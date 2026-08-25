// composables/useDeliveryDraftBoard.ts
//
// 草稿卡片列表的业务状态 + 业务函数（2026-08-25 T11 从 DeliveryNoteScan.vue 抽出）。
//
// 持有：
//   - drafts / draftDetails / draftsLoading / draftsCount
//     —— 草稿 header + line_items + 加载态 + 计数
//   - selectedByNote / printingByNote / deletingByNote
//     —— 每张草稿卡片各自的运行时状态（勾选 / 各种 loading）
//   - tableRefs / foldedComputeds
//     —— 每张卡片的 el-table 实例（clearSelection 用）+ foldBySerial 缓存
//
// 不持有：
//   - submittingByNote（属于 useDeliveryScanSubmission，与 doSubmit 配对）
//   - 扫码相关状态（lastScanCode / scanning / 阻塞弹窗等）
//   - 提交 / 打印预览相关弹窗状态
//
// 子组件约定：
//   - DeliveryDraftCard 通过 props 读 drafts / rows / selectedRows / 各 loading 标志，
//     通过 emits 把 user action（goto-detail / selection-change / remove / print-labels /
//     print-note / delete-draft / submit-draft / set-table-ref）回给 shell，
//     shell 把 emits 接到本 composable 的函数。

import { computed, reactive, ref, type ComputedRef, type Ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  batchGetNotes,
  getNote,
  listNotes,
  printNoteLabels,
  removeParts,
  softDeleteNote,
} from '@/api/deliveryNote'
import { usePrintedLabels } from '@/composables/usePrintedLabels'
import { useDeliveryNoteDetailCache } from '@/composables/useDeliveryNoteDetailCache'
import { triggerBrowserDownload } from '@/utils/download'
import type {
  DeliveryNoteLineItem,
  ScanNoteSummary,
} from '@/types/deliveryNote'

/**
 * el-table 一行 = 同 serial_no 折叠后的若干 batch；serial 为 null 时按 id 各占一行。
 */
export interface MergedDraftRow {
  /** 同 serial_no 折叠后的代表 serial；为 null 时按各自一行（key = `__null_<id>`）。 */
  serial_no: string | null
  drawing_no: string
  name: string
  /** 折叠各 batch 之和。 */
  quantity: number
  /** 系统交期；同 serial 多 batch 取首个非空。 */
  system_delivery_date: string | null
  /** 折叠行背后的所有 batch id（用于 remove / print）。 */
  batch_ids: string[]
  /** 任一 batch 在 localStorage 里登记为已打印 = true；用于绿底渲染。 */
  label_printed: boolean
}

/**
 * el-table 实例 ref（只用到 clearSelection；不绑 FormInstance 等更复杂类型）。
 */
export interface DraftTableInstance {
  clearSelection: () => void
}

/**
 * 同 serial_no 多 batch 折叠为一行（参考 PrintPreviewDialog.vue:91 foldSamePart，
 * 但分组 key 从 part_id 换成 serial_no）。
 */
function foldBySerial(
  items: DeliveryNoteLineItem[],
  isPrinted: (batchId: string) => boolean,
): MergedDraftRow[] {
  const groups = new Map<string, MergedDraftRow>()
  const order: string[] = []
  for (const li of items) {
    const key = li.serial_no ?? `__null_${li.id}`
    const existing = groups.get(key)
    const printed = isPrinted(String(li.id))
    if (existing) {
      existing.quantity += li.quantity
      existing.batch_ids.push(String(li.id))
      if (!existing.label_printed && printed) existing.label_printed = true
      if (!existing.system_delivery_date && li.system_delivery_date) {
        existing.system_delivery_date = li.system_delivery_date
      }
    } else {
      const row: MergedDraftRow = {
        serial_no: li.serial_no,
        drawing_no: li.drawing_no,
        name: li.name,
        quantity: li.quantity,
        system_delivery_date: li.system_delivery_date,
        batch_ids: [String(li.id)],
        label_printed: printed,
      }
      groups.set(key, row)
      order.push(key)
    }
  }
  return order.map((k) => groups.get(k)!)
}

