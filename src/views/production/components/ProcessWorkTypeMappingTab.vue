<!-- 工序映射 Tab（2026-09-12 从 settings/WorkTypeProcess.vue 迁移至 production/components） -->
<template>
  <div class="wt-proc">
    <el-card shadow="never" class="layout-card">
      <div class="layout">
        <!-- 左:工种列表 -->
        <div class="left">
          <div class="left-title">工种</div>
          <el-table
            v-loading="wtQuery.isFetching.value"
            :data="workTypes"
            highlight-current-row
            :row-key="(r: WorkType) => r.id"
            size="small"
            border
            stripe
            height="100%"
            @row-click="onSelectWT"
          >
            <el-table-column prop="code" label="代码" min-width="120" align="center" />
            <el-table-column prop="name" label="名称" min-width="120" align="center" />
          </el-table>
        </div>
        <!-- 右:映射工序 -->
        <div class="right">
          <div class="right-title">
            <span>{{ mappingTitle }}</span>
            <el-button
              v-if="selectedWT"
              type="primary"
              size="small"
              :loading="saveMutation.isPending.value"
              :disabled="!dirty || mappingQuery.isError.value || mappingQuery.isPending.value"
              @click="onSave"
              >保存映射</el-button
            >
          </div>
          <el-checkbox-group
            v-model="selectedProcessIds"
            v-loading="mappingQuery.isPending.value"
            class="proc-group"
          >
            <el-checkbox
              v-for="p in processes"
              :key="p.id"
              :value="p.id"
              :label="p.id"
              border
              class="proc-item"
            >
              <span class="proc-label">
                <span v-if="p.color" class="color-dot" :style="{ background: p.color }" />
                <strong>{{ p.code }}</strong>
                <span style="margin-left: 6px">{{ p.name }}</span>
                <el-tag
                  :type="p.category === 'INHOUSE' ? 'primary' : 'warning'"
                  size="small"
                  style="margin-left: 6px"
                  >{{ PROCESS_CATEGORY_LABEL[p.category] }}</el-tag
                >
              </span>
            </el-checkbox>
          </el-checkbox-group>
        </div>
      </div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
