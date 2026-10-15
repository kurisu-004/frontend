// Tab 1「录入」composable。
//
// 2026-08-25 拆分：原 PartBatchNew.vue 第 1069-1603 行的「手工录入 + 待新增列表 + Dialog + 提交」
// 整段抽到本文件 + PartBatchManualTab.vue。Shell 通过 `v-bind="manual"` 把本 composable 返回
// 的对象铺给 tab 组件。
//
// 2026-10-15 翻转时序（本次改造的语义核心）：
// 改前「选 PDF → 立刻直传 → 提交时把 tmp_key 塞进 batchCreateParts」；
// 改后「选 PDF → **只暂存本地 File，不发任何请求** → 点提交 → batchCreateParts 建单
//      → 拿到 created[].id 之后，对每条有图纸的 staged entry 走直传上传」。
// 于是那五个上传回调连同 `drawingBinding` / `drawingClientRef` 两个字段全部删除，
// PartEntryFormDialog 的图纸区改成 `<el-upload :auto-upload="false">`（只暂存）。
//
// 失败语义随之分家（本文件最需要被记住的一条）：
//   - 建单失败 ⇒ 「这一行没建出来」，可以原样重提（回 idle）；
//   - 建单成功但图纸上传失败 ⇒ **零件已经落库**，重提就是重复建单。所以上传阶段的失败
//     走独立的失败清单 + 独立重试，且提示语必须讲清「零件已创建、只是图纸没传上去」。
//
// 2026-09-24 接入 auth 范本：Zod schema 校验 + useMutation 提交。
// - 删 EP FormRules 与 formRef 管道；走 partEntrySchema.safeParse(form) +
//   formErrors 单字段错误展示（与 LoginView 一致）。
// - 客户存在性等依赖动态 customers 列表的校验不进 schema，留在 onAddConfirm
//   业务层写 formErrors（与 auth「业务判断独立于 schema」一致）。
// - onSubmit → useMutation<PartBatchResult, Error>：mutationFn 仅调内部
//   submitStagedEntries()（薄封装：dedupe + batchCreateParts），部分失败 /
//   成功跳转 / ElMessage 走 onSuccess / onError；mutation 失败用 onError
//   ElMessage.error 反馈（保留原 UX），不写 retry（信任全局默认）。
// - submitting 类型从 Ref<boolean> → ComputedRef<boolean>（mutation.isPending）。

import { computed, onBeforeUnmount, reactive, ref, watch, type ComputedRef, type Ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useMutation } from '@tanstack/vue-query';
import { getOrCreateApplicant } from '@/api/applicant';
import { batchCreateParts, type PartBatchCreatePayload, type PartBatchResult } from '@/api/parts';
import {
  usePartsNewDraft,
  type MergeResult,
  type SerializedStagedEntry,
} from '@/views/parts/new/composables/usePartsNewDraft';
import type { Applicant } from '@/types/applicant';
import type { Customer } from '@/api/customer';
import { buildCustomerTree, leafCustomersOf, type CustomerTreeNode } from '@/api/customer.tree';
import { usePostSubmitUploads, type PostSubmitUploadJob } from '@/composables/usePostSubmitUploads';
import { useConfirm } from '@/composables/useConfirm';
import { useDialogSize, type DialogSizeResult } from '@/composables/useDialogSize';
import {
  findCustomerLabel,
  makeUid,
  resolveRootCustomerId,
  revokeEntryUrls,
  todayIso,
} from './usePartBatchShared';
import {
  partEntrySchema,
  toFieldErrors,
  type PartEntryFieldErrors,
  type PartEntryInput,
} from '../partEntrySchema';

/** 待新增条目（与原 PartBatchNew.vue:StagedEntry 同形）。 */
export interface StagedEntry {
  uid: string;
  drawingNo: string;
  name: string;
  applicantName: string;
  applicantId: string | null;
  customerId: string | null;
  customerLabel: string;
  quantity: number;
  isUrgent: boolean;
  requestDate: string;
  plannedDeliveryDate: string;
  /** PR-F 2026-07-17：送货单字段 */
  orderNo: string | null;
  systemDeliveryDate: string | null;
  note: string | null;
  drawingFile: File | null;
  drawingName: string | null;
  drawingUrl: string | null;
}

export interface FormState {
  drawingNo: string;
  name: string;
  applicantName: string;
  applicantId: string | null;
  customerId: string | null;
  quantity: number;
  isUrgent: boolean;
  requestDate: string;
  plannedDeliveryDate: string;
  /** PR-F 2026-07-17：送货单字段 */
  orderNo: string | null;
  systemDeliveryDate: string | null;
  note: string | null;
  drawingFile: File | null;
  drawingName: string | null;
  drawingUrl: string | null;
}

export interface UsePartBatchManualOptions {
  /** 客户全集（由 shell 加载并传入；两个 Tab 共用，避免重复拉）。 */
  customers: Ref<Customer[]>;
  /** 申请人搜索共享实例（shell 创建一次；两 Tab 共用 cache）。 */
  applicantSearch: {
    applicants: Ref<Applicant[]>;
    /** 当前缓存对应的一级客户 id；Bug 2 dedupe 用 */
    rootCustomerId: Ref<string | null>;
    loading: Ref<boolean>;
    loadForCustomer: (pickedId: string | null) => Promise<void>;
    querySearch: (queryString: string, cb: (items: Applicant[]) => void) => void;
  };
}

/**
 * Tab 1「录入」的全部 state + handler。返回值直接 `v-bind` 给 PartBatchManualTab。
 */
