// @vitest-environment happy-dom
// src/views/com/delivery/utils/__tests__/deliveryNoteTemplate.spec.ts
//
// 2026-10-08 新增：模板逐格校验的守卫。模板一列错位，导出的送货单在客户那边就是废纸，
// 而 Zod strip 模式不会报错、只会静默丢字段 ⇒ 必须靠这里的逐条差异把用户自己看出
// 「改错了哪一格」。
//
// 覆盖（零件版）：正确模板返空数组 / 缺 placeholder / 旧名 {{L2_customer}} / 列位错位 /
// 缺 sheet。
//
// 2026-10-16 两批追加：
//   · `fetchTemplateBytes` 的三种 `TemplateSource` 变体（重点是 `api` 变体必须走后端 axios
//     端点而不是裸 `fetch` —— 后者带不上 Authorization 头，必然 401）；
//   · 检具版一批：两份内置检具模板逐格通过 + 三类坏模板各出一差异（改坏 row5 占位符 /
//     删掉 I2 的 {{delivery_date}} / A 列中间一格不是 {{no}}）。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type * as Hucre from 'hucre/xlsx';

// ⚠️ 整个 api 模块桩掉：`deliveryNoteTemplate.ts` 的 `api` 变体要从它那里取字节，而它是
// axios 客户端 —— 组件测试里真拉一次网络既慢又不稳。这里只断言「打了哪个 id」。
const { fetchPrintTemplateContentMock } = vi.hoisted(() => ({
  fetchPrintTemplateContentMock: vi.fn(async (id: string) => new Uint8Array([7, 7, id.length])),
}));

vi.mock('@/api/printTemplates', () => ({
  fetchPrintTemplateContent: (id: string) => fetchPrintTemplateContentMock(id),
}));

const { assertTemplateMatches, colIndexOf, fetchTemplateBytes } = await import(
  '../deliveryNoteTemplate'
);
const { GAUGE_DELIVERY_NOTE_TEMPLATE_CONTRACT } = await import(
  '../deliveryNoteTemplateContract'
);

beforeEach(() => {
  fetchPrintTemplateContentMock.mockClear();
});

/** 内置零件版模板（法拉）。 */
const PART_BUILTIN = readFileSync('templates/delivery_note_fala.xlsx');

/** 两份内置检具模板（百路达 / 杏南）。哪几项一致、哪几项不同以契约文件头那份「一致 /
 * 不一致」清单为准（deliveryNoteTemplateContract.ts）—— 这里不复述一份，两处各写各的
 * 迟早对不上。 */
const GAUGE_BUILTINS = [
  'templates/delivery_note_gauge_bailuda.xlsx',
  'templates/delivery_note_gauge_xingnan.xlsx',
] as const;

/** 从内置零件版模板复制一份，改指定单元格后交给校验（不落盘，纯内存）。 */
async function openWithEdits(
  edits: (sheet: { rows: unknown[][] }) => void,
): Promise<Hucre.Workbook> {
  const { openXlsx, saveXlsx } = await import('hucre');
  const wb = await openXlsx(new Uint8Array(PART_BUILTIN));
  const sheet = wb.sheets[0];
  sheet.rows = sheet.rows.map((r) => [...r]);
  edits(sheet);
  // save → open 走一圈，确保编辑真的落到 hucre 读得到的位置（而不是被自己忽略）。
  return await openXlsx(await saveXlsx(wb));
}

/** 检具版同款：复制内置检具模板再改格（默认百路达那份）。 */
async function openGaugeWithEdits(
  edits: (sheet: { rows: unknown[][] }) => void,
  file: (typeof GAUGE_BUILTINS)[number] = GAUGE_BUILTINS[0],
): Promise<Hucre.Workbook> {
  const { openXlsx, saveXlsx } = await import('hucre');
  const wb = await openXlsx(new Uint8Array(readFileSync(file)));
  const sheet = wb.sheets[0];
  sheet.rows = sheet.rows.map((r) => [...r]);
  edits(sheet);
  return await openXlsx(await saveXlsx(wb));
}

describe('assertTemplateMatches', () => {
  it('内置模板逐格校验通过（空数组）', async () => {
    const { openXlsx } = await import('hucre');
    const diffs = await assertTemplateMatches(await openXlsx(new Uint8Array(PART_BUILTIN)));
    expect(diffs).toEqual([]);
  });

  it('缺 placeholder（B3 改成原标题）→ 逐条差异', async () => {
    const wb = await openWithEdits((s) => {
      s.rows[2]![1] = '原标题';
    });
    const diffs = await assertTemplateMatches(wb);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toContain('B3 期望 {{order_no}}');
    expect(diffs[0]).toContain('原标题');
  });

  it('旧名 {{L2_customer}} → 差异（本次改名就是为了这条）', async () => {
    const wb = await openWithEdits((s) => {
      s.rows[2]![2] = '{{L2_customer}}';
    });
    const diffs = await assertTemplateMatches(wb);
    expect(diffs.some((d) => d.includes('C3') && d.includes('{{l2_customer}}'))).toBe(true);
  });

  it('列位错位（A3 缺 {{no}}）→ 差异', async () => {
    const wb = await openWithEdits((s) => {
      s.rows[2]![0] = '';
    });
    const diffs = await assertTemplateMatches(wb);
    expect(diffs.some((d) => d.startsWith('A3'))).toBe(true);
  });

  it('序号列缺一格（第 12 行 A12 空）→ 差异只报那一格', async () => {
    const wb = await openWithEdits((s) => {
      s.rows[11]![0] = '';
    });
    const diffs = await assertTemplateMatches(wb);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toContain('A12');
  });

  it('页脚占位符被删（F15 / A17）→ 两条差异', async () => {
    const wb = await openWithEdits((s) => {
      s.rows[14]![5] = '送货人：';
      s.rows[16]![0] = '送货日期';
    });
    const diffs = await assertTemplateMatches(wb);
    expect(diffs.some((d) => d.includes('F15'))).toBe(true);
    expect(diffs.filter((d) => d.includes('A17')).length).toBe(3);
  });

  it('缺工作表 → 一条差异，不抛', async () => {
    const { openXlsx } = await import('hucre');
    const wb = await openXlsx(new Uint8Array(PART_BUILTIN));
    (wb as unknown as { sheets: unknown[] }).sheets = [];
    const diffs = await assertTemplateMatches(wb);
    expect(diffs).toEqual(['缺少第 1 个工作表（模板必须是单 sheet 结构）']);
  });
});

