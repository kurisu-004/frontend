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
//   - **SMTP 预设**：**出参一律 `z.string()`、不守枚举**（见 `mailAccountSchema.preset`
//     的 doc）；封闭的枚举只留在**入参**侧（`makeMailAccountFormSchema`）。
//   - **host / port / tls_mode 是出参里的三个键**，值**由后端按预设推导**（不存 DB）。
//     前端**不在这里另存一份映射** —— 那三值由 `GET /mail/meta` 下发（见 `mailMetaSchema`）。
//     前端另存一份就是这个域的第二真源：后端加一家邮箱服务时它不会报错，只会静默少一个
//     选项。
//
// ⚠️ **`.strict()` 的取舍**：`mailAccountSchema` / `mailMetaSchema` 一律 `.strict()`，与
// mailDigest 域同款 —— 后端给本域加字段时会被这里挡住、需要显式决策，而不是被 Zod 默认
// 的 strip 静默吞掉（吞掉后前端「照样通过校验」，那一列整列失效且无人发现）。

import { z } from 'zod';

// ============================================================
// 原子
// ============================================================

/** 用户可选的 SMTP 服务商预设封闭集（后端 `MailAccountPreset::ALL` 的字面量）。
 *
 *  ⚠️ **只守「入参」这一个方向**：用户在弹窗里能选的封闭集就是这两项，所以建档 / 改档的
 *  请求体按它校验。**出参方向刻意不用它**（`mailAccountSchema.preset` 是 `z.string()`）——
 *  后端 `MailAccountOut::from_row` 对「库里存了未知 preset 字面量」是**刻意降级而不丢行**
 *  的（`preset` 原样回显、`preset_label` / `host` / `tls_mode` 退化为空串、`port` 为 0），
 *  出参拿枚举守它就会把「一行脏数据 / 后端先加一家」放大成**整个列表 parse 抛、页面空白**
 *  —— 恰好是后端那段降级设计要避免的「以为邮箱全没了」。取值域由 `/mail/meta` 下发的选项集
 *  在**使用点**校验，不在出参边界。
 *
 *  字面量只出现在这一处：`mailAccountPresetSchema` 由它构造，别处不重抄。 */
export const MAIL_ACCOUNT_PRESET_VALUES = ['NET_EASE_163', 'TENCENT_QQ'] as const;

export const mailAccountPresetSchema = z.enum(MAIL_ACCOUNT_PRESET_VALUES, {
  // ⚠️ 出参侧放行未知 preset 之后，「编辑一条 preset 已不认识的邮箱」会把那个字面量带进
  // 表单，这条红字必须是人话（回下拉重选一家），不能是 zod 的英文默认消息。
  error: '请选择邮箱服务商',
});

export type MailAccountPresetData = z.infer<typeof mailAccountPresetSchema>;

// ============================================================
// GET /api/v2/mail/accounts
// ============================================================

/** 单个邮箱账号（后端 `MailAccountOut`，**12 个字段逐字对齐**）。
 *
 *  ⚠️ **刻意不声明 `encrypted_secret`**：授权码在**入库前**由后端加密，出参**绝不**带回
 *  明文、掩码、或任何可推导的派生值（连长度都不给）。所以这里没有这个键，且本 schema 是
 *  `.strict()` —— 将来的哪天后端不小心把它带出来，`parse` 会**当场抛 ZodError**（响亮的
 *  失败，页面弹一条「数据格式不符合预期」，控制台留下原始 issues），而不是被 Zod 默认的
 *  strip 静默吞掉、静默进到某个组件的 props 里。**这条不变量就是「响亮地失败」换来的。**
 *  守卫见 `__tests__/mailAccountSchema.spec.ts` 的「多一个键即抛」一组。
 *
 *  ⚠️ **12 个键一个都不能少**：`.strict()` 对「多出来的键」抛，对「少声明的键」同样抛 ——
 *  后端加了 `preset_label` / `host` / `port` / `tls_mode` 而这里没跟上时，建档 / 改档 /
 *  设为默认三个写端点**每次成功都会抛**（mutation 进 `onError` 弹「格式不符合预期」，
 *  而后端已落库成功）⇒ 用户看到失败、库里多了一条，重试再撞 21707。 */
