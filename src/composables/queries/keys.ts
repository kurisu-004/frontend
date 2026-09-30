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
import type { UnionListParams } from '@/api/com/unionList';

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
  /** 2026-09-29 新增：dashboard「紧急工单 Top 列表」queryKey。
   *  listUnionItems 拉 100 件按 planned_delivery_date ASC 的非终态件，客户端再按
   *  today+7 过滤取 top 15。命中 useDashboardInvalidation 同套 AFFECTS_DASHBOARD
   *  事件集后自动 invalidate 重取。 */
  dashboardUrgentList: ['dashboard', 'urgent-list'] as const,
  /** 2026-09-29 新增：dashboard「逾期未交 KPI」queryKey。
   *  fetchOverview 拉当天日期范围内的 overdue_undelivered_count，仅 Manager 角色
   *  启用（enabled: isManager 闸门），非 Manager 不发请求。 */
  dashboardOverdue: ['dashboard', 'overdue'] as const,
  /** 2026-09-30 新增：dashboard「7 天交期柱状图按层点击抽屉」queryKey。
   *  listUnionItems({ row_type: 'PART', statuses, planned_delivery_date_from =
   *  to = date, sort_by: 'PLANNED_DELIVERY_DATE', sort_dir: 'ASC', limit: 500,
   *  offset: 0 }) 拉该日 × 该层状态的所有工单。 */
  dashboardUpcomingList: (params: { date: string; statuses: string[] }) =>
    ['dashboard', 'upcoming-list', params] as const,
  /** 2026-09-28 新增：dashboard 域前缀 —— WS 事件触发 invalidate 用；
   *  包含 dashboardSnapshot / dashboardUrgentList / dashboardOverdue 三个 query，
   *  invalidateQueries({ queryKey: qk.dashboardPrefix }) 一键全失效。 */
  dashboardPrefix: ['dashboard'] as const,
  /** 2026-09-29 新增：零件 owner 维度文件列表共享 query 键。
   *  单请求 owner 全量，computed 内按 kind 桶。失效粒度 = owner 维度。 */
  partFilesList: (ownerId: string) => ['part-files', 'list', ownerId] as const,
  /** 2026-09-29 新增：part-files 域前缀 —— 上传 / 删除完成后调用方通过
   *  qc.invalidateQueries({ queryKey: qk.partFilesPrefix }) 失效整个 part-files
   *  域（任意 ownerId 形态都会命中）。 */
  partFilesPrefix: ['part-files'] as const,
  /** 2026-09-30 新增：零件 owner 维度批次列表 query 键（与 partFilesList 同形命名），
   *  供 dashboard PartPreviewDialog 通用预览用。listPartBatches(partId) 拉 owner 全
   *  量子表，按 owner 失效。 */
  partBatchesList: (partId: string) => ['part-batches', 'list', partId] as const,
  /** 2026-09-30 新增：part-batches 域前缀 —— 拆分 / 取消批次后调用方通过
   *  qc.invalidateQueries({ queryKey: qk.partBatchesPrefix }) 失效整个 part-batches
   *  域（任意 partId 形态都会命中）。 */
  partBatchesPrefix: ['part-batches'] as const,
  /** 2026-09-29 新增：待下发批次列表键工厂 —— list / 单参数形态（沿 processesList 同形）。
   *  Consumer：usePendingBatchesQuery（在 src/composables/queries/usePendingBatchesQuery.ts）。 */
  pendingBatchesList: (params: ListPendingBatchesParams) =>
    ['pending-batches', 'list', params] as const,
  /** 2026-09-29 新增：com 域 union-list 列表键 —— 零件一览页主查询
   *  （src/views/parts/list/composables/usePartsListQuery.ts）切换到
   *  GET /api/v2/com/union-list 后消费此键。params 内 row_type 必填。
   *  2026-09-29 修订：根命名空间沿用 'parts' 而非 'com'——union-list 端点虽在
   *  com 域路由下，但 TanStack Query 的 partialMatchKey 仅在同根命名空间内
   *  前缀匹配；原 ['com', 'union-list', params] 无法被 ['parts'] 前缀命中，
   *  导致 7 个 part 域 mutation（usePartDispatch / usePendingDispatch /
   *  usePartInlineEdit 40901 路径）失效后 union-list 缓存持续 stale。
   *  改用 ['parts', 'union-list', params] 后 qk.partsPrefix 仍是单一失效源。 */
  unionList: (params: UnionListParams) => ['parts', 'union-list', params] as const,
  /** 2026-09-29 修订：union-list 缓存身份已与 parts 域合并，unionPrefix 与
   *  partsPrefix 等价；保留命名仅为未来 com 域自有写操作（如非 part 维度
   *  union 写入）做扩展位 —— 实际失效调用方继续走 qk.partsPrefix。 */
  unionPrefix: ['parts', 'union-list'] as const,
  /** 2026-09-29 新增：pending-batches 域前缀 —— dispatch / bulk / auto 三类 mutation
   *  完成后调 qc.invalidateQueries({ queryKey: qk.pendingBatchesPrefix }) 失效整个域
   *  （任意 params 形态的 list 都会命中）。同时触发 processesPrefix + partsPrefix
   *  跨域失效（usePendingDispatch.ts 集中编排）。 */
  pendingBatchesPrefix: ['pending-batches'] as const,
  // ============================================================
  // 2026-09-30 新增：worker-pool 域 queryKey 工厂 —— 生产队列 Tab 懒加载 +
  // 数据层 TanStack Query 化（CLAUDE.md 2026-09-30 硬约束）的共享基础数据层。
  //
  // 三个 list / state query + 对应 prefix：
  //   - workerPoolCounts：全工序 batch 计数（eager，POSITIVE_INFINITY 缓存），
  //     tab 标题 (N) 徽标数据源，跨 tab 共享（与 worker-pool per-process 解耦）；
  //   - workerPoolByProcess：单工序 worker-pool 详情（lazy per consumer），
  //     与 WorkerPoolTab + PendingPoolCard 共享 cache identity（同 processId
  //     任意 component 实例命中即用）；
  //   - workerPoolStateByWorker：单 worker state（workerHeld + max_held），
  //     WorkerColumn 自管 query 拉取 + 跨 tab 共享。
  //
  // 失效规则（沿 2026-09-26 基础数据精确失效策略 #3）：
  //   - assignWorkerPool / removeFromWorkerPool / autoAllocate 三类 mutation
  //     完成后调 invalidateWorkerPoolByProcessQuery(qc, processId) +
  //     invalidateWorkerPoolCountsQuery(qc)（useWorkerQueue.ts 集中编排）；
  //   - dispatch / bulk / auto 三类 mutation 完成后 usePendingDispatch 集中
  //     失效三域（pendingBatchesPrefix + processesPrefix + partsPrefix） +
  //     refreshBoard 同步看板。
  //   - 写操作点全集中在 useWorkerQueue / usePendingDispatch，本件 store 外
  //     无其他写入（2026-09-30 grep 确认），失效可由 prefix 一把全刷。
  // ============================================================

  /** 2026-09-30 新增：全工序 batch 计数（eager 拉取，tab 标题徽标数据源）。
   *  入参 `params` 是 MaybeRefOrGetter<{ shelf_id?: string | null }>，reactive
   *  变化时 queryKey 自动变 → vue-query 自动 refetch。 */
  workerPoolCounts: (params: { shelf_id?: string | null } | undefined) =>
    ['worker-pool', 'counts', params ?? null] as const,
  /** 2026-09-30 新增：worker-pool counts 域前缀 —— 写 mutation 完成后
   *  qc.invalidateQueries({ queryKey: qk.workerPoolCountsPrefix }) 一键全失效。 */
  workerPoolCountsPrefix: ['worker-pool', 'counts'] as const,
  /** 2026-09-30 新增：单工序 worker-pool 详情（lazy per consumer）。
   *  processId 空字符串 → 占位 key（enabled=false 拦挡，queryFn 二次守卫）。 */
  workerPoolByProcess: (processId: string) =>
    ['worker-pool', 'by-process', processId] as const,
  /** 2026-09-30 新增：worker-pool by-process 域前缀 —— 写 mutation 完成后
   *  qc.invalidateQueries({ queryKey: qk.workerPoolByProcessPrefix }) 一键全失效
   *  （任意 processId 形态都会命中）。 */
  workerPoolByProcessPrefix: ['worker-pool', 'by-process'] as const,
  /** 2026-09-30 新增：单 worker state（workerHeld + max_held + current_held）。
   *  workerId + shelfId 双键 — WorkerColumn 自管 query 拉取 + 跨 tab 共享。
   *  shelf_id 占位空字符串（enabled=false 闸门挡掉无货架激活场景）。 */
  workerPoolStateByWorker: (workerId: string, shelfId: string) =>
    ['worker-pool', 'state', workerId, shelfId] as const,
  /** 2026-09-30 新增：worker-pool state 域前缀 —— assignWorkerPool /
   *  removeFromWorkerPool 完成后调（workerHeld 即时刷新）。 */
  workerPoolStatePrefix: ['worker-pool', 'state'] as const,
} as const;
