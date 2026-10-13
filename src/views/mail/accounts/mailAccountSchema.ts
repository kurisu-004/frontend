// src/views/mail/accounts/mailAccountSchema.ts
//
// 2026-10-16 新建：定时任务 → 邮件域的**邮箱账号** Zod schema，与两个 query hook 同居
// （CLAUDE.md「域 schema 与 query hook 同居」），两组用途（形态照
// `views/mail/digest/mailDigestSchema.ts`）：
//
//   1. **守门**：`mailAccountSchema`（`AccountOut`）/ `mailMetaSchema`（`GET /mail/meta`）。
//      两条读端点的守门点在 queryFn（`composables/useMailAccountsQuery.ts`）；四条写端点
//      （建档 / 改档 / 删除 / 设为默认）走 useMutation、**没有 queryFn 承载** ⇒ 守门留在
//      api 层（CLAUDE.md 为「没有 queryFn 承载的调用」留的口子，同 `api/inspection.ts`
//      的扫码树、`api/mailDigest.ts` 的 preview / send）。
//   2. **表单校验**：`makeMailAccountFormSchema(mode)` —— 新增 / 编辑弹窗的前置校验，把
//      后端 21707（名称重复）等拒绝提前到浏览器，并给出**聚焦到具体字段**的提示。
//
// 三条 wire 序列化约定（与 mailDigest 域同款）：
//   - **雪花 ID 一律 JSON string**：`id` / `sender_account_id` 是 `z.string()`，禁
//     `z.number()`（19 位 ID 在 JS Number 下丢精度）。
//   - **计数 / 版本号一律 JSON number**：`version`（OCC 锚，不是 ID）。
//   - **SMTP 预设枚举**：`preset` 收 `NET_EASE_163` / `TENCENT_QQ`。⚠️ 这里**只**声明
//     wire 上的取值域，**不在前端存 host / port / tls_mode 的映射** —— 那三值由
//     `GET /mail/meta` 下发（见 `mailMetaSchema`）。前端另存一份就是这个域的第二真源：
//     后端加一家邮箱服务时它不会报错，只会静默少一个选项。
//
// ⚠️ **`.strict()` 的取舍**：`mailAccountSchema` / `mailMetaSchema` 一律 `.strict()`，与
// mailDigest 域同款 —— 后端给本域加字段时会被这里挡住、需要显式决策，而不是被 Zod 默认
// 的 strip 静默吞掉（吞掉后前端「照样通过校验」，那一列整列失效且无人发现）。

import { z } from 'zod';

// ============================================================
// 原子
// ============================================================

/** SMTP 服务商预设（后端 `MailAccountPreset` 枚举原文）。
 *
 *  枚举的**取值域**在前端（schema 要守它），**成员清单**在后端（`GET /mail/meta` 的
 *  `presets[].value`）—— 两者不一致时以后端下发的为准：下拉选项由 `/mail/meta` 驱动，
 *  前端这两个字面量只保证「响应的 preset 值能被识别、不被 strip 掉」。 */
export const mailAccountPresetSchema = z.enum(['NET_EASE_163', 'TENCENT_QQ']);

export type MailAccountPresetData = z.infer<typeof mailAccountPresetSchema>;

// ============================================================
// GET /api/v2/mail/accounts
// ============================================================

/** 单个邮箱账号（后端 `MailAccountOut`）。
 *
 *  ⚠️ **刻意不声明 `encrypted_secret`**：授权码在**入库前**由后端加密，出参**绝不**带回
 *  明文、掩码、或任何可推导的派生值（连长度都不给）。所以这里没有这个键，且本 schema 是
 *  `.strict()` —— 将来的哪天后端不小心把它带出来，`parse` 会**当场抛 ZodError**（响亮的
 *  失败，页面弹一条「数据格式不符合预期」，控制台留下原始 issues），而不是被 Zod 默认的
 *  strip 静默吞掉、静默进到某个组件的 props 里。**这条不变量就是「响亮地失败」换来的。**
 *  守卫见 `__tests__/mailAccountSchema.spec.ts` 的「多一个键即抛」一组。 */
