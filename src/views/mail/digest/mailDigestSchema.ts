// src/views/mail/digest/mailDigestSchema.ts
//
// 2026-10-13 新建：交期汇总邮件域的 Zod schema，两组用途（形态照 `views/users/usersSchema.ts`）：
//
//   1. **守门**：`mailDigestConfigSchema` / `mailDigestMetaSchema` /
//      `mailDigestPreviewSchema` / `mailDigestSendResultSchema` / `mailDigestLogListSchema`。
//      三条读端点（config / meta / logs）的守门点在 queryFn
//      （`composables/useMailDigestQuery.ts`）；两条「跑一次」的端点（preview / send）
//      走 useMutation、没有 queryFn 承载，**守门留在 api 层**（CLAUDE.md 为「没有
//      queryFn 承载的调用」留的口子，同 `api/inspection.ts` 的扫码树）。
//   2. **表单校验**：`makeMailDigestFormSchema(frequencyFlags)` —— 保存 / 预览 / 立即发送
//      三个动作共用的前置校验，把后端 21703（邮箱非法）/ 21704（频率与配套字段组合非法）
//      的拒绝提前到浏览器，并给出**聚焦到具体字段**的提示（页面据此给对应输入项标红）。
//      2026-10-14：这两个码原写作 21503 / 21504，后端实查发现 215xx 已被 outsource 发货
//      域占用、改用了 217xx 段，本文件随之对齐（码值单一来源见 `mailDigestErrorText.ts`
//      的 `MAIL_DIGEST_ERROR_CODES`）。
//
// 两条 wire 序列化约定（照抄 statistics / users 两组 schema 的结论）：
//   - **雪花 / 业务 ID 一律 JSON string**：`id` / `log_id` 是 `z.string()`，禁
//     `z.number()`（19 位 ID 在 JS Number 下丢精度）。
//   - **计数 / 版本号 / 时分天一律 JSON number**：`version` / `upcoming_days` /
//     `send_hour` / `overdue_count` / `html_bytes` / `total` 等。`version` 不是 ID。
//
// 2026-10-16：SMTP 从「部署级环境变量」改为「页面内可维护的邮箱账号实体」
// （后端 `/api/v2/mail/*`，前端 `views/mail/accounts/`），本文件随之两处改动：
//   - 配置字段新增 `sender_account_id`（选哪条邮箱发信，null = 未选），因为它与其它
//     配置项同属一份 `mailDigestConfigFields`（同时进 `GET /config` 与 `meta.defaults`）；
//   - `mailDigestMetaSchema` 删掉整段 `smtp` —— 它描述的是部署级 SMTP，与页面里配置的
//     邮箱账号是**两个会打架的真源**。
//
// ⚠️ **`.strict()` 的取舍**：信封 / 行层一律 `.strict()`，与 `views/users/usersSchema.ts`
// 同款 —— 后端给本域加派生字段（例如「上次发送时间」）时会被这里挡住、需要显式决策，
// 而不是被 Zod 默认的 strip 静默吞掉（吞掉后前端「照样通过校验」，那一列整列失效且
// 无人发现）。代价是后端加字段必须同步前端，与仓内既有的 users / 契约测试同口径。

import { z } from 'zod';
import { MAIL_DIGEST_FREQUENCIES, type MailDigestFrequency } from '@/types/mailDigest';

// ============================================================
// 公共原子
// ============================================================

export const mailDigestFrequencySchema = z.enum(MAIL_DIGEST_FREQUENCIES);

export const mailDigestTriggerSourceSchema = z.enum(['SCHEDULED', 'MANUAL']);

export const mailDigestSendStatusSchema = z.enum(['SUCCESS', 'FAILED']);

/** 频率选项（`GET /meta` 的 `frequencies[]` 一项）。
 *
 *  ⚠️ **三个 `needs_*` 是后端下发的、不是前端硬编码的判据**：配套字段该显不显由它们
 *  决定，页面与表单校验都读它（表单校验的默认档见 `DEFAULT_MAIL_DIGEST_FREQUENCY_FLAGS`，
 *  它只是「meta 还没回来」时的兜底，meta 到达后立即以 meta 为准）。 */
