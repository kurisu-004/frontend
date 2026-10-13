// 2026-09-24 新增：usePartBatchManual composable 单测。
// 模式参考 LoginView.spec.ts：harness 组件 + VueQueryPlugin + 模块 mock。
//
// 覆盖：
//   - 校验失败不入队且 formErrors 有值；
//   - trim 后入队（Zod schema 处理 trim，result.data 入 staged）；
//   - 客户存在性业务校验失败 → formErrors.customerId；
//   - onSubmit mutation 成功 → staged 清空 + router.push；
//   - onSubmit 部分失败 → ElMessageBox.alert 且 staged 保留；
//   - 申请人缓存未命中 → createApplicant 被调且 payload 带新 id。
// @vitest-environment happy-dom

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';

// ============ 模块 mock ============

const mocks = vi.hoisted(() => ({
  batchCreateParts: vi.fn(),
  createApplicant: vi.fn(),
  routerReplace: vi.fn(),
  confirmDangerous: vi.fn(),
}));

// 2026-09-28 删 useUploadSession：原 usePartBatchManual.spec.ts 的 sessionStub +
// vi.mock('@/views/parts/new/composables/useUploadSession', ...) 已下线。
// requestDrawingUpload 改为 throw not-implemented 后，spec 不再需要 session mock。

vi.mock('@/api/parts', () => ({
  batchCreateParts: mocks.batchCreateParts,
}));

vi.mock('@/api/applicant', () => ({
  createApplicant: mocks.createApplicant,
}));

vi.mock('@/views/parts/new/composables/usePartsNewDraft', () => ({
  usePartsNewDraft: () => ({
    userId: 'u-test',
    load: () => null,
    clear: () => undefined,
    saver: { schedule: () => undefined, cancel: () => undefined, flush: () => undefined },
  }),
  mergeDraftWithSession: () => ({ restored: false, manualStaged: [], orphanFileRefs: [] }),
}));

vi.mock('vue-router', () => ({
  useRouter: () => ({ replace: mocks.routerReplace, push: mocks.routerReplace }),
  useRoute: () => ({ path: '/parts/new', query: {} }),
}));

