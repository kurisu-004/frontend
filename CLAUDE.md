# CLAUDE.md

myERP 工厂管理系统前端：Vite 8 + Vue 3 + TypeScript + Element Plus。

## API 文档路径

后端主仓在 `~/Code/hsh-erp/backend-rust`（Rust + axum + sqlx）。后端契约的载体是**代码注释**，`docs/api/` 只对少数几个域做了整域契约文档（2026-10-10 盘点，`ls backend-rust/docs/api/` 复核）：

| 文档 | 覆盖域 |
|---|---|
| `docs/api/batch.md` | `part` 批次域 |
| `docs/api/dashboard.md` | `dashboard` 大屏聚合（3 个只读 HTTP 端点 + `/ws/dashboard` 的 WS 首帧与增量） |
| `docs/api/delivery_note.md` | `delivery_note` 送货单（列表 / 详情 / 扫码入单 / 移除批次 / 打印） |
| `docs/api/iam.md` | `iam` 认证 + 账号 + 企业微信绑定 |
| `docs/api/inspection.md` | `prod::inspection` 待品检（队列列表 + 扫码三层树） |
| `docs/api/outsource.md` | 外协（报价 / 订单 / 收发货流转） |
| `docs/api/programming.md` | `prod::programming` 待编程一览 |
| `docs/api/queue.md` | `prod` 生产看板队列域 |

**其余域没有 `docs/api/` 文档**（`shelf` / `assembly` / `wx` / `statistics` / `files` / `cnc_program` …），契约载体是代码注释。查接口按这条路径走：

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

**域 schema 与 query hook 同居**：主查询的守门 schema 放域内 query hook 旁边（`src/views/<域>/<页>/composables/<xxx>Schema.ts`，如 `pendingProgrammingSchema.ts` / `inspectionSchema.ts`），导出 `xxxSchema` + `z.infer` 派生类型（`*Data` 后缀，api 层用它标注返回类型）。`src/composables/queries/schemas.ts` 只留**跨域共用**的基础数据层 schema。

### 目录归位

- **域内列定义**放 `src/views/<域>/<name>ColumnDefs.ts`（域根，与页面主组件同级），**不放 `src/utils/`** —— 单域专用文件不是通用工具：它 import 域内 composable 类型会让 `utils/` 反向依赖 `views/`（层次倒挂）。
- **`src/utils/` 只放跨域通用工具**（举例，非全量清单：`fileExt` / `date` / `jwt` / `download` / `pdfjs` / `elTable` / `dndSourceTracker` / 各 `ExcelParser` / `permissions`）。判据是「零个域内依赖」+「多域复用」，不是「看起来像工具」。
- **api 层引域内 schema 的口径**：默认用 `import type`（编译期擦除，照 `api/dashboard.ts` / `api/programming.ts` / `api/parts/batch.ts`）；运行时值引入只允许出现在**没有 queryFn 承载**的守门点 —— 典型是走 useMutation 的单次拉取（`api/inspection.ts` 的扫码树 `inspectionScanTreeSchema.parse`）。这与上面「`utils/` 不得反向依赖 `views/`」是两条不同的禁令：后者禁的是**通用工具**引**单域实现**；api 层引自己域的 schema（含守门 schema 归位后的唯一运行时边 `api → views/inspection`）是允许形态。

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
- `PendingPoolCard.vue` 是**工序投放卡**（不是批次卡），只是盒模型与 BatchCard 对齐，刻意保持独立、不合并。

### 拖拽投放（Sortable）

看板类页面的跨容器拖拽用 `vue-draggable-plus`。三条已踩过的坑：

- **投放容器一律用二参重载** `useDraggable(el, options)`，**不传 list**。传 list 会挂上库的内建 handler（`list.value.splice(...)`），而库假定 list 就是渲染源 ⇒ Sortable 改的数组与 Vue 渲染的数组不同源。容器在 `v-if` 内时用 `src/composables/useLazyDraggable.ts`（它把首次绑定延后到 el ref 解析之后，并强制 `immediate: false`）。
- **不传 list 就必须自己补 `onRemove` 做 DOM 回滚。** 内建 handler 的第一句是 `from.insertBefore(item, from.children[oldIndex])`（把 Sortable 搬过的节点放回源容器），改二参后这层消失；而 **`invalidate` 补不回来** —— Sortable 已经把节点搬到源容器 DOM 之外，`invalidate` 只重新渲染 vdom 里已有的东西。失败时两侧 query 数据都没变，keyed diff 对这个外来节点连 `patchElement` 都做不到，卡片永久留在错误列并累积；成功时源列数据虽已变、keyed diff 会卸载那张卡，但**卸载只删得掉该 vnode 的 DOM footprint**，footprint 之外的节点同样删不掉。用 `dndSourceTracker.ts` 的 `restoreNodeToSource`。同时加 `sort: false` 关掉容器内重排（该选项只在「落点实例 === 拖拽起点实例」时被读，跨实例投放走 group 的 checkPull/checkPut，不受影响）。
- **Sortable 容器的直接子元素必须全是可拖项**（混入 header / 空态会让 `oldIndex` 与可拖项下标错位）。空态用**兄弟覆盖层**（`position:absolute; inset:0; pointer-events:none`）承载，别用 `v-if` 把容器整个摘掉 —— 空容器必须仍是合法投放目标（给空闲工人派活是主场景）。
- **可拖元素 == vnode 的 DOM footprint ⇒ 卡片类组件的根必须是单个元素。** 根一旦是多根 vnode（Fragment），Vue 会在两侧插锚点（`el-tooltip` 包根就是这个形状：`ElPopper` 的 render 是 `renderSlot`，外加默认 `teleported: true` 留 2 个 teleport 占位注释），锚点跟着留在源容器而卡片元素被搬走；`restoreNodeToSource` 按 `from.children[oldIndex]` 放回时元素序列已位移，卡片被插到**自己那对锚点范围之外**，之后 Vue 卸载走 `removeFragment()` 只删锚点、够不到卡片 ⇒ 每投放一次残留一个幻影卡片（徽标 / 计数照常更新，刷新浏览器才恢复）。同一条约束的另一面：**dev 构建保留模板注释，根元素上方不许有任何注释或元素**，否则组件同样变成多根。`BatchCard` 因此把 `el-tooltip` 放在根内部的触发区 `.card-body` 上，`data-*` / `v-bind="$attrs"` 全部留在根 div。守卫：`src/components/__tests__/BatchCardDndFootprint.spec.ts`。

## 已知风险

- 依赖 `xlsx@0.18.5` 有原型污染 + ReDoS 高危漏洞（npm 官方无修复版本）。仅用于内部只读 Excel 解析（parser / 视图已统一收口，不执行公式宏），攻击面可控，后续迁 SheetJS CDN 版或 exceljs。