export const mailDigestFrequencyOptionSchema = z
  .object({
    value: mailDigestFrequencySchema,
    label: z.string(),
    needs_time: z.boolean(),
    needs_weekday: z.boolean(),
    needs_day_of_month: z.boolean(),
  })
  .strict();

export type MailDigestFrequencyOptionData = z.infer<typeof mailDigestFrequencyOptionSchema>;

/** 表格列白名单的候选（`GET /meta` 的 `columns[]` 一项）。 */
export const mailDigestColumnOptionSchema = z
  .object({
    key: z.string(),
    label: z.string(),
  })
  .strict();

export type MailDigestColumnOptionData = z.infer<typeof mailDigestColumnOptionSchema>;

// ============================================================
// 共享配置字段（`GET /config` 与 `GET /meta` 的 `defaults` 逐字同构）
//
// 抽成一份常量对象的原因：`defaults` 是 `Omit<Config, 'id'|'version'|'created_at'|
// 'updated_at'|'smtp_configured'>`，两份手写会漂 —— 后端加一个配置字段时只改一处的话，
// `defaults` 就静默少一个键，前端「首次初始化用默认值」这条路径会把它抹掉。
// ============================================================

const mailDigestConfigFields = {
  /** 定时任务总开关。false 时后端不注册调度，但仍可手动发送。 */
  enabled: z.boolean(),
  frequency: mailDigestFrequencySchema,
  /** 触发时刻（小时 0..23）。MANUAL_ONLY ⇒ null。 */
  send_hour: z.number().int().min(0).max(23).nullable(),
  /** 触发时刻（分钟 0..59）。MANUAL_ONLY ⇒ null。 */
  send_minute: z.number().int().min(0).max(59).nullable(),
  /** WEEKLY 用，ISO 星期 1=周一 … 7=周日；其余频率 ⇒ null。 */
  weekday: z.number().int().min(1).max(7).nullable(),
  /** MONTHLY 用，1..28（封顶 28 避开短月）；其余频率 ⇒ null。 */
  day_of_month: z.number().int().min(1).max(28).nullable(),
  /** 收件人（TO）。 */
  recipients: z.array(z.string()),
  /** 抄送（CC）。 */
  cc_recipients: z.array(z.string()),
  include_overdue: z.boolean(),
  include_upcoming: z.boolean(),
  upcoming_days: z.number().int(),
  /** 表格列白名单（取自 `meta.columns[].key`）。 */
  visible_columns: z.array(z.string()),
  /** 标题模板；null = 用后端默认标题。 */
  subject_template: z.string().nullable(),
  /** 2026-10-16 新增：发信邮箱（`/api/v2/mail/accounts` 的一行）。
   *  **null = 未选**（不是「用默认邮箱」—— 后端 `mail_digest::service::resolve_sender`
   *  对 null **直接返 21701（503）**，全仓没有任何回落到默认邮箱的分支，所以选择器必须
   *  让用户显式选一条）。雪花 ID ⇒ JSON string。
   *  ⚠️ 它同时出现在 `GET /config` 与 `GET /meta` 的 `defaults` 里（同一份
   *  `mailDigestConfigFields`），所以两端到齐后缺键会当场抛而不是静默 strip 成 undefined。 */
  sender_account_id: z.string().nullable(),
} as const;

// ============================================================
// GET /api/v2/mail-digest/config
// ============================================================

/** 单条定时配置（后端 `MailDigestConfigOut`）。
 *
 *  ⚠️ **表里无行时后端返「全部默认值 + `version: 0` + `id: "0"`」**（不是 404、不是
 *  `null`）⇒ 消费侧永远拿到可用的配置对象，首次保存时用 `version: 0` 作为 OCC 锚
 *  建行。所以本 schema 不接受 `null`，也没有「配置不存在」的 UI 分支。 */
