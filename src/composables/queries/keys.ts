// 2026-09-26 新增：TanStack Query 共享基础数据层（2026-09-26 新增）。
//
// queryKey 工厂，全仓唯一来源。所有 useQuery / queryClient.invalidateQueries
// 必须走这里的 qk.xxx，禁止在调用点拼字面量数组——否则键类型漂移会让
// invalidateQueries 精确失效失效。
//
// 失效规则（2026-09-30 策略变更后）：
//   - 域内任何写操作（create / update / softDelete）后，调用方通过
//     qc.invalidateQueries({ queryKey: qk.<domain>Prefix }) 失效整个域。
//   - 共享基础数据层各 useQuery 用**有限** staleTime（30s）/ gcTime（5min），
//     不再用 POSITIVE_INFINITY 会话级缓存 —— TanStack Query 在本仓是「短时请求去重
//     层」，不保证新鲜度；超 staleTime 的访问自动 refetch。
//   - 失效调用点是**优化**（写完立即看到自己那笔），**不是一致性保证**：跨页面写
//     操作（送检 / worker-scan / 品检流转 / outsource 收发等会改工序候选池成员资格的
//     流转端点）不要求在每个写点补失效 —— 那需要穷举全仓写点，不可持续。新鲜度由
//     有限 staleTime + WS 事件 / 显式 refetch 负责（见 CLAUDE.md 缓存时长策略）。
//
// 锁字面量类型：所有键数组用 as const，调用方拿到的类型是 readonly tuple，
// 与 TanStack Query 的 QueryKey = readonly unknown[] 契约对齐。

