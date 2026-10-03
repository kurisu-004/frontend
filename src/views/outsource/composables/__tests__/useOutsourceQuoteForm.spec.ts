// src/views/outsource/composables/__tests__/useOutsourceQuoteForm.spec.ts
//
// 2026-10-03 契约对齐后重写：新建报价 picker 的候选源改成「有活跃 PENDING 批次的
// 在制件」，行粒度是**一个零件一行**，VO 不再带工序 / 货架字段。原先锁的
// 「选中零件 → 自动填工序」通路（`QuotablePart.next_process_id`）随之下线，改锁
// 「换零件必清空工序与公司」—— 这两步清空是必须保留的：`process_id` 不清会沿用上一
// 零件的工序（el-select 的 :value 只按 part_id 匹配，改零件不会自动清它），
// `outsource_company_id` 不清会残留一个与新工序无隶属关系的公司。
//
// 顺带记一笔：改前 picker 同零件可出多行，而 el-select 的 :value 是裸 part_id，
// 于是 label 暗示工序 A、实际手选工序 B 的串号隐患一直存在（登记在
// OutsourceQuoteCreateDialog.vue 与 useOutsourceQuoteForm.ts 的注释里）。改成一
// 零件一行后该隐患自动消失，无需额外处理。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';

// node env 下真实 ElMessage 会因 `document is not defined` 污染输出（CLAUDE.md 约定）。
vi.mock('element-plus', () => ({
  ElMessage: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

const listCompaniesByProcessMock = vi.fn();

vi.mock('@/api/outsource', () => ({
  createOutsourceQuote: vi.fn(),
  approveOutsourceQuote: vi.fn(),
  rejectOutsourceQuote: vi.fn(),
  softDeleteOutsourceQuote: vi.fn(),
  submitOutsourceQuote: vi.fn(),
  listCompaniesByProcess: (...args: unknown[]) => listCompaniesByProcessMock(...args),
}));

vi.mock('@/composables/useConfirm', () => ({
  useConfirm: () => ({ dangerous: vi.fn(async () => true) }),
}));

const { ElMessage } = await import('element-plus');

import { useOutsourceQuoteForm } from '../useOutsourceQuoteForm';

function makeForm() {
  return useOutsourceQuoteForm({ refresh: vi.fn() });
}

beforeEach(() => {
  listCompaniesByProcessMock.mockReset();
  listCompaniesByProcessMock.mockResolvedValue([{ id: 'CO1', name: '外协厂' }]);
  vi.mocked(ElMessage.info).mockClear();
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
