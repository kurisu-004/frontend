// 后端 scheduled_task 域 **wecom 子域**（企业微信 webhook 通道管理）API。走 `@/api/http`
// 统一 axios 客户端。
//
// 2026-10-17 新建。后端契约（冻结版，与本文件逐字对齐）：
//   GET  /cron/wecom/webhooks               → webhook 通道列表（`{items:[…]}`，一次性返全部）
//   POST /cron/wecom/webhooks               → 新建（body `{name, webhook_url}`）
//   POST /cron/wecom/webhooks/{id}          → 改档（**不是 PUT**，本仓后端只允许 GET/POST；
//                                             **全量覆写**，body 必含 `version`）
//   POST /cron/wecom/webhooks/{id}/delete   → 软删（body **必含 `version`**）
//   POST /cron/wecom/webhooks/{id}/set-default → 置默认（body **必含 `version`**）
//   POST /cron/wecom/webhooks/{id}/test     → 测连通（发一条 text 探针；**不写日志**）
//
// ⚠️ **部署顺序：后端必须先上**。2026-10-17 把定时任务域的各条 URL 线归拢到 `/cron` 根下，
//   旧路径 404、无 alias ⇒ 反序发布时本文件六个端点全部 404，且失败发生在**网络层**
//   （不是 Zod 契约层），现场只看到一句 axios 错误。排查先看部署顺序，别查权限与配置。
// ⚠️ **前端路由 `/wecom` 与 API 前缀 `/cron/wecom` 是两层，不要求一致**：path 是浏览器书签
//   URL + 后端菜单表 `t_menu.path` 列。见 `src/router/index.ts` 的同名路由注释。
//
// ⚠️ **完整 webhook URL 是写入型 secret、永不回显**：出参一律只给 `url_masked`。所以前端
//   没有任何「回显完整地址」的路径，编辑弹窗只能显示掩码 + 「留空则不修改」。这条在
//   `views/wecom/webhooks/weComWebhookSchema.ts::weComWebhookSchema` 的 `.strict()` 上还有
//   第二道闸（后端哪天误把 `webhook_url` 带出来会当场抛）。
//
// 守门点分工（CLAUDE.md「Zod schema-first」）：
//   - **唯一一条读端点**（webhooks 列表）的守门在 queryFn
//     （`views/wecom/webhooks/composables/useWeComWebhooksQuery.ts`），本文件**不 parse** ——
//     parse 返回深拷贝，多一层等于每屏数据被校验并克隆两遍；
//   - 三条**有对象出参**的写端点（建档 / 改档 / 置默认）走 useMutation、**没有 queryFn
//     承载**，守门留在本层（CLAUDE.md 为这类调用留的口子，同 `api/mailDigest.ts` 的保存 /
//     preview / send、`api/mailAccounts.ts` 的建档 / 改档 / 设为默认）。
//   出参类型一律 `import type` 取 schema 的 `z.infer` 派生类型（编译期擦除，不留
//   api → views 的**类型**依赖边）；只有那三条 parse 需要运行时引入 schema 模块。

import { api } from '@/api/http';
import type {
  CreateWeComWebhookPayload,
  UpdateWeComWebhookPayload,
  WeComWebhookVersionPayload,
} from '@/types/wecom';
import type {
  WeComWebhookData,
  WeComWebhookListData,
} from '@/views/wecom/webhooks/weComWebhookSchema';
import { weComWebhookSchema } from '@/views/wecom/webhooks/weComWebhookSchema';

/**
 * 读 webhook 通道列表（`GET /api/v2/cron/wecom/webhooks`）。
 *
 * 出参是**信封对象** `{ items: WebhookOut[] }`（后端 `R<WebhookListOut>`），不是裸数组 ——
 * 一次性返全部、无分页参数，但 `data` 本身仍带一层 `items`。
 *
 * 守门在 queryFn（`useWeComWebhooksQuery`），本函数**不 parse**。
 *
 * 失败抛 `ApiError`：40101 未登录 / 403 非 MANAGER。
 */
export async function listWeComWebhooks(): Promise<WeComWebhookListData> {
  const resp = await api.get<WeComWebhookListData>('/cron/wecom/webhooks');
  return resp.data;
}

/**
 * 新建 webhook 通道（`POST /api/v2/cron/wecom/webhooks`）。
 *
 * 请求体 `{name, webhook_url}`，**`webhook_url` 必填**（库里还没有这条通道）。
 *
 * 守门在本层（useMutation 没有 queryFn 承载）。
 *
 * 失败抛 `ApiError`：
 * - 21803 地址格式不合法（前端 schema 已提前拦，真到这里说明两边判据漂了）；
 * - 21807 自定义名称重复；
 * - 40001 参数非法（长度越界 —— 前端 schema 已提前拦）。
 */
export async function createWeComWebhook(
  payload: CreateWeComWebhookPayload,
): Promise<WeComWebhookData> {
  const resp = await api.post<WeComWebhookData>('/cron/wecom/webhooks', payload);
  // ⚠️ **部署顺序：后端必须先上**（照 CLAUDE.md「写侧 schema 接 `.strict()`」的登记口径）。
  // `weComWebhookSchema` 是 `.strict()` 的写侧语义：后端给 `WebhookOut` **加一个字段**，这行
  // 当场抛 ZodError（mutation 进 `onError` 弹「格式不符合预期」，而库里已落库成功）。这正是
  // 写侧要 `.strict()` 的理由 —— 通道多 / 少一个字段是一次没被看见的决定，必须当场红。
  return weComWebhookSchema.parse(resp.data);
}

