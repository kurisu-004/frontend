import { describe, expect, it, vi } from 'vitest'
import {
  toBatchPassItems,
  mapBatchResult,
  useBulkPassInspection,
  type BulkPassItem,
} from './useBulkPassInspection'
import type { BatchToShipOutFE } from '@/api/parts'

describe('toBatchPassItems', () => {
  it('空数组 → 空数组', () => {
    expect(toBatchPassItems([])).toEqual([])
  })

  it('剥掉 label，保留 batch_id/version/quantity（route B 不再带 part_id）', () => {
    // 2026-08-29：透传 version（caller OCC 锚 t_part_batch）—— batch-to-* 入参必带。
    const items: BulkPassItem[] = [
      {
        batch_id: '190000000000010',
        version: 1,
        quantity: 3,
        label: 'A-01 · 零件甲',
      },
    ]
    expect(toBatchPassItems(items)).toEqual([
      { batch_id: '190000000000010', version: 1, quantity: 3 },
    ])
  })

  it('quantity 为 null → undefined（API 不期望 null）', () => {
    const items: BulkPassItem[] = [
      { batch_id: '190000000000020', version: 1, quantity: null, label: 'x' },
    ]
    expect(toBatchPassItems(items)).toEqual([
      { batch_id: '190000000000020', version: 1, quantity: undefined },
    ])
  })

  it('quantity 缺省（undefined）保持 undefined', () => {
    const items: BulkPassItem[] = [
      { batch_id: '190000000000030', version: 1, label: 'y' },
    ]
    expect(toBatchPassItems(items)).toEqual([
      { batch_id: '190000000000030', version: 1, quantity: undefined },
    ])
  })

  // 2026-08-29：caller OCC 入参必带 version，验证 toBatchPassItems 严格透传。
  it('version 透传：version: 7 → 7', () => {
    const items: BulkPassItem[] = [
      { batch_id: 'B-1', version: 7, label: 'L' },
    ]
    expect(toBatchPassItems(items)).toEqual([
      { batch_id: 'B-1', version: 7, quantity: undefined },
    ])
  })
})

