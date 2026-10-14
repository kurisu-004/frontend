// 大屏域的类型定义。
//
// 收纳三类东西，三者的共同点是**都不是业务 VO**：
//   - WS 协议层类型：DashboardEvent / DashboardEventType / DashboardEventPayload /
//     WsSnapshotMsg / WsHeartbeatMsg / DashboardServerMessage / ConnectionStatus /
//     DashboardConnectionState。它们描述消息壳（消息形态而非业务 VO），被
//     api/dashboard.ts（onMessage 分发）+ ScanBanner.vue（SCAN_BANNER 事件消费） +
//     WsConnectionIndicator.vue（连接状态消费）+ useDashboardInvalidation.ts
//     （AFFECTS_DASHBOARD 类型签名）引用。
//   - 请求参数类型：DeliveryBasis（见下）。
//   - 视图内结构：PartPreviewTarget（工单预览弹窗入参的最小公共结构，见文件末）。
//
// 业务 VO 一律不在本文件：由 Zod schema 派生
// （views/dashboard/composables/dashboardSnapshotSchema.ts），既做 Zod 守门又是
// TS 类型来源，手写 interface 会与之双轨漂移。

import type { OrderStatus } from '@/types/parts';

export type DashboardEventType =
  // —— 纯展示事件：payload 带展示字段，不改任何 dashboard 切片 ——
  // 2026-10-13：报工台（`views/production/scan/`）的一次扫码提交成功后由后端推送，
  // 承载 6 个展示字段（守门 schema 在 views/dashboard/composables/bannerSchema.ts）。
  // **不进 AFFECTS_DASHBOARD 白名单** —— 它只是把「刚刚发生了什么」讲给人听，
  // dashboard 三张报表的数据事实由同一次提交产生的既有状态翻转事件承载。
  | 'SCAN_BANNER'
  // —— 后端 v2 ws_hub 实际下发的写入事件（dashboard invalidate 用）——
  | 'PART_TO_SHIP'
  | 'PART_TO_INSPECTION'
  | 'PART_TO_PROCESS'
  | 'BATCH_TO_SHIP'
  | 'BATCH_TO_INSPECTION'
  | 'PART_SOFT_DELETED'
  | 'PART_DELIVERED'
  | 'PART_BATCH_SPLIT'
  | 'PART_BATCH_CANCELLED'
  | 'PART_SCAN_INSPECT_PASSED'
  | 'PART_SCAN_INSPECT_FAILED'
  | 'PART_BATCH_WITH_PDFS_CREATED'
  | 'PART_PICKED_UP'
  // 2026-10-15：扫码接管端点 `POST /prod/scan/take-over` 的唯一 WS 产出。payload 四键
  // （part_id / batch_id / from_worker_id / to_worker_id）全部是 JSON 字符串；语义是
  // 「这一批换人了」。**没有** quantity / process_id 等键 —— 要更多事实的消费方从刷新
  // 后的列表读，不要指望事件带全量快照。
  | 'PART_TRANSFERRED'
  | 'WORKER_SCAN_RETURNED'
  | 'WORKER_SCAN_INSPECTED'
  | 'WORKER_POOL_REFILL_DONE'
  | 'WORKER_POOL_EMPTY'
  | 'WORKER_POOL_ADMIN_REMOVED'
  | 'WORKER_POOL_AUTO_ALLOCATE_DONE'
  | 'ASSEMBLY_CREATED'
  // ASSEMBLY_CANCELLED / ASSEMBLY_DELETED 同属 v2 产出（dashboard 会展示装配体状态，
  // 故两者都在 AFFECTS_DASHBOARD 白名单里）。
  | 'ASSEMBLY_CANCELLED'
  | 'ASSEMBLY_DELETED'
  | 'ASSEMBLY_UPDATED'
  // 2026-10-11：强制完成端点专用。零件侧 `POST /prod/parts/{id}/force-complete`、装配件侧
  // `POST /prod/assemblies/{id}/force-complete`，两者都绕过状态机直接写 COMPLETED，
  // 必须各自发事件，否则常驻大屏上的该行不会消失。
  | 'PART_FORCE_COMPLETED'
  | 'ASSEMBLY_FORCE_COMPLETED'
  // 2026-10-19：终态序列号一键释放（`POST /serials/release-terminal`）的**汇总事件**。
  // payload 只有下面两个计数，不带被释放行的 id 列表、不带任何展示字段 —— 消费方只能
  // 靠 event_type 触发失效后重取（`useDashboardInvalidation` 白名单），不能指望事件带
  // 全量快照去就地改某一行。
  | 'TERMINAL_SERIALS_RELEASED';

