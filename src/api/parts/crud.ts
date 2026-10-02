// 后端零件 API 封装 —— 单件 CRUD + 生命周期（生产/扫码/品检/外协/返修/打印等）。
// 2026-09-15 Phase 5：业务全切 v2，`api`（baseURL `/api/v2`）默认客户端。
// 打印 2 端点（print-drawing / print-drawing-batch）保留 v1，走 `apiPrint`，
// 在 ./file.ts 单独声明，本文件不重复 export。
// 所有 ID 在前端是字符串（雪花 ID 经后端 IdStr 序列化）。
// 2026-08-25：从原 1165 行 api/parts.ts 拆分到 ./ 子文件；本文件是 ./crud 子域。
//
// 跨子域类型引用：InspectionBatchListResult 定义在 ./batch（listRepairBatches /
// listRepairingBatches 是单件 lifecycle，但响应形态与品检待办一致）。用 `import type`
// 顶置避免 inline import 的可读性问题；type-only 导入是擦除的，运行时无循环代价。
//
// 2026-10-01：`listPendingProgramming`（GET /parts/pending-programming，恒返空）已删除，
// 唯一 caller 是「待编程一览」页，数据源迁到 prod 域 `GET /prod/programming/pending`
// （api/programming.ts）。本文件不再 import partListResultSchema（随该函数一并移除）。

import { api, cleanParams, normalizeListResult } from '@/api/http';
import { inspectionBatchListResultSchema } from '@/composables/queries/schemas';
import type { OutsourceSendableListResult } from '@/types/outsource';
import type {
  LocationTreeNode,
  OrderStatus,
  PartEventType,
  PartListItem,
  PartRowTypeFilter,
  PartSortKey,
  SortDir,
} from '@/types/parts';
import type { InspectionBatchListResult } from './batch';

export interface PartItem {
  id: string;
  version: number;
  serial_no: string | null;
  name: string;
  drawing_no: string;
  quantity: number;
  planned_delivery_date: string;
  is_urgent: boolean;
  status: OrderStatus;
  /** PR-F 2026-07-17：送货单字段 */
  order_no: string | null;
  system_delivery_date: string | null;
  note: string | null;
  customer_name: string | null;
  parent_customer_name: string | null;
  customer_path: string | null;
  // PR-2 2026-09-16 t_part 瘦身：part 级 actual_delivery_date / current_holder_id /
  // placed_at / delivery_note_id / has_been_repaired 随后端列下线删除；连带仅服务
  // 「所属送货单卡」的 delivery_note_no / delivery_note_status 一并移除（该卡已删，
  // 批次级送货单号由 PartBatchMonitorCard 经 t_part_batch 字段展示）。
  assembly_id: string | null;
  current_holder_kind: 'shelf' | 'worker' | 'outsource_company' | null;
  shelf_code: string | null;
  worker_name: string | null;
  /** holder 是外协公司时的公司名（2026-07-15 接入） */
  outsource_company_name: string | null;
  location: string | null;
  /** 后端 service/part.py:3675-3684 生成的当前位置描述：货架 A-01 / 品检 A-01 / 工人 张三 / 外协 公司名 / 编程员持有。仅用于「扫描错页」等展示用途，不参与业务校验。 */
  current_holder_display?: string | null;
  /** 下一道工序 id（NULL = 未设置） */
  next_process_id: string | null;
  /** 下一道工序名称（NULL = 未设置；由后端在 list/get 响应中带出） */
  next_process_name: string | null;
  /** 2026-09-16 新增：工艺链 id（雪花 ID 字符串；null = 未制定工序）。
   *  与后端 PartDetailOut flatten 出参对齐（GET /parts/{id} 详情同源新增）。 */
  process_chain_id?: string | null;
  /**
   * 2026-07-21：该 part 最近一次品检打回（INSPECTION_FAILED）事件的 note。
   * 格式：`"打回到货架：<code> 下一工序：<code> | 备注：<note>"`。
   * 仅 PICK_UP 扫码列表返回（后端 list_for_work_type* 走 LEFT JOIN LATERAL 计算），
   * 其它端点为 null。
   */
  last_inspection_fail_note?: string | null;
  /** 2026-07-29 批次化：批次级列表（扫码台/品检待办）填充；quantity 为批次量 */
  batch_id?: string | null;
  batch_no?: number | null;
  batch_label?: string | null;
}

export interface PartListResult {
  items: PartListItem[];
  total: number;
  limit: number;
  offset: number;
  // 2026-09-25 备注：backend-rust PartListOut 当前走 serialize_i64 → JSON 字符串；
  // 本 schema 暂保留 number 类型（决定权在 frontend，是 backend-rust 后续要修的契约点）。
  // 实际接收响应时由 listParts 等 caller 在响应包装层用
  // @/api/http.normalizeListResult 包一层，把 string 兜底成 number。schema 类型本身
  // 不变，避免大改所有调用方。
}

