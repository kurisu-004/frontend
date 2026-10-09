// Tab 2「PDF 批量上传」composable。
//
// 2026-10-04 单按钮 + 后端上传：提交入口收敛成一个 `onSubmit`，内部三段
// `idle → creating → uploading → done`。上传失败语义是「工单已建 + 失败清单可重试」——工单落库不可回滚，
// 所以 `commitStage` 一旦越过 creating 就绝不回 idle（回 idle 会让用户再点一次
// 主按钮，把同一批工单建第二遍），重试一律只补传文件。
//
// 2026-10-05：creating 阶段**分两路**。独立零件行走 `POST /parts/batch`（一次请求，
// 端点内无 assembly 概念）；装配件行走树形端点 `POST /api/v2/assemblies`（逐组一次请求，
// 一次建出 `t_assembly` 顶层 + 全部 `t_part` 子件）。此前把装配件主子件展平成 N+1 个
// 独立 part 发 `POST /parts/batch`，结果 `t_assembly` 一行不涨、子件的 `assembly_id`
// 全 NULL —— 表格上叫「装配件」的东西在服务端根本不是装配件。
//
// 建单只有「部分行成立」时是例外：建出来的行会立刻从本地表格移除（它们已经是真实
// 工单，留着只会诱导重复提交），剩下的失败行才留在表里等下一次提交 ⇒ 阶段此时回
// idle 也不会重复建单。`POST /parts/batch` 与 `POST /assemblies` 都无幂等键，任何
// 「同一批行发第二次」都是真建出第二份工单。
//
// 已知取舍（2026-10-04）：本 Tab 的草稿是**只写**的 —— `draft.load()` 只在 saver 里用来
// 读回旧 payload 以保住 Tab 1 的 `manual_tab` 段，没有任何把 `pdf_tab.rows` 灌回
// `standaloneParts` / `assemblies` 的路径。所以刷新后表格是空的、行全部丢失，重新提交
// 必须重新选文件再解析。会**重复建单**的实际触发点是「重新解析」：它把全部行重新列出来
// （含上一次已经建出工单的那些），再点提交就会建第二遍。
// 要根治得让行 uid 可复现（解析结果按文件名+页码派生），属独立设计变更。

import {
  computed,
  onBeforeUnmount,
  provide,
  reactive,
  ref,
  shallowRef,
  watch,
  type ComputedRef,
  type Ref,
} from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox, type UploadFile } from 'element-plus';
import { useLazyDraggable } from '@/composables/useLazyDraggable';
import { batchCreateParts, uploadPart3DModel, uploadPartDrawing } from '@/api/parts';
import type { PartBatchCreatePayload, PartBatchResult } from '@/api/parts';
import { createAssembly, uploadAssemblyPdf } from '@/api/assembly';
import type { AssemblyCreatePayload } from '@/types/assembly';
import {
  usePartsNewDraft,
  type SerializedAssemblyChildRow,
  type SerializedAssemblyRow,
  type SerializedPdfTab,
  type SerializedStandalonePartRow,
} from '@/views/parts/new/composables/usePartsNewDraft';
import type { Customer } from '@/api/customer';
import { isPartFileDuplicateError, type PartFileKind } from '@/types/part_file';
import { parseBidExcel, type BidRow, type ParseResult } from '@/utils/bidExcelParser';
import { parseHistoricalPriceExcel } from '@/utils/historicalPriceExcelParser';
import { parseDrawingFilename } from '@/utils/drawingFilename';
import { findElTableTbody } from '@/utils/elTable';
import { countPdfPages } from '@/utils/pdfjs';
// type-only：只为 `loadPdfDoc` / `copyPagesFrom` 的返回类型标注。pdf-lib 的**值**必须
// 保持动态 import（切页只在建行时发生，不该进首屏 bundle）。
import type { PDFDocument as PdfLibDocument } from 'pdf-lib';
import {
  makeUid,
  pageUid,
  parsePageUid,
  stripExt,
  toMoneyString,
  todayIso,
} from './usePartBatchShared';

interface PdfFormState {
  /** 一级客户 id（Tab 2 必选；决定 serial_prefix 来源 + 二级客户候选范围）。 */
  customerL1Id: string | null;
  requestDate: string;
}

/** 源文件区表格的树节点。多页 PDF 是父节点，子页是 children。 */
export interface SourceTreeRow {
  /** 顶层 = pdfSourceUid；子行 = `${pdfSourceUid}:p${pageIndex}`。 */
  id: string;
  pdfSourceUid: string;
  /** null = PDF 顶层；>=0 = 子页。 */
  pageIndex: number | null;
  filename: string;
  totalPages: number;
  children?: SourceTreeRow[];
}

/** 一份「图纸源」：上传的原始 PDF 或前端合成的新 PDF。 */
export interface PdfSource {
  uid: string;
  raw: Blob;
  filename: string;
  totalPages: number;
  /** true = 由 pdf-lib 合并产生；false = 原 PDF。 */
  synthesized: boolean;
  /** 合成来源（仅 synthesized=true）。 */
  synthesizedFrom?: { pdfUid: string; pageIndices: number[] }[];
  /** 原始 PDF 的 uid（合成时记录）。 */
  originPdfUid?: string;
}

/** 独立零件表的一行。 */
export interface StandalonePartRow {
  uid: string;
  pdfSourceUid: string;
  pageCount: number;
  /** 合成来源（仅 pageCount > 1）。 */
  mergedFrom?: { pdfUid: string; pageIndex: number }[];
  drawing_no: string;
  name: string;
  applicant_name: string;
  customer_id: string; // 二级客户 id（L2 leaf）；后端 customer_id 校验需要叶子节点
  customer_name: string; // 显示用，提交时不发送
  request_date: string;
  planned_delivery_date: string;
  system_delivery_date: string | null;
  order_no: string | null;
  note: string | null;
  is_urgent: boolean;
  quantity: number;
  /** PR-H 2026-07-28：含税单价（来自历史价确认单 G 列，可手动覆盖） */
  unit_price: number | null;
  /** PR-H 2026-07-28：含税总价（来自历史价确认单 I 列；空时 = unit_price × quantity） */
  total_price: number | null;
  /** PR-H 2026-07-28：3D 模型数组下标；null = 不挂 */
  three_d_index: number | null;
}

/** 装配件子件。分厂 / 申请人由顶层 AssemblyRow 指定，提交时复制到每条 item。 */
export interface AssemblyChildRow {
  uid: string;
  pdfSourceUid: string;
  page_index: number;
  drawing_no: string;
  name: string;
  quantity: number;
  is_urgent: boolean;
  request_date: string;
  planned_delivery_date: string;
  system_delivery_date: string | null;
  order_no: string | null;
  note: string | null;
  /** PR-H 2026-07-28：含税单价（来自历史价确认单 G 列） */
  unit_price: number | null;
  /** PR-H 2026-07-28：含税总价 */
  total_price: number | null;
  /** PR-H 2026-07-28：3D 模型数组下标；null = 不挂 */
  three_d_index: number | null;
}

/** 装配件顶层行。 */
export interface AssemblyRow {
  uid: string;
  pdfSourceUid: string;
  drawing_no: string;
  name: string;
  applicant_name: string;
  customer_id: string; // 二级客户 id（L2 leaf）
  customer_name: string;
  request_date: string;
  planned_delivery_date: string;
  system_delivery_date: string | null;
  order_no: string | null;
  note: string | null;
  is_urgent: boolean;
  masterPageIndex: number | null;
  /**
   * 2026-10-05 新增：总装图（单页切片）的 PdfSource uid；null = 本装配件**无总装图**。
   * 无总装图时不产生 `ASSEMBLY_MASTER` 上传 job ⇒ 库里没有 ASSEMBLY_MASTER 行 ⇒
   * 打印时既不出总装图也不出该装配件的序列号背面（后端 `printing.py` 的既有守卫）。
   *
   * 与 `pdfSourceUid`（**原始** PDF，供源文件区预览 / 移除时级联清理用）是两回事：
   * 顶层图号 / 子件页的打印都只认这份单页切片。
   */
  masterPdfSourceUid: string | null;
  /** 装配体套数（默认 1）。2026-08-04 新增：用于背面页 Q: 打印 */
  quantity: number;
  /** 2026-10-05 新增：整套含税单价。业务口径 = **整套**的单件价，不是各子件单价之和。 */
  unit_price: number | null;
  /** 2026-10-05 新增：整套含税总价；随 `unit_price` 联动（单价 × 套数）。 */
  total_price: number | null;
  children: AssemblyChildRow[];
}

/** 弹窗内显示的 blob URL + 标题 + 起始页。blob URL 由 pdfFiles[i].raw →
 * URL.createObjectURL 生成；关闭弹窗或组件卸载时 revoke，避免内存泄漏。 */
export interface PdfPreviewState {
  url: string;
  title: string;
  page: number;
}

/**
 * 2026-09-21 显式返回类型需要：模块级 export UploadStatusCell 接口，
 * UsePartBatchPdfReturn 在文件较前位置引用它。
 *
 * 状态机只四态：后置上传链路不算本地摘要、multipart 也没有进度回调。
 */
export interface UploadStatusCell {
  /** 当前阶段：pending（已排队未跑）/ uploading / done / error。 */
  status: 'pending' | 'uploading' | 'done' | 'error';
  /** 0-100；multipart 无进度回调，上传中固定 0、完成时 100（不伪造百分比）。 */
  progress: number;
  /** 错误信息（status='error' 时）。 */
  error?: string;
}

export interface UsePartBatchPdfOptions {
  /** 客户全集（由 shell 加载并传入；两个 Tab 共用）。 */
  customers: Ref<Customer[]>;
  /** 申请人搜索共享实例（shell 创建一次；两 Tab 共用 cache）。 */
  applicantSearch: {
    applicants: Ref<{ id: string; name: string }[]>;
    loading: Ref<boolean>;
    loadForCustomer: (pickedId: string | null) => Promise<void>;
    querySearch: (queryString: string, cb: (items: { id: string; name: string }[]) => void) => void;
  };
  /** 提交成功后切到哪个 tab（默认 'manual'）。由 shell 提供，避免硬编码路由跳转。 */
  successNextTab: Ref<string>;
}

/**
 * Tab 2「PDF 批量上传」的全部 state + handler。返回值直接 `v-bind` 给 PartBatchPdfTab。
 */
/** 2026-09-21 显式返回类型。 */
export interface UsePartBatchPdfReturn {
  pdfForm: PdfFormState;
  // applicants（来自 applicantSearch 共享 instance；组件 props 是 unref 后的裸值）
  applicantCandidates: Ref<Array<{ id: string; name: string }>>;
  applicantLoading: Ref<boolean>;
  querySearch: (
    queryString: string,
    cb: (items: Array<{ id: string; name: string }>) => void,
  ) => void;
  l1Customers: ComputedRef<Array<{ id: string; name: string }>>;
  l2Customers: ComputedRef<Array<{ id: string; name: string }>>;
  pdfFiles: Ref<UploadFile[]>;
  excelFiles: Ref<UploadFile[]>;
  threeDModelFiles: Ref<UploadFile[]>;
  pdfBuildingTree: Ref<boolean>;
  pdfSubmitting: Ref<boolean>;
  allPdfs: Ref<PdfSource[]>;
  selectedPages: Ref<Set<string>>;
  standaloneParts: Ref<StandalonePartRow[]>;
  assemblies: Ref<AssemblyRow[]>;
  totalAssemblyChildren: ComputedRef<number>;
  sourceTree: ComputedRef<SourceTreeRow[]>;
  onPdfChange: (file: UploadFile) => void;
  onPdfRemove: (file: UploadFile) => void;
  onExcelChange: (file: UploadFile) => void;
  onExcelRemove: (file: UploadFile) => void;
  onThreeDModelChange: (file: UploadFile) => void;
  onThreeDModelRemove: (file: UploadFile) => void;
  rebuildFromUploads: () => Promise<void>;
  closePdfPreview: () => void;
  pdfPreviewing: Ref<PdfPreviewState | null>;
  pdfPreviewVisible: Ref<boolean>;
  clearSelection: (table?: { clearSelection: () => void } | null) => void;
  mergeSelectedAsPart: () => Promise<void>;
  mergeSelectedAsAssembly: () => Promise<void>;
  /**
   * 2026-10-05 新增：实际建出的子件（被指定为总装图的那一页被排除）。建单 / 上传 /
   * 计数一律走它，表格仍渲染完整 `a.children`。
   */
  effectiveChildren: (a: AssemblyRow) => AssemblyChildRow[];
  /** 2026-10-05 新增：总装图下拉改值（同时维护 masterPageIndex 与 masterPdfSourceUid）。 */
  onAsmMasterPageChange: (a: AssemblyRow, v: number | null | undefined) => void;
  splitStandalonePart: (row: StandalonePartRow) => void;
  removePdf: (pdfUid: string) => void;
  removeStandalonePart: (uid: string) => void;
  removeAssembly: (uid: string) => void;
  pdfSourceLabel: (uid: string) => string;
  previewStandalonePart: (row: StandalonePartRow) => void;
  previewPdfSourceByUid: (uid: string) => void;
  onUnitPriceChange: (row: StandalonePartRow, v: number | undefined) => void;
  /** 2026-10-05 新增：装配件顶层整套含税单价（联动 total_price = 单价 × 套数）。 */
  onAsmUnitPriceChange: (row: AssemblyRow, v: number | undefined) => void;
  onChildUnitPriceChange: (c: AssemblyChildRow, v: number | undefined) => void;
  onL2Change: (row: { customer_id: string; customer_name?: string }, v: string) => void;
  onAsmPlannedChange: (asmRow: AssemblyRow, v: string) => void;
  onSourceSelectionChange: (rows: SourceTreeRow[]) => void;
  previewSourceRow: (row: SourceTreeRow) => void;
  pdfUploadCells: Record<string, UploadStatusCell>;
  threeDUploadCells: Record<string, UploadStatusCell>;
  getRowPdfCell: (row: { pdfSourceUid: string | null }) => UploadStatusCell | undefined;
  getRowThreeDCell: (row: { three_d_index: number | null }) => UploadStatusCell | undefined;
  /** 2026-10-04：单按钮提交流程的阶段机。 */
  commitStage: Ref<'idle' | 'creating' | 'uploading' | 'done'>;
  canSubmit: ComputedRef<boolean>;
  /** 2026-10-04：按钮文案（提交 / 重试 / 进行中三态都由这里驱动）。 */
  submitLabel: ComputedRef<string>;
  /**
   * 2026-10-04：行内「重试」按钮的 disabled 判据。补传在途时必须置灰 —— 同一次
   * 上传的 job 已在跑，重复触发只会撞后端 `uk_t_part_file_single`。
   */
  cellRetryDisabled: ComputedRef<boolean>;
  /** 行内单文件重试：按 cell key 取其下仍失败的 job 重跑（不重复建 part）。 */
  retryUploadByCell: (jobKey: string) => Promise<void>;
  onSubmit: () => Promise<void>;
  retryFailedUploads: () => Promise<void>;
  manualPartDialogVisible: Ref<boolean>;
  manualPartForm: { drawing_no: string; name: string; file: File | null };
  manualPartFileList: ComputedRef<UploadFile[]>;
  manualPartFormValid: ComputedRef<boolean>;
  closeManualPartDialog: () => void;
  manualAsmDialogVisible: Ref<boolean>;
  manualAsmForm: { drawing_no: string; name: string; file: File | null };
  manualAsmFileList: ComputedRef<UploadFile[]>;
  manualAsmFormValid: ComputedRef<boolean>;
  closeManualAsmDialog: () => void;
  addManualPart: () => void;
  confirmManualPart: () => Promise<void>;
  onManualPartFileChange: (file: UploadFile) => void;
  onManualPartFileRemove: () => void;
  addManualAssembly: () => void;
  confirmManualAssembly: () => Promise<void>;
  onManualAsmFileChange: (file: UploadFile) => void;
  onManualAsmFileRemove: () => void;
}

