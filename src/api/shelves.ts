// 货架 API（走 @/api/http 统一 axios 客户端）。

import { api, cleanParams } from '@/api/http';
import type {
  Shelf,
  ShelfForReturnResult,
  ShelfListResult,
  ShelfProcessMappingItem,
  ShelfProcessesResult,
  SetShelfProcessesPayload,
} from '@/types/shelf';

export interface ListShelvesParams {
  zone?: string;
  is_active?: boolean;
  limit?: number;
  offset?: number;
}

export async function listShelves(params: ListShelvesParams = {}): Promise<ShelfListResult> {
  const resp = await api.get<ShelfListResult>('/shelves', {
    params: cleanParams(params),
  });
  return resp.data;
}

export interface CreateShelfPayload {
  code: string;
  name: string;
  zone: string;
  location?: string;
  display_order?: number;
}

export async function createShelf(payload: CreateShelfPayload): Promise<Shelf> {
  const resp = await api.post<Shelf>('/shelves', payload);
  return resp.data;
}

export interface UpdateShelfPayload {
  name?: string;
  location?: string;
  is_active?: boolean;
  display_order?: number;
}

export async function updateShelf(id: string, payload: UpdateShelfPayload): Promise<Shelf> {
  const resp = await api.post<Shelf>(`/shelves/${id}/update`, payload);
  return resp.data;
}

export async function deactivateShelf(id: string): Promise<Shelf> {
  const resp = await api.post<Shelf>(`/shelves/${id}/deactivate`);
  return resp.data;
}

/**
 * 2026-10-02 修：读取单架已映射工序。
 *
 * 旧实现声明返回 `ShelfWithProcesses {..., processes: [...]}`，那是 v1(Python)
 * 形态 —— 后端 v2 实际返 `{items: [{shelf_id, shelf_code, process_id,
 * process_code, sort_order}]}`，消费侧 `sp.processes` 恒 undefined。
 * 对齐 backend-rust docs/api/shelves.md:216-240 + vo/process_mapping.rs。
 */
export async function getShelfProcesses(id: string): Promise<ShelfProcessesResult> {
  const resp = await api.get<ShelfProcessesResult>(`/shelves/${id}/processes`);
  return resp.data;
}

/**
 * 2026-10-02 修：把「下拉多选 id 列表」编成后端 `SetShelfProcessesRequest` 的
 * `items` 数组。
 *
 * 抽成纯函数而不是内联在 ShelfList.vue 里，是因为 BUG-1 的本质就是「调用方编错了
 * 请求形态」—— 类型系统挡不住对象字面量的 key 名拼错（`{process_ids}` 恰好满足
 * 旧的 `SetShelfProcessesPayload`）。把这个映射收口到一处 + 本文件单测逐字断言，
 * 调用方就再也编不出 v1 形态。
 *
 * sort_order 取数组下标：沿 v1(Python) 契约「提交顺序即 sort_order」的语义 —— 前端
 * 没有独立的拖拽排序入口，el-select 多选的选中顺序就是业务上的工序顺序。
 */
export function toShelfProcessesPayload(processIds: readonly string[]): SetShelfProcessesPayload {
  return { items: processIds.map((process_id, idx) => ({ process_id, sort_order: idx })) };
}

/**
 * 2026-10-02 修：把 `GET /shelves/{id}/processes` 的响应还原成下拉多选 id 列表。
 *
 * 抽成纯函数同 toShelfProcessesPayload 的动机：BUG-2 的本质是「调用方读错响应
 * 形态」（旧代码 `sp.processes.map(...)` —— 后端返 `{items:[...]}`，`processes`
 * 恒 undefined → TypeError → 被裸 catch 吞掉 → 每次打开编辑弹窗已选工序被清空，
 * 用户不察觉点保存就静默清空整组映射）。收口 + 单测后读形态不可能再漂。
 *
 * 排序：后端已按 `ORDER BY sp.sort_order ASC, sp.id ASC` 返回，这里再显式排一次，
 * 目的是 sort_order 缺失 / 重复时仍得到稳定顺序 —— 顺序不稳定会让用户每次打开
 * 弹窗看到的工序次序不同，保存后又整体重排。
 */
