// 2026-09-24 新增：usePartBatchManual composable 单测。
// 模式参考 LoginView.spec.ts：harness 组件 + VueQueryPlugin + 模块 mock。
//
// 覆盖：
//   - 校验失败不入队且 formErrors 有值；
//   - trim 后入队（Zod schema 处理 trim，result.data 入 staged）；
//   - 客户存在性业务校验失败 → formErrors.customerId；
//   - onSubmit mutation 成功 → staged 清空 + router.push；
//   - onSubmit 部分失败 → ElMessageBox.alert 且 staged 保留；
//   - 申请人缓存未命中 → getOrCreateApplicant 被调且 payload 带新 id；
//   - 2026-10-17：同批两行同名申请人 → 两行拿到同一个 id 且整批照常提交
//     （幂等端点 + 缓存回写）；
//   - 2026-10-17：申请人接口 reject → 该行 applicantId 留 null，但整批仍提交。
// @vitest-environment happy-dom

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';

// ============ 模块 mock ============

const mocks = vi.hoisted(() => ({
  batchCreateParts: vi.fn(),
  /**
   * 2026-10-17：`createApplicant` → `getOrCreateApplicant`。
   * 后端 `POST /com/applicants/get-or-create` 是幂等的（同 name+customer 直接返
   * 既有行），非幂等的 createApplicant 会让「同批两行同名申请人」必然撞 409。
   */
  getOrCreateApplicant: vi.fn(),
  routerReplace: vi.fn(),
  confirmDangerous: vi.fn(),
  warn: vi.fn(),
  directUpload: vi.fn(),
}));

// 2026-09-28 删 useUploadSession：原 usePartBatchManual.spec.ts 的 sessionStub +
// vi.mock('@/views/parts/new/composables/useUploadSession', ...) 已下线。
// requestDrawingUpload 改为 throw not-implemented 后，spec 不再需要 session mock。

vi.mock('@/api/parts', () => ({
  batchCreateParts: mocks.batchCreateParts,
}));

vi.mock('@/api/applicant', () => ({
  getOrCreateApplicant: mocks.getOrCreateApplicant,
}));

// 2026-10-15：建单成功后的图纸上传阶段走 `utils/directUpload`（内部再调 upload-intents /
// XHR PUT / confirm 三条网络请求）。这里桩掉传输层，让「建单结果 → 上传阶段」的编排
// 可以被纯本地地驱动；directUpload 自身的行为由 `utils/__tests__/directUpload.spec.ts` 守。
vi.mock('@/utils/directUpload', () => ({
  directUpload: (o: { ownerId: string; file: File }) => mocks.directUpload(o),
}));

// 2026-10-17：申请人解析失败只 console.warn（不中止整批），钉住「告警确实发生」，
// 避免将来有人把 catch 里的 warn 删成静默。
vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
  mocks.warn(...args);
});

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
//
// 2026-10-17：三个 applicantSearch ref 也提到模块级（此前建在 Harness setup 内），
// 因为新用例必须能在 mount **之前**预置缓存（命中快路径）与在提交**之后**断言
// 回写结果，setup 内部的 ref 用例拿不到。
const applicantsRef = vueRef<Applicant[]>([]);
const rootCustomerIdRef = vueRef<string | null>(null);
const loadingRef = vueRef(false);

