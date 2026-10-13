// 交期汇总邮件域的 **入参** wire 类型（2026-10-13 新增）。
//
// ⚠️ **本文件只有入参，没有出参镜像**：六个端点的出参 wire 契约的**唯一真源**是
// `src/views/mail/digest/mailDigestSchema.ts` 的 `mailDigestConfigSchema` /
// `mailDigestMetaSchema` / `mailDigestPreviewSchema` / `mailDigestSendResultSchema` /
// `mailDigestLogListSchema`，消费侧一律用 `z.infer` 派生的 `*Data` 类型（api 层
// `import type` 标注返回类型、组件与 store 直接 import 域内路径）。这里再抄一份手写
// interface 就是同一份契约的第二个真源：schema 加字段时它不会报错，只会静默腐烂。
//
// 沿 `src/types/statistics.ts` 的同款取舍（那是本仓第一个只放入参的 types 文件）。

/** 2026-10-13：4 个频率预设的**唯一真源**（后端 `Frequency` 枚举原文）。
 *  刻意**没有**「每隔 N 小时」——产品决策只有这 4 档。
 *  收成 const 数组而不是散落的联合类型字面量，是为了让 `z.enum()` 与 TS 类型同源
 *  （schema 在 `views/mail/digest/mailDigestSchema.ts` 引这个常量），避免两处各写一遍
 *  将来只改一处。 */
export const MAIL_DIGEST_FREQUENCIES = ['DAILY', 'WEEKLY', 'MONTHLY', 'MANUAL_ONLY'] as const;

export type MailDigestFrequency = (typeof MAIL_DIGEST_FREQUENCIES)[number];

/** 邮件触发来源（`LogItem.trigger_source`）：定时任务触发 vs 管理员手动触发。 */
export type MailDigestTriggerSource = 'SCHEDULED' | 'MANUAL';

/** 单次发送的结果状态。失败也会落一条日志行（`POST /send` 抛错，但服务端已记账）。 */
export type MailDigestSendStatus = 'SUCCESS' | 'FAILED';

/** GET /mail-digest/logs 的分页参数。 */
export interface ListMailDigestLogsParams {
  limit?: number;
  offset?: number;
}

/** POST /mail-digest/config 的请求体。
 *
 * ⚠️ `version` **必填**（OCC 锚，取 `GET /config` 的 `version`；表里无行时后端返
 * `version: 0` + `id: "0"`，那个 0 正是「首次创建」的合法锚）。漏传是 axum 的 HTTP
 * 422 纯文本（不是业务信封），不要用「读-再-比」式隐式 OCC 代替。
 *
 * ⚠️ 本端点是 **POST 而不是 PUT** —— 本仓后端全站只允许 GET / POST 两种方法。
 */
export interface SaveMailDigestConfigPayload {
  version: number;
  enabled: boolean;
  frequency: MailDigestFrequency;
  /** 触发时刻（小时 0..23）。MANUAL_ONLY 时必须为 null。 */
  send_hour: number | null;
  /** 触发时刻（分钟 0..59）。MANUAL_ONLY 时必须为 null。 */
  send_minute: number | null;
  /** WEEKLY 用，ISO 星期：1=周一 … 7=周日。其它频率必须为 null。 */
  weekday: number | null;
  /** MONTHLY 用，1..28（刻意封顶 28，避开短月）。其它频率必须为 null。 */
  day_of_month: number | null;
  /** 收件人（TO）。至少 1 项。 */
  recipients: string[];
  /** 抄送（CC）。可空数组。 */
  cc_recipients: string[];
  include_overdue: boolean;
  include_upcoming: boolean;
  upcoming_days: number;
  /** 表格列白名单，取值域来自 `GET /meta` 的 `columns[].key`。至少 1 项。 */
  visible_columns: string[];
  /** 标题模板；null = 用后端默认标题（页面留空即 null）。 */
  subject_template: string | null;
  /** 2026-10-16 新增：发信邮箱 id（`/api/v2/mail/accounts` 一行的雪花 id，JSON string）。
   *  null = 未选。**保存合法**（用户可能只想先改收件人清单），但**发不出去**：后端
   *  `resolve_sender` 对 null 直接返 21701（503），没有回落默认邮箱的分支。所以页面顶部
   *  给告警、「立即发送」按钮给禁用，而**不拦保存**。 */
  sender_account_id: string | null;
}

/** POST /mail-digest/preview 与 POST /mail-digest/send 共用的请求体。
 *
 * = 配置部分（**不含 `version`** —— 这两条端点不写配置、只渲染 / 真发，允许「用当前
 * 已保存配置」也允许「按当前表单未保存的内容试跑」）。全部键可选：空体 `{}` = 完全用
 * 服务端当前配置。 */
export type MailDigestRunPayload = Partial<Omit<SaveMailDigestConfigPayload, 'version'>>;
