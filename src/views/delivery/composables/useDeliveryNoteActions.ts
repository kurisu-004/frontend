// views/delivery/composables/useDeliveryNoteActions.ts
//
// 2026-08-25 frontend-overall-refactor：DeliveryNoteDetail 拆分的 useDeliveryNoteActions。
// 负责所有 page-level 业务操作（state machine transition / part 增删 / 打印触发）：
// - onDeliveryDateChange：改送货日期（含 21403 BIZ_VERSION_CONFLICT 识别）
// - onSubmit / onSubmitDialogPassSuccess / onSubmitDialogPassPartial / onSubmitError：
//   提交前批量品检前置检测 + confirmDangerous + submitNote（带 version 冲突兜底）
// - onRecall：撤回
// - onSoftDelete：软删并跳列表
// - onRemoveSelected：移除选中零件
// - onAddParts：picker 提交后入单
//
// 设计要点：
// - composable 只持有「业务函数」；不持有 UI 状态（dialog 可见性由 shell 自管）。
// - 所有破坏性操作走 confirmDangerous（T8 模式）。
// - fetchDetail 由 detail composable 传入，actions 完成后调一次 refresh。
// - 错误处理：40403 / 21403 → ElMessage.warning 并 fetchDetail 同步本地；
//   其它 → ElMessage.error(e.message)（T14p5 同款：让 fetch 自然抛、不在 composable 内吞）。
// - 返回值 Promise<boolean> 由 shell 决定后续（是否 close dialog / 跳转）。
//   当前 actions 都是「fire-and-forget」语义，但为了一致性也返回 boolean。

import { ElMessage } from 'element-plus'
import { ref, type Ref } from 'vue'
import { useRouter } from 'vue-router'
import {
  addParts,
  recallNote,
  removeParts,
  softDeleteNote,
  submitNote,
  updateNote,
  type AddPartsItem,
} from '@/api/deliveryNote'
import type { ApiError } from '@/api/http'
import { useConfirm } from '@/composables/useConfirm'
import type {
  BulkPassFailure,
  BulkPassItem,
} from '@/composables/useBulkPassInspection'
import type {
  DeliveryNoteLineItem,
  ScanUnresolvedTarget,
  SubmitDeliveryOut,
} from '@/types/deliveryNote'

/**
 * 详情 composable 暴露给 actions 的最小接口（避免 actions 依赖整个 detail composable）。
 */
export interface DeliveryNoteDetailBindings {
  note: Ref<{
    id: string
    version: number
    part_count: number
    delivery_note_no: string
    delivery_date: string | null
  } | null>
  uninspectedItems: Ref<readonly DeliveryNoteLineItem[]>
  selectedItemIds: Ref<string[]>
  editDeliveryDate: Ref<string>
  fetchDetail: () => Promise<void>
  setSelectedItemIds: (ids: string[]) => void
}

export interface UseDeliveryNoteActionsReturn {
  // mutate local state
  setEditDeliveryDate: (date: string) => void
  // actions
  onDeliveryDateChange: (newDate: string | null) => Promise<boolean>
  onSubmit: () => Promise<boolean>
  onSubmitDialogPassSuccess: () => Promise<boolean>
  onSubmitDialogPassPartial: (
    result: { passed: BulkPassItem[]; failed: BulkPassFailure[] },
  ) => void
  onRecall: () => Promise<boolean>
  onSoftDelete: () => Promise<boolean>
  onRemoveSelected: () => Promise<boolean>
  onAddParts: (items: AddPartsItem[]) => Promise<boolean>
  // 2026-08-29 新增：submit 后 CANDIDATES_AVAILABLE 候选弹窗态 + 回调
  submitCandidateTargets: Ref<ScanUnresolvedTarget[]>
  submitCandidateDialogVisible: Ref<boolean>
  submitCandidateNoteId: Ref<string | null>
  onSubmitCandidateDone: () => Promise<void>
  onSubmitCandidateCancel: () => void
}

