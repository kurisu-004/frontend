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
//
// 2026-10-15 新增「扫码找件 · 自助恢复三件套」的前端契约（locate 只读诊断 +
// take-over / outsource-receive 两个写端点）。这三个端点是报工台三页「扫到 0 匹配」
// 时的兜底出口：旧兜底走 `GET /parts/by-serial/{sn}`，而那条端点的后端闸门不含
// `SHELF_ACCOUNT`，工人一体机账号恒 403；报工台自有的 8 个端点全部放行它。
// ⚠️ 后端 `docs/api/scan.md` 是本节的权威来源，按小节指：逐字段见「逐字段 · locate /
// take-over / outsource-receive」三节，action 取值与写侧守卫的对照见「口径表 · locate 的
// action 决策表与写侧守卫对照」，前端接线清单见「表依赖 · 前端配套改动清单」里的
// 「扫码找件诊断前端接入 / 扫码接管前端接入 / 外协确认收回前端接入」三条。

import type { QueueRefillResultDto } from './productionQueue.contract';
import type { PartOutDto } from './parts/crud';

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
 *  相对上一版（40 字段 `PartListItem`）砍掉 23 个键（`applicant_name` / `request_date` /
 * `customer_id` / `assembly_id` / `status` / `order_no` / `note` / `unit_price` /
 * `total_price` / `version` / `created_at` / `created_by` / `updated_at` / `updated_by` /
 * `deleted_at` / `customer_name` / `l1_customer_name` / `holder_name` / `row_type` /
 * `has_children` / `child_count` / `has_cnc_program` / `delivered_quantity`）：那两个端点的
 * 取行 SQL 从来不投影它们，取出来的是 service 层写死的占位值（`'IN_PROCESS'` / `"0"` /
 * `1970-01-01` / `None`），留在契约里只会诱导消费方去读假值。**后端多发这些键会被 Zod
 * strip 掉**，不报错。
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
  /**
   * 本次流转的数量（2026-10-11）。**必须发 JSON 字符串** —— 后端
   * `deserialize_i64_opt` 只解 `str`，发 number 拿到的是 **HTTP 422 纯文本**
   * （不进 `R<T>` 信封，响应里没有 `code` 字段），与同域 `ScanPickUpRequest.quantity`
   * 同款。三种落法：缺省 / `null` / `>= batch.quantity` = 整批不拆；
   * `0 < q < batch.quantity` = 后端**自动拆批**，本次流转作用在**新批次**上，
   * 余量留在工人手上（`location='WORKER'` 不变，只扣数量 + `version+1`）；
   * `<= 0` 或 `> batch.quantity` ⇒ 业务码 20111。
   *
   * ⚠️ **拆批场景下响应 `scan.batch_id` 是新批次**，不是请求里那个：前端绝不能再拿
   * 请求里的 batch_id 回显或推后继动作。
   */
  quantity?: string | null;
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
 *  故这里复用 part 域的窄投影 `PartOutDto`（**10 字段**，后端 `part/vo/part.rs::PartOut`）
 *  —— type-only 导入、编译期擦除。**别与 `PartDetailDto` 混用**：后者是
 *  `GET /parts/{id}` 等端点返回的 28 字段详情 VO，后端这个端点一个字段都不返
 *  （订正前本文件声明的就是它）。也**别与本文件的 `ScanListItemDto` 混用** ——
 *  后者是报工台两条 list 专用的 17 字段窄投影。 */
export type ScanPickUpResultDto = PartOutDto;