describe('colIndexOf', () => {
  it('A → 0，J → 9', () => {
    expect(colIndexOf('A')).toBe(0);
    expect(colIndexOf('J')).toBe(9);
  });

  it('非单字母列抛错（AA 会被静默当成 A ⇒ 值写错列且不发错）', () => {
    expect(() => colIndexOf('AA')).toThrow();
    expect(() => colIndexOf('a')).toThrow();
    expect(() => colIndexOf('')).toThrow();
  });
});

describe('fetchTemplateBytes', () => {
  it('api 变体：按 id 走后端取字节（不带 Authorization 的裸 fetch 在这里是错的）', async () => {
    const bytes = await fetchTemplateBytes({ kind: 'api', id: 'T1' });
    expect(fetchPrintTemplateContentMock).toHaveBeenCalledWith('T1');
    // 桩按 id 长度造字节：长度对上就说明传下去的是那个 id，而不是丢了 id 拿了别的东西
    expect(Array.from(bytes)).toEqual([7, 7, 2]);
  });

  it('local 变体：直接给回字节，零请求', async () => {
    const raw = new Uint8Array([1, 2, 3]);
    const bytes = await fetchTemplateBytes({ kind: 'local', bytes: raw, filename: 'a.xlsx' });
    expect(bytes).toBe(raw);
    expect(fetchPrintTemplateContentMock).not.toHaveBeenCalled();
  });

  it('url 变体：仍然走裸 fetch（预留形态，本次不动它的语义）', async () => {
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (u: string) => {
      calls.push(u);
      return new Response(new Uint8Array([9]));
    }) as unknown as typeof fetch;
    try {
      const bytes = await fetchTemplateBytes({ kind: 'url', url: 'https://example.test/t.xlsx' });
      expect(calls).toEqual(['https://example.test/t.xlsx']);
      expect(Array.from(bytes)).toEqual([9]);
      expect(fetchPrintTemplateContentMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ============================================================
// 检具版（2026-10-16 新增）
// ============================================================
describe('assertTemplateMatches（检具版）', () => {
  it.each(GAUGE_BUILTINS)('内置检具模板逐格校验通过（空数组）：%s', async (file) => {
    const { openXlsx } = await import('hucre');
    const wb = await openXlsx(new Uint8Array(readFileSync(file)));
    const diffs = await assertTemplateMatches(wb, GAUGE_DELIVERY_NOTE_TEMPLATE_CONTRACT);
    expect(diffs).toEqual([]);
  });

  it('row5 的占位符被改坏 → 差异含单元格引用与实际值', async () => {
    const wb = await openGaugeWithEdits((s) => {
      s.rows[4]![1] = '原订单号';
    });
    const diffs = await assertTemplateMatches(wb, GAUGE_DELIVERY_NOTE_TEMPLATE_CONTRACT);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toContain('B5 期望 {{order_no}}');
    expect(diffs[0]).toContain('原订单号');
  });

  it('I2 的 {{delivery_date}} 被删 → 差异', async () => {
    const wb = await openGaugeWithEdits((s) => {
      s.rows[1]![8] = '送货日期';
    });
    const diffs = await assertTemplateMatches(wb, GAUGE_DELIVERY_NOTE_TEMPLATE_CONTRACT);
    expect(diffs).toEqual(['I2 应包含 {{delivery_date}}']);
  });

  it('A 列中间某格不是 {{no}}（A15）→ 差异只报那一格', async () => {
    const wb = await openGaugeWithEdits((s) => {
      s.rows[14]![0] = '3';
    });
    const diffs = await assertTemplateMatches(wb, GAUGE_DELIVERY_NOTE_TEMPLATE_CONTRACT);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toContain('A15 期望 {{no}}');
    expect(diffs[0]).toContain('3');
  });

  it('缺工作表 → 一条差异，不抛（两套版式共用同一条判据）', async () => {
    const { openXlsx } = await import('hucre');
    const wb = await openXlsx(new Uint8Array(readFileSync(GAUGE_BUILTINS[0])));
    (wb as unknown as { sheets: unknown[] }).sheets = [];
    const diffs = await assertTemplateMatches(wb, GAUGE_DELIVERY_NOTE_TEMPLATE_CONTRACT);
    expect(diffs).toEqual(['缺少第 1 个工作表（模板必须是单 sheet 结构）']);
  });
});