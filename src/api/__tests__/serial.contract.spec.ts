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
//   - **只比字段名与可空性**，不逐个比标量类型（`i64` → `z.number().int()` 这一层的
//     运行时后果是**响的**，不是静默失效）。

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
 */
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

// ============================================================================
// L 组：纯前端断言（永远跑，CI 上没有后端仓时这一组是唯一信号）
// ----------------------------------------------------------------------------
// ⚠️ **L 组不证明字面量是对的，只证明它没被改**：「大写」这件事的正确性由 V3 对着后端
//   `dto.rs` 的两个常量判定；L1 在这里的作用是 —— 有人把前端的 `kind` 顺手改成小写去
//   「迁就还没合并的后端」时，本组当场红，而不是等合并后才发现明细表整体打不开。
// ============================================================================

describe('L：前端字面量不许被单边改动（CI 侧的唯一信号，对不对由 V 组说了算）', () => {
  it('L0：跨仓对账的执行状态 —— 读不到后端仓时打一行 `[跳过]` 提示（**不静默通过**）', () => {
    // ⚠️ 这行提示刻意**写在测试体内**而不是模块顶层：vitest 只把「测试体内」的 console
    // 输出挂到该条用例的 stderr 上，写在模块顶层的话提示会被 reporter 直接吞掉，
    // 「没核成」就真的长得跟「核过了」一模一样。
    if (BACKEND === null) {
      console.warn(
        `[跳过] 未找到后端仓（backend-rust/${BACKEND_DTO_REL}，判据是「存在被核的那个模块」），` +
          'V 组跨仓对账未执行；L 组的前端字面量断言与 serial.spec.ts 的 URL / 守门点断言仍然有效。',
      );
    }
    // 两种状态都必须是「说得清」的：读到 ⇒ V 组真的跑了（后端源文件此刻可读）；读不到 ⇒
    // 上面那行提示出现。本条不因为「读不到」而红 —— CI 只 checkout 前端仓，红了就是噪声。
    expect(BACKEND === null || existsSync(join(BACKEND, BACKEND_DTO_REL))).toBe(true);
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

  it('V5：两个 struct 里都不许出现 serde rename / skip_serializing_if（否则 wire 键与字段名分家，V1/V2 的前提失效）', () => {
    const src = readBackend(BACKEND_DTO_REL);
    const offenders: string[] = [];
    for (const name of ['ReleasedSerialItem', 'ReleaseTerminalOut']) {
      const head = new RegExp(`^\\s*pub\\s+struct\\s+${name}\\s*\\{`, 'm').exec(src);
      if (!head) throw new Error(`后端 dto.rs 里找不到 struct ${name}`);
      for (const line of src.slice(head.index + head[0].length).split('\n')) {
        if (line.trim() === '}') break;
        // 只看**字段上的**属性行；`#[derive(…)]` 在 `pub struct` 之前，不在本段里。
        if (/#\[serde\([^)]*(rename|skip_serializing_if)/.test(line)) {
          offenders.push(`${name}: ${line.trim()}`);
        }
      }
    }
    expect(offenders, '这两个 struct 出现了 serde rename / skip_serializing_if').toEqual([]);
  });

  it('V6：URL —— 后端 nest 前缀 /serials + 子路由 /release-terminal，与前端拼出的路径逐段相同', () => {
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
    // 前端这一侧：域前缀 `/serials` + 子路径 `/release-terminal`，两段都在 `src/api/serial.ts`。
    const src = readFileSync(new URL('../serial.ts', import.meta.url), 'utf8');
    expect(src).toContain("'/serials/release-terminal'");
  });
});
