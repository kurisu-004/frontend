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
import { repairBatchListResultSchema } from '@/composables/queries/schemas';
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
   *  `GET /api/v2/prod/scan/pickable`（扫码台 PICK_UP 列表）与
   *  `GET /api/v2/prod/scan/held`（放回 / 送检 / HeldPartsBadge）；其余复用
   *  本 VO 的端点恒 null（后端刻意不填，理由见下面 `batch_version` 的注释）。
   *  「品检待办」不走本 VO（它有自己的出参），故不再算作填充方。
   *  2026-10-04 补：取件路径上这两个字段的**运行时守门**是
   *  `src/composables/queries/schemas.ts` 的 `scanPartRowSchema`（两个报工台列表
   *  函数的出参都走它 `.parse()`）；改名义务集中登记在下面 `batch_version` 段。 */
  batch_id?: string | null;
  batch_no?: number | null;
  batch_label?: string | null;
  /** 2026-10-03 后端新增：批次 OCC 版本（t_part_batch.version），与 batch_id 同源。
   *  **填充口径：报工台两个列表端点都填** —— `GET /api/v2/prod/scan/pickable`
   *  （扫码台 PICK_UP 列表）与 `GET /api/v2/prod/scan/held`
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
   *    `POST /prod/scan/batches/{batch_id}/pick-up` 的 `version` 入参即取自本字段，缺失时
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
  /** 2026-10-09 后端新增的派生列（批次级 boolean）：报工台两个列表端点（`/prod/scan/pickable` /
   *  `/prod/scan/held`）都填真值，报工台三页的列表卡左边框按它着色（有链且指针未漂移 = 绿，
   *  规则见 `@/views/production/scan/chainAccent`）；其余复用本 VO 的端点**恒为 false**（键恒在 ——
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

/**
 * ⚠️ **v1(Python) 遗留入参**，打的是 `POST /parts/scan`（不是 v2 的 worker-scan）。
 * v2 端点已删掉全部货架字段（见 CLAUDE.md「货架自动选择」），v1 仍在维护、契约未变，
 * 故这里**仍带** `shelf_id` / `target_inspection_shelf_id` —— 它们不属「不再指定货架」
 * 的口径范围。本 wrapper 在生产代码里零调用方；留着是为了将来真要接 v1 时不必重写，
 * 全仓巡检「还有没有 shelf_id」时**这一处是已知例外，不要当残留清掉**。
 */
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
//
// 2026-10-10：这几个端点的 `shelf_id` **后端一并删除** —— 目标货架改由后端按负载
// 自动选择（见 CLAUDE.md「货架自动选择」）。`placeOnShelf` / `releaseFromProgramming`
// 因此在生产代码里已无调用方（零件一览与零件详情的「下发」入口整体下线），但端点本身
// 仍在后端存在，wrapper 保留 —— 留着零成本，将来有入口要接时不必重写 URL 与 body。