describe('mapBatchResult', () => {
  const requested: BulkPassItem[] = [
    { batch_id: 'B-1', version: 1, quantity: 5, label: 'A · 甲' },
    { batch_id: 'B-2', version: 1, label: 'B · 乙' },
    { batch_id: 'B-3', version: 1, label: 'C · 丙' },
  ]

  // 最小 PartItem stub —— 仅供测试 mapBatchResult 的对齐逻辑
  function makePartItem(id: string): BatchToShipOutFE['submitted'][number]['part'] {
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
    }
  }

  it('passed 按 batch_id 反向找回原始 item（保留 label）', () => {
    // 2026-08-28：后端 ToXxxOut 不含 batch_id，改按位置对齐 —— 全部成功时
    // submitted[] 与 requested[] 逐位对应，label 原样带回。
    // new_batch_id 语义：requested[0] 带 quantity=5 → 部分操作 → remainder id；
    // requested[1]/[2] 未带 quantity → 整批操作 → null（不拆批）。
    const out: BatchToShipOutFE = {
      submitted: [
        {
          part: makePartItem('190000000000001'),
          new_batch_id: 'B-1-remainder',
        },
        { part: makePartItem('190000000000002'), new_batch_id: null },
        { part: makePartItem('190000000000003'), new_batch_id: null },
      ],
      failed: [],
    }
    const r = mapBatchResult(requested, out)
    expect(r.passed).toEqual([requested[0], requested[1], requested[2]])
    expect(r.failed).toEqual([])
  })

  it('failed 按 batch_id 找到原始 item 包成 BulkPassFailure（含 code/message）', () => {
    const out: BatchToShipOutFE = {
      submitted: [],
      failed: [
        { batch_id: 'B-1', code: 20103, message: '状态非法' },
        { batch_id: 'B-3', code: 20101, message: 'batch 不存在' },
      ],
    }
    const r = mapBatchResult(requested, out)
    expect(r.passed).toEqual([])
    expect(r.failed).toEqual([
      { item: requested[0], code: 20103, message: '状态非法' },
      { item: requested[2], code: 20101, message: 'batch 不存在' },
    ])
  })

  it('部分通过：passed + failed 同时存在，顺序按请求 items', () => {
    // 关键回归：B-2 失败 → submitted[] 只有 2 项且下标整体前移。
    // 若直接用 requested[i] 取，submitted[1] 会错配成 requested[1]（= 失败的 B-2），
    // 把失败项误报为通过。必须先用 failed[].batch_id 扣除失败项再逐位对齐。
    const out: BatchToShipOutFE = {
      submitted: [
        { part: makePartItem('190000000000001'), new_batch_id: 'B-1-remainder' },
        { part: makePartItem('190000000000003'), new_batch_id: null },
      ],
      failed: [{ batch_id: 'B-2', code: 20103, message: 'X' }],
    }
    const r = mapBatchResult(requested, out)
    expect(r.passed).toEqual([requested[0], requested[2]])
    expect(r.failed).toEqual([{ item: requested[1], code: 20103, message: 'X' }])
  })

  it('passed 中的 batch_id 不在请求 items（防御）：构造无 label 的最小 item', () => {
    // 2026-08-28：batch_id 反查改成位置反查后，"对不上" 的条件变成
    // submitted 比「请求扣掉 failed」还长 —— 这里 3 个请求项全部失败（candidates 为空），
    // 却仍返回 1 条 submitted，走 part 投影兜底占位。
    // 2026-08-29：兜底占位带 version=0（仅满足类型约束，不参与后续请求）。
    const out: BatchToShipOutFE = {
      submitted: [
        { part: makePartItem('190000000000999'), new_batch_id: null },
      ],
      failed: [
        { batch_id: 'B-1', code: 20103, message: 'a' },
        { batch_id: 'B-2', code: 20103, message: 'b' },
        { batch_id: 'B-3', code: 20103, message: 'c' },
      ],
    }
    const r = mapBatchResult(requested, out)
    // makePartItem 的 serial_no 为 null → label 兜成 undefined（即"无 label"）
    expect(r.passed).toEqual([{ batch_id: '190000000000999', version: 0 }])
  })

  it('防御占位 item 的 label 取 part.serial_no（2026-08-28 新增）', () => {
    // 2026-08-29：兜底占位带 version=0。
    const ghost = { ...makePartItem('190000000000999'), serial_no: 'S-999' }
    const out: BatchToShipOutFE = {
      submitted: [{ part: ghost, new_batch_id: null }],
      failed: [
        { batch_id: 'B-1', code: 20103, message: 'a' },
        { batch_id: 'B-2', code: 20103, message: 'b' },
        { batch_id: 'B-3', code: 20103, message: 'c' },
      ],
    }
    const r = mapBatchResult(requested, out)
    expect(r.passed).toEqual([
      { batch_id: '190000000000999', version: 0, label: 'S-999' },
    ])
  })

  it('failed 中的 batch_id 不在请求 items（防御）：fallback 构造最小 item', () => {
    // 2026-08-29：failed 占位也补 version=0（仅满足类型约束）。
    const out: BatchToShipOutFE = {
      submitted: [],
      failed: [{ batch_id: 'B-幽灵', code: 20103, message: '幽灵失败' }],
    }
    const r = mapBatchResult(requested, out)
    expect(r.failed).toEqual([
      { item: { batch_id: 'B-幽灵', version: 0 }, code: 20103, message: '幽灵失败' },
    ])
  })

  // 2026-08-29：failed[] 携带 40901 BIZ_VERSION_CONFLICT（caller OCC 不符）
  // 应原样落入 failed[]，保留原 item + code + message。
  it('failed[] 中 40901 BIZ_VERSION_CONFLICT 落入失败列表（保留原 item）', () => {
    const out: BatchToShipOutFE = {
      submitted: [
        { part: makePartItem('190000000000001'), new_batch_id: null },
        { part: makePartItem('190000000000003'), new_batch_id: null },
      ],
      failed: [
        { batch_id: 'B-2', code: 40901, message: '版本已过期' },
      ],
    }
    const r = mapBatchResult(requested, out)
    // B-2 失败 → candidates=[B-1,B-3]，submitted 顺序对齐回这两项
    expect(r.passed).toEqual([requested[0], requested[2]])
    expect(r.failed).toEqual([
      {
        item: { batch_id: 'B-2', version: 1, label: 'B · 乙' },
        code: 40901,
        message: '版本已过期',
      },
    ])
  })

  it('空 requested + 空 result：空对象', () => {
    expect(mapBatchResult([], { submitted: [], failed: [] })).toEqual({
      passed: [],
      failed: [],
    })
  })
})

