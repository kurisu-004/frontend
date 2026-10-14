// src/views/parts/list/composables/__tests__/serialReleaseSchema.spec.ts
//
// 2026-10-19 新增：`POST /serials/release-terminal` 出参守门 schema 单测。
//
// 覆盖两类回归：
//
//  1. **缺键必抛**：Zod 默认 strip 会把后端漏发的键静默丢掉且不报错 ⇒ 漏声明一个键 =
//     那一格在确认框里恒为空白 / undefined，而管理员看到的明细与服务端实际释放的集合
//     已经不一致（本域是不可撤销的破坏性操作前唯一的告知面，静默降级的代价特别高）。
//     这里逐键删除，断言每个被删的键都让 parse 抛 ZodError。
//  2. **多一个未知键必抛**：守 `.strict()`。若哪天去掉 strict，后端给这个回执加一个
//     键就会被静默 strip，管理员看到的明细少一列而没有任何报错。

import { describe, expect, it } from 'vitest';
import { ZodError, type ZodType } from 'zod';
import { releaseTerminalSerialsOutSchema } from '../serialReleaseSchema';

/** 逐键删除，每个被删的键都必须让 parse 抛错。 */
function expectEveryKeyRequired(schema: ZodType, obj: Record<string, unknown>): void {
  for (const key of Object.keys(obj)) {
    const clone: Record<string, unknown> = { ...obj };
    delete clone[key];
    expect(() => schema.parse(clone), `删掉「${key}」后必须抛 ZodError`).toThrow(ZodError);
  }
}

// ---------------------------------------------------------------
// fixtures（逐字对齐冻结的后端契约）
// ---------------------------------------------------------------

/** 两条明细：一条装配件（drawing_no 有值）、一条零件（drawing_no 为 null）。 */
const AFFECTED = [
  {
    kind: 'ASSEMBLY',
    id: '1900000000000000001',
    serial_no: 'WO-2026-0001',
    drawing_no: 'DWG-A-01',
    status: 'COMPLETED',
  },
  {
    kind: 'PART',
    id: '1900000000000000002',
    serial_no: 'WO-2026-0002',
    drawing_no: null,
    status: 'CANCELLED',
  },
];

const OUT = {
  dry_run: true,
  assembly_count: 1,
  part_count: 1,
  released_total: 2,
  truncated: false,
  affected: AFFECTED,
};

describe('releaseTerminalSerialsOutSchema（2026-10-19）', () => {
  it('R1：完整响应 parse 通过，三个计数与明细原样保留', () => {
    const parsed = releaseTerminalSerialsOutSchema.parse(OUT);
    expect(parsed.assembly_count).toBe(1);
    expect(parsed.part_count).toBe(1);
    expect(parsed.released_total).toBe(2);
    expect(parsed.truncated).toBe(false);
    expect(parsed.affected).toHaveLength(2);
    expect(parsed.affected[0]!.kind).toBe('ASSEMBLY');
    expect(parsed.affected[1]!.drawing_no).toBeNull();
  });

  it('R2：逐键删除 —— 缺任何一个必填键都必须抛 ZodError（Zod 默认 strip 会静默放过）', () => {
    expectEveryKeyRequired(releaseTerminalSerialsOutSchema, OUT);
  });

  it('R3：明细行逐键删除 —— 缺键必抛（漏声明 = 那一格在确认框里恒为空白）', () => {
    for (const key of Object.keys(AFFECTED[0]!)) {
      const clone: Record<string, unknown> = { ...AFFECTED[0]! };
      delete clone[key];
      expect(
        () => releaseTerminalSerialsOutSchema.parse({ ...OUT, affected: [clone] }),
        `明细行删掉「${key}」后必须抛 ZodError`,
      ).toThrow(ZodError);
    }
  });

  it('R4：多一个未知键必抛（守 .strict()）', () => {
    expect(() => releaseTerminalSerialsOutSchema.parse({ ...OUT, unexpected_field: 1 })).toThrow(
      ZodError,
    );
  });

  it('R5：drawing_no 两种形态都接 —— null 接、字符串接、undefined 不接', () => {
    expect(
      releaseTerminalSerialsOutSchema.parse({
        ...OUT,
        affected: [{ ...AFFECTED[0]!, drawing_no: null }],
      }).affected[0]!.drawing_no,
    ).toBeNull();
    expect(
      releaseTerminalSerialsOutSchema.parse({
        ...OUT,
        affected: [{ ...AFFECTED[0]!, drawing_no: 'DWG-X' }],
      }).affected[0]!.drawing_no,
    ).toBe('DWG-X');
    // 键恒在、值可空：undefined 不是合法 wire 形态（前端据此渲染「—」）
    expect(() =>
      releaseTerminalSerialsOutSchema.parse({
        ...OUT,
        affected: [{ ...AFFECTED[0]!, drawing_no: undefined }],
      }),
    ).toThrow(ZodError);
  });

  it('R6：kind 只接 ASSEMBLY / PART，第三个字面量必抛', () => {
    for (const kind of ['ASSEMBLY', 'PART']) {
      expect(
        releaseTerminalSerialsOutSchema.parse({
          ...OUT,
          affected: [{ ...AFFECTED[0]!, kind }],
        }).affected[0]!.kind,
      ).toBe(kind);
    }
    expect(() =>
      releaseTerminalSerialsOutSchema.parse({
        ...OUT,
        affected: [{ ...AFFECTED[0]!, kind: 'XXX' }],
      }),
    ).toThrow(ZodError);
  });

  it('R7：计数非法形态必抛（小数 / 负数 / 字符串计数）', () => {
    expect(() => releaseTerminalSerialsOutSchema.parse({ ...OUT, assembly_count: 1.5 })).toThrow(
      ZodError,
    );
    expect(() => releaseTerminalSerialsOutSchema.parse({ ...OUT, part_count: -1 })).toThrow(
      ZodError,
    );
    expect(() => releaseTerminalSerialsOutSchema.parse({ ...OUT, released_total: '2' })).toThrow(
      ZodError,
    );
  });

  it('R8：截断形态（truncated=true 且明细 < 总数）parse 通过，计数不受截断影响', () => {
    const parsed = releaseTerminalSerialsOutSchema.parse({
      dry_run: false,
      assembly_count: 150,
      part_count: 130,
      released_total: 280,
      truncated: true,
      affected: AFFECTED,
    });
    expect(parsed.truncated).toBe(true);
    expect(parsed.affected).toHaveLength(2);
    expect(parsed.released_total).toBe(280);
  });
});