vi.mock('element-plus', () => ({
  ElMessage: {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
  ElMessageBox: {
    confirm: vi.fn(),
    alert: vi.fn(),
  },
}));

vi.mock('@/composables/useConfirm', () => ({
  useConfirm: () => ({
    dangerous: mocks.confirmDangerous,
  }),
}));

// 2026-09-24：mock 整个 @tanstack/vue-query 模块，让 useMutation 走我们控制的
// 路径：收到 mutationFn 后立刻调 onSuccess/onError（happy-dom 下 useMutation 内部
// 时序不一致，端到端跑不到 mutationFn）。
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';
import type * as VueQueryNS from '@tanstack/vue-query';
import { ref as vueRef, type Ref } from 'vue';

vi.mock('@tanstack/vue-query', async (importOriginal) => {
  const actual = await importOriginal<typeof VueQueryNS>();
  return {
    ...actual,
    VueQueryPlugin: actual.VueQueryPlugin,
    QueryClient: actual.QueryClient,
    useMutation: <TData, TError, TVars>(opts: {
      mutationKey?: unknown[];
      mutationFn: (vars: TVars) => Promise<TData> | TData;
      onSuccess?: (data: TData, vars: TVars) => void | Promise<void>;
      onError?: (err: TError, vars: TVars) => void;
    }) => {
      // 真正的 ref，computed 才能正确追踪 .value 变化
      const isPending = vueRef(false) as Ref<boolean>;
      return {
        mutate: async (vars: TVars) => {
          isPending.value = true;
          try {
            const data = await opts.mutationFn(vars);
            await opts.onSuccess?.(data, vars);
          } catch (e) {
            await opts.onError?.(e as TError, vars);
          } finally {
            isPending.value = false;
          }
        },
        mutateAsync: async (vars: TVars) => {
          isPending.value = true;
          try {
            const data = await opts.mutationFn(vars);
            await opts.onSuccess?.(data, vars);
            isPending.value = false;
            return data;
          } catch (e) {
            await opts.onError?.(e as TError, vars);
            isPending.value = false;
            throw e;
          }
        },
        isPending: isPending,
      };
    },
  };
});

// 静态导入（必须在 vi.mock 之后）
import { usePartBatchManual } from '../composables/usePartBatchManual';
import type { PartBatchResult } from '@/api/parts/batch';
import type { Customer } from '@/api/customer';
import type { Applicant } from '@/types/applicant';

// ============ harness 组件 ============
// 2026-10-17（客户无限层级改造）：customers 提到模块级 `customersRef` —— 深度相关
// 用例要在 mount **之前**换一棵树（客户任意深度：中间层节点有子节点）。原来 ref 建在
// Harness setup 内部，用例拿不到、换不了树。
const baseCustomer: Customer = {
  id: 'c1',
  name: '客户A',
  parent_id: null,
  parent_name: null,
  serial_prefix: null,
  // 2026-09-26（M-1 修复）：Customer 补齐 version / created_at / updated_at 后，
  // 测试 fixture 同步补齐（与 backend-rust CustomerOut 8 字段对齐）。
  version: 1,
  // 2026-10-17（客户无限层级改造）：新增必填 customer_path；本 fixture 的节点
  // 是一级客户（parent_id = null），按口径等于自己的 name。
  customer_path: '客户A',
  created_at: '',
  updated_at: '',
};
const customersRef = vueRef<Customer[]>([baseCustomer]);

// setup 阶段调 usePartBatchManual，把 return 挂到 instance 便于断言。
let captured: ReturnType<typeof usePartBatchManual> | null = null;
const Harness = defineComponent({
  setup() {
    const applicants = vueRef<Applicant[]>([]);
    const rootCustomerId = vueRef<string | null>(null);
    const loading = vueRef(false);
    captured = usePartBatchManual({
      customers: customersRef,
      applicantSearch: {
        applicants,
        rootCustomerId,
        loading,
        loadForCustomer: async () => undefined,
        querySearch: () => undefined,
      },
    });
    return () => h('div', { class: 'harness' }, 'harness');
  },
});

const harnessMount = () =>
  mount(Harness, {
    global: {
      plugins: [
        [
          VueQueryPlugin,
          { queryClient: new QueryClient({ defaultOptions: { mutations: { retry: 0 } } }) },
        ] as [typeof VueQueryPlugin, { queryClient: QueryClient }],
      ],
    },
  });

// ============ fixtures ============

// `created` 元素 = 后端 `PartDetailOut` + 前端补的 `sourceIndex`（请求 items 的全局
// 下标）。Tab 1 不消费 sourceIndex，但类型上必填，fixture 需补。
//
// 2026-10-10：原先这份 fixture 带 9 个后端 `PartDetailOut` **一个都不返**的键
// （parent_customer_name / customer_path / current_holder_kind / shelf_code /
// worker_name / outsource_company_name / location / next_process_name /
// has_process_chain）—— 它们是前端旧 `PartItem` 联合类型里的幽灵字段。现按
// `PartDetailOut` 的 28 字段补齐，被测逻辑（onAddConfirm 的分组合并 / 失败行定位）
// 不读这些字段。
const okPartItem: PartBatchResult['created'][number] = {
  sourceIndex: 0,
  id: 'p1',
  serial_no: 'P00001',
  name: 'x',
  drawing_no: 'd',
  applicant_name: '申请人',
  quantity: 1,
  request_date: '2026-09-25',
  planned_delivery_date: '2026-09-25',
  customer_id: 'c1',
  assembly_id: null,
  status: 'PENDING',
  is_urgent: false,
  next_process_id: null,
  order_no: null,
  system_delivery_date: null,
  note: null,
  unit_price: '0.00',
  total_price: '0.00',
  version: 0,
  created_at: '2026-09-25 08:00:00',
  created_by: null,
  updated_at: '2026-09-25 08:00:00',
  updated_by: null,
  deleted_at: null,
  process_chain_id: null,
  customer_name: '客户A',
  l1_customer_name: '客户A-一级',
  // 2026-10-17：partDetailSchema（strict，28 键）新增必填 customer_path（可空）——
  // 该类型经 PartDetailDto 流到 PartBatchResult['created']，fixture 必须补。
  customer_path: '客户A',
  current_batch_id: null,
};
const okResult: PartBatchResult = { created: [okPartItem], failed: [], cleanup_tmp_keys: [] };
const partialResult: PartBatchResult = {
  created: [],
  failed: [{ index: 0, message: 'invalid' }],
  cleanup_tmp_keys: [],
};

beforeEach(() => {
  mocks.batchCreateParts.mockReset();
  mocks.createApplicant.mockReset();
  mocks.routerReplace.mockReset();
  mocks.confirmDangerous.mockResolvedValue(true);
  // 默认：applicant 缓存命中，避免 createApplicant 未配置触发 undefined.id
  mocks.createApplicant.mockResolvedValue({ id: 'appl-default' });
});

// ============ tests ============

describe('usePartBatchManual', () => {
  it('onAddConfirm 校验失败：空 drawingNo → formErrors.drawingNo 有值且 staged 不变', async () => {
    const w = harnessMount();
    await flushPromises();
    expect(captured).not.toBeNull();

    // 直接构造 form 错误（绕过 el-input v-model），触发 onAddConfirm
    if (!captured) throw new Error('not captured');
    captured.form.drawingNo = '';
    captured.form.name = '';
    captured.form.customerId = '';
    captured.form.applicantName = '';
    captured.form.plannedDeliveryDate = '';
    await captured.onAddConfirm();
    await nextTick();

    // captured.formErrors 是 Ref，断言须走 .value
    expect(captured.formErrors.value.drawingNo).toBe('请输入图号');
    expect(captured.formErrors.value.name).toBe('请输入名称');
    expect(captured.formErrors.value.customerId).toBe('请选择客户');
    expect(captured.formErrors.value.applicantName).toBe('请选择或输入申请人');
    expect(captured.staged.value.length).toBe(0);

    w.unmount();
  });

  it('onAddConfirm 成功：trim 后入队', async () => {
    const w = harnessMount();
    await flushPromises();
    if (!captured) throw new Error('not captured');

    captured.form.drawingNo = '  LT1  ';
    captured.form.name = '  p1  ';
    captured.form.customerId = 'c1';
    captured.form.applicantName = '  bob  ';
    captured.form.requestDate = '2026-09-24';
    captured.form.plannedDeliveryDate = '2026-09-25';
    captured.form.quantity = 2;
    await captured.onAddConfirm();
    await nextTick();

    expect(captured.staged.value.length).toBe(1);
    expect(captured.staged.value[0]!.drawingNo).toBe('LT1');
    expect(captured.staged.value[0]!.name).toBe('p1');
    expect(captured.staged.value[0]!.applicantName).toBe('bob');

    w.unmount();
  });

  it('客户 id 不在 customers 列表：formErrors.customerId = 客户不存在', async () => {
    const w = harnessMount();
    await flushPromises();
    if (!captured) throw new Error('not captured');

    captured.form.drawingNo = 'LT1';
    captured.form.name = 'p1';
    captured.form.customerId = 'c-not-exist';
    captured.form.applicantName = 'bob';
    captured.form.requestDate = '2026-09-24';
    captured.form.plannedDeliveryDate = '2026-09-25';
    await captured.onAddConfirm();
    await nextTick();

    expect(captured.formErrors.value.customerId).toBe('客户不存在');
    expect(captured.staged.value.length).toBe(0);

    w.unmount();
  });

  it('onSubmit 成功：batchCreateParts 调一次、staged 清空、router.push', async () => {
    mocks.batchCreateParts.mockResolvedValue(okResult);
    const w = harnessMount();
    await flushPromises();
    if (!captured) throw new Error('not captured');

    // 入队一条合法条目
    captured.form.drawingNo = 'LT1';
    captured.form.name = 'p1';
    captured.form.customerId = 'c1';
    captured.form.applicantName = 'bob';
    captured.form.requestDate = '2026-09-24';
    captured.form.plannedDeliveryDate = '2026-09-25';
    await captured.onAddConfirm();
    await nextTick();
    expect(captured.staged.value.length).toBe(1);

    await captured.onSubmit();
    // onSubmit 内部 fire-and-forget mutate，等待 mutation 跑完
    for (let i = 0; i < 5; i += 1) {
      await flushPromises();
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(captured.staged.value.length).toBe(0);
    expect(mocks.routerReplace).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/parts', query: { status: 'PENDING' } }),
    );

    w.unmount();
  });

  it('onSubmit 部分失败：ElMessageBox.alert 被调、staged 保留', async () => {
    mocks.batchCreateParts.mockResolvedValue(partialResult);
    const { ElMessageBox } = await import('element-plus');
    const w = harnessMount();
    await flushPromises();
    if (!captured) throw new Error('not captured');

    captured.form.drawingNo = 'LT1';
    captured.form.name = 'p1';
    captured.form.customerId = 'c1';
    captured.form.applicantName = 'bob';
    captured.form.requestDate = '2026-09-24';
    captured.form.plannedDeliveryDate = '2026-09-25';
    await captured.onAddConfirm();
    await nextTick();

    await captured.onSubmit();
    await flushPromises();

    expect(ElMessageBox.alert as ReturnType<typeof vi.fn>).toHaveBeenCalled();
    expect(captured.staged.value.length).toBe(1);
    expect(mocks.routerReplace).not.toHaveBeenCalled();

    w.unmount();
  });

  it('申请人缓存未命中：createApplicant 被调、payload 带新 id', async () => {
    mocks.batchCreateParts.mockResolvedValue(okResult);
    mocks.createApplicant.mockResolvedValue({ id: 'appl-new' });
    const w = harnessMount();
    await flushPromises();
    if (!captured) throw new Error('not captured');

    captured.form.drawingNo = 'LT1';
    captured.form.name = 'p1';
    captured.form.customerId = 'c1';
    captured.form.applicantName = 'newface';
    captured.form.requestDate = '2026-09-24';
    captured.form.plannedDeliveryDate = '2026-09-25';
    await captured.onAddConfirm();
    await nextTick();

    // 清掉 applicants cache 与 rootCustomerId 不一致，强制走 createApplicant
    if (!captured) throw new Error('not captured');
    // rootCustomerId 默认 null，applicantSearch.rootCustomerId.value 是 ref，
    // 但 harness 注入的是 {value:null} 浅对象——保留 null 让 if (applicantSearch.rootCustomerId.value === rootId) 走 createApplicant 分支

    await captured.onSubmit();
    await flushPromises();

    expect(mocks.createApplicant).toHaveBeenCalledTimes(1);
    expect(mocks.createApplicant).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'newface', customer_id: 'c1' }),
    );
    // payload 带新 id
    const lastCall = mocks.batchCreateParts.mock.calls[0]![0] as Array<{ applicant_id: string }>;
    expect(lastCall[0]!.applicant_id).toBe('appl-new');

    w.unmount();
  });

  it('submitting 是 mutation.isPending 派生（useMutation 化）', async () => {
    // 用 mockImplementation 自定义 promise 让 batchCreateParts 永远 pending
    let resolveBatch: (r: PartBatchResult) => void = () => undefined;
    mocks.batchCreateParts.mockImplementation(
      () =>
        new Promise<PartBatchResult>((r) => {
          resolveBatch = r;
        }),
    );
    mocks.batchCreateParts.mockResolvedValueOnce(
      new Promise<PartBatchResult>((r) => {
        resolveBatch = r;
      }) as never,
    );
    const w = harnessMount();
    await flushPromises();
    if (!captured) throw new Error('not captured');

    // 入队一条
    captured.form.drawingNo = 'LT1';
    captured.form.name = 'p1';
    captured.form.customerId = 'c1';
    captured.form.applicantName = 'bob';
    captured.form.requestDate = '2026-09-24';
    captured.form.plannedDeliveryDate = '2026-09-25';
    await captured.onAddConfirm();
    await nextTick();

    await captured.onSubmit();
    // submitStagedEntries 调 batchCreateParts 应 pending → mutate 内部 isPending=true
    for (let i = 0; i < 5; i += 1) {
      await flushPromises();
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(captured.submitting.value).toBe(true);

    // 完成 mutation
    resolveBatch(okResult);
    for (let i = 0; i < 5; i += 1) {
      await flushPromises();
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(captured.submitting.value).toBe(false);

    w.unmount();
  });
});

