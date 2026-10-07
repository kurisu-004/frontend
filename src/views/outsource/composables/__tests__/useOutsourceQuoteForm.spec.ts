// src/views/outsource/composables/__tests__/useOutsourceQuoteForm.spec.ts
//
// 2026-10-03 契约对齐后重写：新建报价 picker 的候选源是「有活跃 PENDING 批次的
// 在制件」，行粒度是**一个零件一行**，VO 不带工序 / 货架字段 ⇒ picker 无从推断报价
// 工序（无数据通路）。本文件锁「换零件必清空工序与公司」—— 这两步清空是必须保留的：
// `process_id` 不清会沿用上一零件的工序（el-select 的 :value 只按 part_id 匹配，
// 改零件不会自动清它），`outsource_company_id` 不清会残留一个与新工序无隶属关系的
// 公司。零件唯一化让「label 暗示工序 A、实际手选工序 B」的串号隐患不复存在。
//
// 2026-10-09 六条写路径改 useMutation 后新增三组断言：
//   - payload 必含 `version`（submit / soft-delete 的后端必填 OCC 锚）；
//   - 写成功走 `invalidateOutsourceQuotesAll`（前缀失效）而不是手工 refresh 回调；
//   - 新建表单校验走 Zod（`OutsourceQuoteFormSchema`），单价 ≤ 0 时不发请求。
// composable 现在用 `useQueryClient` / `useMutation`，故测试要 `createApp` +
// `VueQueryPlugin`（见 CLAUDE.md 的 vue-query 测试形态）。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, effectScope, nextTick } from 'vue';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';

