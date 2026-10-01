# CLAUDE.md

myERP 工厂管理系统前端：Vite 8 + Vue 3 + TypeScript + Element Plus。

## API 文档路径

后端主仓已迁到 `~/Code/hsh-erp/backend-rust`（Rust + axum + sqlx）。所有后端契约一律维护在 `~/Code/hsh-erp/backend-rust/docs/api/`（按域切分：`auth.md` / `users.md` / `delivery-notes.md` / `delivery-groups.md` / `websocket.md` / `index.md` 通用约定）。需要查后端接口时直接 `Read` 对应文件，不要翻 `src/modules/*` 源码反推。

**2026-10-02 域拆分：货架↔工序映射归 prod 域**。后端把 `t_shelf_process` 从 `src/modules/shelf/process_mapping/` 搬到 `src/modules/prod/shelf_process/`，3 个端点 URL **硬切、无 alias**（旧路由已从 `src/modules/shelf/handler.rs` 删除）：

| 前端函数（`src/api/shelves.ts`） | 新路径 | 旧路径（已死） |
|---|---|---|
| `getShelfProcesses(id)` | `GET /api/v2/prod/shelf-processes/{shelf_id}` | `GET /api/v2/shelves/{id}/processes` → 404 |
| `setShelfProcesses(id, payload)` | `POST /api/v2/prod/shelf-processes/{shelf_id}` | `POST /api/v2/shelves/{id}/processes` → 404 |
| `getAllShelfProcessMappings()` | `GET /api/v2/prod/shelf-processes` | `GET /api/v2/shelves/processes` → **400 且响应体不是 `R` 信封**（落进 shelf 域 `/{id}` 路由，`processes` 解析不成 i64 被 axum `Path<i64>` 拒掉，返纯文本） |

请求 / 响应契约**逐字不变**。**货架 CRUD 仍在 `/api/v2/shelves/*`**（未被搬动，`src/api/shelves.ts` 的 4 个 CRUD + 2 个 picker 端点不变）。契约文档：`~/Code/hsh-erp/backend-rust/docs/api/production/shelf-process-mapping.md`（含「前端配套改动清单」一节）；货架 CRUD 文档仍在 `~/Code/hsh-erp/backend-rust/docs/api/shelves.md`。

> 3 个映射函数**刻意留在 `src/api/shelves.ts`**，不新建 `src/api/prod/` 子目录：本仓 `src/api/` 按**前端实体扁平放置**、不按后端模块分层（`api/process.ts` → `/prod/processes`、`api/workType.ts` → `/prod/work-types`、`api/workerPool.ts` → `/prod/pool/*`、`api/pendingBatches.ts` → `/prod/batches/pending` 全在扁平文件里；`src/api/` 下子目录只有 `com/` / `files/` / `parts/`，**没有** `prod/`）。`src/types/shelf.ts` 里 `ShelfProcessMappingItem` / `AllShelfProcessMappingItem` / `ShelfProcessesResult` / `SetShelfProcessesPayload` 同理留在原处（按货架实体归类）。

## 主题色

藏青 `#1e4d8b` / 蓝 `#2c6cb8` / 浅蓝 `#4a8fd6`，覆盖在 `src/styles/variables.scss` 的 `:root` 块里。

## 约定

