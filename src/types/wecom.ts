// 企业微信推送域的 **入参** wire 类型（2026-10-17 新增）。
//
// ⚠️ **本文件只有入参，没有出参镜像**：本域六个 webhook 端点 + 五个 wecom-daily 端点的
// 出参 wire 契约的**唯一真源**是域内 schema —— `views/wecom/webhooks/weComWebhookSchema.ts`
// 的 `weComWebhookSchema` / `weComWebhookListSchema` 与
// `views/wecom/daily/weComDailySchema.ts` 的 `weComDailyConfigSchema`（含
// `weComDailyConfigDefaultsSchema` / `weComDailyFrequencyOptionSchema` /
// `weComDailyWorkerMetricOptionSchema`）/ `weComDailyMetaSchema` / `weComDailyPreviewSchema`
// / `weComDailyLogSchema` / `weComDailyLogListSchema`。消费侧一律用 `z.infer` 派生的
// `*Data` 类型（api 层 `import type` 标注返回类型、组件与 store 直接 import 域内路径）。
// 这里再抄一份手写 interface 就是同一份契约的第二个真源：schema 加字段时它不会报错，
// 只会静默腐烂。
//
// 沿 `src/types/mailDigest.ts` / `src/types/statistics.ts` 的同款取舍（那俩是本仓先例）。

/** 2026-10-17：4 个频率预设的**唯一真源**（后端 `Frequency` 枚举原文）。
 *  收成 const 数组而不是散落的联合类型字面量，是为了让 `z.enum()` 与 TS 类型同源
 *  （schema 在 `views/wecom/daily/weComDailySchema.ts` 引这个常量），避免两处各写一遍
 *  将来只改一处。⚠️ 这四个值与邮件域（`MAIL_DIGEST_FREQUENCIES`）**逐字相同但刻意不复用**：
 *  两个域的判据（配套字段是否必填）由各自的 `GET /meta` 下发，共用一个常量会让后端在
 *  一侧改语义时另一侧静默漂移。 */
export const WECOM_DAILY_FREQUENCIES = ['DAILY', 'WEEKLY', 'MONTHLY', 'MANUAL_ONLY'] as const;

export type WeComDailyFrequency = (typeof WECOM_DAILY_FREQUENCIES)[number];

/** 条形图指标口径：`QUANTITY` = 按件数（`█`/`░` 字符条按 quantity 归一）、
 *  `BATCH` = 按批次数。**取值域的后端真源是 `GET /meta` 的 `worker_metrics[]`**，
 *  这里只是入参侧的封闭集（照 mailDigest 域「枚举只守入参侧」的同款取舍）。
 *
 * ⚠️ **条形图由后端渲染成 markdown 字符条随消息下发，前端只展示文本** —— 全仓不引入
 * ECharts / 任何图表组件（CLAUDE.md「图表」一节那条禁令在此的具体落点）。 */
export type WeComDailyWorkerMetric = 'QUANTITY' | 'BATCH';

/** 触发来源（`LogRow.trigger_source`）：定时任务触发 vs 管理员手动点「立即发送」。 */
export type WeComDailyTriggerSource = 'SCHEDULED' | 'MANUAL';

/** 单次发送的结果状态。**失败也会落一条流水**（`POST /send` 抛错，但服务端已记账）——
 * 这条不变量是 store 的 `send` mutation 在 `onError` 里也失效日志的原因。 */
export type WeComDailySendStatus = 'SUCCESS' | 'FAILED';

// ============================================================
// webhook 域的入参
// ============================================================

/** `POST /cron/wecom/webhooks` 的请求体（新建）。
 *
 * ⚠️ `webhook_url` 必填（库里还没有这条通道）。
 *
 * ⚠️ **完整 webhook URL 是写入型 secret、永不回显**：列表 / 改档出参只给 `url_masked`
 * （掩码快照）。前端没有任何地方能拿到完整 URL，所以编辑弹窗**不预填**它、只显示掩码 +
 * 「留空则不修改」提示（见 `views/wecom/webhooks/WeComWebhookDialog.vue`）。 */
export interface CreateWeComWebhookPayload {
  /** 自定义名称（唯一，重复由后端 21807 拒）。 */
  name: string;
  /** 完整 webhook 地址。格式判据见后端 21803。 */
  webhook_url: string;
}

/** `POST /cron/wecom/webhooks/{id}` 的请求体（改档，**全量覆写**）。
 *
 * ⚠️ `version` **必填**（OCC 锚，取该行当前的 `version`；漏传是 axum 的 HTTP 422 纯文本，
 *   不是业务信封）。
 * ⚠️ `webhook_url` 留空串 ⇒ **沿用旧密文**（不是「清空」）。这是后端显式契约，必须让用户在
 *   编辑弹窗的 placeholder 里看得见。 */
export interface UpdateWeComWebhookPayload {
  version: number;
  name: string;
  webhook_url: string;
}

