// src/views/wecom/daily/weComDailySchema.ts
//
// 2026-10-17 新建：企业微信**每日总结**域的 Zod schema，与三个 query hook 同居
// （CLAUDE.md「域 schema 与 query hook 同居」），两组用途（形态照
// `views/mail/digest/mailDigestSchema.ts`）：
//
//   1. **守门**：`weComDailyConfigSchema` / `weComDailyConfigDefaultsSchema` /
//      `weComDailyFrequencyOptionSchema` / `weComDailyWorkerMetricOptionSchema` /
//      `weComDailyMetaSchema` / `weComDailyPreviewSchema` / `weComDailyLogSchema` /
//      `weComDailyLogListSchema`。
//      三条读端点（config / meta / logs）的守门点在 queryFn
//      （`composables/useWeComDailyQuery.ts`）；三条「跑一次」的端点（save-config / preview /
//      send）走 useMutation、**没有 queryFn 承载**，**守门留在 api 层**（CLAUDE.md 为「没有
//      queryFn 承载的调用」留的口子，同 `api/mailDigest.ts` 的保存 / preview / send）。
//   2. **表单校验**：`makeWeComDailyFormSchema(frequencyFlags, ranges)` —— 保存 / 预览 /
//      立即发送三个动作共用的前置校验，把后端 21804（配置组合非法）等拒绝提前到浏览器，并给出
//      **聚焦到具体字段**的提示。
//
// 两条 wire 序列化约定（照抄 mailDigest / statistics 三组的结论）：
//   - **雪花 / 业务 ID 一律 JSON string**：`id` / `log_id` / `webhook_id` 是 `z.string()`，
//     禁 `z.number()`（19 位 ID 在 JS Number 下丢精度）。
//   - **计数 / 版本号 / 时分天 / 字节数一律 JSON number**：`version` / `upcoming_days` /
//     `worker_top_n` / `max_chunks` / `send_hour` / `markdown_bytes` / `total` 等。
//
// ⚠️ **`.strict()` 的取舍**：信封 / 行层一律 `.strict()`，与 mailDigest 域同款 —— 后端给本域
//   加派生字段时会被这里挡住、需要显式决策，而不是被 Zod 默认的 strip 静默吞掉（吞掉后前端
//   「照样通过校验」，那一列整列失效且无人发现）。代价是后端加字段必须同步前端。
//
// ⚠️ **两条与本域相关的部署顺序**（CLAUDE.md 登记的同款故障）：
//   ① 后端必须先上 `/cron/wecom-daily/*` —— 旧路径 404、无 alias，且失败发生在**网络层**
//      （不是 Zod 契约层），现场只看到一句 axios 错误；
//   ② 即使后端已上，**配置表 / 日志表的字段也是必填键**：漏声明一个键，本文件 `.strict()`
//      当场抛 ⇒ 本页恒空 + 一句「加载失败」。

import { z } from 'zod';
import {
  WECOM_DAILY_FREQUENCIES,
  type WeComDailyFrequency,
  type WeComDailyWorkerMetric,
} from '@/types/wecom';

// ============================================================
// 公共原子
// ============================================================

export const weComDailyFrequencySchema = z.enum(WECOM_DAILY_FREQUENCIES);

export const weComDailyWorkerMetricSchema = z.enum(['QUANTITY', 'BATCH']);

export const weComDailyTriggerSourceSchema = z.enum(['SCHEDULED', 'MANUAL']);

export const weComDailySendStatusSchema = z.enum(['SUCCESS', 'FAILED']);

/** 频率选项（`GET /meta` 的 `frequencies[]` 一项）。
 *
 *  ⚠️ **三个 `needs_*` 是后端下发的、不是前端硬编码的判据**：配套字段该显不显由它们决定，
 *  页面与表单校验都读它（表单校验的默认档见 `DEFAULT_WECOM_DAILY_FREQUENCY_FLAGS`，它只是
 *  「meta 还没回来」时的兜底，meta 到达后立即以 meta 为准）。 */
export const weComDailyFrequencyOptionSchema = z
  .object({
    value: weComDailyFrequencySchema,
    label: z.string(),
    needs_time: z.boolean(),
    needs_weekday: z.boolean(),
    needs_day_of_month: z.boolean(),
  })
  .strict();

