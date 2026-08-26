# 首页大屏

> **目标读者**：前端开发（添加/修改首页 + WebSocket 订阅）
> **核心价值**：登录后默认进入的工厂大屏，提供货架状态总览与加工实况的实时推送
> **最后更新**：2026-08-26 · **维护者**：@frontend-team

---

## 一、入口与路由

| 项 | 值 |
|---|---|
| 路径 | `/dashboard`（`/` 重定向到此） |
| 组件 | `src/views/Dashboard.vue` |
| 守卫 | `requireAuth: true`（所有登录用户） |
| menuCode | `home` |
| 父级 | `MainLayout` 子树 |

路由定义见 `src/router/index.ts`，父级 `/` 节点自带 `redirect: '/dashboard'`，登录后浏览器地址栏落到 `/dashboard`。

## 二、关键页面

- `src/views/Dashboard.vue` — 上下两段：顶部 2/3 货架轮播（`el-carousel` 每页 2 个货架卡，间隔 8s）+ 底部 1/3 正在加工（按工人分组的流水号 chips）。数据全部来自 WS snapshot，不发任何 HTTP 拉取。
- `src/components/NotificationBanner.vue` — 业务事件横幅（`Teleport to body`），消费 `onDashboardEvent`，由 `MainLayout` 挂载，**不在 Dashboard.vue 内**。PICKED_UP / RETURNED / INSPECTED 三类事件对应不同图标，加急件额外显示红色 tag。

## 三、主要 API 调用

| 端点 | 实例 | 用途 |
|---|---|---|
| `ws://.../api/v1/ws/dashboard`（含 `?token=`） | WebSocket（不走 axios） | dashboard snapshot + 业务事件推送 |
| `onDashboardSnapshot(handler)` | `src/api/dashboard.ts` 模块级单例 | 订阅全量快照 |
| `onDashboardEvent(handler)` | 同上 | 订阅增量事件（被 NotificationBanner 消费） |
| `onDashboardStatus(handler)` | 同上 | 订阅连接状态（connecting / open / closed） |
| `reconnectDashboard()` | 同上 | JWT 刷新后强制重连（监听 `auth:tokens-refreshed`） |

`src/api/dashboard.ts` 是 WebSocket 单例 + 多频道订阅的实现：模块级维护 `ws`、`snapSubs`、`eventSubs`、`statusSubs` 三个 Set；第一个订阅触发 `ensureConnected()`，最后一个反订阅只 `unsubscribe` 频道，不断 socket。指数退避重连 1s → 2s → 4s → ... 上限 10s。

## 四、可视化组件

`src/components/EChart.vue` — ECharts 6 封装（v5 主题锁定 + ResizeObserver + unmount dispose）。模块化注册（`echarts/core` + `use`），**绝对不要 `import 'echarts'`**，否则拉全量 ~900KB bundle。目前主要被统计模块复用（`OverviewTab` / `WorkerStatsTab` / `WorkerDetailTab`），首页未直接使用，后续如要补趋势图可挂载。

## 五、权限

| 角色 | 可见性 | 点击详情 |
|---|---|---|
| MANAGER / CLERK / INSPECTOR / CNC_PROGRAMMER | 是 | 是 |
| SHELF_ACCOUNT（工控机） | 是 | **否**（`canOpenPartDetail` 闭锁） |

`canOpenPartDetail` 在 `Dashboard.vue` 顶部定义，纯前端 gate；后端 `GET /parts/{id}` 同样对 SHELF_ACCOUNT 收紧，前后端一致。

## 六、相关 composable / utils

- `usePermissions` — 提供 `isManager` / `isClerk` / `isInspector` / `isCncProgrammer` 等 `ComputedRef`，由 `useAuthSession().hasRole()` 派生。
- `src/utils/deliveryDate.ts` — `formatDashboardDeliveryDate()`，banner 与首页共用。

## 七、后端契约

- `~/Code/hsh-erp-rust/docs/api/websocket.md` — dashboard WS 协议（snapshot / event / status 三类消息 schema）。
- 注意：当前 WS 仍走 v1（`/api/v1/ws/dashboard`），v2 切换未排期。

## 八、关键约束与陷阱

- **echarts 独立懒加载 chunk ~700KB**：仅在使用 `EChart.vue` 的页面才会进入 dependency optimization；首页不引入，避免冷启动开销。
- **WS 重连后必须恢复频道订阅**：后端每条新连接默认无订阅；`socket.onopen` 内 `syncSubscriptions(socket)` 按当前 handler Set 状态补发 `subscribe` 指令。**不要**在 `onmessage` 里做状态判断来兜底。
- **token 走 `?token=` query string**：浏览器 WebSocket API 不允许塞 header，权衡后接受 URL 日志泄漏风险（遵循"前端无 secret"原则：后端有完整 request log，前端只是搬运）。
- **CONNECTING 期间不能 close()**：旧 socket 还在握手时调 `teardown()` 会触发浏览器 `WebSocket is closed before the connection is established`；单例握手期间所有调用共用同一 URL 等其完成即可，详见 `connect()` 注释。
- **陈旧 socket 的 onclose 必须忽略**：多连接堆叠（重连竞赛）会让大屏收到重复推送；`socket !== ws` 时 onclose 直接 return。
- **nginx 反代已配 WebSocket upgrade**：见 `nginx.conf` 中 `/api/` 段的 `proxy_http_version 1.1` + `Upgrade` / `Connection` 头。
- **雪花 ID 必须 string**：snapshot 里 `shelf_id` / `worker_id` 都是 string，不要 `Number()`。

## 九、未来扩展位

### 9.1 `#future-pages`

- 多车间切换：当前 snapshot 是单车间全量；后续如按车间分频道，路由 `?workshop=` 参数可驱动 `sendSubscriptionCommand` 增量订阅。
- 自定义看板布局：把轮播与正在加工两段抽成 `<DashboardPanel>` slot，用户拖拽布局存到 localStorage / 后端。
- 接入 EChart：在 dashboard 增加趋势 mini 图（如近 7 天完工数），需要时直接 import `EChart.vue` 即可（已按需注册，不会拖慢首页冷启动）。

## 十、消息类型速查（参考后端契约）

dashboard WS 消息三类，前端分发靠 `msg.type` 判断：

| 类型 | 触发时机 | 关键字段 |
|---|---|---|
| `snapshot` | 连接建立后第一帧 / 每次重连后第一帧 | `data.on_production_shelves[]`、`data.in_process[]` |
| `event` | 工人刷卡、零件状态切换等增量事件 | `event_type`（PICKED_UP / RETURNED / INSPECTED ...）、`drawing_no`、`shelf_code`、`is_urgent` |
| 状态 | WebSocket 实例自身 | 仅客户端内部：`connecting` / `open` / `closed` |

前端 `DashboardServerMessage` 是 `snapshot | event` 的联合类型；状态走单独的 `onDashboardStatus` 通道，不进入 dispatch 路径。完整字段定义见 `src/types/dashboard.ts`。
