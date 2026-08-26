# 生产统计

> **目标读者**：前端开发（添加/修改统计页或图表）
> **核心价值**：生产 KPI + 工人贡献度 + 跳序异常分析；ECharts 6 + WebSocket 增量推送（断线降级为 30s 轮询）
> **最后更新**：2026-08-26 · **维护者**：@frontend-team

---

## 一、入口与路由

| 项 | 值 |
|---|---|
| 路径 | `/statistics` |
| 组件 | `src/views/statistics/ProductionStats.vue` |
| 守卫 | `requireAuth: true`（MANAGER-only 校验在数据层） |
| menuCode | `production_stats` |
| 父级 | `MainLayout` 子树 |

路由定义见 `src/router/index.ts`，父级 `/` 节点自带 `MainLayout` 包裹。后端统计域 router-level `require_role(MANAGER)` —— 非 MANAGER 调任意端点会拿到 403，前端菜单也通过 `user.menus` 过滤，菜单不可见就进不来。

## 二、关键页面

`src/views/statistics/ProductionStats.vue`（壳，7.1K）：顶部筛选（时间范围 + 自定义日期对），下方 4 个 Tab。

| Tab | 文件 | 职责 |
|---|---|---|
| 总览 | `OverviewTab.vue`（9.5K） | 4 大图：订单数（按日）/ 完成数（按日）/ 趋势折线 / 工人排名柱状 |
| 工人统计 | `WorkerStatsTab.vue`（7.9K） | 工种筛选 + 工人贡献度列表（pickup_count / return_count / completion_rate） |
| 工人详情 | `WorkerDetailTab.vue`（10.5K） | 单工人折线（按日 pickup / return）+ 参与工单表 |
| 跳序领取 | `PickupSkipTab.vue`（9.1K） | 跳序取件汇总 + drawer 明细分页（不消费时间范围，append-only 历史流） |

四个 Tab 都用静态 `import`（`OverviewTab` / `WorkerStatsTab` / `WorkerDetailTab` / `PickupSkipTab`），但 `<el-tab-pane>` 内置 `v-if` 控制子组件挂载，未激活的 Tab 内容不渲染——ECharts 实例仅在 tab 激活时创建与销毁。

## 三、主要 API 调用

`src/api/statistics.ts`（**全部走 `api`（v1），baseURL `/api/v1`**）：

| 函数 | 端点 | 用途 |
|---|---|---|
| `fetchOverview(q)` | `GET /statistics/overview` | 总览 4 大图 |
| `fetchWorkerStats(q)` | `GET /statistics/workers` | 工人贡献度列表（一次性全量） |
| `fetchWorkerDetail(workerId, q)` | `GET /statistics/workers/{worker_id}` | 单工人详情 |
| `fetchPickupSkipSummary()` | `GET /statistics/pickup-skips` | 跳序取件汇总（按工人聚合） |
| `fetchPickupSkipDetail(workerId, q)` | `GET /statistics/pickup-skips/{worker_id}` | 单工人跳序事件明细分页 |

入参 `date_from` / `date_to` 必填 `'YYYY-MM-DD'`（后端严格校验）；`fetchPickupSkipSummary` / `fetchPickupSkipDetail` 无日期范围（append-only 历史流）。

> 注：`fetchWorkerStats` 后端一次性返回所有未软删工人，**前端按 `is_active` / 工种 / `pickup_count` 自管分页筛选**——不要在前端做后端分页请求。

## 四、可视化

`src/components/EChart.vue`（ECharts 6 封装）：

| 设计点 | 说明 |
|---|---|
| 模块化注册 | `echarts/core` + `use`，不引入全量 bundle |
| v5 主题锁定 | `import 'echarts/theme/v5'`（ECharts 6 默认主题变更，注册 v5 旧主题保持原有配色） |
| `ResizeObserver` | 容器尺寸变化时自动 `chart.resize()` |
| `onBeforeUnmount` | `chart.dispose()` 释放实例，避免内存泄漏 |

四个 Tab 都是按需引入（静态 `import`）+ `<el-tab-pane v-if>` 控制挂载：首屏只引入 `OverviewTab`，其他三个 Tab 的 ECharts 实例仅在切换时创建。

## 五、WebSocket 增量

复用 `src/api/dashboard.ts` 的 WS 单例：

