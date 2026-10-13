// src/views/mail/digest/__tests__/mailDigestSchema.spec.ts
//
// 2026-10-13 新增：交期汇总邮件域 Zod schema 单测。三组：
//
//  1. **守门 schema**（config / meta / preview / send / logs）：雪花 ID 恒为 string、
//     计数恒为 number、缺键即抛（Zod strip 陷阱）、多一个键即抛（`.strict()`）。
//  2. **表单校验**：4 种频率 × 配套字段的全部组合（这组直接对应后端 21704 =
//     `MAIL_DIGEST_ERROR_CODES.INVALID_FREQUENCY_COMBO` —— 前端提前拦的那一层，漏一条
//     就变成「点了保存才知道不行」）；邮箱（对应 21703 = `…INVALID_RECIPIENT`）；
//     `upcoming_days` 的空值语义（`el-input-number` 清空 → 不回落成 0）。
//  3. **字段聚焦**：校验 issue 的 `path[0]` 必须指向**具体输入项**（页面据此标红 /
//     高亮），笼统挂在 `frequency` 上会让用户盯着一个看不出该改哪儿的报错。
//
// 环境：默认 node（本文件不碰 DOM）。

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAIL_DIGEST_FREQUENCY_FLAGS,
  makeMailDigestFormSchema,
  mailDigestConfigDefaultsSchema,
  mailDigestConfigSchema,
  mailDigestLogListSchema,
  mailDigestMetaSchema,
  mailDigestPreviewSchema,
  mailDigestSendResultSchema,
  toMailDigestFieldErrors,
  type MailDigestFormField,
  type MailDigestFormModel,
} from '../mailDigestSchema';

/** 后端 `mail_digest/dto.rs::ConfigOut` 的 wire 形态（19 键，全显式声明）。 */
const CONFIG = {
  id: '1900000000000000001',
  version: 3,
  enabled: true,
  frequency: 'WEEKLY',
  send_hour: 8,
  send_minute: 30,
  weekday: 1,
  day_of_month: null,
  recipients: ['a@example.com'],
  cc_recipients: ['b@example.com'],
  include_overdue: true,
  include_upcoming: true,
  upcoming_days: 7,
  visible_columns: ['part_no', 'customer'],
  subject_template: null,
  // 2026-10-16 新增：发信邮箱 id（雪花 ID ⇒ JSON string；null = 未选）。
  sender_account_id: '9000000000000902',
  smtp_configured: true,
  created_at: '2026-10-01 08:00:00',
  updated_at: '2026-10-02 08:00:00',
};

/** 「表里无行」形态：全默认 + version 0 + id "0"。消费侧不许对它抛。 */
const CONFIG_EMPTY_ROW = {
  ...CONFIG,
  id: '0',
  version: 0,
  enabled: false,
  frequency: 'MANUAL_ONLY',
  send_hour: null,
  send_minute: null,
  weekday: null,
  recipients: [],
  cc_recipients: [],
  include_upcoming: false,
  visible_columns: [],
};

/** 后端 `mail_digest/dto.rs::SendResultOut` 的 wire 形态（12 键，全显式声明）。
 *
 *  ⚠️ **本文件唯一的行 fixture，send 与 logs 两条用例共用这一份** —— 两条端点在后端是同一个
 *  结构体（`LogListOut.items` 的元素类型就是 `SendResultOut`）。同一形状配两份手写 fixture
 *  时两份各自漂移，且**漂移对单测不可见**：fixture 若是照着漏声明的 schema 写的，那条用例
 *  就是自证式的（schema 少几个键、fixture 也少几个键，永远绿），真实响应却带着那几个键
 *  ⇒ `.strict()` 下当场抛 —— 挂在 `send` 的守门上就是「邮件已发出、前端报失败、用户重发」。
 *  键集清单见 `mailDigestKeySet.spec.ts`。 */