/** 雪花 ID 字符串（CLAUDE.md §3 — 19 位 > JS Number.MAX_SAFE_INTEGER） */
export interface ListPartsParams {
  customer_id?: string;
  statuses?: OrderStatus[];
  is_urgent?: boolean;
  /**
   * 2026-08-20：图号 / 名称拆为两个独立 ILIKE 子串参数（替换原 keyword 在 /parts 列表的用法）。
   * 两个参数同时设 ⇒ AND 联合（drawing_no ILIKE AND name ILIKE）。
   * keyword 字段由其他端点（outsource picker；2026-10-01 起「待编程一览」走 prod 域
   * GET /prod/programming/pending，该端点有自己的入参类型）继续使用。
   */
  drawing_no?: string;
  name?: string;
  /**
   * 2026-08-20：原 /parts 列表主路径不再使用；保留供 listOutsourceSendable
   * 等其他端点继续使用（与后端 PartListQuery.keyword 兼容）。
   */
  keyword?: string;
  /** 2026-07-22：订单号独立搜索（ILIKE 包含 %kw%）。 */
  order_no?: string;
  /**
   * 2026-07-31：序列号独立搜索（ILIKE 包含 %kw%）。
   * 命中子件也算命中（子件 serial_no 形如 {父装配}-{i:02d}）；
   * 装配件行通过 EXISTS 子件命中自动带出母装配件。
   */
  serial_no?: string;
  /**
   * 仅返回「曾外协过」的零件（2026-07-20 新增，外协接收历史页用）。
   * 命中条件由后端 EXISTS 子查询判定（SENT_TO_OUTSOURCE / RECEIVED_FROM_OUTSOURCE
   * / INSPECTED + note ILIKE '%外协%'）。
   */
  has_outsource_history?: boolean;
  /** 2026-07-21 PR-F：请购日期区间（含端点；任一端点为空表示半开） */
  request_date_from?: string;
  request_date_to?: string;
  /** 2026-07-22：计划交期区间（含端点；任一端点为空表示半开） */
  planned_delivery_date_from?: string;
  planned_delivery_date_to?: string;
  /** 2026-07-21 PR-F：系统交期区间（含端点；任一端点为空表示半开；NULL 字段视为落在区间内） */
  system_delivery_date_from?: string;
  system_delivery_date_to?: string;
  /**
   * 2026-08-11：订单号空白筛选（对应前端 checkbox「仅空白订单号」）。
   * - true  ⇒ 仅空白（NULL OR ''），覆盖 order_no 子串搜索
   * - false ⇒ 仅非空（NULL AND != '' 排除）
   * - undefined / 不传 ⇒ 任意（沿用默认）
   */
  order_no_is_null?: boolean;
  /**
   * 2026-08-11：系统交期空白筛选（对应前端 checkbox「仅空白系统交期」）。
   * - true  ⇒ 仅 NULL，区间失效
   * - false ⇒ 仅非 NULL，区间仍生效
   * - undefined / 不传 ⇒ 任意（区间默认排除 NULL，Bug 1 修复后）
   */
  system_delivery_date_is_null?: boolean;
  /** 2026-08-01：下一道工序多选（雪花 ID 字符串，禁止 Number() 转换——会丢精度；空=全部；NULL 工序自然被排除） */
  next_process_ids?: string[];
  /** 2026-08-01：物理位置多选（OFFICE/PRODUCTION_SHELF/WORKER/INSPECTION_SHELF/OUTSOURCE_COMPANY；空=全部） */
  locations?: string[];
  /**
   * 2026-08-05：具体 holder 多选（货架/工人/外协公司，雪花 ID 字符串）。
   * 与 `locations` 是 OR 关系——命中 `locations` 大类 OR 任一 `holder_ids` 都算中。
   * 用于「所在位置」树形筛选收窄到具体 holder。
   */
  holder_ids?: string[];
  /**
   * 2026-08-05：行类型筛选（ALL/PART/ASSEMBLY），默认 ALL。
   * 后端 list_with_filters 默认行为兼容；ALL 时含装配件。
   *（2026-09-28：后端 modules/part/service/crud.rs::list_parts 真正合并；此前一直忽略此字段）
   */
  row_type?: PartRowTypeFilter;
  sort_by?: PartSortKey;
  sort_dir?: SortDir;
  limit?: number;
  offset?: number;
  /** 2026-07-30：零件一览合并装配件（2026-09-28：后端真正合并；此前一直忽略） */
  include_assemblies?: boolean;
}

export interface PartCreatePayload {
  name: string;
  drawing_no: string;
  applicant_name?: string;
  /**
   * 申请人表 id（雪花 ID 字符串）。
   * 必须是字符串：雪花 ID 19 位 > JS Number.MAX_SAFE_INTEGER（2^53-1），
   * 用 number 类型会在 JSON 序列化时丢精度，后端拿不到原值。
   */
  applicant_id?: string | null;
  quantity?: number;
  /** 2026-09-27 前后端字段对齐：unit_price 改 string（rust_decimal::Decimal +
   *  serde-with-str 序列化对齐）；后端会按 Decimal 精度 parse 字符串）。 */
  unit_price?: string;
  total_price?: string | null;
  request_date: string;
  planned_delivery_date: string;
  is_urgent?: boolean;
  /** PR-F 2026-07-17：送货单字段 */
  order_no?: string | null;
  system_delivery_date?: string | null;
  note?: string | null;
  /** 雪花 ID 字符串（CLAUDE.md §3） */
  customer_id: string;
}

export interface PartStatusChangePayload {
  status: OrderStatus;
}

export interface PartUpdatePayload {
  /** 2026-09-28 契约修复：乐观锁必填。后端 `PartUpdateRequest.version: i32` **无
   *  `#[serde(default)]`**（backend-rust `src/modules/part/dto_crud.rs`），缺字段时
   *  axum `Json` extractor 在进 handler 前直接拒 → HTTP 422
   *  `missing field version`（非项目统一信封）。必须取自 `PartItem.version` /
   *  `PartListItem.version`（= t_part.version）。 */
  version: number;
  name?: string;
  drawing_no?: string;
  applicant_name?: string;
  quantity?: number;
  /** 2026-09-27 前后端字段对齐：unit_price 改 string（rust_decimal::Decimal +
   *  serde-with-str 序列化对齐）。空串会被 `Decimal::from_str("")` 拒（40001），
   *  调用侧须先归一为 `'0'`。 */
  unit_price?: string;
  /** 2026-09-28：后端 `part_sql.rs::update_part` **不按 quantity*unit_price 重算**
   *  （只写 caller 传的值），故改数量/单价时必须由前端算好一并送，否则 DB 总价留旧值。 */
  total_price?: string;
  request_date?: string;
  planned_delivery_date?: string;
  is_urgent?: boolean;
  /** PR-F 2026-07-17：送货单字段 */
  order_no?: string | null;
  system_delivery_date?: string | null;
  note?: string | null;
}

