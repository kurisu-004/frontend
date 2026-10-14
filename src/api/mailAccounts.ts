// 后端 scheduled_task 域 mail 子域（邮箱账号管理）API。走 `@/api/http` 统一 axios 客户端。
//
// 2026-10-16 新建。2026-10-17 随企业微信子模块同批**硬切**到 `/cron/` 前缀（见下）。
// 后端契约（冻结版，与本文件逐字对齐）：
//   GET  /cron/mail/meta                   → SMTP 预设选项（label / host / port / tls_mode）
//   GET  /cron/mail/accounts               → 邮箱账号列表（`{items:[…]}`，一次性返全部）
//   POST /cron/mail/accounts               → 建档
//   POST /cron/mail/accounts/{id}          → 改档（**不是 PUT**，本仓后端只允许 GET/POST）
//   POST /cron/mail/accounts/{id}/delete   → 删除（被定时任务引用时后端 21708 拒）
//   POST /cron/mail/accounts/{id}/set-default → 设为默认（列表标记，⚠️ 不影响发信）
//
// ⚠️ **部署顺序：后端必须先上**。2026-10-17 把定时任务域的三条 URL 线（`/mail/*` →
//   `/cron/mail/*`、`/mail-digest/*` → `/cron/mail-digest/*`、新增 `/cron/wecom/*` 与
//   `/cron/wecom-daily/*`）**归拢到一个 `/cron` 根下**，旧路径 404、无 alias ⇒ 反序发布时
//   本页六个端点全部 404，且失败发生在**网络层**（不是 Zod 契约层），现场只看到一句
//   axios 错误。排查先看部署顺序，别查权限与配置。
// ⚠️ **前端路由 `/mail` 与 API 前缀 `/cron/mail` 是两层，不要求一致**：path 是浏览器书签
//   URL + 后端菜单表 `t_menu.path` 列，`src/router/index.ts` 的 `redirect: '/mail'` 老书签
//   兼容路由一并保持原样（照 `views/wecom/` 域 `/wecom` 与 `/cron/wecom` 的同款做法）。
//
// 端点全部 MANAGER 独占（后端 handler 层统一 require_role）。
//
// ⚠️ **出参绝不含 `encrypted_secret`**：授权码在后端加密入库，列表 / 建档 / 改档三个
// 出参一律不带它（连掩码、连长度都不带）。所以前端没有任何「回显授权码」的路径，
// 列表页恒显示「已配置」、编辑弹窗留空即不改 —— 这条在
// `views/mail/accounts/mailAccountSchema.ts::mailAccountSchema` 的 `.strict()` 上还有第二
// 道闸（后端哪天误带出来会当场抛）。
//
// 守门点分工（CLAUDE.md「Zod schema-first」）：
//   - 两条**读**端点（meta / accounts）的守门在 queryFn
//     （`views/mail/accounts/composables/useMailAccountsQuery.ts`），本文件**不 parse** ——
//     parse 返回深拷贝，多一层等于每屏数据被校验并克隆两遍；
//   - 三条**有对象出参**的写端点（建档 / 改档 / 设为默认）走 useMutation、**没有
//     queryFn 承载**，守门留在本层（CLAUDE.md 为这类调用留的口子，同 `api/mailDigest.ts`
//     的保存 / preview / send、`api/inspection.ts` 的扫码树）。
//   出参类型一律 `import type` 取 schema 的 `z.infer` 派生类型（编译期擦除，不留
//   api → views 的**类型**依赖边）；只有那些 parse 需要运行时引入 schema 模块 —— 所以
//   上方那个**值** import 里**只有** `mailAccountSchema` 一个名字（两条读端点的守门 schema
//   一个都不在这里，那正是 N1 守的不变量：把 `mailAccountListSchema.parse` 写进
//   `listMailAccounts` 会让 lint 的 `no-unused-vars` 先红，而
//   `api/__tests__/mailAccounts.contract.spec.ts` 守的是行为侧）。
//
// ⚠️ **删除端点是唯一的例外：它没有 parse**。后端 `delete_account` 返 `R<()>`，信封的
// `data` 是 `null` —— 没有任何形状可守，`z.object({…}).parse(null)` 必抛。这不是「漏了
// 守门」，是**这道闸门不存在**：软删成功与否由 HTTP 状态码表达（失败一律抛业务码
// 21706 / 21708），而响应体里不含任何需要前端依赖的字段。守卫见
// `api/__tests__/mailAccounts.contract.spec.ts` 的 N2b。

import { api } from '@/api/http';
import type {
  MailAccountVersionPayload,
  SaveMailAccountPayload,
  UpdateMailAccountPayload,
} from '@/types/mailAccount';
import type {
  MailAccountData,
  MailAccountListData,
  MailMetaData,
} from '@/views/mail/accounts/mailAccountSchema';
import { mailAccountSchema } from '@/views/mail/accounts/mailAccountSchema';

/**
 * 读 SMTP 预设选项（`GET /api/v2/cron/mail/meta`）。
 *
 * 返回 `presets[]`：`{value, label, host, port, tls_mode}`。**前端不另存一份映射** ——
 * 弹窗里那条只读的 `host:port:tls_mode` 描述行、预设下拉的选项，全部取自本端点；前端
 *  只有 schema 里的 `mailAccountPresetSchema` 守 wire 取值域，没有「163 是什么端口」这
 *  类常量。
 *
 * 守门在 queryFn（`useMailMetaQuery`），本函数**不 parse**。
 *
 * 失败抛 `ApiError`：40101 未登录 / 403 非 MANAGER。
 */
