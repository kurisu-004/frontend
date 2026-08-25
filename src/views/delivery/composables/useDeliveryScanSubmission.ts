// composables/useDeliveryScanSubmission.ts
//
// 扫码主流程 + 提交草稿 + 打印送货单预览的业务状态 + 函数（2026-08-25 T11 从
// DeliveryNoteScan.vue 抽出）。
//
// 持有：
//   - 扫码防抖态（lastScanCode / lastScanAt / scanning）
//   - 阻塞弹窗（BlockedScanConfirmDialog）状态
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
  type BlockedScanItem,
  type DeliveryNoteDetailOut,
  type DeliveryNoteLineItem,
  type ScanDeliveryOut,
  type ScanNoteSummary,
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

  // ============ 扫码阻塞弹窗（2026-08-23 增量）==============
  /** 弹窗显隐 + 阻塞失败件列表 + 缓存的原始 code（重扫用）。 */
  const blockedDialogVisible = ref(false)
  const blockedFailures = ref<BlockedScanItem[]>([])
  const blockedReason = ref('')
  const blockedOriginalCode = ref('')

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
      await applySuccess(out)
    } catch (e) {
      applyError(code, e)
    } finally {
      scanning.value = false
      await nextTick()
    }
  }

  /** 成功：把 out.note 写入 drafts Map（按 id 替换为后端最新）；fire-and-forget 刷新 detail。 */
  async function applySuccess(out: ScanDeliveryOut): Promise<void> {
    opts.writeDraftFromScan(out.note)
    // 详情同步：失败仅 toast warning，不阻塞主流程的 success 提示。
    void opts.refreshDraftDetail(out.note.id).catch(() => {
      /* 已在 refreshDraftDetail 内 toast；这里仅防止 unhandled promise */
    })
    if (out.outcome === 'ADDED') {
      ElMessage.success(`已加入 ${out.resolved.serial_no} → ${out.note.delivery_note_no}`)
    } else {
      ElMessage.warning(`${out.resolved.serial_no} 已在 ${out.note.delivery_note_no} 上`)
    }
  }

  /**
   * 失败：按 ApiError.code 分流（2026-08-23 增量）。
   *   - 21418 / 21405（扫码阻塞） → 弹 BlockedScanConfirmDialog 让用户一键通过品检。
   *   - 其他错误 → 原 ElMessage.error 兜底（事务回滚不会产生草稿，不动 drafts）。
   *
   * 21418 / 21405 阻塞件失败原因包含两类：
   *   - 「未送检 / 阻塞」类（status=XXX）：品检未通过，弹窗供一键置送检状态。
   *   - 「on note DN-XXX」类：件已挂别的 active 单 —— 不应入此弹窗，按原 ElMessage 兜底。
   */
  function applyError(code: string, e: unknown): void {
    const apiErr = e as ApiError | null | undefined
    if (
      apiErr instanceof ApiError &&
      (BLOCK_SCAN_CODES as readonly number[]).includes(apiErr.code)
    ) {
      // 21418 后端 body: { code, message, data: { failures } }；
      // 错误拦截器保持 envelope 不解封（http.ts:232-234）；同时防御 root-level failures
      const errBody = (apiErr.response as { data?: any } | undefined)?.data ?? null
      let failures: BlockedScanItem[] | undefined = errBody?.data?.failures
      if (!failures || failures.length === 0) {
        const alt = errBody?.failures
        if (Array.isArray(alt) && alt.length > 0) failures = alt
      }
      // 21405 散件无 failures → 从 message 解析
      if (!failures || failures.length === 0) {
        failures = parseBlockMessage(apiErr.message)
      }

      if (failures && failures.length > 0) {
        // 过滤「on note DN-」冲突类（不是品检阻塞）
        const uninspected = failures.filter((f) => !/^on note DN-/.test(f.reason))
        if (uninspected.length === 0) {
          ElMessage.error(apiErr.message ?? '扫码失败')
          return
        }
        blockedFailures.value = uninspected
        blockedReason.value = apiErr.message ?? ''
        blockedOriginalCode.value = code
        blockedDialogVisible.value = true
        return
      }
    }
    const fallback = (e as { message?: string } | null | undefined)?.message ?? '扫码失败'
    ElMessage.error(fallback)
  }

  /**
   * 从 21405 散件 message 解析单元素 BlockedScanItem[]。
   *
   * 后端典型 message：`"part 批次状态 IN_PROCESS, 不可入单"` 或
   * `"part批次状态 X, 不可入单"`；serial_no 在 message 里没显式给（散件 message
   * 只提状态），构造单元素用占位 serial_no='-' + name='扫码件' + reason 透传。
   */
  function parseBlockMessage(msg: string | undefined): BlockedScanItem[] {
    if (!msg) return []
    const statusMatch = msg.match(/status=(\w+)/) ?? msg.match(/批次状态\s*(\w+)/)
    const status = statusMatch?.[1]
    return [
      {
        serial_no: '-',
        name: '扫码件',
        status: status ?? undefined,
        reason: msg,
      },
    ]
  }

  /**
   * 弹窗：阻塞件一键通过品检成功 → 自动用原 code 重扫（再走一遍 scanDelivery）。
   */
  async function onBlockedPassSuccess(): Promise<void> {
    blockedDialogVisible.value = false
    await handleScan(blockedOriginalCode.value)
  }

  /**
   * 弹窗：部分通过品检 → 提示用户处理失败项后重新扫码；不主动重扫。
   * 弹窗保留，由用户在弹窗内点取消关闭。
   */
  function onBlockedPassPartial(result: { passed: BulkPassItem[]; failed: BulkPassFailure[] }): void {
    ElMessage.warning(
      `部分通过品检：${result.passed.length} 项成功 / ${result.failed.length} 项失败；` +
      `请手动处理失败项后重新扫码`,
    )
  }

  function onBlockedCancel(): void {
    blockedDialogVisible.value = false
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
      await submitNote(noteId, { version: d.version })
      // 2026-08-24：note 已提交，缓存不应再保留 DRAFT 视图的 detail。
      detailCache.invalidate(noteId)
      // 本地清掉全部 ref（drafts / draftDetails / selectedByNote / printingByNote /
      // deletingByNote / tableRefs / foldedComputeds / localStorage 标记）
      opts.onDraftRemoved(noteId)
      ElMessage.success('已提交')
    } catch (e) {
      onSubmitDraftError(e)
    } finally {
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

  return {
    // state
    scanning,
    lastScanCode,
    lastScanAt,
    blockedDialogVisible,
    blockedFailures,
    blockedReason,
    blockedOriginalCode,
    printNotePreviewVisible,
    printNoteTarget,
    printNoteLoading,
    submitDialogVisible,
    submitTarget,
    submitUninspected,
    submittingByNote,

    // functions
    handleScan,
    applySuccess,
    applyError,
    onBlockedPassSuccess,
    onBlockedPassPartial,
    onBlockedCancel,
    openPrintNote,
    onSubmitDraft,
    onSubmitDialogPassSuccess,
    onSubmitDialogPassPartial,
    onSubmitDialogCancel,
  }
}