export interface PartPickUpPayload {
  serial_no: string;
  shelf_id: string;
  badge_code: string;
  /** 2026-07-29 批次化：目标批次 id（扫码台卡片回传） */
  batch_id?: string | null;
  /** 领取数量；缺省 = 批次全量 */
  quantity?: number | null;
}

export interface PartScanPayload {
  serial_no: string;
  event_type: PartEventType;
  shelf_id: string;
  badge_code: string;
  target_inspection_shelf_id?: string | null;
  /** 仅 RETURNED 需要；工人指定的下一道工序 id */
  next_process_id?: string | null;
  /** 2026-07-29 批次化：目标批次 id（扫码台卡片回传） */
  batch_id?: string | null;
  /** 归还/送检数量；缺省 = 批次全量 */
  quantity?: number | null;
}

export interface PartEvent {
  id: string;
  part_id: string;
  /** 2026-07-29 批次化：事件归属批次（NULL = 工单级事件） */
  batch_id: string | null;
  batch_no: number | null;
  /** 本次事件涉及的数量 */
  quantity: number | null;
  worker_id: string | null;
  worker_name: string | null;
  event_type: string;
  from_status: string | null;
  to_status: string | null;
  drawing_code: string | null;
  badge_code: string | null;
  note: string | null;
  created_by: string | null;
  operator_username: string | null;
  // 2026-07-17：操作者姓名（display_name）；前端 UI 默认用它，username 仅作 fallback
  operator_name: string | null;
  created_at: string;
}

// axios 会自动丢掉 undefined/null；但空串不会丢（会触发 LIKE '%%'）。
// 空字符串过滤统一在 @/api/http 的 cleanParams 里实现（2026-08-25 refactor）。

export async function listParts(params: ListPartsParams = {}): Promise<PartListResult> {
  const resp = await api.get<PartListResult>('/parts', { params: cleanParams(params) });
  // 2026-09-27 前后端字段对齐：listParts 套一层 normalizeListResult 把分页字段
  // 兜底成 number（与 customer.ts / iam.ts / worker.ts / outsource.ts 现有 4 个
  // 文件的写法对齐）。后端本 PR 已把 PartListOut.total / limit / offset 切到
  // JSON number，但 normalizeListResult 仍保留作为防御层（其它 9 个 list 端点
  // wire-format 行为不一致，列表 wrapper 统一兜底是最稳的解）。
  return normalizeListResult(resp.data);
}

/**
 * 零件一览「所在位置」树（GET /parts/location-tree）。
 *
 * 父节点 5 个固定大类（OFFICE/PRODUCTION_SHELF/WORKER/INSPECTION_SHELF/OUTSOURCE_COMPANY），
 * 叶节点是具体的货架/工人/外协公司（`id` 为雪花 ID 字符串，`location=null`）；
 * OFFICE 无叶子。后端只返当前可见（active + 未软删）的 holder。
 */
export async function getPartLocationTree(): Promise<{ items: LocationTreeNode[] }> {
  const resp = await api.get<{ items: LocationTreeNode[] }>('/parts/location-tree');
  return resp.data;
}

export async function getPart(id: string): Promise<PartItem> {
  const resp = await api.get<PartItem>(`/parts/${id}`);
  return resp.data;
}

export async function createPart(payload: PartCreatePayload): Promise<PartItem> {
  const resp = await api.post<PartItem>('/parts', payload);
  return resp.data;
}

export async function changePartStatus(
  id: string,
  payload: PartStatusChangePayload,
): Promise<PartItem> {
  const resp = await api.post<PartItem>(`/parts/${id}/change-status`, payload);
  return resp.data;
}

// 2026-10-02：以下 lifecycle 端点的操作对象是**批次**（t_part_batch），路由锚点
// 统一迁到 prod 域 `POST /api/v2/prod/batches/{batch_id}/<action>`，故第一形参一律是
// batchId，payload 里的 batch_id 一并删除（它已是路径参数）。part 域只留
// 「多批次动作 + part 级动作」（cancel / force-complete / soft-delete / batches 读）。

export interface PlaceOnShelfPayload {
  shelf_id: string;
  /** 下一道工序 id（必填） */
  next_process_id: string;
  note?: string | null;
}

export async function placeOnShelf(
  batchId: string,
  payload: PlaceOnShelfPayload,
): Promise<PartItem> {
  const resp = await api.post<PartItem>(
    `/prod/batches/${encodeURIComponent(batchId)}/place-on-shelf`,
    payload,
  );
  return resp.data;
}

// 2026-09-29 清理：删除 `sendToProgramming`（PENDING → PROGRAMMING，PENDING→CNC 编程）
// 与 `recallToProgramming`（ON_SHELF → PROGRAMMING）。CNC 编程入口已统一迁到
// 「待编程一览」（cnc/PendingProgrammingList，含 chain 含 CNC 工序的所有 part，
// 不再依赖 part.status='PROGRAMMING'），后端 `POST /api/v2/parts/{id}/send-to-programming`
// 与 `/recall-to-programming` 端点 404 下线。原 code 路径下：
//   - PENDING → PROGRAMMING：文员发编程 → 改走「待编程一览」自动包含 chain 含 CNC 的 PENDING 零件；
//   - ON_SHELF → PROGRAMMING：M/CNC 召回 → 由工人在「生产队列」+「待品检」手动介入。
// 若未来需要重新上线，文员可走「下发零件 → 直接下生产货架」 + 工艺链自动判定。
//
// 历史沿革：原 sendToProgramming / recallToProgramming 在 2026-07-17 PR-F 引入，
// 2026-08-05 召回工作增加 recallToProgramming；2026-09-29 业务迁移「待编程 Tab 化」后下线。

