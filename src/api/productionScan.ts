// 报工台（工人扫码台）域前端 API（v2，baseURL `/api/v2`，前缀 `/prod/scan/*`）。
//
// 2026-10-10 域搬迁：报工台的 5 个端点从 `parts` 域（两条 list）与 `prod::workers` /
// `prod::batch`（三条写）整体迁进后端新建的 `prod::scan` 域，URL **硬切无 alias**：
// 见 `productionScan.contract.ts` 顶部的「新旧 URL 对照表」与部署顺序警告。
// 旧路径的失效响应码分别是 405（verify-badge，method 不再匹配）与 404（其余四条）。
//
// 分层取舍（照 `productionQueue.ts` 同款形态）：本文件**不做** Zod 守门。守门 schema 随
// 报工台视图目录走（`views/production/scan/composables/scanSchema.ts`，与 dashboard 域 /
// queue 域同款），api 层 import 它就是 api → views 的反向依赖。故这里的函数一律返回
// 契约 DTO，守门由消费方 composable 在 queryFn / mutationFn 里
// `xxxSchema.parse(await fetchXxx())` 完成 —— 效果等价，且守门点与「谁驱动渲染」落在同一层。
//
// ⚠️ **两条 list 的过滤键必须发 JSON 字符串**（后端 `deserialize_i64` 只吃 string，
// 发数字或漏传 → axum `QueryRejection` → **HTTP 400 纯文本**，不进 `R<T>` 信封）。
// `workTypeId` / `workerId` 的类型就是 `string`，调用方不要 `Number()`。
//
// 2026-10-15 新增「扫码找件 · 自助恢复三件套」：`fetchScanLocate`（只读诊断，
// `GET /prod/scan/locate`）+ `takeOverBatch` / `receiveFromOutsource`（两个写端点）。
// 它们是报工台三页「扫到 0 匹配」时的兜底出口 —— 旧兜底走 `GET /parts/by-serial/{sn}`，
// 而那条端点的后端闸门不含 `SHELF_ACCOUNT`，工人一体机账号恒 403；报工台自有的 8 个端点
// 全部放行它。逐字段契约见 `./productionScan.contract.ts` 末尾的同名小节。

import { ApiError, api, cleanParams } from '@/api/http';
import type {
  ScanHeldParams,
  ScanListResultDto,
  ScanLocateParams,
  ScanLocateResultDto,
  ScanOutsourceReceiveRequest,
  ScanOutsourceReceiveResultDto,
  ScanPickableParams,
  ScanPickUpRequest,
  ScanPickUpResultDto,
  ScanTakeOverRequest,
  ScanTakeOverResultDto,
  ScanWorkerBriefDto,
  ScanWorkerRequest,
  ScanWorkerResultDto,
} from './productionScan.contract';

// 只再导出两个入参类型：它们被共享文件 `composables/queries/keys.ts` 以
// `@/api/productionScan` 为路径 import（query 键工厂的入参类型不该让 keys.ts 知道
// contract 文件名）。形态照 `productionQueue.ts` 的 `ListQueuePendingParams`。
export type { ScanHeldParams, ScanPickableParams } from './productionScan.contract';

// 后端错误码：20201 = BIZ_WORKER_NOT_FOUND，20202 = BIZ_WORKER_INACTIVE。
// 这两种是扫描时的「未识别」业务态，findWorkerByBadge 按 null 处理；其它错误原样抛出。
const WORKER_NOT_FOUND = 20201;
const WORKER_INACTIVE = 20202;

/**
 * POST /api/v2/prod/scan/verify-badge —— 按工牌码精确匹配工人（工位扫码台第一步）。
 *
 *  - 命中且在职 → 返回 `ScanWorkerBriefDto`（4 字段，见 contract 的说明：它是扫码
 *    session 的最小投影，**不是**账号管理页那个 12 字段 `WorkerOut`）。
 *  - 不存在 / 已停用 → 返回 `null`（不抛错，调用方按业务决定提示文案）。
 *  - 网络 / 其它错误 → 原样抛 `ApiError`。
 *
 * 权限 = `require_auth()`：MANAGER 与 SHELF_ACCOUNT 都能调（SHELF_ACCOUNT 是报工台的
 * 主用户）。旧实现是「拉一次 `GET /prod/workers?limit=500` 在客户端 `Array.find`」，
 * 那种做法把整张工人表交给无权用户、且给 SHELF_ACCOUNT 留了 403 隐患，已下线。
 */
