// src/views/delivery/__tests__/useDeliveryScanSubmission.spec.ts
//
// 2026-08-28 后端扫码建单路线 B 重构后，useDeliveryScanSubmission 需支持 4 outcome：
//   - ADDED / ALREADY_PRESENT（保持原行为）
//   - CANDIDATES_AVAILABLE / PARTIAL_ADDED（新增：触发候选弹窗，不走 ElMessage.warning）
// 错误码迁移：BLOCK_SCAN_CODES = [21421]（旧 21405/21418 不再由 scan 触发）。

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { nextTick } from 'vue'

// mock scanDelivery 模块 —— 必须在 import 之前（vi.mock 会 hoist）。
// 只 mock scanDelivery 即可；composable 用到的 getNote / submitNote 在 handleScan
// 路径不会触发，留 undefined 即可（factory 内不导出也不会爆，因为只是类型上需要存在）。
vi.mock('@/api/deliveryNote', () => ({
  scanDelivery: vi.fn(),
  getNote: vi.fn(),
  submitNote: vi.fn(),
}))

// 2026-08-28 测试环境：vitest 跑在 node 下，element-plus 的 ElMessage 调用 document。
// 整体 stub 为 vi.fn()，无副作用；后续测试关心副作用（如 candidateDialogVisible.value）
// 不依赖 ElMessage 本身。
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
          available_batches: [{ batch_id: 'B1', quantity: 5, status: 'PENDING' }],
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
          available_batches: [{ batch_id: 'B3', quantity: 1, status: 'PROGRAMMING' }],
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
    const { ApiError } = await import('@/api/http')
    vi.mocked(scanDelivery).mockRejectedValue(new ApiError(21405, 'legacy msg'))
    const opts = baseOpts()
    const { submission, candidateDialogVisible } = build(opts)
    await submission.handleScan('X')
    await nextTick()
    expect(candidateDialogVisible.value).toBe(false)
  })
})

// 辅助：build composable 实例并暴露内部状态（视具体 export 形态调整）
function build(opts: ReturnType<typeof baseOpts>) {
  const inst = useDeliveryScanSubmission(opts as any)
  return {
    submission: inst,
    candidateDialogVisible: (inst as any).candidateDialogVisible,
  }
}