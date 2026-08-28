// 后端零件 API 封装 —— 单件 CRUD + 生命周期（生产/扫码/品检/外协/返修/打印等）。
// 所有 ID 在前端是字符串（雪花 ID 经后端 IdStr 序列化）。
// 2026-08-25：从原 1165 行 api/parts.ts 拆分到 ./ 子文件；本文件是 ./crud 子域。
//
// 跨子域类型引用：InspectionBatchListResult 定义在 ./batch（listRepairBatches /
// listRepairingBatches 是单件 lifecycle，但响应形态与品检待办一致）。用 `import type`
// 顶置避免 inline import 的可读性问题；type-only 导入是擦除的，运行时无循环代价。

import { api, apiV2, cleanParams } from '@/api/http'
import type {
  DirectOutsourceCandidateListResult,
} from '@/types/directOutsource'
import type {
  OutsourceSendableListResult,
} from '@/types/outsource'
import type {
  LocationTreeNode,
  OrderStatus,
  PartEventType,
  PartListItem,
  PartRowTypeFilter,
  PartSortKey,
  SortDir,
} from '@/types/parts'
import type { InspectionBatchListResult } from './batch'

export interface PartItem {
  id: string
  version: number
  serial_no: string | null
  name: string
  drawing_no: string
  quantity: number
  planned_delivery_date: string
  actual_delivery_date: string | null
  is_urgent: boolean
  status: OrderStatus
  /** PR-F 2026-07-17：送货单字段 */
  order_no: string | null
  system_delivery_date: string | null
  note: string | null
  customer_name: string | null
  parent_customer_name: string | null
  customer_path: string | null
  /** PR-G 2026-07-22：所属送货单（NULL = 未开单；详情页可链接到送货单） */
  delivery_note_id: string | null
  /** PR-G 2026-07-22：所属送货单单号 DN-YYYYMMDD-NNNN（与 detail.batch_fetch 同事务返回） */
  delivery_note_no: string | null
  /** PR-G 2026-07-22：所属送货单状态 */
  delivery_note_status: string | null
  assembly_id: string | null
  current_holder_id: string | null
  current_holder_kind: 'shelf' | 'worker' | 'outsource_company' | null
  shelf_code: string | null
  worker_name: string | null
  /** holder 是外协公司时的公司名（2026-07-15 接入） */
  outsource_company_name: string | null
  location: string | null
  /** 后端 service/part.py:3675-3684 生成的当前位置描述：货架 A-01 / 品检 A-01 / 工人 张三 / 外协 公司名 / 编程员持有。仅用于「扫描错页」等展示用途，不参与业务校验。 */
  current_holder_display?: string | null
  placed_at: string | null
  /** 下一道工序 id（NULL = 未设置） */
  next_process_id: string | null
  /** 下一道工序名称（NULL = 未设置；由后端在 list/get 响应中带出） */
  next_process_name: string | null
  /**
   * 2026-07-21：该 part 最近一次品检打回（INSPECTION_FAILED）事件的 note。
   * 格式：`"打回到货架：<code> 下一工序：<code> | 备注：<note>"`。
   * 仅 PICK_UP 扫码列表返回（后端 list_for_work_type* 走 LEFT JOIN LATERAL 计算），
   * 其它端点为 null。
   */
  last_inspection_fail_note?: string | null
  /** 2026-07-29 批次化：批次级列表（扫码台/品检待办）填充；quantity 为批次量 */
  batch_id?: string | null
  batch_no?: number | null
  batch_label?: string | null
  /** PR-M 2026-08-04：是否经历过返修（用于列表 / 卡片 / 详情显示「返修」标签） */
  has_been_repaired?: boolean
}

export interface PartListResult {
  items: PartListItem[]
  total: number
  limit: number
  offset: number
}

