// src/views/wecom/webhooks/weComWebhookSchema.ts
//
// 2026-10-17 新建：企业微信 **webhook 通道**域的 Zod schema，与两个 query hook 同居
// （CLAUDE.md「域 schema 与 query hook 同居」），两组用途（形态照
// `views/mail/accounts/mailAccountSchema.ts`）：
//
//   1. **守门**：`weComWebhookSchema`（一行 `WebhookOut`）/ `weComWebhookListSchema`
//      （`GET /cron/wecom/webhooks` 的信封 `{items: [...]}`）。一条读端点的守门点在
//      queryFn（`composables/useWeComWebhooksQuery.ts`）；四条写端点（建档 / 改档 / 软删 /
//      置默认）与测连通走 useMutation、**没有 queryFn 承载** ⇒ 守门留在 api 层
//      （`api/wecomWebhooks.ts`，CLAUDE.md 为这类调用留的口子）。
//   2. **表单校验**：`makeWeComWebhookFormSchema(mode)` —— 新增 / 编辑弹窗的前置校验，把
//      后端 21803（地址格式）/ 21807（名称重复）等拒绝提前到浏览器，并给出**聚焦到具体字段**
//      的提示。
//
// wire 序列化约定：
//   - **雪花 ID 一律 JSON string**：`id` 是 `z.string()`，禁 `z.number()`（19 位 ID 在 JS
//     Number 下丢精度）。
//   - **版本号与计数一律 JSON number**：`version`（OCC 锚，不是 ID）。
//   - ⚠️ **出参里没有、也永远不会有完整 webhook URL**：后端只在出参给 `url_masked`
//     （掩码快照，如 `…key=693a***faaa`）。前端没有任何「回显完整地址」的路径 ⇒ 编辑弹窗
//     只能显示掩码 + 「留空则不修改」。这条不变量就是「响亮地失败」换来的：schema 是
//     `.strict()`，将来哪天后端不小心把 `webhook_url` 带出来，`parse` 会**当场抛**
//     （响亮的失败 + 控制台原始 issues），而不是被 Zod 默认的 strip 静默吞掉、悄悄进到某个
//     组件的 props 里。
//
// ⚠️ **`.strict()` 的取舍**：信封 / 行层一律 `.strict()`，与 mail 域 / users 域同款 ——
// 后端给本域加派生字段时会被这里挡住、需要显式决策，而不是被 strip 静默吞掉。

import { z } from 'zod';

// ============================================================
// GET /api/v2/cron/wecom/webhooks
// ============================================================

/** 单条 webhook 通道（后端 `WebhookOut`，**7 个字段逐字对齐**）。
 *
 *  ⚠️ **7 个键一个都不能少**：`.strict()` 对「后端多发的键」当场抛，而这条 schema 同时是
 *  建档 / 改档 / 置默认三个写端点的守门点（api 层直接 `parse` —— 它们走 useMutation、没有
 *  queryFn 承载）。那里抛错的后果特别贵：后端**已经把那一行落库成功了**才返响应，前端
 *  解析失败 ⇒ 弹「新建失败」⇒ 用户重试 ⇒ 撞 21807「名称重复」。 */
