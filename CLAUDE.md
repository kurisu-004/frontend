# CLAUDE.md

myERP 工厂管理系统前端：Vite 8 + Vue 3 + TypeScript + Element Plus。

## API 文档路径

后端主仓在 `~/Code/hsh-erp/backend-rust`（Rust + axum + sqlx）。所有后端契约维护在 `~/Code/hsh-erp/backend-rust/docs/api/`（按域切分：`auth.md` / `users.md` / `delivery-notes.md` / `delivery-groups.md` / `websocket.md` / `index.md` 通用约定）。需要查后端接口时直接 `Read` 对应文件，不要翻后端源码反推。

## 主题色

藏青 `#1e4d8b` / 蓝 `#2c6cb8` / 浅蓝 `#4a8fd6`，定义在 `src/styles/variables.scss` 的 `:root` 块。

## 约定

- 代码注释、commit message、文档一律中文。
- 注释里带日期戳（如 `2026-10-02 新增`）说明变更缘由。
- 包管理器统一用 **npm**（锁文件 `package-lock.json`），不要切 pnpm/yarn（避免与 CI/Docker 构建漂移）。
- 注释与文档只写**当前**行为与取舍，不记录历史方案对比、被推翻的旧表述、review 编号或行号（行号必然过期）。

## 架构约定（硬约束）

### TanStack Query

`QueryClient` 在 `src/main.ts` 注册（pinia 之后、mount 之前），全局 `mutations.retry: 0` / `queries.retry: 0` / `queries.refetchOnWindowFocus: false`。**新增 mutation 不写 `retry`**，信任全局默认。`app.use(VueQueryPlugin)` 必须早于任何 store 实例化。

两层数据获取：

- **共享基础数据层** `src/composables/queries/`：`staleTime: 30_000` / `gcTime: 5 * 60 * 1000`（有限值，禁 `POSITIVE_INFINITY`）。
- **页面级 store** `src/views/<域>/<页>/composables/useXxxStore.ts`：沿用 4 不变量（首调 / `onBeforeUnmount` `$dispose` / 禁解构 / 不 import vue-router），内部持有分页筛选勾选 + useQuery + useMutation。

模式：

- **queryKey 工厂** `src/composables/queries/keys.ts` 是全仓唯一来源（`qk.customersList` / `qk.processesList(params)` / `<域>Prefix` …）。**禁止在调用点拼字面量数组**。`<域>Prefix` 用于前缀失效。
- **reactive params**：入参 `MaybeRefOrGetter<T>`，`queryKey: computed(() => qk.xxx(toValue(params)))`，`queryFn` 从 `queryKey` 读 params（不闭包捕获 stale）。
- **queryFn Zod 守门**：`xxxListResultSchema.parse(await xxxAPI())`。Zod 默认 strip 会静默丢缺字段，**必填字段必须显式声明**。
- **enabled 闸门**：页面 store 内 useQuery 默认 `enabled=false`，`restoreState()` 末尾开闸，避免双 fetch。
- **fetchList 别名**：主查询暴露 `fetchList(): Promise<void>` = `refetch` 的 async 包装，供外部调用方与测试零改动驱动。
- **mutation 范本**：`mutationKey: ['<域>', '<action>']`；`onSuccess` 失效对应域 + ElMessage.success，`onError` 走 ElMessage.error。

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

- **ElMessage 错误桥接**：useQuery 的 error 走 `watch(error, (e) => e && ElMessage.error(...))`，不在 setup 抛错。测试用 `vi.mock('element-plus', () => ({ ElMessage: { ...vi.fn() } }))` 桩成 no-op（node env 下真实 ElMessage 会因 `document is not defined` 污染输出）。

**缓存定位**：TanStack Query 在本仓只是**短时请求去重层，不承担数据新鲜度保证**。跨页面写操作（送检 / worker-scan / scan-inspect / outsource 等改候选池成员资格的流转）**不做精确失效补齐**（穷举写点不可持续）；数据新鲜度靠 WS 事件或显式 refetch。现有 `invalidateQueries` 调用点是「写完立即看到自己那笔」的优化，全部保留。

