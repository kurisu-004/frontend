// src/views/mail/digest/__tests__/mailDigestKeySet.spec.ts
//
// 2026-10-16 新增：mail 域**全部出参 schema 的键集清单**。
//
// ============================================================================
// 这份文件解决什么
// ============================================================================
// 本域的守门 schema 一律 `.strict()`，所以「schema 少声明一个后端会发的键」不是「少一列
// 展示」，而是**整条响应当场 parse 抛**。而少声明在单测里极难被发现：fixture 若是照着
// schema 手写的，那条用例就是**自证式**的（schema 少三个键、fixture 也少三个键，永远绿），
// 真实响应却带着那三个键。挂在 `POST /mail-digest/send` 的守门上尤其贵 —— 后端已经把邮件
// 发出去才返响应，解析失败 ⇒ 前端弹「发送失败」⇒ 用户重发 ⇒ **重复邮件**。
//
// 所以形态是**显式键集清单**（下方 `KEY_SETS`）：把每条出参 schema 的键集登记在案，逐个
// 断言「schema 的键集 == 清单里的键集」。清单与 schema 是**两份独立书写的东西**，少声明 /
// 多声明两个方向都会红。
//
// ============================================================================
// 人工复核方法（后端仓 `~/Code/hsh-erp/backend-rust`，master 分支）
// ============================================================================
//   1. 打开每条 `backend` 里标的 `文件:行号`；
//   2. 数一遍该 struct 的字段个数，与清单键数 / 注释里的「N 键」是否一致；
//   3. 逐个比字段名与本清单的键名。
//
// ⚠️ **区间必须是整个 struct（含闭合 `}`），不能截在最后一个字段之前**：截断的指针指不到
//   全体，第 2 步数出来的字段数会与紧邻的「N 键」直接矛盾 —— 而第 2 步正是要抓这个错。
//   同理**区间末端不得超过该 struct 的闭合行**：多写一行指的是别的声明，人工复核时会对着
//   一个无关的 struct 数字段，还以为清单错了。
// ⚠️ 本文件**刻意不在测试里读后端仓文件**：CI 上前端仓不一定有后端检出，那样的读法会在缺
//   检出时**静默跳过全部断言**（假阴），比没有护栏更糟。行号只写在注释里供人工核对。
// ⚠️ 行号会随后端插入字段而漂 —— **漂了以字段名为准**，顺手把行号改对即可；「键数」那
//   条断言守的是注释里的「N 键」与清单条目数一致，不会被行号漂移误伤。
//
// ============================================================================
// K1 锁的是**键名**，仅此而已
// ============================================================================
// 逐条断言比的是 `Object.keys(node.shape).sort()` 与清单键名排序后的两个集合，所以：
//   - **不锁可空性 / 类型 / 取值域** —— 把 `z.string()` 改成 `z.string().nullable()` 是零
//     信号，那由各 schema 自己的用例守；
//   - **不锁声明顺序** —— 清单里刻意也按后端 struct 的声明顺序书写（人工第 3 步能一眼扫过去），
//     但**那是纯约定、不被任何断言固定**：`keysOf()` 与 `keys` 两边都 `.sort()`，重排清单或
//     重排 schema 都是绿的。别把它当「顺序也已守住」的凭据。
//
// ============================================================================
// 两个方向的后果都严重，故两个方向都断言
// ============================================================================
//   · schema **少声明**后端会发的键 ⇒ `.strict()` 下当场抛（写端点尤其贵，见上）。
//   · schema **多声明**后端没有的键 ⇒ 同样当场抛，且那个键永远读到 undefined。
// 后端**新增**一个字段时本文件会红：必须显式决策「要不要进前端」，而不是让 `.strict()`
// 在生产上替这个决定、或者让 Zod 默认的 strip 静默吞掉（吞掉后前端「照样通过校验」，那一列
// 整列失效且无人发现）。
//
// ============================================================================
// 守卫清单
// ============================================================================
//   · K1：每条出参 schema 的键集 == `KEY_SETS` 里的键集（逐条一个用例，失败信息带后端真源）。
//   · K2：每条 `backend` 注释里标的「N 键」== 该条清单的条目数（防注释陈旧；失败信息带
//     「注释说 X 个 / 清单 Y 个」两个数）。
//   · K3：两个 schema 模块导出的**每个** ZodObject 都已登记（新增出参 schema 漏登记即红）。
//   · K4：send 与 logs 的行 schema 是同一个对象引用（后端同结构体，结构上不可能分叉）。
//   · K5：日志信封 `items` 的元素就是那条行 schema（信封不会挂到另一份形状上）。
//   · K3c：`NOT_OUT_PARAM` 恒等于那一份显式名单（防「加个名字就把 K3 变绿」的滥用豁免）。
//   · K3d：豁免名单里的名字确实还存在（防 schema 被删后留下一个什么也豁免不掉的悬空豁免）。
// （K3 的反向 —— 清单里每条都确实指向一个 ZodObject —— 由同组的 K3b 断言。）
//
// ⚠️ **K3 只覆盖清单里那两个硬编码模块**（`mailDigestSchema` + `mailAccountSchema`），
//   **不是「mail 域全部」的自动发现**：mail 域的出参 schema 若挪进第三个模块，K3 会
//   **静默失效**（扫不到 = 不红）。挪文件 / 新开 schema 模块时要一并更新 `modules` 数组。
//
// 环境：默认 node（本文件不碰 DOM，也不发请求）。
// ============================================================================

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as digestSchemaModule from '../mailDigestSchema';
import * as accountSchemaModule from '../../accounts/mailAccountSchema';
import {
  mailDigestColumnOptionSchema,
  mailDigestConfigDefaultsSchema,
  mailDigestConfigSchema,
  mailDigestFrequencyOptionSchema,
  mailDigestLogListSchema,
  mailDigestLogSchema,
  mailDigestMetaSchema,
  mailDigestPreviewSchema,
  mailDigestSendResultSchema,
} from '../mailDigestSchema';
import {
  mailAccountListSchema,
  mailAccountSchema,
  mailMetaSchema,
  mailPresetOptionSchema,
} from '../../accounts/mailAccountSchema';