const SEND_RESULT_ROW = {
  log_id: '1900000000000000010',
  // `/send` 的响应里恒为 MANUAL（定时任务触发的那几行只在 logs 里出现）。
  trigger_source: 'MANUAL',
  config_version: 3,
  status: 'SUCCESS',
  subject: '交期汇总 2026-10-13',
  to_recipients: ['a@example.com'],
  cc_recipients: ['b@example.com'],
  overdue_count: 3,
  upcoming_count: 12,
  html_bytes: 20480,
  sent_at: '2026-10-13 08:30:00',
  error_message: null,
};

describe('mailDigestConfigSchema（GET /config 守门）', () => {
  it('合法配置 parse 通过；雪花 id 是字符串、version / 时分是 number', () => {
    const parsed = mailDigestConfigSchema.parse(CONFIG);
    expect(typeof parsed.id).toBe('string');
    expect(parsed.version).toBe(3);
    expect(parsed.send_hour).toBe(8);
    expect(parsed.weekday).toBe(1);
    expect(parsed.day_of_month).toBeNull();
  });

  it('「表里无行」形态（全默认 + version 0 + id "0"）也必须过（不是 404、不是 null）', () => {
    const parsed = mailDigestConfigSchema.parse(CONFIG_EMPTY_ROW);
    expect(parsed.id).toBe('0');
    expect(parsed.version).toBe(0);
    expect(parsed.frequency).toBe('MANUAL_ONLY');
  });

  it('缺任一必填键即抛（Zod strip 陷阱：漏声明 = 后端漏发一路流到视图层）', () => {
    const { upcoming_days: _drop, ...withoutDays } = CONFIG;
    expect(withoutDays).not.toHaveProperty('upcoming_days');
    expect(() => mailDigestConfigSchema.parse(withoutDays)).toThrow();
    const { visible_columns: _dropCols, ...withoutCols } = CONFIG;
    expect(() => mailDigestConfigSchema.parse(withoutCols)).toThrow();
    const { version: _dropVer, ...withoutVer } = CONFIG;
    expect(() => mailDigestConfigSchema.parse(withoutVer)).toThrow();
  });

  it('多一个未知键即抛（.strict()：后端加派生字段时必须在这里显式决策）', () => {
    expect(() =>
      mailDigestConfigSchema.parse({ ...CONFIG, last_sent_at: '2026-10-13 08:30:00' }),
    ).toThrow();
  });

  it('id 发 number 即抛（19 位 ID 在 JS Number 下丢精度）', () => {
    // 用 `Number(字符串)` 构造「后端哪天漏了 serialize_i64」的形态：雪花 ID 一旦被
    // Number 化就回不去了（这里 19 位 → 精度丢失，与字符串不再相等）。
    const lossyId = Number(CONFIG.id);
    expect(String(lossyId)).not.toBe(CONFIG.id);
    expect(() => mailDigestConfigSchema.parse({ ...CONFIG, id: lossyId })).toThrow();
  });

  it('freq 不是 4 个预设之一即抛', () => {
    expect(() => mailDigestConfigSchema.parse({ ...CONFIG, frequency: 'HOURLY' })).toThrow();
  });
});