**唯一例外**：`views/dashboard/composables/` 下 4 个 query（snapshot / urgentList / overdue / upcomingList）用 `gcTime: POSITIVE_INFINITY`（靠 WS 事件失效，不靠 GC），因此**跨账号泄漏窗口无限大**，只靠 auth 会话终止时的 `queryClient.clear()` 兜底。改它们的 gcTime 前先看 auth 一节。

### Zod schema-first

表单类 schema 写在 `src/views/<域>/<表单>Schema.ts`，导出 schema + `z.infer` 类型；链式顺序 trim 在前；错误聚合用同文件内的 `toFieldErrors`。

### auth / 会话

`src/stores/auth.ts`（Pinia setup store）是 auth 唯一状态源：user / token / menus / roles / shelf scope / dummy 标记。

- **消费侧禁止解构 store**：一律 `const auth = useAuthStore(); auth.xxx`（store proxy 已自动解包 ref）。标量 getter 不带括号（`auth.isAuthenticated`），函数式 getter 带括号（`auth.hasRole('X')`）。
- **store 不 import `vue-router`**：`refreshOrLogout(router)` / `forceLogout(router)` 收 router 参数，由 app 层注入导航。
- **`user.value` 只在 `setUser()` 里赋值**（并由它切 tagsView 归属）；`isDummyAuthActive` 的复位点只在 `teardownSession()`。
- **`useQueryClient()` 必须在 store setup 第一行捕获**，不能挪进 action / listener 惰性取（Pinia 不给 action wrapper 注入上下文，`useQueryClient` 会抛）。⇒ 任何实例化 auth store 的 spec 必须 `app.use(VueQueryPlugin)` + 传一个 `QueryClient`。

**会话终止收口 `teardownSession()`**（store 内无 router 参数的私有函数）：清 token / refreshToken / user（经 `setUser(null)`）/ `isDummyAuthActive`、删 `auth_session`、派发 `auth:session-changed(token: null)`、`queryClient.clear()`。**所有会话终止路径必须汇到它，不得另起炉灶**：

| 入口 | 触发源 | 导航 |
|---|---|---|
| `logout()` | 用户点「退出」（先 `await apiLogout()`） | 无（调用方负责） |
| `forceLogout(router)` | `auth:session-lost` ← dashboard WS 关闭码 `4001` | `router.replace('/login')` |
| `refreshOrLogout(router)` catch | 路由守卫 `/iam/me` 校验失败 | 委托 `forceLogout(router)` |
| `auth:logout` 事件订阅 | `src/api/http.ts`（40105 SESSION_REVOKED / refresh 失败） | 无 |

`teardownSession()` = 纯收口；`forceLogout(router)` = 收口 + 追加一次导航；两者都**不联系后端**。`refreshOrLogout` 只用于路由守卫的「未登录但可能有 session」恢复路径。

守卫侧拿到 `refreshOrLogout` 的 false 后必须 `next(false)` **取消**导航（不要 `next('/login')` 再跳一次）—— 守卫是 3 参签名，3 参守卫里「什么都不调」= 导航永久挂起。

**`queryClient.clear()` 是跨账号缓存隔离的唯一手段**：全仓 queryKey 都没有 user 维度而 `QueryClient` 是单例，不清则 A 账号按 `can_access_shelf` 收窄的缓存会零请求直喂 B 账号。`clear()` 自带 silent 的 in-flight 取消，**禁止**再叠 `cancelQueries()`（非 silent 会触发 `watch(error) → ElMessage.error`，登出瞬间刷一屏假错误）。

**`auth:logout` 事件**：派发方在 `src/api/http.ts` 拦截器；订阅方两处、职责不同 —— `src/main.ts` 只负责 `router.replace('/login')`，`src/stores/auth.ts` 调 `teardownSession()` 清状态 + 清缓存。

**auth ↔ WS 事件通道**（均为 `CustomEvent`，避免 `auth ↔ api` 循环依赖）：

