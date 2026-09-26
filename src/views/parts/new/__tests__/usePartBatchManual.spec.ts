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

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';

// ============ 模块 mock ============

const mocks = vi.hoisted(() => ({
  batchCreateParts: vi.fn(),
  createApplicant: vi.fn(),
  routerReplace: vi.fn(),
  consumeFiles: vi.fn(),
  markComplete: vi.fn(),
  sessionInit: vi.fn(),
  confirmDangerous: vi.fn(),
}));

const sessionStub = {
  isReady: { value: true },
  credentials: { value: null },
  bucket: { value: '' },
  region: { value: '' },
  session: { value: { files: [] } },
  files: { value: [] as { client_ref: string; original_filename: string; file_size: number; content_type: string }[] },
  init: mocks.sessionInit,
  allocate: vi.fn(),
  markComplete: mocks.markComplete,
  consumeFiles: mocks.consumeFiles,
  discard: vi.fn(),
};

vi.mock('@/api/parts', () => ({
  batchCreateParts: mocks.batchCreateParts,
}));

vi.mock('@/api/applicant', () => ({
  createApplicant: mocks.createApplicant,
}));

vi.mock('@/composables/useUploadSession', () => ({
  getUploadSession: () => sessionStub,
}));

vi.mock('@/composables/usePartsNewDraft', () => ({
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
    useMutation: <TData, TError, TVars>(
      opts: {
        mutationKey?: unknown[];
        mutationFn: (vars: TVars) => Promise<TData> | TData;
        onSuccess?: (data: TData, vars: TVars) => void | Promise<void>;
        onError?: (err: TError, vars: TVars) => void;
      },
    ) => {
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
// setup 阶段调 usePartBatchManual，把 return 挂到 instance 便于断言。
let captured: ReturnType<typeof usePartBatchManual> | null = null;
const Harness = defineComponent({
  setup() {
    const applicants = vueRef<Applicant[]>([]);
    const rootCustomerId = vueRef<string | null>(null);
    const loading = vueRef(false);
    captured = usePartBatchManual({
      customers: vueRef([
        {
          id: 'c1',
          name: '客户A',
          parent_id: null,
          parent_name: null,
          serial_prefix: null,
          status: 'ACTIVE',
          created_at: '',
          updated_at: '',
        },
      ]) as Ref<Customer[]>,
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

const okPartItem: PartBatchResult['created'][number] = {
  id: 'p1',
  version: 0,
  serial_no: 'P00001',
  name: 'x',
  drawing_no: 'd',
  quantity: 1,
  planned_delivery_date: '2026-09-25',
  is_urgent: false,
  status: 'PENDING',
  order_no: null,
  system_delivery_date: null,
  note: null,
  customer_name: '客户A',
  parent_customer_name: null,
  customer_path: null,
  assembly_id: null,
  current_holder_kind: null,
  shelf_code: null,
  worker_name: null,
  outsource_company_name: null,
  location: null,
  next_process_id: null,
  next_process_name: null,
};
const okResult: PartBatchResult = { created: [okPartItem], failed: [], cleanup_tmp_keys: [] };
const partialResult: PartBatchResult = { created: [], failed: [{ index: 0, message: 'invalid' }], cleanup_tmp_keys: [] };

beforeEach(() => {
  mocks.batchCreateParts.mockReset();
  mocks.createApplicant.mockReset();
  mocks.routerReplace.mockReset();
  mocks.consumeFiles.mockResolvedValue(undefined);
    mocks.markComplete.mockResolvedValue(undefined);
    mocks.sessionInit.mockResolvedValue(undefined);
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

    expect((ElMessageBox.alert as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
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
      () => new Promise<PartBatchResult>((r) => { resolveBatch = r; }),
    );
    mocks.batchCreateParts.mockResolvedValueOnce(
      new Promise<PartBatchResult>((r) => { resolveBatch = r; }) as never,
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
