# CLAUDE.md

myERP 工厂管理系统前端：Vite 8 + Vue 3 + TypeScript + Element Plus。

## API 文档路径

后端主仓在 `~/Code/hsh-erp/backend-rust`（Rust + axum + sqlx）。后端契约的载体是**代码注释**，`docs/api/` 只对少数几个域做了整域契约文档（2026-10-10 盘点，`ls backend-rust/docs/api/` 复核）：

| 文档 | 覆盖域 |
|---|---|
| `docs/api/batch.md` | `part` 批次域 |
| `docs/api/dashboard.md` | `dashboard` 大屏聚合（3 个只读 HTTP 端点 + `/ws/dashboard` 的 WS 首帧与增量） |
| `docs/api/delivery_note.md` | `delivery_note` 送货单（列表 / 详情 / 扫码入单 / 移除批次 / 打印） |
| `docs/api/iam.md` | `iam` 认证 + 账号 + 企业微信绑定 + 货架（5 端点，§1.4） |
| `docs/api/inspection.md` | `prod::inspection` 待品检（队列列表 + 扫码三层树） |
| `docs/api/outsource.md` | 外协（报价 / 订单 / 收发货流转） |
| `docs/api/programming.md` | `prod::programming` 待编程一览 |
| `docs/api/queue.md` | `prod` 生产看板队列域 |

**其余域没有 `docs/api/` 文档**（`assembly` / `wx` / `statistics` / `files` / `cnc_program` …），契约载体是代码注释。查接口按这条路径走：

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

## 架构约定（硬约束）

### TanStack Query

`QueryClient` 在 `src/main.ts` 注册（pinia 之后、mount 之前），全局 `mutations.retry: 0` / `queries.retry: 0` / `queries.refetchOnWindowFocus: false`。**新增 mutation 不写 `retry`**，信任全局默认。`app.use(VueQueryPlugin)` 必须早于任何 store 实例化。

两层数据获取：

- **报工台（`views/production/scan/`，2026-10-10 接入）**：`composables/useScanListQuery.ts` 的 `useScanPickableQuery` / `useScanHeldQuery` + `composables/useScanWrite.ts` 的 `useScanPickUpMutation` / `useScanWorkerScanMutation`。`staleTime: 30_000` / `gcTime: 5 * 60 * 1000`（**gcTime 保持有限值** —— `POSITIVE_INFINITY` 是 dashboard 域靠 WS 事件失效才成立的例外，本域没有失效通道，GC 设无限会让「切走 5 分钟回来」命中陈旧持有件）。三条 list 与两条写共享 `qk.scanPickable` / `qk.scanHeld` 两条参数键 + 两条域前缀键（**不挂 `partsPrefix` 下**：与零件域没有共享写点，挂 parts 下会让最热的 `qk.partsPrefix` 一把全刷捎带扫码缓存）。**params 允许 `null`** ⇒ 占位键 + `enabled` 闸门 + queryFn 二次守卫（必需：过滤键后端必填、漏传是 400 纯文本）。两条 mutation 的 `onSuccess` **与 `onError`** 都失效两条前缀 —— 40901 OCC 恰恰意味着别人已把这批处置了，本端副本过期（理由同 `useQueueDispatch`）。
- **`useScanBus` 已删（2026-10-10）**：它原本只服务「提交后通知徽章刷新」，而徽章与三页共用同一条 `qk.scanHeld` 后该信号冗余。剩下的「提交成功后自动开抽屉」是**写侧信息**（invalidate 只说「数据过期了」，不说「刚刚有人提交成功」），故由徽章上的 **`autoOpenToken` 计数器 prop** 承接，不用模块级单例 —— 退而用 `watch(query.dataUpdatedAt)` 之类的数据侧近似会在暖缓存进页面时失准（缓存新鲜 ⇒ 不发请求 ⇒ 提交后那一次要么被当成「首次更新」跳过，要么在任意一次后台 refetch 上误开抽屉）。自增点放在 `await mutateAsync()` 之后（TanStack 会 await `onSuccess` 返回的 promise，此时失效链的 refetch 已 settle，抽屉打开时看到的是刷新后的列表）。
- **共享基础数据层** `src/composables/queries/`：`staleTime: 30_000` / `gcTime: 5 * 60 * 1000`（有限值，禁 `POSITIVE_INFINITY`）。
- **页面级 store** `src/views/<域>/<页>/composables/useXxxStore.ts`：沿用 4 不变量（首调 / `onBeforeUnmount` `$dispose` / 禁解构 / 不 import vue-router），内部持有分页筛选勾选 + useQuery + useMutation。**useQuery 段可外提成同域独立 query hook**（见下）。

**主查询外提成域内 query hook**：页面级 store 的 `useQuery` 段常被外提成 `src/views/<域>/<页>/composables/useXxxQuery.ts`（如 `usePendingProgrammingQuery` / `useInspectionQueueQuery`，形态范本 `useDashboardUpcoming`）：hook **无自有状态**，入参 `MaybeRefOrGetter`（params + `enabled` 闸门 + `autoRefresh` 等开关），返回 `{ query, data, isFetching, error, fetchList }` + 内部 Zod 守门 + `watch(error) → ElMessage` 桥接。外提后 store 仍保留全部页面态职责：私有状态（分页 / 筛选输入态-生效态拆分 / Tab / 对话框态）、`$dispose` 契约与**切片形态**（对外状态走 plain object slice，禁止平铺 ref 到 store 顶层）、`restoreState()` 末尾开 enabled 闸门、mutation 与失效、列定义与列可见性。query hook 与它守的 schema 同居域内（见「Zod schema-first」）。