| 项 | 说明 |
|---|---|
| 连接 | `ws://.../api/v1/ws/dashboard?token=...`（不走 axios） |
| 模块级单例 | 多页面共享同一连接；重复调用 `connect()` 直接返回已有 socket |
| 频道订阅 | `onDashboardSnapshot(handler)` / `onDashboardEvent(handler)` |

新事件触发时增量更新图表：业务事件（PICKED_UP / RETURNED / INSPECTED 等）由 WS 推送 → 总览 / 工人统计的 KPI 数字局部刷新，**不需要整体 refetch**。

**轮询回退策略**：WS 断线后降级为 30s 轮询（`setInterval` 拉 overview），重连成功后停掉轮询。具体实现细节见 `src/api/dashboard.ts` 的 `connect()`。

## 六、业务指标

| 指标 | 来源 | 展示 |
|---|---|---|
| 订单数（按时间窗口） | `fetchOverview` | KPI 卡 + 柱状 |
| 完成数（按时间窗口） | `fetchOverview` | KPI 卡 + 柱状 |
| 趋势（折线） | `fetchOverview` 的 `daily_created` / `daily_completed` | 折线图 |
| 工人排名（柱状） | `fetchOverview` 的 worker ranking | 水平条形 |
| 工人贡献度 | `fetchWorkerStats` | 表格 + 工种筛选 |
| 单工人详情 | `fetchWorkerDetail` | 折线 + 工单表 |
| 跳序领取（异常分析） | `fetchPickupSkipSummary` / `Detail` | 汇总表 + drawer 明细 |

跳序领取指工人跳过了正常的工序路径直接取件（例如跳过 PROGRAMMING 直接 PICK_UP），是流程异常的强信号——统计页用于回溯这类事件。

## 七、权限要求

| 角色 | 权限 |
|---|---|
| `MANAGER` | 全权访问 |
| 其他角色 | 菜单不可见（`user.menus` 过滤），调后端 403 |

后端 router-level `require_role(MANAGER)`。

## 八、后端契约锚链

| 文档 | 路径 |
|---|---|
| statistics 域 | `~/Code/hsh-erp-rust/docs/api/index.md` 标注「未上线域」（**当前 v2 statistics 路由 nest 但 handler 空 → 全部 404**）；本前端仍走 v1 `/api/v1/statistics.py` |
| WebSocket 增量推送协议 | `~/Code/hsh-erp-rust/docs/api/websocket.md` |
| dashboard WS 实现细节 | `src/api/dashboard.ts` |

> statistics 在 v2 主仓尚未实施（路由 nest 但 handler 空）。前端保持 v1 调用，等 v2 上线后切 `apiV2`。

## 九、关键约束与陷阱

- **4 Tab 都是按需引入（静态 import）+ `v-if` 控制挂载**：未激活的 Tab 不创建 ECharts 实例，避免一次性拉入所有图表资源。
- **WebSocket 增量更新与轮询回退策略**：WS 断线后必须降级为 30s 轮询，否则用户看到的是「冻结」的数据；重连成功必须停掉轮询。
- **大数据量导出限速（后端处理）**：当前统计页不做客户端导出，导出能力由后端专门端点提供；前端只是 UI。
- **echarts ~700KB 独立懒加载 chunk**：靠静态 `import` 走 Vite 自动代码分割；不要把 echarts 提到 main.ts 入口同步加载。
- **雪花 ID 必为 string**：`worker_id` 是雪花 ID 字符串，`fetchWorkerDetail(workerId, q)` 入参用 `encodeURIComponent(workerId)`。
- **`date_from` / `date_to` 严格 `'YYYY-MM-DD'`**：后端会校验格式；前端用 `value-format="YYYY-MM-DD"` 的 `el-date-picker` 保证格式一致。

## 十、跨域锚链

- 大屏 WS 单例与轮询回退策略见 [dashboard.md](dashboard.md)。
- 工人主数据见 [users-and-workers.md](users-and-workers.md)（工人花名册 + 工种关联）。
- 跳序领取的事件源（零件流程异常）见 [parts-and-orders.md](parts-and-orders.md)。

## 十一、未来扩展位

- 自定义时间窗口（当前仅本月 / 上月 / 本年 / 自定义；可加 7 天 / 30 天 / 季度）
- 导出 Excel 报表（后端新增 export 端点，前端调下载）
- 多车间对比（按 `workshop_id` 拆分 KPI）
- 趋势预测（基于历史 daily_completed 序列做简单线性外推）
- 实时告警面板（基于 WS 事件 + 阈值规则触发 toast）