// ============================================================
// 2026-10-15 新增：扫码找件 · 自助恢复三件套的 wire 契约。
// 后端权威来源：`docs/api/scan.md` 的「逐字段」一节里 locate / take-over /
// outsource-receive 三个小节，与「口径表」一节里 locate 的 action 决策表那节。
//
// 四个贯穿本节的形态事实（写错就线上炸，逐条有后端护栏单测钉着）：
//   1. **雪花 id 一律 JSON 字符串**（`serialize_i64` / `serialize_i64_opt`）：入参侧
//      `batch_id` / `next_process_id`（query 侧 `worker_id`）只吃 `str`，发 number
//      得到的是 axum 提取器的 **422 / 400 纯文本**、不进 `{code,message,data}` 信封
//      ⇒ 不能落进「`code != 0`」的错误分支，调用方连业务码都读不到；
//   2. **`version` / `batch_no` / `quantity` 是裸 number**（i32，无自定义反序列化器），
//      方向与第 1 条相反；
//   3. **`next_process_id` 在 locate 出参里是可空字符串**（`null`，**不是** `"0"` 兜底 ——
//      那是同域两条 list 的 `chain_next_process_id` 口径，诊断行刻意分叉）；
//   4. 两个写端点的 `version` **必填**：缺失 → HTTP 422 纯文本。
// ============================================================

/** `GET /api/v2/prod/scan/locate` 的 query 入参。
 *
 *  `serialNo` **必填**且**必发**（缺省 → axum `QueryRejection` → HTTP 400 纯文本）；
 *  `trim()` 后为空串由后端按「未命中」处理（业务码 `20101` / HTTP 404）。
 *
 *  `workerId` 可选，但**本项目三页都必须发**：`locate` 只在传了它时才计算可行动作
 *  `action` / 不可行原因 `disabled_reason`，不传则两者恒 `null`（纯位置事实、拿不到
 *  按钮）。它是**字符串**（后端 `deserialize_i64_opt` 只吃 `str`，发 number → 400 纯文本）。 */
export interface ScanLocateParams {
  serialNo: string;
  workerId?: string | null;
}

/** `locate` 诊断行里的可行动作（4 个 wire 字面量，`SCREAMING_SNAKE_CASE`）。
 *
 *  它只回答「**这个工人**、**这一批**，现在能做什么」，**不是**写侧守卫本身 ——
 *  写侧还会做各自的 OCC / 存在性校验。`null` 时读 `disabled_reason`。
 *  ⚠️ 后端另有 9 个 `disabled_reason` 字面量，其中 `PROCESS_CHAIN_REQUIRED` 已随
 *  外协收回写端点落地被删除（假阻挡），前端 `switch` 里不要留该分支。 */
export type LocateActionValue = 'PICK_UP' | 'MINE' | 'TAKE_OVER' | 'RECEIVE_FROM_OUTSOURCE';

/** `locate` 诊断行里的「不能点」原因（**9 个** wire 字面量）。
 *
 *  分组语义与判定优先级（状态类 → 工种未绑定 → 工序 ∉ 工种 → 容量）逐条对齐后端
 *  `decide_action` 决策表；`UNKNOWN` 是后端没见过的状态 / 位置组合的保守出口。 */
export type LocateDisabledReasonValue =
  /** 批次 `PROGRAMMING`：待编程，指引找 CNC 编程。 */
  | 'PROGRAMMING'
  /** 批次 `INSPECTION`：在品检，指引找品检。 */
  | 'INSPECTION'
  /** `READY_TO_SHIP` / `DELIVERED` / `COMPLETED` / `CANCELLED`：终态。 */
  | 'TERMINAL'
  /** 工人未绑工种（除 `MINE` 外一切动作都不可行）。 */
  | 'WORK_TYPE_NOT_SET'
  /** 推导出的下一道工序不在该工种的活跃工序映射里。 */
  | 'PROCESS_NOT_IN_WORK_TYPE'
  /** 有链但链内没有未软删 step ⇒ 写侧没有可落的链首（对位写侧 `20702`）。 */
  | 'PROCESS_CHAIN_STEP_NOT_FOUND'
  /** 该工人持有的批次已达工种上限 `max_held_batches`（对位写侧 `20204`）。 */
  | 'WORKER_HOLD_LIMIT_EXCEEDED'
  /** 工种未配 `max_held_batches`（`NULL` = 未配置，对位写侧 `20904`）。 */
  | 'WORK_TYPE_MAX_HELD_NOT_SET'
  /** 状态 / 位置组合不在决策表内（保守出口，出现即需补表）。 */
  | 'UNKNOWN';

