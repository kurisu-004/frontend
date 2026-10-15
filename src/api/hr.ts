// 人事（hr）域 API：考勤日历表 + 班次表。走 `@/api/http` 统一 axios 客户端（baseURL
// 已是 `/api/v2`，故下面路径一律从 `/hr/...` 写起，不再拼前缀）。
//
// 2026-10-19 新建。十端点冻结表（URL / method / body 与本文件逐字对齐）：
//   GET  /hr/calendar/days                     → 全局日历日行（区间查询）
//   POST /hr/calendar/days                     → 批量写全局日历日行（**无回显**）
//   POST /hr/calendar/days/delete              → 删全局日历日行（点删 or 区间删，**无回显**）
//   GET  /hr/shifts                            → 班次列表（可选连停用一起返）
//   POST /hr/shifts                            → 建班次（回显 ShiftOut）
//   POST /hr/shifts/{id}                       → 改班次（**全量覆写**语义 + OCC，回显 ShiftOut）
//   POST /hr/shifts/{id}/deactivate            → 停用班次（软删，OCC，回显 ShiftOut）
//   GET  /hr/shifts/{id}/calendar              → 某班次的日历（区间查询）
//   POST /hr/shifts/{id}/calendar/days         → 批量写该班次的日历覆盖行（**无回显**）
//   POST /hr/shifts/{id}/calendar/days/delete  → 删该班次的日历覆盖行（**无回显**）
//
// ⚠️ **零 PUT / PATCH / DELETE**：本仓后端全站只允许 GET / POST。改档走
// `POST /{id}`、停用走 `POST /{id}/deactivate`、删除走独立 action 路径（`/delete`）——
// 删除不给独立动词是为了让「被引用 / 区间非法」这类失败能带**业务码**的信封返回，
// 而不是裸 HTTP 状态码（理由同 `api/wecomWebhooks.ts::deleteWeComWebhook`）。
//
// ⚠️ **路径里的 id 一律 `encodeURIComponent` 包一层**：雪花 ID 虽然是数字串，但这条路径
// 同时吃 POST body 里的 id 形态，统一包一层避免将来出现非数字 id 时漏转义。
//
// ⚠️ **区间口径（`from` / `to`）在前后端各夹一次**：后端要求 `from <= to` 且跨度 ≤ 366 天
// （越界 21904），前端月历翻页 / 区间删除也要照此夹紧——越界请求会白跑一趟往返才被拒。
//
// 守门点分工（CLAUDE.md「Zod schema-first」）：**本文件零 parse**，只发请求 + 类型标注。
// 出参的逐字段对账由页面侧守门 schema 承担（有 queryFn / mutationFn 承载的那一侧）——
// parse 返回深拷贝，多一层等于每屏数据被校验并克隆两遍。

import { api, cleanParams } from '@/api/http';
import type {
  CreateShiftPayload,
  HrCalendarDayInput,
  HrCalendarDaysDeletePayload,
  HrCalendarRangeQuery,
  HrShiftCalendarDayInput,
  ListHrShiftsParams,
  ShiftDeactivatePayload,
  UpdateShiftPayload,
} from '@/types/hr';
import type {
  HrCalendarDaysResult,
  HrShiftCalendarResult,
  HrShiftListResult,
  ShiftOut,
} from '@/api/hr.contract';

/**
 * 查全局日历日行（`GET /api/v2/hr/calendar/days?from=&to=`）。
 *
 * 区间必填（`from <= to`、跨度 ≤ 366 天，越界 21904）。返回的每一行都带 `derived`：
 * true = 该天没有显式行、按星期兜底推出来的（见 `CalendarDayOut`）。
 *
 * 失败抛 `ApiError`：40101 未登录 / 403 无 `hr.view` 权限点 / **21904 区间非法**。
 */
export async function listHrCalendarDays(
  range: HrCalendarRangeQuery,
): Promise<HrCalendarDaysResult> {
  const resp = await api.get<HrCalendarDaysResult>('/hr/calendar/days', {
    params: cleanParams({ from: range.from, to: range.to }),
  });
  return resp.data;
}