export function toShelfProcessIds(result: ShelfProcessesResult): string[] {
  return [...result.items]
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    .map((p) => p.process_id);
}

/**
 * 2026-10-02 修：整组替换单架的工序映射（items 可为 [] = 清空）。
 *
 * - 请求体：必须是 `{items: [{process_id, sort_order}]}`。旧实现发
 *   `{process_ids: string[]}`，后端 `SetShelfProcessesRequest.items` 必填且无
 *   `#[serde(default)]` → serde missing field → 40001 VALIDATION_ERROR →
 *   HTTP 422（用户 2026-10-02 报的就是这个；该功能自 v1 迁 v2 起从未成功过）。
 * - 响应：`data` 为 null（整组替换无回显），故返回 Promise<void>，不再谎称
 *   返回 ShelfWithProcesses。
 */
export async function setShelfProcesses(
  id: string,
  payload: SetShelfProcessesPayload,
): Promise<void> {
  await api.post(`/shelves/${id}/processes`, payload);
}

/**
 * 共享 HMI RETURN 卡片网格 picker 数据源。
 * 后端 `GET /shelves/for-return?next_process_id=...`
 * 返回候选架列表（按 current_load ASC 排序）+ 系统推荐架 id。
 *
 * 错误：20506 BIZ_SHELF_NO_MATCH_FOR_PROCESS（没有 active 架映射该 process）
 */
export async function listShelvesForReturn(nextProcessId: string): Promise<ShelfForReturnResult> {
  const resp = await api.get<ShelfForReturnResult>('/shelves/for-return', {
    params: { next_process_id: nextProcessId },
  });
  return resp.data;
}

/**
 * 2026-07-13 新增：共享 HMI INSPECT 卡片网格 picker 数据源。
 * 后端 `GET /shelves/for-inspection`
 * 返回 active INSPECTION 货架列表（按 current_load ASC 排序）+ 推荐架。
 *
 * 错误：20506 BIZ_SHELF_NO_MATCH_FOR_PROCESS（没有 INSPECTION 架或用户
 * scope 内无 INSPECTION 架）。
 */
export async function listShelvesForInspection(): Promise<ShelfForReturnResult> {
  const resp = await api.get<ShelfForReturnResult>('/shelves/for-inspection');
  return resp.data;
}

/**
 * 2026-07-17 新增：批量取所有 active 货架的工序映射。
 * 后端 `GET /shelves/processes`
 *
 * 2026-10-02 订正：旧注释写的 `{items: [{shelf_id, process_ids}, ...]}`
 * （一架子集一个元素）是 **v1(Python) 形态**，v2 后端返的是**扁平行**——一行一个
 * (货架, 工序) 对，同一 shelf_id 会出现多行：`{items: [{shelf_id, shelf_code,
 * process_id, process_code}]}`（AllShelfProcessMappingItem，注意它**不返**
 * sort_order，排序由 service 层 ORDER BY 保证）。空映射的货架不出现在 items 中。
 *
 * 消费侧 `useShelfProcessFilter` 必须按 shelf_id regroup 扁平行，不能读
 * `item.process_ids`（恒 undefined ⇒ 空集 ⇒ 8 个页面的下拉被静默清空）。
 *
 * 给 `useShelfProcessFilter` composable 一次性消费，避免弹窗打开时
 * N+1 次 `GET /shelves/{id}/processes` 调用。
 */
export interface ShelfProcessMappingsResult {
  items: Array<Omit<ShelfProcessMappingItem, 'sort_order'>>;
}
export async function getAllShelfProcessMappings(): Promise<ShelfProcessMappingsResult> {
  const resp = await api.get<ShelfProcessMappingsResult>('/shelves/processes');
  return resp.data;
}
