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
- **TanStack Query 数据获取架构（2026-09-26）**（2026-09-26 新增）：本轮 TanStack Query 化的硬约束。覆盖两层架构（共享基础数据层 + 页面 store）、queryKey 工厂、Zod 守门、reactive params、enabled 闸门、fetchList 别名、mutation 范本、ElMessage 错误桥接、简单 vs 复杂页面判别。

  1. **两层数据获取架构**
     - **共享基础数据层**（`src/composables/queries/`）：useQuery + `staleTime` / `gcTime` Infinity + 写操作精确失效；全仓唯一 queryKey 来源走 `qk.xxx`。当前覆盖：`useCustomersQuery` / `useProcessesQuery` / `useCustomerTree`（内部转 `useCustomersQuery`，对外 `load()` API 兼容）。
     - **页面级 store**（`src/views/<域>/<页>/composables/useXxxStore.ts`，如 `usePartsListStore`）：沿用 4 不变量（首调 / onBeforeUnmount `$dispose` / 禁解构 / 不 import vue-router）；持有私有状态（分页 / 筛选 / 勾选 / 对话框）+ 内部 useQuery 列表 + useMutation 写操作 + invalidate 失效同域。
  2. **queryKey 工厂（`src/composables/queries/keys.ts`）**
     - 全仓唯一来源：`qk.customersList` / `qk.customersPrefix` / `qk.processesOptions(params)` / `qk.processesList(params)` / `qk.processesPrefix` / `qk.partsList(params)` / `qk.partsPrefix`，as const 锁字面量类型。
     - **禁止在调用点拼字面量数组**——键类型漂移会让 `invalidateQueries` 精确失效失效。
     - `<域>Prefix` 用于 `invalidateQueries({ queryKey: qk.<域>Prefix })` 前缀失效，覆盖域内任意 params 形态的 list；具体 list 键（`customersList` / `processesList(params)` / `partsList(params)`）用于 cache identity。
  3. **基础数据精确失效策略**
     - `staleTime: Number.POSITIVE_INFINITY` + `gcTime: Number.POSITIVE_INFINITY`（会话级缓存，KB 级基础数据不再主动失效）。
     - 失效责任完全在写操作侧：每个写 mutation 的 `onSuccess` 必须调 `<域>Prefix` 的 `invalidateQueries`（走 `invalidateCustomersQuery(qc)` / `invalidateProcessesQuery(qc)` 薄封装，返回 `Promise<void>`）。
     - **此策略仅在「写操作点全集中在某个页面 / 切片」时安全**（如 customers 写点全在 `CustomerList.vue`、processes 写点全在 `ProcessTab.vue`，2026-09-26 grep 确认）。新增写操作点必须同步挂失效，否则缓存与 DB 长期不一致。
  4. **queryFn Zod 校验（`src/composables/queries/schemas.ts`）**
     - 所有共享 useQuery 的 queryFn 必须 `xxxListResultSchema.parse(await xxxAPI())`——守住后端契约漂移。
     - schemas 与后端契约对齐（后端文档在 `~/Code/hsh-erp-rust/docs/api/`，如 `customers.md:142-153` CustomerOut 8 字段、`production/processes.md:159-173` ProcessOut 11 字段）。
     - **Zod 默认 strip 模式会让缺字段静默丢弃，必填字段必须显式声明**（首轮 review M-1：`customerSchema` 漏列 `version` / `created_at` / `updated_at` 会让整份校验形同虚设——`schemas.spec.ts` S4 系列用例是该 regression 的核心 guard）。
     - 链式顺序 trim 在前（沿 2026-09-24 Zod schema-first 约定）。
  5. **reactive params 模式**
     - useQuery 入参 `params` 必须是 `MaybeRefOrGetter<T>`（不是 snapshot 后的 plain object）。
     - `queryKey: computed(() => qk.xxx(toValue(params)))`，依赖变化自动 refetch。
     - `queryFn: async ({ queryKey }) => parseList(await apiFn(queryKey[2]))`——从 queryKey 读最新 params，避免闭包捕获 stale（首轮 review B-1 即此问题）。
     - 范本：`usePartsListQuery.ts:296-304`、`useProcessesQuery.ts:30-36`。
  6. **enabled 闸门（restore 模式）**
     - 页面 store 内 useQuery 默认 `enabled=false`（`restored = ref(false)`），`restoreState()` 末尾 `restored.value = true` 开闸。
     - 避免「store 实例化即用默认参数自动 fetch + restoreState 后用持久化参数又 fetch」的双 fetch——见 `usePartsListQuery.ts:165-166, 438-496`。
     - 与 `useCustomersQuery` 区别：customers 所有 caller 都是 setup 顶层立即消费 data，无闸门；parts list caller 要等路由守卫 + URL `?status=` + localStorage 恢复完才允许 fetch。
  7. **fetchList 别名（过渡期兼容）**
     - 页面 store 主查询暴露 `fetchList(): Promise<void>` 别名 = `useQuery.refetch` 的 async 包装。
     - 让外部调用方（`PartsList.vue` 的 `PurchaseOrderImportDialog @success="store.query.fetchList"`、子组件 emit、测试 `await q.fetchList()`）零改动可用。
     - 测试也通过 fetchList 驱动，无需为新 API 写新 fixture。
  8. **mutation 范本**
     - 不写 `retry`（信任 `src/main.ts` 全局 `mutations.retry: 0`）。
     - `mutationKey: ['<域>', '<action>']` 三层数组。
     - 写 mutation 的 `onSuccess` 必须失效对应域（`invalidateQueries({ queryKey: qk.<域>Prefix })` 或精确）；行内编辑类 mutation `onSuccess` 仍可走就地回填（`Object.assign(row, ...)`）不整表刷新，仅乐观锁冲突（`code === 40901` `BIZ_VERSION_CONFLICT`）走 `invalidateQueries`——见 `usePartInlineEdit.ts:178-208`。

       ```ts
       const createMutation = useMutation({
         mutationKey: ['customers', 'create'],
         mutationFn: (payload: Parameters<typeof createCustomer>[0]) => createCustomer(payload),
         onSuccess: async () => {
           await invalidateCustomersQuery(qc);
           ElMessage.success('客户已创建');
         },
         onError: (e: Error) => ElMessage.error(e.message ?? '保存失败'),
       });
       ```
     - 范本：`src/stores/auth.ts:132`（login mutation，单纯 onSuccess 不挂 invalidate）、`src/views/parts/new/composables/usePartBatchManual.ts:892`（批量录入 mutation，部分失败 / 成功跳转 / ElMessage 放 onSuccess / onError）。
  9. **ElMessage 错误桥接**
     - useQuery 的 error 不在 setup 抛错，走 `watch(error, (e) => e && ElMessage.error(...))` 桥接（替代原 `fetchList catch` 内 ElMessage 路径，`usePartsListQuery.ts:334-336`）。
     - 测试环境用 `vi.mock('element-plus', () => ({ ElMessage: { ...vi.fn() } }))` 桩成 no-op，避免 vitest node env `ElMessage` 内部 `normalizeAppendTo` 触发 `ReferenceError: document is not defined` 污染输出。
  10. **简单页面 vs 复杂页面**
      - **简单页面**（一个列表 + 一些筛选，如 `ApplicantList.vue` / `DeliveryNoteList.vue` / `DeliveryNoteScan.vue` / `OutsourceSendReceive.vue` / `PartBatchNew.vue`）：直接在 `<script setup>` 内消费共享 query composable（`useCustomersQuery()` 等），不强建 store。
      - **复杂页面**（多切片、强耦合状态，如 `PartsList`）：建页面 store（`usePartsListStore`），内部 useQuery + useMutation + invalidate 失效。
      - 区分标准：是否需要跨切片共享状态 / 是否需要 `$dispose` 防泄漏 / 是否需要 4 不变量约束。
- **composable 归属判别（2026-09-27 新增）**：`src/composables/` 仅放跨 ≥3 个顶层域（applicants / assemblies / auth / cnc / customers / dashboard / delivery / delivery-dispatch / inspection / outsource / parts / production / repair / scan / shelves / statistics / users / workers 等）的全局共享 composable。单域 composable 一律就近放到 `views/<域>/composables/`（view 级）或 `components/<域>/`（组件级）。判别标准：在仓内 `rg -l` 统计**排除 composables/ 自身**的 import 引用文件数，跨 ≥3 个顶层域才留全局；只有 1 个域时即便文件很大（如 `useWorkerQueue` 433 行、`useUploadSession` 411 行）也下沉。spec 文件与源文件保持同级 `__tests__/` 目录。

## 已知风险

- 依赖 `xlsx@0.18.5` 有原型污染 + ReDoS 高危漏洞（npm 官方无修复版本）。仅用于内部只读 Excel 解析（4 个 parser + 2 个视图统一收口，不执行公式/宏），攻击面可控。2026-08-21 决策保留，后续迁 SheetJS CDN 版或 exceljs。详见 [`docs/08-known-risks/dependency-risks.md`](./docs/08-known-risks/dependency-risks.md)。
