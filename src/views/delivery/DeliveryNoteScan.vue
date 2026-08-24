<script setup lang="ts">
// DeliveryNoteScan — 扫码建单页面（v3；2026-08-23 重构）。
//
// 2026-08-23 调整（计划文件 §前端实现要点）：
//   - 移除中间的「扫码输入」卡片 —— 纯靠扫码枪订阅，不再提供手动输入 UI。
//   - 分组卡片改 flex 布局（每行最多 4 个，窄屏自适应 2 列）。
//   - 草稿卡片 body 改为 el-table；同 serial_no 的多 batch 折叠为一行。
//   - 草稿卡片 footer 加「打印标签」按钮；下载 XLSX 后用 localStorage 记录
//     已打印的 batch id（usePrintedLabels 模块级 composable 单例），
//     已打印的行在表格里以浅绿底渲染。
//
// 2026-08-23 增量（L1 持久化 + 扫码阻塞确认 + footer 加打印送货单 / 提交草稿）：
//   - l1CustomerId 持久化到 localStorage（useDeliveryScanState 单例）；
//     切换 L1 由 setL1CustomerId 写入，再次进入页面 init 从 storage 恢复。
//   - 21418 / 21405 错误分流到 BlockedScanConfirmDialog：列失败件 → 一键
//     通过品检 → 重扫原 code；冲突类「on note DN-」按原 ElMessage.error 兜底。
//   - footer 4 按钮等宽：删除草稿 / 打印送货单 / 打印标签 / 提交草稿；
//     提交草稿先检查 line_items.status，未送检件触发 BatchInspectionConfirmDialog。
//   - 21403 BIZ_VERSION_CONFLICT → 提示并刷新 detail 让 version 同步，
//     与 DeliveryNoteDetail.vue:99 路径对齐。
//
// 仍保留：
//   - useBarcodeScanner 扫码枪订阅 → handleScan → scanDelivery（后端 find-or-create）。
//   - DeliveryGroupEditor dialog：分组 CRUD 面板。
//   - applySuccess 同步刷新 draftDetails（扫码命中后立即把最新 line_items 拉回）。
//
// 设计要点：
//   - draftDetails 按 note_id 存完整 line_items；foldBySerial 在前端做按
//     serial_no 的合并展示（不破坏后端语义，只换渲染）。
//   - selectedByNote / printingByNote 按 note_id 各自维护 —— el-table 的
//     `@selection-change` 在每张表上独立挂回调；按钮的 disabled / loading
//     也按 note 维度切换。

import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  watch,
  type ComputedRef,
} from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useBarcodeScanner } from '@/composables/useBarcodeScanner'
import { usePrintedLabels } from '@/composables/usePrintedLabels'
import { useDeliveryScanState } from '@/composables/useDeliveryScanState'
import { useDeliveryNoteDetailCache } from '@/composables/useDeliveryNoteDetailCache'
import {
  batchGetNotes,
  getNote,
  listNotes,
  printNoteLabels,
  removeParts,
  scanDelivery,
  softDeleteNote,
  submitNote,
} from '@/api/deliveryNote'
import { listCustomers, type Customer } from '@/api/customer'
import {
  createDeliveryGroup,
  listDeliveryGroups,
  softDeleteDeliveryGroup,
  updateDeliveryGroup,
} from '@/api/deliveryGroup'
import { ApiError } from '@/api/http'
import { useAuthSession } from '@/composables/useAuthSession'
import { canPrint } from '@/utils/deliveryNotePermissions'
import { triggerBrowserDownload } from '@/utils/download'
import type {
  BlockedScanItem,
  DeliveryNoteDetailOut,
  DeliveryNoteLineItem,
  ScanDeliveryOut,
  ScanNoteSummary,
} from '@/types/deliveryNote'
import { BLOCK_SCAN_CODES } from '@/types/deliveryNote'
import type { DeliveryGroupListOut, DeliveryGroupOut } from '@/types/deliveryGroup'
import type { BulkPassFailure, BulkPassItem } from '@/composables/useBulkPassInspection'
import DeliveryGroupEditor from '@/views/delivery/components/DeliveryGroupEditor.vue'
import BlockedScanConfirmDialog from '@/components/delivery/BlockedScanConfirmDialog.vue'
import BatchInspectionConfirmDialog from '@/components/delivery/BatchInspectionConfirmDialog.vue'
import PrintPreviewDialog from '@/components/delivery/PrintPreviewDialog.vue'

