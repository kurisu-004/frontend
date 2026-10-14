// src/views/parts/list/composables/__tests__/serialReleaseSchema.spec.ts
//
// 2026-10-19 新增：`POST /serials/release-terminal` 出参守门 schema 单测。
//
// 覆盖三类回归：
//
//  1. **缺键必抛**：Zod 默认 strip 会把后端漏发的键静默丢掉且不报错 ⇒ 漏声明一个键 =
//     那一格在确认框里恒为空白 / undefined，而管理员看到的明细与服务端实际释放的集合
//     已经不一致（本域是不可撤销的破坏性操作前唯一的告知面，静默降级的代价特别高）。
//     这里逐键删除，断言每个被删的键都让 parse 抛 ZodError。
//  2. **多一个未知键必抛**：守 `.strict()`，且**顶层与明细行各守一次**（R4 / R4b）。若哪天
//     去掉任一处 strict，后端给这个回执（顶层或行 VO）加一个键就会被静默 strip，管理员
//     看到的明细少一列而没有任何报错 —— 本域的表格是逐格渲染的明细表，行级才是这条风险
//     真正落地的位置。
//  3. **值形态必抛**：R5 / R6 / R7 逐字段钉住「后端给什么形态」。`drawing_no` 尤其关键 ——
//     它**值恒非空**（后端两列均 NOT NULL ⇒ `dto.rs` 声明成 `String` 而非
//     `Option<String>`），接了 `.nullable()` 就会养出一个恒不触发的死分支，并把「后端
//     真改成可空」降级成静默通过而不是当场抛。
//
// ⚠️ **本文件的 fixture 是「前端此刻的想象」，不是外部事实**（照
// `src/api/__tests__/printTemplates.contract.spec.ts` 的同款定位）：断言的只是「parse
// 接在返回路径上、`.strict()` 按预期抛或 strip、值形态按声明接」。**「后端此刻长什么样」
// 由 `src/api/__tests__/serial.contract.spec.ts` 的 V 组承担** —— 那份真读后端
// `modules/serial/dto.rs`，把字段集与可空性逐字对拍；改这里之前先跑它。

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
// fixtures（真源在 `src/api/__tests__/serial.contract.spec.ts` 的 V 组，本段只是它的镜像）
// ---------------------------------------------------------------

/** 两条明细：一条装配件、一条零件（两侧 `drawing_no` 都**恒非空** —— 后端
 *  `t_assembly.drawing_no` / `t_part.drawing_no` 在 baseline 里都是 `NOT NULL`，
 *  `dto.rs` 因此声明成 `String`；真源见 `src/api/__tests__/serial.contract.spec.ts`）。 */
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
    drawing_no: 'DWG-B-02',
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
    expect(parsed.affected[1]!.drawing_no).toBe('DWG-B-02');
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

  it('R4b：明细行多一个未知键也必抛（行级 .strict()，外层 strict 管不到这一层）', () => {
    // ⚠️ **与 R4 是一对，缺一条就是零信号**：R4 只守顶层。外层 strict 对 `affected[i]` 里
    // 多出来的键**完全无感** —— 后端给 `ReleasedSerialItem` 加一个字段时，本域的表现是
    // 「明细表少渲染一列 + parse 全绿 + typecheck / lint 全绿」，而它正发生在逐格渲染的
    // 位置上（serialReleaseSchema.ts 文件头论证要防的就是这件事）。把行 schema 的
    // `.strict()` 摘掉时，本条必须变红。
    expect(() =>
      releaseTerminalSerialsOutSchema.parse({
        ...OUT,
        affected: [{ ...AFFECTED[0]!, unexpected_field: 1 }],
      }),
    ).toThrow(ZodError);
    // 反向：行**少**一个键照样必抛（R3 已守），两向都不能少。
    expect(() =>
      releaseTerminalSerialsOutSchema.parse({
        ...OUT,
        affected: [AFFECTED[0]!, AFFECTED[1]!, { ...AFFECTED[0]!, extra: 'x' }],
      }),
    ).toThrow(ZodError);
  });

  it('R5：drawing_no 只接字符串 —— 接 null 必抛、接 undefined 必抛', () => {
    // ⚠️ 这一条守的是「**值恒非空**」这半边：键恒在由 R2 / R3 的逐键删除守住，值恒非空
    // 只能靠「显式接 null / undefined 必抛」守。守门 schema 一旦放回 `.nullable()`，本条红。
    expect(
      releaseTerminalSerialsOutSchema.parse({
        ...OUT,
        affected: [{ ...AFFECTED[0]!, drawing_no: 'DWG-X' }],
      }).affected[0]!.drawing_no,
    ).toBe('DWG-X');
    // 后端 `pub drawing_no: String` ⇒ wire 上恒有值；`null` 不是合法形态（接了就是消费侧
    // 养一个恒不触发的死分支，且把「后端真改成可空」降级成静默通过而不是当场抛）。
    expect(() =>
      releaseTerminalSerialsOutSchema.parse({
        ...OUT,
        affected: [{ ...AFFECTED[0]!, drawing_no: null }],
      }),
    ).toThrow(ZodError);
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
