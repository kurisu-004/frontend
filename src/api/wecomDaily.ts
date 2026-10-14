// 后端 scheduled_task 域 **wecom-daily 子域**（企业微信每日生产情况定时推送）API。走
// `@/api/http` 统一 axios 客户端。
//
// 2026-10-17 新建。后端契约（冻结版，与本文件逐字对齐）：
//   GET  /cron/wecom-daily/config          → 读推送配置（无行时返回全默认 + version 0 + id "0"）
//   POST /cron/wecom-daily/config          → 保存（**不是 PUT**，本仓后端只允许 GET/POST）
//   GET  /cron/wecom-daily/meta            → 频率选项 / worker_metric 选项 / 缺省值 /
//                                           三段取值范围（天数 / 人数 / 分片）
//   POST /cron/wecom-daily/preview         → 渲染，**不发送、不落流水**；空体 `{}` = 全用当前配置
//   POST /cron/wecom-daily/send            → 真发，**成败都落一条流水**
//   GET  /cron/wecom-daily/logs?limit=&offset= → 发送流水分页
//
// ⚠️ **部署顺序：后端必须先上**。2026-10-17 把定时任务域的各条 URL 线归拢到 `/cron` 根下，
//   旧路径 404、无 alias ⇒ 反序发布时本文件六个端点全部 404，且失败发生在**网络层**
//   （不是 Zod 契约层），现场只看到一句 axios 错误。
// ⚠️ **前端路由 `/wecom` 与 API 前缀 `/cron/wecom-daily` 是两层，不要求一致**。
//
// ⚠️ **错误码段是 218xx**。本域占 21801 / 21802 / 21804 / 21805，webhook 子域占 21803 /
//   21806..08。码值的**单一来源**是 `views/wecom/daily/weComDailyErrorText.ts` 的
//   `WECOM_DAILY_ERROR_CODES` 与 `views/wecom/webhooks/weComWebhookErrorText.ts` 的
//   `WECOM_WEBHOOK_ERROR_CODES`（注释里写码值只为指路，真判据一律引常量）。
//
// 守门点分工（CLAUDE.md「Zod schema-first」）—— ⚠️ **这一节最容易写反**：
//   - 三条**读**端点（config / meta / logs）的守门在 queryFn
//     （`views/wecom/daily/composables/useWeComDailyQuery.ts`），本文件**不 parse** ——
//     parse 返回深拷贝，多一层等于每屏数据被校验并克隆两遍；
//   - 三条**写**端点（保存配置 / preview / send）走 useMutation、**没有 queryFn 承载**，
//     守门留在本层（CLAUDE.md 为这类调用留的口子，同 `api/mailDigest.ts`）。
//   出参类型一律 `import type` 取 schema 的 `z.infer` 派生类型（编译期擦除，不留
//   api → views 的**类型**依赖边）；只有那三条 parse 需要运行时引入 schema 模块。

import { api, cleanParams } from '@/api/http';
import type {
  ListWeComDailyLogsParams,
  SaveWeComDailyConfigPayload,
  WeComDailyRunPayload,
} from '@/types/wecom';
import type {
  WeComDailyConfigData,
  WeComDailyLogListData,
  WeComDailyMetaData,
} from '@/views/wecom/daily/weComDailySchema';
import {
  weComDailyConfigSchema,
  weComDailyLogSchema,
  weComDailyPreviewSchema,
  type WeComDailyLogData,
  type WeComDailyPreviewData,
} from '@/views/wecom/daily/weComDailySchema';

/**
 * 读每日总结配置（`GET /api/v2/cron/wecom-daily/config`）。
 *
 * ⚠️ **不会 404**：表里无行时后端返回「全部默认值 + `version: 0` + `id: "0"`」，所以调用方
 * 永远拿到一个可用的配置对象，首次保存用 `version: 0` 建行。
 *
 * 守门在 queryFn（`useWeComDailyConfigQuery`），本函数**不 parse**。
 *
 * 失败抛 `ApiError`：40101 未登录 / 403 非 MANAGER。
 */
export async function fetchWeComDailyConfig(): Promise<WeComDailyConfigData> {
  const resp = await api.get<WeComDailyConfigData>('/cron/wecom-daily/config');
  return resp.data;
}

/**
 * 保存每日总结配置（`POST /api/v2/cron/wecom-daily/config`）。
 *
 * @param payload `version` **必填**（OCC 锚，取 `GET /config` 的 `version`；缺省是 axum 的
 *   HTTP 422 纯文本，不是业务信封）。
 *
 * 守门在本层（走 useMutation、没有 queryFn 承载）。返回的是**存完之后**的那一行（`id` /
 * `version` 都已更新），store 的 `applyConfigToForm` 直接拿它重置快照；不守门的话，一个缺
 * `version` 的响应会让下一次提交带着 `undefined` 打 422，而用户看到的只是一句兜底文案。
 *
 * 失败抛 `ApiError`：
 * - 40901 OCC 版本冲突（配置已被他人改动，UI 提示刷新后重试并重拉配置）；
 * - 21804 频率 / 触发时刻 / 配套字段 / 人数与分片上限组合非法；
 * - 21806 选中的 webhook 已被删除（`webhook_id` 指向的行没了）。
 */
