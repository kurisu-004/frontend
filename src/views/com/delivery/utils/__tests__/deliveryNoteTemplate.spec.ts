// @vitest-environment happy-dom
// src/views/com/delivery/utils/__tests__/deliveryNoteTemplate.spec.ts
//
// 2026-10-08 新增：模板逐格校验的守卫。模板一列错位，导出的送货单在客户那边就是废纸，
// 而 Zod strip 模式不会报错、只会静默丢字段 ⇒ 必须靠这里的逐条差异把用户自己看出
// 「改错了哪一格」。
//
// 覆盖：正确模板返空数组 / 缺 placeholder / 旧名 {{L2_customer}} / 列位错位 / 缺 sheet。

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type * as Hucre from 'hucre/xlsx';
import { assertTemplateMatches, colIndexOf } from '../deliveryNoteTemplate';

const BUILTIN = readFileSync('templates/delivery_note_fala.xlsx');

/** 从内置模板复制一份，改指定单元格后交给校验（不落盘，纯内存）。 */
async function openWithEdits(
  edits: (sheet: { rows: unknown[][] }) => void,
): Promise<Hucre.Workbook> {
  const { openXlsx, saveXlsx } = await import('hucre');
  const wb = await openXlsx(new Uint8Array(BUILTIN));
  const sheet = wb.sheets[0];
  sheet.rows = sheet.rows.map((r) => [...r]);
  edits(sheet);
  // save → open 走一圈，确保编辑真的落到 hucre 读得到的位置（而不是被自己忽略）。
  return await openXlsx(await saveXlsx(wb));
}

describe('assertTemplateMatches', () => {
  it('内置模板逐格校验通过（空数组）', async () => {
    const { openXlsx } = await import('hucre');
    const diffs = await assertTemplateMatches(await openXlsx(new Uint8Array(BUILTIN)));
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
    const wb = await openXlsx(new Uint8Array(BUILTIN));
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
