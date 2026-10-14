// Tab 2「PDF 批量上传」的**共享状态层**（2026-10-20 从 usePartBatchPdf.ts 拆出）。
//
// 这一层只放「三段都要摸」的状态，外加两类与段无关的东西：
//  1. 行工厂（`makeStandaloneRow` / `makeAssemblyChild` / `makeAssemblyRow`）—— 纯
//     构造函数，只读 `pdfForm.requestDate`，解析段建行与行段建行共用；
//  2. 两个跨段闸门（`guardRowMutation` 提交在途闸、`resetCommitState` 换表清提交态）——
//     解析段的「重新解析 / 合并 / 手动新增」与提交段的「建单 / 上传」都要过它们。
//
// 为什么它们住在这一层而不是某一段：这两道闸门被解析段与提交段**双向**调用，放进任一
// 段都会立刻造出 `解析 → 提交` 与 `提交 → 解析` 两条依赖边。放在状态层后，四段的
// 依赖是单向的：`状态 → 回填 → 解析 → 行 → 提交`（见各段文件头的依赖段）。
//
// 客户候选（`l1Customers` / `leafCustomerOptions`）同理：两者是 `customers` 与 `pdfForm`
// 的纯派生，且回填段的「Excel 部门名 → 客户 id」与页面的两级下拉读的是同一份口径
// （`views/parts/new` 域内唯一），放状态层保证只有一份实现。

import { computed, reactive, ref, shallowRef, type ComputedRef, type Ref } from 'vue';
import { ElMessage } from 'element-plus';
import { leafCustomersUnder } from '@/api/customer.tree';
import type { Customer } from '@/api/customer';
import { makeUid, todayIso } from './usePartBatchShared';
import type {
  AssemblyChildRow,
  AssemblyRow,
  CreatedTarget,
  PdfFormState,
  PdfSource,
  StandalonePartRow,
  UploadJob,
  UploadJobState,
  UploadStatusCell,
  UsePartBatchPdfOptions,
} from './usePartBatchPdfTypes';
import type { BidRow } from '@/utils/bidExcelParser';
import type { UploadFile } from 'element-plus';

/**
 * 三段共享的响应式状态与纯派生。对外只经 `usePartBatchPdf` 的返回面暴露，
 * 不直接 import 使用（`rowEpoch` 等提交段私有的运行时量除外，见 `PdfBatchState`）。
 */
export interface PdfBatchState {
  // ---- shell 传入的环境 ----
  customers: Ref<Customer[]>;
  /** 提交成功后切到哪个 tab（由 shell 提供）。 */
  successNextTab: Ref<string>;

  // ---- 表单 ----
  pdfForm: PdfFormState;

  // ---- 文件列表（el-upload 控件绑定）----
  pdfFiles: Ref<UploadFile[]>;
  excelFiles: Ref<UploadFile[]>;
  threeDModelFiles: Ref<UploadFile[]>;

  // ---- 源与行 ----
  allPdfs: Ref<PdfSource[]>;
  /** 源文件区选中的页：key = `${pdfUid}:${pageIndex}`（pageIndex 0-based）。 */
  selectedPages: Ref<Set<string>>;
  standaloneParts: Ref<StandalonePartRow[]>;
  assemblies: Ref<AssemblyRow[]>;
  /**
   * 2026-10-03：Excel 解析结果上提为 composable 状态。
   * 此前它是 `rebuildFromUploads` 内的局部变量，解析完即丢 → 只有「首次解析」这一次调用点
   * 能回填；之后用户合并页（mergeSelectedAsPart / mergeSelectedAsAssembly）、手动新增
   * （confirmManualPart / confirmManualAssembly）新建的行全都拿不到 Excel 数据。
   * 它的生命周期必须跟着「已上传的 Excel 文件」走：Excel 被移除 / 提交后清空时置 null，
   * 避免用陈旧数据回填新行。
   */
  excelByDrawingNo: Ref<Map<string, BidRow> | null>;