export async function findWorkerByBadge(badgeCode: string): Promise<ScanWorkerBriefDto | null> {
  const code = badgeCode.trim();
  if (!code) return null;

  try {
    const resp = await api.post<ScanWorkerBriefDto>('/prod/scan/verify-badge', {
      badge_code: code,
    });
    return resp.data;
  } catch (e) {
    if (e instanceof ApiError && (e.code === WORKER_NOT_FOUND || e.code === WORKER_INACTIVE)) {
      return null;
    }
    throw e;
  }
}

/**
 * GET /api/v2/prod/scan/pickable —— 取件页的跨架可领件列表（后端按 `user.shelf_ids` 收口，
 * scoped SHELF_ACCOUNT 只看到自己绑定架上的件）。
 *
 * `workTypeId` 是**必填 query 键**且**必须发字符串**；`limit` / `offset` 可选。
 * ⚠️ 后端 `limit.unwrap_or(50).clamp(1, 200)` —— **不传 limit 默认只返 50 条**，
 * 当「全部」用会静默截断。报工台取件页显式传 200（clamp 上限）取全。
 *
 * 业务错：无（取不到件返回空信封）。
 */
export async function fetchScanPickable(params: ScanPickableParams): Promise<ScanListResultDto> {
  const resp = await api.get<ScanListResultDto>('/prod/scan/pickable', {
    params: cleanParams({
      work_type_id: params.workTypeId,
      limit: params.limit,
      offset: params.offset,
    }),
  });
  return resp.data;
}

/**
 * GET /api/v2/prod/scan/held —— 某工人当前持有的批次列表（放回页 / 送检页 /
 * `HeldPartsBadge` 徽章共用同一份数据）。
 *
 * `workerId` 是**必填 query 键**且**必须发字符串**；`limit` / `offset` 语义同上
 * （默认 50、上限 200，三个消费方都显式传 200）。
 *
 * 业务错：无（无持有件返回空信封）。
 */
export async function fetchScanHeld(params: ScanHeldParams): Promise<ScanListResultDto> {
  const resp = await api.get<ScanListResultDto>('/prod/scan/held', {
    params: cleanParams({
      worker_id: params.workerId,
      limit: params.limit,
      offset: params.offset,
    }),
  });
  return resp.data;
}

/**
 * POST /api/v2/prod/scan/worker-scan —— 放回（RETURNED）/ 送检（INSPECTED）二合一入口。
 *
 * 响应有两个消费点：① `scan.event_type`（放回页的成功文案必须按**响应**分支，不能照
 * 请求说「已放回 → 下一道工序」）；② `refill.taken[]`（同事务自动补料，非空时弹窗告知）。
 *
 * **不带任何货架字段**：`shelf_id` / `target_inspection_shelf_id` 已随「目标货架由后端
 * 按负载自动选」整体删除（见 CLAUDE.md「货架自动选择」）。
 *
 * 失败抛 ApiError：
 *  - 20103 INVALID_TRANSITION：状态机迁移非法；
 *  - 20202 WORKER_INACTIVE：工牌未识别 / 已停用；
 *  - 40001 VALIDATION_ERROR：RETURNED 时 `next_process_id` 缺或非法。
 */
export async function scanWorker(payload: ScanWorkerRequest): Promise<ScanWorkerResultDto> {
  const resp = await api.post<ScanWorkerResultDto>('/prod/scan/worker-scan', payload);
  return resp.data;
}

/**
 * POST /api/v2/prod/scan/batches/{batch_id}/pick-up —— 取件（批次锚定领取）。
 *
 * 三个反直觉约束（逐条理由见 `productionScan.contract.ts::ScanPickUpRequest`）：
 * `version` 发普通 number、`worker_id` 发**工人雪花 ID 字符串**（不是 badge_code）、
 * `quantity` **必须发 JSON 字符串**（发 number 被 axum Json extractor 拒成 422 纯文本）。
 * 缺省 / null `quantity` = 整批，小于总量时后端自动拆批。
 */
