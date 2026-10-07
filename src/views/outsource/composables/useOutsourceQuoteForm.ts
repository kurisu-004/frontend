// src/views/outsource/composables/useOutsourceQuoteForm.ts
//
// 2026-10-09：新建 + 审批 + 删除 六条写路径全部改 `useMutation` + 失效（替掉裸
// `await api()` + `opts.refresh()` 的手工链路）。同时把新建表单的校验从 el-form 的
// `FormRules` / `validate()` 换成 Zod（`views/outsource/OutsourceQuoteFormSchema.ts`）。
//
// 保留的原有行为（不要在改造中丢掉）：
//   - 工序 → 外协公司级联（`watch(createForm.process_id)` + `listCompaniesByProcess`），
//     以及 `onCreatePartChange` 的两步清空（`process_id` + `outsource_company_id`）——
//     watch 只在值**变化**时跑回调，换零件时 `process_id` 往往已经是 `''`，`'' → ''`
//     不构成变化 ⇒ 没有这一步上一条报价选过的公司会跨零件残留；
//   - 新建报价的零件候选源是「有活跃 PENDING 批次的在制件」，VO 不带工序 ⇒ 工序一律手选。
//
// 契约对齐（2026-10-09，两处**必填 version**）：
//   `POST /{id}/submit` 与 `POST /{id}/soft-delete` 的入参新增必填 `version`（此前
//   无 body，service 自读 version 守乐观锁、形同虚设）。`POST /{id}/update` 与
//   `GET /{id}` 已随本轮硬切从后端删除，本文件对它们的调用一并删除（前端零消费）。

import { reactive, ref, watch, type Ref } from 'vue';
import { ElMessage } from 'element-plus';
import { useMutation, useQueryClient } from '@tanstack/vue-query';
import {
  approveOutsourceQuote,
  createOutsourceQuote,
  listCompaniesByProcess,
  rejectOutsourceQuote,
  softDeleteOutsourceQuote,
  submitOutsourceQuote,
} from '@/api/outsource';
import { useConfirm } from '@/composables/useConfirm';
import {
  OUTSOURCE_QUOTE_STATUS_LABEL,
  type OutsourceQuote,
  type OutsourceQuoteStatus,
} from '@/types/outsource';
import {
  outsourceQuoteFormSchema,
  toFieldErrors,
  type OutsourceQuoteFieldErrors,
  type OutsourceQuoteFormInput,
} from '../OutsourceQuoteFormSchema';
import { invalidateOutsourceQuotesAll } from './useOutsourceQuotesQuery';

/** 新建报价表单（reactive；形状与 `OutsourceQuoteFormInput` 一致）。 */
export type CreateQuoteForm = OutsourceQuoteFormInput;

/** 2026-09-21 显式返回类型。 */
export interface UseOutsourceQuoteFormReturn {
  showCreate: Ref<boolean>;
  createForm: CreateQuoteForm;
  /** Zod 聚合出的字段错误（`Record<字段, 提示>`）；空对象 = 无错误。 */
  createFieldErrors: Ref<OutsourceQuoteFieldErrors>;
  openCreate: () => void;
  onCreate: () => Promise<void>;
  onCreatePartChange: (partId: string) => void;
  companies: Ref<{ id: string; name: string }[]>;
  companiesLoading: Ref<boolean>;
  loadCompaniesByProcess: (processId: string) => Promise<void>;
  onSubmit: (q: OutsourceQuote) => Promise<void>;
  showApprove: Ref<boolean>;
  showReject: Ref<boolean>;
  reviewNote: Ref<string>;
  activeQuote: Ref<OutsourceQuote | null>;
  openApprove: (q: OutsourceQuote) => void;
  openReject: (q: OutsourceQuote) => void;
  onApprove: () => Promise<void>;
  onReject: () => Promise<void>;
  onDelete: (q: OutsourceQuote) => Promise<void>;
}

/** 报价表单 + 六条写路径的 mutation。
 *
 *  **无入参**：写成功后的刷新只走 `invalidateOutsourceQuotesAll`（前缀失效，内部已经
 *  refetch 了活跃 query），不再挂 caller 的 `refresh` 回调 —— 两者串起来会让每次写成功
 *  打两次列表请求。 */