const router = useRouter()

// ============ 扫码防抖态 ============
/** 1.5s 同码防抖：双击 Enter / 扫码枪连扫容错（设计文档 §5 防抖策略）。 */
const lastScanCode = ref('')
const lastScanAt = ref(0)
/** 当前扫码 inflight 标记（handleScan 重入保护）。 */
const scanning = ref(false)

// ============ L1 / 客户全集 ============
/**
 * 当前选中的 L1 客户 id；持久化到 localStorage（useDeliveryScanState 单例）。
 * 写用 setL1CustomerId；onMounted 由 init 从 storage 恢复。
 */
const scanState = useDeliveryScanState()
/** 详情缓存（2026-08-24 接入）：同一 noteId 在一次会话内多次 getNote 复用同一结果。 */
const detailCache = useDeliveryNoteDetailCache()
/** 全量客户列表（listCustomers() 返回平铺）。 */
const allCustomers = ref<Customer[]>([])
/** 一级客户全集（parent_id === null）。 */
const rootCustomers = computed<Customer[]>(() =>
  allCustomers.value.filter((c) => c.parent_id === null),
)
/** 当前 L1 下的 L2 客户全集（分组编辑器用）。 */
const allL2Customers = computed<Customer[]>(() => {
  if (!scanState.l1CustomerId.value) return []
  return allCustomers.value.filter((c) => c.parent_id === scanState.l1CustomerId.value)
})

// ============ 分组态 ============
const groups = ref<DeliveryGroupListOut>({ groups: [], ungrouped_customers: [] })
const groupsLoading = ref(false)
/** 编辑 dialog 状态：null=关闭；带 initial=编辑；initial=undefined=新建。 */
const editorOpen = ref(false)
const editingGroup = ref<DeliveryGroupOut | null>(null)

// ============ 草稿态 ============
/** 当前 L1 下所有 DRAFT 草稿（key = note_id）—— header 摘要。 */
const drafts = ref<Record<string, ScanNoteSummary>>({})
/** 每个草稿的完整 line_items（按 note_id 存），el-table 数据源。 */
const draftDetails = reactive<Record<string, DeliveryNoteLineItem[]>>({})
const draftsLoading = ref(false)
const draftsCount = computed(() => Object.keys(drafts.value).length)

/** 每张草稿卡片各自的勾选行（用于「打印标签」按钮）。 */
const selectedByNote = reactive<Record<string, MergedDraftRow[]>>({})
/** 每张草稿卡片各自的打印中 loading 态。 */
const printingByNote = reactive<Record<string, boolean>>({})
/** 每张草稿卡片各自的删除中 loading 态。 */
const deletingByNote = reactive<Record<string, boolean>>({})
/** 每张草稿卡片各自的提交中 loading 态。 */
const submittingByNote = reactive<Record<string, boolean>>({})

/**
 * 每张草稿卡片各自的 el-table 实例 ref；打印成功后显式调 clearSelection()
 * 触发 EP 自身的 selection-change → onSelectionChange 顺势清空 selectedByNote，
 * 避免依赖 markPrinted → folded computed 重算这条隐式链路。
 */
const tableRefs = new Map<string, { clearSelection: () => void }>()
function setTableRef(noteId: string, el: any): void {
  if (el) tableRefs.set(noteId, el as { clearSelection: () => void })
  else tableRefs.delete(noteId)
}

// ============ 打印状态（localStorage 单例）==============
const printedLabelStore = usePrintedLabels()

// ============ 账号权限（canPrint 用 RoleMapLike）==============
/**
 * CurrentUser.roles 是 string[]，deliveryNotePermissions.canPrint 接受
 * RoleMapLike（boolean 字段）；把数组转成对象形式供按钮 disabled 用。
 */