| 事件 | 方向 | 语义 |
|---|---|---|
| `auth:session-changed` | auth → WS（`src/api/dashboard.ts`） | `detail.token` 为 string = 重连，为 null = 断开 |
| `auth:session-lost` | WS → auth（接收方是 `src/router/index.ts`） | 后端判定会话已死，接收方调 `auth.forceLogout(router)` |

`auth:session-changed` 的派发点共 3 处，必须覆盖全部 token 生命周期转换：`http.ts` 的 `persistTokens()`（刷新）、`loginMutation.onSuccess`（登录）、`teardownSession()`（终止）。**新增改变 token 生命周期的写点时必须同步补派发**，否则控制台会无限刷 WS 报错。`auth:tokens-refreshed` 是另一件事（管 store 自身 state 同步），两者不要混淆。

### tagsView per-user 持久化

`src/stores/tagsView.ts` 自管 localStorage，key 为 `myerp.tags_view.<userId>`：同账号重登恢复标签栏，换账号互不可见。归属切换唯一入口 `switchOwner(userId)`，由 auth 的 `setUser()` 驱动；登出走 `switchOwner(null)`（只清内存、**不写盘**）。**store 初始化不读 localStorage**，hydrate 只由 `switchOwner` 触发。`pinia-plugin-persistedstate` 已卸载（它的 key 入参是 storeId，做不到 per-user 隔离）。

### dashboard WS 单例

`src/api/dashboard.ts` 是全仓唯一 WS 入口（`createGlobalState` + VueUse `useWebSocket`），承载 `/ws/dashboard?token=<jwt>`。

- **URL 用模块级 `shallowRef<string | undefined>` + 显式 `syncWsUrl()`，不用 `computed`**（computed 会缓存住旧 token，logout→重登后仍握吊销 token → `40105` 死循环）。
- **`undefined` 是「无 token 不要连」的哨兵**。禁止无 token 时拿裸 URL 握手（后端必回 `40100`，是无意义重试刷屏的来源）。
- **重试不封顶**（`retries: -1`，退避 1s→10s 封顶），失败日志前 3 次完整诊断、之后每 30 次一行。WS 是 dashboard 唯一更新通道，封顶重试会让页面静默停更。诊断输出：脱敏 URL（`token=***`）/ closeCode + reason / hadErrorEvent / tokenExpired。
- **关闭码分流**（语义表权威来源是后端 `docs/api/websocket.md`）：`1000` / `1001` / `1006` / `1011` / `1012` → 继续无限重试；`4001`（会话在连接期间失效）→ **停重连 + 清 session + 走登出**；`4003`（慢消费方丢了 n 条事件）→ 继续重试 **+ 派发 `dashboard:full-refetch` 立即全量 invalidate**（该事件由 `views/dashboard/composables/useDashboardInvalidation.ts` 接收；必须走立即路径而非 500ms 防抖，且重连首帧 snapshot 在 `dispatch()` 里被 no-op 丢弃、Query 无轮询，丢的事件没有补偿通道）。
- **分层禁令**：WS 层**禁止** import `stores/auth`、`vue-router`、`@tanstack/vue-query`，全部走 CustomEvent 解耦。
- **`4001` 只在已建立的连接上有效**，握手阶段的鉴权失败只会表现为 `1006`（后端 upgrade 前直接回 HTTP `401`，浏览器 WS API 不暴露握手期 status）。所以会话真死的最终兜底是 HTTP 侧 `40105 → auth:logout`，不是 WS 侧的 `4001`；也**不要**加「握手失败几次就登出」的启发式，那会把代理 / 后端故障误判成会话失效。
- **dev 环境必须有 `/ws` 反代**（`vite.config.ts` `server.proxy`）。Vite 8 的 dev upgrade 监听器只对匹配到的 proxy context 转发，缺了表现为「页面数据正常但控制台一直刷 WS 报错」。生产 / 预发由 nginx 的 `location ^~ /ws/` 负责。

### 图表

业务组件一律走 `vue-echarts`（`app.component('VChart', VChart)` 全局注册），模块化注册统一在 `src/plugins/echarts.ts`。**禁止**在业务组件内值导入 `echarts/core` + `echarts.init()` + 自写 ResizeObserver / dispose 生命周期（type-only import 不受限）。`src/components/EChart.vue` 是历史兜底薄壳，不在新增代码中使用。