/** 2026-09-21 显式返回类型。 */
export interface UsePartBatchManualReturn {
  previewDescCol: number;
  addDlg: DialogSizeResult;
  previewDlg: DialogSizeResult;
  /**
   * 2026-10-17（客户无限层级改造）：el-cascader 的 options 直接用
   * `api/customer.tree.ts::buildCustomerTree` 的产物（任意深度 + 每级带
   * `customer_path`）。此前是本文件内联拼的**硬编码两层**树，第 3 层往下的客户根本
   * 选不到。
   */
  customerTree: ComputedRef<CustomerTreeNode[]>;
  // 2026-09-30 hotfix 第 1 轮：applicantCandidates 从返回对象移除，避免
  // PartBatchManualTab.vue 触发「extraneous non-props attribute」告警（v-bind="manual"
  // 摊开所有键给子组件，但子组件 declareProps 未声明 applicantCandidates）。
  applicantLoading: Ref<boolean>;
  querySearch: (queryString: string, cb: (items: Applicant[]) => void) => void;
  staged: Ref<StagedEntry[]>;
  addDialogVisible: Ref<boolean>;
  dialogSubmitting: Ref<boolean>;
  editingUid: Ref<string | null>;
  drawingPreviewVisible: Ref<boolean>;
  drawingPreviewRow: Ref<StagedEntry | null>;
  previewDialogVisible: Ref<boolean>;
  previewing: Ref<StagedEntry | null>;
  // 2026-09-24 重构：submitting 由 useMutation 派生，Ref → ComputedRef。
  submitting: ComputedRef<boolean>;
  // 2026-09-24 新增：Zod schema 校验错误聚合（替代 EP FormRules + formRef.validate()）。
  formErrors: Ref<PartEntryFieldErrors>;
  // 2026-09-24 新增：单字段校验入口（LoginView 同款）。onBlur / onChange 触发。
  validateField: (field: keyof PartEntryInput) => void;
  form: FormState;
  hydrateRestoredCount: ComputedRef<number>;
  // orphanFileRefs 的 session 来源早已下线，值恒为空数组；这里保留只是为了不动页面结构。
  // ⚠️ 上传直连化后**没有 tmp_key 这个东西了**（STS 临时凭证链路已下线，正式 object_key
  // 由 upload-intents 直接签发），字段里也不该再留着它 —— 留着会让后来者以为存在
  // 「tmp 区对象」这条路径。
  orphanFileRefs: ComputedRef<
    Array<{
      client_ref: string;
      status?: string;
      kind?: string;
      file_size?: number;
      original_filename?: string;
      uploaded_at?: string | null;
    }>
  >;
  openDrawingPreview: (row: StagedEntry) => void;
  onDrawingPreviewClosed: () => void;
  closeAddDialog: () => void;
  closePreviewDialog: () => void;
  closeDrawingPreview: () => void;
  openAddDialog: () => void;
  onCustomerChange: (pickedId: unknown) => Promise<void>;
  onApplicantSelect: (item: Record<string, unknown>) => void;
  /**
   * 2026-10-15：对话框里选图纸（`<el-upload :auto-upload="false">` 的 on-change）。
   * **只暂存本地 File，不发任何请求** —— 上传发生在建单成功之后。
   * 第二参数是新选的文件（null = 用户移除），单 PDF 限：选了新的就替换旧的。
   */
  onDrawingFileChange: (file: File | null) => void;
  // 2026-09-24 重构：onAddConfirm / onDialogClosed 不再吃 FormInstance（zod 化后
  // formRef.validate / clearValidate 失去存在意义）。
  onAddConfirm: () => Promise<void>;
  onDialogClosed: () => void;
  onRowPreview: (row: StagedEntry) => void;
  onEditFromPreview: () => void;
  onRemoveRow: (uid: string) => void;
  onClearAll: () => Promise<void>;
  rowClassName: (ctx: { row: unknown }) => string;
  // 2026-09-24 重构：onSubmit 走 useMutation，handler 内仅做空守卫 + confirm + mutate()。
  onSubmit: () => Promise<void>;
  // ============ 2026-10-15：建单成功后的图纸上传阶段 ============
  /** 是否正在传图纸（提交按钮 loading 的一部分）。 */
  drawingUploadingNow: ComputedRef<boolean>;
  /**
   * 上传失败的清单（每行 = 「图号 xxx · 文件名：原因」）。**零件此时已经落库**，
   * 这张清单是唯一的补救入口。
   */
  drawingUploadFailures: ComputedRef<string[]>;
  /** 失败项数（0 = 没有失败，页面不显示失败面板）。 */
  drawingUploadFailedCount: ComputedRef<number>;
  /**
   * 本次提交是否**有行没建成**（`res.failed.length > 0`）。true 时失败面板要同时说清
   * 两件不同的事：① 未建成的行**可以**修正后重新提交（它们已从待新增列表移除）；
   * ② 已建成的行**不能**重新提交（零件已落库），只能用面板上的「重试上传」补图纸。
   */
  partialSubmitFailedRows: Ref<boolean>;
  /** 重跑全部失败项。 */
  retryDrawingUploads: () => Promise<void>;
  /** 清掉上传阶段的现场（失败清单 / 状态），不碰已落库的零件。 */
  dismissDrawingUploadResult: () => void;
}

