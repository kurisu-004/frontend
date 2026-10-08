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
// 2026-10-08：入参形态在 api/productionQueue.ts 定义（api 层是 wire 契约的唯一定义
// 处，沿上面几个 List*Params 的既有做法），本文件只引用。
import type { ListQueuePendingParams } from '@/api/productionQueue';
import type { ListPendingProgrammingParams } from '@/api/programming';
// 2026-10-05：入参形态在 api/processChain.ts 定义（api 层是 wire 契约的唯一定义处，
// 沿上面几个 List*Params 的既有做法），本文件只引用。
import type { ListProcessDesignPartsParams } from '@/api/processChain';
import type { ListShelvesParams } from '@/api/shelves';
// 2026-10-02：工种列表入参形态在 api/workType.ts 定义（api 层是 wire 契约的唯一定义
// 处，沿 ListShelvesParams 等既有做法），本文件只引用。
import type { WorkTypeListParams } from '@/api/workType';
// 2026-10-09：外协三页的列表入参形态同样在 api/outsource.ts 定义（api 层是 wire 契约的
// 唯一定义处），本文件只引用类型。
import type {
  ListOutsourceCompaniesParams,
  ListOutsourceQuotesParams,
  ListOutsourceSentPartsParams,
} from '@/api/outsource';
import type { ProcessCategory } from '@/types/process';
import type { OrderStatus } from '@/types/parts';
import type { DeliveryBasis } from '@/types/dashboard';
import type { UnionListParams } from '@/api/com/unionList';
// 2026-10-08：送货单域入参形态在 api/com/deliveryNote.ts 定义（沿上面几个 List*Params
// 的既有做法），本文件只引用。
import type { ListNotesParams } from '@/api/com/deliveryNote';
// 2026-10-10：账号列表入参形态在 api/iam.ts 定义（沿 ListShelvesParams 等既有做法），
// 本文件只引用。
import type { ListUsersParams } from '@/api/iam';

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

/** 2026-10-09：`qk.outsourceSentParts` 的入参 —— companyId 与 filters 分开，
 *  因为 companyId 是**端点的路径分段**（端点按公司分片返回），必须单独占一个键位，
 *  不能混在会被 hash 的 params 对象里（否则切公司时对比不出「换了公司」，只能靠整个
 *  params 对象不相等来判断，而 params 里其它字段恰好相同时会误命中旧公司的缓存）。 */