export function usePartBatchPdf(opts: UsePartBatchPdfOptions): UsePartBatchPdfReturn {
  const { customers, applicantSearch, successNextTab } = opts;
  const router = useRouter();

  const pdfForm = reactive<PdfFormState>({
    customerL1Id: null,
    requestDate: todayIso(),
  });

  // PDF Tab 一级客户切换 → 拉一次该客户下申请人全集。
  // useApplicantSearch.loadForCustomer 内部对同一 rootCustomerId 不重拉；
  // 切换到空客户则清空缓存。immediate: false 避免首次 null 时多余调用。
  watch(
    () => pdfForm.customerL1Id,
    (next) => {
      void applicantSearch.loadForCustomer(next);
    },
    { immediate: false },
  );

  /** Tab 2 PDF 批量上传专用：仅展示一级客户。 */
  const l1Customers = computed(() =>
    customers.value.filter((c) => c.parent_id === null).map((c) => ({ id: c.id, name: c.name })),
  );
  /** Tab 2 分厂下拉专用：所选 L1 的二级子客户。 */
  const l2Customers = computed(() =>
    pdfForm.customerL1Id
      ? customers.value
          .filter((c) => c.parent_id === pdfForm.customerL1Id)
          .map((c) => ({ id: c.id, name: c.name }))
      : [],
  );

  // PDF / Excel 文件列表（el-upload 控件绑定）
  const pdfFiles = ref<UploadFile[]>([]);
  const excelFiles = ref<UploadFile[]>([]);
  // 2026-10-03：Excel 解析结果上提为 composable 状态。
  // 此前它是 `rebuildFromUploads` 内的局部变量，解析完即丢 → 只有「首次解析」这一次调用点
  // 能回填；之后用户合并页（mergeSelectedAsPart / mergeSelectedAsAssembly）、手动新增
  // （confirmManualPart / confirmManualAssembly）新建的行全都拿不到 Excel 数据。
  // 它的生命周期必须跟着「已上传的 Excel 文件」走：Excel 被移除 / 提交后清空时置 null，
  // 避免用陈旧数据回填新行。
  const excelByDrawingNo = shallowRef<Map<string, BidRow> | null>(null);
  // PR-H 2026-07-28：3D 模型批量上传（.step / .stp / .iges / .igs / .stl / .obj / .3mf）
  const threeDModelFiles = ref<UploadFile[]>([]);
  const pdfBuildingTree = ref(false);
  const pdfSubmitting = ref(false);

  const allPdfs = ref<PdfSource[]>([]);
  /** 源文件区选中的页：key = `${pdfUid}:${pageIndex}`（pageIndex 0-based）。 */
  const selectedPages = ref<Set<string>>(new Set());
  const standaloneParts = ref<StandalonePartRow[]>([]);
  const assemblies = ref<AssemblyRow[]>([]);
  // PR-H 2026-07-28：拖拽排序 —— vue-draggable-plus 的 useDraggable composable
  // 在 setup 阶段调用一次后只在初始化时绑定一次目标 tbody；表格 DOM ref 必须
  // 由本 composable 持有（el-table tbody 会被 EP 重建），通过 provide 暴露给
  // PartBatchPdfTab 模板用 :ref 把实例回写到 ref。
  const standaloneTableRef = ref<{ $el?: HTMLElement } | null>(null);
  const assembliesTableRef = ref<{ $el?: HTMLElement } | null>(null);
  // useDraggable 真正要的 DOM 是 tbody；watcher 在 tableRef 解析后 query 出 tbody。
  const standaloneTbodyRef = ref<HTMLElement | null>(null);
  const assembliesTbodyRef = ref<HTMLElement | null>(null);

  /** 从 el-table 组件实例解析出 EP 渲染出的 tbody DOM。 */
  function resolveTbody(tableRef: Ref<{ $el?: HTMLElement } | null>): HTMLElement | null {
    return findElTableTbody(tableRef.value?.$el ?? null);
  }

  /** 只用于源文件区表格展示的原始（未合成）PDF。 */
  const originalPdfs = computed(() => allPdfs.value.filter((s) => !s.synthesized));
  // 2026-10-05：按 effectiveChildren 计数 —— 指定为总装图的那一页从子件里排除，
  // 表头计数必须与真正建出的子件数一致，否则用户按计数核对会多出一条。
  const totalAssemblyChildren = computed(() =>
    assemblies.value.reduce((sum, a) => sum + effectiveChildren(a).length, 0),
  );

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
  );

  // el-upload 钩子
  function onPdfChange(file: UploadFile): void {
    // 多文件上传会触发多次 on-change；用 fileList 状态自动管理
    pdfFiles.value = fileList(pdfFiles.value, file, '.pdf');
  }
  function onPdfRemove(file: UploadFile): void {
    pdfFiles.value = pdfFiles.value.filter((f) => f.uid !== file.uid);
  }
  function onExcelChange(file: UploadFile): void {
    excelFiles.value = fileList(excelFiles.value, file, '.xlsx,.xls', /*matchExt*/ true);
  }
  function onExcelRemove(file: UploadFile): void {
    excelFiles.value = excelFiles.value.filter((f) => f.uid !== file.uid);
    // 2026-10-03：Excel 文件被移除 → 解析快照同步作废（否则会用已不在列表里的
    // Excel 数据继续回填新建行）。无条件作废的依据是快照只来自 rebuildFromUploads
    // 读到的 `excelFiles.value[0]`：el-upload 未开 `multiple` 也拦不住再次选文件，
    // onExcelChange 走 fileList 的追加语义，列表可能多于 1 个，而快照只对应该次
    // 解析时的第 1 个文件；移除后第 1 个文件可能已换人、甚至列表已空，旧快照无从
    // 校验。取舍：宁可清空导致「少填」，也不要沿用旧快照错填。
    excelByDrawingNo.value = null;
  }
  // PR-H 2026-07-28：3D 模型上传钩子
  function onThreeDModelChange(file: UploadFile): void {
    threeDModelFiles.value = fileList(
      threeDModelFiles.value,
      file,
      '.step,.stp,.iges,.igs,.stl,.obj,.3mf',
    );
  }
  function onThreeDModelRemove(file: UploadFile): void {
    threeDModelFiles.value = threeDModelFiles.value.filter((f) => f.uid !== file.uid);
  }

  /** 把新 file push 到 list（去重 by uid），扩展名校称校验。 */
  function fileList(
    current: UploadFile[],
    file: UploadFile,
    accept: string,
    matchExt = false,
  ): UploadFile[] {
    if (current.some((f) => f.uid === file.uid)) return current;
    const name = (file.name || '').toLowerCase();
    const exts = accept.replace(/\./g, '').split(',');
    if (matchExt) {
      if (!exts.some((e) => name.endsWith('.' + e))) {
        ElMessage.warning(`不支持的文件类型：${file.name}`);
        return current;
      }
    }
    return [...current, file];
  }

  async function readExcel(file: File): Promise<BidRow[]> {
    const buf = await file.arrayBuffer();

    // 2026-09-21 对齐 TS 严格：动态 import 拿 xlsx 必须靠 typeof import() 反推类型。
    // 项目 eslint 规则 @typescript-eslint/consistent-type-imports 默认禁此内联写法，
    // 但本文件刻意保持动态 import 以避免 xlsx（~700KB）进首屏 bundle，故此处加行级豁免。
    // 已知风险见 docs/08-known-risks/dependency-risks.md。
    // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- 动态 import 故意不进主 bundle，类型只能内联 typeof import() 反推
    const XLSX: typeof import('xlsx') = await import('xlsx');
    const wb = XLSX.read(buf, { type: 'array' });
    const sheetNames = wb.SheetNames;
    let parsed: ParseResult;
    if (sheetNames.includes('历史价确认单明细')) {
      parsed = parseHistoricalPriceExcel(wb, todayIso());
    } else if (sheetNames.includes('招标项目-标的')) {
      parsed = parseBidExcel(wb, todayIso());
    } else {
      throw new Error(
        `Excel 格式无法识别（需要「历史价确认单明细」或「招标项目-标的」sheet），当前文件 sheet: ${sheetNames.join(', ')}`,
      );
    }
    if (parsed.errors.length > 0) {
      ElMessage.warning(`Excel 解析告警：${parsed.errors.length} 条（已忽略）`);
    }
    return parsed.rows;
  }

  /** 从 pdfFiles 重新构建 allPdfs + standaloneParts（不自动组成装配件）。
   *  多页 PDF → 每页独立成一行；单页 PDF → 一行。 */
  async function rebuildFromUploads(): Promise<void> {
    if (pdfFiles.value.length === 0) {
      ElMessage.warning('请先上传 PDF');
      return;
    }
    if (!pdfForm.customerL1Id) {
      ElMessage.warning('请选择一级客户');
      return;
    }
    // 提交 / 补传在途时重新解析 = 整表换新（行 uid 全换 + resetCommitState 清空
    // createdTargets），先行的 onSubmit 跑完还会照常收口 ⇒ 静默清空刚解析出的行、
    // 跳页、再弹「成功创建 0 条零件」。两道防线里这是第一道。
    if (guardRowMutation()) return;
    pdfBuildingTree.value = true;
    try {
      // 解析 Excel（可选）。2026-10-03：结果写进 composable 级 excelByDrawingNo，
      // 让后续「合并页 / 手动新增」新建的行也能回填（见该 ref 声明处注释）。
      excelByDrawingNo.value = null;
      if (excelFiles.value.length > 0) {
        const raw = excelFiles.value[0].raw as File | undefined;
        if (raw) {
          const rows = await readExcel(raw);
          excelByDrawingNo.value = new Map(rows.map((r) => [r.drawingNo, r]));
        }
      }

      const sources: PdfSource[] = [];
      const rows: StandalonePartRow[] = [];
      const unparsedPdfNames: string[] = [];

      for (const f of pdfFiles.value) {
        const raw = f.raw as File | undefined;
        if (!raw) continue;
        const fname = f.name;
        const parsed = parseDrawingFilename(fname);
        if (!parsed.drawingNo && !parsed.partName) {
          unparsedPdfNames.push(fname);
        }
        const totalPages = await countPdfPages(raw);
        const pdfUid = `pdf-${f.uid}`;
        sources.push({
          uid: pdfUid,
          raw,
          filename: fname,
          totalPages,
          synthesized: false,
        });
        if (totalPages === 1) {
          // 单页 PDF → 自动进独立零件表
          rows.push(
            makeStandaloneRow({
              pdfSourceUid: pdfUid,
              drawing_no: parsed.drawingNo || '',
              name: parsed.partName || '',
            }),
          );
        }
        // 多页 PDF 不预生成任何行；用户从源文件区显式选择页 → 合并
      }

      allPdfs.value = sources;
      standaloneParts.value = rows;
      assemblies.value = [];
      selectedPages.value = new Set();
      // 行 uid 全部换新 ⇒ 上一批的提交状态（工单 id 映射 / job / 失败清单 / 阶段机）
      // 再也对不上表里任何一行，留着只会让主按钮显示点不动的「重试上传」。
      // 上一批已建出的工单在服务端，本页无从补传（跨刷新取舍见文件头注释）。
      resetCommitState();
      // 全表回填：重新解析已整体替换 standaloneParts 并清空 assemblies，此刻表内
      // 每一行都是刚解析出来的新行，不存在「用户手改过的既有行」需要保护。
      applyExcelToAll();
      // PR-H 2026-07-28：按 drawing_no 把 3D 模型挂到对应独立零件 / 装配件子件行
      linkThreeDModelsToRows();

      if (unparsedPdfNames.length > 0) {
        ElMessage.warning(
          `以下 ${unparsedPdfNames.length} 个 PDF 文件名无法识别图号/名称，请手动填写：` +
            unparsedPdfNames.slice(0, 5).join('、') +
            (unparsedPdfNames.length > 5 ? ' …' : ''),
        );
      }
      ElMessage.success(`已解析：源 ${sources.length} 个 · 候选 ${rows.length} 页`);
    } catch (e) {
      ElMessage.error((e as Error).message ?? '解析失败');
    } finally {
      pdfBuildingTree.value = false;
    }
  }

  /** 回填作用域。契约（2026-10-03）：**传了就必须显式给全两侧**，某一侧没给就
   *  按「空集合」处理、绝不退回全量；只有**完全不传**才是「全表」语义。 */
  interface ExcelFillTarget {
    parts?: StandalonePartRow[];
    assemblies?: AssemblyRow[];
  }

  /** 用 Excel 行覆盖表内字段（applicant / quantity / planned_delivery_date + 分厂 L2 + 单价）。
   *  2026-07-30 起不再覆盖 is_urgent（批量 PDF 导入默认全部不加急，由用户手动 switch）。
   *
   *  数据源是 composable 级 `excelByDrawingNo`。没有 Excel 数据时静默返回（不抛错、不提示）
   *  —— 「没传 Excel」是完全正常的用法，不该打扰用户。
   *
   *  `target` **不传** = 全表（只有 `rebuildFromUploads` 走这条：它本就整体替换了
   *  `standaloneParts` 并清空 `assemblies`，表内全是刚解析出来的新行，不存在「用户
   *  手改过的既有行」需要保护）。`target` **已传** = 只回填它显式给出的集合，
   *  **没给的一侧按空集合处理，绝不退回全量**：全表重扫会把用户在另一侧（独立零件表
   *  ↔ 装配件表）手改过的数量 / 单价 / 总价 / 交期 / 申请人一起覆盖回 Excel 值
   *  （分厂有 `!customer_id` 守卫所以幸免），而「建行」这个动作与那些行无关。
   *  ⇒ 4 个建行入口（合并成零件 / 合并成装配件 / 手动新增零件 / 手动新增装配件）
   *  一律显式传入本次新建的行，且**只给本次涉及的那一侧**。 */
  function applyExcelToAll(target?: ExcelFillTarget): void {
    const excelMap = excelByDrawingNo.value;
    if (!excelMap) return;
    // 2026-10-03：作用域在进循环前一次性定死 —— 不传 = 两张表全量；传了 = 只用它
    //  给出的集合（缺侧即空）。先算成两个局部变量，是为了让「传了作用域就绝不兜回
    //  全量」这件事在代码里一眼可读，且不可能再被 `??` 悄悄改回隐式回落。
    const parts = target ? (target.parts ?? []) : standaloneParts.value;
    const asms = target ? (target.assemblies ?? []) : assemblies.value;
    for (const r of parts) {
      const matched = excelMap.get(r.drawing_no);
      if (!matched) continue;
      r.applicant_name = matched.applicantName || r.applicant_name;
      r.quantity = matched.quantity || r.quantity;
      // 2026-07-30：批量 PDF 导入不再从应标 Excel 继承 is_urgent，默认全部不加急；
      // 用户在 el-switch 单独打开加急。
      if (matched.plannedDeliveryDate) r.planned_delivery_date = matched.plannedDeliveryDate;
      // PR-H 2026-07-28：含税单价 / 总价
      if (matched.unitPrice != null) r.unit_price = matched.unitPrice;
      if (matched.totalPrice != null) r.total_price = matched.totalPrice;
      // 自动解析二级客户（分厂）
      if (!r.customer_id) {
        const l2Id = resolveL2CustomerId(matched.deptName);
        if (l2Id) {
          r.customer_id = l2Id;
          const c = customers.value.find((x) => x.id === l2Id);
          r.customer_name = c?.name ?? '';
        }
      }
    }
    for (const a of asms) {
      // 2026-10-11：顶层命中源为**装配件自身图号** `a.drawing_no`，且**不再有子件
      // 回退** —— 子件图号 / 名称已统一取源值（两个建行入口都不再拼 `-01 / -02`
      // 后缀），建行那一刻 `a.children[i].drawing_no` 与 `a.drawing_no` 恒等；本函数
      // 只在建行的同一 tick 里跑一次，草稿又是只写不恢复的（无「先建后改子件图号
      // 再回填」的时序），所以 `childHit` 分支已不可达，保留只会让人误以为子件图号
      // 还能与顶层不同。
      //
      // ⚠️ 随之而来的**已知代价**：Excel 的「物料编号」列若是旧口径的「逐个子件各占一行」
      // （那一行装的是子件自己的图号，那行的单价 / 数量是**子件口径**），顶层图号在表里
      // 查不到 ⇒ 这一行**整行都不回填**（分厂 / 申请人 / 数量 / 计划交期 / 单价 / 总价全部
      // 留空手填），不再是「只有价不回填、其余几列照填」。子件图号与装配件一致是产品定的
      // 口径，不做前缀模糊匹配：错的数字比空值危险。
      const ownHit = excelMap.get(a.drawing_no);
      if (ownHit) {
        // 分厂 / 申请人由顶层统一持有（子件不再各自持有这两个字段）
        if (!a.customer_id) {
          const l2Id = resolveL2CustomerId(ownHit.deptName);
          if (l2Id) {
            a.customer_id = l2Id;
            const c = customers.value.find((x) => x.id === l2Id);
            a.customer_name = c?.name ?? '';
          }
        }
        a.applicant_name = ownHit.applicantName || a.applicant_name;
        // 数量 = **整套数量**（业务口径：Excel 的数量是整套的数量）
        a.quantity = ownHit.quantity || a.quantity;
        if (ownHit.plannedDeliveryDate) a.planned_delivery_date = ownHit.plannedDeliveryDate;
        // `!= null` 只是类型防御：`BidRow.unitPrice` / `totalPrice` 声明为 `number`，
        // parser 已把空值 / 负数兜底成 0（`totalPrice` 缺列时是 `unitPrice * quantity`），
        // 永不为 null ⇒ 走不到短路，Excel 单元格为空时**照样**以 0 覆盖用户手填的单价。
        if (ownHit.unitPrice != null) a.unit_price = ownHit.unitPrice;
        if (ownHit.totalPrice != null) a.total_price = ownHit.totalPrice;
      }
      // 未命中（`ownHit` 为 undefined）时顶层整套价保持 null 等用户手填：Excel 的
      // 「物料编号」列装不进这个装配件的图号，硬套别的行的价格会与整套口径差一个套数
      // 倍率，错的数字比空值更危险。
      // 2026-10-05 子件口径（业务口径：分厂 / 申请人 / 计划交期 / 单价是整套共享的，
      // 子件数量与单价需手填）：
      //   - 计划交期：顶层填完后同步给全部子件，保证「整套一个交期」。交期既可能来自
      //     Excel，也可能来自用户在顶层手改（`onAsmPlannedChange`），两种来源都会同步
      //     下来；子件单独改过的交期会被顶层值覆盖，与该 handler 的简单覆盖语义一致。
      //   - quantity 保持 makeAssemblyChild 的默认值 1；
      //   - unit_price / total_price 保持 null 待手填。**子件单价不从 Excel 回填**：
      //     Excel 的含税单价是**整套**口径（同一行同时给出了整套数量和整套总价），
      //     摊到每个子件上会让 N 个子件把整套价重复计价 N 倍。要给子件单独定价就得
      //     人工按子件拆，用户在子件行的「含税单价」列自己填。
      if (a.planned_delivery_date) {
        for (const c of a.children) c.planned_delivery_date = a.planned_delivery_date;
      }
      // 2026-07-30：子件不从应标 Excel 继承 is_urgent（同独立零件，默认全部不加急）。
    }
  }

  /** 把 Excel 的「申请人所在一级部门名称」（如"二厂"）解析成 L2 客户 id。
   *  仅在所选 L1 客户的子客户里查找。 */
  function resolveL2CustomerId(deptName: string): string | null {
    if (!pdfForm.customerL1Id || !deptName) return null;
    const match = customers.value.find(
      (c) => c.parent_id === pdfForm.customerL1Id && c.name.trim() === deptName.trim(),
    );
    return match?.id ?? null;
  }

  /**
   * 单价改动 → 自动联动总价（PR-H 2026-07-28 起三类行共用）。
   *
   * 三类行（独立零件 / 装配件顶层 / 装配件子件）的联动公式完全一样：
   * `total_price = unit_price × quantity`。对装配件顶层，`quantity` 是**套数**
   * （`AssemblyRow.quantity`），所以算出来的是整套总价，与 Excel 的整套口径一致。
   *
   * 用户手改过总价后本函数会把它覆盖掉 —— 表格里总价列可编辑，用户想保自己的值
   * 就以那次手改为准再点一次单价。数量为 0 或单价为空时**不动**总价（避免清空
   * 单价顺手把已有总价也抹成 0）。
   */
  function linkTotalPrice(
    row: { quantity: number; unit_price: number | null; total_price: number | null },
    v: number | undefined,
  ): void {
    row.unit_price = v ?? null;
    if (row.quantity > 0 && row.unit_price != null) {
      row.total_price = row.unit_price * row.quantity;
    }
  }

  function onUnitPriceChange(row: StandalonePartRow, v: number | undefined): void {
    linkTotalPrice(row, v);
  }
  function onAsmUnitPriceChange(a: AssemblyRow, v: number | undefined): void {
    linkTotalPrice(a, v);
  }
  function onChildUnitPriceChange(c: AssemblyChildRow, v: number | undefined): void {
    linkTotalPrice(c, v);
  }

  /** PR-H 2026-07-28：3D 模型支持扩展名（与后端 _file_kind_policy.THREE_D_MODEL 对齐）。 */
  const THREE_D_EXTS = ['step', 'stp', 'iges', 'igs', 'stl', 'obj', '3mf'];

  /** 把 3D 模型按文件名解析的 drawing_no 自动挂到独立零件 / 装配件子件行。
   *  - 文件名约定：图号_名称.ext（与 PDF 解析共用 `parseDrawingFilename`，先剥扩展名）。
   *  - 已挂过该图号的 → 跳过（不重复挂）。
   *  - 找不到匹配行 → ElMessage.warning（不报错，整批仍可提交）。
   *
   *  2026-10-11 核实：子件图号不再拼后缀、拆分出的独立行也同图号，但**按图号 `find`
   *  不会误挂** —— 唯一调用点是 `rebuildFromUploads`，它在本函数之前刚把
   *  `standaloneParts` 整体替换成「单页 PDF 一行」的全新数组并 `assemblies.value = []`，
   * 此刻表内没有任何合并 / 拆分产生的行，且一个图号最多一行；`mergeSelectedAsAssembly` /
   *  `splitStandalonePart` 都在这一轮之后才跑，且**不再调用**本函数（它们建出的行
   *  `three_d_index` 恒 null = 无 3D 模型，与改动前一致）。 */
  function linkThreeDModelsToRows(): void {
    if (threeDModelFiles.value.length === 0) return;
    const warns: string[] = [];
    threeDModelFiles.value.forEach((f, idx) => {
      const raw = f.raw as File | undefined;
      if (!raw) return;
      const fname = f.name;
      const noExt = THREE_D_EXTS.reduce(
        (acc, ext) => acc.replace(new RegExp(`\\.${ext}$`, 'i'), ''),
        fname,
      );
      const parsed = parseDrawingFilename(`${noExt}.pdf`); // 复用 PDF 解析逻辑
      if (!parsed.drawingNo) {
        warns.push(`3D 模型「${fname}」文件名无法识别图号，已忽略`);
        return;
      }
      // 先尝试独立零件，再试装配件子件
      const spMatch = standaloneParts.value.find((r) => r.drawing_no === parsed.drawingNo);
      if (spMatch) {
        if (spMatch.three_d_index != null) {
          warns.push(`图号 ${parsed.drawingNo} 已挂载 3D 模型，跳过「${fname}」`);
          return;
        }
        spMatch.three_d_index = idx;
        return;
      }
      let attached = false;
      for (const a of assemblies.value) {
        const childMatch = a.children.find((c) => c.drawing_no === parsed.drawingNo);
        if (childMatch) {
          if (childMatch.three_d_index != null) {
            warns.push(`图号 ${parsed.drawingNo} 已挂载 3D 模型，跳过「${fname}」`);
            attached = true;
            break;
          }
          childMatch.three_d_index = idx;
          attached = true;
          break;
        }
      }
      if (!attached) warns.push(`未找到图号 ${parsed.drawingNo} 对应零件行，已忽略「${fname}」`);
    });
    if (warns.length > 0) {
      ElMessage.warning(
        `3D 模型挂载提示（${warns.length} 条）：\n` +
          warns.slice(0, 5).join('\n') +
          (warns.length > 5 ? '\n…' : ''),
      );
    }
  }

  /** 默认表单填充一个独立零件行。 */
  function makeStandaloneRow(opts: {
    pdfSourceUid: string;
    drawing_no: string;
    name: string;
    pageCount?: number;
    mergedFrom?: { pdfUid: string; pageIndex: number }[];
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
    };
  }

  /** 装配件子件默认填充（分厂 / 申请人由顶层 AssemblyRow 指定）。 */
  function makeAssemblyChild(opts: {
    pdfSourceUid: string;
    pageIndex: number;
    drawing_no: string;
    name: string;
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
    };
  }

  /** 装配件顶层默认填充（2026-10-05 新增：与两个建行入口共用，避免字段漏填）。
   *  分厂 / 申请人 / 单价 / 总价初始全空，由 `applyExcelToAll` 回填或用户手填。
   *  `masterPdfSourceUid` 与 `masterPageIndex` 成对：默认两者皆 null = 无总装图。 */
  function makeAssemblyRow(opts: {
    pdfSourceUid: string;
    drawing_no: string;
    name: string;
    masterPageIndex: number | null;
    masterPdfSourceUid: string | null;
    children: AssemblyChildRow[];
  }): AssemblyRow {
    return {
      uid: `asm-${makeUid()}`,
      pdfSourceUid: opts.pdfSourceUid,
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
      masterPageIndex: opts.masterPageIndex,
      masterPdfSourceUid: opts.masterPdfSourceUid,
      quantity: 1,
      unit_price: null,
      total_price: null,
      children: opts.children,
    };
  }

  // ============ PDF 文件名点击预览 ============
  const pdfPreviewing = ref<PdfPreviewState | null>(null);
  const pdfPreviewVisible = ref(false);

  /** 打开预览（通用入口）：传入 pdfSourceUid 和起始页（1-indexed）。 */
  function previewAt(pdfSourceUid: string, title: string, page: number): void {
    if (pdfPreviewing.value) {
      try {
        URL.revokeObjectURL(pdfPreviewing.value.url);
      } catch {
        /* ignore */
      }
    }
    const src = allPdfs.value.find((s) => s.uid === pdfSourceUid);
    if (!src) {
      ElMessage.warning('PDF 不可用');
      return;
    }
    pdfPreviewing.value = {
      url: URL.createObjectURL(src.raw),
      title,
      page,
    };
    pdfPreviewVisible.value = true;
  }

  /** 关闭预览：revoke URL，清状态。el-dialog `:before-close` 会调。 */
  function closePdfPreview(): void {
    if (pdfPreviewing.value) {
      try {
        URL.revokeObjectURL(pdfPreviewing.value.url);
      } catch {
        /* ignore */
      }
      pdfPreviewing.value = null;
    }
    pdfPreviewVisible.value = false;
  }

  // ============ 拖拽排序（vue-draggable-plus useLazyDraggable） ============
  // PR-H 2026-07-28：拖动 handle 列重排行顺序。
  // - 不接受嵌套展开行（child-table 不挂 sortable）；仅顶层独立零件 / 装配件行。
  // - 2026-08-27 fix：两个 tbodyRef 在 setup 时均为 null，useDraggable 默认 immediate
  //   会在挂载时 new Sortable(null) 抛错。改用 useLazyDraggable：给 ref 赋值即自动重绑，
  //   覆盖 el-table 首次挂载与 EP 重建 tbody（行数变化 / v-if）两种时机。
  // - 表格 DOM ref 由本 composable 持有，通过 provide('partBatchPdfRefs') 暴露
  //   给 PartBatchPdfTab，模板用 :ref 回写。
  /** 拖拽收尾：把 list 从 oldIndex 挪到 newIndex，返回原地复制的 list 给响应式。 */
  function makeOnEnd<T>(list: Ref<T[]>) {
    return (evt: { oldIndex?: number; newIndex?: number }) => {
      const { oldIndex, newIndex } = evt;
      if (oldIndex == null || newIndex == null || oldIndex === newIndex) return;
      const next = list.value.slice();
      const [moved] = next.splice(oldIndex, 1);
      if (moved) next.splice(newIndex, 0, moved);
      list.value = next;
    };
  }
  useLazyDraggable(standaloneTbodyRef, standaloneParts, {
    handle: '.drag-handle',
    draggable: 'tr',
    animation: 150,
    ghostClass: 'sortable-ghost',
    onEnd: makeOnEnd(standaloneParts),
  });
  useLazyDraggable(assembliesTbodyRef, assemblies, {
    handle: '.drag-handle',
    draggable: 'tr',
    animation: 150,
    ghostClass: 'sortable-ghost',
    onEnd: makeOnEnd(assemblies),
  });

  // 监听 tableRef 变化 → 重新解析 tbody 写回 ref；useLazyDraggable 内部 watcher 接管重绑。
  // 触发时机：el-table 首次挂载、行数变化（v-if / 数据长度变化）让 EP 重建 tbody。
  watch(
    standaloneTableRef,
    () => {
      standaloneTbodyRef.value = resolveTbody(standaloneTableRef);
    },
    { flush: 'post' },
  );
  watch(
    assembliesTableRef,
    () => {
      assembliesTbodyRef.value = resolveTbody(assembliesTableRef);
    },
    { flush: 'post' },
  );

  // 把 tableRef 暴露给 PartBatchPdfTab：provide 注入，避免通过 v-bind 摊开
  // 时 props readonly 静默丢写。
  provide('partBatchPdfRefs', { standaloneTableRef, assembliesTableRef });

  // ============ 源文件区：勾选 + 归组 + 删除 ============

  /** el-table type=selection 回调：把选中的 SourceTreeRow 扁平化成页 UID 集合。
   *  顶层被选中 → 等价于「该 PDF 全部页」。 */
  function onSourceSelectionChange(rows: SourceTreeRow[]): void {
    const next = new Set<string>();
    for (const r of rows) {
      if (r.pageIndex !== null) {
        next.add(pageUid(r.pdfSourceUid, r.pageIndex));
      } else {
        const src = allPdfs.value.find((s) => s.uid === r.pdfSourceUid);
        if (src) for (let p = 0; p < src.totalPages; p++) next.add(pageUid(r.pdfSourceUid, p));
      }
    }
    selectedPages.value = next;
  }

  /** 源文件区点击文件名预览。顶层 → 第 1 页；子页 → 对应页。 */
  function previewSourceRow(row: SourceTreeRow): void {
    const page = row.pageIndex === null ? 1 : row.pageIndex + 1;
    previewAt(row.pdfSourceUid, `${row.filename} 预览`, page);
  }

  // el-table 类型来自 element-plus 类型导出，运行时为函数组件；用宽松类型包住。
  // el-table ref 现在由 PartBatchPdfTab 持有；外部调用（清空选择按钮）需传 ref，
  // composable 内部 merge 后调用可不传 —— 只重置 selectedPages 状态。
  function clearSelection(table?: { clearSelection: () => void } | null): void {
    table?.clearSelection();
    selectedPages.value = new Set();
  }

  /**
   * 加载源 PDF 文档。一次建行里的多次切页共用它，避免 N 页就 load N 次（load 要重解
   * 整份 xref，代价随页数线性涨）。
   */
  async function loadPdfDoc(raw: Blob): Promise<PdfLibDocument> {
    const { PDFDocument } = await import('pdf-lib');
    return PDFDocument.load(await raw.arrayBuffer());
  }

  /** 从已加载的 srcDoc 切出 pageIndices（0-based）指定的页 → 新 PDF Blob。 */
  async function copyPagesFrom(srcDoc: PdfLibDocument, pageIndices: number[]): Promise<Blob> {
    const { PDFDocument } = await import('pdf-lib');
    const out = await PDFDocument.create();
    const copied = await out.copyPages(srcDoc, pageIndices);
    copied.forEach((p) => out.addPage(p));
    const bytes = await out.save();
    // pdf-lib save() 返回 Uint8Array<ArrayBufferLike>，TS 5+ 要求 BlobPart 严格是
    // ArrayBuffer 类型；slice() 拷贝出独立 ArrayBuffer，避开 SharedArrayBuffer 误判。
    return new Blob([bytes.slice().buffer as ArrayBuffer], { type: 'application/pdf' });
  }

  /** 用 pdf-lib 合并 PDF 的指定页（0-based pageIndices）→ 新 PDF Blob。 */
  async function mergePages(raw: Blob, pageIndices: number[]): Promise<Blob> {
    return copyPagesFrom(await loadPdfDoc(raw), pageIndices);
  }

  /**
   * 切出 1 页并登记成 PdfSource（`syn-` 约定），返回新 source。
   *
   * 2026-10-05：装配件的每个子件 / 总装图各自持有一份**单页切片**，`uid` 天然唯一 ⇒
   * 上传时一个 entry 对应一个目标实体（顶层与 N 个子件共享整份多页 PDF 会让打印把每一页
   * 在每个子件上重复输出）。`originPdfUid` 指向原始 PDF，`removePdf` 靠它级联清理这些切片。
   */
  async function pushPageSlice(
    src: PdfSource,
    srcDoc: PdfLibDocument,
    pageIndex: number,
  ): Promise<PdfSource> {
    const slice: PdfSource = {
      uid: `syn-${makeUid()}`,
      raw: await copyPagesFrom(srcDoc, [pageIndex]),
      filename: `${stripExt(src.filename)}_p${pageIndex + 1}.pdf`,
      totalPages: 1,
      synthesized: true,
      synthesizedFrom: [{ pdfUid: src.uid, pageIndices: [pageIndex] }],
      originPdfUid: src.uid,
    };
    allPdfs.value.push(slice);
    return slice;
  }

  /**
   * 把本轮已登记的 PdfSource 按 uid 从 `allPdfs` 摘掉（切页中途失败时的回滚）。
   *
   * 2026-10-05：切片是循环里逐个 push 进去的，失败时装配件行还没建出来 ⇒ 这批切片没有
   * 任何行引用，也不在源文件区显示（`originalPdfs` 只留 `!synthesized`），用户既看不到
   * 也删不掉，纯占内存（切到第 40 页失败 = 前 39 份单页 Blob 悬空）。失败即整批摘掉，
   * 保持「一次建行要么全成、要么什么都不留」。
   */
  function rollbackPushedSources(uid: string[]): void {
    if (uid.length === 0) return;
    const owned = new Set(uid);
    allPdfs.value = allPdfs.value.filter((s) => !owned.has(s.uid));
  }

  /**
   * 切页失败的提示文案。**必须带出是哪个文件**：源文件区有多份 PDF 时，只说「解析失败」
   * 用户无从判断是哪一份出了问题。
   *
   * 2026-10-05：pdf-lib 对加密 PDF 抛 `EncryptedPDFError`、对 xref 异常的 PDF 抛
   * `ParseError`（pdfjs 能正常读，源文件区已经能看到页），所以「能预览」不代表
   * 「能切页」。三个建行入口的按钮都是裸 `@click`（Vue 不接 handler 返回的 promise），
   * 不兜住就是 unhandled rejection：不建行、不提示、用户只看到按钮按了没反应。
   */
  function sliceFailedMessage(src: PdfSource, e: unknown): string {
    return `切页失败：无法从「${src.filename}」切出单页 PDF（${errorReason(e)}）`;
  }

  /**
   * 读不出页数时的提示。与 `sliceFailedMessage` **刻意分开**：这是另一个失败面 ——
   * 手动新增的这份 PDF 从没进过 `rebuildFromUploads`（那里 pdfjs 读不动会整批中断并
   * 弹「解析失败」），所以走到这里还读不出页数只可能是这份文件本身 pdfjs 就打不开。
   * 混进「切页失败」会让用户以为坏的是切页那一步，换份文件重试也还是这句。
   */
  function pageCountFailedMessage(src: PdfSource, e: unknown): string {
    return `无法读取「${src.filename}」的页数，子件数量无法确定（${errorReason(e)}）`;
  }

  /** 异常 → 提示里的一句话原因（两个失败文案共用同一口径）。 */
  function errorReason(e: unknown): string {
    return e instanceof Error && e.message ? e.message : '未知原因';
  }

  /** 切页在途标记。模块内局部量，不进对外返回面（模板拿不到、也就无从 `:loading`）。 */
  let pageSlicing = false;

  /**
   * 切页前的重入闸门：已在切页就拒掉本次点击（返回 true = 调用方应直接 return）。
   *
   * 2026-10-05：切页是主线程同步计算（load 要重解整份 xref，再逐页 create/copyPages/
   * save），几百页会假死数秒；期间按钮既无 loading 也未禁用，可连点 ⇒ 建出两行重复装配件
   *（`POST /assemblies` 无幂等键）。这里只做函数级拦截。
   */
  function rejectIfSlicing(): boolean {
    if (!pageSlicing) return false;
    ElMessage.warning('正在切页，请稍候');
    return true;
  }

  /** 把选中页按 pdfUid 分组。 */
  function selectedByPdf(): Map<string, number[]> {
    const m = new Map<string, number[]>();
    for (const k of selectedPages.value) {
      const { pdfUid, pageIndex } = parsePageUid(k);
      const arr = m.get(pdfUid) ?? [];
      arr.push(pageIndex);
      m.set(pdfUid, arr);
    }
    for (const arr of m.values()) arr.sort((a, b) => a - b);
    return m;
  }

  /** 合并选中页 → 一个独立零件（同一 PDF）。 */
  async function mergeSelectedAsPart(): Promise<void> {
    if (guardRowMutation()) return;
    if (rejectIfSlicing()) return;
    const byPdf = selectedByPdf();
    if (byPdf.size === 0) {
      ElMessage.warning('请先勾选页');
      return;
    }
    if (byPdf.size > 1) {
      ElMessage.warning('合并为零件的页必须来自同一 PDF');
      return;
    }
    const [pdfUid, pageIndices] = [...byPdf.entries()][0];
    const src = allPdfs.value.find((s) => s.uid === pdfUid);
    if (!src) return;

    let created: StandalonePartRow;
    if (pageIndices.length === src.totalPages) {
      // 全部页 → 直接复用原 PDF，无合成
      created = makeStandaloneRow({
        pdfSourceUid: pdfUid,
        drawing_no: parseDrawingFilename(src.filename).drawingNo || '',
        name: parseDrawingFilename(src.filename).partName || '',
      });
    } else {
      // 部分页 → pdf-lib 合成
      // 2026-10-05：与「合并为装配件」/「手动新增装配件」同一口径 —— 按钮是裸 `@click`，
      // pdf-lib 抛错时原本是 unhandled rejection（不建行、不提示、按钮看着像坏了）。
      // 回滚集合天然为空：合成产物是 `mergePages` 成功之后才 push 进 allPdfs 的，
      // 抛错时一个条目都没登记，没有半成品要摘。
      pageSlicing = true;
      let merged: Blob;
      try {
        merged = await mergePages(src.raw, pageIndices);
      } catch (e) {
        ElMessage.error(sliceFailedMessage(src, e));
        return;
      } finally {
        pageSlicing = false;
      }
      const newUid = `syn-${makeUid()}`;
      allPdfs.value.push({
        uid: newUid,
        raw: merged,
        filename: `${stripExt(src.filename)}_p${pageIndices.map((i) => i + 1).join('+')}.pdf`,
        totalPages: pageIndices.length,
        synthesized: true,
        synthesizedFrom: [{ pdfUid, pageIndices }],
        originPdfUid: pdfUid,
      });
      created = makeStandaloneRow({
        pdfSourceUid: newUid,
        pageCount: pageIndices.length,
        mergedFrom: pageIndices.map((i) => ({ pdfUid, pageIndex: i })),
        drawing_no: parseDrawingFilename(src.filename).drawingNo || '',
        name: parseDrawingFilename(src.filename).partName || '',
      });
    }
    standaloneParts.value.push(created);
    // 移除原 standalone 行（如果存在）
    clearSelection();
    // 2026-10-03：只回填本次新建的这一行 —— 全表重扫会把用户在其他行上手改过的
    // 数量 / 单价 / 交期 / 申请人覆盖回 Excel 值。
    applyExcelToAll({ parts: [created] });
    ElMessage.success(`已合并 ${pageIndices.length} 页 → 独立零件`);
  }

  /** 合并选中页 → 一个装配件（同一 PDF，至少 2 页）。 */
  async function mergeSelectedAsAssembly(): Promise<void> {
    if (guardRowMutation()) return;
    if (rejectIfSlicing()) return;
    const byPdf = selectedByPdf();
    if (byPdf.size === 0) {
      ElMessage.warning('请先勾选页');
      return;
    }
    if (byPdf.size > 1) {
      ElMessage.warning('合并为装配件的页必须来自同一 PDF');
      return;
    }
    const [pdfUid, pageIndices] = [...byPdf.entries()][0];
    if (pageIndices.length < 2) {
      ElMessage.warning('合并为装配件至少需要 2 页');
      return;
    }
    const src = allPdfs.value.find((s) => s.uid === pdfUid);
    if (!src) return;
    const parsed = parseDrawingFilename(src.filename);
    // 2026-10-05：每个子件切出**自己那一页**的单页 PDF（load 一次，逐页切）。校验全过
    // 才占重入闸门，所以上面那些 early return 不必各自释放。
    pageSlicing = true;
    const slices: PdfSource[] = [];
    try {
      const srcDoc = await loadPdfDoc(src.raw);
      for (const pi of pageIndices) slices.push(await pushPageSlice(src, srcDoc, pi));
    } catch (e) {
      rollbackPushedSources(slices.map((s) => s.uid));
      ElMessage.error(sliceFailedMessage(src, e));
      return;
    } finally {
      pageSlicing = false;
    }
    // 2026-10-11 口径变更：子件图号 / 名称**直接取源值**，不再按页码拼 `-02 / -03`
    // 后缀 —— 合并为装配件后所有子件与装配件保持一致（后端对 children 是纯透传，
    // `t_part.drawing_no` 也无唯一约束，`t_part.serial_no` 由 `{asm_serial}-{i:02d}`
    // 独立保证，天然允许同图号多行）。
    const children: AssemblyChildRow[] = pageIndices.map((pi, i) =>
      makeAssemblyChild({
        pdfSourceUid: slices[i]!.uid,
        pageIndex: pi,
        drawing_no: parsed.drawingNo || '',
        name: parsed.partName || '',
      }),
    );
    const created = makeAssemblyRow({
      // 顶层 pdfSourceUid 仍是**原始** PDF：源文件区预览 / removePdf 级联清理依赖它
      pdfSourceUid: pdfUid,
      drawing_no: parsed.drawingNo || '',
      name: parsed.partName || '',
      // 默认「无总装图」：不产生 ASSEMBLY_MASTER 文件，打印既不出总装图也不出
      // 该装配件的序列号背面。要指定某页作总装图由用户在下拉里选。
      masterPageIndex: null,
      masterPdfSourceUid: null,
      children,
    });
    assemblies.value.push(created);
    clearSelection();
    // 2026-10-03：只回填本次新建的这一个装配件（含其子件交期同步），不动其它装配件。
    applyExcelToAll({ assemblies: [created] });
    ElMessage.success(`已合并 ${pageIndices.length} 页 → 装配件`);
  }

  /** 拆分：把合成后的独立零件拆回 N 个单页行。 */
  function splitStandalonePart(row: StandalonePartRow): void {
    if (!row.mergedFrom || row.mergedFrom.length === 0) return;
    // 找到原始 PDF
    const originUid = row.mergedFrom[0].pdfUid;
    const src = allPdfs.value.find((s) => s.uid === originUid);
    if (!src) {
      ElMessage.error('原 PDF 已不存在，无法拆分');
      return;
    }
    // 按 pageIndex 排序，逐页创建独立行
    const sorted = [...row.mergedFrom].sort((a, b) => a.pageIndex - b.pageIndex);
    // 2026-10-11：拆出的多行**同图号同名称**（直接取源 PDF 文件名解析结果）。
    // 拆开后的行本就是独立零件，与合成行同图号是必然结果 —— `t_part.drawing_no`
    // 无唯一约束，唯一性由 `serial_no` 单独保证。
    const parsed = parseDrawingFilename(src.filename);
    // 每页一行：字段全部来自同一个源文件，逐页循环只是行数不同
    for (const _page of sorted) {
      standaloneParts.value.push(
        makeStandaloneRow({
          pdfSourceUid: originUid,
          drawing_no: parsed.drawingNo || '',
          name: parsed.partName || '',
        }),
      );
    }
    // 删除合成 PDF（若已合并成 part，且 part 是唯一引用）
    const synthUid = row.pdfSourceUid;
    if (synthUid.startsWith('syn-')) {
      allPdfs.value = allPdfs.value.filter((s) => s.uid !== synthUid);
    }
    standaloneParts.value = standaloneParts.value.filter((r) => r.uid !== row.uid);
    ElMessage.success(`已拆回 ${sorted.length} 页`);
  }

  /** 删除一个原 PDF：连带删除合成 PDF + 引用它的所有 part / assembly。 */
  function removePdf(pdfUid: string): void {
    if (!allPdfs.value.some((s) => s.uid === pdfUid)) return;
    // 1. 找出要删除的源：原 PDF + 它的所有合成派生
    const removeUids = new Set<string>([pdfUid]);
    allPdfs.value.filter((s) => s.originPdfUid === pdfUid).forEach((s) => removeUids.add(s.uid));
    // 2. 从 allPdfs 移除
    allPdfs.value = allPdfs.value.filter((s) => !removeUids.has(s.uid));
    // 3. 清理 standaloneParts
    standaloneParts.value = standaloneParts.value.filter((r) => !removeUids.has(r.pdfSourceUid));
    // 4. 清理 assemblies
    assemblies.value = assemblies.value.filter((a) => !removeUids.has(a.pdfSourceUid));
    // 5. 清理 selection
    const next = new Set<string>();
    for (const k of selectedPages.value) {
      if (!removeUids.has(parsePageUid(k).pdfUid)) next.add(k);
    }
    selectedPages.value = next;
    // 6. 从 el-upload pdfFiles 移除原 UploadFile（pdfUid = "pdf-<uploadFileUid>"）
    const uploadUid = pdfUid.startsWith('pdf-') ? pdfUid.slice(4) : null;
    if (uploadUid) {
      pdfFiles.value = pdfFiles.value.filter((f) => String(f.uid) !== uploadUid);
    }
  }

  function removeStandalonePart(uid: string): void {
    const row = standaloneParts.value.find((r) => r.uid === uid);
    if (!row) return;
    // 若是合成行，删除合成 PDF
    if (row.pdfSourceUid.startsWith('syn-')) {
      allPdfs.value = allPdfs.value.filter((s) => s.uid !== row.pdfSourceUid);
    }
    standaloneParts.value = standaloneParts.value.filter((r) => r.uid !== uid);
  }

  /**
   * 删除一个装配件行，并把它持有的单页切片（`syn-` 开头）从 `allPdfs` 里摘掉 ——
   * 切片只在建这一行时产生、行删了就没有引用，留在 allPdfs 里只是堆无人使用的 Blob。
   * 仍被其它行引用的切片不动（`Set` 去重：总装图切片与对应子件的切片是同一个 uid）。
   */
  function removeAssembly(uid: string): void {
    const row = assemblies.value.find((a) => a.uid === uid);
    if (!row) return;
    assemblies.value = assemblies.value.filter((a) => a.uid !== uid);
    const owned = new Set<string>();
    if (row.masterPdfSourceUid) owned.add(row.masterPdfSourceUid);
    for (const c of row.children) owned.add(c.pdfSourceUid);
    if (owned.size === 0) return;
    const stillUsed = new Set<string>();
    for (const r of standaloneParts.value) stillUsed.add(r.pdfSourceUid);
    for (const a of assemblies.value) {
      stillUsed.add(a.pdfSourceUid);
      if (a.masterPdfSourceUid) stillUsed.add(a.masterPdfSourceUid);
      for (const c of a.children) stillUsed.add(c.pdfSourceUid);
    }
    allPdfs.value = allPdfs.value.filter(
      (s) => !(s.uid.startsWith('syn-') && owned.has(s.uid) && !stillUsed.has(s.uid)),
    );
  }

  /** 展示用：把 PdfSource uid 翻译成可读文件名 + 页数。 */
  function pdfSourceLabel(uid: string): string {
    const src = allPdfs.value.find((s) => s.uid === uid);
    if (!src) return '(已删除)';
    return src.synthesized
      ? `${src.filename}（合成 ${src.totalPages} 页）`
      : `${src.filename}（${src.totalPages} 页）`;
  }

  /** 预览独立零件 / 装配件图纸。 */
  function previewStandalonePart(row: StandalonePartRow): void {
    previewAt(row.pdfSourceUid, `${row.drawing_no || row.name} 预览`, 1);
  }
  function previewPdfSourceByUid(uid: string): void {
    previewAt(uid, `${pdfSourceLabel(uid)} 预览`, 1);
  }

  /** 行（standalone / child）分厂下拉 onChange：同步 customer_name。 */
  function onL2Change(row: { customer_id: string; customer_name?: string }, v: string): void {
    row.customer_id = v;
    const c = customers.value.find((x) => x.id === v);
    row.customer_name = c?.name ?? '';
  }

  /** 装配件顶层计划交期改值 → 同步所有子件。简单覆盖语义：child 单独改后
   *  下次顶层改会被覆盖（如需「记住 child 单独覆盖」需加 flag 字段，本轮不做）。 */
  function onAsmPlannedChange(asmRow: AssemblyRow, v: string): void {
    asmRow.planned_delivery_date = v;
    for (const c of asmRow.children) c.planned_delivery_date = v;
  }

  /**
   * 实际建出的子件：被指定为总装图的那一页从子件里排除。
   * 表格里仍然渲染完整 `a.children`（下拉选项来自它、用户填的图号 / 交期不能丢），
   * 但建单 / 上传 / 计数一律走本函数。
   *
   * 排除是为了「页不重不漏」：总装图单独走 `kind=ASSEMBLY_MASTER`，若同一页又作为子件
   * 存在，打印会在总装图页之外再输出一次该页。
   */
  function effectiveChildren(a: AssemblyRow): AssemblyChildRow[] {
    if (a.masterPageIndex === null) return a.children;
    return a.children.filter((c) => c.page_index !== a.masterPageIndex);
  }

  /**
   * 总装图下拉改值：同时维护 `masterPageIndex` 与 `masterPdfSourceUid`（后者是那个
   * 子件的切片，提交 / 上传 / 状态格都按它寻址）。
   *
   * 判空用 `typeof v !== 'number'`：el-select 清空 emit 的是 `undefined`
   * （应用层配了 `value-on-clear` 时可能是 `''`），都按「无总装图」处理。
   */
  function onAsmMasterPageChange(a: AssemblyRow, v: number | null | undefined): void {
    if (typeof v !== 'number') {
      a.masterPageIndex = null;
      a.masterPdfSourceUid = null;
      return;
    }
    a.masterPageIndex = v;
    const child = a.children.find((c) => c.page_index === v);
    if (!child) {
      // 下拉选项就是从 children 生成的，理论上到不了这里。真到了说明 children 被
      // 换过（草稿恢复 / 将来新增的入口），宁可提示也不要静默按「无」提交。
      a.masterPdfSourceUid = null;
      ElMessage.warning('总装图选中的页在子件表里找不到，已按「无总装图」处理');
      return;
    }
    a.masterPdfSourceUid = child.pdfSourceUid;
  }

  // ============ 手动新增零件 / 装配件 ============
  const manualPartDialogVisible = ref(false);
  const manualPartForm = reactive<{
    drawing_no: string;
    name: string;
    file: File | null;
  }>({ drawing_no: '', name: '', file: null });
  const manualPartFileList = computed<UploadFile[]>(() =>
    manualPartForm.file
      ? [
          {
            uid: -1,
            name: manualPartForm.file.name,
            status: 'success',
            raw: manualPartForm.file as UploadFile['raw'],
          },
        ]
      : [],
  );
  const manualPartFormValid = computed(
    () => manualPartForm.drawing_no.trim().length > 0 && manualPartForm.file !== null,
  );

  function addManualPart(): void {
    manualPartForm.drawing_no = '';
    manualPartForm.name = '';
    manualPartForm.file = null;
    manualPartDialogVisible.value = true;
  }

  function onManualPartFileChange(file: UploadFile): void {
    manualPartForm.file = (file.raw as File | undefined) ?? null;
  }

  function onManualPartFileRemove(): void {
    manualPartForm.file = null;
  }

  async function confirmManualPart(): Promise<void> {
    if (guardRowMutation()) return;
    if (!manualPartFormValid.value) return;
    const f = manualPartForm.file!;
    const pdfUid = `manual-${makeUid()}`;
    allPdfs.value.push({
      uid: pdfUid,
      raw: f,
      filename: f.name,
      totalPages: 1,
      synthesized: false,
    });
    const created = makeStandaloneRow({
      pdfSourceUid: pdfUid,
      drawing_no: manualPartForm.drawing_no.trim(),
      name: manualPartForm.name.trim(),
    });
    standaloneParts.value.push(created);
    manualPartDialogVisible.value = false;
    // 2026-10-03：只回填本次新建的这一行（Excel 数据在 composable 级状态里活着）。
    applyExcelToAll({ parts: [created] });
    ElMessage.success('已新增零件');
  }

  /** 模板里点「取消」按钮的关闭动作。 */
  function closeManualPartDialog(): void {
    manualPartDialogVisible.value = false;
  }
  function closeManualAsmDialog(): void {
    manualAsmDialogVisible.value = false;
  }

  const manualAsmDialogVisible = ref(false);
  const manualAsmForm = reactive<{
    drawing_no: string;
    name: string;
    file: File | null;
  }>({ drawing_no: '', name: '', file: null });
  const manualAsmFileList = computed<UploadFile[]>(() =>
    manualAsmForm.file
      ? [
          {
            uid: -2,
            name: manualAsmForm.file.name,
            status: 'success',
            raw: manualAsmForm.file as UploadFile['raw'],
          },
        ]
      : [],
  );
  const manualAsmFormValid = computed(
    () => manualAsmForm.drawing_no.trim().length > 0 && manualAsmForm.file !== null,
  );

  function addManualAssembly(): void {
    manualAsmForm.drawing_no = '';
    manualAsmForm.name = '';
    manualAsmForm.file = null;
    manualAsmDialogVisible.value = true;
  }

  function onManualAsmFileChange(file: UploadFile): void {
    manualAsmForm.file = (file.raw as File | undefined) ?? null;
  }

  function onManualAsmFileRemove(): void {
    manualAsmForm.file = null;
  }

  async function confirmManualAssembly(): Promise<void> {
    if (guardRowMutation()) return;
    if (rejectIfSlicing()) return;
    if (!manualAsmFormValid.value) return;
    const f = manualAsmForm.file!;
    const pdfUid = `manual-asm-${makeUid()}`;
    const manualSource: PdfSource = {
      uid: pdfUid,
      raw: f,
      filename: f.name,
      // 下面读出页数后就地补上；先给 0 是为了让失败提示能用上这个 source（带文件名）
      totalPages: 0,
      synthesized: false,
    };
    // 2026-10-05：与「合并为装配件」同一口径 —— 每个子件只持自己那一页的单页切片。
    // 原始 PDF 也进 allPdfs，一起纳入回滚：切页失败时行没建出来，留着它会让用户重试时
    // 多出一份重复的源文件（源文件区是按 `!synthesized` 展示的，删得掉但看不见因果）。
    //
    // 重入闸门必须占在**任何 await 之前**：`countPdfPages` 是这里最慢的一步（pdfjs 要解析
    // 整份文件），占晚了对话框「添加」按钮在解析期间就变成可连点 ⇒ 建出两行重复装配件
    // （`POST /assemblies` 无幂等键）。`countPdfPages` 也因此必须落在 try 里：flag 已置位
    // 而 await 在 try 外的话，它一抛错 `pageSlicing` 就永远停在 true，本入口被焊死。
    const slices: PdfSource[] = [];
    // 失败发生在哪一步：`pages` = 连页数都读不出来（另一个失败面，见 `pageCountFailedMessage`）。
    let phase: 'pages' | 'slice' = 'pages';
    pageSlicing = true;
    let totalPages = 0;
    try {
      totalPages = await countPdfPages(f);
      manualSource.totalPages = totalPages;
      phase = 'slice';
      allPdfs.value.push(manualSource);
      const srcDoc = await loadPdfDoc(f);
      for (let p = 0; p < totalPages; p++)
        slices.push(await pushPageSlice(manualSource, srcDoc, p));
    } catch (e) {
      rollbackPushedSources([manualSource.uid, ...slices.map((s) => s.uid)]);
      ElMessage.error(
        phase === 'pages'
          ? pageCountFailedMessage(manualSource, e)
          : sliceFailedMessage(manualSource, e),
      );
      return;
    } finally {
      pageSlicing = false;
    }
    // 2026-10-11 口径变更：每个子件**直接取手动输入框的值**，与页数无关 ——
    // 不再拼 `-01 / -02` 后缀（与「合并为装配件」入口同口径，两条入口天然统一）。
    const asmDrawingNo = manualAsmForm.drawing_no.trim();
    const asmName = manualAsmForm.name.trim() || asmDrawingNo;
    const children: AssemblyChildRow[] = [];
    for (let p = 0; p < totalPages; p++) {
      children.push(
        makeAssemblyChild({
          pdfSourceUid: slices[p]!.uid,
          pageIndex: p,
          drawing_no: asmDrawingNo,
          name: asmName,
        }),
      );
    }
    const created = makeAssemblyRow({
      pdfSourceUid: pdfUid,
      drawing_no: asmDrawingNo,
      name: manualAsmForm.name.trim(),
      // 2026-10-05：默认「无总装图」，与「合并为装配件」一致。默认把第 1 页当总装图会
      // 让「有总装图 ⇒ 打印额外出总装图页 + 序列号背面」这条后端守卫在用户没要求时也被
      // 触发。要总装图由用户在下拉里显式指定。
      masterPageIndex: null,
      masterPdfSourceUid: null,
      children,
    });
    assemblies.value.push(created);
    manualAsmDialogVisible.value = false;
    // 2026-10-03：只回填本次新建的这一个装配件（含其子件交期同步），不动其它装配件。
    applyExcelToAll({ assemblies: [created] });
    ElMessage.success(`已新增装配件（共 ${totalPages} 子件）`);
  }

  // ============================================================
  // 2026-10-04：建工单（POST /parts/batch）+ 逐 part 后置上传
  // ============================================================

  /** 反查用：jobKey（`pdf:${srcUid}` / `3d:${fileUid}`）→ status cell。 */
  const pdfUploadCells = reactive<Record<string, UploadStatusCell>>({});
  const threeDUploadCells = reactive<Record<string, UploadStatusCell>>({});

  /**
   * 任意 Blob → File。PdfSource.raw 在合成路径（pdf-lib save()）下是 Blob 而非 File。
   * 这里统一包成 File 以简化下游类型。
   */
  function ensureFile(blob: Blob, filename: string): File {
    if (blob instanceof File) return blob;
    return new File([blob], filename, { type: blob.type || 'application/octet-stream' });
  }

  /** 受控并发跑 async 函数；单个 item 抛错不影响其它 item（异常在各 fn 内自兜）。 */
  async function runWithConcurrency<T>(
    items: T[],
    limit: number,
    fn: (it: T, idx: number) => Promise<void>,
  ): Promise<void> {
    if (items.length === 0) return;
    let cursor = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const i = cursor++;
        await fn(items[i]!, i);
      }
    });
    await Promise.all(workers);
  }

  /**
   * 决定某个 row 的 PDF 单元（用于 UI 显示上传状态）。
   * `pdfSourceUid` 允许为 null = 该实体没有要传的 PDF（装配件无总装图时顶层就是这种
   * 情况），此时不占状态格。
   */
  function getRowPdfCell(row: { pdfSourceUid: string | null }): UploadStatusCell | undefined {
    if (!row.pdfSourceUid) return undefined;
    return pdfUploadCells[`pdf:${row.pdfSourceUid}`];
  }
  /** 决定某个 row 的 3D 单元。 */
  function getRowThreeDCell(row: { three_d_index: number | null }): UploadStatusCell | undefined {
    if (row.three_d_index === null) return undefined;
    const f = threeDModelFiles.value[row.three_d_index];
    if (!f) return undefined;
    return threeDUploadCells[`3d:${f.uid}`];
  }

  /**
   * 文件上传条目（统一容器）。
   * - key：UI cell / 后置上传 job 的键（`pdf:${srcUid}` / `3d:${fileUid}`）。
   * - rowRefs：哪些 row 引用了该文件。**落在哪个端点由 ref 的 rowKind 决定**（见
   *   `buildUploadJobs`）：装配件顶层走 `POST /assemblies/{id}/files`，其余（独立零件 /
   *   装配件子件）走 parts 的上传端点。
   *
   * 2026-10-05：装配件侧每个子件、每个总装图都是各自独立的**单页切片**（uid 唯一），
   * 装配件顶层在「无总装图」时**不产生 entry** ⇒ 装配件的一份 entry 只对应一个目标
   * 实体。同一份 PDF 挂多个 ref 只可能来自「多行共享同一份原件」，而「合成多页独立
   * 零件」「多个装配件各切自同一 PDF」这两类**不产生多 ref** —— 前者一个合成产物只挂
   * 一行，后者每个子件各建各的切片（uid 互不相同）。
   *
   * 2026-10-05 补：PDF 侧真正稳定产出「一个 cell 多个 job」的活口是 `splitStandalonePart`
   * —— 它把合成行拆回 N 行，每行的 `pdfSourceUid` 都指回**原始** PDF 的 uid（不是被
   * 删掉的那个 `syn-` 切片），于是 `pdf:<原 uid>` 这一份 entry 挂 N 个 standalone ref；
   * 次要的一条是对同一份原始 PDF 再次「全部页合并为独立零件」（那条分支直接复用原
   * uid、不建切片），重复做就会得到多行共享同一 uid。
   * （3D 侧本来就常见多 ref：同一个模型文件被多行选中。）改 `syncCells` /
   * `buildUploadJobs` 的多 ref 逻辑时按上面这些设防，不要假设「一份 entry 只有一个
   * ref」而把循环简化掉。
   */
  interface FileUploadEntry {
    key: string;
    kind: PartFileKind;
    filename: string;
    file: File;
    size: number;
    contentType: string;
    rowRefs: RowRef[];
  }
  /** row 反向引用：哪个 row 用了哪个文件（决定该 part 要传哪些原件）。 */
  type RowRef =
    | { rowKind: 'standalone'; rowUid: string }
    | { rowKind: 'asmMaster'; rowUid: string }
    | { rowKind: 'asmChild'; rowUid: string; asmUid: string };

  /** 收集本批次所有待上传文件（PDF + 3D），按 (kind, srcUid/fileUid) 去重。 */
  function collectFilesToUpload(): FileUploadEntry[] {
    const map = new Map<string, FileUploadEntry>();
    const ensure = (key: string, make: () => FileUploadEntry): FileUploadEntry => {
      const existing = map.get(key);
      if (existing) return existing;
      const created = make();
      map.set(key, created);
      return created;
    };
    /** 装一个 PDF 条目并把 row 挂上去（每个实体一个独立切片 ⇒ key 天然唯一）。 */
    const attachPdf = (src: PdfSource, ref: RowRef): void => {
      const key = `pdf:${src.uid}`;
      ensure(key, () => ({
        key,
        kind: 'DRAWING',
        filename: src.filename,
        file: ensureFile(src.raw, src.filename),
        size: src.raw.size,
        contentType: src.raw.type || 'application/pdf',
        rowRefs: [],
      })).rowRefs.push(ref);
    };

    // 1) PDF：独立零件行
    for (const r of standaloneParts.value) {
      const src = allPdfs.value.find((s) => s.uid === r.pdfSourceUid);
      if (!src) continue;
      attachPdf(src, { rowKind: 'standalone', rowUid: r.uid });
    }
    // 2) PDF：装配件 —— 每个子件一份单页切片；总装图可选（也是独立的那一页的切片）
    for (const a of assemblies.value) {
      for (const c of effectiveChildren(a)) {
        const src = allPdfs.value.find((s) => s.uid === c.pdfSourceUid);
        if (!src) continue;
        attachPdf(src, { rowKind: 'asmChild', rowUid: c.uid, asmUid: a.uid });
      }
      // 「无总装图」⇒ 顶层一个 job 都不产生（库里就不会有 ASSEMBLY_MASTER 行）
      if (!a.masterPdfSourceUid) continue;
      const master = allPdfs.value.find((s) => s.uid === a.masterPdfSourceUid);
      if (!master) continue;
      attachPdf(master, { rowKind: 'asmMaster', rowUid: a.uid });
    }
    // 3) 3D 模型：被 row 引用的（three_d_index 指向的文件）
    const attachThreeD = (ref: RowRef, idx: number): void => {
      const f = threeDModelFiles.value[idx];
      const raw = f?.raw as File | undefined;
      if (!f || !raw) return;
      const key = `3d:${f.uid}`;
      ensure(key, () => ({
        key,
        kind: '3D_MODEL',
        filename: f.name,
        file: raw,
        size: raw.size,
        contentType: raw.type || 'application/octet-stream',
        rowRefs: [],
      })).rowRefs.push(ref);
    };
    for (const r of standaloneParts.value) {
      if (r.three_d_index !== null)
        attachThreeD({ rowKind: 'standalone', rowUid: r.uid }, r.three_d_index);
    }
    // 装配件子件走 effectiveChildren，与建单口径（buildAssemblyPayload）对齐：被指定为
    // 总装图的那一页不建出子件，遍历它只会挂出一个没有 job 的 entry。
    // 2026-10-05：这一处**对外不可观测** —— 不建 job 就不进 jobsByCellKey，syncCells 也不
    // 会凭空造 cell，composable 的返回面上看不出差别。保留这个写法是为了不给「一个
    // PdfSource 同时挂 asmChild + asmMaster 两种 ref」留下悬空引用；配套用例锁的是
    // 用户可见的那条不变式：被排除那一行不占 3D 状态格。
    for (const a of assemblies.value) {
      for (const c of effectiveChildren(a)) {
        if (c.three_d_index !== null) {
          attachThreeD({ rowKind: 'asmChild', rowUid: c.uid, asmUid: a.uid }, c.three_d_index);
        }
      }
    }
    return Array.from(map.values());
  }

  // ============================================================
  // 2026-10-04：建工单（POST /parts/batch）+ 逐 part 后置上传
  // ============================================================

  /**
   * 2026-10-04 定：并发上限。瓶颈在后端内存 —— `upload_part_file` 把整份 multipart
   * 读进内存（`&[u8]`）再转存对象存储，单文件上限 300MB（`cos.max_file_size`），
   * 所以 6 是「几路并发不至于把后端内存打爆」的保守值，不是吞吐最优值。
   * 不取更小的 3：文件字节现在全过后端，限制在服务端一侧（对象存储直传链路才是
   * 浏览器侧受限），按浏览器侧的余量取值对后端没有意义。
   */
  const PART_UPLOAD_CONCURRENCY = 6;

  /**
   * 2026-10-05 定：装配件建单的并发上限（`POST /assemblies`，每组一次请求）。
   *
   * 不沿用 `PART_UPLOAD_CONCURRENCY`（6）：那个值的瓶颈是**字节流**（整份 multipart 进
   * 后端内存），装配件建单一个请求只发几 KB JSON，字节维度根本不是约束。装配件建单的
   * 真实约束在服务端写事务：每组要派 1 个装配件流水号（`t_serial_counter` 上一次 UPSERT）
   * + 1 条 `t_assembly` + N 条 `t_part` INSERT，组数一多请求就在同一张计数表上排队。
   *
   * 取 3 而不是串行：一次批量导入的装配件组数是个位数（合并多页 PDF 才能凑出一组），
   * 串行会把每组的往返时间线性叠加；3 路足够把等待摊薄，又把同一 L1 客户计数表上的
   * 并发写压到很低。也不取更高：组数本就少，再高只增加计数表争用，收益为零。
   */
  const ASSEMBLY_CREATE_CONCURRENCY = 3;

  /**
   * 后置上传的**目标实体**。2026-10-05 起上传端点按目标分流：装配件顶层（`t_assembly` 行）
   * 的总装图走 `POST /assemblies/{id}/files`；独立零件与装配件子件（都是 `t_part` 行）走
   * `POST /parts/{id}/upload-drawing` / `upload-3d-model`。
   */
  type UploadTarget = 'part' | 'assembly';

  /** 一次后置上传作业 = 一个目标实体 × 一份原件。 */
  interface UploadJob {
    /**
     * job 的稳定身份 = `${jobKey}:${target}:${ownerId}`（jobKey 已含 `pdf:` / `3d:` 前缀，
     * 故天然区分 kind；再带 target 是因为 t_part.id 与 t_assembly.id 是两套雪花，job id
     * 必须全局唯一）。job 状态、失败清单、重试集合全按它寻址 —— 粒度必须是 job
     * 而不是 cell：一份原件被多个 row 共享时（合成的多页独立零件等）会展开成多个 job，
     * 只失败其中一个时按 cell 重试会把已成功的也重跑一遍，而后端
     * `uk_t_part_file_single (part_id, kind)`（覆盖 DRAWING / 3D_MODEL /
     * ASSEMBLY_MASTER / CAD_2D）会对二次上传报 21108「相同文件已存在」。装配件文件的
     * `t_part_file.part_id` 存的就是 assembly.id，所以装配件顶层同样受这条约束。
     */
    id: string;
    /** = entry.key（`pdf:<uid>` / `3d:<uid>`），同时是 UI cell 的键。 */
    jobKey: string;
    /** 目标端点。 */
    target: UploadTarget;
    /** 目标实体的雪花 ID 字符串（后端 JSON 里是 string）：part.id 或 assembly.id。 */
    ownerId: string;
    kind: PartFileKind;
    entry: FileUploadEntry;
  }

  /** job 运行时状态。`error` 的错误文案存在 failedJobs 里，不在状态里。 */
  type UploadJobState = 'pending' | 'uploading' | 'done' | 'error';

  /**
   * 本次提交 `buildCommitItems()` 的 `items[i]` 对应的本地行 uid（**只覆盖独立零件**，
   * 与 `res.created[].sourceIndex` 同坐标系）。装配件不走这条坐标：它的 id 来自
   * `createAssembly` 响应，建单成功时直接按 rowUid 记进 `createdTargets`。
   */
  const itemRowUids = ref<string[]>([]);

  /** 提交流程阶段机。转移：
   *  - idle → creating → uploading → done
   *  - creating 失败 → 回 idle。前提是 `createdTargets` 为空（一行都没建出来，
   *    本地表格原样保留，重来不会碰到已落库的工单）。`createdTargets` 非空说明已经
   *    有行建出来了，此时回 idle 会诱导重复建单，必须走下面的部分成功分支。
   *  - 建单「部分行成立」→ 同样回 idle，但前提是**建成的行已被移出本地表格**（见
   *    dropCreatedRows），下一次提交只会发出剩下的失败行
   *  - uploading 阶段失败 → 转 done 走失败清单（工单已落库，回 idle 会让用户再点
   *    一次主按钮、把同一批工单建第二遍）
   *  - done（全成功）→ 清空跳页；done（有失败 job）→ 只走重试上传，不再建单；
   *    done（job 列表没登记上）→ 现场重建 job 再补传，仍不建单 */
  const commitStage = ref<'idle' | 'creating' | 'uploading' | 'done'>('idle');

  /**
   * 一行已建出的工单 = 目标实体（`t_part` 行 / `t_assembly` 行）+ 它的雪花 ID。
   *
   * 2026-10-05：`t_part` 与 `t_assembly` 两张表的 id 都在同一张 map 里，所以必须带
   * `target` 区分 —— 只存一个裸 id 的话，后置上传分不清该打 `/parts/{id}/upload-drawing`
   * 还是 `/assemblies/{id}/files`。
   */
  interface CreatedTarget {
    target: UploadTarget;
    /** 目标实体的雪花 ID 字符串。 */
    id: string;
  }

  /**
   * 本地 rowUid → 已建出的目标实体。**跨 done 保留**（重试路径绝不清空）：工单已落库
   * 不可回滚，这是同一次页面停留内「重试只重传文件、绝不重复建单」的唯一保证。
   * 跨刷新的取舍见文件头注释。
   *
   * 装配件是**整组记账**：一次 `POST /assemblies` 建出顶层 + 全部子件，三条记录同进同出。
   * 组内若出现「顶层建出但子件数对不上」这种响应异常，整组都不记账（见
   * `createAssemblyGroups`），保证 map 里的每条记录都对应服务端真实存在的一行。
   *
   * reactive（Vue 的集合代理）⇒ `size` 可以直接进 computed 判「工单已建但 job 未登记」。
   */
  const createdTargets = reactive(new Map<string, CreatedTarget>());

  /** 已建出实体按表计数（提示文案 / 主按钮文案用；装配件子件计入 `parts`）。 */
  const createdCounts = computed<{ parts: number; assemblies: number; total: number }>(() => {
    let parts = 0;
    let assemblies = 0;
    for (const v of createdTargets.values()) {
      if (v.target === 'assembly') assemblies += 1;
      else parts += 1;
    }
    return { parts, assemblies, total: parts + assemblies };
  });

  /** 本次提交的全部上传作业（shallowRef：整体替换，不深代理 File）。 */

  const uploadJobs = shallowRef<UploadJob[]>([]);
  /** jobKey → 该 cell 名下的全部 job（cell 状态按它聚合推导）。 */
  let jobsByCellKey = new Map<string, UploadJob[]>();
  /** jobId → 状态。 */
  const jobStates = new Map<string, UploadJobState>();
  /**
   * 失败 job：jobId → { job, error }。失败清单与重试集合的唯一来源。
   * reactive（Vue 的集合代理）⇒ 按 job 粒度的计数可以直接进 computed。
   */
  const failedJobs = reactive(new Map<string, { job: UploadJob; error: string }>());
  /**
   * 2026-10-04：在途 job 集合。同一个 job 只允许一个请求在飞 —— 行内重试与批量重试
   * 的交集、以及用户连点两下，都靠它挡住（重复发同一个 part + kind 只会稳定撞后端
   * 唯一索引 21108，详见 `isPartFileDuplicateError`）。
   */
  const runningJobIds = new Set<string>();

  /** 当前是否有任何 job 上传失败（主按钮 disabled + 重试分支的判据）。 */
  const hasUploadErrors = computed<boolean>(() => failedJobs.size > 0);

  /** 失败 job 数（按钮文案用，口径与失败清单的行一一对应）。 */
  const failedJobCount = computed<number>(() => failedJobs.size);

  /**
   * 2026-10-04：重新解析出一批全新行时清掉上一批的提交状态（行 uid 全部换新，
   * `createdTargets` / job / 失败清单都再也对不上表里任何一行）。
   * 阶段回 idle：这是新的一批内容，可以正常提交。
   *
   * 调用方必须先过 `guardRowMutation`：这一句会把 `commitStage` 打回 idle，而
   * `commitStage` 是「第二次建单」唯一的连点闸门 —— 提交在途时打掉它，主按钮的
   * `disabled` 就成了唯一防线。
   */
  function resetCommitState(): void {
    commitStage.value = 'idle';
    createdTargets.clear();
    itemRowUids.value = [];
    uploadJobs.value = [];
    jobsByCellKey = new Map();
    jobStates.clear();
    failedJobs.clear();
    runningJobIds.clear();
    Object.keys(pdfUploadCells).forEach((k) => delete pdfUploadCells[k]);
    Object.keys(threeDUploadCells).forEach((k) => delete threeDUploadCells[k]);
  }

  /**
   * 2026-10-04：行集合世代号，**只在行的增删换时 +1**（新 uid 进表 / 行被移除 / 整表
   * 被替换）；行内字段编辑不动它，所以用户改个数量不会误触发。
   *
   * `flush: 'sync'` 让它在改动发生的那一刻同步递增，于是「谁改的行集合」这件事
   * 不必逐个入口打点 —— 重新解析 / 手动新增 / 合并 / 拆分 / 删除，以及将来新增的入口，
   * 全部被这一个收口覆盖。`rowEpoch` 的唯一消费方是 `summarizeUploads` 的世代校验。
   */
  const rowEpoch = ref(0);
  watch(
    () =>
      `${standaloneParts.value.map((r) => r.uid).join('|')}#${assemblies.value
        .map((a) => a.uid)
        .join('|')}`,
    () => {
      rowEpoch.value += 1;
    },
    { flush: 'sync' },
  );

  /**
   * 本次提交 / 补传开始时的世代号快照。收口时与 `rowEpoch` 比对：不等说明用户在这期间
   * 换过行集合，本次收口的计数、清场、跳页已经对不上当前表格。
   */
  let submitRowEpoch = 0;

  /**
   * 2026-10-04：**所有会往表里加行 / 换掉整表的入口**共用的提交在途闸门。
   *
   * 提交在途时建出来的新行没有工单 id、也不会被本次 job 覆盖，成功收口会把它跟
   * 已建出的行一起清掉。返回 true = 已拦下，调用方必须立即 return。
   *
   * 这道闸门是第一道防线；第二道是 `rowEpoch`（即便有入口绕过这里，收口也会拒绝对不上
   * 的表格动手）。纯删除行（拆分 / 删除 / 移除源文件）**不**走这道闸门：它不产生新
   * 内容，删掉的行对应的工单也已落库，世代校验会如实提示「结果无法与当前表格对应」。
   */
  function guardRowMutation(): boolean {
    if (!pdfSubmitting.value) return false;
    ElMessage.warning('正在提交 / 上传图纸中，请等本轮结束再改表格');
    return true;
  }

  /** cell key → 对应的响应式 cell（PDF / 3D 分表存）。 */
  function cellOf(jobKey: string, kind: PartFileKind): UploadStatusCell | undefined {
    return kind === 'DRAWING' ? pdfUploadCells[jobKey] : threeDUploadCells[jobKey];
  }

  /**
   * 由 jobStates / failedJobs 重新推导每个 cell 的状态，**不就地覆盖**。
   *
   * 同一份文件可能被多个 job 共用一个 cell（多行共享原件时）：任一 job 失败即 error
   * （该文件确实没传全），但重试时只重跑失败的那个 job，成功过的不会再动。error 文案
   * 取第一个失败 job 的错误（同一份文件、同一批请求，错误基本一致）。
   */
  function syncCells(): void {
    for (const [jobKey, jobs] of jobsByCellKey) {
      const cell = cellOf(jobKey, jobs[0]!.kind);
      if (!cell) continue;
      const firstFailed = jobs.find((j) => failedJobs.has(j.id));
      if (firstFailed) {
        cell.status = 'error';
        cell.progress = 0;
        cell.error = failedJobs.get(firstFailed.id)!.error;
        continue;
      }
      delete cell.error;
      if (jobs.every((j) => jobStates.get(j.id) === 'done')) {
        cell.status = 'done';
        cell.progress = 100;
      } else if (jobs.some((j) => jobStates.get(j.id) === 'uploading')) {
        cell.status = 'uploading';
        cell.progress = 0;
      } else {
        cell.status = 'pending';
        cell.progress = 0;
      }
    }
  }

  /** 登记一次提交的全部 job（并按 jobKey 建 cell）。重试不重跑这里。 */
  function registerUploadJobs(jobs: UploadJob[]): void {
    uploadJobs.value = jobs;
    jobsByCellKey = new Map();
    jobStates.clear();
    failedJobs.clear();
    Object.keys(pdfUploadCells).forEach((k) => delete pdfUploadCells[k]);
    Object.keys(threeDUploadCells).forEach((k) => delete threeDUploadCells[k]);
    for (const job of jobs) {
      const list = jobsByCellKey.get(job.jobKey) ?? [];
      list.push(job);
      jobsByCellKey.set(job.jobKey, list);
      jobStates.set(job.id, 'pending');
      const bucket = job.kind === 'DRAWING' ? pdfUploadCells : threeDUploadCells;
      if (!bucket[job.jobKey]) bucket[job.jobKey] = { status: 'pending', progress: 0 };
    }
    syncCells();
  }

  /**
   * 失败 job 的目标实体标签（失败清单 / 汇总标题用）。
   * 装配件子件与独立零件都是 `t_part` 行，标「第 X 号零件」；装配件顶层是 `t_assembly`
   * 行，标「装配件 X」—— 两者的 id 是两套雪花，混标会让用户拿着装配件 id 去零件列表里找。
   */
  function jobOwnerLabel(job: UploadJob): string {
    return job.target === 'assembly' ? `装配件 ${job.ownerId}` : `第 ${job.ownerId} 号零件`;
  }

  /** 失败 job 清单（每行 = 一个目标实体 × 一份原件），汇总时弹给用户看。 */
  function failedJobLines(): string[] {
    return Array.from(failedJobs.values()).map(
      (f) => `${jobOwnerLabel(f.job)} · ${f.job.entry.filename}：${f.error}`,
    );
  }

  /**
   * 汇总上传结果：无失败 → 提示 + 清空跳页；有失败 → 弹清单 + 保留现场供重试。
   *
   * **前提**：行集合自 `submitRowEpoch` 快照以来没被改过（见开头的世代校验）。收口的
   * 计数 / 清场 / 跳页全部以「当前表格 == 建单时那张表」为前提，不成立就只能如实告知。
   *
   * 计数口径统一为 **job**（一个目标实体 × 一份原件 = 一项），与下面清单的行一一对应：
   * 同一份文件被多个实体引用时是多项，标题若按「文件数」算就会出现「1 个文件失败」
   * 底下列两行实体号的矛盾。涉及的目标实体数 / 文件数作为补充信息一并给出。
   *
   * 成功判据是「**全部已登记 job 都判成功**」，不是「failedJobs 为空」：登记 / 调度
   * 被打断时，未被调度的 job 停在 `pending` 且不在 `failedJobs` 里，只看 failedJobs 会
   * 把「一个文件都没传上去」当成功收口（清空现场 + 跳页）。未完成的先补记进
   * `failedJobs` 再弹清单。`uploadJobs` 为空但工单已建（job 构造抛错）同样不算成功。
   */
  function summarizeUploads(): void {
    // 2026-10-04 世代校验，必须**先于**任何收口动作。行集合在提交期间被换过（重新解析
    // 会把 `createdTargets` 一并清空、行 uid 全部换新）时，下面的计数 / 清场 / 跳页
    // 都对不上当前表格：走成功收口会把用户刚建好的行静默清掉、跳到零件列表、再弹一条
    // 「成功创建 0 条零件」的假提示，而工单其实已经落库了。
    if (rowEpoch.value !== submitRowEpoch) {
      const lost = failedJobs.size > 0 ? `其中 ${failedJobs.size} 项文件未上传成功。\n` : '';
      ElMessageBox.alert(
        `工单已经创建，但提交期间本地表格被改过，本次结果已无法与当前表格对应。\n` +
          `${lost}\n已创建的工单请到零件列表 / 装配件列表查看，图纸可在详情页补传。`,
        '提交结果请到列表核对',
        { type: 'warning' },
      );
      return;
    }
    const unfinished = uploadJobs.value.filter((j) => jobStates.get(j.id) !== 'done');
    for (const job of unfinished) {
      if (!failedJobs.has(job.id)) {
        failedJobs.set(job.id, { job, error: '未完成（上传过程被中断）' });
      }
    }
    if (uploadJobs.value.length === 0 && createdTargets.size > 0) {
      ElMessageBox.alert(
        `工单已创建 ${createdCountText()}，但文件一个都没上传（上传任务没能登记）。\n\n可在本页点「重试上传」补传（不会重复建单）。`,
        '文件上传未开始',
        { type: 'error' },
      );
      return;
    }
    if (failedJobs.size > 0) {
      const lines = failedJobLines();
      const ownerCount = new Set(Array.from(failedJobs.values(), (f) => f.job.ownerId)).size;
      const fileCount = new Set(Array.from(failedJobs.values(), (f) => f.job.jobKey)).size;
      const sample = lines.slice(0, 5).join('\n');
      const more = lines.length > 5 ? `\n…还有 ${lines.length - 5} 项失败` : '';
      ElMessageBox.alert(
        `工单已创建，但 ${failedJobs.size} 项上传失败（涉及 ${ownerCount} 个工单 / ${fileCount} 个文件）：\n${sample}${more}\n\n可在本页重试上传（不会重复建单）。`,
        '文件上传失败',
        { type: 'warning' },
      );
      return;
    }
    // 2026-10-05：装配件子件挂上 assembly_id 后**不会**出现在零件一览（列表的 part 段是
    // `WHERE assembly_id IS NULL`），只有装配件父行进列表 ⇒ 成功提示里必须说清子件去哪看。
    // 装配件子件本身就是 t_part 行、已经含在 `parts` 里，所以显式点明其中几条是子件，
    // 免得读成「零件和子件是两批」。
    const c = createdCounts.value;
    const childCount = createdChildCount();
    const segs: string[] = [];
    if (c.parts > 0) {
      segs.push(
        c.assemblies > 0
          ? `${c.parts} 条零件（其中 ${childCount} 个为装配件子件）`
          : `${c.parts} 条零件`,
      );
    }
    if (c.assemblies > 0) segs.push(`${c.assemblies} 个装配件`);
    const hint = c.assemblies > 0 ? '\n子件不在零件一览里，请到装配件详情页查看。' : '';
    ElMessage.success(`成功创建 ${segs.join(' + ') || '0 条'}${hint}`);
    // 2026-10-04：草稿在这里才清 —— 还有上传失败就必须留着（工单已落库，图样要靠本页
    // 的 job 现场补传）。注意草稿对 Tab 2 是**只写**的（`pdf_tab` 段没有回读路径，
    // 刷新后表格本来就是空的），清掉它不代表行可恢复。
    draft.saver.cancel();
    draft.clear();
    allPdfs.value = [];
    standaloneParts.value = [];
    assemblies.value = [];
    selectedPages.value = new Set();
    pdfFiles.value = [];
    excelFiles.value = [];
    // 2026-10-03：Excel 文件已清空 → 解析结果同步作废（下一批是新数据）。
    excelByDrawingNo.value = null;
    threeDModelFiles.value = [];
    Object.keys(pdfUploadCells).forEach((k) => delete pdfUploadCells[k]);
    Object.keys(threeDUploadCells).forEach((k) => delete threeDUploadCells[k]);
    uploadJobs.value = [];
    jobsByCellKey = new Map();
    jobStates.clear();
    failedJobs.clear();
    runningJobIds.clear();
    createdTargets.clear();
    itemRowUids.value = [];
    successNextTab.value = 'manual';
    router.push('/parts?status=PENDING');
  }

  /**
   * 跑一批 job（受控并发）。成败记在 job 上（jobStates / failedJobs）再由 syncCells
   * 推导 cell 状态；单个 job 抛错只记失败、不影响其它 job，也不外抛。
   *
   * 端点按 `job.target` 分流（2026-10-05）：装配件顶层的总装图打
   * `POST /assemblies/{id}/files`（field=`file`，只收 PDF，存成 kind=ASSEMBLY_MASTER）；
   * 独立零件 / 装配件子件（都是 `t_part` 行）打 `/parts/{id}/upload-drawing` /
   * `upload-3d-model`。
   *
   * 已在途的 job 直接跳过（`runningJobIds`）：同一次上传请求重复发出去既浪费带宽，
   * 又会撞后端唯一索引。
   *
   * 命中 `isPartFileDuplicateError`（后端说这个 owner 的这个 kind 已有文件）按**成功**
   * 收：该 kind 下已有文件就说明那份文件已经在服务端，此刻把它记成失败会让每次重试
   * 都稳定再拿一次同一个码，UI 永远停在假错误里（成因是上一次上传「已落库但响应
   * 丢失」）。装配件总装图与零件图纸同落 `t_part_file`（`owner_kind` 不同、kind 都是各自
   * 那一个），所以复用同一个 21108 归一。
   */
  async function runUploadJobs(jobs: UploadJob[]): Promise<void> {
    const runnable = jobs.filter((j) => !runningJobIds.has(j.id));
    if (runnable.length === 0) return;
    await runWithConcurrency(runnable, PART_UPLOAD_CONCURRENCY, async (job) => {
      runningJobIds.add(job.id);
      jobStates.set(job.id, 'uploading');
      syncCells();
      try {
        if (job.target === 'assembly') {
          await uploadAssemblyPdf(job.ownerId, job.entry.file);
        } else if (job.kind === 'DRAWING') {
          await uploadPartDrawing(job.ownerId, job.entry.file);
        } else {
          await uploadPart3DModel(job.ownerId, job.entry.file);
        }
        jobStates.set(job.id, 'done');
        failedJobs.delete(job.id);
      } catch (e) {
        if (isPartFileDuplicateError(e)) {
          jobStates.set(job.id, 'done');
          failedJobs.delete(job.id);
        } else {
          jobStates.set(job.id, 'error');
          failedJobs.set(job.id, { job, error: (e as Error).message ?? '上传失败' });
        }
      } finally {
        runningJobIds.delete(job.id);
        syncCells();
      }
    });
  }

  const draft = usePartsNewDraft();

  // ============================================================
  // draft 持久化：监听 rows / assemblies 变更 → debounce 500ms 写 localStorage
  // ============================================================
  //
  // 写时机：rows / assemblies 任意字段变化 → schedule saver（debounce 500ms 合并）；
  // 建单前 → saver.flush()（把当前现场固化进 localStorage）；全部上传成功 → clearDraft。
  //
  // 2026-09-18 B1 修复：cross-tab clobber。原来 PDF Tab saver 写整个 payload 时
  // 把 manual_tab 覆盖为 `{ staged: [] }`（PDF Tab 不写 manual 段），Manual Tab
  // saver 同样覆盖 pdf_tab 为空。两 Tab 共享同 key 时 debounce 竞争，后者覆盖
  // 前者。本次改为：schedule 前先读旧 payload（draft.load()），仅覆盖本 Tab 段，
  // 另一 Tab 段保留。代价：每次 schedule 多一次 localStorage 读（仍在 500ms
  // debounce 窗口内合并，开销可接受）。
  if (draft.userId) {
    watch(
      () =>
        [
          pdfForm.customerL1Id,
          pdfForm.requestDate,
          commitStage.value,
          JSON.stringify(serializePdfTab()),
        ] as const,
      () => {
        const prev = draft.load();
        const basePayload = {
          active_tab: prev?.active_tab ?? 'pdf',
          saved_at: new Date().toISOString(),
          pdf_tab: serializePdfTab(),
          // 保留 manual_tab 旧值；只有 Manual Tab 自己的 saver 会更新 manual_tab 段
          manual_tab: prev?.manual_tab ?? { staged: [] },
        };
        draft.saver.schedule(basePayload);
      },
    );
  }

  /**
   * 把当前 PDF Tab state 序列化成 SerializedPdfTab 形态（不含 File / Blob）。
   * 详见 usePartsNewDraft.SerializedPdfTab。
   */
  function serializePdfTab(): SerializedPdfTab {
    return {
      customerL1Id: pdfForm.customerL1Id,
      requestDate: pdfForm.requestDate,
      rows: standaloneParts.value.map(serializeStandalonePartRow),
      assemblies: assemblies.value.map(serializeAssemblyRow),
      selectedPages: Array.from(selectedPages.value),
    };
  }

  /** 单个 standalone part row → SerializedStandalonePartRow。 */
  function serializeStandalonePartRow(r: StandalonePartRow): SerializedStandalonePartRow {
    return {
      uid: r.uid,
      pdfSourceUid: r.pdfSourceUid,
      pageCount: r.pageCount,
      ...(r.mergedFrom ? { mergedFrom: r.mergedFrom } : {}),
      drawing_no: r.drawing_no,
      name: r.name,
      applicant_name: r.applicant_name,
      customer_id: r.customer_id,
      customer_name: r.customer_name,
      request_date: r.request_date,
      planned_delivery_date: r.planned_delivery_date,
      system_delivery_date: r.system_delivery_date,
      order_no: r.order_no,
      note: r.note,
      is_urgent: r.is_urgent,
      quantity: r.quantity,
      unit_price: r.unit_price,
      total_price: r.total_price,
      three_d_index: r.three_d_index,
    };
  }

  /** 单个 assembly row → SerializedAssemblyRow（含 children 递归）。 */
  function serializeAssemblyRow(a: AssemblyRow): SerializedAssemblyRow {
    return {
      uid: a.uid,
      pdfSourceUid: a.pdfSourceUid,
      drawing_no: a.drawing_no,
      name: a.name,
      applicant_name: a.applicant_name,
      customer_id: a.customer_id,
      customer_name: a.customer_name,
      request_date: a.request_date,
      planned_delivery_date: a.planned_delivery_date,
      system_delivery_date: a.system_delivery_date,
      order_no: a.order_no,
      note: a.note,
      is_urgent: a.is_urgent,
      masterPageIndex: a.masterPageIndex,
      quantity: a.quantity,
      unit_price: a.unit_price,
      total_price: a.total_price,
      children: a.children.map(serializeAssemblyChildRow),
    };
  }

  function serializeAssemblyChildRow(c: AssemblyChildRow): SerializedAssemblyChildRow {
    return {
      uid: c.uid,
      pdfSourceUid: c.pdfSourceUid,
      page_index: c.page_index,
      drawing_no: c.drawing_no,
      name: c.name,
      quantity: c.quantity,
      is_urgent: c.is_urgent,
      request_date: c.request_date,
      planned_delivery_date: c.planned_delivery_date,
      system_delivery_date: c.system_delivery_date,
      order_no: c.order_no,
      note: c.note,
      unit_price: c.unit_price,
      total_price: c.total_price,
      three_d_index: c.three_d_index,
    };
  }

  /**
   * 2026-10-04：工单已建、但上传 job 列表没登记上（构造 job 抛错 / 登记被打断）。
   *
   * 这时 `failedJobs` 是空的，只按「有失败 job」判可点会让主按钮显示「提交创建（N 个
   * 零件）」却永久 disabled —— UI 在邀请一个点不动的动作，而用户看到自己填好的行唯一
   * 合理的动作就是再点一次，那会把工单再建一遍。出路是现成的：`createdTargets` 与
   * `itemRowUids` 还在手上，现场重建 job 列表即可（不碰建单）。
   */
  const needsUploadRebuild = computed<boolean>(
    () => createdTargets.size > 0 && uploadJobs.value.length === 0,
  );

  /** 是否可以点主按钮：idle 态有内容可提交；done 态还有失败 job 或待重建的 job 列表。 */
  const canSubmit = computed<boolean>(() => {
    if (commitStage.value === 'done') return hasUploadErrors.value || needsUploadRebuild.value;
    if (commitStage.value !== 'idle') return false;
    return standaloneParts.value.length > 0 || assemblies.value.length > 0;
  });

  /**
   * 主按钮文案（提交 / 进行中 / 重试三态）。
   *
   * done 态统一是「重试上传（N 项）」：N 取失败 job 数；job 列表没登记上时取已建工单
   * 数（每条工单至少要补一份图纸），点下去是「现场重建 job 再补传」，同样不建单。
   */
  const submitLabel = computed<string>(() => {
    if (commitStage.value === 'creating') return '正在创建工单…';
    if (commitStage.value === 'uploading') return '正在上传图纸…';
    if (commitStage.value === 'done') {
      const n = hasUploadErrors.value ? failedJobCount.value : createdCounts.value.total;
      if (n > 0) return `重试上传（${n} 项）`;
    }
    const partCount =
      standaloneParts.value.length + assemblies.value.length + totalAssemblyChildren.value;
    return `提交创建（${partCount} 个零件）`;
  });

  /** 行内「重试」按钮的 disabled 判据：补传在途时置灰。 */
  const cellRetryDisabled = computed<boolean>(
    () => pdfSubmitting.value || commitStage.value !== 'done',
  );

  /**
   * UI 调用：行内单文件重试。`jobKey` 取该 cell 自身的 key，**只重跑该 key 下仍在
   * 失败的 job**（同一份文件被多个 part 共享时，已成功的那些不会重传）。
   * 收尾与 retryFailedUploads 对称：跑完必须 summarizeUploads —— 否则最后一个错误
   * 修好后页面停在「无失败但按钮禁用」的态，既不提示也不跳页。
   *
   * 开头的 `pdfSubmitting` 闸门挡住连点：同一批 job 重入会稳定撞后端唯一索引 21108。
   */
  async function retryUploadByCell(jobKey: string): Promise<void> {
    if (pdfSubmitting.value) return;
    const jobs = uploadJobs.value.filter((j) => j.jobKey === jobKey && failedJobs.has(j.id));
    if (jobs.length === 0) {
      ElMessage.warning('该文件没有待重试的记录，请重新提交');
      return;
    }
    submitRowEpoch = rowEpoch.value;
    pdfSubmitting.value = true;
    try {
      await runUploadJobs(jobs);
    } finally {
      pdfSubmitting.value = false;
    }
    summarizeUploads();
  }

  /** 前端兜底：所有 row 的 customer_id 必须有 L2 客户（后端强校验 L2-leaf）。
   *  返回 true 表示通过，false 表示阻塞；阻塞时已通过 ElMessage.warning 提示。 */
  function validateL2Customers(): boolean {
    const missing: string[] = [];
    for (const r of standaloneParts.value) {
      if (!r.customer_id) missing.push(`独立零件 ${r.drawing_no || r.uid}`);
    }
    for (const a of assemblies.value) {
      if (!a.customer_id) missing.push(`装配件 ${a.drawing_no || a.uid}`);
    }
    if (missing.length > 0) {
      ElMessage.warning(
        `以下 ${missing.length} 行未指定分厂（二级客户），请补全后再提交：\n` +
          missing.slice(0, 5).join('\n') +
          (missing.length > 5 ? '\n…' : ''),
      );
      return false;
    }
    return true;
  }

  /** 独立零件行 → `POST /parts/batch` 的 item（不含文件：文件走后置上传）。
   *
   * 2026-10-05：**只含独立零件**。装配件不再展平成 N+1 个独立 part —— `POST /parts/batch`
   * 端点内没有 assembly 概念，展平的结果是 `t_assembly` 一行不涨、子件的 `assembly_id`
   * 全 NULL。装配件改走树形端点 `POST /api/v2/assemblies`（见 `buildAssemblyPayload`）。
   *
   * 顺序必须与 `res.created[].sourceIndex` 的坐标系一致（`rowUids[i]` ↔ `items[i]`）。
   * 金额经 `toMoneyString` 带上（2 位小数字符串，缺价时为 undefined → 键不生效，
   * 后端落 0），与独立零件 / 装配件 / 子件三层保持同一口径。 */
  function buildCommitItems(): { items: PartBatchCreatePayload[]; rowUids: string[] } {
    const items: PartBatchCreatePayload[] = [];
    const rowUids: string[] = [];
    for (const r of standaloneParts.value) {
      rowUids.push(r.uid);
      items.push({
        name: r.name || r.drawing_no,
        drawing_no: r.drawing_no,
        applicant_name: r.applicant_name,
        applicant_id: null,
        quantity: r.quantity,
        request_date: r.request_date,
        planned_delivery_date: r.planned_delivery_date || r.request_date,
        is_urgent: r.is_urgent,
        order_no: r.order_no,
        system_delivery_date: r.system_delivery_date,
        note: r.note,
        customer_id: r.customer_id,
        // 2026-10-05：含税单价 / 总价随建单一起发（此前三层同时丢弃，表格里填的价
        // 永远落不了库）。`toMoneyString` 保证 2 位小数标度，缺价时给 undefined
        // 而不是 null / '0' —— 让「没填价」与「填了 0 元」在请求体里可区分。
        unit_price: toMoneyString(r.unit_price),
        total_price: toMoneyString(r.total_price),
      });
    }
    return { items, rowUids };
  }

  /**
   * 装配件行 → `POST /api/v2/assemblies` 的 `data` JSON（**不传 PDF**）。
   *
   * 一次请求建出 `t_assembly` 顶层 + 全部 `t_part` 子件（子件的 `assembly_id` 指向顶层）。
   * 后端该端点现在**无条件**派序列号、**无条件**建子件（2026-10-05 放开），所以不传
   * PDF 也能建出完整的装配件；总装图走 `POST /assemblies/{id}/files` 单独上传
   * （那个端点才真入库，存 kind=ASSEMBLY_MASTER）。
   *
   * 金额一律过 `toMoneyString`：`unit_price` / `total_price` 是 rust `rust_decimal` +
   * `serde-with-str`，只认 JSON 字符串。
   */
  function buildAssemblyPayload(a: AssemblyRow): AssemblyCreatePayload {
    return {
      name: a.name || a.drawing_no || `装配件-${a.uid}`,
      drawing_no: a.drawing_no,
      // 必须是 L2 叶子，后端强校验（20302）；空值由 validateL2Customers 挡在前头。
      customer_id: a.customer_id,
      applicant_name: a.applicant_name,
      request_date: a.request_date,
      planned_delivery_date: a.planned_delivery_date || a.request_date,
      is_urgent: a.is_urgent,
      /** 顶层是**套数**。 */
      quantity: a.quantity,
      unit_price: toMoneyString(a.unit_price),
      total_price: toMoneyString(a.total_price),
      order_no: a.order_no,
      system_delivery_date: a.system_delivery_date,
      note: a.note,
      children: effectiveChildren(a).map((c, i) => ({
        name: c.name || `子件${i + 1}`,
        drawing_no: c.drawing_no,
        quantity: c.quantity,
        planned_delivery_date: c.planned_delivery_date || c.request_date,
        // 子件单价不从 Excel 继承（Excel 是整套口径，摊到 N 个子件会重复计价 N 倍），
        // 只有用户在子件行手填过才会发出去。
        unit_price: toMoneyString(c.unit_price),
        total_price: toMoneyString(c.total_price),
      })),
    };
  }

  /** 一次装配件建单的结果分两类，逐组独立记账（互不影响）。 */
  interface AssemblyGroupFailure {
    /** 该组的本地行 uid（`AssemblyRow.uid`）。 */
    rowUid: string;
    /** 展示用标签：`图号 xxx` 或 `装配件-uid`。 */
    label: string;
    error: string;
    /**
     * `rejected` = 后端处理过并回滚了（带 5 位业务码），该组一定没建出，重提安全；
     * `unknown` = 拿不到定论（网络 / 5xx 页面，或响应与请求对不上），后端可能已落库。
     */
    outcome: 'rejected' | 'unknown';
  }

  /**
   * 后端业务错误码是 5 位（`1xxxx`–`5xxxx`）；`api/http.ts` 在拿不到 `{code,message,data}`
   * 信封时用 HTTP 状态码（网络错误是 0）兜底 ⇒ `code >= 10000` 才代表「后端处理过这次
   * 请求」。事务内的 DB / 内部错误（50001 / 50000）同样是 5 位、同样已回滚 ⇒ 归
   * `rejected`（该组一定没建出，重提安全）；它们不是「客户数据不合法」意义上的拒绝，
   * 但对「会不会重复建单」这个问题答案一样。
   */
  function isDefinitiveApiRejection(e: unknown): boolean {
    const code = (e as { code?: unknown } | null)?.code;
    return typeof code === 'number' && code >= 10000;
  }

  /**
   * 逐个装配件发 `POST /api/v2/assemblies`（受控并发 `ASSEMBLY_CREATE_CONCURRENCY`），
   * **逐组 try/catch、不整体 reject**，并把建出的实体写进 `createdTargets`。
   *
   * 心智模型与 `batchCreateParts` 一致：该端点无幂等键，一个组装配件 400（比如 20308
   *  L1 客户没有 `serial_prefix`）绝不能让其它已建好的组在 UI 上消失。
   *
   * **记账的不变量（双向）**：
   *  1. 记了账的必真实存在（`createdTargets` 里每条都对应服务端的一行）；
   *  2. 建出来的必都记上账（否则那行的图纸永不上传，且本页再也够不着它 —— 行会被
   *     `dropCreatedRows` 整行摘掉）。
   * ⇒ 响应只要对不上请求（子件数不一致 / 某个子件缺 id / 子件顺序错位），**整组不记账**，
   *  落进 `unknown` 分支：行留在表里、如实告诉用户「先到装配件列表核对」。宁可让用户
   * 多核对一次，也不能出现「顶层已建、子件没建全/挂错行」的状态。
   */
  async function createAssemblyGroups(rows: AssemblyRow[]): Promise<AssemblyGroupFailure[]> {
    const failures: AssemblyGroupFailure[] = [];
    if (rows.length === 0) return failures;
    await runWithConcurrency(rows, ASSEMBLY_CREATE_CONCURRENCY, async (a) => {
      const label = a.drawing_no || a.name || `装配件-${a.uid}`;
      // 2026-10-05：请求里的子件 = effectiveChildren（被指定为总装图的那一页不算子件）。
      // 算一次存局部变量：下面的长度校验与按下标逐个对账必须用**同一份**数组。
      const effChildren = effectiveChildren(a);
      try {
        const res = await createAssembly(buildAssemblyPayload(a));
        const children = res?.created_children;
        if (!res?.assembly?.id || !Array.isArray(children)) {
          throw new Error('响应缺少 assembly / created_children（可能被网关拦截）');
        }
        if (children.length !== effChildren.length) {
          throw new Error(
            `子件数量与请求不一致（请求 ${effChildren.length} 个，响应 ${children.length} 个）`,
          );
        }
        // 2026-10-05：`created_children[i]` 要按下标对回本地子件行（后端按入参顺序建子件，
        // 序列号 `{asm_serial}-{i:02d}` 1-based）。**同长度但错序是静默数据损坏**：子件 A
        // 的图纸会挂到子件 B 上（part id 只是 id，后端不校验）⇒ 不报错、不进失败清单、
        // 最后弹「成功」。所以用后端回显的 drawing_no 逐个对账，不符即整组不记账。
        // 只容忍 null / 空白差异（空图号在库里是 NULL、回显也就 null），真实值不一致一律
        // 当错序处理。
        //
        // 2026-10-11 能力收窄：子件图号不再拼后缀，全部与装配件一致 ⇒ 本对账**只能查出
        // 图号真的不同**（回显了别的装配件的子件、被截断、被转义），查不出「N 个子件之间
        // 纯错序」—— 那 N 个子件在建单请求里除 page_index 外逐字段相同，而后端不回显
        // page_index，前端手上没有任何可区分的锚点。这是「子件图号与装配件一致」这一产品
        // 取意的必然结果，不是漏做。
        children.forEach((child, i) => {
          if (!child?.id) throw new Error(`响应第 ${i + 1} 个子件缺 id`);
          if ((child.drawing_no ?? '').trim() !== effChildren[i]!.drawing_no.trim()) {
            throw new Error(
              `子件顺序与请求不一致（请求第 ${i + 1} 个是 ${effChildren[i]!.drawing_no || '（空图号）'}，` +
                `响应是 ${child.drawing_no || '（空图号）'}）`,
            );
          }
        });
        // 顶层 + 子件同进同出（一次请求一个事务）
        createdTargets.set(a.uid, { target: 'assembly', id: String(res.assembly.id) });
        children.forEach((child, i) => {
          createdTargets.set(effChildren[i]!.uid, { target: 'part', id: String(child!.id) });
        });
      } catch (e) {
        failures.push({
          rowUid: a.uid,
          label,
          error: (e as Error).message ?? '创建失败',
          // 只有带 5 位业务码的 ApiError 才是「后端明确拒了」；本文件自造的响应形状错误
          // 与网络错误都没有 code，一律按「可能已落库」的 unknown 上报。
          outcome: isDefinitiveApiRejection(e) ? 'rejected' : 'unknown',
        });
      }
    });
    // 失败清单按表格顺序展示（并发下完成顺序不定）
    const order = new Map(rows.map((a, i) => [a.uid, i]));
    failures.sort((x, y) => (order.get(x.rowUid) ?? 0) - (order.get(y.rowUid) ?? 0));
    return failures;
  }

  /**
   * `buildUploadJobs` 真正用到的部分：目标实体 + 它的本地行 uid。
   * 收窄成这个形状是为了让「job 登记失败后用 `createdTargets` 现场重建」不必伪造
   * 后端返回的整个 item（重建路径拿不到那些字段，而这里一个都不读）。
   */
  interface CreatedTargetRef {
    target: UploadTarget;
    /** 目标实体 id（part.id 或 assembly.id）。 */
    id: string;
    /**
     * 本地行 uid。**直查，不走 `itemRowUids[sourceIndex]`**：装配件子件的 id 来自
     * `createAssembly` 的响应，本来就没有 `sourceIndex` 坐标。
     */
    rowUid: string;
  }

  /**
   * 本次提交要上传的「目标实体 × 原件」对应关系（建单成功后调用一次）。
   *
   * 端点分流在**行**这一级，不在 entry 这一级：同一份原件被多个 row 引用时（共享一个
   * UI cell），顶层要打 `/assemblies/{id}/files`、子件要打 `/parts/{id}/upload-drawing`。
   */
  function buildUploadJobs(refs: CreatedTargetRef[]): UploadJob[] {
    const entries = collectFilesToUpload();
    const byRow = new Map<string, FileUploadEntry[]>();
    for (const e of entries) {
      for (const ref of e.rowRefs) {
        const list = byRow.get(ref.rowUid) ?? [];
        list.push(e);
        byRow.set(ref.rowUid, list);
      }
    }
    const jobs: UploadJob[] = [];
    for (const ref of refs) {
      for (const entry of byRow.get(ref.rowUid) ?? []) {
        // 总装图只存 PDF（`/assemblies/{id}/files` 只收 PDF）。顶层本来就不挂 3D
        // （`collectFilesToUpload` 只给 asmChild / standalone 挂），这一句是防线：万一
        // 将来给顶层挂了 3D，绝不能把 3D 文件发到只收 PDF 的端点上去。
        if (ref.target === 'assembly' && entry.kind !== 'DRAWING') continue;
        jobs.push({
          id: `${entry.key}:${ref.target}:${ref.id}`,
          jobKey: entry.key,
          target: ref.target,
          ownerId: ref.id,
          kind: entry.kind,
          entry,
        });
      }
    }
    // 同一份原件被多个 row 共享时（合成的多页独立零件等），这里会为每个实体各产出
    // 一个 job。这是建单与文件上传彻底解耦的已知代价：请求数比「建单时各带一份绑定」高，
    // 但上传失败不再需要回滚工单。
    return jobs;
  }

  /**
   * 把 `createdTargets` 里的那些行从本地表格移走。
   *
   * 这些行对应的工单已经是服务端里的真实记录了，留在表内只会诱导「再点一次提交」
   * ⇒ 重复建单。`itemRowUids` 保持原样（补传 job 仍要靠它把 id 对回 PDF）。
   *
   * 独立零件按行摘。装配件按**组**摘：一次 `POST /assemblies` 建出顶层 + 全部子件，
   * 记账也是整组记的（`createAssemblyGroups` 保证 map 里每条记录都真实存在），所以
   * 顶层建出即整行完成、整行摘掉；没记账的组（明确被拒 / 成败未知）整行留在表里。
   * `allPdfs` 里的原件一律留着（源文件区仍可预览，也不参与提交）。
   */
  function dropCreatedRows(): void {
    standaloneParts.value = standaloneParts.value.filter(
      (r) => createdTargets.get(r.uid)?.target !== 'part',
    );
    assemblies.value = assemblies.value.filter(
      (a) => createdTargets.get(a.uid)?.target !== 'assembly',
    );
  }

  /** 已建出实体的一句话计数（「N 条零件 + M 个装配件」，无则给 0 条）。 */
  function createdCountText(): string {
    const c = createdCounts.value;
    const segs: string[] = [];
    if (c.parts > 0) segs.push(`${c.parts} 条零件`);
    if (c.assemblies > 0) segs.push(`${c.assemblies} 个装配件`);
    return segs.join(' + ') || '0 条';
  }

  /**
   * 已记账的装配件子件数。子件是 `t_part` 行、已经含在 `createdCounts().parts` 里，
   * 这里单独数出来只为文案说清「零件那 N 条里有几条是子件」。
   * 从 `createdTargets` 数而不是 `totalAssemblyChildren`（那是表内行数，与「建出了几个」
   * 不是一回事），保证文案里的两个数字永远自洽。
   */
  function createdChildCount(): number {
    let n = 0;
    for (const a of assemblies.value) {
      for (const c of effectiveChildren(a)) {
        if (createdTargets.get(c.uid)?.target === 'part') n += 1;
      }
    }
    return n;
  }

  /**
   * 建单「有行没建出来」的清单文案。四个来源各自成段：
   * 独立零件逐行被拒 / 独立零件整组请求失败（成败未知）/ 装配件组被拒 / 装配件组成败未知。
   */
  function buildCreateFailureText(
    res: PartBatchResult | null,
    asmFailures: AssemblyGroupFailure[],
  ): string {
    const parts: string[] = [];
    if (res) {
      const sample = res.failed
        .slice(0, 5)
        .map((f) => `第 ${f.index + 1} 行：${f.message}`)
        .join('\n');
      const more = res.failed.length > 5 ? `\n…还有 ${res.failed.length - 5} 行被拒绝` : '';
      if (res.failed.length > 0)
        parts.push(`${res.failed.length} 行被服务端拒绝：\n${sample}${more}`);
      const groupLines = (res.groupErrors ?? []).map(
        (g) => `第 ${g.startIndex + 1}-${g.endIndex + 1} 行（分厂 ${g.customer_id}）：${g.message}`,
      );
      if (groupLines.length > 0) {
        parts.push(
          `${groupLines.length} 个分厂组请求失败，成功与否未知（响应丢失时后端可能已落库）：\n${groupLines
            .slice(0, 3)
            .join('\n')}`,
        );
      }
    }
    const rejected = asmFailures.filter((f) => f.outcome === 'rejected');
    const unknown = asmFailures.filter((f) => f.outcome === 'unknown');
    if (rejected.length > 0) {
      parts.push(
        `${rejected.length} 个装配件服务端拒绝：\n${rejected
          .slice(0, 5)
          .map((f) => `装配件 ${f.label}：${f.error}`)
          .join('\n')}`,
      );
    }
    if (unknown.length > 0) {
      parts.push(
        `${unknown.length} 个装配件成功与否未知（网络失败 / 响应形状异常时后端可能已落库）：\n${unknown
          .slice(0, 5)
          .map((f) => `装配件 ${f.label}：${f.error}`)
          .join('\n')}`,
      );
    }
    if (parts.length === 0) return '没有任何一行建出。';
    const c = createdCounts.value;
    const head = c.total > 0 ? `已创建 ${createdCountText()}；` : '';
    const hint = c.assemblies > 0 ? '\n装配件子件不在零件一览里，请到装配件详情页查看。' : '';
    // 「先核对再重提」这句是**承重**的，不是客套：`t_assembly.drawing_no` 与
    // `t_part.drawing_no` 都没有唯一索引（只有 serial_no 唯一）⇒ 重提一个已建出的组会
    // **完全静默**地建出第二份，没有任何 DB 报错能兜住。前端对 `unknown` 组拿不到定论，
    // 那句提示就是用户唯一的防重复建单防线。
    return (
      `${head}${parts.join('\n\n')}\n` +
      `已创建的工单尚未上传图纸，可在详情页补传。\n建成的行已从表格移除，` +
      `直接重新提交只会发出剩下的行。` +
      (parts.some((p) => p.includes('成功与否未知'))
        ? '\n重新提交前请先到零件 / 装配件列表核对，避免重复建单。'
        : '') +
      hint
    );
  }

  /**
   * 主按钮：创建工单 + 逐实体后置上传图纸 / 3D（单入口，2026-10-04）。
   *
   * creating 阶段分两路（2026-10-05）：
   *  1. 独立零件行 → `batchCreateParts`（一次请求，`batchCreateParts` 内部按分厂分组、
   *     逐组 try/catch 聚合，从不整体 reject）；
   *  2. 装配件行 → `createAssemblyGroups`（逐组一次 `POST /assemblies`，受控并发，
   *     逐组 try/catch）。
   *
   * **先独立零件后装配件**：装配件那路自己吞掉所有错误，零件这路抛错只可能来自
   * `batchCreateParts` 自身（它不整体 reject）⇒ 万一抛错时装配件还没建，回 idle 让用户
   * 重来不会碰到已落库的工单；反过来（先装配件）就会落进「已建出但一条上传都没发」的
   * done 态分支。
   *
   * 两路的失败**合并**成一次 `ElMessageBox.alert` 汇总：任一路有行没建出就整轮不上传
   * （与既有口径一致：已建出的行移出表格、剩下的留在表里等下一次提交，图纸可到详情页
   * 补传）。装配件子件挂上 `assembly_id` 后不进入零件一览，只有装配件父行进列表 ⇒
   * 成功提示与失败提示都会告诉用户「子件在装配件详情页看」。
   */
  async function onSubmit(): Promise<void> {
    if (commitStage.value !== 'idle') {
      ElMessage.warning(
        commitStage.value === 'done' ? '工单已创建，请使用「重试上传」' : '正在提交中',
      );
      return;
    }
    if (standaloneParts.value.length === 0 && assemblies.value.length === 0) {
      ElMessage.warning('请先解析上传');
      return;
    }
    if (!validateL2Customers()) return;

    // 建单前固化快照：上传途中刷新 / 切走时，行数据（含用户已填的分厂、交期）还在
    draft.saver.flush();

    const { items, rowUids } = buildCommitItems();
    itemRowUids.value = rowUids;
    // 2026-10-05：记账只覆盖**本轮**。上一轮「部分失败」时建成的行已被 dropCreatedRows
    // 移出表格，但它们在 map 里的记录还在；不清的话本轮成功提示会把上一批一并数进去
    // （文案形如「成功创建 7 条零件 + 2 个装配件」，而本轮只建了 3 条）—— 在一个专门防
    // 重复建单的流程里给出自相矛盾的计数。
    // 清在这里而不是 `resetCommitState`：重试上传（done 态）**绝不能**碰它，否则已落库
    // 工单的 id 就丢了，job 现场重建与「重试只重传不重建」两个不变量同时失效。
    createdTargets.clear();

    submitRowEpoch = rowEpoch.value;
    pdfSubmitting.value = true;
    commitStage.value = 'creating';
    try {
      // applicant dedupe 在本 Tab 不需要：JSON 端点不接受 applicant_id，
      // applicant_name 走字符串直存，同名只会在 t_part.applicant_name 出现重复字符串。
      // 没有独立零件行时压根不调（整批都是装配件）：`POST /parts/batch` 与装配件无关，
      // 调一个空数组虽然也会早返回，但「装配件不经过批量端点」这件事值得在代码里直白。
      const res: PartBatchResult =
        items.length > 0
          ? await batchCreateParts(items)
          : { created: [], failed: [], groupErrors: [] };

      // 记下「建出来的 part ↔ 本地哪一行」，这是后置上传的锚
      res.created.forEach((c) => {
        const rowUid = itemRowUids.value[c.sourceIndex];
        if (rowUid) createdTargets.set(rowUid, { target: 'part', id: String(c.id) });
      });

      // 装配件：整组一次请求（顶层 + 全部子件），逐组失败不影响其它组
      const asmFailures = await createAssemblyGroups(assemblies.value);

      const partFailed = res.failed.length > 0 || (res.groupErrors?.length ?? 0) > 0;
      if (partFailed || asmFailures.length > 0) {
        const text = buildCreateFailureText(partFailed ? res : null, asmFailures);
        if (createdTargets.size === 0) {
          // 一行都没建出来 ⇒ 本地表格原样保留，回 idle 让用户改完再提交。
          ElMessageBox.alert(text, '部分行未通过', { type: 'warning' });
          commitStage.value = 'idle';
          return;
        }
        // 部分成功：建成的行移出表格（它们已经是真实工单），剩下的失败行留在表里。
        // 此时回 idle 是安全的 —— 下一次提交只会发出剩下的行，不可能重复建已建成的行。
        dropCreatedRows();
        ElMessageBox.alert(text, '部分行未通过', { type: 'warning' });
        commitStage.value = 'idle';
        return;
      }

      commitStage.value = 'uploading';
      let jobs: UploadJob[];
      try {
        jobs = buildUploadJobs(rebuildCreatedTargets());
      } catch (e) {
        // 工单已落库，但一条上传都还没发出去（job 登记前就抛了）⇒ 封住「再提交一次
        // 就多建一批工单」的口子：转 done（canSubmit 只剩「重建 job 补传」这一条出路），
        // 并保留 createdTargets / itemRowUids —— 用户点「重试上传」时靠它们现场重建
        // job 列表，仍然不建单。
        commitStage.value = 'done';
        ElMessageBox.alert(
          `工单已创建 ${createdCountText()}，但文件未能开始上传：\n${(e as Error).message ?? '上传失败'}\n\n请点「重试上传」在本页补传（不会重复建单）；若一直失败，可到详情页补传。`,
          '文件上传未开始',
          { type: 'error' },
        );
        return;
      }
      registerUploadJobs(jobs);
      await runUploadJobs(jobs);

      commitStage.value = 'done';
      summarizeUploads();
    } catch (e) {
      const msg = (e as Error).message ?? '提交失败';
      if (commitStage.value === 'uploading') {
        // 工单已建、补传阶段整体抛错：转 done 走失败清单 / 重试语义（已登记的 job
        // 各自成败照实汇总）。绝不能回 idle —— 那会让主按钮重新可点，用户再按一次
        // 就是同一批工单建第二遍。
        commitStage.value = 'done';
        summarizeUploads();
      } else if (commitStage.value === 'creating') {
        // creating 阶段的兜底。走到这里的**前提**是 `createdTargets` 为空：建单结果
        // 一拿到就已写进 createdTargets（见上方 forEach / createAssemblyGroups），
        // 非空说明已有工单落库。非空时**绝不能**回 idle —— 主按钮会重新可点，用户再按
        // 一次就是已建出的那批工单建第二遍（两个建单端点都无幂等键）；改走 done 态补传
        // 语义，工单已落库的事实如实转达。
        if (createdTargets.size > 0) {
          commitStage.value = 'done';
          ElMessageBox.alert(
            `工单已创建 ${createdCountText()}，但提交过程中出错：\n${msg}\n\n请点「重试上传」在本页补传（不会重复建单）；若一直失败，可到详情页补传。`,
            '提交中断',
            { type: 'error' },
          );
        } else {
          commitStage.value = 'idle';
        }
      }
      ElMessage.error(msg);
    } finally {
      pdfSubmitting.value = false;
    }
  }

  /**
   * 由 `createdTargets` 现场还原「目标实体 ↔ 本地行」。
   *
   * `buildUploadJobs` 抛错时 job 列表没登记上，但记账还在，所以重建不需要重新建单、
   * 也不需要后端再返回一次 `created`。
   */
  function rebuildCreatedTargets(): CreatedTargetRef[] {
    return Array.from(createdTargets.entries()).map(([rowUid, v]) => ({
      rowUid,
      target: v.target,
      id: v.id,
    }));
  }

  /**
   * 重试上传（**不重复建工单**）。done 态的两种出路：
   *  - 有失败 job → 只重跑 `failedJobs` 里的那些；
   *  - job 列表压根没登记上 → 用 `createdTargets` 现场重建再全跑。
   */
  async function retryFailedUploads(): Promise<void> {
    if (commitStage.value !== 'done' || pdfSubmitting.value) {
      ElMessage.warning('当前没有可重试的上传');
      return;
    }
    const failed = uploadJobs.value.filter((j) => failedJobs.has(j.id));
    const rebuild = needsUploadRebuild.value;
    if (failed.length === 0 && !rebuild) {
      ElMessage.warning('当前没有可重试的上传');
      return;
    }
    submitRowEpoch = rowEpoch.value;
    pdfSubmitting.value = true;
    try {
      if (failed.length > 0) {
        await runUploadJobs(failed);
      } else {
        let jobs: UploadJob[];
        try {
          jobs = buildUploadJobs(rebuildCreatedTargets());
        } catch (e) {
          ElMessageBox.alert(
            `补传仍未能开始：\n${(e as Error).message ?? '上传失败'}\n\n工单已创建，可到零件 / 装配件详情页补传。`,
            '文件上传未开始',
            { type: 'error' },
          );
          return;
        }
        if (jobs.length === 0) {
          // 建单时还在的文件此刻已经不在了（行被删 / 重新解析过）⇒ 再点也补不上，
          // 如实说清出路，不要让用户反复点一个不可能成功的动作。
          ElMessageBox.alert(
            `工单已创建 ${createdCountText()}，但本页已找不到对应的文件（行数据被清空或重新解析过）。\n\n图纸请到零件 / 装配件详情页补传。`,
            '文件上传未开始',
            { type: 'error' },
          );
          return;
        }
        registerUploadJobs(jobs);
        await runUploadJobs(jobs);
      }
    } finally {
      pdfSubmitting.value = false;
    }
    summarizeUploads();
  }

  // 2026-08-27：vue-draggable-plus 的 useDraggable composable 在 unmount 时
  // 自动 destroy，无需手动调用。
  // unmount 时刷新 draft 快照 + 撤销 pending saver（避免 debounce 在组件已销毁后
  // 写入 stale state）。
  onBeforeUnmount(() => {
    closePdfPreview();
    draft.saver.flush();
    draft.saver.cancel();
  });

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
    totalAssemblyChildren,
    sourceTree,
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
    onAsmUnitPriceChange,
    onChildUnitPriceChange,
    onL2Change,
    onAsmPlannedChange,
    // preview
    closePdfPreview,
    previewSourceRow,
    previewStandalonePart,
    previewPdfSourceByUid,
    pdfSourceLabel,
    // selection
    onSourceSelectionChange,
    clearSelection,
    // merge / split
    mergeSelectedAsPart,
    mergeSelectedAsAssembly,
    effectiveChildren,
    onAsmMasterPageChange,
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
    // submit：2026-10-04 单入口（建工单 + 逐 part 后置上传）
    onSubmit,
    retryFailedUploads,
    // 上传状态（行内进度 / 行内单文件重试 / 全局汇总）
    pdfUploadCells,
    threeDUploadCells,
    getRowPdfCell,
    getRowThreeDCell,
    // 阶段机 + 主按钮文案
    commitStage,
    canSubmit,
    submitLabel,
    cellRetryDisabled,
    retryUploadByCell,
  };
}