describe('mailDigestMetaSchema / mailDigestConfigDefaultsSchema（GET /meta 守门）', () => {
  const META = {
    frequencies: [
      {
        value: 'DAILY',
        label: '每天',
        needs_time: true,
        needs_weekday: false,
        needs_day_of_month: false,
      },
      {
        value: 'WEEKLY',
        label: '每周',
        needs_time: true,
        needs_weekday: true,
        needs_day_of_month: false,
      },
      {
        value: 'MONTHLY',
        label: '每月',
        needs_time: true,
        needs_weekday: false,
        needs_day_of_month: true,
      },
      {
        value: 'MANUAL_ONLY',
        label: '仅手动',
        needs_time: false,
        needs_weekday: false,
        needs_day_of_month: false,
      },
    ],
    columns: [
      { key: 'part_no', label: '零件号' },
      { key: 'customer', label: '客户' },
    ],
    defaults: {
      enabled: false,
      frequency: 'MANUAL_ONLY',
      send_hour: null,
      send_minute: null,
      weekday: null,
      day_of_month: null,
      recipients: [],
      cc_recipients: [],
      include_overdue: true,
      include_upcoming: false,
      upcoming_days: 7,
      visible_columns: ['part_no'],
      subject_template: null,
      sender_account_id: null,
    },
    upcoming_days_range: { min: 1, max: 60 },
  };

  it('2026-10-16：smtp 段已从出参删除，defaults 里带上了发信邮箱 id', () => {
    const parsed = mailDigestMetaSchema.parse(META);
    // SMTP 改由邮箱账号实体承载（views/mail/accounts/），meta 里不再有部署级 SMTP 段。
    // 断言用的是「键不存在」而不是「值为 undefined」：后者在 `.strict()` 下也会通过，
    // 万一有人把它改成 `.passthrough()` 就漏掉了这条不变量。
    expect(Object.keys(parsed)).not.toContain('smtp');
    expect(parsed.defaults.sender_account_id).toBeNull();
    expect(parsed.upcoming_days_range).toEqual({ min: 1, max: 60 });
    expect(parsed.frequencies).toHaveLength(4);
  });

  it('2026-10-16：后端若仍下发 smtp 段，守门当场抛（不是静默 strip）', () => {
    const bad = { ...META, smtp: { configured: true } };
    expect(() => mailDigestMetaSchema.parse(bad)).toThrow();
  });

  it('频率选项缺一个 needs_* 即抛（页面按它显隐，漏一个就少显一项输入）', () => {
    const bad = {
      ...META,
      frequencies: [{ value: 'DAILY', label: '每天', needs_time: true, needs_weekday: false }],
    };
    expect(() => mailDigestMetaSchema.parse(bad)).toThrow();
  });

  it('defaults 段与 config 的配置字段逐字同构（少一个键即抛）', () => {
    const { upcoming_days: _drop, ...withoutDays } = META.defaults;
    expect(() => mailDigestConfigDefaultsSchema.parse(withoutDays)).toThrow();
    expect(mailDigestConfigDefaultsSchema.parse(META.defaults).upcoming_days).toBe(7);
  });
});

describe('preview / send / logs 的守门 schema', () => {
  it('preview：html / subject / 三个计数齐全', () => {
    const parsed = mailDigestPreviewSchema.parse({
      subject: '交期汇总 2026-10-13',
      html: '<table><tr><td>A</td></tr></table>',
      overdue_count: 3,
      upcoming_count: 12,
      columns: ['part_no'],
    });
    expect(parsed.html).toContain('<table>');
    expect(parsed.upcoming_count).toBe(12);
  });

  it('send：出参 = SendResultOut 的 12 键行视图（与 logs 行是同一个结构体）', () => {
    const ok = mailDigestSendResultSchema.parse({
      ...SEND_RESULT_ROW,
      status: 'FAILED',
      error_message: 'SMTP 握手失败',
    });
    expect(ok.status).toBe('FAILED');
    expect(ok.error_message).toBe('SMTP 握手失败');
    expect(ok.trigger_source).toBe('MANUAL');
    expect(ok.config_version).toBe(3);
    expect(
      mailDigestSendResultSchema.parse({ ...ok, status: 'SUCCESS', error_message: null }).status,
    ).toBe('SUCCESS');
    expect(() => mailDigestSendResultSchema.parse({ ...ok, status: 'PENDING' })).toThrow();
  });

  it('send：缺任一键即抛（漏声明 = 后端多发一个键当场抛，而邮件那时已经发出去了）', () => {
    for (const key of Object.keys(SEND_RESULT_ROW)) {
      const without: Record<string, unknown> = { ...SEND_RESULT_ROW };
      delete without[key];
      expect(() => mailDigestSendResultSchema.parse(without), `少了 ${key} 竟然过了`).toThrow();
    }
  });

  it('send：多一个未知键即抛（.strict()：后端加派生字段时必须在这里显式决策）', () => {
    expect(() =>
      mailDigestSendResultSchema.parse({ ...SEND_RESULT_ROW, smtp_error: 'timeout' }),
    ).toThrow();
  });

  it('logs：行形状就是 send 行形状（后端两端同一个结构体），分页三计数按 number', () => {
    const scheduledRow = { ...SEND_RESULT_ROW, trigger_source: 'SCHEDULED' };
    const parsed = mailDigestLogListSchema.parse({
      items: [scheduledRow],
      total: 1,
      limit: 20,
      offset: 0,
    });
    expect(parsed.items[0]?.trigger_source).toBe('SCHEDULED');
    expect(parsed.items[0]?.config_version).toBe(3);
    expect(parsed.total).toBe(1);
    // 行少一个键即抛：logs 行与 send 行是同一个结构体，缺一个就说明两处声明漂了
    const { cc_recipients: _drop, ...withoutCc } = scheduledRow;
    expect(() =>
      mailDigestLogListSchema.parse({ items: [withoutCc], total: 1, limit: 20, offset: 0 }),
    ).toThrow();
  });
});

