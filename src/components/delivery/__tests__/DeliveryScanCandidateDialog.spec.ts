// src/components/delivery/__tests__/DeliveryScanCandidateDialog.spec.ts
//
// 2026-08-31 新增：路线 B 候选弹窗纯函数单测（flatBatches + filterTargetsByKind）。
// 覆盖：A 单组 / B 单组 / A+B 混合 / 空 targets；filter 仅保留指定 kind + selected。

import { describe, it, expect } from 'vitest'
import {
  flattenCandidateBatches,
  filterTargetsByKind,
} from '../utils/scanCandidateFlatten'
import type {
  ScanAvailableBatch,
  ScanAttachableBatch,
  ScanUnresolvedTarget,
} from '@/types/deliveryNote'

const mkTarget = (
  partId: string,
  attachable: ScanAttachableBatch[] = [],
  inspectable: ScanAvailableBatch[] = [],
): ScanUnresolvedTarget => ({
  part_id: partId,
  serial_no: `S-${partId}`,
  drawing_no: `D-${partId}`,
  name: `Name-${partId}`,
  available_batches: inspectable,
  attachable_batches: attachable,
})

describe('flattenCandidateBatches', () => {
  it('空 targets → []', () => {
    expect(flattenCandidateBatches([])).toEqual([])
  })

  it('仅 B 组（inspectable）→ 全部 INSPECTABLE', () => {
    const t = mkTarget('p1', [], [
      { batch_id: 'b1', quantity: 5, status: 'PENDING', version: 1 },
    ])
    const rows = flattenCandidateBatches([t])
    expect(rows).toHaveLength(1)
    expect(rows[0].kind).toBe('INSPECTABLE')
    expect(rows[0].batch_id).toBe('b1')
  })

  it('仅 A 组（attachable）→ 全部 ATTACHABLE', () => {
    const t = mkTarget('p1', [
      { batch_id: 'a1', quantity: 3, status: 'READY_TO_SHIP', version: 2 },
    ], [])
    const rows = flattenCandidateBatches([t])
    expect(rows).toHaveLength(1)
    expect(rows[0].kind).toBe('ATTACHABLE')
  })

  it('A+B 混合 → ATTACHABLE 在前，INSPECTABLE 在后', () => {
    const t = mkTarget('p1',
      [{ batch_id: 'a1', quantity: 1, status: 'INSPECTION', version: 1 }],
      [{ batch_id: 'b1', quantity: 2, status: 'PENDING', version: 1 }],
    )
    const rows = flattenCandidateBatches([t])
    expect(rows.map((r) => r.kind)).toEqual(['ATTACHABLE', 'INSPECTABLE'])
    expect(rows.map((r) => r.batch_id)).toEqual(['a1', 'b1'])
  })
})

describe('filterTargetsByKind', () => {
  it('输入 A+B → 过滤后只剩 INSPECTABLE 行 + 满足 selected', () => {
    const t1 = mkTarget('p1',
      [{ batch_id: 'a1', quantity: 1, status: 'INSPECTION', version: 1 }],
      [
        { batch_id: 'b1', quantity: 2, status: 'PENDING', version: 1 },
        { batch_id: 'b2', quantity: 3, status: 'PENDING', version: 1 },
      ],
    )
    const selected = new Set(['b1'])  // 只勾 b1
    const filtered = filterTargetsByKind([t1], 'INSPECTABLE', selected)
    expect(filtered).toHaveLength(1)
    expect(filtered[0].available_batches).toHaveLength(1)
    expect(filtered[0].available_batches[0].batch_id).toBe('b1')
    expect(filtered[0].attachable_batches).toEqual([])
  })

  it('选中集合为空 → 返回 []', () => {
    const t1 = mkTarget('p1', [],
      [{ batch_id: 'b1', quantity: 2, status: 'PENDING', version: 1 }])
    expect(filterTargetsByKind([t1], 'INSPECTABLE', new Set())).toEqual([])
  })
})