export type WeComDailyFrequencyOptionData = z.infer<typeof weComDailyFrequencyOptionSchema>;

/** 条形图指标选项（`GET /meta` 的 `worker_metrics[]` 一项）。
 *
 *  ⚠️ 同样**由后端下发**：第四节用哪套口径是产品决定，写死在前端等于「后端加了第三种口径、
 *  前端静默只给两种」且零报错。 */
export const weComDailyWorkerMetricOptionSchema = z
  .object({
    value: weComDailyWorkerMetricSchema,
    label: z.string(),
  })
  .strict();

export type WeComDailyWorkerMetricOptionData = z.infer<typeof weComDailyWorkerMetricOptionSchema>;

// ============================================================
// 共享配置字段（`GET /config` 与 `GET /meta` 的 `defaults` 逐字同构）
//
// 抽成一份常量对象的原因：`defaults` 是「配置字段去掉 id / version / 时间戳 /
// webhook_configured / webhook_id」，两份手写会漂 —— 后端加一个配置字段时只改一处的话，
// `defaults` 就静默少一个键，前端「首次初始化用默认值」这条路径会把它抹掉。
// ============================================================

const weComDailyConfigFields = {
  /** 定时任务总开关。false 时后端不注册调度，但仍可手动发送。 */
  enabled: z.boolean(),
  frequency: weComDailyFrequencySchema,
  /** 触发时刻（小时 0..23）。MANUAL_ONLY ⇒ null。 */
  send_hour: z.number().int().min(0).max(23).nullable(),
  /** 触发时刻（分钟 0..59）。MANUAL_ONLY ⇒ null。 */
  send_minute: z.number().int().min(0).max(59).nullable(),
  /** WEEKLY 用，ISO 星期 1=周一 … 7=周日；其余频率 ⇒ null。 */
  weekday: z.number().int().min(1).max(7).nullable(),
  /** MONTHLY 用，1..28（封顶 28 避开短月）；其余频率 ⇒ null。 */
  day_of_month: z.number().int().min(1).max(28).nullable(),
  /** 推送目标 webhook（`/cron/wecom/webhooks` 一行的雪花 id ⇒ JSON string）。
   *  **null = 未选**（不是「用默认 webhook」—— 后端对 null **直接返 21801**，全仓没有任何
   *  回落到 `is_default` 的分支，所以选择器必须让用户显式选一条）。 */
  webhook_id: z.string().nullable(),
  /** 第三节「N 日内交期」的天数（默认 3）。取值域由 `meta.upcoming_days_range` 下发。 */
  upcoming_days: z.number().int(),
  /** 第四节条形图的指标口径（默认 QUANTITY）。取值域由 `meta.worker_metrics[]` 下发。 */
  worker_metric: weComDailyWorkerMetricSchema,
  /** 第四节最多列多少个工人（0 = 不限，默认 15）。范围由 `meta.worker_top_n_range` 下发。 */
  worker_top_n: z.number().int(),
  /** 一次触发最多发几条（默认 3；企业微信官方限频 20 条/分钟）。范围由
   *  `meta.max_chunks_range` 下发。 */
  max_chunks: z.number().int(),
  /** 节开关一：全厂报工总览。 */
  include_overview: z.boolean(),
  /** 节开关二：今日出货单数。 */
  include_delivery: z.boolean(),
  /** 节开关三：逾期未交工单 + N 日内交期工单。 */
  include_orders: z.boolean(),
  /** 节开关四：所有工人今日报工统计（**条形字符图，由后端渲染成 markdown 字符条**）。 */
  include_workers: z.boolean(),
  /** 标题模板；null = 用后端默认标题。 */
  subject_template: z.string().nullable(),
} as const;

// ============================================================
// GET /api/v2/cron/wecom-daily/config
// ============================================================

/** 单条每日总结配置（后端 `ConfigOut`，**21 个字段逐字对齐**）。
 *
 *  ⚠️ **表里无行时后端返「全部默认值 + `version: 0` + `id: "0"`」**（不是 404、不是
 *  `null`）⇒ 消费侧永远拿到可用的配置对象，首次保存时用 `version: 0` 作为 OCC 锚建行。
 *  所以本 schema **不接受 `null`**，也没有「配置不存在」的 UI 分支。 */
