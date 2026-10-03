// src/views/outsource/composables/__tests__/useOutsourceQuoteForm.spec.ts
//
// 2026-10-03 新增：新建报价 picker 的「选中零件 → 自动填工序」契约守卫。
//
// 为什么锁这里：`GET /outsource-quotes/quotable-parts` 的行粒度是
// 「一个 (零件, OUTSOURCE 工序) 组合一行」（后端 `DISTINCT ON (part_id, next_process_id)`
// 已去重），所以**同一 part_id 可以出多行**。前端一度按 part_id 查表取第一行来填
// 工序：多行时 el-option 出现重复 key，且自动填的是第一行的工序 —— 操作员点了第二行，
// 系统却按第一行的工序建报价，且**没有任何提示**。现在重复 key 走组合键修掉，
// 多行填工序改为显式提示手动选。本文件把两条都钉死。

import { beforeEach, describe, expect, it, vi } from 'vitest';

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

import type { Process } from '@/types/process';
import type { QuotablePart } from '@/types/outsource';
import { useOutsourceQuoteForm, quotablePartRowKey } from '../useOutsourceQuoteForm';

/** 一条 picker 行（只填用例关心的字段，其余给合法占位）。 */
function part(overrides: Partial<QuotablePart> = {}): QuotablePart {
  return {
    id: 'P1',
    serial_no: 'SN-1',
    drawing_no: 'DWG-1',
    name: '零件甲',
    is_urgent: false,
    unit_price: '100.00',
    customer_id: 'C1',
    customer_name: '客户乙',
    l1_customer_name: '客户甲',
    customer_path: '客户甲/客户乙',
    shelf_id: 'SH-A',
    shelf_code: 'C2',
    next_process_id: 'PR-OUT-1',
    next_process_name: '外协粗加工',
    ...overrides,
  };
}

function processRow(id: string, category: Process['category'], name: string): Process {
  return { id, code: id, name, category, sort_order: 0, is_active: true } as unknown as Process;
}

const processes: Process[] = [
  processRow('PR-OUT-1', 'OUTSOURCE', '外协粗加工'),
  processRow('PR-OUT-2', 'OUTSOURCE', '外协精加工'),
  processRow('PR-IN-1', 'INHOUSE', '钻孔'),
];

function makeForm(parts: QuotablePart[]) {
  return useOutsourceQuoteForm({
    parts: () => parts,
    processes: () => processes,
    refresh: vi.fn(),
  });
}

beforeEach(() => {
  listCompaniesByProcessMock.mockReset();
  listCompaniesByProcessMock.mockResolvedValue([{ id: 'CO1', name: '外协厂' }]);
  vi.mocked(ElMessage.info).mockClear();
});

describe('quotablePartRowKey', () => {
  it('Q1：同一零件的两个外协工序行 → 两个不同的组合键（picker 的 :key 不再重复）', () => {
    const rowA = part({ next_process_id: 'PR-OUT-1' });
    const rowB = part({ next_process_id: 'PR-OUT-2', shelf_code: 'C3' });

    expect(quotablePartRowKey(rowA)).not.toBe(quotablePartRowKey(rowB));
  });
});

describe('onCreatePartChange', () => {
  it('Q2：单行 + next_process 是外协工序 → 自动填该行工序并级联拉公司', () => {
    const form = makeForm([part()]);

    form.onCreatePartChange('P1');

    expect(form.createForm.process_id).toBe('PR-OUT-1');
    expect(listCompaniesByProcessMock).toHaveBeenCalledWith('PR-OUT-1');
  });

  it('Q3：换零件时先清掉上一零件留下的工序与公司（不残留脏选择）', () => {
    const form = makeForm([part(), part({ id: 'P2', next_process_id: 'PR-OUT-2' })]);

    form.onCreatePartChange('P1');
    form.createForm.outsource_company_id = 'CO1';

    form.onCreatePartChange('P2');
    expect(form.createForm.outsource_company_id).toBe('');
    expect(form.createForm.process_id).toBe('PR-OUT-2');
  });

  // 核心守卫：同零件多行时**不许**任取一行填工序（那会静默建出错工序的报价）。
  it('Q4：同零件多行 → 不自动填 + 提示手动选工序（不静默取第一行）', () => {
    const form = makeForm([
      part({ next_process_id: 'PR-OUT-1' }),
      part({ next_process_id: 'PR-OUT-2', shelf_code: 'C3' }),
    ]);

    form.onCreatePartChange('P1');

    expect(form.createForm.process_id).toBe('');
    expect(ElMessage.info).toHaveBeenCalledWith('该零件对应多个外协工序，请手动选择工序');
    expect(listCompaniesByProcessMock).not.toHaveBeenCalled();
  });

  it('Q5：next_process 类别非 OUTSOURCE → 不自动填 + 提示手动选择', () => {
    const form = makeForm([part({ next_process_id: 'PR-IN-1', next_process_name: '钻孔' })]);

    form.onCreatePartChange('P1');

    expect(form.createForm.process_id).toBe('');
    expect(ElMessage.info).toHaveBeenCalledWith('该零件的下一工序不是外协工序，请手动选择');
  });

  it('Q6：part_id 查不到任何行 → 静默清空，不误报「未设置下一工序」', () => {
    const form = makeForm([part()]);

    form.onCreatePartChange('P404');

    expect(form.createForm.process_id).toBe('');
    expect(ElMessage.info).not.toHaveBeenCalled();
  });

  it('Q7：next_process_id 为空串 → 提示手动选择（不自动填）', () => {
    const form = makeForm([part({ next_process_id: '', next_process_name: '' })]);

    form.onCreatePartChange('P1');

    expect(form.createForm.process_id).toBe('');
    expect(ElMessage.info).toHaveBeenCalledWith('该零件未设置下一工序，请手动选择');
  });
});
