// src/api/__tests__/serial.contract.spec.ts
//
// 2026-10-19 新增：`POST /serials/release-terminal` 的**跨仓 wire 契约**守卫 —— 真读
// 后端 `modules/serial/dto.rs` 与前端守门 schema 逐字对拍。
//
// ## 为什么要有这个文件
//
// 本域的另两份测试都**自证**：
//   - `src/api/__tests__/serial.spec.ts` 钉的是「api 层不 parse + URL / body 打在哪」
//     （不碰出参形状）；
//   - `views/parts/list/composables/__tests__/serialReleaseSchema.spec.ts` 的 fixture 是
//     **前端自己手写的字面量**，断言的只是「parse 接在返回路径上 / `.strict()` 按预期抛」。
// ⇒ 「后端此刻长什么样」这件事**没有任何一条测试有条件变红**。而本域的出参形状错了就是
// **整个响应被拒**：`kind` 判别位大小写对不上 ⇒ `.strict()` + `z.enum` 让**每一行明细都
// 过不了 Zod**、对话框永远打不开（不是降级，是功能不存在），且失败发生在契约层、
// **不产生任何红色报错**。`drawing_no` 的可空性错一档则是恒不触发的死分支 / 静默降级。
//
// ⇒ 真源在后端仓的 `.rs` 源文件里（CLAUDE.md：「后端契约的载体是**代码注释**」）。本文件
// 把那份源码读进来对拍 —— 纪律与 `printTemplates.contract.spec.ts`（V7 组）、
// `api/files/__tests__/previewContract.spec.ts`（`findBackendRoot`）同源：定位后端仓 →
// 真读源码 → 正则抽字段 → 双向集合相等 / 逐字比对。
//
// **读不到时整段 `skipIf` 并在 L0 里打一行 `[跳过]`，不静默通过**（那条提示写在测试体内
// 才不会被 reporter 吞掉，见 L0 的注释）。
//
// ⚠️ **本文件自己的强度边界（能守什么 / 守不住什么，别越读越信）**：
//   - **只在本机能读到后端仓时生效**。CI 只 checkout 前端仓 ⇒ V 组整段 skip 并打一行
//     `[跳过]`。所以另配了 L 组（纯前端、永远跑）承担「别把字面量改小写 / 改可空」这道
//     CI 侧信号；**L 组只钉前端字面量，不证明它对**，对不对由 V 组说了算。
//   - **只认「Rust 字段名 == wire 上的 JSON 键」这一前提**。V5 专门守它。
//   - **HTTP 出参那半只比字段名与可空性**，不逐个比标量类型（`i64` → `z.number().int()` 这一层
//     的运行时后果是**响的**，不是静默失效）。**WS 那一半（V7）不受这条限制** —— 它比的是事件
//     kind 与 payload 键名的字面量，因为那条通道连 Zod 守门都没有，字面量写错是纯静默。

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  releaseTerminalSerialsOutSchema,
  releasedSerialItemSchema,
} from '@/views/parts/list/composables/serialReleaseSchema';

// ============================================================================
// 跨仓对账基建 —— 只服务于下面的 V 组。判据与候选顺序照 printTemplates.contract.spec.ts。
// ============================================================================

const FRONTEND_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

/** 被核的那份后端源码（`serial` 是 2026-10-19 新立域，根 checkout 里**根本没有**这个模块，
 *  只有对应的后端 worktree 里有）。 */
const BACKEND_DTO_REL = 'src/modules/serial/dto.rs';
const BACKEND_HANDLER_REL = 'src/modules/serial/handler.rs';
const BACKEND_MODULES_REL = 'src/modules/mod.rs';

/**
 * 定位后端仓根目录；返回 `null` 表示「本机没有可读的后端源」。
 *
 * 判据是「**存在被核的那个模块**」（`src/modules/serial/dto.rs`）而不是「这是个后端仓」——
 * 根 checkout 里没有 `serial` 模块（同名后端 worktree 才有）⇒ 用「像不像后端仓」判会把
 * 根 checkout 选上，然后对着一份**根本没有 serial 域**的源码核出一条读不懂的红。候选顺序
 * 把 worktree 排在根 checkout 前面（前端并行开发分支对应的后端改动也只落在后端的同名
 * worktree 里）。
 *
 * ⚠️ **向上走到文件系统根，不设跳数上限**（2026-10-19 改）：原先写死 5 跳，而本 worktree
 * 已经要**恰好 4 跳**（`.claude/worktrees/release-terminal-serials` → `frontend` →
 * `hsh-erp`），只剩 1 跳余量 —— 再嵌一层目录就静默返回 null ⇒ V 组整段 skip 并打一行
 * `[跳过]`，方向安全但守卫会**无声失效**。上限只能是「走到根」。
 */