/** `locate` 的工单侧最小投影（**7 字段**）。 */
export interface LocatePartBriefDto {
  /** part id，**雪花 ID 字符串**。 */
  id: string;
  /** `t_part.serial_no`（可空列；本端点按序列号命中 ⇒ 实际恒非空）。 */
  serial_no: string | null;
  name: string;
  drawing_no: string;
  is_urgent: boolean;
  /** 计划交付日（`t_part.planned_delivery_date`，真实值非占位）。 */
  planned_delivery_date: string;
  /** 系统推算交付日（可空列）。 */
  system_delivery_date: string | null;
}

/** `locate` 的一行批次诊断（**16 字段**，键名即网络契约）。
 *
 *  行单位是**批次**，覆盖该 part 的**全部未软删批次**（含终态）：找件场景里「这批被
 *  取消了」本身就是要回答的事实。它与同域两条 list 的 `ScanListItem` **刻意不复用**：
 *  列表行被状态 / 位置 / 持有人过滤且 `location` 恒 null，本行 `location` 是真实值
 *  （它就是「件在哪个位置」的答案本身）。 */
export interface LocateBatchItemDto {
  /** 批次 id，**雪花 ID 字符串**。两个写端点的批次锚（原样回传）。 */
  batch_id: string;
  /** `t_part_batch.batch_no`（零件内递增；拆批产生的同号行由 batch_id 兜底）。**裸 number**。 */
  batch_no: number;
  /** `t_part_batch.quantity`（批次数量，不是工单数量）。**裸 number**。 */
  quantity: number;
  /** `t_part_batch.status` **原文透出**（含终态、含可能的脏值）；分类结论在
   *  `action` / `disabled_reason`，本键只作展示与排查。 */
  status: string;
  /** `t_part_batch.version`（OCC 锚，两个写端点必填）。**裸 number**。 */
  version: number;
  /** 位置真实值（`PRODUCTION_SHELF` / `WORKER` / `OUTSOURCE_COMPANY` /
   *  `INSPECTION_SHELF` / `OFFICE` / `NULL`），**不是** list 端点那个恒 null 的占位。 */
  location: string | null;
  /** 持有人显示名：`COALESCE(t_shelf.name, t_worker.name, t_outsource_company.name)`。 */
  holder_display: string | null;
  /** 批次当前工序名（走 `current_process_id` 权威列；工序被软删时 null；出池过的
   *  `INSPECTION` / `DELIVERED` 批次按「出池清该列」不变式恒 null）。 */
  current_process_name: string | null;
  /** 链位置三值（`"NONE"` / `"NEXT"` / `"TAIL"`），与同域 `/held` 的 `chain_state` 同源。 */
  chain_state: string;
  /** 链内推导出的下一道工序 id。**可空字符串**，不是 `"0"` 兜底（诊断行用 `null`
   *  表达「没有下一道」）；仅 `chain_state === 'NEXT'` 时非空。 */
  next_process_id: string | null;
  /** 下一道工序名（下一道工序被软删时 id 仍有值、名字 null）。 */
  next_process_name: string | null;
  /** `t_part_batch.updated_at`（位置事实的新鲜度）。 */
  updated_at: string;
  /** 仅外协批次（`status='OUTSOURCE'`）：在途公司名；非外协批次恒 null。 */
  company_name: string | null;
  /** 仅外协批次：该批次**开口 shipment**（`status='OUTSOURCING'`）的发出时间。 */
  sent_at: string | null;
  /** 针对 query 里那个工人的可行动作；未传 `worker_id` 时恒 null。 */
  action: LocateActionValue | null;
  /** 不能点 `action` 的原因；`action` 非空或未传 `worker_id` 时恒 null。 */
  disabled_reason: LocateDisabledReasonValue | null;
}

/**
 * 2026-10-16 新增：本次诊断里**当前工人的工种可执行的工序**清单。
 *
 * 为什么是诊断出参的一部分、而不是让前端自己去拉工序表再按工种过滤：工种↔工序
 * 映射（`t_work_type_process`）只有后端有一份权威读口，前端过滤就等于在第二处复制
 * 「这个工种能干什么」的判据，而它与写端点的闸门（工序必须落在工种映射内）必须同源
 * 才不会漂。
 *
 * 它是**顶层数组**（不在任何一行 batch 内）：候选集对本次诊断的每一行都相同，
 * 按行重复只会让人误以为不同行的候选不同。
 */
