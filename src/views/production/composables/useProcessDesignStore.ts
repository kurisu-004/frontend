// src/views/production/composables/useProcessDesignStore.ts
//
// 2026-10-05 新增：「制定工序」页 Pinia setup store —— 替代
// usePartProcessDesign.ts（模块级 `ref` 单例 + 4 处裸 async API 调用，
// 无 queryKey / 无 Zod 守门 / 无 enabled 闸门，2026-10-05 删除）。
//
// 数据源迁移：本页 2026-10-05 起读 prod 域 `GET /api/v2/prod/process-design/parts`
// （旧 part 域 `GET /api/v2/parts?status=PENDING` 的 repo SQL 硬置
// `AND assembly_id IS NULL`，把**装配件的子零件全排除**了，而子件同样需要定工序）。
// 行类型从 `PartListItem`（20 余字段）换成 `ProcessDesignPartSchema`（7 字段，本页
// 实际只读 id / process_chain_id / name / serial_no / drawing_no 五个 + assembly_id 标注）。
//
// 范本：src/views/cnc/composables/usePendingProgrammingStore.ts。
//
// 不变量（改动前必读）：
//   1. 必须在组件 setup 内首次调用 useProcessDesignStore()；
//   2. 视图 onBeforeUnmount 必须 store.$dispose()（Pinia 单例，泄漏选中零件 /
//      未保存草稿到下次进入 —— 注意 $dispose 只 reset 本 store 自建的 ref，
//      故对外状态必须走 query / editor 两个 plain object slice，见 return 处的说明）；
//   3. 消费侧禁止解构 store —— 一律 store.query.xxx / store.editor.xxx
//      （深代理自动解包嵌套 ref）；
//   4. 不 import vue-router：本页暂无跳转需求（确有需要时按
//      usePendingProgrammingStore::registerRouter 的注入范式加）。
//
// 沿 CLAUDE.md 硬约束：
//   - 两层数据获取架构：本文件是**页面级 store**（私有状态 + 内部 useQuery +
//     useMutation + 失效），工序下拉走**共享基础数据层** useProcessesQuery；
//   - queryKey 全走 qk.xxx，queryFn 从 queryKey 读最新 params（不闭包捕获 stale）；
//   - Zod 守门在 **api 层**（listProcessDesignParts 内部 parse），queryFn 不重复
//     parse（parse 返回深拷贝，重复 parse = 每屏数据被校验 + 克隆两遍）；
//   - enabled 闸门（restored）避免「默认参数首屏 + 持久化参数再屏」双 fetch；
//   - 不写 retry：信任 main.ts 全局 queries.retry: 0 / mutations.retry: 0；
//   - 缓存时长：本页是页面级列表，走 main.ts 全局默认（不在共享层有限缓存约束范围内）。
//
// ⚠️ 服务端态与未保存草稿**分家**（本页数据层的核心设计）：
//   - 服务端链 → store 内第 2 个 useQuery（qk.processDesignChain）**读**，
//     query 缓存只装已持久化的东西；
//   - 未保存的工序草稿 → 私有 `draftSteps: Record<string, ProcessStep[]>`，**绝不**
//     进 query 缓存（否则「刷新页面 = 恢复未保存编辑」这种反直觉行为会出现，且脏数据
//     会被失效 / 重取悄悄覆盖）；
//   - dirty 的基线 → 私有 `savedSignatures: Record<string, string>`，只在「服务端数据
//     对齐草稿」与「保存成功」两个时点落定快照（不是拿实时 serverSteps 比），详见
//     isDirty 的注释。
//
// 两条读路径纪律（互相独立，踩中任一条都会让「已制定」零件的工序永远加载不出来）：
//   1. `steps` 的 getter **纯读**，不播种草稿 —— 读值发生在每一次渲染里
//      （toolbar 的 `{{ totalMinutes }}` 无条件渲染），在这里播种会凭空造出草稿；
//   2. 服务端数据对齐草稿的 watch 只在「当前链的数据已到位」时播种，「有链但在途」
//      直接 return（此时 serverSteps 还是空数组，播种等于把空草稿钉死）。
// 两者叠加的后果是同一条：空草稿一旦落盘，工序列表永远是空的，而 dirty 却为 true
// ⇒ 用户点一次「保存」就把该零件的工艺链清空（POST 空 steps = 整组替换语义下的
// 「清空所有步骤」）。
//
// 三条同族守卫生住「草稿与基线在异步往返期间不被错配」这条不变量（后端 POST 是整组
// 替换，错配一次就是数据丢失，故都收在 store 而不是 UI）：
//   3. `addStep` 在链在途时拒绝（`chainPending`）—— 那窗口里 `currentDraft()` 播的是
//      空草稿，硬接一道工序会挡住真数据到达后的播种，保存时把服务端整条链截成 1 条；
//   4. `resetSteps` 在链在途 / 加载失败时拒绝（`canReset`）—— 重置的内容源不是权威值；
//   5. `markSaved` 的基线取**发起保存那一刻同步算出的签名字符串**（随 mutation 变量
//      传下去）而非实时草稿 —— 保存往返期间的任何新编辑都改不了这串基线，保存完成后
//      dirty 仍为 true，不会被随后的失效 refetch 覆盖。
// 回归守卫见 __tests__/useProcessDesignStore.spec.ts 的 T15~T25。

