// composables/useOutsourceQuoteForm.ts
//
// 2026-08-25 T13：从 OutsourceQuoteList.vue 抽出：新建 + 审批 + 删除 业务状态 + 业务函数。
//
// 职责：
// - 新建报价 dialog state：showCreate / createForm / createRules / createFormRef +
//   companies / companiesLoading / onCreatePartChange（换零件时清空工序与公司） +
//   watch process_id 级联 + onCreate（创建草稿）
// - 审批 dialog state：showApprove / showReject / reviewNote / activeQuote +
//   openApprove / openReject / onApprove / onReject
// - 删除（带 confirmDangerous 二次确认）：onDelete
// - 提交审核（无 dialog）：onSubmit
//
// 不持有：
// - 表格列表状态（由 useOutsourceQuoteTable 持有）
// - 页级 lookup（processes / parts）：2026-10-03 起本 composable 不再需要它们
//   （工序改为操作员在 dialog 里手选，见 onCreatePartChange），二者由 shell 直供
//   OutsourceQuoteCreateDialog。

import { reactive, ref, watch, type Ref } from 'vue';
import { ElMessage, type FormInstance, type FormRules } from 'element-plus';
import {
  approveOutsourceQuote,
  createOutsourceQuote,
  listCompaniesByProcess,
  rejectOutsourceQuote,
  softDeleteOutsourceQuote,
  submitOutsourceQuote,
} from '@/api/outsource';
import { useConfirm } from '@/composables/useConfirm';
import { OUTSOURCE_QUOTE_STATUS_LABEL, type OutsourceQuote } from '@/types/outsource';

/** 新建报价表单（reactive） */
export interface CreateQuoteForm {
  part_id: string;
  outsource_company_id: string;
  process_id: string;
  price: string;
  note: string;
}

export interface UseOutsourceQuoteFormOptions {
  /** 创建 / 审批 / 删除 成功后由 caller 触发表格刷新 */
  refresh: () => Promise<void> | void;
}

/** 2026-09-21 显式返回类型。 */
export interface UseOutsourceQuoteFormReturn {
  showCreate: Ref<boolean>;
  createFormRef: Ref<FormInstance | undefined>;
  createForm: CreateQuoteForm;
  createRules: FormRules;
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

export function useOutsourceQuoteForm(
  opts: UseOutsourceQuoteFormOptions,
): UseOutsourceQuoteFormReturn {
  const { dangerous: confirmDangerous } = useConfirm();

  // ============ 新建报价 dialog ============
  const showCreate = ref(false);
  const createFormRef = ref<FormInstance>();
  const createForm = reactive<CreateQuoteForm>({
    part_id: '',
    outsource_company_id: '',
    process_id: '',
    price: '',
    note: '',
  });

  // 前端必填校验：4 个核心字段都必填，price 还需 > 0（镜像 schema/outsource_quote.py
  // `OutsourceQuoteCreateRequest` 的 `gt=0`）。
  const createRules: FormRules = {
    part_id: [{ required: true, message: '请选择零件', trigger: 'change' }],
    outsource_company_id: [{ required: true, message: '请选择外协公司', trigger: 'change' }],
    process_id: [{ required: true, message: '请选择工序', trigger: 'change' }],
    price: [
      { required: true, message: '请填写单价', trigger: 'blur' },
      {
        validator: (_rule, value: string, cb) => {
          const n = Number(value);
          if (value === '' || value == null || Number.isNaN(n) || n <= 0) {
            cb(new Error('单价必须大于 0'));
          } else {
            cb();
          }
        },
        trigger: 'blur',
      },
    ],
  };

  function openCreate(): void {
    createForm.part_id = '';
    createForm.outsource_company_id = '';
    createForm.process_id = '';
    createForm.price = '';
    createForm.note = '';
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
      const cs = await listCompaniesByProcess(processId);
      companies.value = cs.map((c) => ({ id: c.id, name: c.name }));
    } catch (e) {
      companies.value = [];
      ElMessage.error((e as Error).message ?? '外协公司加载失败');
    } finally {
      companiesLoading.value = false;
    }
  }

  // 工序变化：级联刷新公司列表，并清掉之前已选的公司，避免脏数据
  // 注意：此处 watch 必须在 createForm (reactive) 声明之后注册，
  //       否则 watch() 同步调用 source getter 会撞到 const TDZ 抛 ReferenceError。
  watch(
    () => createForm.process_id,
    (newPid) => {
      createForm.outsource_company_id = '';
      void loadCompaniesByProcess(newPid);
    },
  );

