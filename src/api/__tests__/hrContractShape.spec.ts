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
// 本文件核四件事，其中三件对着后端仓源码：
//   1. **H 组**：六个读端点的行 VO 与信封 —— 前端 zod `.strict()` 的键集与后端 `vo.rs` 对应
//      struct 的 `pub` 字段集**双向集合相等**（H1..H7），另加两件跨仓的「集合 / 锚点」事实：
//      **H8** 错误码集合（后端 `shared/error.rs` 的全部 `BIZ_HR_*` 常量必须都被前端码表收进）
//      与 **H9** 注释里那些 `docs/api/hr.md §N.M` 口径锚点必须指向真实存在的**那一节**；
//   2. **L 组**：三个短文本列的前端长度上限与后端迁移文件的 `varchar(n)` **逐字相等**
//      （此前代码注释断言「后端没给长度上限」是错的 —— 后端 `dto.rs` 有 `COL_SHIFT_CODE` /
//      `COL_NAME` / `COL_REMARK` 且 service 侧有 `check_len` 守卫；上限本身也写成了 32 ≠ 30
//      ⇒ 超长编码过得了前端，要白跑一趟往返才吃 `21909`，而那句 message 不说是哪个字段）；
//   3. **W 组**：四条批量写端点的回显形状 `{affected}` —— 前端类型侧逐字对上（`expectTypeOf`
//      由 `npm run typecheck` 的 `vue-tsc` 兜住），api 层刻意 `Promise<void>` 丢弃响应；
//   4. **X 组**（纯前端，**永远跑**）：错误码表每个码都配了人话；跨仓对账「有没有真的核成」的
//      状态播报 + CI 硬信号。
//
// ⚠️ **强度边界（能守什么 / 守不住什么，别越读越信）**：
//   - **H / L 组只在本机能读到后端仓时生效**。CI 只 checkout 前端仓 ⇒ 整段 `skipIf` 并打一行
//     `[跳过]` 提示（**不静默通过**，同 previewContract / printTemplates 的约定）；X 组那条
//     X0 把这件事从「一行不影响退出码的 warn」升级成「**CI 环境变量在位时缺后端仓即判红**」，
//     所以 CI 上不存在「这 10 条全部退化成 no-op 却还看起来全绿」的窗口。
//   - **被核的是哪一份后端源码由 `findBackendRoot` 的候选顺序决定**（同名 worktree → 其余
//     worktree 按 `vo.rs` 新旧 → 根 checkout，`HR_BACKEND_DIR` 可覆盖）。判据错了整套对账
//     就是对着另一份源码跑，所以那一段的判据与理由都写在函数注释里。
//   - **只比字段名，不比类型**。后端把 `pub name: String` 改成 `Option<String>`（wire 变
//     `null`）这类改动抓不到 —— 但运行时后果是 `z.string()` 当场拒 `null` 抛，**响的**。
//   - **只认「Rust 字段名 = wire 键」这一前提**，由 H7 专门守：一旦后端给这些 struct 加
//     `#[serde(rename)]` / `skip_serializing_if`，wire 键就与字段名分家，H1..H6 全部失效。
//   - **W 组是类型侧断言**，运行时不可见（`interface` 无 runtime 形态）；它的价值在于
//     「后端加字段时 vue-tsc 立刻红」，而 H 组覆盖不到写端点。
//   - **H9 只判「引用指向的那一节存在且是对的那一节」，不判注释正文说得对不对**。

