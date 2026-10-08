// 2026-10-10 新建：报工台（工人扫码台）域前端 wire 契约（types only，无 runtime）。
//
// 端点（baseURL `/api/v2`，前缀 `/prod/scan/*`，**硬切无 alias**）。这 5 条 URL 全部是
// 2026-10-10 的域搬迁产物，旧路径已 404 / 405：
//   POST /api/v2/prod/scan/verify-badge           ← findWorkerByBadge
//                                                  （旧：/prod/workers/verify-badge，405）
//   GET  /api/v2/prod/scan/pickable                ← fetchScanPickable
//                                                  （旧：/parts/pickable-by-work-type/{id}，404）
//   GET  /api/v2/prod/scan/held                    ← fetchScanHeld
//                                                  （旧：/parts/by-worker/{id}，404）
//   POST /api/v2/prod/scan/worker-scan             ← scanWorker
//                                                  （旧：/prod/batches/worker-scan，404）
//   POST /api/v2/prod/scan/batches/{batch_id}/pick-up ← pickUpBatch
//                                                  （旧：/prod/batches/{batch_id}/pick-up，404）
//
// ⚠️ **部署顺序：后端必须先上**。两条 list 的过滤键由 path 改 query，旧前端发的 URL
// 直接 404；报工台三页 + 徽章会同时空白，且失败发生在网络层（不是 Zod 契约漂移），
// 现场只看到一句 axios 错误。
//
// 分层取舍（照 `productionQueue.contract.ts` 两级切分的同款形态）：本文件只放 types，
// 零 runtime 依赖；请求发送在 `./productionScan.ts`，且**不做 Zod 守门** —— 守门点在
// queryFn / mutationFn（`views/production/scan/composables/scanSchema.ts`，
// 见 CLAUDE.md「api 层引域内 schema 的口径」）。
//
// wire 层形态约定：
//   - 两条 list 的过滤键 `work_type_id` / `worker_id` 走 `deserialize_i64`：
//     **只吃 JSON 字符串**，且**必填**。发数字或漏传 → axum `QueryRejection` →
//     **HTTP 400 纯文本**（不进 `R<T>` 信封，响应里没有 `code` 字段，别指望解析业务码）。
//     前端侧由 query hook 的 `enabled` 闸门保证不发空键（键缺失时 query 不跑）。
//   - `limit` / `offset` 是裸 i32 → JSON number。后端 `unwrap_or(50).clamp(1, 200)`：
//     **不传 limit 默认只返 50 条**，当「全部」用会静默截断 ⇒ 消费方一律显式传 200。
//   - 雪花 ID 一律 string（`serialize_i64` / `serialize_i64_opt`），禁止 `Number()`。
//   - `total` / `limit` / `offset` 是裸 i64 → JSON **number**（与雪花 ID 字段相反）。
//   - `planned_delivery_date` 现在是**真实投影值**（不再是 `1970-01-01` 占位符）⇒
//     声明成非 null string，不要拿它判「无交期」。

import type { QueueRefillResultDto } from './productionQueue.contract';
import type { PartItem } from './parts/crud';

/** `GET /api/v2/prod/scan/pickable` 的 query 入参。
 *
 *  `work_type_id` 是**必填**过滤键（雪花 ID 字符串）。前端从 `useScanSession` 的
 *  `worker.work_type_id` 取；工人未分配工种时该值为 null，此时 query hook 用
 * `enabled=false` 闸门**不发请求**（漏传会被后端 `QueryRejection` 拒成 400 纯文本）。
 *  `limit` / `offset` 可选，`cleanParams` 会剔除 undefined。 */
export interface ScanPickableParams {
  workTypeId: string;
  limit?: number;
  offset?: number;
}

/** `GET /api/v2/prod/scan/held` 的 query 入参。`workerId` 必填、雪花 ID 字符串，
 *  闸门理由同 `ScanPickableParams.work_type_id`。 */
export interface ScanHeldParams {
  workerId: string;
  limit?: number;
  offset?: number;
}