`refetchInterval`（自动刷新）一律写 `computed(() => (autoRefresh ? 300_000 : false))` **而非裸函数**，并显式 `refetchIntervalInBackground: true`（TanStack Query 默认 false，窗口失焦会暂停轮询）。裸函数形态踩过的坑：vue-query 的 `defaultedOptions` 只在 `queryKey` 那一层对 function 求值（`unrefGetters` 仅 queryKey 为 true），裸函数体内的 `autoRefresh` 不进依赖收集 ⇒ 勾选开关不触发 `observer.setOptions` ⇒ `#updateRefetchInterval` 不重新求值 ⇒ 轮询永远不启动。

模式：

- **queryKey 工厂** `src/composables/queries/keys.ts` 是全仓唯一来源（`qk.customersList` / `qk.processesList(params)` / `<域>Prefix` …）。**禁止在调用点拼字面量数组**。`<域>Prefix` 用于前缀失效。
- **reactive params**：入参 `MaybeRefOrGetter<T>`，`queryKey: computed(() => qk.xxx(toValue(params)))`，`queryFn` 从 `queryKey` 读 params（不闭包捕获 stale）。
- **queryFn Zod 守门**：`xxxListResultSchema.parse(await xxxAPI())`。Zod 默认 strip 会静默丢缺字段，**必填字段必须显式声明**。主查询的守门点在 queryFn，**api 层函数只发请求 + 用 schema 的 `z.infer` 标注返回类型，不 parse**（parse 返回深拷贝，多一层等于每屏数据被校验并克隆两遍）；守门留在 api 层的是那些**没有 queryFn 承载**的调用（如扫码取树走 useMutation、批量写端点）。
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

**唯一例外**：`views/dashboard/composables/` 下 3 个 query（`useDashboardSnapshot` / `useDashboardUpcoming` / `useDashboardDeliveryOrders`）用 `gcTime: POSITIVE_INFINITY`（靠 WS 事件失效，不靠 GC），因此**跨账号泄漏窗口无限大**，只靠 auth 会话终止时的 `queryClient.clear()` 兜底。改它们的 gcTime 前先看 auth 一节。

### Zod schema-first

表单类 schema 写在 `src/views/<域>/<表单>Schema.ts`，导出 schema + `z.infer` 类型；链式顺序 trim 在前；错误聚合用同文件内的 `toFieldErrors`。

**域 schema 与 query hook 同居**：主查询的守门 schema 放域内 query hook 旁边（`src/views/<域>/<页>/composables/<xxx>Schema.ts`，如 `pendingProgrammingSchema.ts` / `inspectionSchema.ts` / `scanSchema.ts`），导出 `xxxSchema` + `z.infer` 派生类型（`*Data` 后缀，api 层用它标注返回类型）。`src/composables/queries/schemas.ts` 只留**跨域共用**的基础数据层 schema，域 schema 迁出时在该文件留一段**指针注释**说明去向，且**不做 re-export**（再导一层没有消费方，只会让读代码的人多一个「该 import 哪个路径」的判断）。对应用例也一并搬到域内（`views/<域>/.../__tests__/<xxx>Schema.spec.ts`）。

**守门点随分层搬家（2026-10-10，报工台先行）**：报工台原先把 `.parse()` 写在 api helper 里（`api/parts/crud.ts::listPartsHeldByWorker`），守门 schema 在全局 `composables/queries/schemas.ts`；接入 TanStack Query 后改成 **`api 层只发请求 + 类型标注（不 parse）、守门在 queryFn / mutationFn`** —— 与本文件「TanStack Query」一节的 `queryFn Zod 守门` 同款。搬家的连带收益是 api 模块不再 import 域内 schema（`api → views` 这条边只剩「无 queryFn 承载的单次拉取」一种，见下）。断言也要跟着搬：api 层那批「helper 必须在边界 reject 坏响应」的用例**不再成立**，改守「api 层不做 parse」（负向守卫，防止有人图省事把 parse 搬回去），而「parse 真的接在返回路径上」由 query hook 的 spec 守 —— 把 parse 整段删掉时 api 层 spec 全绿而线上崩。

### 目录归位