/**
 * 批量写全局日历日行（`POST /api/v2/hr/calendar/days`）。
 *
 * 请求体 `{ items: HrCalendarDayInput[] }`，**全量 upsert**（同一天重复出现以最后一条为准）。
 * `CUSTOM_LEAVE` 的行**必填 `name`**。
 *
 * ⚠️ **返回 `Promise<void>`**：后端返 `R<()>`，信封 `data` 是 `null` —— 凭空造一个返回值
 * 就是谎称「后端回了我什么」。成功与否由 HTTP 状态码 / 业务码表达，写后失效由调用方做。
 *
 * 失败抛 `ApiError`：40101 未登录 / 403 无 `hr.schedule.manage` / **21905 未知日型** /
 * **21907 `CUSTOM_LEAVE` 缺 name** / 40001 字段缺失或 `cal_date` 格式非法。
 */
export async function saveHrCalendarDays(payload: { items: HrCalendarDayInput[] }): Promise<void> {
  await api.post<null>('/hr/calendar/days', payload);
}

/**
 * 删全局日历日行（`POST /api/v2/hr/calendar/days/delete`）。
 *
 * 两种口径：`{ dates: [...] }` 点删，或 `{ from, to }` 删整个区间（后端按两者并集处理）。
 * 区间口径受同一区间约束（`from <= to`、跨度 ≤ 366 天，越界 21904）。
 *
 * ⚠️ 删的是**显式行**：被删的那天会重新落回「按星期推导」的兜底日型（`derived: true`），
 * 而不是变成「没有这天」。
 *
 * ⚠️ **返回 `Promise<void>`**（后端返 `R<()>`，`data` 是 `null`，理由同
 * `saveHrCalendarDays`）。
 *
 * 失败抛 `ApiError`：40101 未登录 / 403 无 `hr.schedule.manage` / **21904 区间非法**。
 */
export async function deleteHrCalendarDays(payload: HrCalendarDaysDeletePayload): Promise<void> {
  await api.post<null>('/hr/calendar/days/delete', payload);
}

/**
 * 班次列表（`GET /api/v2/hr/shifts?include_inactive=`）。
 *
 * `include_inactive` 缺省 = 只返启用班次；停用是软删，行仍在库里。
 *
 * 失败抛 `ApiError`：40101 未登录 / 403 无 `hr.view` 权限点。
 */
export async function listHrShifts(params: ListHrShiftsParams = {}): Promise<HrShiftListResult> {
  const resp = await api.get<HrShiftListResult>('/hr/shifts', {
    params: cleanParams({ include_inactive: params.include_inactive }),
  });
  return resp.data;
}

/**
 * 建班次（`POST /api/v2/hr/shifts`），返回建完之后的那一行。
 *
 * `segments` 是**绝对时钟轴**（`HH ∈ 0..48`，夜班 22:00→次日 02:00 写 `'22:00'→'26:00'`），
 * 逐档口径见 `types/hr.ts::ShiftSegmentOut`。
 *
 * 失败抛 `ApiError`：40101 未登录 / 403 无 `hr.schedule.manage` / **21902 编码重复** /
 * **21903 时段非法**（格式 / 零长段 / 乱序 / 重叠 / 首段 ≥ 24:00 / 超 48:00 / 空数组 / 超 6 段）/
 * **21908 总跨度 > 24:00**。
 */
export async function createHrShift(payload: CreateShiftPayload): Promise<ShiftOut> {
  const resp = await api.post<ShiftOut>('/hr/shifts', payload);
  return resp.data;
}

/**
 * 改班次（`POST /api/v2/hr/shifts/{id}`），返回改完之后的那一行。
 *
 * @param payload `version` **必填**（OCC 锚，取该行当前的 `version`；缺省是 axum 的 HTTP 422
 *   纯文本，拿不到业务码）。可选列缺省 = 不改；**显式传 `null` 才是清空**可空列
 *   （`color` / `remark`）—— 表单提交时别把这两种情况混成一个 `null`。
 *
 * 失败抛 `ApiError`：40101 未登录 / 403 无 `hr.schedule.manage` / **21901 班次不存在或已软删** /
 * **21902 编码重复** / **21903 时段非法** / **21906 班次已停用** / **21908 总跨度 > 24:00** /
 * 40901 OCC 冲突。
 */
