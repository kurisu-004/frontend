// src/views/hr/schedule/__tests__/hrScheduleSchema.spec.ts
//
// 2026-10-19 新建（排班日历页第一轮 review）：`hrScheduleSchema.ts` 里**只有 Zod 能表达**的那
// 几条契约 —— 三个短文本列的长度上限、出参班次色的形状、表单校验的字段级行为。
//
// 为什么这几个点要单测：
//  - **长度上限**：PG 的 `varchar(n)` 超长是 `22001` ⇒ 后端兜成 **HTTP 500**（无业务码），
//    前端只有一句「班次创建失败」，排查零线索。所以「前端先卡住」是唯一的一道闸，它一旦与
//    列宽漂移就再没有第二道。后端那一侧的对账（真读迁移文件）在
//    `src/api/__tests__/hrContractShape.spec.ts::L` —— 本文件钉的是**前端 schema 真的按这个
//    数值在拒**。
//  - **出参颜色**：下游 `ShiftSidebar` / `ScheduleDayCell` 把它直接喂给
//    `:style="{ backgroundColor }"`，形状守门放在这一层（写侧由表单同一条正则把关）。
//  - **字段级校验**：红字必须挂在**出问题的那个字段**上，否则用户看着一条红字不知道去改哪。

import { describe, expect, it } from 'vitest';
import {
  HR_SHIFT_CODE_MAX,
  HR_SHIFT_COLOR_RE,
  HR_SHIFT_NAME_MAX,
  HR_SHIFT_REMARK_MAX,
  initialShiftForm,
  shiftFormSchema,
  toShiftFieldErrors,
  hrShiftSchema,
} from '../hrScheduleSchema';

function form(over: Record<string, unknown> = {}) {
  return { ...initialShiftForm(), code: 'NIGHT', name: '夜班', ...over };
}

/** 断言「解析失败」并把 issues 交出来（`.error` 在 success 为真时不存在，先判再取）。 */
function expectRejected(parsed: ReturnType<typeof shiftFormSchema.safeParse>) {
  if (parsed.success) throw new Error('期望被拒，却解析成功');
  return parsed.error.issues;
}

describe('hrScheduleSchema — 三个短文本列的长度上限', () => {
  it('S1：编码 30 字符放行、31 字符被拒（PG 列宽是 varchar(30)）', () => {
    const ok = 'A'.repeat(30);
    const tooLong = 'A'.repeat(31);
    expect(ok).toHaveLength(HR_SHIFT_CODE_MAX);
    expect(tooLong).toHaveLength(HR_SHIFT_CODE_MAX + 1);
    expect(shiftFormSchema.safeParse(form({ code: ok })).success).toBe(true);

    const bad = shiftFormSchema.safeParse(form({ code: tooLong }));
    expect(bad.success).toBe(false);
    // 红字必须挂在 `code` 上（挂到别的字段上用户就不知道去改哪一栏）。
    expect(toShiftFieldErrors(expectRejected(bad)).code).toContain(String(HR_SHIFT_CODE_MAX));
  });

  it('S2：名称 / 备注同理（50 / 200，各卡一位）', () => {
    expect(shiftFormSchema.safeParse(form({ name: '名'.repeat(HR_SHIFT_NAME_MAX) })).success).toBe(
      true,
    );
    const name = shiftFormSchema.safeParse(form({ name: '名'.repeat(HR_SHIFT_NAME_MAX + 1) }));
    expect(name.success).toBe(false);
    expect(toShiftFieldErrors(expectRejected(name)).name).toBeTruthy();

    expect(
      shiftFormSchema.safeParse(form({ remark: 'x'.repeat(HR_SHIFT_REMARK_MAX) })).success,
    ).toBe(true);
    const remark = shiftFormSchema.safeParse(form({ remark: 'x'.repeat(HR_SHIFT_REMARK_MAX + 1) }));
    expect(remark.success).toBe(false);
    expect(toShiftFieldErrors(expectRejected(remark)).remark).toBeTruthy();
  });

  it('S3：trim 在长度校验之前归一（前后空格不该把 30 字符的编码顶成超长）', () => {
    expect(shiftFormSchema.safeParse(form({ code: `  ${'A'.repeat(30)}  ` })).success).toBe(true);
  });
});

describe('hrScheduleSchema — 出参班次色的形状守门', () => {
  const ROW = {
    id: '9000000000000901',
    version: 1,
    code: 'DAY',
    name: '白班',
    color: null,
    segments: [{ seq: 1, start: '08:00', end: '12:00' }],
    is_active: true,
    sort_order: 1,
    remark: null,
    cross_day: false,
    overflow_minutes: 0,
    daily_minutes: 240,
    created_at: '2026-10-19 08:00:00',
    updated_at: '2026-10-19 08:00:00',
  };

  it('S4：`#rrggbb` / `null` / **空串**都放行；其它形态被拒', () => {
    expect(hrShiftSchema.safeParse(ROW).success).toBe(true);
    expect(hrShiftSchema.safeParse({ ...ROW, color: '#1E4D8B' }).success).toBe(true);
    // ⚠️ 空串是**清空之后的合法落库形态**（后端 `Option<String>` 收 `''` 就落 `''`）。按
    // `#rrggbb` 拒掉它 ⇒ 「清空过颜色的班次」把整个班次列表打成坏响应（`.strict()` 下是
    // 班次栏整块空 + 红条）。归一成 `null`（走默认色）由 store 的 `shifts` 做。
    expect(hrShiftSchema.safeParse({ ...ROW, color: '' }).success).toBe(true);
    for (const bad of ['red', '#fff', 'rgb(1,2,3)', '#1e4d8b; background:url(x)']) {
      expect(
        hrShiftSchema.safeParse({ ...ROW, color: bad }).success,
        `color=${JSON.stringify(bad)} 应被拒`,
      ).toBe(false);
    }
    expect(HR_SHIFT_COLOR_RE.test('#1e4d8b')).toBe(true);
  });
});

describe('hrScheduleSchema — 表单校验的字段级行为', () => {
  it('S5：时段非法只挂 `segments` 一条聚合红字（不逐段拆成多个字段位）', () => {
    const bad = shiftFormSchema.safeParse(
      form({
        segments: [
          { seq: 1, start: '08:00', end: '12:00' },
          { seq: 2, start: '11:00', end: '13:00' },
        ],
      }),
    );
    expect(bad.success).toBe(false);
    const errors = toShiftFieldErrors(expectRejected(bad));
    expect(errors.segments).toContain('重叠');
    expect(Object.keys(errors)).toEqual(['segments']);
  });

  it('S6：颜色的 preprocess 把空串 / undefined 归一成 null（清空 = 走默认色，不是红字）', () => {
    for (const blank of ['', null, undefined]) {
      const parsed = shiftFormSchema.safeParse(form({ color: blank }));
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data.color).toBeNull();
    }
  });

  it('S7：同字段多 issue 只取第一条（后一条不覆盖前一条）', () => {
    const errors = toShiftFieldErrors([
      { path: ['code'], message: '第一条' },
      { path: ['code'], message: '第二条' },
      { path: [], message: '顶层 issue' },
      { path: ['remark'], message: '备注那条' },
    ]);
    expect(errors).toEqual({ code: '第一条', remark: '备注那条' });
  });
});
