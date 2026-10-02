/** 工种 (WorkType) — 工人所属的工种类别 */

export interface WorkType {
  id: string;
  /** 乐观锁版本号；每次 UPDATE 自增 */
  version: number;
  code: string;
  name: string;
  description: string | null;
  sort_order: number;
  /** 2026-08-05：工种可领取上限（持有批次数）；null=不限 */
  max_held_batches: number | null;
  /** 2026-10-02 补：已映射的工序 id 列表（JSON 形态 `["123","456"]`）。后端
   *  `WorkTypeOut.process_ids`（backend-rust src/modules/prod/work_type/vo/work_type.rs:20）
   *  由 service 层用 `WorkTypeProcessRepo::list_by_work_types_batch` **单条 SQL 批量
   *  补全**（防 N+1），list / detail 两个端点都带；空数组 = 未映射任何工序。
   *  此前本 interface 漏声明它，`types.ts` 与 VO 不同步。 */
  process_ids: string[];
  created_at: string;
  updated_at: string;
}

export interface WorkTypeListResult {
  items: WorkType[];
  total: number;
  limit: number;
  offset: number;
}

export interface WorkTypeCreatePayload {
  code: string;
  name: string;
  description?: string | null;
  sort_order?: number;
  max_held_batches?: number | null;
}

export interface WorkTypeUpdatePayload {
  name?: string;
  description?: string | null;
  sort_order?: number;
  max_held_batches?: number | null;
}

/**
 * 2026-10-02 契约对齐：工种↔工序映射行（backend-rust `WorkTypeProcessMappingItem`）。
 *
 * 后端**只返 4 个字段**（docs/api/production/work-type-process-mapping.md:96-99
 * 字段表 / `src/modules/prod/work_type/vo/process_mapping.rs`）：
 * work_type_id / process_id / process_code / sort_order。
 *
 * - 新增 `work_type_id`：后端恒返（映射行天然带），此前前端类型漏声明。
 * - 删 `process_name`：**后端不返这个键**。旧类型里的它是 v1(Python) 影子字段 ——
 *   留着不会让编译期报错（读了得到 undefined），只会让调用方以为有值可用。
 *   工序展示名请走 `process_code` 或工单候选源里的 Process 列表。
 * - `sort_order` 保持必填：后端 SQL 是 `ORDER BY sp.sort_order ASC, id ASC`，
 *   恒返非空；不用 `?? 0` 兜底（那会把契约漂移静默吞掉）。
 */
export interface WorkTypeProcessLink {
  work_type_id: string;
  process_id: string;
  process_code: string;
  sort_order: number;
}

/**
 * 2026-10-02 契约对齐：`GET /api/v2/prod/work-types/{id}/processes` 的响应。
 *
 * 后端 `WorkTypeProcessMappingOut` **只有 `items` 一个键**（无分页信封 ——
 * 该端点不接 limit/offset，一次返全部；doc :56 / :112）。
 *
 * ⚠️ 旧实现声明的 `WorkTypeWithProcesses`（extends WorkType + `processes: []`）是
 * v1(Python) 影子类型：响应里既没有 `processes` 也没有 WorkType 的 10 个字段。
 * 线上症状 = 工序管理「工序映射」Tab 点工种后 `Cannot read properties of undefined
 * (reading 'map')`（`detail.processes.map(...)`，TypeError 抛在 try 内被 catch 吞掉
 * 后原样 ElMessage.error 弹出 = 用户看到的 toast）。该影子类型已删除。
 */
export interface WorkTypeProcessesResult {
  items: WorkTypeProcessLink[];
}

/**
 * 2026-10-02 契约修正：`POST /api/v2/prod/work-types/{id}/processes` 的请求体。
 *
 * **整组替换**语义（service 先 `soft_delete_all_for_work_type` → `bulk_insert`，
 * doc :72「维护约定」第 2 条）：`items: []` = 清空该工种全部映射。
 *
 * 旧形态 `{ process_ids: string[] }` 是 v1 影子 payload，后端
 * `SetWorkTypeProcessesRequest` 无该键 ⇒ serde missing field ⇒ 40001 → HTTP 422。
 * ⚠️ 更危险的是「静默清空」路径：若某个调用点发了 `{ process_ids: [...] }` 而被
 * 归一化成 `items: []`，该工种全部映射会被无声清掉。形状收口到
 * `toWorkTypeProcessesPayload`（src/api/workType.ts）+ 单测逐字断言，见该函数注释。
 */
export interface SetWorkTypeProcessesPayload {
  items: Array<{ process_id: string; sort_order: number }>;
}