export interface PlaceOnShelfPayload {
  /** 下一道工序 id（必填） */
  next_process_id: string;
  /** 批次 OCC：t_part_batch.version。后端 `PlaceOnShelfRequest.version: i32` 无
   *  `#[serde(default)]` ⇒ 缺字段时 axum `Json` extractor 在进 handler 前直接拒 →
   *  HTTP 422 纯文本（不是业务信封）。
   *
   *  2026-10-10：零件一览 / 零件详情 / cnc 三处「下发」入口下线后本 wrapper 零生产
   *  调用方，`version` 仍声明成可选 —— 新接线时**必须**改成必填，否则漏传只会在运行期
   *  拿到一条工人看不懂的裸 422。
   *
   *  ⚠️ 接线前先确认批次锚点拿得到：数据源 `GET /parts` 的行单位是 part，后端**刻意
   *  不填**批次锚点（一个 part 的活跃批次可能不止一个，填任一都是错锚点）⇒ 需要
   *  `batch_id` 与 `batch_version` **同时**可得（`GET /parts/{id}/batches` 的每个
   *  批次项都带 version），只补 batch_id 仍是 422。
   *  URL 由 `src/api/parts/__tests__/routes.spec.ts` 的 R1 钉住。 */
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
 *
 *  2026-10-02 迁 prod 域：PROGRAMMING 是批次状态，锚点改 `{batch_id}`。
 *  2026-10-10：「待编程一览」页与零件详情页的「下发」入口下线（下发改由扫码台的
 *  工人放回 / 送检接管），本 wrapper **零生产调用方**；端点仍在后端存在故保留。
 *
 *  后端该端点复用 `PlaceOnShelfRequest`，其 `version` 必填（无
 *  `#[serde(default)]`，缺字段返 422 纯文本）⇒ 本函数的 `version` 仍声明成可选，
 *  新接线时**必须**改成必填，并从 `GET /parts/{id}/batches` 的批次项取
 *  `t_part_batch.version`（`GET /parts/{id}` 本身不返批次锚点）。
 *  URL 由 `src/api/parts/__tests__/routes.spec.ts` 的 R1 钉住。 */

export async function releaseFromProgramming(
  batchId: string,
  nextProcessId: string,
  version?: number,
): Promise<PartItem> {
  const resp = await api.post<PartItem>(
    `/prod/batches/${encodeURIComponent(batchId)}/release-from-programming`,
    {
      next_process_id: nextProcessId,
      version,
    },
  );
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
 * payload 与后端 v2 `ScanInspectRequest` 对齐：`pass` / `version` 两者必填（后端无
 * `#[serde(default)]`，缺任一 → HTTP 422），`next_process_id` 仅 pass=false 分支必填。
 *
 * 2026-10-10：`target_inspection_shelf_id` 与 `shelf_id` 后端**一并删除** —— 送检目标
 * 品检架 / 打回目标生产架都改由后端按负载自动选（见 CLAUDE.md「货架自动选择」）。 */
export interface ScanInspectPayload {
  /** 必填；true = 走 INSPECTED（品检通过）/ false = 走 INSPECTION_FAILED（打回）。 */
  pass: boolean;
  /** 必填；t_part_batch.version（OCC 锚），不匹配 → 40901。 */
  version: number;
  /** 仅 pass=false 必填；下一道工序 id。 */
  next_process_id?: string;
  /** 可选；品检备注（≤ 500 字符）。 */
  note?: string | null;
  /** 可选；缺省 = 批次全量。 */
  quantity?: number | null;
}

/**
 * ⚠️ 2026-10-10：`target_inspection_shelf_id` 与 `shelf_id` 后端**一并删除**（目标架改
 * 由后端按负载自动选），两个字段已从上面的 payload 移除。
 *
 * ⚠️ 2026-10-05 起本封装在生产侧**零调用方**：待品检页的「快捷品检」已改成
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

/** 单件送检（多状态 → INSPECTION）。后端 `ToInspectionRequest`：
 *  `version` 必填，`quantity` / `note` 选填。
 *
 *  2026-10-10：`target_inspection_shelf_id` 后端删除 —— 目标品检架由后端按负载自动选
 *  （见 CLAUDE.md「货架自动选择」）。
 *  响应里的 `new_batch_id` 是拆批信号，语义与 toShip 完全一致（拆批时源批次原地减量、
 *  留下的 remainder 就是入参 batchId，被流转的那部分落在一个 id 不返回的新批次上，
 *  详见上方 `ToShipPayload` 的拆批说明）。 */
export interface ToInspectionPayload {
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
 *  后端 `ToProcessRequest`：`next_process_id` / `version` 两者必填（缺任一 → HTTP 422），
 *  `quantity` / `note` 选填。
 *  返修中批次（`is_repairing = true`）后端返 20118 返修守卫，走通用 catch 弹原文。
 *
 *  2026-10-10：`shelf_id` 后端删除 —— 打回的目标生产架由后端按负载自动选。 */
export interface ToProcessPayload {
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

// ============================================================
// 外协流程
//
// 2026-10-10：`send-to-outsource` / `receive-from-outsource` /
// `receive-from-outsource-to-inspection` 三个端点随外协三合一硬切下线，三合一为
// `POST /api/v2/outsource-queue/move`（无 alias）。本文件原有的三个 wrapper 与它们的
// payload 类型一并删除 —— 它们打的都是 404 路径，零生产调用方。
//
// 现行契约：`src/api/outsource.contract.ts::OutsourceMoveRequestDto`，
// 调用侧 `views/outsource/composables/useOutsourceQueueMove.ts`，契约守卫
// `views/outsource/composables/__tests__/useOutsourceQueueMove.spec.ts`。
// ============================================================
