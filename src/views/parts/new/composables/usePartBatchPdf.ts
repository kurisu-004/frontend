// Tab 2「PDF 批量上传」composable。
//
// 2026-08-25 拆分：原 PartBatchNew.vue 第 1605-2857 行的「PDF 上传 + 拆页 + 合并 + 提交」
// 整段抽到本文件 + PartBatchPdfTab.vue。
//
// 2026-09-18 接入 backend-rust `/api/v2/upload-sessions/*` 共享 STS session pool：
// - onStartUpload 不再每文件并发调 `grantStsTmpKey`，改为单次 `session.allocate(N)`
//   拿整批 tmp_key；session 凭证过期由 `useUploadSession` 定时器自动续期。
// - useCosUpload 的 `refetchIntents` 回调改为 `session.renew()` + 从最新 session
//   字段重建 UploadIntentsOut。
// - onCommit 成功后调 `session.consumeFiles(submittedClientRefs)` 通知后端延长
//   tmp 对象保留窗口（便于后端事务内 head + copy）。
// - mount 时 `useUploadSession.init('parts_new')` + 配合 `usePartsNewDraft` 恢复
//   session.files 中 status='done' 的条目到 rows 的「已上传」区。

import {
  computed,
  onBeforeUnmount,
  onMounted,
  provide,
  reactive,
  ref,
  shallowRef,
  watch,
  type ComputedRef,
  type Ref,
  type ShallowRef,
} from 'vue';
import type { UseCosUploadReturn } from '@/composables/useCosUpload';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox, type UploadFile } from 'element-plus';
import { useLazyDraggable } from '@/composables/useLazyDraggable';
import { useCosUpload, type CosUploadItem } from '@/composables/useCosUpload';
import { batchCreateParts, type PartBatchCreatePayload } from '@/api/parts';
import { getUploadSession } from '@/views/parts/new/composables/useUploadSession';
import {
  usePartsNewDraft,
  mergeDraftWithSession,
  type MergeResult,
  type SerializedAssemblyChildRow,
  type SerializedAssemblyRow,
  type SerializedPdfTab,
  type SerializedStandalonePartRow,
} from '@/views/parts/new/composables/usePartsNewDraft';
import type { Customer } from '@/api/customer';
import type { FileBinding, PartFileKind, UploadIntentsOut } from '@/types/part_file';
import type { SessionFile } from '@/types/upload_session';
import { computeSha256 } from '@/utils/fileHash';
import { parseBidExcel, type BidRow, type ParseResult } from '@/utils/bidExcelParser';
import { parseHistoricalPriceExcel } from '@/utils/historicalPriceExcelParser';
import { parseDrawingFilename } from '@/utils/drawingFilename';
import { findElTableTbody } from '@/utils/elTable';
import { pdfjsLib } from '@/utils/pdfjs';
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
 */
export interface UploadStatusCell {
  /** 当前阶段：hashing / uploading / done / error / pending。 */
  status: 'pending' | 'hashing' | 'uploading' | 'done' | 'error';
  /** 0-100。hashing 与 uploading 阶段都走该字段。 */
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
  standaloneTableRef: Ref<{ $el?: HTMLElement } | null>;
  assembliesTableRef: Ref<{ $el?: HTMLElement } | null>;
  standaloneTbodyRef: Ref<HTMLElement | null>;
  assembliesTbodyRef: Ref<HTMLElement | null>;
  originalPdfs: ComputedRef<PdfSource[]>;
  totalAssemblyChildren: ComputedRef<number>;
  sourceTree: ComputedRef<SourceTreeRow[]>;
  onPdfChange: (file: UploadFile) => void;
  onPdfRemove: (file: UploadFile) => void;
  onExcelChange: (file: UploadFile) => void;
  onExcelRemove: (file: UploadFile) => void;
  onThreeDModelChange: (file: UploadFile) => void;
  onThreeDModelRemove: (file: UploadFile) => void;
  rebuildFromUploads: () => Promise<void>;
  previewAt: (pdfSourceUid: string, title: string, page: number) => void;
  closePdfPreview: () => void;
  pdfPreviewing: Ref<PdfPreviewState | null>;
  pdfPreviewVisible: Ref<boolean>;
  resolveTbody: (tableRef: Ref<{ $el?: HTMLElement } | null>) => HTMLElement | null;
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
  hydrateResult: Ref<MergeResult | null>;
  hydrateRestoredCount: ComputedRef<number>;
  // 2026-09-21 fix：原 unknown[] 与 PartBatchNew.vue v-bind propType `{client_ref, kind,
  // original_filename, file_size, uploaded_at}[]` 不兼容；收紧到 SessionFile[]（后端
  // /upload-sessions 单端点唯一结构，hydrate 输出与 UI 期望一致）。
  orphanFileRefs: ComputedRef<SessionFile[]>;
  pdfUploadCells: Record<string, UploadStatusCell>;
  threeDUploadCells: Record<string, UploadStatusCell>;
  allUploadsDone: ComputedRef<boolean>;
  hasUploadErrors: ComputedRef<boolean>;
  getRowPdfCell: (row: { pdfSourceUid: string }) => UploadStatusCell | undefined;
  getRowThreeDCell: (row: { three_d_index: number | null }) => UploadStatusCell | undefined;
  cosUpload: ShallowRef<UseCosUploadReturn | null>;
  cosItemsRef: Ref<CosUploadItem[]>;
  uploadStage: Ref<'idle' | 'uploading' | 'uploaded' | 'committed'>;
  canStartUpload: ComputedRef<boolean>;
  canSubmitCreate: ComputedRef<boolean>;
  retryUploadByRow: (rowUid: string, slot: 'pdf' | '3d', threeDIndex?: number) => Promise<void>;
  onStartUpload: () => Promise<void>;
  // 2026-09-21 fix：PartBatchNew.vue 在 v-bind 时传了 onCommit，但 T-B8 显式返回类型化时漏声明。
  onCommit: () => Promise<void>;
  validateL2Customers: () => boolean;
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

