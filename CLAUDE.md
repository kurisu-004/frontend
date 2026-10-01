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

> 3 个映射函数**刻意留在 `src/api/shelves.ts`**，不新建 `src/api/prod/` 子目录：本仓 `src/api/` 按**前端实体扁平放置**、不按后端模块分层。两组反证：
>
> 1. `/prod` 命名空间已被**7 个扁平文件**瓜分（`process.ts` / `worker.ts` / `workType.ts` / `workerPool.ts` / `pendingBatches.ts` / `processChain.ts` / `programming.ts`）。其中 `programming.ts` → `/prod/programming/pending` 与本次的 `/prod/shelf-processes` **完全同构**；`workerPool.ts` → `/prod/pool/*` 更直接反证「文件名 = URL 段」在本仓**从来不是**规则。建 `api/prod/` 只会把 1 个资源塞进第 8 处，或引发搬 7 个文件的巨量 diff。
> 2. 现有 3 个子目录 `com/` / `files/` / `parts/` **全部镜像独占 URL 命名空间**（`com/unionList.ts` → `/com/union-list`、`files/sts.ts` → `/files/sts-tmp-keys`、`parts/*` → `/parts/*`）。注意 `files/` 只有 1 个文件、1 条端点路径 —— 它成目录**不是因为端点多**，只有 `parts/`（`/parts/*` 端点数确实多到拆出 4 个实现文件 batch / bid / crud / file）才适用「端点多到需拆文件」。**没有** `prod/` 目录。
>
> `src/types/shelf.ts` 里 `ShelfProcessMappingItem` / `AllShelfProcessMappingItem` / `ShelfProcessesResult` / `SetShelfProcessesPayload` 同理留在原处（按货架实体归类）。

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
  `forceLogout(router)`（2026-10-02 新增）是它的**同步**兄弟：`refreshOrLogout` 拉
  `/iam/me` 复核（给路由守卫的「未登录但可能有 session」恢复路径用），`forceLogout`
  不联系后端、直接终止本地会话（给「后端已权威判定会话失效」的信号用，如 WS 关闭码
  `4001`）。`forceLogout` 的 router 参数**保留**（app 层唯一的导航注入点），
  `refreshOrLogout` 的失败分支**委托**给它并透传 router。
  mutation 全局 retry: 0 见上文 TanStack Query 约定，store 内不写 retry。
- **会话终止收口 `teardownSession()`（2026-10-02 新增）**：`src/stores/auth.ts` 里
  **无 router 参数**的私有函数，是会话终止的**唯一**状态 + 缓存收口点 —— 清
  `token` / `refreshToken` / `user`（经 `setUser(null)`，连带切 tagsView 归属）/
  `isDummyAuthActive`、删 `auth_session`、派发 `auth:session-changed(token: null)`、
  **`queryClient.clear()`**。四条终止路径全部汇到它，**新增第 5 条必须改走本函数**：
  | 入口 | 触发源 | 导航 |
  |---|---|---|
  | `logout()` | 用户点「退出」（先 `await apiLogout()`） | 无（调用方负责） |
  | `forceLogout(router)` | `auth:session-lost` 事件 ← dashboard WS 关闭码 `4001` | `router.replace('/login')` |
  | `refreshOrLogout(router)` catch | 路由守卫 /iam/me 校验失败 | 委托 `forceLogout(router)` |
  | `auth:logout` 事件订阅 | `src/api/http.ts:425`（40105 SESSION_REVOKED）/ `:450`（refresh 失败） | 无 |

  分工：`teardownSession()` = 纯收口（无 router、不感知路由）；`forceLogout(router)`
  = 在其之上**追加**一次导航。守卫侧拿到 `refreshOrLogout` 的 false 后必须
  `next(false)` **取消**那条已被取代的导航（不要 `next('/login')` 再导航一次）——
  守卫是 3 参签名 `(to, _from, next)`，vue-router 的 `guardToPromiseFn` 只在
  `guard.length < 3` 时自动续 next，3 参守卫里「什么都不调」= 导航永久挂起
  （prod 守卫 promise 永不 settle，dev 抛 `Invalid navigation guard`）。