- 代码注释、commit message、文档一律中文。
- 注释里带日期戳（如 `2026-08-26 新增`）说明变更缘由是本仓库的通行做法。
- 包管理器统一使用 **npm**（锁文件 `package-lock.json`，无 pnpm/yarn 锁文件）。子模块内 `npm install` / `npm run dev` / `npm run build` / `npm test` 一律走 npm，不要切到 pnpm/yarn（避免 lockfile 与 CI/Docker 镜像构建漂移）。

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
     - **共享基础数据层**（`src/composables/queries/`）：useQuery + 有限 `staleTime` / `gcTime`（取值见下方「缓存时长策略」条目）+ 写操作显式失效；全仓唯一 queryKey 来源走 `qk.xxx`。当前覆盖：`useCustomersQuery` / `useProcessesQuery` / `usePendingBatchesQuery` / `useWorkerPoolCountsQuery` / `useWorkerPoolByProcessQuery` / `useWorkerStateByWorkerQuery`，以及内部转 `useCustomersQuery` 的 `src/composables/useCustomerTree.ts`（对外 API 保持兼容）。
     - **页面级 store**（`src/views/<域>/<页>/composables/useXxxStore.ts`，如 `usePartsListStore`）：沿用 4 不变量（首调 / onBeforeUnmount `$dispose` / 禁解构 / 不 import vue-router）；持有私有状态（分页 / 筛选 / 勾选 / 对话框）+ 内部 useQuery 列表 + useMutation 写操作 + invalidate 失效同域。
  2. **queryKey 工厂（`src/composables/queries/keys.ts`）**
     - 全仓唯一来源：`qk.customersList` / `qk.customersPrefix` / `qk.processesOptions(params)` / `qk.processesList(params)` / `qk.processesPrefix` / `qk.partsList(params)` / `qk.partsPrefix`，as const 锁字面量类型。
     - **禁止在调用点拼字面量数组**——键类型漂移会让 `invalidateQueries` 精确失效失效。
     - `<域>Prefix` 用于 `invalidateQueries({ queryKey: qk.<域>Prefix })` 前缀失效，覆盖域内任意 params 形态的 list；具体 list 键（`customersList` / `processesList(params)` / `partsList(params)`）用于 cache identity。
  3. **写操作显式失效（优化，非一致性保证）**
     - 缓存时长取值与定位见下方「TanStack Query 缓存时长策略」条目；本条只讲失效调用点。
     - 每个写 mutation 的 `onSuccess` **应**调 `<域>Prefix` 的 `invalidateQueries`（走 `invalidateCustomersQuery(qc)` / `invalidateProcessesQuery(qc)` 等薄封装，返回 `Promise<void>`）—— 效果是「写完立即看到自己那笔」。
     - ⚠️ **这不构成一致性保证，也不再要求穷举全仓写点**。2026-09-30 前的旧表述（「失效责任完全在写操作侧」「此策略仅在写操作点全集中时安全，新增写点必须挂失效」）已被推翻：生产队列域实际有 4 类跨页面写操作会改候选池成员资格（送检 / worker-scan RETURNED / scan-inspect / outsource 收发），补齐它们的失效等于把维护者绑在不可持续的穷举义务上。
  4. **queryFn Zod 校验（`src/composables/queries/schemas.ts`）**
     - 所有共享 useQuery 的 queryFn 必须 `xxxListResultSchema.parse(await xxxAPI())`——守住后端契约漂移。
     - schemas 与后端契约对齐（后端文档在 `~/Code/hsh-erp/backend-rust/docs/api/`，如 `customers.md:142-153` CustomerOut 8 字段、`production/processes.md:159-173` ProcessOut 11 字段）。
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
     - 写 mutation 的 `onSuccess` 应失效对应域（`invalidateQueries({ queryKey: qk.<域>Prefix })` 或精确）——「写完立即看到自己那笔」的优化，非一致性保证（见「缓存时长策略」条目）；行内编辑类 mutation `onSuccess` 仍可走就地回填（`Object.assign(row, ...)`）不整表刷新，仅乐观锁冲突（`code === 40901` `BIZ_VERSION_CONFLICT`）走 `invalidateQueries`——见 `usePartInlineEdit.ts:178-208`。

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
- **TanStack Query 缓存时长策略（2026-09-30 起）**：TanStack Query 在本仓的定位降级为「**短时请求去重层**」，**不承担数据新鲜度保证**。这一条与上条「TanStack Query 数据获取架构」的关系：架构条目里的 queryKey 工厂 / Zod 守门 / reactive params / enabled 闸门 / fetchList 别名 / mutation 范本 / ElMessage 桥接全部继续有效，**只有**缓存时长与「失效保证一致性」这一假设被本条取代。
   - **共享基础数据层**（`src/composables/queries/`）一律用**有限的** `staleTime` / `gcTime`，**不再用 `POSITIVE_INFINITY`**。当前统一取值 `staleTime: 30_000`（30s 短时去重窗口）/ `gcTime: 5 * 60 * 1000`（空闲缓存保留，必须 `>= staleTime`）：30s 内切 tab / 切日期 / 反复进详情命中缓存不重发；超 30s 的访问自动 refetch。覆盖 `useCustomersQuery` / `useProcessesQuery` / `usePendingBatchesQuery` / `useWorkerPoolCountsQuery` / `useWorkerPoolByProcessQuery` / `useWorkerStateByWorkerQuery`。
   - 选 30s 的依据：用户操作间隔（送检 → 切回队列页）通常 > 1min，必触发自动 refetch；同页内切 tab 是秒级，30s 足以去重。对照仓内两套先例——`useDashboardUpcomingList.ts:80` 的 `staleTime: 30_000`（措辞框架最接近本策略）被采纳为基准；`usePartBatchesQuery` / `usePartFilesListQuery` 的 20min / 30min 是**派生视图域**特例（图纸/3D 几乎不变），不适合会被生产流转改动的候选池 / 工序 / 客户基础数据。
   - **跨页面写操作不再使用「精确失效」策略**：会改变工序候选池成员资格的流转端点（送检 `POST /parts/batch-to-inspection`、worker-scan `RETURNED`、scan-inspect、outsource 收发）分布在 delivery / scan / inspection / outsource 多个域，要求在每个写点补失效等于穷举全仓写点，不可持续，因此**不做**这类补齐。数据新鲜度由 **WS 事件**或**显式 refetch**（如 `WorkerQueueBoard.onRefresh`）负责。
   - **现有 `invalidateQueries` 调用点全部保留、一行不删**：它们是「写完立即看到自己那笔」的优化，不是一致性保证。降级的是「依赖精确失效来保证一致性」这个**假设**，不是失效机制本身。
   - 页面级 store（`usePartsListStore` 等）走 `src/main.ts` 全局默认，**不在本条约束范围**；`views/dashboard/` 下的 WS 事件失效域 query 同理，沿用各自既有取值。