// ============================================================================
// 键集清单
// ============================================================================

/** 一条登记项：`label` 是前端 schema 名，`backend` 是后端真源，`keys` 是后端字段名。 */
interface KeySetEntry {
  readonly label: string;
  /** 后端真源：`文件:行号::结构体名` + 键数（键数被 K2 断言，非注释摆设）。 */
  readonly backend: string;
  /** 被登记的 ZodObject（顶层出参 schema，或数组 / 对象里嵌的那一层）。 */
  readonly node: unknown;
  /** 后端字段名清单，与后端 struct 逐字对应。 */
  readonly keys: readonly string[];
}

/** `SendResultOut` 的 12 个字段（send 与 logs 共用同一份，两条登记项指向同一个 node）。 */
const SEND_RESULT_KEYS = [
  'log_id',
  'config_version',
  'trigger_source',
  'status',
  'subject',
  'to_recipients',
  'cc_recipients',
  'overdue_count',
  'upcoming_count',
  'html_bytes',
  'sent_at',
  'error_message',
] as const;

const KEY_SETS: readonly KeySetEntry[] = [
  {
    label: 'mailDigestConfigSchema',
    backend: 'mail_digest/dto.rs:498-532::ConfigOut（19 键）',
    node: mailDigestConfigSchema,
    keys: [
      'id',
      'version',
      'enabled',
      'frequency',
      'send_hour',
      'send_minute',
      'weekday',
      'day_of_month',
      'recipients',
      'cc_recipients',
      'include_overdue',
      'include_upcoming',
      'upcoming_days',
      'visible_columns',
      'subject_template',
      'sender_account_id',
      'smtp_configured',
      'created_at',
      'updated_at',
    ],
  },
  {
    label: 'mailDigestConfigDefaultsSchema',
    backend: 'mail_digest/dto.rs:537-554::ConfigDefaultsOut（14 键）',
    node: mailDigestConfigDefaultsSchema,
    keys: [
      'enabled',
      'frequency',
      'send_hour',
      'send_minute',
      'weekday',
      'day_of_month',
      'recipients',
      'cc_recipients',
      'include_overdue',
      'include_upcoming',
      'upcoming_days',
      'visible_columns',
      'subject_template',
      'sender_account_id',
    ],
  },
  {
    label: 'mailDigestMetaSchema',
    backend: 'mail_digest/dto.rs:620-625::MetaOut（4 键）',
    node: mailDigestMetaSchema,
    keys: ['frequencies', 'columns', 'defaults', 'upcoming_days_range'],
  },
  {
    label: 'mailDigestMetaSchema.upcoming_days_range',
    backend: 'mail_digest/dto.rs:600-603::RangeOut（2 键）',
    node: mailDigestMetaSchema.shape.upcoming_days_range,
    keys: ['min', 'max'],
  },
  {
    label: 'mailDigestMetaSchema.frequencies[]',
    backend: 'mail_digest/dto.rs:583-589::FrequencyOption（5 键）',
    node: mailDigestFrequencyOptionSchema,
    keys: ['value', 'label', 'needs_time', 'needs_weekday', 'needs_day_of_month'],
  },
  {
    label: 'mailDigestMetaSchema.columns[]',
    backend: 'mail_digest/dto.rs:593-596::ColumnOption（2 键）',
    node: mailDigestColumnOptionSchema,
    keys: ['key', 'label'],
  },
  {
    label: 'mailDigestPreviewSchema',
    backend: 'mail_digest/dto.rs:629-635::PreviewOut（5 键）',
    node: mailDigestPreviewSchema,
    keys: ['subject', 'html', 'overdue_count', 'upcoming_count', 'columns'],
  },
  {
    label: 'mailDigestSendResultSchema',
    backend: 'mail_digest/dto.rs:639-653::SendResultOut（12 键）',
    node: mailDigestSendResultSchema,
    keys: SEND_RESULT_KEYS,
  },
  {
    label: 'mailDigestLogSchema',
    backend: 'mail_digest/dto.rs:639-653::SendResultOut（12 键，与 send 同结构体）',
    node: mailDigestLogSchema,
    keys: SEND_RESULT_KEYS,
  },
  {
    label: 'mailDigestLogListSchema',
    backend: 'mail_digest/dto.rs:657-663::LogListOut（4 键）',
    node: mailDigestLogListSchema,
    keys: ['items', 'total', 'limit', 'offset'],
  },
  {
    label: 'mailAccountSchema',
    backend: 'scheduled_task/dto.rs:219-241::MailAccountOut（12 键）',
    node: mailAccountSchema,
    keys: [
      'id',
      'version',
      'name',
      'preset',
      'preset_label',
      'account',
      'host',
      'port',
      'tls_mode',
      'is_default',
      'created_at',
      'updated_at',
    ],
  },
  {
    label: 'mailAccountListSchema',
    backend: 'scheduled_task/dto.rs:270-272::MailAccountListOut（1 键）',
    node: mailAccountListSchema,
    keys: ['items'],
  },
  {
    label: 'mailMetaSchema',
    backend: 'scheduled_task/dto.rs:208-210::MailMetaOut（1 键）',
    node: mailMetaSchema,
    keys: ['presets'],
  },
  {
    label: 'mailMetaSchema.presets[]',
    backend: 'scheduled_task/dto.rs:197-204::PresetOption（5 键）',
    node: mailPresetOptionSchema,
    keys: ['value', 'label', 'host', 'port', 'tls_mode'],
  },
];