  // ---- 阶段与闸门 ----
  /** 提交在途（建单 / 补传都算），`guardRowMutation` 的判据。 */
  pdfSubmitting: Ref<boolean>;
  /** 提交流程阶段机。转移：
   *  - idle → creating → uploading → done
   *  - creating 失败 → 回 idle。前提是 `createdTargets` 为空（一行都没建出来，
   *    本地表格原样保留，重来不会碰到已落库的工单）。`createdTargets` 非空说明已经
   *    有行建出来了，此时回 idle 会诱导重复建单，必须走下面的部分成功分支。
   *  - 建单「部分行成立」→ 同样回 idle，但前提是**建成的行已被移出本地表格**（见
   *    `dropCreatedRows`），下一次提交只会发出剩下的失败行
   *  - uploading 阶段失败 → 转 done 走失败清单（工单已落库，回 idle 会让用户再点
   *    一次主按钮、把同一批工单建第二遍）
   *  - done（全成功）→ 清空跳页；done（有失败 job）→ 只走重试上传，不再建单；
   *    done（job 列表没登记上）→ 现场重建 job 再补传，仍不建单 */
  commitStage: Ref<'idle' | 'creating' | 'uploading' | 'done'>;
  /**
   * 本地 rowUid → 已建出的目标实体。**跨 done 保留**（重试路径绝不清空）：工单已落库
   * 不可回滚，这是同一次页面停留内「重试只重传文件、绝不重复建单」的唯一保证。
   * 跨刷新的取舍见 usePartBatchPdf.ts 文件头。
   *
   * 装配件是**整组记账**：一次 `POST /assemblies` 建出顶层 + 全部子件，三条记录同进同出。
   * 组内若出现「顶层建出但子件数对不上」这种响应异常，整组都不记账（见
   * `createAssemblyGroups`），保证 map 里的每条记录都对应服务端真实存在的一行。
   *
   * reactive（Vue 的集合代理）⇒ `size` 可以直接进 computed 判「工单已建但 job 未登记」。
   */
  createdTargets: Map<string, CreatedTarget>;
  /**
   * 本次提交 `buildCommitItems()` 的 `items[i]` 对应的本地行 uid（**只覆盖独立零件**，
   * 与 `res.created[].sourceIndex` 同坐标系）。装配件不走这条坐标：它的 id 来自
   * `createAssembly` 响应，建单成功时直接按 rowUid 记进 `createdTargets`。
   */
  itemRowUids: Ref<string[]>;
  /** 反查用：jobKey（`pdf:${srcUid}` / `3d:${fileUid}`）→ status cell。 */
  pdfUploadCells: Record<string, UploadStatusCell>;
  threeDUploadCells: Record<string, UploadStatusCell>;
  /** 本次提交的全部上传作业（shallowRef：整体替换，不深代理 File）。 */
  uploadJobs: Ref<UploadJob[]>;
  /** jobKey → 该 cell 名下的全部 job（cell 状态按它聚合推导）。 */
  jobsByCellKey: Map<string, UploadJob[]>;
  /** jobId → 状态。 */
  jobStates: Map<string, UploadJobState>;
  /**
   * 失败 job：jobId → { job, error }。失败清单与重试集合的唯一来源。
   * reactive（Vue 的集合代理）⇒ 按 job 粒度的计数可以直接进 computed。
   */
  failedJobs: Map<string, { job: UploadJob; error: string }>;
  /**
   * 2026-10-04：在途 job 集合。同一个 job 只允许一个请求在飞 —— 行内重试与批量重试
   * 的交集、以及用户连点两下，都靠它挡住（重复发同一个 part + kind 只会稳定撞后端
   * 唯一索引 21108，详见 `isPartFileDuplicateError`）。
   */
  runningJobIds: Set<string>;

  // ---- 纯派生 ----
  /** Tab 2 PDF 批量上传专用：仅展示一级客户（树的根）。 */
  l1Customers: ComputedRef<Array<{ id: string; name: string }>>;
  /**
   * 2026-10-17（客户无限层级改造）：行内客户列选的候选 = **所选根子树内的叶子节点**。
   *
   * 为什么不是「该根的直接子」：客户改成任意深度后，「分厂」这一层可能根本没有子节点，
   * 直接子就是叶子；也可能「分厂 → 车间 → 班组」三层，直接子（分厂）是中间层，**业务
   * 单据不能挂中间层**（零件 / 装配件只能挂叶子）⇒ 只列直接子会让下拉里能选的值全部
   * 被后端拒（20104），而真正的末级部门一个都选不到。
   *
   * 叶子口径走 `api/customer.tree.ts::leafCustomersUnder`：**「所选根的子树内的叶子」
   * 这个需求有第二个消费方**（送货单扫码台的分组编辑器成员候选，零件只会挂在 L3/L4
   * 叶子而分组原先只能选 L2；且送货分组只服务打印分页 —— 按成员 `customer_id` 建映射、
   * 打印行项用自己的叶子 `customer_id` 去查，中间层成员匹配不到任何行项），两处各写一遍
   * 「parent_id → children 索引 + 显式栈」的话，重复 id 去重 / `parent_id` 成环这两条脏
   * 数据口径迟早分叉。`path` 是 `customer_path`（第 2 层到叶子的 ` / ` 拼接、不含 L1 ——
   * L1 已由页面顶部的下拉承载），空串兜底退回单段名。
   */
  leafCustomerOptions: ComputedRef<Array<{ id: string; name: string; path: string }>>;