  /** 选择零件后重置工序与公司，让操作员在独立的工序下拉里重新选。
   *
   *  2026-10-03 契约对齐：`GET /outsource-quotes/quotable-parts` 的行粒度改成
   *  「一个零件一行」，VO 不再带工序 / 货架字段 ⇒ **没有任何数据通路**能推断出该
   *  零件该报哪道工序（此前的「自动填工序」只能靠已下线的 `next_process_id`）。
   *  工序一律手选。
   *
   *  清空两步是必须的：`process_id` 不清会沿用上一零件的工序（`el-select` 的
   *  `:value` 只按 part_id 匹配，改零件不会自动清它），`outsource_company_id` 不清
   *  则会残留一个与新工序无隶属关系的公司。
   *
   *  入参保留是为对齐 dialog 的 `partChange` 事件载荷（当前无需读取）。 */
  function onCreatePartChange(_partId: string): void {
    createForm.process_id = '';
    // 2026-10-03 登记：下一行与 `process_id` 的 watch（上面）重复，**看着冗余但不可删**
    //  —— watch 只在 `process_id` 从非空变空时才触发，而换零件时它本来已是 ''（或本次
    //  赋的 ''），watch 不跑 ⇒ 没有这一行，上一条报价选过的公司会跨零件残留。
    // `useOutsourceQuoteForm.spec.ts` 的 Q2 正是靠它才绿。
    createForm.outsource_company_id = '';
  }

  async function onCreate(): Promise<void> {
    if (!createFormRef.value) return;
    // el-form 校验：4 个必填字段 + price > 0；校验失败时 validate() reject，直接短路（红字提示）
    try {
      await createFormRef.value.validate();
    } catch {
      return;
    }
    try {
      await createOutsourceQuote({
        part_id: createForm.part_id,
        outsource_company_id: createForm.outsource_company_id,
        process_id: createForm.process_id,
        price: createForm.price || '0',
        note: createForm.note || null,
      });
      ElMessage.success('已创建 DRAFT 报价');
      showCreate.value = false;
      await opts.refresh();
    } catch (e) {
      ElMessage.error((e as Error).message ?? '创建失败');
    }
  }

  // ============ 提交审核（无 dialog，直接发请求）============
  async function onSubmit(q: OutsourceQuote): Promise<void> {
    try {
      await submitOutsourceQuote(q.id);
      ElMessage.success('已提交审核');
      await opts.refresh();
    } catch (e) {
      ElMessage.error((e as Error).message ?? '提交失败');
    }
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

  async function onApprove(): Promise<void> {
    if (!activeQuote.value) return;
    try {
      await approveOutsourceQuote(activeQuote.value.id, {
        version: activeQuote.value.version,
        review_note: reviewNote.value || null,
      });
      ElMessage.success('已通过');
      showApprove.value = false;
      await opts.refresh();
    } catch (e) {
      ElMessage.error((e as Error).message ?? '审批失败');
    }
  }

  async function onReject(): Promise<void> {
    if (!activeQuote.value || !reviewNote.value.trim()) {
      ElMessage.warning('请填写拒绝原因');
      return;
    }
    try {
      await rejectOutsourceQuote(activeQuote.value.id, {
        version: activeQuote.value.version,
        review_note: reviewNote.value.trim(),
      });
      ElMessage.success('已拒绝');
      showReject.value = false;
      await opts.refresh();
    } catch (e) {
      ElMessage.error((e as Error).message ?? '拒绝失败');
    }
  }

  // ============ 软删（二次确认）============
  async function onDelete(q: OutsourceQuote): Promise<void> {
    if (
      !(await confirmDangerous(
        '确认操作',
        `确定要软删报价 #${q.id}（${OUTSOURCE_QUOTE_STATUS_LABEL[q.status]}）？`,
      ))
    )
      return;
    try {
      await softDeleteOutsourceQuote(q.id);
      ElMessage.success('已软删');
      await opts.refresh();
    } catch (e) {
      ElMessage.error((e as Error).message ?? '删除失败');
    }
  }

  return {
    // 新建
    showCreate,
    createFormRef,
    createForm,
    createRules,
    openCreate,
    onCreate,
    onCreatePartChange,
    // 工序 → 公司级联
    companies,
    companiesLoading,
    loadCompaniesByProcess,
    // 提交
    onSubmit,
    // 审批
    showApprove,
    showReject,
    reviewNote,
    activeQuote,
    openApprove,
    openReject,
    onApprove,
    onReject,
    // 删除
    onDelete,
  };
}