export async function saveWeComDailyConfig(
  payload: SaveWeComDailyConfigPayload,
): Promise<WeComDailyConfigData> {
  const resp = await api.post<WeComDailyConfigData>('/cron/wecom-daily/config', payload);
  // ⚠️ **部署顺序：后端必须先上**（照 CLAUDE.md「写侧 schema 接 `.strict()`」的登记口径）。
  // 后端给 `ConfigOut` 加一个字段，这行当场抛 ZodError（mutation 进 `onError` 弹「格式不符合
  // 预期」，而库里已落库成功）。这正是写侧要 `.strict()` 的理由 —— 配置多 / 少一个字段是一
  // 次没被看见的决定，必须当场红。
  return weComDailyConfigSchema.parse(resp.data);
}

/**
 * 读本域元数据（`GET /api/v2/cron/wecom-daily/meta`）。
 *
 * 返回频率选项（含三个 `needs_*` 判据）、条形图指标选项、缺省配置，以及三段取值范围
 * （`upcoming_days_range` / `worker_top_n_range` / `max_chunks_range`）。
 *
 * ⚠️ **这些判据前端一律不硬编码**：输入项的 `:min/:max`、配套字段的显隐、表单的越界校验
 * 全部读这一份（后端改范围时前端自动跟随，不会出现「UI 放行、schema 却拒」）。
 *
 * 守门在 queryFn（`useWeComDailyMetaQuery`），本函数**不 parse**。
 *
 * 失败抛 `ApiError`：40101 未登录 / 403 非 MANAGER。
 */
export async function fetchWeComDailyMeta(): Promise<WeComDailyMetaData> {
  const resp = await api.get<WeComDailyMetaData>('/cron/wecom-daily/meta');
  return resp.data;
}

/**
 * 渲染推送预览（`POST /api/v2/cron/wecom-daily/preview`）。
 *
 * 请求体 = 配置部分（**不含 version**），全部键可选：空体 `{}` = 完全用服务端当前配置；
 * 传部分键 = 只覆盖那几项。**不落库、不写流水、不发消息**。
 *
 * ⚠️ 出参是 `chunks: string[]`（不是单个 `markdown`）—— 后端把超出单条消息上限的内容**拆成
 *   多条**而不是截断，`chunk_count` 是「这次要发几条」的唯一答案。预览弹窗逐片渲染，见
 *   `views/wecom/daily/components/WeComPreviewDialog.vue`。
 *
 * 守门在本层（useMutation 没有 queryFn 承载）。失败抛 `ApiError`：21801 / 21804。
 */
export async function previewWeComDaily(
  payload: WeComDailyRunPayload,
): Promise<WeComDailyPreviewData> {
  const resp = await api.post<WeComDailyPreviewData>('/cron/wecom-daily/preview', payload);
  return weComDailyPreviewSchema.parse(resp.data);
}

/**
 * 立即发送一次（`POST /api/v2/cron/wecom-daily/send`）。
 *
 * 请求体与 preview 同形。**真发、不可撤销** —— UI 侧必须挂二次确认
 * （`WeComDailySettings.vue` 的 `el-popconfirm`）。
 *
 * ⚠️ **成败都会落一条流水**（后端 21802 抛错之前已经记了 `t_wecom_daily_log`）⇒ store 的
 *   `onError` **也**要失效日志列表，前端才能立刻看到那行失败记录（否则「为什么没发出去」
 *  凭空消失，理由同 `api/mailDigest.ts::sendMailDigestNow`）。
 *
 * ⚠️ **出参是 `LogRow`**（与 `/logs` 的 `items[]` 同一个结构体，后端 `SendResultOut` 就是
 *   `LogRow`）⇒ 只维护一份 schema，`weComDailyLogSchema` 两处共用，不拆成两份声明（漏声明的
 *   那份在单测里很难被发现，而 `.strict()` 会把它变成线上当场抛）。
 *
 * 守门在本层（同 preview）。失败抛 `ApiError`：
 * - 21801 没有可用的推送通道（`webhook_id` 为空 / 指向的行已被软删）；
 * - 21802 推送失败（地址失效 / 机器人已被移出群）；**服务端已记一条 FAILED 流水**；
 * - 21804 配置组合非法。
 */
export async function sendWeComDailyNow(payload: WeComDailyRunPayload): Promise<WeComDailyLogData> {
  const resp = await api.post<WeComDailyLogData>('/cron/wecom-daily/send', payload);
  return weComDailyLogSchema.parse(resp.data);
}

/**
 * 发送流水分页（`GET /api/v2/cron/wecom-daily/logs?limit=&offset=`）。
 *
 * 守门在 queryFn（同三条读端点），本函数**不 parse**。
 *
 * 失败抛 `ApiError`：40101 未登录 / 403 非 MANAGER。
 */
export async function listWeComDailyLogs(params: ListWeComDailyLogsParams = {}) {
  const resp = await api.get<WeComDailyLogListData>('/cron/wecom-daily/logs', {
    params: cleanParams(params),
  });
  return resp.data;
}