// ============================================================================
// 2026-10-17（客户无限层级改造）：cascader 任意深度 + 「单据只能挂叶子」提交闸。
//
// 改前口径：customerTree 是本 composable 内联拼的**硬编码两层**树（第 3 层往下的客户
// 选不到），且提交只校验「客户存在」⇒ 选中间层（下面还有车间）也能进待新增列表，
// 后端会以 20104 拒掉。
// ============================================================================

/** 任意深度客户树（customer_path = 第 2 层到叶子 ` / ` 拼接、不含 L1）。 */
function deepCustomer(
  id: string,
  name: string,
  parentId: string | null,
  customerPath: string,
): Customer {
  return {
    id,
    name,
    parent_id: parentId,
    parent_name: null,
    serial_prefix: null,
    customer_path: customerPath,
    version: 1,
    created_at: '',
    updated_at: '',
  };
}

const DEEP_TREE: Customer[] = [
  deepCustomer('d-root', '测试集团', null, '测试集团'),
  deepCustomer('d-f1', '甲分厂', 'd-root', '甲分厂'),
  deepCustomer('d-f1-w1', '一车间', 'd-f1', '甲分厂 / 一车间'),
  deepCustomer('d-f1-w1-b1', '装配班组', 'd-f1-w1', '甲分厂 / 一车间 / 装配班组'),
  deepCustomer('d-f2', '乙分厂', 'd-root', '乙分厂'),
  deepCustomer('d-f2-w1', '镀膜厂', 'd-f2', '乙分厂 / 镀膜厂'),
];

