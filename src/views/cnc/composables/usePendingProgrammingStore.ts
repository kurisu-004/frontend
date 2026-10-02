// src/views/cnc/composables/usePendingProgrammingStore.ts
//
// 2026-10-01 新增：「待编程一览」页 Pinia setup store —— 替代原
// usePendingProgrammingList.ts（ListShell + fetcher 手写状态机，2026-10-01 删除）。
//
// 范本：src/views/parts/list/composables/usePartsListStore.ts（页面级 store）
//   + usePartsListQuery.ts（useQuery 部分）。
//
// 数据源迁移：本页 2026-10-01 起读 prod 域 `GET /api/v2/prod/programming/pending`
// （旧 part 域 /parts/pending-programming 恒返空，前端 wrapper 已删）。行类型从
// PartListItem 换成 ProgrammingItem（pendingProgrammingItemSchema 的 z.infer）。
//
// 不变量（改动前必读）：
//   1. 必须在组件 setup 内首次调用 usePendingProgrammingStore()；
//   2. 视图 onBeforeUnmount 必须 store.$dispose()（Pinia 单例，泄漏对话框态 /
//    分页 / Tab 勾选到下次进入 —— 注意 $dispose 只 reset 本 store 自建的 ref，
//    故对外状态必须走 query / release 两个 plain object slice，见 return 处的说明）；
//   3. 消费侧禁止解构 store —— 一律 store.query.xxx / store.release.xxx
//    （深代理自动解包嵌套 ref）；
//   4. 不 import vue-router：路由跳转能力由视图通过 registerRouter 注入
//    （沿 src/stores/auth.ts::refreshOrLogout(router) 与
//    usePartsListStore::registerTableGetter 的先例）—— store 需在 node 单测里
//    无 router 实例化。
//
// 沿 CLAUDE.md 硬约束：
//   - 两层数据获取架构：本文件是**页面级 store**（私有状态 + 内部 useQuery +
//     useMutation + 失效），货架 / 工序下拉走**共享基础数据层**
//     （useProductionShelvesQuery / useProcessesQuery）；
//   - queryKey 全走 qk.xxx，queryFn 从 queryKey 读最新 params（不闭包捕获 stale）；
//   - Zod 守门在 **api 层**（fetchPendingProgramming 内部 parse，所有调用方都受守门），
//     queryFn 不重复 parse（见主查询处 M-2 注）；错误经 watch(errorMsg) 桥接 ElMessage；
//   - enabled 闸门（restored）避免「默认参数首屏 + 持久化参数再屏」双 fetch；
//   - 不写 retry：信任 main.ts 全局 queries.retry: 0 / mutations.retry: 0；
//   - 缓存时长：本页是页面级列表，走 main.ts 全局默认（不在共享层有限缓存
//     staleTime/gcTime 约束范围内）。

import { computed, reactive, ref, watch } from 'vue';
import { defineStore } from 'pinia';
import { ElMessage } from 'element-plus';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import type { QueryClient } from '@tanstack/vue-query';

import { fetchPendingProgramming, type ListPendingProgrammingParams } from '@/api/programming';
import { qk } from '@/composables/queries/keys';
import type {
  PendingProgrammingItemSchema,
  PendingProgrammingListResultSchema,
} from '@/composables/queries/schemas';
import { useProcessesQuery } from '@/composables/queries/useProcessesQuery';
import { useProductionShelvesQuery } from '@/composables/queries/useProductionShelvesQuery';
import { useColumnVisibility } from '@/composables/useColumnVisibility';
import { useColumnDrag } from '@/composables/useColumnDrag';
import { useListStatePersist } from '@/composables/useListFilterPersist';
import { useShelfProcessFilter } from '@/composables/useShelfProcessFilter';
import { handleProcessChainRequired } from '@/composables/useProcessChainRequiredHandler';
import {
  buildPendingProgrammingColumnDefs,
  type PendingProgrammingRow,
} from '../pendingProgrammingColumnDefs';
import type { Process } from '@/types/process';
import type { Shelf } from '@/types/shelf';