- **图表统一 vue-echarts 8.3（2026-09-30 起硬约束）**：仓内所有 ECharts 相关业务组件必须走 `vue-echarts`（peer deps `vue@^3.3.0` / `echarts@^6.0.0` 与本仓 `vue@^3.4.0` / `echarts@^6.1.0` 兼容）。模块化注册统一在 `src/plugins/echarts.ts`（按需 `echarts.use([BarChart, ..., CanvasRenderer])` + `import 'echarts/theme/v5'` 锁旧主题，避免拉全量 ~900KB bundle）；`main.ts` 通过 `app.component('VChart', VChart)` 全局注册，业务 SFC 直接写 `<v-chart :option="..." @click="onClick" />`。**禁止**在业务组件内 `import * as echarts from 'echarts/core'`（值导入）+ `echarts.init(el, 'v5', { renderer: 'canvas' })` + ResizeObserver + dispose 自写 mount 生命周期（2026-09-30 重构前 `UpcomingDeliveryChart.vue` 即此模式，已迁出）；**type-only import 不受限**（`import type { ECElementEvent, EChartsCoreOption } from 'echarts/core'` 是合法的，类型擦除不进 bundle）；历史兜底壳 `src/components/EChart.vue` 仅作为 option 全量替换薄壳，不在新代码中扩展其用法。

## 已知风险

- 依赖 `xlsx@0.18.5` 有原型污染 + ReDoS 高危漏洞（npm 官方无修复版本）。仅用于内部只读 Excel 解析（4 个 parser + 2 个视图统一收口，不执行公式/宏），攻击面可控。2026-08-21 决策保留，后续迁 SheetJS CDN 版或 exceljs。详见 [`docs/08-known-risks/dependency-risks.md`](./docs/08-known-risks/dependency-risks.md)。
