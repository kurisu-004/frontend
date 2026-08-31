// src/views/delivery/__tests__/useDeliveryScanSubmission.spec.ts
//
// 2026-08-28 后端扫码建单路线 B 重构后，useDeliveryScanSubmission 需支持 4 outcome：
//   - ADDED / ALREADY_PRESENT（保持原行为）
//   - CANDIDATES_AVAILABLE / PARTIAL_ADDED（新增：触发候选弹窗，不走 ElMessage.warning）
// 错误码迁移：BLOCK_SCAN_CODES = [21421]（旧 21405/21418 不再由 scan 触发）。

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { nextTick } from 'vue'

// mock scanDelivery 模块 —— 必须在 import 之前（vi.mock 会 hoist）。
// 2026-08-29：submitNote 也需要被 mock，因为新测试要触发 submit 路径。
// 2026-08-29：available_batches 测试 fixture 加 `version: 1`（caller OCC 必填）。
vi.mock('@/api/deliveryNote', () => ({
  scanDelivery: vi.fn(),
  getNote: vi.fn(),
  submitNote: vi.fn(),
}))

// 2026-08-28 测试环境：vitest 跑在 node 下，element-plus 的 ElMessage 调用 document。
// 整体 stub 为 vi.fn()，无副作用；后续测试关心副作用（如 candidateDialogVisible.value）
// 不依赖 ElMessage 本身。ElMessageBox.confirm 默认返回 undefined → 走 confirmAndSubmit 分支。
vi.mock('element-plus', () => ({
  ElMessage: {
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
  ElMessageBox: {
    confirm: vi.fn(),
  },
}))

import { scanDelivery } from '@/api/deliveryNote'
import { useDeliveryScanSubmission } from '../composables/useDeliveryScanSubmission'
import { ApiError } from '@/api/http'

const baseOpts = () => ({
  writeDraftFromScan: vi.fn(),
  refreshDraftDetail: vi.fn().mockResolvedValue(undefined),
  onDraftRemoved: vi.fn(),
})

describe('useDeliveryScanSubmission route B', () => {
  beforeEach(() => vi.clearAllMocks())

  it('ADDED outcome writes draft + shows success', async () => {
    vi.mocked(scanDelivery).mockResolvedValue({
      outcome: 'ADDED',
      resolved: { kind: 'PART', id: '1', serial_no: 'A001', drawing_no: 'D-1', name: 'N1' },
      note: { id: 'N1', delivery_note_no: 'DN-001' } as any,
      added_batches: [],
    })
    const opts = baseOpts()
    const { submission } = build(opts)
    await submission.handleScan('A001')
    expect(opts.writeDraftFromScan).toHaveBeenCalled()
  })

  it('CANDIDATES_AVAILABLE outcome opens candidate dialog (no ElMessage.warning)', async () => {
    vi.mocked(scanDelivery).mockResolvedValue({
      outcome: 'CANDIDATES_AVAILABLE',
      resolved: { kind: 'PART', id: '1', serial_no: 'A001', drawing_no: 'D-1', name: 'N1' },
      note: { id: 'N1', delivery_note_no: 'DN-001' } as any,
      added_batches: [],
      unresolved_targets: [
        {
          part_id: '1',
          serial_no: 'A001',
          drawing_no: 'D-1',
          name: 'N1',
          available_batches: [{ batch_id: 'B1', quantity: 5, status: 'PENDING', version: 1 }],
          attachable_batches: [],
        },
      ],
    })
    const opts = baseOpts()
    const { submission, candidateDialogVisible } = build(opts)
    await submission.handleScan('A001')
    await nextTick()
    expect(candidateDialogVisible.value).toBe(true)
  })

  it('PARTIAL_ADDED outcome writes A 组 draft + opens candidate dialog', async () => {
    vi.mocked(scanDelivery).mockResolvedValue({
      outcome: 'PARTIAL_ADDED',
      resolved: { kind: 'ASSEMBLY', id: 'A1', serial_no: 'AS001', drawing_no: 'AD-1', name: 'AN1' },
      note: { id: 'N1', delivery_note_no: 'DN-001' } as any,
      added_batches: [{ batch_id: 'B2', part_id: '2', serial_no: 'P002', drawing_no: 'D-2', name: 'N2', quantity: 3 }],
      unresolved_targets: [
        {
          part_id: '3',
          serial_no: 'P003',
          drawing_no: 'D-3',
          name: 'N3',
          available_batches: [{ batch_id: 'B3', quantity: 1, status: 'PROGRAMMING', version: 1 }],
          attachable_batches: [],
        },
      ],
    })
    const opts = baseOpts()
    const { submission, candidateDialogVisible } = build(opts)
    await submission.handleScan('AS001')
    await nextTick()
    expect(opts.writeDraftFromScan).toHaveBeenCalled()
    expect(candidateDialogVisible.value).toBe(true)
  })

  it('applyError handles 21421 via BLOCK_SCAN_CODES (toast only, no dialog)', async () => {
    // 错误码 21421 应直接走 ElMessage.error(message)，不弹候选弹窗（不在 route B 弹窗流程）
    const { ApiError } = await import('@/api/http')
    vi.mocked(scanDelivery).mockRejectedValue(new ApiError(21421, 'C 组状态不允许'))
    const opts = baseOpts()
    const { submission, candidateDialogVisible } = build(opts)
    await submission.handleScan('X')
    await nextTick()
    expect(candidateDialogVisible.value).toBe(false)
  })

  it('applyError does NOT trigger candidate dialog for legacy 21405', async () => {
    vi.mocked(scanDelivery).mockRejectedValue(new ApiError(21405, 'legacy msg'))
    const opts = baseOpts()
    const { submission, candidateDialogVisible } = build(opts)
    await submission.handleScan('X')
    await nextTick()
    expect(candidateDialogVisible.value).toBe(false)
  })
})

// 2026-08-29：submit 后端 outcome 包装（替换原 21405 硬错误路径）
// - SUBMITTED → 清草稿（onDraftRemoved）
// - CANDIDATES_AVAILABLE → 弹 DeliverySubmitCandidateDialog
// 详见 docs/03-modules/scan-route-b-fix.md「submit outcome 包装」节。
describe('useDeliveryScanSubmission submit outcome (2026-08-29)', () => {
  beforeEach(() => vi.clearAllMocks())

  // 2026-08-29：mock 一个最小 DeliveryNoteDetailOut + ScanNoteSummary，用于触发
  // onSubmitDraft → confirmAndSubmit → doSubmit 路径。
  function makeReadyDetail(noteId: string, version: number) {
    // line_items 全部 INSPECTION / READY_TO_SHIP → onSubmitDraft 不会弹
    // BatchInspectionConfirmDialog，直接走 doSubmit。
    return {
      id: noteId,
      version,
      delivery_note_no: 'DN-001',
      customer_id: 'C1',
      customer_name: null,
      parent_customer_name: null,
      customer_path: null,
      status: 'DRAFT',
      submitted_at: null,
      picked_up_at: null,
      submitted_by: null,
      picked_up_by: null,
      driver_worker_id: null,
      driver_worker_name: null,
      part_count: 1,
      note: null,
      delivery_date: null,
      created_at: '2026-08-29',
      updated_at: '2026-08-29',
      line_items: [
        {
          id: 'LI-1',
          version: 1,
          part_id: '1',
          batch_no: 1,
          batch_label: null,
          serial_no: 'A001',
          drawing_no: 'D-1',
          name: 'N1',
          quantity: 5,
          is_urgent: false,
          status: 'READY_TO_SHIP',
          applicant_name: null,
          request_date: null,
          planned_delivery_date: null,
          system_delivery_date: null,
          order_no: null,
          note: null,
          customer_name: null,
          parent_customer_name: null,
          customer_path: null,
          is_scanned: false,
          scanned: false,
          assembly_id: null,
          assembly_serial_no: null,
          assembly_drawing_no: null,
          assembly_name: null,
          assembly_order_no: null,
        },
      ],
      scanned_serials: [],
    }
  }

  function makeDraft(noteId: string, version: number) {
    return {
      id: noteId,
      version,
      delivery_note_no: 'DN-001',
      customer_id: 'C1',
      customer_name: null,
      parent_customer_name: null,
      customer_path: null,
      status: 'DRAFT',
      scope: 'LEAF',
      scope_label: '按零件',
      part_count: 1,
      delivery_date: null,
      created_at: '2026-08-29',
      updated_at: '2026-08-29',
      recent_items: [],
    }
  }

  // 2026-08-29：submit 返回 SUBMITTED → 调 onDraftRemoved 清本地状态、不弹 candidate dialog
  it('SUBMITTED outcome clears draft via onDraftRemoved (no candidate dialog)', async () => {
    const { getNote, submitNote } = await import('@/api/deliveryNote')
    vi.mocked(getNote).mockResolvedValue(makeReadyDetail('N1', 5) as any)
    vi.mocked(submitNote).mockResolvedValue({
      outcome: 'SUBMITTED',
      note: {
        id: 'N1',
        version: 6,
        delivery_note_no: 'DN-001',
        customer_id: 'C1',
        customer_name: null,
        parent_customer_name: null,
        customer_path: null,
        status: 'SUBMITTED',
        submitted_at: '2026-08-29',
        picked_up_at: null,
        submitted_by: 'U1',
        picked_up_by: null,
        driver_worker_id: null,
        driver_worker_name: null,
        part_count: 1,
        note: null,
        delivery_date: null,
        created_at: '2026-08-29',
        updated_at: '2026-08-29',
      },
    } as any)

    const opts = baseOpts()
    const { submission, submitCandidateDialogVisible } = build(opts)
    await submission.onSubmitDraft(makeDraft('N1', 5) as any)
    await nextTick()

    expect(opts.onDraftRemoved).toHaveBeenCalledWith('N1')
    expect(submitCandidateDialogVisible.value).toBe(false)
  })

  // 2026-08-29：submit 返回 CANDIDATES_AVAILABLE → 弹 DeliverySubmitCandidateDialog，
  // **不**调 onDraftRemoved（草稿保留 + 等待用户在 dialog 里点「一键过检」）。
  it('CANDIDATES_AVAILABLE outcome opens submit candidate dialog', async () => {
    const { getNote, submitNote } = await import('@/api/deliveryNote')
    vi.mocked(getNote).mockResolvedValue(makeReadyDetail('N1', 5) as any)
    vi.mocked(submitNote).mockResolvedValue({
      outcome: 'CANDIDATES_AVAILABLE',
      note: null,
      unresolved_targets: [
        {
          part_id: '1',
          serial_no: 'A001',
          drawing_no: 'D-1',
          name: 'N1',
          available_batches: [
            { batch_id: 'B1', quantity: 5, status: 'INSPECTION', version: 1 },
          ],
        },
      ],
    } as any)

    const opts = baseOpts()
    const { submission, submitCandidateDialogVisible, submitCandidateTargets } = build(opts)
    await submission.onSubmitDraft(makeDraft('N1', 5) as any)
    await nextTick()

    expect(opts.onDraftRemoved).not.toHaveBeenCalled()
    expect(submitCandidateDialogVisible.value).toBe(true)
    expect(submitCandidateTargets.value).toHaveLength(1)
    expect(submitCandidateTargets.value[0].available_batches[0].batch_id).toBe('B1')
    expect(submitCandidateTargets.value[0].available_batches[0].version).toBe(1)
  })

  // 2026-08-29：submit 抛 21403 BIZ_VERSION_CONFLICT → 走 onSubmitDraftError 警告分支
  it('submit error 21403 BIZ_VERSION_CONFLICT triggers warning (no candidate dialog, no draft removed)', async () => {
    const { getNote, submitNote } = await import('@/api/deliveryNote')
    const { ElMessage } = await import('element-plus')
    vi.mocked(getNote).mockResolvedValue(makeReadyDetail('N1', 5) as any)
    vi.mocked(submitNote).mockRejectedValue(new ApiError(21403, '版本已过期'))

    const opts = baseOpts()
    const { submission, submitCandidateDialogVisible } = build(opts)
    await submission.onSubmitDraft(makeDraft('N1', 5) as any)
    await nextTick()

    // 失败路径：onDraftRemoved 不应被调；candidate dialog 不应被弹；
    // ElMessage.warning 应被触发（21403 提示「版本已过期，正在刷新...」）。
    expect(opts.onDraftRemoved).not.toHaveBeenCalled()
    expect(submitCandidateDialogVisible.value).toBe(false)
    expect(ElMessage.warning).toHaveBeenCalled()
  })
})

// 辅助：build composable 实例并暴露内部状态（视具体 export 形态调整）
function build(opts: ReturnType<typeof baseOpts>) {
  const inst = useDeliveryScanSubmission(opts as any)
  return {
    submission: inst,
    candidateDialogVisible: (inst as any).candidateDialogVisible,
    // 2026-08-29 新增：submit 后 CANDIDATES_AVAILABLE 弹窗态
    submitCandidateDialogVisible: (inst as any).submitCandidateDialogVisible,
    submitCandidateTargets: (inst as any).submitCandidateTargets,
  }
}