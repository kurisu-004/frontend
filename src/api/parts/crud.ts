// 后端零件 API 封装 —— 单件 CRUD + 生命周期（生产/扫码/品检/外协/返修/打印等）。
// 全部走 `api`（baseURL `/api/v2`）。打印 2 端点（print-drawing / print-drawing-batch）
// 在 ./file.ts 单独声明，同走 `api`（由 rust 鉴权后转发 python），本文件不重复 export。
// 所有 ID 在前端是字符串（雪花 ID 经后端 IdStr 序列化）。
// 2026-08-25：从原 1165 行 api/parts.ts 拆分到 ./ 子文件；本文件是 ./crud 子域。
//
// 跨子域类型引用：RepairBatchListResult 定义在 ./batch（listRepairBatches /
// listRepairingBatches 是单件 lifecycle，但响应形态一致 —— 两条端点共用后端
// `InspectionBatchListItemOut`）。用 `import type`
// 顶置避免 inline import 的可读性问题；type-only 导入是擦除的，运行时无循环代价。
//
// 2026-10-01：`listPendingProgramming`（GET /parts/pending-programming，恒返空）已删除，
// 唯一 caller 是「待编程一览」页，数据源迁到 prod 域 `GET /prod/programming/pending`
// （api/programming.ts）。本文件不再 import partListResultSchema（随该函数一并移除）。