- **报工台（2026-10-10 搬进 `views/production/scan/`）**：视图与 composables 域内自持（`components/` / `composables/` / `__tests__/`），与后端 `prod::scan` 域、生产队列域同款布局。api 在 `src/api/productionScan.ts` + `productionScan.contract.ts`（两级切分，照 `productionQueue`），守门 schema 在 `views/production/scan/composables/scanSchema.ts`。**`BatchPickerDialog` 与 `chainAccent.ts` 都留在域内**（`views/production/scan/components/`）：两者都只被报工台三页消费、零跨域消费方，不满足「零个域内依赖 + 多域复用」的上提判据（`BatchCard.vue` 那种 6 个跨域消费方才配得上 `src/components/`）；`BatchPickerDialog` 还 import 了域内 `chainAccent`，上提只会造出一条 `components/ → views/` 的反向依赖。局部 import，不进 `main.ts` 全局注册。`composables/useBarcodeScanner.ts` 留在原地（com/delivery、inspection、repair、outsource、parts/list 五域共用的跨域工具）。**`useScanSession.worker` 用 4 字段的 `ScanWorkerBriefDto`、不是 `@/types/worker::Worker`**：后者是账号管理页那个 12 字段 `WorkerOut` 镜像（后端未删，仍在用），扫码链路一个额外字段都不用，沿用宽 VO 只会让消费侧以为还有 `version` / `is_active` 可读。两个 VO 在运行时都是「扫工牌拿回来的那个对象」，`ScanWorkerBrief` 的 4 个字段又是 `Worker` 的子集 ⇒ 换类型不产生任何编译期/运行时信号，回归保护见 `views/production/scan/composables/__tests__/useScanSession.spec.ts`。
- **⚠️ 报工台的路由 path 与后端 URL 不一致是有意的，且 path 不会跟着视图目录一起搬**：路由仍是 `path: 'scan/*'` / `menuCode: 'scan_badge'` —— path 是浏览器可见的书签 URL，同时是后端菜单表 `scan_badge` 节点的 `path` 字段，改它会断掉用户已收藏的链接与菜单下发；后端 URL 已是 `/api/v2/prod/scan/*`（2026-10-10 硬切）。搬目录只改 `component` 的 import 路径。**⚠️ 部署顺序：后端必须先上** —— 两条 list 的过滤键由 path 改成必填 query（漏传或发数字 → axum `QueryRejection` → **HTTP 400 纯文本**，不进 `R<T>` 信封），旧 URL 直接 404，`verify-badge` 那条更隐蔽（路径还在但 method 变了 → 405）。失败发生在网络层而不是 Zod 契约层，现场只看到一句 axios 错误，报工台三页 + 徽章同时空白。
- **域内列定义**放 `src/views/<域>/<name>ColumnDefs.ts`（域根，与页面主组件同级），**不放 `src/utils/`** —— 单域专用文件不是通用工具：它 import 域内 composable 类型会让 `utils/` 反向依赖 `views/`（层次倒挂）。
- **`src/utils/` 只放跨域通用工具**（举例，非全量清单：`fileExt` / `date` / `jwt` / `download` / `pdfjs` / `elTable` / `dndSourceTracker` / 各 `ExcelParser` / `permissions`）。判据是「零个域内依赖」+「多域复用」，不是「看起来像工具」。
- **api 层引域内 schema 的口径**：默认用 `import type`（编译期擦除，照 `api/dashboard.ts` / `api/programming.ts` / `api/parts/batch.ts`）；运行时值引入只允许出现在**没有 queryFn 承载**的守门点 —— 典型是走 useMutation 的单次拉取（`api/inspection.ts` 的扫码树 `inspectionScanTreeSchema.parse`）。这与上面「`utils/` 不得反向依赖 `views/`」是两条不同的禁令：后者禁的是**通用工具**引**单域实现**；api 层引自己域的 schema（含守门 schema 归位后的唯一运行时边 `api → views/inspection`）是允许形态。
- **货架管理（2026-10-10 迁入 iam 域）**：视图在 `src/views/iam/shelves/`，**api 仍在平铺的 `src/api/shelves.ts`** —— `src/api/` 是按前端实体扁平放置、不按后端模块分层（见 `api/shelves.ts` 文件头）。⚠️ **`views/iam/` 与 `views/users/` 的不对称是有意的、不是漏搬**：`users`（账号管理）自 v1 起就在根下，是历史遗留；货架管理是 2026-10-10 新迁的，只规定**新代码**按域进 `views/iam/`，不回头搬历史目录。看到 `views/users/` 仍平铺不必"顺手修正"。
- **前端路由 `/shelves` 与后端 URL `/api/v2/iam/shelves` 不一致是有意的**：路由 path 是浏览器可见的书签 URL，同时是后端菜单表 `shelves_list` 节点的 `path` 字段（见 `src/composables/__fixtures__/adminMenus.ts`），改它会断掉用户已收藏的链接；后端 API URL 是另一层。两者不要求一致，看到「前端 /shelves、后端 /iam/shelves」不是漏改。

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
| `forceLogout(router)` | `auth:session-lost` 且 reason 不是 `access token expired`（reason 契约见「dashboard WS 单例」小节） | `router.replace('/login')` |
| `refreshOrLogout(router)` catch | 路由守卫 `/iam/me` 校验失败，或 WS `4001` 且 reason 是 `access token expired`（尝试用 refresh token 续期） | 委托 `forceLogout(router)` |
| `auth:logout` 事件订阅 | `src/api/http.ts`（40105 SESSION_REVOKED / refresh 失败） | 无 |

`teardownSession()` = 纯收口；`forceLogout(router)` = 收口 + 追加一次导航；两者都**不联系后端**。`refreshOrLogout` 有两个消费方：路由守卫的「未登录但可能有 session」恢复路径，以及 WS `4001` 且 reason 为 `access token expired` 时的续期尝试（两种情形下它的 catch 都委托 `forceLogout`，所以「false」与「抛异常」都已经完成收口）。

