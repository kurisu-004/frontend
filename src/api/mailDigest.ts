// 后端 mail_digest 域（交期汇总邮件定时任务）API。走 `@/api/http` 统一 axios 客户端。
//
// 2026-10-13 新建。后端契约（冻结版，与本文件逐字对齐）：
//   GET  /mail-digest/config                 → 读定时配置（无行时返回全默认 + version 0）
//   POST /mail-digest/config                 → 保存（**不是 PUT**，本仓后端只允许 GET/POST）
//   GET  /mail-digest/meta                   → 频率选项 / 列白名单候选 / 默认值 / 天数范围 / SMTP 状态
//   POST /mail-digest/preview                → 按（可覆盖的）配置渲染 HTML，不落库
//   POST /mail-digest/send                   → 真发一封，落一条发送日志
//   GET  /mail-digest/logs?limit=&offset=    → 发送日志分页
//
// 端点全部 MANAGER 独占（后端 handler 层统一 require_role）。
//
// ⚠️ **2026-10-14：错误码段是 217xx**。本域第一版按「215 段往后排」猜成了 215xx，后端
// 实查发现 215xx 已被 outsource 发货域占用（`BIZ_OUTSOURCE_SHIPMENT_*=21501..21504`，
// 至今在用），改用了全新的 217xx 段。本文件下方各端点 JSDoc 里提到的码值随之对齐，
// 码值的**单一来源**是 `views/mail/digest/mailDigestErrorText.ts` 的
// `MAIL_DIGEST_ERROR_CODES`（注释里写码值只为指路，真判据一律引常量）。
//
// 守门点分工（CLAUDE.md「Zod schema-first」）：
//   - 三条**读**端点（config / meta / logs）的守门在 queryFn
//     （`views/mail/digest/composables/useMailDigestQuery.ts`），本文件**不 parse** ——
//     parse 返回深拷贝，多一层等于每屏数据被校验并克隆两遍；
//   - 两条「跑一次」的端点（preview / send）与**保存配置**这三条走 useMutation、
//     **没有 queryFn 承载**，守门留在本层（CLAUDE.md 为这类调用留的口子，同
//     `api/inspection.ts` 的扫码树）。
//   出参类型一律 `import type` 取 schema 的 `z.infer` 派生类型（编译期擦除，不留
//   api → views 的**类型**依赖边）；只有上面两条 parse 需要运行时引入 schema 模块。

import { api, cleanParams } from '@/api/http';
import type {
  ListMailDigestLogsParams,
  MailDigestRunPayload,
  SaveMailDigestConfigPayload,
} from '@/types/mailDigest';
import type {
  MailDigestConfigData,
  MailDigestLogListData,
  MailDigestMetaData,
} from '@/views/mail/digest/mailDigestSchema';
import {
  mailDigestConfigSchema,
  mailDigestPreviewSchema,
  mailDigestSendResultSchema,
  type MailDigestPreviewData,
  type MailDigestSendResultData,
} from '@/views/mail/digest/mailDigestSchema';

/**
 * 读定时配置（`GET /api/v2/mail-digest/config`）。
 *
 * ⚠️ **不会 404**：表里无行时后端返回「全部默认值 + `version: 0` + `id: "0"`」，
 * 所以调用方永远拿到一个可用的配置对象，首次保存用 `version: 0` 建行。
 *
 * 失败抛 `ApiError`：40101 未登录 / 403 非 MANAGER / 21705 配置不存在。
 */
export async function fetchMailDigestConfig(): Promise<MailDigestConfigData> {
  const resp = await api.get<MailDigestConfigData>('/mail-digest/config');
  return resp.data;
}