/** 两条 list 共用的行 VO。**17 字段**，行单位是**批次**。
 *
 *  相对上一版（39 字段 `PartListItem`）砍掉 22 个键（`applicant_name` / `request_date` /
 *  `customer_id` / `assembly_id` / `status` / `order_no` / `note` / `unit_price` /
 *  `total_price` / `version` / `created_at` / `created_by` / `updated_at` / `updated_by` /
 *  `deleted_at` / `customer_name` / `l1_customer_name` / `holder_name` / `row_type` /
 *  `has_children` / `child_count` / `has_cnc_program`）：那两个端点的取行 SQL 从来不投影
 *  它们，取出来的是 service 层写死的占位值（`'IN_PROCESS'` / `"0"` / `1970-01-01`），
 *  留在契约里只会诱导消费方去读假值。**后端多发这些键会被 Zod strip 掉**，不报错。
 *
 *  取件（pickable）与持有（held）两条端点**共用**本 VO，各字段取值差异见逐字段注释。 */
export interface ScanListItemDto {
  /** part id（雪花 ID 字符串）。行单位是批次但本键仍指 part —— 送检 / 放回的
   *  worker-scan 入参 `serial_no` 之外的批次锚另走 `batch_id`。 */
  id: string;
  serial_no: string | null;
  name: string;
  drawing_no: string;
  quantity: number;
  is_urgent: boolean;
  /** 计划交付日，**真实值**（2026-10-10 起两条端点都投影 `t_part.planned_delivery_date`，
   *  不再是 `1970-01-01` 占位符）。前端只当排序键用，不上屏；上屏走 `system_delivery_date`。 */
  planned_delivery_date: string;
  /** 系统推算交付日，nullable（未推算时 null）。`DeliveryDateChip` 的唯一数据源。 */
  system_delivery_date: string | null;
  /** `t_part.process_chain_id`；未制定工序链时 null。**pickable 恒 null**（取件候选按
   *  工种↔工序映射取，不按链），**held 有真值**。只回答「这个件有没有链」，不回答
   *  「链上的下一步是谁」—— 后者一律读下面四件套。 */
  process_chain_id: string | null;
  /** 派生列：该批次**有制定工序链且链指针未漂移**。报工台两页的列表卡左边框专供这个语义
   *  （规则见 `views/production/scan/chainAccent.ts`）。后端恒发，非 Option。 */
  has_process_chain: boolean;
  /** 工序链派生四件套，**pickable 恒为降级值**（`"NONE"` / `"0"` / null / null），
   *  **held 填真值**：放回页按它分流（`NEXT` 免选工序 / `TAIL` 提示送检 / `NONE` 手选）。 */
  chain_state: string;
  /** 下一道工序 id（雪花 ID 字符串）。`'0'` = 无下一道（`NONE` / `TAIL` 的兜底值，
   *  **不是**真 id）—— 消费侧见到 `'0'` 必须短路，不提交 worker-scan。 */
  chain_next_process_id: string;
  /** `chain_state === 'NEXT'` 时为下一道工序名，其余 null。 */
  chain_next_process_name: string | null;
  /** 当前工序名；解析不出时 null。 */
  chain_current_process_name: string | null;
  /** 批次雪花 id（`serialize_i64_opt` → JSON string）。**两条端点都填**：
   *  取件用它拼 `POST /prod/scan/batches/{batch_id}/pick-up` 的路径参数；
   *  放回 / 送检用它做 worker-scan 的 `batch_id` 入参。 */
  batch_id: string;
  /** 批次 OCC 版本（`t_part_batch.version`），作 pick-up 的 `version` 入参。
   *  ⚠️ 这是**唯一**的批次 OCC 锚：上一版 VO 上那个 part 级 `version` 已随本次收敛删除，
   *  且两个取行 SQL 从来不投影 `t_part.version`（恒 0），拿它当批次版本会 OCC 误判。 */
  batch_version: number | null;
  /** 位置。**两条端点的值恒为 null，但键必须在** —— `BatchPickerDialog.holderText` 用
   *  `'location' in p` 判「这个 VO 带不带 holder 信息」，被 strip 掉会让报工台卡片静默
   *  少掉「未知位置」那一行，且仓内没有测试能提前发现（fixture 自己显式带上了该键）。 */
  location: string | null;
}

/** 两条 list 的出参：分页信封（**不是裸数组**）。消费方必须取 `.items`。
 *  把信封当数组用的症状是 `items.length` 恒 undefined + 排序 composable 的
 *  `[...list]` 抛 `TypeError: list is not iterable` ⇒ 三页 `v-for` 同时渲染失败。 */
export interface ScanListResultDto {
  items: ScanListItemDto[];
  /** 匹配总数，**不受 items 截断影响**。 */
  total: number;
  limit: number;
  offset: number;
}

