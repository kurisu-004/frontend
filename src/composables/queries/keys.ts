// 2026-09-26 新增：TanStack Query 共享基础数据层（2026-09-26 新增）。
//
// queryKey 工厂，全仓唯一来源。所有 useQuery / queryClient.invalidateQueries
// 必须走这里的 qk.xxx，禁止在调用点拼字面量数组——否则键类型漂移会让
// invalidateQueries 精确失效失效。
//
// 失效规则：
//   - 域内任何写操作（create / update / softDelete）后，调用方通过
//     qc.invalidateQueries({ queryKey: qk.<domain>Prefix }) 失效整个域；
//     整域内每个 useQuery 共享 gcTime: POSITIVE_INFINITY，失效只重置 staleTime
//     状态（始终 fresh），下次访问走 queryFn 重拉——避免对每条数据单独管理 key。
//   - useQuery 本体 staleTime: POSITIVE_INFINITY + gcTime: POSITIVE_INFINITY
//     （会话级缓存），基础数据（KB 级）不再主动失效，依赖写入端精确 invalidate。
//
// 锁字面量类型：所有键数组用 as const，调用方拿到的类型是 readonly tuple，
// 与 TanStack Query 的 QueryKey = readonly unknown[] 契约对齐。

import type { ListPartsParams } from '@/api/parts';
import type { ListPendingBatchesParams } from '@/api/pendingBatches';
import type { ProcessCategory } from '@/types/process';

/** 2026-09-26 新增：工序列表 / 下拉选项 query 入参形态（与 api/process.ts listProcesses 同步）。
 *  含 code_like / category / limit / offset 四字段；与 ListProcessesParams 同形，预留扩展分叉。 */
export interface ProcessListParams {
  code_like?: string;
  category?: ProcessCategory;
  limit?: number;
  offset?: number;
}

/** 2026-09-26 新增：与 ProcessListParams 同形（当前 listProcesses 只有一种调用形态），
 *  保留独立命名以对齐 ListPartsParams 风格，方便未来分叉为「全量列表 vs 下拉选项」
 *  两套入参（例如管理页加 sort_by / 筛选条件，下拉保持 limit:200 简单契约）。 */
export type ListProcessesParams = ProcessListParams;

export const qk = {
  customersList: ['customers', 'list'] as const,
  customersPrefix: ['customers'] as const,
  processesOptions: (params: ProcessListParams | undefined) =>
    ['processes', 'options', params ?? null] as const,
  processesList: (params: ListProcessesParams) =>
    ['processes', 'list', params] as const,
  processesPrefix: ['processes'] as const,
  /** 2026-09-26 新增：零件列表键工厂 —— A 任务只对齐键类型，useQuery 由 B 任务实现。 */
  partsList: (params: ListPartsParams) => ['parts', 'list', params] as const,
  /** 2026-09-26 追加（B 任务）：零件域前缀 —— 下发 / 召回 / 行内编辑完成后
   *  qc.invalidateQueries({ queryKey: qk.partsPrefix }) 失效整个 parts 域（任意
   *  listParts 参数形态都会命中）。与 customersPrefix / processesPrefix 同形。 */
  partsPrefix: ['parts'] as const,
  /** 2026-09-28 新增：dashboard 域大屏快照键（HTTP 全量首取 + WS 事件 invalidate）。
   *  与 customersList / processesList 等 list 形态不同 —— dashboard snapshot 是
   *  全量单条（无 params），HTTP 端点 GET /api/v2/dashboard/snapshot 一次取回
   *  完整 DashboardSnapshotVO。 */
  dashboardSnapshot: ['dashboard', 'snapshot'] as const,
  /** 2026-09-28 新增：dashboard 域前缀 —— WS 事件触发 invalidate 用；
   *  当前 dashboard 域只有 snapshot 一个 query，Prefix 仅供未来扩展（如分视图
   *  缓存、按角色拆 queryKey）预留。 */
  dashboardPrefix: ['dashboard'] as const,
  /** 2026-09-29 新增：零件 owner 维度文件列表共享 query 键。
   *  单请求 owner 全量，computed 内按 kind 桶。失效粒度 = owner 维度。 */
  partFilesList: (ownerId: string) => ['part-files', 'list', ownerId] as const,
  /** 2026-09-29 新增：part-files 域前缀 —— 上传 / 删除完成后调用方通过
   *  qc.invalidateQueries({ queryKey: qk.partFilesPrefix }) 失效整个 part-files
   *  域（任意 ownerId 形态都会命中）。 */
  partFilesPrefix: ['part-files'] as const,
  /** 2026-09-29 新增：待下发批次列表键工厂 —— list / 单参数形态（沿 processesList 同形）。
   *  Consumer：usePendingBatchesQuery（在 src/composables/queries/usePendingBatchesQuery.ts）。 */
  pendingBatchesList: (params: ListPendingBatchesParams) =>
    ['pending-batches', 'list', params] as const,
  /** 2026-09-29 新增：pending-batches 域前缀 —— dispatch / bulk / auto 三类 mutation
   *  完成后调 qc.invalidateQueries({ queryKey: qk.pendingBatchesPrefix }) 失效整个域
   *  （任意 params 形态的 list 都会命中）。同时触发 processesPrefix + partsPrefix
   *  跨域失效（usePendingDispatch.ts 集中编排）。 */
  pendingBatchesPrefix: ['pending-batches'] as const,
} as const;
