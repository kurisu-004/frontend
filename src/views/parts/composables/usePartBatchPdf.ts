// Tab 2「PDF 批量上传」composable。
//
// 2026-08-25 拆分：原 PartBatchNew.vue 第 1605-2857 行的「PDF 上传 + 拆页 + 合并 + 提交」
// 整段抽到本文件 + PartBatchPdfTab.vue。

import { computed, nextTick, onBeforeUnmount, reactive, ref, watch, type Ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox, type UploadFile } from 'element-plus'
import Sortable from 'sortablejs'
import {
  batchCreatePartsWithPdfs,
  type PartBatchFilePayload,
  type PartBatchTreeAssemblyFE,
  type PartBatchTreeItemFE,
} from '@/api/parts'
import type { Customer } from '@/api/customer'
import { parseBidExcel, type BidRow, type ParseResult } from '@/utils/bidExcelParser'
import { parseHistoricalPriceExcel } from '@/utils/historicalPriceExcelParser'
import { parseDrawingFilename } from '@/utils/drawingFilename'
import { pdfjsLib } from '@/utils/pdfjs'
import {
  makeUid,
  pageUid,
  parsePageUid,
  stripExt,
  todayIso,
} from './usePartBatchShared'

interface PdfFormState {
  /** 一级客户 id（Tab 2 必选；决定 serial_prefix 来源 + 二级客户候选范围）。 */
  customerL1Id: string | null
  requestDate: string
}

/** 源文件区表格的树节点。多页 PDF 是父节点，子页是 children。 */
export interface SourceTreeRow {
  /** 顶层 = pdfSourceUid；子行 = `${pdfSourceUid}:p${pageIndex}`。 */
  id: string
  pdfSourceUid: string
  /** null = PDF 顶层；>=0 = 子页。 */
  pageIndex: number | null
  filename: string
  totalPages: number
  children?: SourceTreeRow[]
}

/** 一份「图纸源」：上传的原始 PDF 或前端合成的新 PDF。 */
export interface PdfSource {
  uid: string
  raw: Blob
  filename: string
  totalPages: number
  /** true = 由 pdf-lib 合并产生；false = 原 PDF。 */
  synthesized: boolean
  /** 合成来源（仅 synthesized=true）。 */
  synthesizedFrom?: { pdfUid: string; pageIndices: number[] }[]
  /** 原始 PDF 的 uid（合成时记录）。 */
  originPdfUid?: string
}

/** 独立零件表的一行。 */
export interface StandalonePartRow {
  uid: string
  pdfSourceUid: string
  pageCount: number
  /** 合成来源（仅 pageCount > 1）。 */
  mergedFrom?: { pdfUid: string; pageIndex: number }[]
  drawing_no: string
  name: string
  applicant_name: string
  customer_id: string  // 二级客户 id（L2 leaf）；后端 customer_id 校验需要叶子节点
  customer_name: string  // 显示用，提交时不发送
  request_date: string
  planned_delivery_date: string
  system_delivery_date: string | null
  order_no: string | null
  note: string | null
  is_urgent: boolean
  quantity: number
  /** PR-H 2026-07-28：含税单价（来自历史价确认单 G 列，可手动覆盖） */
  unit_price: number | null
  /** PR-H 2026-07-28：含税总价（来自历史价确认单 I 列；空时 = unit_price × quantity） */
  total_price: number | null
  /** PR-H 2026-07-28：3D 模型数组下标；null = 不挂 */
  three_d_index: number | null
}

/** 装配件子件。分厂 / 申请人由顶层 AssemblyRow 指定，提交时复制到每条 item。 */
export interface AssemblyChildRow {
  uid: string
  pdfSourceUid: string
  page_index: number
  drawing_no: string
  name: string
  quantity: number
  is_urgent: boolean
  request_date: string
  planned_delivery_date: string
  system_delivery_date: string | null
  order_no: string | null
  note: string | null
  /** PR-H 2026-07-28：含税单价（来自历史价确认单 G 列） */
  unit_price: number | null
  /** PR-H 2026-07-28：含税总价 */
  total_price: number | null
  /** PR-H 2026-07-28：3D 模型数组下标；null = 不挂 */
  three_d_index: number | null
}

/** 装配件顶层行。 */
export interface AssemblyRow {
  uid: string
  pdfSourceUid: string
  drawing_no: string
  name: string
  applicant_name: string
  customer_id: string  // 二级客户 id（L2 leaf）
  customer_name: string
  request_date: string
  planned_delivery_date: string
  system_delivery_date: string | null
  order_no: string | null
  note: string | null
  is_urgent: boolean
  masterPageIndex: number | null
  /** 装配体套数（默认 1）。2026-08-04 新增：用于背面页 Q: 打印 */
  quantity: number
  children: AssemblyChildRow[]
}

/** 弹窗内显示的 blob URL + 标题 + 起始页。blob URL 由 pdfFiles[i].raw →
 * URL.createObjectURL 生成；关闭弹窗或组件卸载时 revoke，避免内存泄漏。 */
export interface PdfPreviewState {
  url: string
  title: string
  page: number
}

export interface UsePartBatchPdfOptions {
  /** 客户全集（由 shell 加载并传入；两个 Tab 共用）。 */
  customers: Ref<Customer[]>
  /** 申请人搜索共享实例（shell 创建一次；两 Tab 共用 cache）。 */
  applicantSearch: {
    applicants: Ref<{ id: string; name: string }[]>
    loading: Ref<boolean>
    loadForCustomer: (pickedId: string | null) => Promise<void>
    querySearch: (queryString: string, cb: (items: { id: string; name: string }[]) => void) => void
  }
  /** 提交成功后切到哪个 tab（默认 'manual'）。由 shell 提供，避免硬编码路由跳转。 */
  successNextTab: Ref<string>
}

/**
 * Tab 2「PDF 批量上传」的全部 state + handler。返回值直接 `v-bind` 给 PartBatchPdfTab。
 */