/** 雪花 ID 字符串（CLAUDE.md §3 — 19 位 > JS Number.MAX_SAFE_INTEGER） */
export interface ListPartsParams {
  customer_id?: string
  statuses?: OrderStatus[]
  is_urgent?: boolean
  /**
   * 2026-08-20：图号 / 名称拆为两个独立 ILIKE 子串参数（替换原 keyword 在 /parts 列表的用法）。
   * 两个参数同时设 ⇒ AND 联合（drawing_no ILIKE AND name ILIKE）。
   * keyword 字段由其他端点（pending-programming / outsource picker）继续使用。
   */
  drawing_no?: string
  name?: string
  /**
   * 2026-08-20：原 /parts 列表主路径不再使用；保留供 listPendingProgramming / listOutsourceSendable
   * 等其他端点继续使用（与后端 PartListQuery.keyword 兼容）。
   */
  keyword?: string
  /** 2026-07-22：订单号独立搜索（ILIKE 包含 %kw%）。 */
  order_no?: string
  /**
   * 2026-07-31：序列号独立搜索（ILIKE 包含 %kw%）。
   * 命中子件也算命中（子件 serial_no 形如 {父装配}-{i:02d}）；
   * 装配件行通过 EXISTS 子件命中自动带出母装配件。
   */
  serial_no?: string
  /**
   * 仅返回「曾外协过」的零件（2026-07-20 新增，外协接收历史页用）。
   * 命中条件由后端 EXISTS 子查询判定（SENT_TO_OUTSOURCE / RECEIVED_FROM_OUTSOURCE
   * / INSPECTED + note ILIKE '%外协%'）。
   */
  has_outsource_history?: boolean
  /** 2026-07-21 PR-F：请购日期区间（含端点；任一端点为空表示半开） */
  request_date_from?: string
  request_date_to?: string
  /** 2026-07-22：计划交期区间（含端点；任一端点为空表示半开） */
  planned_delivery_date_from?: string
  planned_delivery_date_to?: string
  /** 2026-07-21 PR-F：系统交期区间（含端点；任一端点为空表示半开；NULL 字段视为落在区间内） */
  system_delivery_date_from?: string
  system_delivery_date_to?: string
  /**
   * 2026-08-11：订单号空白筛选（对应前端 checkbox「仅空白订单号」）。
   * - true  ⇒ 仅空白（NULL OR ''），覆盖 order_no 子串搜索
   * - false ⇒ 仅非空（NULL AND != '' 排除）
   * - undefined / 不传 ⇒ 任意（沿用默认）
   */
  order_no_is_null?: boolean
  /**
   * 2026-08-11：系统交期空白筛选（对应前端 checkbox「仅空白系统交期」）。
   * - true  ⇒ 仅 NULL，区间失效
   * - false ⇒ 仅非 NULL，区间仍生效
   * - undefined / 不传 ⇒ 任意（区间默认排除 NULL，Bug 1 修复后）
   */
  system_delivery_date_is_null?: boolean
  /** 2026-08-01：下一道工序多选（雪花 ID 字符串，禁止 Number() 转换——会丢精度；空=全部；NULL 工序自然被排除） */
  next_process_ids?: string[]
  /** 2026-08-01：物理位置多选（OFFICE/PRODUCTION_SHELF/WORKER/INSPECTION_SHELF/OUTSOURCE_COMPANY；空=全部） */
  locations?: string[]
  /**
   * 2026-08-05：具体 holder 多选（货架/工人/外协公司，雪花 ID 字符串）。
   * 与 `locations` 是 OR 关系——命中 `locations` 大类 OR 任一 `holder_ids` 都算中。
   * 用于「所在位置」树形筛选收窄到具体 holder。
   */
  holder_ids?: string[]
  /**
   * 2026-08-05：行类型筛选（ALL/PART/ASSEMBLY），默认 ALL。
   * 后端 list_with_filters 默认行为兼容；ALL 时含装配件。
   */
  row_type?: PartRowTypeFilter
  sort_by?: PartSortKey
  sort_dir?: SortDir
  limit?: number
  offset?: number
  /** 2026-07-30：零件一览合并装配件 */
  include_assemblies?: boolean
}