const auth = useAuthSession()
const roleMap = computed<{ MANAGER?: boolean; CLERK?: boolean; INSPECTOR?: boolean }>(() => {
  const r = auth.user.value?.roles ?? []
  return {
    MANAGER: r.includes('MANAGER'),
    CLERK: r.includes('CLERK'),
    INSPECTOR: r.includes('INSPECTOR'),
  }
})

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

/**
 * 每张草稿卡片各自的 el-table 实例 ref；打印成功后显式调 clearSelection()
 * 触发 EP 自身的 selection-change → onSelectionChange 顺势清空 selectedByNote，
 * 避免依赖 markPrinted → folded computed 重算这条隐式链路。
 */
// ============ 合并行模型 ============
/** el-table 一行 = 同 serial_no 折叠后的若干 batch；serial 为 null 时按 id 各占一行。 */
interface MergedDraftRow {
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

// ============ 折叠函数 ============
/**
 * 同 serial_no 多 batch 折叠为一行（参考 PrintPreviewDialog.vue:91 foldSamePart，
 * 但分组 key 从 part_id 换成 serial_no）。
 *
 * 规则：
 *   - serial_no 为非 null：按 serial 字符串聚合；quantity 求和；system_delivery_date
 *     取首个非空；label_printed = 任一 batch 已打印。
 *   - serial_no 为 null：每个 batch 单独一行，key = `__null_<id>`。
 */
function foldBySerial(items: DeliveryNoteLineItem[]): MergedDraftRow[] {
  const groups = new Map<string, MergedDraftRow>()
  const order: string[] = []
  for (const li of items) {
    const key = li.serial_no ?? `__null_${li.id}`
    const existing = groups.get(key)
    const printed = printedLabelStore.isPrintedBatch(String(li.id))
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

// ============ 折叠数据缓存（per-note computed；保 data 引用稳定）==============
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
function foldedRows(noteId: string): MergedDraftRow[] {
  let c = foldedComputeds.get(noteId)
  if (!c) {
    c = computed(() => foldBySerial(draftDetails[noteId] ?? []))
    foldedComputeds.set(noteId, c)
  }
  return c.value
}

const { onScan } = useBarcodeScanner()
let unsubScan: (() => void) | null = null

// ============ 数据加载 ============

/** 拉全量客户（onMounted 调一次即可）。 */
async function loadAllCustomers(): Promise<void> {
  try {
    allCustomers.value = await listCustomers()
  } catch (e) {
    ElMessage.error((e as Error).message ?? '加载客户列表失败')
  }
}

/** 拉当前 L1 下的分组 + 未分组 L2。 */
async function reloadGroups(l1Id: string): Promise<void> {
  if (!l1Id) {
    groups.value = { groups: [], ungrouped_customers: [] }
    return
  }
  groupsLoading.value = true
  try {
    groups.value = await listDeliveryGroups(l1Id)
  } catch (e) {
    ElMessage.error((e as Error).message ?? '加载分组规则失败')
  } finally {
    groupsLoading.value = false
  }
}

/**
 * 拉当前 L1 下所有 DRAFT 草稿 + 各草稿的完整 line_items。
 *
 * 两步：
 *   1) listNotes 拿 header（statuses=DRAFT, customer_id=l1, limit=200）；
 *   2) 对每个 header 并发 getNote(d.id)，拿到完整 DeliveryNoteDetailOut.line_items。
 *
 * 任一 getNote 失败 → catch(()=null) 跳过；对应的草稿卡片展示空表（不阻断其他）。
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
  drafts.value = {
    ...drafts.value,
    [out.note.id]: out.note,
  }
  // 详情同步：失败仅 toast warning，不阻塞主流程的 success 提示。
  void refreshDraftDetail(out.note.id).catch(() => {
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
 *
 * 这是 best-effort：21405 阻塞弹窗本来价值有限（一键 passInspection 需要
 * part_id，后端扩展后才完整可用）。后端扩展后可移除此 fallback。
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

// ============ 分组面板：CRUD ============

function openNewGroup(): void {
  editingGroup.value = null
  editorOpen.value = true
}

function openEditGroup(g: DeliveryGroupOut): void {
  editingGroup.value = g
  editorOpen.value = true
}

async function onGroupEditorSubmit(payload: {
  name: string
  member_customer_ids: string[]
}): Promise<void> {
  if (!scanState.l1CustomerId.value) return
  const initial = editingGroup.value
  try {
    if (initial) {
      await updateDeliveryGroup(initial.id, {
        version: initial.version,
        name: payload.name,
        member_customer_ids: payload.member_customer_ids,
      })
      ElMessage.success('分组已更新')
    } else {
      await createDeliveryGroup({
        customer_id: scanState.l1CustomerId.value,
        name: payload.name,
        member_customer_ids: payload.member_customer_ids,
      })
      ElMessage.success('分组已创建')
    }
    editorOpen.value = false
    editingGroup.value = null
    await reloadGroups(scanState.l1CustomerId.value)
  } catch (e) {
    ElMessage.error((e as Error).message ?? '保存分组失败')
  }
}

async function onDeleteGroup(g: DeliveryGroupOut): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `确认删除分组「${g.name}」？该分组下的 DRAFT 草稿将不再路由。`,
      '删除分组',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  try {
    await softDeleteDeliveryGroup(g.id, { version: g.version })
    ElMessage.success('分组已删除')
    await reloadGroups(scanState.l1CustomerId.value)
  } catch (e) {
    ElMessage.error((e as Error).message ?? '删除分组失败')
  }
}

// ============ 草稿卡片：行操作 ============

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
    delete drafts.value[noteId]
    delete draftDetails[noteId]
    delete selectedByNote[noteId]
    delete printingByNote[noteId]
    delete deletingByNote[noteId]
    foldedComputeds.delete(noteId)
    tableRefs.delete(noteId)
    // 清掉 localStorage 里该 note 的所有 batch 记录
    printedLabelStore.unmark(noteId, Object.keys(printedLabelStore.store.value[noteId] ?? {}))
    ElMessage.success('草稿已删除')
  } catch (e) {
    ElMessage.error((e as Error).message ?? '删除草稿失败')
  } finally {
    deletingByNote[noteId] = false
  }
}

// ============ 打印送货单 + 提交草稿（2026-08-23 增量 footer 按钮）==============

/**
 * 「打印送货单」按钮可用条件：复用 deliveryNotePermissions.canPrint
 * （角色 + 至少 1 个零件）。
 *
 * ScanNoteSummary.part_count 是后端返的零件数（设计文档 §5.7.note）；
 * 兜底用 recent_items.length（D2 兼容早先实现）。
 */
function canPrintNote(d: ScanNoteSummary): boolean {
  const partCount = (d as { part_count?: number }).part_count ?? d.recent_items.length
  return canPrint(roleMap.value, partCount)
}

/** 「提交草稿」按钮：状态 = DRAFT 才允许；其他状态（如 SUBMITTED）禁用。 */
function canSubmitDraft(d: ScanNoteSummary): boolean {
  return d.status === 'DRAFT'
}

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
  // 同步最新 version（避免 reloadDrafts 与此处 getNote 之间再次改动）
  if (drafts.value[d.id]) {
    drafts.value[d.id] = { ...drafts.value[d.id], version: detail.version }
  }
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
    // 本地清掉所有相关 ref + computed + table ref
    delete drafts.value[noteId]
    delete draftDetails[noteId]
    delete selectedByNote[noteId]
    delete printingByNote[noteId]
    delete deletingByNote[noteId]
    delete submittingByNote[noteId]
    foldedComputeds.delete(noteId)
    tableRefs.delete(noteId)
    printedLabelStore.unmark(noteId, Object.keys(printedLabelStore.store.value[noteId] ?? {}))
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
      void refreshDraftDetail(target.id).catch(() => { /* 已 toast */ })
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
    void refreshDraftDetail(submitTarget.value.id).catch(() => { /* 已 toast */ })
  }
}

function onSubmitDialogCancel(): void {
  submitDialogVisible.value = false
}

// ============ 卡片跳转 ============

function gotoDetail(draft: ScanNoteSummary): void {
  void router.push(`/delivery-notes/${draft.id}`)
}

function gotoAllDrafts(): void {
  if (!scanState.l1CustomerId.value) return
  void router.push({
    path: '/delivery-notes',
    query: { statuses: 'DRAFT', customer_id: scanState.l1CustomerId.value },
  })
}

// ============ 生命周期 ============

onMounted(async () => {
  // L1 持久化恢复：单例扫描整个页面载入后从 localStorage 读回；只触发一次
  scanState.init()
  // 扫码枪订阅：每页独立挂载；卸载时退订避免劫持到其他页
  unsubScan = onScan((code) => { void handleScan(code) })
  // 拉客户全集
  await loadAllCustomers()
})

/**
 * L1 变化（init 从 localStorage 恢复 / 用户切换 el-select）→ 重拉分组 + 草稿 + 关掉打开中的 editor。
 *
 * 用 immediate: true 处理「重入页面时 watch 不会 fire 已有值」的问题：
 * useDeliveryScanState 是模块级单例，_l1CustomerId 在页面间共享。
 * 重新进入页面时值已持久为「法拉电子」等，普通 watch 不会触发，
 * 但 immediate 会在 setup 阶段 fire 一次，确保 reloadGroups + reloadDrafts 执行。
 */
watch(
  scanState.l1CustomerId,
  async (id) => {
    if (!id) return
    editorOpen.value = false
    editingGroup.value = null
    await Promise.all([reloadGroups(id), reloadDrafts(id)])
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  unsubScan?.()
  unsubScan = null
})
</script>

<template>
  <div class="page">
    <!-- ========== 顶部：分组规则面板 ========== -->
    <el-card shadow="never" v-loading="groupsLoading">
      <template #header>
        <div class="card-header-row">
          <span class="dn-scan-card-title">分组规则</span>
          <el-button
            type="primary"
            link
            :disabled="!scanState.l1CustomerId.value"
            @click="openNewGroup"
          >
            + 新增分组
          </el-button>
        </div>
      </template>