export async function fetchMailMeta(): Promise<MailMetaData> {
  const resp = await api.get<MailMetaData>('/cron/mail/meta');
  return resp.data;
}

/**
 * 读邮箱账号列表（`GET /api/v2/cron/mail/accounts`）。
 *
 * 出参是**信封对象** `{ items: MailAccountOut[] }`（后端 `R<MailAccountListOut>`），不是裸
 * 数组 —— 一次性返全部、无分页参数，但 `data` 本身仍带一层 `items`。
 *
 * **不含**任何形式的授权码派生值。
 *
 * 守门在 queryFn（`useMailAccountsQuery`），本函数**不 parse**。
 *
 * 失败抛 `ApiError`：40101 未登录 / 403 非 MANAGER。
 */
export async function listMailAccounts(): Promise<MailAccountListData> {
  const resp = await api.get<MailAccountListData>('/cron/mail/accounts');
  return resp.data;
}

/**
 * 新建邮箱账号（`POST /api/v2/cron/mail/accounts`）。
 *
 * 请求体 `{name, preset, account, secret}`，**`secret` 必填**（库里还没有授权码）。
 *
 * 守门在本层（useMutation 没有 queryFn 承载）。
 *
 * 失败抛 `ApiError`：
 * - 21707 自定义名称重复；
 * - 40001 参数非法（长度 / 枚举越界 —— 前端 schema 已提前拦，真到这里说明两边上限漂了）。
 */
export async function createMailAccount(payload: SaveMailAccountPayload): Promise<MailAccountData> {
  const resp = await api.post<MailAccountData>('/cron/mail/accounts', payload);
  return mailAccountSchema.parse(resp.data);
}

/**
 * 改档（`POST /api/v2/cron/mail/accounts/{id}`）。
 *
 * @param payload `version` **必填**（OCC 锚，取该行当前的 `version`；缺省是 axum 的
 *   HTTP 422 纯文本，不是业务信封）。
 *
 * 守门在本层（同建档）。
 *
 * ⚠️ **`secret` 空串 = 不修改授权码**（后端显式契约，不是「清空」）：编辑弹窗里该栏留空
 * 时提交的就是空串，后端保留库里那份密文。响应里**不含**授权码的任何派生值。
 *
 * 失败抛 `ApiError`：21706 账号不存在 / 21707 名称重复 / 40901 OCC 版本冲突。
 */
export async function updateMailAccount(
  id: string,
  payload: UpdateMailAccountPayload,
): Promise<MailAccountData> {
  const resp = await api.post<MailAccountData>(
    `/cron/mail/accounts/${encodeURIComponent(id)}`,
    payload,
  );
  return mailAccountSchema.parse(resp.data);
}

/**
 * 删除邮箱账号（`POST /api/v2/cron/mail/accounts/{id}/delete`）。
 *
 * **不是 DELETE 方法** —— 本仓后端全站只允许 GET / POST。删除走独立的 action 路径而不是
 * `DELETE /accounts/{id}`，是为了与 `set-default` 同形、且给「被引用时拒绝」留出一个能带
 * 业务码（21708）的信封响应。
 *
 * @param payload `version` **必填**（OCC 锚，取目标行当前的 `version`；漏传是 axum 的
 *   HTTP 422 纯文本，拿不到业务码、查表文案全部落空）。
 *
 * ⚠️ **本函数不做 Zod 守门**：后端 `delete_account` 返 `R<()>`，信封的 `data` 是 `null`，
 * 没有形状可守（`parse(null)` 必抛，而那正是「删除永远失败」的成因）。成功与否由 HTTP
 * 状态码表达：失败一律 reject 出去（21706 / 21708），store 的 `onError` 转成人话。
 *
 * 失败抛 `ApiError`：21706 账号不存在 / **21708 账号被定时任务引用禁止删除**
 * （文案点名引用方，见 `mailAccountErrorText.ts`）。
 */
export async function deleteMailAccount(
  id: string,
  payload: MailAccountVersionPayload,
): Promise<void> {
  await api.post<null>(`/cron/mail/accounts/${encodeURIComponent(id)}/delete`, payload);
}

/**
 * 设为默认（`POST /api/v2/cron/mail/accounts/{id}/set-default`）。
 *
 * ⚠️ **只是给这一行打上「默认」标记，不决定发信**：后端对 `is_default` 的全部消费只有列表
 * 排序与那条「至多一条为 true」的唯一索引；发信邮箱由交期汇总配置里的
 * `sender_account_id` 决定（`mail_digest::service::resolve_sender` 不看本字段）。
 *
 * @param payload `version` **必填**（OCC 锚，取**目标行**当前的 `version`）。
 *
 * 成功路径唯一（后端把原来那条默认的 `is_default` 置 false），因此返回的是**改完之后的
 * 那一行**（`MailAccountOut`），列表页可以直接就地把该行换成新响应、其余行靠失效重拉。
 *
 * 守门在本层。失败抛 `ApiError`：21706 账号不存在 / 40901 OCC 版本冲突。
 */
export async function setDefaultMailAccount(
  id: string,
  payload: MailAccountVersionPayload,
): Promise<MailAccountData> {
  const resp = await api.post<MailAccountData>(
    `/cron/mail/accounts/${encodeURIComponent(id)}/set-default`,
    payload,
  );
  return mailAccountSchema.parse(resp.data);
}