export interface PartCreatePayload {
  name: string
  drawing_no: string
  applicant_name?: string
  /**
   * 申请人表 id（雪花 ID 字符串）。
   * 必须是字符串：雪花 ID 19 位 > JS Number.MAX_SAFE_INTEGER（2^53-1），
   * 用 number 类型会在 JSON 序列化时丢精度，后端拿不到原值。
   */
  applicant_id?: string | null
  quantity?: number
  unit_price?: number
  total_price?: number | null
  request_date: string
  planned_delivery_date: string
  actual_delivery_date?: string | null
  is_urgent?: boolean
  /** PR-F 2026-07-17：送货单字段 */
  order_no?: string | null
  system_delivery_date?: string | null
  note?: string | null
  /** 雪花 ID 字符串（CLAUDE.md §3） */
  customer_id: string
}

export interface PartStatusChangePayload {
  status: OrderStatus
}

export interface PartUpdatePayload {
  name?: string
  drawing_no?: string
  applicant_name?: string
  quantity?: number
  unit_price?: number
  total_price?: number | null
  request_date?: string
  planned_delivery_date?: string
  actual_delivery_date?: string | null
  is_urgent?: boolean
  /** PR-F 2026-07-17：送货单字段 */
  order_no?: string | null
  system_delivery_date?: string | null
  note?: string | null
  /** 雪花 ID 字符串（CLAUDE.md §3） */
  customer_id?: string
}

export interface PartPickUpPayload {
  serial_no: string
  shelf_id: string
  badge_code: string
  /** 2026-07-29 批次化：目标批次 id（扫码台卡片回传） */
  batch_id?: string | null
  /** 领取数量；缺省 = 批次全量 */
  quantity?: number | null
}

export interface PartScanPayload {
  serial_no: string
  event_type: PartEventType
  shelf_id: string
  badge_code: string
  target_inspection_shelf_id?: string | null
  /** 仅 RETURNED 需要；工人指定的下一道工序 id */
  next_process_id?: string | null
  /** 2026-07-29 批次化：目标批次 id（扫码台卡片回传） */
  batch_id?: string | null
  /** 归还/送检数量；缺省 = 批次全量 */
  quantity?: number | null
}

export interface PartEvent {
  id: string
  part_id: string
  /** 2026-07-29 批次化：事件归属批次（NULL = 工单级事件） */
  batch_id: string | null
  batch_no: number | null
  /** 本次事件涉及的数量 */
  quantity: number | null
  worker_id: string | null
  worker_name: string | null
  event_type: string
  from_status: string | null
  to_status: string | null
  drawing_code: string | null
  badge_code: string | null
  note: string | null
  created_by: string | null
  operator_username: string | null
  // 2026-07-17：操作者姓名（display_name）；前端 UI 默认用它，username 仅作 fallback
  operator_name: string | null
  created_at: string
}

// axios 会自动丢掉 undefined/null；但空串不会丢（会触发 LIKE '%%'）。
// 空字符串过滤统一在 @/api/http 的 cleanParams 里实现（2026-08-25 refactor）。

export async function listParts(
  params: ListPartsParams = {},
): Promise<PartListResult> {
  const resp = await api.get<PartListResult>('/parts', { params: cleanParams(params) })
  return resp.data
}

/**
 * 零件一览「所在位置」树（GET /parts/location-tree）。
 *
 * 父节点 5 个固定大类（OFFICE/PRODUCTION_SHELF/WORKER/INSPECTION_SHELF/OUTSOURCE_COMPANY），
 * 叶节点是具体的货架/工人/外协公司（`id` 为雪花 ID 字符串，`location=null`）；
 * OFFICE 无叶子。后端只返当前可见（active + 未软删）的 holder。
 */
export async function getPartLocationTree(): Promise<{ items: LocationTreeNode[] }> {
  const resp = await api.get<{ items: LocationTreeNode[] }>('/parts/location-tree')
  return resp.data
}

export async function getPart(id: string): Promise<PartItem> {
  const resp = await api.get<PartItem>(`/parts/${id}`)
  return resp.data
}

export async function createPart(payload: PartCreatePayload): Promise<PartItem> {
  const resp = await api.post<PartItem>('/parts', payload)
  return resp.data
}