export function useOutsourceQuoteForm(): UseOutsourceQuoteFormReturn {
  const { dangerous: confirmDangerous } = useConfirm();
  // 必须在组件 setup 内调用本 composable（useQueryClient 依赖注入上下文）。
  const qc = useQueryClient();

  // ============ 新建报价 dialog ============
  const showCreate = ref(false);
  const createForm = reactive<CreateQuoteForm>({
    part_id: '',
    outsource_company_id: '',
    process_id: '',
    price: '',
    note: '',
  });
  const createFieldErrors = ref<OutsourceQuoteFieldErrors>({});

  function openCreate(): void {
    Object.assign(createForm, { part_id: '', outsource_company_id: '', process_id: '', price: '', note: '' });
    createFieldErrors.value = {};
    showCreate.value = true;
  }

  // ============ 工序 → 外协公司级联（PR-H 2026-07-28）============
  const companies = ref<{ id: string; name: string }[]>([]);
  const companiesLoading = ref(false);

  async function loadCompaniesByProcess(processId: string): Promise<void> {
    if (!processId) {
      companies.value = [];
      return;
    }
    companiesLoading.value = true;
    try {
      // 2026-10-09：端点出参收成窄 VO `{id, name}[]`（裸数组），不再有 is_active ——
      // service 层已滤掉停用公司，能出现在这里的恒为启用。
      companies.value = await listCompaniesByProcess(processId);
    } catch (e) {
      companies.value = [];
      ElMessage.error((e as Error).message ?? '外协公司加载失败');
    } finally {
      companiesLoading.value = false;
    }
  }

  // 工序变化：级联刷新公司列表，并清掉之前已选的公司，避免脏数据。
  // watch 必须在 createForm 声明之后注册，否则 watch() 同步求值 source 会撞 TDZ。
  watch(
    () => createForm.process_id,
    (newPid) => {
      createForm.outsource_company_id = '';
      void loadCompaniesByProcess(newPid);
    },
  );

  /** 选择零件后重置工序与公司，让操作员在独立的工序下拉里重新选。
   *
   *  入参保留是为对齐 dialog 的 `partChange` 事件载荷（当前无需读取）。 */
  function onCreatePartChange(_partId: string): void {
    createForm.process_id = '';
    // 2026-10-03 登记：与 `createForm.process_id` 的 watch 看似重复，**不可删** ——
    // watch 只在值**发生变化**时才跑回调，换零件时 `process_id` 往往已经是 `''`，
    // `'' → ''` 不构成变化 ⇒ watch 不触发；没有这一行，上一条报价选过的公司会跨零件残留。
    createForm.outsource_company_id = '';
  }

  // ============ 审批 dialog（通过 + 拒绝）============
  const showApprove = ref(false);
  const showReject = ref(false);
  const reviewNote = ref('');
  const activeQuote = ref<OutsourceQuote | null>(null);

  function openApprove(q: OutsourceQuote): void {
    activeQuote.value = q;
    reviewNote.value = '';
    showApprove.value = true;
  }
  function openReject(q: OutsourceQuote): void {
    activeQuote.value = q;
    reviewNote.value = '';
    showReject.value = true;
  }

  // ============ 六条写路径的 useMutation ============
  const createMutation = useMutation({
    mutationKey: ['outsource', 'quotes', 'create'],
    mutationFn: (payload: Parameters<typeof createOutsourceQuote>[0]) =>
      createOutsourceQuote(payload),
    onSuccess: async () => {
      await invalidateOutsourceQuotesAll(qc);
      ElMessage.success('已创建 DRAFT 报价');
      showCreate.value = false;
    },
    onError: (e: Error) => ElMessage.error(e.message ?? '创建失败'),
  });

  // ⚠️ `version` 是硬约束：`OutsourceQuoteSubmitRequest.version` 无
  // `#[serde(default)]` ⇒ 缺传是 axum 的 HTTP 422 纯文本（不是业务信封）。
  const submitMutation = useMutation({
    mutationKey: ['outsource', 'quotes', 'submit'],
    mutationFn: (vars: { id: string; version: number }) =>
      submitOutsourceQuote(vars.id, { version: vars.version }),
    onSuccess: async () => {
      await invalidateOutsourceQuotesAll(qc);
      ElMessage.success('已提交审核');
    },
    onError: (e: Error) => ElMessage.error(e.message ?? '提交失败'),
  });

  const approveMutation = useMutation({
    mutationKey: ['outsource', 'quotes', 'approve'],
    mutationFn: (vars: { id: string; version: number; review_note: string | null }) =>
      approveOutsourceQuote(vars.id, { version: vars.version, review_note: vars.review_note }),
    onSuccess: async () => {
      await invalidateOutsourceQuotesAll(qc);
      ElMessage.success('已通过');
      showApprove.value = false;
    },
    onError: (e: Error) => ElMessage.error(e.message ?? '审批失败'),
  });

  const rejectMutation = useMutation({
    mutationKey: ['outsource', 'quotes', 'reject'],
    mutationFn: (vars: { id: string; version: number; review_note: string }) =>
      rejectOutsourceQuote(vars.id, { version: vars.version, review_note: vars.review_note }),
    onSuccess: async () => {
      await invalidateOutsourceQuotesAll(qc);
      ElMessage.success('已拒绝');
      showReject.value = false;
    },
    onError: (e: Error) => ElMessage.error(e.message ?? '拒绝失败'),
  });

  const softDeleteMutation = useMutation({
    mutationKey: ['outsource', 'quotes', 'soft-delete'],
    mutationFn: (vars: { id: string; version: number }) =>
      softDeleteOutsourceQuote(vars.id, { version: vars.version }),
    onSuccess: async () => {
      await invalidateOutsourceQuotesAll(qc);
      ElMessage.success('已软删');
    },
    onError: (e: Error) => ElMessage.error(e.message ?? '删除失败'),
  });

  /** 六个包装统一 try/catch：`mutateAsync` 在失败时 reject，错误文案由各 mutation 的
   *  `onError` 弹；调用侧（`OutsourceQuoteList.vue` 的 `@confirm` / `void form.onSubmit`）
   *  是裸接，不兜就是每次写失败多一条 unhandledrejection。 */
  async function onCreate(): Promise<void> {
    const parsed = outsourceQuoteFormSchema.safeParse(createForm);
    if (!parsed.success) {
      createFieldErrors.value = toFieldErrors(parsed.error.issues);
      return;
    }
    createFieldErrors.value = {};
    const v = parsed.data;
    try {
      await createMutation.mutateAsync({
        part_id: v.part_id,
        outsource_company_id: v.outsource_company_id,
        process_id: v.process_id,
        // 单价原样传字符串：后端入参是 Decimal 串，前端不做 number 转换（会丢末位精度）。
        price: v.price,
        note: v.note || null,
      });
    } catch {
      // mutation onError 已 ElMessage 提示
    }
  }

  async function onSubmit(q: OutsourceQuote): Promise<void> {
    try {
      await submitMutation.mutateAsync({ id: q.id, version: q.version });
    } catch {
      // mutation onError 已 ElMessage 提示
    }
  }

  async function onApprove(): Promise<void> {
    if (!activeQuote.value) return;
    try {
      await approveMutation.mutateAsync({
        id: activeQuote.value.id,
        version: activeQuote.value.version,
        review_note: reviewNote.value || null,
      });
    } catch {
      // mutation onError 已 ElMessage 提示
    }
  }

  async function onReject(): Promise<void> {
    if (!activeQuote.value || !reviewNote.value.trim()) {
      ElMessage.warning('请填写拒绝原因');
      return;
    }
    try {
      await rejectMutation.mutateAsync({
        id: activeQuote.value.id,
        version: activeQuote.value.version,
        review_note: reviewNote.value.trim(),
      });
    } catch {
      // mutation onError 已 ElMessage 提示
    }
  }

  async function onDelete(q: OutsourceQuote): Promise<void> {
    if (
      !(await confirmDangerous(
        '确认操作',
        `确定要软删报价 #${q.id}（${OUTSOURCE_QUOTE_STATUS_LABEL[q.status]}）？`,
      ))
    )
      return;
    try {
      await softDeleteMutation.mutateAsync({ id: q.id, version: q.version });
    } catch {
      // mutation onError 已 ElMessage 提示
    }
  }

  return {
    showCreate,
    createForm,
    createFieldErrors,
    openCreate,
    onCreate,
    onCreatePartChange,
    companies,
    companiesLoading,
    loadCompaniesByProcess,
    onSubmit,
    showApprove,
    showReject,
    reviewNote,
    activeQuote,
    openApprove,
    openReject,
    onApprove,
    onReject,
    onDelete,
  };
}

/** 报价状态筛选的候选（原生 `:filters` 列的 options）。
 *
 *  候选源是 `ACTIVE_QUOTE_STATUSES`（草稿 / 待审核 / 已批准 / 已拒绝四个活跃值）而不是
 *  `OUTSOURCE_QUOTE_STATUS_LABEL` 的全部键 —— 后者含四个 legacy 值
 *  （`OUTSOURCING` / `RECEIVED` / `BILLED` / `USED`），它们没有操作按钮、选中也拿不到
 *  行，让用户能选到「查不出任何行」的状态是纯误导。 */
export function quoteStatusFilterOptions(
  activeStatuses: readonly OutsourceQuoteStatus[],
): { text: string; value: string }[] {
  return activeStatuses.map((v) => ({ text: OUTSOURCE_QUOTE_STATUS_LABEL[v], value: v }));
}