/** 2026-08-05 召回：ON_SHELF 或 PROGRAMMING → PENDING（Manager；PROGRAMMING 为
 *  历史数据消化场景）。2026-09-29 业务迁移后 PROGRAMMING 状态自该日起被标记为
 *  废弃（无新进入路径），但本端点保留供历史 PROGRAMMING 批次召回。
 *
 *  2026-10-02 迁 prod 域：召回是批次级动作（ON_SHELF/PROGRAMMING 都是批次状态），
 *  路径锚点改为 `{batch_id}`，故 `batch_id` 是路径参数、不再是可选项
 *  ——「缺省按 expect 唯一批次解析」的旧语义已随端点下线。 */
export interface PartRecallPayload {
  note?: string | null;
}

export async function recallToPending(
  batchId: string,
  payload?: PartRecallPayload,
): Promise<PartItem> {
  const resp = await api.post<PartItem>(
    `/prod/batches/${encodeURIComponent(batchId)}/recall-to-pending`,
    payload ?? {},
  );
  return resp.data;
}

// 2026-09-30 新增：系统管理员专属「强制完成」—— 绕过状态机将该工单及所有非取消
// 批次置为 COMPLETED（与正常 `completePart` DELIVERED → COMPLETED 不同）。仅 MANAGER
// 角色可见，按钮守卫由 usePartDispatch.canForceComplete 收口。
export interface ForceCompletePayload {
  note?: string | null;
}

export async function forceCompletePart(
  id: number | string,
  payload?: ForceCompletePayload,
): Promise<PartItem> {
  const resp = await api.post<PartItem>(`/parts/${id}/force-complete`, payload ?? {});
  return resp.data;
}

/** 释放编程完成 batch 到生产架：PROGRAMMING → IN_PROCESS。
 *  PROGRAMMING 状态自 2026-09-29 起被标记为废弃（无新进入路径），但本端点保留
 *  供历史 PROGRAMMING 数据消化。
 *  调用方：
 *    1. PendingProgrammingList.vue「下发」按钮（仅历史 PROGRAMMING 数据可见）；
 *  2. usePartCncGroups.onReleaseToShelf（零件详情页 CNC 卡片，针对历史数据）。
 *
 *  2026-10-02 迁 prod 域：PROGRAMMING 是批次状态，锚点改 `{batch_id}`。 */
export async function releaseFromProgramming(
  batchId: string,
  shelfId: string,
  nextProcessId: string,
): Promise<PartItem> {
  const resp = await api.post<PartItem>(
    `/prod/batches/${encodeURIComponent(batchId)}/release-from-programming`,
    {
      shelf_id: shelfId,
      next_process_id: nextProcessId,
    },
  );
  return resp.data;
}

/** 2026-10-02 已知缺口（v1 遗留，待单独修）：本函数**本次不改**。
 *
 *  后端 v2 的领取端点是批次锚定的 `POST /api/v2/prod/batches/{batch_id}/pick-up`，
 *  而本函数打的是 `/parts/pick-up`（1 段，v1 形状），payload
 *  `PartPickUpPayload { serial_no, shelf_id, badge_code, batch_id?, quantity? }`
 *  与 v2 `PickUpRequest { version, worker_id, shelf_id, note }` 不同构：v1 是
 *  「扫序列号 + 工牌」，v2 是「按批次 + OCC + 工人」。两者映射是业务决策、不是机械
 *  路径迁移，故本次只登记不改，调用方（ScanPickParts.vue）同步保持原样。 */
export async function pickUpPart(payload: PartPickUpPayload): Promise<PartItem> {
  const resp = await api.post<PartItem>('/parts/pick-up', payload);
  return resp.data;
}

export async function scanPart(payload: PartScanPayload): Promise<PartItem> {
  const resp = await api.post<PartItem>('/parts/scan', payload);
  return resp.data;
}

/**
 * 扫码台 RETURN / INSPECT 二合一入口。
 *
 * 后端 `POST /api/v2/prod/batches/worker-scan`（rust prod 域 batch 域 worker_scan：
 * 2026-10-02 由 `POST /api/v2/parts/worker-scan` 迁来）：
 *  - event_type=RETURNED  → mark_returned（IN_PROCESS+WORKER → ON_SHELF/PROCESS）
 *  - event_type=INSPECTED → mark_inspected（INSPECTION → INSPECTED/INSPECTION_FAILED）
 *
 * 单一端点替代 v1 的 `POST /parts/scan?event_type=...`（v1 Python 仍在维护，旧 v1
 * `scanPart` 路径保留为兼容兜底；新前端流程推荐 worker-scan）。
 *
 * 入参：
 *  - serial_no: 序列号
 *  - badge_code: 工牌码
 *  - event_type: 'RETURNED' | 'INSPECTED'
 *  - shelf_id: 目标货架雪花 ID 字符串（RETURNED=生产架 / INSPECTED=品检架）
 *  - next_process_id?: 仅 RETURNED 必填；工人手动输入下一道工序
 *  - target_inspection_shelf_id?: 仅 INSPECTED 必填；品检架 id
 *  - batch_id?: 可选；多批次歧义时显式指定
 *
 * 失败抛 ApiError：
 *  - 20103 INVALID_TRANSITION：状态机迁移非法
 *  - 20202 WORKER_INACTIVE：工牌未识别 / 已停用
 *  - 20401 / 20403 等
 */