export async function changePartStatus(
  id: string,
  payload: PartStatusChangePayload,
): Promise<PartItem> {
  const resp = await api.post<PartItem>(`/parts/${id}/change-status`, payload)
  return resp.data
}

export interface PlaceOnShelfPayload {
  shelf_id: string
  /** 下一道工序 id（必填） */
  next_process_id: string
}

export async function placeOnShelf(
  id: number | string,
  shelfId: string,
  nextProcessId: string,
): Promise<PartItem> {
  const resp = await api.post<PartItem>(`/parts/${id}/place-on-shelf`, {
    shelf_id: shelfId,
    next_process_id: nextProcessId,
  })
  return resp.data
}

/** PENDING → PROGRAMMING：文员把零件发送至 CNC 编程。 */
export async function sendToProgramming(id: number | string): Promise<PartItem> {
  const resp = await api.post<PartItem>(`/parts/${id}/send-to-programming`)
  return resp.data
}

/** 2026-08-05 召回：ON_SHELF 或 PROGRAMMING → PENDING（M/C）。
 *  `batch_id` 缺省按 expect 唯一批次解析；多在架批次必须指定。 */
export interface PartRecallPayload {
  batch_id?: string | null
}

export async function recallToPending(
  id: number | string,
  payload?: PartRecallPayload,
): Promise<PartItem> {
  const resp = await api.post<PartItem>(
    `/parts/${id}/recall-to-pending`,
    payload ?? {},
  )
  return resp.data
}

/** 2026-08-05 召回：ON_SHELF → PROGRAMMING（M/CNC）。 */
export async function recallToProgramming(
  id: number | string,
  payload?: PartRecallPayload,
): Promise<PartItem> {
  const resp = await api.post<PartItem>(
    `/parts/${id}/recall-to-programming`,
    payload ?? {},
  )
  return resp.data
}

/** PROGRAMMING → IN_PROCESS：编程员上传完 G 代码后下发到生产货架。 */
export async function releaseFromProgramming(
  id: number | string,
  shelfId: string,
  nextProcessId: string,
): Promise<PartItem> {
  const resp = await api.post<PartItem>(
    `/parts/${id}/release-from-programming`,
    { shelf_id: shelfId, next_process_id: nextProcessId },
  )
  return resp.data
}

/** 待编程一览：status=PROGRAMMING 的零件列表。 */
export async function listPendingProgramming(
  params: Omit<ListPartsParams, 'statuses' | 'is_urgent'> = {},
): Promise<PartListResult> {
  const resp = await api.get<PartListResult>(
    '/parts/pending-programming',
    { params: cleanParams(params) },
  )
  return resp.data
}

export async function pickUpPart(payload: PartPickUpPayload): Promise<PartItem> {
  const resp = await api.post<PartItem>('/parts/pick-up', payload)
  return resp.data
}

export async function scanPart(payload: PartScanPayload): Promise<PartItem> {
  const resp = await api.post<PartItem>('/parts/scan', payload)
  return resp.data
}

export async function listPartEvents(id: string): Promise<PartEvent[]> {
  const resp = await api.get<PartEvent[]>(`/parts/${id}/events`)
  return resp.data
}

export async function softDeletePart(id: string): Promise<void> {
  await api.post(`/parts/${id}/soft-delete`)
}

export async function updatePart(
  id: string,
  payload: PartUpdatePayload,
): Promise<PartItem> {
  const resp = await api.post<PartItem>(`/parts/${id}/update`, payload)
  return resp.data
}

// ============ inspection to-XXX 体系（2026-08-28 后端路线 B 重构）==============

/** 单件送检（PENDING/PROGRAMMING/IN_PROCESS+PRODUCTION_SHELF → INSPECTION）。
 * 自动拆批：quantity < batch.quantity 时响应 new_batch_id 为拆出的 remainder。
 * 后端详见 ~/Code/hsh-erp-rust/docs/api/parts/inspection.md。 */