  /** PDF 按页数动态读取（pdfjs-dist）。与 composables/usePdfPageCount.ts 同模式：
   *  destroy() 在 PDFDocumentLoadingTask 上，不在 PDFDocumentProxy 上（旧实现
   *  调 doc.destroy() 抛 "doc.destroy is not a function"）。 */
  async function countPdfPages(file: File): Promise<number> {
    const buf = await file.arrayBuffer();
    const task = pdfjsLib.getDocument({ data: buf });
    try {
      const doc = await task.promise;
      return doc.numPages;
    } finally {
      await task.destroy();
    }
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
    pdfBuildingTree.value = true;
    try {
      // 解析 Excel（可选）
      let excelByDrawingNo: Map<string, BidRow> | null = null;
      if (excelFiles.value.length > 0) {
        const raw = excelFiles.value[0].raw as File | undefined;
        if (raw) {
          const rows = await readExcel(raw);
          excelByDrawingNo = new Map(rows.map((r) => [r.drawingNo, r]));
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
      if (excelByDrawingNo) applyExcelToAll(excelByDrawingNo);
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

  /** 用 Excel 行覆盖表内字段（applicant / quantity / planned_delivery_date + 分厂 L2 + 单价）。
   *  2026-07-30 起不再覆盖 is_urgent（批量 PDF 导入默认全部不加急，由用户手动 switch）。 */
  function applyExcelToAll(excelByDrawingNo: Map<string, BidRow>): void {
    for (const r of standaloneParts.value) {
      const matched = excelByDrawingNo.get(r.drawing_no);
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
    for (const a of assemblies.value) {
      // 顶层分厂 / 申请人：用第一个能在 Excel 查到的 child 的行（child 不再各自持有这两个字段）
      const firstHit = a.children
        .map((c) => excelByDrawingNo.get(c.drawing_no))
        .find((m): m is BidRow => !!m);
      if (firstHit) {
        if (!a.customer_id) {
          const l2Id = resolveL2CustomerId(firstHit.deptName);
          if (l2Id) {
            a.customer_id = l2Id;
            const c = customers.value.find((x) => x.id === l2Id);
            a.customer_name = c?.name ?? '';
          }
        }
        a.applicant_name = firstHit.applicantName || a.applicant_name;
      }
      // 子件继承 quantity / urgent / planned_delivery_date / 单价 / 总价
      for (const c of a.children) {
        const matched = excelByDrawingNo.get(c.drawing_no);
        if (!matched) continue;
        c.quantity = matched.quantity || c.quantity;
        // 2026-07-30：子件不再从应标 Excel 继承 is_urgent。
        if (matched.plannedDeliveryDate) c.planned_delivery_date = matched.plannedDeliveryDate;
        // PR-H 2026-07-28：含税单价 / 总价
        if (matched.unitPrice != null) c.unit_price = matched.unitPrice;
        if (matched.totalPrice != null) c.total_price = matched.totalPrice;
      }
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

    if (pageIndices.length === src.totalPages) {
      // 全部页 → 直接复用原 PDF，无合成
      standaloneParts.value.push(
        makeStandaloneRow({
          pdfSourceUid: pdfUid,
          drawing_no: parseDrawingFilename(src.filename).drawingNo || '',
          name: parseDrawingFilename(src.filename).partName || '',
        }),
      );
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
      standaloneParts.value.push(
        makeStandaloneRow({
          pdfSourceUid: newUid,
          pageCount: pageIndices.length,
          mergedFrom: pageIndices.map((i) => ({ pdfUid, pageIndex: i })),
          drawing_no: parseDrawingFilename(src.filename).drawingNo || '',
          name: parseDrawingFilename(src.filename).partName || '',
        }),
      );
    }
    // 移除原 standalone 行（如果存在）
    clearSelection();
    ElMessage.success(`已合并 ${pageIndices.length} 页 → 独立零件`);
  }

  /** 合并选中页 → 一个装配件（同一 PDF，至少 2 页）。 */
  async function mergeSelectedAsAssembly(): Promise<void> {
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
    });
    clearSelection();
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
    standaloneParts.value.push(
      makeStandaloneRow({
        pdfSourceUid: pdfUid,
        drawing_no: manualPartForm.drawing_no.trim(),
        name: manualPartForm.name.trim(),
      }),
    );
    manualPartDialogVisible.value = false;
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
    });
    manualAsmDialogVisible.value = false;
    ElMessage.success(`已新增装配件（共 ${totalPages} 子件）`);
  }

  // ============================================================
  // 2026-09-16 T3.4：COS 直传 + JSON batchCreate 链路
  // ============================================================

  /** 反查用：client_ref → status cell（map 而非 reactive 数组，配合 watch deep）。 */ const pdfUploadCells =
    reactive<Record<string, UploadStatusCell>>({});
  const threeDUploadCells = reactive<Record<string, UploadStatusCell>>({});

  /**
   * 任意 Blob → File。PdfSource.raw 在合成路径（pdf-lib save()）下是 Blob 而非 File，
   * computeSha256 / cos-js-sdk-v5 都接受 File 或 Blob，但 hash-wasm.createSHA256
   * 默认按 File.slice 分块，两者等价。这里统一包成 File 以简化下游类型。
   */
  function ensureFile(blob: Blob, filename: string): File {
    if (blob instanceof File) return blob;
    return new File([blob], filename, { type: blob.type || 'application/octet-stream' });
  }

  /**
   * 受控并发跑 async 函数（与 useCosUpload.ts::runWithConcurrency 同语义；本文件
   * 的 hash 阶段独立一份以避免暴露 useCosUpload 内部 API）。
   */
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

  /** 全局上传就绪状态：所有 file cell 都为 done（用于提交按钮 disabled）。 */
  const allUploadsDone = computed<boolean>(() => {
    const keys = Object.keys(pdfUploadCells);
    const tkeys = Object.keys(threeDUploadCells);
    if (keys.length === 0 && tkeys.length === 0) return true; // 无文件 = 视为就绪
    return (
      keys.every((k) => pdfUploadCells[k]?.status === 'done') &&
      tkeys.every((k) => threeDUploadCells[k]?.status === 'done')
    );
  });

  /** 当前是否有任何文件上传失败（用于提交按钮 disabled）。 */
  const hasUploadErrors = computed<boolean>(() => {
    return (
      Object.values(pdfUploadCells).some((c) => c.status === 'error') ||
      Object.values(threeDUploadCells).some((c) => c.status === 'error')
    );
  });

  /** UI 调用：从 cosUpload.items[index] 同步 cell。 */
  function syncCellsFromCosItems(items: CosUploadItem[], entries: FileUploadEntry[]): void {
    items.forEach((it, idx) => {
      const entry = entries[idx];
      if (!entry) return;
      const cell: UploadStatusCell = {
        status: it.status,
        progress: it.progress,
        error: it.error,
      };
      if (entry.kind === 'DRAWING') {
        pdfUploadCells[entry.key] = cell;
      } else {
        threeDUploadCells[entry.key] = cell;
      }
    });
  }

  /**
   * 文件上传条目（统一容器）。
   * - key：UI 反查用（`pdf:${srcUid}` / `3d:${fileUid}`）。
   * - rowRefs：哪些 row 引用了该文件（同一 PDF 被多个 row 共享时会有 N 个 ref）。
   * - sha / clientRef / tmpKey：hash + createUploadIntents + 上传完成后回填。
   */
  interface FileUploadEntry {
    key: string;
    kind: PartFileKind;
    filename: string;
    file: File;
    size: number;
    contentType: string;
    sha?: string;
    clientRef?: string;
    tmpKey?: string;
    rowRefs: RowRef[];
  }
  /** row 反向引用：哪个 row 用了哪个文件（用于回填 FileBinding）。 */
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
        rowRefs: [{ rowKind: 'standalone', rowUid: r.uid }],
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
    const referencedThreeD = new Set<number>();
    for (const r of standaloneParts.value) {
      if (r.three_d_index !== null) referencedThreeD.add(r.three_d_index);
    }
    for (const a of assemblies.value) {
      for (const c of a.children) {
        if (c.three_d_index !== null) referencedThreeD.add(c.three_d_index);
      }
    }
    referencedThreeD.forEach((idx) => {
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
      }));
    });
    return Array.from(map.values());
  }

  /** 从已上传的 entry 构建 FileBinding（提交时挂到 row 的 drawing_file/model3d_file）。 */
  function buildBindingFromEntry(entry: FileUploadEntry): FileBinding | undefined {
    if (!entry.tmpKey || !entry.sha) return undefined;
    return {
      tmp_key: entry.tmpKey,
      content_sha256: entry.sha,
      original_filename: entry.filename,
      file_size: String(entry.size),
      content_type: entry.contentType,
    };
  }

  /** 给 row 反查它对应的 PDF entry（用于把 FileBinding 写回）。 */
  function findPdfEntryForRow(rowUid: string): FileUploadEntry | undefined {
    for (const e of lastUploadEntries) {
      if (e.kind !== 'DRAWING') continue;
      if (e.rowRefs.some((r) => r.rowUid === rowUid)) return e;
    }
    return undefined;
  }
  /** 给 row 反查它对应的 3D entry。 */
  function findThreeDEntryForRow(rowUid: string, threeDIndex: number): FileUploadEntry | undefined {
    const f = threeDModelFiles.value[threeDIndex];
    if (!f) return undefined;
    const key = `3d:${f.uid}`;
    return lastUploadEntries.find((e) => e.key === key);
  }

  /**
   * 2026-09-18 A2 修复：cosItem 变 done 时，按 entry.rowRefs 反查 row，把
   * client_ref / sha / tmp_key 写入对应 row.fileLink（PDF Tab 的 fileLink
   * 是 UI 渲染「已上传 / 需重传」tag 的唯一信号源）。
   *
   * rowRefs 三种形态：standalone / asmMaster / asmChild。
   * - asmMaster 写顶层 AssemblyRow.fileLink；
   * - asmChild 按 asmUid 定位顶层，再写顶层.children[child.uid].fileLink；
   * - standalone 直接写 StandalonePartRow.fileLink。
   */
  function writeRowFileLink(
    entry: FileUploadEntry,
    payload: { client_ref: string; sha256: string; tmp_key: string },
  ): void {
    const fileLink: FileLink = {
      client_ref: payload.client_ref,
      sha256: payload.sha256,
      tmp_key: payload.tmp_key,
      file_size: entry.size,
      original_filename: entry.filename,
      uploaded_at: new Date().toISOString(),
    };
    for (const ref of entry.rowRefs) {
      if (ref.rowKind === 'standalone') {
        const row = standaloneParts.value.find((r) => r.uid === ref.rowUid);
        if (row) row.fileLink = fileLink;
        continue;
      }
      if (ref.rowKind === 'asmMaster') {
        const row = assemblies.value.find((r) => r.uid === ref.rowUid);
        if (row) row.fileLink = fileLink;
        continue;
      }
      if (ref.rowKind === 'asmChild') {
        const asm = assemblies.value.find((a) => a.uid === ref.asmUid);
        const child = asm?.children.find((c) => c.uid === ref.rowUid);
        if (child) child.fileLink = fileLink;
      }
    }
  }

  /** 本次提交对应的上传条目集合（仅 onSubmitPdfTree 期间有效，buildBinding 时用）。 */
  let lastUploadEntries: FileUploadEntry[] = [];

  // ============================================================
  // 2026-09-18 upload-session 接入：单例 session + draft 持久化
  // ============================================================
  //
  // parts/new 两个 Tab（PDF + Manual）共享同一 `parts_new` scope 的 session。
  // useUploadSession 用模块级 Map 实现 scope → state 单例，所以两次调用
  // getUploadSession('parts_new') 拿到的是同一 state。
  //
  // mount 时 init session 拿首次 STS 凭证 + 启动 renew 定时器（凭证过期前 5min
  // 自动续期）；draft 在 mount 时合并 session.files 与 localStorage 快照恢复
  // 工作现场，commit / discard 时清空。
  const session = getUploadSession('parts_new');
  const draft = usePartsNewDraft();

  // ============================================================
  // 2026-09-18 hydrate：mount 时从 draft + session.files 恢复 rows / fileLink
  // ============================================================
  //
  // hydrate 是 PDF Tab 恢复功能的入口（A1/A2 关键路径）：
  // 1) session.init → session.files 拿到后端实际状态；
  // 2) draft.load() → 拿到上次 mount 时写入 localStorage 的 rows / file_links；
  // 3) mergeDraftWithSession(draft, session) → 按 client_ref 合并 →
  //    - pdfRows / pdfAssemblies 的 drawing / threeD 状态 = 'done' | 'need_reselect'
  //    - orphanFileRefs（session.files 中存在但 snapshot 未引用的 client_ref）
  //
  // hydrate 写到本地 state 的部分：
  // - standaloneParts / assemblies → 还原字段（含 fileLink 写入触发 A3 UI 渲染）；
  // - orphanFileRefs → 暴露给 UI 渲染「孤儿文件待认领」面板；
  // - hydrateRestoredCount → 暴露给 UI 渲染顶部「已恢复 N 条已上传图纸」总览。
  //
  // 流程不变量：
  // - restore 失败（draft=null / version 不匹配 / user_id 不匹配）→ restored=false，
  //   不动 rows（保持空），orphanFileRefs = session.files（用户能看到的全部 session 文件）；
  // - restore 成功但 rows 中所有 file 状态都是 need_reselect → restored=true，
  //   hydrateRestoredCount = 0（用户看到「已恢复 0 条已上传图纸」+ 需重传的 row tag）。
  const hydrateResult = ref<MergeResult | null>(null);
  const hydrateRestoredCount = computed<number>(() => {
    const r = hydrateResult.value;
    if (!r) return 0;
    let count = 0;
    for (const row of r.pdfRows) {
      if (row.drawing === 'done') count += 1;
      if (row.threeD === 'done') count += 1;
    }
    for (const asm of r.pdfAssemblies) {
      // asm.children[0] = master，其余是 child
      if (asm.children[0]?.drawing === 'done') count += 1;
      for (let i = 1; i < asm.children.length; i += 1) {
        const c = asm.children[i];
        if (!c) continue;
        if (c.drawing === 'done') count += 1;
        if (c.threeD === 'done') count += 1;
      }
    }
    return count;
  });
  const orphanFileRefs = computed(() => hydrateResult.value?.orphanFileRefs ?? []);

  /**
   * mount 时调：init session + 从 session.files 同步已 done 文件到本地 cell +
   * 用 draft + session 合并结果 hydrate rows / fileLink。
   *
   * 2026-09-18：原实现只 init session + syncCellsFromSession（后者仅补 cells，
   * 不写 row.fileLink —— 见 A2 反馈）。本次扩展为完整 hydrate：
   * - session.init 后 session.files 才非空，mergeDraftWithSession 才有意义；
   * - hydrate 写到 standaloneParts / assemblies 后，row.fileLink 才有值，
   *   PartBatchPdfTab 模板才能渲染「已上传 / 需重传」tag（A3）。
   */
  onMounted(async () => {
    try {
      await session.init('parts_new');
      // 1) hydrate rows / assemblies / orphan from draft + session
      const loaded = draft.load();
      const merged = mergeDraftWithSession(loaded, session.session.value);
      hydrateResult.value = merged;
      applyHydrate(merged);
      // 2) sync session.files → local cells（仅补缺，不覆盖当前正在上传的 cell）
      syncCellsFromSession();
    } catch (e) {
      // init 失败不阻断 UI；用户后续点「开始上传」时再重试 init
      console.warn('[usePartBatchPdf] session.init failed', e);
    }
  });

  /**
   * 把 mergeDraftWithSession 的结果写到 standaloneParts / assemblies。
   * 仅 restored=true 时执行（draft 为空 / 版本不匹配 → 不动 rows）。
   *
   * 写入策略：
   * - SerializedPdfTab 不含 File / Blob，restore 后的 row 是「骨架」；
   * - drawing=undefined → row.fileLink = null（用户需重选文件）；
   * - drawing='done' → row.fileLink = { client_ref, sha256, tmp_key, ... }（UI 标已上传）；
   * - drawing='need_reselect' → row.fileLink = null（UI 渲染「需重传」tag）。
   */
  function applyHydrate(merged: MergeResult): void {
    if (!merged.restored) return;
    const payload = draft.load();
    if (!payload) return;
    // 1) pdfForm 顶层字段（L1 客户 + 请购日期）
    pdfForm.customerL1Id = payload.pdf_tab.customerL1Id;
    pdfForm.requestDate = payload.pdf_tab.requestDate || todayIso();
    // 2) standaloneParts
    standaloneParts.value = merged.pdfRows.map((m) =>
      deserializeStandaloneRow(m.row, m.drawing, m.threeD),
    );
    // 3) assemblies（master = a.children[0]，其余 child）
    assemblies.value = merged.pdfAssemblies.map((a) => {
      const masterMerged = a.children[0];
      const masterRow: AssemblyRow = deserializeAssemblyRow(a.row, masterMerged?.drawing);
      // 过滤掉 master 占位（children[0] 是 master），保留真正的 child 行
      const childMerged = a.children.slice(1).filter(
        (
          c,
        ): c is (typeof a.children)[number] & {
          row: SerializedAssemblyChildRow;
        } => 'page_index' in c.row,
      );
      masterRow.children = childMerged.map((c) =>
        deserializeAssemblyChildRow(c.row, c.drawing, c.threeD),
      );
      return masterRow;
    });
    // 4) selectedPages（按 page_uid 还原选择集；用户上次勾选过的页直接恢复）
    selectedPages.value = new Set(payload.pdf_tab.selectedPages);
  }

  /** 把 SerializedStandalonePartRow + drawing/threeD 状态 → StandalonePartRow（含 fileLink）。 */
  function deserializeStandaloneRow(
    row: SerializedStandalonePartRow,
    drawing: 'done' | 'need_reselect' | undefined,
    _threeD: 'done' | 'need_reselect' | undefined,
  ): StandalonePartRow {
    const fileLink = buildFileLinkFromSnapshot(row.drawing_client_ref, row.drawing_sha256, drawing);
    return {
      uid: row.uid,
      pdfSourceUid: row.pdfSourceUid,
      pageCount: row.pageCount,
      ...(row.mergedFrom ? { mergedFrom: row.mergedFrom } : {}),
      drawing_no: row.drawing_no,
      name: row.name,
      applicant_name: row.applicant_name,
      customer_id: row.customer_id,
      customer_name: row.customer_name,
      request_date: row.request_date,
      planned_delivery_date: row.planned_delivery_date,
      system_delivery_date: row.system_delivery_date,
      order_no: row.order_no,
      note: row.note,
      is_urgent: row.is_urgent,
      quantity: row.quantity,
      unit_price: row.unit_price,
      total_price: row.total_price,
      three_d_index: row.three_d_index,
      // 2026-09-18：A2 修复 — 仅在 drawing='done' 且 snapshot 带 client_ref/sha 时写 fileLink。
      // 'need_reselect' 让 fileLink=null（UI 渲染「需重传」tag）；
      // undefined（snapshot 没引用）→ fileLink=null（保持未上传态）。
      // 3D 模型不写入 row.fileLink（独立零件行仅在上传阶段通过 three_d_index
      // 关联 3D 模型 entry，提交时按 entry 反查；本字段仅承载图纸 binding）。
      fileLink,
      // 2026-09-18 A3：fileLink=null 但 snapshot 曾带 drawing_client_ref →
      // 标「需重传」；用于 UI 区分"从未上传"vs"上传过但 session 失效"。
      fileLinkNeedReselect: !fileLink && !!row.drawing_client_ref,
    };
  }

  /** 把 SerializedAssemblyRow → AssemblyRow（含顶层 fileLink + 空 children，
   *  children 由 caller 在 applyHydrate 内填充 deserializeAssemblyChildRow 结果）。 */
  function deserializeAssemblyRow(
    row: SerializedAssemblyRow,
    drawing: 'done' | 'need_reselect' | undefined,
  ): AssemblyRow {
    const fileLink = buildFileLinkFromSnapshot(row.drawing_client_ref, row.drawing_sha256, drawing);
    return {
      uid: row.uid,
      pdfSourceUid: row.pdfSourceUid,
      drawing_no: row.drawing_no,
      name: row.name,
      applicant_name: row.applicant_name,
      customer_id: row.customer_id,
      customer_name: row.customer_name,
      request_date: row.request_date,
      planned_delivery_date: row.planned_delivery_date,
      system_delivery_date: row.system_delivery_date,
      order_no: row.order_no,
      note: row.note,
      is_urgent: row.is_urgent,
      masterPageIndex: row.masterPageIndex,
      quantity: row.quantity,
      children: [],
      fileLink,
      fileLinkNeedReselect: !fileLink && !!row.drawing_client_ref,
    };
  }

  /** 把 SerializedAssemblyChildRow → AssemblyChildRow（含 fileLink）。 */
  function deserializeAssemblyChildRow(
    row: SerializedAssemblyChildRow,
    drawing: 'done' | 'need_reselect' | undefined,
    _threeD: 'done' | 'need_reselect' | undefined,
  ): AssemblyChildRow {
    const fileLink = buildFileLinkFromSnapshot(row.drawing_client_ref, row.drawing_sha256, drawing);
    return {
      uid: row.uid,
      pdfSourceUid: row.pdfSourceUid,
      page_index: row.page_index,
      drawing_no: row.drawing_no,
      name: row.name,
      quantity: row.quantity,
      is_urgent: row.is_urgent,
      request_date: row.request_date,
      planned_delivery_date: row.planned_delivery_date,
      system_delivery_date: row.system_delivery_date,
      order_no: row.order_no,
      note: row.note,
      unit_price: row.unit_price,
      total_price: row.total_price,
      three_d_index: row.three_d_index,
      fileLink,
      fileLinkNeedReselect: !fileLink && !!row.drawing_client_ref,
    };
  }

  /**
   * 把 snapshot 的 (client_ref, sha) + 合并状态 → FileLink。
   * 仅在 status='done' 且 client_ref/sha 都在时返回；否则 null（让 row.fileLink=null，
   * UI 渲染「需重传」tag）。
   */
  function buildFileLinkFromSnapshot(
    clientRef: string | undefined,
    sha: string | undefined,
    status: 'done' | 'need_reselect' | undefined,
  ): FileLink | null {
    if (status !== 'done') return null;
    if (!clientRef || !sha) return null;
    // 从 session.files 找 tmp_key（commit 时 buildBindingFromEntry 也需要；
    // 这里只补上 tmp_key，其他字段 session.files 也有，但当前 UI 渲染只需
    // client_ref / sha 即可，「已上传」tag 不展示 tmp_key）
    const sessFile = session.files.value.find((f) => f.client_ref === clientRef);
    return {
      client_ref: clientRef,
      sha256: sha,
      tmp_key: sessFile?.tmp_key ?? '',
      file_size: sessFile?.file_size,
      original_filename: sessFile?.original_filename,
      uploaded_at: sessFile?.uploaded_at ?? null,
    };
  }

  /**
   * 把 session.files 中 status=done 的条目同步到本地 pdfUploadCells
   * （仅当 cell 还未存在时新增；正在上传中的 cell 不动）。
   *
   * 主要场景：两 Tab 共享 session，另一 Tab 完成上传后本 Tab 第一次 mount
   * 应立即看到 done 状态（避免本 Tab 「开始上传」时拿旧 cell 状态做判断）。
   *
   * 2026-09-18：B2/B3 整改后，UI 主要走 row.fileLink 路径（hydrate 已写入），
   * 本函数仅作为兜底——确保 session.files 中 done 的条目对应 pdfUploadCells /
   * threeDUploadCells 也是 done，避免 canSubmitCreate 计算属性误判。
   *
   * kind 比较用 toLowerCase() —— 后端契约上是小写（drawing / 3d_model），但
   * 旧 python StsPurpose 端口可能返回大写；做大小写兼容。
   */
  function syncCellsFromSession(): void {
    const files = session.files.value;
    for (const f of files) {
      if (f.status !== 'done') continue;
      const key = fileKeyFromSessionFile(f);
      if (!key) continue;
      const k = f.kind.toLowerCase();
      if (k === 'drawing') {
        if (!pdfUploadCells[key]) pdfUploadCells[key] = { status: 'done', progress: 100 };
      } else if (k === '3d_model') {
        if (!threeDUploadCells[key]) threeDUploadCells[key] = { status: 'done', progress: 100 };
      }
    }
  }

  /**
   * 把 SessionFile 翻译成 pdfUploadCells / threeDUploadCells 的 key
   * （`pdf:${srcUid}` / `3d:${client_ref}`）。
   *
   * 2026-09-18 重要：之前 key 拼 client_ref 但 UI cell key 用 srcUid，两套命名
   * 空间错位（B2 反馈）。本次修复：drawing → `pdf:${srcUid}`（UI 沿用），
   * 3d_model → `3d:${client_ref}`（3D 模型 cell 没按 srcUid 维度建索引，沿用
   * 上传阶段生成的 client_ref）。
   */
  function fileKeyFromSessionFile(f: { client_ref: string; kind: string }): string | null {
    const k = f.kind.toLowerCase();
    if (k === 'drawing') {
      // drawing: 通过 file_links[].kind === 'drawing' 反查 srcUid；
      // 但本函数只拿到 client_ref，没法直接知道 srcUid。退而求其次：用
      // `pdf:${client_ref}` 作为 key（与 cosUpload item 命名空间一致）。
      return `pdf:${f.client_ref}`;
    }
    if (k === '3d_model') return `3d:${f.client_ref}`;
    return null;
  }

  // ============================================================
  // 2026-09-18 draft 持久化：监听 rows / assemblies 变更 → debounce 500ms 写 localStorage
  // ============================================================
  //
  // 写时机：
  // - rows / assemblies 任意字段变化 → schedule saver（debounce 500ms 合并）；
  // - onStartUpload 启动前（mount 时基线快照 + 每次「开始上传」前）→ saver.flush()；
  // - onCommit 成功后 → clearDraft + 清 sessions（保留 session 单例由 caller 决定）。
  //
  // 2026-09-18 B1 修复：cross-tab clobber。原来 PDF Tab saver 写整个 payload 时
  // 把 manual_tab 覆盖为 `{ staged: [] }`（PDF Tab 不写 manual 段），Manual Tab
  // saver 同样覆盖 pdf_tab 为空。两 Tab 共享同 key 时 debounce 竞争，后者覆盖
  // 前者。本次改为：schedule 前先读旧 payload（draft.load()），仅覆盖本 Tab 段，
  // 另一 Tab 段保留。代价：每次 schedule 多一次 localStorage 读（仍在 500ms
  // debounce 窗口内合并，开销可接受）。
  if (draft.userId) {
    watch(
      () => [pdfForm.customerL1Id, pdfForm.requestDate, JSON.stringify(serializePdfTab())] as const,
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
      file_links: serializeFileLinks(),
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
   * 收集所有 row.fileLink → file_links 数组。
   * bound_row_ids 用 row uid 数组（一个 file 可能被多个 row 引用：装配主子件）。
   */
  function serializeFileLinks(): SerializedPdfTab['file_links'] {
    const links: SerializedPdfTab['file_links'] = [];
    const seen = new Map<
      string,
      { kind: 'drawing' | '3d_model'; sha256: string; rowIds: Set<string> }
    >();
    const addLink = (
      clientRef: string | undefined,
      sha: string | undefined,
      rowUid: string,
      kind: 'drawing' | '3d_model',
    ): void => {
      if (!clientRef || !sha) return;
      const cur = seen.get(clientRef);
      if (cur) {
        cur.rowIds.add(rowUid);
        return;
      }
      seen.set(clientRef, { kind, sha256: sha, rowIds: new Set([rowUid]) });
    };
    standaloneParts.value.forEach((r) => {
      addLink(r.fileLink?.client_ref, r.fileLink?.sha256, r.uid, 'drawing');
    });
    assemblies.value.forEach((a) => {
      addLink(a.fileLink?.client_ref, a.fileLink?.sha256, a.uid, 'drawing');
      a.children.forEach((c) => {
        addLink(c.fileLink?.client_ref, c.fileLink?.sha256, c.uid, 'drawing');
      });
    });
    seen.forEach((v, k) => {
      links.push({
        client_ref: k,
        sha256: v.sha256,
        bound_row_ids: Array.from(v.rowIds),
        kind: v.kind,
      });
    });
    return links;
  }

  // ============================================================
  // 2026-09-16 M3-B 复审兜底：cosUpload 提升到 composable 顶层
  // ============================================================
  //
  // 旧实现的 cosUpload / cosItemsRef 是在 onSubmitPdfTree 内 `let` 声明的局部变量，
  // retryUploadByRow 拿不到 → 实际是空操作 stub（仅弹「请重新提交」提示）。
  // 复审要求：cosUpload 提到顶层 Ref<UseCosUploadReturn | null>，让 row 内「重试」
  // 按钮能直接调 retryItem()，不必再走「重提交 → 重新走整条七步流程」。
  //
  // 提交拆两步：
  // - 「开始上传」：hash + createUploadIntents + useCosUpload.startUpload()，uploadStage='uploaded'
  // - 「提交创建」：仅 batchCreateParts + 清空，uploadStage='committed'
  // 「重试」按钮（行内）调 cosUpload.value?.retryItem(clientRef)，全程在 uploaded 阶段可达。
  //
  // null = 本次会话还没点过「开始上传」；上传 / 提交各自结束后清回 null（与 cell 一起重置）。
  // cosItemsRef 是顶层 Ref<CosUploadItem[]>，useCosUpload 在闭包里持有它，
  // retryItem 时能读到同一对象（mutable status / progress / etag 都是原地写）。
  // 「未开始上传」状态下用空数组占位（避免 useCosUpload 内部 items.value[i] 炸 RangeError）。
  const cosUpload = shallowRef<UseCosUploadReturn | null>(null);
  const cosItemsRef = ref<CosUploadItem[]>([]);

  /** 上传阶段机。状态机转换：
   *  - idle → uploading → uploaded → committed
   *  - uploaded → uploading（用户点行内「重试」，单文件重跑）
   *  - committed → idle（提交完成、清空，下次重新解析后可再提交） */
  const uploadStage = ref<'idle' | 'uploading' | 'uploaded' | 'committed'>('idle');

  /** 计算属性：是否可以点「开始上传」（PDF/3D 文件都至少有一份处于 pending/error）。 */
  const canStartUpload = computed<boolean>(
    () =>
      (standaloneParts.value.length > 0 || assemblies.value.length > 0) &&
      uploadStage.value === 'idle',
  );

  /** 计算属性：是否可以点「提交创建」（所有 cell.status === 'done'）。 */
  const canSubmitCreate = computed<boolean>(() => {
    if (uploadStage.value !== 'uploaded') return false;
    const pdfKeys = Object.keys(pdfUploadCells);
    const tKeys = Object.keys(threeDUploadCells);
    if (pdfKeys.length === 0 && tKeys.length === 0) return true; // 无文件 = 视为就绪
    return (
      pdfKeys.every((k) => pdfUploadCells[k]?.status === 'done') &&
      tKeys.every((k) => threeDUploadCells[k]?.status === 'done')
    );
  });

  /** UI 调用：单项重试。映射 rowUid → 找到对应 entry 的 clientRef 触发 retryItem。
   *
   * 2026-09-16 M3-B 复审修复：cosUpload 提升到 composable 顶层后，retryItem
   * 全程可触达（不再依赖 caller 注入）；单元接收 (rowUid, slot, threeDIndex?) 即可。
   * 行内「重试」按钮在「开始上传」之后、commit 之前任意时刻可点。
   */
  async function retryUploadByRow(
    rowUid: string,
    slot: 'pdf' | '3d',
    threeDIndex?: number,
  ): Promise<void> {
    const upload = cosUpload.value;
    if (!upload) {
      ElMessage.warning('请先点「开始上传」再使用行内「重试」');
      return;
    }
    let entry: FileUploadEntry | undefined;
    if (slot === 'pdf') {
      entry = findPdfEntryForRow(rowUid);
    } else {
      entry = threeDIndex !== undefined ? findThreeDEntryForRow(rowUid, threeDIndex) : undefined;
    }
    if (!entry?.clientRef) {
      ElMessage.warning('找不到对应上传条目，请重新点「开始上传」');
      return;
    }
    // 标记 uploading 阶段让 UI 知道「正在重试」（但保持 uploaded 阶段，commit 仍可走）
    uploadStage.value = 'uploading';
    try {
      await upload.retryItem(entry.clientRef);
    } finally {
      // 重试完成：恢复 uploaded 阶段；如仍有 error 项，canSubmitCreate 会保持 false
      uploadStage.value = 'uploaded';
    }
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

  /** 点击「开始上传」按钮（2026-09-16 M3-B 复审拆第一步）。
   *
   * 七步流程中的步骤 1-5：
   * 1) 收集待上传文件（PDF + 3D），按 (kind, srcUid/fileUid) 去重；保留 rowRefs
   *    反查哪些 row 需要这个 FileBinding
   * 2) 受控并发 3 hash → UI cell.status='hashing' → 完成后 'pending'
   * 3) 调 createUploadIntents (owner_part_id 缺省 = 场景 A)；按 idx 把
   *    client_ref / tmp_key 回填到 entries
   * 4) 构造 CosUploadItem[] + useCosUpload，**提升到顶层 ref**（cosUpload.value），
   *    让 row 内「重试」按钮能直接调 retryItem(client_ref)
   * 5) startUpload() 完成后 uploadStage='uploaded'；如任何 cell.status !== 'done'
   *    保留在 'uploading' 阶段让行内 retry 按钮可达（不再强制 alert 阻断）
   */
  async function onStartUpload(): Promise<void> {
    if (standaloneParts.value.length === 0 && assemblies.value.length === 0) {
      ElMessage.warning('请先解析上传');
      return;
    }
    if (!validateL2Customers()) return;
    if (uploadStage.value !== 'idle') {
      ElMessage.warning('已上传或已提交；如需重传请重新解析');
      return;
    }

    // 2026-09-18：上传前 flush draft 快照（把当前解析结果固化进 localStorage，
    // 万一上传中途页面刷新，用户重进仍能从 draft + session.files 恢复）
    draft.saver.flush();

    pdfSubmitting.value = true;
    uploadStage.value = 'uploading';
    try {
      // 清空旧的 cell（重新解析拆分后可能引用变了）
      Object.keys(pdfUploadCells).forEach((k) => delete pdfUploadCells[k]);
      Object.keys(threeDUploadCells).forEach((k) => delete threeDUploadCells[k]);

      // 步骤 1：收集文件
      const entries = collectFilesToUpload();
      lastUploadEntries = entries;

      // 步骤 2：受控并发 3 hash
      if (entries.length > 0) {
        entries.forEach((e) => {
          const cell: UploadStatusCell = { status: 'hashing', progress: 0 };
          if (e.kind === 'DRAWING') pdfUploadCells[e.key] = cell;
          else threeDUploadCells[e.key] = cell;
        });
        await runWithConcurrency(entries, 3, async (entry) => {
          const sha = await computeSha256(entry.file);
          entry.sha = sha;
          const cell =
            entry.kind === 'DRAWING' ? pdfUploadCells[entry.key] : threeDUploadCells[entry.key];
          if (cell) {
            cell.status = 'pending';
            cell.progress = 0;
          }
        });
      }

      // 步骤 3+4+5：upload-session 共享 STS 单端口签 N 个 key
      //
      // 2026-09-18：替换原 backend-python grantStsTmpKey（每文件并发 1-key 响应）。
      // 新方案 backend-rust `/api/v2/upload-sessions/{id}/files:allocate` 一次签
      // N 个 tmp_key + 共享同一 STS 凭证；凭证过期由 useUploadSession 定时器在
      // expired_time - 5min 自动 renew，refetchIntents 回调只负责重建
      // UploadIntentsOut 形状（applyFreshIntents 内部按 client_ref 索引到 item）。
      if (entries.length > 0) {
        // 1) 给每条 entry 生成 client_ref（UUID，便于后端 batch dedup 与本地索引）
        entries.forEach((e) => {
          if (!e.clientRef) e.clientRef = crypto.randomUUID();
        });

        // 2) ensure upload session 已 init（mount 时已 init 过；用户在别处
        //    discard 过的极端情况走兜底 init）
        if (!session.isReady.value) {
          await session.init('parts_new');
        }

        // 3) 一次性 allocate：拿到 N 个 tmp_key（共享 session 顶层 credentials）
        const allocated = await session.allocate(
          entries.map((e) => ({
            client_ref: e.clientRef!,
            kind: e.kind,
            original_filename: e.filename,
            file_size: e.size,
            content_type: e.contentType,
            content_sha256: e.sha!,
          })),
        );

        // 4) 回填 tmp_key 到 entries（按 client_ref 索引）
        const tmpKeyByRef = new Map(allocated.map((a) => [a.client_ref, a.tmp_key]));
        entries.forEach((e) => {
          const k = tmpKeyByRef.get(e.clientRef!);
          if (k) e.tmpKey = k;
        });

        // 5) 校验 session 凭证 / bucket / region 就绪
        const credentials = session.credentials.value;
        const bucket = session.bucket.value;
        const region = session.region.value;
        const tmpPrefix = session.tmpPrefix.value ?? '';
        if (!credentials || !bucket || !region) {
          throw new Error('upload session 凭证或桶信息缺失');
        }

        // 6) 构造 cosItemsRef：所有 item 共享 session 顶层 credentials / bucket /
        //    region，tmp_key 各自从 allocate 响应取（per-item）
        cosItemsRef.value = entries.map((e) => ({
          client_ref: e.clientRef!,
          file: e.file,
          tmp_key: e.tmpKey!,
          bucket,
          region,
          tmp_prefix: tmpPrefix,
          credentials,
          status: 'pending',
          progress: 0,
        }));

        // 7) useCosUpload：refetchIntents 改为 session.renew + 从最新 session 重建
        //    UploadIntentsOut 形状。applyFreshIntents 内部按 client_ref 索引到 item。
        cosUpload.value = useCosUpload({
          items: cosItemsRef,
          refetchIntents: async (): Promise<UploadIntentsOut> => {
            await session.renew();
            const fresh = session.session.value;
            if (!fresh) throw new Error('upload session 已被 discard');
            return {
              credentials: fresh.credentials,
              bucket: fresh.bucket,
              region: fresh.region,
              tmp_prefix: fresh.tmp_prefix,
              items: entries.map((e) => ({
                client_ref: e.clientRef!,
                tmp_key: tmpKeyByRef.get(e.clientRef!) ?? e.tmpKey ?? '',
                dedup_hit: false,
              })),
            };
          },
        });

        // 同步 status / progress / error 到 UI cells（每次 cosItemsRef 变都跑一遍）；
        // 同时在 item status 变 'done' 时：
        // 1) 调 session.markComplete，让 session.files 同步推进 status → 'done'
        //    （供 mount 恢复 / batch commit 时 reuse）；
        // 2) 2026-09-18 A2 修复：通过 entry.rowRefs 反查 row.uid，把 client_ref +
        //    sha + tmp_key 写到对应 row.fileLink，让 PartBatchPdfTab 模板能立即
        //    渲染「已上传」tag（done 命中）；3D 模型不挂 row.fileLink（仅 PDF 走
        //    drawing_file 字段，3D 在 commit 时按 three_d_index 另查）。
        const completedClientRefs = new Set<string>();
        const stopSync = watch(
          cosItemsRef,
          (items) => {
            syncCellsFromCosItems(items, entries);
            for (const it of items) {
              if (it.status === 'done' && !completedClientRefs.has(it.client_ref)) {
                completedClientRefs.add(it.client_ref);
                const entry = entries.find((e) => e.clientRef === it.client_ref);
                if (entry && entry.kind === 'DRAWING') {
                  writeRowFileLink(entry, {
                    client_ref: it.client_ref,
                    sha256: entry.sha ?? '',
                    tmp_key: entry.tmpKey ?? '',
                  });
                }
                // markComplete 失败不阻断 UI（status=done 已写入，仅 session.files
                // 同步延后；下次 batch commit 时仍按 tmp_key 走）
                void session.markComplete(it.client_ref, it.etag).catch(() => {
                  /* swallow */
                });
              }
            }
          },
          { deep: true, immediate: true },
        );

        try {
          // 紧邻上面 cosUpload.value = useCosUpload(...) 已确保非 null；await 跨越
          // 边界 TS 不会保持 narrowing，加非空断言。
          await cosUpload.value!.startUpload();
        } finally {
          stopSync();
        }
      }

      // 阶段切到 uploaded；失败项由行内 retry 兜底，不阻断 stage
      uploadStage.value = 'uploaded';

      const failedCount =
        Object.values(pdfUploadCells).filter((c) => c.status === 'error').length +
        Object.values(threeDUploadCells).filter((c) => c.status === 'error').length;
      if (failedCount === 0) {
        ElMessage.success('所有文件已上传完成，请确认后提交创建');
      } else {
        ElMessage.warning(`${failedCount} 个文件上传失败，请点行内「重试」`);
      }
    } catch (e) {
      // 上传阶段异常 → 回滚到 idle 允许重试
      uploadStage.value = 'idle';
      ElMessage.error((e as Error).message ?? '上传失败');
    } finally {
      pdfSubmitting.value = false;
    }
  }

  /** 点击「提交创建」按钮（2026-09-16 M3-B 复审拆第二步）。
   *
   * 步骤 6+7：仅 batchCreateParts + 清空，不再触发上传。前提：uploadStage='uploaded'
   * 且所有 cell.status === 'done'（UI 通过 disabled 阻止；这里再校验一次）。
   */
  async function onCommit(): Promise<void> {
    if (uploadStage.value !== 'uploaded') {
      ElMessage.warning('请先点「开始上传」');
      return;
    }
    if (!canSubmitCreate.value) {
      ElMessage.warning('仍有文件上传失败，请先点行内「重试」');
      return;
    }
    if (!validateL2Customers()) return;

    pdfSubmitting.value = true;
    try {
      // 步骤 6：构造 PartBatchCreatePayload[]
      // - 装配主子件统一展平为独立 part（M3 v2 端点无 assembly_uid 支持）；
      //   子件图号 / 名称沿用原 drawing_no / name；quantity / 分厂 / 申请人继承自顶层。
      // - drawing_file：从 PDF entry 派生；model3d_file：从 3D entry 派生。
      const items: PartBatchCreatePayload[] = [];
      for (const r of standaloneParts.value) {
        const pdfEntry = findPdfEntryForRow(r.uid);
        const threeDEntry =
          r.three_d_index !== null ? findThreeDEntryForRow(r.uid, r.three_d_index) : undefined;
        const drawingFile = pdfEntry ? buildBindingFromEntry(pdfEntry) : undefined;
        const model3dFile = threeDEntry ? buildBindingFromEntry(threeDEntry) : undefined;
        items.push({
          name: r.name || r.drawing_no,
          drawing_no: r.drawing_no,
          applicant_name: r.applicant_name,
          applicant_id: null, // M3 v2 JSON 端点无 applicant_id 字段
          quantity: r.quantity,
          request_date: r.request_date,
          planned_delivery_date: r.planned_delivery_date || r.request_date,
          is_urgent: r.is_urgent,
          order_no: r.order_no,
          system_delivery_date: r.system_delivery_date,
          note: r.note,
          customer_id: r.customer_id,
          drawing_file: drawingFile,
          model3d_file: model3dFile,
        });
      }
      for (const a of assemblies.value) {
        // 顶层 master part（也是独立 part，不创建 assembly 父节点）
        const masterPdfEntry = findPdfEntryForRow(a.uid);
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
          drawing_file: masterPdfEntry ? buildBindingFromEntry(masterPdfEntry) : undefined,
          // master 顶层不强挂 3D（按 row.three_d_index 约定，3D 挂到具体子件）
          model3d_file: undefined,
        });
        // 子件：每个子件一个 part（共享顶层 PDF）
        for (const c of a.children) {
          const childPdfEntry = findPdfEntryForRow(c.uid);
          const threeDEntry =
            c.three_d_index !== null ? findThreeDEntryForRow(c.uid, c.three_d_index) : undefined;
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
            drawing_file: childPdfEntry ? buildBindingFromEntry(childPdfEntry) : undefined,
            model3d_file: threeDEntry ? buildBindingFromEntry(threeDEntry) : undefined,
          });
        }
      }

      // 步骤 7：JSON batchCreate（v2 后端按 customer_id 自动分组；无需前端分组）
      // 注：applicant dedupe 在 PDF Tab 不需要 —— JSON 端点不接受 applicant_id，
      // applicant_name 走字符串直存（同名校验在 createApplicant 单点路径上，本路径
      // 不触发）。同名重复只会让 t_part.applicant_name 出现重复字符串，不影响
      // applicant 表去重。详见 T3.4 调研报告 §7。
      const res = await batchCreateParts(items);
      if (res.failed.length > 0) {
        const sample = res.failed
          .slice(0, 5)
          .map((f) => `第 ${f.index + 1} 行：${f.message}`)
          .join('\n');
        const more = res.failed.length > 5 ? `\n...还有 ${res.failed.length - 5} 行失败` : '';
        ElMessageBox.alert(
          `服务端拒绝了 ${res.failed.length} 行：\n${sample}${more}`,
          '部分行未通过',
          { type: 'warning' },
        );
        return;
      }

      // 2026-09-18 接入 upload_session：通知后端「本批 tmp 文件已被消费」。
      // consume 仅延长 tmp 保留窗口（便于 batch_create_parts 事务内 head + copy
      // tmp → 正式 CAS key 完成）；tmp 物理删除由 batch_create_parts 端点 spawn
      // delete 兜底（详见 backend-rust `src/handlers/parts/batch.rs`），前端不感知。
      // submittedClientRefs 来自 lastUploadEntries（本次提交真实上传的文件），
      // 不包含 row.fileLink 引用但本批未上传的复用项（那些已经在之前的提交里
      // consume 过或由 markComplete 触发过 commit，无需再 notify）。
      const submittedClientRefs = lastUploadEntries
        .map((e) => e.clientRef)
        .filter((r): r is string => !!r);
      if (submittedClientRefs.length > 0) {
        await session.consumeFiles(submittedClientRefs).catch(() => {
          /* best-effort；失败不影响提交结果 */
        });
      }

      const standaloneCount = standaloneParts.value.length;
      const assemblyMasters = assemblies.value.length;
      const childCount = assemblies.value.reduce((s, a) => s + a.children.length, 0);
      ElMessage.success(
        `成功创建 ${res.created.length} 条零件（${standaloneCount} 独立 + ${assemblyMasters} 装配件顶层 + ${childCount} 子件）`,
      );
      // 2026-09-18：提交成功后清空 draft（保留 session 单例，下一批次继续复用）
      draft.saver.cancel();
      draft.clear();
      // 清空 + 跳回
      allPdfs.value = [];
      standaloneParts.value = [];
      assemblies.value = [];
      selectedPages.value.clear();
      pdfFiles.value = [];
      excelFiles.value = [];
      threeDModelFiles.value = [];
      Object.keys(pdfUploadCells).forEach((k) => delete pdfUploadCells[k]);
      Object.keys(threeDUploadCells).forEach((k) => delete threeDUploadCells[k]);
      lastUploadEntries = [];
      // 释放上传引用，避免下次会话持到 stale items（cosUpload.value = null 让 retryUploadByRow 兜底）
      cosUpload.value = null;
      cosItemsRef.value = [];
      uploadStage.value = 'committed';
      // 重置回 idle 供下次「开始上传」使用
      uploadStage.value = 'idle';
      successNextTab.value = 'manual';
      router.push('/parts?status=PENDING');
    } catch (e) {
      ElMessage.error((e as Error).message ?? '提交失败');
    } finally {
      pdfSubmitting.value = false;
    }
  }

  // 2026-08-27：vue-draggable-plus 的 useDraggable composable 在 unmount 时
  // 自动 destroy，无需手动调用。
  //
  // 2026-09-18：unmount 时刷新 draft 快照 + 撤销 pending saver（避免 debounce
  // 在组件已销毁后写入 stale state）。session 不在 unmount 销毁 —— 两 Tab
  // 共享同一单例，Manual Tab 仍在活跃时 session 续期定时器必须存活。
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
    previewAt,
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
    // submit
    // 2026-09-16 M3-B 复审：原 onSubmitPdfTree 拆成「先上传 → 后提交」两步。
    // onStartUpload：hash + createUploadIntents + useCosUpload + startUpload
    // onCommit：仅 batchCreateParts + 清空 + 跳页
    onStartUpload,
    onCommit,
    // 2026-08-27：el-table DOM ref 由本 composable 持有；PartBatchPdfTab 通过
    // provide/inject 取到这两个 ref，模板 :ref 把 el-table 实例回写到 composable。
    standaloneTableRef,
    assembliesTableRef,
    standaloneTbodyRef,
    assembliesTbodyRef,
    resolveTbody,
    originalPdfs,
    // 2026-09-16 T3.4：上传状态（UI 进度 / 重试用）
    pdfUploadCells,
    threeDUploadCells,
    getRowPdfCell,
    getRowThreeDCell,
    allUploadsDone,
    hasUploadErrors,
    cosUpload,
    cosItemsRef,
    validateL2Customers,
    // 2026-09-16 M3-B 复审：阶段机 + 按钮 disabled 判定
    uploadStage,
    canStartUpload,
    canSubmitCreate,
    retryUploadByRow,
    // 2026-09-18 A3：hydrate 结果给 UI 渲染顶部「已恢复 N 条」el-alert +
    // 孤儿文件待认领面板（合并由 usePartsNewDraft.mergeDraftWithSession 完成）
    hydrateRestoredCount,
    hydrateResult,
    orphanFileRefs,
  };
}
