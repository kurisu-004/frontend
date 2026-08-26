# myERP Frontend 文档总入口

> **目标读者**：所有人
> **核心价值**：9 大分组树状索引 + 按身份速查分流
> **最后更新**：2026-08-26 · **维护者**：@frontend-team

---

## 项目一句话

myERP 工厂管理系统前端，Vite 8 + Vue 3.4 + TypeScript + Element Plus 2.7。后端双轨：v1 FastAPI（`/api/v1`）+ v2 Rust 主仓 `~/Code/hsh-erp-rust`（`/api/v2`），前端用 `api` 和 `apiV2` 双 axios 实例。

## 文档地图

```
docs/
├── README.md                       # 本文件 — 文档总入口
├── 01-getting-started/             # 新人 5 分钟入门
├── 02-architecture/                # 架构核心（5 大非显然决策）
├── 03-modules/                     # 11 业务域索引与域文档
├── 04-ui-and-styling/              # UI 体系 + EP 集成 + 设计 token
├── 05-build-and-deploy/            # 构建 / Docker / nginx 部署
├── 06-data-and-excel/              # 数据契约 + Excel 解析
├── 07-testing/                     # 测试策略
├── 08-known-risks/                 # 已知风险与遗留决策
└── api-requirements/               # 给后端 agent 的需求文档（保留）
```

## 按身份速查

### 新人（刚 clone 仓库）

按顺序读：

1. [01-getting-started/README.md](01-getting-started/README.md) — 5 分钟知道是什么、怎么跑
2. [01-getting-started/project-layout.md](01-getting-started/project-layout.md) — 30 秒理解 `src/` 拓扑
3. [02-architecture/README.md](02-architecture/README.md) — 5 大非显然架构决策
4. 按需读 [03-modules/](03-modules/) — 接手哪个域读哪个

### Agent（接手新模块 / 自动重构）

优先跳这两处：

1. 仓库根 [CLAUDE.md](../CLAUDE.md) "硬约束" 段 — 命令片段、8 条禁忌、与 v2 后端的契约路径
2. [02-architecture/](02-architecture/) 全文 — api 契约 / 状态管理 / 路由权限 / 构建 / pdfjs
3. 接手哪个域读 [03-modules/](03-modules/) 对应域文档

### 部署运维

直接进 [05-build-and-deploy/](05-build-and-deploy/)：

- Docker 多阶段构建（`node:24-alpine` → `nginx:1.30-alpine`）
- nginx 反代 + WebSocket + MCP 端点 deny-all
- 证书缺失自动降级 HTTP 启动
- `client_max_body_size 300m`（批量 PDF 上传）

### 后端联调

1. [02-architecture/api-contract.md](02-architecture/api-contract.md) — 双 axios 实例 + 信封协议 + 错误码
2. 后端契约：`~/Code/hsh-erp-rust/docs/api/`（auth / users / delivery-notes / delivery-groups / websocket / index）
3. 给后端的需求写在 [api-requirements/](api-requirements/)

## 与 README.md / CLAUDE.md 的分工

| 文件 | 受众 | 内容 |
|---|---|---|
| [README.md](../README.md) | 30 秒上手 | clone + install + run + 主题色 + 已知风险 |
| [CLAUDE.md](../CLAUDE.md) | AI Agent 速查手册 | 常用命令、架构要点（带注释引用）、构建配置非显然点、约定、安全风险 |
| [docs/](.) | 开发者项目百科 | 架构故事 + 模块细节 + 决策缘由 + 跨文档引用 |

三者不重复：README 给最浅，CLAUDE.md 给 Agent 上下文最密集的一份，docs/ 给深入主题的完整论述。

## 文档维护约定

- 文档顶部统一格式：`目标读者` + `核心价值` + `最后更新` + `维护者`
- 中文为主，专有名词保留英文
- 文件路径、代码标识符一律反引号
- H2 主章节开头 3-5 行引言段
- 不写 emoji、不写"待补充"、不引用具体行号