export interface ToInspectionPayload {
  /** 必填；目标品检货架 id（雪花 ID 字符串，zone=INSPECTION active）。 */
  target_inspection_shelf_id: string
  /** 可选；≤ 500 字符品检备注（v2 新增）。 */
  note?: string | null
  /** 可选；多批次歧义时必填。 */
  batch_id?: string | null
  /** 可选；缺省 = 批次全量；部分数量 < 整批会拆出新批次作 remainder。 */
  quantity?: number | null
}

export async function toInspection(
  id: string,
  payload: ToInspectionPayload,
): Promise<{ part: PartItem; new_batch_id: string | null }> {
  const resp = await apiV2.post<{ part: PartItem; new_batch_id: string | null }>(
    `/parts/${id}/to-inspection`,
    payload,
  )
  return resp.data
}

/** 单件通过品检（INSPECTION → READY_TO_SHIP，可选自动拆批）。
 * body 可省略（Content-Length: 0 等价于空对象）。 */
export interface ToShipPayload {
  batch_id?: string | null
  quantity?: number | null
  note?: string | null
}

export async function toShip(
  id: string,
  payload?: ToShipPayload,
): Promise<{ part: PartItem; new_batch_id: string | null }> {
  const resp = await apiV2.post<{ part: PartItem; new_batch_id: string | null }>(
    `/parts/${id}/to-ship`,
    payload ?? {},
  )
  return resp.data
}

/** 单件品检打回（INSPECTION → IN_PROCESS，指定 shelf + next_process）。
 * 事件类型 INSPECTION_FAILED。 */
export interface ToProcessPayload {
  /** 必填；目标生产货架 id（PRODUCTION zone active）。 */
  shelf_id: string
  /** 必填；下一道工序 id（保留为该 part 的下道工序，工人可直接领取）。 */
  next_process_id: string
  /** 可选；品检备注。 */
  note?: string | null
  /** 可选；多批次歧义时必填。 */
  batch_id?: string | null
  /** 可选；缺省 = 批次全量。 */
  quantity?: number | null
}

export async function toProcess(
  id: string,
  payload: ToProcessPayload,
): Promise<{ part: PartItem; new_batch_id: string | null }> {
  const resp = await apiV2.post<{ part: PartItem; new_batch_id: string | null }>(
    `/parts/${id}/to-process`,
    payload,
  )
  return resp.data
}

/** READY_TO_SHIP → DELIVERED：发货（文员/管理员手动）。 */
export async function deliverPart(id: string): Promise<PartItem> {
  const resp = await api.post<PartItem>(`/parts/${id}/deliver`)
  return resp.data
}

/** 扫码台：司机确认发货（PR-C 2026-07-10）。 */
export interface ScanDeliverPartPayload {
  part_id: string
  worker_badge_code: string
}

export async function scanDeliverPart(
  payload: ScanDeliverPartPayload,
): Promise<PartItem> {
  const resp = await api.post<PartItem>('/parts/scan/deliver-part', payload)
  return resp.data
}

/** DELIVERED → COMPLETED：确认完成，释放流水号。 */
export async function completePart(id: string): Promise<PartItem> {
  const resp = await api.post<PartItem>(`/parts/${id}/complete`)
  return resp.data
}

/** → REPAIRING：开始返修（INSPECTION/READY_TO_SHIP/DELIVERED 进入）。
 *  2026-08-04 PR-M：支持 batch_id + quantity（部分返修先拆再转）。 */
export interface StartRepairPayload {
  batch_id?: string | null
  quantity?: number | null
}
export async function startPartRepair(
  id: string,
  payload?: StartRepairPayload,
): Promise<PartItem> {
  const resp = await api.post<PartItem>(
    `/parts/${id}/start-repair`,
    payload ?? undefined,
  )
  return resp.data
}

/** REPAIRING → ON_SHELF / INSPECTION：返修完成（PR-M 2026-08-04）。
 *
 * - shelf.zone=PRODUCTION → REPAIRING → ON_SHELF（需 next_process_id）
 * - shelf.zone=INSPECTION → REPAIRING → INSPECTION（无需 next_process_id）
 */
