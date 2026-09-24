# CLAUDE.md

myERP 工厂管理系统前端：Vite 8 + Vue 3 + TypeScript + Element Plus。

## API 文档路径

后端主仓已迁到 `~/Code/hsh-erp-rust`（Rust + axum + sqlx）。所有后端契约一律维护在 `~/Code/hsh-erp-rust/docs/api/`（按域切分：`auth.md` / `users.md` / `delivery-notes.md` / `delivery-groups.md` / `websocket.md` / `index.md` 通用约定）。需要查后端接口时直接 `Read` 对应文件，不要翻 `src/modules/*` 源码反推。

## 主题色

藏青 `#1e4d8b` / 蓝 `#2c6cb8` / 浅蓝 `#4a8fd6`，覆盖在 `src/styles/variables.scss` 的 `:root` 块里。

## 约定

- 代码注释、commit message、文档一律中文。
- 注释里带日期戳（如 `2026-08-26 新增`）说明变更缘由是本仓库的通行做法。

## 架构约定（硬约束）

- **登录页架构（2026-09-24）**：`LoginView` 持表单 ref + `useMutation`（`retry: 0`，mutation 失败绝不能重试 3 次）+ Zod schema 校验；`LoginCard.vue` 是纯展示视觉壳（不持表单状态），通过 `#default` slot 注入字段，`#footer` slot 注入链接；emit `submit` 不带 payload。复用时只改 LoginView，不动 LoginCard。
- **TanStack Query（2026-09-24 首例基建）**：`QueryClient` 在 `src/main.ts` 注册（pinia 之后、mount 之前），全局 `mutations.retry: 0` / `queries.retry: 0` / `queries.refetchOnWindowFocus: false`。新增 mutation 时默认不再写 retry，信任全局默认。useMutation 失败重试是 TanStack 默认 3 次指数退避，对所有业务 mutation 都是反模式。
- **Zod schema-first**（2026-09-24 起）：表单类 schema 写在 `src/views/<域>/<表单>Schema.ts`，导出 schema + `z.infer` 派生的 TS 类型；trim / min / max 链式顺序 trim 在前。错误聚合用 `toFieldErrors` 工具（同 schema 文件内）。

## 已知风险

- 依赖 `xlsx@0.18.5` 有原型污染 + ReDoS 高危漏洞（npm 官方无修复版本）。仅用于内部只读 Excel 解析（4 个 parser + 2 个视图统一收口，不执行公式/宏），攻击面可控。2026-08-21 决策保留，后续迁 SheetJS CDN 版或 exceljs。详见 [`docs/08-known-risks/dependency-risks.md`](./docs/08-known-risks/dependency-risks.md)。