- **`queryClient.clear()` 是跨账号缓存隔离的唯一手段（2026-10-02，M-4）**：全仓
  queryKey（`src/composables/queries/keys.ts` + 各视图内 query）**都没有 user 维度**，
  而 `QueryClient` 是 `src/main.ts` 里的单例。登出 → 不刷新页面 → 换账号登录，A 账号
  按 `can_access_shelf` 收窄的缓存会零网络请求直喂 B 账号。故会话终止时必须
  `clear()` 全清：
  - `clear()` **自带 in-flight 取消且是 silent**
    （`queryCache.js` `clear()` → `remove()` → `query.js` `destroy()` → `this.cancel({ silent: true })`），
    **禁止**再叠 `cancelQueries()`：默认非 silent 会触发仓内
    `watch(error) → ElMessage.error` 桥接，登出瞬间刷一屏假错误。
  - 会话终止是**唯一**全清点：`views/dashboard/composables/` 下 4 个 query 用
    `gcTime: POSITIVE_INFINITY`（`useDashboardSnapshot` / `useDashboardUrgentList` /
    `useDashboardOverdue` / `useDashboardUpcomingList`），永不被 GC，只靠这一步兜底。
- **`useQueryClient()` 必须在 store setup 顶层捕获（2026-10-02）**：`src/stores/auth.ts`
  的 `queryClient` 在 `defineStore` 回调**第一行**取，不能挪进 `teardownSession()` 惰性取。
  原因：Pinia 只对 store setup 包 `runWithContext`（`pinia.mjs:1468-1470`），
  action wrapper（同文件 `:1379-1405`）里**没有**；而 `useQueryClient()` 首行
  `hasInjectionContext()` 守卫会抛（`useQueryClient.js:26`）。⇒ 任何惰性路径
  （action 内 / 事件 listener 内）再调都会炸。
  两侧后果：`src/main.ts` 里 `app.use(VueQueryPlugin, …)` 必须早于**任何** store 实例化
  （最早的实例化是 dummy 分支的 `useAuthStore()`）；测试侧
  `useQueryClient()` 只在 store **首次创建**时执行（后续命中 `pinia._s` 早返回），
  所以**任何实例化 auth store 的 spec 必须 `app.use(VueQueryPlugin)` + 传一个
  `QueryClient`**。
- **`auth:logout` 是订阅点不是派发点（2026-10-02）**：派发方两处，都在 axios 拦截器
  —— `src/api/http.ts:425`（40105 SESSION_REVOKED）与 `:450`（refresh 失败）。
  订阅方两处，职责**不同**：
  - `src/main.ts` —— **只负责导航** `router.replace('/login')`；
  - `src/stores/auth.ts` —— 清会话状态 + 清 query 缓存（`teardownSession()`）。
    此前只有前者，状态无人清理（`auth.user` / `token` 全留、`isAuthenticated` 仍 true、
    内存 query 缓存被新账号复用），是 M-4 暴露面最大的一条路径。
  - ⚠️ 旧注释「拦截器失败分支已经清掉 localStorage」是**事实错误**：`src/api/http.ts`
    全文件零 QueryClient 引用、也从不删 `auth_session`（它只在 refresh 成功时经
    `persistTokens()` **写**）。
- **auth store 写点唯一性（2026-10-02）**：`user.value` 只在 `setUser()` 里赋值
  （5 个调用方：`loadFromStorage` / `loginMutation.mutationFn`（必须在 `saveToStorage()`
  **之前**）/ `refreshOrLogout` 成功 / `initDummyAuth` / `auth:tokens-refreshed` 监听）。
  `setUser` 顺带切 tagsView 的持久化归属 `switchOwner(u?.id ?? null)`，
  `tagsView.switchOwner` **只经 setUser 调用**（`teardownSession` 不重复调）。
  另：`isDummyAuthActiveValue` 的复位点**只在** `teardownSession()` 里 —— 此前只在
  `initDummyAuth()` 置 true、从无复位，dev dummy 模式登出后守卫仍短路放行。
