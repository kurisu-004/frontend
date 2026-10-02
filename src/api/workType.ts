// 工种 (WorkType) API 封装。
//
// 2026-10-02 契约修正：映射两个端点的请求 / 响应形态此前是 v1(Python) 影子类型
// （WorkTypeWithProcesses / {process_ids}），与后端实际契约不符 —— 详见
// 下方 getWorkTypeProcesses / setWorkTypeProcesses 与 @/types/workType.ts 的注释。
// 本文件同时承担「收口映射 payload / result 形态」的两个纯函数（与 shelves.ts 同款
// 设计），原因见那两处注释。

import { api, cleanParams } from '@/api/http';
import type {
  SetWorkTypeProcessesPayload,
  WorkType,
  WorkTypeCreatePayload,
  WorkTypeListResult,
  WorkTypeProcessesResult,
  WorkTypeUpdatePayload,
} from '@/types/workType';

/** 2026-10-02：listWorkTypes 的入参形态提为具名 type —— 共享 query
 *  `useWorkTypesQuery` 的 queryKey / queryFn 都要引用它（key 工厂在
 *  composables/queries/keys.ts，api 层是形态的唯一定义处，沿 ListShelvesParams /
 *  ListPendingBatchesParams 的既有做法）。 */
export interface WorkTypeListParams {
  code_like?: string;
  limit?: number;
  offset?: number;
}

export async function listWorkTypes(params: WorkTypeListParams = {}): Promise<WorkTypeListResult> {
  // 2026-09-25 修正：后端路由前缀缺失 /prod/ 段，补齐对齐 v2 backend-rust 实际契约。
  const resp = await api.get<WorkTypeListResult>('/prod/work-types', {
    params: cleanParams(params),
  });
  return resp.data;
}

export async function getWorkType(id: string): Promise<WorkType> {
  const resp = await api.get<WorkType>(`/prod/work-types/${id}`);
  return resp.data;
}

export async function createWorkType(payload: WorkTypeCreatePayload): Promise<WorkType> {
  const resp = await api.post<WorkType>('/prod/work-types', payload);
  return resp.data;
}

export async function updateWorkType(
  id: string,
  payload: WorkTypeUpdatePayload,
): Promise<WorkType> {
  const resp = await api.post<WorkType>(`/prod/work-types/${id}/update`, payload);
  return resp.data;
}

export async function softDeleteWorkType(id: string): Promise<void> {
  await api.post(`/prod/work-types/${id}/soft-delete`);
}

/**
 * 2026-10-02 修：整组替换某工种的工序映射（`items: []` = 清空全部）。
 *
 * - 响应：`data` 为 `null`（整组替换无回显，doc :79），故返回 `Promise<void>`，
 *   不再谎称返回 `WorkTypeWithProcesses`（该影子类型同时已删除）。
 * - 请求体：必须由 `toWorkTypeProcessesPayload` 生成 —— 旧实现发
 *   `{process_ids: string[]}`，后端 `SetWorkTypeProcessesRequest` 无该键。
 *
 * ⚠️ 整组替换语义本身是危险操作：任何形态错误的 payload 一旦被归一化成
 * `items: []`，该工种的全部映射会被无声清掉且无提示。防线有三层：
 *   ① 形状收口到纯函数（类型系统挡不住对象字面量 key 拼错，见该函数注释）；
 *   ② src/api/workType.spec.ts 逐字断言 payload 形态；
 *   ③ 视图层 onSave 前的「映射加载失败硬闸」（加载失败时禁止保存）——
 *      否则「加载失败 + 用户看到空勾选 + 点保存」= 拿不完整快照整组覆盖真实映射。
 */
export async function setWorkTypeProcesses(
  workTypeId: string,
  payload: SetWorkTypeProcessesPayload,
): Promise<void> {
  await api.post(`/prod/work-types/${workTypeId}/processes`, payload);
}

