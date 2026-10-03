// Tab 1「录入」composable。
//
// 2026-08-25 拆分：原 PartBatchNew.vue 第 1069-1603 行的「手工录入 + 待新增列表 + Dialog + 提交」
// 整段抽到本文件 + PartBatchManualTab.vue。Shell 通过 `v-bind="manual"` 把本 composable 返回
// 的对象铺给 tab 组件。
//
// 2026-09-18 接入 backend-rust `/api/v2/upload-sessions/*` 共享 STS session pool：
// - `requestDrawingUpload` 不再并发调 grantStsTmpKey（每文件 1-key），
//   改用 `useUploadSession.allocate(files)` 单次签整批 tmp_key；
// - onCommit 成功后调 `session.consumeFiles(submittedClientRefs)` 通知后端
//   延长 tmp 保留窗口；
// - mount 时 `useUploadSession.init('parts_new')` + draft 持久化（与 PDF
//   Tab 共享同一单例 session）。
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

import {
  computed,
  onBeforeUnmount,
  reactive,
  ref,
  watch,
  type ComputedRef,
  type Ref,
} from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useMutation } from '@tanstack/vue-query';
import { createApplicant } from '@/api/applicant';
import {
  batchCreateParts,
  type PartBatchCreatePayload,
  type PartBatchResult,
} from '@/api/parts';
import { grantStsTmpKeyFiles } from '@/api/files/sts';
import {
  usePartsNewDraft,
  type MergeResult,
  type SerializedStagedEntry,
} from '@/views/parts/new/composables/usePartsNewDraft';
import { stsToCosUploadGrant } from '@/views/parts/new/composables/_grantMappers';
import { computeSha256 } from '@/utils/fileHash';
import { parseFileExt } from '@/utils/fileExt';
import type { Applicant } from '@/types/applicant';
import type { FileBinding } from '@/types/part_file';
import type { Customer } from '@/api/customer';
// 2026-09-28 子任务 #5：useUploadSession 已删除，requestDrawingUpload 改走
// grantStsTmpKeyFiles 单批签名路径；CosUploader 契约 (File[]) => Promise<CosUploadGrant>
// 完全保留，仅 caller 实现从「共享 STS session」变为「批量新签 STS + item 拼 grant」。
import type {
  CosUploadedItem,
  CosUploaderItem,
  CosUploadGrant,
} from '@/components/CosUploader/useCosUploader';
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
  /** 2026-09-17 M4：图纸上传走 COS 直传，提交时挂 FileBinding 给后端 batch 事务 */
  drawingBinding: FileBinding | null;
  /**
   * 2026-09-18 接入 upload_session：图纸对应的 upload session client_ref。
   * 新图纸上传成功（onDrawingUploaded）时由 session.allocate 写入；commit 成功后
   * 用此字段调 session.consumeFiles。
   */
  drawingClientRef?: string;
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
  /** 2026-09-17 M4：图纸上传走 COS 直传，提交时挂 FileBinding 给后端 batch 事务 */
  drawingBinding: FileBinding | null;
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
  customerTree: ComputedRef<
    Array<{ id: string; name: string; children: Array<{ id: string; name: string }> }>
  >;
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
  drawingUploading: Ref<boolean>;
  hydrateRestoredCount: ComputedRef<number>;
  // 2026-09-28 删 useUploadSession：orphanFileRefs 从 SessionFile[] 改为 DraftSessionFile[]
  // （usePartsNewDraft.ts 内联松散结构类型，仅保 client_ref / kind / status / tmp_key /
  // file_size / original_filename / uploaded_at）。UI 只读 client_ref / original_filename
  // 等基础字段，类型收紧留待子任务 #5 重写 grantStsTmpKeyFiles 后回收。
  orphanFileRefs: ComputedRef<Array<{ client_ref: string; status?: string; kind?: string; tmp_key?: string; file_size?: number; original_filename?: string; uploaded_at?: string | null }>>;
  openDrawingPreview: (row: StagedEntry) => void;
  onDrawingPreviewClosed: () => void;
  closeAddDialog: () => void;
  closePreviewDialog: () => void;
  closeDrawingPreview: () => void;
  openAddDialog: () => void;
  onCustomerChange: (pickedId: unknown) => Promise<void>;
  onApplicantSelect: (item: Record<string, unknown>) => void;
  requestDrawingUpload: (files: File[]) => Promise<CosUploadGrant>;
  onDrawingUploaded: (item: CosUploadedItem) => void;
  onDrawingItemsChange: (items: CosUploaderItem[]) => void;
  onDrawingAllDone: () => void;
  onDrawingUploadError: (item: CosUploaderItem) => void;
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
  const customerTree = computed(() => {
    const roots = customers.value.filter((c) => c.parent_id === null);
    return roots.map((r) => ({
      id: r.id,
      name: r.name,
      children: customers.value
        .filter((c) => c.parent_id === r.id)
        .map((c) => ({ id: c.id, name: c.name })),
    }));
  });

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

  // ============ 图纸 COS 上传（2026-09-17 M4）============
  /**
   * 图纸上传中标记：onAddConfirm 据此守卫"上传未完成不允许提交"。
   *
   * 设计要点：保持 drawingUploading 在 module-scope ref（而非在每个 item 上）
   * 是为了让组件模板能直接 v-bind 一个 bool 给"加入列表"按钮 `:disabled`，
   * 不必遍历 items 数组。composable 内部维护模块级 Map<File, sha>，
   * 因为 upload 回调内我们直接拿到 raw File，用 Map<File, string> 按 File
   * identity 取 sha 最稳（无 getter/setter 序列化问题）。
   */
  const drawingUploading = ref(false);
  const drawingShaMap = new Map<File, string>();

  // ============================================================
