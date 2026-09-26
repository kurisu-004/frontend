// 2026-09-24 新增：录入 Tab Zod schema 单元测试（纯函数，node 环境）。
// 覆盖：trim→min/max 顺序、必填、长度上限、quantity int/min、iso date 格式、
// nullable 字段、toFieldErrors 首条聚合。

import { describe, expect, it } from 'vitest';
import { partEntrySchema, toFieldErrors } from '../partEntrySchema';

const base = {
  drawingNo: 'LT1',
  name: 'p1',
  customerId: 'cust-1',
  applicantName: 'bob',
  quantity: 1,
  isUrgent: false,
  requestDate: '2026-09-24',
  plannedDeliveryDate: '2026-09-25',
  orderNo: null,
  systemDeliveryDate: null,
  note: null,
};

describe('partEntrySchema', () => {
  it('合法入参：通过', () => {
    const r = partEntrySchema.safeParse(base);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toEqual(base);
  });

  it('trim 在 min 前：前后空字符串被 trim 后视为合法', () => {
    const r = partEntrySchema.safeParse({
      ...base,
      drawingNo: '  LT1  ',
      name: '  p1  ',
      applicantName: '  bob  ',
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.drawingNo).toBe('LT1');
      expect(r.data.name).toBe('p1');
      expect(r.data.applicantName).toBe('bob');
    }
  });

  it('全空格必填字段：trim 后空 → 报错且文案友好', () => {
    const r = partEntrySchema.safeParse({
      ...base,
      drawingNo: '   ',
      name: '',
      applicantName: '\t  ',
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const fe = toFieldErrors(r.error.issues);
      expect(fe.drawingNo).toBe('请输入图号');
      expect(fe.name).toBe('请输入名称');
      expect(fe.applicantName).toBe('请选择或输入申请人');
    }
  });

  it('customerId 空：走 v4 error 参数 → 请选择客户', () => {
    const r = partEntrySchema.safeParse({ ...base, customerId: '' });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(toFieldErrors(r.error.issues).customerId).toBe('请选择客户');
    }
  });

  it('长度上限对齐 DDL：drawingNo 100 / name 200 / applicantName 50 / orderNo 30 / note 500', () => {
    const overCases = [
      { drawingNo: 'a'.repeat(101) },
      { name: 'a'.repeat(201) },
      { applicantName: 'a'.repeat(51) },
      { orderNo: 'a'.repeat(31) },
      { note: 'a'.repeat(501) },
    ];
    for (const patch of overCases) {
      const r = partEntrySchema.safeParse({ ...base, ...patch });
      expect(r.success).toBe(false);
    }
  });

  it('quantity 必填 + int + min(1)', () => {
    expect(partEntrySchema.safeParse({ ...base, quantity: 0 }).success).toBe(false);
    expect(partEntrySchema.safeParse({ ...base, quantity: 1.5 }).success).toBe(false);
    expect(partEntrySchema.safeParse({ ...base, quantity: 1 }).success).toBe(true);
    expect(partEntrySchema.safeParse({ ...base, quantity: 100 }).success).toBe(true);
  });

  it('日期格式 YYYY-MM-DD：非空非格式 → 报错', () => {
    expect(
      partEntrySchema.safeParse({ ...base, requestDate: '' }).success,
    ).toBe(false);
    expect(
      partEntrySchema.safeParse({ ...base, plannedDeliveryDate: '2026-9-9' }).success,
    ).toBe(false);
    expect(
      partEntrySchema.safeParse({ ...base, requestDate: '2026-09-24' }).success,
    ).toBe(true);
  });

  it('systemDeliveryDate 可为 null；非法格式报错', () => {
    expect(
      partEntrySchema.safeParse({ ...base, systemDeliveryDate: null }).success,
    ).toBe(true);
    expect(
      partEntrySchema.safeParse({ ...base, systemDeliveryDate: 'bad' }).success,
    ).toBe(false);
  });

  it('orderNo / note 可为 null 或空字符串（caller 端归一化为 null）', () => {
    expect(partEntrySchema.safeParse({ ...base, orderNo: '', note: '' }).success).toBe(true);
    expect(partEntrySchema.safeParse({ ...base, orderNo: null, note: null }).success).toBe(true);
  });

  it('schema 未知字段被 strip：result.data 不含 applicantId/drawingFile 等', () => {
    const r = partEntrySchema.safeParse({
      ...base,
      applicantId: 'a-1',
      drawingFile: { name: 'foo' },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect((r.data as Record<string, unknown>).applicantId).toBeUndefined();
      expect((r.data as Record<string, unknown>).drawingFile).toBeUndefined();
    }
  });

  describe('toFieldErrors', () => {
    it('同字段多条 issue 只取第一条', () => {
      const r = partEntrySchema.safeParse({
        ...base,
        drawingNo: '   ',
      });
      expect(r.success).toBe(false);
      if (!r.success) {
        const fe = toFieldErrors(r.error.issues);
        // drawingNo 同时命中 min(1) 与 trim 后长度，应只返回第一条
        expect(fe.drawingNo).toBe('请输入图号');
      }
    });

    it('返回对象键是字段名，文案来自 issue.message', () => {
      const r = partEntrySchema.safeParse({
        ...base,
        customerId: '',
        quantity: 0,
      });
      expect(r.success).toBe(false);
      if (!r.success) {
        const fe = toFieldErrors(r.error.issues);
        expect(fe).toEqual({
          customerId: '请选择客户',
          quantity: '数量至少为 1',
        });
      }
    });
  });
});