// 2026-10-02 重构：迁移到共享基础数据层（useWorkTypesQuery / useProcessesQuery），
// 修三个线上 bug。根因与逐条修法见文件下方「2026-10-02 变更日志」块。
import { computed, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { useMutation, useQueryClient } from '@tanstack/vue-query';
import {
  setWorkTypeProcesses,
  toWorkTypeProcessIds,
  toWorkTypeProcessesPayload,
} from '@/api/workType';
import {
  invalidateWorkTypeProcessesQuery,
  invalidateWorkTypesQuery,
  useWorkTypeProcessesQuery,
  useWorkTypesQuery,
} from '@/composables/queries/useWorkTypesQuery';
import { useProcessesQuery } from '@/composables/queries/useProcessesQuery';
import type { WorkType, SetWorkTypeProcessesPayload } from '@/types/workType';
import type { Process } from '@/types/process';
import { PROCESS_CATEGORY_LABEL } from '@/types/process';

const qc = useQueryClient();

// 左表：工种。共享 query + Zod 守门（此前裸调 listWorkTypes，零守门）。
const wtQuery = useWorkTypesQuery({ limit: 200 });
const workTypes = computed<WorkType[]>(() => wtQuery.data.value?.items ?? []);

// 右表勾选源：工序。走共享 useProcessesQuery({limit: 200})，与
// src/views/parts/list/composables/usePartDispatch.ts:110 与
// src/views/cnc/composables/usePendingProgrammingStore.ts:296 **同一个 queryKey**
// ⇒ 直接共享缓存（30s 窗口内不再重复发请求），并消掉本 Tab 绕过
// invalidateProcessesQuery 的独立拉取。
// 桥接 cast 理由沿 usePartDispatch.ts:115-122：Zod 派生的 description / color 是
// optional（后端 skip_serializing_if），Process 业务类型是 required。
const procQuery = useProcessesQuery({ limit: 200 });
const processes = computed<Process[]>(() => (procQuery.data.value?.items ?? []) as Process[]);

const selectedWT = ref<WorkType | null>(null);
const selectedWTId = computed<string>(() => selectedWT.value?.id ?? '');

/** 2026-10-02：映射 query 是勾选初值 + 错误态的唯一来源。
 *  key = 当前选中工种；空字符串时 enabled=false（零请求）。 */
const mappingQuery = useWorkTypeProcessesQuery(selectedWTId);

/** 2026-10-02：**用户**勾选态**（不是加载结果）。初值由下方 watcher 从
 *  mappingQuery.data 派生（读形态收口在 toWorkTypeProcessIds）。 */
const selectedProcessIds = ref<string[]>([]);

/** 2026-10-02：dirty 基线改取 mapping query 的当前 data（computed，非手写 ref）。
 *  旧实现用 `initialProcessIds` ref，而它在**加载失败时不更新**（catch 里 return），
 *  于是残留上一个工种的 id → 切到加载失败的工种时 watcher 立刻把 dirty 置 true
 *  → 保存按钮直接可点 → 拿不完整快照整组覆盖真实映射。基线绑到 query data 后，
 *  失败态下基线恒为 []，dirty 要么 false、要么等用户在未知态下自己勾选 —— 而那条
 *  路又被 onSave 的硬闸拦住（见下）。 */
const baselineProcessIds = computed<string[]>(() =>
  mappingQuery.data.value ? toWorkTypeProcessIds(mappingQuery.data.value) : [],
);

const dirty = computed<boolean>(() => {
  if (!selectedWT.value) return false;
  const a = [...selectedProcessIds.value].sort();
  const b = [...baselineProcessIds.value].sort();
  return a.length !== b.length || a.some((x, i) => x !== b[i]);
});

const mappingTitle = computed(() =>
  selectedWT.value ? `「${selectedWT.value.name}」可执行的工序` : '请选择工种',
);

function onSelectWT(row: WorkType): void {
  const sameWorkType = selectedWT.value?.id === row.id;
  // 2026-10-02 review 第 1 轮（MINOR-2）：**切到别的工种时立刻清零勾选**。
  // 下方 watcher 判据是 `!data → return`（这是对的：用 isError 当守卫会漏掉「失败后
  // 重试成功那一次」同步），代价是 A→B 加载失败时勾选区**残留 A 的勾**，标题却写着
  // B —— 纯显示不一致。写路径已被 onSave 硬闸 + 按钮 disabled 双重封死（不丢数据），
  // 但「不知道现状」时展示别人的勾选本身就是误导，故在切换点清零。
  // ⚠️ 只在 **id 变化**时清零：同工种重复点击是「重试」（见下），此时清零会把
  // 用户在重试前看到的内容也抹掉，与 P4 用例的期望直接冲突。
  if (!sameWorkType) selectedProcessIds.value = [];
  selectedWT.value = row;
  // 2026-10-02：**同一工种重复点击 = 用户在重试**。
  // queryKey 不变时 vue-query 不会自动重发（error 态的 query 不会自愈，也不在
  // staleTime/refetchOnWindowFocus 范围内），所以不显式 refetch 的话，下面那句
  // 「请重新选择该工种后再试」对同一个工种就是**假的提示** —— 重新点一次
  // 什么都不会发生，用户只能刷新整个页面。切到**别的**工种会换 key、会自动重发，
  // 不需要这段。
  if (sameWorkType && mappingQuery.isError.value) void mappingQuery.refetch();
}

/** 2026-10-02：勾选态与「服务端基线」同步。
 *  触发点 = ① 切换工种（selectedWTId 变）② 该工种映射数据到达（含失败后重试成功）。
 *  ⚠️ **没有加载出 data 时一个字都不改勾选**（判据是 `!data` 而不是 `isError`：
 *  刷新中的 error query 仍带 isError=true，用它当守卫会漏掉「重试成功后到达」那
 *  一次同步）。失败态下勾选是不可信快照 —— 但这不代表「可以保存」：onSave 硬闸 +
 *  按钮 disabled 双重拦住。 */
watch(
  [selectedWTId, mappingQuery.data],
  () => {
    if (!mappingQuery.data.value) return;
    selectedProcessIds.value = toWorkTypeProcessIds(mappingQuery.data.value);
  },
  { immediate: true },
);

// 2026-10-02：query 的 error 走 watch 桥接出 toast（CLAUDE.md 架构条目 §9：
// useQuery 的 error 不在 setup 抛错）。映射那条的文案要点明「保存已被禁用」——
// 否则用户看到一个空勾选区会以为「这个工种没配工序」。
watch(wtQuery.error, (e) => e && ElMessage.error(e.message ?? '加载工种失败'));
watch(procQuery.error, (e) => e && ElMessage.error(e.message ?? '加载工序失败'));
watch(
  mappingQuery.error,
  (e) => e && ElMessage.error(`${e.message ?? '加载映射失败'}，保存已禁用`),
);

// TData 用 unknown 而非 void：`setWorkTypeProcesses` 返回 Promise<void>（后端
// `data: null`，整组替换无回显），mutation 的成功返回值本组件不消费；而
// eslint 的 no-invalid-void-type 禁止把 void 用作泛型实参。与同域
// usePartInlineEdit.ts:234 的 `useMutation<unknown, Error, …>` 同款处理。
const saveMutation = useMutation<
  unknown,
  Error,
  { workTypeId: string; payload: SetWorkTypeProcessesPayload }
>({
  // 不写 retry：信任 src/main.ts 全局 mutations.retry: 0。
  mutationKey: ['work-types', 'set-processes'],
  mutationFn: ({ workTypeId, payload }) => setWorkTypeProcesses(workTypeId, payload),
  onSuccess: async () => {
    // 2026-10-02：两个域都失效。workTypesPrefix 是**缓存一致性维护位**，不是当前
    // 可见 bug 的修复 —— 左表只渲染 code / name（见模板），且全仓**只有**本 Tab 一个
    // useWorkTypesQuery 消费者，映射一改左表画面不会有任何变化。之所以仍然失效：
    // 后端 WorkTypeOut.process_ids 由 list 端点批量补全（vo/work_type.rs:20），
    // 缓存里躺着的确实是过期数据；将来左表一旦加列（如「已映射 N 道工序」）就会
    // 立刻暴出「左表旧快照 + 右表已新」的分裂。留着它成本是每次保存多一次
    // 后台 refetch（30s staleTime 下通常不真发请求），换来的是这条失效链不依赖
    // 「左表恰好不读 process_ids」这个脆弱前提。
    await invalidateWorkTypeProcessesQuery(qc);
    await invalidateWorkTypesQuery(qc);
    ElMessage.success('已保存');
  },
  onError: (e) => ElMessage.error(e.message ?? '保存失败'),
});

/** 2026-10-02：保存（**整组替换**语义）。
 *
 * ⚠️ 加载失败硬闸 —— 防止「静默清空整组映射」的最后一道闸：
 * 该端点是整组替换（后端 service 先清空再 bulk_insert，`items: []` = 清空）。
 * 映射加载失败时用户看到的是**空/不完整勾选**，此时点保存 = 用不完整快照整组覆盖
 * 真实映射，且后端返回 200 + 「已保存」提示 —— 用户完全无从察觉数据被清掉。
 * 所以「不知道现状」时**绝不允许写**：isError 或 data 为空一律早退。
 * 用 query 自带的错误态表达「未成功加载」，不再手写 processLoadFailed ref ——
 * query 的 error 态就是那个语义（手写状态位还得手动复位，是 P4 那类回归的来源）。
 *
 * 2026-10-02 review 第 1 轮（MINOR-1）：**加载中**与**加载失败**拆成两条早退。
 * 合并写会误导：A 加载完成后点 B，B 的请求在飞的那一瞬 `data` 为 undefined
 * （新 queryKey 无缓存）⇒ baseline 落到 `[]` 而勾选还带着 A 的内容 ⇒ dirty=true、
 * isError=false、isPending=true。按钮现已把 isPending 一并计入 disabled（见模板），
 * 所以这条分支正常不可达；保留它是给「按钮 disabled 与 onSave 之间状态翻转」留的
 * 兜底，而文案必须说清是哪一种 —— 早先统一弹「加载失败…请重新选择该工种」，
 * 在「其实只是还在加载」时是假提示。 */
async function onSave(): Promise<void> {
  if (!selectedWT.value) return;
  if (mappingQuery.isPending.value) {
    ElMessage.error('工序映射仍在加载中，未做任何保存：请稍候再试');
    return;
  }
  if (mappingQuery.isError.value || !mappingQuery.data.value) {
    ElMessage.error('工序映射加载失败，未做任何保存：请重新选择该工种后再试');
    return;
  }
  // 2026-10-02：payload 由纯函数生成（读形态 / 写形态两端都收口到
  // src/api/workType.ts + src/api/workType.spec.ts 逐字断言）。
  // 旧实现内联 `{process_ids: [...]}` —— 后端 SetWorkTypeProcessesRequest 无该键。
  try {
    await saveMutation.mutateAsync({
      workTypeId: selectedWT.value.id,
      payload: toWorkTypeProcessesPayload(selectedProcessIds.value),
    });
  } catch {
    // 错误提示已由 mutation onError 统一处理
  }
}

// ============================================================
// 2026-10-02 变更日志（迁移到共享基础数据层 + 修三个线上 bug）
//
// BUG-1「Cannot read properties of undefined (reading 'map')」
//   旧 onSelectWT 读 `detail.processes`（旧类型 WorkTypeWithProcesses 是 v1 影子
//   类型），后端 WorkTypeProcessMappingOut **只有 items 键** ⇒ `processes` 恒
//   undefined ⇒ `.map()` 抛 TypeError ⇒ 被裸 catch 吞掉后原样 ElMessage.error 弹
//   出（那就是用户看到的 toast）。该域零 Zod 守门、零 queryKey，编译期不拦。
//   修：读形态收口到 `toWorkTypeProcessIds(result)` 纯函数 + 新增
//   `workTypeProcessesResultSchema` 守门（4 字段全必填）；影子类型已删除。
//
// BUG-2「保存后该工种全部映射被静默清空」
//   旧 onSave 发 `{process_ids: selectedProcessIds}`，后端要
//   `items: [{process_id, sort_order}]`（整组替换）。三处叠加：
//     ① payload 形态错（v1 影子）；② 加载失败时 initialProcessIds 残留上一个工种
//        的 id，dirty watcher 立刻置 true，保存按钮直接可点；③ 无失败硬闸。
//   修：payload 由 `toWorkTypeProcessesPayload` 生成（含去重 + sort_order 重排）；
//   dirty 基线改绑 mapping query data（失败态恒 []）；onSave 开头硬闸；
//   按钮 `:disabled="!dirty || mappingQuery.isError.value"`。
//
// BUG-3「保存后不刷新」
//   旧 onSave 成功后只改本地 initialProcessIds，不失效任何缓存。修：onSuccess
//   失效 workTypeProcessesPrefix + workTypesPrefix（两个都要，理由见上）。
//
// 一并删除：onMounted 的 Promise.all([fetchWorkTypes(), fetchProcesses()])、
// fetchWorkTypes / fetchProcesses 两个函数、手写的 loadingWT / loadingMapping
// （改读 query 的 isFetching / isPending）、initialProcessIds ref、saving ref
// （改读 saveMutation.isPending）。
// ============================================================
</script>

<style lang="scss" scoped>
.wt-proc {
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: calc(100vh - 160px);
}
.layout-card {
  flex: 1;
  min-height: 0;
  :deep(.el-card__body) {
    height: 100%;
  }
}
.layout {
  display: flex;
  gap: 16px;
  height: 100%;
  min-height: 480px;
}
.left {
  flex: 0 0 320px;
  display: flex;
  flex-direction: column;
}
.left-title,
.right-title {
  font-weight: 600;
  font-size: 14px;
  margin-bottom: 8px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.right {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.proc-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow-y: auto;
  flex: 1;
}
.proc-item {
  margin: 0 !important;
  padding: 8px 12px !important;
  :deep(.el-checkbox__label) {
    width: 100%;
  }
}
.proc-label {
  display: inline-flex;
  align-items: center;
}
.color-dot {
  display: inline-block;
  width: 12px;
  height: 12px;
  border-radius: 2px;
  margin-right: 6px;
  border: 1px solid #eee;
  vertical-align: middle;
}
</style>