import { api, cleanParams, normalizeListResult } from '@/api/http';
import {
  repairBatchListResultSchema,
  scanPartListResultSchema,
  type ScanPartListResultSchema,
} from '@/composables/queries/schemas';
import type {
  LocationTreeNode,
  OrderStatus,
  PartEventType,
  PartListItem,
  PartRowTypeFilter,
  PartSortKey,
  SortDir,
} from '@/types/parts';
import type { RepairBatchListResult } from './batch';
import type { QueueRefillResultDto } from '@/api/productionQueue.contract';

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
  /** 2026-07-29 批次化；2026-10-04 订正填充口径：**报工台两个列表端点都填** ——
   *  `GET /api/v2/parts/pickable-by-work-type/{work_type_id}`（扫码台 PICK_UP 列表）与
   *  `GET /api/v2/parts/by-worker/{worker_id}`（放回 / 送检 / HeldPartsBadge）；其余复用
   *  本 VO 的端点恒 null（后端刻意不填，理由见下面 `batch_version` 的注释）。
   *  「品检待办」不走本 VO（它有自己的出参），故不再算作填充方。
   *  2026-10-04 补：取件路径上这两个字段的**运行时守门**是
   *  `src/composables/queries/schemas.ts` 的 `scanPartRowSchema`（两个报工台列表
   *  函数的出参都走它 `.parse()`）；改名义务集中登记在下面 `batch_version` 段。 */
  batch_id?: string | null;
  batch_no?: number | null;
  batch_label?: string | null;
  /** 2026-10-03 后端新增：批次 OCC 版本（t_part_batch.version），与 batch_id 同源。
   *  **填充口径：报工台两个列表端点都填** —— `GET /api/v2/parts/pickable-by-work-type/
   *  {work_type_id}`（扫码台 PICK_UP 列表）与 `GET /api/v2/parts/by-worker/{worker_id}`
   *  （放回 / 送检 / HeldPartsBadge）。这两个端点的行本来就是批次行 —— 后端取行 SQL
   *  投影 `b.id` / `b.version` 并显式覆写 `PartListItem.batch_id` / `batch_version`。
   *  取件端点的候选口径 = `b.status='IN_PROCESS' AND b.location='PRODUCTION_SHELF' AND
   *  货架 active 且 zone='PRODUCTION'` 且落在该工种↔工序映射上。
   *  ⚠️ **本 VO 的 `version` 字段不是批次版本**：它是 part 级 `t_part.version`，
   *  而报工台两个取行 SQL 压根不投影 `p.version` ⇒ 该 VO 上**恒为 0**（后端
   *  有意占位）。批次 OCC 只认本字段，**不要拿 `version` 当批次版本用**。
   *
   *  其余复用 `PartListItem` 的端点**恒为 null**（后端刻意不填：part 级行的单位是
   *  part，一个 part 的活跃批次可能不止一个，填任意一个都是**错锚点**）。复用该 VO
   *  的端点里恒 null 的逐个是：`GET /parts` / `GET /com/union-list` /
   *  `GET /parts/by-work-type/{id}` / `POST /assemblies/{id}/children`（唯一一处单条
   *  返回本 VO 的端点）。⚠️ **别把 outsource-* 算进来**：它们是自有 repo 的自有
   *  SQL（`OutsourceRepoTrait::quotable_list` / `sendable_list`，入参形态也不同——
   *  keyword_pat / customer_id / limit / offset），出参也是自有 VO
   *  （`QuotablePartListOut` / `OutsourceSendableListOut` / …），既不复用
   *  `PartListFilters` 也不经过本 VO。
   *    `POST /prod/batches/{batch_id}/pick-up` 的 `version` 入参即取自本字段，缺失时
   *    扫码台走显式报错（不静默用 part_id 顶替）。
   *
   *    ⚠️ **改名义务**（沿用本仓既有惯例）：后端换字段名（`batch_ids` 复数 / 嵌套结构）
   *    时，**取件这条路径的运行时守门在 `src/composables/queries/schemas.ts` 的
   *    `scanPartRowSchema`**（本 VO 的 `batch_id` / `batch_version` 都声明成
   *    必填 + 可空，不声明成 `.optional()`）—— 键消失会让 Zod parse 当场抛错，
   *    而不是让字段以 undefined 流到视图层、只弹一句「批次锚点缺失」这种看不出
   *    真因的提示。**后端换名时必须同步改：本注释所在的 `PartItem.batch_id` 与
   *    `batch_version` 两行 + `scanPartRowSchema` 的同名字段 +
   *    `ScanPickParts.vue` 的 `PICK_UP_NO_BATCH_HINT` 缺字段守卫。** */
  batch_version?: number | null;
  /** 2026-10-09 后端新增的派生列（批次级 boolean）：报工台两个列表端点（`pickable-by-work-type` /
   *  `by-worker`）都填真值，报工台三页的列表卡左边框按它着色（有链且指针未漂移 = 绿，
   *  规则见 `@/views/scan/chainAccent`）；其余复用本 VO 的端点**恒为 false**（键恒在 ——
   *  后端 `PartListItem.has_process_chain` 非 Option、无 `serde(default)`，`From` 里显式
   *  赋值 ⇒ 漏赋值编译不过；part 级路径拿不到批次链位置，故 false）。
   *  **声明成必填**：键恒在而类型层允许 undefined 只会让下游写出 `boolean | undefined` 的
   *  防御代码，而运行时这个 undefined 永远不会出现（报工台路径的必填守门在
   *  `scanPartRowSchema`，缺键即抛）。 */
  has_process_chain: boolean;
}

