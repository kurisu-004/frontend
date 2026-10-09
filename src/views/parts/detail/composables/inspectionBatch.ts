// views/parts/detail/composables/inspectionBatch.ts
//
// 2026-10-10 新增（review 第 1 轮）：品检锚批次的**唯一**派生口径。
//
// 它同时喂三处，缺一处就会出现「界面上是一个批次、写下去打到另一个批次」：
//   1. 底部按钮组的显隐 + 「目标批次 X」标识（`PartDetail.vue`）；
//   2. 「指定下一道工序」弹窗的目标批次回显（`PartDetail.vue`）；
//   3. 两个品检写操作的锚（`usePartDetailActions.ts` 的 bindings）。
//
// 口径：**用户选中的批次是品检中就用它，否则回落到列表里第一个 INSPECTION 批次**。
// 收敛这一步是因为此前两条动作锚不同批次：品检通过按 `find(INSPECTION)` 取列表序第一
// 条，指定工序按 shell 传的 `selectedBatchId` 取用户当前选中行 —— 多批次工单上两者
// 打不同的批次，而按钮上没有任何标识能分辨（后端 `fix(batch):
// find_current_inspection_batch_id 遇多 INSPECTION 批次改返 id 不返 500` 这条修复本身
// 就说明「多 INSPECTION 批次」是真实场景，不是理论边界）。
//
// 但**不能只按 `find(INSPECTION)` 取**：那是「忽略用户选择」。用户在批次表里选中的行
// 是他此刻正在看的那一批，选中的是品检批次时点「品检通过」却打在别批上是更差的错。
// 「尊重选择」与「两个按钮必然同批」并不冲突 —— 两条动作共用本函数即可同时成立。
//
// ⚠️ 判据读**批次**而不读 `part.status`：`t_part.status` 是 min-progress 派生列，同工单
// 只要还有任一批次进度更靠前，整单就派生成那个更早的状态 ⇒ 多批次工单上会出现
// 「批次是 INSPECTION、`t_part.status` 却是 IN_PROCESS」而按钮整排消失、该批次永远动不了。
// 后端 `prod/batch/service/transition_core.rs::to_ship_core` 对同一处有长注释警告。

import type { PartBatch } from '@/api/parts';

/**
 * 品检锚批次；null = 当前没有可流转的品检批次（调用方据此隐藏按钮 / 拒发请求）。
 *
 * @param batches 该工单的批次列表（`usePartDetail` 的投影）。
 * @param selectedBatchId 用户在批次表里当前选中的批次 id（`PartDetail.vue` 的局部 ref）。
 */
export function resolveInspectionBatch(
  batches: PartBatch[],
  selectedBatchId: string | null | undefined,
): PartBatch | null {
  const selected = selectedBatchId ? batches.find((b) => b.id === selectedBatchId) : undefined;
  if (selected?.status === 'INSPECTION') return selected;
  return batches.find((b) => b.status === 'INSPECTION') ?? null;
}