export function useDeliveryDraftBoard() {
  const printedLabelStore = usePrintedLabels()
  const detailCache = useDeliveryNoteDetailCache()

  // ============ 草稿 header + detail 缓存 ============
  /** 当前 L1 下所有 DRAFT 草稿（key = note_id）—— header 摘要。 */
  const drafts = ref<Record<string, ScanNoteSummary>>({})
  /** 每个草稿的完整 line_items（按 note_id 存），el-table 数据源。 */
  const draftDetails = reactive<Record<string, DeliveryNoteLineItem[]>>({})
  const draftsLoading = ref(false)
  const draftsCount: ComputedRef<number> = computed(
    () => Object.keys(drafts.value).length,
  )

  // ============ 每张草稿卡片各自的运行时状态 ============
  /** 每张草稿卡片各自的勾选行（用于「打印标签」按钮）。 */
  const selectedByNote = reactive<Record<string, MergedDraftRow[]>>({})
  /** 每张草稿卡片各自的打印中 loading 态。 */
  const printingByNote = reactive<Record<string, boolean>>({})
  /** 每张草稿卡片各自的删除中 loading 态。 */
  const deletingByNote = reactive<Record<string, boolean>>({})

  /**
   * 每张草稿卡片各自的 el-table 实例 ref；打印成功后显式调 clearSelection()
   * 触发 EP 自身的 selection-change → onSelectionChange 顺势清空 selectedByNote，
   * 避免依赖 markPrinted → folded computed 重算这条隐式链路。
   */
  const tableRefs = new Map<string, DraftTableInstance>()

  // ============ 折叠数据缓存（per-note computed；保 data 引用稳定）============
  /**
   * EP table 在 :data 引用变化时（store/index.mjs:27-37 的 setData 命中
   * dataInstanceChanged）会自动 clearSelection()。原实现模板内联调用
   * foldBySerial(...) → 每次重渲染都产生新数组 → 勾选立刻被清，与
   * selectedByNote 写入触发的重渲染形成死循环。
   *
   * 按 note_id 缓存 computed：当 draftDetails[noteId] 与 printedLabelStore
   * 均未变时复用同一引用，视图重渲染不再误清勾选；数据真正变化（扫码刷新 /
   * markPrinted / 移除）时正常重算（引用变了 → EP 自动清勾选，符合直觉）。
   */
  const foldedComputeds = new Map<string, ComputedRef<MergedDraftRow[]>>()

  /** 子组件用：注册 / 反注册 el-table 实例；给 onPrintLabels 的 clearSelection 用。 */
  function setTableRef(noteId: string, el: DraftTableInstance | null): void {
    if (el) tableRefs.set(noteId, el)
    else tableRefs.delete(noteId)
  }

  /** 按 note_id 取 foldBySerial 结果（命中 cache 时复用同一 ref）。 */
  function foldedRows(noteId: string): MergedDraftRow[] {
    let c = foldedComputeds.get(noteId)
    if (!c) {
      c = computed(() => foldBySerial(draftDetails[noteId] ?? [], printedLabelStore.isPrintedBatch))
      foldedComputeds.set(noteId, c)
    }
    return c.value
  }

  /** el-table 行已打印绿底（与 DeliveryNoteDetail.vue row-urgent 样式对齐）。 */
  function rowClassName({ row }: { row: MergedDraftRow }): string {
    return row.label_printed ? 'row-printed' : ''
  }

  function onSelectionChange(noteId: string, rows: MergedDraftRow[]): void {
    selectedByNote[noteId] = rows
  }

  function hasSelection(noteId: string): boolean {
    return (selectedByNote[noteId]?.length ?? 0) > 0
  }

  function getSelectionSize(noteId: string): number {
    return selectedByNote[noteId]?.length ?? 0
  }

  // ============ 数据加载 ============

  /**
   * 拉当前 L1 下所有 DRAFT 草稿 + 各草稿的完整 line_items。
   *
   * 两步：
   *   1) listNotes 拿 header（statuses=DRAFT, customer_id=l1, limit=200）；
   *   2) 对每个 header 并发 batchGetNotes([...])（PR3 上线后），拿到完整
   *      DeliveryNoteDetailOut.line_items；命中 detailCache 的 note 跳过。
   *
   * 任一失败 → 兜底空数组（不阻断其他草稿卡片渲染）。
   */
  async function reloadDrafts(l1Id: string): Promise<void> {
    if (!l1Id) {
      drafts.value = {}
      // 清空 draftDetails / selectedByNote / printingByNote / deletingByNote 残留 key。
      for (const k of Object.keys(draftDetails)) delete draftDetails[k]
      for (const k of Object.keys(selectedByNote)) delete selectedByNote[k]
      for (const k of Object.keys(printingByNote)) delete printingByNote[k]
      for (const k of Object.keys(deletingByNote)) delete deletingByNote[k]
      foldedComputeds.clear()
      return
    }
    draftsLoading.value = true
    try {
      const resp = await listNotes({
        statuses: ['DRAFT'],
        customer_id: l1Id,
        limit: 200,
      })
      const next: Record<string, ScanNoteSummary> = {}
      for (const n of resp.items) {
        // 防御性前端过滤：listNotes 已带 statuses=['DRAFT'] 查询参数，但若后端未
        // 严格按 status 过滤，已提交件会跟着回来。本地再筛一次确保 UI 只显示草稿。
        // 2026-08-23：用户报告退出页面再回到扫码建单后，已提交的草稿又出现。
        if (n.status !== 'DRAFT') continue
        // DeliveryNoteOut ⊃ ScanNoteSummary 字段（除 scope/scope_label/recent_items 外）；
        // 补齐这三个字段后直接当 ScanNoteSummary 用。
        next[n.id] = {
          ...n,
          scope: 'L1_WIDE',
          scope_label: '按一级客户',
          recent_items: [],
        }
      }
      drafts.value = next

      // 清掉旧 key（残留可能因 listNotes 限 200 不再返回）
      for (const k of Object.keys(draftDetails)) {
        if (!(k in next)) delete draftDetails[k]
      }
      for (const k of Object.keys(selectedByNote)) {
        if (!(k in next)) delete selectedByNote[k]
      }
      for (const k of Object.keys(printingByNote)) {
        if (!(k in next)) delete printingByNote[k]
      }
      for (const k of Object.keys(deletingByNote)) {
        if (!(k in next)) delete deletingByNote[k]
      }
      // 同步清掉 foldedComputeds 里的 stale key（避免残留 computed 持有旧 draftDetails 引用）
      for (const k of Array.from(foldedComputeds.keys())) {
        if (!(k in next)) foldedComputeds.delete(k)
      }

      const items = resp.items
      // 2026-08-24：后端 PR3 上线 /batch-detail 后改用单次批量调用；detailCache
      // 已缓存的 note 跳过远程请求，结果集按 items 入参顺序对齐。
      const uncachedIds = items.filter((d) => !detailCache.peek(d.id)).map((d) => d.id)
      if (uncachedIds.length > 0) {
        const fetched = await batchGetNotes(uncachedIds)
        for (const det of fetched) detailCache.put(det.id, det)
      }
      const detailResults = items.map((d) => detailCache.peek(d.id))
      for (let i = 0; i < items.length; i += 1) {
        const header = items[i]
        const detail = detailResults[i]
        if (detail) {
          draftDetails[header.id] = detail.line_items
          // 同步乐观锁 version 到 drafts（listNotes 已含 version 字段，getNote 是更新源）
          drafts.value[header.id] = { ...drafts.value[header.id], version: detail.version }
        } else {
          // 失败兜底：空数组，el-table 渲染空态
          if (!(header.id in draftDetails)) draftDetails[header.id] = []
        }
      }
    } catch (e) {
      ElMessage.error((e as Error).message ?? '加载草稿列表失败')
    } finally {
      draftsLoading.value = false
    }
  }

  /**
   * 拉单个 note 的 line_items 并写回 draftDetails（扫码命中后立即刷新）。
   * 失败 toast warning 但不阻塞主流程（applySuccess 已先 toast ADDED/ALREADY_PRESENT）。
   */
  async function refreshDraftDetail(noteId: string): Promise<void> {
    // 2026-08-24：强制 invalidate 后重拉，避免命中「旧缓存 + 新后端数据」的不一致窗口。
    detailCache.invalidate(noteId)
    try {
      const detail = await detailCache.get(noteId, getNote)
      if (!detail) throw new Error('详情拉取失败')
      draftDetails[noteId] = detail.line_items
      // 同步乐观锁 version 到 drafts（getNote 返回的最新 version）
      if (drafts.value[noteId]) {
        drafts.value[noteId] = { ...drafts.value[noteId], version: detail.version }
      }
    } catch (e) {
      ElMessage.warning(`刷新 ${noteId} 详情失败：${(e as Error).message ?? '未知错误'}`)
    }
  }

  /**
   * 扫码命中：把 out.note 写入 drafts Map（按 id 替换为后端最新）；
   * useDeliveryScanSubmission 调本函数；detail 刷新由 useDeliveryScanSubmission 单独触发。
   */
  function writeDraftFromScan(note: ScanNoteSummary): void {
    drafts.value = {
      ...drafts.value,
      [note.id]: note,
    }
  }

  /**
   * 移除：按 MergedDraftRow.batch_ids 全量删除对应 batch；成功后本地剔除这些
   * batch_id 触发的行，重新计算 foldBySerial；并 unmark localStorage 记录避免脏绿底。
   *
   * - 调用后端 removeParts 时取当前 d.version 作乐观锁。
   * - 后端返回最新 DeliveryNoteDetailOut（接口约定），同步覆盖 draftDetails 与 drafts.version。
   */
  async function onRemove(d: ScanNoteSummary, row: MergedDraftRow): Promise<void> {
    const noteId = d.id
    try {
      const updated = await removeParts(noteId, {
        batch_ids: row.batch_ids,
        version: d.version,
      })
      draftDetails[noteId] = updated.line_items
      drafts.value[noteId] = { ...drafts.value[noteId], version: updated.version }
      // 2026-08-24：mutation 已返最新 detail → 直接 put 缓存，避免下次再 get 时多打一次后端
      detailCache.put(noteId, updated)
      printedLabelStore.unmark(noteId, row.batch_ids)
      // 该表可能折叠行被剔除 → 清掉选中
      if (selectedByNote[noteId]) {
        selectedByNote[noteId] = selectedByNote[noteId].filter(
          (r) => r.batch_ids.some((b) => row.batch_ids.includes(b)) === false,
        )
      }
      ElMessage.success('已移除')
    } catch (e) {
      ElMessage.error((e as Error).message ?? '移除失败')
    }
  }

  /**
   * 打印标签：把 selectedByNote 展平为 line_item_ids → 调 printNoteLabels → 浏览器下载 →
   * 写入 localStorage → 清空选中 → success toast。
   */
  async function onPrintLabels(d: ScanNoteSummary): Promise<void> {
    const noteId = d.id
    const rows = selectedByNote[noteId] ?? []
    if (rows.length === 0) return
    const lineItemIds: string[] = []
    for (const r of rows) lineItemIds.push(...r.batch_ids)
    if (lineItemIds.length === 0) return

    printingByNote[noteId] = true
    try {
      const { blob, filename } = await printNoteLabels(noteId, {
        line_item_ids: lineItemIds,
      })
      triggerBrowserDownload(blob, filename)
      printedLabelStore.markPrinted(noteId, lineItemIds)
      // foldBySerial 在模板里每次访问都重算，store 是响应式 ref → isPrintedBatch
      // 立刻返回新值 → 模板自动刷新绿底。
      // 显式清掉 el-table 内部勾选态（emit selection-change([]) → onSelectionChange
      // 顺势把 selectedByNote 置空；下一行 selectedByNote[noteId] = [] 为双保险）。
      tableRefs.get(noteId)?.clearSelection()
      selectedByNote[noteId] = []
      ElMessage.success('已导出标签')
    } catch (e) {
      ElMessage.error((e as Error).message ?? '打印标签失败')
    } finally {
      printingByNote[noteId] = false
    }
  }

  /**
   * 删除草稿：二次确认 → 调 softDeleteNote → 本地清掉所有相关 ref + localStorage。
   *
   * - 取 d.version 作乐观锁（reloadDrafts 时同步过，与 detail.version 一致）；
   * - printedLabelStore.unmark 全量清掉该 note 的所有 batch 记录，避免死 key。
   * - 失败 toast，按钮恢复可点。
   */
  async function onDeleteDraft(d: ScanNoteSummary): Promise<void> {
    try {
      await ElMessageBox.confirm(
        `确认删除草稿 ${d.delivery_note_no}？关联零件会解除。`,
        '删除草稿',
        { type: 'warning', confirmButtonText: '确认删除', cancelButtonText: '取消' },
      )
    } catch {
      return
    }
    const noteId = d.id
    deletingByNote[noteId] = true
    try {
      await softDeleteNote(noteId, { version: d.version })
      // 2026-08-24：note 已从后端软删 → 失效缓存，防止之后误打开（同一会话内 hash 复用场景）
      detailCache.invalidate(noteId)
      clearNoteLocalState(noteId)
      // 清掉 localStorage 里该 note 的所有 batch 记录
      printedLabelStore.unmark(noteId, Object.keys(printedLabelStore.store.value[noteId] ?? {}))
      ElMessage.success('草稿已删除')
    } catch (e) {
      ElMessage.error((e as Error).message ?? '删除草稿失败')
    } finally {
      deletingByNote[noteId] = false
    }
  }

  /**
   * 清掉某 note 的全部本地 ref / table ref / foldedComputed；doSubmit 后由
   * useDeliveryScanSubmission 通过 options.onDraftRemoved 触发。
   */
  function clearNoteLocalState(noteId: string): void {
    delete drafts.value[noteId]
    delete draftDetails[noteId]
    delete selectedByNote[noteId]
    delete printingByNote[noteId]
    delete deletingByNote[noteId]
    foldedComputeds.delete(noteId)
    tableRefs.delete(noteId)
  }

  return {
    // refs
    drafts: drafts as Ref<Record<string, ScanNoteSummary>>,
    draftDetails,
    draftsLoading,
    draftsCount,
    selectedByNote,
    printingByNote,
    deletingByNote,

    // functions
    setTableRef,
    foldedRows,
    rowClassName,
    onSelectionChange,
    hasSelection,
    getSelectionSize,
    reloadDrafts,
    refreshDraftDetail,
    writeDraftFromScan,
    onRemove,
    onPrintLabels,
    onDeleteDraft,
    clearNoteLocalState,
  }
}
