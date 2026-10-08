export interface Shelf {
  id: string;
  /** 乐观锁版本号；每次 UPDATE 自增 */
  version: number;
  code: string;
  name: string;
  zone: string; // PRODUCTION | INSPECTION
  location: string | null;
  is_active: boolean;
  /**
   * 2026-10-10 新增：负载上限（**件数**，不是批次数）。
   * `null` 或 `<= 0` = **不限**（后端选架时该架不参与百分比比较）。
   * 负载上限只影响**选架**时的排序，不构成拒绝：允许超载（> 100%）继续投放。
   * 百分比由前端自己算 `current_load / capacity` —— 后端不返 `load_ratio`，
   * 避免同一个派生量在前端 / 后端各算一遍而两边口径漂移。
   */
  capacity: number | null;
  /**
   * 2026-10-10 新增：在架**件数**（`SUM(t_part_batch.quantity)`，件数不是批次数）。
   * 恒为 number（空架 = 0），后端必返。
   */
  current_load: number;
  // 2026-10-02 摘除 account_count：**用户决定货架列表页不再展示账号数**，前端
  // 类型 / 表格列 / shelfSchema 三处同步摘除（漏改任一处，Zod 守门会对真实响应
  // 抛 ZodError）。
  // 注意因果方向：后端 ShelfOut 在同 PR 里也已删除该字段，但那是**另一次独立决策**
  //，不是「后端删了前端才跟删」。写成「配套后端删除」会让下一个读者反推因果
  //（以为是后端契约变化倒逼前端），进而在前端已不需要该字段时不敢再摘。
  // 决策依据一句话：用户已拍板舍弃该字段，前端不再展示。
  /**
   * 物理顺序（0=未设置；manager 在 ShelfList 后台手填）。
   * 共享 HMI 卡片网格 picker 按 (display_order ASC, code ASC) 排。
   */
  display_order: number;
  created_at: string;
  updated_at: string;
}

export interface ShelfListResult {
  items: Shelf[];
  total: number;
  limit: number;
  offset: number;
}

// ============================================================
// 2026-10-02 货架 ↔ 工序映射契约（对齐 backend-rust
// docs/api/production/shelf-process-mapping.md +
// src/modules/prod/shelf_process/ 的 dto / vo）
//
// 缘由：v1(Python) 迁 v2(Rust) 时前端停在了旧形态 ——
//   写：发 `{process_ids: string[]}`，后端 `SetShelfProcessesRequest{items:[...]}`
//       的 items 必填无 default → serde missing field → 40001 → HTTP 422
//       （该功能自迁移以来从未成功过一次）；
//   读：读 `sp.processes`，后端实际返 `{items:[...]}` → 恒 undefined。
// 因此下面两个接口的类型**只声明后端真实存在的字段**，不再留 v1 影子。
// ============================================================

/** 单架已映射工序的一行（`GET /prod/shelf-processes/{shelf_id}` 响应 item）。
 *  对应后端 VO `ShelfProcessMappingItem`
 *  （`src/modules/prod/shelf_process/vo.rs`）。
 *
 *  `sort_order` 必填：单架端点 SQL 是 `ORDER BY sp.sort_order ASC, sp.id ASC`，
 *  该字段从不缺失。把它声明成可选（为了兼容全集 VO）等于把一个必返字段降级，
 *  逼出消费侧 `?? 0` 兜底、掩盖契约漂移。全集 VO 单独用
 *  `AllShelfProcessMappingItem` 表达。 */
export interface ShelfProcessMappingItem {
  shelf_id: string;
  shelf_code: string;
  process_id: string;
  process_code: string;
  sort_order: number;
}

/** 全集已映射工序的一行（`GET /prod/shelf-processes` 响应 item）。
 *  对应后端 VO `AllShelfProcessMappingItem`（与单架 VO 同一文件）—— 与单架 VO 的
 *  唯一差别就是**不返 sort_order**（全集排序由 service 层 ORDER BY 保证），
 *  故显式 Omit，而不是让单架 VO 的 sort_order 变可选。 */
export type AllShelfProcessMappingItem = Omit<ShelfProcessMappingItem, 'sort_order'>;

/** `GET /prod/shelf-processes/{shelf_id}` 响应体。
 *  2026-10-02 域拆分：URL 硬切自 `/shelves/{id}/processes`（旧路径已 404），响应体不变。
 */
export interface ShelfProcessesResult {
  items: ShelfProcessMappingItem[];
}

/** `POST /prod/shelf-processes/{shelf_id}` 请求体（整组替换；items 可为 [] = 清空映射）。
 *  2026-10-02 域拆分：URL 硬切自 `/shelves/{id}/processes`（旧写路径已 404），请求体不变。
 *  sort_order 语义沿 v1 契约「提交顺序即 sort_order」。 */
export interface SetShelfProcessesPayload {
  items: Array<{ process_id: string; sort_order: number }>;
}