export const mailAccountSchema = z
  .object({
    /** 账号行 id（雪花 ID ⇒ JSON string）。**不要**用 `z.number()`。 */
    id: z.string(),
    /** OCC 锚。四条写端点里改档 / 删除 / 设为默认三条**都必填**（缺省是 axum 的 422）。 */
    version: z.number(),
    /** 自定义名称（管理员给这条邮箱起的名字，列表与选择器都展示它）。
     *  必填且唯一（重复由后端 21707 拒）。⚠️ 它同时是**发件人显示名**。 */
    name: z.string(),
    /** SMTP 服务商预设字面量。⚠️ **守形状不守取值域**（理由见 `mailAccountPresetSchema`
     *  的 doc：后端对未知字面量是刻意降级，整页崩掉正是它要避免的）。 */
    preset: z.string(),
    /** 预设中文标签，**由后端下发**（前端不必另存映射）。⚠️ 库里有未知 preset 时后端给
     *  **空串**，所以这里**不能** `.min(1)` —— 列表页的展示位（`MailAccountsTab.vue` 的
     *  「预设」列）取 `preset_label || preset` 降级。 */
    preset_label: z.string(),
    /** SMTP 登录账号（163 / QQ 都是完整邮箱地址）。同时是发件人地址。 */
    account: z.string(),
    /** SMTP 主机名（由预设推导，后端不下发映射表里的 host 常量）。
     *  ⚠️ 未知 preset 时后端给**空串**，故不能 `.min(1)`。 */
    host: z.string(),
    /** SMTP 端口（由预设推导，两家都 465）。⚠️ 未知 preset 时后端给 **`0`**。 */
    port: z.number(),
    /** TLS 模式（由预设推导，`WRAPPED` / `STARTTLS` / `NONE`）。未知 preset 时为空串。 */
    tls_mode: z.string(),
    /** 是否带「默认」标记（`POST /accounts/{id}/set-default` 只能有一条为 true，唯一索引保证）。
     *
     *  ⚠️ **它不决定发信**：后端对这一列的全部消费只有列表排序（`ORDER BY is_default DESC`）
     *  与那条唯一索引；发信走 `mail_digest_config.sender_account_id` →
     *  `mail_digest::service::resolve_sender`，后者**从不**回落到本字段。 */
    is_default: z.boolean(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .strict();

export type MailAccountData = z.infer<typeof mailAccountSchema>;

/** `GET /mail/accounts` 的出参（后端 `MailAccountListOut`）：`{ items: MailAccountOut[] }`。
 *
 *  ⚠️ **是信封对象、不是裸数组**（后端 `R<MailAccountListOut>` 的 `data` 就是它）：
 *  把它写成 `z.array(...)` 时 queryFn 会在**每一屏**抛 ZodError ⇒ 列表恒空、而两条 warning
 *  都不弹（用户只看到一张空白表，没有任何报错线索）。`staleTime` 未到时重取命中的也是这条
 *  路径，所以症状是「页面一直是空的」，不是「偶尔闪一下」。
 *
 *  `.strict()` 的理由与元素层同款：信封多一个键（如后端将来加 `total`）必须当场决策，
 *  而不是被 strip 静默吞掉。 */
export const mailAccountListSchema = z
  .object({
    items: z.array(mailAccountSchema),
  })
  .strict();

export type MailAccountListData = z.infer<typeof mailAccountListSchema>;

// ============================================================
// GET /api/v2/mail/meta
// ============================================================

/** 预设选项（`GET /mail/meta` 的 `presets[]` 一项）。
 *
 *  host / port / tls_mode 三件套**由后端下发**，弹窗据此渲染一条只读描述行。写成前端常量
 *  的话，后端改端口（465 → 587）或加一家服务商时就多一份会静默漂移的真源。
 *
 *  ⚠️ `value` 与 `mailAccountSchema.preset` 同口径取 `z.string()`：这一层是**下拉选项源**，
 *  它下发的每一项都会被用户选中并原样提交给写端点，而写端点才是校验枚举的地方。 */
export const mailPresetOptionSchema = z
  .object({
    value: z.string(),
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
// 表单 schema（新增 / 编辑弹窗）
// ============================================================

/** 表单模式：建档（secret 必填）/ 改档（secret 留空 = 不改）。 */
export type MailAccountFormMode = 'create' | 'edit';

/** 长度上限，**与后端 `service.rs` 的三个 validate_* 逐字同口径**（`.chars().count()`
 *  口径，不是字节数；改了这里必须同步改后端，否则用户在浏览器过了、后端 21704 拒）。
 *
 *  刻意写死：这三个不是「后端下发的范围」类判据（那是 `/mail/meta` 的
 *  `upcoming_days_range` 那种），而是与数据库列宽 / 后端校验常量 1:1 的定值；做成下发字段
 *  只会给后端添一条「忘了更新上限」的路径。
 *
 *  ⚠️ 这三个常量同时是 `MailAccountDialog.vue` 三个输入框 `maxlength` 的**唯一绑定源** ——
 *  模板里再抄一遍字面量就成了第二真源，改常量时界面拦不住、用户能敲够字符再吃一个 21704。 */
export const MAIL_ACCOUNT_NAME_MAX = 50;
export const MAIL_ACCOUNT_ACCOUNT_MAX = 120;
export const MAIL_ACCOUNT_SECRET_MAX = 200;

/** 授权码的格式判据：拦**全部控制字符**，不校验具体长度 / 字符集。
 *  各家邮箱的授权码形态各不相同（163 是 16 位字母数字、QQ 是 16 位带横线），前端按某一
 *  家的规则写死 regex 就会在录入另一家时给出「格式不正确」而实际值是对的 —— 最终判据在
 *  后端（真发信时才验），前端只拦「明显打错了」的形态。
 *
 *  ⚠️ 与后端 `validate_secret` 的 `char::is_control()` 逐字对齐 = Unicode `Cc` 类目 =
 *  U+0000..U+001F 与 U+007F..U+009F。只拦 `\r\n` 时，授权码里混进 `\0` / `\x1b` 之类会
 *  一路进到 SMTP 的 `AUTH` 命令行（那是凭据注入面），前端却报「已通过」。 */
const MAIL_ACCOUNT_SECRET_REJECT = /[\u0000-\u001f\u007f-\u009f]/;

/** 登录账号的格式判据：拒**任何空白字符**，且**必须含 `@`**。
 *
 *  ⚠️ 与后端 `validate_account` **不是逐字同一条正则**（Rust 的 `char::is_whitespace()` 按
 *  Unicode `White_Space` 属性判，JS 按 `/\s/`），两端口径有**两处差集，且方向相反**：
 *  - U+0085（NEL）：Rust 拒、JS `\s` 放行 ⇒ **前端更松**，唯一一类「过了前端却吃后端 21704」的
 *    输入形态；
 *  - U+FEFF（BOM）：JS `\s` 拒、Rust 放行 ⇒ **前端更严**（BOM 本来就该拒）。
 *
 *  除此之外两端口径逐条一致，所以前端可以照 `\s` 写，不必枚举 `White_Space` 类目。
 *
 *  ⚠️ **链式顺序与后端不同，但这只影响「同时违反多条时哪条先报」**（前端先 trim、先拒空串；
 *  后端先判空再判空白再判 CR/LF 再判 `@`）：除上面那两条差集外，两端对同一条输入**都拒**，
 *  不需要为了对齐提示先后而改顺序（前端「trim 在前」是 CLAUDE.md 表单 schema 的纪律）。 */
const MAIL_ACCOUNT_ACCOUNT_REJECT = /\s/;

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
    // 枚举**只在入参侧**守（理由见 `MAIL_ACCOUNT_PRESET_VALUES`）。
    preset: mailAccountPresetSchema,
    account: z
      .string()
      .trim()
      .min(1, '请填写登录账号')
      .max(MAIL_ACCOUNT_ACCOUNT_MAX, `登录账号长度不能超过 ${MAIL_ACCOUNT_ACCOUNT_MAX} 个字符`)
      .refine((v) => !MAIL_ACCOUNT_ACCOUNT_REJECT.test(v), '登录账号不能包含空白字符')
      // ⚠️ 「必须含 @」是后端 `validate_account` 的硬判据（163 与 QQ **都**填完整邮箱
      // 地址）。前端不拦时用户会按旧文案填一个 QQ 号，提交上去吃 21704；而 21704 的
      // message 是给日志看的「SMTP 登录账号应为一个完整邮箱地址…」，糊到 toast 上也要用户
      // 自己翻译。这里提前拦并给出可执行的提示。
      .refine((v) => v.includes('@'), '请填写完整邮箱地址（如 xxx@163.com）'),
    secret: z
      .string()
      .trim()
      .max(MAIL_ACCOUNT_SECRET_MAX, `授权码长度不能超过 ${MAIL_ACCOUNT_SECRET_MAX} 个字符`)
      .refine(
        (v) => !MAIL_ACCOUNT_SECRET_REJECT.test(v),
        '授权码不能包含控制字符（换行 / 制表符等）',
      ),
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