function findBackendRoot(): string | null {
  const worktrees: string[] = [];
  const roots: string[] = [];
  let dir = FRONTEND_ROOT;
  for (;;) {
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
    if (existsSync(join(c, BACKEND_DTO_REL))) return c;
  }
  return null;
}

const BACKEND = findBackendRoot();

/** 读一次后端源文件（V 组专用；`BACKEND` 为 null 时那段整段 skip，不会走到这里）。 */
function readBackend(rel: string): string {
  return readFileSync(join(BACKEND!, rel), 'utf8');
}

/** 从后端 Rust 源码里抽出某个 `pub struct` 的字段声明（字段名 + 类型文本）。 */
function rustStructFieldDecls(src: string, structName: string): { name: string; type: string }[] {
  const head = new RegExp(`^\\s*pub\\s+struct\\s+${structName}\\s*\\{`, 'm').exec(src);
  if (!head) throw new Error(`后端 dto.rs 里找不到 struct ${structName} —— 跨仓对账无法进行`);
  const out: { name: string; type: string }[] = [];
  for (const line of src.slice(head.index + head[0].length).split('\n')) {
    if (line.trim() === '}') break;
    // doc 注释行（`///`）与属性行（`#[`）的行首都不是 `pub`，天然被跳过。
    const m = /^\s*pub\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+?)\s*,\s*$/.exec(line);
    if (m) out.push({ name: m[1]!, type: m[2]! });
  }
  if (out.length === 0) throw new Error(`后端 dto.rs 的 struct ${structName} 抽出 0 个字段`);
  return out;
}

/** 同上，只取字段名（按声明顺序）。 */
function rustStructFields(src: string, structName: string): string[] {
  return rustStructFieldDecls(src, structName).map((f) => f.name);
}

/** 取某个 `pub struct` 里某个字段的类型文本（抽不到抛错，不返回 undefined）。 */
function rustFieldType(src: string, structName: string, field: string): string {
  const decl = rustStructFieldDecls(src, structName).find((f) => f.name === field);
  if (!decl) throw new Error(`后端 struct ${structName} 里找不到字段 ${field}`);
  return decl.type;
}

/**
 * 抽 `dto.rs` 里 `pub const <NAME>: &str = "<字面量>";` 的**字面量**。
 *
 * ⚠️ 这两个常量是 `kind` 判别位的**唯一真源**（后端 `mod.rs` 的域文档明写「别在别处
 * 重写字符串」）⇒ 前端那两个字面量必须与它们逐字相同，**包括大小写**。
 */
function rustStrConstValue(src: string, constName: string): string {
  const m = new RegExp(
    `^\\s*pub\\s+const\\s+${constName}\\s*:\\s*&str\\s*=\\s*"([^"]*)"`,
    'm',
  ).exec(src);
  if (!m) throw new Error(`后端 dto.rs 里找不到常量 ${constName} —— 跨仓对账无法进行`);
  return m[1]!;
}

/** 取出某个 zod object 的键集（`z.object({…})` 的 `.shape` 就是声明时的键表）。 */
function zodKeys(schema: { shape: Record<string, unknown> }): string[] {
  return Object.keys(schema.shape).sort();
}

/** 取某个 zod `enum` 的全部选项（`z.enum([…])` 的 `.options`）。 */
function zodEnumOptions(schema: unknown): string[] {
  const options = (schema as { options?: unknown }).options;
  if (!Array.isArray(options)) throw new Error('取不到 zod enum 的 options —— 取值方式变了');
  return options as string[];
}

