// 2026-09-14 新增：process_chain 域前端契约（types only，无 runtime）。
// 2026-09-15 Phase 5：业务全切 v2；端点 baseURL `/api/v2`，业务统一走 `api`。
//
// 端点（与 backend-rust/src/modules/process_chain/handler.rs 对齐）：
//   GET  /api/v2/process-chains/by-part/{part_id}  ← getProcessChainByPart
//   PUT  /api/v2/process-chains/by-part/{part_id}  ← upsertProcessChainByPart
//
// 端点形状以 rust 实际为准（process-chain.md）：
// - i64 主键 → JSON 字符串（雪花 ID 防 JS 精度截断，CLAUDE.md #3）
// - 单步字段：sort_order / process_id / estimated_minutes / note（无 enabled 标志，rust 缺该字段）
// - 整组 upsert 语义：steps 数组完整替换；不存在的 part 自动建链

/** 单步工艺（rust ProcessChainStepOut + UpsertChainStep 共用形状）。
 *  `id` 仅 GET 响应携带（PUT 提交时不需；service 软删旧 steps 后 INSERT 新行）。 */
export interface ProcessChainStepDto {
  id?: string;
  /** 0-based 顺序；后端按 sort_order ASC, id ASC 排序（process-chain.md §DTO） */
  sort_order: number;
  /** FK → Process.id（雪花 ID 字符串，禁止 Number() 转换） */
  process_id: string;
  /** 预估耗时（≥0；CHECK 约束，rust 端 20104 校验） */
  estimated_minutes: number;
  /** 单步备注；空串/null 视作 None */
  note?: string | null;
  /** 乐观锁；GET 响应携带，PUT 不需 */
  version?: number;
}

/** 工艺链详情（rust ProcessChainOut）。 */
export interface ProcessChainByPartDto {
  id: string;
  part_id: string;
  /** 链名；upsert 时空串视为「不修改」/ 默认 `'默认工艺'` */
  name: string;
  note: string | null;
  /** 乐观锁；upsert 整组替换 +1 */
  version: number;
  created_at: string;
  updated_at: string;
  steps: ProcessChainStepDto[];
}

/** 整组 upsert 请求（rust UpsertChainRequest）。
 *  替换语义：保留 header id，version++，软删旧 steps，INSERT 新 steps。
 *  空数组 steps 表示「保留 header 但清空所有步骤」。 */
export interface UpsertProcessChainRequest {
  /** 链名；空串视为「不修改」；新建时默认 `'默认工艺'` */
  name?: string;
  /** 备注；空串视为「显式清空」 */
  note?: string | null;
  steps: ProcessChainStepDto[];
}
