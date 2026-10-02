// views/parts/detail/composables/useDefaultBatchSelection.ts
//
// 2026-10-03 新增：批次列表到达后的兜底选中（详情页三卡联动的初始锚点）。
//
// 为什么要有：selectedBatchId 只有一个写入来源 —— 用户点批次行。没人点过 ⇒ 恒 null
// ⇒ useProcessChain.currentStepId 恒 null ⇒ 工序链时间轴整条全灰、「当前」徽标永不
// 出现。所以 batches 到达时需要一个默认锚点。规则是**优先带工序链定位的批次**：
// `GET /parts/{id}/batches` 无 status 过滤且按 batch_no ASC 排序，第一行是最老批次，
// 而初始批次（PENDING）与被取消的批次 current_process_step_id 恒为 NULL
// （初始 batch 不在生产流），选中它们等于没选中。
//
// 连带影响（有意为之）：PartHistoryCard 跟随 selectedBatchId 过滤，进页面即落到
// 某个批次的事件视图；再点一次该行（onBatchSelect(null)）可切回全量事件。
//
// 不动用户已有选择：判据是 selectedBatchId === null。用户点行取消选中不会引发
// batches 引用变化，故不会被选回；切 partId 时 selectedBatchId 被重置为 null，
// 紧接着新 part 的 batches 到达由本 watch 重新兜底。

import { watch, type Ref } from 'vue';
import type { PartBatch } from '@/api/parts';

/** 兜底选中的判据：current_process_step_id 非空 = 该批次在工序链上有定位。
 *  只有这样的批次才能让 ProcessChainCard 落出 `.current-step` 高亮。 */
export function pickDefaultBatch(batches: PartBatch[]): PartBatch | null {
  if (batches.length === 0) return null;
  return batches.find((b) => Boolean(b.current_process_step_id)) ?? batches[0]!;
}

/** batches 到达时给 selectedBatchId 兜底；不覆盖用户已有的选择。
 *  immediate：调用时若已有批次（缓存已就位）也立即兜底一次。 */
export function useDefaultBatchSelection(
  batches: Ref<PartBatch[]>,
  selectedBatchId: Ref<string | null>,
): void {
  watch(
    batches,
    (list) => {
      if (selectedBatchId.value !== null) return;
      const target = pickDefaultBatch(list);
      if (target) selectedBatchId.value = target.id;
    },
    { immediate: true },
  );
}