- **tagsView per-user 持久化（2026-10-02 新增，替代 pinia-plugin-persistedstate）**：
  `src/stores/tagsView.ts` 改自管 `localStorage`，key 形如
  **`myerp.tags_view.<userId>`**。行为：同账号重登**恢复**自己的标签栏；换账号
  **互不可见**；登出（`switchOwner(null)`）只清内存、**不写盘**（写盘等于把存档覆盖成
  空 = 缺陷没修成）。归属切换的唯一入口是 `switchOwner(userId)`，由 auth store 的
  `setUser()` 驱动；**store 初始化路径不读 localStorage**（hydrate 只由 `switchOwner`
  触发，否则 `TagsView.spec.ts` 那类裸 `setActivePinia(createPinia())` 的 spec 会因
  反查 userId 而被迫 `useAuthStore()` → 撞上 `useQueryClient()` 的 injection 限制）。
  旧全局 key `tags_view` 在首次 `switchOwner(非 null)` 时一次性迁移并 `removeItem`。
  **key 命名有意偏离**仓内另两个 per-user 先例（`useListFilterPersist.ts` /
  `useColumnVisibility.ts` 的 `myerp.list.<userId>.<key>`，userId 在**中间**、带末位
  `<名>`）：本 store 只有一份数据，末位名冗余；且该 key 此前从未上线，无迁移成本。
  `pinia-plugin-persistedstate@^4.7.1` 已从 `package.json` 卸载（插件的 `key` 只求值
  一次、入参是 storeId、且 Pinia store 跨 logout→login 存活，做不到 per-user 隔离）。
  `reset()`（清空含 affix）保留但当前**无生产调用方** —— 登出走 `switchOwner(null)`。
- **auth 转换事件 `auth:session-changed`（2026-10-01 新增）**：长连接层（`src/api/dashboard.ts`
  的 dashboard WS 单例）与 auth 之间的**唯一**通知通道，取代此前只订阅 `auth:tokens-refreshed`
  的做法。`CustomEvent<{ token: string | null }>`，`detail.token` 语义：
  - `string` → token 已就位（刷新 / 登录），WS 用它重算 URL 并重连；
  - `null` → session 已终止（登出 / `refreshOrLogout` 失败），WS 主动断开。

  **4 个派发点，覆盖全部 auth 转换，缺一即产生「控制台无限刷 WS 报错」**：
  | 位置 | 时机 | detail.token |
  |---|---|---|
  | `src/api/http.ts` `persistTokens()` | access token 被刷新 | 新 token |
  | `src/stores/auth.ts` `loginMutation.onSuccess` | 登录成功 | 新 token |
  | `src/stores/auth.ts` `teardownSession()` | 会话终止（**4 条路径的单点**，见上方条目） | `null` |

  （2026-10-02 合并说明：原表把 `logout()` 与 `refreshOrLogout()` catch 分支列成两行，
  M-4 把两者连同新加的 `forceLogout` / `auth:logout` 事件一起收进 `teardownSession()`，
  于是 4 个派发点变成 3 个 —— **派发语句本身只有 1 处**。）

  派发方**一律不 import** `src/api/dashboard.ts`（否则形成 `auth ↔ api` 循环依赖），
  沿用 auth store 条目里既定的 CustomEvent 解耦范式。`auth:tokens-refreshed` 保留不动
  —— 它管 store 自身 state（token / user / refreshToken）同步，与 WS 层是两件事。
  **新增任何改变 token 生命周期的写点时，必须在这 3 处之外同步补派发。**
  ⚠️ 本表**不覆盖** WS 收到后端关闭码 `4001` 的场景 —— 那条路径由 WS 层反向派发
  `auth:session-lost`（方向相反），详见下方「dashboard WS 单例」第 4 条。