守卫侧拿到 `refreshOrLogout` 的 false 后必须 `next(false)` **取消**导航（不要 `next('/login')` 再跳一次）—— 守卫是 3 参签名，3 参守卫里「什么都不调」= 导航永久挂起。

**`queryClient.clear()` 是跨账号缓存隔离的唯一手段**：全仓 queryKey 都没有 user 维度而 `QueryClient` 是单例，不清则 A 账号按 `can_access_shelf` 收窄的缓存会零请求直喂 B 账号。`clear()` 自带 silent 的 in-flight 取消，**禁止**再叠 `cancelQueries()`（非 silent 会触发 `watch(error) → ElMessage.error`，登出瞬间刷一屏假错误）。

**`auth:logout` 事件**：派发方在 `src/api/http.ts` 拦截器；订阅方两处、职责不同 —— `src/main.ts` 只负责 `router.replace('/login')`，`src/stores/auth.ts` 调 `teardownSession()` 清状态 + 清缓存。

**auth ↔ WS 事件通道**（均为 `CustomEvent`，避免 `auth ↔ api` 循环依赖）：

| 事件 | 方向 | 语义 |
|---|---|---|
| `auth:session-changed` | auth → WS（`src/api/dashboard.ts`） | `detail.token` 为 string = 重连，为 null = 断开 |
| `auth:session-lost` | WS → auth（接收方是 `src/router/index.ts`） | 后端 re-auth 失败（关闭码 `4001`），接收方按 `detail.reason` 分流：`access token expired` / `null` → `auth.refreshOrLogout(router)`（成功后再 `reconnectDashboard()` 恢复长连接），其余 → `auth.forceLogout(router)` |

`auth:session-changed` 的派发点共 3 处，必须覆盖全部 token 生命周期转换：`http.ts` 的 `persistTokens()`（刷新）、`loginMutation.onSuccess`（登录）、`teardownSession()`（终止）。**新增改变 token 生命周期的写点时必须同步补派发**，否则控制台会无限刷 WS 报错。`auth:tokens-refreshed` 是另一件事（管 store 自身 state 同步），两者不要混淆。

**token 刷新必须跨标签页互斥**（`api/http.ts` 的 `getOrCreateRefresh`，锁名 `hsh-erp:token-refresh`，Web Locks `exclusive`）：后端 refresh token **一次性轮转**，对已用过的 jti 做 reuse detection，命中就 `delete_all_user_sessions` ⇒ **该用户所有标签页 + 所有设备一起登出**。同一账号多标签页共享同一份 `localStorage.auth_session` 与同一个 exp，按 `exp − 提前量` 排期的保活定时器必然落在同一时刻，而标签页内的 `refreshPromise` 跨标签页不互斥 ⇒ 两处同时拿同一枚 refresh jti 去刷新是常规路径而非低概率竞态。所以「读 storage → 发 refresh → 写回」整段必须在锁内，且**锁内先现读 storage**：access token 剩余寿命仍大于提前量说明别的标签页刚轮转过，直接复用 storage 里那对新 token 返回、不发请求。互斥包在 `getOrCreateRefresh()` 这一层 ⇒ reactive 40102 / proactive / 保活定时器三条触发路径一并覆盖。**部署前提**：`navigator.locks` 只在安全上下文（https / localhost）可用，缺失时降级为直接执行（降级只是尽力，仍有并发窗口）—— `nginx.conf` 同时 `listen 80` 与 `listen 443 ssl`（443 需人工配证书），现场若以 `http://192.168.x.x:8080` 访问则本保护形同虚设，要生效必须走 https。**不要**用「起表时快照 token 指纹、触发前重读比对」或「随机抖动」代替互斥：同刻触发的两个标签页会同时比对通过 / 只是把两枚定时器错开。

**access token 保活定时器**（`api/http.ts` 的 `ensureAccessTokenKeepalive`，模块级 `setTimeout` 链）：按 `localStorage` 里当前 access token 的 `exp` 自续期 —— 在「剩余寿命 ≤ 提前量(300s)」那一刻发 `/iam/refresh`（排期是 `剩余寿命 − 300s + 5s`，那 +5s 是**余量**，让定时器早到几毫秒时剩余寿命仍 ≤ 阈值、不至于空转一轮；见 `http.ts` 的 `KEEPALIVE_SLACK_SECONDS`），成功后按新 exp 重排。**它存在的唯一理由是覆盖零 HTTP 流量**：`maybeProactiveRefresh` 只在成功响应拦截器里被调，天然依赖流量，而 dashboard 的 3 个 query 都没有 `refetchInterval`（`staleTime` 只决定「下次取数放不放行」，不产生定时器）⇒ 空闲大屏 / HMI 屏零流量时 access token（TTL 900s）会静静过期，随后 WS 周期性 re-auth 拿到 TOKEN_EXPIRED。起表点共 **4** 个，判据是「token 从哪来」，**新增 token 落盘写路径时必须同步补起表**：`http.ts::persistTokens`（refresh 成功后）/ `stores/auth.ts::saveToStorage`（登录成功后 —— 登录**不经过** `persistTokens`，那条只在 `doRefresh` 里被调）/ `stores/auth.ts::loadFromStorage`（刷新浏览器恢复会话）/ `stores/auth.ts::teardownSession`（会话终止，兼**拆表点**，删盘后调用即 no-op）。`initDummyAuth` 只写内存、刻意不写 localStorage，没有起表对象。与互斥锁的关系：它**按 `exp − 提前量` 这个确定性时刻排期**，同账号多标签页共享同一份 storage 与同一个 exp ⇒ 定时器落在同一时刻，因此它正是上一条那个跨标签页竞态的主要来源，必须经 `getOrCreateRefresh()` 才能拿到互斥保护。失败兜底是**有界重试**（退避两档后放弃并打一行 warn）：一次网络抖动不该让保活链对本会话永久失效，而无限重排在后端持续不可用时会变成请求风暴；放弃后仍由 reactive 40102 / WS 4001 兜底。