export type PendingProgrammingTab = 'pending' | 'programmed';

/** 下发失败兜底所需的最小 router 形态（只用 push 跳「工序制定」页）。
 *  结构化注入而非 `import type { Router }`：沿 src/stores/auth.ts::refreshOrLogout
 *  的先例 —— store 不 import vue-router（不变量 #4，node 单测无 router 实例），
 *  视图传真实 Router 实例即可（结构化子类型，天然可赋值）。 */
export interface PendingProgrammingRouter {
  push: (path: string) => Promise<unknown> | unknown;
}

/** 列可见性 / 列顺序的 localStorage key —— 沿用 2026-09-29 的老值。
 *  ⚠️ 不要改：改 key 会让老用户已配好的列可见性 / 列顺序快照全丢。 */
export const PENDING_PROGRAMMING_LIST_KEY = 'pending_programming';

/** 2026-10-02：待编程列表行缺批次 id 时的提示（见 releaseMutation 注释）。 */
const RELEASE_NO_BATCH_HINT = '待编程列表未返回批次信息，无法下发（列表接口需补批次 id）';

export const usePendingProgrammingStore = defineStore('pending-programming', () => {
  const qc = useQueryClient();

  // ============ 私有状态 ============
  /** 搜索**生效态**（进 queryKey ⇒ 进请求）。持久化到 `pending_programming_filter`。
   *  ⚠️ 只由 onSearch() / restoreState() 写，**不要**直接绑到视图输入框。 */
  const search = reactive({ keyword: '', serialNo: '' });
  /** 搜索**输入态**（只被视图 v-model 写，**不进 queryKey**）。
   *  2026-10-01 review 第 1 轮 I-1：生效态直接绑 v-model 时，每敲一个字符就换一个
   *  queryKey ⇒ 每个字符一次 GET；且 onSearch 只绑 @keyup.enter / @clear，打字途中
   *  页码不重置 ⇒ 在第 3 页打字会拉到「第 3 页的筛选结果」（大概率空表）。
   *  拆成输入态 / 生效态后：打字 0 请求，Enter / 清空才 onSearch 提交一次。 */
  const searchInput = reactive({ keyword: '', serialNo: '' });
  const activeTab = ref<PendingProgrammingTab>('pending');
  /** 自动刷新开关（5min 轮询，持久化）。原视图用裸 setInterval 维护，2026-10-01
   *  改由 useQuery 的 refetchInterval 承担（见下），这里只保留开关状态。 */
  const autoRefresh = ref(false);
  const page = ref(1);
  const pageSize = ref(20);
  // 2026-10-01：enabled 闸门。store 实例化时 useQuery 不发请求，
  // restoreState() 末尾置 true 才开闸（避免默认参数 + 持久化参数双 fetch）。
  const restored = ref(false);

  // 下发对话框态（全部私有于 store；视图只读 + 绑定 v-model）
  const releaseDialogVisible = ref(false);
  const releaseTarget = ref<PendingProgrammingRow | null>(null);
  const releaseShelfId = ref<string | null>(null);
  const releaseProcessId = ref<string | null>(null);
  const releaseSubmitting = ref(false);

  // ============ buildParams ============
  function buildParams(): ListPendingProgrammingParams {
    return {
      // Tab 三态映射：pending = 仅未编程 / programmed = 仅已编程
      // （省略 = 全部，本页两个 Tab 不暴露「全部」分支）。
      // ⚠️ 恒为真 boolean（2026-10-01 review 第 1 轮 M-4：后端
      // deserialize_bool_opt 把空串当「不过滤」而不是 400，详见
      // api/programming.ts::ListPendingProgrammingParams 的注释）——
      // 前端仍不发空串，不依赖后端那条兜底。
      has_cnc_program: activeTab.value === 'pending' ? false : true,
      // ⚠️ 读的是**生效态** search（不是 searchInput）：自动刷新 tick / 刷新按钮
      // 触发的 refetch 走的是当前 queryKey，输入框里没提交的半截字不该进请求。
      // 空串 / 纯空格 → undefined（cleanParams 只兜 undefined，空串会原样发出）
      keyword: search.keyword.trim() || undefined,
      serial_no: search.serialNo.trim() || undefined,
      sort_by: 'PLANNED_DELIVERY_DATE',
      sort_dir: 'ASC',
      limit: pageSize.value,
      offset: (page.value - 1) * pageSize.value,
    };
  }

  // ============ 主查询 useQuery ============
  const listQuery = useQuery<
    PendingProgrammingListResultSchema,
    Error,
    PendingProgrammingListResultSchema,
    ReturnType<typeof qk.programmingList>
  >({
    queryKey: computed(() => qk.programmingList(buildParams())),
    // queryFn 从 queryKey[2] 读最新 params（不闭包捕获 buildParams 的 snapshot）
    // 2026-10-01 review 第 1 轮 M-2：守门**收敛在 api 层**
    // （api/programming.ts::fetchPendingProgramming 内部 parse，形态同
    //  api/pendingBatches.ts::dispatchBatches ⇒ 任何调用方都受 Zod 守门）。
    // 此处不再重复 parse —— Zod 的 parse 返回**深拷贝**，重复 parse 等于每屏数据
    // 被校验 + 克隆两遍（50 行 × 13 字段），纯浪费。
    queryFn: async ({ queryKey }) =>
      fetchPendingProgramming(queryKey[2] as ListPendingProgrammingParams),
    enabled: restored,
    placeholderData: keepPreviousData,
    // 自动刷新：原视图的 window.setInterval(5min) 迁移到 refetchInterval。
    // ⚠️ refetchIntervalInBackground 必须显式 true —— TanStack Query 默认 false，
    // 窗口失焦时暂停轮询，与原手写 setInterval（后台照跑）行为不一致。
    // ⚠️ refetchInterval 用 **computed** 而非裸函数 `() => autoRefresh ? 300_000 : false`
    //   （勿改回函数形态）：vue-query 的 defaultedOptions 是对 options 的 computed，
    //   经 `cloneDeepUnref` 逐层 unref —— 只在 queryKey 那一层会把 function 求值
    //   （`unrefGetters` 仅 queryKey 为 true），其余层 function 原样保留。
    //   裸函数体内的 `autoRefresh.value` 因此**不进入** defaultedOptions 的依赖收集，
    //   勾选「自动刷新」不触发 `watch(defaultedOptions) → observer.setOptions(...)`
    //   ⇒ query-core 的 `#updateRefetchInterval` 不会被重新求值（setOptions 里只有
    //   `nextRefetchInterval !== #currentRefetchInterval` 时才重建定时器）⇒ 轮询永远
    //   不启动，必须再改一次筛选 / 手动刷新才「歪打正着」。computed 让 autoRefresh
    //   进入依赖，勾选与取消勾选都会重建定时器。
    //   注：轮询本身无法在 vitest node 环境断言 —— query-core 的
    //   `#shouldScheduleTimer` 有 `!isServer()` 闸门（node 下 window 未定义 ⇒
    //   永不排定时器），单测只覆盖到「开关状态 + 参数」层。
    refetchInterval: computed(() => (autoRefresh.value ? 300_000 : false)),
    refetchIntervalInBackground: true,
  });

  // ============ 派生 ============
  const items = computed<PendingProgrammingRow[]>(() => listQuery.data.value?.items ?? []);
  const total = computed<number>(() => listQuery.data.value?.total ?? 0);
  const loading = listQuery.isFetching;
  const errorMsg = computed<string | null>(() => {
    const e = listQuery.error.value;
    return e ? e.message : null;
  });
  const emptyText = computed<string>(() => errorMsg.value ?? '当前无待编程零件');

  // ElMessage 错误桥接（useQuery 的 error 不在 setup 抛错）
  watch(errorMsg, (msg) => {
    if (msg) ElMessage.error(msg);
  });

  /** fetchList 别名 = useQuery.refetch 的 async 包装（保留该名字：视图「刷新」按钮
   *  与测试都通过它驱动，保持当前页码 refetch）。 */
  async function fetchList(): Promise<void> {
    await listQuery.refetch();
  }

  // ============ 事件处理 ============
  // ⚠️ 只做 page=1；queryKey 变化自动 refetch。**不要**再加 watch(activeTab) ——
  // 2026-09-29 review 已修过「@tab-change + watch 串行触发两次刷新」的 bug
  // （点一下 Tab 拉两次接口），本页只保留 @tab-change 一条路径。
  function onTabChange(): void {
    page.value = 1;
  }

  /** 提交搜索：输入态 → 生效态 + 页码归 1（queryKey 变化自动 refetch）。
   *  ⚠️ 视图只在 `@keyup.enter` / `@clear` 调它，**不要**绑到输入框的
   *  `update:modelValue`（那只是打字，会每字一请求，见上方 searchInput 注）。
   *  - el-input `clearable` 的 ✕ 会先发 `update:modelValue('')` 再发 `@clear`：
   *    前者只改输入态（0 请求），后者走本函数提交一次 ⇒ **净 1 次请求**，不双发。
   *  - Object.assign 与 page=1 是同一同步块内完成，`watch(defaultedOptions)` 是
   *    pre-flush ⇒ computed 只在块末求值一次 ⇒ 单次 setOptions ⇒ 单次 fetch。
   *
   * 2026-10-01 review 第 2 轮 N-2（把语义钉死，避免后人当 bug 改）：**只有**
   * Enter 与清空会提交输入态。切 Tab（onTabChange 只做 page=1）、翻页 / 改每页条数、
   * 点「刷新」（fetchList = refetch 当前 queryKey）、自动刷新 tick（query-core
   * #executeFetch 复用当前 queryKey，压根不重跑 buildParams）**都不提交**草稿 ——
   * 它们只重拉「已生效」的条件。这是有意的：草稿未提交前不该被其它动作顺带生效。
   * 副作用（也是 N-2 留作后续的已知决策）：草稿不持久化，打字未按 Enter 就离开页面
   * 会丢失；恢复出来的是上次真正生效过的条件，与列表内容自洽。 */
  function onSearch(): void {
    Object.assign(search, searchInput);
    page.value = 1;
  }

  // ============ 持久化 ============
  // ⚠️ key 沿用 `pending_programming_filter`（与 2026-09-29 版一致，不要改：
  // 改 key 老用户的搜索条件 / 自动刷新 / Tab 记忆全丢）。
  // 用泛型 useListStatePersist 而非 useListFilterPersist：后者的 deps 形状固定为
  // { search, sortBy, sortDir, pageSize }（零件一览遗留），本页持久化的是
  // { search, autoRefresh, activeTab } 三字段（无排序交互 / 排序固定）。
  //
  // deps 只放**生效态** search，**不放** searchInput：
  //   1) useListStatePersist.restore() 会校验「每个 dep key 都必须存在于快照里」，
  //      少一个就整份返回 null。往 deps 里加 searchInput 会让 2026-10-01 之前
  //      落盘的快照（只有 search / autoRefresh / activeTab）整体失效 ⇒ 老用户
  //      搜索条件 + 自动刷新 + Tab 记忆全丢。
  //   2) 语义上也只该存生效态：存草稿会让下次进页面时输入框显示一个从未生效过的条件。
  // 副作用（有意为之）：用户打了字没按 Enter 就离开，草稿不保留 —— 恢复出来的是
  // 上次真正生效过的条件，与列表内容一致。
  //
  // 2026-10-01 review 第 1 轮 M-8：删掉原先的 `exclude: new Set(['page'])` —— 它是
  // 空操作（deps 从来就没有 page），留着会让人误以为分页被显式排除。本页**不持久化
  // 分页 / 每页条数**（沿 ListShell.vue:50-57 记录的 2026-08-31 决策：放弃 pageSize
  // 跨会话恢复，进入页面一律默认 20），但**要**持久化 autoRefresh 与 activeTab。
  const { restore: restorePersisted } = useListStatePersist(
    'pending_programming_filter',
    { search, autoRefresh, activeTab },
  );

  function restoreState(): void {
    const s = restorePersisted() as
      | {
          search?: Partial<{ keyword: string; serialNo: string }>;
          autoRefresh?: boolean;
          activeTab?: PendingProgrammingTab;
        }
      | null;
    if (s) {
      if (s.search) Object.assign(search, s.search);
      if (typeof s.autoRefresh === 'boolean') autoRefresh.value = s.autoRefresh;
      if (s.activeTab === 'pending' || s.activeTab === 'programmed') {
        activeTab.value = s.activeTab;
      }
    }
    // 2026-10-01 review 第 1 轮 I-1：把生效态**同步回输入态**，否则输入框空白而
    // 列表已按恢复出的条件过滤 —— 用户看到的框与表不一致，按回车还会把条件清空。
    Object.assign(searchInput, search);
    // 开闸 → useQuery 触发首屏 fetch（视图不再显式调 fetchList）
    restored.value = true;
  }

  // ============ 列可见性 + 列顺序拖动 ============
  // 2026-10-01：列定义搬到独立文件（src/views/cnc/pendingProgrammingColumnDefs.ts），
  // deps 注入本 store 的三个函数（不下发 / 跳详情 / 该行是否下发中）。
  const columnDefs = buildPendingProgrammingColumnDefs({
    openReleaseDialog: (row) => openReleaseDialog(row),
    navigateToPart: (id) => navigateToPart(id),
    isReleasing: (id) => releaseSubmitting.value && releaseTarget.value?.id === id,
  });
  const columnVisibility = useColumnVisibility(columnDefs, {
    listKey: PENDING_PROGRAMMING_LIST_KEY,
  });
  const drag = useColumnDrag(columnDefs, { listKey: PENDING_PROGRAMMING_LIST_KEY });

  // ============ 路由注入（不变量 #4：store 不 import vue-router）============
  // 用 holder 对象装 getter（而不是裸 let 变量）：TS 对闭包捕获的 let 变量做控制流
  // 收窄会把调用点判成「恒为 null」。holder 的属性访问不参与收窄。
  const routerHolder: { get: (() => { push: (path: string) => unknown } | null) | null } = {
    get: null,
  };
  function registerRouter(fn: () => { push: (path: string) => unknown } | null): void {
    routerHolder.get = fn;
  }
  function navigateToPart(id: string): void {
    void routerHolder.get?.()?.push(`/parts/${id}`);
  }

  // ============ 下发对话框数据源（共享基础数据层 query）============
  // 2026-10-01：裸调 listShelves / listProcesses 迁到共享 query
  // （useProductionShelvesQuery 新增 / useProcessesQuery 现成）。两个 query 都在
  // store setup 期间发起（30s staleTime + 跨页共享缓存 ⇒ 重复进本页不再重发；
  // 代价是首屏多两个基础数据请求，取代原「弹窗打开才拉」的懒加载 —— 共享层
  // 本就是短时请求去重层，见 CLAUDE.md 缓存时长策略）。
  const processesQuery = useProcessesQuery({ limit: 200 });
  const shelvesQuery = useProductionShelvesQuery({
    zone: 'PRODUCTION',
    is_active: true,
    limit: 200,
  });
  // 2026-10-01 说明：processes 走 `as Process[]` 桥接 —— processSchema 派生的
  // description / color 是 optional（对齐后端 skip_serializing_if），而 Process 业务类型
  // 是 required，TS 结构不匹配。沿 usePartDispatch.ts 同模式桥接；渲染层
  // （useShelfProcessFilter / el-option label）只读 id / code / name / category，
  // 对 optional 字段无依赖，零行为差异。
  const processes = computed<Process[]>(
    () => (processesQuery.data.value?.items ?? []) as Process[],
  );
  // 2026-10-01：shelfSchema 的字段与 @/types/shelf::Shelf 结构完全一致，无需桥接。
  // 2026-10-02：两侧同步摘除 account_count（用户决定货架列表页不再展示账号数；
  // 后端 ShelfOut 在同 PR 也已删该字段，是另一次独立决策），仍 10 字段对齐。
  const productionShelves = computed<Shelf[]>(() => shelvesQuery.data.value?.items ?? []);
  // 2026-07-17：CNC 下发只允许 INHOUSE 工序（外协工序走 send_to_outsource）
  const inhouseProcesses = computed(() =>
    processes.value.filter((p) => p.category === 'INHOUSE'),
  );
  // 2026-10-01 review 第 1 轮 M-1：两个下拉的**首屏在途态**。数据源从「点下发才
  // await 拉完再开弹窗」换成共享 query（setup 期就发）后，弹窗可能空开，而空态文案
  // 「当前工序未映射到任何生产货架，请先在「货架管理 → 工序映射」配置」是**主动
  // 误导**的（用户会去改映射，其实只是数据还没到）。
  // 取舍：选「弹窗照开 + 空态区分在途」而不是「settle 前不开弹窗」——
  //   · 共享层本就是短时请求去重层，30s 内重复进本页命中缓存几乎零延迟，等它反而
  //     让「点下发 → 弹窗」出现可感知的空档；
  //   · 仓内其它 dialog（PartDetail / OutsourceSendReceive 等）也是「打开即渲染、
  //     数据未到就空/骨架」，不额外引入一个 gate；
  //   · 代价是冷缓存首访可能看到空态，已由下面两个 pending 派生挡住误导文案。
  const processesPending = processesQuery.isPending;
  const shelvesPending = shelvesQuery.isPending;
  // 2026-10-01 review 第 2 轮 N-1：**失败态**也要单独一层。
  // ⚠️ isPending 在失败时是 false（query-core `queryObserver.js:346`
  // `isPending = status === 'pending'`，失败后 status 变 'error'）⇒ 只加 pending 分支
  // 不够：query 挂掉时空态会落回「未映射到任何生产货架，请先配置映射」/「没有可用的
  // 工序」，用户会去改配置，其实只是接口挂了 —— 与 M-1 想消灭的误导同一性质。
  // 错误本身有 ElMessage toast 兜底（见下方 watch），但空态文案必须自己说真话。
  const processesError = computed<string | null>(() => {
    const e = processesQuery.error.value;
    return e ? e.message : null;
  });
  const shelvesError = computed<string | null>(() => {
    const e = shelvesQuery.error.value;
    return e ? e.message : null;
  });

  // 2026-07-17：useShelfProcessFilter 双向收窄（货架↔工序映射过滤）。
  // ⚠️ 该 composable 跨 3 页共用（cnc / outsource / inspection / parts-detail），
  // 本次不动它，仅换数据源。
  const {
    filteredShelves: filteredProductionShelves,
    filteredProcesses: filteredInhouseProcesses,
  } = useShelfProcessFilter(
    productionShelves,
    inhouseProcesses,
    releaseShelfId,
    releaseProcessId,
  );

  // 旧视图在 openReleaseDialog 的 try/catch 里弹「加载失败：xxx」；数据源迁到
  // useQuery 后错误不再抛到对话框打开逻辑，改由 watch 桥接（沿 CLAUDE.md
  // TanStack Query 架构条目 #9「useQuery 的 error 不在 setup 抛错」）。
  watch([processesQuery.error, shelvesQuery.error], ([procErr, shelfErr]) => {
    const msg = (procErr ?? shelfErr)?.message;
    if (msg) ElMessage.error(`加载失败：${msg}`);
  });

  function openReleaseDialog(row: PendingProgrammingRow): void {
    releaseTarget.value = row;
    releaseShelfId.value = null;
    releaseProcessId.value = null;
    releaseDialogVisible.value = true;
    // 2026-10-02：不再显式 load() —— 映射改由共享 query 跟随上面两个基础数据 query
    // 就绪自动开闸（productionShelves / inhouseProcesses 都非空时），实际比旧
    // 「点下发才拉」更早到位。
  }

  function onReleaseDialogClosed(): void {
    releaseTarget.value = null;
    releaseShelfId.value = null;
    releaseProcessId.value = null;
  }

  // ============ 下发 mutation（PROGRAMMING → IN_PROCESS）============
  const releaseMutation = useMutation<
    unknown,
    Error,
    { partId: string; shelfId: string; nextProcessId: string; router: PendingProgrammingRouter }
  >({
    mutationKey: ['programming', 'release-from-programming'],
    // 2026-10-02 已知缺口：release-from-programming 迁 prod 域并以批次为锚，而本页
    // 数据源 `GET /prod/programming/pending` 的行不携带批次 id，拿不到锚点。此时直接
    // 失败并说明原因，不用 part_id 顶替（那会打成「批次不存在」）。待后端在该列表项
    // 补上批次 id 后，把本 throw 换成传 batchId 即可。
    mutationFn: () => {
      throw new Error(RELEASE_NO_BATCH_HINT);
    },
    onSuccess: async () => {
      // 失效本域（待编程列表）+ parts 域（下发改了 part 的 status / 货架归属）
      await invalidateProgrammingQuery(qc);
      await qc.invalidateQueries({ queryKey: qk.partsPrefix });
      ElMessage.success(releasedMessage());
    },
    onError: async (e, v) => {
      // 2026-09-16 PR-3：20706 BIZ_PROCESS_CHAIN_REQUIRED 兜底 —— 弹「前往制定」框；
      // 命中后不再弹普通错误提示（沿 PendingProgrammingList.vue 迁移前的语义）。
      const handled = await handleProcessChainRequired(e, v.partId, v.router);
      if (!handled) ElMessage.error(e.message ?? '下发失败');
    },
  });

  /** 成功文案：带零件标识 + 目标货架 code（旧视图行为，2026-10-01 保留）；
   *  目标行已被清空时回落到通用文案。 */
  function releasedMessage(): string {
    const row = releaseTarget.value;
    if (!row) return '已下发到生产货架';
    const shelfCode =
      productionShelves.value.find((s) => s.id === releaseShelfId.value)?.code ?? '';
    return shelfCode
      ? `零件 ${row.serial_no || row.drawing_no} 已下发到生产货架 ${shelfCode}`
      : '已下发到生产货架';
  }

  /** 视图「确认下发」按钮：校验选择 → 跑 mutation → 成功后关对话框。
   *  router 由视图传入（store 不 import vue-router，不变量 #4）。 */
  async function confirmRelease(router: PendingProgrammingRouter): Promise<void> {
    const target = releaseTarget.value;
    if (!target || !releaseShelfId.value || !releaseProcessId.value) return;
    releaseSubmitting.value = true;
    try {
      await releaseMutation.mutateAsync({
        partId: target.id,
        shelfId: releaseShelfId.value,
        nextProcessId: releaseProcessId.value,
        router,
      });
      releaseDialogVisible.value = false;
    } catch {
      // onError 已提示（20706 兜底框 or 普通 ElMessage.error），这里只收尾
    } finally {
      releaseSubmitting.value = false;
    }
  }

  // ============ 对外切片 ============
  // ⚠️ 为什么切 query / release 两个 slice，而不是把 15 个 ref 平铺在 store 顶层：
  // Pinia setup store 的 `$dispose()` 只做 `scope.stop()` + 清订阅 + 从 `pinia._s`
  // 摘除，**不删** `pinia.state.value[$id]`；下次 `useStore()` 时 Pinia 会把
  // 上次残留的 state **hydrate 回新建的 ref**（pinia.mjs createSetupStore 的
  // `if (initialState && shouldHydrate(prop)) prop.value = initialState[key]`）。
  //   - 平铺的顶层 ref（如 releaseDialogVisible / page）会被序列化进 state ⇒
  //     $dispose 后「对话框还开着 / 停在第 3 页」泄漏到下次进入，直接违反
  //     不变量 #2；
  //   - 切成 plain object slice 后，slice 既不是 ref 也不是 reactive，Pinia
  //     不会把它写进 state ⇒ $dispose 后真 fresh。
  // 这也是 usePartsListStore 切成 query / filters / batch / dispatch 切片的
  // 同源原因（那里靠 batchMode 泄漏的回归用例守住）。
  return {
    // 主查询切片：筛选 / Tab / 分页 + items / total / loading / 错误
    query: {
      /** 生效态（进 queryKey ⇒ 进请求）。视图不直接绑 v-model，只经 onSearch 写。 */
      search,
      /** 输入态（视图 el-input 的 v-model 绑这里）；打字 0 请求，提交走 onSearch */
      searchInput,
      activeTab,
      autoRefresh,
      page,
      pageSize,
      items,
      total,
      loading,
      errorMsg,
      emptyText,
      /** fetchList 别名（视图「刷新」按钮 / 测试驱动） */
      fetchList,
      onTabChange,
      /** 提交搜索：searchInput → search + page=1（Enter / @clear 触发） */
      onSearch,
      restoreState,
    },
    // 下发对话框切片
    release: {
      dialogVisible: releaseDialogVisible,
      target: releaseTarget,
      shelfId: releaseShelfId,
      processId: releaseProcessId,
      submitting: releaseSubmitting,
      /** useShelfProcessFilter 双向收窄后的候选（数据源：共享 query，见上） */
      filteredShelves: filteredProductionShelves,
      filteredProcesses: filteredInhouseProcesses,
      // 2026-10-01 review 第 1 轮 M-1：下拉空态要能区分「数据在途」与「真的没映射」
      processesPending,
      shelvesPending,
      // 2026-10-01 review 第 2 轮 N-1：再区分「加载失败」—— isPending 在失败时为
      // false，没有这一层空态会落回「未映射，请去配置映射」的误导文案
      processesError,
      shelvesError,
      openDialog: openReleaseDialog,
      onDialogClosed: onReleaseDialogClosed,
      confirm: confirmRelease,
      // 2026-10-01 review 第 1 轮 M-3：**不再**对外暴露 releaseMutation。
      // 行内「下发」按钮的 loading 由 submitting + target 派生即可
      // （columnDefs 的 isReleasing 闭包），错误提示走 onError 的 ElMessage /
      // 20706 兜底框，视图与测试都不需要读 mutation 对象 —— 暴露出去只是死 API。
    },
    // 列
    columnDefs,
    columnVisibility,
    drag,
    registerRouter,
  };
});

/** 失效整个 programming 域（写操作 release-from-programming 成功后调）。
 *  返回 Promise<void> 让 caller 可以 await 失效完成再走后续逻辑。 */
export function invalidateProgrammingQuery(qc: QueryClient): Promise<void> {
  return qc.invalidateQueries({ queryKey: qk.programmingPrefix }).then(() => undefined);
}

/** 行类型再导出（视图 cellRender / 测试用；与 api/programming 的 z.infer 同源）。 */
export type { PendingProgrammingItemSchema, PendingProgrammingRow };