// node env 下真实 ElMessage 会因 `document is not defined` 污染输出（CLAUDE.md 约定）。
vi.mock('element-plus', () => ({
  ElMessage: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

const listCompaniesByProcessMock = vi.fn();
const listOutsourceQuotesMock = vi.fn();
const createMock = vi.fn();
const submitMock = vi.fn();
const softDeleteMock = vi.fn();

vi.mock('@/api/outsource', () => ({
  createOutsourceQuote: (...args: unknown[]) => createMock(...args),
  approveOutsourceQuote: vi.fn(),
  rejectOutsourceQuote: vi.fn(),
  softDeleteOutsourceQuote: (...args: unknown[]) => softDeleteMock(...args),
  submitOutsourceQuote: (...args: unknown[]) => submitMock(...args),
  listCompaniesByProcess: (...args: unknown[]) => listCompaniesByProcessMock(...args),
  listOutsourceQuotes: (...args: unknown[]) => listOutsourceQuotesMock(...args),
}));

vi.mock('@/composables/useConfirm', () => ({
  useConfirm: () => ({ dangerous: vi.fn(async () => true) }),
}));

const { ElMessage } = await import('element-plus');

import { useOutsourceQuoteForm } from '../useOutsourceQuoteForm';
import type { OutsourceQuote } from '@/types/outsource';

let testApp: ReturnType<typeof createApp>;
let testQueryClient: QueryClient;

/** 在 effectScope + `runWithContext` 里跑一遍 composable（拿到真实 useMutation 生命周期）。 */
function makeForm(): ReturnType<typeof useOutsourceQuoteForm> {
  const scope = effectScope();
  let form!: ReturnType<typeof useOutsourceQuoteForm>;
  scope.run(() => {
    form = testApp.runWithContext(() => useOutsourceQuoteForm());
  });
  return form;
}

function makeQuote(overrides: Partial<OutsourceQuote> = {}): OutsourceQuote {
  return {
    id: 'Q1',
    version: 5,
    part_id: 'P1',
    outsource_company_id: 'CO1',
    process_id: 'PR-OUT-1',
    price: '12.50',
    note: null,
    status: 'DRAFT',
    submitted_at: null,
    reviewed_at: null,
    review_note: null,
    created_at: '2026-10-01T08:00:00',
    updated_at: '2026-10-01T08:00:00',
    part_serial_no: 'SN-1',
    part_drawing_no: 'DWG-1',
    part_name: '零件甲',
    outsource_company_name: '外协厂',
    process_code: 'PPSEND',
    process_name: '外协-切割',
    customer_path: '一级/二级',
    part_unit_price: '100.00',
    is_urgent: false,
    ...overrides,
  };
}

beforeEach(() => {
  listCompaniesByProcessMock.mockReset();
  listCompaniesByProcessMock.mockResolvedValue([{ id: 'CO1', name: '外协厂' }]);
  createMock.mockReset();
  createMock.mockResolvedValue(makeQuote());
  submitMock.mockReset();
  submitMock.mockResolvedValue(makeQuote({ status: 'SUBMITTED' }));
  softDeleteMock.mockReset();
  softDeleteMock.mockResolvedValue(undefined);
  listOutsourceQuotesMock.mockReset();
  listOutsourceQuotesMock.mockResolvedValue({ items: [], total: 0, limit: 20, offset: 0 });
  vi.mocked(ElMessage.info).mockClear();
  testQueryClient = new QueryClient({
    defaultOptions: { mutations: { retry: 0 }, queries: { retry: 0 } },
  });
  testApp = createApp({});
  testApp.use(VueQueryPlugin, { queryClient: testQueryClient });
});

describe('onCreatePartChange', () => {
  it('Q1：换零件 → 工序被清空（不沿用上一零件的工序）', () => {
    const form = makeForm();
    form.createForm.process_id = 'PR-OUT-1';

    form.onCreatePartChange('P2');

    expect(form.createForm.process_id).toBe('');
  });

  it('Q2：换零件 → 外协公司被清空（不残留与新工序无隶属关系的公司）', () => {
    const form = makeForm();
    form.createForm.outsource_company_id = 'CO1';

    form.onCreatePartChange('P2');

    expect(form.createForm.outsource_company_id).toBe('');
  });

  // 回归锁：清空 `process_id` 会触发 watch 里的级联，把上一个工序的可选公司一并清掉
  // —— 不清的话公司下拉里留着与新工序无隶属关系的公司，操作员能选到错配项。
  it('Q3：清空工序连带清空已加载的公司列表（级联不失效）', async () => {
    const form = makeForm();
    form.createForm.process_id = 'PR-OUT-1';
    await nextTick();
    await vi.waitFor(() => expect(form.companies.value).toHaveLength(1));

    form.onCreatePartChange('P2');
    await nextTick();

    expect(form.companies.value).toEqual([]);
  });

  // 回归锁：不得再有「按零件反推工序」这条数据通路（VO 已无 next_process_id），
  // 任何自动填/自动级联都会静默建出错工序的报价。
  it('Q4：不自动填工序、不弹提示（工序一律手选）', () => {
    const form = makeForm();

    form.onCreatePartChange('P1');

    expect(form.createForm.process_id).toBe('');
    expect(ElMessage.info).not.toHaveBeenCalled();
  });
});

describe('六条写路径的 payload 与失效', () => {
  // ⚠️ submit 的 body 必含 version（后端 `OutsourceQuoteSubmitRequest.version` 无
  // `#[serde(default)]` ⇒ 缺传是 HTTP 422 纯文本）。这是本轮修掉的第二类线上缺陷
  // （第一类是公司 update 漏传 version）。
  it('Q5：提交审核 → payload 带 version（OCC 锚）', async () => {
    const form = makeForm();
    await form.onSubmit(makeQuote({ id: 'Q7', version: 9 }));
    expect(submitMock).toHaveBeenCalledWith('Q7', { version: 9 });
  });

  it('Q6：软删 → payload 带 version', async () => {
    const form = makeForm();
    await form.onDelete(makeQuote({ id: 'Q8', version: 4 }));
    expect(softDeleteMock).toHaveBeenCalledWith('Q8', { version: 4 });
  });

  it('Q7：写成功后失效报价域（走 qk.outsourceQuotesPrefix 前缀）', async () => {
    const invalidateSpy = vi.spyOn(testQueryClient, 'invalidateQueries');
    const form = makeForm();
    await form.onSubmit(makeQuote());
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['outsource', 'quotes'] });
  });
});

// 写路径的错误处理：`mutateAsync` 失败时 reject，错误文案由 mutation 的 onError 弹。
// 调用侧（OutsourceQuoteList 的 `@confirm` / `void form.onSubmit`）是裸接，包装层不兜
// 就是每次写失败多一条 unhandledrejection。
describe('写失败：包装吞掉 rejection（onError 已提示）', () => {
  it('Q7a：submit 失败 → 包装 resolve、ElMessage.error 一次、不产生未捕获 rejection', async () => {
    submitMock.mockRejectedValueOnce(new Error('40901 乐观锁冲突'));
    const form = makeForm();

    await expect(form.onSubmit(makeQuote())).resolves.toBeUndefined();
    expect(ElMessage.error).toHaveBeenCalledWith('40901 乐观锁冲突');
  });

  it('Q7b：soft-delete 失败 → 包装 resolve、ElMessage.error 一次', async () => {
    softDeleteMock.mockRejectedValueOnce(new Error('删除失败'));
    const form = makeForm();

    await expect(form.onDelete(makeQuote())).resolves.toBeUndefined();
    expect(ElMessage.error).toHaveBeenCalledWith('删除失败');
  });

  it('Q7c：create 失败 → 包装 resolve、弹窗保持打开（用户改完可重试）', async () => {
    createMock.mockRejectedValueOnce(new Error('创建失败'));
    const form = makeForm();
    form.openCreate();
    Object.assign(form.createForm, {
      part_id: 'P1',
      outsource_company_id: 'CO1',
      process_id: 'PR-OUT-1',
      price: '12.50',
    });

    await expect(form.onCreate()).resolves.toBeUndefined();
    expect(form.showCreate.value).toBe(true);
    expect(ElMessage.error).toHaveBeenCalledWith('创建失败');
  });
});

// 失效链的唯一性：写成功后的刷新只走 invalidateOutsourceQuotesAll（内部已 refetch 活跃
// query）。以前还叠一条 caller 的 refresh 回调（= 再次 refetch）⇒ 每次写成功打两次列表
// 请求。这条用「活跃 query 的请求计数」钉死。
describe('写成功后的刷新次数', () => {
  it('Q7d：一次写成功只重拉一次列表（失效已含 refetch，不再叠 refresh 回调）', async () => {
    const { useOutsourceQuotesQuery } = await import('../useOutsourceQuotesQuery');
    const scope = effectScope();
    scope.run(() => {
      testApp.runWithContext(() => useOutsourceQuoteForm());
      testApp.runWithContext(() =>
        useOutsourceQuotesQuery({ params: { limit: 20, offset: 0 }, enabled: true }),
      );
    });
    await vi.waitFor(() => expect(listOutsourceQuotesMock).toHaveBeenCalledTimes(1));

    const scope2 = effectScope();
    const form = scope2.run(() => testApp.runWithContext(() => useOutsourceQuoteForm()))!;
    listOutsourceQuotesMock.mockClear();
    await form.onSubmit(makeQuote());

    // 先等第一次落地，再留一段静默窗口让第二次 refetch 有机会发生，最后数总量。
    await vi.waitFor(() => expect(listOutsourceQuotesMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 50));
    expect(listOutsourceQuotesMock).toHaveBeenCalledTimes(1);
  });
});

describe('新建表单校验（Zod）', () => {
  it('Q8：单价 ≤ 0 → 字段报错且不发请求（0 价报价在可发送列表里永远匹配不上审批价）', async () => {
    const form = makeForm();
    Object.assign(form.createForm, {
      part_id: 'P1',
      outsource_company_id: 'CO1',
      process_id: 'PR-OUT-1',
      price: '0',
    });

    await form.onCreate();

    expect(createMock).not.toHaveBeenCalled();
    expect(form.createFieldErrors.value.price).toBe('单价必须大于 0');
  });

  it('Q9：必填项缺失 → 每个缺项都有字段报错', async () => {
    const form = makeForm();
    Object.assign(form.createForm, { part_id: '', outsource_company_id: '', process_id: '' });

    await form.onCreate();

    expect(createMock).not.toHaveBeenCalled();
    expect(form.createFieldErrors.value.part_id).toBe('请选择零件');
    expect(form.createFieldErrors.value.outsource_company_id).toBe('请选择外协公司');
    expect(form.createFieldErrors.value.process_id).toBe('请选择工序');
  });

  it('Q10：合法输入 → 发请求且价格原样传字符串（后端入参是 Decimal 串）', async () => {
    const form = makeForm();
    Object.assign(form.createForm, {
      part_id: 'P1',
      outsource_company_id: 'CO1',
      process_id: 'PR-OUT-1',
      price: '12.50',
      note: '   ',
    });

    await form.onCreate();

    expect(createMock).toHaveBeenCalledWith({
      part_id: 'P1',
      outsource_company_id: 'CO1',
      process_id: 'PR-OUT-1',
      price: '12.50',
      // 空白备注归一成 null（空串与 null 语义相同但不归一会让列表里出现「备注是一个空格」）
      note: null,
    });
  });
});