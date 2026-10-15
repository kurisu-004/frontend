// src/api/__tests__/hrContractShape.spec.ts
//
// 2026-10-19 新建（排班日历页第一轮 review）：人事（hr）域出参形状的**真·跨仓对账**。
//
// ⚠️ **为什么单独一个文件、而不是往 `useScheduleStore.spec.ts` 里加一条 `Object.keys` 断言**：
//   班次日历的守门 schema 漏了信封上的 `shift_id`，而 store 单测里的 fixture **也**漏了它 ——
//   两侧同错、互相印证，于是「每次 `GET /hr/shifts/{id}/calendar` 都抛 `unrecognized_keys`、
//   班次作用域整月显示无数据」这条 100% 复现的线上故障，在全绿的测试里躺到 review 才被发现。
//   根子不在漏抄一个字段，在于**fixture 与被测对象同属前端**：`Object.keys(fixture)` 断言的
//   只是「前端代码符不符合前端自己的想象」，对「后端此刻长什么样」一个字都不说。
//   ⇒ 外部事实必须**真读后端源码**（照 `api/__tests__/printTemplates.contract.spec.ts::V7` 与
//   `api/files/__tests__/previewContract.spec.ts` 的既有纪律）。
//
// 本文件核三件事，全部对着后端仓源码：
//   1. **H 组**：六个读端点的行 VO 与信封 —— 前端 zod `.strict()` 的键集与后端 `vo.rs` 对应
//      struct 的 `pub` 字段集**双向集合相等**；
//   2. **L 组**：三个短文本列的前端长度上限与后端迁移文件的 `varchar(n)` **逐字相等**
//      （此前代码注释断言「后端没给长度上限」是错的 —— 后端 `dto.rs` 有 `COL_SHIFT_CODE` /
//      `COL_NAME` / `COL_REMARK` 且 service 侧有 `check_len` 守卫；上限本身也写成了 32 ≠ 30
//      ⇒ 超长编码过得了前端，要白跑一趟往返才吃 `21909`，而那句 message 不说是哪个字段）；
//   3. **W 组**：四条批量写端点的回显形状 `{affected}` —— 前端类型侧逐字对上（`expectTypeOf`
//      由 `npm run typecheck` 的 `vue-tsc` 兜住），api 层刻意 `Promise<void>` 丢弃响应。
//
// ⚠️ **强度边界（能守什么 / 守不住什么，别越读越信）**：
//   - **只在本机能读到后端仓时生效**。CI 只 checkout 前端仓 ⇒ 整段 `skipIf` 并打一行
//     `[跳过]` 提示（**不静默通过**，同 previewContract / printTemplates 的约定）。
//   - **只比字段名，不比类型**。后端把 `pub name: String` 改成 `Option<String>`（wire 变
//     `null`）这类改动抓不到 —— 但运行时后果是 `z.string()` 当场拒 `null` 抛，**响的**。
//   - **只认「Rust 字段名 = wire 键」这一前提**，由 H7 专门守：一旦后端给这些 struct 加
//     `#[serde(rename)]` / `skip_serializing_if`，wire 键就与字段名分家，H1..H6 全部失效。
//   - **W 组是类型侧断言**，运行时不可见（`interface` 无 runtime 形态）；它的价值在于
//     「后端加字段时 vue-tsc 立刻红」，而 H 组覆盖不到写端点。

import { describe, expect, expectTypeOf, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HrCalendarWriteOut } from '@/api/hr.contract';
import type { UpdateShiftPayload } from '@/types/hr';
import {
  hrCalendarDaySchema,
  hrCalendarDaysResultSchema,
  hrShiftCalendarDaySchema,
  hrShiftCalendarResultSchema,
  hrShiftListResultSchema,
  hrShiftSchema,
  HR_SHIFT_CODE_MAX,
  HR_SHIFT_NAME_MAX,
  HR_SHIFT_REMARK_MAX,
} from '@/views/hr/schedule/hrScheduleSchema';

// ============================================================================
// 跨仓对账基建 —— 纪律与 `printTemplates.contract.spec.ts::V7` 逐字同源
// ----------------------------------------------------------------------------
// 判据是「**存在被核的那个模块**」而不是「这是个后端仓」；候选顺序把后端 worktree 排在根
// checkout 前面 —— 本域的后端代码只落在后端同名 worktree 里，根 checkout 里可能根本没有
// `hr` 模块，用「像不像后端仓」判会选上一份没有该模块的源码、核出一条假红。
// ============================================================================