// ============================================================
// 共享 HMI 卡片网格 picker 的两个 VO（2026-07-10 建 RETURN，2026-07-13 加 INSPECT）
//
// ⚠️ 2026-10-02 关键澄清：`for-return` 与 `for-inspection` 是**两个不同后端 VO**，
// 形状不同，**不能共用一个类型**。此前 `listShelvesForInspection()` 的返回类型谎报成
// `ShelfForReturnResult`（`src/api/shelves.ts`），品检路径因此会去读一个后端不返的
// 字段。拆类型的目的就是让这种错位在编译期暴露出来。
//
//   | 字段                            | for-return | for-inspection |
//   |---------------------------------|------------|----------------|
//   | id/code/name/zone/location      | ✓          | ✓              |
//   | current_load（当前在架件数）      | ✓          | ✗ 后端计划补（见下） |
//   | is_recommended（系统推荐标记）   | ✓          | ✗ **没有**     |
//   | is_active                       | ✗          | ✓              |
//
// ⚠️ 2026-10-04 订正 current_load 的状态（两个仓并行推进，合并时后端可能尚未上线）：
// for-inspection 的在架数聚合是后端**计划**补的，当前 `ShelfForInspectionItem` **没有**
// 这层聚合。故 `ShelfForInspection.current_load` 声明成可选，消费侧（`ShelfPickerDialog` →
// `HmiPickerCard`）不假设它在，由 `HmiPickerCard` 的
// `currentLoad !== undefined && currentLoad !== null` 守卫决定是否渲染 ——
// 后端补不补都不会渲染出「在架 undefined 件」。
//
// 后端 VO 逐字对齐 backend-rust `src/modules/shelf/vo/shelf.rs` 的两个结构体：
//   `ShelfForReturnItem`（七字段）/ `ShelfForInspectionItem`（六字段，**不含**
//   current_load**，见上）。两侧的 Out 信封都**只有** items 一个字段（无分页、
//   无 recommended_shelf_id）。
// ============================================================

/** `GET /shelves/for-return` 响应 item。
 *  对应后端 VO `ShelfForReturnItem`（`src/modules/shelf/vo/shelf.rs`）。 */
export interface ShelfForReturn {
  id: string;
  code: string;
  name: string;
  /** 后端 ShelfForReturnItem 第 4 字段。值由端点固定（for-return 只查
   *  PRODUCTION 区、for-inspection 只查 INSPECTION 区），picker 视图零消费；
   *  但类型逐字对齐 VO，注释在声称对齐时就不能少列。 */
  zone: string;
  location: string | null;
  /** 当前在架**件数**（不是批数）：后端 `LEFT JOIN t_part_batch` 聚合 ——
   *  `status IN ('PENDING','IN_PROCESS','INSPECTION','OUTSOURCE')` 的批次
   *  `SUM(quantity)`，按 `current_holder_id` 分组；LEFT JOIN 保留 0 负载架
   *  （空架 = 0）。口径覆盖待加工 / 加工中 / 品检中 / 外协中四种占架状态。
   *  （返修批次 status 即 IN_PROCESS，`is_repairing` 是独立标记列，不另计。）*/
  current_load: number;
  /** 系统推荐标记；picker 弹窗时默认高亮 + 「完成」一键接受。
   *  ⚠️ **只有 for-return 有**。（2026-07-17 起前端不再据此自动高亮。） */
  is_recommended: boolean;
  // 2026-10-02 摘除 display_order / mapped_process_codes：后端
  // `ShelfForReturnItem`（`src/modules/shelf/vo/shelf.rs`）只有
  // id / code / name / zone / location / current_load / is_recommended 七字段
  // （zone 已如上补齐）。原来这两个字段是纯类型谎言：mapped_process_codes 恒
  // undefined ⇒ ShelfPickerDialog 传给 HmiPickerCard 的 chips 恒不渲染；
  // display_order 零消费。
}

export interface ShelfForReturnResult {
  items: ShelfForReturn[];
  // 2026-10-02 摘除 recommended_shelf_id：全仓零消费，且后端把推荐标记放在每个
  // item 的 is_recommended 上（ShelfForReturnOut 只有 items 一个字段）。
}

/** `GET /shelves/for-inspection` 响应 item。
 *  对应后端 VO `ShelfForInspectionItem` —— 与 for-return VO **不是同一个结构体**，
 *  字段顺序照抄后端。
 *  `is_recommended` 恒不存在（推荐语义只属于 for-return）。 */
export interface ShelfForInspection {
  id: string;
  code: string;
  name: string;
  zone: string;
  location: string | null;
  /** 恒为 true —— 端点查询条件就是 `is_active = true`；保留字段只为逐字对齐 VO。 */
  is_active: boolean;
  /** 在架件数。前端按后端同款 `SUM(quantity)` 口径理解（见
   *  `ShelfForReturn.current_load`）；后端若改了口径需同步本注释。
   *  **可选**：后端**计划**给 for-inspection 补这层聚合，当前 VO 仍无该字段
   *  （两个仓并行推进，合并时后端可能尚未上线），故声明为可选。消费侧不假设它存在
   *  —— `HmiPickerCard` 收到 undefined 就不渲染「在架 N 件」。 */
  current_load?: number;
}

export interface ShelfForInspectionResult {
  items: ShelfForInspection[];
}

/** `ShelfPickerDialog` 卡片网格的**元素级联合**：两个 VO 都可能出现在同一张网格里
 *  （dialog 的 `kind` prop 决定走哪个端点）。公共字段 id / code / name / zone /
 *  location / current_load 在两侧都有（后者品检侧可选，见 ShelfForInspection），
 *  消费侧读这些零成本。
 *
 *  2026-10-02 新增：拆出 `ShelfForInspection` 后 dialog 必须接这个联合类型 ——
 *  继续声明 `ShelfForReturn[]` 就等于让品检路径依赖 for-return 独有的 is_recommended。 */
export type ShelfPickerItem = ShelfForReturn | ShelfForInspection;