- **dashboard WS 单例（2026-10-01 重构）**：`src/api/dashboard.ts` 是全仓唯一 WS 入口
  （`createGlobalState` + VueUse `useWebSocket`），承载 `/ws/dashboard?token=<jwt>`。四条硬约束：
  1. **URL 用模块级 `shallowRef<string | undefined>` + 显式 `syncWsUrl()`，不用 `computed`。**
     旧 `computed + tokenVersion` 形态会缓存住旧 token（`tokenVersion` 只被刷新事件 bump），
     导致 logout→不刷新页面→重新登录后 WS 仍握吊销 token → `40105` 死循环。
     VueUse `_init()` 每次重试都重读 `urlRef.value`，所以只要在 auth 转换点同步一次即可。
  2. **`undefined` 是「无 token，不要连」的哨兵值。** 借 VueUse `_init()` 首行
     `typeof urlRef.value === "undefined"` 守卫实现零连接尝试。**禁止**无 token 时拿裸 URL
     去握手 —— 后端必回 `40100 缺少 token 查询参数`，是无意义重试刷屏的直接来源。
  3. **重试不封顶次数**（`autoReconnect.retries: -1`，退避 `1s→10s` 封顶），失败日志按
     「前 3 次完整诊断 + 之后每 30 次一行」降频。理由：WS 是 dashboard **唯一**更新通道
     （首屏 `GET /api/v2/dashboard/snapshot` 之后全靠 WS 事件 invalidate 重取），
     封顶重试会让页面静默停止刷新，比刷屏更糟。诊断须输出四项 app 内可判定信息：
     脱敏 URL（JWT 一律 `token=***`）/ `closeCode` + `reason` / `hadErrorEvent` /
     `tokenExpired`（`decodeJwt` 读 `exp`）。排查**先按 closeCode 查第 4 条的关闭码表**；
     只有 `1006` 才需要再去查握手期 HTTP status —— 浏览器 WS API **不暴露握手期 status**，
     后端鉴权失败是 upgrade 前直接回 `401`（不是 WS Close 帧），故 `1006` 无法区分
     `401` / `502` / 代理缺失，真实 status 只能看 Network 面板或直连后端 curl。
  4. **关闭码分流（2026-10-02）**：后端已补完**主动 Close 帧**（此前全仓零
     `sender.send(Message::Close(..))`，所有断开都是裸 drop，浏览器只见 `1006`），
     关闭码语义表的唯一权威来源是 `~/Code/hsh-erp/backend-rust/docs/api/websocket.md`：
     | code | 含义 | 前端行为 |
     |---|---|---|
     | `1000` | 正常关闭 | 无需动作；**服务端不主动发**，只会出现在客户端 `close(1000)` 的回声里（`closeDashboard()` / 登出路径） |
     | `1001` | going away（**后端不主动发**：2026-10-02 起写失败路径改裸断，浏览器侧落 `1006`） | 保留行仅作对照；真收到与 `1006` 同走无限重连 |
     | `1011` | 内部错误（`snapshot build failed` / `send snapshot failed` / `re-auth unavailable` / `pong timeout`） | 继续无限重试（`snapshot build failed` 一个 reason **刻意偏离**，见下） |
     | `1012` | 服务重启 | 继续无限重试 |
     | `4001` | **会话在连接期间失效** | **停重连 + 清 session + 走登出** |
     | `4003` | 慢消费方（背压超限，丢了 n 条事件） | 继续无限重试 **+ 立即 invalidate 全量 HTTP 重取** |
     | `1006` | 浏览器侧「异常关闭」兜底（无 Close 帧） | 继续无限重试（原因未知） |

     `4001` 是**唯一**必须终止重连的码：其余全部按第 3 条继续无限重试，理由同上
     （WS 是 dashboard 唯一更新通道，封顶/放弃重连会让页面静默停止刷新）；而 `4001`
     再重试多少次都会被判 401，是死路，不分流就是 2026-10-01 修掉的「logout 死循环」
     bug 的另一面。`onDisconnected` 里 `4001` 分支的行为**顺序**（`src/api/dashboard.ts`）：
     ① `wsUrl.value = undefined` 停重连（复用第 2 条「无 token 不连」哨兵；
     触发 `watch(urlRef, open)` → `close()` → `resetRetry()` 掐掉已排队的退避定时器，
     即便没掐掉 `_init()` 首行的 undefined 守卫也不会 `new WebSocket`）
     → ② `localStorage.removeItem('auth_session')` 清会话
     → ③ `window.dispatchEvent(new CustomEvent('auth:session-lost', { detail: { code, reason } }))`。

     `4003` 的**额外**动作（本表唯一非终止性的特例）：后端文档规定「重连 + 全量 HTTP
     重取」，其成立前提是「重连时自然重新收到首帧 snapshot」—— **该前提对本前端不成立**：
     重连后的首帧 `snapshot` 在 `api/dashboard.ts` 的 `dispatch()` 里被显式 no-op 丢弃，
     且 TanStack Query 无轮询（`staleTime: 30_000` 只管「下次取数是否放行」）⇒ 丢掉的
     n 个事件没有任何补偿通道，「丢 1 个事件 = 对应区块永不刷新」且页面静默无提示。
     所以 `4003` 分支额外派发 `window` 事件 **`dashboard:full-refetch`**
     （`CustomEvent<{ code, reason }>`），由
     `src/views/dashboard/composables/useDashboardInvalidation.ts` 接收 → 对本
     composable 持有的每个 queryKey **立即 invalidate（不防抖）**。防抖（500ms /
     maxWait 1500ms）是给「单次扫码连发 3 个事件」防雪崩用的；4003 是「已确定丢了
     数据」，每多等 500ms 都在展示已知过期的数据，故必须走独立的立即路径。
     ⚠️ WS 层**禁止** import `@tanstack/vue-query`（api 层引入 TanStack Query 依赖是
     分层倒置）—— 走 CustomEvent 解耦，接收方那边已经持有 `qk` + `queryClient`。
     其余关闭码（`1006` / `1011` / `1012`）同样会因断连丢事件，属既有架构的
     已知缺口（无轮询），刻意不在本表扩范围：只有 `4003` 是后端**明确告知**「永久丢了
     n 条」的码。
     `1011` 四个 reason 里**仅** `snapshot build failed` 一个被本前端**刻意偏离**
     （后端建议「提示用户稍后再试」，理由与第 3 条一致 —— 放弃重连 / 静默停更比
     「刷屏 + 无提示」更糟，单点后端故障不应该让所有客户端一起失去 dashboard）。
     `re-auth unavailable`（后端 2026-10-02 新增：Redis 挂 / 连接池耗尽 → `50000`，
     后端明确写「**不要**清 token」）/ `send snapshot failed` / `pong timeout` 三者
     后端本就要求走通用重连，前端行为与后端要求**完全一致**，无偏离。

     `auth:session-lost` 与上面 `auth:session-changed` **方向相反，别混淆**：
     后者由 auth 层派发、语义「token 变了，WS 重算 URL 重连」；前者由 WS 层派发、
     语义「后端判定会话已死，请上层终止会话」。接收方是 **`src/router/index.ts`**
     （不是 MainLayout.vue：那只是组件，挂在 `requireAuth` 子树下，`/scan/*` 等
     MainLayout 之外的全屏路由收不到；router 模块已持有 router + useAuthStore，零新增依赖），
     动作是 **`auth.forceLogout(router)`**（`src/stores/auth.ts`）→ 调
     `teardownSession()`（清 store 内存 state + `localStorage.removeItem` + 派发
     `auth:session-changed(token: null)` + 切 tagsView 归属 + **`queryClient.clear()`**）
     再 `router.replace('/login')`，**不联系后端**。收口细节见上方「会话终止收口
     `teardownSession()`」条目。
     WS 层**禁止** import `stores/auth` 或 `vue-router`。
     ⚠️ **不要**在 app 层改回「先 `refreshOrLogout(router)` 复核 `/iam/me`」：WS 层在
     派发 ② 里已 `removeItem`，而 `http.ts` 请求拦截器只从 localStorage 取 token
     （`readToken()`，不读 store）⇒ `apiMe()` 不带 `Authorization` ⇒ 后端 middleware
     必返 `40100` ⇒ 「HTTP 侧仍有效」分支在构造上不可达，还留下一个长达一次 RTT 的
     「UI 显示已登录、实际已登出」窗口。`refreshOrLogout` 的语义是**给路由守卫用**
     （`!auth.isAuthenticated` 时的恢复路径），两者不要混用。

     ⚠️ **`4001` 只在已建立的连接上有效 —— 握手阶段拿不到它（2026-10-02 留档，代码改不了）**。
     后端 `reauth_close_code()` 的分流是：`40100` / `40102` / `40105`（鉴权类）→ `4001`，
     其余（含 Redis 抖动 `50000`）→ `1011 / re-auth unavailable`。组合本身正确（前端对
     `1011` 无特判 → 无限重连，与后端「不要清 token」一致）。但残留一条门：**Redis 抖动 +
     会话已被吊销**时，re-auth 拿到 `50000` ⇒ 后端发 `1011` 而非 `4001` ⇒ 前端重连
     ⇒ **握手阶段**校验到吊销 ⇒ upgrade 前直接回 `40105` ⇒ 浏览器只见 `1006` ⇒
     **永远到不了 4001 分支**（只能继续无限重试）。暴露面有界：页面只要发出任何 HTTP
     请求，`40105` 会触发 `http.ts` 派发 `auth:logout` → 跳登录页（并经
     `teardownSession()` 清会话状态 + query 缓存）；只有在「页面静止 +
     TanStack Query 无轮询」的空档里，用户会盯着不再刷新的 dashboard + 一串 WS 重试日志。
     **这是既有架构缺口**（握手阶段的失败从来就是 1006），不是某次改动引入的；会话真死
     的最终兜底是 **HTTP 侧 `40105` → `auth:logout`**，不是 WS 侧的 `4001`。
     review 时不要把它误判成新 bug，也不要试图在前端加「握手失败几次就登出」的启发式 ——
     那会把代理 / 后端故障（`502`、后端不可达，同样是 1006）误当成会话失效。

  **dev 环境必须有 `/ws` 反代**（`vite.config.ts` `server.proxy`）。Vite 8 的 dev `upgrade`
  监听器只对**匹配到的 proxy context** 转发 `proxy.ws`，不匹配的路径掉出循环后不写任何
  响应 → 浏览器看到「握手无响应」而 HTTP 首屏快照走 `/api` 完全正常，表现为
  「页面数据正常但控制台一直刷 WS 报错」。生产 / 预发由 nginx
  （`nginx.conf` / `nginx.http-only.conf` 的 `location ^~ /ws/`）负责。复验命令见
  `vite.config.ts` 内注释。
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

     - 范本：`src/stores/auth.ts:234`（login mutation，单纯 onSuccess 不挂 invalidate；行号随 M-4 改动位移过，2026-10-02 重新核过）、`src/views/parts/new/composables/usePartBatchManual.ts:892`（批量录入 mutation，部分失败 / 成功跳转 / ElMessage 放 onSuccess / onError）。
  9. **ElMessage 错误桥接**
     - useQuery 的 error 不在 setup 抛错，走 `watch(error, (e) => e && ElMessage.error(...))` 桥接（替代原 `fetchList catch` 内 ElMessage 路径，`usePartsListQuery.ts:334-336`）。
     - 测试环境用 `vi.mock('element-plus', () => ({ ElMessage: { ...vi.fn() } }))` 桩成 no-op，避免 vitest node env `ElMessage` 内部 `normalizeAppendTo` 触发 `ReferenceError: document is not defined` 污染输出。