/** `POST /cron/wecom/webhooks/{id}/delete` 与 `.../set-default` 共用的请求体：
 * **只有 `version`**（OCC 锚，取目标行当前的 `version`）。两条端点都**无 `#[serde(default)]`**
 * ⇒ 发 `{}` 是 HTTP 422 纯文本、拿不到业务码、查表文案全部落空（本仓后端零
 * PUT/PATCH/DELETE，走 action 路径 ≠ 无 body）。 */
export interface WeComWebhookVersionPayload {
  version: number;
}

// ============================================================
// wecom-daily 域的入参
// ============================================================

/** `GET /cron/wecom-daily/logs` 的分页参数。 */
export interface ListWeComDailyLogsParams {
  limit?: number;
  offset?: number;
}

/** `POST /cron/wecom-daily/config` 的请求体。
 *
 * ⚠️ `version` **必填**（OCC 锚，取 `GET /config` 的 `version`；表里无行时后端返
 *   `version: 0` + `id: "0"`，那个 0 正是「首次创建」的合法锚）。
 * ⚠️ 本端点是 **POST 而不是 PUT** —— 本仓后端全站只允许 GET / POST 两种方法。
 */
export interface SaveWeComDailyConfigPayload {
  version: number;
  /** 定时总开关。false 时后端不注册调度，但仍可手动发送。 */
  enabled: boolean;
  frequency: WeComDailyFrequency;
  /** 触发时刻（小时 0..23）。MANUAL_ONLY ⇒ null。 */
  send_hour: number | null;
  /** 触发时刻（分钟 0..59）。MANUAL_ONLY ⇒ null。 */
  send_minute: number | null;
  /** WEEKLY 用，ISO 星期：1=周一 … 7=周日。其它频率 ⇒ null。 */
  weekday: number | null;
  /** MONTHLY 用，1..28（刻意封顶 28，避开短月）。其它频率 ⇒ null。 */
  day_of_month: number | null;
  /** 推送目标 webhook（`/cron/wecom/webhooks` 一行的雪花 id，JSON string）。null = 未选。
   *  **保存合法**（用户可能只想先调内容开关），但**发不出去**：后端对 null 直接返 21801
   *  ⇒ 页面顶部给告警、「立即发送」按钮给禁用，而**不拦保存**（照 mailDigest 域
   *  `sender_account_id` 的同款取舍）。 */
  webhook_id: string | null;
  /** 「N 日内交期」的天数。取值域由 `GET /meta` 的 `upcoming_days_range` 下发。 */
  upcoming_days: number;
  /** 2026-10-23 新增：第三节按交期日期分组列工单清单时，**每个分组最多列多少条**。
   *  取值域 `0..=200`，**`0` 表示不限**（与 `worker_top_n === 0` 同语义）。超出部分不逐条
   *  列出，只在组末出一行「另有 N 行未列出」脚注 —— **不静默截断**。装配件的子件与工单吃
   *  同一个额度。
   *  ⚠️ 这一段范围**不由 `GET /meta` 下发**（meta 只在 `defaults` 段多给了 `order_list_limit`
   *  与 `include_drawings` 两个键，没有对应的 `*_range`），所以取值域的真源是前端域内常量
   *  `weComDailySchema.ts::WECOM_DAILY_ORDER_LIST_LIMIT_RANGE`（表单校验与输入项 `:min/:max`
   *  共用同一份，不写死第二份字面量）。 */
  order_list_limit: number;
  /** 第四节条形图的指标口径。取值域由 `GET /meta` 的 `worker_metrics[]` 下发。 */
  worker_metric: WeComDailyWorkerMetric;
  /** 第四节最多列多少个工人。0 = 不限。范围由 `GET /meta` 的 `worker_top_n_range` 下发。 */
  worker_top_n: number;
  /** 一次触发最多发几条（企业微信官方限频 20 条/分钟）。范围由 `max_chunks_range` 下发。 */
  max_chunks: number;
  /** 节开关一：全厂报工总览。 */
  include_overview: boolean;
  /** 节开关二：本期出货单数。 */
  include_delivery: boolean;
  /** 节开关三：逾期未交工单 + N 日内交期工单。 */
  include_orders: boolean;
  /** 2026-10-23 新增：第三节的工单行上是否挂图纸预览链接（缺省 true）。为 false 时**不触发
   *  任何图片转码**，日报只出纯文字清单（第三节行数多、群里刷屏时可关）。 */
  include_drawings: boolean;
  /** 节开关四：所有工人本期报工统计（条形字符图）。 */
  include_workers: boolean;
  /** 标题模板；null = 用后端默认标题（页面留空即 null）。 */
  subject_template: string | null;
}

/** `POST /cron/wecom-daily/preview` 与 `POST /cron/wecom-daily/send` 共用的请求体。
 *
 * = 配置部分（**不含 `version`** —— 这两条端点不写配置、只渲染 / 真发，允许「用当前已保存
 * 配置」也允许「按当前表单未保存的内容试跑」）。全部键可选：空体 `{}` = 完全用服务端当前
 * 配置。 */
export type WeComDailyRunPayload = Partial<Omit<SaveWeComDailyConfigPayload, 'version'>>;