  // ---- 行工厂 ----
  makeStandaloneRow: (opts: {
    pdfSourceUid: string;
    drawing_no: string;
    name: string;
    pageCount?: number;
    mergedFrom?: { pdfUid: string; pageIndex: number }[];
  }) => StandalonePartRow;
  makeAssemblyChild: (opts: {
    pdfSourceUid: string;
    pageIndex: number;
    drawing_no: string;
    name: string;
  }) => AssemblyChildRow;
  makeAssemblyRow: (opts: {
    pdfSourceUid: string;
    drawing_no: string;
    name: string;
    masterPageIndex: number | null;
    masterPdfSourceUid: string | null;
    children: AssemblyChildRow[];
  }) => AssemblyRow;

  // ---- 跨段闸门 ----
  guardRowMutation: () => boolean;
  resetCommitState: () => void;
}

/**
 * 创建共享状态。整个 composable 只调一次；四段工厂拿到的都是同一个对象 ⇒ ref 身份、
 * 闭包捕获与拆分前逐字一致。
 */
export function createPdfBatchState(opts: UsePartBatchPdfOptions): PdfBatchState {
  const { customers, successNextTab } = opts;

  const pdfForm = reactive<PdfFormState>({
    customerL1Id: null,
    requestDate: todayIso(),
  });

  // PDF / Excel / 3D 模型文件列表（el-upload 控件绑定）
  const pdfFiles = ref<UploadFile[]>([]);
  const excelFiles = ref<UploadFile[]>([]);
  // PR-H 2026-07-28：3D 模型批量上传（.step / .stp / .iges / .igs / .stl / .obj / .3mf）
  const threeDModelFiles = ref<UploadFile[]>([]);

  const allPdfs = ref<PdfSource[]>([]);
  /** 源文件区选中的页：key = `${pdfUid}:${pageIndex}`（pageIndex 0-based）。 */
  const selectedPages = ref<Set<string>>(new Set());
  const standaloneParts = ref<StandalonePartRow[]>([]);
  const assemblies = ref<AssemblyRow[]>([]);
  const excelByDrawingNo = shallowRef<Map<string, BidRow> | null>(null);

  /** 提交在途（建单 / 补传都算），`guardRowMutation` 的判据。 */
  const pdfSubmitting = ref(false);
  const commitStage = ref<'idle' | 'creating' | 'uploading' | 'done'>('idle');
  const createdTargets = reactive(new Map<string, CreatedTarget>());
  const itemRowUids = ref<string[]>([]);
  const pdfUploadCells = reactive<Record<string, UploadStatusCell>>({});
  const threeDUploadCells = reactive<Record<string, UploadStatusCell>>({});
  const uploadJobs = shallowRef<UploadJob[]>([]);
  let jobsByCellKey = new Map<string, UploadJob[]>();
  const jobStates = new Map<string, UploadJobState>();
  const failedJobs = reactive(new Map<string, { job: UploadJob; error: string }>());
  const runningJobIds = new Set<string>();

  /** Tab 2 PDF 批量上传专用：仅展示一级客户（树的根）。 */
  const l1Customers = computed(() =>
    customers.value.filter((c) => c.parent_id === null).map((c) => ({ id: c.id, name: c.name })),
  );

  /** 行内「客户」列的候选（详见 `leafCustomerOptions` 字段注释）。 */
  const leafCustomerOptions = computed(() =>
    leafCustomersUnder(customers.value, pdfForm.customerL1Id).map((c) => ({
      id: c.id,
      name: c.name,
      path: c.customer_path || c.name,
    })),
  );

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

  /** 装配件子件默认填充（客户 / 申请人由顶层 AssemblyRow 指定）。 */
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
   *  客户 / 申请人 / 单价 / 总价初始全空，由 `applyExcelToAll` 回填或用户手填。
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

  return {
    customers,
    successNextTab,
    pdfForm,
    pdfFiles,
    excelFiles,
    threeDModelFiles,
    allPdfs,
    selectedPages,
    standaloneParts,
    assemblies,
    excelByDrawingNo,
    pdfSubmitting,
    commitStage,
    createdTargets,
    itemRowUids,
    pdfUploadCells,
    threeDUploadCells,
    uploadJobs,
    get jobsByCellKey() {
      return jobsByCellKey;
    },
    set jobsByCellKey(next: Map<string, UploadJob[]>) {
      jobsByCellKey = next;
    },
    jobStates,
    failedJobs,
    runningJobIds,
    l1Customers,
    leafCustomerOptions,
    makeStandaloneRow,
    makeAssemblyChild,
    makeAssemblyRow,
    guardRowMutation,
    resetCommitState,
  };
}