- **TanStack Query 缓存时长策略（2026-09-30 起）**：TanStack Query 在本仓的定位降级为「**短时请求去重层**」，**不承担数据新鲜度保证**。这一条与上条「TanStack Query 数据获取架构」的关系：架构条目里的 queryKey 工厂 / Zod 守门 / reactive params / enabled 闸门 / fetchList 别名 / mutation 范本 / ElMessage 桥接全部继续有效，**只有**缓存时长与「失效保证一致性」这一假设被本条取代。
   - **共享基础数据层**（`src/composables/queries/`）一律用**有限的** `staleTime` / `gcTime`，**不再用 `POSITIVE_INFINITY`**。当前统一取值 `staleTime: 30_000`（30s 短时去重窗口）/ `gcTime: 5 * 60 * 1000`（空闲缓存保留，必须 `>= staleTime`）：30s 内切 tab / 切日期 / 反复进详情命中缓存不重发；超 30s 的访问自动 refetch。覆盖 `useCustomersQuery` / `useProcessesQuery` / `usePendingBatchesQuery` / `useWorkerPoolCountsQuery` / `useWorkerPoolByProcessQuery` / `useWorkerStateByWorkerQuery`。
   - 选 30s 的依据：用户操作间隔（送检 → 切回队列页）通常 > 1min，必触发自动 refetch；同页内切 tab 是秒级，30s 足以去重。对照仓内两套先例——`useDashboardUpcomingList.ts:80` 的 `staleTime: 30_000`（措辞框架最接近本策略）被采纳为基准；`usePartBatchesQuery` / `usePartFilesListQuery` 的 20min / 30min 是**派生视图域**特例（图纸/3D 几乎不变），不适合会被生产流转改动的候选池 / 工序 / 客户基础数据。
   - **跨页面写操作不再使用「精确失效」策略**：会改变工序候选池成员资格的流转端点（送检 `POST /parts/batch-to-inspection`、worker-scan `RETURNED`、scan-inspect、outsource 收发）分布在 delivery / scan / inspection / outsource 多个域，要求在每个写点补失效等于穷举全仓写点，不可持续，因此**不做**这类补齐。数据新鲜度由 **WS 事件**或**显式 refetch**（如 `WorkerQueueBoard.onRefresh`）负责。
   - **现有 `invalidateQueries` 调用点全部保留、一行不删**：它们是「写完立即看到自己那笔」的优化，不是一致性保证。降级的是「依赖精确失效来保证一致性」这个**假设**，不是失效机制本身。
   - 页面级 store（`usePartsListStore` 等）走 `src/main.ts` 全局默认，**不在本条约束范围**；`views/dashboard/` 下的 WS 事件失效域 query 同理，沿用各自既有取值。
   - ⚠️ **例外仍在**：`views/dashboard/composables/` 下 4 个 query（`useDashboardSnapshot` / `useDashboardUrgentList` / `useDashboardOverdue` / `useDashboardUpcomingList`）用 `gcTime: POSITIVE_INFINITY`，是本条「不再用 POSITIVE_INFINITY」**唯一**的现存例外（它们靠 dashboard WS 事件失效，不靠 GC）。代价是**跨账号泄漏窗口无限大** —— 靠会话终止时的 `queryClient.clear()` 兜底，详见「`queryClient.clear()` 是跨账号缓存隔离的唯一手段」条目。**改这 4 个 query 的 gcTime 前先看那条条目。**