      <div class="filter-row">
        <span class="filter-label">一级客户</span>
        <el-select
          :model-value="scanState.l1CustomerId.value"
          placeholder="先选一级客户"
          filterable
          clearable
          style="width: 280px"
          @update:model-value="(v: string) => scanState.setL1CustomerId(v)"
        >
          <el-option
            v-for="c in rootCustomers"
            :key="c.id"
            :label="c.name"
            :value="c.id"
          />
        </el-select>
      </div>

      <template v-if="scanState.l1CustomerId.value">
        <el-empty
          v-if="groups.groups.length === 0 && groups.ungrouped_customers.length === 0"
          description="该一级客户下还没有 L2 客户"
          :image-size="80"
        />
        <template v-else>
          <div class="groups-grid">
            <div
              v-for="g in groups.groups"
              :key="g.id"
              class="group-row"
            >
              <div class="group-row-main">
                <span class="group-name">{{ g.name }}</span>
                <div class="group-members">
                  <el-tag
                    v-for="m in g.members"
                    :key="m.customer_id"
                    size="small"
                    effect="plain"
                    type="info"
                  >
                    {{ m.customer_name }}
                  </el-tag>
                  <span v-if="g.members.length === 0" class="muted">（无成员）</span>
                </div>
              </div>
              <div class="group-row-actions">
                <el-button link size="small" type="primary" @click="openEditGroup(g)">
                  编辑
                </el-button>
                <el-button link size="small" type="danger" @click="onDeleteGroup(g)">
                  删除
                </el-button>
              </div>
            </div>