### 共享批次卡片

`src/components/BatchCard.vue` 是全仓唯一的批次卡片（200×96 固定盒），消费方：生产队列的工序候选池 / 工人列 / 待下发池，外协发送接收看板的候选池 / 外协公司列。**局部 import**（与 `PagedTable` / `ColumnVisibilityPopover` 同风格），不进 `main.ts` 全局注册。view-model 是 `src/types/batchCard.ts` 的 `BatchCardModel`（局部 import，不属 `types/workerPool.ts`）。

- **DTO 差异只能在适配层消化，组件零 `api/*` 依赖。** 三个 wire DTO 各自经 `views/production/composables/poolItemToCard.ts`（`poolItemToCard` / `heldToCard` / `pendingBatchToCard`）或 `views/outsource/composables/outsourceItemToCard.ts` 转成本类型；**适配层各域自持，不要为了对称集中到共享目录**。
- **改尺寸 / body 行数会同时影响全部消费方。** 200×96 是硬预算：body 恒 4 行 × 18px 行高（4×18 + 3×2 gap + 上下各 8 padding + 上下各 1px 边框 = 96px，无余量），长文本一律 ellipsis 不换行。**新信息只能进 tooltip，不得加第 5 行。**
- `BatchCardModel` 的两类扩展字段性质不同：`version?: number` 是 `t_part_batch` 的一列、**非领域概念**故在顶层（外协收发的 OCC 锚）；`extra?: BatchCardExtra` 是**单域扩展槽**、只进 tooltip（外协公司 / 工序 / 单价 / 发出时间 / 接收可免填性）。新增域信息优先走 `extra`，别往顶层堆领域字段。
- `PendingPoolCard.vue` 是**工序投放卡**（不是批次卡），只是盒模型与 BatchCard 对齐，刻意保持独立、不合并。

### 拖拽投放（Sortable）

看板类页面的跨容器拖拽用 `vue-draggable-plus`。两条已踩过的坑：

- **投放容器一律用二参重载** `useDraggable(el, options)`，**不传 list**。传 list 会挂上库的内建 handler（`list.value.splice(...)`），而库假定 list 就是渲染源 ⇒ Sortable 改的数组与 Vue 渲染的数组不同源。容器在 `v-if` 内时用 `src/composables/useLazyDraggable.ts`（它把首次绑定延后到 el ref 解析之后，并强制 `immediate: false`）。
- **不传 list 就必须自己补 `onRemove` 做 DOM 回滚。** 内建 handler 的第一句是 `from.insertBefore(item, from.children[oldIndex])`（把 Sortable 搬过的节点放回源容器），改二参后这层消失；而 **`invalidate` 补不回来** —— 投放失败时源/落点两侧 query 数据都没变，Vue 的 keyed diff 只 `patchElement`，永远不会删一个不在 vdom 里的外来节点 ⇒ 失败后卡片永久留在错误列并累积。用 `dndSourceTracker.ts` 的 `restoreNodeToSource`。同时加 `sort: false` 关掉容器内重排（该选项只在「落点实例 === 拖拽起点实例」时被读，跨实例投放走 group 的 checkPull/checkPut，不受影响）。
- **Sortable 容器的直接子元素必须全是可拖项**（混入 header / 空态会让 `oldIndex` 与可拖项下标错位）。空态用**兄弟覆盖层**（`position:absolute; inset:0; pointer-events:none`）承载，别用 `v-if` 把容器整个摘掉 —— 空容器必须仍是合法投放目标（给空闲工人派活是主场景）。

## 已知风险

- 依赖 `xlsx@0.18.5` 有原型污染 + ReDoS 高危漏洞（npm 官方无修复版本）。仅用于内部只读 Excel 解析（parser / 视图已统一收口，不执行公式宏），攻击面可控。2026-08-21 决策保留，后续迁 SheetJS CDN 版或 exceljs。详见 [`docs/08-known-risks/dependency-risks.md`](./docs/08-known-risks/dependency-risks.md)。
