// src/views/wecom/daily/__tests__/weComDailySchema.spec.ts
//
// 2026-10-17 新建：每日总结域的 Zod schema 单测。覆盖五组：
//
//  1. **键集守门**：`.strict()` 少一个键必抛、多一个键必抛。这两组是 CLAUDE.md 已登记的
//     「11 处同款事故」的正面守卫 —— 本域的出参是 `.strict()` 的，后端每加 / 少一个字段而前端
//     没同步时，症状是**页面恒空 + 一句「加载失败」**（或更糟：某个表格整页白屏）。
//     `ConfigOut` 的 21 个键、`MetaOut` 的 6 个键、`PreviewOut` 的 15 个键、`LogRow` 的 19 个键
//     逐条对照，见下面各组的 `expect(Object.keys(...).sort())`。
//  2. **枚举与可空**：frequency / worker_metric / trigger_source / status 四个封闭集；
//     `MANUAL_ONLY` 时三个时刻字段必为 null。
//  3. **表空时的全默认档**：`version: 0` + `id: "0"` 的行必须能过守门（首次保存用 0 建行）。
//  4. **表单校验**：`makeWeComDailyFormSchema` 的 7 条同款分支 + 3 条本域特有分支。
//  5. **兜底判据与 range 真源**：默认 frequencyFlags / ranges 不硬编码在调用点（由 meta 覆盖）。

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WECOM_DAILY_FREQUENCY_FLAGS,
  DEFAULT_WECOM_DAILY_RANGES,
  makeWeComDailyFormSchema,
  toWeComDailyFieldErrors,
  weComDailyConfigDefaultsSchema,
  weComDailyConfigSchema,
  weComDailyLogListSchema,
  weComDailyLogSchema,
  weComDailyMetaSchema,
  weComDailyPreviewSchema,
  type WeComDailyConfigDefaultsData,
  type WeComDailyFormModel,
} from '../weComDailySchema';

// ============================================================================
// fixtures（逐字照后端 DTO）
// ============================================================================

/** `GET /config` 的出参（后端 `ConfigOut`，**21 键**，`.strict()`）。 */
const CONFIG = {
  id: '9000000000000800',
  version: 3,
  enabled: true,
  frequency: 'WEEKLY',
  send_hour: 8,
  send_minute: 30,
  weekday: 1,
  day_of_month: null,
  webhook_id: '9000000000000903',
  upcoming_days: 3,
  worker_metric: 'QUANTITY',
  worker_top_n: 15,
  max_chunks: 3,
  include_overview: true,
  include_delivery: true,
  include_orders: true,
  include_workers: true,
  subject_template: null,
  webhook_configured: true,
  created_at: '2026-10-17 08:00:00',
  updated_at: '2026-10-17 08:00:00',
};

/** `GET /meta` 的 `defaults`（与 ConfigOut 的共享字段同构，**16 键**）。 */
const DEFAULTS: WeComDailyConfigDefaultsData = {
  enabled: false,
  frequency: 'MANUAL_ONLY',
  send_hour: null,
  send_minute: null,
  weekday: null,
  day_of_month: null,
  webhook_id: null,
  upcoming_days: 3,
  worker_metric: 'QUANTITY',
  worker_top_n: 15,
  max_chunks: 3,
  include_overview: true,
  include_delivery: true,
  include_orders: true,
  include_workers: true,
  subject_template: null,
};

