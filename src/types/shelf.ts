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