/**
 * 取某个 `pub struct` 的**完整定义区**：`pub struct` 那行**上方紧邻的属性 / doc 注释行**
 * + struct 行本身 + 体内直到收尾 `}` 的全部行。
 *
 * ⚠️ **起点必须上移到 struct 上方的属性区**（2026-10-19 改）：`#[serde(rename_all =
 * "camelCase")]` / `#[serde(flatten)]` 这类让「Rust 字段名 == wire 键」这条前提失效的属性，
 * 就写在 `pub struct` 那一行**之前** —— 只扫体内行会整段漏掉它们，而 V1 / V2 的双向对账
 * 恰恰是靠这条前提成立的。doc 注释一并纳入是**为了跨过夹在属性与 struct 之间的注释**
 * （`#[derive]` / `/// 说明` / `pub struct` 的排列在 Rust 里合法），但 doc 注释里**常引用**
 * `#[serde(…)]` 的**文字**（讲别的类型怎么改名），所以判定时只认 `#` 开头的行 —— 见 V5。
 */
function rustStructRegion(src: string, structName: string): string[] {
  const lines = src.split('\n');
  const idx = lines.findIndex((l) =>
    new RegExp(`^\\s*pub\\s+struct\\s+${structName}\\s*\\{`).test(l),
  );
  if (idx < 0) throw new Error(`后端源码里找不到 struct ${structName}`);
  let start = idx;
  for (let i = idx - 1; i >= 0; i -= 1) {
    const t = lines[i]!.trim();
    if (t.startsWith('#[') || t.startsWith('//')) start = i;
    else break;
  }
  return lines.slice(start);
}

// ============================================================================
// L 组：纯前端断言（永远跑，CI 上没有后端仓时这一组是唯一信号）
// ----------------------------------------------------------------------------
// ⚠️ **L 组不证明字面量是对的，只证明它没被改**：「大写」这件事的正确性由 V3 对着后端
//   `dto.rs` 的两个常量判定；L1 在这里的作用是 —— 有人把前端的 `kind` 顺手改成小写去
//   「迁就还没合并的后端」时，本组当场红，而不是等合并后才发现明细表整体打不开。
// ============================================================================

describe('L：前端字面量不许被单边改动（CI 侧的唯一信号，对不对由 V 组说了算）', () => {
  it('L0：跨仓对账的执行状态播报 —— 读不到后端仓时打一行 `[跳过]` 提示（**本条不断言**）', () => {
    // ⚠️ 这行提示刻意**写在测试体内**而不是模块顶层：vitest 只把「测试体内」的 console
    // 输出挂到该条用例的 stderr 上，写在模块顶层的话提示会被 reporter 直接吞掉，
    // 「没核成」就真的长得跟「核过了」一模一样。
    //
    // ⚠️ **本条是状态播报，不是断言**：它没有 `expect`，也不该有 —— 「要么没读到、
    // 要么读到了且那个文件确实在」这个析取**由 `findBackendRoot` 的构造保证**（该函数
    // 只在 `existsSync(join(root, dto.rs))` 为真时才返回该 root），写成断言就是一个
    // **恒真、永不失败**的假信号。本条的真载荷就是下面那行 `console.warn`：CI 只 checkout
    // 前端仓时它出现，提示「V 组没跑成」；读到后端仓时它不出现。
    if (BACKEND === null) {
      console.warn(
        `[跳过] 未找到后端仓（backend-rust/${BACKEND_DTO_REL}，判据是「存在被核的那个模块」），` +
          'V 组跨仓对账未执行；L 组的前端字面量断言与 serial.spec.ts 的 URL / 守门点断言仍然有效。',
      );
    }
  });

  it('L1：kind 的两个字面量是大写 ASSEMBLY / PART，且小写形态必抛', () => {
    expect(zodEnumOptions(releasedSerialItemSchema.shape.kind)).toEqual(['ASSEMBLY', 'PART']);
    const base = {
      id: '1900000000000000001',
      serial_no: 'WO-2026-0001',
      drawing_no: 'DWG-A-01',
      status: 'COMPLETED',
    };
    for (const kind of ['ASSEMBLY', 'PART']) {
      expect(releasedSerialItemSchema.safeParse({ ...base, kind }).success).toBe(true);
    }
    // ⚠️ 小写不是合法形态（判别位两侧必须逐字相同，全仓惯例是大写）。
    for (const kind of ['assembly', 'part']) {
      expect(
        releasedSerialItemSchema.safeParse({ ...base, kind }).success,
        `kind 收到小写「${kind}」必须被拒`,
      ).toBe(false);
    }
  });

  it('L2：drawing_no / serial_no / id 三键都不可空（null / undefined 一律必拒）', () => {
    // 后端三列在 baseline 里都是 `NOT NULL` ⇒ 三个字段都是 `String` 而不是 `Option<String>`。
    // 本条守的是「消费侧不许长出恒不触发的 `?? '—'` / `=== null` 死分支」的**前半段**
    // （schema 侧）；后半段（预览框真去加兜底）靠 serialReleaseSchema.spec.ts 的 R5 守着。
    const base = { kind: 'PART', id: '1', serial_no: 'WO-1', drawing_no: 'DWG-1', status: 'OK' };
    for (const key of ['id', 'serial_no', 'drawing_no'] as const) {
      for (const bad of [null, undefined]) {
        expect(
          releasedSerialItemSchema.safeParse({ ...base, [key]: bad }).success,
          `${key} 收到 ${String(bad)} 必须被拒`,
        ).toBe(false);
      }
    }
  });
});