let captured: ReturnType<typeof usePartBatchManual> | null = null;
const Harness = defineComponent({
  setup() {
    captured = usePartBatchManual({
      customers: customersRef,
      applicantSearch: {
        applicants: applicantsRef,
        rootCustomerId: rootCustomerIdRef,
        loading: loadingRef,
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
/**
 * 混合形态：第 0 行建成、第 1 行没建成。⚠️ `sourceIndex: 0` 必须与 `failed[].index: 1`
 * 对上 —— 它是「建出来的零件对回 staged 哪一行」的唯一依据（见 runDrawingUploadPhase）。
 */
const mixedResult: PartBatchResult = {
  created: [okPartItem],
  failed: [{ index: 1, message: 'invalid' }],
  cleanup_tmp_keys: [],
};

beforeEach(() => {
  mocks.batchCreateParts.mockReset();
  mocks.getOrCreateApplicant.mockReset();
  mocks.directUpload.mockReset();
  mocks.directUpload.mockResolvedValue({ item: { id: 'file-1' }, alreadyExists: false });
  mocks.routerReplace.mockReset();
  mocks.warn.mockReset();
  mocks.confirmDangerous.mockResolvedValue(true);
  // 申请人缓存默认「空且不属于任何 root」⇒ 强制走 getOrCreateApplicant 分支，
  // 避免未配置 mock 时读到 undefined.id。
  applicantsRef.value = [];
  rootCustomerIdRef.value = null;
  loadingRef.value = false;
  mocks.getOrCreateApplicant.mockResolvedValue({ id: 'appl-default' });
});

/** 把一条合法表单灌进 `captured.form` 并入队（Tab 1 的录入路径）。 */
async function stageEntry(
  c: ReturnType<typeof usePartBatchManual>,
  drawingNo: string,
  applicantName: string,
): Promise<void> {
  c.form.drawingNo = drawingNo;
  c.form.name = 'p1';
  c.form.customerId = 'c1';
  c.form.applicantName = applicantName;
  c.form.requestDate = '2026-09-24';
  c.form.plannedDeliveryDate = '2026-09-25';
  await c.onAddConfirm();
  await nextTick();
}

/** onSubmit 是 fire-and-forget 的 mutate，跑完它需要几个宏任务周转。 */
async function drainSubmit(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await flushPromises();
    await new Promise((r) => setTimeout(r, 10));
  }
}

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

  // ⚠️ 2026-10-15：部分行未建成时，**已建成的那几行的图纸仍要上传**，且那几行必须
  //   从 staged 里摘掉。改前这一支直接 return：图纸既没传、也没进失败清单、也没提示，
  //   而 staged 原样留着 ⇒ 用户改完失败行再点一次提交，会为已经建出来的行再建一遍单。
  it('onSubmit 混合结果（1 行建成 + 1 行未建成）：建成行的图纸照样上传，且那行从 staged 移除', async () => {
    mocks.batchCreateParts.mockResolvedValue(mixedResult);
    const { ElMessageBox } = await import('element-plus');
    // element-plus 是模块级桩，alert 的调用记录跨用例累积 ⇒ 只看本用例自己那次。
    (ElMessageBox.alert as ReturnType<typeof vi.fn>).mockClear();
    const w = harnessMount();
    await flushPromises();
    if (!captured) throw new Error('not captured');

    // 第 0 行：建成（带图纸 ⇒ 上传阶段必须为它建 job）
    captured.form.drawingNo = 'LT1';
    captured.form.name = 'p1';
    captured.form.customerId = 'c1';
    captured.form.applicantName = 'bob';
    captured.form.requestDate = '2026-09-24';
    captured.form.plannedDeliveryDate = '2026-09-25';
    captured.onDrawingFileChange(new File([new Uint8Array([1, 2, 3])], 'lt1.pdf'));
    await captured.onAddConfirm();
    await nextTick();

    // 第 1 行：未建成（无图纸）
    captured.form.drawingNo = 'LT2';
    captured.form.name = 'p2';
    captured.onDrawingFileChange(null);
    await captured.onAddConfirm();
    await nextTick();
    expect(captured.staged.value.length).toBe(2);

    await captured.onSubmit();
    await drainSubmit();

    // ① 建成行的图纸真的传了，owner 是 created[0].id
    expect(mocks.directUpload).toHaveBeenCalledTimes(1);
    expect(mocks.directUpload.mock.calls[0]![0]).toMatchObject({
      ownerKind: 'PART',
      ownerId: 'p1',
      kind: 'DRAWING',
    });

    // ② 已建成的那行从 staged 移除（重提不会再建一遍单），只剩未建成的那行
    expect(captured.staged.value.length).toBe(1);
    expect(captured.staged.value[0]!.drawingNo).toBe('LT2');

    // ③ 未建成的行以 alert 告知，且 alert 正文点名「已建成的零件不要重新提交」
    expect(ElMessageBox.alert as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
    const alertText = String(
      (ElMessageBox.alert as ReturnType<typeof vi.fn>).mock.calls[0]![0],
    );
    expect(alertText).toContain('第 2 行');
    expect(alertText).toContain('不要重新提交');
    expect(captured.partialSubmitFailedRows.value).toBe(true);

    // ④ 不跳页（未建成的行还留在页面上要用户改）
    expect(mocks.routerReplace).not.toHaveBeenCalled();

    w.unmount();
  });

  it('onSubmit 全成功时复位 partialSubmitFailedRows（不带着上一批的 true 渲染下一批面板）', async () => {
    mocks.batchCreateParts.mockResolvedValue(okResult);
    const w = harnessMount();
    await flushPromises();
    if (!captured) throw new Error('not captured');

    await stageEntry(captured, 'LT1', 'bob');
    await captured.onSubmit();
    await drainSubmit();
    expect(captured.partialSubmitFailedRows.value).toBe(false);

    w.unmount();
  });

  // ⚠️ 提交进行中（上传阶段仍在 mutation 的 onSuccess 里跑）`staged` 被改动时，
  //   图纸**仍要传到正确的 ownerId**。改前 `runDrawingUploadPhase` 按可变的 `staged.value`
  //   回查 `created[].sourceIndex`，删掉前面某行会让后面下标左移 ⇒ A 的图纸挂到 B 上。
  it('提交进行中 staged 被删行：图纸按提交瞬间的快照回查，仍传到正确的 ownerId', async () => {
    let resolveBatch: (r: PartBatchResult) => void = () => {};
    mocks.batchCreateParts.mockReturnValueOnce(
      new Promise<PartBatchResult>((r) => {
        resolveBatch = r;
      }),
    );
    const w = harnessMount();
    await flushPromises();
    if (!captured) throw new Error('not captured');

    const fileA = new File([new Uint8Array([1])], 'a.pdf');
    const fileB = new File([new Uint8Array([2])], 'b.pdf');

    // 第 0 行（带图纸 a.pdf）
    captured.form.drawingNo = 'LT1';
    captured.form.name = 'p1';
    captured.form.customerId = 'c1';
    captured.form.applicantName = 'bob';
    captured.form.requestDate = '2026-09-24';
    captured.form.plannedDeliveryDate = '2026-09-25';
    captured.onDrawingFileChange(fileA);
    await captured.onAddConfirm();
    await nextTick();

    // 第 1 行（带图纸 b.pdf）
    captured.form.drawingNo = 'LT2';
    captured.form.name = 'p2';
    captured.onDrawingFileChange(fileB);
    await captured.onAddConfirm();
    await nextTick();
    expect(captured.staged.value.length).toBe(2);

    await captured.onSubmit();
    await flushPromises();
    expect(captured.submitting.value).toBe(true);

    // 提交在途：模拟 UI 漏了闸，删掉第 0 行（后面下标左移）
    captured.staged.value.splice(0, 1);
    expect(captured.staged.value[0]!.drawingNo).toBe('LT2');

    // 用**部分成功**（第 0 行建成、第 1 行未建成）才会走到「摘除已建成行」那一支
    resolveBatch(mixedResult);
    await drainSubmit();

    // ① 传的是**快照里第 0 行**那份图纸（a.pdf），不是左移后占着 0 的 LT2（b.pdf）
    expect(mocks.directUpload).toHaveBeenCalledTimes(1);
    const sent = mocks.directUpload.mock.calls[0]![0] as { file: File; ownerId: string };
    // happy-dom 的 File 跨 setup 边界不是同一引用，按 name 判身份（a.pdf / b.pdf 不重名）
    expect(sent.file.name).toBe('a.pdf');
    expect(sent.ownerId).toBe('p1');
    // ② 长度已错位 ⇒ 摘除走 uid 兜底：已建成的 LT1 按 uid 摘（它已被用户删掉、摘不到），
    //    **绝不能**把 LT2 当成 LT1 摘掉
    expect(captured.staged.value.map((e) => e.drawingNo)).toEqual(['LT2']);

    w.unmount();
  });

  // ⚠️ 提交进行中「删行」必须被 composable 拒掉 —— UI 的 `:disabled` 是第一道闸，
  //   状态机自身是第二道（UI 漏一个 disabled 不该静默降级成数据串行）。
  it('提交进行中 onRemoveRow 被拒（staged 不变、给出提示）', async () => {
    let resolveBatch: (r: PartBatchResult) => void = () => {};
    mocks.batchCreateParts.mockReturnValueOnce(
      new Promise<PartBatchResult>((r) => {
        resolveBatch = r;
      }),
    );
    const w = harnessMount();
    await flushPromises();
    if (!captured) throw new Error('not captured');

    await stageEntry(captured, 'LT1', 'bob');
    await captured.onSubmit();
    await flushPromises();
    expect(captured.submitting.value).toBe(true);

    captured.onRemoveRow(captured.staged.value[0]!.uid);
    expect(captured.staged.value.length).toBe(1);

    resolveBatch(okResult);
    await drainSubmit();
    w.unmount();
  });

  it('申请人缓存未命中：getOrCreateApplicant 被调、payload 带新 id', async () => {
    mocks.batchCreateParts.mockResolvedValue(okResult);
    mocks.getOrCreateApplicant.mockResolvedValue({ id: 'appl-new' });
    const w = harnessMount();
    await flushPromises();
    if (!captured) throw new Error('not captured');

    await stageEntry(captured, 'LT1', 'newface');

    // rootCustomerId 默认 null，applicantSearch.rootCustomerId.value 与解析出的
    // rootId（'c1'）不相等 ⇒ 缓存快路径判据不成立，必然走 getOrCreateApplicant。
    await captured.onSubmit();
    await drainSubmit();

    expect(mocks.getOrCreateApplicant).toHaveBeenCalledTimes(1);
    expect(mocks.getOrCreateApplicant).toHaveBeenCalledWith(
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
// 2026-10-17：新增订单页「申请人已存在」修复。
//
// 改前：`submitStagedEntries` 的申请人循环对每条缓存未命中的行走**非幂等**的
// `createApplicant`、且**没有 try/catch** ⇒
//   - 同批两行同名申请人 → 第二行 409 → 整个函数 reject → `batchCreateParts`
//     根本不执行 → **整批订单全废**；
//   - 任意一行申请人接口抖动 / 挂掉 → 同样整批报废。
//
// 改后：走幂等端点 `getOrCreateApplicant`，且每行独立 try/catch（失败只 warn）。
// ============================================================================

/** 幂等端点的返回行（字段对齐 `types/applicant.ts` 的 `Applicant`）。 */
function applicantFixture(id: string, name: string, customerId: string): Applicant {
  return {
    id,
    version: 1,
    name,
    customer_id: customerId,
    customer_name: '客户A',
    created_at: '2026-10-17 08:00:00',
    updated_at: '2026-10-17 08:00:00',
  };
}

describe('usePartBatchManual：申请人幂等解析（2026-10-17）', () => {
  it('同批两行同名申请人：两行拿到同一个 id、端点只调一次、整批照常提交', async () => {
    mocks.batchCreateParts.mockResolvedValue(okResult);
    // 预置「缓存属于 c1、但里面还没有这个申请人」⇒ 第一行走网络、第二行走回写后的快路径
    rootCustomerIdRef.value = 'c1';
    applicantsRef.value = [];
    mocks.getOrCreateApplicant.mockResolvedValue(applicantFixture('appl-dup', 'dup', 'c1'));

    const w = harnessMount();
    await flushPromises();
    if (!captured) throw new Error('not captured');

    // 两行同一客户、同一申请人姓名；第二行的 applicantId 仍是 null（未走下拉选中）
    await stageEntry(captured, 'LT-1', 'dup');
    await stageEntry(captured, 'LT-2', 'dup');
    expect(captured.staged.value.map((s) => s.applicantId)).toEqual([null, null]);

    await captured.onSubmit();
    await drainSubmit();

    // (a) 两行都拿到同一个 applicantId
    const sent = mocks.batchCreateParts.mock.calls[0]![0] as Array<{ applicant_id: string | null }>;
    expect(mocks.batchCreateParts).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(2);
    expect(sent.map((it) => it.applicant_id)).toEqual(['appl-dup', 'appl-dup']);

    // 幂等端点只被调一次（第二行命中第一行回写进缓存的快路径）
    expect(mocks.getOrCreateApplicant).toHaveBeenCalledTimes(1);
    expect(mocks.getOrCreateApplicant).toHaveBeenCalledWith({ name: 'dup', customer_id: 'c1' });

    // 新申请人已回写进同 root 的缓存，供本批后续行 / 下一批复用
    expect(applicantsRef.value.map((a) => a.id)).toEqual(['appl-dup']);

    w.unmount();
  });

  it('幂等端点 reject：该行 applicantId 留 null，但 batchCreateParts 仍被调、不抛错', async () => {
    mocks.batchCreateParts.mockResolvedValue(okResult);
    rootCustomerIdRef.value = 'c1';
    applicantsRef.value = [];
    mocks.getOrCreateApplicant.mockRejectedValue(new Error('applicant 500'));

    const w = harnessMount();
    await flushPromises();
    if (!captured) throw new Error('not captured');

    await stageEntry(captured, 'LT-1', 'boom');
    // 关键：onSubmit 本身必须**不** reject（原 bug 就是这里 reject → 整批全废）
    await expect(captured.onSubmit()).resolves.toBeUndefined();
    await drainSubmit();

    // 整批照常提交，申请人 id 留空
    const sent = mocks.batchCreateParts.mock.calls[0]![0] as Array<{
      applicant_id: string | null;
      applicant_name: string;
    }>;
    expect(mocks.batchCreateParts).toHaveBeenCalledTimes(1);
    expect(sent[0]!.applicant_id).toBeNull();
    // 后端 PartBatchCreateItem 没有 applicant_id 字段（applicant_name 是自由文本、
    // 直接落 t_part.applicant_name）⇒ 名字照发，工单照建。
    expect(sent[0]!.applicant_name).toBe('boom');

    // 失败必须**有告警**，不许静默吞
    const warned = mocks.warn.mock.calls.map((c: unknown[]) => c.map(String).join(' '));
    expect(warned.some((line: string) => line.includes('boom'))).toBe(true);

    // 失败行不写缓存（避免把半截数据喂给后续行的快路径）
    expect(applicantsRef.value).toEqual([]);

    w.unmount();
  });

  it('一行失败不牵连同批其它行：成功行走端点拿到 id，失败行留空，两行都在 payload 里', async () => {
    mocks.batchCreateParts.mockResolvedValue(okResult);
    rootCustomerIdRef.value = 'c1';
    applicantsRef.value = [];
    mocks.getOrCreateApplicant
      .mockRejectedValueOnce(new Error('applicant 500'))
      .mockResolvedValueOnce(applicantFixture('appl-ok', 'good', 'c1'));

    const w = harnessMount();
    await flushPromises();
    if (!captured) throw new Error('not captured');

    await stageEntry(captured, 'LT-1', 'bad');
    await stageEntry(captured, 'LT-2', 'good');

    await captured.onSubmit();
    await drainSubmit();

    const sent = mocks.batchCreateParts.mock.calls[0]![0] as Array<{
      drawing_no: string;
      applicant_id: string | null;
    }>;
    expect(mocks.batchCreateParts).toHaveBeenCalledTimes(1);
    expect(sent.map((it) => [it.drawing_no, it.applicant_id])).toEqual([
      ['LT-1', null],
      ['LT-2', 'appl-ok'],
    ]);

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