/**
 * 改档（`POST /api/v2/cron/wecom/webhooks/{id}`）。
 *
 * @param payload `version` **必填**（OCC 锚，取该行当前的 `version`；缺省是 axum 的 HTTP 422
 *   纯文本，不是业务信封）。body 是**全量覆写**（不是 PATCH），所以 `name` 必填。
 *
 * 守门在本层（同建档）。
 *
 * ⚠️ **`webhook_url` 空串 = 不修改地址**（后端显式契约，不是「清空」）：编辑弹窗里该栏留空
 *   时提交的就是空串，后端保留库里那份密文。响应里**不含**完整地址的任何派生值。
 *
 * 失败抛 `ApiError`：21803 地址格式 / 21806 通道不存在 / 21807 名称重复 / 40901 OCC 冲突。
 */
export async function updateWeComWebhook(
  id: string,
  payload: UpdateWeComWebhookPayload,
): Promise<WeComWebhookData> {
  const resp = await api.post<WeComWebhookData>(
    `/cron/wecom/webhooks/${encodeURIComponent(id)}`,
    payload,
  );
  return weComWebhookSchema.parse(resp.data);
}

/**
 * 软删 webhook 通道（`POST /api/v2/cron/wecom/webhooks/{id}/delete`）。
 *
 * **不是 DELETE 方法** —— 本仓后端全站只允许 GET / POST。删除走独立 action 路径是为了与
 * `set-default` 同形、且给「被每日总结引用时拒绝」留出一个能带业务码（21808）的信封响应。
 *
 * @param payload `version` **必填**（OCC 锚，取目标行当前的 `version`；漏传是 axum 的 HTTP
 *   422 纯文本，拿不到业务码、查表文案全部落空）。
 *
 * ⚠️ **本函数不做 Zod 守门**，与 `api/mailAccounts.ts::deleteMailAccount` 同款取舍：软删没有
 *   任何前端需要依赖的出参字段（后端返 `R<()>`、信封 `data` 是 `null`），凭空造一个
 *   `{deleted: boolean}` 的 schema 去 parse 它只会让**删除永远走 onError**、而后端行已软删。
 *   成功与否由 HTTP 状态码表达：失败一律 reject（21806 / 21808），store 的 `onError` 转人话。
 *   守卫见 `api/__tests__/wecomWebhooks.contract.spec.ts` 的 N2b。
 *
 * 失败抛 `ApiError`：21806 通道不存在 / **21808 被每日总结配置引用禁止删除** / 40901 OCC 冲突。
 */
export async function deleteWeComWebhook(
  id: string,
  payload: WeComWebhookVersionPayload,
): Promise<void> {
  await api.post<null>(`/cron/wecom/webhooks/${encodeURIComponent(id)}/delete`, payload);
}

/**
 * 设为默认（`POST /api/v2/cron/wecom/webhooks/{id}/set-default`）。
 *
 * ⚠️ **只是给这一行打上「默认」标记，不决定推送**：后端对 `is_default` 的全部消费只有列表
 *   排序与那条「至多一条为 true」的唯一索引；推哪条通道由每日总结配置里的 `webhook_id`
 *   决定，后端**从不**回落到本字段（与 mail 域 `is_default` 的处境同款）。
 *
 * @param payload `version` **必填**（OCC 锚，取**目标行**当前的 `version`）。
 *
 * 成功路径唯一（后端把原来那条默认的 `is_default` 置 false），因此返回的是**改完之后的那一行**。
 *
 * 守门在本层。失败抛 `ApiError`：21806 通道不存在 / 40901 OCC 版本冲突。
 */
export async function setDefaultWeComWebhook(
  id: string,
  payload: WeComWebhookVersionPayload,
): Promise<WeComWebhookData> {
  const resp = await api.post<WeComWebhookData>(
    `/cron/wecom/webhooks/${encodeURIComponent(id)}/set-default`,
    payload,
  );
  return weComWebhookSchema.parse(resp.data);
}

/**
 * 测连通（`POST /api/v2/cron/wecom/webhooks/{id}/test`）。
 *
 * 发一条 text 类型的探针消息到该通道，body 是**空对象**（不带 `version` —— 它不写配置）。
 *
 * ⚠️ **本函数不做 Zod 守门**，理由同 `deleteWeComWebhook`：这条端点没有任何前端需要依赖的
 *   出参字段（后端返 `R<()>`），探针的成败由 HTTP 状态码 / 业务码（21806 / 21802）表达。
 * ⚠️ **`/test` 不写 `t_wecom_daily_log`**（它是通道探测、不是内容推送）⇒ **store 的
 *   `testMutation` 刻意不失效日志 query**：失效了只会让管理员看到发送历史闪一下 loading，
 *   而历史里本来就什么都没多。
 *
 * 失败抛 `ApiError`：21806 通道不存在 / 21802 推送失败（地址失效 / 机器人已被移出群）。
 */
export async function testWeComWebhook(id: string): Promise<void> {
  await api.post<null>(`/cron/wecom/webhooks/${encodeURIComponent(id)}/test`, {});
}