describe('usePartBatchManual：客户任意深度（cascader + 落叶子）', () => {
  beforeEach(() => {
    customersRef.value = DEEP_TREE;
  });

  afterAll(() => {
    customersRef.value = [baseCustomer];
  });

  it('customerTree 走 buildCustomerTree：第 4 层节点也在树上，且带 customer_path', () => {
    const w = harnessMount();
    if (!captured) throw new Error('not captured');

    const roots = captured.customerTree.value;
    expect(roots.map((r) => r.id)).toEqual(['d-root']);
    const f1 = roots[0]?.children[0];
    expect(f1?.id).toBe('d-f1');
    // 深度 3
    expect(f1?.children[0]?.id).toBe('d-f1-w1');
    // 深度 4（改前的硬编码两层树在这里就没有任何选项）
    expect(f1?.children[0]?.children[0]?.id).toBe('d-f1-w1-b1');
    // cascader 的 label 吃 customer_path
    expect(f1?.children[0]?.children[0]?.customer_path).toBe('甲分厂 / 一车间 / 装配班组');

    w.unmount();
  });

  it('选中**中间层**客户 → 拒绝入队 + formErrors.customerId 提示挂末级（后端 20104）', async () => {
    const w = harnessMount();
    await flushPromises();
    if (!captured) throw new Error('not captured');

    captured.form.drawingNo = 'LT1';
    captured.form.name = 'p1';
    captured.form.customerId = 'd-f1'; // 甲分厂：下面还有一车间
    captured.form.applicantName = 'bob';
    captured.form.requestDate = '2026-09-24';
    captured.form.plannedDeliveryDate = '2026-09-25';
    await captured.onAddConfirm();
    await nextTick();

    expect(captured.formErrors.value.customerId).toContain('还有下级部门');
    expect(captured.formErrors.value.customerId).toContain('甲分厂');
    expect(captured.staged.value.length).toBe(0);

    w.unmount();
  });

  it('选中**叶子**客户 → 正常入队（任意深度都放行）', async () => {
    const w = harnessMount();
    await flushPromises();
    if (!captured) throw new Error('not captured');

    captured.form.drawingNo = 'LT1';
    captured.form.name = 'p1';
    captured.form.customerId = 'd-f1-w1-b1'; // 深度 4 的末级班组
    captured.form.applicantName = 'bob';
    captured.form.requestDate = '2026-09-24';
    captured.form.plannedDeliveryDate = '2026-09-25';
    await captured.onAddConfirm();
    await nextTick();

    expect(captured.formErrors.value.customerId).toBeUndefined();
    expect(captured.staged.value.length).toBe(1);
    expect(captured.staged.value[0]?.customerId).toBe('d-f1-w1-b1');

    w.unmount();
  });

  it('根节点自己就是叶子（该 L1 下没建任何下级）→ 照样放行', async () => {
    customersRef.value = [deepCustomer('solo-root', '独立客户', null, '独立客户')];
    const w = harnessMount();
    await flushPromises();
    if (!captured) throw new Error('not captured');

    captured.form.drawingNo = 'LT1';
    captured.form.name = 'p1';
    captured.form.customerId = 'solo-root';
    captured.form.applicantName = 'bob';
    captured.form.requestDate = '2026-09-24';
    captured.form.plannedDeliveryDate = '2026-09-25';
    await captured.onAddConfirm();
    await nextTick();

    expect(captured.formErrors.value.customerId).toBeUndefined();
    expect(captured.staged.value.length).toBe(1);

    w.unmount();
  });
});