export interface CompleteRepairPayload {
  batch_id?: string | null
  next_process_id?: string | null
}
export async function completePartRepair(
  id: string,
  shelfId: string,
  payload?: CompleteRepairPayload,
): Promise<PartItem> {
  const resp = await api.post<PartItem>(
    `/parts/${id}/complete-repair`,
    payload ?? undefined,
    { params: { shelf_id: shelfId } },
  )
  return resp.data
}

/** 返修接收 Tab·已送货（DELIVERED 批次；PR-M 2026-08-04）。
 *
 * 2026-08-25 注：返回类型 InspectionBatchListResult 定义在 ./batch（listRepairBatches
 * 是单件 lifecycle 端点，但响应形态与品检待办一致）；用 type-only 跨子域引用。 */
export async function listRepairBatches(params: {
  keyword?: string
  serial_no?: string
  customer_id?: string
  limit?: number
  offset?: number
} = {}): Promise<InspectionBatchListResult> {
  const resp = await api.get<InspectionBatchListResult>(
    '/parts/repair-batches',
    { params: cleanParams(params) },
  )
  return resp.data
}

/** 返修接收 Tab·返修中（REPAIRING 批次；PR-M 2026-08-04）。 */
export async function listRepairingBatches(params: {
  keyword?: string
  serial_no?: string
  customer_id?: string
  limit?: number
  offset?: number
} = {}): Promise<InspectionBatchListResult> {
  const resp = await api.get<InspectionBatchListResult>(
    '/parts/repairing-batches',
    { params: cleanParams(params) },
  )
  return resp.data
}

/** PR-M 2026-08-04 续：一步式返修下发（DELIVERED → REPAIRING → ON_SHELF/INSPECTION）。 */
export interface RepairDispatchPayload {
  shelf_id: string
  /** 下一道工序（可选；缺省沿用 REPAIRING 携带的下一工序，PRODUCTION 区会校验映射） */
  next_process_id?: string | null
  batch_id?: string | null
  /** 部分数量（可选；缺省 = 批次全量） */
  quantity?: number | null
}
export async function repairDispatch(
  id: string,
  payload: RepairDispatchPayload,
): Promise<PartItem> {
  const resp = await api.post<PartItem>(
    `/parts/${id}/repair-dispatch`,
    payload,
  )
  return resp.data
}

export async function cancelPart(id: string): Promise<PartItem> {
  const resp = await api.post<PartItem>(`/parts/${id}/cancel`)
  return resp.data
}

export async function getPartBySerial(serialNo: string): Promise<PartItem> {
  const resp = await api.get<PartItem>(
    `/parts/by-serial/${encodeURIComponent(serialNo)}`,
  )
  return resp.data
}

/**
 * 扫码台 PICK_UP 列表：列出指定工种在指定货架上可领的零件。
 * 排序：加急优先 → 临期优先 → id 降序。
 */
export async function listPartsByWorkType(
  workTypeId: string,
  shelfId: string,
): Promise<PartItem[]> {
  const resp = await api.get<PartItem[]>(
    `/parts/by-work-type/${encodeURIComponent(workTypeId)}`,
    { params: { shelf_id: shelfId } },
  )
  return resp.data
}

/**
 * 共享 HMI PICK_UP 跨架列表（2026-07-10）。
 * 列出**所有**生产货架上、该工种可领的零件；前端按 `current_holder_id`
 * 在卡片网格里分组。
 * 排序与 `listPartsByWorkType` 一致。
 */
export async function listPartsByWorkTypeAllShelves(
  workTypeId: string,
): Promise<PartItem[]> {
  const resp = await api.get<PartItem[]>(
    `/parts/pickable-by-work-type/${encodeURIComponent(workTypeId)}`,
  )
  return resp.data
}

/**
 * 扫码台 RETURN 列表：列出某工人当前持有的所有零件（2026-07-10 新流程）。
 * 排序：加急优先 → 临期优先 → id 降序。
 * 入参 workerId 是雪花 ID 字符串。
 */