// `DashboardEventPayload` **不带任何展示字段**，只有 id 类键与少量计数。
// 旧版在这里声明过 serial_no / drawing_no / name / customer_path / is_urgent /
// planned_delivery_date / worker_name / shelf_code 八个展示字段 —— 那是 v1 遗留事件
// （旧横幅支持的 8 个 kind）的契约，v2 后端零产出方，且约 40 个 v2 事件的 payload 里
// 一个展示字段都不带。带展示字段的唯一事件是 SCAN_BANNER，而它的 payload 由域内
// `bannerSchema.ts` 单独守门、单独派生类型，不在本壳里声明。
// 判据落在「**有没有展示字段**」上，而不是「是不是只有 id 类键」—— 计数键不是展示文案
// （没有消费者把它渲染成一句话），所以 SCAN_BANNER 仍是唯一的展示事件。
export interface DashboardEventPayload {
  /** PART_FORCE_COMPLETED 携带的被强推工单 id（雪花 ID 字符串）。该事件绕过状态机
   *  直写 COMPLETED，不带任何展示字段 —— 消费方要按行定位只能靠这个 id。 */
  part_id?: string | null;
  // PART_TRANSFERRED（扫码接管）携带的三个键，全部是雪花 ID 字符串：被接管的批次、
  // 所属工单、接管**前**的持有人。该事件的四键 payload 里没有任何展示字段，语义是
  // 「这一批换人了」—— 想知道换给了谁、要刷哪些列表，按本文件头「本仓只按 event_type
  // 失效」的纪律走（`useDashboardInvalidation`），不要指望事件带全量快照。
  batch_id?: string | null;
  from_worker_id?: string | null;
  to_worker_id?: string | null;
  // 装配体事件携带的字段
  assembly_id?: string | null;
  // TERMINAL_SERIALS_RELEASED 携带的两个计数：本次释放的装配件数与零件数（JSON number）。
  // 只用于让消费方知道「变了多少」，定位到具体行仍要重取。
  assembly_count?: number;
  part_count?: number;
}

export interface DashboardEvent {
  type: 'event';
  event_type: DashboardEventType;
  data: DashboardEventPayload;
  ts: string;
}

// WS 协议层消息壳三件套，让 DashboardServerMessage union 是真正的判别联合
// （discriminated union）—— dispatch 函数里三个 type 分支靠 TS narrowing 收窄。
//   - WsSnapshotMsg：后端**每次连接（含重连）**的首帧 snapshot。`data` 的业务字段不消费
//     （HTTP 全量首取已替代），但重连后的那一帧承担断线期丢事件的补偿职责（派
//     `dashboard:full-refetch`）—— 详见 `api/dashboard.ts::dispatch` 的 snapshot 分支。
//   - WsHeartbeatMsg：后端 30s 保活 text 帧，前端无消费者。
// 字段对齐 backend-rust `src/modules/ws/hub.rs`。

export interface WsSnapshotMsg {
  type: 'snapshot';
  data: unknown;
  ts: string;
}

export interface WsHeartbeatMsg {
  type: 'heartbeat';
  ts: string | number;
}

export type DashboardServerMessage = DashboardEvent | WsSnapshotMsg | WsHeartbeatMsg;
export type ConnectionStatus = 'connecting' | 'open' | 'closed';