import { describe, expect, expectTypeOf, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HrCalendarWriteOut } from '@/api/hr.contract';
import type { UpdateShiftPayload } from '@/types/hr';
import { HR_SCHEDULE_ERROR_CODES, HR_SCHEDULE_ERROR_TEXT } from '@/views/hr/schedule/hrErrorText';
import {
  hrCalendarDaySchema,
  hrCalendarDaysResultSchema,
  hrShiftBandSchema,
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
// 判据是「**存在被核的那个模块**」而不是「这是个后端仓」；候选顺序是「同名 worktree →
// 其余 worktree 按 vo.rs 新旧 → 根 checkout」，且 `HR_BACKEND_DIR` 可显式覆盖。
// ============================================================================

const FRONTEND_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** 被核的那份后端源码。 */
const BACKEND_VO_REL = 'src/modules/hr/vo.rs';
/** 被核的那份建表迁移（列宽真源）。 */
const BACKEND_MIGRATION_REL = 'migrations/20261019000000_001_hr.sql';
/** 业务码真源（`BIZ_HR_*` 常量）。 */
const BACKEND_ERROR_REL = 'src/shared/error.rs';
/** hr 域整域契约文档（前端注释里那些 `§N.M` 口径锚点的真身）。 */
const BACKEND_HR_DOC_REL = 'docs/api/hr.md';

/**
 * 当前前端 worktree 的**目录名**（= 所建分支的短名）；根 checkout / 普通 clone 下为 `null`。
 *
 * worktree 的 `.git` 是**文件**而非目录，内容一行 `gitdir: …/worktrees/<slug>` ⇒ 取它的
 * basename 就是 slug。并行开发的前后端 worktree 同名（`hr-schedule` ↔ `hr-schedule`），所以它
 * 是「哪份后端源码才对得上当前前端分支」的判据。
 */
function frontendWorktreeSlug(): string | null {
  const dotGit = join(FRONTEND_ROOT, '.git');
  if (!existsSync(dotGit) || !statSync(dotGit).isFile()) return null;
  const m = /^gitdir:\s*(.+)\s*$/m.exec(readFileSync(dotGit, 'utf8'));
  return m ? basename(m[1]!.trim()) : null;
}

/**
 * 定位被核的那份后端仓根目录；返回 `null` 表示「本机没有可读的后端 hr 域源码」。
 *
 * ⚠️ **候选顺序是防「假红 / 假绿」的那一半**（2026-10-19 改）：原先是「slug 字典序第一个含
 *   `hr/vo.rs` 的 worktree」，本机恰好命中正确的那份 —— 但只要有人建一个字典序更靠前、又是从
 *   已含 hr 的分支切出的 worktree（例如 `aaa-…`），对账就会对着**过期源码**跑，而且是对着
 *   一份「字段集差不多」的过期源码跑：结构变化能红，内容漂移则一路假绿。现在按可信度分三档：
 *   1. **与当前前端 worktree 同名**（同一分支的前后端改动只会落在这一份上）；
 *   2. 其余 worktree 按 `vo.rs` 的 **mtime 最新**优先（新切出来的、真正在改 hr 的那份最新）；
 *   3. 根 checkout 最后 —— 本域的后端代码可以只落在 worktree 里，根 checkout 里可能根本没有
 *      `hr` 模块，用「像不像后端仓」判会选上一份没有该模块的源码、核出一条假红。
 *
 * `HR_BACKEND_DIR` 可显式覆盖（多人多 worktree 时指定「就核这一份」）。⚠️ 设了却指不到被核
 *   模块时**直接抛**而不是静默回落到候选列表：回落会把「我以为在核 A」变成「实际在核 B」。
 *
 * ⚠️ **向上走到文件系统根，不设跳数上限**（照 `serial.contract.spec.ts` 的同款改法）：本
 *   worktree 恰好要 4 跳才够到 `hsh-erp/backend-rust`，写死跳数上限就只剩 1 跳余量 —— 再嵌
 *   一层目录就静默返回 null、整组对账无声失效。上限只能是「走到根」。
 */
function findBackendRoot(): string | null {
  const override = process.env.HR_BACKEND_DIR;
  if (override) {
    if (!existsSync(join(override, BACKEND_VO_REL))) {
      throw new Error(
        `HR_BACKEND_DIR=${override} 里没有 ${BACKEND_VO_REL} —— 它必须指向 hr 域源码所在的后端仓`,
      );
    }
    return override;
  }

  const worktrees: string[] = [];
  const roots: string[] = [];
  let dir = FRONTEND_ROOT;
  for (;;) {
    const be = join(dir, 'backend-rust');
    if (existsSync(be)) {
      roots.push(be);
      const wtDir = join(be, '.claude', 'worktrees');
      if (existsSync(wtDir)) {
        for (const slug of readdirSync(wtDir)) worktrees.push(join(wtDir, slug));
      }
    }
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }

  const hasHr = (c: string) => existsSync(join(c, BACKEND_VO_REL));
  const newestFirst = (a: string, b: string) =>
    statSync(join(b, BACKEND_VO_REL)).mtimeMs - statSync(join(a, BACKEND_VO_REL)).mtimeMs;
  const slug = frontendWorktreeSlug();
  const sameName = slug ? worktrees.filter((c) => basename(c) === slug && hasHr(c)) : [];
  const restWorktrees = worktrees.filter((c) => !sameName.includes(c) && hasHr(c)).sort(newestFirst);
  const restRoots = roots.filter(hasHr).sort(newestFirst);
  return [...sameName, ...restWorktrees, ...restRoots][0] ?? null;
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

/** 读一次后端源文件（`BACKEND` 为 `null` 时用到它的整组都 skip，走不到这里）。 */
function readBackendFile(rel: string): string {
  return readFileSync(join(BACKEND!, rel), 'utf8');
}

function readBackendVo(): string {
  return readBackendFile(BACKEND_VO_REL);
}

/**
 * 从后端 `shared/error.rs` 里抽出全部**业务码常量**（`pub const BIZ_HR_* : i32 = N;`），
 * 保持 `常量名 → 码值`。
 *
 * ⚠️ 只认声明行（行首 `pub const`）：`error.rs` 里另有大量 `code::BIZ_HR_*` 的**引用**与一张
 * 测试用表，把它们也抽进来会得到「同一个码名出现三次」的错误结果。抽到空集时**抛错**而不是
 * 返回空 Map —— 否则「正则哪天坏了 ⇒ 抽出 0 个业务码」会退化成「后端一个业务码都没有」，
 * 而子集断言对空集**恒真**，放行一次真实的漂移。
 */
function rustBizHrCodes(src: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of src.matchAll(/^\s*pub\s+const\s+(BIZ_HR_[A-Z0-9_]+)\s*:\s*i32\s*=\s*(\d+)\s*;/gm)) {
    out.set(m[1]!, Number(m[2]));
  }
  if (out.size === 0) {
    throw new Error(
      `后端 ${BACKEND_ERROR_REL} 里抽不出任何 BIZ_HR_* 业务码常量 —— 抽取方式失效（声明写法变了？）`,
    );
  }
  return out;
}

/** 递归列出目录下的 `.ts` / `.vue` 源文件（H9 扫注释锚点用）。 */
function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(p));
    else if (/\.(ts|vue)$/.test(entry.name)) out.push(p);
  }
  return out;
}