const FRONTEND_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** 被核的那份后端源码。 */
const BACKEND_VO_REL = 'src/modules/hr/vo.rs';
/** 被核的那份建表迁移（列宽真源）。 */
const BACKEND_MIGRATION_REL = 'migrations/20261019000000_001_hr.sql';

function findBackendRoot(): string | null {
  const worktrees: string[] = [];
  const roots: string[] = [];
  let dir = FRONTEND_ROOT;
  for (let i = 0; i < 5; i += 1) {
    const be = join(dir, 'backend-rust');
    if (existsSync(be)) {
      roots.push(be);
      const wtDir = join(be, '.claude', 'worktrees');
      if (existsSync(wtDir)) {
        for (const slug of readdirSync(wtDir).sort()) worktrees.push(join(wtDir, slug));
      }
    }
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  for (const c of [...worktrees, ...roots]) {
    if (existsSync(join(c, BACKEND_VO_REL))) return c;
  }
  return null;
}

const BACKEND = findBackendRoot();

/**
 * 从后端 Rust 源码里抽出某个 `pub struct` 的**字段名**（按声明顺序）。
 *
 * ⚠️ 只抽名字、不抽类型、也不解析 serde 属性（强度边界见文件头）。抽到空集时**抛错**而不是
 * 返回空数组：否则「正则哪天坏了 ⇒ 抽出 0 个字段」会退化成「后端字段集为空」，与前端那侧
 * 一比就是一条读不懂的红。
 */
function rustStructFields(src: string, structName: string): string[] {
  const head = new RegExp(`^\\s*pub\\s+struct\\s+${structName}\\s*\\{`, 'm').exec(src);
  if (!head) throw new Error(`后端 vo.rs 里找不到 struct ${structName} —— 跨仓对账无法进行`);
  const fields: string[] = [];
  for (const line of src.slice(head.index + head[0].length).split('\n')) {
    if (line.trim() === '}') break;
    const m = /^\s*pub\s+([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(line);
    if (m) fields.push(m[1]!);
  }
  if (fields.length === 0) throw new Error(`后端 vo.rs 的 struct ${structName} 抽出 0 个字段`);
  return fields;
}

/** 抽某个 struct 的**字段行原文**（W 组 / H7 查字段上的 serde 属性用）。 */
function rustStructBody(src: string, structName: string): string[] {
  const head = new RegExp(`^\\s*pub\\s+struct\\s+${structName}\\s*\\{`, 'm').exec(src);
  if (!head) throw new Error(`后端 vo.rs 里找不到 struct ${structName} —— 跨仓对账无法进行`);
  const lines: string[] = [];
  for (const line of src.slice(head.index + head[0].length).split('\n')) {
    if (line.trim() === '}') break;
    lines.push(line);
  }
  return lines;
}

function readBackendVo(): string {
  return readFileSync(join(BACKEND!, BACKEND_VO_REL), 'utf8');
}

/** 取出某个 zod object 的键集（`z.object({…})` 的 `.shape` 就是声明时的键表）。 */
function zodKeys(schema: { shape: Record<string, unknown> }): string[] {
  return Object.keys(schema.shape).sort();
}

// ============================================================================
// H 组：六个读端点的行 VO / 信封
// ============================================================================

describe.skipIf(!BACKEND)('H：出参形状真·跨仓对账（对着后端 hr/vo.rs）', () => {
  it('H1：端点 8 信封 —— hrShiftCalendarResultSchema 的键集与后端 ShiftCalendarOut 双向相等', () => {
    // ⚠️ **本域 `.strict()` 形状事故的原点**。后端 `ShiftCalendarOut { shift_id, items }`，
    // 前端一度只声明 `items` ⇒ 每一次 `GET /hr/shifts/{id}/calendar` 都抛
    // `unrecognized_keys` ⇒ 切到任意班次作用域就红条 + 整月「无数据」。集合相等是**双向**的：
    // 后端加字段（前端没跟上 → 生产逐屏抛）与前端多声明（后端没有 → 恒 `undefined` 的死字段，
    // 且 `.strict()` 下让真响应直接抛）两个方向都会红。
    const backend = rustStructFields(readBackendVo(), 'ShiftCalendarOut').sort();
    const frontend = zodKeys(hrShiftCalendarResultSchema);
    expect(frontend, '端点 8 信封键与后端 ShiftCalendarOut 不一致（shift_id 不能漏）').toEqual(
      backend,
    );
    // 显式点一遍：`shift_id` 在信封上、不在 items 里（它就是这轮漏掉的那一个）。
    expect(frontend).toContain('shift_id');
    expect(zodKeys(hrShiftCalendarDaySchema)).not.toContain('shift_id');
  });

  it('H2：端点 8 行 VO —— hrShiftCalendarDaySchema 的键集与后端 ShiftCalendarDayOut 双向相等', () => {
    const backend = rustStructFields(readBackendVo(), 'ShiftCalendarDayOut').sort();
    const frontend = zodKeys(hrShiftCalendarDaySchema);
    expect(frontend, '班次日历行键与后端 ShiftCalendarDayOut 不一致').toEqual(backend);
  });

  it('H3：端点 1 信封与行 —— 与后端 CalendarDaysOut / CalendarDayOut 双向相等', () => {
    const src = readBackendVo();
    expect(zodKeys(hrCalendarDaysResultSchema), '端点 1 信封键与后端 CalendarDaysOut 不一致').toEqual(
      rustStructFields(src, 'CalendarDaysOut').sort(),
    );
    expect(zodKeys(hrCalendarDaySchema), '全局日历行键与后端 CalendarDayOut 不一致').toEqual(
      rustStructFields(src, 'CalendarDayOut').sort(),
    );
  });

  it('H4：端点 4 信封 —— hrShiftListResultSchema 的键集与后端 ShiftListOut 双向相等', () => {
    const backend = rustStructFields(readBackendVo(), 'ShiftListOut').sort();
    const frontend = zodKeys(hrShiftListResultSchema);
    expect(frontend, '班次列表信封键与后端 ShiftListOut 不一致').toEqual(backend);
    // 后端这个信封**只有** items：一旦前端顺手加个 `total` / `limit` 之类，`.strict()` 会让
    // 真的列表响应抛（Zod 把未知键判 `unrecognized_keys`），班次栏整块空。
    expect(frontend).toEqual(['items']);
  });

  it('H5：班次行 —— hrShiftSchema 的键集与后端 ShiftOut 双向相等（含 3 个派生列）', () => {
    const backend = rustStructFields(readBackendVo(), 'ShiftOut').sort();
    const frontend = zodKeys(hrShiftSchema);
    expect(frontend, '班次行键与后端 ShiftOut 不一致').toEqual(backend);
    // 三个派生列（后端算好、前端不重复推导）逐个点名，删一个就会红。
    for (const derived of ['cross_day', 'overflow_minutes', 'daily_minutes']) {
      expect(frontend, `派生列 ${derived} 不能少`).toContain(derived);
    }
  });

  it('H6：写端点回显 —— 后端两条 WriteOut 都是 `{affected}`（前端类型见 W 组）', () => {
    const src = readBackendVo();
    expect(rustStructFields(src, 'CalendarDaysWriteOut').sort()).toEqual(['affected']);
    expect(rustStructFields(src, 'ShiftDaysWriteOut').sort()).toEqual(['affected']);
  });

  it('H7：八个 struct 里都不许出现 serde rename / skip_serializing_if（否则 H1..H6 的前提失效）', () => {
    // H1..H6 成立的前提是「Rust 字段名 == wire 上的 JSON 键」。这条把该前提本身钉住：后端一旦
    // 加 `#[serde(rename = "…")]`（wire 键改名）或 `skip_serializing_if`（空值时整个键消失 ⇒
    // `.strict()` 必抛），抽出来的字段名就不再代表 wire 键，会在**两边同时对得上**的情况下
    // 放行一次真实的断裂。
    // ⚠️ `serialize_with`（`ShiftOut.id` / `ShiftCalendarOut.shift_id` 的雪花 ID 转 string）**不
    // 违规**：它只改序列化形态、不改键名，正是前端按 `z.string()` 接的那把。
    const src = readBackendVo();
    const structs = [
      'CalendarDaysOut',
      'CalendarDayOut',
      'CalendarDaysWriteOut',
      'ShiftListOut',
      'ShiftOut',
      'ShiftCalendarOut',
      'ShiftCalendarDayOut',
      'ShiftDaysWriteOut',
    ];
    const offenders: string[] = [];
    for (const name of structs) {
      for (const line of rustStructBody(src, name)) {
        if (/#\[serde\([^)]*(rename|skip_serializing_if)/.test(line)) {
          offenders.push(`${name}: ${line.trim()}`);
        }
      }
    }
    expect(offenders, '这些 struct 出现了 serde rename / skip_serializing_if').toEqual([]);
  });
});

// ============================================================================
// L 组：三个短文本列的长度上限（真源是后端迁移文件的 varchar(n)）
// ============================================================================

describe.skipIf(!BACKEND)('L：短文本列长度上限与后端 varchar(n) 逐字相等', () => {
  /** 从迁移的 `CREATE TABLE t_hr_shift (… )` 里抽出某列的 varchar 宽度。 */
  function columnWidth(col: string): number | null {
    const sql = readFileSync(join(BACKEND!, BACKEND_MIGRATION_REL), 'utf8');
    const head = /CREATE TABLE public\.t_hr_shift\s*\(/.exec(sql);
    if (!head) throw new Error('迁移文件里找不到 CREATE TABLE public.t_hr_shift');
    for (const line of sql.slice(head.index + head[0].length).split('\n')) {
      if (line.trim() === ');') break;
      const m = new RegExp(`^\\s*${col}\\s+character varying\\((\\d+)\\)`, 'i').exec(line);
      if (m) return Number(m[1]);
    }
    return null;
  }

  it('L1：HR_SHIFT_CODE_MAX = 30（此前是 32 ⇒ 31/32 字符的编码过得了前端才吃后端 21909）', () => {
    expect(columnWidth('code')).toBe(HR_SHIFT_CODE_MAX);
    expect(HR_SHIFT_CODE_MAX).toBe(30);
  });

  it('L2：HR_SHIFT_NAME_MAX / HR_SHIFT_REMARK_MAX 与迁移同宽', () => {
    expect(columnWidth('name')).toBe(HR_SHIFT_NAME_MAX);
    expect(columnWidth('remark')).toBe(HR_SHIFT_REMARK_MAX);
  });

  it('L3：三个上限都**不是**「前端兜底上限」—— 它们必须与列宽逐字相等（注释里那句「后端没给长度上限」是错的）', () => {
    // 这条钉住的是**取舍本身**：上限的正当性来自「后端按列宽守（`dto.rs::COL_*` + service 的
    // `check_len` → 21909 / HTTP 400），所以超长必须在前端就红」，一旦有人当成「够用即可」的
    // 兜底值再放宽，超长就要白跑一趟往返、失败原因还只是一句给日志看的 message。
    for (const width of [columnWidth('code'), columnWidth('name'), columnWidth('remark')]) {
      expect(width, '列宽抽不到：对账失效（迁移改了写法？）').not.toBeNull();
    }
  });
});

// ============================================================================
// W 组：四条批量写端点的回显形状（类型侧断言，由 `npm run typecheck` 的 vue-tsc 兜住）
// ============================================================================

describe('W：写端点回显 `{affected}` 的前端类型契约', () => {
  it('W1：HrCalendarWriteOut 只有 affected 一个键（对应后端两个 WriteOut struct）', () => {
    // 后端 `CalendarDaysWriteOut` 与 `ShiftDaysWriteOut` 形状相同（都是 `{affected: i64}`），
    // 前端用**同一个** interface 标注两条路。类型断言在这里的正当性：interface 零 runtime
    // 形态，唯一能核它的就是编译器 —— 写多一个键 / 改键名，`vue-tsc` 当场红。
    expectTypeOf<keyof HrCalendarWriteOut>().toEqualTypeOf<'affected'>();
    expectTypeOf<HrCalendarWriteOut['affected']>().toEqualTypeOf<number>();
  });

  it('W2：改成 UpdateShiftPayload 时 `color` / `remark` 是**非 null 的 string**（空串 = 清空）', () => {
    // 后端 `Option<String>` + `#[serde(default)]` 把 JSON `null` 与键缺失都解成 `None`、一律
    // 回落旧值 ⇒ 类型里留着 `| null` 就是在邀请后来人发一个「静默不清空」的 `null`。
    expectTypeOf<NonNullable<UpdateShiftPayload['color']>>().toEqualTypeOf<string>();
    expectTypeOf<NonNullable<UpdateShiftPayload['remark']>>().toEqualTypeOf<string>();
  });
});

if (!BACKEND) {
  // 整段 skipIf 会安静地跳过 —— 明确打一行，别让「没核成」看起来像「核过了」。
  console.warn(
    `[跳过] 未找到后端仓（backend-rust/${BACKEND_VO_REL}，判据是「存在被核的那个模块」），` +
      'H 组跨仓字段对账与 L 组列宽对账未执行；W 组类型断言与本仓内的其它断言仍然有效。',
  );
}
