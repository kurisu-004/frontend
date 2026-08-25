import { describe, expect, it } from 'vitest'
import {
  toBatchPassItems,
  mapBatchResult,
  type BulkPassItem,
} from './useBulkPassInspection'
import type { BatchPassInspectionOutFE } from '@/api/parts'

describe('toBatchPassItems', () => {
  it('空数组 → 空数组', () => {
    expect(toBatchPassItems([])).toEqual([])
  })

  it('剥掉 label，保留 part_id/batch_id/quantity', () => {
    const items: BulkPassItem[] = [
      {
        part_id: '190000000000001',
        batch_id: '190000000000010',
        quantity: 3,
        label: 'A-01 · 零件甲',
      },
    ]
    expect(toBatchPassItems(items)).toEqual([
      { part_id: '190000000000001', batch_id: '190000000000010', quantity: 3 },
    ])
  })

  it('batch_id/quantity 为 null → undefined（API 不期望 null）', () => {
    const items: BulkPassItem[] = [
      { part_id: '190000000000002', batch_id: null, quantity: null, label: 'x' },
    ]
    expect(toBatchPassItems(items)).toEqual([
      { part_id: '190000000000002', batch_id: undefined, quantity: undefined },
    ])
  })

  it('batch_id/quantity 缺省（undefined）保持 undefined', () => {
    const items: BulkPassItem[] = [{ part_id: '190000000000003', label: 'y' }]
    expect(toBatchPassItems(items)).toEqual([
      { part_id: '190000000000003', batch_id: undefined, quantity: undefined },
    ])
  })
})

describe('mapBatchResult', () => {
  const requested: BulkPassItem[] = [
    { part_id: '190000000000001', batch_id: 'B1', quantity: 5, label: 'A · 甲' },
    { part_id: '190000000000002', batch_id: 'B2', label: 'B · 乙' },
    { part_id: '190000000000003', label: 'C · 丙' },
  ]

  it('passed 按 part_id 反向找回原始 item（保留 label）', () => {
    const out: BatchPassInspectionOutFE = {
      passed: [
        {
          id: '190000000000002',
          version: 1,
          serial_no: null,
          name: '乙',
          drawing_no: 'D-2',
          quantity: 1,
          planned_delivery_date: '2026-09-01',
          actual_delivery_date: null,
          is_urgent: false,
          status: 'READY_TO_SHIP',
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
          location: null,
          placed_at: null,
          next_process_id: null,
          next_process_name: null,
        },
      ],
      failed: [],
    }
    const r = mapBatchResult(requested, out)
    expect(r.passed).toEqual([requested[1]])
    expect(r.failed).toEqual([])
  })

  it('failed 按 part_id 找到原始 item 包成 BulkPassFailure（含 code/message）', () => {
    const out: BatchPassInspectionOutFE = {
      passed: [],
      failed: [
        { part_id: '190000000000001', code: 20103, message: '状态非法' },
        { part_id: '190000000000003', code: 20101, message: 'part 不存在' },
      ],
    }
    const r = mapBatchResult(requested, out)
    expect(r.passed).toEqual([])
    expect(r.failed).toEqual([
      { item: requested[0], code: 20103, message: '状态非法' },
      { item: requested[2], code: 20101, message: 'part 不存在' },
    ])
  })

  it('部分通过：passed + failed 同时存在，顺序按请求 items', () => {
    const out: BatchPassInspectionOutFE = {
      passed: [
        {
          id: '190000000000001',
          version: 1,
          serial_no: null,
          name: '甲',
          drawing_no: 'D-1',
          quantity: 5,
          planned_delivery_date: '2026-09-01',
          actual_delivery_date: null,
          is_urgent: false,
          status: 'READY_TO_SHIP',
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
          location: null,
          placed_at: null,
          next_process_id: null,
          next_process_name: null,
        },
        {
          id: '190000000000003',
          version: 1,
          serial_no: null,
          name: '丙',
          drawing_no: 'D-3',
          quantity: 1,
          planned_delivery_date: '2026-09-01',
          actual_delivery_date: null,
          is_urgent: false,
          status: 'READY_TO_SHIP',
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
          location: null,
          placed_at: null,
          next_process_id: null,
          next_process_name: null,
        },
      ],
      failed: [{ part_id: '190000000000002', code: 20103, message: 'X' }],
    }
    const r = mapBatchResult(requested, out)
    expect(r.passed).toEqual([requested[0], requested[2]])
    expect(r.failed).toEqual([{ item: requested[1], code: 20103, message: 'X' }])
  })

  it('passed 中的 part_id 不在请求 items（防御）：构造无 label 的最小 item', () => {
    const out: BatchPassInspectionOutFE = {
      passed: [
        {
          id: '190000000000999',
          version: 1,
          serial_no: null,
          name: '幽灵',
          drawing_no: 'D-X',
          quantity: 1,
          planned_delivery_date: '2026-09-01',
          actual_delivery_date: null,
          is_urgent: false,
          status: 'READY_TO_SHIP',
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
          location: null,
          placed_at: null,
          next_process_id: null,
          next_process_name: null,
        },
      ],
      failed: [],
    }
    const r = mapBatchResult(requested, out)
    expect(r.passed).toEqual([{ part_id: '190000000000999' }])
  })

  it('failed 中的 part_id 不在请求 items（防御）：fallback 构造最小 item', () => {
    const out: BatchPassInspectionOutFE = {
      passed: [],
      failed: [{ part_id: '190000000000999', code: 20103, message: '幽灵失败' }],
    }
    const r = mapBatchResult(requested, out)
    expect(r.failed).toEqual([
      { item: { part_id: '190000000000999' }, code: 20103, message: '幽灵失败' },
    ])
  })

  it('空 requested + 空 result：空对象', () => {
    expect(mapBatchResult([], { passed: [], failed: [] })).toEqual({
      passed: [],
      failed: [],
    })
  })
})