export interface LocateProcessBriefDto {
  /** 工序 id，**雪花 ID 字符串形态** —— 后端用 `serialize_i64` 发，前端发成 number
   *  会被写端点的 `deserialize_i64` 拒成 400 纯文本，任何地方都不得 `Number()` 转它。 */
  process_id: string;
  code: string;
  name: string;
  /** `INHOUSE` 自产 / `OUTSOURCE` 外协。⚠️ **本联合类型是给读代码的人看的意图声明，不是
   *  运行时闸门** —— 守门侧（`views/production/scan/composables/scanSchema.ts` 的
   *  `locateProcessBriefSchema`）刻意用 `z.string()` 而不锁枚举，理由见那里的注释（2026-10-16
   *  review 第 1 轮）。别拿本行去把 Zod 改回 `z.enum`。 */
  category: 'INHOUSE' | 'OUTSOURCE';
}

/** `GET /api/v2/prod/scan/locate` 出参：`part` + **全部**批次 + 工种工序候选。
 *
 *  **不分页、无上限**（找件场景要一次看全），顺序即 `batch_no ASC, id ASC`
 *  （件数递增 + 拆批兜底），前端不必二次排序。
 *
 * `worker_processes` 是**恒存在的键**、值可以是空数组：未传 `worker_id`、工人未绑
 *  工种、工种未映射任何工序、**工种只映射了已软删工序**（2026-10-16 review 第 2 轮
 *  MINOR-1 登记：读侧闸门用含已软删工序的**宽集合**判「这行可不可点」，出参发的是未软删的
 *  **窄集合** ⇒「行可点 + 候选为空」是后端自己认可的形态，不是边角），四种情形都是 `[]`
 *  （不是 null、不是缺键）。手填下一道工序的选择范围由它决定。 */
export interface ScanLocateResultDto {
  part: LocatePartBriefDto;
  batches: LocateBatchItemDto[];
  worker_processes: LocateProcessBriefDto[];
}

/** `POST /api/v2/prod/scan/take-over`（扫码接管）请求。
 *
 *  场景：批次仍挂在**别的**工人名下，但图纸 / 实物已流转到这位工人手里 ⇒ holder 换成
 *  我、顺手推进到我工种下的下一道工序，同一事务原子完成。**整批接管，不做部分数量。** */
export interface ScanTakeOverRequest {
  /** 批次锚，**必须发字符串**（后端 `deserialize_i64` 只吃 `str`，发 number → 422 纯文本）。
   *
   *  ⚠️ **调用方不必自己填它、填了也不作数**：`takeOverBatch(batchId, payload)` 组装
   *  请求体时一律写形参 `batchId`，本字段在 payload 里传的值会被**整个丢弃**（不是合并，
   * 两者不一致时发出去的是形参那个）。本字段仍声明在这里，是因为它属于 wire 契约（后端
   *  body 的必填键）—— 路径参数与 body 字段承载的是同一个批次锚。 */
  batch_id: string;
  /** **接管人**（扫码人）工牌码。旧持有人由批次行的 `current_holder_id` 决定，
   *  客户端不需要、也不应该指定。 */
  badge_code: string;
  /** 批次 OCC 锚，**必填且发裸 number**（缺失 → 422 纯文本；不一致 → `40901`）。 */
  version: number;
  /** 接管后要推进到的工序，**字符串**。
   *  - `chain_state === 'NEXT'`：**可省略**（后端按链自推）。
   *  - 其余形态（无链 / 链尾 / 指针漂移）：**必填**，缺失 → `40001`；有链但该工序不在
   *    链内 → `20702`。 */
  next_process_id?: string | null;
  /** `t_part_event.note` 的附加备注；缺省时事件备注自动写「接管自 worker {旧持有人 id}」。 */
  note?: string | null;
}