export async function listPartsHeldByWorker(
  workerId: string,
): Promise<PartItem[]> {
  const resp = await api.get<PartItem[]>(
    `/parts/by-worker/${encodeURIComponent(workerId)}`,
  )
  return resp.data
}

// ============================================================
// 外协流程（2026-07-15 新增；属单件 lifecycle，归 ./crud）
// ============================================================
export interface SendToOutsourcePayload {
  /** 外协公司 id（雪花 ID 字符串） */
  outsource_company_id: string
  /** 外协工序 id（雪花 ID 字符串；JS Number 会丢精度） */
  next_process_id: string
  /**
   * 乐观锁版本号；与目标批次 TPartBatch.version 必须一致，否则返 BIZ_VERSION_CONFLICT 409。
   * 前端从 OutsourceSendableItem.version（批次级 version）取值后传入。
   * 2026-07-28 新增。
   * 2026-07-29 PR-fix-0.2.0 批次化：改为批次 version。
   */
  version: number
  /**
   * 2026-07-29 PR-fix-0.2.0 批次化：可发送批次 id（雪花 ID 字符串）。
   * 选填 —— 缺省时后端用 _resolve_target_batch 在该 part 的活跃批次里自动选唯一者；
   * 多批次工单建议显式传入，避免歧义。Picker 选中行时建议把 row.batch_id 一起回传。
   */
  batch_id?: string
  /**
   * 2026-07-30：部分发送数量；≤ 批次量，缺省 = 批次全量。
   */
  quantity?: number | null
}

/**
 * PENDING / IN_PROCESS → OUTSOURCE：把零件发送给外协公司。
 * 后端会校验公司存在 + 启用 + 工序 OUTSOURCE + 公司映射了该工序。
 */
export async function sendToOutsource(
  partId: string,
  payload: SendToOutsourcePayload,
): Promise<PartItem> {
  const resp = await api.post<PartItem>(
    `/parts/${encodeURIComponent(partId)}/send-to-outsource`,
    payload,
  )
  return resp.data
}

/**
 * 统一外协可发送一览（2026-07-28 新增；取代 listDirectOutsourceCandidates / listApprovedForSend）：
 * 合并 APPROVAL（需审批 + 有报价）和 DIRECT（无需审批可直发）两类，
 * 每行带 send_mode + source_status 字段。
 */
export async function listOutsourceSendable(
  params: {
    keyword?: string
    customer_id?: string
    limit?: number
    offset?: number
  } = {},
): Promise<OutsourceSendableListResult> {
  const resp = await api.get<OutsourceSendableListResult>(
    '/parts/outsource-sendable',
    { params: cleanParams(params) },
  )
  return resp.data
}

/**
 * 直接发送外协候选（已弃用；2026-07-28 后由 listOutsourceSendable 取代）。
 * 保留以兼容旧调用方；新代码请用 listOutsourceSendable。
 */
export async function listDirectOutsourceCandidates(
  params: {
    keyword?: string
    customer_id?: string
    limit?: number
    offset?: number
  } = {},
): Promise<DirectOutsourceCandidateListResult> {
  const resp = await api.get<DirectOutsourceCandidateListResult>(
    '/parts/direct-outsource-candidates',
    { params: cleanParams(params) },
  )
  return resp.data
}

export interface ReceiveFromOutsourcePayload {
  shelf_id: string
  /** 下一道工序 id（雪花 ID 字符串；JS Number 会丢精度） */
  next_process_id: string
  /** 2026-07-30：目标批次 id；缺省按状态唯一批次解析 */
  batch_id?: string | null
  /** 2026-07-30：部分接收数量；缺省 = 批次全量 */
  quantity?: number | null
}

/**
 * OUTSOURCE → IN_PROCESS：从外协回收，下发到生产货架继续加工。
 */
export async function receiveFromOutsource(
  partId: string,
  payload: ReceiveFromOutsourcePayload,
): Promise<PartItem> {
  const resp = await api.post<PartItem>(
    `/parts/${encodeURIComponent(partId)}/receive-from-outsource`,
    payload,
  )
  return resp.data
}