export interface WorkerScanPayload {
  serial_no: string;
  badge_code: string;
  event_type: 'RETURNED' | 'INSPECTED';
  /** 雪花 ID 字符串（CLAUDE.md §3）；RETURNED=生产架 / INSPECTED=品检架 */
  shelf_id: string;
  /** 仅 RETURNED 必填 */
  next_process_id?: string | null;
  /** 仅 INSPECTED 必填 */
  target_inspection_shelf_id?: string | null;
  /** 可选；多批次歧义时显式指定 */
  batch_id?: string | null;
}

export interface WorkerScanOut {
  /** worker_scan_event service 层最小投影 */
  scan: {
    worker_id: string;
    part_id: string;
    batch_id: string;
    event_type: string;
    /** 父装配件 id（仅当 INSPECTED 分支触发父 status 变更时 Some） */
    synced_assembly_id: string | null;
  };
  /** 同事务 WorkerPoolService::refill 结果（前端按需消费） */
  refill: {
    pool_count_by_process: { process_id: string; pool_count: number }[];
    held_batches: unknown[];
  };
}

export async function workerScan(payload: WorkerScanPayload): Promise<WorkerScanOut> {
  // 2026-10-02 迁 prod 域：工人报工的对象是批次（一笔事务改 2 个批次），路径由
  // `POST /parts/worker-scan` 改为 `POST /prod/batches/worker-scan`。**无 Path
  // extractor**，body 逐字不变（`serial_no` 主键 + `batch_id` 可选消歧）。
  const resp = await api.post<WorkerScanOut>('/prod/batches/worker-scan', payload);
  return resp.data;
}

export async function listPartEvents(id: string): Promise<PartEvent[]> {
  const resp = await api.get<PartEvent[]>(`/parts/${id}/events`);
  return resp.data;
}

/** 2026-09-28 契约修复：软删入参 `PartSoftDeleteRequest` 的 `version: i32` 同样必填
 *  （backend-rust `src/modules/part/dto_crud.rs`），此前本函数不发 body → 必 422。
 *  @param version `PartItem.version`（= t_part.version）；不匹配 → 40901。 */
export async function softDeletePart(id: string, version: number): Promise<void> {
  await api.post(`/parts/${id}/soft-delete`, { version });
}

export async function updatePart(id: string, payload: PartUpdatePayload): Promise<PartItem> {
  const resp = await api.post<PartItem>(`/parts/${id}/update`, payload);
  return resp.data;
}

// ============ inspection 体系（2026-08-28 后端路线 B 重构）==============
//
// 2026-10-02：品检流转端点整体迁 prod 域并锚定批次 —— 路径
// `POST /api/v2/parts/{part_id}/<action>` → `POST /api/v2/prod/batches/{batch_id}/<action>`，
// `batch_id` 从 body 删除（已是路径参数），OCC 锚 `t_part_batch.version`。
// 另：`pass-inspection` / `fail-inspection` 两条 v1 Python 遗留路由在 v2 从未注册
// （「待品检」页点这两个按钮报 404 的根因），本文件不再声明对应封装 ——
// 品检通过走 `toShip`、品检打回走 `toProcess`。

/** 扫码快捷品检（PENDING/PROGRAMMING/IN_PROCESS+PRODUCTION_SHELF → INSPECTION）。
 * 事件类型 INSPECTED（pass=true）/ INSPECTION_FAILED（pass=false）。
 *
 * payload 与后端 v2 `ScanInspectRequest` 对齐：`pass` / `target_inspection_shelf_id` /
 * `version` 三者必填（后端无 `#[serde(default)]`，缺任一 → HTTP 422），`shelf_id` /
 * `next_process_id` 仅 pass=false 分支必填。 */
export interface ScanInspectPayload {
  /** 必填；目标品检架 id（雪花 ID 字符串，zone=INSPECTION active）。 */
  target_inspection_shelf_id: string;
  /** 必填；true = 走 INSPECTED（品检通过）/ false = 走 INSPECTION_FAILED（打回）。 */
  pass: boolean;
  /** 必填；t_part_batch.version（OCC 锚），不匹配 → 40901。 */
  version: number;
  /** 仅 pass=false 必填；打回的目标生产货架 id。 */
  shelf_id?: string;
  /** 仅 pass=false 必填；下一道工序 id。 */
  next_process_id?: string;
  /** 可选；品检备注（≤ 500 字符）。 */
  note?: string | null;
  /** 可选；缺省 = 批次全量。 */
  quantity?: number | null;
}

export async function scanInspect(
  batchId: string,
  payload: ScanInspectPayload,
): Promise<PartItem> {
  const resp = await api.post<PartItem>(
    `/prod/batches/${encodeURIComponent(batchId)}/scan-inspect`,
    payload,
  );
  return resp.data;
}

/** 外协回收直送品检（OUTSOURCE → INSPECTION，外协接收 tab 的「品检」分支）。
 *
 * 2026-10-02 改名：原名 `toInspection` 打的是
 * `POST /parts/{id}/receive-from-outsource-to-inspection`，与「送检」端点
 * `POST /prod/batches/{batch_id}/to-inspection`（本文件下方 `toInspection`）是两个
 * 不同端点，同名极易误用，故按端点语义改名。schema 仍为 `shelf_id`（不是
 * `target_inspection_shelf_id`）。 */