export async function pickUpBatch(
  batchId: string,
  payload: ScanPickUpRequest,
): Promise<ScanPickUpResultDto> {
  const resp = await api.post<ScanPickUpResultDto>(
    `/prod/scan/batches/${encodeURIComponent(batchId)}/pick-up`,
    payload,
  );
  return resp.data;
}

/**
 * GET /api/v2/prod/scan/locate —— 扫码找件 · 只读诊断（2026-10-15 新增）。
 *
 * 返回该工单的**全部**批次（含终态）与逐行针对 `workerId` 的可行动作 `action` /
 * 不可行原因 `disabled_reason`。
 *
 * ⚠️ `serial_no` **必带**（缺省 → axum `QueryRejection` → HTTP 400 纯文本）。
 * ⚠️ `worker_id` **可空但本项目三页必发**：不传则 `action` / `disabled_reason` 恒 `null`
 *   （纯位置事实、一颗按钮都拿不到）。它是**字符串**（后端只吃 `str`，发 number → 400）。
 *   为空时经 `cleanParams` 剔掉整个键、绝不发出 `worker_id=` 空串。
 *
 * 业务错：`20101`（工单未命中，HTTP 404，**不回退 `t_assembly`** —— 扫的是装配件序列号
 *  时应提示扫子件）/ `20201`（工人不存在）/ `20202`（工人已停用）。三者都走
 * `ApiError.code` 分流，**不**在本函数内吞掉。
 */
export async function fetchScanLocate(params: ScanLocateParams): Promise<ScanLocateResultDto> {
  const resp = await api.get<ScanLocateResultDto>('/prod/scan/locate', {
    params: cleanParams({
      serial_no: params.serialNo,
      worker_id: params.workerId ?? undefined,
    }),
  });
  return resp.data;
}

/**
 * POST /api/v2/prod/scan/take-over —— 扫码接管（2026-10-15 新增）。
 *
 * `batch_id` 走 body 且**必须发字符串**、`version` **必填且发裸 number**（缺失 → 422
 * 纯文本）；`next_process_id` 仅「链位置推导不出下一道」时必填。
 * 整批接管，不做部分数量（无 `quantity` 键）。
 */
export async function takeOverBatch(
  batchId: string,
  payload: ScanTakeOverRequest,
): Promise<ScanTakeOverResultDto> {
  // ⚠️ `batch_id` 走 **body** 而不是 path 段（后端 TakeOverRequest.batch_id 是 body
  // 字段）；形参 `batchId` 是它的权威来源并覆盖 payload 同名字段，避免两个真相源。
  // ⚠️ `next_process_id` / `note` **键缺省就不发**（不是发 null）：这两个是后端
  // `Option<String>` + `#[serde(default)]`，发 null 与不发等价，但「不发」让
  // 「链能自推、所以本次没带工序」这件事在请求体上直接可读。
  const body: ScanTakeOverRequest = {
    version: payload.version,
    badge_code: payload.badge_code,
    batch_id: batchId,
    ...(payload.next_process_id != null ? { next_process_id: payload.next_process_id } : {}),
    ...(payload.note != null ? { note: payload.note } : {}),
  };
  const resp = await api.post<ScanTakeOverResultDto>('/prod/scan/take-over', body);
  return resp.data;
}

/**
 * POST /api/v2/prod/scan/outsource-receive —— 外协确认收回（2026-10-15 新增）。
 *
 * 形态与 take-over 逐字同款（`batch_id` 字符串、`version` 裸 number 必填）；
 * 语义上 `next_process_id` 是**显式覆盖**：`chain_state === 'NEXT'` 时也必须把 locate 行
 * 的 `next_process_id` 原样回传（写侧缺省推导口径与读侧在稀疏链上不等价）。
 */
export async function receiveFromOutsource(
  batchId: string,
  payload: ScanOutsourceReceiveRequest,
): Promise<ScanOutsourceReceiveResultDto> {
  // 与 take-over 逐字同款：batch_id 走 body、形参是权威来源；next_process_id 键缺省不发。
  const body: ScanOutsourceReceiveRequest = {
    version: payload.version,
    badge_code: payload.badge_code,
    batch_id: batchId,
    ...(payload.next_process_id != null ? { next_process_id: payload.next_process_id } : {}),
  };
  const resp = await api.post<ScanOutsourceReceiveResultDto>('/prod/scan/outsource-receive', body);
  return resp.data;
}