// 2026-09-28 删 useUploadSession 模块级 Map 单例池：详见 plan §3.1。
// ============================================================
//
// 原块内容（2026-09-18 接入）：与 PDF Tab 共享 `parts_new` scope session；
// mount 时 mergeDraftWithSession 把 session.files 中 status='done' 的条目
// hydrate 到 staged（drawingBinding）；commit / discard 时清空。
//
// 本次删除：useUploadSession.ts + @/types/upload_session 已整文件下线，
// session 来源不再存在。draft 仍持有（持久化 staged 列表），但 hydrate 路径
// 无数据来源。本任务保留 hydrateResult / hydrateRestoredCount / orphanFileRefs
// 三件 API 暴露（给 UI 顶部 el-alert 与孤儿文件面板），值恒为「未恢复」/0/[]，
// 由子任务 #5 重写实现 grantStsTmpKeyFiles 后重新挂上 session 来源。
//
// 同步下线 onMounted 中的 await session.init('parts_new') 预申请逻辑；
// applyHydrate / deserializeStaged 整段删除（前者仅由 onMounted 调用，
// 后者内部依赖 session.files.value）。
// ============================================================
  const draft = usePartsNewDraft();

  // 暴露 hydrateResult / hydrateRestoredCount / orphanFileRefs 给 UI 渲染
  // 「已恢复 N 条」顶部 el-alert + 「孤儿文件待认领」面板（A3）。
  // 2026-09-28：值恒为空（session 来源下线），子任务 #5 重新挂真实 session 后会自然恢复。
  const hydrateResult = ref<MergeResult | null>(null);
  const hydrateRestoredCount = computed<number>(() => {
    const r = hydrateResult.value;
    if (!r) return 0;
    return r.manualStaged.filter((s) => s.drawing === 'done').length;
  });
  const orphanFileRefs = computed(() => hydrateResult.value?.orphanFileRefs ?? []);

  /** drawingClientRef → file 的反向索引：上传完成时按 File 取 client_ref。
   *  2026-09-28 注：useUploadSession 删除后 session.consumeFiles 不复存在，
   *  此 Map 暂保留字段语义（onDrawingUploaded 仍写入）；commit 路径的
   *  consumeFiles 调用在 submitStagedEntries 内 stub 为 no-op。
   *  子任务 #5 重写 requestDrawingUpload / commit 流水后此 Map 可能调整。 */
  const drawingClientRefByFile = new Map<File, string>();

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
    drawingBinding: null,
  });

  const form = reactive<FormState>(initialForm());

  /**
   * 保持 applicantId 与 applicantName 一致：
   * - 用户从下拉挑了某人：applicantName = item.name，applicantId = item.id（@select 设）
   * - 用户清空 / 继续打字改了名字：当前 applicantId 已不再指向同名 → 清掉
   *   → 让 onSubmit 走「自动新增」分支（PartBatchNew.vue:onSubmit 内 createApplicant 段）。
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

  // ============ 图纸 COS 上传（2026-09-17 M4 + 2026-09-18 upload_session → 2026-09-28 grantStsTmpKeyFiles）============
  //
  // CosUploader 走「前端直传 COS tmp 区 → 提交时挂 FileBinding → 后端 batch 事务内
  // head + copy tmp → 正式 CAS key + 插 t_part_file(READY)」两段式链路。
  //
  // 2026-09-18 原实现：每文件独立调 grantStsTmpKey（python 单端口 1-key）→ 2026-09-18
  // 升级为共享 STS session：单次 `session.allocate(files)` 拿整批 tmp_key + 续期定时器
  // → 2026-09-28 删 useUploadSession 后改回"批调用 grantStsTmpKeyFiles 单签名批"。
  //
  // 2026-09-28 子任务 #5：caller 改造为 grantStsTmpKeyFiles 数组入参。
  // - 入参：files[]（User 选中的图纸文件，按 ElUpload 接受顺序）；
  // - 调用：POST /api/v2/files/sts-tmp-keys body {scope: 'parts_new', files: [...]}
  //   单 HTTP + 单签名批；不再有 session / renew / 24h TTL；
  // - 出参：response.items[i].tmp_key 与 files[i] 一一对应（下标对齐），caller 用
  //   _grantMappers.stsToCosUploadGrant 拼成 CosUploadGrant 返回给 CosUploader。
  // - CosUploader 组件层契约 `(files: File[]) => Promise<CosUploadGrant>` 不变。
  //
  // 仍保留的字段：drawingShaMap（onDrawingUploaded 内按 File 身份取 sha）、
  // drawingClientRefByFile（commit 阶段反查 client_ref，2026-09-18 upload_session 适配
  // 时引入；2026-09-28 退化为"CosUploader tmp_key → File"反向索引，commit 时不再
  // 上报 session.consumeFiles）。

  /**
   * 2026-09-28 子任务 #5：caller 改为 grantStsTmpKeyFiles 单批签名。
   * 2026-09-29：caller 在 grant 之前必传 content_sha256（完整 64 hex）+ ext；
   * 本函数负责先算 SHA-256 + 解析 ext，再喂 grantStsTmpKeyFiles。
   *
   * 流程：
   * 1) 对每个 file 跑 computeSha256（流式 hash-wasm 8MB 分块，~30MB PDF 不阻塞 UI）；
   *    并用 parseFileExt 从文件名取 ext（小写字母数字 1-7）；
   * 2) 把 files 映射成 grantStsTmpKeyFiles 入参（purpose / filename / content_type /
   *    content_sha256 / ext）；
   * 3) 单 HTTP 拿回 N 个 STS 凭证 + tmp_key；
   * 4) 用 _grantMappers.stsToCosUploadGrant 拼成「共享 credentials / bucket /
   *    region + items[].tmp_key」格式返回给 CosUploader。
   *
   * 与 usePartBatchPdf.allocate 的差异：本函数只处理 'drawing' kind（手工录入 Tab
   * 只挂图纸），kind 写死；PDF Tab 还要按 entry.kind 派生 'drawing' / '3d_model'。
   *
   * 本调用点为「单次 getUploadGrant」路径：CosUploader 拿回 grant 后不会主动
   * refetch（useCosUploader 的 ensureFreshCredentials 仅在 initialGrant 未传时
   * 才兜底），因此 client_ref 用 crypto.randomUUID() 生成后无需跨 refetch 复用。
   *
   * 2026-09-29 升级：算出的 sha + ext 同步写入 drawingShaMap（File→sha），
   * 让 onDrawingUploaded 不依赖 CosUploader.computeHash 也能拿到 sha 写 binding。
   * 同时保持 CosUploader :compute-hash="false" 不变（避免大 PDF 算两次 hash）。
   */
  async function requestDrawingUpload(files: File[]): Promise<CosUploadGrant> {
    if (files.length === 0) {
      throw new Error('requestDrawingUpload: files 不能为空');
    }
    // 2026-09-29：先逐文件算 sha + 解析 ext，再喂 grantStsTmpKeyFiles。
    // 用 Promise.all 并行 hash。
    const shaExtPairs = await Promise.all(
      files.map(async (f) => {
        const sha = await computeSha256(f);
        const ext = parseFileExt(f.name);
        return { sha, ext };
      }),
    );
    // 缓存 sha 到 drawingShaMap（onDrawingUploaded 内按 File 身份取 sha 写 binding）
    files.forEach((f, idx) => {
      const pair = shaExtPairs[idx]!;
      drawingShaMap.set(f, pair.sha);
    });
    const grants = await grantStsTmpKeyFiles({
      scope: 'parts_new',
      files: files.map((f, idx) => {
        const pair = shaExtPairs[idx]!;
        return {
          purpose: 'drawing',
          // 与现有 StsTmpKeysRequest 字段一致；python 端 schema 接受此 snake_case。
          filename: f.name,
          content_type: f.type || 'application/octet-stream',
          // 2026-09-29：必传完整 64 hex SHA-256（rust schema 收紧 required）。
          content_sha256: pair.sha,
          // 2026-09-29：必传 ext（utils/fileExt.parseFileExt 解析）。
          ext: pair.ext,
        };
      }),
    });
    if (grants.items.length !== files.length) {
      throw new Error(
        `grantStsTmpKeyFiles 返回项数（${grants.items.length}）≠ files 长度（${files.length}）`,
      );
    }
    // client_ref 用 crypto.randomUUID() 生成；本调用点不跨 refetch 复用。
    const clientRefs = files.map(() => crypto.randomUUID());
    // 共享 STS 凭证：python 端 batch 签发同一 scope 共享一组 credentials / bucket / region
    // （响应 items[0..N-1] 应一致；任取 items[0] 作为批级元数据载体）。
    const head = grants.items[0]!;
    return stsToCosUploadGrant(head, clientRefs);
  }

  /**
   * 单文件上传完成后回调：写 binding + 新建 blob URL 给 PdfViewer 预览。
   *
   * sha 丢失说明 drawingShaMap 被错误清理（不可能发生在组件正常生命周期），
   * 抛 ElMessage.error 让 caller 重传。
   */
  function onDrawingUploaded(item: CosUploadedItem): void {
    const sha = drawingShaMap.get(item.file) ?? '';
    if (!sha) {
      ElMessage.error('图纸 hash 记录丢失，请重新上传');
      return;
    }
    // 替换旧文件 → 撤销旧 blob URL 防止内存泄漏
    if (form.drawingUrl) {
      try {
        URL.revokeObjectURL(form.drawingUrl);
      } catch {
        /* ignore */
      }
    }
    form.drawingBinding = {
      tmp_key: item.tmp_key,
      content_sha256: sha,
      original_filename: item.file.name,
      file_size: String(item.file.size),
      content_type: item.file.type || 'application/pdf',
    };
    form.drawingFile = item.file;
    form.drawingName = item.file.name;
    form.drawingUrl = URL.createObjectURL(item.file);

    // 2026-09-18 接入 upload_session：
    // 1) 记录 client_ref（CosUploader 通过 item.client_ref 传回），便于后续
    //    onAddConfirm 写入 staged.drawingClientRef；
    // 2) 通知 session 该 file 已 done（后端 SessionFile.status=done，tmp_key +
    //    sha 由 caller 提供，etag 由 COS 返回）。
    //
    // 2026-09-28 删 useUploadSession：session.markComplete 不复存在，本 best-effort
    // 调用整体删除（status=done 已本地落地，不影响 batch commit）。
    drawingClientRefByFile.set(item.file, item.client_ref);
  }

  /**
   * 清空 form 上图纸相关字段 + revoke blob URL。
   * 复用于：列表清空 + 替换中间态 + 关闭对话框。
   */
  function clearDrawingForm(): void {
    if (form.drawingUrl) {
      try {
        URL.revokeObjectURL(form.drawingUrl);
      } catch {
        /* ignore */
      }
    }
    form.drawingBinding = null;
    form.drawingFile = null;
    form.drawingName = null;
    form.drawingUrl = null;
  }

  /**
   * CosUploader @change：维护 drawingUploading 状态 + 处理空列表 / 替换中间态。
   *
   * 不变量：「form drawing 字段反映 last successful upload」——
   * - 用户移除所有项 → 清空 form 图纸字段；
   * - 用户换图但最新一项仍在 hashing/uploading/pending → 保留旧 binding（直到新项
   *   uploaded 事件触发 onDrawingUploaded 覆盖）；同时清 preview（保持"上传中时不展示旧预览"
   *   的 UX）。这里我们选择更保守的策略：只要 latest item 不在 done，就清 binding + 预览，
   *   上传成功后由 onDrawingUploaded 重新写回。
   */
  function onDrawingItemsChange(items: CosUploaderItem[]): void {
    drawingUploading.value = items.some(
      (it) => it.status === 'pending' || it.status === 'hashing' || it.status === 'uploading',
    );
    if (items.length === 0) {
      clearDrawingForm();
      return;
    }
    const newest = items[items.length - 1]!;
    if (newest.status !== 'done' && (form.drawingBinding || form.drawingUrl)) {
      clearDrawingForm();
    }
  }

  /** @all-done：全部进入终态（done / error），关闭 uploading 标记。 */
  function onDrawingAllDone(): void {
    drawingUploading.value = false;
  }

  /** @error：单文件上传或 confirm 失败，关闭 uploading 标记 + 提示用户。 */
  function onDrawingUploadError(item: CosUploaderItem): void {
    drawingUploading.value = false;
    ElMessage.error(`图纸上传失败：${item.error ?? '未知错误'}`);
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
    // 2026-09-17 M4：图纸上传中守卫。M3-C 后端要求 binding 与图片必须同时提交；
    // 上传未完成时拒绝 addConfirm，避免 staged 条目带 stale binding。
    if (drawingUploading.value) {
      ElMessage.error('图纸上传中，请稍候');
      return;
    }

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
        drawingBinding: form.drawingBinding,
        // 2026-09-18：从 drawingClientRefByFile 反查当前图纸对应的 client_ref；
        // 编辑模式下也允许 client_ref 跟随新 file 更新。
        drawingClientRef: form.drawingFile
          ? drawingClientRefByFile.get(form.drawingFile)
          : undefined,
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
        form.drawingBinding = null;
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
    // 2026-09-17 M4：清模块级上传状态。下次打开 dialog 不会继承旧 File 的 sha 记录。
    drawingShaMap.clear();
    drawingUploading.value = false;
    // 2026-09-18 C1：清 drawingClientRefByFile Map（防止 File 引用堆积 → 内存泄漏）。
    drawingClientRefByFile.clear();
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
      drawingBinding: target.drawingBinding,
    });
    formErrors.value = {};
    addDialogVisible.value = true;
    // 标记该 entry 的 url 已被 dialog 接管；切到 list 时不再 revoke 它
    // 简化处理：编辑模式下，旧 url 仍属于 entry；编辑确认时 onAddConfirm 会先 revokeEntryUrls(staged[idx])，避免泄漏
    target.drawingUrl = null;
    target.drawingFile = null;
    target.drawingName = null;
    target.drawingBinding = null;
    // 同步刷新 rootCustomerId 与申请人候选（让下拉带回原选项）
    if (target.customerId) {
      void applicantSearch.loadForCustomer(target.customerId);
    }
  }

  function onRemoveRow(uid: string): void {
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
   *   1) 遍历 staged，为无 applicantId 的条目处理申请人 dedupe（缓存命中复用 id，
   *      未命中 → createApplicant 自动新增）；
   *   2) 构造 payload 调 batchCreateParts（按 customer_id 分组，跨客户混合语义由
   *      api 层负责）；
   *   3) 返回 PartBatchResult 交给 onSuccess 分流（部分失败 / 全成功）。
   *
   * 此函数不负责：
   *   - 清 staged / draft / session consumeFiles（放 onSuccess）；
   *   - 跳转 / ElMessage（放 onSuccess / onError）；
   *   - 入队前 confirm 确认（放 onSubmit handler）。
   */
  async function submitStagedEntries(): Promise<PartBatchResult> {
    // 1) 先为每条 entry 处理 applicant_id：
    //    - 已有 applicantId（用户从下拉挑的）→ 跳过；
    //    - 在缓存中能按 name 命中 → 复用其 id（2026-09-16 修复，避免
    //      对已存在的 applicant 重复 POST → 409 Conflict）；
    //    - 缓存未命中（且缓存对应 L1 root 与本条 L1 一致时才查，避免
    //      跨 L1 root 误判）→ 调 createApplicant 自动新增。
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
      const created = await createApplicant({
        name: trimmed,
        customer_id: String(rootId),
      });
      s.applicantId = created.id;
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
      // 2026-09-17 M4：图纸 FileBinding。后端 PartBatchCreatePayload.drawing_file
      // 必传 FileBindingIn（可选？null 触发后端跳过）；未上传图纸时给 undefined
      // 让 v2 后端 schema 跳过该字段。
      drawing_file: s.drawingBinding ?? undefined,
    }));
    return batchCreateParts(items);
  }

  const submitMutation = useMutation<PartBatchResult, Error, undefined>({
    mutationKey: ['parts', 'manual', 'batch-create'],
    mutationFn: () => submitStagedEntries(),
    onSuccess: async (res) => {
      if (res.failed.length > 0) {
        const sample = res.failed
          .slice(0, 5)
          .map((f) => `第 ${f.index + 1} 行：${f.message}`)
          .join('\n');
        const more = res.failed.length > 5 ? `\n...还有 ${res.failed.length - 5} 行失败` : '';
        await ElMessageBox.alert(
          `服务端拒绝了 ${res.failed.length} 行：\n${sample}${more}`,
          '部分行未通过',
          { type: 'warning' },
        ).catch(() => {
          /* 用户点叉忽略 */
        });
        return;
      }

      // 2026-09-18 接入 upload_session：通知后端「本批 tmp 文件已被消费」。
      // consume 仅延长 tmp 保留窗口（便于 batch_create_parts 事务内 head + copy
      // tmp → 正式 CAS key 完成）；tmp 物理删除由 batch_create_parts 端点 spawn
      // delete 兜底（详见 backend-rust `src/handlers/parts/batch.rs`），前端不感知。
      // submittedClientRefs 仅含本批实际走 COS 上传的新图纸（不含编辑模式
      // 复用旧 FileBinding 的条目——那些走原 binding 路径，不经过 session）。
      //
      // 2026-09-28 删 useUploadSession：session.consumeFiles 不复存在。子任务 #5
      // 重写 grantStsTmpKeyFiles 路径后会重新挂上 commit 完成通知（如果你不再需要，
      // 可删除本块整段）。当前 stub：暂保留 submittedClientRefs 收集 + skip。
      void staged.value
        .map((s) => s.drawingClientRef)
        .filter((r): r is string => !!r);

      // 释放所有 blob URL
      staged.value.forEach(revokeEntryUrls);
      staged.value = [];
      // 2026-09-18：提交成功后清空 draft（保留 session 单例，下一批次继续复用）
      draft.saver.cancel();
      draft.clear();
      ElMessage.success(`成功新建 ${res.created.length} 条零件`);
      // 跳到零件一览并筛选「待生产」，便于核对刚添加的零件
      router.push({ path: '/parts', query: { status: 'PENDING' } });
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
            file_links: [],
          },
          manual_tab: serializeManualTab(),
        };
        draft.saver.schedule(basePayload);
      },
    );
  }

  /** staged 数组 → SerializedStagedEntry[]（不含 File / blob URL，只存 binding）。 */
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
        ...(s.drawingBinding
          ? {
              drawingTmpKey: s.drawingBinding.tmp_key,
              drawingSha256: s.drawingBinding.content_sha256,
              drawingFilename: s.drawingBinding.original_filename,
              drawingFileSize: s.drawingBinding.file_size,
              drawingContentType: s.drawingBinding.content_type,
            }
          : {}),
        ...(s.drawingClientRef ? { drawingClientRef: s.drawingClientRef } : {}),
      })),
    };
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
    // 2026-09-17 M4：图纸上传状态（CosUploader 守卫 + 子组件 disabled 绑定）
    drawingUploading,
    // 2026-09-18 A3：hydrate 结果给 UI 渲染顶部「已恢复 N 条」el-alert +
    // 孤儿文件待认领面板（合并 dry-run 由 usePartsNewDraft.mergeDraftWithSession 完成）
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
    // 2026-09-17 M4：图纸上传回调（替代 beforeDrawingUpload + onDrawingChange +
    // onDrawingRemoveUpload + onDrawingRemove 四件套）。CosUploader 通过这五
    // 个回调驱动 form 图纸状态机。
    requestDrawingUpload,
    onDrawingUploaded,
    onDrawingItemsChange,
    onDrawingAllDone,
    onDrawingUploadError,
    onAddConfirm,
    onDialogClosed,
    onRowPreview,
    onEditFromPreview,
    onRemoveRow,
    onClearAll,
    rowClassName,
    onSubmit,
  };
}