export interface ReceiveFromOutsourceToInspectionPayload {
  /** 必填；目标品检货架 id（雪花 ID 字符串，zone=INSPECTION active）。 */
  shelf_id: string;
  /** 必填；t_part_batch.version（OCC 锚）。 */
  version: number;
  /** 可选；回收后自动通过品检。 */
  auto_pass_inspection?: boolean;
  note?: string | null;
}

export async function receiveFromOutsourceToInspection(
  batchId: string,
  payload: ReceiveFromOutsourceToInspectionPayload,
): Promise<PartItem> {
  const resp = await api.post<PartItem>(
    `/prod/batches/${encodeURIComponent(batchId)}/receive-from-outsource-to-inspection`,
    payload,
  );
  return resp.data;
}

/** 单件送检（多状态 → INSPECTION）。后端 `ToInspectionRequest`：
 *  `target_inspection_shelf_id` / `version` 必填，`quantity` / `note` 选填。
 *  ⚠️ 与上面的 `receiveFromOutsourceToInspection`（外协回收直送品检）不是同一端点。 */
export interface ToInspectionPayload {
  /** 必填；目标品检货架 id（雪花 ID 字符串，zone=INSPECTION active）。 */
  target_inspection_shelf_id: string;
  /** 必填；t_part_batch.version（OCC 锚）。 */
  version: number;
  quantity?: number | null;
  note?: string | null;
}

export async function toInspection(
  batchId: string,
  payload: ToInspectionPayload,
): Promise<{ part: PartItem; new_batch_id: string | null }> {
  const resp = await api.post<{ part: PartItem; new_batch_id: string | null }>(
    `/prod/batches/${encodeURIComponent(batchId)}/to-inspection`,
    payload,
  );
  return resp.data;
}

/** 品检通过（INSPECTION → READY_TO_SHIP，可选自动拆批）。
 *  后端 `ToShipRequest`：`version` 必填（OCC 锚 t_part_batch），
 *  `quantity` / `note` 选填。`new_batch_id` 非 null = 部分数量触发拆批，
 *  值是 remainder 批次 id（≠ 入参 batchId），调用方应据此刷新批次列表。 */
export interface ToShipPayload {
  /** 必填；t_part_batch.version。 */
  version: number;
  quantity?: number | null;
  note?: string | null;
}

export async function toShip(
  batchId: string,
  payload: ToShipPayload,
): Promise<{ part: PartItem; new_batch_id: string | null }> {
  const resp = await api.post<{ part: PartItem; new_batch_id: string | null }>(
    `/prod/batches/${encodeURIComponent(batchId)}/to-ship`,
    payload,
  );
  return resp.data;
}

/** 品检打回 / 指定下一道工序（INSPECTION → IN_PROCESS）。事件类型 INSPECTION_FAILED。
 *  后端 `ToProcessRequest`：`shelf_id` / `next_process_id` / `version` 三者必填
 *  （缺任一 → HTTP 422），`quantity` / `note` 选填。
 *  返修中批次（`is_repairing = true`）后端返 20118 返修守卫，走通用 catch 弹原文。 */
export interface ToProcessPayload {
  /** 必填；打回的目标生产货架 id。 */
  shelf_id: string;
  /** 必填；下一道工序 id。 */
  next_process_id: string;
  /** 必填；t_part_batch.version（OCC 锚），不匹配 → 40901。 */
  version: number;
  /** 可选；部分数量；缺省 = 批次全量。 */
  quantity?: number | null;
  /** 可选；品检员填的不合格原因等（写入 t_part_event.note，事件历史一览可见）。 */
  note?: string | null;
}

export async function toProcess(
  batchId: string,
  payload: ToProcessPayload,
): Promise<{ part: PartItem; new_batch_id: string | null }> {
  const resp = await api.post<{ part: PartItem; new_batch_id: string | null }>(
    `/prod/batches/${encodeURIComponent(batchId)}/to-process`,
    payload,
  );
  return resp.data;
}

/** READY_TO_SHIP → DELIVERED：发货（文员/管理员手动）。
 *  2026-10-02 迁 prod 域：批次锚定 + `version` 必填（OCC 锚 t_part_batch）。 */
export interface DeliverPayload {
  version: number;
  note?: string | null;
}

export async function deliverPart(batchId: string, payload: DeliverPayload): Promise<PartItem> {
  const resp = await api.post<PartItem>(
    `/prod/batches/${encodeURIComponent(batchId)}/deliver`,
    payload,
  );
  return resp.data;
}

/** 扫码台：司机确认发货（PR-C 2026-07-10）。
 *  2026-10-02 迁 prod 域：`POST /parts/scan/deliver-part` → `POST /prod/batches/scan/deliver`。
 *  body 不变 —— 服务端按 serial_no + status 解析目标批次，无 path 参数。 */
export interface ScanDeliverPartPayload {
  part_id: string;
  worker_badge_code: string;
}

export async function scanDeliverPart(payload: ScanDeliverPartPayload): Promise<PartItem> {
  const resp = await api.post<PartItem>('/prod/batches/scan/deliver', payload);
  return resp.data;
}

/** DELIVERED → COMPLETED：确认完成，释放流水号。
 *  2026-10-02 迁 prod 域：批次锚定 + `version` 必填（OCC 锚 t_part_batch）。 */
export interface CompletePayload {
  version: number;
  note?: string | null;
}

export async function completePart(batchId: string, payload: CompletePayload): Promise<PartItem> {
  const resp = await api.post<PartItem>(
    `/prod/batches/${encodeURIComponent(batchId)}/complete`,
    payload,
  );
  return resp.data;
}

/** → REPAIRING：开始返修（INSPECTION/READY_TO_SHIP/DELIVERED 进入）。
 *  2026-10-02 迁 prod 域：批次锚定，`batch_id` 已是路径参数（部分返修由 quantity 表达）。 */
