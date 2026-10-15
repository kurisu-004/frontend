# CLAUDE.md

myERP 工厂管理系统前端：Vite 8 + Vue 3 + TypeScript + Element Plus。

## API 文档路径

后端主仓在 `~/Code/hsh-erp/backend-rust`（Rust + axum + sqlx）。后端契约的载体是**代码注释**，`docs/api/` 只对少数几个域做了整域契约文档（`ls backend-rust/docs/api/` 复核；上表最后更新 2026-10-17）：

| 文档 | 覆盖域 |
|---|---|
| `docs/api/batch.md` | `part` 批次域 |
| `docs/api/customers.md` | `com` 客户域（客户树 / CRUD / 无限层级口径，2026-10-17 新增） |
| `docs/api/dashboard.md` | `dashboard` 大屏聚合（3 个只读 HTTP 端点 + `/ws/dashboard` 的 WS 首帧与增量） |
| `docs/api/delivery_note.md` | `delivery_note` 送货单（列表 / 详情 / 扫码入单 / 移除批次 / 打印） |
| `docs/api/iam.md` | `iam` 认证 + 账号 + 企业微信绑定 + 货架（5 端点，§1.4） |
| `docs/api/inspection.md` | `prod::inspection` 待品检（队列列表 + 扫码三层树） |
| `docs/api/outsource.md` | 外协（报价 / 订单 / 收发货流转） |
| `docs/api/programming.md` | `prod::programming` 待编程一览 |
| `docs/api/queue.md` | `prod` 生产看板队列域 |
| `docs/api/statistics.md` | `statistics` 生产统计域（车间总览 + 工人贡献度 + 单工人详情，含有效工时口径表） |

**其余域没有 `docs/api/` 文档**（`assembly` / `wx` / `files` / `cnc_program` …），契约载体是代码注释。查接口按这条路径走：

1. **先查 `docs/api/` 清单**（`ls backend-rust/docs/api/`）有没有该域的文档 —— 有就直接 `Read`，它是整域契约（端点表 / 逐字段 / 口径表 / 错误码 / 前端配套清单）。
2. **没有就去该域的 `mod.rs` 模块 doc**（`src/modules/<域>/mod.rs` 顶部的 `//!` 注释块）：域范围、端点分组、路由硬切与关键取舍都写在这里。`prod` 是容器域，子域要看 `src/modules/prod/<子模块>/mod.rs`（如 `prod/batch`、`prod/inspection`）。个别域的模块 doc 很薄（`iam` 只有一行），那就下钻该域的 `handler` / `service`。
3. **字段级细节看 `vo` 与 `repo` 的文件头**：`vo`（出参，`Serialize` 侧）与 `repo`（SQL 真源 + 胖 trait）的模块 doc 按端点语义分组列了字段与口径，再细看逐字段 / 逐函数的 doc 注释。

⚠️ **引用路径前先确认目标存在** —— 不要凭印象 `Read` 一个 `docs/api/` 下的文件，那条路径下的文档随域逐个上线，上表会继续变。

## 主题色

藏青 `#1e4d8b` / 蓝 `#2c6cb8` / 浅蓝 `#4a8fd6`，定义在 `src/styles/variables.scss` 的 `:root` 块。

## 约定

- 代码注释、commit message、文档一律中文。
- 注释里带日期戳（如 `2026-10-02 新增`）说明变更缘由。
- 包管理器统一用 **npm**（锁文件 `package-lock.json`），不要切 pnpm/yarn（避免与 CI/Docker 构建漂移）。
- 注释与文档只写**当前**行为与取舍，不记录历史方案对比、被推翻的旧表述、review 编号或行号（行号必然过期）。

## 已知风险

- 依赖 `xlsx@0.18.5` 有原型污染 + ReDoS 高危漏洞（npm 官方无修复版本）。仅用于内部只读 Excel 解析（parser / 视图已统一收口，不执行公式宏），攻击面可控，后续迁 SheetJS CDN 版或 exceljs。
- `src/three/OcctStepLoader.ts::buildTopology` 递归取子形状（face / wire / edge）时，每个子形状的 wasm 句柄都直接塞进 `TopologyNode.children[].handle`，**全程不释放** —— `releaseShape()` 只释放根句柄。一次复杂 STEP 的面 / 线 / 边量级足以让 wasm arena 迅速膨胀。当前刻意延后：仓内**没有任何释放子句柄的入口**（`shapeCache.forget()` / `shapeCache.reset()` 只按**根句柄**删缓存条目，子句柄从来不是表里的键），所以子句柄一释放，`children[].handle` 就变成悬空数字；而 `inspectLastLoaded()` / `getTopology()` / `getStats()` 三个调试导出（无代码调用方，仅供浏览器控制台排查 OCCT 解析结果）是现场唯一的排查手段，数字悬空后就再也没法拿它们比对。要动 `buildTopology` 的子形状遍历前先读这条。