/** 连接状态订阅推送的四字段快照（api/dashboard.ts 的 onDashboardConnection）。
 *
 *  为什么不只给 `ConnectionStatus` 三态字符串：三态表达不了「closed 是不是断线」。
 *  主动关闭（登出、token 刷新换连接）与真实断开落在同一个 `'closed'` 上，对 UI 含义
 *  恰好相反 —— 前者不该 alarming，后者必须让人看见（大屏三个 query 都是
 *  `gcTime: POSITIVE_INFINITY` + 无 `refetchInterval`，断了会静默停更）。 */
export interface DashboardConnectionState {
  status: ConnectionStatus;
  /** 本次关闭是否**主动发起**（登出 / token 刷新换连接）。判据绑在 WS 层「待关闭的
   *  socket 实例」这一等值比较上，不是按 close code 猜 —— code 1000 也可能由服务端
   *  / 中间层主动发出，那是真实断开。 */
  expected: boolean;
  /** 连续失败次数（连上后归零）。退避不封顶，这个数会一直涨。 */
  retries: number;
  /** 最近一次关闭的诊断信息；从未失败过则为 null。 */
  lastError: { code: number; reason: string | null } | null;
}

// ============================================================
// 交期统计口径。
//
// dashboard 左栏「交期分桶」柱状图、派生它的「今日到期 / N 天到期」KPI、点柱后的
// 工单明细抽屉，三者共用同一个口径（同一份请求参数 → 同一份统计语义）。
//   - planned：按 planned_delivery_date（计划交期）分桶；
//   - system：按 system_delivery_date（系统交期）分桶，**后端与前端缺省口径**。
//
// 为什么放本文件而不是 dashboardSnapshotSchema.ts：口径是**请求参数**，不是响应
// VO 的一部分，wire 响应形态（{date, count, by_status}[]）与口径无关。schema 文件
// 的职责是对响应做 Zod 守门 + 派生响应类型，把请求参数塞进去会让「守卫响应」与
// 「描述请求」两件事混在一个文件里。
//
// 两种口径的统计结果**不可互相替代**：system_delivery_date 可空，后端对 NULL 做范围
// 比较恒为 false ⇒ 该列为 NULL 的工单在系统口径下整件不计入；planned_delivery_date
// 是 NOT NULL 列，计划口径无此缺失。两口径用的是**同一个日期窗口**、只是打在不同的列
// 上，桶的**个数**恒为请求的 days（服务端零填充），各桶件数随口径变化，合计**无可比
// 大小关系**（同一工单的两列可能分别落在窗口内外）。图卡上的口径开关旁挂了提示，避免
// 用户把差异误读成数据丢失。
export const DELIVERY_BASES = ['planned', 'system'] as const;

export type DeliveryBasis = (typeof DELIVERY_BASES)[number];

/** 口径 → 中文名（图卡开关 / 抽屉 header 共用同一份文案）。 */
export const DELIVERY_BASIS_LABEL: Record<DeliveryBasis, string> = {
  planned: '计划交期',
  system: '系统交期',
};

// ============================================================
// 2026-10-07 新增：工单预览弹窗的入参最小公共结构。
//
// dashboard 上三条行点击路径的行类型各不相同（WorkerHeldBatchData /
// SystemDeliveryOrderData / DeliveryOrderDetailData），但通用预览弹窗只读 4 个字段
// （序列号 / 名称 / 状态 + 按 id 拉图纸与批次两个独立请求）。收成这个最小结构而不是
// 让弹窗去认某个具体 VO：弹窗的契约就摆在这里，加字段时必须同步评估它的渲染面。
//
// ⚠️ **这里刻意只有 4 个字段**：交期面板的「装配件行点开子件列表、零件行点开预览」
// 分流发生在 DashboardView 自己那层（读 SystemDeliveryOrderData 自带的 row_type），
// 与本弹窗无关。分流所需字段不进本结构，否则会为了给一个弹窗不读的字段补值，把与
// 装配件无关的调用点（柱状图下钻明细行、子件行）全改成显式构造最小结构。
export interface PartPreviewTarget {
  id: string;
  serial_no: string | null;
  name: string;
  status: OrderStatus;
}
