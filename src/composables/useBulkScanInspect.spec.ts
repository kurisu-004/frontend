import { describe, expect, it } from 'vitest'
import {
  toBatchScanItems,
  mapScanBatchResult,
  type BulkScanItem,
} from './useBulkScanInspect'
import type { BatchScanInspectOutFE } from '@/api/parts'

describe('toBatchScanItems', () => {
  it('空数组 → 空数组', () => {
    expect(toBatchScanItems([])).toEqual([])
  })

  it('剥掉 label，保留 part_id/decision/batch_id/quantity 等核心字段', () => {
    const items: BulkScanItem[] = [
      {
        part_id: '190000000000001',
        batch_id: '190000000000010',
        quantity: 3,
        decision: 'PASS',
        label: 'A-01 · 零件甲',
      },
    ]
    expect(toBatchScanItems(items)).toEqual([
      {
        part_id: '190000000000001',
        batch_id: '190000000000010',
        quantity: 3,
        decision: 'PASS',
        shelf_id: null,
        next_process_id: null,
        note: null,
      },
    ])
  })

  it('FAIL 路径：shelf_id/next_process_id/note 全部透传', () => {
    const items: BulkScanItem[] = [
      {
        part_id: '190000000000001',
        decision: 'FAIL',
        shelf_id: '190000000000100',
        next_process_id: '190000000000200',
        note: '返工',
        label: 'A-01',
      },
    ]
    expect(toBatchScanItems(items)).toEqual([
      {
        part_id: '190000000000001',
        batch_id: null,
        quantity: null,
        decision: 'FAIL',
        shelf_id: '190000000000100',
        next_process_id: '190000000000200',
        note: '返工',
      },
    ])
  })

  it('null/undefined 字段统一映射为 null（API 期望 null 而非 undefined）', () => {
    const items: BulkScanItem[] = [
      { part_id: '190000000000002', label: 'x' },
    ]
    expect(toBatchScanItems(items)).toEqual([
      {
        part_id: '190000000000002',
        batch_id: null,
        quantity: null,
        decision: null,
        shelf_id: null,
        next_process_id: null,
        note: null,
      },
    ])
  })
})

describe('mapScanBatchResult', () => {
  const requested: BulkScanItem[] = [
    { part_id: '190000000000001', batch_id: 'B1', quantity: 5, label: 'A · 甲' },
    { part_id: '190000000000002', batch_id: 'B2', label: 'B · 乙' },
    { part_id: '190000000000003', label: 'C · 丙' },
  ]

  // 最小 PartItem stub —— 仅供测试 mapScanBatchResult 的对齐逻辑
  function makePartItem(id: string): BatchScanInspectOutFE['submitted'][number] {
    return {
      id,
      version: 1,
      serial_no: null,
      name: 'x',
      drawing_no: 'D',
      quantity: 1,
      planned_delivery_date: '2026-09-01',
      actual_delivery_date: null,
      is_urgent: false,
      status: 'INSPECTION',
      order_no: null,
      system_delivery_date: null,
      note: null,
      customer_name: null,
      parent_customer_name: null,
      customer_path: null,
      delivery_note_id: null,
      delivery_note_no: null,
      delivery_note_status: null,
      assembly_id: null,
      current_holder_id: null,
      current_holder_kind: null,
      shelf_code: null,
      worker_name: null,
      outsource_company_name: null,
      location: 'INSPECTION_SHELF',
      placed_at: null,
      next_process_id: null,
      next_process_name: null,
    }
  }

  it('submitted 按 part_id 反向找回原始 item（保留 label）', () => {
    const out: BatchScanInspectOutFE = {
      submitted: [makePartItem('190000000000002')],
      failed: [],
    }
    const r = mapScanBatchResult(requested, out)
    expect(r.submitted).toEqual([requested[1]])
    expect(r.failed).toEqual([])
  })

  it('failed 按 part_id 找到原始 item 包成 BulkScanFailure（含 code/message）', () => {
    const out: BatchScanInspectOutFE = {
      submitted: [],
      failed: [
        { part_id: '190000000000001', code: 20103, message: '状态非法' },
        { part_id: '190000000000003', code: 20511, message: '品检架 zone 不对' },
      ],
    }
    const r = mapScanBatchResult(requested, out)
    expect(r.submitted).toEqual([])
    expect(r.failed).toEqual([
      { item: requested[0], code: 20103, message: '状态非法' },
      { item: requested[2], code: 20511, message: '品检架 zone 不对' },
    ])
  })

  it('部分成功：submitted + failed 同时存在', () => {
    const out: BatchScanInspectOutFE = {
      submitted: [
        makePartItem('190000000000001'),
        makePartItem('190000000000003'),
      ],
      failed: [{ part_id: '190000000000002', code: 20103, message: 'X' }],
    }
    const r = mapScanBatchResult(requested, out)
    expect(r.submitted).toEqual([requested[0], requested[2]])
    expect(r.failed).toEqual([{ item: requested[1], code: 20103, message: 'X' }])
  })

  it('submitted 中的 part_id 不在请求 items（防御）：构造无 label 的最小 item', () => {
    const out: BatchScanInspectOutFE = {
      submitted: [makePartItem('190000000000999')],
      failed: [],
    }
    const r = mapScanBatchResult(requested, out)
    expect(r.submitted).toEqual([{ part_id: '190000000000999' }])
  })

  it('failed 中的 part_id 不在请求 items（防御）：fallback 构造最小 item', () => {
    const out: BatchScanInspectOutFE = {
      submitted: [],
      failed: [{ part_id: '190000000000999', code: 20103, message: '幽灵失败' }],
    }
    const r = mapScanBatchResult(requested, out)
    expect(r.failed).toEqual([
      { item: { part_id: '190000000000999' }, code: 20103, message: '幽灵失败' },
    ])
  })

  it('空 requested + 空 result：空对象', () => {
    expect(mapScanBatchResult([], { submitted: [], failed: [] })).toEqual({
      submitted: [],
      failed: [],
    })
  })
})