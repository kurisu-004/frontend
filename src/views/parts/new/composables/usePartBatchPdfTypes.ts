// Tab 2「PDF 批量上传」的**类型层**（2026-10-20 从 usePartBatchPdf.ts 拆出）。
//
// 为什么不并进任一行为模块：行 VO / 源 PDF 描述 / 上传 cell 形态同时被「解析 / 回填 /
// 提交」三段消费，放在其中任一段都会逼另外两段从「行为模块」里 import 类型 —— 依赖方向
// 立刻变成双向。本模块零行为、零响应式状态，只声明形状。
//
// 对外形状：`usePartBatchPdf.ts` 原样 re-export 全部类型（`PartBatchPdfTab.vue` 与两份
// spec 的 import 路径不变，见该文件的 re-export 段）。

import type { ComputedRef, Ref } from 'vue';
import type { UploadFile } from 'element-plus';
import type { Customer } from '@/api/customer';
import type { PartFileKind } from '@/types/part_file';

/** Tab 2 表单（本 Tab 只有一个一级客户下拉 + 申请日期）。 */
export interface PdfFormState {
  /** 一级客户 id（Tab 2 必选；决定 serial_prefix 来源 + 行内客户候选范围 = 该根子树内的叶子）。 */
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
  customer_id: string; // 客户 id（必须是**叶子**：业务单据只能挂叶子，后端 customer_id 校验如此）
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

/** 装配件子件。客户 / 申请人由顶层 AssemblyRow 指定，提交时复制到每条 item。 */
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
  customer_id: string; // 客户 id（必须是叶子，见 StandalonePartRow 同字段注释）
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
 *  URL.createObjectURL 生成；关闭弹窗或组件卸载时 revoke，避免内存泄漏。 */
export interface PdfPreviewState {
  url: string;
  title: string;
  page: number;
}

/**
 * 2026-09-21 显式返回类型需要：模块级 export UploadStatusCell 接口，
 * UsePartBatchPdfReturn 在文件较前位置引用它。
 *
 * 状态机只四态：后置上传链路不算本地摘要（hash 阶段的进度不进 UI，那段只有一两秒）。
 *
 * 2026-10-15：`progress` 从「上传期间恒为 0」变成**真进度** —— 传输改成预签 URL 直传，
 * XHR 的 `upload.onprogress` 有回调，`usePartBatchPdfUploads` 的 `markJobProgress`
 * 把它回写到本 cell。
 */
export interface UploadStatusCell {
  /** 当前阶段：pending（已排队未跑）/ uploading / done / error。 */
  status: 'pending' | 'uploading' | 'done' | 'error';
  /** 0-100；上传期间是真实字节进度（直传的 XHR onprogress），完成时 100。 */
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
  /**
   * 2026-10-17：行内「客户」列选的候选 = **所选根整棵子树里的叶子节点**（任意深度），
   * 不再是「该根的直接子」。`path` 走 `customer_path`（第 2 层到叶子的 ` / ` 拼接、
   * 不含 L1 —— L1 已由页面顶部的下拉承载）。
   */
  leafCustomerOptions: ComputedRef<Array<{ id: string; name: string; path: string }>>;
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
  onCustomerLeafChange: (row: { customer_id: string; customer_name?: string }, v: string) => void;
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

// ============================================================
// 以下是「回填 / 状态 / 提交」三段内部使用的类型，不进对外返回面
// （`usePartBatchPdf.ts` 的 re-export 段只导出第一块那些）。
// ============================================================

/** 回填作用域。契约（2026-10-03）：**传了就必须显式给全两侧**，某一侧没给就
 *  按「空集合」处理、绝不退回全量；只有**完全不传**才是「全表」语义。 */
export interface ExcelFillTarget {
  parts?: StandalonePartRow[];
  assemblies?: AssemblyRow[];
}

/** 文件上传条目（统一容器）。
 * - key：UI cell / 后置上传 job 的键（`pdf:${srcUid}` / `3d:${fileUid}`）。
 * - rowRefs：哪些 row 引用了该文件。**owner 与 kind 两个维度的分流口径只写在提交段
 *   `buildUploadJobs` 的注释里**（owner 按 ref 的 rowKind 定、落库 kind 由
 *   `runUploadJobs` 在发请求前改写），本类型不复述，避免两处各改一处产生矛盾注释。
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
export interface FileUploadEntry {
  key: string;
  kind: PartFileKind;
  filename: string;
  file: File;
  size: number;
  contentType: string;
  rowRefs: RowRef[];
}

/** row 反向引用：哪个 row 用了哪个文件（决定该 part 要传哪些原件）。 */
export type RowRef =
  | { rowKind: 'standalone'; rowUid: string }
  | { rowKind: 'asmMaster'; rowUid: string }
  | { rowKind: 'asmChild'; rowUid: string; asmUid: string };

/**
 * 后置上传的**目标实体**：决定 `uploadFileObject` 的 `owner_kind` 与落库 kind ——
 * 装配件顶层（`t_assembly` 行）传 `ASSEMBLY` + `ASSEMBLY_MASTER`，独立零件与装配件
 * 子件（都是 `t_part` 行）传 `PART` + 原件自身的 kind。
 */
export type UploadTarget = 'part' | 'assembly';

/** 一次后置上传作业 = 一个目标实体 × 一份原件。 */
export interface UploadJob {
  /**
   * job 的稳定身份 = `${jobKey}:${target}:${ownerId}`（jobKey 已含 `pdf:` / `3d:` 前缀，
   * 故天然区分 kind；再带 target 是因为 t_part.id 与 t_assembly.id 是两套雪花，job id
   * 必须全局唯一）。job 状态、失败清单、重试集合全按它寻址 —— 粒度必须是 job
   * 而不是 cell：一份原件被多个 row 共享时（合成的多页独立零件等）会展开成多个 job，
   * 只失败其中一个时按 cell 重试会把已成功的也重跑一遍，而后端
   * `uk_t_part_file_single (part_id, kind)`（覆盖 DRAWING / 3D_MODEL /
   * ASSEMBLY_MASTER / CAD_2D）会对同 owner 同 kind 的二次上传报 21108「相同文件
   * 已存在」。装配件文件的 `t_part_file.part_id` 存的就是 assembly.id、总装图按
   * `ASSEMBLY_MASTER` 落库（转换点见 `runUploadJobs`），所以装配件顶层同样受这条约束。
   */
  id: string;
  /** = entry.key（`pdf:<uid>` / `3d:<uid>`），同时是 UI cell 的键。 */
  jobKey: string;
  /** 目标实体种类：`assembly` = `t_assembly` 行，`part` = `t_part` 行。 */
  target: UploadTarget;
  /** 目标实体的雪花 ID 字符串（后端 JSON 里是 string）：part.id 或 assembly.id。 */
  ownerId: string;
  /**
   * **原件类型**（`entry.kind` 的原样拷贝）：`'DRAWING'` / `'3D_MODEL'`。
   * `registerUploadJobs` / `syncCells` 靠它把 job 分派到 PDF / 3D 两张 cell 表，
   * ⚠️ **不要**在这里改成落库用的 kind（装配件顶层落库是 `ASSEMBLY_MASTER`，改成它
   * 会把总装图的 cell 分派进 3D 表）。owner / kind 的落库映射在 `runUploadJobs`。
   */
  kind: PartFileKind;
  entry: FileUploadEntry;
}

/** job 运行时状态。`error` 的错误文案存在 failedJobs 里，不在状态里。 */
export type UploadJobState = 'pending' | 'uploading' | 'done' | 'error';

/**
 * 一行已建出的工单 = 目标实体（`t_part` 行 / `t_assembly` 行）+ 它的雪花 ID。
 *
 * 2026-10-05：`t_part` 与 `t_assembly` 两张表的 id 都在同一张 map 里，所以必须带
 * `target` 区分 —— 只存一个裸 id 的话，后置上传分不清该传 `owner_kind='PART'`
 * 还是 `owner_kind='ASSEMBLY'`（`t_part.id` 与 `t_assembly.id` 是两套雪花）。
 */
export interface CreatedTarget {
  target: UploadTarget;
  /** 目标实体的雪花 ID 字符串。 */
  id: string;
}

/** 一次装配件建单的结果分两类，逐组独立记账（互不影响）。 */
export interface AssemblyGroupFailure {
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
 * `buildUploadJobs` 真正用到的部分：目标实体 + 它的本地行 uid。
 * 收窄成这个形状是为了让「job 登记失败后用 `createdTargets` 现场重建」不必伪造
 * 后端返回的整个 item（重建路径拿不到那些字段，而这里一个都不读）。
 */
export interface CreatedTargetRef {
  target: UploadTarget;
  /** 目标实体 id（part.id 或 assembly.id）。 */
  id: string;
  /**
   * 本地行 uid。**直查，不走 `itemRowUids[sourceIndex]`**：装配件子件的 id 来自
   * `createAssembly` 的响应，本来就没有 `sourceIndex` 坐标。
   */
  rowUid: string;
}
