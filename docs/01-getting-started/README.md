# 新人入门

> **目标读者**：刚接手项目的前端 / 后端联调 / 部署运维
> **核心价值**：5 分钟知道这是什么、怎么跑、按身份分流继续读
> **最后更新**：2026-08-26 · **维护者**：@frontend-team

---

## 这是什么

myERP 工厂管理系统前端。后端双轨运行：v1 FastAPI（`/api/v1`，历史兼容）+ v2 Rust 主仓 `~/Code/hsh-erp-rust`（`/api/v2`，新功能优先）。前端用 `api` 和 `apiV2` 两个 axios 实例同时对接两套后端。

系统覆盖 **11 个业务域**：

| 域 | 一句话 |
|---|---|
| 零件 / 装配 | 零件 CRUD、装配件、批次、报价、Pdf 上传、零件详情 |
| 订单全生命周期 | 待品检、待编程一览、外协发送/接收、返修接收、送货单 |
| 品检 / 送检 / 返修 | 单件品检、批量通过品检（v2）、返修接收、外协对账 |
| 外协 | 外协厂一览、报价一览、发送/接收、对账（按公司聚合 SENT_TO_OUTSOURCE 事件） |
| 送货单 / 扫码建单 | 送货单管理 + 详情 + 司机送货台（v2 扫码建单） |
| 工位扫码台 | 工人工牌识别 → 取件 / 放回 / 送检（独立全屏路由树） |
| 货架 / CNC | 货架管理、CNC 工位账号 |
| 客户 / 申请人 | 客户树、申请人主数据 |
| 账号 / 工人 | 系统账号（含角色）、工人花名册 |
| 首页大屏 | 工厂大屏（WebSocket 实时推送） |
| 生产统计 | 4 Tab 统计（产量 / 合格率 / 按时率） |
| 设置 | 工种、工序、工种-工序映射、字典 |

## 技术栈

```
Vite 8  ·  Vue 3.4  ·  TypeScript 5.4  ·  Element Plus 2.7
axios  ·  echarts 6  ·  pdfjs 6  ·  xlsx 0.18  ·  pinia 2  ·  sortablejs
```

## 快速跑起来

```bash
git clone <repo>          # 仓库地址见内部文档
cd frontend
npm ci                    # 用 lockfile 严格安装，不重新解析
npm run dev               # → http://localhost:5173
```

需要后端在 `127.0.0.1:8000`（v1 FastAPI）和 `127.0.0.1:3000`（v2 Rust，未启动则 `/api/v2/*` 报 502）同时运行才能完整跑通。详见 [installation.md](./installation.md)。

## 文档地图

```
docs/
├── README.md                       文档总入口 + 按身份速查
├── 01-getting-started/             本目录（5 分钟入门）
├── 02-architecture/                5 大非显然架构决策
├── 03-modules/                     11 业务域索引
├── 04-ui-and-styling/              UI 体系 + EP 集成
├── 05-build-and-deploy/            构建 / Docker / nginx
├── 06-data-and-excel/              数据契约 + Excel 解析
├── 07-testing/                     测试策略
├── 08-known-risks/                 已知风险与遗留决策
└── api-requirements/               给后端 agent 的需求
```

## 接下来读什么

按身份分流：

- **新人前端**：本 README → [project-layout.md](./project-layout.md) → [02-architecture/README.md](../02-architecture/README.md) → 接手哪个域读 [03-modules/](../03-modules/) 对应域
- **Agent 接手新模块**：仓库根 [CLAUDE.md](../../CLAUDE.md) → [02-architecture/](../02-architecture/) 全文 → 接手哪个域读 [03-modules/](../03-modules/) 对应域
- **后端联调**：[02-architecture/api-contract.md](../02-architecture/api-contract.md) → 后端契约 `~/Code/hsh-erp-rust/docs/api/`
- **部署运维**：[05-build-and-deploy/](../05-build-and-deploy/)

## 仓库内其他入口

- 根 [README.md](../../README.md) — 30 秒上手 + 主题色 + 已知风险
- 根 [CLAUDE.md](../../CLAUDE.md) — Agent 速查手册（命令、架构要点、约定、安全）
- 根 [package.json](../../package.json) — npm scripts 与依赖版本
- 根 [vite.config.ts](../../vite.config.ts) — 构建配置（dev 代理、auto-import、optimizeDeps）
