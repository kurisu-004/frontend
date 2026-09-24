# CLAUDE.md

myERP 工厂管理系统前端：Vite 8 + Vue 3 + TypeScript + Element Plus。

## API 文档路径

后端主仓已迁到 `~/Code/hsh-erp-rust`（Rust + axum + sqlx）。所有后端契约一律维护在 `~/Code/hsh-erp-rust/docs/api/`（按域切分：`auth.md` / `users.md` / `delivery-notes.md` / `delivery-groups.md` / `websocket.md` / `index.md` 通用约定）。需要查后端接口时直接 `Read` 对应文件，不要翻 `src/modules/*` 源码反推。

## 主题色

藏青 `#1e4d8b` / 蓝 `#2c6cb8` / 浅蓝 `#4a8fd6`，覆盖在 `src/styles/variables.scss` 的 `:root` 块里。

## 约定

- 代码注释、commit message、文档一律中文。
- 注释里带日期戳（如 `2026-08-26 新增`）说明变更缘由是本仓库的通行做法。


## 已知风险

- 依赖 `xlsx@0.18.5` 有原型污染 + ReDoS 高危漏洞（npm 官方无修复版本）。仅用于内部只读 Excel 解析（4 个 parser + 2 个视图统一收口，不执行公式/宏），攻击面可控。2026-08-21 决策保留，后续迁 SheetJS CDN 版或 exceljs。详见 [`docs/08-known-risks/dependency-risks.md`](./docs/08-known-risks/dependency-risks.md)。