export interface ListOutsourceSentPartsKeyParams {
  companyId: string;
  filters: ListOutsourceSentPartsParams;
}

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
   * 单请求 owner 全量，computed 内按 kind 桶。失效粒度 = owner 维度。 */
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
  /** 2026-09-29 新增：com 域 union-list 列表键 —— 零件一览页主查询
   *  （src/views/parts/list/composables/usePartsListQuery.ts）切换到
   *  GET /api/v2/com/union-list 后消费此键。params 内 row_type 必填。
   *  根命名空间取 'parts' 而非 'com'：TanStack Query 的 partialMatchKey 只在同根
   *  命名空间内前缀匹配，挂 'com' 下会让 qk.partsPrefix 的一把全刷捎带不上本查询
   *  ⇒ part 域 7 个 mutation 失效后 union-list 缓存持续 stale。 */
  unionList: (params: UnionListParams) => ['parts', 'union-list', params] as const,
  /** 2026-09-29 修订：union-list 缓存身份已与 parts 域合并，unionPrefix 与
   *  partsPrefix 等价；保留命名仅为未来 com 域自有写操作（如非 part 维度
   *  union 写入）做扩展位 —— 实际失效调用方继续走 qk.partsPrefix。 */
  unionPrefix: ['parts', 'union-list'] as const,
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
   *  (货架, 工序) 对），故键退化为常量键（与 productionQueueSnapshot 同形），不随任何
   *  候选源变化。useShelfProcessFilter 实例共用本键 ⇒ 30s 窗口内只发一次请求
   *  （该窗口有 Q6「卸载 → 立即重挂仍不重发」的用例实证；Q5 证的只是同 tick 并发
   *  挂载的在飞请求合并）。 */
  shelfProcessMappings: ['shelf-process-mappings'] as const,
  /** 2026-10-02 新增：货架↔工序映射域前缀 —— 与 shelfProcessMappings 同值（键已是
   *  常量，前缀即自身，沿 productionQueueSnapshotPrefix 同形）。唯一写点
   *  setShelfProcesses（ShelfList.vue）成功后调 invalidateShelfProcessMappingsQuery(qc)
   *  —— 本域**不是**「跨页面写操作无法穷举」那种情形：全仓写点只有这一个，读点只剩
   *  零件详情外协回收弹窗那一处 useShelfProcessFilter（2026-10-10 前是 10 个），
   *  补失效的成本近乎零。 */
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
  // 2026-10-08 新增：production-queue 域（「生产队列」页）queryKey 工厂。
  //
  // 根命名空间取 `production-queue`，与后端 URL 段 `/prod/queue/*` 与视图目录
  // `views/production/queue/` 对齐，便于按 URL 反查键。**不**挂到 `parts` 前缀下
  // —— 理由沿本文件 inspection / outsource-queue 两段的取舍：本域的三个读端点与
  // 零件一览、批次列表**没有共享写点**（本域写操作改的是批次位置 / 状态归属，
  // 那两个页面消费的是工单级派生视图），挂 parts 下反而会让最热的
  // `qk.partsPrefix` 一把全刷把队列页的看板缓存全部连带重拉。
  //
  // 三条读键：
  //   - productionQueueSnapshot：全工序候选数 + 待下发总数（**常量键**，eager），
  //     工序 tab 标题 (N) / 「待下发」tab 标题 (N) / 右栏工序卡徽标的唯一数据源；
  //   - productionQueueBoard(processId)：单工序看板（工序元数据 + 工人列
  //     **内联持有批次与容量** + 候选池），**参数键**（端点按工序分片返回，
  //     不带 id 会拿上一个工序的缓存冒充当前工序）⇒ 消掉了「每列一个工人 state
  //     请求」的 N+1，打开一个工序 tab 恒为 1 个请求；
  //   - productionQueuePending(params)：待下发列表（**参数键**，端点接 limit /
  //     offset），消费方 useQueueDispatch（「待下发」tab 的左侧列表 + 多选源）。
  //
  // 失效规则（本域**不再声称「失效即可保证一致性」**）：
  //   - 已显式挂失效的写点（**不是**全部写点）：
  //     - move / auto-allocate 完成后 `useQueueMove` 失效 snapshot + board 前缀
  //       （前缀全失效：目标工序由后端从批次当前 step 自推，前端拿不到受影响
  //       processId；一次 auto-allocate 还能同时动多个工人）；
  //     - dispatch（含 preview 确认后的真正下发）完成后 `useQueueDispatch` 失效
  //       pending 前缀 + board 前缀 + snapshot 前缀，外加跨域 `qk.partsPrefix`
  //       （下发把工单迁到 IN_PROCESS + 生产货架，零件一览的派生状态跟着变）；
  //     - recall 完成后 `useQueueRecall` 失效同一组前缀（同 dispatch 的理由：
  //       批次可能从任意工序的候选池或任意工人的手里被召回，菜单只带卡片 model）。
  //   - 上述编排点只覆盖 queue 域自身的写路径。后端候选池 = `IN_PROCESS` +
  //     `PRODUCTION_SHELF`，而其它域的流转端点同样会改这两个字段却不挂本前缀
  //     失效：delivery 域送检（`POST /prod/batches/to-inspection`）、scan 域
  //     工人放回（`workerScan` 同事务跑 refill，放回即从池里抢批）、inspection 域
  //     品检流转（送检 / 转生产 / 发货）、outsource 域收发。
  //   - 决策：**不再逐个给这些写点补失效**（要求穷举全仓写点，不可持续）。新鲜度
  //     由有限 staleTime（30s）+ 本页自身的显式刷新按钮 + 写后失效兜底。
  //     上面的编排点是「写完立即看到自己那笔」的优化，**不是**新鲜度保证。
  // ============================================================

  /** 队列快照（全工序候选数 + 待下发总数，eager 拉取）。
   *  **常量键**：后端 `GET /prod/queue/snapshot` 不接 Query extractor（无分页、无
   *  筛选、无 shelf 维度），故键不随任何 tab / 选中态 / 激活货架变化。
   *  ⚠️ `processes[]` 只含候选数 > 0 的工序 —— 它是**徽标数据源**、不是工序全集；
   *  右栏「待下发」工序卡仍要与 `useProcessesQuery` 的工序列表 join 才能拿到
   *  只在列表上出现的 `category` 等字段。 */
  productionQueueSnapshot: () => ['production-queue', 'snapshot'] as const,
  /** production-queue snapshot 域前缀 —— 写 mutation 完成后
   *  qc.invalidateQueries({ queryKey: qk.productionQueueSnapshotPrefix }) 一键全失效。
   *  与 productionQueueSnapshot 同值（键已是常量，前缀即自身）。 */
  productionQueueSnapshotPrefix: ['production-queue', 'snapshot'] as const,
  /** 单工序看板（工序元数据 + 工人列内联持有批次与容量 + 该工序候选池）。
   *  **参数键**：端点按 process_id 分片返回，不带 id 切 tab 时会命中上一个工序的缓存。
   *  processId 空字符串 → 占位键（`enabled=false` 闸门 + queryFn 内二次守卫拦掉）。
   *  消费方 ProcessBoardTab（el-tab-pane `:lazy="true"` ⇒ 首次激活才 mount 才发）。 */
  productionQueueBoard: (processId: string) => ['production-queue', 'board', processId] as const,
  /** production-queue board 域前缀 —— 写 mutation 完成后一把全失效（任意 processId
   *  形态都命中）。**前缀而非精确键**是唯一正确策略：move 的目标工序由后端从批次
   *  当前 step 推导、一次 auto-allocate 跨全部工人、一次 dispatch 可能同时改多个
   *  工序池，调用 onSuccess 时都拿不到「受影响的 processId」。 */
  productionQueueBoardPrefix: ['production-queue', 'board'] as const,
  /** 待下发批次列表（`GET /prod/queue/pending`）。**参数键**：端点接 limit / offset，
   *  键必须随 params 变化才能拿到不同 cache identity（与 partsList / programmingList
   *  / inspectionQueueList 同形）。 */
  productionQueuePending: (params: ListQueuePendingParams) =>
    ['production-queue', 'pending', params] as const,
  /** production-queue pending 域前缀 —— dispatch / recall 完成后一把全失效
   *  （任意 params 形态都命中）。 */
  productionQueuePendingPrefix: ['production-queue', 'pending'] as const,
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
  // 2026-10-08：外协看板 queue 域（「外协发送/接收」看板）queryKey 工厂。
  //
  // 根命名空间取 `outsource-queue`（**不**挂到既有 `outsource` 前缀下），理由沿本
  // 文件 `inspection` / `process-design` 两段的「根命名空间」取舍：
  //   - 键的根只要求「同根前缀匹配」才有意义。本域与既有 `outsource` 域的读端点
  //     （`/outsource-sendable` / `/outsource-shipments/in-flight` /
  //     `/outsource-companies/*`）**没有共享写点**：那 4 个 list 端点所在的收发页面
  //     2026-10-03 起改看板（UI 属并行任务，看板侧消费本域两键）、数据源换成本域；
  //     而看板自己的写操作只有外协发送 / 接收，两者都是 prod/batches 域的
  //     `POST /batches/{batch_id}/send-to-outsource` / `receive-from-outsource`，
  //     不写 outsource 域的表。
  //   - 反过来，挂到 `outsource` 前缀下会让将来任何一次「outsource 域一把全刷」把
  //     看板两个 tab 的数据全部连带重拉（`in_flight_count` 随收发变动，量级不小）。
  //   - 命名空间与后端 URL 段逐字对齐（`/outsource-queue/*`），便于按 URL 反查键。
  //
  // 两个键对应两个只读端点（2026-10-08 的契约重排：原 `/outsource-pool/state` 端点
  // 删除 —— 在途批次改为随工序详情内联在 `companies[].held_batches`，公司列不再单独
  // 发请求，N+1 从结构上消失）：
  //   - snapshot     → 各工序可发送 / 在途计数（tab 标题徽标的唯一数据源，eager 拉取）
  //   - processes/{id} → 单工序看板（左列候选批次 + 右列公司列），tab body 懒加载
  //
  // 写端点 `POST /outsource-queue/move`（发送 / 回收生产 / 回收品检）**没有自己的
  // queryKey** —— 它是 mutation，由 `useOutsourceQueueMove` 的 onSuccess / onError
  // 串行失效下面两个前缀。一次移动会同时改左列候选池与右列在途集合（两个 tab body 是
  // 两条独立 query），漏刷任何一个都会看到「徽标更新了、卡片没动」；而受影响的
  // processId 前端拿不到（可能跨 tab），故一律前缀全失效。
  // ⚠️ 编排点 ≠ 全部写点：与 CLAUDE.md「跨页面写操作不做穷举失效」一致，本域的
  // 新鲜度由 30s 有限 staleTime + 看板自身的显式 refetch 兜底。
  // ============================================================
  /** 各外协工序的可发送 / 在途计数（eager 拉取，看板 tab 标题徽标的唯一数据源）。
   *  **常量键**：后端 `GET /outsource-queue/snapshot` 不接 Query extractor（无分页、
   *  无筛选），故键里没有任何可变量。函数形态与 `productionQueueSnapshot` 对齐 ——
   *  `queryKey: computed(() => qk.outsourceQueueSnapshot())`。 */
  outsourceQueueSnapshot: () => ['outsource-queue', 'snapshot'] as const,
  /** outsource-queue snapshot 域前缀 —— 写端点 `POST /outsource-queue/move` 完成后
   *  qc.invalidateQueries({ queryKey: qk.outsourceQueueSnapshotPrefix }) 一键全失效。
   *  与 outsourceQueueSnapshot 同值（键已是常量，前缀即自身，沿
   *  productionQueueSnapshotPrefix 同形）。 */
  outsourceQueueSnapshotPrefix: ['outsource-queue', 'snapshot'] as const,
  /** 单工序看板详情（左「可发送候选批次」+ 右「外协公司列」，在途批次内联在
   *  公司列上）。processId 空串 → 占位键（enabled=false 闸门 + queryFn 二次守卫拦掉）。 */
  outsourceQueueProcess: (processId: string) => ['outsource-queue', 'process', processId] as const,
  /** outsource-queue process 域前缀 —— 任意 processId 形态一把全失效（发送的目标
   *  工序由 tab 决定、后端不自推，mutation 回调里可能拿不到 processId）。 */
  outsourceQueueProcessPrefix: ['outsource-queue', 'process'] as const,
  // ============================================================
  // 2026-10-09 新增：outsource 域（外协公司一览 / 外协对账 / 报价一览）queryKey 工厂。
  //
  // 根命名空间取 `outsource`（与页面路由段 / 菜单域、后端 `/outsource-companies/*` 与
  // `/outsource-quotes/*` 两组 URL 对齐，便于按 URL 反查键），**不**挂到
  // `outsource-queue` 前缀下 —— 理由沿本文件 `inspection` / `process-design` 两段的
  // 「根命名空间」取舍，且这两域的读写前缀确实不同：
  //   - 本域写点（公司 create / update / soft-delete、报价 submit / approve / reject /
  //     soft-delete、行内 reconcile-update）改的是 `t_outsource_company` /
  //     `t_outsource_company_process` / `t_outsource_quote` / `t_outsource_shipment`，
  //     **一个字都不写 `t_part_batch`** ⇒ 看板（候选池 / 在途集合）完全不受影响；
  //   - 看板写点 `POST /outsource-queue/move` 改的是批次 `location` / `current_holder_id`
  //     / `version`，也不碰本域四张表 ⇒ 本域三个列表页不必跟着重拉。
  // 所以两边的失效前缀各自独立：公司的工序映射变了（`process_ids` 整体替换）只影响
  // 公司一览与报价的公司下拉，不影响看板的 `held_batches`。
  //
  // 三条读键（都是**参数键**：三个 list 端点都接 limit / offset 与各自的筛选维度，
  // 键必须随 params 变化才能拿到不同 cache identity）：
  //   - outsourceCompanies(params)   —— GET /outsource-companies
  //   - outsourceSentParts({companyId, ...}) —— GET /outsource-companies/{id}/sent-parts
  //     （companyId 走**独立键位**而非塞进 params 对象：端点按公司分片返回，不带 id 切
  //      公司时会命中上一个公司的缓存）；
  //   - outsourceQuotes(params)       —— GET /outsource-quotes
  //
  // 失效编排点（各页 store / composable 的 mutation 回调）：
  //   - 公司 create / update / soft-delete → invalidateOutsourceCompaniesAll
  //     （`process_ids` 替换会改公司工序清单，报价一览的「外协公司」筛选列名要跟着变）；
  //   - 报价 create / submit / approve / reject / soft-delete → invalidateOutsourceQuotesAll；
  //   - 行内 reconcile-update（改单价 / 数量 / 对账标记）→ invalidateOutsourceSentPartsAll。
  // ⚠️ 编排点 ≠ 全部写点：与 CLAUDE.md「跨页面写操作不做穷举失效」一致，本域的新鲜度
  // 由有限 staleTime（30s）+ 各页自身的显式刷新兜底。
  // ============================================================
  /** 外协公司一览列表键。params = `name_like` / `is_active` / `limit` / `offset`。 */
  outsourceCompanies: (params: ListOutsourceCompaniesParams) =>
    ['outsource', 'companies', params] as const,
  /** outsource companies 域前缀 —— 公司写端点成功后一把全失效（任意 params 形态都命中）。 */
  outsourceCompaniesPrefix: ['outsource', 'companies'] as const,
  /** 外协对账（某公司已发出的零件）列表键。companyId 走独立键位。 */
  outsourceSentParts: (params: ListOutsourceSentPartsKeyParams) =>
    ['outsource', 'sent-parts', params.companyId, params.filters] as const,
  /** outsource sent-parts 域前缀 —— 行内 reconcile-update 成功后一把全失效。 */
  outsourceSentPartsPrefix: ['outsource', 'sent-parts'] as const,
  /** 外协报价一览列表键。params = `statuses` / `drawing_no` / `name` /
   *  `outsource_company_id` / `customer_id` / `is_urgent` / `sort_by` / `sort_dir` /
   *  `limit` / `offset`。 */
  outsourceQuotes: (params: ListOutsourceQuotesParams) => ['outsource', 'quotes', params] as const,
  /** outsource quotes 域前缀 —— 报价写端点成功后一把全失效。 */
  outsourceQuotesPrefix: ['outsource', 'quotes'] as const,
  // ============================================================
  // 2026-10-05 新增：process-design 域（「制定工序」页）queryKey 工厂。
  //
  // 根命名空间取 `process-design`（与页面路由 / 后端 URL 段 `/prod/process-design/*`
  // 逐字对齐，便于按 URL 反查键），**不**挂到 `parts` 前缀下 —— 理由沿本文件
  // `inspection` / `outsource-queue` 两段的取舍：键的根只要求「同根前缀匹配」才有意义。
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
  // ============================================================
  // 2026-10-08 新增：送货单域（`/api/v2/com/delivery/*`）queryKey 工厂。
  //
  // 根命名空间取 `delivery-notes` / `delivery-groups` / `delivery-drivers`，与后端 URL
  // 前缀逐段对齐，便于按 URL 反查键。**不**挂 `partsPrefix` 下 —— 理由沿本文件
  // `inspection` / `process-design` 两段的取舍：键的根只要求「同根前缀匹配」才有意义。
  // 送货单的写点会改批次与零件的 DELIVERED 状态；挂 parts 下会让全仓最热的
  // `qk.partsPrefix` 一把全刷把整个送货单域连带重拉（列表 + 详情 + 草稿看板三处）。
  //
  // 失效编排点（本域写操作完成后由对应 mutation 的 onSuccess / 写后回调调，
  // 逐条对应关系见下，改端点时照这张表核对「有没有接上失效」）：
  //   - `POST /{id}/update` / `/{id}/submit` / `/{id}/recall` / `/{id}/soft-delete` /
  //     `/{id}/remove-batches` —— useDeliveryNoteActions.ts（详情页 5 个写端点，
  //     每个都在 fetchDetail 之外**额外**刷本域前缀）；
  //   - `POST /{id}/pickup`（一键送货）—— useDeliveryNoteListStore 的 deliverMutation；
  //   - `POST /{id}/driver`（指定司机）—— PrintPreviewDialog 的 onDriverChange；
  //   - `POST /scan`（扫码入单）—— useDeliveryScanSubmission；
  //   - 草稿看板的移除 / 提交 —— useDeliveryDraftBoard；
  //   - 以上都经 `invalidateDeliveryNotesQuery(qc)` 一把失效本域的列表 / 详情 /
  //     批量详情键；
  //   - 分组 create / update / soft-delete → `invalidateDeliveryGroupsQuery(qc)`。
  //
  // ⚠️ 编排点 ≠ 全部写点：其它域的写端点同样会改本域关心的字段 ——
  //   `POST /prod/batches/to-ship`（品检流转把批次转成 READY_TO_SHIP，直接决定它能不能
  //   扫码入单）、`POST /parts/worker-scan`（工人放回，批次位置变）、
  //   `/prod/inspection/*` 品检流转、outsource 外协收发。按 CLAUDE.md
  //   「跨页面写操作不做穷举失效，30s 有限 staleTime + 显式刷新兜新鲜度」的既定策略，
  //   这些写点**不逐个补失效**（要求穷举全仓写点，不可持续）。
  // ============================================================
  /** 送货单一览键（页面级 store `useDeliveryNoteListStore` 的主查询，
   *  数据源 `GET /api/v2/com/delivery/note`）。**参数键**：端点接 statuses 多值 +
   *  customer_id + keyword ILIKE + limit / offset，键必须随 params 变化才能拿到不同
   *  cache identity（与 partsList / programmingList / inspectionQueueList 同形）。 */
  deliveryNotesList: (params: ListNotesParams) => ['delivery-notes', 'list', params] as const,
  /** 送货单详情键（`GET /com/delivery/note/{id}`）。**参数键**：端点按单据 id 分片
   *  返回，不带 id 切详情页时会命中上一张单的缓存。id 为空串 → 占位键
   *  （`enabled=false` 闸门 + queryFn 内二次守卫拦掉）。 */
  deliveryNoteDetail: (id: string) => ['delivery-notes', 'detail', id] as const,
  /** 批量详情键（`GET /com/delivery/note/batch-detail?ids=`）。**参数键**：
   *  ids 数组进键（后端按入参顺序装配 items），草稿看板拉 N 张详情只发一次往返。 */
  deliveryNotesBatchDetail: (ids: string[]) => ['delivery-notes', 'batch-detail', ids] as const,
  /** 送货单域前缀 —— 域内任一写操作完成后
   *  `qc.invalidateQueries({ queryKey: qk.deliveryNotesPrefix })` 一把全失效
   *  （任意 params 形态 / 任意 note id 都命中）。 */
  deliveryNotesPrefix: ['delivery-notes'] as const,
  /** 送货分组列表键（扫码建单页的分组面板，数据源
   *  `GET /com/delivery/group?customer_id=`）。**参数键**：端点按 L1 分片返回，
   *  切 L1 时必须换一份 cache identity。 */
  deliveryGroupsList: (l1Id: string) => ['delivery-groups', 'list', l1Id] as const,
  /** 送货分组域前缀 —— 分组 create / update / soft-delete 完成后一把全失效。 */
  deliveryGroupsPrefix: ['delivery-groups'] as const,
  /** 送货司机候选键（打印对话框的司机下拉，数据源 `GET /com/delivery/drivers`）。
   *  **常量键**：端点不接 Query extractor（无分页、无筛选），一条 JOIN 返全部在职
   *  送货司机 ⇒ 键不随任何筛选 / tab 变化。本仓本域 query 都不设 staleTime（走全局
   *  默认 0），常量的意义是「同一次挂载内不重复往返」，不是「30s 内不发请求」。 */
  deliveryDrivers: () => ['delivery-drivers'] as const,
  /** 送货司机域前缀 —— 与 deliveryDrivers 同值（键已是常量，前缀即自身）。 */
  deliveryDriversPrefix: ['delivery-drivers'] as const,
  // ============================================================
  // 2026-10-10 新增：iam 域（「账号管理」页）queryKey 工厂。
  //
  // 根命名空间取 `users`（与页面路由段 / 菜单域、后端 `/iam/users/*` 两组 URL 对齐），
  // **不**挂 `iamPrefix` 下的其它名字：本域只有账号管理这一个页面族，且它的读端点与
  // `auth` 域的登录 / 会话链路**没有共享写点**（改密码 / 改角色不影响 `me` 的返回，
  // 后者的货架范围要等 token 刷新才变，见 RoleDialog 的提示）。
  //
  // 三条键：
  //   - usersList(params)   —— 账号分页列表（**参数键**：端点接 username_like / is_active
  //     / limit / offset，键必须随 params 变化才能拿到不同 cache identity，与
  //     partsList / programmingList / inspectionQueueList 同形）。
  //   - userWxIdentity(id)  —— 单账号的企业微信绑定（**参数键**：端点按账号 id 分片返回，
  //     不带 id 切账号时会命中上一个账号的绑定缓存）。⚠️ 该端点未绑定时返回 `null`，
  //     消费侧必须能处理 null（不要 `.map` / `.length`）。
  //   - usersPrefix         —— 域前缀失效：本域 8 个写端点（建号 / 编辑 / 停用 / 重置密码 /
  //     加角色 / 移角色 / 绑企微 / 解企微）成功后一律失效它，一把覆盖上面两条读键。
  // ============================================================
  /** 账号分页列表键（页面级 store `useUsersListStore` 的主查询，数据源
   *  `GET /api/v2/iam/users`）。params = `username_like` / `is_active` / `limit` / `offset`。 */
  usersList: (params: ListUsersParams) => ['users', 'list', params] as const,
  /** iam 账号域前缀 —— 域内任一写端点成功后
   *  `qc.invalidateQueries({ queryKey: qk.usersPrefix })` 一把全失效
   *  （任意 params 形态 / 任意账号 id 都命中），单个账号的企微绑定由
   *  `qk.userWxIdentity(userId)` 精确失效（同在 users 前缀下，前缀一把也覆盖得到）。 */
  usersPrefix: ['users'] as const,
  /** 单账号的企业微信绑定键（`GET /api/v2/iam/users/{id}/wx-bind`）。**参数键**：端点按
   *  账号分片返回，不带 id 切账号时会拿上一个账号的绑定冒充当前账号的。
   *  id 空串 → 占位键（`enabled=false` 闸门 + queryFn 内二次守卫拦掉）。 */
  userWxIdentity: (userId: string) => ['users', 'wx-identity', userId] as const,
  // ============================================================
  // 2026-10-10 新增：assembly 域 queryKey 工厂。此前全仓 62 个键里**零 assembly 键**
  // —— assemblies 域的读走 `api/assembly.ts` 直接调函数（详情页 `useAssemblyDetail`
  // 自己持 ref + loading），没有进入共享基础数据层。dashboard 的装配件子件弹窗需要
  // 同一份数据，按 CLAUDE.md「主查询外提成 query hook」补上这条共享键。
  //
  // 根命名空间取 `assembly`（与页面路由段 / 菜单域、后端 `/assemblies/*` 对齐）。
  // **不**挂 `partsPrefix` 下 —— 理由沿本文件 `inspection` / `process-design` 两段的
  // 「根命名空间」取舍：键的根只要求「同根前缀匹配」才有意义，本域读端点与零件一览 /
  // 批次列表没有共享写点，挂 parts 下会让全仓最热的 `qk.partsPrefix` 一把全刷把装配件
  // 详情连带重拉。
  // ============================================================
  /** 装配件详情键（`GET /api/v2/assemblies/{id}`，响应含全部子件 `children[]`）。
   *  **参数键**：端点按装配件 id 分片返回，不带 id 切装配件时会拿上一个的子件列表
   *  冒充当前装配件的。id 空串 → 占位键（`enabled=false` 闸门 + queryFn 内二次守卫
   *  拦掉，理由同 deliveryNoteDetail）。 */
  assemblyDetail: (id: string) => ['assembly', 'detail', id] as const,
  /** assembly 域前缀 —— 装配件 / 子件写操作（建单 / 更新 / 取消 / 软删 / 增删子件）
   *  完成后一把全失效（任意 id 形态都命中）。 */
  assemblyPrefix: ['assembly'] as const,
} as const;
