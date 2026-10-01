export interface Shelf {
  id: string;
  /** 乐观锁版本号；每次 UPDATE 自增 */
  version: number;
  code: string;
  name: string;
  zone: string; // PRODUCTION | INSPECTION
  location: string | null;
  is_active: boolean;
  // 2026-10-02 摘除 account_count：配套后端删除 ShelfOut.account_count
  //（用户已拍板「舍弃这个字段，前端不再显示」），前端类型 / 表格列同步摘除。
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
// docs/api/shelves.md:216-270 + src/modules/shelf/vo/process_mapping.rs）
//
// 修复缘由：v1(Python) 迁 v2(Rust) 时前端停在了旧形态 ——
//   写：发 `{process_ids: string[]}`，后端 `SetShelfProcessesRequest{items:[...]}`
//       的 items 必填无 default → serde missing field → 40001 → HTTP 422
//       （该功能自迁移以来从未成功过一次）；
//   读：读 `sp.processes`，后端实际返 `{items:[...]}` → 恒 undefined。
// 因此下面两个接口的类型**只声明后端真实存在的字段**，不再留 v1 影子。
// ============================================================

/** 单条 shelf ↔ process 映射行（`GET /shelves/{id}/processes` 与
 *  `GET /shelves/processes` 共用同一扁平行形态；后端按 sort_order ASC 返回）。 */
export interface ShelfProcessMappingItem {
  shelf_id: string;
  shelf_code: string;
  process_id: string;
  process_code: string;
  /** 后端 GET 单架接口返该字段；全集接口（AllShelfProcessMappingItem）不返，
   *  故声明为可选，消费侧按 `?? 0` 兜底。 */
  sort_order?: number;
}

/** `GET /shelves/{id}/processes` 响应体。 */
export interface ShelfProcessesResult {
  items: ShelfProcessMappingItem[];
}

/** `POST /shelves/{id}/processes` 请求体（整组替换；items 可为 [] = 清空映射）。
 *  sort_order 语义沿 v1 契约「提交顺序即 sort_order」。 */
export interface SetShelfProcessesPayload {
  items: Array<{ process_id: string; sort_order: number }>;
}

// ============================================================
// 共享 HMI RETURN 卡片网格 picker（2026-07-10）
// ============================================================
export interface ShelfForReturn {
  id: string;
  code: string;
  name: string;
  location: string | null;
  /** 当前在架件数（status=IN_PROCESS + holder=shelf） */
  current_load: number;
  /** 系统推荐标记；picker 弹窗时默认高亮 + 「完成」一键接受 */
  is_recommended: boolean;
  // 2026-10-02 摘除 display_order / mapped_process_codes：后端
  // ShelfForReturnItem（backend-rust/src/modules/shelf/vo/shelf.rs:48-57）只有
  // id / code / name / zone / location / current_load / is_recommended 七字段。
  // 原来这两个字段是纯类型谎言：mapped_process_codes 恒 undefined ⇒
  // ShelfPickerDialog 传给 HmiPickerCard 的 chips 恒不渲染；display_order 零消费。
}

export interface ShelfForReturnResult {
  items: ShelfForReturn[];
  // 2026-10-02 摘除 recommended_shelf_id：全仓零消费，且后端把推荐标记放在每个
  // item 的 is_recommended 上（ShelfForReturnOut 只有 items 一个字段）。
}