### tagsView per-user 持久化

`src/stores/tagsView.ts` 自管 localStorage，key 为 `myerp.tags_view.<userId>`：同账号重登恢复标签栏，换账号互不可见。归属切换唯一入口 `switchOwner(userId)`，由 auth 的 `setUser()` 驱动；登出走 `switchOwner(null)`（只清内存、**不写盘**）。**store 初始化不读 localStorage**，hydrate 只由 `switchOwner` 触发。`pinia-plugin-persistedstate` 已卸载（它的 key 入参是 storeId，做不到 per-user 隔离）。

### dashboard WS 单例

`src/api/dashboard.ts` 是全仓唯一 WS 入口（`createGlobalState` + VueUse `useWebSocket`），承载 `/ws/dashboard?token=<jwt>`。

- **URL 用模块级 `shallowRef<string | undefined>` + 显式 `syncWsUrl()`，不用 `computed`**（computed 会缓存住旧 token，logout→重登后仍握吊销 token → `40105` 死循环）。
- **`undefined` 是「无 token 不要连」的哨兵**。禁止无 token 时拿裸 URL 握手（后端必回 `40100`，是无意义重试刷屏的来源）。
- **重试不封顶**（`retries: -1`，退避 1s→10s 封顶），失败日志前 3 次完整诊断、之后每 30 次一行。WS 是 dashboard 唯一更新通道，封顶重试会让页面静默停更。诊断输出：脱敏 URL（`token=***`）/ closeCode + reason / hadErrorEvent / tokenExpired。
- **关闭码分流**（逐行契约表在后端 `docs/api/dashboard.md` §7.1「关闭码表」：code × reason × 发出点 × 前端应做什么；`4001` 的判定收在 `src/modules/dashboard/handler.rs` 的纯函数 `reauth_close_code`（`TOKEN_EXPIRED` 40102 → `(4001, "access token expired")`；`UNAUTHORIZED` 40100 / `SESSION_REVOKED` 40105 → `(4001, "auth expired")`；其余 → `(1011, "re-auth unavailable")`），`1011` / `1012` / `4003` 见该文件内各 `close_with(&mut sender, <code>, …)` 发出点旁的注释）：`1000` / `1001` / `1006` / `1011` / `1012` → 继续无限重试；`4001`（连接期间 re-auth 失败）→ **停重连（URL 置 undefined）+ 不清 session**，只派发 `auth:session-lost` 交 app 层处置（清会话的职责在 app 层，`access token expired` 时本地 refresh token 仍然有效，WS 层删 localStorage 等于直接踢人）；`4003`（慢消费方丢了 n 条事件）→ 继续重试 **+ 派发 `dashboard:full-refetch` 立即全量 invalidate**（该事件由 `views/dashboard/composables/useDashboardInvalidation.ts` 接收；必须走立即路径而非 500ms 防抖，且重连首帧 snapshot 在 `dispatch()` 里被 no-op 丢弃、Query 无轮询，丢的事件没有补偿通道）。
- **`4001` 的两段 reason 由 app 层（`src/router/index.ts` 的 `auth:session-lost` listener）分流**，字面量必须与后端 `handler.rs::reauth_close_code` 的产出逐字对齐（reason 拆分那次改动在后端仓，本仓只消费不解释）：`access token expired` = 只是这枚 access JWT 自然过期、`TOKEN_EXPIRED` 40102 ⇒ `auth.refreshOrLogout(router)`，成功后必须 `reconnectDashboard()` 恢复长连接（refreshOrLogout 走 `/iam/me`，成功响应不触发 40102，不一定发生 refresh，没人派发 `auth:session-changed`，漏掉这句 WS 会永远停在 `undefined`）；`auth expired` = 会话真被吊销、`UNAUTHORIZED` 40100 / `SESSION_REVOKED` 40105 ⇒ `auth.forceLogout(router)`；`null` 按「可能只是过期」走 refresh 分支，其它未知的非空 reason 保守 forceLogout。
- **主动关闭的判定绑在 socket 实例上**：`useWebSocket` 的 `ws.onclose` 无条件调 `onDisconnected`（`explicitlyClosed` 只挡 `autoReconnect` 分支），所以 token 刷新换连接那次 `code 1000` 必须靠「待关闭的 socket 实例」这一等值比较剔除，不能按 code 吞。**`useWebSocket` 传 `autoConnect: false`**：它只关掉 VueUse 自己的 `watch(urlRef, open)`，`immediate` 首次建连不受影响；不关掉的话那条 watch 与本文件的 `watch(wsUrl, …)` 同 flush 且注册更早，会先跑 `open()` 把 wsRef 换成新 socket，导致取不到「即将关闭的旧实例」。因实例绑定，标记滞留也不会吞掉别的连接的失败（一个 WebSocket 只派发一次 close 事件）。
- **分层禁令**：WS 层**禁止** import `stores/auth`、`vue-router`、`@tanstack/vue-query`，全部走 CustomEvent 解耦。
- **`4001` 只在已建立的连接上有效**，握手阶段的鉴权失败只会表现为 `1006`（后端 upgrade 前直接回 HTTP `401`，浏览器 WS API 不暴露握手期 status）。所以会话真死的最终兜底是 HTTP 侧 `40105 → auth:logout`，不是 WS 侧的 `4001`；也**不要**加「握手失败几次就登出」的启发式，那会把代理 / 后端故障误判成会话失效。
- **dev 环境必须有 `/ws` 反代**（`vite.config.ts` `server.proxy`）。Vite 8 的 dev upgrade 监听器只对匹配到的 proxy context 转发，缺了表现为「页面数据正常但控制台一直刷 WS 报错」。生产 / 预发由 nginx 的 `location ^~ /ws/` 负责。