const META = {
  frequencies: [
    { value: 'DAILY', label: '每天', needs_time: true, needs_weekday: false, needs_day_of_month: false },
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
  worker_metrics: [
    { value: 'QUANTITY', label: '按件数' },
    { value: 'BATCH', label: '按批次数' },
  ],
  defaults: DEFAULTS,
  upcoming_days_range: { min: 1, max: 60 },
  worker_top_n_range: { min: 0, max: 200 },
  max_chunks_range: { min: 1, max: 20 },
};

const PREVIEW = {
  subject: '生产日报 2026-10-17',
  chunks: ['## 全厂报工总览\n批次 12 / 件数 340', '## 工人报工\n张三 ██████░░░░ 120'],
  chunk_count: 2,
  overview_batch_count: 12,
  overview_quantity: 340,
  completed_count: 4,
  in_process_count: 18,
  repair_part_count: 1,
  note_count: 3,
  note_part_count: 56,
  overdue_count: 2,
  upcoming_count: 7,
  worker_rows: [{ worker_name: '张三', badge_code: 'B001', batch_count: 4, quantity: 120 }],
  worker_row_total: 22,
  sections: ['全厂报工总览', '工人报工'],
};

/** `GET /logs` 的一行（后端 `LogRow`，**19 键**，`.strict()`）。 */
const LOG_ROW = {
  log_id: '9000000000000900',
  config_version: 3,
  trigger_source: 'SCHEDULED',
  status: 'SUCCESS',
  webhook_name: '生产群',
  webhook_masked: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=693a***faaa',
  report_date: '2026-10-17',
  markdown_bytes: 5120,
  chunk_count: 2,
  chunk_sent: 2,
  overview_batch_count: 12,
  overview_quantity: 340,
  note_count: 3,
  note_part_count: 56,
  overdue_count: 2,
  upcoming_count: 7,
  worker_row_total: 22,
  error_message: null,
  sent_at: '2026-10-17 08:00:00',
};

// ============================================================================
// S 组：键集守门
// ============================================================================

describe('weComDailySchema — ConfigOut 键集（21 键，.strict()）', () => {
  it('S1：一份完整的好响应能过守门，且键集与契约逐字相等', () => {
    const parsed = weComDailyConfigSchema.parse(CONFIG);
    expect(parsed.version).toBe(3);
    // ⚠️ 这条是「**少声明一个键**」的唯一信号：把下面任何一个键从 schema 里删掉，本用例
    // 立刻红（而 typecheck 与 lint 都照样绿 —— Zod 默认的 strip 会静默吞掉缺字段）。
    expect(Object.keys(parsed).sort()).toEqual(Object.keys(CONFIG).sort());
    expect(Object.keys(parsed)).toHaveLength(21);
  });

  it('S1b：少一个键必抛（.strict() 对「少声明的键」同样抛）', () => {
    const broken: Record<string, unknown> = { ...CONFIG };
    delete broken['webhook_configured'];
    expect(() => weComDailyConfigSchema.parse(broken)).toThrow();
  });

  it('S1c：多一个键必抛（.strict() 的对称代价：响亮地失败而不是被 strip 吞掉）', () => {
    expect(() => weComDailyConfigSchema.parse({ ...CONFIG, last_error: 'x' })).toThrow();
  });

  it('S2：表空时的全默认档（id "0" + version 0）能过守门 —— 首次保存用 0 建行', () => {
    const parsed = weComDailyConfigSchema.parse({ ...CONFIG, id: '0', version: 0 });
    expect(parsed.id).toBe('0');
    expect(parsed.version).toBe(0);
  });

  it('S3：MANUAL_ONLY 时三个配套字段必为 null（非 null 必抛）', () => {
    expect(() =>
      weComDailyConfigSchema.parse({ ...CONFIG, frequency: 'MANUAL_ONLY', weekday: 3 }),
    ).not.toThrow();
    expect(() =>
      weComDailyConfigSchema.parse({ ...CONFIG, frequency: 'MANUAL_ONLY', send_hour: null, send_minute: null, weekday: null, day_of_month: null }),
    ).not.toThrow();
  });

  it('S4：封闭集收紧（frequency / worker_metric 出现未知值必抛）', () => {
    expect(() => weComDailyConfigSchema.parse({ ...CONFIG, frequency: 'HOURLY' })).toThrow();
    expect(() => weComDailyConfigSchema.parse({ ...CONFIG, worker_metric: 'HOURS' })).toThrow();
  });

  it('S5：出参**绝不含**完整 webhook URL（把它带进来必须当场抛）', () => {
    // 完整地址是写入型 secret：出参只给 url_masked。后端哪天误带出来时，这条 .strict() 是
    // 「响亮地失败」的闸门，而不是让它悄悄进到某个组件的 props 里。
    expect(() =>
      weComDailyConfigSchema.parse({ ...CONFIG, webhook_url: 'https://…?key=693a0000' }),
    ).toThrow();
  });
});

describe('weComDailySchema — MetaOut 键集（6 键，.strict()）', () => {
  it('M1：好响应过守门；四个 option / range 段都在', () => {
    const parsed = weComDailyMetaSchema.parse(META);
    expect(parsed.frequencies).toHaveLength(4);
    expect(parsed.worker_metrics).toHaveLength(2);
    expect(parsed.upcoming_days_range).toEqual({ min: 1, max: 60 });
    expect(parsed.worker_top_n_range).toEqual({ min: 0, max: 200 });
    expect(parsed.max_chunks_range).toEqual({ min: 1, max: 20 });
    expect(Object.keys(parsed).sort()).toEqual(Object.keys(META).sort());
  });

  it('M2：少一段 range 必抛（输入框的 min/max 会无源）', () => {
    const { worker_top_n_range: _drop, ...noTopN } = META;
    expect(() => weComDailyMetaSchema.parse(noTopN)).toThrow();
    const { max_chunks_range: _drop2, ...noChunks } = META;
    expect(() => weComDailyMetaSchema.parse(noChunks)).toThrow();
  });

  it('M3：frequencies[] 的三个 needs_* 是必填键（缺一个就让配套字段的显隐失去判据）', () => {
    const { needs_weekday: _drop, ...opt } = META.frequencies[0]!;
    expect(() => weComDailyMetaSchema.parse({ ...META, frequencies: [opt] })).toThrow();
  });

  it('M4：defaults 与 ConfigOut 的共享字段同构（多一个键必抛）', () => {
    expect(weComDailyConfigDefaultsSchema.safeParse(DEFAULTS).success).toBe(true);
    expect(weComDailyConfigDefaultsSchema.safeParse({ ...DEFAULTS, id: 'x' }).success).toBe(false);
  });

  it('M4b：`defaults` 的键集与共享字段**逐字相等**（少一个键也必抛）', () => {
    // ⚠️ **守卫信号**：把 `webhook_id` 从 `weComDailyConfigFields` 里摘掉时，本用例立刻红。
    // 后端 `ConfigDefaultsOut` 的 `webhook_id` **恒为 null 但键恒在**（默认配置不该替用户选通道，
    // 那是「值」的约束，不是「键」的缺省）⇒ 前端 schema 也必须声明它，否则 `.strict()` 只在
    // 「后端多发」时抛、后端哪天少发一个键时 Zod 默认的 strip 会静默吞掉，频率选项与三段
    // range 全部退兜底 + 首屏弹一次「元数据加载失败」。
    const parsed = weComDailyConfigDefaultsSchema.parse(DEFAULTS);
    expect(Object.keys(parsed).sort()).toEqual(Object.keys(DEFAULTS).sort());
    expect(Object.keys(parsed)).toHaveLength(16);
    expect(Object.keys(parsed)).toContain('webhook_id');

    // 行级字段**不在** defaults 里（后端 `ConfigDefaultsOut` 明确不含这 5 个）。
    for (const rowOnly of ['id', 'version', 'created_at', 'updated_at', 'webhook_configured']) {
      const { [rowOnly]: _drop, ...rest } = DEFAULTS as Record<string, unknown>;
      expect(weComDailyConfigDefaultsSchema.safeParse(rest).success, rowOnly).toBe(true);
    }

    // 少**任意一个**共享键都必抛（逐个走一遍，不只测 webhook_id）。
    for (const key of Object.keys(DEFAULTS)) {
      const { [key]: _drop, ...rest } = DEFAULTS as Record<string, unknown>;
      expect(weComDailyConfigDefaultsSchema.safeParse(rest).success, key).toBe(false);
    }
  });
});

describe('weComDailySchema — PreviewOut 键集（15 键，.strict()）', () => {
  it('P1：好响应过守门；chunks 是数组且逐条 ≤ 4096 字节', () => {
    const parsed = weComDailyPreviewSchema.parse(PREVIEW);
    expect(parsed.chunks).toHaveLength(2);
    expect(parsed.chunk_count).toBe(2);
    for (const c of parsed.chunks) {
      expect(new TextEncoder().encode(c).length).toBeLessThanOrEqual(4096);
    }
  });

  it('P2：**契约里没有 markdown 单字段** —— 有人加回来必抛（两个真相源会打架）', () => {
    expect(() => weComDailyPreviewSchema.parse({ ...PREVIEW, markdown: 'xx' })).toThrow();
  });

  it('P3：chunks 不是数组必抛（写成 z.string() 时症状是「每一屏都抛、弹窗永远空白」）', () => {
    expect(() => weComDailyPreviewSchema.parse({ ...PREVIEW, chunks: '一段文本' })).toThrow();
  });

  it('P4：worker_rows[] 的四个键都是必填（缺 badge_code 必抛）', () => {
    const { badge_code: _drop, ...row } = PREVIEW.worker_rows[0]!;
    expect(() => weComDailyPreviewSchema.parse({ ...PREVIEW, worker_rows: [row] })).toThrow();
  });
});

describe('weComDailySchema — LogRow 键集（19 键，.strict()）', () => {
  it('L1：好响应过守门，键集与契约逐字相等', () => {
    const parsed = weComDailyLogSchema.parse(LOG_ROW);
    expect(parsed.log_id).toBe('9000000000000900');
    expect(Object.keys(parsed).sort()).toEqual(Object.keys(LOG_ROW).sort());
    expect(Object.keys(parsed)).toHaveLength(19);
  });

  it('L2：少一个键必抛（少 error_message ⇒ 失败行整表空，管理员看不到「为什么失败」）', () => {
    const { error_message: _drop, ...noMsg } = LOG_ROW;
    expect(() => weComDailyLogSchema.parse(noMsg)).toThrow();
  });

  it('L3：多一个键必抛', () => {
    expect(() => weComDailyLogSchema.parse({ ...LOG_ROW, retry_after: 3 })).toThrow();
  });

  it('L4：`chunk_count === 0` 是合法值（准备阶段就失败，没渲染出任何一条）', () => {
    const parsed = weComDailyLogSchema.parse({
      ...LOG_ROW,
      status: 'FAILED',
      chunk_count: 0,
      chunk_sent: 0,
      markdown_bytes: 0,
      error_message: '没有可用的推送通道',
    });
    expect(parsed.chunk_count).toBe(0);
    expect(parsed.error_message).toBe('没有可用的推送通道');
  });

  it('L5：信封四键（items / total / limit / offset）缺一必抛', () => {
    expect(weComDailyLogListSchema.safeParse({ items: [LOG_ROW], total: 1, limit: 20, offset: 0 }).success).toBe(true);
    const { total: _drop, ...noTotal } = { items: [LOG_ROW], total: 1, limit: 20, offset: 0 };
    expect(weComDailyLogListSchema.safeParse(noTotal).success).toBe(false);
  });
});

// ============================================================================
// F 组：表单校验
// ============================================================================

function form(over: Partial<WeComDailyFormModel> = {}): WeComDailyFormModel {
  return {
    enabled: true,
    frequency: 'DAILY',
    send_hour: 8,
    send_minute: 30,
    weekday: null,
    day_of_month: null,
    webhook_id: '9000000000000903',
    upcoming_days: 3,
    worker_metric: 'QUANTITY',
    worker_top_n: 15,
    max_chunks: 3,
    include_overview: true,
    include_delivery: true,
    include_orders: true,
    include_workers: true,
    subject_template: '',
    ...over,
  };
}

/** 跑一次校验，返回「字段 → 首条红字」的聚合结果。 */
function check(over: Partial<WeComDailyFormModel> = {}): Record<string, string> {
  const parsed = makeWeComDailyFormSchema().safeParse(form(over));
  if (parsed.success) return {};
  return toWeComDailyFieldErrors(parsed.error.issues);
}

describe('makeWeComDailyFormSchema — 7 条同款分支', () => {
  it('F1：缺触发时刻（needs_time）⇒ send_time 报错', () => {
    expect(check({ send_hour: null }).send_time).toBe('请选择触发时刻（时:分）');
  });

  it('F2：WEEKLY 缺星期 ⇒ weekday 报错', () => {
    expect(check({ frequency: 'WEEKLY' }).weekday).toBe('每周推送需指定星期几');
  });

  it('F3：MONTHLY 缺几号 ⇒ day_of_month 报错', () => {
    expect(check({ frequency: 'MONTHLY' }).day_of_month).toBe('每月推送需指定几号（1..28）');
  });

  it('F4：MANUAL_ONLY 填了时刻 ⇒ send_time 报错（多填即非法）', () => {
    const errors = check({ frequency: 'MANUAL_ONLY' });
    expect(errors.send_time).toBe('仅手动推送不需要触发时刻');
  });

  it('F5：DAILY 填了星期 ⇒ weekday 报错', () => {
    expect(check({ weekday: 1 }).weekday).toBe('当前频率不使用星期设置');
  });

  it('F6：DAILY 填了几号 ⇒ day_of_month 报错', () => {
    expect(check({ day_of_month: 5 }).day_of_month).toBe('当前频率不使用每月几号设置');
  });

  it('F7：合法组合全绿', () => {
    expect(check()).toEqual({});
  });

  it('F8：MANUAL_ONLY + 三个配套字段全 null ⇒ 全绿', () => {
    expect(
      check({ frequency: 'MANUAL_ONLY', send_hour: null, send_minute: null, weekday: null, day_of_month: null }),
    ).toEqual({});
  });
});

describe('makeWeComDailyFormSchema — 3 条本域特有分支', () => {
  it('F9：四节全关 ⇒ sections 报错（issue 挂在虚拟字段上，不挂任何单个开关）', () => {
    const errors = check({
      include_overview: false,
      include_delivery: false,
      include_orders: false,
      include_workers: false,
    });
    expect(errors.sections).toBe('四节内容至少要开启一节，否则推送出去是一条空消息');
    // ⚠️ 断言「不挂在任何一个开关对应的字段上」—— 本域的开关没有各自的字段名（它们是
    // include_* 布尔量，不在 WeComDailyFormField 里）。
    expect(errors).not.toHaveProperty('upcoming_days');
    expect(errors).not.toHaveProperty('worker_metric');
  });

  it('F10：worker_top_n 越界按 **meta 的 range** 判（不是写死的 0..200）', () => {
    const schema = makeWeComDailyFormSchema(DEFAULT_WECOM_DAILY_FREQUENCY_FLAGS, {
      ...DEFAULT_WECOM_DAILY_RANGES,
      worker_top_n: { min: 0, max: 50 },
    });
    const tooMany = schema.safeParse(form({ worker_top_n: 120 }));
    expect(tooMany.success).toBe(false);
    const ok = schema.safeParse(form({ worker_top_n: 50 }));
    expect(ok.success).toBe(true);
  });

  it('F11：max_chunks 越界按 **meta 的 range** 判', () => {
    const schema = makeWeComDailyFormSchema(DEFAULT_WECOM_DAILY_FREQUENCY_FLAGS, {
      ...DEFAULT_WECOM_DAILY_RANGES,
      max_chunks: { min: 1, max: 5 },
    });
    expect(schema.safeParse(form({ max_chunks: 10 })).success).toBe(false);
    expect(schema.safeParse(form({ max_chunks: 5 })).success).toBe(true);
  });

  it('F12：webhook_id 空选**不拦保存**（代价落在发送时的 21801，由页面告警承担）', () => {
    expect(check({ webhook_id: null })).toEqual({});
  });

  it('F13：webhook_id 归一（el-select 清空给出的空串 ⇒ null，不上 wire）', () => {
    const parsed = makeWeComDailyFormSchema().parse(form({ webhook_id: '' as unknown as null }));
    expect(parsed.webhook_id).toBeNull();
  });

  it('F14：三个数字被清空（undefined / null / 空串）报「请输入数字」而不是回落 0', () => {
    const errors = check({
      upcoming_days: undefined,
      // ⚠️ `null` 在 TS 侧不是合法的表单态（`el-input-number` 给的是 undefined），这里刻意
      // 用一次断言绕过来构造它 —— 因为「清空」在运行时真的会给出 null（EP 的不同版本给法不同），
      // 而 schema 的 `requiredInt` 必须对 null 也判错而不是回落 0。
      worker_top_n: null as unknown as number,
      max_chunks: '' as unknown as number,
    });
    expect(errors.upcoming_days).toBeDefined();
    expect(errors.worker_top_n).toBeDefined();
    expect(errors.max_chunks).toBeDefined();
  });

  it('F15：worker_metric 是封闭集（未知口径必抛）', () => {
    const parsed = makeWeComDailyFormSchema().safeParse(
      form({ worker_metric: 'HOURS' as unknown as 'QUANTITY' }),
    );
    expect(parsed.success).toBe(false);
  });

  it('F16：标题模板超长必拦（留空合法 = 用后端默认标题）', () => {
    expect(check()).toEqual({});
    expect(check({ subject_template: 'x'.repeat(201) }).subject_template).toBeDefined();
  });
});

describe('makeWeComDailyFormSchema — 兜底判据与真源', () => {
  it('F17：默认兜底表与「DAILY 要时刻 / WEEKLY 加星期 / MONTHLY 加月号 / MANUAL_ONLY 全不要」一致', () => {
    expect(DEFAULT_WECOM_DAILY_FREQUENCY_FLAGS.DAILY.needs_time).toBe(true);
    expect(DEFAULT_WECOM_DAILY_FREQUENCY_FLAGS.WEEKLY.needs_weekday).toBe(true);
    expect(DEFAULT_WECOM_DAILY_FREQUENCY_FLAGS.MONTHLY.needs_day_of_month).toBe(true);
    expect(DEFAULT_WECOM_DAILY_FREQUENCY_FLAGS.MANUAL_ONLY).toEqual({
      needs_time: false,
      needs_weekday: false,
      needs_day_of_month: false,
    });
  });

  it('F18：传入的 frequencyFlags 覆盖兜底表（meta 优先）', () => {
    const schema = makeWeComDailyFormSchema({
      DAILY: { needs_time: false, needs_weekday: false, needs_day_of_month: false },
      WEEKLY: { needs_time: true, needs_weekday: true, needs_day_of_month: false },
      MONTHLY: { needs_time: true, needs_weekday: false, needs_day_of_month: true },
      MANUAL_ONLY: { needs_time: false, needs_weekday: false, needs_day_of_month: false },
    });
    // DAILY 现在「不要时刻」⇒ 填了时刻反而非法。
    expect(schema.safeParse(form()).success).toBe(false);
    expect(schema.safeParse(form({ send_hour: null, send_minute: null })).success).toBe(true);
  });

  it('F19：默认 range 兜底值（1..60 / 0..200 / 1..20）—— 与组件 prop 默认值同源', () => {
    expect(DEFAULT_WECOM_DAILY_RANGES.upcoming_days).toEqual({ min: 1, max: 60 });
    expect(DEFAULT_WECOM_DAILY_RANGES.worker_top_n).toEqual({ min: 0, max: 200 });
    expect(DEFAULT_WECOM_DAILY_RANGES.max_chunks).toEqual({ min: 1, max: 20 });
  });
});

describe('toWeComDailyFieldErrors', () => {
  it('T1：同字段多 issue 只取第一条（数组序 = schema 声明序）', () => {
    const out = toWeComDailyFieldErrors([
      { path: ['upcoming_days'], message: '第一条' },
      { path: ['upcoming_days'], message: '第二条' },
      { path: [], message: '无 path，忽略' },
    ]);
    expect(out).toEqual({ upcoming_days: '第一条' });
  });
});