export const weComWebhookSchema = z
  .object({
    /** 通道行 id（雪花 ID ⇒ JSON string）。**不要**用 `z.number()`。 */
    id: z.string(),
    /** OCC 锚。改档 / 软删 / 置默认三条端点**都必填**（缺省是 axum 的 422 纯文本）。 */
    version: z.number(),
    /** 自定义名称（列表与每日总结的 webhook 选择器都展示它）。必填且唯一。 */
    name: z.string(),
    /** 掩码后的 webhook 地址快照。⚠️ **完整地址永不回显**（见文件头）。 */
    url_masked: z.string(),
    /** 是否带「默认」标记（`POST /{id}/set-default` 只能有一条为 true，唯一索引保证）。
     *
     * ⚠️ **它不决定推送**：每日总结推哪条由 `wecom_daily_config.webhook_id` 决定，后端
     * **从不**回落到本字段（与 mail 域 `is_default` 的处境同款）。所以它既不 gate 任何写
     * 操作、也不进任何请求体，只影响列表排序。 */
    is_default: z.boolean(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .strict();

export type WeComWebhookData = z.infer<typeof weComWebhookSchema>;

/** `GET /cron/wecom/webhooks` 的出参（后端 `WebhookListOut`）：`{ items: WebhookOut[] }`。
 *
 *  ⚠️ **是信封对象、不是裸数组**（后端 `R<WebhookListOut>` 的 `data` 就是它）：把它写成
 *  `z.array(...)` 时 queryFn 会在**每一屏**抛 ZodError ⇒ 列表恒空、而两条 warning 都不弹
 *  （用户只看到一张空白表，没有任何报错线索）。`staleTime` 未到时重取命中的也是这条路径，
 *  所以症状是「页面一直是空的」，不是「偶尔闪一下」。 */
export const weComWebhookListSchema = z
  .object({
    items: z.array(weComWebhookSchema),
  })
  .strict();

export type WeComWebhookListData = z.infer<typeof weComWebhookListSchema>;

// ============================================================
// 表单 schema（新增 / 编辑弹窗）
// ============================================================

/** 表单模式：新建（地址必填）/ 改档（地址留空 = 不改）。 */
export type WeComWebhookFormMode = 'create' | 'edit';

/** 长度上限，**与后端 `validate_*` 的常量 1:1**（`.chars().count()` 口径，不是字节数；改了
 * 这里必须同步改后端，否则用户在浏览器过了、后端 21804 拒）。
 *
 * ⚠️ 这两个常量同时是 `WeComWebhookDialog.vue` 两个输入框 `maxlength` 的**唯一绑定源** ——
 * 模板里再抄一遍字面量就成了第二真源。 */
export const WECOM_WEBHOOK_NAME_MAX = 50;
export const WECOM_WEBHOOK_URL_MAX = 500;

/** 企业微信群机器人的 webhook 地址格式（对齐后端 21803 的判据）。
 *
 * 只做**形态**校验、刻意不比后端更宽：企业微信官方群机器人地址恒为
 * `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=<uuid>`。前端拦一道能在提交前就说清，
 * 最终判据仍在后端（多拦会误伤将来可能出现的其它入口地址）。
 *
 * ⚠️ 额外拦**控制字符**（`\r\n` 等）：那是 HTTP 头注入的原料，后端也会拒，但前端拦一道能在
 * 保存前就地标红，而它在提交后只表现为一条 21803。 */
const WECOM_WEBHOOK_URL_RE = /^https:\/\/qyapi\.weixin\.qq\.com\/cgi-bin\/webhook\/send\?key=\S+$/;

/** 格式判据的提示文案。**只留一处**：它是 21803 的前端版，两处各抄一遍就会漂。 */
export const WECOM_WEBHOOK_URL_FORMAT_HINT =
  '地址格式不正确，应为 https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…';

export interface WeComWebhookFormModel {
  name: string;
  /** 完整 webhook 地址。**编辑态恒为空串**（地址不出参 ⇒ 无从回显），提交时落到后端的
   *  「沿用旧密文」分支。 */
  webhook_url: string;
}

export type WeComWebhookFormField = 'name' | 'webhook_url';

export type WeComWebhookFormFieldErrors = Partial<Record<WeComWebhookFormField, string>>;

/**
 * 构造弹窗表单的校验 schema。
 *
 * @param mode `'create'` ⇒ `webhook_url` 必填（库里还没有这条通道）；`'edit'` ⇒ **允许留空**，
 *   留空在 wire 上是**空串**，后端语义是「本次不改地址」。这两种语义必须在 UI 上分开：编辑
 *   弹窗只显示 `url_masked` + placeholder「留空表示不修改」，列表页**永远**只显示掩码。
 */
export function makeWeComWebhookFormSchema(mode: WeComWebhookFormMode) {
  const urlShape = z
    .string()
    .trim()
    .max(WECOM_WEBHOOK_URL_MAX, `地址长度不能超过 ${WECOM_WEBHOOK_URL_MAX} 个字符`)
    .refine((v) => !/[\u0000-\u001f\u007f-\u009f]/.test(v), '地址不能包含控制字符');

  return z.object({
    name: z
      .string()
      .trim()
      .min(1, '请填写名称')
      .max(WECOM_WEBHOOK_NAME_MAX, `名称长度不能超过 ${WECOM_WEBHOOK_NAME_MAX} 个字符`),
    // 链式顺序 **trim 在前**（CLAUDE.md 表单 schema 的纪律）：el-input 前后空格必须在
    // 长度校验与格式校验之前归一，否则「 https://… 」会因为首字符是空格而格式判红。
    // `el-input` 的 v-model 恒为字符串，这里的 preprocess 只兜住 null/undefined（防御性，
    // 生产上不可达 —— 别当成死代码清掉，见 useMailAccountsStore.spec.ts 的同款纪律）。
    webhook_url: z.preprocess(
      (v) => (v === null || v === undefined ? '' : String(v)),
      mode === 'create'
        ? urlShape
            .min(1, '请填写 webhook 地址')
            .refine((v) => WECOM_WEBHOOK_URL_RE.test(v), WECOM_WEBHOOK_URL_FORMAT_HINT)
        : // 编辑态允许空串（= 不改），但**拒绝**「有内容却不合法」：填了半截地址就保存会拿
          // 旧的密文、而用户以为改成功了。
          urlShape.refine(
            (v) => v === '' || WECOM_WEBHOOK_URL_RE.test(v),
            WECOM_WEBHOOK_URL_FORMAT_HINT,
          ),
    ),
  });
}

/** 把 ZodIssue 列表按字段聚合到字段错误表；同字段多 issue 只取第一条
 *  （照 `views/mail/accounts/mailAccountSchema.ts::toMailAccountFieldErrors` 的同款 helper）。 */
export function toWeComWebhookFieldErrors(
  issues: Array<{ path: PropertyKey[]; message: string }>,
): WeComWebhookFormFieldErrors {
  const out: WeComWebhookFormFieldErrors = {};
  for (const issue of issues) {
    const key = issue.path[0] as WeComWebhookFormField | undefined;
    if (key && !out[key]) out[key] = issue.message;
  }
  return out;
}
