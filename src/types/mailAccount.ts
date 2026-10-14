// 邮箱账号（定时任务 → 邮件域）的 **入参** wire 类型（2026-10-16 新增）。
//
// ⚠️ **本文件只有入参，没有出参镜像**：五个端点的出参 wire 契约的**唯一真源**是
// `src/views/mail/accounts/mailAccountSchema.ts` 的 `mailAccountSchema` /
// `mailAccountListSchema` / `mailMetaSchema`，消费侧一律用 `z.infer` 派生的 `*Data` 类型
// （api 层 `import type` 标注返回类型、组件与 store 直接 import 域内路径）。这里再抄一份
// 手写 interface 就是同一份契约的第二个真源：schema 加字段时它不会报错，只会静默腐烂。
//
// ⚠️ **删除端点没有出参 schema**（后端返回 `R<()>`，wire 上 `data` 是 `null`）—— 不是漏写，
// 是**没有可守的形状**：`parse(null)` 必抛。
//
// 沿 `src/types/mailDigest.ts` 的同款取舍（那是本仓第一个只放入参的 types 文件）。

import type { MailAccountPresetData } from '@/views/mail/accounts/mailAccountSchema';

/** SMTP 服务商预设的 wire 形态。**别名**到 schema 的 `z.infer` 派生类型而不是重写一遍
 *  联合类型 —— 改枚举时只改 schema 一处。 */
export type MailAccountPreset = MailAccountPresetData;

/** `POST /api/v2/cron/mail/accounts` 的请求体（建档）。
 *
 *  ⚠️ 本端点与改档端点都是 **POST 而不是 PUT** —— 本仓后端全站只允许 GET / POST 两种方法。 */
export interface SaveMailAccountPayload {
  /** 自定义名称。必填，同一部署内唯一（重复由后端 21707 拒）。 */
  name: string;
  /** SMTP 服务商预设；host / port / tls_mode 由后端按它推导，前端不传也不存。 */
  preset: MailAccountPreset;
  /** SMTP 登录账号，163 / QQ **都**填完整邮箱地址（后端 `validate_account` 要求含 `@`）。
   *  同时也是发件人地址。 */
  account: string;
  /** 授权码。**建档时必填**（库里还没有）。 */
  secret: string;
}

/** `POST /api/v2/cron/mail/accounts/{id}` 的请求体（改档）。
 *
 *  ⚠️ `version` **必填**（OCC 锚，取该行当前的 `version`；漏传是 axum 的 HTTP 422 纯文本，
 *  不是业务信封）。不要用「读-再-比」式隐式 OCC 代替。
 *
 *  ⚠️ **`secret` 空串 = 不修改授权码**（后端显式契约，不是「清空」）：编辑弹窗里
 *  授权码一栏留空时不回显、placeholder 写「留空表示不修改」，提交的就是空串。
 *  ⚠️ 想清空授权码**没有前端路径** —— 授权码是发信的必要输入，清空只会让这条邮箱彻底不
 *  能用；真要停用某条邮箱，删掉它（被定时任务引用时后端 21708 会拦，并提示引用方）。 */
export interface UpdateMailAccountPayload extends SaveMailAccountPayload {
  version: number;
}

/** `POST /api/v2/cron/mail/accounts/{id}/set-default` 与 `/delete` 的请求体：**只有 `version`**
 *  一个键，且**必填**。
 *
 *  ⚠️ 后端 `DeleteAccountRequest` / `SetDefaultAccountRequest` 的 `version` **没有**
 *  `#[serde(default)]` ⇒ 漏传是 axum `Json` 提取器的 **HTTP 422 纯文本**，不进 `R<T>` 信封、
 *  拿不到业务码、查表文案全部落空（用户只看到一句 axios 通用错误，且看不出是 OCC 缺参）。
 *  本仓后端零 PUT/PATCH/DELETE，「软删」走 action 路径不代表它没有 body。
 *
 *  **不要**改回「无 body / 空对象承载」那种写法：形参上的 `?` 与 `_` 前缀正是它悄悄退化成
 *  `{}` 的原因（`api/mailAccounts.ts` 的两条动作端点 + `useMailAccountsStore` 的两个
 *  mutation，三层都以为别人会补 version）。回归见
 *  `src/api/__tests__/mailAccounts.contract.spec.ts` 的 U5（断言 body 逐字等于
 *  `{ version: n }`）与 `views/mail/accounts/__tests__/useMailAccountsStore.spec.ts` 的 W3/W4。 */
export interface MailAccountVersionPayload {
  /** OCC 锚，取**目标行**当前返回的 `version`（不是 id、不是 version 0）。 */
  version: number;
}