import { computed, ref, watch } from 'vue';
import { defineStore } from 'pinia';
import { ElMessage } from 'element-plus';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import type { QueryClient } from '@tanstack/vue-query';

import { ApiError } from '@/api/http';
import {
  getProcessChainById,
  listProcessDesignParts,
  upsertProcessChainByPart,
  type ListProcessDesignPartsParams,
} from '@/api/processChain';
import type { ProcessChainByPartDto, ProcessChainStepDto } from '@/api/processChain.contract';
import { qk } from '@/composables/queries/keys';
import type {
  ProcessDesignPartListResultSchema,
  ProcessDesignPartSchema,
} from '@/composables/queries/schemas';
import { useProcessesQuery } from '@/composables/queries/useProcessesQuery';
import type { Process } from '@/types/process';
import type { ProcessStep } from '@/types/partProcess';

/** 2026-10-05：单页拉取上限。后端 limit 缺省 200 / clamp(1, 500)；本页不分页，
 *  取 200 与后端缺省一致。左栏据此提示「仅显示前 N / 共 M」（后端 total 是全量口径，
 *  与 limit/offset 无关）。 */
export const PROCESS_DESIGN_LIMIT = 200;

/** 链不存在 / 已删的后端错误码（BIZ_PROCESS_CHAIN_NOT_FOUND，HTTP 404）。
 *  命中即按**空链**归一，不当错误态：链软删后 part 上仍挂着 process_chain_id 是
 *  合法中间态，此时零件就是「没有工序」，不该弹错、不该阻塞编辑。 */
const CHAIN_NOT_FOUND = 20701;

/** 把 service 侧 ProcessChainStepDto 转成 UI 用的 ProcessStep（注入 uid / color 等冗余）。
 *  ProcessStep.uid 仅作 UI v-for key，不参与后端。
 *
 *  ⚠️ 每次调用都生成**新的随机 uid** ⇒ 不能拿整对象 JSON 比较来判断「草稿与服务端是否
 *  一致」（见下方 stepsSignature：只比对业务字段）。 */