            <div
              v-if="groups.ungrouped_customers.length > 0"
              class="group-row ungrouped-row"
            >
              <div class="group-row-main">
                <span class="group-name muted">未分组 L2</span>
                <div class="group-members">
                  <el-tag
                    v-for="u in groups.ungrouped_customers"
                    :key="u.id"
                    size="small"
                    effect="plain"
                  >
                    {{ u.name }}
                  </el-tag>
                </div>
              </div>
              <div class="group-row-actions">
                <span class="muted small">{{ groups.ungrouped_customers.length }} 个</span>
              </div>
            </div>
          </div>
        </template>
      </template>
      <el-empty
        v-else
        description="先选一级客户，加载分组规则"
        :image-size="80"
      />
    </el-card>

    <!-- ========== 底部：草稿卡片列表 ========== -->
    <div class="drafts-section" v-loading="draftsLoading">
      <div class="drafts-header">
        <span class="dn-scan-card-title">当前草稿（{{ draftsCount }}）</span>
        <el-button
          v-if="draftsCount > 0"
          link
          type="primary"
          @click="gotoAllDrafts"
        >
          查看全部 →
        </el-button>
      </div>

      <el-empty
        v-if="draftsCount === 0"
        description="暂无草稿 — 扫码枪扫码开始建单"
        :image-size="80"
      />
      <div v-else class="drafts-grid">
        <el-card
          v-for="d in drafts"
          :key="d.id"
          shadow="hover"
          class="draft-card"
        >
          <template #header>
            <div class="draft-card-head" @click="gotoDetail(d)">
              <span class="draft-no draft-no-link">{{ d.delivery_note_no }}</span>
              <el-tag size="small" type="info" effect="plain">
                {{ d.scope_label }}
              </el-tag>
            </div>
          </template>
          <div class="draft-card-body">
            <div class="draft-customer">{{ d.customer_path || '—' }}</div>
            <el-table
              :ref="(el: any) => setTableRef(d.id, el)"
              :data="foldedRows(d.id)"
              :row-key="(row: MergedDraftRow) => row.batch_ids[0]"
              :row-class-name="rowClassName"
              height="240"
              size="small"
              empty-text="暂无加入批次 — 扫码加入"
              @selection-change="(rows: MergedDraftRow[]) => onSelectionChange(d.id, rows)"
            >
              <el-table-column type="selection" width="44" fixed />
              <el-table-column label="序列号" min-width="100">
                <template #default="{ row }">
                  <span :class="{ muted: !row.serial_no }">{{ row.serial_no || '—' }}</span>
                </template>
              </el-table-column>
              <el-table-column
                prop="name"
                label="名称"
                min-width="110"
                show-overflow-tooltip
              />
              <el-table-column
                prop="quantity"
                label="数量"
                width="60"
                align="right"
              />
              <el-table-column label="系统交期" width="90" align="center">
                <template #default="{ row }">
                  {{ row.system_delivery_date || '—' }}
                </template>
              </el-table-column>
              <el-table-column label="" width="56" align="center">
                <template #default="{ row }">
                  <el-button link size="small" type="danger" @click="onRemove(d, row as MergedDraftRow)">
                    移除
                  </el-button>
                </template>
              </el-table-column>
            </el-table>
          </div>
          <template #footer>
            <!--
              2026-08-23：4 按钮等宽（footer-btn flex:1）。
              删除草稿 / 打印送货单 / 打印标签 / 提交草稿。
            -->
            <div class="draft-card-footer">
              <el-button
                type="danger"
                plain
                class="footer-btn"
                :loading="deletingByNote[d.id]"
                @click="onDeleteDraft(d)"
              >
                <el-icon><Delete /></el-icon>
                删除草稿
              </el-button>
              <el-button
                type="success"
                plain
                class="footer-btn"
                :disabled="!canPrintNote(d)"
                @click="openPrintNote(d)"
              >
                <el-icon><Printer /></el-icon>
                打印送货单
              </el-button>
              <el-button
                type="success"
                plain
                class="footer-btn"
                :disabled="!hasSelection(d.id)"
                :loading="printingByNote[d.id]"
                @click="onPrintLabels(d)"
              >
                <el-icon><Printer /></el-icon>
                打印标签{{ hasSelection(d.id) ? `（${getSelectionSize(d.id)}）` : '' }}
              </el-button>
              <el-button
                type="primary"
                class="footer-btn"
                :disabled="!canSubmitDraft(d)"
                :loading="submittingByNote[d.id]"
                @click="onSubmitDraft(d)"
              >
                提交草稿
              </el-button>
            </div>
          </template>
        </el-card>
      </div>
    </div>