/**
 * 2026-10-02 修：拉取某工种已映射的工序列表。
 *
 * 响应 `data` = `WorkTypeProcessMappingOut` = `{items: [...]}`，**只有 items 一个键**
 * （无分页信封）。旧的 `WorkTypeWithProcesses`（extends WorkType + `processes: []`）
 * 是 v1 影子类型：读 `detail.processes` 恒 undefined → `.map()` 抛 TypeError →
 * 被裸 catch 吞掉后原样弹 toast（用户 2026-10-02 报的原 bug）。
 * **读形态请一律走 `toWorkTypeProcessIds`**，理由同下。
 */
export async function getWorkTypeProcesses(workTypeId: string): Promise<WorkTypeProcessesResult> {
  const resp = await api.get<WorkTypeProcessesResult>(`/prod/work-types/${workTypeId}/processes`);
  return resp.data;
}

/**
 * 2026-10-02 新增：把「勾选的工序 id 列表」编成后端
 * `SetWorkTypeProcessesRequest` 的 `items` 数组。
 *
 * 抽成纯函数而不是内联在 ProcessWorkTypeMappingTab.vue 里，是因为 BUG-1 的本质
 * 就是「调用方编错了请求形态」—— **类型系统挡不住对象字面量的 key 名拼错**：
 * 旧的 `{process_ids: selectedProcessIds.value}` 恰好满足旧的
 * `SetWorkTypeProcessesPayload = {process_ids: string[]}`，编译期完全合法。
 * （同款设计先例：src/api/shelves.ts 的 toShelfProcessesPayload，2026-10-02。）收口
 * 到一处 + 本文件单测逐字断言后，调用方就再也编不出 v1 形态。
 *
 * sort_order 取数组下标：沿 v1 契约「提交顺序即 sort_order」的语义 —— 前端没有独立
 * 的拖拽排序入口，勾选的选中顺序就是业务上的工序顺序。
 *
 * 去重（`[...new Set(...)]`）：`t_work_type_process` 上有
 * `(work_type_id, process_id)` 唯一约束，items 里出现重复 process_id 时
 * `bulk_insert` 撞唯一索引 → HTTP 500。今天 el-checkbox-group 产不出重复值，但本
 * 函数的立身之本是「收口 payload 形态」——将来若改成「已有映射 + 新增勾选」合并
 * 提交，重复就会真实发生。`sort_order` 按**去重后**的下标重算（沿用原下标会留下
 * 空洞，语义上不再是 0..n-1 的连续顺序）。
 *
 * 空数组**必须**发 `{items: []}`（不能省略 key）：后端 items 是必填 Vec
 * （无 `#[serde(default)]`），漏键会 40001 → HTTP 422；而 `items: []` 是
 * 「清空整组映射」的合法表达。
 */
export function toWorkTypeProcessesPayload(
  processIds: readonly string[],
): SetWorkTypeProcessesPayload {
  const unique = [...new Set(processIds)];
  return { items: unique.map((process_id, idx) => ({ process_id, sort_order: idx })) };
}

/**
 * 2026-10-02 新增：把 `GET /prod/work-types/{id}/processes` 的响应还原成
 * 「勾选的工序 id 列表」。
 *
 * 抽成纯函数同 toWorkTypeProcessesPayload 的动机：BUG-2 的本质是「调用方读错响应
 * 形态」（旧代码 `detail.processes.map(...)`）。收口 + 单测后读形态不可能再漂。
 *
 * 排序：后端该端点已按 `ORDER BY sp.sort_order ASC, sp.id ASC` 返回，这里再显式排
 * 一次。`sort_order` 重复时靠 `Array.prototype.sort` 的稳定性（ES2019 起规范保证）
 * 保住后端给的 id ASC 次序，仍然稳定。
 */
export function toWorkTypeProcessIds(result: WorkTypeProcessesResult): string[] {
  return [...result.items].sort((a, b) => a.sort_order - b.sort_order).map((p) => p.process_id);
}