export function useDeliveryNoteActions(
  bindings: DeliveryNoteDetailBindings,
): UseDeliveryNoteActionsReturn {
  const router = useRouter()
  const { dangerous: confirmDangerous } = useConfirm()

  // ============ submit 后 CANDIDATES_AVAILABLE 候选弹窗（2026-08-29 新增）==============
  /** submit 返回 CANDIDATES_AVAILABLE 时把 unresolved_targets 投到这里，
   * shell（DeliveryNoteDetail）用 DeliverySubmitCandidateDialog 渲染。
   * 弹窗「一键过检并重新提交」成功后 emit('done') → onSubmitCandidateDone
   * fetchDetail 拿新 version + doSubmit 重提。 */
  const submitCandidateTargets = ref<ScanUnresolvedTarget[]>([])
  const submitCandidateDialogVisible = ref(false)
  const submitCandidateNoteId = ref<string | null>(null)

  // ============ 辅助 ============
  /** submitNote 统一错误处理：识别 21403 BIZ_VERSION_CONFLICT / 40901 批次 version 不匹配 → 刷新详情；其它原样展示 */
  function onSubmitError(e: unknown): void {
    const err = e as ApiError
    // ApiError 已在 http.ts 信封拦截器中把 backend code 提到顶层 err.code
    if (err?.code === 21403) {
      ElMessage.warning('版本已过期，正在刷新...')
      void bindings.fetchDetail()
      return
    }
    // 2026-08-29 新增：40901 = BIZ_VERSION_CONFLICT（批次 version 不匹配，
    // batch-to-ship 联动 submit 时可能附带返回），同样让用户刷新生效。
    if (err?.code === 40901) {
      ElMessage.warning('该批次已被他人修改，请刷新后重试')
      void bindings.fetchDetail()
      return
    }
    ElMessage.error(err?.message ?? '提交失败')
  }

  function setEditDeliveryDate(date: string): void {
    bindings.editDeliveryDate.value = date
  }

  // ============ 改送货日期 ============
  async function onDeliveryDateChange(newDate: string | null): Promise<boolean> {
    const n = bindings.note.value
    if (!n) return false
    const normalized = newDate ?? ''
    if (normalized === (n.delivery_date ?? '')) return false  // 没变 → 不发请求
    try {
      await updateNote(n.id, {
        version: n.version,
        delivery_date: normalized,
      })
      ElMessage.success('已更新送货日期')
      await bindings.fetchDetail()
      return true
    } catch (e: unknown) {
      const err = e as ApiError
      if (err?.code === 21403 /* BIZ_VERSION_CONFLICT */) {
        ElMessage.warning('该记录已被其他用户修改，请刷新后重试')
      } else {
        ElMessage.error(err?.message ?? '更新送货日期失败')
      }
      await bindings.fetchDetail()
      return false
    }
  }

  // ============ 提交（带未送检前置检测 + confirmDangerous）============
  /**
   * 内部 submit 助手（2026-08-29 重构）：
   * - 调 submitNote，按 SubmitDeliveryOut.outcome 分流
   * - 'SUBMITTED'（或缺失，向后兼容旧 server）→ success path + fetchDetail
   * - 'CANDIDATES_AVAILABLE' → 弹 DeliverySubmitCandidateDialog；shell 在
   *   看到 submitCandidateDialogVisible 翻 true 时渲染弹窗
   * 错误处理：21403 / 40901 → onSubmitError 刷新详情；其它原样展示。
   * 返回值：success path = true；弹窗 / 错误 / 缺 note = false（shell 不会因此关闭任何东西）。
   */
  async function doSubmit(): Promise<boolean> {
    const n = bindings.note.value
    if (!n) return false
    try {
      const out: SubmitDeliveryOut = await submitNote(n.id, { version: n.version })
      if (out.outcome === 'CANDIDATES_AVAILABLE' || out.unresolved_targets) {
        submitCandidateTargets.value = out.unresolved_targets ?? []
        submitCandidateNoteId.value = n.id
        submitCandidateDialogVisible.value = true
        ElMessage.info(`仍有 ${submitCandidateTargets.value.length} 项未过检，请确认`)
        return false
      }
      ElMessage.success('已提交')
      await bindings.fetchDetail()
      return true
    } catch (e) {
      onSubmitError(e)
      return false
    }
  }

  async function onSubmit(): Promise<boolean> {
    const n = bindings.note.value
    if (!n) return false
    // 前置未送检检测：有任何非 INSPECTION / READY_TO_SHIP 件 → shell 应打开批量过检弹窗
    if (bindings.uninspectedItems.value.length > 0) {
      return false  // shell 收到 false 后判断应打开 submitDialogVisible
    }
    if (!await confirmDangerous(
      '提交送货单',
      `确认提交 ${n.delivery_note_no}？`,
      { type: 'warning', confirmText: '提交', cancelText: '取消' },
    )) return false
    return await doSubmit()
  }

  /** BatchInspectionConfirmDialog 全部通过品检 → 继续 submitNote */
  async function onSubmitDialogPassSuccess(): Promise<boolean> {
    return await doSubmit()
  }

  /** BatchInspectionConfirmDialog 部分通过 → toast 提示失败明细，不关闭弹窗 */
  function onSubmitDialogPassPartial(
    result: { passed: BulkPassItem[]; failed: BulkPassFailure[] },
  ): void {
    ElMessage.warning(
      `部分通过：${result.passed.length} 项成功 / ${result.failed.length} 项失败，请手动处理失败项`,
    )
    // 保留弹窗让用户继续操作（不关闭）；刷新详情同步已通过的 status
    void bindings.fetchDetail()
  }

  // ============ 撤回 ============
  async function onRecall(): Promise<boolean> {
    const n = bindings.note.value
    if (!n) return false
    if (!await confirmDangerous(
      '撤回送货单',
      `确认撤回 ${n.delivery_note_no}？`,
      { type: 'warning' },
    )) return false
    try {
      await recallNote(n.id, { version: n.version })
      ElMessage.success('已撤回')
      await bindings.fetchDetail()
      return true
    } catch (e) {
      const err = e as ApiError
      ElMessage.error(err?.message ?? '撤回失败')
      return false
    }
  }

  // ============ 软删 ============
  async function onSoftDelete(): Promise<boolean> {
    const n = bindings.note.value
    if (!n) return false
    if (!await confirmDangerous(
      '删除送货单',
      `确认删除 ${n.delivery_note_no}？关联零件会解除。`,
      { type: 'warning' },
    )) return false
    try {
      await softDeleteNote(n.id, { version: n.version })
      ElMessage.success('已删除')
      await router.push('/delivery-notes')
      return true
    } catch (e) {
      const err = e as ApiError
      ElMessage.error(err?.message ?? '删除失败')
      return false
    }
  }

  // ============ 移除选中零件 ============
  async function onRemoveSelected(): Promise<boolean> {
    const n = bindings.note.value
    if (!n) return false
    if (bindings.selectedItemIds.value.length === 0) {
      ElMessage.warning('请勾选要移除的零件')
      return false
    }
    if (!await confirmDangerous(
      '移除零件',
      `确认移除选中的 ${bindings.selectedItemIds.value.length} 件零件？`,
      { type: 'warning' },
    )) return false
    try {
      await removeParts(n.id, {
        batch_ids: bindings.selectedItemIds.value,
        version: n.version,
      })
      ElMessage.success('已移除')
      bindings.setSelectedItemIds([])
      await bindings.fetchDetail()
      return true
    } catch (e) {
      const err = e as ApiError
      ElMessage.error(err?.message ?? '移除失败')
      return false
    }
  }

  // ============ picker 提交入单 ============
  async function onAddParts(items: AddPartsItem[]): Promise<boolean> {
    const n = bindings.note.value
    if (!n) return false
    if (items.length === 0) return false
    try {
      await addParts(n.id, { items, version: n.version })
      ElMessage.success(`已添加 ${items.length} 批`)
      await bindings.fetchDetail()
      return true
    } catch (e) {
      const err = e as ApiError
      ElMessage.error(err?.message ?? '添加失败')
      return false
    }
  }

  // ============ submit 后 CANDIDATES_AVAILABLE 候选弹窗回调（2026-08-29 新增）==============
  /** 候选弹窗「一键过检」成功后：fetchDetail（拿新 version）→ doSubmit 重提。
   *  如果重提又返回 CANDIDATES_AVAILABLE（极端场景：过检后又有新 INSPECTION 批次），
   *  由 doSubmit 再次触发弹窗。doSubmit 同步串行，不会无限递归。 */
  async function onSubmitCandidateDone(): Promise<void> {
    submitCandidateDialogVisible.value = false
    const noteId = submitCandidateNoteId.value
    if (!noteId) return
    try {
      await bindings.fetchDetail()
      // fetchDetail 后 note.version 已更新；doSubmit 用最新 version 调 submitNote
      await doSubmit()
    } catch (e) {
      ElMessage.error((e as Error).message ?? '重提失败')
    }
  }

  function onSubmitCandidateCancel(): void {
    submitCandidateDialogVisible.value = false
  }

  return {
    setEditDeliveryDate,
    onDeliveryDateChange,
    onSubmit,
    onSubmitDialogPassSuccess,
    onSubmitDialogPassPartial,
    onRecall,
    onSoftDelete,
    onRemoveSelected,
    onAddParts,
    // 2026-08-29 新增
    submitCandidateTargets,
    submitCandidateDialogVisible,
    submitCandidateNoteId,
    onSubmitCandidateDone,
    onSubmitCandidateCancel,
  }
}