// ============================================================
// 表单校验
// ============================================================

const schema = makeMailDigestFormSchema();

/** 一份「四频率通用」的基线表单（各频率只改 frequency 与配套字段）。 */
function baseForm(over: Partial<MailDigestFormModel> = {}): MailDigestFormModel {
  return {
    enabled: true,
    frequency: 'DAILY',
    send_hour: 8,
    send_minute: 30,
    weekday: null,
    day_of_month: null,
    recipients: ['a@example.com'],
    cc_recipients: [],
    include_overdue: true,
    include_upcoming: false,
    upcoming_days: 7,
    visible_columns: ['part_no'],
    subject_template: '',
    sender_account_id: null,
    ...over,
  };
}

describe('makeMailDigestFormSchema：频率 × 配套字段（对应后端 21704）', () => {
  it('DAILY：给了时刻即可过（weekday / day_of_month 必须为空）', () => {
    expect(schema.safeParse(baseForm()).success).toBe(true);
    // 留着上一次切频率前的星期 → 非法（否则后端注册出一个自相矛盾的调度）
    expect(schema.safeParse(baseForm({ weekday: 1 })).success).toBe(false);
    expect(schema.safeParse(baseForm({ day_of_month: 5 })).success).toBe(false);
  });

  it('WEEKLY：必须同时给时刻与星期', () => {
    expect(schema.safeParse(baseForm({ frequency: 'WEEKLY', weekday: 1 })).success).toBe(true);
    expect(schema.safeParse(baseForm({ frequency: 'WEEKLY', weekday: null })).success).toBe(false);
    // 星期越界（ISO 只有 1..7）
    expect(schema.safeParse(baseForm({ frequency: 'WEEKLY', weekday: 0 })).success).toBe(false);
    expect(schema.safeParse(baseForm({ frequency: 'WEEKLY', weekday: 8 })).success).toBe(false);
  });

  it('MONTHLY：必须同时给时刻与月号，且月号 1..28（避开短月）', () => {
    expect(schema.safeParse(baseForm({ frequency: 'MONTHLY', day_of_month: 28 })).success).toBe(
      true,
    );
    expect(schema.safeParse(baseForm({ frequency: 'MONTHLY', day_of_month: null })).success).toBe(
      false,
    );
    expect(schema.safeParse(baseForm({ frequency: 'MONTHLY', day_of_month: 29 })).success).toBe(
      false,
    );
    expect(schema.safeParse(baseForm({ frequency: 'MONTHLY', day_of_month: 0 })).success).toBe(
      false,
    );
  });

  it('MANUAL_ONLY：三个配套字段全必须为空（留了时刻就非法）', () => {
    expect(
      schema.safeParse(baseForm({ frequency: 'MANUAL_ONLY', send_hour: null, send_minute: null }))
        .success,
    ).toBe(true);
    expect(
      schema.safeParse(
        baseForm({ frequency: 'MANUAL_ONLY', send_hour: null, send_minute: null, weekday: 3 }),
      ).success,
    ).toBe(false);
    expect(
      schema.safeParse(
        baseForm({
          frequency: 'MANUAL_ONLY',
          send_hour: null,
          send_minute: null,
          day_of_month: 5,
        }),
      ).success,
    ).toBe(false);
  });

  it('非 MANUAL_ONLY 的频率缺时刻 → 报在 send_time 上（不是笼统的 frequency）', () => {
    const parsed = schema.safeParse(baseForm({ send_hour: null }));
    expect(parsed.success).toBe(false);
    const errs = toMailDigestFieldErrors(
      parsed.error?.issues as unknown as Array<{ path: PropertyKey[]; message: string }>,
    );
    expect(errs.send_time).toBe('请选择触发时刻（时:分）');
    // ⚠️ 聚焦必须落到具体输入项：报错挂 frequency 上会让用户盯着单选组发呆。
    expect(Object.keys(errs)).toEqual(['send_time']);
  });

  it('自定义 needs_* 判据生效（meta 下发的判据优先于内置兜底表）', () => {
    // 构造一个「每天不需要时刻」的 meta：内置表说 DAILY 要时刻，这里要它不要求。
    const custom = makeMailDigestFormSchema({
      ...DEFAULT_MAIL_DIGEST_FREQUENCY_FLAGS,
      DAILY: { needs_time: false, needs_weekday: false, needs_day_of_month: false },
    });
    expect(custom.safeParse(baseForm({ send_hour: null, send_minute: null })).success).toBe(true);
    // 兜底表那份仍要求时刻（证明确实是「按传入判据走」而不是恒真）
    expect(schema.safeParse(baseForm({ send_hour: null, send_minute: null })).success).toBe(false);
  });
});