### 图表

业务组件一律走 `vue-echarts`（`app.component('VChart', VChart)` 全局注册），模块化注册统一在 `src/plugins/echarts.ts`。**禁止**在业务组件内值导入 `echarts/core` + `echarts.init()` + 自写 ResizeObserver / dispose 生命周期（type-only import 不受限）。`src/components/EChart.vue` 是历史兜底薄壳，不在新增代码中使用。

### 共享批次卡片

`src/components/BatchCard.vue` 是全仓唯一的批次卡片（200×96 固定盒），消费方：生产队列的工序候选池 / 工人列 / 待下发池，外协发送接收看板的候选池 / 外协公司列。**局部 import**（与 `PagedTable` / `ColumnVisibilityPopover` 同风格），不进 `main.ts` 全局注册。view-model 是 `src/types/batchCard.ts` 的 `BatchCardModel`（局部 import，不属 `types/productionQueue.ts`）。

- **DTO 差异只能在适配层消化，组件零 `api/*` 依赖。** 三个 wire DTO 各自经 `views/production/queue/utils/queueItemToCard.ts`（`poolItemToCard` / `heldToCard` / `pendingBatchToCard`）或 `views/outsource/composables/outsourceItemToCard.ts` 转成本类型；**适配层各域自持，不要为了对称集中到共享目录**。
- **改尺寸 / body 行数会同时影响全部消费方。** 200×96 是硬预算：body 恒 4 行 × 18px 行高（4×18 + 3×2 gap + 上下各 8 padding + 上下各 1px 边框 = 96px，无余量），长文本一律 ellipsis 不换行。**新信息只能进 tooltip，不得加第 5 行。**
- `BatchCardModel` 的两类扩展字段性质不同：`version?: number` 是 `t_part_batch` 的一列、**非领域概念**故在顶层（外协收发的 OCC 锚）；`extra?: BatchCardExtra` 是**单域扩展槽**、只进 tooltip（外协公司 / 工序 / 单价 / 发出时间 / 接收可免填性）。新增域信息优先走 `extra`，别往顶层堆领域字段。
- **左侧 4px 竖条只承载「这条批次有制定工序链且链指针未漂移」这一个语义**（`has_process_chain`，绿；无链落 `var(--el-border-color-lighter)`）。加急只剩 body 的「加急」tag 一个通道（`.is-urgent` 红底是报工台 `.part-row` 的样式，批次卡片没有），**不进边框**；`.is-selected` 的主色描边照旧盖住竖条（交互反馈优先于语义色）。三个适配层里该字段来源不同：候选池 / 工人持有 / 外协候选透传后端派生列，待下发按 `process_chain_id !== '0'` 推导，外协在途恒 `false`（外协收发阶段不判链）。
- `has_process_chain` 只回答「有没有链且指针对得上」，**不回答「下一道工序能免填吗」** —— 后者是 `chain_state` / `chain_resolvable` 的事（放回页、外协接收各有消费点），两者不要互相推导。
- 报工台（`views/production/scan/`）三页的 `.part-row` 与 `components/BatchPickerDialog.vue` 的 `.batch-row` 走同一条规则（`views/production/scan/chainAccent.ts`，**类绑定** `chainRowClass()` + 各文件 scoped CSS 里的 `.has-chain` 规则）：**流程区分不进边框**（由顶栏标题 + 路由承担），三个页面的 CSS 里不得再出现按流程硬编码的左边框色。**禁止**用模板 inline `:style` 承载这个语义色 —— inline 优先于任何非 `!important` 规则，会盖住 `.is-selected` / `.is-urgent` 的 `border-color` 简写，表现为选中态左边框退成中性色。报工台的级联口径与 `BatchCard.vue` 相反：`.has-chain` 排在全部状态类**之后**（同档 0,2,0 靠源码顺序取胜），左边框恒归链语义（选中色与链色同为一个绿，肉眼无差，但口径只有一条）。
- `PendingPoolCard.vue` 是**工序投放卡**（不是批次卡），只是盒模型与 BatchCard 对齐，刻意保持独立、不合并。