export interface StartRepairPayload {
  version: number;
  reason?: string | null;
  note?: string | null;
}
export async function startPartRepair(
  batchId: string,
  payload: StartRepairPayload,
): Promise<PartItem> {
  const resp = await api.post<PartItem>(
    `/prod/batches/${encodeURIComponent(batchId)}/start-repair`,
    payload,
  );
  return resp.data;
}

/** REPAIRING → ON_SHELF / INSPECTION：返修完成（PR-M 2026-08-04）。
 *
 * - shelf.zone=PRODUCTION → REPAIRING → ON_SHELF（需 next_process_id）
 * - shelf.zone=INSPECTION → REPAIRING → INSPECTION（无需 next_process_id）
 *
 * 2026-10-02 迁 prod 域：批次锚定；`shelf_id` 从 query 参数移入 body
 * （后端 `CompleteRepairRequest` 是 body DTO，旧实现的 `params: { shelf_id }`
 *  与之不同构）。
 */
export interface CompleteRepairPayload {
  /** 必填；目标货架 id（zone 决定落 ON_SHELF 还是 INSPECTION）。 */
  shelf_id: string;
  /** 必填；t_part_batch.version（OCC 锚）。 */
  version: number;
  next_process_id?: string | null;
  note?: string | null;
}
export async function completePartRepair(
  batchId: string,
  payload: CompleteRepairPayload,
): Promise<PartItem> {
  const resp = await api.post<PartItem>(
    `/prod/batches/${encodeURIComponent(batchId)}/complete-repair`,
    payload,
  );
  return resp.data;
}

/** 返修接收 Tab·已送货（DELIVERED 批次；PR-M 2026-08-04）。
 *
 * 2026-08-25 注：返回类型 InspectionBatchListResult 定义在 ./batch（listRepairBatches
 * 是单件 lifecycle 端点，但响应形态与品检待办一致）；用 type-only 跨子域引用。
 *
 * 2026-10-02 补 Zod 守门：此前是 `return resp.data` 零校验，与同形态的
 * listInspectionBatches（./batch:333）不一致。三个端点
 * （inspection-batches / repair-batches / repairing-batches）**共用同一个 Rust VO**
 * `InspectionBatchListItemOut`（backend-rust vo/inspection.rs 头注明确写了这点），
 * 所以共用同一个 schema 是契约事实、不是复用偷懒。零守门的代价是这次踩到的坑：
 * `is_repairing`（2026-10-01 后端 M5 恒输出）没被 schema 声明时，
 * `listInspectionBatches` 整页抛 unrecognized_keys 白屏，而本函数会**静默**把
 * 多出来的键丢掉 —— 同一个契约漂移在两个调用点表现完全相反，最难排查。
 * 守门只在这一处（不在 useXxxQuery 里再 parse —— Zod parse 是深拷贝，两处都做
 * 等于白拷一次）。 */
export async function listRepairBatches(
  params: {
    keyword?: string;
    serial_no?: string;
    customer_id?: string;
    limit?: number;
    offset?: number;
  } = {},
): Promise<InspectionBatchListResult> {
  // 2026-10-02 迁 prod 域：与已有的 `GET /prod/batches/pending` 并列，
  // 路径 `/parts/repair-batches` → `/prod/batches/repair`（无 path 参数）。
  const resp = await api.get<unknown>('/prod/batches/repair', {
    params: cleanParams(params),
  });
  return inspectionBatchListResultSchema.parse(resp.data) as InspectionBatchListResult;
}

/** 返修接收 Tab·返修中（PR-M 2026-08-04）。
 *
 * 2026-10-02 补 Zod 守门，理由同 listRepairBatches（共用 InspectionBatchListItemOut VO
 * + 本函数此前零校验）。注意本端点的过滤判据 2026-10-01 起已从
 * `status='REPAIRING'` 改为 `is_repairing = true`（migration 005）——
 * 响应行的 `status` 恒为 `IN_PROCESS`，**不要**再靠 status 判「返修中」。 */
export async function listRepairingBatches(
  params: {
    keyword?: string;
    serial_no?: string;
    customer_id?: string;
    limit?: number;
    offset?: number;
  } = {},
): Promise<InspectionBatchListResult> {
  // 2026-10-02 迁 prod 域：`/parts/repairing-batches` → `/prod/batches/repairing`。
  const resp = await api.get<unknown>('/prod/batches/repairing', {
    params: cleanParams(params),
  });
  return inspectionBatchListResultSchema.parse(resp.data) as InspectionBatchListResult;
}

/** PR-M 2026-08-04 续：一步式返修下发（DELIVERED → REPAIRING → ON_SHELF/INSPECTION）。
 *
 *  2026-10-02 迁 prod 域：批次锚定，`batch_id` 已是路径参数（部分返修由 quantity 表达），
 *  `version` 必填（OCC 锚 t_part_batch）。 */
export interface RepairDispatchPayload {
  shelf_id: string;
  /** 必填；t_part_batch.version（OCC 锚），不匹配 → 40901。 */
  version: number;
  /** 下一道工序（可选；缺省沿用 REPAIRING 携带的下一工序，PRODUCTION 区会校验映射） */
  next_process_id?: string | null;
  reason?: string | null;
  note?: string | null;
  /** 部分数量（可选；缺省 = 批次全量） */
  quantity?: number | null;
}
export async function repairDispatch(
  batchId: string,
  payload: RepairDispatchPayload,
): Promise<PartItem> {
  const resp = await api.post<PartItem>(
    `/prod/batches/${encodeURIComponent(batchId)}/repair-dispatch`,
    payload,
  );
  return resp.data;
}