describe('makeMailDigestFormSchema：收件人（对应后端 21703）', () => {
  it('TO 至少 1 项（空数组 / 全是空串都拒）', () => {
    expect(schema.safeParse(baseForm({ recipients: [] })).success).toBe(false);
    expect(schema.safeParse(baseForm({ recipients: ['  '] })).success).toBe(false);
  });

  it('CC 可空，但填了就要合法', () => {
    expect(schema.safeParse(baseForm({ cc_recipients: [] })).success).toBe(true);
    expect(schema.safeParse(baseForm({ cc_recipients: ['not-an-email'] })).success).toBe(false);
  });

  it('邮箱先 trim 再校验（前后空格不致命，解析出的值已 trim）', () => {
    const parsed = schema.parse(baseForm({ recipients: ['  a@example.com  '] }));
    expect(parsed.recipients).toEqual(['a@example.com']);
  });

  it('拦含换行的地址（邮件头注入的原料，后端也拒，前端先拦一道）', () => {
    const parsed = schema.safeParse(baseForm({ recipients: ['a@example.com\r\nBcc: x@y.com'] }));
    expect(parsed.success).toBe(false);
    const errs = toMailDigestFieldErrors(
      parsed.error?.issues as unknown as Array<{ path: PropertyKey[]; message: string }>,
    );
    expect(errs.recipients).toBe('邮箱不能包含换行');
  });
});