/**
 * 保存定时配置（`POST /api/v2/mail-digest/config`）。
 *
 * @param payload `version` **必填**（OCC 锚，取 `GET /config` 的 `version`；缺省是
 *   axum 的 HTTP 422 纯文本，不是业务信封）。
 *
 * 守门在本层（走 useMutation、没有 queryFn 承载，CLAUDE.md 为这类调用留的口子）。
 * 返回的是**存完之后**的那一行（`id` / `version` 都已更新），store 的 `applyConfigToForm`
 * 直接拿它重置快照；不守门的话，一个缺 `version` 的响应会让下一次提交带着 `undefined`
 * 打 422，而用户看到的只是一句兜底文案。
 *
 * 失败抛 `ApiError`：
 * - 40901 OCC 版本冲突（配置已被他人改动，UI 提示刷新后重试并重拉配置）；
 * - 21703 收件人邮箱格式不合法；
 * - 21704 频率与配套字段组合非法（**缺**时刻 / 缺星期 / 缺月号）。
 *   ⚠️ 2026-10-14（review 第 1 轮 M-2）订正：「**多填**当前频率用不到的字段」后端**不报
 *   21704**，而是清空（`weekday` / `day_of_month`）或原样忽略（`MANUAL_ONLY` 的时刻），
 *   原先写在括号里的「或多填了不用的字段」是错的。
 */
export async function saveMailDigestConfig(
  payload: SaveMailDigestConfigPayload,
): Promise<MailDigestConfigData> {
  const resp = await api.post<MailDigestConfigData>('/mail-digest/config', payload);
  return mailDigestConfigSchema.parse(resp.data);
}

/**
 * 读本域元数据（`GET /api/v2/mail-digest/meta`）。
 *
 * 返回频率选项（含三个 `needs_*` 判据）、表格列白名单候选、默认配置、`upcoming_days`
 * 的取值范围。
 *
 * ⚠️ 2026-10-16：**`smtp` 段已从出参删除**。SMTP 不再是部署级环境变量，而是页面内可
 * 维护的邮箱账号实体（`GET /api/v2/mail/accounts`，前端 `views/mail/accounts/`）——
 * 发信地址、授权码、选哪条发信都由那几张表承载。`defaults` 段里的
 * `sender_account_id`（选哪条邮箱发信）取的就是那个域的行 id，页面顶部的告警判据随之
 * 从「`meta.smtp.configured === false`」改为「邮箱列表为空 / 未选发信邮箱」。
 *
 * 失败抛 `ApiError`：40101 未登录 / 403 非 MANAGER。
 */
export async function fetchMailDigestMeta(): Promise<MailDigestMetaData> {
  const resp = await api.get<MailDigestMetaData>('/mail-digest/meta');
  return resp.data;
}

/**
 * 渲染邮件预览（`POST /api/v2/mail-digest/preview`）。
 *
 * 请求体 = 配置部分（**不含 version**），全部键可选：空体 `{}` = 完全用服务端当前配置；
 * 传部分键 = 只覆盖那几项（其余仍取当前配置）。**不落库、不写日志、不发信**。
 *
 * 守门在本层（useMutation 没有 queryFn 承载）。失败抛 `ApiError`：21703 / 21704。
 */
export async function previewMailDigest(
  payload: MailDigestRunPayload,
): Promise<MailDigestPreviewData> {
  const resp = await api.post<MailDigestPreviewData>('/mail-digest/preview', payload);
  return mailDigestPreviewSchema.parse(resp.data);
}

/**
 * 立即发送一封（`POST /api/v2/mail-digest/send`）。
 *
 * 请求体与 preview 同形。**真发、不可撤销** —— UI 侧必须挂二次确认
 * （`MailDigestSettings.vue` 的 `el-popconfirm`）。
 *
 * 守门在本层（同 preview）。失败抛 `ApiError`：
 * - 21701 SMTP 未配置（页面的 SMTP 状态条会提前禁用按钮，但服务端仍要拒）；
 * - 21702 SMTP 发送失败（**服务端已记一条 FAILED 日志**，所以 store 的 onError 也要
 *   失效日志列表，前端才能立刻看到那行失败记录）；
 * - 21703 / 21704 同 preview。
 */
export async function sendMailDigestNow(
  payload: MailDigestRunPayload,
): Promise<MailDigestSendResultData> {
  const resp = await api.post<MailDigestSendResultData>('/mail-digest/send', payload);
  return mailDigestSendResultSchema.parse(resp.data);
}

/**
 * 发送日志分页（`GET /api/v2/mail-digest/logs?limit=&offset=`）。
 *
 * 守门在 queryFn（同三条读端点），本函数**不 parse**。
 */
export async function listMailDigestLogs(params: ListMailDigestLogsParams = {}) {
  const resp = await api.get<MailDigestLogListData>('/mail-digest/logs', {
    params: cleanParams(params),
  });
  return resp.data;
}