export function usePartBatchManual(opts: UsePartBatchManualOptions): UsePartBatchManualReturn {
  const { customers, applicantSearch } = opts;
  const router = useRouter();

  // ============ 响应式 ============
  const previewDescCol = 2;
  // 各 dialog 独立的响应式宽度（保留桌面固定 px）
  const addDlg = useDialogSize({ desktopWidth: 900 });
  const previewDlg = useDialogSize({ desktopWidth: 720 });

  const { dangerous: confirmDangerous } = useConfirm();

  // ============ 客户树（用于 cascader） ============
  // 2026-10-17：换成 buildCustomerTree（任意深度；每个节点带 customer_path / depth /
  // root_id，cascader 的 label 直接吃 customer_path）。拼树逻辑不在本文件另写一份 ——
  // 脏数据口径（孤儿 / 环 / 重复 id）与全仓其它客户树消费方必须一致。
  const customerTree = computed<CustomerTreeNode[]>(() => buildCustomerTree(customers.value));

  // ============ 待新增列表 ============
  const staged = ref<StagedEntry[]>([]);

  // ============ Dialog 表单 ============
  // 2026-09-24 改造：EP formRefLocal 机制彻底移除——zod schema-first 后 formRef.validate()
  // 不再需要；onAddConfirm / onDialogClosed 不再吃 FormInstance 形参。PartBatchManualTab
  // 顶部的 el-form 不再绑 :rules、不再需要 ref 转发。
  const addDialogVisible = ref(false);
  const dialogSubmitting = ref(false);
  const editingUid = ref<string | null>(null);

  // ============ Zod schema 单字段错误聚合 ============
  // 2026-09-24：替代 EP FormRules 错误展示位。el-form-item :error="formErrors.xxx" 直接绑。
  // 提交前整体校验失败时同样写此 ref。
  const formErrors = ref<PartEntryFieldErrors>({});

  // ============ 图纸暂存（2026-10-15 翻转时序）============
  //
  // 对话框里的 `<el-upload :auto-upload="false">` 只做一件事：**把选中的 File 暂存到
  // form 上**。不发任何请求、不签任何 URL、不算 sha。真正的上传发生在
  // `submitMutation.onSuccess` 之后 —— 那时零件已经有 id 了。
  //
  // 为什么值得这么翻：改前「选文件即传」让用户在「还在改表单、随时可能点取消」的阶段就
  // 把几百 MB 传上去了，而这份字节最终能不能用取决于建单成不成功（不成功就白传）。
  // 翻转之后字节只在**确定会建单**的那一刻才开始流动。

  // draft 持久化（staged 列表）。图纸**不进草稿** —— 它是内存里的 File 对象，
  // 刷新即失效；刷新后这一行的图纸位显示为空，用户重新选一次即可（与 pdf_tab 整段
  // 「只写不读」是同款取舍，见 usePartsNewDraft 的注释）。
  const draft = usePartsNewDraft();

  // 建单成功后的图纸上传状态机（2026-10-15）。它是**本 Tab 独有**的一份实例，不与
  // Tab2 的 `usePartBatchPdfUploads` 共享 —— 后者的状态与「行集合世代号」深度耦合，
  // 共享会把 Tab2 的表格语义泄漏过来（见 usePostSubmitUploads 文件头）。
  const uploads = usePostSubmitUploads();

  // 暴露 hydrateResult / hydrateRestoredCount / orphanFileRefs 给 UI 渲染
  // 「已恢复 N 条」顶部 el-alert + 「孤儿文件待认领」面板（A3）。
  // 值恒为空（session 来源早已下线），两个计数恒 0 / 空数组。
  const hydrateResult = ref<MergeResult | null>(null);
  const hydrateRestoredCount = computed<number>(() => {
    const r = hydrateResult.value;
    if (!r) return 0;
    return r.manualStaged.filter((s) => s.drawing === 'done').length;
  });
  const orphanFileRefs = computed(() => hydrateResult.value?.orphanFileRefs ?? []);

  /** PDF 弹窗预览（图号列点击触发） */
  const drawingPreviewVisible = ref(false);
  const drawingPreviewRow = ref<StagedEntry | null>(null);
  function openDrawingPreview(row: StagedEntry): void {
    drawingPreviewRow.value = row;
    drawingPreviewVisible.value = true;
  }
  function onDrawingPreviewClosed(): void {
    drawingPreviewRow.value = null;
  }

  /** 模板里点「取消」按钮的关闭动作（prop 在子组件是 readonly，父组件提供 mutator）。 */
  function closeAddDialog(): void {
    addDialogVisible.value = false;
  }
  function closePreviewDialog(): void {
    previewDialogVisible.value = false;
  }
  /** 图纸 PDF 预览 dialog 的关动作（el-dialog X / Esc 触发：先 visible=false，再走 @closed 清 row）。 */
  function closeDrawingPreview(): void {
    drawingPreviewVisible.value = false;
  }

  const initialForm = (): FormState => ({
    drawingNo: '',
    name: '',
    applicantName: '',
    applicantId: null,
    customerId: null,
    quantity: 1,
    isUrgent: false,
    requestDate: todayIso(),
    plannedDeliveryDate: '',
    orderNo: null,
    systemDeliveryDate: null,
    note: null,
    drawingFile: null,
    drawingName: null,
    drawingUrl: null,
  });

  const form = reactive<FormState>(initialForm());

  /**
   * 保持 applicantId 与 applicantName 一致：
   * - 用户从下拉挑了某人：applicantName = item.name，applicantId = item.id（@select 设）
   * - 用户清空 / 继续打字改了名字：当前 applicantId 已不再指向同名 → 清掉
   *   → 让 onSubmit 走「自动新增」分支（submitStagedEntries 内
   *     getOrCreateApplicant 段；2026-10-17 起该段已幂等 + 单行失败不中止整批）。
   * - onEditFromPreview 反填 staged row 时若 applicantId 已 stale，watcher 也自愈。
   *
   * 注意：本 watcher 必须在 const form 声明之后注册 —— watch 的 getter 在 setup
   * 阶段就会同步执行一次以注册 reactive 依赖，提前引用 form 会触发 TDZ。
   */
  watch(
    () => form.applicantName,
    (next) => {
      const currentId = form.applicantId;
      if (currentId === null) return;
      const matched = applicantSearch.applicants.value.find((a) => a.id === currentId);
      if (matched && matched.name === next) return;
      form.applicantId = null;
    },
  );

  // ============ Zod schema 单字段校验 ============
  // 2026-09-24：替代 EP FormRules + formEl.validate()。直接取 schema.shape[field] 跑
  // safeParse 拿到单字段错误，与 LoginView.validateField 同款。
  function validateField(field: keyof PartEntryInput): void {
    const fieldSchema = partEntrySchema.shape[field];
    const result = fieldSchema.safeParse(form[field as unknown as keyof FormState]);
    if (result.success) {
      delete formErrors.value[field];
    } else {
      formErrors.value[field] = result.error.issues[0]?.message;
    }
  }

  function openAddDialog(): void {
    editingUid.value = null;
    Object.assign(form, initialForm());
    // 申请人候选由 onCustomerChange 在客户变更时刷新；openAddDialog
    // 调 initialForm() 把 customerId 置空，所以这里无需再清缓存。
    addDialogVisible.value = true;
  }

  async function onCustomerChange(pickedId: unknown): Promise<void> {
    // cascader emitPath:false → string id；但 Element Plus 类型声明是 CascaderValue
    const raw = Array.isArray(pickedId) ? pickedId[pickedId.length - 1] : pickedId;
    const idStr = raw === null || raw === undefined ? '' : String(raw);
    form.applicantId = null;
    form.applicantName = '';
    // 客户变更清掉旧错误，避免新选的客户被旧「客户不存在」卡住
    delete formErrors.value.customerId;
    await applicantSearch.loadForCustomer(idStr || null);
  }

  function onApplicantSelect(item: Record<string, unknown>): void {
    form.applicantId = String(item.id);
    // form.applicantName 由 v-model 自动同步为 item.name，无需手动设
  }

  // ============ 图纸暂存（2026-10-15 翻转时序）============
  //
  // 对话框里的 `<el-upload :auto-upload="false">` 只做一件事：**把选中的 File 暂存到
  // form 上**（外加一个 blob URL 给预览）。不发任何请求、不签 URL、不算 sha。
  // 真正的上传发生在 `submitMutation.onSuccess` 之后 —— 那时零件已经有 id 了。

  /**
   * 对话框内选 / 换 / 移除图纸（2026-10-15）。**只暂存，不上传**。
   *
   * 传 null 表示用户移除了当前图纸。选中新文件时按「替换」语义处理：先 revoke 旧的
   * blob URL 再挂新的（否则那一份几百 MB 的字节会一直挂在内存里直到刷新页面）。
   */
  function onDrawingFileChange(file: File | null): void {
    // 替换旧文件 → 撤销旧 blob URL 防止内存泄漏
    if (form.drawingUrl) {
      try {
        URL.revokeObjectURL(form.drawingUrl);
      } catch {
        /* ignore */
      }
    }
    if (!file) {
      form.drawingFile = null;
      form.drawingName = null;
      form.drawingUrl = null;
      return;
    }
    form.drawingFile = file;
    form.drawingName = file.name;
    form.drawingUrl = URL.createObjectURL(file);
  }


  /**
   * 「加入列表 / 保存到列表」按钮：Zod 全表单校验 + 业务校验（客户存在性）→ 入队。
   *
   * 2026-09-24 重构：删 formEl.validate() / formEl.clearValidate() 管道；改走
   * partEntrySchema.safeParse(form) → toFieldErrors 写 formErrors ref；
   * 客户存在性等依赖动态列表的校验不进 schema，留在本层写 formErrors.customerId。
   * 字段 trim 由 schema 安全处理（safeParse 返回的 result.data 已 trim）。
   */
  async function onAddConfirm(): Promise<void> {
    // 1) Zod 全表单校验
    const result = partEntrySchema.safeParse(form);
    if (!result.success) {
      formErrors.value = toFieldErrors(result.error.issues);
      return;
    }
    formErrors.value = {};

    // 2) 业务校验：客户存在性（依赖动态 customers 列表，不进 schema）
    const rawId = result.data.customerId;
    const matched = customers.value.find((x) => String(x.id) === String(rawId));
    if (!matched) {
      formErrors.value = { ...formErrors.value, customerId: '客户不存在' };
      return;
    }

    // 2.1) 2026-10-17（客户无限层级改造）：**必须是叶子**。业务单据（零件 / 装配件 /
    // 送货单）只能挂末级部门，中间层只能用来筛选，挂上去会被后端拒（20104）。
    // 为什么不放进 partEntrySchema：schema 是纯字段校验，那层拿不到客户树结构，
    // 「有没有子节点」只能在持有 customers 的调用点判定（与「客户存在性」同款，
    // schema 文件头的口径：依赖动态状态的检查不进 schema）。
    // 判据走共享函数 `leafCustomersOf`（CLAUDE.md「客户无限层级」一节：「任何根客户 /
    // 叶子客户判定都走它，不要就地写 `parent_id !== null`」）——就地反查「有没有节点
    // 以我为父」与它逐字等价，但会漏掉它那份按 id 去重的脏数据口径。
    const isLeaf = leafCustomersOf(customers.value).some((x) => x.id === matched.id);
    if (!isLeaf) {
      formErrors.value = {
        ...formErrors.value,
        customerId: `「${matched.customer_path || matched.name}」还有下级部门，单据只能挂在末级部门`,
      };
      return;
    }

    dialogSubmitting.value = true;
    try {
      const entry: StagedEntry = {
        uid: editingUid.value ?? makeUid(),
        drawingNo: result.data.drawingNo,
        name: result.data.name,
        applicantName: result.data.applicantName,
        applicantId: form.applicantId,
        customerId: rawId,
        customerLabel: findCustomerLabel(customers, rawId),
        quantity: result.data.quantity,
        isUrgent: result.data.isUrgent,
        requestDate: result.data.requestDate,
        plannedDeliveryDate: result.data.plannedDeliveryDate,
        orderNo: result.data.orderNo || null,
        systemDeliveryDate: result.data.systemDeliveryDate || null,
        note: result.data.note || null,
        drawingFile: form.drawingFile,
        drawingName: form.drawingName,
        drawingUrl: form.drawingUrl,
      };

      if (editingUid.value) {
        // 编辑模式：找到旧条目，先释放旧 URL，再替换
        const idx = staged.value.findIndex((s) => s.uid === editingUid.value);
        if (idx >= 0) {
          revokeEntryUrls(staged.value[idx]);
          staged.value.splice(idx, 1, entry);
        }
      } else {
        // 新增：原 dialog 的 url 转交给 entry（已经放进 entry），把 form 上的 url 置空避免 onClosed 重复释放
        form.drawingUrl = null;
        form.drawingFile = null;
        form.drawingName = null;
        staged.value.push(entry);
      }
      addDialogVisible.value = false;
      ElMessage.success(editingUid.value ? '已更新到列表' : '已加入待新增列表');
    } finally {
      dialogSubmitting.value = false;
    }
  }

  /**
   * el-dialog @closed 回调：清 form + 校验位 + 上传临时状态。
   *
   * 2026-09-24 重构：不再吃 FormInstance；clearValidate 等价物改为 formErrors 重置。
   * 子组件（PartEntryFormDialog）会先 revoke blob URL / clear uploader queue 再调本函数。
   */
  function onDialogClosed(): void {
    // 仅在「取消」关闭时表单上仍残留 url 才需要回收；onAddConfirm 成功后已把 url 转交
    if (form.drawingUrl) {
      try {
        URL.revokeObjectURL(form.drawingUrl);
      } catch {
        /* ignore */
      }
    }
    formErrors.value = {};
    Object.assign(form, initialForm());
    editingUid.value = null;
  }

  // ============ 行操作：查看 / 删除 / 编辑 ============
  const previewDialogVisible = ref(false);
  const previewing = ref<StagedEntry | null>(null);

  function onRowPreview(row: StagedEntry): void {
    previewing.value = row;
    previewDialogVisible.value = true;
  }

  function onEditFromPreview(): void {
    const target = previewing.value;
    if (!target) return;
    previewDialogVisible.value = false;
    // 把目标 entry 的字段塞回 form
    editingUid.value = target.uid;
    Object.assign(form, {
      drawingNo: target.drawingNo,
      name: target.name,
      applicantName: target.applicantName,
      applicantId: target.applicantId,
      customerId: target.customerId,
      quantity: target.quantity,
      isUrgent: target.isUrgent,
      requestDate: target.requestDate,
      plannedDeliveryDate: target.plannedDeliveryDate,
      orderNo: target.orderNo,
      systemDeliveryDate: target.systemDeliveryDate,
      note: target.note,
      drawingFile: target.drawingFile,
      drawingName: target.drawingName,
      drawingUrl: target.drawingUrl,
    });
    formErrors.value = {};
    addDialogVisible.value = true;
    // 标记该 entry 的 url 已被 dialog 接管；切到 list 时不再 revoke 它
    // 简化处理：编辑模式下，旧 url 仍属于 entry；编辑确认时 onAddConfirm 会先 revokeEntryUrls(staged[idx])，避免泄漏
    target.drawingUrl = null;
    target.drawingFile = null;
    target.drawingName = null;
    // 同步刷新 rootCustomerId 与申请人候选（让下拉带回原选项）
    if (target.customerId) {
      void applicantSearch.loadForCustomer(target.customerId);
    }
  }

  /**
   * 删一行。
   *
   * ⚠️ **提交进行中直接拒**：上传阶段整个跑在 mutation 的 onSuccess 里（`isPending`
   * 覆盖到上传结束），页面还停在这张表上。此时删行会让后面所有下标左移，而
   * `created[].sourceIndex` 是按**提交那一刻**的行序算的 ⇒ 后面某行的 File 会被挂到
   * 别的零件上，**不可逆**。UI 侧已把「删除 / 添加 / 编辑」在 `submitting` 期禁用，
   * 这里再设一道是因为 composable 是唯一能保证「状态机自洽」的位置（UI 漏一个 disabled
   * 不会静默降级成数据串行）。
   */
  function onRemoveRow(uid: string): void {
    if (submitting.value) {
      ElMessage.warning('提交进行中（含图纸上传），不能改动待新增列表');
      return;
    }
    const idx = staged.value.findIndex((s) => s.uid === uid);
    if (idx < 0) return;
    revokeEntryUrls(staged.value[idx]);
    staged.value.splice(idx, 1);
  }

  async function onClearAll(): Promise<void> {
    if (
      !(await confirmDangerous(
        '提示',
        `确认清空 ${staged.value.length} 条待新增记录？此操作无法撤销。`,
        { type: 'warning', confirmText: '清空', cancelText: '取消' },
      ))
    )
      return;
    staged.value.forEach(revokeEntryUrls);
    staged.value = [];
  }

  function rowClassName({ row }: { row: unknown }): string {
    const r = row as StagedEntry;
    return r.isUrgent ? 'row-urgent' : '';
  }

  // ============ 提交 ============
  // 2026-09-24 重构：onSubmit → useMutation。
  //
  // mutationFn 薄封装：调内部 submitStagedEntries()（原 onSubmit 的主体：dedupe +
  // batchCreateParts），原样搬；部分失败 / 成功跳转 / 消息走 onSuccess / onError。
  // 整批 best-effort 的 consumeFiles + draft clear + staged 清空也由 onSuccess 在
  // 「无失败」分支处理。mutation 失败用 onError ElMessage.error 反馈（保留原 UX）。

  /**
   * 提交主体（薄封装）：
   *   1) 遍历 staged，为无 applicantId 的条目解析申请人（缓存命中复用 id，
   *      未命中 → 调**幂等**端点 get-or-create 自动新增）；
   *   2) 构造 payload 调 batchCreateParts（按 customer_id 分组，跨客户混合语义由
   *      api 层负责）；
   *   3) 返回 PartBatchResult 交给 onSuccess 分流（部分失败 / 全成功）。
   *
   * 此函数不负责：
   *   - 清 staged / draft / session consumeFiles（放 onSuccess）；
   *   - 跳转 / ElMessage（放 onSuccess / onError）；
   *   - 入队前 confirm 确认（放 onSubmit handler）。
   *
   * ⚠️ 第 1 步**绝不允许**抛错中止整批 —— 2026-10-17 修复，详见循环体注释。
   */
  async function submitStagedEntries(): Promise<PartBatchResult> {
    // 1) 先为每条 entry 解析 applicant_id：
    //    - 已有 applicantId（用户从下拉挑的）→ 跳过；
    //    - 在缓存中能按 name 命中 → 复用其 id（2026-09-16 修复引入的**快路径**，
    //      保留：省掉一次网络往返；2026-10-17 起它只是优化，不再是正确性依赖）；
    //    - 缓存未命中（且缓存对应 L1 root 与本条 L1 一致时才查，避免
    //      跨 L1 root 误判）→ 调**幂等**端点 `getOrCreateApplicant`。
    //
    // 2026-10-17 两处修复：
    //
    // (a) `createApplicant` → `getOrCreateApplicant`。原实现对每条未命中的行直接
    //     POST `/com/applicants`，**非幂等**：同一批里两行同名申请人（用户自由
    //     文本录入，placeholder 明写「不在表中则提交时自动新增」）第二行必然
    //     撞后端唯一键 409 → 整批 reject。
    //
    // (b) 每行包 try/catch，失败只 console.warn + applicantId 留 null，**不中止
    //     整批**。为什么这不算降级丢功能：后端 `PartBatchCreateItem` **没有**
    //     `applicant_id` 字段（`applicant_name` 是自由文本，直接存进
    //     `t_part.applicant_name`，见 backend-rust 的 PartBatchCreateItem 契约
    //     与 `t_part` 表结构 —— 前端多带该键后端 serde 默认忽略），所以拿不到
    //     id **完全不影响工单创建**。一行申请人解析失败拖垮整批订单才是真 bug。
    for (const s of staged.value) {
      if (s.applicantId) continue;
      const trimmed = s.applicantName.trim();
      if (!trimmed || !s.customerId) continue;
      const rootId = resolveRootCustomerId(customers, s.customerId);
      if (rootId === null) continue;
      if (applicantSearch.rootCustomerId.value === rootId) {
        const cached = applicantSearch.applicants.value.find(
          (a) => a.name === trimmed && a.customer_id === rootId,
        );
        if (cached) {
          s.applicantId = cached.id;
          continue;
        }
      }
      try {
        const applicant = await getOrCreateApplicant({
          name: trimmed,
          customer_id: String(rootId),
        });
        s.applicantId = applicant.id;
        // 回写缓存（同 root 下）：同一批里后续同名行即可走上面的快路径，
        // 不必再打一次网络。rootCustomerId 对不上时**不写** —— 那是别人的缓存。
        if (applicantSearch.rootCustomerId.value === rootId) {
          applicantSearch.applicants.value = [...applicantSearch.applicants.value, applicant];
        }
      } catch (e) {
        // ⚠️ **已知缺口，不是「有意设计」**（2026-10-17 登记）：这里只
        // `console.warn`，**用户零反馈** —— 提交照常成功、工单照常建出来，
        // 界面上不弹任何提示、该行也不留任何标记。**允许**这么降级的根据就是上面
        // (b) 那条：后端 `PartBatchCreateItem` 没有 `applicant_id` 字段，
        // `applicant_name` 是自由文本直落 `t_part`，所以这一行拿不到 id **确实
        // 不影响建单**；为它中止整批才是真 bug。
        //
        // 但**它仍然是缺口**，别把「不影响建单」读成「没问题」：① 生产环境
        // `console.warn` 等于无人看见；② 将来申请人登记真出故障（get-or-create
        // 返 4xx / 401 会话过期 / 网络断）时，现场既没有用户可见线索、也没有前端
        // 埋点能回溯是哪一行哪一次提交漏了 `applicant_id`，只能反查后端日志。
        // **待补**：一个用户可见的弱提示 + 该行标记位，让用户知道「这行的申请人
        // 没登记上」。在补上之前，本行与 `console.warn` 的存在只保证「不拖垮整批」。
        // 行为守卫：`__tests__/usePartBatchManual.spec.ts` 的「幂等端点 reject」
        // 与「一行失败不牵连同批其它行」两条（前者钉住 warn 确实发出，避免将来有人
        // 把它删成彻底静默）。
        console.warn(
          `[usePartBatchManual] 申请人「${trimmed}」解析失败，该行 applicant_id 留空（不影响建单）:`,
          e,
        );
      }
    }

    // 2) 构造批量 payload
    const items: PartBatchCreatePayload[] = staged.value.map((s) => ({
      name: s.name,
      drawing_no: s.drawingNo,
      applicant_name: s.applicantName,
      // applicant_id 雪花 ID 19 位 → 必须用字符串，避免 JS Number 精度丢失
      applicant_id: s.applicantId,
      quantity: s.quantity,
      request_date: s.requestDate,
      planned_delivery_date: s.plannedDeliveryDate,
      is_urgent: s.isUrgent,
      /** PR-F 2026-07-17：送货单字段 */
      order_no: s.orderNo,
      system_delivery_date: s.systemDeliveryDate,
      note: s.note,
      // customer_id 雪花 ID 字符串（CLAUDE.md §3）
      customer_id: s.customerId!,
    }));
    return batchCreateParts(items);
  }

  /**
   * 建单成功后的「传图纸」阶段（2026-10-15）。
   *
   * `created[i].sourceIndex` 是本次请求 items 数组的全局下标，而 items 正是
   * `staged.value.map(...)` 逐字构造的 ⇒ **下标就是 staged 的下标**，据此把「建出来的
   * 零件」对回「本地哪一行」。只有那些**既建成了、又带了图纸**的行才产生 job。
   *
   * 三种收场：
   * 1. 一份图纸都没有 ⇒ 提示成功；`navigate` 为真时跳页；
   * 2. 全部传完 ⇒ 同上；
   * 3. 有失败 ⇒ **停在当前页**，弹一条讲清「零件已创建、图纸没传上去」的 warning，
   *    失败清单由页面渲染。用户点清单上的「重试」只重传文件，绝不重建单。
   *
   * @param opts.navigate 全成功时是否跳页 + 弹「成功新建 N 条」。**部分行未建成时传
   *   false** —— 那一支页面上还留着未建成的行要用户改、还留着图纸失败清单要人重试，
   *   跳过去两样都看不见；提示语也不能说「成功新建」，它会把用户引到「这批全好了」的
   *   错误结论上（真正未建成行数由调用方的 alert 说）。
   */
  async function runDrawingUploadPhase(
    res: PartBatchResult,
    opts: { navigate: boolean },
    snapshot: StagedEntry[],
  ): Promise<void> {
    // ⚠️ **只读 `snapshot`，不要读 `staged.value`**：`created[i].sourceIndex` 是「本次请求
    // items 数组的下标」，而 items 是提交瞬间的 `staged` 逐字构造的。上传阶段跑在 mutation
    // 的 onSuccess 内（`isPending` 覆盖整段），这段时间里 `staged` 仍可被改动 ——
    // 用户删掉前面某行会让后面下标左移，按可变的 `staged.value` 回查就会把**别的行的
    // File** 挂到当前零件上（不可逆）。UI 侧已把「删除 / 添加 / 编辑」在 submitting 期
    // 禁用，那只是第一道闸；这里是第二道，且不依赖 UI。
    const jobs: PostSubmitUploadJob[] = res.created
      .filter((c) => {
        const entry = snapshot[c.sourceIndex];
        return !!entry?.drawingFile;
      })
      .map((c) => {
        const entry = snapshot[c.sourceIndex]!;
        return {
          // job id 取 staged 的 uid：同一份 File 被两行引用时是两个独立 job（各自的目标
          // 零件不同），粒度必须是 job 而不是文件，否则失败一个会把另一个也重跑。
          id: `manual:${entry.uid}`,
          filename: entry.drawingName ?? entry.drawingFile!.name,
          // ⚠️ 标签必须**此刻**存进去：`runDrawingUploadPhase` 返回后 staged 会被清空，
          // 失败清单那时再回头查「这条 job 对应哪一行」已经查不到了。
          label: `图号 ${entry.drawingNo}`,
          file: entry.drawingFile!,
          ownerKind: 'PART' as const,
          ownerId: c.id,
          kind: 'DRAWING' as const,
        };
      });

    if (jobs.length === 0) {
      if (opts.navigate) {
        ElMessage.success(`成功新建 ${res.created.length} 条零件`);
        await router.push({ path: '/parts', query: { status: 'PENDING' } });
      }
      return;
    }

    uploads.registerJobs(jobs);
    await uploads.runJobs(jobs);
    const failures = uploads.failedJobs.value;
    if (failures.length === 0) {
      if (opts.navigate) {
        ElMessage.success(`成功新建 ${res.created.length} 条零件`);
        await router.push({ path: '/parts', query: { status: 'PENDING' } });
      } else {
        // 部分行未建成：能说的只有「已建成的那几行图纸传好了」，不能说「成功新建 N 条」。
        ElMessage.success(`已建成 ${res.created.length} 条零件，其图纸全部上传成功`);
      }
      return;
    }
    ElMessage.warning(
      `零件已创建 ${res.created.length} 条，其中 ${failures.length} 份图纸未上传成功。` +
        `请在页面下方「图纸上传失败」面板里重试（零件已经建出来了，不要重新提交）。`,
    );
  }

  /**
   * 本次提交有没有行没建成。**每次提交前复位**：它只描述「上一次性提交」的形态，
   * 带着上一批的 true 去渲染下一批的面板文案就是错的。
   */
  const partialSubmitFailedRows = ref(false);

  /**
   * 本次提交的行快照（由 `mutationFn` 在**发请求之前**写下）。
   *
   * 上传阶段（`runDrawingUploadPhase`）与「已建成行的摘除」都必须按它回查，不能按
   * 可变的 `staged.value` —— 见 `runDrawingUploadPhase` 的注释。
   */
  const activeSubmitSnapshot = ref<StagedEntry[]>([]);

  const submitMutation = useMutation<PartBatchResult, Error, undefined>({
    mutationKey: ['parts', 'manual', 'batch-create'],
    // ⚠️ **提交瞬间对 `staged` 做快照**：上传阶段整个跑在 onSuccess 里（`isPending`
    // 覆盖到上传结束），这段时间里 `staged` 仍可能被改动，而 `created[].sourceIndex`
    // 是按「提交那一刻的行序」算的。不快照就可能把别的行的图纸挂到当前零件上。
    mutationFn: async () => {
      activeSubmitSnapshot.value = staged.value.slice();
      return submitStagedEntries();
    },
    onSuccess: async (res) => {
      const partial = res.failed.length > 0;
      partialSubmitFailedRows.value = partial;

      // 2026-10-15：建单成功 → 追加「传图纸」阶段。
      //
      // ⚠️ **这是本次改造的失败语义核心**：到这里零件**已经落库**了。上传失败绝不
      // 能让用户以为「整次提交失败了」而再点一次提交（那就是重复建单）。所以这一段：
      //   - 不回 idle、不重置 staged 的建单结果；
      //   - 失败项进独立的 `drawingUploadFailures` 清单，由页面渲染成可重试的面板；
      //   - 有失败时**不跳页**（跳过去用户就没地方看见清单、也没地方点重试）。
      //
      // ⚠️ **部分行未建成（`res.failed.length > 0`）时同样要跑这一段**：那些建成的行
      // 已经落库了，它们的图纸再不上传就既不进失败清单、也不提示，用户一点都看不出来。
      // 不跳页（`navigate: false`）：页面上还留着未建成的行要用户改。
      // 必须排在下面改 `staged` **之前** —— 它按 `sourceIndex` 回 staged 取 File。
      await runDrawingUploadPhase(res, { navigate: !partial }, activeSubmitSnapshot.value);

      if (partial) {
        // ⚠️ **已建成的行必须从 staged 里摘掉**：留着的话，用户改完失败行再点一次提交，
        // 会为已经建出来的那些行**再建一遍单** —— 那是真数据损坏，而「改完重提失败行」
        // 本身是被允许的动作。摘掉的行一并 revoke 掉它的 blob URL。
        // ⚠️ 摘除同样按快照下标算；但**当前 staged 已经被用户改动过**（UI 侧在
        // submitting 期禁了删除/添加/编辑，理论上下标仍对齐；这里仍做一次对齐守卫：
        // 长度不一致说明 UI 漏了闸，宁可一行都不摘，也不能摘错行）。
        const createdIndexes = new Set(res.created.map((c) => c.sourceIndex));
        const snapshotLen = activeSubmitSnapshot.value.length;
        const aligned = staged.value.length === snapshotLen;
        if (aligned) {
          staged.value.filter((_, i) => createdIndexes.has(i)).forEach(revokeEntryUrls);
          staged.value = staged.value.filter((_, i) => !createdIndexes.has(i));
        } else {
          // 错位 ⇒ 用 uid 兜底（uid 是每行稳定的身份，不随下标移动）
          const createdUids = new Set(
            activeSubmitSnapshot.value
              .filter((_, i) => createdIndexes.has(i))
              .map((e) => e.uid),
          );
          staged.value.filter((s) => createdUids.has(s.uid)).forEach(revokeEntryUrls);
          staged.value = staged.value.filter((s) => !createdUids.has(s.uid));
        }

        const sample = res.failed
          .slice(0, 5)
          .map((f) => `第 ${f.index + 1} 行：${f.message}`)
          .join('\n');
        const more = res.failed.length > 5 ? `\n...还有 ${res.failed.length - 5} 行失败` : '';
        const drawingNote =
          res.created.length > 0
            ? `\n\n另外 ${res.created.length} 行已建成（已从待新增列表移除），` +
              `它们的图纸上传结果见页面下方「图纸上传失败」面板；` +
              `已建成的零件**不要重新提交**。`
            : '';
        await ElMessageBox.alert(
          `服务端拒绝了 ${res.failed.length} 行：\n${sample}${more}${drawingNote}`,
          '部分行未通过',
          { type: 'warning' },
        ).catch(() => {
          /* 用户点叉忽略 */
        });
        return;
      }

      // 释放所有 blob URL
      staged.value.forEach(revokeEntryUrls);
      staged.value = [];
      // 提交成功后清空 draft
      draft.saver.cancel();
      draft.clear();
    },
    onError: (err) => {
      ElMessage.error(err.message ?? '提交失败');
    },
  });

  /** onSubmit handler：空守卫 + confirm 确认框 + 触发 mutation。 */
  async function onSubmit(): Promise<void> {
    if (staged.value.length === 0) {
      ElMessage.warning('没有可提交的待新增零件');
      return;
    }
    if (
      !(await confirmDangerous(
        '确认提交',
        `将向服务端提交 ${staged.value.length} 条新零件，提交后系统按客户自动分配序列号。是否继续？`,
        { type: 'info', confirmText: '提交', cancelText: '取消' },
      ))
    )
      return;
    partialSubmitFailedRows.value = false;
    submitMutation.mutate();
  }

  // submitting 暴露给模板（:disabled / :loading）。从 mutation.isPending 派生。
  const submitting = computed<boolean>(() => submitMutation.isPending.value);

  // 2026-09-18：unmount 时刷新 draft 快照 + 撤销 pending saver。session 不在
  // unmount 销毁 —— 两 Tab 共享同一单例，PDF Tab 仍在活跃时 session 续期
  // 定时器必须存活。
  onBeforeUnmount(() => {
    staged.value.forEach(revokeEntryUrls);
    draft.saver.flush();
    draft.saver.cancel();
  });

  // ============================================================
  // 2026-09-18 draft 持久化：监听 staged 变更 → debounce 500ms 写 localStorage
  // ============================================================
  //
  // 写时机：staged 数组任意字段变化 → schedule saver（debounce 500ms）；
  // commit 成功后 → clearDraft。
  //
  // 2026-09-18 B1 修复：cross-tab clobber。Manual Tab saver 之前写整个 payload
  // 时把 pdf_tab 覆盖为空（{rows:[]/...}），导致 PDF Tab 自己的 watcher 触发
  // 时再次覆盖 manual_tab → 两 Tab 任意一边写就抹掉另一边。改为：schedule 前
  // 先 draft.load() 取旧 payload，仅覆盖本 Tab 段。
  if (draft.userId) {
    watch(
      () => JSON.stringify(serializeManualTab()),
      () => {
        const prev = draft.load();
        const basePayload = {
          active_tab: prev?.active_tab ?? 'manual',
          saved_at: new Date().toISOString(),
          // 保留 pdf_tab 旧值；只有 PDF Tab 自己的 saver 会更新 pdf_tab 段
          pdf_tab: prev?.pdf_tab ?? {
            customerL1Id: null,
            requestDate: '',
            rows: [],
            assemblies: [],
            selectedPages: [],
          },
          manual_tab: serializeManualTab(),
        };
        draft.saver.schedule(basePayload);
      },
    );
  }

  /**
   * staged 数组 → SerializedStagedEntry[]。
   *
   * 2026-10-15：图纸**不进草稿**。改前草稿存的是 binding 的五个字段（tmp_key /
   * sha / filename / size / content_type），可那些 tmp_key 在刷新后早已失效；改后
   * 图纸是内存里的 File，刷新即失效 ⇒ 两者都不可恢复，索性一条不存（刷新后该行图纸位
   * 显示为空，用户重选一次即可）。
   */
  function serializeManualTab(): { staged: SerializedStagedEntry[]; form_draft?: unknown } {
    return {
      staged: staged.value.map((s) => ({
        uid: s.uid,
        drawingNo: s.drawingNo,
        name: s.name,
        applicantName: s.applicantName,
        applicantId: s.applicantId,
        customerId: s.customerId,
        customerLabel: s.customerLabel,
        quantity: s.quantity,
        isUrgent: s.isUrgent,
        requestDate: s.requestDate,
        plannedDeliveryDate: s.plannedDeliveryDate,
        orderNo: s.orderNo,
        systemDeliveryDate: s.systemDeliveryDate,
        note: s.note,
      })),
    };
  }

  // ============ 2026-10-15：图纸上传阶段的展示面 ============

  /**
   * 失败清单的可读文案（每行 = 「图号 xxx · 文件名：原因」）。
   *
   * 文案全部取自 job 上登记时就存好的字段（`label` / `filename`）—— staged 在上传阶段
   * 结束后会被清空，那时已经没法反查是哪一行了。
   */
  const drawingUploadFailures = computed<string[]>(() =>
    uploads.failedJobs.value.map(
      (f) => `${f.job.label ?? '零件'} · ${f.job.filename}：${f.error}`,
    ),
  );
  const drawingUploadFailedCount = computed<number>(() => uploads.failedJobs.value.length);

  /**
   * 重试全部失败项。**只重传文件**，绝不重建单 —— 零件此时已经落库，重建单就是重复建单。
   * 全部成功后面板自动消失（失败清单为空），并补一条成功提示。
   */
  async function retryDrawingUploads(): Promise<void> {
    await uploads.retryFailed();
    const left = uploads.failedJobs.value.length;
    if (left === 0) {
      ElMessage.success('图纸全部上传成功');
    } else {
      ElMessage.warning(`仍有 ${left} 份图纸未上传成功`);
    }
  }

  /** 用户手动关掉失败面板（放弃重试）。零件已落库，这里只清本地上传现场。 */
  function dismissDrawingUploadResult(): void {
    uploads.clear();
  }

  return {
    // dialog size + responsive
    previewDescCol,
    addDlg,
    previewDlg,
    // 客户树
    customerTree,
    // applicants
    // 2026-09-30 hotfix 第 1 轮：applicantCandidates 从返回对象删除（PartBatchManualTab
    // 未声明该 prop，v-bind 摊开后 Vue 会触发「extraneous non-props attribute」告警）；
    // UI 层仅消费 applicantLoading / querySearch（PartEntryFormDialog 用）。
    applicantLoading: applicantSearch.loading,
    querySearch: applicantSearch.querySearch,
    // state
    staged,
    addDialogVisible,
    dialogSubmitting,
    editingUid,
    drawingPreviewVisible,
    drawingPreviewRow,
    previewDialogVisible,
    previewing,
    submitting,
    // 2026-09-24：替代 EP rules；单字段 :error 展示位。
    formErrors,
    validateField,
    form,
    // hydrate 结果给 UI 渲染顶部「已恢复 N 条」el-alert + 「孤儿文件待认领」面板。
    // 恒为空（session 来源早已下线），保留是为了不动页面结构。
    hydrateRestoredCount,
    orphanFileRefs,
    // handlers
    openDrawingPreview,
    onDrawingPreviewClosed,
    closeAddDialog,
    closePreviewDialog,
    closeDrawingPreview,
    openAddDialog,
    onCustomerChange,
    onApplicantSelect,
    // 图纸：对话框里只**暂存**本地 File（`<el-upload :auto-upload="false">` 的
    // on-change），真正上传在建单成功之后由 `usePostSubmitUploads` 驱动。
    onDrawingFileChange,
    onAddConfirm,
    onDialogClosed,
    onRowPreview,
    onEditFromPreview,
    onRemoveRow,
    onClearAll,
    rowClassName,
    onSubmit,
    // ============ 2026-10-15：建单成功后的图纸上传阶段 ============
    drawingUploadingNow: uploads.running,
    drawingUploadFailures,
    drawingUploadFailedCount,
    partialSubmitFailedRows,
    retryDrawingUploads,
    dismissDrawingUploadResult,
  };
}