    <!-- ========== 扫码阻塞确认对话框（2026-08-23） ========== -->
    <BlockedScanConfirmDialog
      v-model="blockedDialogVisible"
      :failures="blockedFailures"
      :reason="blockedReason"
      :original-code="blockedOriginalCode"
      @pass-success="onBlockedPassSuccess"
      @pass-partial="onBlockedPassPartial"
      @cancel="onBlockedCancel"
    />

    <!-- ========== 打印送货单预览（2026-08-23） ========== -->
    <!--
      v-if 保持：note=null 时（getNote 加载中）不渲染 dialog。openPrintNote
      等 detail 拉回后再开 dialog，避免 PrintPreviewDialog 在 note=null 时
      初始化空表格。
    -->
    <PrintPreviewDialog
      v-if="printNotePreviewVisible && printNoteTarget"
      v-model="printNotePreviewVisible"
      :note="printNoteTarget"
      mode="note"
    />

    <!-- ========== 提交前未送检确认（2026-08-23） ========== -->
    <BatchInspectionConfirmDialog
      v-model="submitDialogVisible"
      :uninspected-items="submitUninspected"
      :note-id="submitTarget?.id ?? ''"
      :note-version="submitTarget?.version ?? 0"
      source="submit"
      @pass-success="onSubmitDialogPassSuccess"
      @pass-partial="onSubmitDialogPassPartial"
      @cancel="onSubmitDialogCancel"
    />