// ============================================================================
// helpers
// ============================================================================

/** node 的键集（排序后，便于与清单逐字比对而不受声明顺序影响）。 */
function keysOf(node: unknown): string[] {
  return Object.keys((node as { shape: Record<string, unknown> }).shape).sort();
}

/** ZodArray 字段的元素（K5 用它确认信封 `items` 挂的是那条行 schema）。 */
function elementOf(arrayField: unknown): unknown {
  return (arrayField as { element: unknown }).element;
}

/** 表单校验器是 `.superRefine()` 的产物、类型上仍是 ZodObject，但它**不接任何后端出参**
 *  ⇒ 显式排除。其余任何新导出的 ZodObject 漏登记都会被 K3 拦下。
 *
 * ⚠️ 这份名单是**豁免名单、不是白名单的补充**：谁都能把名字加进来让 K3 变绿。所以它的
 *   内容本身被 K3c 断言钉死 —— 加名字必须同时改那条断言，届时就是一次显式决定。 */
const NOT_OUT_PARAM = new Set(['mailDigestFormSchema']);

// ============================================================================
// K1 / K2：逐条键集对账
// ============================================================================

describe('mail 域出参键集清单（schema ↔ 后端 DTO，逐字对账）', () => {
  for (const entry of KEY_SETS) {
    it(`${entry.label}：键集与后端 DTO 一致（${entry.backend}）`, () => {
      expect(keysOf(entry.node), `${entry.label} 的键集与后端 ${entry.backend} 不一致`).toEqual(
        [...entry.keys].sort(),
      );
    });
  }

  it('K2：每条 backend 注释里标的键数 == 该条清单的条目数（防注释陈旧）', () => {
    const stale = KEY_SETS.filter(
      (e) => /（(\d+) 键/.exec(e.backend)?.[1] !== String(e.keys.length),
    ).map((e) => {
      // 两个数都带上：只说「不一致」的话，读者还得自己回查一遍才知道该改注释还是该改清单。
      const said = /（(\d+) 键/.exec(e.backend)?.[1] ?? '（没标键数）';
      return `${e.label}：${e.backend} 注释说 ${said} 个，清单实际 ${e.keys.length} 个`;
    });
    expect(stale).toEqual([]);
  });
});

