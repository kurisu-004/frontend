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

import { computed, onBeforeUnmount, onMounted, reactive, ref, watch, type ComputedRef, type Ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus';
import { createApplicant } from '@/api/applicant';
import { batchCreateParts, type PartBatchCreatePayload } from '@/api/parts';
import { getUploadSession } from '@/composables/useUploadSession';
import {
  usePartsNewDraft,
  mergeDraftWithSession,
  type MergeResult,
  type SerializedStagedEntry,
} from '@/composables/usePartsNewDraft';
import type { Applicant } from '@/types/applicant';
import type { FileBinding } from '@/types/part_file';
import type { Customer } from '@/api/customer';
import { computeSha256 } from '@/utils/fileHash';
import type {
  CosUploadedItem,
  CosUploaderItem,
  CosUploadSession,
} from '@/composables/useCosUploader';
import { useConfirm } from '@/composables/useConfirm';
import { useDialogSize } from '@/composables/useDialogSize';
import {
  findCustomerLabel,
  makeUid,
  resolveRootCustomerId,
  revokeEntryUrls,
  todayIso,
} from './usePartBatchShared';

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
  customerTree: ComputedRef<Array<{ id: string; name: string; children: Array<{ id: string; name: string }> }>>;
  applicantCandidates: Ref<Applicant[]>;
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
  submitting: Ref<boolean>;
  form: FormState;
  rules: FormRules;
  drawingUploading: Ref<boolean>;
  hydrateRestoredCount: ComputedRef<number>;
  orphanFileRefs: ComputedRef<unknown[]>;
  openDrawingPreview: (row: StagedEntry) => void;
  onDrawingPreviewClosed: () => void;
  closeAddDialog: () => void;
  closePreviewDialog: () => void;
  closeDrawingPreview: () => void;
  openAddDialog: () => void;
  onCustomerChange: (pickedId: unknown) => Promise<void>;
  onApplicantSelect: (item: Record<string, unknown>) => void;
  requestDrawingUpload: (files: File[]) => Promise<CosUploadSession>;
  onDrawingUploaded: (item: CosUploadedItem) => void;
  onDrawingItemsChange: (items: CosUploaderItem[]) => void;
  onDrawingAllDone: () => void;
  onDrawingUploadError: (item: CosUploaderItem) => void;
  onAddConfirm: (formEl?: FormInstance) => Promise<void>;
  onDialogClosed: (formEl?: FormInstance) => void;
  onRowPreview: (row: StagedEntry) => void;
  onEditFromPreview: () => void;
  onRemoveRow: (uid: string) => void;
  onClearAll: () => Promise<void>;
  rowClassName: (ctx: { row: unknown }) => string;
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
  // 注意：el-form 的 ref 必须在子组件里声明为本地 ref（ref="formRef" 写在子组件
  // 模板里时，Vue 会把 el-form 实例写到那个 ref 上 —— 而父组件传下来的 formRef 是
  // readonly prop，写入会静默失败）。子组件把 formRefLocal.value 通过 onAddConfirm
  // / onDialogClosed 的形参传回本 composable。
  const addDialogVisible = ref(false);
  const dialogSubmitting = ref(false);
  const editingUid = ref<string | null>(null);

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
  // 2026-09-18 upload-session 接入：单例 session + draft 持久化
  // ============================================================
  //
  // 与 PDF Tab（usePartBatchPdf）共享同一 `parts_new` scope session —— useUploadSession
  // 用模块级 Map 实现 scope → state 单例，两 Tab 多次调用 getUploadSession('parts_new')
  // 拿到同一 state。Manual Tab 主要场景是单文件选图，每次 allocate 仍走单端口，
  // 但凭证由共享 session pool 提供，避开每文件一次 grantStsTmpKey 调用。
  //
  // draft 持久化：手工录入 Tab 待新增列表（staged）的可序列化字段在 mount 时
  // 恢复（session.files 命中 done → 行恢复 FileBinding），变更后 debounce 写
  // localStorage，commit / discard 时清空。
  const session = getUploadSession('parts_new');
  const draft = usePartsNewDraft();

  // 2026-09-18 A1：mount 时 hydrate staged entries（draft + session.files 合并）。
  // 暴露 hydrateResult / hydrateRestoredCount / orphanFileRefs 给 UI 渲染
  // 「已恢复 N 条」顶部 el-alert + 「孤儿文件待认领」面板（A3）。
  const hydrateResult = ref<MergeResult | null>(null);
  const hydrateRestoredCount = computed<number>(() => {
    const r = hydrateResult.value;
    if (!r) return 0;
    return r.manualStaged.filter((s) => s.drawing === 'done').length;
  });
  const orphanFileRefs = computed(() => hydrateResult.value?.orphanFileRefs ?? []);

  onMounted(async () => {
    try {
      await session.init('parts_new');
      // 1) hydrate staged from draft + session
      const loaded = draft.load();
      const merged = mergeDraftWithSession(loaded, session.session.value);
      hydrateResult.value = merged;
      applyHydrate(merged);
    } catch (e) {
      console.warn('[usePartBatchManual] session.init failed', e);
    }
  });

  /**
   * 把 mergeDraftWithSession 结果写到 staged。
   * 仅 restored=true 时执行。
   *
   * 写入策略：
   * - 序列化字段全部还原（图号 / 名称 / 申请人 / 客户 / 日期等）；
   * - drawing='done' → entry.drawingClientRef = client_ref，entry.drawingBinding
   *   从 session.files 反查 tmp_key 重建（这样 staged 列表的「已上传」tag 与
   *   commit 时的 FileBinding 都到位）；
   * - drawing='need_reselect' / undefined → 不写 drawingClientRef / drawingBinding，
   *   UI 渲染「需重传」tag。
   */
  function applyHydrate(merged: MergeResult): void {
    if (!merged.restored) return;
    staged.value = merged.manualStaged.map((m) => deserializeStaged(m.entry, m.drawing));
  }

  /** 把 SerializedStagedEntry + drawing 状态 → StagedEntry（不含 File）。 */
  function deserializeStaged(
    entry: SerializedStagedEntry,
    drawing: 'done' | 'need_reselect' | undefined,
  ): StagedEntry {
    // 仅在 drawing='done' 时重建 drawingBinding（tmp_key + sha 从 session.files 反查）
    let drawingBinding: FileBinding | null = null;
    if (drawing === 'done' && entry.drawingClientRef) {
      const sessFile = session.files.value.find((f) => f.client_ref === entry.drawingClientRef);
      if (sessFile && entry.drawingTmpKey && entry.drawingSha256) {
        drawingBinding = {
          tmp_key: entry.drawingTmpKey,
          content_sha256: entry.drawingSha256,
          original_filename: entry.drawingFilename ?? sessFile.original_filename,
          file_size: entry.drawingFileSize ?? String(sessFile.file_size),
          content_type: entry.drawingContentType ?? sessFile.content_type,
        };
      }
    }
    return {
      uid: entry.uid,
      drawingNo: entry.drawingNo,
      name: entry.name,
      applicantName: entry.applicantName,
      applicantId: entry.applicantId,
      customerId: entry.customerId,
      customerLabel: entry.customerLabel,
      quantity: entry.quantity,
      isUrgent: entry.isUrgent,
      requestDate: entry.requestDate,
      plannedDeliveryDate: entry.plannedDeliveryDate,
      orderNo: entry.orderNo,
      systemDeliveryDate: entry.systemDeliveryDate,
      note: entry.note,
      // 文件相关：hydrate 时不持有 File（File 不存 localStorage）；File /
      // blob URL 仅在用户重新打开 dialog 重新选择时才赋值
      drawingFile: null,
      drawingName: entry.drawingFilename ?? null,
      drawingUrl: null,
      drawingBinding,
      drawingClientRef: drawing === 'done' ? entry.drawingClientRef : undefined,
    };
  }

  /** drawingClientRef → file 的反向索引：上传完成时按 File 取 client_ref。
   *  提交成功后按 staged[i].drawingClientRef 调 session.consumeFiles。 */
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

  const rules: FormRules = {
    drawingNo: [{ required: true, message: '请输入图号', trigger: 'blur' }],
    name: [{ required: true, message: '请输入名称', trigger: 'blur' }],
    customerId: [
      {
        required: true,
        validator: (_rule, value, callback) => {
          // cascader emitPath:false 返回选中节点的 id，来自 Customer.id（string）
          if (value === null || value === undefined || value === '') {
            callback(new Error('请选择客户'));
            return;
          }
          const c = customers.value.find((x) => String(x.id) === String(value));
          if (!c) {
            callback(new Error('客户不存在'));
            return;
          }
          callback();
        },
        trigger: 'change',
      },
    ],
    quantity: [{ required: true, message: '请输入数量', trigger: 'blur' }],
    requestDate: [{ required: true, message: '请选择请购日期', trigger: 'change' }],
    plannedDeliveryDate: [{ required: true, message: '请选择计划交期', trigger: 'change' }],
  };

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
    await applicantSearch.loadForCustomer(idStr || null);
  }

  function onApplicantSelect(item: Record<string, unknown>): void {
    form.applicantId = String(item.id);
    // form.applicantName 由 v-model 自动同步为 item.name，无需手动设
  }

  // ============ 图纸 COS 上传（2026-09-17 M4 + 2026-09-18 upload_session）============
  //
  // CosUploader 走「前端直传 COS tmp 区 → 提交时挂 FileBinding → 后端 batch 事务内
  // head + copy tmp → 正式 CAS key + 插 t_part_file(READY)」两段式链路。
  //
  // 2026-09-18 改造：原 grantStsTmpKey（每文件 1-key）替换为 upload session 共享
  // STS：单次 `session.allocate(files)` 拿整批 tmp_key，凭证过期由 useUploadSession
  // 定时器自动续期。两 Tab（Manual / PDF）共享同一 `parts_new` scope session。
  //
  // sha 仍由本 composable 算（不开组件 computeHash 避免大 PDF 算两次），存模块级
  // Map<File, string>，onDrawingUploaded 时按 File 对象 identity 取用。
  //
  // 用户取消对话框 / 移除文件会留孤儿 tmp 对象 → session 会话结束后由后端
  // discard 兜底回收（详见 useUploadSession.discard），前端不显式 cancel。

  /**
   * 校验 + 算 sha + 调 session.allocate，拼出 CosUploadSession 返回给组件。
   *
   * 2026-09-18 改造：原本每文件并发调 grantStsTmpKey；现在改用共享 session pool
   * 一次签整批 tmp_key。新流程：
   * 1) ensure session.init('parts_new') —— mount 时已 init 过；
   * 2) session.allocate([{client_ref, kind, original_filename, file_size,
   *    content_type, content_sha256}]) 拿 N 个 tmp_key；
   * 3) 把 client_ref + tmp_key + sha 映射回 caller 期待 CosUploadSession.items
   *    形态（同时塞 sha 给组件做 confirm 用）。
   *
   * client_ref 由 caller（这里）生成（crypto.randomUUID），便于后续
   * session.markComplete / removeFiles / consumeFiles 反查。
   */
  async function requestDrawingUpload(files: File[]): Promise<CosUploadSession> {
    // 校验 + 算 sha（intents 入参必填；不开组件 computeHash 避免算两次）
    for (const f of files) {
      // accept=".pdf" 拦截 picker，但拖拽可以绕过，组件层兜底再校验一次
      if (!f.name.toLowerCase().endsWith('.pdf')) {
        throw new Error('图纸必须是 .pdf 后缀');
      }
    }
    const shas = await Promise.all(files.map(async (f) => [f, await computeSha256(f)] as const));
    for (const [f, sha] of shas) drawingShaMap.set(f, sha);

    // ensure session init（mount 时已 init；兜底覆盖边缘情况）
    if (!session.isReady.value) {
      await session.init('parts_new');
    }

    // 一次性 allocate：拿整批 tmp_key + 共享 session 顶层 credentials
    const clientRefs = files.map(() => crypto.randomUUID());
    const allocated = await session.allocate(
      files.map((f, i) => {
        const sha = shas.find(([it]) => it === f)![1];
        return {
          client_ref: clientRefs[i]!,
          kind: 'drawing',
          original_filename: f.name,
          file_size: f.size,
          content_type: f.type || 'application/pdf',
          content_sha256: sha,
        };
      }),
    );

    // session 顶层 credentials / bucket / region 共享给所有 item
    const credentials = session.credentials.value;
    const bucket = session.bucket.value;
    const region = session.region.value;
    if (!credentials || !bucket || !region) {
      throw new Error('upload session 凭证或桶信息缺失');
    }

    // CosUploader 组件 CosUploadSession.items 需要 client_ref + tmp_key 一一对应；
    // sha 暂存进 caller 闭包，onDrawingUploaded 时按 File 身份取用。
    return {
      credentials,
      bucket,
      region,
      items: allocated.map((a) => ({
        client_ref: a.client_ref,
        tmp_key: a.tmp_key,
      })),
    };
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
    //    onAddConfirm 写入 staged.drawingClientRef、commit 成功后 consumeFiles；
    // 2) 通知 session 该 file 已 done（后端 SessionFile.status=done，tmp_key +
    //    sha 由 caller 提供，etag 由 COS 返回）。
    drawingClientRefByFile.set(item.file, item.client_ref);
    void session.markComplete(item.client_ref, item.etag).catch(() => {
      /* best-effort；status=done 已本地落地，session.files 同步失败不影响 commit */
    });
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

  async function onAddConfirm(formEl?: FormInstance): Promise<void> {
    if (!formEl) return;
    // 2026-09-17 M4：图纸上传中守卫。M3-C 后端要求 binding 与图片必须同时提交；
    // 上传未完成时拒绝 addConfirm，避免 staged 条目带 stale binding。
    if (drawingUploading.value) {
      ElMessage.error('图纸上传中，请稍候');
      return;
    }
    try {
      await formEl.validate();
    } catch {
      return;
    }
    // cascader value → customerId（Customer.id 为 string，emitPath:false 返回 string）
    const rawId = form.customerId;
    if (rawId === null || rawId === '') {
      ElMessage.error('请选择客户');
      return;
    }
    // customerId 是雪花 ID 字符串（CLAUDE.md §3），不再转 Number。
    // 校验非空：cascader emitPath:false 返 string id，空串说明未选。
    if (!rawId) {
      ElMessage.error('请选择客户');
      return;
    }
    // 申请人必填：要么选了已有 applicantId，要么输了字符串（自动新增）
    const applicantName = form.applicantName.trim();
    if (!applicantName) {
      ElMessage.error('请选择或输入申请人');
      return;
    }
    dialogSubmitting.value = true;
    try {
      const entry: StagedEntry = {
        uid: editingUid.value ?? makeUid(),
        drawingNo: form.drawingNo.trim(),
        name: form.name.trim(),
        applicantName,
        applicantId: form.applicantId,
        customerId: rawId,
        customerLabel: findCustomerLabel(customers, rawId),
        quantity: form.quantity,
        isUrgent: form.isUrgent,
        requestDate: form.requestDate,
        plannedDeliveryDate: form.plannedDeliveryDate,
        orderNo: form.orderNo || null,
        systemDeliveryDate: form.systemDeliveryDate || null,
        note: form.note || null,
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

  function onDialogClosed(formEl?: FormInstance): void {
    // 仅在「取消」关闭时表单上仍残留 url 才需要回收；onAddConfirm 成功后已把 url 转交
    if (form.drawingUrl) {
      try {
        URL.revokeObjectURL(form.drawingUrl);
      } catch {
        /* ignore */
      }
    }
    formEl?.clearValidate();
    Object.assign(form, initialForm());
    editingUid.value = null;
    // 2026-09-17 M4：清模块级上传状态。下次打开 dialog 不会继承旧 File 的 sha 记录。
    drawingShaMap.clear();
    drawingUploading.value = false;
    // 2026-09-18 C1：清 drawingClientRefByFile Map（防止 File 引用堆积 → 内存泄漏）。
    // Map 内每个 File 对象 identity 是当前这次 dialog 选出来的；关闭 dialog 后
    // 下次打开是新一次 uploader 流程，File 已被 GC 链断开，Map 持有它们等于
    // 永久泄漏。Map.clear() 让所有引用断开，下一轮 onDrawingUploaded 重新填充。
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
  const submitting = ref(false);

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
    submitting.value = true;
    try {
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
      // submittedClientRefs 仅含本批实际走 COS 上传的新图纸（不含编辑模式
      // 复用旧 FileBinding 的条目——那些走原 binding 路径，不经过 session）。
      const submittedClientRefs = staged.value
        .map((s) => s.drawingClientRef)
        .filter((r): r is string => !!r);
      if (submittedClientRefs.length > 0) {
        await session.consumeFiles(submittedClientRefs).catch(() => {
          /* best-effort；失败不影响提交结果 */
        });
      }

      // 释放所有 blob URL
      staged.value.forEach(revokeEntryUrls);
      staged.value = [];
      // 2026-09-18：提交成功后清空 draft（保留 session 单例，下一批次继续复用）
      draft.saver.cancel();
      draft.clear();
      ElMessage.success(`成功新建 ${res.created.length} 条零件`);
      // 跳到零件一览并筛选「待生产」，便于核对刚添加的零件
      router.push({ path: '/parts', query: { status: 'PENDING' } });
    } catch (e) {
      ElMessage.error((e as Error).message ?? '提交失败');
    } finally {
      submitting.value = false;
    }
  }

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
    applicantCandidates: applicantSearch.applicants,
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
    form,
    rules,
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