    <!-- ========== 分组编辑器 dialog ========== -->
    <DeliveryGroupEditor
      v-if="editorOpen"
      :l1-id="scanState.l1CustomerId.value"
      :initial="editingGroup"
      :all-l2-customers="allL2Customers"
      @submit="onGroupEditorSubmit"
      @cancel="editorOpen = false"
    />
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.dn-scan-card-title {
  font-weight: 600;
  color: var(--text-primary, #303133);
}

/* ============ 分组规则面板 ============ */
.card-header-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.filter-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}
.filter-label {
  color: var(--el-text-color-regular);
  min-width: 64px;
}

/* 分组卡片：每行最多 4 个，窄屏自动 2 列 */
.groups-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}
.group-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  padding: 10px 14px;
  background: var(--primary-bg, #eaf2fb);
  border: 1px solid #d9ecff;
  border-radius: 6px;
  flex: 0 0 calc(25% - 9px);
  box-sizing: border-box;
}
.group-row-main {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  flex: 1;
}
.group-row-actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
  align-items: center;
}
.group-name {
  font-weight: 600;
  color: var(--text-primary, #303133);
}
.group-members {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.ungrouped-row {
  background: var(--el-fill-color-light);
  border-style: dashed;
}
.ungrouped-row .small {
  font-size: 12px;
}

@media (max-width: 1200px) {
  .group-row {
    flex: 0 0 calc(50% - 6px);
  }
}

/* ============ 草稿卡片列表 ============ */
.drafts-section {
  background: #fff;
  border-radius: 4px;
  padding: 12px 16px;
  border: 1px solid var(--el-border-color-lighter);
}
.drafts-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
/* 草稿卡片：每行 2 张，每张 50% 宽，避免横向滚动 + 表格完整可见。 */
.drafts-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}
.draft-card {
  flex: 0 0 calc(50% - 6px);
  box-sizing: border-box;
  min-width: 0;
}
.draft-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  cursor: pointer;
}
.draft-no {
  font-family: 'SF Mono', Menlo, Consolas, monospace;
  font-weight: 700;
  font-size: 15px;
  color: var(--text-primary, #303133);
}
.draft-no-link {
  text-decoration: underline;
  text-decoration-color: transparent;
  transition: text-decoration-color 120ms ease;
}
.draft-card-head:hover .draft-no-link {
  text-decoration-color: var(--el-color-primary);
}
.draft-customer {
  font-size: 13px;
  color: var(--el-text-color-regular);
  margin-bottom: 8px;
}
.draft-card-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

/* ============ 草稿卡片 footer：删除 + 打印 两个按钮等分居中 ============ */
.draft-card-footer {
  display: flex;
  gap: 8px;
}
.footer-btn {
  flex: 1;
}
:deep(.footer-btn .el-button__inner) {
  justify-content: center;
}

/* ============ 已打印行绿底（与 DeliveryNoteDetail.vue row-urgent 风格对齐） ============ */
:deep(.el-table__row.row-printed) > td.el-table__cell {
  background-color: #e6f7e6 !important;
}
:deep(.el-table__row.row-printed:hover > td.el-table__cell) {
  background-color: #d6efd6 !important;
}

.muted {
  color: var(--el-text-color-secondary);
}
</style>