/** `POST /api/v2/prod/scan/verify-badge` 出参（rust `ScanWorkerBrief`）。**4 字段**。
 *
 *  ⚠️ 与 `WorkerOut`（`@/types/worker.ts`，账号管理页的工人列表 / 详情，**后端未删**）
 *  是**两个不同的 VO**：本 VO 是扫码 session 的最小投影，只够「认工人 + 定工种 + 提交
 *  worker-scan」；管理页还要 `version` / `is_active` / `created_at` / `updated_at`。
 *  两者不可互换，`useScanSession.worker` 声明的是本 VO。 */
export interface ScanWorkerBriefDto {
  id: string;
  badge_code: string;
  name: string;
  /** 工种 id；**未分配工种时为 null**（取件页据此显示「未分配工种」并拒发 pickable 请求）。 */
  work_type_id: string | null;
}

/** `POST /api/v2/prod/scan/worker-scan` 请求（放回 / 送检二合一）。 */
export interface ScanWorkerRequest {
  serial_no: string;
  /** 工牌码（不是 worker_id）—— 后端按工牌定位工人。 */
  badge_code: string;
  /** 客户端发的字面量只有这两个；**响应的 `scan.event_type` 才是 WS 广播名**
   *  （`WORKER_SCAN_RETURNED` / `WORKER_SCAN_INSPECTED`），放回页的成功文案按响应分支。 */
  event_type: 'RETURNED' | 'INSPECTED';
  /** 仅 `RETURNED` 必填（雪花 ID 字符串）；`INSPECTED` 不发。 */
  next_process_id?: string | null;
  /** 多批次歧义时显式指定；不传时后端按 serial_no 解析。 */
  batch_id?: string | null;
}

/** `POST /api/v2/prod/scan/worker-scan` 出参。 */
export interface ScanWorkerResultDto {
  /** worker_scan_event 的 service 层最小投影（逐字对齐后端 `WorkerScanCoreOut`）。 */
  scan: {
    worker_id: string;
    part_id: string;
    batch_id: string;
    /** **WS 广播名**：`WORKER_SCAN_RETURNED` / `WORKER_SCAN_INSPECTED`。
     *  客户端发 `RETURNED`，但当该批次当前工序是工序链最后一道时后端自动改投品检、
     *  回来的是 `WORKER_SCAN_INSPECTED` ⇒ 照请求的 `event_type` 说「已放回 → 下一道」
     *  是错的（工件已被送走），放回页的成功文案必须按本字段分支。 */
    event_type: string;
    /** 父装配件 id（仅当 INSPECTED 分支触发父 status 变更时非 null）。 */
    synced_assembly_id: string | null;
  };
  /** 同事务 queue 域 refill 结果。**与 `POST /prod/queue/refill` 出参是同一个 rust
   *  `RefillResult`**，故直接复用 `QueueRefillResultDto`，不另立一份会漂移的本地结构。
   *  `taken[]` 是本次自动给该工人抢到的批次，放回 / 送检页据此弹窗告知。 */
  refill: QueueRefillResultDto;
}

/** `POST /api/v2/prod/scan/batches/{batch_id}/pick-up` 请求（取件）。
 *
 *  - `version`：**普通 number**（后端 `i32`，无自定义反序列化器）—— 不要转字符串；
 *  - `worker_id`：**工人雪花 ID 字符串**（不是 badge_code；后端按 worker 记录归属）；
 *  - `quantity`：**必须发 JSON 字符串**（后端 `deserialize_i64_opt` 先解
 *    `Option::<String>` 再 parse i64，发 number 被拒成 422 纯文本）；缺省 = 整批，
 *    小于总量时后端自动拆批；
 *  - **不发任何货架字段**：`shelf_id` 已随「目标货架由后端按负载自动选」整体删除。 */
export interface ScanPickUpRequest {
  version: number;
  worker_id: string;
  quantity?: string | null;
  note?: string | null;
}

/** `POST /api/v2/prod/scan/batches/{batch_id}/pick-up` 出参：part 级 `R<PartOut>`。
 *
 *  取件页只用「这次领取成功了」这一事实，行字段本身不消费（提交后走列表失效重拉），
 *  故这里直接复用 part 域的 `PartItem`（`GET /parts/{id}` 等端点返回的同一个 VO，
 *  type-only 导入、编译期擦除）。**注意别与本文件的 `ScanListItemDto` 混用** ——
 *  后者是报工台两条 list 专用的 17 字段窄投影。 */
export type ScanPickUpResultDto = PartItem;