- **图表统一 vue-echarts 8.3（2026-09-30 起硬约束）**：仓内所有 ECharts 相关业务组件必须走 `vue-echarts`（peer deps `vue@^3.3.0` / `echarts@^6.0.0` 与本仓 `vue@^3.4.0` / `echarts@^6.1.0` 兼容）。模块化注册统一在 `src/plugins/echarts.ts`（按需 `echarts.use([BarChart, ..., CanvasRenderer])` + `import 'echarts/theme/v5'` 锁旧主题，避免拉全量 ~900KB bundle）；`main.ts` 通过 `app.component('VChart', VChart)` 全局注册，业务 SFC 直接写 `<v-chart :option="..." @click="onClick" />`。**禁止**在业务组件内 `import * as echarts from 'echarts/core'`（值导入）+ `echarts.init(el, 'v5', { renderer: 'canvas' })` + ResizeObserver + dispose 自写 mount 生命周期（2026-09-30 重构前 `UpcomingDeliveryChart.vue` 即此模式，已迁出）；**type-only import 不受限**（`import type { ECElementEvent, EChartsCoreOption } from 'echarts/core'` 是合法的，类型擦除不进 bundle）；历史兜底壳 `src/components/EChart.vue` 仅作为 option 全量替换薄壳，不在新代码中扩展其用法。

## 已知风险

- 依赖 `xlsx@0.18.5` 有原型污染 + ReDoS 高危漏洞（npm 官方无修复版本）。仅用于内部只读 Excel 解析（4 个 parser + 2 个视图统一收口，不执行公式/宏），攻击面可控。2026-08-21 决策保留，后续迁 SheetJS CDN 版或 exceljs。详见 [`docs/08-known-risks/dependency-risks.md`](./docs/08-known-risks/dependency-risks.md)。