export const mailDigestConfigSchema = z
  .object({
    /** 配置行 id；「尚未建行」时后端返字符串 `"0"`（雪花 ID 的 JSON string 约定）。 */
    id: z.string(),
    /** OCC 锚，`POST /config` 必填（无行时为 0）。 */
    version: z.number(),
    ...mailDigestConfigFields,
    /** SMTP 是否已配置。
     *
     *  ⚠️ 2026-10-16：本字段**保留**是因为后端仍在 `GET /config` 里下发它（契约未删），
     *  但**前端已无消费方** —— SMTP 判定改由邮箱账号实体承载（`accounts.length === 0`
     *  或未选 `sender_account_id`，见 `useMailDigestStore` 的 `noAccounts` /
     *  `senderMissing`）。留着它是因为它是**必填键**、schema 是 `.strict()`：后端哪天把它
     *  删掉会当场抛（响亮的失败，要显式决策），而不是被 Zod 默认的 strip 静默吞掉。 */
    smtp_configured: z.boolean(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .strict();

export type MailDigestConfigData = z.infer<typeof mailDigestConfigSchema>;

// ============================================================
// GET /api/v2/mail-digest/meta
// ============================================================

/** `defaults` 段：与上面共享字段逐字同构（少了 id / version / 时间戳 / smtp 标志）。 */
export const mailDigestConfigDefaultsSchema = z.object(mailDigestConfigFields).strict();

export type MailDigestConfigDefaultsData = z.infer<typeof mailDigestConfigDefaultsSchema>;

export const mailDigestMetaSchema = z
  .object({
    frequencies: z.array(mailDigestFrequencyOptionSchema),
    columns: z.array(mailDigestColumnOptionSchema),
    defaults: mailDigestConfigDefaultsSchema,
    /** 「含未来 N 天」的天数取值范围（前端 el-input-number 的 min/max 由此驱动，
     *  不写死 1..60 —— 范围是后端的判据，后端收窄时前端自动跟随）。 */
    upcoming_days_range: z
      .object({
        min: z.number(),
        max: z.number(),
      })
      .strict(),
    // 2026-10-16：`smtp` 段（configured / host / port / from_address / from_name）**已
    // 删除**。SMTP 配置不再是部署级的环境变量，而是**页面内可维护的邮箱账号实体**
    // （`views/mail/accounts/`，后端 `/api/v2/mail/*`）：发信地址、授权码、选哪条发信
    // 全部改由那几张表承载，`meta` 里再留一段「部署级 SMTP」只会变成第二个真源，且两者
    // 迟早会打架（运维改了 env、页面里配的邮箱是另一个地址，报错时没头绪）。
    // 页面顶部的告警判据随之改为「邮箱列表为空 / 未选发信邮箱」。
  })
  .strict();

export type MailDigestMetaData = z.infer<typeof mailDigestMetaSchema>;

// ============================================================
// POST /api/v2/mail-digest/preview
// ============================================================

export const mailDigestPreviewSchema = z
  .object({
    subject: z.string(),
    /** 邮件正文 HTML（服务端渲染）。页面用 `<iframe :srcdoc>` 渲染，见
     *  `components/MailPreviewDialog.vue` 的注释（为什么不走 v-html）。 */
    html: z.string(),
    overdue_count: z.number(),
    upcoming_count: z.number(),
    /** 本次实际生效的列（= 请求里的 `visible_columns` ∩ `meta.columns[].key`）。 */
    columns: z.array(z.string()),
  })
  .strict();

export type MailDigestPreviewData = z.infer<typeof mailDigestPreviewSchema>;

// ============================================================
// POST /api/v2/mail-digest/send 与 GET /api/v2/mail-digest/logs
// ============================================================

/** 单次发送结果（`POST /send` 成功时的返回；也是 `LogItem` 的基础形状）。 */
export const mailDigestSendResultSchema = z
  .object({
    /** 该次发送日志行的 id（雪花 ID ⇒ JSON string）。 */
    log_id: z.string(),
    status: mailDigestSendStatusSchema,
    subject: z.string(),
    /** 实际投递的 TO（落库时的快照，不是当前配置）。 */
    to_recipients: z.array(z.string()),
    overdue_count: z.number(),
    upcoming_count: z.number(),
    /** 正文字节数（便于事后核对大小）。 */
    html_bytes: z.number(),
    /** 发送时刻（后端 naive timestamp 字符串）。失败行也记时刻。 */
    sent_at: z.string(),
    /** 失败原因；成功行恒为 null。 */
    error_message: z.string().nullable(),
  })
  .strict();

export type MailDigestSendResultData = z.infer<typeof mailDigestSendResultSchema>;

/** 发送日志行 = 发送结果 + 三个「当时」的快照字段。 */
export const mailDigestLogSchema = mailDigestSendResultSchema
  .extend({
    /** 发这封时配置表的 version（回溯「用的是哪版配置」的锚）。 */
    config_version: z.number(),
    /** 当时的 CC 快照。 */
    cc_recipients: z.array(z.string()),
    /** 触发来源：定时任务 / 手动。 */
    trigger_source: mailDigestTriggerSourceSchema,
  })
  .strict();

export type MailDigestLogData = z.infer<typeof mailDigestLogSchema>;

/** 发送日志分页信封。三个计数按后端裸 i64 ⇒ JSON number 守门
 *  （归一点若将来需要，加在 api 层 `normalizeListResult`，schema 不做二次归一）。 */
export const mailDigestLogListSchema = z
  .object({
    items: z.array(mailDigestLogSchema),
    total: z.number(),
    limit: z.number(),
    offset: z.number(),
  })
  .strict();

export type MailDigestLogListData = z.infer<typeof mailDigestLogListSchema>;

// ============================================================
// 表单 schema（保存 / 预览 / 立即发送 三个动作共用的前置校验）
// ============================================================

/** 频率的「配套字段」判据。值来自 `GET /meta` 的 `frequencies[]`，三个 needs_* 决定
 *  时间 / 星期 / 月号这三个输入项显不显示、以及缺不缺就拒（对应后端 21704）。 */
export interface MailDigestFrequencyFlags {
  needs_time: boolean;
  needs_weekday: boolean;
  needs_day_of_month: boolean;
}

export type MailDigestFrequencyFlagMap = Record<MailDigestFrequency, MailDigestFrequencyFlags>;

/** 「meta 还没回来」时的兜底判据（DAILY 要时刻 / WEEKLY 额外要星期 / MONTHLY 额外要
 *  月号 / MANUAL_ONLY 全不要）。**meta 到达后一律以 meta 为准** —— 这份只是让首屏
 *  在 meta 未到达时也能给出与后端一致的校验，不构成第二真源。 */
export const DEFAULT_MAIL_DIGEST_FREQUENCY_FLAGS: MailDigestFrequencyFlagMap = {
  DAILY: { needs_time: true, needs_weekday: false, needs_day_of_month: false },
  WEEKLY: { needs_time: true, needs_weekday: true, needs_day_of_month: false },
  MONTHLY: { needs_time: true, needs_weekday: false, needs_day_of_month: true },
  MANUAL_ONLY: { needs_time: false, needs_weekday: false, needs_day_of_month: false },
};

/** 同上，中文 label 的兜底。meta 到达后以 `meta.frequencies[].label` 为准；这份让
 *  首屏（meta 还在飞）在频率单选组里也能显示四个可点的选项而不是一个空组。 */
export const DEFAULT_MAIL_DIGEST_FREQUENCY_LABELS: Record<MailDigestFrequency, string> = {
  DAILY: '每天',
  WEEKLY: '每周（指定星期几）',
  MONTHLY: '每月（指定几号）',
  MANUAL_ONLY: '仅手动',
};

/** 「meta 未到达」时的完整频率选项列表（label + 三个 needs_* 都取兜底值）。 */
export const DEFAULT_MAIL_DIGEST_FREQUENCY_OPTIONS: MailDigestFrequencyOptionData[] =
  MAIL_DIGEST_FREQUENCIES.map((value) => ({
    value,
    label: DEFAULT_MAIL_DIGEST_FREQUENCY_LABELS[value],
    ...DEFAULT_MAIL_DIGEST_FREQUENCY_FLAGS[value],
  }));

/** 表单态（页面持有的可编辑模型）。与 `GET /config` 的差别只有两处，都是 UI 需要：
 *  - `subject_template` 恒为 `string`（`el-input` 绑不了 null，留空 = 发 null）；
 *  - `upcoming_days` 允许 `undefined` / `null`（`el-input-number` 被清空时的取值）。 */
export interface MailDigestFormModel {
  enabled: boolean;
  frequency: MailDigestFrequency;
  send_hour: number | null;
  send_minute: number | null;
  weekday: number | null;
  day_of_month: number | null;
  recipients: string[];
  cc_recipients: string[];
  include_overdue: boolean;
  include_upcoming: boolean;
  upcoming_days: number | undefined;
  visible_columns: string[];
  subject_template: string;
  /** 2026-10-16：发信邮箱 id（`/api/v2/mail/accounts` 的雪花 id，JSON string）。
   *  null = 未选。表单校验**不拦**它 —— **空选是合法保存**（用户可能只想先改收件人清单，
   *  拦了就等于强迫他先建邮箱再干别的）。代价是「真要发信时」后端以 21701 失败，所以
   *  页面顶部给告警、「立即发送」按钮给禁用（见 `MailDigestSettings.vue` 的
   *  `senderMissing` 与 `useMailDigestStore` 的 `sendDisabled`）。 */
  sender_account_id: string | null;
}

// ⚠️ `sender_account_id` 的键名与 wire 上**逐字一致**：Zod issue 的 `path[0]` 就是 schema
// 的键名，模板读的也是这个键。写成 `'sender_account'` 的话 `errors.sender_account` 永远拿不到
// （潜伏项：那处校验当前因 preprocess 已把 `''` 归一成 null 而不可达，但它是留给将来
// 「未选也拦」那条规则的接口）。
export type MailDigestFormField =
  | 'frequency'
  | 'send_time'
  | 'weekday'
  | 'day_of_month'
  | 'recipients'
  | 'cc_recipients'
  | 'upcoming_days'
  | 'visible_columns'
  | 'subject_template'
  | 'sender_account_id';

export type MailDigestFormFieldErrors = Partial<Record<MailDigestFormField, string>>;

/** 把 `el-input-number` / `el-select` 可能给出的 `null` / `undefined` / `''` 归一成
 *  `null`（=「没填」）；其它值走 `Number()`。`NaN` 保留下去交给下游的类型校验报错，
 *  不在这里悄悄回落到 0（那会让「清空天数」变成「未来 0 天」）。 */
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

/** 必填整数（`upcoming_days`）。`el-input-number` 被清空时给的是 `undefined` / `null`，
 *  `z.coerce.number()` 会把 `null` 静默转成 **0**（`Number(null) === 0`）——
 *  那会让「清空」看起来像「未来 0 天」。故先把空值转成 `NaN`，让类型校验按「没填」报错。 */
const requiredInt = (min: number, max: number, message: string) =>
  z.preprocess(
    (v) => (v === null || v === undefined || v === '' ? Number.NaN : v),
    z.coerce.number({ error: message }).int('必须是整数').min(min, message).max(max, message),
  );

/** 邮箱基本格式（对齐后端 21703）。刻意不做 RFC 5322 全量校验：前端只负责把明显
 *  离谱的值拦下来给人话提示，最终判据在后端（多拦会误伤合法地址）。额外拦
 *  `\r\n` —— 那是邮件头注入的原料，后端也会拒，但前端拦一道能在提交前就说清。 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const emailItemSchema = z
  .string()
  .trim()
  .min(3, '邮箱格式不正确')
  .max(254, '邮箱过长')
  .refine((v) => !/[\r\n]/.test(v), '邮箱不能包含换行')
  .refine((v) => EMAIL_RE.test(v), '邮箱格式不正确');

/** 「未来 N 天」取值范围的兜底（meta 未到达时用）。与 `MailContentSection` 的 prop
 *  默认值逐字一致 —— 两处都是「meta 还没回来」这一瞬的兜底，meta 到达后以 meta 为准。 */
const DEFAULT_UPCOMING_DAYS_RANGE = { min: 1, max: 60 };

/**
 * 构造表单校验 schema。
 *
 * @param frequencyFlags `GET /meta` 的 `frequencies[]` 转成的判据表；缺省用
 *   `DEFAULT_MAIL_DIGEST_FREQUENCY_FLAGS`（meta 未到达时的兜底）。
 * @param upcomingDaysRange `GET /meta` 的 `upcoming_days_range`；缺省用
 *   `DEFAULT_UPCOMING_DAYS_RANGE`。⚠️ 2026-10-14（review 第 1 轮 N-1）：**范围只有这
 *   一处真源**——`MailContentSection` 的 `:min/:max` 本来就读它，这里曾把 `1..60` 写死，
 *   于是后端把上限放宽到 90 时「UI 允许输 90、schema 却拒」，用户被前端自己的校验挡住
 *   且看不到任何原因说明。
 *
 * 组合校验在 `superRefine` 里做，报错 issue 的 `path` **指向具体输入项**（`send_time` /
 * `weekday` / `day_of_month`）而不是笼统挂在频率上 —— 页面的字段聚焦与标红靠 `path[0]`
 * 定位，笼统挂频率会让用户盯着一个「看不出该改哪」的报错。
 * ⚠️ 「缺字段」那一支对应后端 **21704**；「多填」那一支后端是**清空 / 忽略**、不报 21704
 * （详见 `superRefine` 内部注释）。
 */
export function makeMailDigestFormSchema(
  frequencyFlags: MailDigestFrequencyFlagMap = DEFAULT_MAIL_DIGEST_FREQUENCY_FLAGS,
  upcomingDaysRange: { min: number; max: number } = DEFAULT_UPCOMING_DAYS_RANGE,
) {
  const base = z.object({
    enabled: z.boolean(),
    frequency: mailDigestFrequencySchema,
    send_hour: nullableInt(0, 23, '触发小时需在 0..23 之间'),
    send_minute: nullableInt(0, 59, '触发分钟需在 0..59 之间'),
    weekday: nullableInt(1, 7, '请选择星期（1=周一 … 7=周日）'),
    day_of_month: nullableInt(1, 28, '每月几号需在 1..28 之间'),
    recipients: z.array(emailItemSchema).min(1, '至少填写一个收件人'),
    cc_recipients: z.array(emailItemSchema),
    include_overdue: z.boolean(),
    include_upcoming: z.boolean(),
    upcoming_days: requiredInt(
      upcomingDaysRange.min,
      upcomingDaysRange.max,
      `未来天数需在 ${upcomingDaysRange.min}..${upcomingDaysRange.max} 之间`,
    ),
    visible_columns: z.array(z.string()).min(1, '至少选择一列'),
    // 留空合法（= 用后端默认标题），超长才拒。
    subject_template: z.string().trim().max(200, '标题模板长度不能超过 200 个字符'),
    // 2026-10-16：发信邮箱。**刻意不拦空选** —— 「没选发信邮箱」是**合法保存**（用户可能
    // 只想先改收件人清单，拦成红字会强迫他先建一个邮箱才能干别的）。**理由不是「空选也能
    // 发」**：后端 `resolve_sender` 对 `sender_account_id IS NULL` 直接返 21701（503），
    // 全仓没有回落到默认邮箱的分支 ⇒ 空选的代价落在**真发信那一刻**，由页面顶部告警 +
    // 「立即发送」按钮禁用承担（见 `MailDigestSettings.vue` 的 `senderMissing` 与
    // `useMailDigestStore` 的 `sendDisabled`），而不是表单红字。
    // `el-select` 清空给出的是 `''`，归一成 null（= 未选）后才不会把空串塞上 wire。
    // ⚠️ 这里只做**归一**（issue 的 path 仍是 `sender_account_id`，与 `MailDigestFormField`
    // 的键名逐字一致，模板才读得到红字）。
    sender_account_id: z.preprocess(
      (v) => (v === '' || v === undefined ? null : v),
      z.string({ error: '请选择发信邮箱' }).trim().min(1, '请选择发信邮箱').nullable(),
    ),
  });

  return base.superRefine((v, ctx) => {
    const flags = frequencyFlags[v.frequency];
    if (!flags) return;
    const fail = (field: MailDigestFormField, message: string): void => {
      ctx.addIssue({ code: 'custom', path: [field], message });
    };
    if (flags.needs_time) {
      if (v.send_hour === null) fail('send_time', '请选择触发时刻（时:分）');
      if (v.send_minute === null) fail('send_time', '请选择触发时刻（时:分）');
    }
    if (flags.needs_weekday && v.weekday === null) {
      fail('weekday', '每周发送需指定星期几');
    }
    if (flags.needs_day_of_month && v.day_of_month === null) {
      fail('day_of_month', '每月发送需指定几号（1..28）');
    }
    // 配套字段「多填」也算非法。⚠️ 2026-10-14（review 第 1 轮 M-2）订正口径：
    // 后端**不是报 21704，而是清空 / 忽略** —— `validate_save_request` 在非专属频率下把
    // `weekday` / `day_of_month` 清成 NULL，`MANUAL_ONLY` 的时刻字段则是既不清空也不校验
    // （`validate_time` 在 `!needs_time` 时直接 Ok，原样存回）。前端比后端严本身没问题，
    // 但这三条 issue 的 `path` 指向的输入框在对应频率下**整行不渲染**（见
    // `MailScheduleSection.vue` 的 `v-if="flags.needs_*"`）⇒ 不可见的字段上挂红字等于
    // 把三条动作全拦死却零提示。故两道入口（store 的 `applyConfigToForm` 与 section 的
    // `onFrequencyChange`）都先按判据归一，这三条在这里只是**兜底**。
    if (!flags.needs_time && (v.send_hour !== null || v.send_minute !== null)) {
      fail('send_time', '仅手动发送不需要触发时刻');
    }
    if (!flags.needs_weekday && v.weekday !== null) {
      fail('weekday', '当前频率不使用星期设置');
    }
    if (!flags.needs_day_of_month && v.day_of_month !== null) {
      fail('day_of_month', '当前频率不使用每月几号设置');
    }
    // 「含未来 N 天」关掉时天数不再有意义；**不拦**（后端只把它当无效字段忽略），
    // 免得用户关了开关还要顺手清天数才能保存。
  });
}

/** 默认判据下的表单 schema（meta 未到达时用；到达后 store 改用带 meta 的那一份）。 */
export const mailDigestFormSchema = makeMailDigestFormSchema();

/** 表单态 → 校验器的输入（页面组件持有的是同一个对象，但校验前统一拷贝一次，
 *  免得 Zod 的 trim 变换就地改到 store 的态上）。 */
export type MailDigestFormInput = z.input<ReturnType<typeof makeMailDigestFormSchema>>;

/** 把 ZodIssue 列表按字段聚合到字段错误表；同字段多 issue 只取第一条
 *  （照 `views/users/usersSchema.ts` 的同款 helper）。 */
export function toMailDigestFieldErrors(
  issues: Array<{ path: PropertyKey[]; message: string }>,
): MailDigestFormFieldErrors {
  const out: MailDigestFormFieldErrors = {};
  for (const issue of issues) {
    const key = issue.path[0] as MailDigestFormField | undefined;
    if (key && !out[key]) out[key] = issue.message;
  }
  return out;
}