/** `POST /api/v2/prod/scan/take-over` 出参（**7 个 JSON 键**，键名即网络契约）。
 *
 *  后端另有一个 `#[serde(skip)]` 的内部管道字段 `synced_assembly_id`
 *  （handler 在 commit 后补发 `ASSEMBLY_UPDATED` 用）**不在 JSON 里**，别自己加。 */
export interface ScanTakeOverResultDto {
  /** 被接管的批次，雪花 ID 字符串。 */
  batch_id: string;
  /** 所属工单，雪花 ID 字符串。 */
  part_id: string;
  /** **旧**持有人（接管前批次行上的 `current_holder_id`，服务端层面恒非空）。 */
  from_worker_id: string;
  /** **新**持有人（扫牌反查出的接管人）。 */
  to_worker_id: string;
  /** 接管后批次落到哪道工序。 */
  next_process_id: string;
  /** 目标工序在链内的 step id；**无链时为 null**（不是 `"0"` 兜底）。 */
  next_process_step_id: string | null;
  /** 接管**后**的批次锚（= 客户端传值 + 1）。**裸 number**，继续用作下一次动作的 OCC。 */
  version: number;
}

/** `POST /api/v2/prod/scan/outsource-receive`（外协确认收回）请求。
 *
 *  场景：件实际已从外协回厂，但库里批次仍停在 `OUTSOURCE + OUTSOURCE_COMPANY` 挂在公司
 *  名下 ⇒ 一步「收回落自动选架 + 立刻交到扫码工人手上」，同一事务原子完成。
 *  **整批动作，没有 `quantity`，也没有 `note`。** */
export interface ScanOutsourceReceiveRequest {
  /** 批次锚，**必须发字符串**（与 take-over 同款）。
   *
   *  ⚠️ 与 `ScanTakeOverRequest.batch_id` 同一条纪律：请求体里这个键一律取
   *  `receiveFromOutsource` 的形参 `batchId`，调用方在 payload 里传的值会被**整个丢弃**。 */
  batch_id: string;
  /** 收回人（扫码人）工牌码；收回后立刻交到这位工人手上。 */
  badge_code: string;
  /** 批次 OCC 锚，**必填且发裸 number**。 */
  version: number;
  /** 收回后要落到的工序，**字符串**。语义与 take-over **不同**：这里是可选的
   *  **显式覆盖**（传了就用），缺省才按链推导。
   *  - ⚠️ `chain_state === 'NEXT'` 时**也必须把 locate 行的 `next_process_id` 原样回传**：
   *    写侧缺省推导的口径是 `sort_order = 当前 + 1`，与读侧 `sort_order > 当前 LIMIT 1`
   *    **在稀疏链上不等价** ⇒ 省略会在稀疏链 / part 无链但指针存活的形态上吃 `20706` /
   *    `40001`。
   *  - `chain_state !== 'NEXT'`（含无链）：前端应弹手填；无链且缺省 → `40001`。 */
  next_process_id?: string | null;
}

/** `POST /api/v2/prod/scan/outsource-receive` 出参（**6 个 JSON 键**，键名即网络契约）。
 *
 *  后端另有一个 `#[serde(skip)]` 的内部管道字段 `picked_quantity`（handler 在 commit 后
 *  补发 `PART_PICKED_UP` 用）**不在 JSON 里**，别自己加。 */
export interface ScanOutsourceReceiveResultDto {
  /** 被收回的批次，雪花 ID 字符串。 */
  batch_id: string;
  /** 所属工单，雪花 ID 字符串。 */
  part_id: string;
  /** **新**持有人（扫牌反查出的收回人）。 */
  worker_id: string;
  /** **收回前**的在途公司（批次行收回前的 `current_holder_id`，服务端层面恒非空）。 */
  company_id: string;
  /** 收回后批次落到哪道工序。 */
  next_process_id: string;
  /** 收回 + 交人**两段写之后**的批次锚（**由库写后读回**，不是请求的 `version + 2`）。
   *  **裸 number**，继续用作下一次动作的 OCC。 */
  version: number;
}