import type { ListInspectionQueueParams } from '@/api/inspection';
import type { ListPartsParams } from '@/api/parts';
import type { ListPendingBatchesParams } from '@/api/pendingBatches';
import type { ListPendingProgrammingParams } from '@/api/programming';
// 2026-10-05：入参形态在 api/processChain.ts 定义（api 层是 wire 契约的唯一定义处，
// 沿上面几个 List*Params 的既有做法），本文件只引用。
import type { ListProcessDesignPartsParams } from '@/api/processChain';
import type { ListShelvesParams } from '@/api/shelves';
// 2026-10-02：工种列表入参形态在 api/workType.ts 定义（api 层是 wire 契约的唯一定义
// 处，沿 ListShelvesParams / ListPendingBatchesParams 的既有做法），本文件只引用。
import type { WorkTypeListParams } from '@/api/workType';
import type { ProcessCategory } from '@/types/process';
import type { OrderStatus } from '@/types/parts';
import type { DeliveryBasis } from '@/types/dashboard';
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
  processesList: (params: ListProcessesParams) => ['processes', 'list', params] as const,
  processesPrefix: ['processes'] as const,
  /** 2026-09-26 新增：零件列表键工厂 —— A 任务只对齐键类型，useQuery 由 B 任务实现。 */
  partsList: (params: ListPartsParams) => ['parts', 'list', params] as const,
  /** 2026-09-26 追加（B 任务）：零件域前缀 —— 下发 / 召回 / 行内编辑完成后
   *  qc.invalidateQueries({ queryKey: qk.partsPrefix }) 失效整个 parts 域（任意
   *  listParts 参数形态都会命中）。与 customersPrefix / processesPrefix 同形。 */
  partsPrefix: ['parts'] as const,
  /** 2026-10-07：dashboard 域大屏快照键（HTTP 全量首取 + WS 事件 invalidate）。
   *  **无维度键**：快照本身没有口径概念（交期分桶已拆到独立的 dashboardUpcoming 端点），
   *  后端也不接受任何 query 参数 ⇒ 键里没有任何可变量。切口径 / 切天数都不会换键，
   *  刷新只发生在 WS 事件 invalidate 与 staleTime 到期两条路径上。
   *  失效走 qk.dashboardSnapshotPrefix（见下），不用本键。 */
  dashboardSnapshot: () => ['dashboard', 'snapshot'] as const,
  /** dashboard snapshot 域前缀 —— 专供 WS 事件失效用。 */
  dashboardSnapshotPrefix: ['dashboard', 'snapshot'] as const,
  /** 2026-10-07：dashboard「交期分桶」queryKey（柱状图数据源 + 今日 / 窗口 KPI 派生）。
   *  listUpcomingDelivery 取服务端零填充好的 days 条分桶，并回一个后端判定的 `today`
   *  作「今天」锚点（前端不再 new Date()）。
   *
   *  **basis 与 days 都必须进键**：两者任意变化都换缓存身份，切口径 / 切天数即自动
   *  refetch。本 query 的 gcTime 是 POSITIVE_INFINITY（dashboard 域例外，靠 WS 事件
   *  失效），不把可变入参进键会让「上一次的口径 / 天数」缓存被下一次请求直接命中。
   *  失效走 dashboardUpcomingPrefix（见下），不用本键。 */
  dashboardUpcoming: (basis: DeliveryBasis, days: number) =>
    ['dashboard', 'upcoming', basis, days] as const,
  /** dashboard「交期分桶」域前缀 —— 专供 WS 事件失效用。键含 basis + days 两个维度，
   *  事件到达时所有组合（任意口径 × 任意天数）都过期，用前缀一把 partial match 命中，
   *  而不是只失效当前那一条。 */
  dashboardUpcomingPrefix: ['dashboard', 'upcoming'] as const,
  /** 2026-10-07：dashboard「柱状图按层下钻明细」queryKey。
   *  listDeliveryOrders 按 date + statuses + basis 查工单明细；statuses 序列化成数组进键，
   *  保证换层 / 换日期 / 换口径都换缓存身份。失效走 dashboardDeliveryOrdersPrefix。 */
  dashboardDeliveryOrders: (params: {
    date: string;
    statuses: readonly OrderStatus[];
    basis: DeliveryBasis;
  }) => ['dashboard', 'delivery-orders', params] as const,
  /** dashboard「柱状图按层下钻明细」域前缀 —— 专供 WS 事件失效用。params 随用户切层 /
   *  切日期 / 切口径不断变化，事件到达时要失效的是整个维度（此前挂载过、现已切走的那些
   *  查询同样过期），故用前缀而非精确键。 */
  dashboardDeliveryOrdersPrefix: ['dashboard', 'delivery-orders'] as const,
  /** dashboard 域前缀 —— WS 事件触发 invalidate 用；
   *  覆盖范围：dashboardSnapshot（无维度）、dashboardUpcoming（basis × days）、
   *  dashboardDeliveryOrders（date × statuses × basis）三类 query，
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
  /** 2026-09-29 新增：pending-batches 域前缀 —— dispatch 完成后调
   *  qc.invalidateQueries({ queryKey: qk.pendingBatchesPrefix }) 失效整个域
   *  （任意 params 形态的 list 都会命中）。同时触发 partsPrefix 跨域失效
   *  （usePendingDispatch.ts 集中编排）。2026-09-30 修复：去掉 processesPrefix ——
   *  下发批次不改变工序列表，失效它只会多打一次 processes 请求。 */
  pendingBatchesPrefix: ['pending-batches'] as const,
  // ============================================================
  // 2026-10-01 新增：programming 域（「待编程一览」页）+ shelves 域（生产货架下拉）
  // queryKey 工厂。
  //
  // programming 域：
  //   - programmingList：页面级 store usePendingProgrammingStore 的主查询键
  //     （GET /api/v2/prod/programming/pending，数据源 2026-10-01 由 part 域
  //     /parts/pending-programming 迁到 prod 域）；
  //   - programmingPrefix：**唯一写操作** release-from-programming
  //     （2026-10-02 迁 prod 域、批次锚定：
  //     POST /api/v2/prod/batches/{batch_id}/release-from-programming，见
  //     usePendingProgrammingStore::releaseMutation）成功后走前缀失效，同时失效
  //     qk.partsPrefix（下发把 part 迁到 IN_PROCESS + 生产货架，零件一览 / 生产队列
  //     列表都要跟着变）。失效属「写完立即看到自己那笔」的优化，非一致性保证
  //     （见 CLAUDE.md 缓存时长策略）。
  //
  // shelves 域：
  //   - shelvesList：共享基础数据层 useProductionShelvesQuery 的键（下发对话框的
  //     目标 PRODUCTION 货架候选）。列表页是页面级 store 内部的 private state，
  //     但**基础数据**（货架几乎不变、跨 3 页共用）按 CLAUDE.md 定位放共享层。
  //   - shelvesPrefix：**当前不存在**，因为货架域零失效调用方（货架写点在
  //     ShelfList.vue，未挂失效）。按 CLAUDE.md「跨页面写操作不做穷举失效」策略，
  //     30s 有限 staleTime 兜新鲜度。将来真有货架写点要挂失效时，在这里补
  //     `shelvesPrefix: ['shelves'] as const`** + 在 useProductionShelvesQuery 补
  //     对应薄封装，不要在调用点拼字面量数组。
  // ============================================================
  programmingList: (params: ListPendingProgrammingParams) =>
    ['programming', 'list', params] as const,
  programmingPrefix: ['programming'] as const,
  shelvesList: (params: ListShelvesParams) => ['shelves', 'list', params] as const,
  /** 2026-10-02 新增：货架↔工序映射全集键（GET /prod/shelf-processes，单条无 params）。
   *  后端 handler 不接 Query extractor，一次返全部 active 映射的**扁平行**（一行一个
   *  (货架, 工序) 对），故键退化为常量键（与 workerPoolCounts 同形），不随任何
   *  候选源变化。10 处 useShelfProcessFilter 实例共用本键 ⇒ 30s 窗口内只发一次请求
   *  （该窗口有 Q6「卸载 → 立即重挂仍不重发」的用例实证；Q5 证的只是同 tick 并发
   *  挂载的在飞请求合并）。 */
  shelfProcessMappings: ['shelf-process-mappings'] as const,
  /** 2026-10-02 新增：货架↔工序映射域前缀 —— 与 shelfProcessMappings 同值（键已是
   *  常量，前缀即自身，沿 workerPoolCountsPrefix 同形）。唯一写点
   *  setShelfProcesses（ShelfList.vue）成功后调 invalidateShelfProcessMappingsQuery(qc)
   *  —— 本域**不是**「跨页面写操作无法穷举」那种情形：全仓写点只有这一个，10 个读点
   *  全是 useShelfProcessFilter，补失效的成本近乎零。 */
  shelfProcessMappingsPrefix: ['shelf-process-mappings'] as const,
  // ============================================================
  // 2026-10-02 新增：work-types 域（工种 + 工种↔工序映射）queryKey 工厂。
  //
  // 本域此前**零 Zod 守门、零 queryKey**（ProcessWorkTypeMappingTab.vue 直接裸调
  // listWorkTypes / listProcesses / getWorkTypeProcesses），这正是线上三个症状
  // （Tab 点工种报 undefined.map / 保存发错 payload 静默清空映射 / 保存后不刷新）
  // 能长期存在的原因。迁移到共享基础数据层后：
  //   - workTypesList(params)：**参数键**。消费方 useWorkTypesQuery（工序映射 Tab
  //     的左表「工种」列表，limit=200 全量）。带 params 是因为后端 list 端点接
  //     `code_like` / `limit` / `offset` Query extractor（WorkTypeListOut 有分页信封），
  //     键必须随 params 变化才能拿到不同 cache identity。
  //   - workTypesPrefix：域前缀失效。消费方 = useWorkTypesQuery 的
  //     invalidateWorkTypesQuery —— 唯一写点 setWorkTypeProcesses（保存映射）会改
  //     `WorkTypeOut.process_ids`（后端 list 端点批量补全该字段），所以保存成功后
  //     必须连带失效工种列表，否则左表展示的映射数/勾选态是旧快照。
  //   - workTypeProcesses(workTypeId)：**参数键**。消费方
  //     useWorkTypeProcessesQuery（工序映射 Tab 右表的「该工种已映射工序」）。
  //     参数是 work_type_id —— 该端点按工种分片返回，键必须带 id，否则切工种时
  //     命中上一个工种的缓存。
  //   - workTypeProcessesPrefix：域前缀失效（同上，写点只有一个，成本近乎零，
  //     不适用 CLAUDE.md「跨页面写操作不做穷举失效」策略——那针对的是写点散落
  //     多域的情形）。
  // ============================================================
  workTypesList: (params: WorkTypeListParams) => ['work-types', 'list', params] as const,
  workTypesPrefix: ['work-types'] as const,
  workTypeProcesses: (workTypeId: string) => ['work-types', 'processes', workTypeId] as const,
  workTypeProcessesPrefix: ['work-types', 'processes'] as const,
  // ============================================================
  // 2026-09-30 新增：pool 域 queryKey 工厂（后端 worker-pool → pool 路径收敛后
  // 前端同步改名）—— 生产队列 Tab 懒加载 + 数据层 TanStack Query 化
  // （CLAUDE.md 2026-09-30 硬约束）的共享基础数据层。
  //
  // 三个 list / state query + 对应 prefix：
  //   - workerPoolCounts：全工序 batch 计数（eager，30s staleTime 去重缓存），
  //     tab 标题 (N) 徽标 + 「待下发」Tab 工序卡 badge 数据源，跨 tab 共享；
  //   - workerPoolByProcess：单工序候选池详情（lazy，仅 tab 首次激活时拉），
  //     与 WorkerPoolTab 共享 cache identity；
  //   - workerPoolStateByWorker：单 worker state（held_batches + max_held），
  //     WorkerColumn 自管 query 拉取 + 跨 tab 共享。
  //
  // 失效规则（2026-09-30 策略变更后已改写，pool 域不再声称「失效即可保证一致性」）：
  //   - 已显式挂 pool 失效的写点（**不是**全部写点）：
  //     - moveBatch / autoAllocate 完成后调 invalidateWorkerPoolByProcessAll(qc) +
  //       invalidateWorkerPoolCountsQuery(qc) + invalidateWorkerStateByWorkerAll(qc)
  //       （useWorkerQueue.ts 集中编排）；
  //     - dispatch（含 preview 确认后的真正下发）完成后 usePendingDispatch 集中
  //       失效四域（pendingBatchesPrefix + partsPrefix + workerPoolByProcessPrefix +
  //       workerPoolCountsPrefix）+ pool state（workerPoolStatePrefix）。2026-09-30
  //       修复：原先含 processesPrefix，下发不改变工序列表故移除。
  //   - 上述两条失效链只覆盖 useWorkerQueue（move / autoAllocate）与
  //     usePendingDispatch（dispatch）**这两条路径**，prefix 一把全刷也只覆盖它们。
  //     后端候选池定义 = `status='IN_PROCESS' AND location='PRODUCTION_SHELF'`
  //     （worker_pool/repo/sql.rs），而其它域的流转端点同样会改这两个
  //     字段、却**未挂 pool 失效**：
  //       - delivery 域送检 `batchToInspection`（POST /prod/batches/to-inspection，
  //         useBulkScanInspect）—— to_inspection_core 接受
  //         IN_PROCESS+PRODUCTION_SHELF 为合法起点并迁到 INSPECTION+INSPECTION_SHELF，
  //         即把批次移出候选池；
  //       - scan 域工人放回 `workerScan` event_type=RETURNED
  //         （ScanReturnParts）—— service 同事务跑 WorkerPool refill，
  //         放回即从池里抢批，counts / by-process / state 三域同时变；
  //       - inspection 域的品检流转（`useInspectionListStore` 的 `toInspectionMutation`
  //         / `toShipMutation` / `toProcessMutation`）—— 送检把 IN_PROCESS+PRODUCTION_SHELF
  //         的批次迁到 INSPECTION+INSPECTION_SHELF，即把批次移出候选池；
  //       - outsource 域收发（useOutsourceSendableList / usePartDetail 的
  //         receiveFromOutsource / useOutsourceReceivingList）—— send 移出候选池、
  //         receive 移入候选池；**仍未挂 worker-pool 三域失效**（既存缺口）。
  //         2026-10-03 起该页改看板（UI 属并行任务，看板侧消费 outsource-pool
  //         三键）、数据源换成 outsource-pool 三域；看板侧收发
  //         mutation（useOutsourceBoardMove，并行任务待落地）挂 outsource-pool
  //         三键 + qk.partsPrefix 失效。
  //   - 2026-09-30 决策：**不再逐个给这些写点补失效**（要求穷举全仓写点，不可持续）。
  //     改为把 pool 三域的 staleTime / gcTime 收紧到有限值（30s / 5min）——
  //     工人送检后切回队列页（操作间隔通常 > 1min）自动 refetch，实时性由有限
  //     staleTime + WS 事件 / 显式 refetch（WorkerQueueBoard.onRefresh）保证。
  //     上面的失效调用点是「写完立即看到自己那笔」的优化，不是新鲜度保证。
  // ============================================================

  /** 全工序 batch 计数（eager 拉取，tab 标题徽标 + 待下发工序卡 badge 数据源）。
   *  2026-09-30：去 params 维度 —— 后端 `GET /prod/pool/counts` 的 handler
   *  （worker_pool/handler.rs）只有 `State` + `CurrentUser`，**不接 Query
   *  extractor**；按 process_id GROUP BY 跨所有货架聚合，没有 shelf 维度。
   *  故本 queryKey 退化为常量键（与 prefix 同形），不再随 activeShelfId 变化而
   *  refetch —— 也顺带消除了 WorkerQueueBoard 里 shelfId 的 TDZ 隐患。 */
  workerPoolCounts: ['worker-pool', 'counts'] as const,
  /** worker-pool counts 域前缀 —— 写 mutation 完成后
   *  qc.invalidateQueries({ queryKey: qk.workerPoolCountsPrefix }) 一键全失效。
   *  2026-09-30：与 `workerPoolCounts` 同值（键已是常量，前缀即自身）。 */
  workerPoolCountsPrefix: ['worker-pool', 'counts'] as const,
  /** 单工序候选池详情（lazy，仅 WorkerPoolTab 首次激活时拉）。
   *  processId 空字符串 → 占位 key（enabled=false 拦挡，queryFn 二次守卫）。 */
  workerPoolByProcess: (processId: string) => ['worker-pool', 'by-process', processId] as const,
  /** worker-pool by-process 域前缀 —— 写 mutation 完成后
   *  qc.invalidateQueries({ queryKey: qk.workerPoolByProcessPrefix }) 一键全失效
   *  （任意 processId 形态都会命中）。 */
  workerPoolByProcessPrefix: ['worker-pool', 'by-process'] as const,
  /** 单 worker state（held_batches + max_held + current_held）。
   *  2026-10-04：**单键**（workerId 唯一维度）—— WorkerColumn 自管 query 拉取，
   *  同一 worker 在不同 tab / 不同货架视图下共享同一 cache identity。
   *  后端 `GET /prod/pool/state` 的出参（held_batches / max_held / current_held /
   *  capacity_remaining）本就不含货架维度，shelf_id 唯一影响的 pool_count_by_process
   *  前端零消费，故不进键。 */
  workerPoolStateByWorker: (workerId: string) => ['worker-pool', 'state', workerId] as const,
  /** worker-pool state 域前缀 —— `POST /prod/pool/move` 完成后调（POOL↔WORKER
   *  双向移动都会改变 worker 的 held_batches，故按前缀全刷而非按 worker 精刷）。 */
  workerPoolStatePrefix: ['worker-pool', 'state'] as const,
  // ============================================================
  // 2026-10-03 新增：inspection 域（「待品检」页）queryKey 工厂。
  //
  // 根命名空间取 `inspection`（与页面路由 / 菜单域、后端 prod::inspection 域一致）：
  // 键的根只要求「同域前缀匹配」，而本页与零件一览 / 批次列表没有共享写点
  // （本页的写操作只有品检流转，它改的是批次状态，不会改零件一览的行集），
  // 挂在 parts 域下反而会让 qk.partsPrefix 的一把全刷捎带上本页缓存。
  // ============================================================
  /** 待品检队列列表键（页面级 store `useInspectionListStore` 的主查询，
   *  数据源 `GET /api/v2/prod/inspection/queue`）。带 params 是因为后端 list 端点
   *  接 3 个 ILIKE 子串 + 客户 + 系统交期区间 + 排序 + limit / offset，键必须随
   *  params 变化才能拿到不同 cache identity（与 partsList / programmingList 同形）。 */
  inspectionQueueList: (params: ListInspectionQueueParams) =>
    ['inspection', 'queue', params] as const,
  /** inspection 域前缀 —— 品检流转（to-inspection / to-process / to-ship）完成后
   *  调 `qc.invalidateQueries({ queryKey: qk.inspectionPrefix })` 失效本域；
   *  未来若本域新增其它 list 键，一并被前缀覆盖。 */
  inspectionPrefix: ['inspection'] as const,
  // ============================================================
  // 2026-10-03 新增：outsource-pool 域（「外协发送/接收」看板）queryKey 工厂。
  //
  // 根命名空间取 `outsource-pool`（**不**挂到既有 `outsource` 前缀下），理由沿本
  // 文件 `inspection` 域段的「根命名空间」取舍：
  //   - 键的根只要求「同根前缀匹配」才有意义。本域与既有 `outsource` 域的读端点
  //     （`/outsource-sendable` / `/outsource-shipments/in-flight` /
  //     `/outsource-companies/*`）**没有共享写点**：那 4 个 list 端点所在的收发页面
  //     2026-10-03 起改看板（UI 属并行任务，看板侧消费本域三键）、数据源换成本域；
  //     而看板自己的写操作只有外协发送 / 接收，两者都是
  //     `POST /prod/batches/{batch_id}/send-to-outsource` /
  //     `receive-from-outsource`（prod/batches 域），不写 outsource 域的表。
  //   - 反过来，挂到 `outsource` 前缀下会让将来任何一次「outsource 域一把全刷」把
  //     看板三个 tab 的数据全部连带重拉（`in_flight_count` 随收发变动，量级不小）。
  //   - 命名空间与后端 URL 段逐字对齐（`/outsource-pool/*`），便于按 URL 反查键。
  //
  // 失效编排点（待落地）：看板侧收发 mutation `useOutsourceBoardMove`（并行任务，本仓
  // 尚无调用方）落地后由其 onSuccess 集中失效本域三键 + `qk.partsPrefix` ——
  // 发送/接收改的是 t_part 的派生 status，零件一览 / 批次列表要跟着变。
  // ⚠️ 编排点 ≠ 全部写点：与 CLAUDE.md「跨页面写操作不做穷举失效」一致，本域的
  // 新鲜度由 30s 有限 staleTime + 看板自身的显式 refetch 兜底。
  // ============================================================
  /** 各外协工序的可发送 / 在途计数（eager 拉取，看板 tab 标题徽标的唯一数据源）。
   *  **常量键**：后端 `GET /outsource-pool/counts` 不接 Query extractor（无分页、
   *  无筛选），故键不随任何 tab / 选中态变化。 */
  outsourcePoolCounts: ['outsource-pool', 'counts'] as const,
  /** outsource-pool counts 域前缀 —— 与 `outsourcePoolCounts` 同值（键已是常量，
   *  前缀即自身，沿 workerPoolCountsPrefix 同形）。 */
  outsourcePoolCountsPrefix: ['outsource-pool', 'counts'] as const,
  /** 单工序看板详情（左「可发送候选批次」+ 右「外协公司列」）。
   *  processId 空串 → 占位键（enabled=false 闸门 + queryFn 二次守卫拦掉）。 */
  outsourcePoolByProcess: (processId: string) =>
    ['outsource-pool', 'by-process', processId] as const,
  /** outsource-pool by-process 域前缀 —— 任意 processId 形态一把全失效（发送的目标
   *  工序由 tab 决定、后端不自推，mutation 回调里可能拿不到 processId）。 */
  outsourcePoolByProcessPrefix: ['outsource-pool', 'by-process'] as const,
  /** 单公司 × 单工序的在途批次（看板右侧公司列）。
   *  **双键**：公司列是 (公司 × 工序) 的笛卡尔格，任一维度变化都换一份 cache identity。 */
  outsourcePoolState: (outsourceCompanyId: string, processId: string) =>
    ['outsource-pool', 'state', outsourceCompanyId, processId] as const,
  /** outsource-pool state 域前缀 —— 一次发送/接收会同时改多个公司列（接收写入侧的
   *  目标公司、发送释放源公司的持有数），故按前缀全刷而非按 (公司, 工序) 精刷。 */
  outsourcePoolStatePrefix: ['outsource-pool', 'state'] as const,
  // ============================================================
  // 2026-10-05 新增：process-design 域（「制定工序」页）queryKey 工厂。
  //
  // 根命名空间取 `process-design`（与页面路由 / 后端 URL 段 `/prod/process-design/*`
  // 逐字对齐，便于按 URL 反查键），**不**挂到 `parts` 前缀下 —— 理由沿本文件
  // `inspection` / `outsource-pool` 两段的取舍：键的根只要求「同根前缀匹配」才有意义。
  // 本页与零件一览 / 批次列表**没有共享写点**：本页唯一的写操作是保存工艺链
  // （`POST /prod/process-chains/by-part/{part_id}`，写 `t_part_process_chain` /
  // `t_part_process`，**不改** `t_part` 的 status / 货架归属 / 批次成员资格），
  //   而零件一览 / 生产队列的写点（下发 / 送检 / 收发）改的是那些字段。
  // 反过来若挂到 `parts` 下，任何一次「零件域一把全刷」（`qk.partsPrefix` 是全仓最热
  // 的失效键）都会连带把本页列表 + 选中零件的工艺链全部重拉，纯粹浪费往返。
  //
  // 失效编排点：`useProcessDesignStore` 的 upsert-chain mutation（保存工艺链）成功后
  // 调 `invalidateProcessDesignQuery(qc)` —— 同时失效零件列表（该零件要从「待制定」
  // 迁到「已制定」）与选中零件的工艺链（整组 upsert 后 steps / version 全变）。
  // ⚠️ 编排点 ≠ 全部写点：与 CLAUDE.md「跨页面写操作不做穷举失效」一致，本域的
  // 新鲜度由有限 staleTime + 本页自身的显式 refetch 兜底。
  // ============================================================
  /** 零件列表键（页面级 store `useProcessDesignStore` 的主查询，数据源
   *  `GET /api/v2/prod/process-design/parts`）。带 params 是因为端点接
   *  `sort_dir` / `limit` / `offset`，键必须随 params 变化才能拿到不同 cache identity
   *  （与 partsList / programmingList / inspectionQueueList 同形）。 */
  processDesignParts: (params: ListProcessDesignPartsParams) =>
    ['process-design', 'parts', params] as const,
  /** process-design 域前缀 —— 保存工艺链成功后一把全失效（列表 + 选中零件的链） */
  processDesignPartsPrefix: ['process-design'] as const,
  /** 选中零件的工艺链键（`GET /api/v2/prod/process-chains/{chain_id}`）。
   *  **参数键**：该端点按链 id 分片返回，切零件时必须换一份 cache identity，否则会拿
   *  上一个零件的 steps 冒充当前零件的。chainId 空串 → 占位键
   *  （`enabled=false` 闸门拦掉，见 store 的 selectedChainId 派生）。
   *  后端无链 / 链已删 → 20701 BIZ_PROCESS_CHAIN_NOT_FOUND，store 的 queryFn 按空链
   *  归一（不当错误态），故本页不需要第二条失效路径。 */
  processDesignChain: (chainId: string) => ['process-design', 'chain', chainId] as const,
} as const;