/** 取出某个 zod object 的键集（`z.object({…})` 的 `.shape` 就是声明时的键表）。 */
function zodKeys(schema: { shape: Record<string, unknown> }): string[] {
  return Object.keys(schema.shape).sort();
}

// ============================================================================
// H 组：六个读端点的行 VO / 信封 + 错误码集合 + 口径锚点
// ============================================================================

describe.skipIf(!BACKEND)('H：出参形状 / 业务码 / 口径锚点真·跨仓对账（对着后端 hr 域源码）', () => {
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

  it('H3b：端点 1 逐班次色带 —— hrShiftBandSchema 的键集与后端 ShiftBandOut 双向相等', () => {
    // ⚠️ **同 H1 的事故形状，只是这一层更隐蔽**：日行上的 `shift_bands` 元素是**嵌套**结构，
    // 而前端最初连字段名都没抄 ⇒ `.strict()` 在**每一次** `GET /hr/calendar/days` 上抛
    //   `unrecognized_keys`，全局日历整月「无数据」。嵌套层同样双向集合相等：后端加字段
    //   （前端没跟上 → 生产逐屏抛）与前端多声明（恒 `undefined` 的死字段，且真响应直接抛）。
    const backend = rustStructFields(readBackendVo(), 'ShiftBandOut').sort();
    const frontend = zodKeys(hrShiftBandSchema);
    expect(frontend, '端点 1 的 shift_bands 元素键与后端 ShiftBandOut 不一致').toEqual(backend);
    // 雪花 ID 走 JSON **string**（元素里这一列不是 number）。
    expect(frontend).toContain('shift_id');
    expect(frontend).toContain('effective_day_type');
    // 色带挂在**日行**上、不是信封上。
    expect(zodKeys(hrCalendarDaySchema)).toContain('shift_bands');
    expect(zodKeys(hrCalendarDaysResultSchema)).not.toContain('shift_bands');
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

  it('H7：下面逐个点名的 struct 里都不许出现 serde rename / skip_serializing_if（否则 H1..H6 的前提失效）', () => {
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
      'ShiftBandOut',
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

  it('H8：后端 `error.rs` 的**全部** `BIZ_HR_*` 业务码都必须在前端码表里（漏一个 = 用户只看到一句给日志看的 message）', () => {
    // ⚠️ **为什么这条能从根上消灭一整类漂移**：前端的文案表是逐个手工加的，而后端加码的成本
    // 是零 —— 本轮新增的 `BIZ_HR_FIELD_INVALID`（21909）就曾只被抄进注释、没进
    // `HR_SCHEDULE_ERROR_CODES`，而后端真落下来时用户读到的是 `contractDriftErrorText` 兜底
    // 返回的**后端 message**（「字段 code 超过 30 字符」，给排查用的那种）。对齐了列宽却没收进
    // 文案表，是同一件事做了一半。
    const backend = rustBizHrCodes(readBackendFile(BACKEND_ERROR_REL));
    const frontend = new Set<number>(Object.values(HR_SCHEDULE_ERROR_CODES));
    const missing = [...backend.entries()]
      .filter(([, code]) => !frontend.has(code))
      .map(([name, code]) => `${name} = ${code}`);
    expect(
      missing,
      '后端这些业务码没进前端 hrErrorText.ts 的 HR_SCHEDULE_ERROR_CODES（补码值 + 补一句人话）',
    ).toEqual([]);
    // ⚠️ **只断言「后端 ⊆ 前端」，不反向断言**：前端表里合法地多出不属于 hr 域的通用码
    // （`VERSION_CONFLICT` = 40901 就是 OCC 段给的）。反向断言要么开白名单、要么在没有
    // 站得住的理由时删掉一个在用的码 —— 那是比「漏一个码」更坏的失败。
  });

  it('H9：前端注释里每一处 `docs/api/hr.md §N.M` 都指向 hr.md 里**真实存在**的那一节，「清空 / `null`」那几处一律指向 `null 与缺省的语义`', () => {
    // ⚠️ **这些注释的全部价值就是「权威口径在后端文档这一节」**，指错一节读者按图索骥就会落到
    //   别的口径上（`§5.4` 是「空 items 落 21904」，与「显式清空发空串」毫无关系），而注释对不对
    //   没有任何机器能验 —— 只能对着真文档核。
    const doc = readBackendFile(BACKEND_HR_DOC_REL);
    const headings = new Map<string, string>();
    for (const m of doc.matchAll(/^###\s+(\d+\.\d+)\s+(.*)$/gm)) headings.set(m[1]!, m[2]!.trim());
    expect(
      headings.size,
      `后端 ${BACKEND_HR_DOC_REL} 里抽不出 §N.M 小节标题 —— 抽取方式失效`,
    ).toBeGreaterThan(0);
    // ⚠️ **钉住 §5.5 的身份**：hr.md 若把它改号成 5.6，下面「清空那几处指向 5.5」会继续绿，
    //   而锚点已经指错 —— 所以顺带要求这一节的标题里带「null」。
    expect(headings.get('5.5') ?? '', 'hr.md 的 §5.5 必须是「null 与缺省的语义」那一节').toContain(
      'null',
    );

    // 扫描范围：hr 域的全部前端源码（api / types / views/hr，含单测里的注释）。**本文件自身不在
    // 范围内** —— 守卫的判据写在守卫里会自证。
    const files = [
      join(FRONTEND_ROOT, 'src/api/hr.ts'),
      join(FRONTEND_ROOT, 'src/api/hr.contract.ts'),
      join(FRONTEND_ROOT, 'src/types/hr.ts'),
      ...listSourceFiles(join(FRONTEND_ROOT, 'src/views/hr')),
    ];
    const dangling: string[] = [];
    const misdirected: string[] = [];
    let total = 0;
    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split('\n');
      const rel = file.slice(FRONTEND_ROOT.length + 1);
      lines.forEach((line, i) => {
        for (const m of line.matchAll(/docs\/api\/hr\.md`?\s*§(\d+\.\d+)/g)) {
          total += 1;
          const section = m[1]!;
          if (!headings.has(section)) {
            dangling.push(`${rel}: ${section}`);
            continue;
          }
          // ⚠️ **窗口取 ±3 行**（锚点常与它的解释分家，跨一两行），且**窗口里出现多个不同锚点就
          //   不判** —— 「清空发空串见 §5.5、列宽守卫见 §5.7」这种一句话两个锚点的写法会被误伤。
          const win = lines.slice(Math.max(0, i - 3), i + 4);
          const winRefs = new Set(
            win.flatMap((l) => [...l.matchAll(/§(\d+\.\d+)/g)].map((x) => x[1]!)),
          );
          const talksClear = /清空|空串|缺省|`null`/.test(win.join('\n'));
          if (talksClear && winRefs.size === 1 && section !== '5.5') {
            misdirected.push(`${rel}: ${section}（这段在讲清空 / null 的语义）`);
          }
        }
      });
    }
    // 扫描器本身不许空转（后端文档被改名 / 前端锚点写法变了 ⇒ 一处都扫不到 = 假绿）。
    expect(total, '一处 hr.md 锚点都没扫到：扫描器失效或锚点写法变了').toBeGreaterThan(0);
    expect(dangling, '这些锚点指向 hr.md 里不存在的小节').toEqual([]);
    expect(misdirected, '讲清空 / null 语义的锚点没指向 hr.md 的「null 与缺省的语义」一节').toEqual([]);
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

// ============================================================================
// X 组：纯前端断言 + 跨仓对账的执行状态（**永远跑** —— CI 上没有后端仓时唯一还响的东西）
// ============================================================================

describe('X：错误码文案表与跨仓对账的执行状态', () => {
  it('X0：读不到后端仓时打一行 `[跳过]`，CI 环境变量在位时直接判红', () => {
    // ⚠️ **提示写在测试体内**（照 `serial.contract.spec.ts::L0` 的形状）：vitest 只把测试体内
    // 的 console 输出挂到该条用例的 stderr 上，写在模块顶层会被 reporter 吞掉。
    //
    // ⚠️ **为什么要从「一行 warn」升级成「CI 上必然红」**：纯前端 CI（只 checkout 前端仓）上
    //   H / L 组整段 skip，那 10 条断言退化成 no-op，而 `console.warn` 不影响退出码 ⇒
    //   `npm run test` 在那台机器上是**假绿**：看起来全过，实际这道网根本没织。所以 CI 上缺
    //   后端源码判红，本地缺后端源码照旧只提示 + 跳过 —— 不去打断每一个纯本地的开发机。
    if (BACKEND === null) {
      console.warn(
        `[跳过] 未找到后端仓（backend-rust/${BACKEND_VO_REL}，判据是「存在被核的那个模块」；` +
          '可用 HR_BACKEND_DIR 显式指定），H 组的字段 / 业务码 / 口径锚点对账与 L 组列宽对账未执行；' +
          'X1 / W 组类型断言与本仓内的其它断言仍然有效。',
      );
    }
    // `CI` 由 CI runner 注入（不是 vitest 特有）；本地一般为空 ⇒ 下面这行在本地不触发。
    if (process.env.CI) {
      expect(
        BACKEND,
        'CI 上找不到后端 hr 域源码 ⇒ 本文件的对账断言一条都没执行。要么在 CI 里 checkout 后端仓' +
          '（或把 HR_BACKEND_DIR 指过去），要么显式承认这道网没织，别让全绿骗过去',
      ).not.toBeNull();
    }
  });

  it('X1：`HR_SCHEDULE_ERROR_CODES` 的每个码都配了一句人话（码进表了、文案没进 = 用户看到后端 message）', () => {
    // 纯前端这一半：H8 核的是「后端有的码前端都收了」，本条核的是「收进来的码都有人话」——
    // 少了 H8 的跨仓前提，本条只能守「别漏写文案」，守不了「别漏整个码」。
    const missing = Object.entries(HR_SCHEDULE_ERROR_CODES)
      .filter(([, code]) => !HR_SCHEDULE_ERROR_TEXT[code]?.trim())
      .map(([name, code]) => `${name} = ${code}`);
    expect(missing, '这些业务码没有对应文案（用户会读到给日志看的后端 message）').toEqual([]);
  });
});