export interface PartListResult {
  items: PartListItem[];
  total: number;
  limit: number;
  offset: number;
  // 2026-10-04 订正：分页字段的口径以 backend-rust `vo/part.rs::PartListOut` 为准 ——
  // `total` / `limit` / `offset` 是**裸 i64（无 serialize_with）→ JSON number**；
  // 走 `serialize_i64` → JSON string 的是雪花 ID 字段，不是这三个计数。
  // 实际接收响应时由 listParts 等 caller 在响应包装层用
  // @/api/http.normalizeListResult 包一层（对 number 是恒等、对 string 是兜底归一），
  // 调用处就不必关心后端实际给的是 string 还是 number。schema 类型本身保持 number，
  // 避免大改所有调用方。
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
   * 2026-08-20：原 /parts 列表主路径不再使用；保留供按图号/名称/单号分列搜索之外的
   * 老式关键字搜索继续使用（与后端 PartListQuery.keyword 兼容）。
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

// 2026-10-03 清理：`changePartStatus`（`POST /parts/{id}/change-status`）与
// `PartStatusChangePayload` 删除 —— 后端全仓零注册该路由（`src/` 与 `tests/` 均无），
// 且前端零调用方，留着只会被误当成可用端点。

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

/** 2026-10-03 迁 prod 域：领取入参对齐后端 v2 `PickUpRequest`。与 v1 的
 *  `{ serial_no, shelf_id, badge_code, batch_id?, quantity? }` 不再同构 ——
 *  v1 是「扫序列号 + 工牌」，v2 是「按批次 + OCC + 工人」。
 *
 *  2026-10-04 去掉 `shelf_id`：后端把它从必填 `i64` 改成 `Option<i64>`，**缺省即不做
 *  任何校验**。该字段在 pick-up 里本来就只是「存在 + active + zone=PRODUCTION」的一
 *  道冗余断言 —— 既不落库、也不参与任何 WHERE，删掉它对端点行为没有影响，而取件页因此
 *  不再需要「当前作业架」，多架账号（`user.shelf_ids` ≥ 2）也能提交。 */
export interface PartPickUpPayload {
  /** 必填；t_part_batch.version（OCC），从列表项的 batch_version 取 */
  version: number;
  /** 必填；雪花 ID 字符串；不是工牌码 */
  worker_id: string;
  /** 2026-10-03 部分领取：缺省 = 整批。**必须发字符串**（后端 deserialize_i64_opt 只吃 JSON string，发 number 会 422） */
  quantity?: string | null;
  note?: string | null;
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

// 2026-10-02：以下 lifecycle 端点的操作对象是**批次**（t_part_batch），路由锚点
// 统一迁到 prod 域 `POST /api/v2/prod/batches/{batch_id}/<action>`，故第一形参一律是
// batchId，payload 里的 batch_id 一并删除（它已是路径参数）。part 域只留
// 「多批次动作 + part 级动作」（cancel / force-complete / soft-delete / batches 读）。

export interface PlaceOnShelfPayload {
  shelf_id: string;
  /** 下一道工序 id（必填） */
  next_process_id: string;
  /** 批次 OCC：t_part_batch.version，取列表项的 `batch_version`；后端必填，缺失 422。
   *
   *  已知缺口（2026-10-03 登记，未修）：后端 `PlaceOnShelfRequest.version: i32`
   *  **无 `#[serde(default)]`**，缺字段时 axum `Json` extractor 在进 handler 前直接拒
   *  → HTTP 422。调用方是「零件一览」下发的 `usePartDispatch`（单件 + 批量两条
   *  path），属本轮范围外的 `views/parts/list/**`，那里已用显式报错挡住（该文件
   *  文件头登记了同源缺口：连 batch_id 都取不到），故这里先声明成可选让编译通过。
   *
   *  ⚠️ **解阻塞需要后端改，前端接线解不开**：数据源 `GET /parts` 的行单位是 part，
   *  后端**刻意不填**批次锚点（一个 part 的活跃批次可能不止一个，填任一都是错锚点）
   *  ⇒ 必须后端为该端点（或另开「按 part 取活跃批次锚点」的只读端点）提供锚点，
   *  且 `batch_id` 与 `batch_version` 需**同时**补 —— 只补 batch_id 仍是 422。
   *  后端提供前保持可选；提供后**必须**改成必填并同步接线 `usePartDispatch`。
   *  URL 由 `src/api/parts/__tests__/routes.spec.ts` 的 R1 钉住，body 透传由 R2c 钉住。 */
  version?: number;
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

// 2026-10-08：召回（`ON_SHELF` / `PROGRAMMING` → `PENDING`）的 api 封装迁到
// `@/api/productionQueue`（`recallToPending` + `POST /prod/queue/recall`）—— 后端把
// 召回端点收进 queue 域并把 `batch_id` 从路径参数改成 body 字段，零件域不再是它的
// 归属地。本文件随之删除 `PartRecallPayload` 与 `recallToPending`。

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
 *    1. usePendingProgrammingStore 的 release mutation（「待编程一览」页操作列
 *       「下发」按钮，仅历史 PROGRAMMING 数据可见）；
 *    2. usePartCncGroups.onReleaseToShelf（零件详情页 CNC 卡片，针对历史数据）。
 *
 *  2026-10-02 迁 prod 域：PROGRAMMING 是批次状态，锚点改 `{batch_id}`。
 *  2026-10-03：后端该端点复用 `PlaceOnShelfRequest`，其 `version` 同样必填（无
 *  `#[serde(default)]`，缺字段 422）⇒ 本函数补第 4 形参 `version` 并透传。
 *  后端同日给 `ProgrammingItemOut` 补上 `batch_id` / `batch_version`（取该 part 的
 *  PROGRAMMING 活跃批次，无则 null），调用方 1 据此完成接线。
 *
 *  已知缺口（2026-10-03 更新，**只剩调用方 2**：调用方 2 仍未传 `version`，
 *  该路径上的请求仍 422。`version` 声明为可选正是为它留位，调用方 2 接上后
 *  本形参**必须**改成必填）：
 *    - `usePartCncGroups.onReleaseToShelf`（零件详情页 CNC 卡片，
 *      `views/parts/detail/**`，2026-10-03 未动）。它**不是**被后端锚点卡住：
 *      - `GET /api/v2/parts/{id}`（`PartDetailOut`）确实**不**含 batch_id /
 *        batch_version，它唯一的批次字段 `current_batch_id` 语义是「当前
 *        **INSPECTION** 批次 id」（service `find_current_inspection_batch_id`，
 *        非品检态恒 null），对 PROGRAMMING 批次无效；
 *      - 但 `GET /api/v2/parts/{id}/batches`（`PartBatchListItemOut`）的**每个
 *        批次项都带 `version`**（t_part_batch.version），而该流程本来就是让用户在
 *        批次卡里**手选**批次再下发（`onReleaseToShelf` 的 batchId 形参由
 *        PartDetail.vue 传入），`usePartDetail` 已持有 batches 列表。两处同款先例
 *        都在同一个文件里：`onReceiveFromOutsourceFn`（按调用方给的 batchId 去
 *        batches 里取 version，形态与本处最贴近）、`onPassInspection`（按批次状态在
 *        batches 里找目标再取其 id + version，并有 40901 code 分流 → warning + 重取
 *        batches）。
 *      ⇒ 剩下的是**纯前端改动**（`onReleaseToShelf` 形参加 version + PartDetail 调用点
 *        从 batches 里按 selectedBatchId 取 version），落在 `views/parts/detail/**`，
 *        不在本轮范围。接线时顺带按上述先例处理批次被并发改动的情形（40901 提示刷新
 *        + 重取 batches）。 */

export async function releaseFromProgramming(
  batchId: string,
  shelfId: string,
  nextProcessId: string,
  version?: number,
): Promise<PartItem> {
  const resp = await api.post<PartItem>(
    `/prod/batches/${encodeURIComponent(batchId)}/release-from-programming`,
    {
      shelf_id: shelfId,
      next_process_id: nextProcessId,
      version,
    },
  );
  return resp.data;
}

/** 扫码台 PICK_UP：批次锚定领取。
 *  2026-10-03 由 v1 遗留的 `POST /parts/pick-up` 迁到 prod 域
 *  `POST /api/v2/prod/batches/{batch_id}/pick-up`：批次 id 升为路径参数（不再进 body），
 *  body 只剩 OCC 锚 + 领取人 + 数量。三个反直觉约束，调用方必须遵守：
 *  - `version` 是普通 number（后端 `i32`，无自定义 deserializer），**不要**转字符串；
 *  - `worker_id` 是**工人雪花 ID 字符串**，不是 v1 的 `badge_code` 工牌码（后端按 worker
 *    记录归属，不认工牌码）；
 *  - `quantity` **必须发 JSON 字符串**（后端 `deserialize_i64_opt` 的实现是先
 *    `Option::<String>::deserialize` 再 `parse::<i64>()`，发 number 会被 axum `Json`
 *    extractor 拒成 422）；缺省 / null = 整批，小于总量时后端自动拆批。
 *  - 不发 `shelf_id`（2026-10-04：后端改成 `Option<i64>`，缺省不做任何校验；该值在
 *    pick-up 里既不落库也不参与 WHERE，见 `PartPickUpPayload` 的说明）。
 *  响应仍是 part 级 `R<PartOut>`，调用方按整批刷新列表即可。
 *
 *  **有跨仓部署顺序依赖**（2026-10-04）：后端把 `shelf_id` 改成可选的那一支必须先上线，
 *  前端这个改动才能独立验证；反之旧后端 + 不发 `shelf_id` 会得到裸 HTTP 422。 */
export async function pickUpPart(batchId: string, payload: PartPickUpPayload): Promise<PartItem> {
  const resp = await api.post<PartItem>(
    `/prod/batches/${encodeURIComponent(batchId)}/pick-up`,
    payload,
  );
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
 *  - shelf_id: **工人当前所在的补料生产架**（PRODUCTION 区），雪花 ID 字符串；
 *    两个 event_type 都用它 —— 后端 service 开头**无条件**做
 *    `get_by_id_zone(shelf_id, "PRODUCTION")`，与 event_type 无关（误填品检架得
 *    20501）。放回时它是「放回的目标架」，送检时它是「补料架」。
 *  - next_process_id?: 仅 RETURNED 必填；工人手动输入下一道工序
 *  - target_inspection_shelf_id?: 仅 INSPECTED 必填；**送检目标品检架**
 *    （INSPECTION 区，后端另有一道 `zone != INSPECTION` → 20511 守卫）
 *  - batch_id?: 可选；多批次歧义时显式指定
 *
 * 失败抛 ApiError（契约依据 `docs/api/parts/inspection.md` 的 worker-scan 段）：
 *  - 20103 INVALID_TRANSITION：状态机迁移非法
 *  - 20202 WORKER_INACTIVE：工牌未识别 / 已停用
 *  - 20501 BIZ_SHELF_NOT_FOUND：shelf_id 不存在 / 非 PRODUCTION 区
 *  - 20511 BIZ_SHELF_NOT_INSPECTION_ZONE：target_inspection_shelf_id 非 INSPECTION 区
 *  - 20507 BIZ_SHELF_PROCESS_NOT_MAPPED：RETURNED 时 shelf_id 未映射 next_process_id
 *  - 40001 VALIDATION_ERROR：next_process_id / target_inspection_shelf_id 缺或非法
 *  - 40301 SHELF_MISMATCH：shelf_id / target_inspection_shelf_id 不在本账号绑定集内
 *  - 20401 / 20403 等
 *  - ⚠️ **shelf_id 缺省不走 40001**：`shelf_id` 是无 `#[serde(default)]` 的必填
 *    `i64`，缺字段由 axum `Json` extractor 在 service 之前直接拒 ⇒ **裸 HTTP 422、
 *    响应体不是项目统一 `R` 信封**（docs 明写「非项目统一信封」）⇒ 本仓 `ApiError`
 *    拿不到 code，拦截器的错误文案兜不到业务语义。省略它等于给工人一条看不懂的
 *    裸 422，故消费侧（`resolveWorkingShelfId`）在发请求前就拦住。
 */
export interface WorkerScanPayload {
  serial_no: string;
  badge_code: string;
  event_type: 'RETURNED' | 'INSPECTED';
  /** 雪花 ID 字符串（CLAUDE.md §3）；工人当前所在的补料生产架（PRODUCTION 区），
   *  **两个 event_type 同义** —— 不要当成送检目标品检架（那是下面的字段）。 */
  shelf_id: string;
  /** 仅 RETURNED 必填 */
  next_process_id?: string | null;
  /** 仅 INSPECTED 必填；送检目标品检架（INSPECTION 区） */
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
    /** 实际取值是 WS 广播名（`WORKER_SCAN_RETURNED` / `WORKER_SCAN_INSPECTED`），
     *  不是入参那两个 `RETURNED` / `INSPECTED` —— 前端当前不消费，宽松标注。 */
    event_type: string;
    /** 父装配件 id（仅当 INSPECTED 分支触发父 status 变更时 Some） */
    synced_assembly_id: string | null;
  };
  /** 同事务 queue 域 refill 结果。与 `POST /prod/queue/refill` 的出参
   *  **同一个** rust `RefillResult`，故直接复用 `QueueRefillResultDto`，
   *  不另立一份会漂移的本地结构：
   *  `taken[]` 是本次自动给该工人抢到的批次（扫检 / 放回后报工台据此弹窗提示）。 */
  refill: QueueRefillResultDto;
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

/** ⚠️ 2026-10-05 起本封装在生产侧**零调用方**：待品检页的「快捷品检」已改成
 *  `GET /prod/inspection/scan/{serial_no}` 取树 + `to-inspection`（送检）/
 *  `to-ship`（品检通过）/ `to-process`（指定工序）三个显式端点，快捷品检那套
 *  pass/pass=false 分流不再有调用点。后端 `scan-inspect` 端点仍在，签名照上注释
 *  保留待用，不要当死代码删。 */
export async function scanInspect(batchId: string, payload: ScanInspectPayload): Promise<PartItem> {
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
 *  响应里的 `new_batch_id` 是拆批信号，语义与 toShip 完全一致（拆批时源批次原地减量、
 *  留下的 remainder 就是入参 batchId，被流转的那部分落在一个 id 不返回的新批次上，
 *  详见上方 `ToShipPayload` 的拆批说明）。
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
 *  `quantity` / `note` 选填。
 *
 *  `new_batch_id` 的拆批语义（后端 `_split_for_partial_op`，本文件三个写端点一致）：
 *  - 整批操作（`quantity` 缺省或 >= 批次量）→ `null`，未拆批；
 *  - 部分操作（`quantity` < 批次量）→ `Some(remainder_id)`，而 **remainder 就是本次
 *    入参的 batchId 本身**：源批次原地减量（数量 -quantity、状态留在源状态、id 不变），
 *    被流转的那 quantity 件另立一个**新批次**（数量 = 操作量、状态翻到目标态），
 *    新批次的 id 全程不返回。
 *  调用方据此刷新批次列表：会多出一行**数量 = 操作量**的新批次。
 */
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

/** 扫码台：司机确认发货。
 *  `POST /prod/batches/scan/deliver`（prod 域，静态双段路径，无 path 参数 ——
 *  服务端按序列号 + status 自行解析目标批次）。
 *  字段名对齐后端 `ScanDeliverPartRequest`：`part_serial_no` / `worker_badge_code`
 *  均必填且无 `#[serde(default)]`，对不上就是 422。
 *  2026-10-03：本函数仍零生产调用方（死代码），接上调用方时直接用本签名。 */
export interface ScanDeliverPartPayload {
  part_serial_no: string;
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
 *  2026-10-02 迁 prod 域：批次锚定，`batch_id` 已是路径参数。
 *  ⚠️ 该 DTO **无 quantity**（后端 `StartRepairRequest` 只有 version / reason / note）：
 *  要返修部分数量必须先 split 出子批次，再对子批次调本端点。 */
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
 * 返回类型 RepairBatchListResult 定义在 ./batch（两条返修端点共用同一个后端 VO
 * `InspectionBatchListItemOut`）；用 type-only 跨子域引用。
 *
 * Zod 守门：两条返修端点共用 `repairBatchListResultSchema`。品检队列读（`api/inspection.ts`
 * 的 listInspectionBatches）另有自己的 13 字段精简 VO 与 schema，与返修 VO 行对象
 * **不可互相 cast**（少了 status / location / holder_name 等键）。零守门的代价是踩过
 * 的坑：`is_repairing`（后端恒输出）没被 schema 声明时，本函数会**静默**把多出来的
 * 键丢掉，页面照常渲染、只是列全空。
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
): Promise<RepairBatchListResult> {
  // 2026-10-02 迁 prod 域：与已有的 `GET /prod/batches/pending` 并列，
  // 路径 `/parts/repair-batches` → `/prod/batches/repair`（无 path 参数）。
  const resp = await api.get<unknown>('/prod/batches/repair', {
    params: cleanParams(params),
  });
  return repairBatchListResultSchema.parse(resp.data) as RepairBatchListResult;
}

/** 返修接收 Tab·返修中（PR-M 2026-08-04）。
 *
 * 2026-10-02 补 Zod 守门，理由同 listRepairBatches（共用后端 VO + 本函数此前零
 * 校验）。注意本端点的过滤判据 2026-10-01 起已从
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
): Promise<RepairBatchListResult> {
  // 2026-10-02 迁 prod 域：`/parts/repairing-batches` → `/prod/batches/repairing`。
  const resp = await api.get<unknown>('/prod/batches/repairing', {
    params: cleanParams(params),
  });
  return repairBatchListResultSchema.parse(resp.data) as RepairBatchListResult;
}

/** PR-M 2026-08-04 续：一步式返修下发（DELIVERED → REPAIRING → ON_SHELF/INSPECTION）。
 *
 *  2026-10-02 迁 prod 域：批次锚定，`batch_id` 已是路径参数（从 body 删除），
 *  `version` 必填（OCC 锚 t_part_batch）。
 *  ⚠️ 该 DTO **无 quantity**（后端 `RepairDispatchRequest` 只有 batch_id / version /
 *  shelf_id / next_process_id / reason / note 六个字段，且 serde 未开
 *  `deny_unknown_fields` ⇒ 多带的键被**静默忽略**）：本端点是**整批返修**，
 *  传任何数量都不会生效。返修部分数量只能先 `splitBatch`（`@/api/batch`）拆出子批次、
 *  再对子批次调本端点。 */
export interface RepairDispatchPayload {
  shelf_id: string;
  /** 必填；t_part_batch.version（OCC 锚），不匹配 → 40901。 */
  version: number;
  /** 下一道工序（可选；缺省沿用 REPAIRING 携带的下一工序，PRODUCTION 区会校验映射） */
  next_process_id?: string | null;
  reason?: string | null;
  note?: string | null;
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
 * 共享 HMI PICK_UP 跨架列表（2026-07-10）。
 * `GET /parts/pickable-by-work-type/{work_type_id}`
 *
 * 2026-10-04 契约修正：返回的是**分页信封**（后端 `PartListOut`：items / total /
 * limit / offset），不是裸数组；行 VO 是 `PartListItem`（**不是** `PartDetailOut`）。
 * 调用方必须取 `.items`，否则 `useScanPartsSort` 的 `[...list]` 抛 TypeError，
 * 取件页整页渲染失败。
 *
 * 分页参数（后端 `PickableByWorkTypeQuery` = `ByWorkTypeQuery`）：
 *   - `limit`：后端 `unwrap_or(50).clamp(1, 200)` —— **不传默认只返 50 条**，
 *     当「全部」用会静默截断；要拿全就显式传 200（clamp 上限）。
 *   - `offset`：`unwrap_or(0).max(0)`。
 *
 * ⚠️ 行 VO 里有一批 service 层写死的占位值（`planned_delivery_date` / `request_date`
 * 写死 `1970-01-01`、`is_urgent` 写死 false、`applicant_name` 写死空串、
 * `system_delivery_date` 恒 null、`customer_id` 写死 0、`status` 写死 `IN_PROCESS`、
 * `version` 写死 0），两个日期占位符在 `scanPartRowSchema` 的 transform 里归一成
 * `null`。详见该 schema 的注释。
 */
export async function listPartsByWorkTypeAllShelves(
  workTypeId: string,
  params: { limit?: number; offset?: number } = {},
): Promise<ScanPartListResultSchema> {
  const resp = await api.get<unknown>(
    `/parts/pickable-by-work-type/${encodeURIComponent(workTypeId)}`,
    { params: cleanParams(params) },
  );
  return scanPartListResultSchema.parse(
    normalizeListResult(resp.data as Parameters<typeof normalizeListResult>[0]),
  );
}

/**
 * 扫码台 RETURN / INSPECT 列表：列出某工人当前持有的所有零件。
 * `GET /parts/by-worker/{worker_id}`（入参 workerId 是雪花 ID 字符串）
 *
 * 2026-10-04 契约修正：同 `listPartsByWorkTypeAllShelves`，返回分页信封
 * `PartListOut`、行 VO 是 `PartListItem`；`limit` / `offset` 语义同上（后端
 * `ByWorkerQuery`，默认 50、上限 200）。该端点**也填**批次锚点（`batch_id` /
 * `batch_version`，与取件端点同口径，见上面 `PartItem` 处的填充口径登记）与工序链
 * 派生四件套（`chain_state` / `chain_next_process_id` / `chain_next_process_name` /
 * `chain_current_process_name`）—— 后两组的取值口径与 schema 侧的降级理由见
 * `src/composables/queries/schemas.ts::scanPartRowSchema`。
 */
export async function listPartsHeldByWorker(
  workerId: string,
  params: { limit?: number; offset?: number } = {},
): Promise<ScanPartListResultSchema> {
  const resp = await api.get<unknown>(`/parts/by-worker/${encodeURIComponent(workerId)}`, {
    params: cleanParams(params),
  });
  return scanPartListResultSchema.parse(
    normalizeListResult(resp.data as Parameters<typeof normalizeListResult>[0]),
  );
}

// ============================================================
// 外协流程（2026-07-15 新增；属单件 lifecycle，归 ./crud）
// ============================================================
/** `POST /prod/batches/{batch_id}/send-to-outsource` 入参。
 *
 *  2026-10-03 登记的字段名要点：
 *  - body 键是 `process_id`（后端 DTO 原名如此，且**必填无默认值**；发成别的键名
 *    得到的是 422 纯文本，不是业务信封，别按业务错误码排查）。
 *  - 列表行字段是 `current_process_id` / `current_process_name`
 *    （`src/types/outsource.ts`，批次当前所属的外协工序）。
 *  两者刻意不同名：body 键跟后端 DTO，行字段描述批次本身的位置。
 *
 *  模式由 `quote_id` / `direct` 二选一表达，**两者都不传后端返 400**：
 *  - APPROVAL（需审批报价）：传 `quote_id`（来自 `OutsourceSendableItem.quote_id`）；
 *  - DIRECT（免审批直发）：传 `direct: true` + `quote_id: null`，后端自动建一条
 *    `price=0` 的 APPROVED 占位报价。DIRECT 行的 `outsource_company_id` 取自
 *    `company_options`，该工序未映射任何活跃公司时后端仍返回该行但数组为空
 *    ⇒ 前端必须先过 `canSend` 再入队/提交，否则空串会让后端 `i64` 反序列化失败。
 */
export interface SendToOutsourcePayload {
  /** 外协公司 id（雪花 ID 字符串） */
  outsource_company_id: string;
  /** 外协工序 id（雪花 ID 字符串；JS Number 会丢精度） */
  process_id: string;
  /**
   * 乐观锁版本号；与目标批次 TPartBatch.version 必须一致，否则返 BIZ_VERSION_CONFLICT 409。
   * 前端从 OutsourceSendableItem.version（批次级 version）取值后传入。
   */
  version: number;
  /** APPROVAL 模式必传（来自 OutsourceSendableItem.quote_id）；DIRECT 传 null */
  quote_id?: string | null;
  /** DIRECT 模式传 true；APPROVAL 传 null */
  direct?: boolean | null;
  /**
   * 部分发送数量；≤ 批次量，null 或 == batch_quantity = 整批。
   * 部分发送后源批次留余量、仍可再次发送。
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

// 2026-10-03：`listOutsourceSendable` 迁至 `src/api/outsource.ts`（URL 同步从
// `/parts/outsource-sendable` 迁到 outsource 域顶层 `/outsource-sendable`）。

export interface ReceiveFromOutsourcePayload {
  shelf_id: string;
  /** 下一道工序 id（雪花 ID 字符串；JS Number 会丢精度）。
   *  ⚠️ 这个键后端**没有**随 send-to-outsource 一起改名，仍是 `next_process_id`
   *  （与 `SendToOutsourcePayload.process_id` 刻意不同名）。 */
  next_process_id: string;
  /** 必填；t_part_batch.version（OCC 锚），不匹配 → 40901。 */
  version: number;
  /**
   * 部分接收数量；null 或 == 当前剩余待收量 = 整批。
   * 2026-10-03 修正：后端此前静默忽略该字段（前端填了数量却整批回收），
   * 现已真正实现。拆批后新子批次回生产架，源批次保留余量且**仍在外协厂**
   * （开口 shipment 仍是 OUTSOURCING）—— 所以部分接收后「待接收」列表里仍会
   *  出现那批余量，这是正确行为，前端不要做「部分接收后该行消失」的假设。
   */
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