### 货架自动选择（2026-10-10）

**目标货架一律由后端选，前端不提供任何货架选择器。** 要恢复某个入口，必须同时确认后端对应端点是否仍接受 `shelf_id` —— 那 8 条写路径的货架入参已全部删除（worker-scan / place-on-shelf / release-from-programming / to-process / to-inspection / scan-inspect / repair-dispatch / outsource-queue/move 的 `to` 侧），`POST /prod/queue/move` 只删了 `to` 侧、`from` 侧仍必填。

- **口径**：按目标的工序 / 品检找出所有符合条件的货架，再按 `current_load / capacity` **升序**取一个。`capacity` 为 `null` 或 `<= 0` = **不限**（排在有上限的架之后，不参与百分比比较）；**超载不拒**（> 100% 照样投放，只影响排序）。
- **前端只负责展示负载**：`Shelf.capacity` / `Shelf.current_load` 只在 `src/views/iam/shelves/ShelfList.vue` 消费（列表三列 + 新增/编辑弹窗的容量输入）。百分比由前端自己算 —— 后端**不返** `load_ratio`，避免同一个派生量两边各算一遍。`capacity` 是**必填键、值可空**：`z.number().nullable()`；`current_load` 是 `z.number()`。
- **⚠️ 部署顺序：后端必须先上。** `capacity` / `current_load` 是必填键，后端旧版本不返 ⇒ `shelfSchema.parse` 抛 ZodError ⇒ `useProductionShelvesQuery` 的数据恒空，而它的消费方里包含 `/scan/action` 的按钮显隐（扫工牌后能做的三件事）、账号管理的货架绑定、待品检页的工序弹窗。**表现是静默的**：扫码台三个动作按钮全没了且零文案（`noActionReason` 在「绑了架但一个 zone 都认不出来」这一支刻意返回 `null`），不是红色报错。排障时先怀疑部署顺序，别去查权限。
- **已下线的端点**：`GET /shelves/for-return` 与 `GET /shelves/for-inspection`（404、无 alias），连同 `ShelfForReturn` / `ShelfForInspection` / `ShelfForInspectionResult` / `ShelfPickerItem` 类型与 `listShelvesForReturn` / `listShelvesForInspection` 两个 api 函数一并删除。`api/shelfPickers.spec.ts` 随它们删除 —— 那两个端点没有 alias，留着就是守一个不存在的契约。同批删除的还有 `views/production/scan/components/ShelfPickerDialog.vue` 与 `WorkingShelfDialog.vue`、`stores/scanShelf.ts`、`views/production/scan/composables/resolveWorkingShelf.ts`。
- **`useShelfProcessFilter` 整文件删除**：它唯一剩下的消费方是零件详情页的「外协回收」弹窗，而那个弹窗打的 `POST /prod/batches/{id}/receive-from-outsource` **已被后端硬切下线**（三合一为 `POST /outsource-queue/move`，无 alias）⇒ 能点必 404。`useShelfProcessMappingsQuery` 随之零读点，但 `ShelfList.vue` 保存映射后仍调 `invalidateShelfProcessMappingsQuery(qc)`，故文件保留（写点与失效链成对留存）。
- **`receive-from-outsource` / `receive-from-outsource-to-inspection` 两个 wrapper 随之删除**（都是 404 路径）。外协回收生产的现行入口是 `views/outsource/` 的看板右键菜单，契约由 `useOutsourceQueueMove.spec.ts` 守。
- **`api/parts/crud.ts::PartScanPayload` / `scanPart` 是已知例外**：它打的是 v1(Python) 的 `POST /parts/scan`，v1 仍在维护、契约未变，故仍带 `shelf_id` / `target_inspection_shelf_id`，不属本口径范围。全仓巡检货架字段时不要把它当残留清掉（同理不要删掉它的零调用方 wrapper `scanPart` —— 与下一条的 `place-on-shelf` 一样属「端点还在、入口待产品决定」）。
- **`place-on-shelf` / `release-from-programming` 前端零调用方、wrapper 保留**：端点仍在后端，body 已按新契约改对。要接回入口时注意 `place-on-shelf` 的 `version` 仍是可选形参，而后端必填（缺字段返 422 纯文本，不是业务信封）⇒ 新接线必须改成必填并从 `GET /parts/{id}/batches` 的批次项取 `t_part_batch.version`（`GET /parts/{id}` 本身不返批次锚点）。
- **⚠️ 两条功能死角，是「删掉人工指定货架」的直接后果，不是 bug**，现场要知道：
  - **未上架的批次无人能推进**：后端要求「`location IS NULL` 的 `PENDING` 批次先走 `place-on-shelf` 才能发外协」，而 `place-on-shelf` 的三个前端入口（零件一览下发 / 零件详情下发 / cnc 下发）已随本轮下线 ⇒ 这类批次当前**没有任何前端入口能让它上架**。出路要么是后端 / 产品补一个上架入口，要么确认这批数据由别的途径产生。`NOT_SHELVED_HINT` 因此只说「尚未上架，暂时不能发送到外协」，**刻意不给「请先下发」这个指路**（那个按钮已经不存在了）。
  - **「外协回收 → 品检」无替代端点**：后端把 `OUTSOURCE_COMPANY → INSPECTION_SHELF` 这个方向整条下线了。替代路径是「先回收进生产 → 再走送检」（`to-inspection` 或 worker-scan 的 INSPECTED），代价是多一次工序推进 / 多一次扫码。品检架仍由后端自动选，所以替代路径的落架不受影响。