// ============================================================================
// K3：登记无遗漏 —— 新增出参 schema 必须登记
// ============================================================================

describe('mail 域出参键集登记的完整性', () => {
  it('K3：两个 schema 模块导出的每个 ZodObject 都已登记（新增出参 schema 漏登记即红）', () => {
    const registered = new Set(KEY_SETS.map((e) => e.node));
    const modules: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      ['mailDigestSchema', digestSchemaModule as unknown as Record<string, unknown>],
      ['mailAccountSchema', accountSchemaModule as unknown as Record<string, unknown>],
    ];
    const missing: string[] = [];
    for (const [modName, mod] of modules) {
      for (const [name, value] of Object.entries(mod)) {
        if (NOT_OUT_PARAM.has(name)) continue;
        if (!(value instanceof z.ZodObject)) continue;
        if (!registered.has(value)) missing.push(`${modName}.${name}`);
      }
    }
    expect(missing, `下列出参 schema 未登记键集：${missing.join('、')}`).toEqual([]);
  });

  it('K3b：清单里没有写错的引用（每条的 node 都仍是 ZodObject）', () => {
    const stale = KEY_SETS.filter((e) => !(e.node instanceof z.ZodObject)).map((e) => e.label);
    expect(
      stale,
      `下列登记项的 node 不是 ZodObject（多半是写错了引用）：${stale.join('、')}`,
    ).toEqual([]);
  });

  it('K3c：豁免名单 NOT_OUT_PARAM 恒等于那一份显式清单（加名字必须改本条断言）', () => {
    // K3 是「扫模块导出 vs 清单」的方向；NOT_OUT_PARAM 是这条扫描的**逃逸口**，谁都能把
    // 名字加进去让 K3 变绿（新增一个表单 schema 就足以让整个出参登记形同虚设）。所以用
    // 与 K2 同款的「防清单陈旧」思路，把这份名单的内容本身钉死 —— 加名字是一次显式决定。
    expect([...NOT_OUT_PARAM].sort()).toEqual(['mailDigestFormSchema']);
  });

  it('K3d：豁免名单里的名字确实还存在于被扫的模块里（删掉 schema 后别留悬空豁免）', () => {
    const exported = new Set([
      ...Object.keys(digestSchemaModule),
      ...Object.keys(accountSchemaModule),
    ]);
    const dangling = [...NOT_OUT_PARAM].filter((name) => !exported.has(name));
    // 悬空豁免本身不致命（它什么也豁免不掉），但它说明有人删/改了 schema 却没收拾名单，
    // 此时真正的风险是「他以为 K3 还盖着某个东西」—— 指出来比静默留着强。
    expect(
      dangling,
      `NOT_OUT_PARAM 里的下列名字已不存在于任何 schema 模块：${dangling.join('、')}`,
    ).toEqual([]);
  });
});

// ============================================================================
// K4 / K5：send 与 logs 同结构体的结构性不变量
// ============================================================================

describe('send 与 logs 同结构体（后端 LogListOut.items 的元素类型就是 SendResultOut）', () => {
  it('K4：mailDigestLogSchema 与 mailDigestSendResultSchema 是同一个对象引用', () => {
    expect(mailDigestLogSchema).toBe(mailDigestSendResultSchema);
  });

  it('K5：日志信封 items 的元素就是那条行 schema（信封不会挂到另一份形状上）', () => {
    expect(elementOf(mailDigestLogListSchema.shape.items)).toBe(mailDigestLogSchema);
  });
});