export function usePartBatchPdf(opts: UsePartBatchPdfOptions) {
  const { customers, applicantSearch, successNextTab } = opts
  const router = useRouter()

  const pdfForm = reactive<PdfFormState>({
    customerL1Id: null,
    requestDate: todayIso(),
  })

  // PDF Tab 一级客户切换 → 拉一次该客户下申请人全集。
  // useApplicantSearch.loadForCustomer 内部对同一 rootCustomerId 不重拉；
  // 切换到空客户则清空缓存。immediate: false 避免首次 null 时多余调用。
  watch(
    () => pdfForm.customerL1Id,
    (next) => {
      void applicantSearch.loadForCustomer(next)
    },
    { immediate: false },
  )

  /** Tab 2 PDF 批量上传专用：仅展示一级客户。 */
  const l1Customers = computed(() =>
    customers.value
      .filter((c) => c.parent_id === null)
      .map((c) => ({ id: c.id, name: c.name })),
  )
  /** Tab 2 分厂下拉专用：所选 L1 的二级子客户。 */
  const l2Customers = computed(() =>
    pdfForm.customerL1Id
      ? customers.value
          .filter((c) => c.parent_id === pdfForm.customerL1Id)
          .map((c) => ({ id: c.id, name: c.name }))
      : [],
  )

  // PDF / Excel 文件列表（el-upload 控件绑定）
  const pdfFiles = ref<UploadFile[]>([])
  const excelFiles = ref<UploadFile[]>([])
  // PR-H 2026-07-28：3D 模型批量上传（.step / .stp / .iges / .igs / .stl / .obj / .3mf）
  const threeDModelFiles = ref<UploadFile[]>([])
  const pdfBuildingTree = ref(false)
  const pdfSubmitting = ref(false)

  const allPdfs = ref<PdfSource[]>([])
  /** 源文件区选中的页：key = `${pdfUid}:${pageIndex}`（pageIndex 0-based）。 */
  const selectedPages = ref<Set<string>>(new Set())
  const standaloneParts = ref<StandalonePartRow[]>([])
  const assemblies = ref<AssemblyRow[]>([])
  // PR-H 2026-07-28：拖拽排序 — 表格 DOM ref + Sortable 实例句柄
  const standaloneTableRef = ref<{ $el?: HTMLElement } | null>(null)
  const assembliesTableRef = ref<{ $el?: HTMLElement } | null>(null)
  let standaloneSortable: Sortable | null = null
  let assembliesSortable: Sortable | null = null

  /** 只用于源文件区表格展示的原始（未合成）PDF。 */
  const originalPdfs = computed(() => allPdfs.value.filter((s) => !s.synthesized))
  const totalAssemblyChildren = computed(() =>
    assemblies.value.reduce((sum, a) => sum + a.children.length, 0),
  )

  /** 源文件区树状数据：仅显示多页 PDF（单页 PDF 已直接进独立零件表）。
   *  多页 PDF → 1 父行 + N 子页。 */
  const sourceTree = computed<SourceTreeRow[]>(() =>
    originalPdfs.value
      .filter((src) => src.totalPages > 1)
      .map((src) => ({
        id: src.uid,
        pdfSourceUid: src.uid,
        pageIndex: null,
        filename: src.filename,
        totalPages: src.totalPages,
        children: Array.from({ length: src.totalPages }, (_, i) => ({
          id: `${src.uid}:p${i}`,
          pdfSourceUid: src.uid,
          pageIndex: i,
          filename: `${src.filename}（第 ${i + 1} 页）`,
          totalPages: src.totalPages,
        })),
      })),
  )

  // el-upload 钩子
  function onPdfChange(file: UploadFile): void {
    // 多文件上传会触发多次 on-change；用 fileList 状态自动管理
    pdfFiles.value = fileList(pdfFiles.value, file, '.pdf')
  }
  function onPdfRemove(file: UploadFile): void {
    pdfFiles.value = pdfFiles.value.filter((f) => f.uid !== file.uid)
  }
  function onExcelChange(file: UploadFile): void {
    excelFiles.value = fileList(excelFiles.value, file, '.xlsx,.xls', /*matchExt*/ true)
  }
  function onExcelRemove(file: UploadFile): void {
    excelFiles.value = excelFiles.value.filter((f) => f.uid !== file.uid)
  }
  // PR-H 2026-07-28：3D 模型上传钩子
  function onThreeDModelChange(file: UploadFile): void {
    threeDModelFiles.value = fileList(threeDModelFiles.value, file, '.step,.stp,.iges,.igs,.stl,.obj,.3mf')
  }
  function onThreeDModelRemove(file: UploadFile): void {
    threeDModelFiles.value = threeDModelFiles.value.filter((f) => f.uid !== file.uid)
  }

  /** 把新 file push 到 list（去重 by uid），扩展名校称校验。 */
  function fileList(
    current: UploadFile[],
    file: UploadFile,
    accept: string,
    matchExt = false,
  ): UploadFile[] {
    if (current.some((f) => f.uid === file.uid)) return current
    const name = (file.name || '').toLowerCase()
    const exts = accept.replace(/\./g, '').split(',')
    if (matchExt) {
      if (!exts.some((e) => name.endsWith('.' + e))) {
        ElMessage.warning(`不支持的文件类型：${file.name}`)
        return current
      }
    }
    return [...current, file]
  }

  /** PDF 按页数动态读取（pdfjs-dist）。与 composables/usePdfPageCount.ts 同模式：
   *  destroy() 在 PDFDocumentLoadingTask 上，不在 PDFDocumentProxy 上（旧实现
   *  调 doc.destroy() 抛 "doc.destroy is not a function"）。 */
  async function countPdfPages(file: File): Promise<number> {
    const buf = await file.arrayBuffer()
    const task = pdfjsLib.getDocument({ data: buf })
    try {
      const doc = await task.promise
      return doc.numPages
    } finally {
      await task.destroy()
    }
  }

  async function readExcel(file: File): Promise<BidRow[]> {
    const buf = await file.arrayBuffer()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const XLSX: any = await import('xlsx')
    const wb = XLSX.read(buf, { type: 'array' })
    const sheetNames = wb.SheetNames
    let parsed: ParseResult
    if (sheetNames.includes('历史价确认单明细')) {
      parsed = parseHistoricalPriceExcel(wb, todayIso())
    } else if (sheetNames.includes('招标项目-标的')) {
      parsed = parseBidExcel(wb, todayIso())
    } else {
      throw new Error(
        `Excel 格式无法识别（需要「历史价确认单明细」或「招标项目-标的」sheet），当前文件 sheet: ${sheetNames.join(', ')}`,
      )
    }
    if (parsed.errors.length > 0) {
      ElMessage.warning(`Excel 解析告警：${parsed.errors.length} 条（已忽略）`)
    }
    return parsed.rows
  }

  /** 从 pdfFiles 重新构建 allPdfs + standaloneParts（不自动组成装配件）。
   *  多页 PDF → 每页独立成一行；单页 PDF → 一行。 */
  async function rebuildFromUploads(): Promise<void> {
    if (pdfFiles.value.length === 0) {
      ElMessage.warning('请先上传 PDF')
      return
    }
    if (!pdfForm.customerL1Id) {
      ElMessage.warning('请选择一级客户')
      return
    }
    pdfBuildingTree.value = true
    try {
      // 解析 Excel（可选）
      let excelByDrawingNo: Map<string, BidRow> | null = null
      if (excelFiles.value.length > 0) {
        const raw = excelFiles.value[0].raw as File | undefined
        if (raw) {
          const rows = await readExcel(raw)
          excelByDrawingNo = new Map(rows.map((r) => [r.drawingNo, r]))
        }
      }

      const sources: PdfSource[] = []
      const rows: StandalonePartRow[] = []
      const unparsedPdfNames: string[] = []

      for (const f of pdfFiles.value) {
        const raw = f.raw as File | undefined
        if (!raw) continue
        const fname = f.name
        const parsed = parseDrawingFilename(fname)
        if (!parsed.drawingNo && !parsed.partName) {
          unparsedPdfNames.push(fname)
        }
        const totalPages = await countPdfPages(raw)
        const pdfUid = `pdf-${f.uid}`
        sources.push({
          uid: pdfUid,
          raw,
          filename: fname,
          totalPages,
          synthesized: false,
        })
        if (totalPages === 1) {
          // 单页 PDF → 自动进独立零件表
          rows.push(makeStandaloneRow({
            pdfSourceUid: pdfUid,
            drawing_no: parsed.drawingNo || '',
            name: parsed.partName || '',
          }))
        }
        // 多页 PDF 不预生成任何行；用户从源文件区显式选择页 → 合并
      }

      allPdfs.value = sources
      standaloneParts.value = rows
      assemblies.value = []
      selectedPages.value = new Set()
      if (excelByDrawingNo) applyExcelToAll(excelByDrawingNo)
      // PR-H 2026-07-28：按 drawing_no 把 3D 模型挂到对应独立零件 / 装配件子件行
      linkThreeDModelsToRows()

      if (unparsedPdfNames.length > 0) {
        ElMessage.warning(
          `以下 ${unparsedPdfNames.length} 个 PDF 文件名无法识别图号/名称，请手动填写：` +
            unparsedPdfNames.slice(0, 5).join('、') +
            (unparsedPdfNames.length > 5 ? ' …' : ''),
        )
      }
      ElMessage.success(`已解析：源 ${sources.length} 个 · 候选 ${rows.length} 页`)
    } catch (e) {
      ElMessage.error((e as Error).message ?? '解析失败')
    } finally {
      pdfBuildingTree.value = false
    }
  }

  /** 用 Excel 行覆盖表内字段（applicant / quantity / planned_delivery_date + 分厂 L2 + 单价）。
   *  2026-07-30 起不再覆盖 is_urgent（批量 PDF 导入默认全部不加急，由用户手动 switch）。 */
  function applyExcelToAll(excelByDrawingNo: Map<string, BidRow>): void {
    for (const r of standaloneParts.value) {
      const matched = excelByDrawingNo.get(r.drawing_no)
      if (!matched) continue
      r.applicant_name = matched.applicantName || r.applicant_name
      r.quantity = matched.quantity || r.quantity
      // 2026-07-30：批量 PDF 导入不再从应标 Excel 继承 is_urgent，默认全部不加急；
      // 用户在 el-switch 单独打开加急。
      if (matched.plannedDeliveryDate) r.planned_delivery_date = matched.plannedDeliveryDate
      // PR-H 2026-07-28：含税单价 / 总价
      if (matched.unitPrice != null) r.unit_price = matched.unitPrice
      if (matched.totalPrice != null) r.total_price = matched.totalPrice
      // 自动解析二级客户（分厂）
      if (!r.customer_id) {
        const l2Id = resolveL2CustomerId(matched.deptName)
        if (l2Id) {
          r.customer_id = l2Id
          const c = customers.value.find((x) => x.id === l2Id)
          r.customer_name = c?.name ?? ''
        }
      }
    }
    for (const a of assemblies.value) {
      // 顶层分厂 / 申请人：用第一个能在 Excel 查到的 child 的行（child 不再各自持有这两个字段）
      const firstHit = a.children
        .map((c) => excelByDrawingNo.get(c.drawing_no))
        .find((m): m is BidRow => !!m)
      if (firstHit) {
        if (!a.customer_id) {
          const l2Id = resolveL2CustomerId(firstHit.deptName)
          if (l2Id) {
            a.customer_id = l2Id
            const c = customers.value.find((x) => x.id === l2Id)
            a.customer_name = c?.name ?? ''
          }
        }
        a.applicant_name = firstHit.applicantName || a.applicant_name
      }
      // 子件继承 quantity / urgent / planned_delivery_date / 单价 / 总价
      for (const c of a.children) {
        const matched = excelByDrawingNo.get(c.drawing_no)
        if (!matched) continue
        c.quantity = matched.quantity || c.quantity
        // 2026-07-30：子件不再从应标 Excel 继承 is_urgent。
        if (matched.plannedDeliveryDate) c.planned_delivery_date = matched.plannedDeliveryDate
        // PR-H 2026-07-28：含税单价 / 总价
        if (matched.unitPrice != null) c.unit_price = matched.unitPrice
        if (matched.totalPrice != null) c.total_price = matched.totalPrice
      }
    }
  }

  /** 把 Excel 的「申请人所在一级部门名称」（如"二厂"）解析成 L2 客户 id。
   *  仅在所选 L1 客户的子客户里查找。 */
  function resolveL2CustomerId(deptName: string): string | null {
    if (!pdfForm.customerL1Id || !deptName) return null
    const match = customers.value.find(
      (c) => c.parent_id === pdfForm.customerL1Id && c.name.trim() === deptName.trim(),
    )
    return match?.id ?? null
  }

  /** PR-H 2026-07-28：含税单价改动 → 自动联动 total_price（仅在用户未手动锁定时）；
   *  保留 Excel 回填值优先 —— 若 total_price 已被 Excel 写入过且与自动算的不一致，
   *  仍按 Excel 的值，不强制覆盖（用户可手动改回）。 */
  function onUnitPriceChange(row: StandalonePartRow, v: number | undefined): void {
    row.unit_price = v ?? null
    // 仅当用户没明确设置过 total_price 时自动算
    if (row.quantity > 0 && row.unit_price != null) {
      row.total_price = row.unit_price * row.quantity
    }
  }
  function onChildUnitPriceChange(c: AssemblyChildRow, v: number | undefined): void {
    c.unit_price = v ?? null
    if (c.quantity > 0 && c.unit_price != null) {
      c.total_price = c.unit_price * c.quantity
    }
  }

  /** PR-H 2026-07-28：3D 模型支持扩展名（与后端 _file_kind_policy.THREE_D_MODEL 对齐）。 */
  const THREE_D_EXTS = ['step', 'stp', 'iges', 'igs', 'stl', 'obj', '3mf']

  /** 把 3D 模型按文件名解析的 drawing_no 自动挂到独立零件 / 装配件子件行。
   *  - 文件名约定：图号_名称.ext（与 PDF 解析共用 `parseDrawingFilename`，先剥扩展名）。
   *  - 已挂过该图号的 → 跳过（不重复挂）。
   *  - 找不到匹配行 → ElMessage.warning（不报错，整批仍可提交）。 */
  function linkThreeDModelsToRows(): void {
    if (threeDModelFiles.value.length === 0) return
    const warns: string[] = []
    threeDModelFiles.value.forEach((f, idx) => {
      const raw = f.raw as File | undefined
      if (!raw) return
      const fname = f.name
      const noExt = THREE_D_EXTS.reduce(
        (acc, ext) => acc.replace(new RegExp(`\\.${ext}$`, 'i'), ''),
        fname,
      )
      const parsed = parseDrawingFilename(`${noExt}.pdf`) // 复用 PDF 解析逻辑
      if (!parsed.drawingNo) {
        warns.push(`3D 模型「${fname}」文件名无法识别图号，已忽略`)
        return
      }
      // 先尝试独立零件，再试装配件子件
      const spMatch = standaloneParts.value.find((r) => r.drawing_no === parsed.drawingNo)
      if (spMatch) {
        if (spMatch.three_d_index != null) {
          warns.push(`图号 ${parsed.drawingNo} 已挂载 3D 模型，跳过「${fname}」`)
          return
        }
        spMatch.three_d_index = idx
        return
      }
      let attached = false
      for (const a of assemblies.value) {
        const childMatch = a.children.find((c) => c.drawing_no === parsed.drawingNo)
        if (childMatch) {
          if (childMatch.three_d_index != null) {
            warns.push(`图号 ${parsed.drawingNo} 已挂载 3D 模型，跳过「${fname}」`)
            attached = true
            break
          }
          childMatch.three_d_index = idx
          attached = true
          break
        }
      }
      if (!attached) warns.push(`未找到图号 ${parsed.drawingNo} 对应零件行，已忽略「${fname}」`)
    })
    if (warns.length > 0) {
      ElMessage.warning(
        `3D 模型挂载提示（${warns.length} 条）：\n` +
          warns.slice(0, 5).join('\n') +
          (warns.length > 5 ? '\n…' : ''),
      )
    }
  }

  /** 默认表单填充一个独立零件行。 */
  function makeStandaloneRow(opts: {
    pdfSourceUid: string
    drawing_no: string
    name: string
    pageCount?: number
    mergedFrom?: { pdfUid: string; pageIndex: number }[]
  }): StandalonePartRow {
    return {
      uid: `part-${makeUid()}`,
      pdfSourceUid: opts.pdfSourceUid,
      pageCount: opts.pageCount ?? 1,
      mergedFrom: opts.mergedFrom,
      drawing_no: opts.drawing_no,
      name: opts.name,
      applicant_name: '',
      customer_id: '',
      customer_name: '',
      request_date: pdfForm.requestDate,
      planned_delivery_date: '',
      system_delivery_date: null,
      order_no: null,
      note: null,
      is_urgent: false,
      quantity: 1,
      // PR-H 2026-07-28
      unit_price: null,
      total_price: null,
      three_d_index: null,
    }
  }

  /** 装配件子件默认填充（分厂 / 申请人由顶层 AssemblyRow 指定）。 */
  function makeAssemblyChild(opts: {
    pdfSourceUid: string
    pageIndex: number
    drawing_no: string
    name: string
  }): AssemblyChildRow {
    return {
      uid: `child-${makeUid()}`,
      pdfSourceUid: opts.pdfSourceUid,
      page_index: opts.pageIndex,
      drawing_no: opts.drawing_no,
      name: opts.name,
      quantity: 1,
      is_urgent: false,
      request_date: pdfForm.requestDate,
      planned_delivery_date: '',
      system_delivery_date: null,
      order_no: null,
      note: null,
      // PR-H 2026-07-28
      unit_price: null,
      total_price: null,
      three_d_index: null,
    }
  }

  // ============ PDF 文件名点击预览 ============
  const pdfPreviewing = ref<PdfPreviewState | null>(null)
  const pdfPreviewVisible = ref(false)

  /** 打开预览（通用入口）：传入 pdfSourceUid 和起始页（1-indexed）。 */
  function previewAt(pdfSourceUid: string, title: string, page: number): void {
    if (pdfPreviewing.value) {
      try { URL.revokeObjectURL(pdfPreviewing.value.url) } catch { /* ignore */ }
    }
    const src = allPdfs.value.find((s) => s.uid === pdfSourceUid)
    if (!src) {
      ElMessage.warning('PDF 不可用')
      return
    }
    pdfPreviewing.value = {
      url: URL.createObjectURL(src.raw),
      title,
      page,
    }
    pdfPreviewVisible.value = true
  }

  /** 关闭预览：revoke URL，清状态。el-dialog `:before-close` 会调。 */
  function closePdfPreview(): void {
    if (pdfPreviewing.value) {
      try { URL.revokeObjectURL(pdfPreviewing.value.url) } catch { /* ignore */ }
      pdfPreviewing.value = null
    }
    pdfPreviewVisible.value = false
  }

  // ============ 拖拽排序（sortable.js） ============
  // PR-H 2026-07-28：拖动 handle 列重排行顺序。
  // - 不接受嵌套展开行（child-table 不挂 sortable）；仅顶层独立零件 / 装配件行。
  // - watch 行数 + 数据身份变化时重建实例（避免 v-if / 数据长度变化时 tbody 重建导致旧实例悬挂）。
  function initStandaloneSortable(): void {
    const root = standaloneTableRef.value?.$el
    if (!root) return
    const tbody = root.querySelector(
      '.el-table__body-wrapper .el-table__body > tbody',
    ) as HTMLElement | null
    if (!tbody) return
    standaloneSortable?.destroy()
    standaloneSortable = Sortable.create(tbody, {
      handle: '.drag-handle',
      draggable: 'tr',
      animation: 150,
      ghostClass: 'sortable-ghost',
      onEnd(evt: { oldIndex?: number; newIndex?: number }) {
        const { oldIndex, newIndex } = evt
        if (oldIndex == null || newIndex == null || oldIndex === newIndex) return
        const next = standaloneParts.value.slice()
        const [moved] = next.splice(oldIndex, 1)
        if (moved) next.splice(newIndex, 0, moved)
        standaloneParts.value = next
      },
    })
  }
  function initAssembliesSortable(): void {
    const root = assembliesTableRef.value?.$el
    if (!root) return
    const tbody = root.querySelector(
      '.el-table__body-wrapper .el-table__body > tbody',
    ) as HTMLElement | null
    if (!tbody) return
    assembliesSortable?.destroy()
    assembliesSortable = Sortable.create(tbody, {
      handle: '.drag-handle',
      draggable: 'tr',
      animation: 150,
      ghostClass: 'sortable-ghost',
      onEnd(evt: { oldIndex?: number; newIndex?: number }) {
        const { oldIndex, newIndex } = evt
        if (oldIndex == null || newIndex == null || oldIndex === newIndex) return
        const next = assemblies.value.slice()
        const [moved] = next.splice(oldIndex, 1)
        if (moved) next.splice(newIndex, 0, moved)
        assemblies.value = next
      },
    })
  }
  watch(
    () => standaloneParts.value.length,
    () => nextTick(initStandaloneSortable),
  )
  watch(
    () => assemblies.value.length,
    () => nextTick(initAssembliesSortable),
  )

  // ============ 源文件区：勾选 + 归组 + 删除 ============
  function togglePageSelection(pdfUid: string, pageIndex: number, on: boolean): void {
    const next = new Set(selectedPages.value)
    const k = pageUid(pdfUid, pageIndex)
    if (on) next.add(k)
    else next.delete(k)
    selectedPages.value = next
  }

  /** el-table type=selection 回调：把选中的 SourceTreeRow 扁平化成页 UID 集合。
   *  顶层被选中 → 等价于「该 PDF 全部页」。 */
  function onSourceSelectionChange(rows: SourceTreeRow[]): void {
    const next = new Set<string>()
    for (const r of rows) {
      if (r.pageIndex !== null) {
        next.add(pageUid(r.pdfSourceUid, r.pageIndex))
      } else {
        const src = allPdfs.value.find((s) => s.uid === r.pdfSourceUid)
        if (src) for (let p = 0; p < src.totalPages; p++) next.add(pageUid(r.pdfSourceUid, p))
      }
    }
    selectedPages.value = next
  }

  /** 源文件区点击文件名预览。顶层 → 第 1 页；子页 → 对应页。 */
  function previewSourceRow(row: SourceTreeRow): void {
    const page = row.pageIndex === null ? 1 : row.pageIndex + 1
    previewAt(row.pdfSourceUid, `${row.filename} 预览`, page)
  }

  function togglePdfSelection(pdfUid: string, on: boolean): void {
    const src = allPdfs.value.find((s) => s.uid === pdfUid)
    if (!src) return
    const next = new Set(selectedPages.value)
    for (let p = 0; p < src.totalPages; p++) {
      const k = pageUid(pdfUid, p)
      if (on) next.add(k)
      else next.delete(k)
    }
    selectedPages.value = next
  }

  function isPdfFullySelected(pdfUid: string): boolean {
    const src = allPdfs.value.find((s) => s.uid === pdfUid)
    if (!src || src.totalPages === 0) return false
    for (let p = 0; p < src.totalPages; p++) {
      if (!selectedPages.value.has(pageUid(pdfUid, p))) return false
    }
    return true
  }

  function isPdfPartiallySelected(pdfUid: string): boolean {
    const src = allPdfs.value.find((s) => s.uid === pdfUid)
    if (!src) return false
    let any = false
    for (let p = 0; p < src.totalPages; p++) {
      if (selectedPages.value.has(pageUid(pdfUid, p))) {
        any = true
        break
      }
    }
    return any && !isPdfFullySelected(pdfUid)
  }

  // el-table 类型来自 element-plus 类型导出，运行时为函数组件；用宽松类型包住
  const sourceTableRef = ref<{ clearSelection: () => void } | null>(null)

  function clearSelection(): void {
    sourceTableRef.value?.clearSelection()
    selectedPages.value = new Set()
  }

  /** 用 pdf-lib 合并 PDF 的指定页（0-based pageIndices）→ 新 PDF Blob。 */
  async function mergePages(raw: Blob, pageIndices: number[]): Promise<Blob> {
    const { PDFDocument } = await import('pdf-lib')
    const src = await PDFDocument.load(await raw.arrayBuffer())
    const out = await PDFDocument.create()
    const copied = await out.copyPages(src, pageIndices)
    copied.forEach((p) => out.addPage(p))
    const bytes = await out.save()
    // pdf-lib save() 返回 Uint8Array<ArrayBufferLike>，TS 5+ 要求 BlobPart 严格是
    // ArrayBuffer 类型；slice() 拷贝出独立 ArrayBuffer，避开 SharedArrayBuffer 误判。
    return new Blob([bytes.slice().buffer as ArrayBuffer], { type: 'application/pdf' })
  }

  /** 把选中页按 pdfUid 分组。 */
  function selectedByPdf(): Map<string, number[]> {
    const m = new Map<string, number[]>()
    for (const k of selectedPages.value) {
      const { pdfUid, pageIndex } = parsePageUid(k)
      const arr = m.get(pdfUid) ?? []
      arr.push(pageIndex)
      m.set(pdfUid, arr)
    }
    for (const arr of m.values()) arr.sort((a, b) => a - b)
    return m
  }

  /** 合并选中页 → 一个独立零件（同一 PDF）。 */
  async function mergeSelectedAsPart(): Promise<void> {
    const byPdf = selectedByPdf()
    if (byPdf.size === 0) {
      ElMessage.warning('请先勾选页')
      return
    }
    if (byPdf.size > 1) {
      ElMessage.warning('合并为零件的页必须来自同一 PDF')
      return
    }
    const [pdfUid, pageIndices] = [...byPdf.entries()][0]
    const src = allPdfs.value.find((s) => s.uid === pdfUid)
    if (!src) return

    if (pageIndices.length === src.totalPages) {
      // 全部页 → 直接复用原 PDF，无合成
      standaloneParts.value.push(makeStandaloneRow({
        pdfSourceUid: pdfUid,
        drawing_no: parseDrawingFilename(src.filename).drawingNo || '',
        name: parseDrawingFilename(src.filename).partName || '',
      }))
    } else {
      // 部分页 → pdf-lib 合成
      const merged = await mergePages(src.raw, pageIndices)
      const newUid = `syn-${makeUid()}`
      allPdfs.value.push({
        uid: newUid,
        raw: merged,
        filename: `${stripExt(src.filename)}_p${pageIndices.map((i) => i + 1).join('+')}.pdf`,
        totalPages: pageIndices.length,
        synthesized: true,
        synthesizedFrom: [{ pdfUid, pageIndices }],
        originPdfUid: pdfUid,
      })
      standaloneParts.value.push(makeStandaloneRow({
        pdfSourceUid: newUid,
        pageCount: pageIndices.length,
        mergedFrom: pageIndices.map((i) => ({ pdfUid, pageIndex: i })),
        drawing_no: parseDrawingFilename(src.filename).drawingNo || '',
        name: parseDrawingFilename(src.filename).partName || '',
      }))
    }
    // 移除原 standalone 行（如果存在）
    clearSelection()
    ElMessage.success(`已合并 ${pageIndices.length} 页 → 独立零件`)
  }

  /** 合并选中页 → 一个装配件（同一 PDF，至少 2 页）。 */
  async function mergeSelectedAsAssembly(): Promise<void> {
    const byPdf = selectedByPdf()
    if (byPdf.size === 0) {
      ElMessage.warning('请先勾选页')
      return
    }
    if (byPdf.size > 1) {
      ElMessage.warning('合并为装配件的页必须来自同一 PDF')
      return
    }
    const [pdfUid, pageIndices] = [...byPdf.entries()][0]
    if (pageIndices.length < 2) {
      ElMessage.warning('合并为装配件至少需要 2 页')
      return
    }
    const src = allPdfs.value.find((s) => s.uid === pdfUid)
    if (!src) return
    const parsed = parseDrawingFilename(src.filename)
    const asmUid = `asm-${makeUid()}`
    const children: AssemblyChildRow[] = pageIndices.map((pi) => {
      const drawingNo = parsed.drawingNo
        ? (pi === 0 ? parsed.drawingNo : `${parsed.drawingNo}-${String(pi + 1).padStart(2, '0')}`)
        : ''
      const name = parsed.partName
        ? (pi === 0 ? parsed.partName : `${parsed.partName}-${pi + 1}`)
        : ''
      return makeAssemblyChild({
        pdfSourceUid: pdfUid,
        pageIndex: pi,
        drawing_no: drawingNo,
        name: name,
      })
    })
    assemblies.value.push({
      uid: asmUid,
      pdfSourceUid: pdfUid,
      drawing_no: parsed.drawingNo || '',
      name: parsed.partName || '',
      applicant_name: '',
      customer_id: '',
      customer_name: '',
      request_date: pdfForm.requestDate,
      planned_delivery_date: '',
      system_delivery_date: null,
      order_no: null,
      note: null,
      is_urgent: false,
      masterPageIndex: null,
      quantity: 1,
      children,
    })
    clearSelection()
    ElMessage.success(`已合并 ${pageIndices.length} 页 → 装配件`)
  }

  /** 拆分：把合成后的独立零件拆回 N 个单页行。 */
  function splitStandalonePart(row: StandalonePartRow): void {
    if (!row.mergedFrom || row.mergedFrom.length === 0) return
    // 找到原始 PDF
    const originUid = row.mergedFrom[0].pdfUid
    const src = allPdfs.value.find((s) => s.uid === originUid)
    if (!src) {
      ElMessage.error('原 PDF 已不存在，无法拆分')
      return
    }
    // 按 pageIndex 排序，逐页创建独立行
    const sorted = [...row.mergedFrom].sort((a, b) => a.pageIndex - b.pageIndex)
    for (const m of sorted) {
      const parsed = parseDrawingFilename(src.filename)
      const drawingNo = parsed.drawingNo
        ? (m.pageIndex === 0 ? parsed.drawingNo : `${parsed.drawingNo}-${String(m.pageIndex + 1).padStart(2, '0')}`)
        : ''
      const name = parsed.partName
        ? (m.pageIndex === 0 ? parsed.partName : `${parsed.partName}-${m.pageIndex + 1}`)
        : ''
      standaloneParts.value.push(makeStandaloneRow({
        pdfSourceUid: originUid,
        drawing_no: drawingNo,
        name: name,
      }))
    }
    // 删除合成 PDF（若已合并成 part，且 part 是唯一引用）
    const synthUid = row.pdfSourceUid
    if (synthUid.startsWith('syn-')) {
      allPdfs.value = allPdfs.value.filter((s) => s.uid !== synthUid)
    }
    standaloneParts.value = standaloneParts.value.filter((r) => r.uid !== row.uid)
    ElMessage.success(`已拆回 ${sorted.length} 页`)
  }

  /** 删除一个原 PDF：连带删除合成 PDF + 引用它的所有 part / assembly。 */
  function removePdf(pdfUid: string): void {
    if (!allPdfs.value.some((s) => s.uid === pdfUid)) return
    // 1. 找出要删除的源：原 PDF + 它的所有合成派生
    const removeUids = new Set<string>([pdfUid])
    allPdfs.value.filter((s) => s.originPdfUid === pdfUid).forEach((s) => removeUids.add(s.uid))
    // 2. 从 allPdfs 移除
    allPdfs.value = allPdfs.value.filter((s) => !removeUids.has(s.uid))
    // 3. 清理 standaloneParts
    standaloneParts.value = standaloneParts.value.filter((r) => !removeUids.has(r.pdfSourceUid))
    // 4. 清理 assemblies
    assemblies.value = assemblies.value.filter((a) => !removeUids.has(a.pdfSourceUid))
    // 5. 清理 selection
    const next = new Set<string>()
    for (const k of selectedPages.value) {
      if (!removeUids.has(parsePageUid(k).pdfUid)) next.add(k)
    }
    selectedPages.value = next
    // 6. 从 el-upload pdfFiles 移除原 UploadFile（pdfUid = "pdf-<uploadFileUid>"）
    const uploadUid = pdfUid.startsWith('pdf-') ? pdfUid.slice(4) : null
    if (uploadUid) {
      pdfFiles.value = pdfFiles.value.filter((f) => String(f.uid) !== uploadUid)
    }
  }

  function removeStandalonePart(uid: string): void {
    const row = standaloneParts.value.find((r) => r.uid === uid)
    if (!row) return
    // 若是合成行，删除合成 PDF
    if (row.pdfSourceUid.startsWith('syn-')) {
      allPdfs.value = allPdfs.value.filter((s) => s.uid !== row.pdfSourceUid)
    }
    standaloneParts.value = standaloneParts.value.filter((r) => r.uid !== uid)
  }

  function removeAssembly(uid: string): void {
    assemblies.value = assemblies.value.filter((a) => a.uid !== uid)
  }

  /** 展示用：把 PdfSource uid 翻译成可读文件名 + 页数。 */
  function pdfSourceLabel(uid: string): string {
    const src = allPdfs.value.find((s) => s.uid === uid)
    if (!src) return '(已删除)'
    return src.synthesized
      ? `${src.filename}（合成 ${src.totalPages} 页）`
      : `${src.filename}（${src.totalPages} 页）`
  }

  /** 预览独立零件 / 装配件图纸。 */
  function previewStandalonePart(row: StandalonePartRow): void {
    previewAt(row.pdfSourceUid, `${row.drawing_no || row.name} 预览`, 1)
  }
  function previewPdfSource(src: PdfSource): void {
    previewAt(src.uid, `${src.filename} 预览`, 1)
  }
  function previewPdfSourceByUid(uid: string): void {
    previewAt(uid, `${pdfSourceLabel(uid)} 预览`, 1)
  }

  /** 行（standalone / child）分厂下拉 onChange：同步 customer_name。 */
  function onL2Change(row: { customer_id: string; customer_name?: string }, v: string): void {
    row.customer_id = v
    const c = customers.value.find((x) => x.id === v)
    row.customer_name = c?.name ?? ''
  }

  /** 装配件顶层计划交期改值 → 同步所有子件。简单覆盖语义：child 单独改后
   *  下次顶层改会被覆盖（如需「记住 child 单独覆盖」需加 flag 字段，本轮不做）。 */
  function onAsmPlannedChange(asmRow: AssemblyRow, v: string): void {
    asmRow.planned_delivery_date = v
    for (const c of asmRow.children) c.planned_delivery_date = v
  }

  // ============ 手动新增零件 / 装配件 ============
  const manualPartDialogVisible = ref(false)
  const manualPartForm = reactive<{
    drawing_no: string
    name: string
    file: File | null
  }>({ drawing_no: '', name: '', file: null })
  const manualPartFileList = computed<UploadFile[]>(() =>
    manualPartForm.file
      ? [{ uid: -1, name: manualPartForm.file.name, status: 'success', raw: manualPartForm.file as UploadFile['raw'] }]
      : [],
  )
  const manualPartFormValid = computed(() =>
    manualPartForm.drawing_no.trim().length > 0 && manualPartForm.file !== null,
  )

  function addManualPart(): void {
    manualPartForm.drawing_no = ''
    manualPartForm.name = ''
    manualPartForm.file = null
    manualPartDialogVisible.value = true
  }

  function onManualPartFileChange(file: UploadFile): void {
    manualPartForm.file = (file.raw as File | undefined) ?? null
  }

  function onManualPartFileRemove(): void {
    manualPartForm.file = null
  }

  async function confirmManualPart(): Promise<void> {
    if (!manualPartFormValid.value) return
    const f = manualPartForm.file!
    const pdfUid = `manual-${makeUid()}`
    allPdfs.value.push({
      uid: pdfUid,
      raw: f,
      filename: f.name,
      totalPages: 1,
      synthesized: false,
    })
    standaloneParts.value.push(makeStandaloneRow({
      pdfSourceUid: pdfUid,
      drawing_no: manualPartForm.drawing_no.trim(),
      name: manualPartForm.name.trim(),
    }))
    manualPartDialogVisible.value = false
    ElMessage.success('已新增零件')
  }

  /** 模板里点「取消」按钮的关闭动作。 */
  function closeManualPartDialog(): void {
    manualPartDialogVisible.value = false
  }
  function closeManualAsmDialog(): void {
    manualAsmDialogVisible.value = false
  }

  const manualAsmDialogVisible = ref(false)
  const manualAsmForm = reactive<{
    drawing_no: string
    name: string
    file: File | null
  }>({ drawing_no: '', name: '', file: null })
  const manualAsmFileList = computed<UploadFile[]>(() =>
    manualAsmForm.file
      ? [{ uid: -2, name: manualAsmForm.file.name, status: 'success', raw: manualAsmForm.file as UploadFile['raw'] }]
      : [],
  )
  const manualAsmFormValid = computed(() =>
    manualAsmForm.drawing_no.trim().length > 0 && manualAsmForm.file !== null,
  )

  function addManualAssembly(): void {
    manualAsmForm.drawing_no = ''
    manualAsmForm.name = ''
    manualAsmForm.file = null
    manualAsmDialogVisible.value = true
  }

  function onManualAsmFileChange(file: UploadFile): void {
    manualAsmForm.file = (file.raw as File | undefined) ?? null
  }

  function onManualAsmFileRemove(): void {
    manualAsmForm.file = null
  }

  async function confirmManualAssembly(): Promise<void> {
    if (!manualAsmFormValid.value) return
    const f = manualAsmForm.file!
    const totalPages = await countPdfPages(f)
    const pdfUid = `manual-asm-${makeUid()}`
    allPdfs.value.push({
      uid: pdfUid,
      raw: f,
      filename: f.name,
      totalPages,
      synthesized: false,
    })
    const asmUid = `asm-${makeUid()}`
    const children: AssemblyChildRow[] = []
    for (let p = 0; p < totalPages; p++) {
      children.push(makeAssemblyChild({
        pdfSourceUid: pdfUid,
        pageIndex: p,
        drawing_no: totalPages === 1
          ? manualAsmForm.drawing_no.trim()
          : `${manualAsmForm.drawing_no.trim()}-${String(p + 1).padStart(2, '0')}`,
        name: totalPages === 1
          ? manualAsmForm.name.trim() || manualAsmForm.drawing_no.trim()
          : `${manualAsmForm.name.trim() || manualAsmForm.drawing_no.trim()}-${p + 1}`,
      }))
    }
    assemblies.value.push({
      uid: asmUid,
      pdfSourceUid: pdfUid,
      drawing_no: manualAsmForm.drawing_no.trim(),
      name: manualAsmForm.name.trim(),
      applicant_name: '',
      customer_id: '',
      customer_name: '',
      request_date: pdfForm.requestDate,
      planned_delivery_date: '',
      system_delivery_date: null,
      order_no: null,
      note: null,
      is_urgent: false,
      masterPageIndex: totalPages > 1 ? 0 : null,
      quantity: 1,
      children,
    })
    manualAsmDialogVisible.value = false
    ElMessage.success(`已新增装配件（共 ${totalPages} 子件）`)
  }

  /** 点击「提交创建」 */
  async function onSubmitPdfTree(): Promise<void> {
    if (standaloneParts.value.length === 0 && assemblies.value.length === 0) {
      ElMessage.warning('请先解析上传')
      return
    }
    // 前端兜底：所有 row 的 customer_id 必须有 L2 客户（后端强校验 L2-leaf）
    const missing: string[] = []
    for (const r of standaloneParts.value) {
      if (!r.customer_id) missing.push(`独立零件 ${r.drawing_no || r.uid}`)
    }
    for (const a of assemblies.value) {
      // 子件分厂继承自顶层 → 顶层 customer_id 校验已覆盖
      if (!a.customer_id) missing.push(`装配件 ${a.drawing_no || a.uid}`)
    }
    if (missing.length > 0) {
      ElMessage.warning(
        `以下 ${missing.length} 行未指定分厂（二级客户），请补全后再提交：\n` +
          missing.slice(0, 5).join('\n') +
          (missing.length > 5 ? '\n…' : ''),
      )
      return
    }
    pdfSubmitting.value = true
    try {
      const items: PartBatchTreeItemFE[] = []
      const assembliesPayload: PartBatchTreeAssemblyFE[] = []
      // files 按 allPdfs 顺序对齐（顺序即为后端的 pdf_index）
      const files: PartBatchFilePayload[] = allPdfs.value.map((src) => ({
        data: src.raw,
        filename: src.filename,
        contentType: 'application/pdf',
      }))

      // PR-H 2026-07-28：3D 模型按 threeDModelFiles 顺序对齐（与 items[i].three_d_index 对齐）
      const threeDModelPayloads: PartBatchFilePayload[] = []
      for (const f of threeDModelFiles.value) {
        const raw = f.raw
        if (!raw) continue
        threeDModelPayloads.push({
          data: raw,
          filename: f.name,
          contentType: 'application/octet-stream',  // 后端按扩展名重新判
        })
      }

      // 独立零件：page_index 始终 0（合成 / 原 PDF 都按整体上传）
      for (const r of standaloneParts.value) {
        const pdfIndex = allPdfs.value.findIndex((s) => s.uid === r.pdfSourceUid)
        if (pdfIndex < 0) {
          ElMessage.error(`独立零件 ${r.drawing_no} 引用了已删除的图纸源`)
          return
        }
        items.push({
          pdf_index: pdfIndex,
          page_index: 0,
          assembly_uid: null,
          is_master: false,
          drawing_no: r.drawing_no,
          name: r.name || r.drawing_no,
          applicant_name: r.applicant_name,
          applicant_id: null,
          quantity: r.quantity,
          customer_id: r.customer_id,
          request_date: r.request_date,
          planned_delivery_date: r.planned_delivery_date || r.request_date,
          system_delivery_date: r.system_delivery_date,
          order_no: r.order_no,
          note: r.note,
          is_urgent: r.is_urgent,
          // PR-H 2026-07-28
          unit_price: r.unit_price ?? null,
          total_price: r.total_price ?? null,
          three_d_index: r.three_d_index ?? null,
        })
      }

      // 装配件 + 子件
      for (const a of assemblies.value) {
        const pdfIndex = allPdfs.value.findIndex((s) => s.uid === a.pdfSourceUid)
        if (pdfIndex < 0) {
          ElMessage.error(`装配件 ${a.drawing_no} 引用了已删除的图纸源`)
          return
        }
        assembliesPayload.push({
          uid: a.uid,
          drawing_no: a.drawing_no || null,
          name: a.name || null,
          applicant_name: a.applicant_name,
          applicant_id: null,
          customer_id: a.customer_id,
          request_date: a.request_date,
          planned_delivery_date: a.planned_delivery_date || a.request_date,
          system_delivery_date: a.system_delivery_date,
          order_no: a.order_no,
          note: a.note,
          is_urgent: a.is_urgent,
          quantity: a.quantity,
        })
        for (const c of a.children) {
          items.push({
            pdf_index: pdfIndex,
            page_index: c.page_index,
            assembly_uid: a.uid,
            is_master: a.masterPageIndex === c.page_index,
            drawing_no: c.drawing_no,
            name: c.name || `子件${c.page_index + 1}`,
            // 分厂 / 申请人继承自装配件顶层
            applicant_name: a.applicant_name,
            applicant_id: null,
            quantity: c.quantity,
            customer_id: a.customer_id,
            request_date: c.request_date,
            planned_delivery_date: c.planned_delivery_date || c.request_date,
            system_delivery_date: c.system_delivery_date,
            order_no: c.order_no,
            note: c.note,
            is_urgent: c.is_urgent,
            // PR-H 2026-07-28
            unit_price: c.unit_price ?? null,
            total_price: c.total_price ?? null,
            three_d_index: c.three_d_index ?? null,
          })
        }
      }

      const res = await batchCreatePartsWithPdfs(items, assembliesPayload, files, threeDModelPayloads)
      if (res.failed && res.failed.length > 0) {
        const msgs = res.failed.slice(0, 5).map((f) => f.message).join('；')
        ElMessageBox.alert(
          `前置校验失败 ${res.failed.length} 条：${msgs}`,
          '提交失败',
          { type: 'error' },
        )
        return
      }
      ElMessage.success(
        `成功创建 ${res.standalone_parts.length} 个独立零件 + ${res.assemblies.length} 个装配件`,
      )
      // 清空 + 跳回
      allPdfs.value = []
      standaloneParts.value = []
      assemblies.value = []
      selectedPages.value.clear()
      pdfFiles.value = []
      excelFiles.value = []
      threeDModelFiles.value = []  // PR-H 2026-07-28
      successNextTab.value = 'manual'
      router.push('/parts?status=PENDING')
    } catch (e) {
      ElMessage.error((e as Error).message ?? '提交失败')
    } finally {
      pdfSubmitting.value = false
    }
  }

  // 暴露给模板的 init 函数（shell 会在 nextTick 调一次）
  function initSortables(): void {
    nextTick(() => {
      initStandaloneSortable()
      initAssembliesSortable()
    })
  }

  onBeforeUnmount(() => {
    closePdfPreview()
    standaloneSortable?.destroy()
    assembliesSortable?.destroy()
  })

  return {
    // 客户
    l1Customers,
    l2Customers,
    // applicants
    applicantCandidates: applicantSearch.applicants,
    applicantLoading: applicantSearch.loading,
    querySearch: applicantSearch.querySearch,
    // pdfForm
    pdfForm,
    // file lists
    pdfFiles,
    excelFiles,
    threeDModelFiles,
    pdfBuildingTree,
    pdfSubmitting,
    // data
    allPdfs,
    selectedPages,
    standaloneParts,
    assemblies,
    originalPdfs,
    totalAssemblyChildren,
    sourceTree,
    // table refs
    standaloneTableRef,
    assembliesTableRef,
    sourceTableRef,
    // preview state
    pdfPreviewing,
    pdfPreviewVisible,
    // manual add dialog
    manualPartDialogVisible,
    manualPartForm,
    manualPartFileList,
    manualPartFormValid,
    manualAsmDialogVisible,
    manualAsmForm,
    manualAsmFileList,
    manualAsmFormValid,
    // upload handlers
    onPdfChange,
    onPdfRemove,
    onExcelChange,
    onExcelRemove,
    onThreeDModelChange,
    onThreeDModelRemove,
    // parse
    rebuildFromUploads,
    onUnitPriceChange,
    onChildUnitPriceChange,
    onL2Change,
    onAsmPlannedChange,
    // preview
    previewAt,
    closePdfPreview,
    previewSourceRow,
    previewStandalonePart,
    previewPdfSource,
    previewPdfSourceByUid,
    pdfSourceLabel,
    // selection
    onSourceSelectionChange,
    togglePageSelection,
    togglePdfSelection,
    isPdfFullySelected,
    isPdfPartiallySelected,
    clearSelection,
    // merge / split
    mergeSelectedAsPart,
    mergeSelectedAsAssembly,
    splitStandalonePart,
    removePdf,
    removeStandalonePart,
    removeAssembly,
    // manual add
    addManualPart,
    onManualPartFileChange,
    onManualPartFileRemove,
    confirmManualPart,
    closeManualPartDialog,
    addManualAssembly,
    onManualAsmFileChange,
    onManualAsmFileRemove,
    confirmManualAssembly,
    closeManualAsmDialog,
    // submit
    onSubmitPdfTree,
    // init
    initSortables,
  }
}