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
// ⚠️ 本文件**刻意不在测试里读后端仓文件**：CI 上前端仓不一定有后端检出，那样的读法会在缺
//   检出时**静默跳过全部断言**（假阴），比没有护栏更糟。行号只写在注释里供人工核对。
// ⚠️ 行号会随后端插入字段而漂 —— **漂了以字段名为准**，顺手把行号改对即可；「键数」那
//   条断言守的是注释里的「N 键」与清单条目数一致，不会被行号漂移误伤。
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
//   · K2：每条 `backend` 注释里标的「N 键」== 该条清单的条目数（防注释陈旧）。
//   · K3：两个 schema 模块导出的**每个** ZodObject 都已登记（新增出参 schema 漏登记即红）。
//   · K4：send 与 logs 的行 schema 是同一个对象引用（后端同结构体，结构上不可能分叉）。
//   · K5：日志信封 `items` 的元素就是那条行 schema（信封不会挂到另一份形状上）。
// （K3 的反向 —— 清单里每条都确实指向一个 ZodObject —— 由同组的 K3b 断言。）
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
    backend: 'mail_digest/dto.rs:537-551::ConfigDefaultsOut（14 键）',
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
    backend: 'mail_digest/dto.rs:657-664::LogListOut（4 键）',
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
 *  ⇒ 显式排除。其余任何新导出的 ZodObject 漏登记都会被 K3 拦下。 */
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
    ).map((e) => `${e.label}：注释与清单条目数不一致`);
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