export async function cancelPart(id: string): Promise<PartItem> {
  const resp = await api.post<PartItem>(`/parts/${id}/cancel`);
  return resp.data;
}

export async function getPartBySerial(serialNo: string): Promise<PartItem> {
  const resp = await api.get<PartItem>(`/parts/by-serial/${encodeURIComponent(serialNo)}`);
  return resp.data;
}

/**
 * 扫码台 PICK_UP 列表：列出指定工种在指定货架上可领的零件。
 * 排序：加急优先 → 临期优先 → id 降序。
 */
export async function listPartsByWorkType(
  workTypeId: string,
  shelfId: string,
): Promise<PartItem[]> {
  const resp = await api.get<PartItem[]>(`/parts/by-work-type/${encodeURIComponent(workTypeId)}`, {
    params: { shelf_id: shelfId },
  });
  return resp.data;
}

/**
 * 共享 HMI PICK_UP 跨架列表（2026-07-10）。
 * 列出**所有**生产货架上、该工种可领的零件。
 * 排序与 `listPartsByWorkType` 一致。
 * 2026-09-16 PR-2：出参不再含 part 级 current_holder_id（t_part 瘦身），
 * 扫码提交货架由 useActiveShelfSelection 的选中架兜底。
 */
export async function listPartsByWorkTypeAllShelves(workTypeId: string): Promise<PartItem[]> {
  const resp = await api.get<PartItem[]>(
    `/parts/pickable-by-work-type/${encodeURIComponent(workTypeId)}`,
  );
  return resp.data;
}

/**
 * 扫码台 RETURN 列表：列出某工人当前持有的所有零件（2026-07-10 新流程）。
 * 排序：加急优先 → 临期优先 → id 降序。
 * 入参 workerId 是雪花 ID 字符串。
 */
export async function listPartsHeldByWorker(workerId: string): Promise<PartItem[]> {
  const resp = await api.get<PartItem[]>(`/parts/by-worker/${encodeURIComponent(workerId)}`);
  return resp.data;
}

// ============================================================
// 外协流程（2026-07-15 新增；属单件 lifecycle，归 ./crud）
// ============================================================
export interface SendToOutsourcePayload {
  /** 外协公司 id（雪花 ID 字符串） */
  outsource_company_id: string;
  /** 外协工序 id（雪花 ID 字符串；JS Number 会丢精度） */
  next_process_id: string;
  /**
   * 乐观锁版本号；与目标批次 TPartBatch.version 必须一致，否则返 BIZ_VERSION_CONFLICT 409。
   * 前端从 OutsourceSendableItem.version（批次级 version）取值后传入。
   */
  version: number;
  /**
   * 2026-07-30：部分发送数量；≤ 批次量，缺省 = 批次全量。
   */
  quantity?: number | null;
  note?: string | null;
}

/**
 * PENDING / IN_PROCESS → OUTSOURCE：把零件发送给外协公司。
 * 后端会校验公司存在 + 启用 + 工序 OUTSOURCE + 公司映射了该工序。
 *
 * 2026-10-02 迁 prod 域：发送对象是批次，第一形参由 partId 改 batchId
 * （原 payload 的 `batch_id` 随之删除 —— 它已是路径参数，「缺省按活跃批次猜唯一者」
 * 的旧语义不再存在）。
 */
export async function sendToOutsource(
  batchId: string,
  payload: SendToOutsourcePayload,
): Promise<PartItem> {
  const resp = await api.post<PartItem>(
    `/prod/batches/${encodeURIComponent(batchId)}/send-to-outsource`,
    payload,
  );
  return resp.data;
}

/**
 * 统一外协可发送一览（2026-07-28 新增；取代旧 listDirectOutsourceCandidates /
 * listApprovedForSend 两个端点）：
 * 合并 APPROVAL（需审批 + 有报价）和 DIRECT（无需审批可直发）两类，
 * 每行带 send_mode + source_status 字段。
 */
export async function listOutsourceSendable(
  params: {
    keyword?: string;
    customer_id?: string;
    limit?: number;
    offset?: number;
  } = {},
): Promise<OutsourceSendableListResult> {
  const resp = await api.get<OutsourceSendableListResult>('/parts/outsource-sendable', {
    params: cleanParams(params),
  });
  return resp.data;
}

// 2026-09-25 清理：listDirectOutsourceCandidates 函数（@deprecated 状态）删除。
// 自 2026-07-28 起由 listOutsourceSendable 取代；全仓零调用方。@/types/directOutsource.ts
// 类型文件保留作为归档备查（导出符号未被引用），如未来彻底不再需要可一并删除。

export interface ReceiveFromOutsourcePayload {
  shelf_id: string;
  /** 下一道工序 id（雪花 ID 字符串；JS Number 会丢精度） */
  next_process_id: string;
  /** 必填；t_part_batch.version（OCC 锚），不匹配 → 40901。 */
  version: number;
  /** 2026-07-30：部分接收数量；缺省 = 批次全量 */
  quantity?: number | null;
  note?: string | null;
}

/**
 * OUTSOURCE → IN_PROCESS：从外协回收，下发到生产货架继续加工。
 *
 * 2026-10-02 迁 prod 域：批次锚定（第一形参 batchId），`batch_id` 从 body 删除。
 * 后端 `receive_from_outsource` 复用 `PlaceOnShelfRequest`，故 `version` 必填。
 */
export async function receiveFromOutsource(
  batchId: string,
  payload: ReceiveFromOutsourcePayload,
): Promise<PartItem> {
  const resp = await api.post<PartItem>(
    `/prod/batches/${encodeURIComponent(batchId)}/receive-from-outsource`,
    payload,
  );
  return resp.data;
}
