# 业务模块索引

> **目标读者**：Agent / 新人前端 / 后端联调
> **核心价值**：11 业务域的总入口，给出文档链接、路由前缀、v1/v2 迁移状态
> **最后更新**：2026-08-26 · **维护者**：@frontend-team

---

## 一、业务域清单（11 域）

| 域 | 文档 | 路由前缀 | 一句话职责 |
|---|---|---|---|
| 零件 / 订单 | [parts-and-orders.md](parts-and-orders.md) | `/parts` | 零件 CRUD 与下单 |
| 品检 / 返修 | [inspection-and-repair.md](inspection-and-repair.md) | `/inspection` | 单件 / 批量品检、返修流转 |
| 送货单 | [delivery-notes.md](delivery-notes.md) | `/delivery-notes` | 送货单管理 + 详情 + 缓存策略 |
| 工位扫码台 | [scan-station.md](scan-station.md) | `/scan` | 工人扫码台（独立路由树，无 MainLayout） |
| 外协 | [outsource.md](outsource.md) | `/outsource` | 外协单流转 |
| 货架 / CNC | [shelves-and-cnc.md](shelves-and-cnc.md) | `/shelves` `//cnc` | 货架账户与 CNC 工位 |
| 客户 / 申请人 | [customers-and-applicants.md](customers-and-applicants.md) | `/customers` `//applicants` | 客户主数据 + 申请人 |
| 账号 / 工人 | [users-and-workers.md](users-and-workers.md) | `/users` `//workers` | 系统账号 + 工人花名册 |
| 首页大屏 | [dashboard.md](dashboard.md) | `/` `/dashboard` | 工厂大屏 + WebSocket 实时 |
| 生产统计 | [statistics.md](statistics.md) | `/statistics` | 产量、合格率、按时率统计 |
| 设置（工种 / 工序） | [settings.md](settings.md) | `/settings` | 工种、工序、字典维护 |

> 注：部分文档为占位链接，详细内容随各域梳理补齐。本 README 是索引，**不重复域内信息**。

## 二、v1 / v2 迁移进度

后端契约统一路径：`~/Code/hsh-erp-rust/docs/api/`（按域切分）。前端 `src/api/` 下既有 `api`（v1）也有 `apiV2`（v2）两个 axios 实例，**新功能必须在 `apiV2` 上加**。

| 域 | 当前状态 | 切换时间 |
|---|---|---|
| auth | 100% v2 | 2026-08-26 |
| deliveryNote | 部分 v2 | 2026-08-24 |
| deliveryGroup | 100% v2 | V2 P1 |
| 单件 scanInspect | v2 | 2026-08-25 |
| 批量 batchPassInspection | v2 | 2026-08-25 |
| 批量 batchScanInspect | v2 | 2026-08-25 |
| 零件 CRUD | v1 | — |
| 装配 | v1 | — |
| 外协 | v1 | — |
| 货架 | v1 | — |
| CNC | v1 | — |
| 客户 / 申请人 | v1 | — |
| 账号 / 工人 | v1 | — |
| 大屏 WS | v1 | — |
| 统计 | v1 | — |
| 设置（工种 / 工序） | v1 | — |

迁移通用规则：v1 → v2 切换后，v1 refresh_token / session 立即作废（不同 JWT 签名 + 不同 session 表），受影响用户首次访问会被强制重登一次，由 40101/40103 静默兜底（见 `src/api/auth.ts`）。

## 三、各域文档共同大纲

每篇 `<domain>.md` 按以下结构组织，方便读者预期：

```
1. 入口与路由
   - 文件：src/router/index.ts 里的路由定义
   - meta：menuCode / roles / layout（MainLayout vs 全屏）
2. 关键页面（每个 .vue 一句话职责）
   - List：列表页职责 + 关键筛选/排序
   - Detail：详情页职责 + 关键交互
   - FormDialog（如有）：表单弹窗
3. 主要 API 调用（v1/v2 标注）
   - 表格：endpoint → 哪个 axios 实例 → 后端契约文件
4. 权限要求
   - 角色：MANAGER / CLERK / INSPECTOR / SHELF_ACCOUNT ...
   - menuCode（与后端菜单表 code 对齐）
5. 相关 composable / utils
   - 列出本域复用的模块级单例 composable
6. 后端契约锚链
   - ~/Code/hsh-erp-rust/docs/api/<domain>.md
7. 关键约束与陷阱
   - 雪花 ID 必须 string
   - 信封解构失败如何降级
   - composable 单例状态泄漏如何避免
```

## 四、新增业务域的 checklist

按顺序走完 5 步，前后端契约一致即可上线：

1. **建目录**：`src/views/<new-domain>/` 放 `.vue` 页面（按 List / Detail / FormDialog 拆）。
2. **写接口**：`src/api/<new-domain>.ts` 走 `apiV2`（baseURL `/api/v2`），遵循信封 `{code, message, data}`。
3. **写类型**：`src/types/<new-domain>.ts` 集中放请求/响应类型，**雪花 ID 用 string**。
4. **加路由**：`src/router/index.ts` 加路由 + meta；**`menuCode` 必填**（与后端菜单表对齐，前置守卫 `allowByMenuCode` 会卡）。
5. **加文档**：`docs/03-modules/<new-domain>.md` 按本 README 第三节的共同大纲写。

> 完成上述 5 步后才算"上线"——少任何一步，前置守卫 / 菜单渲染 / 类型契约都会出问题。