describe('makeMailDigestFormSchema：数值与列白名单', () => {
  it('upcoming_days：1..60；被清空（undefined / null）报「请填」而不是回落成 0', () => {
    expect(schema.safeParse(baseForm({ upcoming_days: 1 })).success).toBe(true);
    expect(schema.safeParse(baseForm({ upcoming_days: 60 })).success).toBe(true);
    expect(schema.safeParse(baseForm({ upcoming_days: 61 })).success).toBe(false);
    expect(schema.safeParse(baseForm({ upcoming_days: 0 })).success).toBe(false);
    expect(schema.safeParse(baseForm({ upcoming_days: undefined })).success).toBe(false);
    // `z.coerce.number()` 会把 null 静默转成 0（Number(null) === 0）⇒ 必须报「请填」
    expect(schema.safeParse(baseForm({ upcoming_days: null as unknown as number })).success).toBe(
      false,
    );
  });

  // ⚠️ 2026-10-14（review 第 1 轮 N-1）：「未来 N 天」的范围**由 meta 下发**
  // （`makeMailDigestFormSchema` 的第二个形参），不再在 schema 里写死 1..60 —— 后端把上限
  // 放宽到 90 时，「UI 允许输 90（`:min/:max` 读 meta）、schema 却拒」会把用户挡在自己
  // 系统的校验上且看不到原因。报错文案里的范围也跟着 meta 走。
  it('upcoming_days 的范围取自 meta（形参），而不是写死的 1..60', () => {
    const wide = makeMailDigestFormSchema(DEFAULT_MAIL_DIGEST_FREQUENCY_FLAGS, {
      min: 1,
      max: 90,
    });
    expect(wide.safeParse(baseForm({ upcoming_days: 90 })).success).toBe(true);
    expect(wide.safeParse(baseForm({ upcoming_days: 91 })).success).toBe(false);
    // 兜底那份仍是 1..60（证明确实是「按传入范围走」而不是恒真）
    expect(schema.safeParse(baseForm({ upcoming_days: 90 })).success).toBe(false);

    // 收窄方向同样跟随：后端说 3..30 时，1 被拒。
    const narrow = makeMailDigestFormSchema(DEFAULT_MAIL_DIGEST_FREQUENCY_FLAGS, {
      min: 3,
      max: 30,
    });
    expect(narrow.safeParse(baseForm({ upcoming_days: 1 })).success).toBe(false);
    expect(narrow.safeParse(baseForm({ upcoming_days: 7 })).success).toBe(true);
    const errs = toMailDigestFieldErrors(
      narrow.safeParse(baseForm({ upcoming_days: 1 })).error?.issues as unknown as Array<{
        path: PropertyKey[];
        message: string;
      }>,
    );
    expect(errs.upcoming_days).toBe('未来天数需在 3..30 之间');
  });

  it('visible_columns 非空', () => {
    expect(schema.safeParse(baseForm({ visible_columns: [] })).success).toBe(false);
  });

  it('subject_template 可留空（空 = 用后端默认标题），超 200 字拒', () => {
    expect(schema.parse(baseForm()).subject_template).toBe('');
    expect(schema.safeParse(baseForm({ subject_template: 'x'.repeat(201) })).success).toBe(false);
  });

  it('关掉「含未来 N 天」后不新增任何要求（旧的天数值仍能过，schema 不因开关关着就加判据）', () => {
    expect(schema.safeParse(baseForm({ include_upcoming: false, upcoming_days: 30 })).success).toBe(
      true,
    );
    // 对照：天数本身仍是必填数字字段（后端同款要求），所以 undefined 照样被拒 ——
    // 这条约束来自 upcoming_days 字段本身，与开关无关。
    expect(
      schema.safeParse(baseForm({ include_upcoming: false, upcoming_days: undefined })).success,
    ).toBe(false);
  });
});

describe('toMailDigestFieldErrors', () => {
  it('按字段聚合 issue，同字段只取第一条', () => {
    const parsed = schema.safeParse(baseForm({ recipients: [], visible_columns: [] }));
    expect(parsed.success).toBe(false);
    const errs = toMailDigestFieldErrors(
      parsed.error?.issues as unknown as Array<{ path: PropertyKey[]; message: string }>,
    );
    expect(errs.recipients).toBeDefined();
    expect(errs.visible_columns).toBe('至少选择一列');
    // 每个 issue 的 path[0] 都必须落在已声明的字段名上（页面只认这几个键做标红）
    for (const key of Object.keys(errs)) {
      expect([
        'frequency',
        'send_time',
        'weekday',
        'day_of_month',
        'recipients',
        'cc_recipients',
        'upcoming_days',
        'visible_columns',
        'subject_template',
      ] as MailDigestFormField[]).toContain(key as MailDigestFormField);
    }
  });
});