describe('useBulkPassInspection().run() (2026-08-28 route B)', () => {
  it('passes batch_id-only items to batch-to-ship endpoint', async () => {
    const apiParts = await import('@/api/parts')
    const spy = vi.spyOn(apiParts, 'batchToShip').mockResolvedValue({
      submitted: [],
      failed: [],
    })

    const bulk = useBulkPassInspection()
    await bulk.run([
      { batch_id: '111', version: 1, quantity: 2, label: 'A / 批 111' },
      { batch_id: '222', version: 1, label: 'A / 批 222' },
    ])

    expect(spy).toHaveBeenCalledWith({
      items: [
        { batch_id: '111', version: 1, quantity: 2 },
        { batch_id: '222', version: 1, quantity: undefined },
      ],
    })
    // 关键断言：入参 items **不含 part_id**
    const callArg = spy.mock.calls[0][0]
    for (const it of callArg.items) {
      expect(it).not.toHaveProperty('part_id')
    }
  })

  // 2026-08-29：验证 caller OCC version 严格透传到 batchToShip 入参（关键回归）：
  // 不同批次的 version 各异，必须 1:1 透传，丢一个就 40901。
  it('preserves per-item version when calling batchToShip', async () => {
    const apiParts = await import('@/api/parts')
    const spy = vi.spyOn(apiParts, 'batchToShip').mockResolvedValue({
      submitted: [],
      failed: [],
    })
    // 清掉之前测试用例对 spy 的累积调用计数，只看本次 run 的入参。
    spy.mockClear()

    const bulk = useBulkPassInspection()
    await bulk.run([
      { batch_id: '111', version: 3, label: 'L1' },
      { batch_id: '222', version: 5, label: 'L2' },
      { batch_id: '333', version: 7, label: 'L3' },
    ])

    expect(spy).toHaveBeenCalledTimes(1)
    const callArg = spy.mock.calls[0][0]
    expect(callArg.items[0].version).toBe(3)
    expect(callArg.items[1].version).toBe(5)
    expect(callArg.items[2].version).toBe(7)
    expect(callArg.items[0].batch_id).toBe('111')
    expect(callArg.items[1].batch_id).toBe('222')
    expect(callArg.items[2].batch_id).toBe('333')
  })

  it('result failed[].item.batch_id 反查回原始 BulkPassItem', async () => {
    const apiParts = await import('@/api/parts')
    const requested: BulkPassItem[] = [
      { batch_id: 'B-1', version: 1, label: 'L1' },
      { batch_id: 'B-2', version: 1, label: 'L2' },
    ]
    const out: BatchToShipOutFE = {
      submitted: [],
      failed: [{ batch_id: 'B-2', code: 20103, message: '状态非法' }],
    }
    vi.spyOn(apiParts, 'batchToShip').mockResolvedValue(out)

    const bulk = useBulkPassInspection()
    const r = await bulk.run(requested)

    expect(r.failed).toEqual([
      { item: { batch_id: 'B-2', version: 1, label: 'L2' }, code: 20103, message: '状态非法' },
    ])
    expect(r.passed).toEqual([])
  })

  // 2026-08-29：失败码 40901 BIZ_VERSION_CONFLICT 端到端：request → response → BulkPassFailure
  it('failed[] 中 40901 BIZ_VERSION_CONFLICT 端到端透传', async () => {
    const apiParts = await import('@/api/parts')
    const requested: BulkPassItem[] = [
      { batch_id: 'B-1', version: 1, label: 'L1' },
      { batch_id: 'B-2', version: 1, label: 'L2' },
    ]
    const out: BatchToShipOutFE = {
      submitted: [],
      failed: [{ batch_id: 'B-2', code: 40901, message: '版本已过期' }],
    }
    vi.spyOn(apiParts, 'batchToShip').mockResolvedValue(out)

    const bulk = useBulkPassInspection()
    const r = await bulk.run(requested)

    expect(r.failed).toEqual([
      { item: { batch_id: 'B-2', version: 1, label: 'L2' }, code: 40901, message: '版本已过期' },
    ])
    expect(r.passed).toEqual([])
  })

  it('result submitted[].batch_id 反查回原始 BulkPassItem', async () => {
    const apiParts = await import('@/api/parts')
    const requested: BulkPassItem[] = [
      { batch_id: 'B-1', version: 1, label: 'L1' },
      { batch_id: 'B-2', version: 1, label: 'L2' },
    ]
    const partStub = {
      id: '190000000000001',
      version: 1,
      serial_no: null,
      name: 'x',
      drawing_no: 'D',
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
    } as const
    const out: BatchToShipOutFE = {
      submitted: [
        { part: partStub, new_batch_id: null },
      ],
      // B-1 失败 → candidates=[B-2]，submitted[0] 对应 B-2（验证下标前移后仍对得上）
      failed: [{ batch_id: 'B-1', code: 20103, message: '状态非法' }],
    }
    vi.spyOn(apiParts, 'batchToShip').mockResolvedValue(out)

    const bulk = useBulkPassInspection()
    const r = await bulk.run(requested)

    expect(r.passed).toEqual([{ batch_id: 'B-2', version: 1, label: 'L2' }])
    expect(r.failed).toEqual([
      { item: { batch_id: 'B-1', version: 1, label: 'L1' }, code: 20103, message: '状态非法' },
    ])
  })
})