- **worker-scan 的响应要读 `scan.event_type`**：客户端发 `RETURNED`，但当该批次当前工序是工序链最后一道时后端自动改投品检、回来的是 `WORKER_SCAN_INSPECTED`。放回页的成功文案必须按**响应**分支，照请求的 `event_type` 说「已放回 → 下一道工序」是错的。
- **放回页 NEXT 分支的确认框：三个出口 + 禁右上角 ×**：确认框是 `chain_state='NEXT'` 唯一能到达 `ProcessPickerDialog` 的路，只给「按链放回 / 取消」的话，工人一旦不同意管理员配的工序链（临时插单、改道）就被困死 —— 取消只清选中态，再点卡片还是同一个框。工序链是配置不是命令，「换一道工序」不是冗余出口。**同时必须 `:show-close="false"`**：× 只 emit `update:modelValue(false)`、不发业务事件，而本框又是 NEXT 分支**唯一**的提交入口 ⇒ × 一关就留下「卡片已选中 + 工序已填 + 无处可提交」的死角。判据很简单：**一个弹窗若是某条路径的唯一出口，它的关闭权就必须收在自己手里**；同页另外三个弹窗关掉不致命（确认栏的「取消选择」就能恢复），所以它们不禁 ×。

### 拖拽投放（Sortable）

看板类页面的跨容器拖拽用 `vue-draggable-plus`。三条已踩过的坑：

- **投放容器一律用二参重载** `useDraggable(el, options)`，**不传 list**。传 list 会挂上库的内建 handler（`list.value.splice(...)`），而库假定 list 就是渲染源 ⇒ Sortable 改的数组与 Vue 渲染的数组不同源。容器在 `v-if` 内时用 `src/composables/useLazyDraggable.ts`（它把首次绑定延后到 el ref 解析之后，并强制 `immediate: false`）。
- **不传 list 就必须自己补 `onRemove` 做 DOM 回滚。** 内建 handler 的第一句是 `from.insertBefore(item, from.children[oldIndex])`（把 Sortable 搬过的节点放回源容器），改二参后这层消失；而 **`invalidate` 补不回来** —— Sortable 已经把节点搬到源容器 DOM 之外，`invalidate` 只重新渲染 vdom 里已有的东西。失败时两侧 query 数据都没变，keyed diff 对这个外来节点连 `patchElement` 都做不到，卡片永久留在错误列并累积；成功时源列数据虽已变、keyed diff 会卸载那张卡，但**卸载只删得掉该 vnode 的 DOM footprint**，footprint 之外的节点同样删不掉。用 `dndSourceTracker.ts` 的 `restoreNodeToSource`。同时加 `sort: false` 关掉容器内重排（该选项只在「落点实例 === 拖拽起点实例」时被读，跨实例投放走 group 的 checkPull/checkPut，不受影响）。
- **Sortable 容器的直接子元素必须全是可拖项**（混入 header / 空态会让 `oldIndex` 与可拖项下标错位）。空态用**兄弟覆盖层**（`position:absolute; inset:0; pointer-events:none`）承载，别用 `v-if` 把容器整个摘掉 —— 空容器必须仍是合法投放目标（给空闲工人派活是主场景）。
- **可拖元素 == vnode 的 DOM footprint ⇒ 卡片类组件的根必须是单个元素。** 根一旦是多根 vnode（Fragment），Vue 会在两侧插锚点（`el-tooltip` 包根就是这个形状：`ElPopper` 的 render 是 `renderSlot`，外加默认 `teleported: true` 留 2 个 teleport 占位注释），锚点跟着留在源容器而卡片元素被搬走；`restoreNodeToSource` 按 `from.children[oldIndex]` 放回时元素序列已位移，卡片被插到**自己那对锚点范围之外**，之后 Vue 卸载走 `removeFragment()` 只删锚点、够不到卡片 ⇒ 每投放一次残留一个幻影卡片（徽标 / 计数照常更新，刷新浏览器才恢复）。同一条约束的另一面：**dev 构建保留模板注释，根元素上方不许有任何注释或元素**，否则组件同样变成多根。`BatchCard` 因此把 `el-tooltip` 放在根内部的触发区 `.card-body` 上，`data-*` / `v-bind="$attrs"` 全部留在根 div。守卫：`src/components/__tests__/BatchCardDndFootprint.spec.ts`。

## 已知风险

- 依赖 `xlsx@0.18.5` 有原型污染 + ReDoS 高危漏洞（npm 官方无修复版本）。仅用于内部只读 Excel 解析（parser / 视图已统一收口，不执行公式宏），攻击面可控，后续迁 SheetJS CDN 版或 exceljs。
