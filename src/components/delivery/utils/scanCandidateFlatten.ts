// src/components/delivery/utils/scanCandidateFlatten.ts
//
// 2026-08-31 抽出：DeliveryScanCandidateDialog 的纯函数（flatBatches +
// filterTargetsByKind）独立成模块，便于单测。SFC 仍负责 el-dialog / el-table 装配。
//
// 设计要点：
// - 纯函数：不依赖 Vue 实例或组件状态；输入 targets + selected → 输出结构化行 / 临时结构。
// - 行顺序：ATTACHABLE 在前（同组聚集），INSPECTABLE 在后，与原 spec 一致。

import type { ScanUnresolvedTarget } from '@/types/deliveryNote'

export type BatchKind = 'ATTACHABLE' | 'INSPECTABLE'

export interface FlatBatchRow {
  batch_id: string
  quantity: number
  status: string
  version: number
  kind: BatchKind
  part_id: string
  serial_no: string
  drawing_no: string
  name: string
}

/** 把 ScanUnresolvedTarget[] 展平为 FlatBatchRow[]，合并 A+B 两组。
 *  ATTACHABLE 在前，INSPECTABLE 在后。 */
export function flattenCandidateBatches(
  targets: ScanUnresolvedTarget[],
): FlatBatchRow[] {
  return targets.flatMap((t) => {
    const attachableRows: FlatBatchRow[] = t.attachable_batches.map((b) => ({
      batch_id: b.batch_id,
      quantity: b.quantity,
      status: b.status,
      version: b.version,
      kind: 'ATTACHABLE' as const,
      part_id: t.part_id,
      serial_no: t.serial_no,
      drawing_no: t.drawing_no,
      name: t.name,
    }))
    const inspectableRows: FlatBatchRow[] = t.available_batches.map((b) => ({
      batch_id: b.batch_id,
      quantity: b.quantity,
      status: b.status,
      version: b.version,
      kind: 'INSPECTABLE' as const,
      part_id: t.part_id,
      serial_no: t.serial_no,
      drawing_no: t.drawing_no,
      name: t.name,
    }))
    return [...attachableRows, ...inspectableRows]
  })
}

/** 从 targets 中筛出只含指定 kind 行的临时结构，喂给 buildSelectedScanItems。 */
export function filterTargetsByKind(
  targets: ScanUnresolvedTarget[],
  _kind: 'INSPECTABLE' | 'ATTACHABLE',
  selected: Set<string>,
): ScanUnresolvedTarget[] {
  return targets
    .map((t) => ({
      ...t,
      available_batches: t.available_batches.filter((b) => selected.has(b.batch_id)),
      attachable_batches: [],
    }))
    .filter((t) => t.available_batches.length > 0)
}