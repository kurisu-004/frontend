// composables/useDeliveryScanSubmission.ts
//
// 扫码主流程 + 提交草稿 + 打印送货单预览的业务状态 + 函数（2026-08-25 T11 从
// DeliveryNoteScan.vue 抽出）。
//
// 持有：
//   - 扫码防抖态（lastScanCode / lastScanAt / scanning）
//   - route B 候选弹窗（DeliveryScanCandidateDialog）状态（candidateTargets /
//     originalScanCode / candidateDialogVisible）
//   - 打印送货单预览（PrintPreviewDialog）状态
//   - 提交草稿前的未送检确认（BatchInspectionConfirmDialog）状态
//   - submittingByNote —— 每张草稿卡片提交中 loading
//
// 不持有：
//   - drafts / draftDetails / selectedByNote / printingByNote / deletingByNote
//     —— useDeliveryDraftBoard 持有；本 composable 通过 options 注入回调访问
//
// 与 useDeliveryDraftBoard 的协调：
//   - writeDraftFromScan(note) → board 写入 drafts Map
//   - refreshDraftDetail(noteId) → board 重新拉详情
//   - clearNoteLocalState(noteId) → board 在 submit 成功后清掉全部 ref

import { nextTick, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { getNote, scanDelivery, submitNote } from '@/api/deliveryNote'
import { ApiError } from '@/api/http'
import { useDeliveryNoteDetailCache } from '@/composables/useDeliveryNoteDetailCache'
import {
  BLOCK_SCAN_CODES,
  type DeliveryNoteDetailOut,
  type DeliveryNoteLineItem,
  type ScanDeliveryOut,
  type ScanNoteSummary,
  type ScanUnresolvedTarget,
  type SubmitDeliveryOut,
} from '@/types/deliveryNote'
import type { BulkPassFailure, BulkPassItem } from '@/composables/useBulkPassInspection'

export interface UseDeliveryScanSubmissionOptions {
  /** 扫码命中后写入 drafts Map 的回调（由 useDeliveryDraftBoard 注入）。 */
  writeDraftFromScan: (note: ScanNoteSummary) => void
  /** 重新拉单个 note 的 line_items（由 useDeliveryDraftBoard 注入）。 */
  refreshDraftDetail: (noteId: string) => Promise<void>
  /**
   * 提交成功后清掉 note 全部本地 ref（由 useDeliveryDraftBoard 注入）；
   * useDeliveryScanSubmission 不直接知道 draftDetails / selectedByNote / tableRefs 的存在。
   */
  onDraftRemoved: (noteId: string) => void
}

export function useDeliveryScanSubmission(opts: UseDeliveryScanSubmissionOptions) {
  const detailCache = useDeliveryNoteDetailCache()

  // ============ 扫码防抖态 ============
  /** 1.5s 同码防抖：双击 Enter / 扫码枪连扫容错（设计文档 §5 防抖策略）。 */
  const lastScanCode = ref('')
  const lastScanAt = ref(0)
  /** 当前扫码 inflight 标记（handleScan 重入保护）。 */
  const scanning = ref(false)

  // ============ 打印送货单预览（2026-08-23 增量）==============
  /** preview 弹窗显隐 + 当前打开的 note（getNote 拉回）。 */
  const printNotePreviewVisible = ref(false)
  const printNoteTarget = ref<DeliveryNoteDetailOut | null>(null)
  const printNoteLoading = ref(false)

  // ============ 提交前未送检确认（2026-08-23 增量）==============
  /** 提交草稿前检测未送检件，触发 BatchInspectionConfirmDialog 一键通过品检后真正提交。 */
  const submitDialogVisible = ref(false)
  const submitTarget = ref<ScanNoteSummary | null>(null)
  const submitUninspected = ref<DeliveryNoteLineItem[]>([])

  /** 每张草稿卡片各自的提交中 loading 态。 */
  const submittingByNote = reactive<Record<string, boolean>>({})

  // ============ route B 候选批次弹窗（2026-08-28 新增）==============
  /** 扫码命中 CANDIDATES_AVAILABLE / PARTIAL_ADDED 时把 unresolved_targets 投到这里，
   * 父组件 DeliveryNoteScan 用 DeliveryScanCandidateDialog 渲染。
   * 弹窗「一键送检」成功后 emit('done') → 父级用 originalScanCode 重扫。 */
  const candidateTargets = ref<ScanUnresolvedTarget[]>([])
  const originalScanCode = ref<string>('')
  const candidateDialogVisible = ref(false)

  // ============ submit 后 CANDIDATES_AVAILABLE 候选弹窗（2026-08-29 新增）==============
  /** submit 返回 CANDIDATES_AVAILABLE 时把 unresolved_targets 投到这里，
   * 父组件 DeliveryNoteScan 用 DeliverySubmitCandidateDialog 渲染。
   * 弹窗「一键过检并重新提交」成功后 emit('done') → 父级 fetchDetail 拿新 version + doSubmit 重提。 */
  const submitCandidateTargets = ref<ScanUnresolvedTarget[]>([])
  const submitCandidateOriginalNote = ref<ScanNoteSummary | null>(null)
  const submitCandidateDialogVisible = ref(false)

  // ============ 扫码主流程 ============

  /**
   * 单次扫码处理全流程（v3 只来自扫码枪 onScan 回调）：
   *   1) trim + 长度校验
   *   2) inflight / 1.5s 同码 防抖
   *   3) await scanDelivery → applySuccess / applyError
   */
  async function handleScan(rawCode: string): Promise<void> {
    const code = rawCode.trim()

    // 1) 客户端格式校验
    if (code.length < 1 || code.length > 64) {
      ElMessage.warning('条码格式不正确')
      return
    }

    // 2) inflight / 双击 Enter 守卫
    if (scanning.value) {
      ElMessage.warning('上一次扫码尚未完成，请稍候')
      return
    }
    const now = Date.now()
    if (lastScanCode.value === code && now - lastScanAt.value < 1500) {
      return // 同码 1.5s 内重复：吞掉
    }
    lastScanCode.value = code
    lastScanAt.value = now

    scanning.value = true
    try {
      const out = await scanDelivery(code)
      await applySuccess(out, code)
    } catch (e) {
      applyError(code, e)
    } finally {
      scanning.value = false
      await nextTick()
    }
  }

  /** 成功：按 outcome 4 分支处理（2026-08-28 路线 B）。
   *   - ADDED：批次全部已挂载 → writeDraftFromScan + refresh + success toast
   *   - ALREADY_PRESENT：幂等命中 → refresh + warning（不重复写 draft）
   *   - CANDIDATES_AVAILABLE：B 组待送检 → writeDraftFromScan（A 组 0 项也写以记录扫码历史）+ 弹候选弹窗
   *   - PARTIAL_ADDED：装配件混合 → writeDraftFromScan + refresh + 弹候选弹窗 */
  async function applySuccess(out: ScanDeliveryOut, originalCode: string): Promise<void> {
    switch (out.outcome) {
      case 'ADDED':
        if (out.note) {
          opts.writeDraftFromScan(out.note)
          void opts.refreshDraftDetail(out.note.id).catch(() => { /* 已 toast */ })
        }
        ElMessage.success(
          `已加入 ${out.resolved?.serial_no ?? ''} → ${out.note?.delivery_note_no ?? ''}`,
        )
        break
      case 'ALREADY_PRESENT':
        // 幂等：不重复 writeDraftFromScan（草稿未变化），但提示
        if (out.note) {
          void opts.refreshDraftDetail(out.note.id).catch(() => { /* 已 toast */ })
        }
        ElMessage.warning(
          `${out.resolved?.serial_no ?? ''} 已在 ${out.note?.delivery_note_no ?? ''} 上`,
        )
        break
      case 'CANDIDATES_AVAILABLE':
        // 散件仅 B 组：写草稿（A 组 0 项也要写以记录扫码历史）+ 弹候选弹窗
        if (out.note) opts.writeDraftFromScan(out.note)
        candidateTargets.value = out.unresolved_targets ?? []
        originalScanCode.value = originalCode
        candidateDialogVisible.value = true
        ElMessage.info(
          `识别到 ${out.resolved?.serial_no ?? ''}，但 ${candidateTargets.value.length} 项未送检，请确认`,
        )
        break
      case 'PARTIAL_ADDED':
        // 装配件混合：A 组已挂载 + B 组子件待送检
        if (out.note) {
          opts.writeDraftFromScan(out.note)
          void opts.refreshDraftDetail(out.note.id).catch(() => { /* 已 toast */ })
        }
        candidateTargets.value = out.unresolved_targets ?? []
        originalScanCode.value = originalCode
        candidateDialogVisible.value = true
        ElMessage.success(
          `草稿已加入 ${out.added_batches?.length ?? 0} 项；剩余 ${candidateTargets.value.length} 项未送检，请确认`,
        )
        break
    }
  }

  /**
   * 失败：按 ApiError.code 分流（2026-08-28 路线 B 简化）。
   *   - 21421（BIZ_DELIVERY_BATCH_STATE_INVALID，C 组状态短路：DELIVERED / OUTSOURCE /
   *     IN_PROCESS 工人持有 / COMPLETED / CANCELLED）→ 直接 toast，无 failures 结构、不弹窗。
   *   - 21417（BIZ_DELIVERY_SCAN_UNKNOWN_CODE，条码未命中）→ toast 提示。
   *   - 其他 → 兜底 toast。
   *
   * 旧 21405 / 21418 不再由 scan 触发（candidate 弹窗由 CANDIDATES_AVAILABLE /
   * PARTIAL_ADDED outcome 触发，见 applySuccess）。
   */
  function applyError(_code: string, e: unknown): void {
    const apiErr = e as ApiError | null | undefined
    if (
      apiErr instanceof ApiError &&
      (BLOCK_SCAN_CODES as readonly number[]).includes(apiErr.code)
    ) {
      // 21421 C 组状态短路：无 failures 结构，直接展示 message
      ElMessage.error(apiErr.message ?? '批次状态不允许扫码建单')
      return
    }
    if (apiErr instanceof ApiError && apiErr.code === 21417) {
      // BIZ_DELIVERY_SCAN_UNKNOWN_CODE：条码未命中
      ElMessage.error(`无法识别扫码：${apiErr.message ?? '请检查条码'}`)
      return
    }
    const fallback = (e as { message?: string } | null | undefined)?.message ?? '扫码失败'
    ElMessage.error(fallback)
  }

  // ============ 打印送货单 + 提交草稿 ============

  /**
   * 打开打印送货单预览：
   *   - 先 getNote 拉 detail（full line_items），期间 printNoteTarget=null
   *     且弹窗保持关闭（v-if 控制）
   *   - 拿到 detail 后才打开弹窗；失败 toast 并保持关闭
   *
   * 注：PrintPreviewDialog 的 watch 只触发 inits / 加载在 modelValue/mergeMode
   * 变化时；为避免「note=null 时打开空表格」，先关着、等数据好再开。
   */
  async function openPrintNote(d: ScanNoteSummary): Promise<void> {
    printNoteTarget.value = null
    printNotePreviewVisible.value = false
    printNoteLoading.value = true
    try {
      const detail = await detailCache.get(d.id, getNote)
      if (!detail) throw new Error('详情拉取失败')
      printNoteTarget.value = detail
      printNotePreviewVisible.value = true
    } catch (e) {
      ElMessage.error((e as Error).message ?? '加载详情失败')
    } finally {
      printNoteLoading.value = false
    }
  }

  /**
   * 提交草稿：先 getNote 拉完整 detail 检查未送检件。
   *   - 全 INSPECTION / READY_TO_SHIP → ElMessageBox.confirm 直接提交。
   *   - 有未送检件 → 弹 BatchInspectionConfirmDialog，让用户一键通过品检后真正提交。
   */
  async function onSubmitDraft(d: ScanNoteSummary): Promise<void> {
    let detail: DeliveryNoteDetailOut
    // 2026-08-24：进入提交流前 invalidate，避免拿到的 detail 是「之前会话」的 stale 副本。
    detailCache.invalidate(d.id)
    try {
      const fetched = await detailCache.get(d.id, getNote)
      if (!fetched) throw new Error('详情拉取失败')
      detail = fetched
    } catch (e) {
      ElMessage.error((e as Error).message ?? '加载详情失败')
      return
    }
    const uninspected = (detail.line_items ?? []).filter(
      (li) => li.status !== 'INSPECTION' && li.status !== 'READY_TO_SHIP',
    )
    // 同步最新 version（避免 reloadDrafts 与此处 getNote 之间再次改动）；
    // writeDraftFromScan 内部实现 = drafts.value = { ...drafts.value, [note.id]: note }，
    // 等价于原代码的 in-place version 更新。
    opts.writeDraftFromScan({ ...d, version: detail.version })
    if (uninspected.length > 0) {
      submitTarget.value = { ...d, version: detail.version }
      submitUninspected.value = uninspected
      submitDialogVisible.value = true
      return
    }
    await confirmAndSubmit({ ...d, version: detail.version })
  }

  async function confirmAndSubmit(d: ScanNoteSummary): Promise<void> {
    try {
      await ElMessageBox.confirm(
        `确认提交草稿 ${d.delivery_note_no}？`,
        '提交草稿',
        { type: 'warning', confirmButtonText: '提交', cancelButtonText: '取消' },
      )
    } catch {
      return
    }
    await doSubmit(d)
  }

  async function doSubmit(d: ScanNoteSummary): Promise<void> {
    const noteId = d.id
    submittingByNote[noteId] = true
    try {
      const out: SubmitDeliveryOut = await submitNote(noteId, { version: d.version })
      // 2026-08-29：后端 submit 返回 SubmitDeliveryOut，outcome 分流：
      // - 'SUBMITTED'（或缺失，向后兼容旧 server）：提交成功
      // - 'CANDIDATES_AVAILABLE'：note 仍是 DRAFT，挂的批次仍有 INSPECTION 未过检；
      //   弹 DeliverySubmitCandidateDialog 让用户一键过检后再次 submit。
      if (out.outcome === 'CANDIDATES_AVAILABLE' || out.unresolved_targets) {
        submitCandidateTargets.value = out.unresolved_targets ?? []
        submitCandidateOriginalNote.value = d
        submitCandidateDialogVisible.value = true
        ElMessage.info(`仍有 ${submitCandidateTargets.value.length} 项未过检，请确认`)
        // success path 不成立：finally 不靠 return 跳过（submittingByNote 需保留为 true，
        // dialog 的 done 会重 submit；cancel 后 user 可手动重试）。
        return
      }
      // 2026-08-24：note 已提交，缓存不应再保留 DRAFT 视图的 detail。
      detailCache.invalidate(noteId)
      // 本地清掉全部 ref（drafts / draftDetails / selectedByNote / printingByNote /
      // deletingByNote / tableRefs / foldedComputeds / localStorage 标记）。
      // shell 的 onDraftRemoved 会 delete submittingByNote[noteId]，所以 success 路径
      // 不需要再写回 false（写了会留 orphan key；finally 不靠 return 跳过——ECMAScript
      // 规范 finally 在任何退出路径都执行，所以不能放重置）。
      opts.onDraftRemoved(noteId)
      ElMessage.success('已提交')
    } catch (e) {
      onSubmitDraftError(e)
      // 失败路径：catch 里只重置一次，让用户可以重试提交
      submittingByNote[noteId] = false
    }
  }

  /**
   * 提交失败处理：
   *   - 21403 BIZ_VERSION_CONFLICT → 提示并刷新 detail 让 version 同步（与
   *     DeliveryNoteDetail.vue:99 路径对齐）。
   *   - 其他 → toast error。
   */
  function onSubmitDraftError(e: unknown): void {
    const err = e as { code?: number; message?: string; response?: { data?: { code?: number } } }
    if (err?.code === 21403 || err?.response?.data?.code === 21403) {
      ElMessage.warning('版本已过期，正在刷新...')
      const target = submitTarget.value
      if (target) {
        void opts.refreshDraftDetail(target.id).catch(() => { /* 已 toast */ })
      }
      return
    }
    ElMessage.error(err?.message ?? '提交失败')
  }

  /**
   * BatchInspectionConfirmDialog 全部通过品检 → 关闭弹窗 → 真正提交。
   * 注：dialog 内部已刷新过 line_items 状态（变成 INSPECTION）；我们这里需要
   * 拉最新的 detail.version，因为 onSubmitDraft 拿到的 version 可能已变。
   */
  async function onSubmitDialogPassSuccess(): Promise<void> {
    submitDialogVisible.value = false
    const d = submitTarget.value
    if (!d) return
    // 2026-08-24：passInspection 改变了 line_items 状态 → invalidate 后重拉最新 version。
    detailCache.invalidate(d.id)
    try {
      const detail = await detailCache.get(d.id, getNote)
      if (!detail) throw new Error('详情拉取失败')
      await doSubmit({ ...d, version: detail.version })
    } catch (e) {
      ElMessage.error((e as Error).message ?? '加载详情失败')
    }
  }

  /**
   * BatchInspectionConfirmDialog 部分通过品检 → 提示用户已通过的已置送检状态，
   * 失败项需手动处理后再次提交；保留弹窗让用户决定（重试 / 取消）。
   * 这里只 toast + 刷新 draftDetails 让 UI 反映新状态。
   */
  function onSubmitDialogPassPartial(result: { passed: BulkPassItem[]; failed: BulkPassFailure[] }): void {
    ElMessage.warning(
      `部分通过品检：${result.passed.length} 项成功 / ${result.failed.length} 项失败；` +
      `已通过的已置送检状态，请处理失败项后再次提交`,
    )
    if (submitTarget.value) {
      void opts.refreshDraftDetail(submitTarget.value.id).catch(() => { /* 已 toast */ })
    }
  }

  function onSubmitDialogCancel(): void {
    submitDialogVisible.value = false
  }

  // ============ submit 后 CANDIDATES_AVAILABLE 候选弹窗回调（2026-08-29 新增）==============
  /** 候选弹窗「一键过检」成功后：刷新 detail（拿新 version）→ 自动重提。
   *  如果重提又返回 CANDIDATES_AVAILABLE（极端场景：过检后又有新 INSPECTION 批次），由 doSubmit 再次触发弹窗。
   *  doSubmit 的 submittingByNote 守卫会防止无限递归（同 noteId 上一次 inflight 完成后才能再起）。 */
  async function onSubmitCandidateDone(): Promise<void> {
    submitCandidateDialogVisible.value = false
    const original = submitCandidateOriginalNote.value
    if (!original) return
    detailCache.invalidate(original.id)
    try {
      const fetched = await detailCache.get(original.id, getNote)
      if (!fetched) throw new Error('详情拉取失败')
      await doSubmit({ ...original, version: fetched.version })
    } catch (e) {
      ElMessage.error((e as Error).message ?? '重提失败')
    }
  }

  function onSubmitCandidateCancel(): void {
    submitCandidateDialogVisible.value = false
    // 允许用户手动重试：重置 submitting flag，让 onCardSubmitDraft 重新进入 doSubmit。
    const original = submitCandidateOriginalNote.value
    if (original) {
      submittingByNote[original.id] = false
    }
  }

  return {
    // state
    scanning,
    lastScanCode,
    lastScanAt,
    printNotePreviewVisible,
    printNoteTarget,
    printNoteLoading,
    submitDialogVisible,
    submitTarget,
    submitUninspected,
    submittingByNote,
    // 2026-08-28 新增：route B 候选弹窗态
    candidateTargets,
    originalScanCode,
    candidateDialogVisible,
    // 2026-08-29 新增：submit 后 CANDIDATES_AVAILABLE 候选弹窗态
    submitCandidateTargets,
    submitCandidateOriginalNote,
    submitCandidateDialogVisible,

    // functions
    handleScan,
    applySuccess,
    applyError,
    openPrintNote,
    onSubmitDraft,
    onSubmitDialogPassSuccess,
    onSubmitDialogPassPartial,
    onSubmitDialogCancel,
    // 2026-08-29 新增：submit 候选弹窗回调
    onSubmitCandidateDone,
    onSubmitCandidateCancel,
  }
}
