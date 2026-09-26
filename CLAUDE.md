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

- **登录页架构（2026-09-24）**：`LoginView` 持表单 ref + `useMutation`（不显式写 retry，信任全局默认）+ Zod schema 校验；`LoginCard.vue` 是纯展示视觉壳（不持表单状态），通过 `#default` slot 注入字段，`#footer` slot 注入链接；emit `submit` 不带 payload。复用时只改 LoginView，不动 LoginCard。
- **TanStack Query（2026-09-24 首例基建）**：`QueryClient` 在 `src/main.ts` 注册（pinia 之后、mount 之前），全局 `mutations.retry: 0` / `queries.retry: 0` / `queries.refetchOnWindowFocus: false`。新增 mutation 时默认不再写 retry，信任全局默认。TanStack v5 的 mutation 官方默认即不重试（3 次指数退避是 query 默认值），全局显式 retry: 0 是双保险兼明示意图。
- **Zod schema-first**（2026-09-24 起）：表单类 schema 写在 `src/views/<域>/<表单>Schema.ts`，导出 schema + `z.infer` 派生的 TS 类型；trim / min / max 链式顺序 trim 在前。错误聚合用 `toFieldErrors` 工具（同 schema 文件内）。
- **录入 Tab 范本（2026-09-24 parts/new）**：`PartBatchManualTab` 持 staged 列表 + 预览 dialog，对话框表单抽到 `PartEntryFormDialog.vue` 展示壳；表单校验走 Zod schema（`partEntrySchema.ts`，DDL 长度上限），单字段错误通过 `validateField(field)` 写 `formErrors` ref、`el-form-item :error="formErrors.xxx"` 展示，不依赖 EP `FormRules` 与 `formRef.validate()`。客户存在性等依赖动态列表的校验不进 schema，留在 `onAddConfirm` 业务层写 `formErrors`。提交走 `useMutation<PartBatchResult, Error>`，mutationFn 仅调一个内部 `submitStagedEntries()`（薄封装：dedupe + batchCreateParts），部分失败/成功跳转/ElMessage 放 onSuccess/onError。
- **auth store 架构（2026-09-26）**：`src/stores/auth.ts` Pinia setup store 是 auth 唯一状态源
  （user / token / menus / roles / shelf scope / dummy 标记），替代原
  `composables/useAuthSession` 模块级单例。login useMutation 在 store 内（全局唯一
  mutation，error / isPending 全局可见），Zod schema 与角色路由跳转仍留在
  `views/auth/LoginView.vue`（视图层关注点，不进 store）。http.ts 拦截器通过
  CustomEvent `auth:tokens-refreshed` 与 store 解耦（拦截器不反向 import store，避免
  循环依赖；store setup 回调里挂 listener）。API 形态：标量 getter（isAuthenticated /
  menus / activeShelfId / boundShelves / isWildcardShelfAccount / isDummyAuthActive /
  user / token）走 computed 属性不带括号；函数式 getter（hasRole / hasMenuCode /
  canOperateShelf / getAuthHeader）保留调用形态 `auth.hasRole('X')`。store proxy 自动
  解包嵌套 ref（`auth.user` 是 `CurrentUser | null`，不是 `Ref<...>`），consumer 写
  `auth.xxx` 不写 `.value`。**消费侧禁止解构 store**（沿 `usePartsListStore` 不变量
  #3）—— 一律 `const auth = useAuthStore(); auth.xxx` 访问，否则丢失响应式。
  `refreshOrLogout(router)` 接收 router 参数（store 不 import vue-router，避免循环依赖）。
  mutation 全局 retry: 0 见上文 TanStack Query 约定，store 内不写 retry。

## 已知风险

- 依赖 `xlsx@0.18.5` 有原型污染 + ReDoS 高危漏洞（npm 官方无修复版本）。仅用于内部只读 Excel 解析（4 个 parser + 2 个视图统一收口，不执行公式/宏），攻击面可控。2026-08-21 决策保留，后续迁 SheetJS CDN 版或 exceljs。详见 [`docs/08-known-risks/dependency-risks.md`](./docs/08-known-risks/dependency-risks.md)。
