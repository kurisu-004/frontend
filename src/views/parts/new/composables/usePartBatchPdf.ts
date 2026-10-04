// Tab 2「PDF 批量上传」composable。
//
// 2026-10-04 单按钮 + 后端上传：提交入口收敛成一个 `onSubmit`，内部三段
// `idle → creating（POST /parts/batch 建工单）→ uploading（逐个 part 后置补传图纸 /
// 3D）→ done`。上传失败语义是「工单已建 + 失败清单可重试」——工单落库不可回滚，
// 所以 `commitStage` 一旦越过 creating 就绝不回 idle（回 idle 会让用户再点一次
// 主按钮，把同一批工单建第二遍），重试一律只补传文件。
//
// 建单只有「部分行成立」时是例外：建出来的行会立刻从本地表格移除（它们已经是真实
// 工单，留着只会诱导重复提交），剩下的失败行才留在表里等下一次提交 ⇒ 阶段此时回
// idle 也不会重复建单。`POST /parts/batch` 无幂等键，任何「同一批行发第二次」都是
// 真建出第二份工单。
//
// 已知取舍（2026-10-04）：本 Tab 的草稿是**只写**的 —— `draft.load()` 只在 saver 里用来
// 读回旧 payload 以保住 Tab 1 的 `manual_tab` 段，没有任何把 `pdf_tab.rows` 灌回
// `standaloneParts` / `assemblies` 的路径。所以刷新后表格是空的、行全部丢失，重新提交
// 必须重新选文件再解析。会**重复建单**的实际触发点是「重新解析」：它把全部行重新列出来
// （含上一次已经建出工单的那些），再点提交就会建第二遍，而 `POST /parts/batch` 无幂等键。
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
import { makeUid, pageUid, parsePageUid, stripExt, todayIso } from './usePartBatchShared';

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

/**
 * row → upload session file 缝合标记（2026-09-18 接入 upload_session 时新增）。
 *
 * 当 row.fileLink 非空时：
 * - client_ref：upload session 中分配的 client_ref（refetch / markComplete /
 *   removeFiles / consumeFiles 都用这个 key）；
 * - sha256：图纸 SHA-256 hex（与后端 SessionFile.content_sha256 对齐，便于
 *   后端 commit 时按 (sha) 验真）；
 * - tmp_key：COS tmp 区 key（提交时挂到 part_batch payload 的 drawing_file）。
 *
 * UI 层根据 fileLink 是否存在决定渲染「已上传」态还是「需选择文件」态。
 */