export async function updateHrShift(id: string, payload: UpdateShiftPayload): Promise<ShiftOut> {
  const resp = await api.post<ShiftOut>(`/hr/shifts/${encodeURIComponent(id)}`, payload);
  return resp.data;
}

/**
 * 停用班次（`POST /api/v2/hr/shifts/{id}/deactivate`），返回停用之后的那一行。
 *
 * **软删**：行仍在库里（`is_active: false`），只是不再出现在新建考勤的选择项里；查列表要带
 * `include_inactive=true` 才看得见。本域**没有**物理删除端点。
 *
 * @param payload `version` **必填**（OCC 锚，取该行当前的 `version`）。
 *
 * 失败抛 `ApiError`：40101 未登录 / 403 无 `hr.schedule.manage` / **21901 班次不存在或已软删** /
 * **21906 班次已停用**（重复停用）/ 40901 OCC 冲突。
 */
export async function deactivateHrShift(
  id: string,
  payload: ShiftDeactivatePayload,
): Promise<ShiftOut> {
  const resp = await api.post<ShiftOut>(`/hr/shifts/${encodeURIComponent(id)}/deactivate`, payload);
  return resp.data;
}

/**
 * 查某班次的日历（`GET /api/v2/hr/shifts/{id}/calendar?from=&to=`）。
 *
 * 每行同时给全局日型（`global_day_type`）与叠加本班次覆盖后的最终日型
 * （`effective_day_type`），并用 `is_override` 标出「这天有本班次的覆盖行」——
 * 渲染读最终日型，标注「与全局不同」读 `is_override` + 两个日型对比。
 *
 * 区间必填（越界 21904）。
 *
 * 失败抛 `ApiError`：40101 未登录 / 403 无 `hr.view` / **21901 班次不存在或已软删** /
 * **21904 区间非法**。
 */
export async function getHrShiftCalendar(
  id: string,
  range: HrCalendarRangeQuery,
): Promise<HrShiftCalendarResult> {
  const resp = await api.get<HrShiftCalendarResult>(
    `/hr/shifts/${encodeURIComponent(id)}/calendar`,
    { params: cleanParams({ from: range.from, to: range.to }) },
  );
  return resp.data;
}

/**
 * 批量写某班次的日历覆盖行（`POST /api/v2/hr/shifts/{id}/calendar/days`）。
 *
 * 请求体 `{ items: HrShiftCalendarDayInput[] }`（本域行带 `remark`、不带 `name`），
 * 全量 upsert。删掉某天不用发请求，走下面那条 delete。
 *
 * ⚠️ **返回 `Promise<void>`**（后端返 `R<()>`、`data` 是 `null`，理由同 `saveHrCalendarDays`）。
 *
 * 失败抛 `ApiError`：40101 未登录 / 403 无 `hr.schedule.manage` / **21901 班次不存在或已软删** /
 * **21905 未知日型** / **21906 班次已停用** / 40001 字段缺失。
 */
export async function saveHrShiftCalendarDays(
  id: string,
  payload: { items: HrShiftCalendarDayInput[] },
): Promise<void> {
  await api.post<null>(`/hr/shifts/${encodeURIComponent(id)}/calendar/days`, payload);
}

/**
 * 删某班次的日历覆盖行（`POST /api/v2/hr/shifts/{id}/calendar/days/delete`）。
 *
 * 口径与全局那条 delete 同形（`{ dates }` 点删 or `{ from, to }` 区间删）。
 * 删掉覆盖行后，那天重新落回**全局日历**的日型（`is_override` 转 false）——不是变成空白。
 *
 * ⚠️ **返回 `Promise<void>`**（理由同 `saveHrCalendarDays`）。
 *
 * 失败抛 `ApiError`：40101 未登录 / 403 无 `hr.schedule.manage` / **21901 班次不存在或已软删** /
 * **21904 区间非法** / **21906 班次已停用**。
 */
export async function deleteHrShiftCalendarDays(
  id: string,
  payload: HrCalendarDaysDeletePayload,
): Promise<void> {
  await api.post<null>(`/hr/shifts/${encodeURIComponent(id)}/calendar/days/delete`, payload);
}