// ============================================================================
// V 组：真·跨仓对账（对着后端 `modules/serial/dto.rs`）
// ============================================================================

describe.skipIf(!BACKEND)('V：出参形状 / 判别位大小写真·跨仓对账（对着后端 serial/dto.rs）', () => {
  it('V1：明细行 VO —— releasedSerialItemSchema 的键集与后端 ReleasedSerialItem 双向相等', () => {
    const backend = rustStructFields(readBackend(BACKEND_DTO_REL), 'ReleasedSerialItem').sort();
    const frontend = zodKeys(releasedSerialItemSchema);
    expect(
      frontend,
      '明细行 VO 的键与后端 ReleasedSerialItem 不一致（改一边就要改另一边）',
    ).toEqual(backend);
  });

  it('V2：出参顶层 —— releaseTerminalSerialsOutSchema 的键集与后端 ReleaseTerminalOut 双向相等', () => {
    const backend = rustStructFields(readBackend(BACKEND_DTO_REL), 'ReleaseTerminalOut').sort();
    const frontend = zodKeys(releaseTerminalSerialsOutSchema);
    expect(frontend, '出参顶层键与后端 ReleaseTerminalOut 不一致（改一边就要改另一边）').toEqual(
      backend,
    );
  });

  it('V3：kind 判别位 —— 前端两个字面量与后端 KIND_ASSEMBLY / KIND_PART 逐字相同（大小写也含）', () => {
    const src = readBackend(BACKEND_DTO_REL);
    const backend = [
      rustStrConstValue(src, 'KIND_ASSEMBLY'),
      rustStrConstValue(src, 'KIND_PART'),
    ].sort();
    const frontend = [...zodEnumOptions(releasedSerialItemSchema.shape.kind)].sort();
    expect(
      frontend,
      'kind 的字面量与后端两个常量不一致（判别位两侧大小写必须逐字相同，否则每一行明细都过不了 Zod）',
    ).toEqual(backend);
    // 两个常量本身也必须互不相同 —— 同一个值重复声明会让「判别位」这件事本身失效。
    expect(backend[0]).not.toBe(backend[1]);
  });

  it("V4：id / serial_no / drawing_no 三个字段都是 String（不是 Option<String>），kind 是 &'static str", () => {
    const src = readBackend(BACKEND_DTO_REL);
    for (const field of ['id', 'serial_no', 'drawing_no']) {
      const type = rustFieldType(src, 'ReleasedSerialItem', field);
      expect(
        type,
        `后端 ReleasedSerialItem.${field} 变成「${type}」⇒ wire 形态已变，前端 z.string() 要同步重判`,
      ).toBe('String');
    }
    // `kind` 是 `&'static str`（不是 String、也不是 Option<String>），它承载判别位。
    expect(rustFieldType(src, 'ReleasedSerialItem', 'kind')).toBe("&'static str");
  });

  it('V5：两个 struct 的完整定义区（**含 struct 上方的属性**）都不许出现 serde rename / skip_serializing_if / flatten（否则 wire 键与字段名分家，V1/V2 的前提失效）', () => {
    const src = readBackend(BACKEND_DTO_REL);
    const offenders: string[] = [];
    for (const name of ['ReleasedSerialItem', 'ReleaseTerminalOut']) {
      for (const line of rustStructRegion(src, name)) {
        const t = line.trim();
        // ⚠️ **只判 `#` 开头的行**：doc 注释里常**引用** `#[serde(rename = "…")]` 的文字
        // （这两个 struct 的注释就在解释「status 字段沿用 PartStatus 的大写形态」），
        // 那不是属性、不构成对「Rust 字段名 == wire 键」这条前提的破坏。
        if (t.startsWith('#[') && /#\[serde\([^)]*(rename|skip_serializing_if|flatten)/.test(t)) {
          offenders.push(`${name}: ${t}`);
        }
      }
    }
    expect(offenders, '这两个 struct 出现了 serde rename / skip_serializing_if / flatten').toEqual(
      [],
    );
  });

  it('V6：URL 与 HTTP method —— 后端 nest 前缀 /serials + 子路由 POST /release-terminal，与前端拼出的路径与 method 逐段相同', () => {
    // 前端没有任何类型能挡住 URL 打错（同 printTemplates.contract.spec.ts 的同款理由），
    // 而 URL 错了是 404、只在「点一下才发现」时暴露。
    const modules = readBackend(BACKEND_MODULES_REL);
    expect(modules, '后端 src/modules/mod.rs 里找不到 .nest("/serials", …)').toContain(
      '.nest("/serials"',
    );
    const handler = readBackend(BACKEND_HANDLER_REL);
    expect(handler, '后端 serial/handler.rs 里找不到 .route("/release-terminal", …)').toContain(
      '.route("/release-terminal"',
    );
    // ⚠️ **method 也要核**（2026-10-19 补）：只断言路径存在时，后端把 `post(...)` 改成
    // `get(...)` / `any(...)` 前端照样 405（路径还在、method 变了），而守卫全绿。
    // 前端这一侧打的是 `api.post`，所以这里逐字核 `post(`。
    expect(
      handler,
      '后端 /release-terminal 不是 POST —— 前端 api.post 会打 405，而只核路径的守卫全绿',
    ).toContain('.route("/release-terminal", post(');
    // 前端这一侧：域前缀 `/serials` + 子路径 `/release-terminal`，两段都在 `src/api/serial.ts`。
    const src = readFileSync(new URL('../serial.ts', import.meta.url), 'utf8');
    expect(src).toContain("'/serials/release-terminal'");
  });

  it('V7：WS 汇总事件的 kind 与两个 payload 键 —— 后端 handler.rs 广播的字面量与前端逐字相同', () => {
    // ⚠️ **为什么必须单独守**：V 组其余各条覆盖的是 HTTP DTO 与 URL，WS 帧走的是**另一条
    // 通道** —— `api/dashboard.ts` 对帧只做 `JSON.parse` + cast，**没有 Zod 守门** ⇒ 这三个
    // 跨仓字面量写错是**纯静默**：白名单永不命中，常驻大屏静默停更（dashboard 三 query
    // 都是 `gcTime: POSITIVE_INFINITY` 且无 `refetchInterval`，没有第二条通道）。
    const handler = readBackend(BACKEND_HANDLER_REL);
    expect(handler, '后端 serial/handler.rs 里找不到 WS 广播的 kind 字面量').toContain(
      '"TERMINAL_SERIALS_RELEASED"',
    );
    for (const key of ['assembly_count', 'part_count']) {
      expect(handler, `后端 serial/handler.rs 的 WS payload 里没有 ${key} 这个键`).toContain(
        `"${key}":`,
      );
    }
    // 前端这一侧：三个字面量都是**编译期擦除的**（`DashboardEventType` / `DashboardEventPayload`
    // 没有运行期值），所以读源码文本比对 —— 照 V6 核 URL 的同款做法。事件联合里的 kind 与
    // payload 的两个键各读一处，白名单那一份也读（它决定了「命中后会不会重取」，而
    // `useDashboardInvalidation.spec.ts` 的 I1 只断言元素**数**、换掉其中一个仍绿）。
    const types = readFileSync(new URL('../../types/dashboard.ts', import.meta.url), 'utf8');
    expect(types, "前端 types/dashboard.ts 的事件联合里没有 'TERMINAL_SERIALS_RELEASED'").toContain(
      "'TERMINAL_SERIALS_RELEASED'",
    );
    for (const key of ['assembly_count', 'part_count']) {
      expect(types, `前端 types/dashboard.ts 的 payload 里没有 ${key} 这个键`).toContain(
        `${key}?:`,
      );
    }
    const whitelist = readFileSync(
      new URL('../../views/dashboard/composables/useDashboardInvalidation.ts', import.meta.url),
      'utf8',
    );
    expect(
      whitelist,
      "AFFECTS_DASHBOARD 白名单里没有 'TERMINAL_SERIALS_RELEASED'（事件永不失效）",
    ).toContain("'TERMINAL_SERIALS_RELEASED'");
  });
});