export interface FileLink {
  client_ref: string;
  sha256: string;
  tmp_key: string;
  /** 文件大小（bytes），用于 row.fileSize 显示；session.files 中也有但不强依赖 */
  file_size?: number;
  /** 原始文件名（仅展示）；session.files.original_filename 同源 */
  original_filename?: string;
  /** 绑定时间（ISO8601）；session.files.uploaded_at 同源，UI 展示用 */
  uploaded_at?: string | null;
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
  /**
   * 2026-09-18 接入 upload_session：当 row 由 session.files 中 status=done 的
   * 条目恢复而来时设置，UI 据此展示「已上传」badge + 跳过文件选择器。
   * 普通新解析行不设置（保持 null）。
   */
  fileLink?: FileLink | null;
  /**
   * 2026-09-18 A3：hydrate 时 snapshot 原 drawing_client_ref 的"曾上传过"标记。
   * 区分两种 null fileLink：
   * - fileLink=null + fileLinkNeedReselect=true → 之前传过但 session 失效，需重传；
   * - fileLink=null + fileLinkNeedReselect=false → 从未上传，保持普通态。
   * 仅 deserialize 时根据 snapshot.drawing_client_ref + drawing 状态写入，
   * 用户编辑 / 新增行不会自动设置（默认 undefined，UI 当 false 处理）。
   */
  fileLinkNeedReselect?: boolean;
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
  /** 2026-09-18 接入 upload_session：见 StandalonePartRow.fileLink 注释 */
  fileLink?: FileLink | null;
  /** 2026-09-18 A3：见 StandalonePartRow.fileLinkNeedReselect 注释 */
  fileLinkNeedReselect?: boolean;
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
  /** 装配体套数（默认 1）。2026-08-04 新增：用于背面页 Q: 打印 */
  quantity: number;
  children: AssemblyChildRow[];
  /** 2026-09-18 接入 upload_session：顶层 master 也可能来自 session.files；见上 */
  fileLink?: FileLink | null;
  /** 2026-09-18 A3：见 StandalonePartRow.fileLinkNeedReselect 注释 */
  fileLinkNeedReselect?: boolean;
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
  splitStandalonePart: (row: StandalonePartRow) => void;
  removePdf: (pdfUid: string) => void;
  removeStandalonePart: (uid: string) => void;
  removeAssembly: (uid: string) => void;
  pdfSourceLabel: (uid: string) => string;
  previewStandalonePart: (row: StandalonePartRow) => void;
  previewPdfSourceByUid: (uid: string) => void;
  onUnitPriceChange: (row: StandalonePartRow, v: number | undefined) => void;
  onChildUnitPriceChange: (c: AssemblyChildRow, v: number | undefined) => void;
  onL2Change: (row: { customer_id: string; customer_name?: string }, v: string) => void;
  onAsmPlannedChange: (asmRow: AssemblyRow, v: string) => void;
  onSourceSelectionChange: (rows: SourceTreeRow[]) => void;
  previewSourceRow: (row: SourceTreeRow) => void;
  pdfUploadCells: Record<string, UploadStatusCell>;
  threeDUploadCells: Record<string, UploadStatusCell>;
  getRowPdfCell: (row: { pdfSourceUid: string }) => UploadStatusCell | undefined;
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
  const totalAssemblyChildren = computed(() =>
    assemblies.value.reduce((sum, a) => sum + a.children.length, 0),
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
    // createdPartIds），先行的 onSubmit 跑完还会照常收口 ⇒ 静默清空刚解析出的行、
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
      // 行 uid 全部换新 ⇒ 上一批的提交状态（partId 映射 / job / 失败清单 / 阶段机）
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
      // 2026-10-03：顶层命中源改为**装配件自身图号** `a.drawing_no`。子件图号是前端按
      // 「首页原图号 / 原图号-02」合成的（见 mergeSelectedAsAssembly /
      // confirmManualAssembly），其中只有第 1 页那个恰好等于装配件自身图号，`-02 / -03`
      // 这些在 Excel 的「物料编号」列里根本不存在 —— 顶层回填认自身图号才是稳的。
      // 保留 child 命中作为回退：Excel 里「逐个子件各占一行」的历史数据，其子件图号就是
      // 物料编号本身，仍应命中。
      const ownHit = excelMap.get(a.drawing_no);
      const childHit = a.children
        .map((c) => excelMap.get(c.drawing_no))
        .find((m): m is BidRow => !!m);
      const hit = ownHit ?? childHit;
      if (hit) {
        // 分厂 / 申请人由顶层统一持有（子件不再各自持有这两个字段）
        if (!a.customer_id) {
          const l2Id = resolveL2CustomerId(hit.deptName);
          if (l2Id) {
            a.customer_id = l2Id;
            const c = customers.value.find((x) => x.id === l2Id);
            a.customer_name = c?.name ?? '';
          }
        }
        a.applicant_name = hit.applicantName || a.applicant_name;
        // 数量 = **整套数量**（业务口径：Excel 的数量是整套的数量）
        a.quantity = hit.quantity || a.quantity;
        if (hit.plannedDeliveryDate) a.planned_delivery_date = hit.plannedDeliveryDate;
      }
      // 2026-10-03 子件口径（业务口径：分厂 / 申请人 / 计划交期是整套共享的，
      // 子件数量需手填、子件不需要单价）：
      //   - 计划交期：顶层填完后同步给全部子件，保证「整套一个交期」。交期既可能来自
      //     Excel，也可能来自用户在顶层手改（`onAsmPlannedChange`），两种来源都会同步
      //     下来；子件单独改过的交期会被顶层值覆盖，与该 handler 的简单覆盖语义一致。
      //   - quantity 保持 makeAssemblyChild 的默认值 1；
      //   - unit_price / total_price 保持默认 null。
      // 单价留空不是漏填，而是整套含税单价在本仓无处落库：`AssemblyRow` 没有
      // unit_price / total_price 字段，后端 `POST /parts/batch` 的 item DTO 也不收
      // （`PartBatchCreateItemFE` 无这两项）⇒ 装配件整套的单价提交时必然丢弃。子件
      // 虽然有这两个字段（`AssemblyChildRow`）和表格里的手填列，提交时同样被丢弃。
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

  /** PR-H 2026-07-28：含税单价改动 → 自动联动 total_price（仅在用户未手动锁定时）；
   *  保留 Excel 回填值优先 —— 若 total_price 已被 Excel 写入过且与自动算的不一致，
   *  仍按 Excel 的值，不强制覆盖（用户可手动改回）。 */
  function onUnitPriceChange(row: StandalonePartRow, v: number | undefined): void {
    row.unit_price = v ?? null;
    // 仅当用户没明确设置过 total_price 时自动算
    if (row.quantity > 0 && row.unit_price != null) {
      row.total_price = row.unit_price * row.quantity;
    }
  }
  function onChildUnitPriceChange(c: AssemblyChildRow, v: number | undefined): void {
    c.unit_price = v ?? null;
    if (c.quantity > 0 && c.unit_price != null) {
      c.total_price = c.unit_price * c.quantity;
    }
  }

  /** PR-H 2026-07-28：3D 模型支持扩展名（与后端 _file_kind_policy.THREE_D_MODEL 对齐）。 */
  const THREE_D_EXTS = ['step', 'stp', 'iges', 'igs', 'stl', 'obj', '3mf'];

  /** 把 3D 模型按文件名解析的 drawing_no 自动挂到独立零件 / 装配件子件行。
   *  - 文件名约定：图号_名称.ext（与 PDF 解析共用 `parseDrawingFilename`，先剥扩展名）。
   *  - 已挂过该图号的 → 跳过（不重复挂）。
   *  - 找不到匹配行 → ElMessage.warning（不报错，整批仍可提交）。 */
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

  /** 用 pdf-lib 合并 PDF 的指定页（0-based pageIndices）→ 新 PDF Blob。 */
  async function mergePages(raw: Blob, pageIndices: number[]): Promise<Blob> {
    const { PDFDocument } = await import('pdf-lib');
    const src = await PDFDocument.load(await raw.arrayBuffer());
    const out = await PDFDocument.create();
    const copied = await out.copyPages(src, pageIndices);
    copied.forEach((p) => out.addPage(p));
    const bytes = await out.save();
    // pdf-lib save() 返回 Uint8Array<ArrayBufferLike>，TS 5+ 要求 BlobPart 严格是
    // ArrayBuffer 类型；slice() 拷贝出独立 ArrayBuffer，避开 SharedArrayBuffer 误判。
    return new Blob([bytes.slice().buffer as ArrayBuffer], { type: 'application/pdf' });
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
      const merged = await mergePages(src.raw, pageIndices);
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
    const asmUid = `asm-${makeUid()}`;
    const children: AssemblyChildRow[] = pageIndices.map((pi) => {
      const drawingNo = parsed.drawingNo
        ? pi === 0
          ? parsed.drawingNo
          : `${parsed.drawingNo}-${String(pi + 1).padStart(2, '0')}`
        : '';
      const name = parsed.partName
        ? pi === 0
          ? parsed.partName
          : `${parsed.partName}-${pi + 1}`
        : '';
      return makeAssemblyChild({
        pdfSourceUid: pdfUid,
        pageIndex: pi,
        drawing_no: drawingNo,
        name: name,
      });
    });
    const created: AssemblyRow = {
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
    };
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
    for (const m of sorted) {
      const parsed = parseDrawingFilename(src.filename);
      const drawingNo = parsed.drawingNo
        ? m.pageIndex === 0
          ? parsed.drawingNo
          : `${parsed.drawingNo}-${String(m.pageIndex + 1).padStart(2, '0')}`
        : '';
      const name = parsed.partName
        ? m.pageIndex === 0
          ? parsed.partName
          : `${parsed.partName}-${m.pageIndex + 1}`
        : '';
      standaloneParts.value.push(
        makeStandaloneRow({
          pdfSourceUid: originUid,
          drawing_no: drawingNo,
          name: name,
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

  function removeAssembly(uid: string): void {
    assemblies.value = assemblies.value.filter((a) => a.uid !== uid);
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
    if (!manualAsmFormValid.value) return;
    const f = manualAsmForm.file!;
    const totalPages = await countPdfPages(f);
    const pdfUid = `manual-asm-${makeUid()}`;
    allPdfs.value.push({
      uid: pdfUid,
      raw: f,
      filename: f.name,
      totalPages,
      synthesized: false,
    });
    const asmUid = `asm-${makeUid()}`;
    const children: AssemblyChildRow[] = [];
    for (let p = 0; p < totalPages; p++) {
      children.push(
        makeAssemblyChild({
          pdfSourceUid: pdfUid,
          pageIndex: p,
          drawing_no:
            totalPages === 1
              ? manualAsmForm.drawing_no.trim()
              : `${manualAsmForm.drawing_no.trim()}-${String(p + 1).padStart(2, '0')}`,
          name:
            totalPages === 1
              ? manualAsmForm.name.trim() || manualAsmForm.drawing_no.trim()
              : `${manualAsmForm.name.trim() || manualAsmForm.drawing_no.trim()}-${p + 1}`,
        }),
      );
    }
    const created: AssemblyRow = {
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
    };
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
   * 同一 PDF 源被多个 row 共享时（assembly 子件继承顶层 PDF），所有 row 显示同一状态。
   */
  function getRowPdfCell(row: { pdfSourceUid: string }): UploadStatusCell | undefined {
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
   * - rowRefs：哪些 row 引用了该文件（同一 PDF 被装配件主子件共享时会有 N 个 ref）。
   *   后置上传按「part × ref」展开 job：同一份原件被 N 个 part 引用就上传 N 次。
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

    // 1) PDF：独立零件行
    for (const r of standaloneParts.value) {
      const src = allPdfs.value.find((s) => s.uid === r.pdfSourceUid);
      if (!src) continue;
      const key = `pdf:${src.uid}`;
      ensure(key, () => ({
        key,
        kind: 'DRAWING',
        filename: src.filename,
        file: ensureFile(src.raw, src.filename),
        size: src.raw.size,
        contentType: src.raw.type || 'application/pdf',
        rowRefs: [],
      })).rowRefs.push({ rowKind: 'standalone', rowUid: r.uid });
    }
    // 2) PDF：装配件顶层（master）
    for (const a of assemblies.value) {
      const src = allPdfs.value.find((s) => s.uid === a.pdfSourceUid);
      if (!src) continue;
      const key = `pdf:${src.uid}`;
      ensure(key, () => ({
        key,
        kind: 'DRAWING',
        filename: src.filename,
        file: ensureFile(src.raw, src.filename),
        size: src.raw.size,
        contentType: src.raw.type || 'application/pdf',
        rowRefs: [],
      })).rowRefs.push({ rowKind: 'asmMaster', rowUid: a.uid });
      // 子件共享同 PDF
      for (const c of a.children) {
        map.get(key)!.rowRefs.push({ rowKind: 'asmChild', rowUid: c.uid, asmUid: a.uid });
      }
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
    for (const a of assemblies.value) {
      for (const c of a.children) {
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

  /** 一次后置上传作业 = 一个 part × 一份原件。 */
  interface UploadJob {
    /**
     * job 的稳定身份 = `${jobKey}:${partId}`（jobKey 已含 `pdf:` / `3d:` 前缀，故
     * 天然区分 kind）。job 状态、失败清单、重试集合全按它寻址 —— 粒度必须是 job
     * 而不是 cell：一份 PDF 被装配件 master + N 个子件共享时会展开成 N+1 个 job，
     * 只失败其中一个时按 cell 重试会把已成功的也重跑一遍，而后端
     * `uk_t_part_file_single(part_id, kind)` 会对二次上传报 21108「相同文件已存在」。
     */
    id: string;
    /** = entry.key（`pdf:<uid>` / `3d:<uid>`），同时是 UI cell 的键。 */
    jobKey: string;
    /** 雪花 ID 字符串（后端 JSON 里是 string）。 */
    partId: string;
    kind: PartFileKind;
    entry: FileUploadEntry;
  }

  /** job 运行时状态。`error` 的错误文案存在 failedJobs 里，不在状态里。 */
  type UploadJobState = 'pending' | 'uploading' | 'done' | 'error';

  /** 本次提交的 `items[i]` 对应的本地行 uid（与 `created[].sourceIndex` 同坐标系）。 */
  const itemRowUids = ref<string[]>([]);

  /** 提交流程阶段机。转移：
   *  - idle → creating → uploading → done
   *  - creating 失败 → 回 idle。前提是 `createdPartIds` 为空（一个 part 都没建出来，
   *    本地表格原样保留，重来不会碰到已落库的工单）。`createdPartIds` 非空说明已经
   *    有 part 建出来了，此时回 idle 会诱导重复建单，必须走下面的部分成功分支。
   *  - 建单「部分行成立」→ 同样回 idle，但前提是**建成的行已被移出本地表格**（见
   *    dropCreatedRows），下一次提交只会发出剩下的失败行
   *  - uploading 阶段失败 → 转 done 走失败清单（工单已落库，回 idle 会让用户再点
   *    一次主按钮、把同一批工单建第二遍）
   *  - done（全成功）→ 清空跳页；done（有失败 job）→ 只走重试上传，不再建单；
   *    done（job 列表没登记上）→ 现场重建 job 再补传，仍不建单 */
  const commitStage = ref<'idle' | 'creating' | 'uploading' | 'done'>('idle');

  /**
   * 本地 rowUid → 已建出的 partId。**跨 done 保留**（重试路径绝不清空）：工单已落库
   * 不可回滚，这是同一次页面停留内「重试只重传文件、绝不重复建 part」的唯一保证。
   * 跨刷新的取舍见文件头注释。
   *
   * reactive（Vue 的集合代理）⇒ `size` 可以直接进 computed 判「工单已建但 job 未登记」。
   */
  const createdPartIds = reactive(new Map<string, string>());

  /**
   * 2026-10-04：建单「部分行成立」时装配顶层（master）已经建出的那些行。
   *
   * 装配件顶层在 UI 上是一行、提交时却与子件各自成为独立 item：顶层建出而某个子件
   * 被拒时，这一行不能整行删掉（被拒子件得留着重发），也不能整行重发（顶层会再建成
   * 一份）。所以顶层建出的事实单独记在这里，`buildCommitItems` 据此跳过它。
   * 生命周期跟着行 uid：行被删 / 全成功清场 / 重新解析出新的 uid 后自然失效。
   */
  const createdAssemblyMasters = reactive(new Set<string>());

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
   * `createdPartIds` / job / 失败清单都再也对不上表里任何一行）。
   * 阶段回 idle：这是新的一批内容，可以正常提交。
   *
   * 调用方必须先过 `guardRowMutation`：这一句会把 `commitStage` 打回 idle，而
   * `commitStage` 是「第二次建单」唯一的连点闸门 —— 提交在途时打掉它，主按钮的
   * `disabled` 就成了唯一防线。
   */
  function resetCommitState(): void {
    commitStage.value = 'idle';
    createdPartIds.clear();
    createdAssemblyMasters.clear();
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
   * 提交在途时建出来的新行没有 partId、也不会被本次 job 覆盖，成功收口会把它跟
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
   * 同一份文件可能被 N+1 个 job 共用一个 cell：任一 job 失败即 error（该文件确实
   * 没传全），但重试时只重跑失败的那个 job，成功过的不会再动。error 文案取第一个
   * 失败 job 的错误（同一份文件、同一批请求，错误基本一致）。
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

  /** 失败 job 清单（每行 = 一个 part × 一份原件），汇总时弹给用户看。 */
  function failedJobLines(): string[] {
    return Array.from(failedJobs.values()).map(
      (f) => `第 ${f.job.partId} 号零件 · ${f.job.entry.filename}：${f.error}`,
    );
  }

  /**
   * 汇总上传结果：无失败 → 提示 + 清空跳页；有失败 → 弹清单 + 保留现场供重试。
   *
   * **前提**：行集合自 `submitRowEpoch` 快照以来没被改过（见开头的世代校验）。收口的
   * 计数 / 清场 / 跳页全部以「当前表格 == 建单时那张表」为前提，不成立就只能如实告知。
   *
   * 计数口径统一为 **job**（一个 part × 一份原件 = 一项），与下面清单的行一一对应：
   * 一份 PDF 被装配件 master + N 子件共享时是 N+1 项，标题若按「文件数」算就会
   * 出现「1 个文件失败」底下列两行零件号的矛盾。涉及的零件数 / 文件数作为补充
   * 信息一并给出。
   *
   * 成功判据是「**全部已登记 job 都判成功**」，不是「failedJobs 为空」：登记 / 调度
   * 被打断时，未被调度的 job 停在 `pending` 且不在 `failedJobs` 里，只看 failedJobs 会
   * 把「一个文件都没传上去」当成功收口（清空现场 + 跳页）。未完成的先补记进
   * `failedJobs` 再弹清单。`uploadJobs` 为空但工单已建（job 构造抛错）同样不算成功。
   */
  function summarizeUploads(): void {
    // 2026-10-04 世代校验，必须**先于**任何收口动作。行集合在提交期间被换过（重新解析
    // 会把 `createdPartIds` 一并清空、行 uid 全部换新）时，下面的计数 / 清场 / 跳页
    // 都对不上当前表格：走成功收口会把用户刚建好的行静默清掉、跳到零件列表、再弹一条
    // 「成功创建 0 条零件」的假提示，而工单其实已经落库了。
    if (rowEpoch.value !== submitRowEpoch) {
      const lost = failedJobs.size > 0 ? `其中 ${failedJobs.size} 项文件未上传成功。\n` : '';
      ElMessageBox.alert(
        `工单已经创建，但提交期间本地表格被改过，本次结果已无法与当前表格对应。\n` +
          `${lost}\n已创建的工单请到零件列表查看，图纸可在零件详情页补传。`,
        '提交结果请到零件列表核对',
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
    if (uploadJobs.value.length === 0 && createdPartIds.size > 0) {
      ElMessageBox.alert(
        `工单已创建 ${createdPartIds.size} 条零件，但文件一个都没上传（上传任务没能登记）。\n\n可在本页点「重试上传」补传（不会重复建单）。`,
        '文件上传未开始',
        { type: 'error' },
      );
      return;
    }
    if (failedJobs.size > 0) {
      const lines = failedJobLines();
      const partCount = new Set(Array.from(failedJobs.values(), (f) => f.job.partId)).size;
      const fileCount = new Set(Array.from(failedJobs.values(), (f) => f.job.jobKey)).size;
      const sample = lines.slice(0, 5).join('\n');
      const more = lines.length > 5 ? `\n…还有 ${lines.length - 5} 项失败` : '';
      ElMessageBox.alert(
        `工单已创建，但 ${failedJobs.size} 项上传失败（涉及 ${partCount} 个零件 / ${fileCount} 个文件）：\n${sample}${more}\n\n可在本页重试上传（不会重复建单）。`,
        '文件上传失败',
        { type: 'warning' },
      );
      return;
    }
    const standaloneCount = standaloneParts.value.length;
    const assemblyMasters = assemblies.value.length;
    const childCount = assemblies.value.reduce((s, a) => s + a.children.length, 0);
    ElMessage.success(
      `成功创建 ${createdPartIds.size} 条零件（${standaloneCount} 独立 + ${assemblyMasters} 装配件顶层 + ${childCount} 子件）`,
    );
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
    createdPartIds.clear();
    createdAssemblyMasters.clear();
    itemRowUids.value = [];
    successNextTab.value = 'manual';
    router.push('/parts?status=PENDING');
  }

  /**
   * 跑一批 job（受控并发）。成败记在 job 上（jobStates / failedJobs）再由 syncCells
   * 推导 cell 状态；单个 job 抛错只记失败、不影响其它 job，也不外抛。
   *
   * 已在途的 job 直接跳过（`runningJobIds`）：同一次上传请求重复发出去既浪费带宽，
   * 又会撞后端唯一索引。
   *
   * 命中 `isPartFileDuplicateError`（后端说这个 part 的这个 kind 已有文件）按**成功**
   * 收：该 kind 下已有文件就说明那份文件已经在服务端，此刻把它记成失败会让每次重试
   * 都稳定再拿一次同一个码，UI 永远停在假错误里（成因是上一次上传「已落库但响应
   * 丢失」）。
   */
  async function runUploadJobs(jobs: UploadJob[]): Promise<void> {
    const runnable = jobs.filter((j) => !runningJobIds.has(j.id));
    if (runnable.length === 0) return;
    await runWithConcurrency(runnable, PART_UPLOAD_CONCURRENCY, async (job) => {
      runningJobIds.add(job.id);
      jobStates.set(job.id, 'uploading');
      syncCells();
      try {
        if (job.kind === 'DRAWING') await uploadPartDrawing(job.partId, job.entry.file);
        else await uploadPart3DModel(job.partId, job.entry.file);
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
      ...(r.fileLink
        ? { drawing_client_ref: r.fileLink.client_ref, drawing_sha256: r.fileLink.sha256 }
        : {}),
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
      ...(a.fileLink
        ? { drawing_client_ref: a.fileLink.client_ref, drawing_sha256: a.fileLink.sha256 }
        : {}),
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
      ...(c.fileLink
        ? { drawing_client_ref: c.fileLink.client_ref, drawing_sha256: c.fileLink.sha256 }
        : {}),
    };
  }

  /**
   * 2026-10-04：工单已建、但上传 job 列表没登记上（构造 job 抛错 / 登记被打断）。
   *
   * 这时 `failedJobs` 是空的，只按「有失败 job」判可点会让主按钮显示「提交创建（N 个
   * 零件）」却永久 disabled —— UI 在邀请一个点不动的动作，而用户看到自己填好的行唯一
   * 合理的动作就是再点一次，那会把工单再建一遍。出路是现成的：`createdPartIds` 与
   * `itemRowUids` 还在手上，现场重建 job 列表即可（不碰建单）。
   */
  const needsUploadRebuild = computed<boolean>(
    () => createdPartIds.size > 0 && uploadJobs.value.length === 0,
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
      const n = hasUploadErrors.value ? failedJobCount.value : createdPartIds.size;
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

  /** 本地行 → `POST /parts/batch` 的 item（不含文件：文件走后置上传）。
   *
   * 展平顺序固定，且**必须**与 `res.created[].sourceIndex` 的坐标系一致：
   * 独立零件 → 装配件顶层（master）→ 装配件子件。
   * 装配件主子件各建一个独立 part（`POST /parts/batch` 无 assembly 概念），
   * 子件继承顶层的申请人 / 分厂。
   */
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
      });
    }
    for (const a of assemblies.value) {
      // 顶层 master part（也是独立 part，不创建 assembly 父节点）。部分成功收口后
      // 顶层已建出（createdAssemblyMasters），再发一次就是重复建单。
      if (!createdAssemblyMasters.has(a.uid)) {
        rowUids.push(a.uid);
        items.push({
          name: a.name || a.drawing_no || `装配件-${a.uid}`,
          drawing_no: a.drawing_no || '',
          applicant_name: a.applicant_name,
          applicant_id: null,
          quantity: a.quantity,
          request_date: a.request_date,
          planned_delivery_date: a.planned_delivery_date || a.request_date,
          is_urgent: a.is_urgent,
          order_no: a.order_no,
          system_delivery_date: a.system_delivery_date,
          note: a.note,
          customer_id: a.customer_id,
        });
      }
      // 子件：每个子件一个 part（共享顶层 PDF）
      for (const c of a.children) {
        rowUids.push(c.uid);
        items.push({
          name: c.name || `子件${c.page_index + 1}`,
          drawing_no: c.drawing_no,
          applicant_name: a.applicant_name, // 继承顶层
          applicant_id: null,
          quantity: c.quantity,
          request_date: c.request_date,
          planned_delivery_date: c.planned_delivery_date || c.request_date,
          is_urgent: c.is_urgent,
          order_no: c.order_no,
          system_delivery_date: c.system_delivery_date,
          note: c.note,
          customer_id: a.customer_id, // 分厂继承顶层
        });
      }
    }
    return { items, rowUids };
  }

  /**
   * 建单结果里 `buildUploadJobs` 真正用到的部分：partId + 它对应的请求 items 下标。
   * 收窄成这个形状是为了让「job 登记失败后用 createdPartIds 现场重建」不必伪造整个
   * `PartItem`（重建路径拿不到后端吐回的那些字段，而这里一个都不读）。
   */
  interface CreatedPartRef {
    id: string | number;
    sourceIndex: number;
  }

  /** 本次提交要上传的 part + 文件的对应关系（`POST /parts/batch` 返回后调用一次）。 */
  function buildUploadJobs(parts: CreatedPartRef[]): UploadJob[] {
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
    for (const part of parts) {
      // 用 sourceIndex 反查源行，不靠数组下标 —— 它才是「建出来的 part ↔ 本地哪一行」
      // 的权威锚。
      const rowUid = itemRowUids.value[part.sourceIndex];
      if (!rowUid) continue;
      const partId = String(part.id);
      for (const entry of byRow.get(rowUid) ?? []) {
        jobs.push({
          id: `${entry.key}:${partId}`,
          jobKey: entry.key,
          partId,
          kind: entry.kind,
          entry,
        });
      }
    }
    // 同一份 PDF 被装配件 master + N 个子件共享时，这里会产出 N+1 个 job（每个 part
    // 各上传一次）。这是本次改造的已知代价：请求数比「建单时各带一份绑定」高，
    // 但换来的是建单与文件上传彻底解耦（上传失败不再需要回滚工单）。
    return jobs;
  }

  /**
   * 把 `createdPartIds` 里的那些行从本地表格移走。
   *
   * 这些行对应的 part 已经是服务端里的真实工单了，留在表内只会诱导「再点一次提交」
   * ⇒ 重复建单。`itemRowUids` 保持原样（补传 job 仍要靠它把 partId 对回 PDF）。
   *
   * 装配件按 part 粒度摘：子件各自是独立 part，摘掉建出的那些；顶层只在**连子件一起
   * 全部建出**时才整行删除 —— 只要还有子件没建出就得把这一行留着（被拒子件的数据在
   * 这里），而顶层本身记进 `createdAssemblyMasters`，下一次提交只发剩下的子件。
   * `allPdfs` 里的原件一律留着（源文件区仍可预览，也不参与提交）。
   */
  function dropCreatedRows(): void {
    standaloneParts.value = standaloneParts.value.filter((r) => !createdPartIds.has(r.uid));
    const kept: AssemblyRow[] = [];
    for (const a of assemblies.value) {
      const masterCreated = createdPartIds.has(a.uid);
      if (masterCreated) createdAssemblyMasters.add(a.uid);
      a.children = a.children.filter((c) => !createdPartIds.has(c.uid));
      if (masterCreated && a.children.length === 0) continue;
      kept.push(a);
    }
    assemblies.value = kept;
  }

  /** 建单「有行没建出来」的清单文案（服务端逐行拒绝 + 整组请求失败两段）。 */
  function buildCreateRejectionText(res: PartBatchResult, createdCount: number): string {
    const groupErrors = res.groupErrors ?? [];
    const sample = res.failed
      .slice(0, 5)
      .map((f) => `第 ${f.index + 1} 行：${f.message}`)
      .join('\n');
    const more = res.failed.length > 5 ? `\n…还有 ${res.failed.length - 5} 行被拒绝` : '';
    const groupLines = groupErrors.map(
      (g) => `第 ${g.startIndex + 1}-${g.endIndex + 1} 行（分厂 ${g.customer_id}）：${g.message}`,
    );
    const groupNote = groupLines.length
      ? `\n\n另有 ${groupLines.length} 个分厂组请求失败，成功与否未知（响应丢失时后端可能已落库）：\n${groupLines
          .slice(0, 3)
          .join('\n')}\n重新提交这些行前建议先到零件列表核对。`
      : '';
    if (createdCount === 0)
      return `服务端拒绝了 ${res.failed.length} 行：\n${sample}${more}${groupNote}`;
    const rejected = res.failed.length
      ? `${res.failed.length} 行被服务端拒绝：\n${sample}${more}`
      : '';
    return (
      `已创建 ${createdCount} 条工单；${rejected || '其余行未建出。'}\n` +
      `已创建的工单尚未上传图纸，可在零件详情页补传。\n建成的行已从表格移除，` +
      `直接重新提交只会发出剩下的行。${groupNote}`
    );
  }

  /** 主按钮：创建工单 + 逐 part 后置上传图纸 / 3D（单入口，2026-10-04）。 */
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

    submitRowEpoch = rowEpoch.value;
    pdfSubmitting.value = true;
    commitStage.value = 'creating';
    try {
      // applicant dedupe 在本 Tab 不需要：JSON 端点不接受 applicant_id，
      // applicant_name 走字符串直存，同名只会在 t_part.applicant_name 出现重复字符串。
      const res = await batchCreateParts(items);

      // 记下「建出来的 part ↔ 本地哪一行」，这是后置上传的锚
      createdPartIds.clear();
      res.created.forEach((c) => {
        const rowUid = itemRowUids.value[c.sourceIndex];
        if (rowUid) createdPartIds.set(rowUid, String(c.id));
      });

      if (res.failed.length > 0 || (res.groupErrors?.length ?? 0) > 0) {
        if (createdPartIds.size === 0) {
          // 一个 part 都没建出来 ⇒ 本地表格原样保留，回 idle 让用户改完再提交。
          ElMessageBox.alert(buildCreateRejectionText(res, 0), '部分行未通过', { type: 'warning' });
          commitStage.value = 'idle';
          return;
        }
        // 部分成功：建成的行移出表格（它们已经是真实工单），剩下的失败行留在表里。
        // 此时回 idle 是安全的 —— 下一次提交只会发出剩下的行，不可能重复建已建成的行。
        dropCreatedRows();
        ElMessageBox.alert(buildCreateRejectionText(res, createdPartIds.size), '部分行未通过', {
          type: 'warning',
        });
        commitStage.value = 'idle';
        return;
      }

      commitStage.value = 'uploading';
      let jobs: UploadJob[];
      try {
        jobs = buildUploadJobs(res.created);
      } catch (e) {
        // 工单已落库，但一条上传都还没发出去（job 登记前就抛了）⇒ 封住「再提交一次
        // 就多建一批工单」的口子：转 done（canSubmit 只剩「重建 job 补传」这一条出路），
        // 并保留 createdPartIds / itemRowUids —— 用户点「重试上传」时靠它们现场重建
        // job 列表，仍然不建单。
        commitStage.value = 'done';
        ElMessageBox.alert(
          `工单已创建 ${createdPartIds.size} 条零件，但文件未能开始上传：\n${(e as Error).message ?? '上传失败'}\n\n请点「重试上传」在本页补传（不会重复建单）；若一直失败，可到零件详情页补传。`,
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
        // creating 阶段的兜底。走到这里的**前提**是 `createdPartIds` 为空：建单结果
        // 一拿到就已写进 createdPartIds（见上方 forEach），非空说明已有 part 落库。
        // 非空时**绝不能**回 idle —— 主按钮会重新可点，用户再按一次就是已建出的那批
        // 工单建第二遍（`POST /parts/batch` 无幂等键）；改走 done 态补传语义，工单
        // 已落库的事实如实转达。
        if (createdPartIds.size > 0) {
          commitStage.value = 'done';
          ElMessageBox.alert(
            `工单已创建 ${createdPartIds.size} 条零件，但提交过程中出错：\n${msg}\n\n请点「重试上传」在本页补传（不会重复建单）；若一直失败，可到零件详情页补传。`,
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
   * 由 `createdPartIds` + `itemRowUids` 现场还原「partId ↔ 请求 items 下标」。
   *
   * `buildUploadJobs` 抛错时 job 列表没登记上，但它的两个入参还在手上，所以重建
   * 不需要重新建单、也不需要后端再返回一次 `created`。
   */
  function rebuildCreatedPartRefs(): CreatedPartRef[] {
    const refs: CreatedPartRef[] = [];
    itemRowUids.value.forEach((rowUid, sourceIndex) => {
      const partId = createdPartIds.get(rowUid);
      if (partId) refs.push({ id: partId, sourceIndex });
    });
    return refs;
  }

  /**
   * 重试上传（**不重复建工单**）。done 态的两种出路：
   *  - 有失败 job → 只重跑 `failedJobs` 里的那些；
   *  - job 列表压根没登记上 → 用 `createdPartIds` + `itemRowUids` 现场重建再全跑。
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
          jobs = buildUploadJobs(rebuildCreatedPartRefs());
        } catch (e) {
          ElMessageBox.alert(
            `补传仍未能开始：\n${(e as Error).message ?? '上传失败'}\n\n工单已创建，可到零件详情页补传。`,
            '文件上传未开始',
            { type: 'error' },
          );
          return;
        }
        if (jobs.length === 0) {
          // 建单时还在的文件此刻已经不在了（行被删 / 重新解析过）⇒ 再点也补不上，
          // 如实说清出路，不要让用户反复点一个不可能成功的动作。
          ElMessageBox.alert(
            `工单已创建 ${createdPartIds.size} 条，但本页已找不到对应的文件（行数据被清空或重新解析过）。\n\n图纸请到零件详情页补传。`,
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