export const weComDailyConfigSchema = z
  .object({
    /** 配置行 id；「尚未建行」时后端返字符串 `"0"`（雪花 ID 的 JSON string 约定）。 */
    id: z.string(),
    /** OCC 锚，`POST /config` 必填（无行时为 0）。 */
    version: z.number(),
    ...weComDailyConfigFields,
    /** 纯 DB 存在性检查：`webhook_id` 指向的行还在不在。
     *
     *  ⚠️ **后端不解密**（它只查那条行有没有被软删），所以它判不出「地址已失效」。真正的
     *  「机器人已被移出群」只在推送那一刻以 21802 暴露 —— 页面**不**把它包装成「已配置」。 */
    webhook_configured: z.boolean(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .strict();

export type WeComDailyConfigData = z.infer<typeof weComDailyConfigSchema>;

// ============================================================
// GET /api/v2/cron/wecom-daily/meta
// ============================================================

/** `defaults` 段（后端 `ConfigDefaultsOut`）：**逐字就是上面那个共享字段对象**，16 个键
 *  一个不少不少 —— 相对 `ConfigOut` 去掉的只有 `id` / `version` / 两个时间戳 /
 *  `webhook_configured` 这 5 个行级字段。
 *
 *  ⚠️ **`webhook_id` 在 `defaults` 里恒为 `null`**（默认配置不该替用户选一条通道），但**键本身
 *  恒在**：它与另外 15 个字段走的是同一个 schema 对象。所以这条 schema 是 `.strict()` 的 ——
 *  后端哪天在 `defaults` 里少下发一个键（哪怕是恒为 `null` 的 `webhook_id`），parse 当场抛，
 *  频率选项与三段 range 全部退兜底 + 首屏弹一次「元数据加载失败」。
 *  守卫见 `__tests__/weComDailySchema.spec.ts` 的 M4 组（键集逐字相等 + 少一个键必抛）。 */
export const weComDailyConfigDefaultsSchema = z.object(weComDailyConfigFields).strict();

export type WeComDailyConfigDefaultsData = z.infer<typeof weComDailyConfigDefaultsSchema>;

/** 取值区间（`{min, max}`）。三段（天数 / 人数 / 分片）都用它，
 *  `.strict()` 的理由同上：后端将来加一维（比如「行高」）会当场红，需要显式决策。 */
const weComDailyRangeSchema = z
  .object({
    min: z.number(),
    max: z.number(),
  })
  .strict();

export const weComDailyMetaSchema = z
  .object({
    frequencies: z.array(weComDailyFrequencyOptionSchema),
    worker_metrics: z.array(weComDailyWorkerMetricOptionSchema),
    defaults: weComDailyConfigDefaultsSchema,
    /** 「N 日内交期」的天数取值范围（后端判据，前端 el-input-number 的 min/max 由此驱动，
     *  **不写死 1..60** —— 后端收窄 / 放宽时前端自动跟随）。 */
    upcoming_days_range: weComDailyRangeSchema,
    /** 第四节人数上限取值范围（**0 = 不限**；前端不硬编码 0..200）。 */
    worker_top_n_range: weComDailyRangeSchema,
    /** 一次触发最多发几条的取值范围（后端按企业微信官方限频 20 条/分钟定，前端不硬编码
     *  1..20 —— 「改这个数字」是一次必须两边同时做的决定，不该由前端单方面猜）。 */
    max_chunks_range: weComDailyRangeSchema,
  })
  .strict();

export type WeComDailyMetaData = z.infer<typeof weComDailyMetaSchema>;

// ============================================================
// POST /api/v2/cron/wecom-daily/preview
// ============================================================

/** 单个工人行（`PreviewOut.worker_rows[]` 一项）。
 *
 *  ⚠️ **条形图不在这一层**：字符条（`█` / `░`）由后端直接渲染进 `chunks[]` 的 markdown 文本，
 *  前端**只展示文本**、不引入任何图表组件（CLAUDE.md「图表」一节）。
 *
 *  ⚠️ **结构化字段：后端下发、当前只守门不展示** —— 预览弹窗只读同级的 `worker_row_total`
 *  （「工人 N 人」那枚 tag），`worker_rows[]` 的本体全仓没有渲染点（预览按「逐片展示
 *  `chunks`」的形态呈现，工人明细已是其中一片的正文）。留它在 `.strict()` 的出参里，是为了让
 *  「后端多发 / 少发一个键」当场红，而不是被 Zod 默认的 strip 静默吞掉。 */
export const weComDailyWorkerRowSchema = z
  .object({
    worker_name: z.string(),
    badge_code: z.string(),
    batch_count: z.number(),
    quantity: z.number(),
  })
  .strict();

/** 预览结果（后端 `PreviewOut`，**15 个字段逐字对齐**）。**渲染、不发送、不落流水**。
 *
 *  ⚠️ **`chunks` 是必填数组，契约里没有 `markdown` 单字段** —— 只维护一个真相源。同时维护
 *  `markdown` 与 `chunks` 会让「要发几条」有两个答案，而这个答案恰恰是管理员唯一需要预判的
 *  东西（见 `components/WeComPreviewDialog.vue`：逐片渲染 + 「第 i / N 条 · NNNN / 4096 字节」）。
 *
 *  ⚠️ **分片不是截断**：后端把超出企业微信单条消息上限（4096 字节）的内容**按块拆成多条**，
 *  绝不丢内容。所以 `chunks.length` 既是「要发几条」也是「内容有没有被丢掉」的判据。 */
export const weComDailyPreviewSchema = z
  .object({
    subject: z.string(),
    /** 将按顺序发送的 N 条 markdown，逐条 <= 4096 **字节**（⚠️ 不是字符数：中文一条消息
     *  按 UTF-8 占 3 字节，字符数会低估到三分之一）。 */
    chunks: z.array(z.string()),
    /** 冗余字段，恒等于 `chunks.length`（后端显式下发，省得前端自己数）。 */
    chunk_count: z.number(),
    /** 第一节：全厂今日报工批次数。 */
    overview_batch_count: z.number(),
    /** 第一节：全厂今日送检 / 放回件数。 */
    overview_quantity: z.number(),
    /** 第一节：今日完工单数。 */
    completed_count: z.number(),
    /** 第一节：当前在制工单数。 */
    in_process_count: z.number(),
    /** 第一节：今日返修单数。 */
    repair_part_count: z.number(),
    /** 第二节：今日已取货送货单数。 */
    note_count: z.number(),
    /** 第二节：今日已取货件数合计。 */
    note_part_count: z.number(),
    /** 第三节：逾期未交工单数。 */
    overdue_count: z.number(),
    /** 第三节：N 日内交期工单数。 */
    upcoming_count: z.number(),
    /** 第四节：工人行（全量，可能多于实际进 chunks 的条数 —— `worker_top_n` 截断后
     *  `chunks` 里只出现前 N 行，`worker_row_total` 才是全量行数）。 */
    worker_rows: z.array(weComDailyWorkerRowSchema),
    /** 全量工人行数（可能 > `chunks` 里出现的条数）。 */
    worker_row_total: z.number(),
    /** 本次实际生效的节（四个开关的交集，page 用来解释「我明明开了为什么没有这一节」）。 */
    sections: z.array(z.string()),
  })
  .strict();

export type WeComDailyPreviewData = z.infer<typeof weComDailyPreviewSchema>;

// ============================================================
// GET /api/v2/cron/wecom-daily/logs
// ============================================================

/** 单次发送的流水行（后端 `LogRow`，**19 个字段逐字对齐**，顺序照后端 struct 声明序）。
 *
 *  ⚠️ **不变量：`chunk_sent < chunk_count ⟺ status === 'FAILED'`**（来源：后端在发完最后一条
 *  才把 `chunk_sent` 补齐；中途失败时它停在已发出的那一条上）。`chunk_count === 0` 是
 *  **合法值** = 准备阶段就失败（还没渲染出任何一条），与「发了 0 / 0 条且成功」要靠 `status`
 *  区分 —— 所以「条数」列对 `chunk_count === 0` 一律显示 `—` 而不是 `0/0`
 *  （见 `components/WeComLogTable.vue`）。
 *
 *  ⚠️ **19 个键一个都不能少**：`.strict()` 对「多出来的键」当场抛。守卫见
 *  `__tests__/weComDailySchema.spec.ts` 的「少键必抛 / 多键必抛」两组。 */
export const weComDailyLogSchema = z
  .object({
    /** 该次发送流水行的 id（雪花 ID ⇒ JSON string）。 */
    log_id: z.string(),
    /** 发这条时配置表的 version（回溯「用的是哪版配置」的锚）。 */
    config_version: z.number(),
    /** 触发来源：定时任务 / 手动。 */
    trigger_source: weComDailyTriggerSourceSchema,
    status: weComDailySendStatusSchema,
    /** 推送目标名称的**快照**（落库时的名字，不是当前配置里的名字）。 */
    webhook_name: z.string(),
    /** 推送目标的**掩码**地址快照（不含完整 URL —— 与出参一致，完整地址永不落库到日志）。 */
    webhook_masked: z.string(),
    /** 统计日（报表口径的那一天）。⚠️ 恒等于 `sent_at` 的日期部分（后端同一个
     *  `now_naive()` 调用取值）⇒ 展示层**不建「统计日」列**，理由见 `WeComLogTable.vue`。 */
    report_date: z.string(),
    /** 全部片的字节数之和（不是字符数）。 */
    markdown_bytes: z.number(),
    /** 这次本来要发几条。 */
    chunk_count: z.number(),
    /** 实际发出去了几条（失败时 < `chunk_count`）。 */
    chunk_sent: z.number(),
    overview_batch_count: z.number(),
    overview_quantity: z.number(),
    note_count: z.number(),
    note_part_count: z.number(),
    overdue_count: z.number(),
    upcoming_count: z.number(),
    /** 全量工人行数（`worker_top_n` 截断前的真实行数）。 */
    worker_row_total: z.number(),
    /** 失败原因；成功行恒为 null。 */
    error_message: z.string().nullable(),
    /** 发送时刻（后端 naive timestamp 字符串，**无时区后缀**）。失败行也记时刻。 */
    sent_at: z.string(),
  })
  .strict();

export type WeComDailyLogData = z.infer<typeof weComDailyLogSchema>;

/** 发送流水分页信封。四个计数按后端裸 i64 ⇒ JSON number 守门。 */
export const weComDailyLogListSchema = z
  .object({
    items: z.array(weComDailyLogSchema),
    total: z.number(),
    limit: z.number(),
    offset: z.number(),
  })
  .strict();

export type WeComDailyLogListData = z.infer<typeof weComDailyLogListSchema>;

// ============================================================
// 表单 schema（保存 / 预览 / 立即发送 三个动作共用的前置校验）
// ============================================================

/** 频率的「配套字段」判据。值来自 `GET /meta` 的 `frequencies[]`，三个 needs_* 决定
 * 时间 / 星期 / 月号这三个输入项显不显示、以及缺不缺就拒（对应后端 21804）。 */
export interface WeComDailyFrequencyFlags {
  needs_time: boolean;
  needs_weekday: boolean;
  needs_day_of_month: boolean;
}

export type WeComDailyFrequencyFlagMap = Record<WeComDailyFrequency, WeComDailyFrequencyFlags>;

/** 「meta 还没回来」时的兜底判据（DAILY 要时刻 / WEEKLY 额外要星期 / MONTHLY 额外要月号 /
 *  MANUAL_ONLY 全不要）。**meta 到达后一律以 meta 为准** —— 这份只是让首屏在 meta 未到达时
 * 也能给出与后端一致的校验，不构成第二真源。 */
export const DEFAULT_WECOM_DAILY_FREQUENCY_FLAGS: WeComDailyFrequencyFlagMap = {
  DAILY: { needs_time: true, needs_weekday: false, needs_day_of_month: false },
  WEEKLY: { needs_time: true, needs_weekday: true, needs_day_of_month: false },
  MONTHLY: { needs_time: true, needs_weekday: false, needs_day_of_month: true },
  MANUAL_ONLY: { needs_time: false, needs_weekday: false, needs_day_of_month: false },
};

/** 同上，中文 label 的兜底。meta 到达后以 `meta.frequencies[].label` 为准；这份让首屏
 * （meta 还在飞）在频率单选组里也能显示四个可点的选项而不是一个空组。 */
export const DEFAULT_WECOM_DAILY_FREQUENCY_LABELS: Record<WeComDailyFrequency, string> = {
  DAILY: '每天',
  WEEKLY: '每周（指定星期几）',
  MONTHLY: '每月（指定几号）',
  MANUAL_ONLY: '仅手动',
};

/** 「meta 未到达」时的完整频率选项列表（label + 三个 needs_* 都取兜底值）。 */
export const DEFAULT_WECOM_DAILY_FREQUENCY_OPTIONS: WeComDailyFrequencyOptionData[] =
  WECOM_DAILY_FREQUENCIES.map((value) => ({
    value,
    label: DEFAULT_WECOM_DAILY_FREQUENCY_LABELS[value],
    ...DEFAULT_WECOM_DAILY_FREQUENCY_FLAGS[value],
  }));

/** 「meta 未到达」时的条形图指标选项。⚠️ 兜底值**刻意与后端缺省一致**（QUANTITY 排在前面），
 * 但真源仍是 `meta.worker_metrics[]` —— 这份只保证 meta 在飞时下拉不是空的。 */
export const DEFAULT_WECOM_DAILY_WORKER_METRIC_OPTIONS: WeComDailyWorkerMetricOptionData[] = [
  { value: 'QUANTITY', label: '按件数' },
  { value: 'BATCH', label: '按批次数' },
];

/** 表单态（页面持有的可编辑模型）。与 `GET /config` 的差别只有两处，都是 UI 需要：
 *  - `subject_template` 恒为 `string`（`el-input` 绑不了 null，留空 = 发 null）；
 *  - 三个数字输入（天数 / 人数 / 分片）允许 `undefined` / `null`
 *    （`el-input-number` 被清空时的取值）。 */
export interface WeComDailyFormModel {
  enabled: boolean;
  frequency: WeComDailyFrequency;
  send_hour: number | null;
  send_minute: number | null;
  weekday: number | null;
  day_of_month: number | null;
  webhook_id: string | null;
  upcoming_days: number | undefined;
  worker_metric: WeComDailyWorkerMetric;
  worker_top_n: number | undefined;
  max_chunks: number | undefined;
  include_overview: boolean;
  include_delivery: boolean;
  include_orders: boolean;
  include_workers: boolean;
  subject_template: string;
}

export type WeComDailyFormField =
  | 'frequency'
  | 'send_time'
  | 'weekday'
  | 'day_of_month'
  | 'webhook_id'
  | 'upcoming_days'
  | 'worker_metric'
  | 'worker_top_n'
  | 'max_chunks'
  | 'sections'
  | 'subject_template';

export type WeComDailyFormFieldErrors = Partial<Record<WeComDailyFormField, string>>;

/** 把 `el-input-number` / `el-select` 可能给出的 `null` / `undefined` / `''` 归一成
 *  `null`（=「没填」）；其它值走 `Number()`。`NaN` 保留下去交给下游的类型校验报错，
 *  **不在这里悄悄回落到 0**（那会让「清空天数」变成「未来 0 天」）。 */
function toNullableNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  return Number(v);
}

/** 可空整数（`weekday` / `day_of_month` / `send_hour` / `send_minute` 共用）。 */
const nullableInt = (min: number, max: number, message: string) =>
  z.preprocess(
    toNullableNumber,
    z
      .number({ error: '请输入数字' })
      .int('必须是整数')
      .min(min, message)
      .max(max, message)
      .nullable(),
  );

/** 必填整数（`upcoming_days` / `worker_top_n` / `max_chunks`）。`el-input-number` 被清空时给
 *  的是 `undefined` / `null`，`z.coerce.number()` 会把 `null` 静默转成 **0**
 *  （`Number(null) === 0`）—— 那会让「清空」看起来像「0 天 / 0 人 / 0 条」。故先把空值转成
 *  `NaN`，让类型校验按「没填」报错。 */
const requiredInt = (min: number, max: number, message: string) =>
  z.preprocess(
    (v) => (v === null || v === undefined || v === '' ? Number.NaN : v),
    z.coerce.number({ error: message }).int('必须是整数').min(min, message).max(max, message),
  );

/** 三段取值范围的兜底（meta 未到达时用）。⚠️ 与 `WeComContentSection` / `WeComScheduleSection`
 * 的 prop 默认值逐字一致 —— 那些与本文件都是「meta 还没回来」这一瞬的兜底，meta 到达后以
 * meta 为准。**不是**第二真源：后端改范围后前端一律以 meta 为准（schema 与输入项的
 * `:min/:max` 共用同一份，见 `makeWeComDailyFormSchema` 的调用点）。 */
export const DEFAULT_WECOM_DAILY_RANGES = {
  upcoming_days: { min: 1, max: 60 },
  worker_top_n: { min: 0, max: 200 },
  max_chunks: { min: 1, max: 20 },
} as const;

/** `makeWeComDailyFormSchema` 的第二个形参：三段取值范围（全部来自 `GET /meta`）。 */
export interface WeComDailyRanges {
  upcoming_days: { min: number; max: number };
  worker_top_n: { min: number; max: number };
  max_chunks: { min: number; max: number };
}

/**
 * 构造表单校验 schema。
 *
 * @param frequencyFlags `GET /meta` 的 `frequencies[]` 转成的判据表；缺省用
 *   `DEFAULT_WECOM_DAILY_FREQUENCY_FLAGS`（meta 未到达时的兜底）。
 * @param ranges `GET /meta` 的三段取值范围；缺省用 `DEFAULT_WECOM_DAILY_RANGES`。
 *   ⚠️ **范围只有这一处真源** —— 输入项的 `:min/:max` 本来就读同一份，在 schema 里再写死一份
 *   就会出现「UI 允许输 90、schema 却拒」的矛盾（用户被前端自己的校验挡住且看不到原因）。
 *
 * 组合校验在 `superRefine` 里做，报错 issue 的 `path` **指向具体输入项**（`send_time` /
 * `weekday` / `day_of_month` / `sections` / …）而不是笼统挂在频率上 —— 页面的字段聚焦与标红
 * 靠 `path[0]` 定位。
 *
 * ⚠️ **「缺」类分支 = 后端会拒（21804）；「多」类分支 = 仅前端兜底**：后端对「多填当前频率
 * 用不到的配套字段」是**清空 / 忽略**、不报 21804（口径与邮件域同款）。这两类之所以值得分开
 * 写，是因为「多」类那三条的 `path` 指向的输入框在对应频率下**整行不渲染**（见
 * `components/WeComScheduleSection.vue` 的 `v-if="flags.needs_*"`）⇒ 不可见的字段上挂红字
 * 等于把三条动作全拦死却零提示。所以 store 的 `applyConfigToForm` 与 section 的
 * `onFrequencyChange` 都先按判据归一，schema 里那三条只是**兜底**。
 */
export function makeWeComDailyFormSchema(
  frequencyFlags: WeComDailyFrequencyFlagMap = DEFAULT_WECOM_DAILY_FREQUENCY_FLAGS,
  ranges: WeComDailyRanges = DEFAULT_WECOM_DAILY_RANGES,
) {
  const base = z.object({
    enabled: z.boolean(),
    frequency: weComDailyFrequencySchema,
    send_hour: nullableInt(0, 23, '触发小时需在 0..23 之间'),
    send_minute: nullableInt(0, 59, '触发分钟需在 0..59 之间'),
    weekday: nullableInt(1, 7, '请选择星期（1=周一 … 7=周日）'),
    day_of_month: nullableInt(1, 28, '每月几号需在 1..28 之间'),
    // 留空合法（= 推送时才发现没通道，后端 21801），见 `WeComDailyFormModel.webhook_id` 的说明。
    // `el-select` 清空给出的是 `''`，归一成 null（= 未选）后才不会把空串塞上 wire。
    // ⚠️ 这里只做**归一**（issue 的 path 仍是 `webhook_id`，与 `WeComDailyFormField` 的键名
    // 逐字一致，模板才读得到红字 —— 那半句是留给将来「未选也拦」那条规则的接口）。
    webhook_id: z.preprocess(
      (v) => (v === '' || v === undefined ? null : v),
      z.string({ error: '请选择推送通道' }).trim().min(1, '请选择推送通道').nullable(),
    ),
    upcoming_days: requiredInt(
      ranges.upcoming_days.min,
      ranges.upcoming_days.max,
      `未来天数需在 ${ranges.upcoming_days.min}..${ranges.upcoming_days.max} 之间`,
    ),
    worker_metric: weComDailyWorkerMetricSchema,
    worker_top_n: requiredInt(
      ranges.worker_top_n.min,
      ranges.worker_top_n.max,
      `人数上限需在 ${ranges.worker_top_n.min}..${ranges.worker_top_n.max} 之间（0 = 不限）`,
    ),
    max_chunks: requiredInt(
      ranges.max_chunks.min,
      ranges.max_chunks.max,
      `单次最多条数需在 ${ranges.max_chunks.min}..${ranges.max_chunks.max} 之间`,
    ),
    include_overview: z.boolean(),
    include_delivery: z.boolean(),
    include_orders: z.boolean(),
    include_workers: z.boolean(),
    // 留空合法（= 用后端默认标题），超长才拒。
    subject_template: z.string().trim().max(200, '标题模板长度不能超过 200 个字符'),
  });

  return base.superRefine((v, ctx) => {
    const flags = frequencyFlags[v.frequency];
    if (!flags) return;
    const fail = (field: WeComDailyFormField, message: string): void => {
      ctx.addIssue({ code: 'custom', path: [field], message });
    };

    // ── 「缺」类：后端会拒（21804）─────────────────────────────────────────
    if (flags.needs_time) {
      if (v.send_hour === null) fail('send_time', '请选择触发时刻（时:分）');
      if (v.send_minute === null) fail('send_time', '请选择触发时刻（时:分）');
    }
    if (flags.needs_weekday && v.weekday === null) {
      fail('weekday', '每周推送需指定星期几');
    }
    if (flags.needs_day_of_month && v.day_of_month === null) {
      fail('day_of_month', '每月推送需指定几号（1..28）');
    }

    // ── 「多」类：仅前端兜底（后端清空 / 忽略，不报 21804）─────────────────
    if (!flags.needs_time && (v.send_hour !== null || v.send_minute !== null)) {
      fail('send_time', '仅手动推送不需要触发时刻');
    }
    if (!flags.needs_weekday && v.weekday !== null) {
      fail('weekday', '当前频率不使用星期设置');
    }
    if (!flags.needs_day_of_month && v.day_of_month !== null) {
      fail('day_of_month', '当前频率不使用每月几号设置');
    }

    // ── 本域特有三条 ──────────────────────────────────────────────────────
    // ① 四节全关 ⇒ 没有任何内容可推。issue 挂在 `sections`（一个虚拟字段）上：它不对应任何
    //    单个输入项，而是**四个开关共同**的责任；页面把它渲染成一行提示而不是某个框的红字。
    if (!v.include_overview && !v.include_delivery && !v.include_orders && !v.include_workers) {
      fail('sections', '四节内容至少要开启一节，否则推送出去是一条空消息');
    }
    // ② / ③ 人数与分片上限的越界判据**全部取自 meta 的 range**（`ranges` 形参），
    //    与输入项的 `:min/:max` 同源 ⇒ 后端改范围时前端不会一边放行一边拦。
  });
}

/** 把 ZodIssue 列表按字段聚合到字段错误表；同字段多 issue 只取第一条
 *  （照 `views/users/usersSchema.ts` 的同款 helper）。 */
export function toWeComDailyFieldErrors(
  issues: Array<{ path: PropertyKey[]; message: string }>,
): WeComDailyFormFieldErrors {
  const out: WeComDailyFormFieldErrors = {};
  for (const issue of issues) {
    const key = issue.path[0] as WeComDailyFormField | undefined;
    if (key && !out[key]) out[key] = issue.message;
  }
  return out;
}
