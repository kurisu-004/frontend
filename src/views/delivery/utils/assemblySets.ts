// src/views/delivery/utils/assemblySets.ts
//
// 装配件套数字段的读取口径。详情页 tree 父行（useDeliveryNoteDetail）与打印预览的
// 「合并一套」父行（PrintPreviewDialog）共用这一份实现：同一张装配件在两页显示的套数
// 必须同源，两处各写一套兜底迟早会出现「详情页 1 套 / 预览 4 套」这类分裂。
//
// 后端契约（详情接口 line_items）：
// - assembly_quantity = 装配件**工单总套数**（该装配体整单要做的套数，与本单无关），
//   组内各子件行重复同一值。
// - shippable_sets = 该装配件**在本单可出货的套数**，是 note 级聚合值：同一
//   assembly_id 的每个子件行都填同一个值（后端按 assembly_id 归并后回填到组内每行）；
//   子件在本单凑不齐整套时为 0 套（凑不齐整套不能发货）；散件行两个字段都是 null。
//
// 两个字段都可能整体缺失（后端未上线该字段）。缺失一律读成 null，**不得兜成 0**：
// 「后端没给数」与「真的 0 套」在业务上完全相反（前者照常能打，后者打不了整套），
// 兜成 0 会让用户以为这张单子凑不齐一套。

import type { DeliveryNoteLineItem } from '@/types/deliveryNote';

/** 装配件工单总套数：取组内首个有值的子件行（组内等值，缺失则 null）。 */
export function assemblyTotalSetsOfGroup(siblings: readonly DeliveryNoteLineItem[]): number | null {
  return siblings.find((s) => s.assembly_quantity != null)?.assembly_quantity ?? null;
}

/** 装配件在本单可出货的套数：只对有值的子件取 min，组内全缺（后端未给数）则 null。
 *  取 min 是不依赖后端把整组填满的保守口径 —— 真给满了组内等值，min 是 no-op。 */
export function shippableSetsOfGroup(siblings: readonly DeliveryNoteLineItem[]): number | null {
  const present = siblings.map((s) => s.shippable_sets).filter((v): v is number => v != null);
  return present.length === 0 ? null : Math.min(...present);
}