export const mailAccountSchema = z
  .object({
    /** 账号行 id（雪花 ID ⇒ JSON string）。**不要**用 `z.number()`。 */
    id: z.string(),
    /** OCC 锚，`POST /accounts/{id}` 必填。 */
    version: z.number(),
    /** 自定义名称（管理员给这条邮箱起的名字，列表与选择器都展示它）。
     *  必填且唯一（重复由后端 21707 拒）。 */
    name: z.string(),
    /** SMTP 服务商预设：决定 host / port / tls_mode（由 `GET /mail/meta` 下发，
     *  前端不存映射）。 */
    preset: mailAccountPresetSchema,
    /** 登录账号（163 是邮箱地址本身、QQ 是 QQ 号）。 */
    account: z.string(),
    /** 是否为默认发信邮箱（`POST /accounts/{id}/set-default` 只能有一条为 true）。 */
    is_default: z.boolean(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .strict();

export type MailAccountData = z.infer<typeof mailAccountSchema>;

/** `GET /mail/accounts` 的出参：一次性返全部（**无分页信封**）—— 邮箱数量是两位数级别，
 *  与仓内 `GET /iam/roles` / `GET /statistics/workers` 同款，不引入 limit / offset。
 *  ⚠️ 数组层**不加** `.strict()`（`ZodArray` 没有这个方法）：逐元素的对象层已经是
 *  `.strict()`，元素上多一个键照样逐条抛。 */
export const mailAccountListSchema = z.array(mailAccountSchema);

export type MailAccountListData = z.infer<typeof mailAccountListSchema>;

// ============================================================
// GET /api/v2/mail/meta
// ============================================================

/** 预设选项（`GET /mail/meta` 的 `presets[]` 一项）。
 *
 *  host / port / tls_mode 三件套**由后端下发**，弹窗据此渲染一条只读描述行。写成前端常量
 *  的话，后端改端口（465 → 587）或加一家服务商时就多一份会静默漂移的真源。 */
export const mailPresetOptionSchema = z
  .object({
    value: mailAccountPresetSchema,
    label: z.string(),
    host: z.string(),
    port: z.number(),
    /** TLS 模式（当前两家都是 `WRAPPED`）。前端只展示、不据此分支 —— 真发信在后端。 */
    tls_mode: z.string(),
  })
  .strict();

export type MailPresetOptionData = z.infer<typeof mailPresetOptionSchema>;

export const mailMetaSchema = z
  .object({
    presets: z.array(mailPresetOptionSchema),
  })
  .strict();

export type MailMetaData = z.infer<typeof mailMetaSchema>;

// ============================================================
// POST /api/v2/mail/accounts/{id}/delete
// ============================================================

/** 删除结果。后端把 `deleted` 恒置 true，**失败不返 200**（21708 被引用时抛错）——
 *  所以这个 `true` 不是断言，是「后端确实走了成功分支」的回执。 */
export const mailAccountDeleteResultSchema = z
  .object({
    deleted: z.boolean(),
  })
  .strict();

export type MailAccountDeleteResultData = z.infer<typeof mailAccountDeleteResultSchema>;

// ============================================================
// 表单 schema（新增 / 编辑弹窗）
// ============================================================

/** 表单模式：建档（secret 必填）/ 改档（secret 留空 = 不改）。 */
export type MailAccountFormMode = 'create' | 'edit';

/** 长度上限，与后端同口径。**刻意写死**：这两条不是「后端下发的范围」类判据（那是
 *  `/mail/meta` 的 `upcoming_days_range` 那种），而是与数据库列宽 1:1 的常量；把它做成
 *  下发字段只会给后端添一条「忘了更新上限」的路径。 */
export const MAIL_ACCOUNT_NAME_MAX = 64;
export const MAIL_ACCOUNT_ACCOUNT_MAX = 128;
export const MAIL_ACCOUNT_SECRET_MAX = 128;

/** 授权码的格式判据：刻意**只**拦换行与首尾空白，不校验具体长度 / 字符集。
 *  各家邮箱的授权码形态各不相同（163 是 16 位字母数字、QQ 是 16 位带横线），前端按某一
 *  家的规则写死 regex 就会在录入另一家时给出「格式不正确」而实际值是对的 —— 最终判据在
 *  后端（真发信时才验），前端只拦「明显打错了」的形态。 */
const MAIL_ACCOUNT_SECRET_REJECT = /[\r\n]/;

export interface MailAccountFormModel {
  name: string;
  preset: MailAccountPresetData;
  account: string;
  secret: string;
}

export type MailAccountFormField = 'name' | 'preset' | 'account' | 'secret';

export type MailAccountFormFieldErrors = Partial<Record<MailAccountFormField, string>>;

/**
 * 构造弹窗表单的校验 schema。
 *
 * @param mode `'create'` ⇒ `secret` 必填（库里还没有授权码）；`'edit'` ⇒ **允许留空**，
 *   留空在 wire 上是**空串**，后端语义是「本次不改授权码」（`POST /accounts/{id}` 的
 *   显式契约，不是「清空」）。这两种语义必须在 UI 上分开：编辑弹窗的 placeholder 写
 *   「留空表示不修改」，且列表页**永远**只显示「已配置」、不显示任何派生值。
 */
export function makeMailAccountFormSchema(mode: MailAccountFormMode) {
  const base = z.object({
    name: z
      .string()
      .trim()
      .min(1, '请填写名称')
      .max(MAIL_ACCOUNT_NAME_MAX, `名称长度不能超过 ${MAIL_ACCOUNT_NAME_MAX} 个字符`),
    preset: mailAccountPresetSchema,
    account: z
      .string()
      .trim()
      .min(1, '请填写登录账号')
      .max(MAIL_ACCOUNT_ACCOUNT_MAX, `登录账号长度不能超过 ${MAIL_ACCOUNT_ACCOUNT_MAX} 个字符`)
      .refine((v) => !/[\r\n]/.test(v), '登录账号不能包含换行'),
    secret: z
      .string()
      .trim()
      .max(MAIL_ACCOUNT_SECRET_MAX, `授权码长度不能超过 ${MAIL_ACCOUNT_SECRET_MAX} 个字符`)
      .refine((v) => !MAIL_ACCOUNT_SECRET_REJECT.test(v), '授权码不能包含换行'),
  });

  if (mode === 'create') {
    return base.refine((v) => v.secret.length > 0, {
      // `path: ['secret']` 让红字落到授权码那一项，而不是笼统挂在整份表单上。
      path: ['secret'],
      message: '请填写授权码',
    });
  }
  return base;
}

/** 把 ZodIssue 列表按字段聚合到字段错误表；同字段多 issue 只取第一条
 *  （照 `views/mail/digest/mailDigestSchema.ts::toMailDigestFieldErrors` 的同款 helper）。 */
export function toMailAccountFieldErrors(
  issues: Array<{ path: PropertyKey[]; message: string }>,
): MailAccountFormFieldErrors {
  const out: MailAccountFormFieldErrors = {};
  for (const issue of issues) {
    const key = issue.path[0] as MailAccountFormField | undefined;
    if (key && !out[key]) out[key] = issue.message;
  }
  return out;
}
