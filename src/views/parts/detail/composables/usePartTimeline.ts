// views/parts/detail/composables/usePartTimeline.ts
//
// 2026-10-10 新增：时间线卡（批次监控 + 历史 + 工序链）的**联动锚与派生层**。
//
// 三张卡共享同一个锚 `selectedBatchId`，而「品检按钮打哪个批次」又是一个从批次列表
// 派生出来的独立口径（`inspectionBatch.ts`）。这些派生散在 shell 里会让「按钮显隐 /
// 弹窗回显 / 写操作锚」三处各读一次不同来源 —— 本文件把它们收在一处，shell 只拿返回值
// 往 `PartActionBar` / `PartFailInspectionDialog` / `usePartDetailActions` 上分派。
//
// ⚠️ **口径唯一**：`inspectionBatch` 同时是
//   1. 「品检通过 / 指定工序」两个按钮的显隐判据；
//   2. 「指定工序」弹窗的目标批次回显；
//   3. 两个品检写操作的锚（`usePartDetailActions` 的 bindings）。
// 三处读的是**同一个**派生值，所以「界面上是一个批次、写下去打到另一个批次」不可能发生。
// 反过来，`selectedBatchId` 是**视图锚**（「用户在看哪个批次」），绝不能拿它当写锚。

import { computed, ref, watch, type ComputedRef, type Ref } from 'vue';
import type { PartBatch } from '@/api/parts';
import { useProcessesQuery } from '@/composables/queries/useProcessesQuery';
import type { Process } from '@/types/process';
import type { PartDetailData } from './partDetailSchema';
import { resolveInspectionBatch } from './inspectionBatch';
import { useProcessChain } from './useProcessChain';
import { useDefaultBatchSelection } from './useDefaultBatchSelection';

export function usePartTimeline(
  partId: Ref<string>,
  part: ComputedRef<PartDetailData | null>,
  batches: ComputedRef<PartBatch[]>,
) {
  // ============ 联动锚 ============
  /** 批次行选中。唯一写入来源是「点批次行」（同一行二次点击 = 撤销选中）。 */
  const selectedBatchId = ref<string | null>(null);

  function onBatchSelect(b: PartBatch | null): void {
    selectedBatchId.value = b?.id ?? null;
  }

  /**
   * 品检锚批次。口径见 `inspectionBatch.ts`：选中的批次在品检中就用它，否则回落列表里
   * 第一个 INSPECTION 批次。判据读**批次**而不读 `part.status` —— `t_part.status` 是
   * min-progress 派生列，多批次工单上会出现「批次已在品检、整单状态还在靠前」。
   */
  const inspectionBatch = computed(() =>
    resolveInspectionBatch(batches.value, selectedBatchId.value),
  );

  // ============ 工序链 ============
  const processChain = useProcessChain(
    partId,
    computed(() => part.value),
    computed(() => batches.value),
    selectedBatchId,
  );
  const currentStepId = computed<string | null>(() => processChain.currentStepId.value);

  /**
   * `part.process_chain_id` 变化时拉链（首次 part 加载 + 工艺变更）；`useProcessChain`
   * 内部已 watch partId 清状态，这里只触发拉取。chain 变化前先清 `selectedBatchId`，
   * 免得旧批次 id 在链未拉完时被 `currentStepId` 引用到错误的 step。
   *
   * ⚠️ 既有健壮性缺口（登记不改逻辑）：这里只置空 `selectedBatchId`，**不重取 batches**
   * ⇒ 若现有 batches 里没有带 `current_process_step_id` 的批次，`useDefaultBatchSelection`
   * 的兜底也补不出选中项，工序链时间轴会继续整条全灰。当前不可达：本页没有链编辑入口，
   * `process_chain_id` 变化只可能由切 partId 触发，而那会改 `usePartBatchesQuery` 的
   * ownerPartId ⇒ reactive queryKey 自己驱动重取。将来本页加入链编辑能力时必须在此补
   * refetch。
   */
  watch(
    () => part.value?.process_chain_id,
    (id) => {
      if (id) {
        selectedBatchId.value = null;
        void processChain.fetchProcessChain();
      }
    },
  );

  // 兜底选中：selectedBatchId 没人点过时恒为 null ⇒ currentStepId 恒 null ⇒ 工序链
  // 时间轴整条全灰、「当前」徽标永不出现。判据（优先带 current_process_step_id 的批次，
  // 否则回落第一条）与「不覆盖用户已有选择」的语义在 useDefaultBatchSelection 里。
  // 连带影响：PartHistoryCard 跟随 selectedBatchId 过滤，进页面即落到该批次的事件视图。
  useDefaultBatchSelection(batches, selectedBatchId);

  // ============ 共享 processes 缓存 ============
  // 「指定工序」弹窗的工序下拉与 ProcessChainCard 的名称字典共用这一份。
  // `as Process[]` 桥接：processSchema 派生的 description / color 是 optional（对齐后端
  // skip_serializing_if），而 Process 业务类型是 required，TS 结构不匹配。两个消费方
  // 只读 id / code / name / category，对 optional 字段无依赖，零行为差异。
  const processesQuery = useProcessesQuery({ limit: 200 });
  const processes = computed<Process[]>(
    () => (processesQuery.data.value?.items ?? []) as Process[],
  );

  /** ProcessChainCard 需要 { process_id → { code, name } } 字典；O(1) 查找，避免组件内
   *  v-for .find。 */
  const processesLookup = computed<Record<string, { code: string; name: string }>>(() => {
    const map: Record<string, { code: string; name: string }> = {};
    for (const p of processes.value) {
      map[p.id] = { code: p.code, name: p.name };
    }
    return map;
  });

  return {
    selectedBatchId,
    onBatchSelect,
    inspectionBatch,
    processChain,
    currentStepId,
    processes,
    processesLookup,
  };
}