function dtoToStep(dto: ProcessChainStepDto): ProcessStep {
  return {
    uid: `step-${dto.id ?? Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    process_id: dto.process_id,
    process_code: '', // 后端响应不冗余 code/name — 由调用方按 process_id 二次查
    process_name: '',
    category: 'INHOUSE', // 默认值；查不到工序时保持（后端不填）
    estimated_minutes: dto.estimated_minutes,
    note: dto.note ?? null,
    sort_order: dto.sort_order,
    color: null,
  };
}

/** 把 UI 用的 ProcessStep 转成 service UpsertProcessChainRequest 用的 step（去掉 uid）。 */
function stepToUpsert(step: ProcessStep): ProcessChainStepDto {
  return {
    sort_order: step.sort_order,
    process_id: step.process_id,
    estimated_minutes: step.estimated_minutes,
    note: step.note ?? null,
  };
}

/** 工序步骤的「业务签名」—— 只取参与后端语义的四个字段。
 *  刻意**排除 uid**：服务端每次映射都会生成新随机 uid（见 dtoToStep），带 uid 比较
 *  会让「草稿 = 服务端」永远不成立（dirty 恒 true）。 */
function stepsSignature(steps: ProcessStep[]): string {
  return JSON.stringify(
    steps.map((s) => [s.process_id, s.estimated_minutes, s.note ?? null, s.sort_order]),
  );
}

export const useProcessDesignStore = defineStore('process-design', () => {
  const qc = useQueryClient();

  // ============ 私有状态 ============
  /** 序列号排序方向（进 queryKey ⇒ 进请求）。后端排序键固定 serial_no，无 sort_by。 */
  const sortDir = ref<'ASC' | 'DESC'>('ASC');
  /** 当前选中的零件（null = 未选）。驱动选中零件工艺链的懒加载。 */
  const selectedPartId = ref<string | null>(null);
  /** partId → 未保存的工序草稿。**只装 dirty 编辑**，query 缓存不碰它。
   *  语义是「按零件存盘」：来回切零件不丢编辑。 */
  const draftSteps = ref<Record<string, ProcessStep[]>>({});
  /** partId → 播种 / 保存那一刻的 `stepsSignature` 快照，即 dirty 的**基线**。
   *  2026-10-05 新增：dirty 不再拿**实时** `serverSteps` 当基线（那样任何 refetch /
   *  invalidate 改变服务端 steps 都会翻转 dirty，dirty 就不再是「用户有没有改过」的
   *  意图信号；后端对响应做归一化时还会让「保存」按钮卡在可点态）。快照只在两个
   *  时点落定：服务端数据对齐草稿时（seedDraft）、保存成功时（markSaved）。 */
  const savedSignatures = ref<Record<string, string>>({});
  // 2026-10-05：enabled 闸门。store 实例化时 useQuery 不发请求，restoreState() 末尾
  // 置 true 才开闸（避免「默认参数首屏 + 恢复参数再屏」双 fetch）。
  const restored = ref(false);

  // ============ buildParams ============
  function buildParams(): ListProcessDesignPartsParams {
    return {
      sort_dir: sortDir.value,
      limit: PROCESS_DESIGN_LIMIT,
      offset: 0,
    };
  }

  // ============ 主查询 useQuery（零件列表）============
  const listQuery = useQuery<
    ProcessDesignPartListResultSchema,
    Error,
    ProcessDesignPartListResultSchema,
    ReturnType<typeof qk.processDesignParts>
  >({
    queryKey: computed(() => qk.processDesignParts(buildParams())),
    // params 从 queryKey[2] 读（不闭包捕获 buildParams 的 snapshot）。
    // 守门**收敛在 api 层**（listProcessDesignParts 内部 parse，形态同
    // api/pendingBatches.ts::dispatchBatches ⇒ 任何调用方都受 Zod 守门），
    // 此处不重复 parse。
    queryFn: async ({ queryKey }) =>
      listProcessDesignParts(queryKey[2] as ListProcessDesignPartsParams),
    enabled: restored,
    placeholderData: keepPreviousData,
  });

  // ============ 派生 ============
  const parts = computed<ProcessDesignPartSchema[]>(() => listQuery.data.value?.items ?? []);
  const total = computed<number>(() => listQuery.data.value?.total ?? 0);
  const loading = listQuery.isFetching;

  // ============ 工序下拉（共享基础数据层）============
  // 旧实现是 store 内裸调 listProcesses({}) + 模块级 ref（每次进页都重拉、跨页零去重）。
  // 2026-10-05 改走共享层：自带 Zod 守门 + 30s staleTime + 跨页去重。
  // limit 500 拉全量（工序下拉要全量，后端 processes 端点 limit clamp 500）。
  const processesQuery = useProcessesQuery({ limit: 500 });
  // processSchema 派生的 description / color 是 optional（对齐后端 skip_serializing_if），
  // 而 Process 业务类型是 required ⇒ 结构不匹配，走 `as Process[]` 桥接（沿
  // usePendingProgrammingStore::processes 同款）。本页只读 id / code / name /
  // category / color / requires_approval，对 optional 字段无依赖。
  const processes = computed<Process[]>(
    () => (processesQuery.data.value?.items ?? []) as Process[],
  );

  // ============ 选中零件的工艺链（第 2 个 useQuery）============
  /** 选中零件的链 id：零件行上 process_chain_id 为 null ⇒ null（未制定工序）。
   *  这也是「该零件有没有链」的唯一判据 —— 零件不在列表里（异常路径）同样落 null。 */
  const selectedChainId = computed<string | null>(() => {
    const pid = selectedPartId.value;
    if (!pid) return null;
    return parts.value.find((p) => p.id === pid)?.process_chain_id ?? null;
  });

  const chainQuery = useQuery<
    ProcessChainByPartDto,
    Error,
    ProcessChainByPartDto,
    ReturnType<typeof qk.processDesignChain>
  >({
    queryKey: computed(() => qk.processDesignChain(selectedChainId.value ?? '')),
    queryFn: async ({ queryKey }) => {
      const chainId = queryKey[2] as string;
      try {
        return await getProcessChainById(chainId);
      } catch (e) {
        // 20701（链已删 / 脏数据）按空链归一：query 缓存里存一条空链，UI 走「暂无工序」
        // 空态而不是错误态。其它错误照抛（错误由下方 watch 桥接 ElMessage）。
        if (e instanceof ApiError && e.code === CHAIN_NOT_FOUND) {
          return {
            id: chainId,
            name: '',
            note: null,
            version: 0,
            created_at: '',
            updated_at: '',
            steps: [],
          } satisfies ProcessChainByPartDto;
        }
        throw e;
      }
    },
    // 闸门挂在**链 id** 上而不是 selectedPartId：process_chain_id 为空的零件
    // （绝大多数「待制定」行）压根不需要发请求，直接判空链 —— 省一次必 404 的往返。
    enabled: computed(() => restored.value && !!selectedChainId.value),
  });

  /** 服务端链 → UI 步骤（冗余字段按 process_id 二次查工序下拉补齐）。 */
  const serverSteps = computed<ProcessStep[]>(() =>
    (chainQuery.data.value?.steps ?? []).map((dto) => {
      const step = dtoToStep(dto);
      const p = processes.value.find((pp) => pp.id === step.process_id);
      if (p) {
        step.process_code = p.code;
        step.process_name = p.name;
        step.category = p.category;
        step.color = p.color ?? null;
      }
      return step;
    }),
  );

  // ElMessage 错误桥接（useQuery 的 error 不在 setup 抛错）
  const errorMsg = computed<string | null>(() => {
    const e = listQuery.error.value ?? chainQuery.error.value;
    return e ? e.message : null;
  });
  watch(errorMsg, (msg) => {
    if (msg) ElMessage.error(msg);
  });

  /** fetchList 别名 = useQuery.refetch 的 async 包装（保留该名字：视图的「刷新」入口
   *  与测试都通过它驱动，保持当前 sort_dir refetch）。 */
  async function fetchList(): Promise<void> {
    await listQuery.refetch();
  }

  // ============ 选中零件 ============
  /** 选中零件（由左栏行点击驱动）。零件未在列表里（异常路径）时也允许选中，
   *  此时 selectedChainId 落 null ⇒ 不发请求、steps 为空。 */
  function selectPart(partId: string): void {
    if (selectedPartId.value === partId) return;
    selectedPartId.value = partId;
  }

  /** 序列号排序方向切换（由 el-table 的 @sort-change 驱动）。
   *  EP 的 order 三态：'ascending' / 'descending' / null（取消排序）⇒ null 落回 ASC
   *  （后端只认 DESC / 非 DESC 两态）。 */
  function onSortChange(order: 'ascending' | 'descending' | null): void {
    sortDir.value = order === 'descending' ? 'DESC' : 'ASC';
  }

  // ============ 草稿（未持久化的编辑）============
  /** 读当前零件草稿；缺省时用服务端 steps 播种一份。
   *  `currentDraft()` 必须在**所有**编辑入口前调用：草稿不存在时 in-place 改动
   *  serverSteps 派生出来的对象，改动会在下次 chainQuery 重算时静默丢失。 */
  function currentDraft(): ProcessStep[] {
    const pid = selectedPartId.value;
    if (!pid) return [];
    const existing = draftSteps.value[pid];
    if (existing) return existing;
    return seedDraft(
      pid,
      serverSteps.value.map((s) => ({ ...s })),
    );
  }

  /** 写草稿并**按数组下标拍平 sort_order**（返回拍平后的数组）。
   *  拍平是硬要求：后端 20104 校验 sort_order 重复，而 `addStep()` 恒给 sort_order=0
   *  （用户连点两次「添加工序」就是 [0, 0]）⇒ 保存前必须重写成 0,1,2…。 */
  function writeDraft(partId: string, steps: ProcessStep[]): ProcessStep[] {
    const flattened = steps.map((s, i) => ({ ...s, sort_order: i }));
    draftSteps.value = { ...draftSteps.value, [partId]: flattened };
    return flattened;
  }

  /** 用服务端 steps 播种草稿，**同时**把签名快照记成 dirty 基线
   *  （「此刻的草稿 = 已持久化的内容」⇒ dirty 应为 false）。 */
  function seedDraft(partId: string, steps: ProcessStep[]): ProcessStep[] {
    const flattened = writeDraft(partId, steps);
    savedSignatures.value = {
      ...savedSignatures.value,
      [partId]: stepsSignature(flattened),
    };
    return flattened;
  }

  /** 保存成功后把基线推到「刚发出去的那份 payload」上 ⇒ dirty 归零。
   *  `signature` 是发起保存那一刻**同步**算出的业务签名字符串（`save()` 随 mutation 变量
   *  一起传下来），不是 resolve 时刻重算的：后端若对响应做归一化（耗时 clamp 之类），
   *  拿响应当基线会让「保存」按钮刚变灰又变可点。
   *
   *  ⚠️ 2026-10-05 修：基线必须是**字符串**而不是数组快照。数组快照对「原地改动」不免疫
   *  —— Sortable 的内建 handler 是 `list.value.splice(...)`（见 useLazyDraggable 头注），
   *  它改的正是 `writeDraft` 产出的那份数组（`draftSteps` 是 ref，取值是包着同一份 raw
   *  的 reactive 代理，代理上的 splice 直达底层）：保存往返期间一次拖拽就能把「快照」
   *  改成重排后的顺序，基线与草稿同进同出、dirty 静默保持 false，而服务端还是旧顺序 ⇒
   *  UI 显示幻影顺序 + 保存按钮灰着。签名字符串在那一刻已成定局，对任何后续原地改动免疫。
   *
   *  基线取 payload 而非实时草稿，同时收掉「POST 在途期间的并发编辑被静默丢弃」——
   *  保存往返期间用户新增 / 重排的工序都不在基线里，于是保存完成后草稿签名 ≠ 基线签名
   *  ⇒ dirty 仍为 true，下方播种 watch 因 isDirty 挡在门外，草稿原样保留、用户能再点
   *  一次保存。拿实时草稿当基线则会把这批未保存的编辑一起当成「已保存」，随后失效
   *  refetch 回来时播种覆盖掉它们（编辑凭空消失 + 按钮变灰），用户毫不知情。
   *  随后那次失效 refetch 带归一化后的 steps 回来时，若期间无新编辑（isDirty 为
   *  false）则允许把草稿对齐到服务端权威 steps。 */
  function markSaved(partId: string, signature: string): void {
    savedSignatures.value = {
      ...savedSignatures.value,
      [partId]: signature,
    };
  }

  /** 当前零件草稿与「播种 / 上次保存那一刻的快照」是否已分家（dirty）。 */
  function isDirty(partId: string): boolean {
    const draft = draftSteps.value[partId];
    if (!draft) return false;
    const baseline = savedSignatures.value[partId];
    // 有草稿却没有基线 = 未走过播种 / 保存路径（正常路径下不可能，见 seedDraft 注释）。
    // 保守判 dirty：宁可让用户多点一次保存，也不让「有编辑但保存按钮灰着」。
    if (baseline === undefined) return true;
    return stepsSignature(draft) !== baseline;
  }

  const dirty = computed<boolean>(() =>
    selectedPartId.value ? isDirty(selectedPartId.value) : false,
  );

  /** 当前零件的工序步骤（可写）：get 纯读草稿，set 写回草稿。
   *  可写是 Sortable 的硬要求 —— 工序卡拖拽排序走 vue-draggable-plus 三参形态
   *  （useLazyDraggable 的 list 形参），库内建 handler 会 `list.value.splice(...)`；
   *  绑只读 computed 的话，排序改的是临时数组、DOM 顺序与数据当场脱钩。
   *  ⚠️ getter **纯读、不播种**（2026-10-05 修）：读值发生在任何渲染里（toolbar 的
   *  `{{ totalMinutes }}` 无条件渲染），一旦在这里调播种就会凭空造出一份草稿 ——
   *  链还没回来时播种的是**空数组**，真数据到达后被 isDirty 挡在门外，steps 永远空。
   *  写侧不受影响：addStep / removeStep / patchStep / selectProcess / resetSteps
   *  自己都先调 `currentDraft()`（那里才播种），Sortable 也只在列表非空（= 草稿已存在）
   *  时才拿到可写数组。 */
  const steps = computed<ProcessStep[]>({
    get: () => {
      const pid = selectedPartId.value;
      if (!pid) return [];
      return draftSteps.value[pid] ?? [];
    },
    set: (val: ProcessStep[]) => {
      const pid = selectedPartId.value;
      if (pid) writeDraft(pid, val);
    },
  });

  /** 服务端数据到达 / 切换零件时，把草稿对齐到服务端 steps ——
   *  ⚠️ **仅在未 dirty 时**：用户在途编辑不能被异步返回的数据覆盖。
   *
   *  2026-10-05 修：「有链但在途」必须直接 return。切零件时 watch 源（含
   *  `selectedPartId`）立刻触发，此刻链 query 的键刚换、`data` 还是 undefined ⇒
   *  `serverSteps` 是空数组，此时播种等于把一份**空草稿**钉死在该 partId 上；真数据
   *  到达后的第二次触发又因 isDirty（空草稿 vs 真 steps）被挡回去，工序永远加载不出来，
   *  且 dirty 卡在 true ⇒ 用户一点「保存」就把该零件的工艺链清空（POST 空 steps =
   *  「保留 header 但清空所有步骤」）。
   *
   *  ⚠️ 判据不能用 `isPending` 单判：`enabled=false` 的 query（零件压根没有链）isPending
   *  **恒为 true**，而「无链」分支恰恰必须放行（服务端就是空链，播种空数组是对的）。
   *  故先按「有没有链 id」分流：有链 ⇒ 要求 `data` 已到位且 id 对得上（键刚换、
   *  isPending 还没翻转的那一瞬也拦得住，不依赖 vue-query 内部 watcher 的时序）；
   *  无链 ⇒ 直接按空链播种。 */
  watch([chainQuery.data, selectedPartId, selectedChainId], () => {
    const pid = selectedPartId.value;
    if (!pid) return;
    const chainId = selectedChainId.value;
    if (chainId) {
      if (chainQuery.isPending.value) return;
      const chain = chainQuery.data.value;
      // data 未到位（键刚换）或 id 对不上（上一个零件的响应）都算陈旧，丢弃
      if (!chain || chain.id !== chainId) return;
    }
    if (isDirty(pid)) return;
    seedDraft(
      pid,
      serverSteps.value.map((s) => ({ ...s })),
    );
  });

  /** 选中零件的链是否在途（右栏空态区分「在加载」与「真的没工序」，也是编辑侧的
   *  准入闸门）。口径与 `canReset` 同源：`enabled=false` 的 query（零件压根没有链）
   *  isPending 恒为 true，所以必须先按「有没有链 id」分流。 */
  const chainPending = computed<boolean>(
    () => !!selectedChainId.value && chainQuery.isPending.value,
  );

  /** 追加一道空白工序（末尾）。默认带第一道工序的 code / name / category / color，
   *  estimated_minutes=30 —— 与旧实现同默认。
   *
   *  ⚠️ 2026-10-05 修：链在途时**拒绝**并提示，不让它建草稿。守卫放在 store 而不是
   *  组件，是为了任何入口（占位方框、快捷键、将来的批量导入）都绕不过去。
   *  原因是 `currentDraft()` 在草稿缺失时会用 `serverSteps` 播种，而链在途时
   *  `serverSteps` 是空数组：此刻 addStep 会把「空草稿 + 1 道新工序」连同空基线一起
   *  写进 draftSteps，随后真数据到达时播种 watch 被 isDirty 挡在门外 ⇒ 服务端那 3 步
   *  永远进不来，用户再点一次保存就是拿 1 条去整组替换 3 条（步骤被静默截断）。
   *  removeStep / patchStep / selectProcess 在同一窗口里是无害的：它们对空草稿做完
   *  过滤 / 改字段后仍是空数组，签名与基线一致 ⇒ dirty 为 false，数据到达时正常
   *  播种覆盖；唯一会把草稿改成「非空且与基线不一致」的入口就是 addStep。
   *  Sortable 在这窗口同样够不着：卡片列表（连同它的容器 ref）在 ProcessStepCardList 的
   *  `v-else` 分支里，而 chainPending 期间该零件不可能有非空草稿（唯一的建草稿入口
   *  currentDraft() 播的是空 serverSteps）⇒ steps 必为空、走 `v-if` 空态分支 ⇒
   *  Sortable 没启动，没有任何可拖的卡片。哪天让空态也渲染列表分支，这条就失效了。 */
  function addStep(): void {
    const pid = selectedPartId.value;
    if (!pid) return;
    if (chainPending.value) {
      ElMessage.warning('工艺链尚未加载完成，暂不能添加工序');
      return;
    }
    const first = processes.value[0];
    const step: ProcessStep = {
      uid: `step-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      process_id: first?.id ?? '',
      process_code: first?.code ?? '',
      process_name: first?.name ?? '',
      category: first?.category ?? 'INHOUSE',
      estimated_minutes: 30,
      note: null,
      sort_order: 0,
      color: first?.color ?? null,
    };
    writeDraft(pid, [...currentDraft(), step]);
  }

  /** 按 uid 删除一道工序。 */
  function removeStep(uid: string): void {
    const pid = selectedPartId.value;
    if (!pid) return;
    writeDraft(
      pid,
      currentDraft().filter((s) => s.uid !== uid),
    );
  }

  /** 行内改单字段（耗时 / 备注）。走 store 而不是就地改对象，保证任何编辑路径都会
   *  先经 currentDraft() 播种出草稿（否则改的是 serverSteps 的临时对象，会丢）。 */
  function patchStep(
    uid: string,
    patch: Partial<Pick<ProcessStep, 'estimated_minutes' | 'note'>>,
  ): void {
    const pid = selectedPartId.value;
    if (!pid) return;
    writeDraft(
      pid,
      currentDraft().map((s) => (s.uid === uid ? { ...s, ...patch } : s)),
    );
  }

  /** 换工序：同步透传 code / name / category / color（UI 卡片左侧色条 + 标签用）。
   *  选不到（清空 / 脏 id）时回落成空工序字段，不报错。 */
  function selectProcess(uid: string, processId: string): void {
    const pid = selectedPartId.value;
    if (!pid) return;
    const p = processes.value.find((pp) => pp.id === processId);
    const next = p
      ? {
          process_id: p.id,
          process_code: p.code,
          process_name: p.name,
          category: p.category,
          color: p.color ?? null,
        }
      : {
          process_id: '',
          process_code: '',
          process_name: '',
          category: 'INHOUSE' as const,
          color: null,
        };
    writeDraft(
      pid,
      currentDraft().map((s) => (s.uid === uid ? { ...s, ...next } : s)),
    );
  }

  /** 「重置」是否可点：重置的**内容源**是 serverSteps，链在途 / 链加载失败时它不是
   *  权威值（空数组或上一份缓存），此时点重置等于无声丢弃用户的编辑。 */
  const canReset = computed<boolean>(() => {
    if (!selectedChainId.value) return true;
    return !chainQuery.isPending.value && !chainQuery.isError.value;
  });

  /** 「重置」：丢弃草稿，回到服务端链的 steps。
   *  守卫见 `canReset`：链没就绪时宁可拒绝（弹提示）也不清空用户的编辑。 */
  function resetSteps(): void {
    const pid = selectedPartId.value;
    if (!pid) return;
    if (!canReset.value) {
      ElMessage.warning('工艺链尚未加载完成，暂不能重置');
      return;
    }
    seedDraft(
      pid,
      serverSteps.value.map((s) => ({ ...s })),
    );
  }

  /** 摘要：当前零件的工序总耗时（右栏 toolbar 展示）。 */
  const totalMinutes = computed<number>(() =>
    steps.value.reduce((acc, s) => acc + (s.estimated_minutes || 0), 0),
  );

  // ============ 保存整组 mutation（POST by-part）============
  /** mutation 变量：`params` 是**发起保存那一刻**的列表 params 快照（2026-10-05 新增）。
   *  零闪烁回写要按当时生效的 sort_dir 组 queryKey，用响应时刻的实时 sortDir 组会打到
   *  一份没人用的缓存上（用户在请求发出与 resolve 之间切了排序），回写静默失效。 */
  interface SaveChainVars {
    partId: string;
    steps: ProcessStep[];
    /** 2026-10-05 新增：`steps` 那一刻的业务签名，作为保存后 dirty 的基线。
     *  **必须随变量传下去**，不能在 resolve 时重算 —— 那时草稿可能已被 Sortable 就地
     *  重排或新增过，重算出来的基线等于「连没保存的编辑一起认了」。 */
    signature: string;
    params: ListProcessDesignPartsParams;
  }

  const saveMutation = useMutation<ProcessChainByPartDto, Error, SaveChainVars>({
    mutationKey: ['process-design', 'upsert-chain'],
    // 不写 retry：信任 main.ts 全局 mutations.retry: 0。
    mutationFn: ({ partId, steps: payload }) =>
      upsertProcessChainByPart(partId, { steps: payload.map(stepToUpsert) }),
    onSuccess: async (dto, vars) => {
      // 零闪烁回写：无链零件首次保存时后端建链，响应的 `id` 即新链 id（既有链保存时
      // id 不变，赋值幂等）。先 setQueryData 把该行就地改成「已制定」——不等一个往返，
      // 左栏分组立刻迁移；再失效整域拿权威值。
      // ⚠️ 用 mutation 变量里的 partId / params，不用当前的 selectedPartId / sortDir：
      // 保存期间用户可能已经切到别的零件或切了排序，按当前值去 patch 会改错行 / 改错缓存。
      // 显式标注 prev 类型：queryKey 末段是普通对象（非 tagged key），TS 无法从键反推
      // TQueryFnData，不标注会被退化成 `{}`。
      markSaved(vars.partId, vars.signature);
      qc.setQueryData(
        qk.processDesignParts(vars.params),
        (prev: ProcessDesignPartListResultSchema | undefined) => {
          if (!prev) return prev;
          return {
            ...prev,
            items: prev.items.map((p) =>
              p.id === vars.partId && p.process_chain_id !== dto.id
                ? { ...p, process_chain_id: dto.id }
                : p,
            ),
          };
        },
      );
      // 链缓存直接落服务端响应（整组 upsert 后的权威 steps / version），避免切件回来
      // 先闪一帧旧 steps。
      qc.setQueryData(qk.processDesignChain(dto.id), dto);
      // ⚠️ 草稿**不清**：它就是刚保存成功的那份，留在草稿里可避免链 query 重取到达前
      // 右栏闪空态（dirty 由 markSaved 归零，随后失效 refetch 到达时 watch 允许把
      // 草稿对齐到服务端权威 steps）。
      await invalidateProcessDesignQuery(qc);
      ElMessage.success('已保存');
    },
    onError: (e: Error) => {
      // 失败：保留草稿与 dirty（不回滚），让用户编辑不丢、可点保存重试。
      ElMessage.error(`保存工艺链失败：${e.message ?? '未知错误'}`);
    },
  });

  const saving = saveMutation.isPending;

  /** 显式持久化入口：先本地拍平（writeDraft 内部）再 POST 整组。
   *  失败时 mutateAsync reject —— 草稿与 dirty 保持不变，调用方（UI）只需 catch
   *  吞掉（错误提示已在 onError 弹过）。 */
  async function save(): Promise<void> {
    const pid = selectedPartId.value;
    if (!pid) return;
    const flattened = writeDraft(pid, currentDraft());
    await saveMutation.mutateAsync({
      partId: pid,
      steps: flattened,
      signature: stepsSignature(flattened),
      params: buildParams(),
    });
  }

  /** 恢复页面状态 + 开闸。本页**无持久化状态**（零件列表每次进页都重拉），故本方法
   *  目前只做开闸；保留这个入口是为了与「视图 onMounted 统一调 restoreState()」的
   *  页面级 store 范式对齐 —— 将来加持久化只需在这里恢复，开闸位置不用动。 */
  function restoreState(): void {
    restored.value = true;
  }

  // ============ 对外切片 ============
  // ⚠️ 为什么切 query / editor 两个 slice，而不是把 10 个 ref 平铺在 store 顶层：
  // Pinia setup store 的 `$dispose()` 只做 `scope.stop()` + 清订阅 + 从 `pinia._s`
  // 摘除，**不删** `pinia.state.value[$id]`；下次 `useStore()` 时 Pinia 会把
  // 上次残留的 state **hydrate 回新建的 ref**（pinia.mjs createSetupStore 的
  // `if (initialState && shouldHydrate(prop)) prop.value = initialState[key]`）。
  //   - 平铺的顶层 ref（如 selectedPartId / draftSteps）会被序列化进 state ⇒
  //     $dispose 后「上次编辑到一半的工序」泄漏到下次进入，直接违反不变量 #2；
  //   - 切成 plain object slice 后，slice 既不是 ref 也不是 reactive，Pinia
  //     不会把它写进 state ⇒ $dispose 后真 fresh。
  //     ⚠️ 前提是 slice 确实是 **plain object**：写成 reactive() 会通过 Pinia 的 state
  //     登记闸门（isRef || isReactive）进 state，重建时由 mergeReactiveObjects 递归
  //     回填、内层 ref 一样复活 ⇒ 本护栏失效。
  // 回归守卫见 __tests__/useProcessDesignStore.spec.ts 的「$dispose 后重建」用例。
  return {
    query: {
      /** 零件行（后端 7 字段 VO 的 z.infer；本页只读其中 6 个） */
      parts,
      /** 全量行数（后端 COUNT，与 limit/offset 无关）—— 用于「仅显示前 N / 共 M」提示 */
      total,
      loading,
      errorMsg,
      sortDir,
      selectedPartId,
      selectPart,
      onSortChange,
      restoreState,
      /** fetchList 别名（视图「刷新」入口 / 测试驱动） */
      fetchList,
      /** 选中零件的链是否在途（右栏空态区分「加载中」与「真的没工序」；
       *  同时是编辑侧的准入闸门，见 addStep 守卫） */
      chainPending,
      /** 工序下拉（共享基础数据层 query 的只读投影） */
      processes,
    },
    editor: {
      /** 当前零件的工序步骤（可写，Sortable 拖拽排序直接绑它） */
      steps,
      /** 是否已修改（与播种 / 上次保存那一刻的签名快照比对） */
      dirty,
      saving,
      /** 当前零件工序总耗时（分钟） */
      totalMinutes,
      /** 「重置」是否可点（链在途 / 链加载失败时为 false） */
      canReset,
      addStep,
      removeStep,
      patchStep,
      selectProcess,
      resetSteps,
      save,
    },
  };
});

/** 失效整个 process-design 域（保存工艺链成功后调）。
 *  返回 Promise<void> 让 caller 可以 await 失效完成再走后续逻辑。
 *  `processDesignPartsPrefix` = `['process-design']`，同时命中零件列表与选中零件的链。 */
export function invalidateProcessDesignQuery(qc: QueryClient): Promise<void> {
  return qc.invalidateQueries({ queryKey: qk.processDesignPartsPrefix }).then(() => undefined);
}

/** 行类型再导出（组件 cellRender / 测试用；与 schemas 的 z.infer 同源）。 */
export type { ProcessDesignPartSchema, ProcessDesignPartListResultSchema };
