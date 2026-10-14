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

## 架构约定（硬约束）

### TanStack Query

`QueryClient` 在 `src/main.ts` 注册（pinia 之后、mount 之前），全局 `mutations.retry: 0` / `queries.retry: 0` / `queries.refetchOnWindowFocus: false`。**新增 mutation 不写 `retry`**，信任全局默认。`app.use(VueQueryPlugin)` 必须早于任何 store 实例化。

两层数据获取：

- **报工台（`views/production/scan/`，2026-10-10 接入）**：`composables/useScanListQuery.ts` 的 `useScanPickableQuery` / `useScanHeldQuery` + `composables/useScanWrite.ts` 的 `useScanPickUpMutation` / `useScanWorkerScanMutation`。`staleTime: 30_000` / `gcTime: 5 * 60 * 1000`（**gcTime 保持有限值** —— `POSITIVE_INFINITY` 是 dashboard 域靠 WS 事件失效才成立的例外，本域没有失效通道，GC 设无限会让「切走 5 分钟回来」命中陈旧持有件）。三条 list 与两条写共享 `qk.scanPickable` / `qk.scanHeld` 两条参数键 + 两条域前缀键（**不挂 `partsPrefix` 下**：与零件域没有共享写点，挂 parts 下会让最热的 `qk.partsPrefix` 一把全刷捎带扫码缓存）。**params 允许 `null`** ⇒ 占位键 + `enabled` 闸门 + queryFn 二次守卫（必需：过滤键后端必填、漏传是 400 纯文本）。两条 mutation 的 `onSuccess` **与 `onError`** 都失效两条前缀 —— 40901 OCC 恰恰意味着别人已把这批处置了，本端副本过期（理由同 `useQueueDispatch`）。
- **生产统计（`views/statistics/`，2026-10-12 接入）**：`composables/` 下三个 query hook —— `useStatisticsOverviewQuery.ts`（车间总览）/ `useStatisticsWorkersQuery.ts`（工人贡献度列表）/ `useStatisticsWorkerDetailQuery.ts`（单工人详情），守门 schema 与三者同居 `views/statistics/composables/statisticsSchema.ts`。键为 `qk.statisticsPrefix` 前缀键 + 三条参数键 `qk.statisticsOverview(params)` / `qk.statisticsWorkers(params)` / `qk.statisticsWorkerDetail(workerId, params)`，三条都以 `{ date_from, date_to }`（`StatisticsQuery`，`types/statistics.ts`）作尾部键位；`workerId` 走**独立键位**而不是塞进 params 对象 —— 端点按工人分片返回，不带 id 切工人会拿上一个工人的详情冒充当前工人。params 允许 `null` ⇒ 占位键 + `enabled` 闸门 + queryFn 二次守卫（后端两个日期是必填 `NaiveDate`，漏传是 HTTP 400 纯文本）。`qk.statisticsWorkers` **被两个 tab 共用**（工人表与单工人详情的工人下拉是同一份数据），同屏去重靠的就是这一条。**`qk.statisticsPrefix` 不挂 `partsPrefix` 下**：本域**自身**是纯只读域（三个端点全是只读、零写点），挂上去只会在零件域任何一次写操作后把三张报表一把全刷，而统计口径与零件状态流转无关（有效工时只取决于工单锚链上配的 `estimated_minutes`，不随某张零件进出流程变）。⚠️ **「本域自身零写点」≠「全仓没有东西会改本域读的数据」**：`qk.statisticsPrefix` 当前的唯一失效调用方在**域外** —— 序列号一键释放（`views/parts/list/composables/useSerialRelease.ts`，2026-10-19），它释放掉的 `serial_no` 正是本域行 VO 里**可空**的那一格（可空语义 = 「流水号已被释放」，见 `statisticsSchema.ts::workerPartItemSchema`）。将来本域出现写端点时同样走 `qk.statisticsPrefix` 一把全失效即可。
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

**statistics 域的 schema 归位（2026-10-12）**：`overviewOutSchema` / `workerStatsListOutSchema` / `workerDetailOutSchema` 三条守门 schema 都在 `src/views/statistics/composables/statisticsSchema.ts`，与三个 query hook 同居（`src/composables/queries/schemas.ts` 顶部留了一段**指针注释**说明去向）。**不做 re-export**：再导一层没有任何消费方 —— api 层只用 `import type` 取 `*Data` 派生类型标注返回类型，消费侧的组件直接从域内路径 import；多一个中转出口只会让读代码的人多一次「该 import 哪个路径」的判断，且迁进迁出时多一个要同步的地方。对应用例也一并搬到域内（`views/statistics/composables/__tests__/statisticsSchema.spec.ts`），api 层只留「不 parse」的负向守卫（`src/api/__tests__/statistics.spec.ts`）—— 这两条必须成对存在：缺 api 层那条，把 parse 搬回 api 层是零测试信号；缺 query hook 那条（`useStatisticsWorkersQuery.spec.ts` 的坏响应用例），把 parse 从 queryFn 删掉也是零测试信号。

### 送货单打印模板：两套版式与司机流程（2026-10-18 打印侧接线）

- **模板来源收口成一种**：`TemplateSource` 只剩 `api`（后端按**一级客户**绑定的那份）+ 预留的 `url`。管理员在「模板编辑」页（`/print-templates`，视图 `views/printTemplates/`）上传 / 替换 / 删除；打印对话框打开时按 `note.customer_id`（**它就是一级客户 id**）调 `GET /print-templates/resolve`，命中即取字节（`GET /print-templates/{id}/content`，带鉴权的 axios 端点，后端**没有** `content_url` 字段，别拼相对路径）。**打印页不再有上传入口，也不再逐格校验**。
- **逐格校验是「模板编辑」页上传闸的职责，也是全仓唯一的把关点**（`usePrintTemplatesStore::uploadChecked`）：先 `detectTemplateContract` 探版式，**判不出直接拒收**（提示说清「既不匹配零件版、也不匹配检具版」）；判出则 `assertTemplateMatches(wb, contract)` 按该契约逐格校验，**逐条差异必须留着上屏**。反过来在打印页再逐格验一遍拦不住任何新东西（模板入库时已过那道闸），只会让「管理员在 Excel 里改了一格」变成要联系管理员才能打印 —— 所以两处职责**不可互换**。
- **版式由前端锚点探测判定**（`deliveryNoteTemplate.ts::detectTemplateContract`，O(1)、不产生任何差异清单）：四条锚点 `B3==='{{order_no}}'`（零件）/ `B5==='{{order_no}}'`（检具）/ `F15` 含 `{{driver_name}}`（零件）/ `I2` 含 `{{delivery_date}}`（检具），都不中或缺 sheet 返 `null`。锚点坐标全部**从契约常量现推**（`PART_ANCHORS` / `GAUGE_ANCHORS`），不另写一份。后端模板行的 `kind` 恒是 `DELIVERY_TEMPLATE`、**不带任何版式信息**，所以版式只能这样判。
- **契约**在 `views/com/delivery/utils/deliveryNoteTemplateContract.ts`，两套用 `kind` 判别（`'part'` 零件版 / `'gauge'` 检具版）；`assertTemplateMatches` / `renderDeliveryNoteWorkbook` 分别以第 2 / 第 4 参吃契约，**默认参数是零件版**。列位 / 行区间 / 页脚占位符位置全部写死，**不做列位自适应**。`renderDeliveryNoteWorkbook` 的页脚形参是判别联合（`FooterFor<C>`，按契约 kind 反查）：零件版 `{ driverName, year, month, date }`（判别位可省）、检具版 `{ kind: 'gauge', deliveryDate }`（**kind 必填**），不配套编译期就报错、运行时抛中文错误。
- **零件版**（`templates/delivery_note_fala.xlsx`）：单 sheet 打印区 A1:J17、数据区 row3..12（**10 行/张**）、页脚 F15 送货人 + A17 送货日期。
- **检具版**（`templates/delivery_note_gauge_bailuda.xlsx` / `templates/delivery_note_gauge_xingnan.xlsx`，百路达 / 杏南各一份）：两行表头 row3-4、数据区 **row5..29（25 行）× A..I**、右上 I2 `{{delivery_date}}`（导出当天，`formatChineseDeliveryDate(new Date())` → `YYYY年M月D日`）；I 列 `{{system_delivery_date}}` 渲染成 `M月D日`。**C 列 `{{customer_path}}` 写客户路径**（第 2 层到叶子、不含 L1，取值 `li.customer_path || li.customer_name`）—— 它与零件版 C 列的 `{{l2_customer}}` 是**同一个值**，键名不同只因检具模板这一列是后来才放上占位符的；G「新制/返修」、H「NG/OK/校验备注」（客户约定送货厂家手填）**不写占位符**，渲染时清空留白。客户版式**没有单位列**，数量列 F 写裸数字。
- **打印对话框按探测结果分支**（`views/com/delivery/components/PrintPreviewDialog.vue`）：sheet 容量取 `templateContract.dataRowCount`（零件版 10 / 检具版 25，tab 下方的「容量 N/张」同源）、页脚按 `kind` 构造、**司机下拉只在零件版渲染**（检具版模板没有「送货人」页脚格，给了下拉也没有落点）。探测不出来 ⇒ 「导出」不可点 + **一句**提示指向「模板编辑」页，**不列逐格差异**。
- ⚠️ **导出时对刚取回的字节再探一次版式**：后端「同一客户再次上传 = 替换绑定」，所以对话框开着的那几分钟里绑定完全可能换掉，而导出取的是**新**字节、用的却是**打开时**那份契约 ⇒ 零件版的 10 行 × A..J 写进检具模板的 row3..12（盖掉两行表头）、四个占位符检具模板里一个都没有，产物留着字面量 `{{delivery_date}}` 且**零报错零日志**。所以 `onExport` 取字节后先跑一次 `detectTemplateContract`（仍是 O(1) 四格探测，**不是**逐格校验），`kind` 对不上或判不出即中止并提示关掉重开；这一步排在**司机落库之前**（复探不过是一次纯读取的失败，不该留下 driver 的 version 变更）。
- ⚠️ **迁移提示**：检具契约新增了 C 列 `{{customer_path}}` 这个**必填占位符**，2026-10-18 之前入库的检具模板在重新上传前会被上传闸判出差异 —— 现场表现是「点上传被拒 + 差异列表点名 C5」，不是故障。
- **司机**：打印**不再强制**指定司机（导出只 gate 模板与行项）。指定司机的强制点是**一键送货** —— 在送货确认对话框里选；选了先 `POST /{id}/driver` 再 `POST /{id}/pickup`（driver POST 推进 version，pickup **必须**用返回体里的新 version，否则 409）；单据上已有司机时可沿用、不重发 driver。**失败路径也失效本域** —— 「两条 POST 串一步」会出现 driver 成功而 pickup 失败（409 OCC / 21409 / 网络），此时本端缓存里的 version 与司机名都已过期，不刷就必然再吃一次 409（同「TanStack Query」一节报工台那两条 mutation 的 `onError` 失效）。

### 目录归位

- **报工台（2026-10-10 搬进 `views/production/scan/`）**：视图与 composables 域内自持（`components/` / `composables/` / `__tests__/`），与后端 `prod::scan` 域、生产队列域同款布局。api 在 `src/api/productionScan.ts` + `productionScan.contract.ts`（两级切分，照 `productionQueue`），守门 schema 在 `views/production/scan/composables/scanSchema.ts`。**四个页面共用四个域内组件，页面自己只留骨架与确认栏**：`PartRowCard.vue`（列表行 `.part-row` 的唯一模板 + CSS 实现，四页全用，含 `readonly`）、`ScanTopbar.vue`（顶栏 + `flowLabel` / `flowTagType`）、`PartDrawingPreviewDialog.vue`（图纸预览弹窗四分支 + 下载闸门 + blob 生命周期）、`QuantityDialog.vue`（提交前选数量）。这四者都只被报工台消费、零跨域消费方，与 `BatchPickerDialog` / `chainAccent.ts` 一样留在 `views/production/scan/components/`（不满足「零个域内依赖 + 多域复用」的上提判据 —— `BatchCard.vue` 那种 6 个跨域消费方才配得上 `src/components/`；`BatchPickerDialog` 还 import 了域内 `chainAccent`，上提只会造出一条 `components/ → views/` 的反向依赖）。局部 import，不进 `main.ts` 全局注册。`composables/useBarcodeScanner.ts` 留在原地（com/delivery、inspection、repair、outsource、parts/list、production/scan 六域共用的跨域工具）。**页面共 6 条**：`ScanActionPicker`（选流程）+ 取件 / 放回 / 送检三个动作页 + `ScanHeldParts`（只读「查看持有」，2026-10-11 由 `HeldPartsDialog` 改为独立页 `/scan/held`，路由与其余 5 条一样共用 `menuCode: 'scan_badge'`）—— 四页用 `PartRowCard` 三列网格，`ScanHeldParts` 那份传 `readonly`（整卡不可点、无选中态、无写操作）。**`useScanSession.worker` 用 4 字段的 `ScanWorkerBriefDto`、不是 `@/types/worker::Worker`**：后者是账号管理页那个 12 字段 `WorkerOut` 镜像（后端未删，仍在用），扫码链路一个额外字段都不用，沿用宽 VO 只会让消费侧以为还有 `version` / `is_active` 可读。两个 VO 在运行时都是「扫工牌拿回来的那个对象」，`ScanWorkerBrief` 的 4 个字段又是 `Worker` 的子集 ⇒ 换类型不产生任何编译期/运行时信号，回归保护见 `views/production/scan/composables/__tests__/useScanSession.spec.ts`。
- **⚠️ 报工台的路由 path 与后端 URL 不一致是有意的，且 path 不会跟着视图目录一起搬**：路由仍是 `path: 'scan/*'` / `menuCode: 'scan_badge'` —— path 是浏览器可见的书签 URL，同时是后端菜单表 `scan_badge` 节点的 `path` 字段，改它会断掉用户已收藏的链接与菜单下发；后端 URL 已是 `/api/v2/prod/scan/*`（2026-10-10 硬切）。搬目录只改 `component` 的 import 路径。**⚠️ 部署顺序：后端必须先上** —— 两条 list 的过滤键由 path 改成必填 query（漏传或发数字 → axum `QueryRejection` → **HTTP 400 纯文本**，不进 `R<T>` 信封），旧 URL 直接 404，`verify-badge` 那条更隐蔽（路径还在但 method 变了 → 405）。失败发生在网络层而不是 Zod 契约层，现场只看到一句 axios 错误，报工台三页 + 徽章同时空白。
- **域内列定义**放 `src/views/<域>/<name>ColumnDefs.ts`（域根，与页面主组件同级），**不放 `src/utils/`** —— 单域专用文件不是通用工具：它 import 域内 composable 类型会让 `utils/` 反向依赖 `views/`（层次倒挂）。
- **`src/utils/` 只放跨域通用工具**（举例，非全量清单：`fileExt` / `date` / `jwt` / `download` / `pdfjs` / `elTable` / `dndSourceTracker` / 各 `ExcelParser` / `permissions`）。判据是「零个域内依赖」+「多域复用」，不是「看起来像工具」。
- **api 层引域内 schema 的口径**：默认用 `import type`（编译期擦除，照 `api/dashboard.ts` / `api/programming.ts` / `api/parts/batch.ts`）；运行时值引入只允许出现在**没有 queryFn 承载**的守门点 —— 典型是走 useMutation 的单次拉取（`api/inspection.ts` 的扫码树 `inspectionScanTreeSchema.parse`）。这与上面「`utils/` 不得反向依赖 `views/`」是两条不同的禁令：后者禁的是**通用工具**引**单域实现**；api 层引自己域的 schema（含守门 schema 归位后的唯一运行时边 `api → views/inspection`）是允许形态。
- **货架管理（2026-10-10 迁入 iam 域）**：视图在 `src/views/iam/shelves/`，**api 仍在平铺的 `src/api/shelves.ts`** —— `src/api/` 是按前端实体扁平放置、不按后端模块分层（见 `api/shelves.ts` 文件头）。⚠️ **`views/iam/` 与 `views/users/` 的不对称是有意的、不是漏搬**：`users`（账号管理）自 v1 起就在根下，是历史遗留；货架管理是 2026-10-10 新迁的，只规定**新代码**按域进 `views/iam/`，不回头搬历史目录。看到 `views/users/` 仍平铺不必"顺手修正"。
- **前端路由 `/shelves` 与后端 URL `/api/v2/iam/shelves` 不一致是有意的**：路由 path 是浏览器可见的书签 URL，同时是后端菜单表 `shelves_list` 节点的 `path` 字段（见 `src/composables/__fixtures__/adminMenus.ts`），改它会断掉用户已收藏的链接；后端 API URL 是另一层。两者不要求一致，看到「前端 /shelves、后端 /iam/shelves」不是漏改。

### 客户无限层级（2026-10-17）

客户树从「固定两层（集团 / 分厂）」放开到**任意深度**（集团 / 分厂 / 车间 / 班组…），前后端同批发布。整域契约文档：`backend-rust/docs/api/customers.md`。

- **`customer_path` 的口径**：第 2 层到叶子的名称用 `" / "` 拼接，**不含 L1**；节点自身即 L1 时等于它自己的 `name`。**必填键、值非 null** —— 客户行解析不出（软删 / `parent_id` 链成环）时后端落**空串**，展示层必须兜底退回单段名。
- **`parent_customer_name` / `l1_customer_name` 的语义变了（破坏性）**：不再是「直接父名」，而是「**根（L1）客户名**」。字段名还叫 `parent`，读代码时别按名字理解。`api/assembly.ts::enrichAssemblyItem` 仍按客户行的 `parent_name` 填装配件的 `parent_customer_name`（装配件 VO 不返根名），这是已知的不对称。
- **返修域是「值承载变了、键名没变」的那一类特例**：返修行 VO（`prod::batch::vo::RepairBatchListItem`，前端镜像 `api/parts/batch.ts::RepairBatchListItem`）**没有**新增 `customer_path` 键 —— 后端让**已有的 `customer_name` 承载路径**（第 2 层到叶子的 ` / ` 拼接、不含根），`l1_customer_name` 承载根名。**键集没变 ⇒ `.strict()` 不受影响**（不会像别的域那样一改就白屏），但**任何按「`customer_name` 是单段名」写的代码都错了**：`views/repair/RepairReceive.vue` 的「客户」列按 `l1 + " / " + customer_name` 组合，得到的就是全路径（两层树时与旧值逐字相同，深度 ≥ 3 才显出差别）。判据落在「字段的值」而不是「字段名」上，别照别的域去给它补一个 `customer_path` 键 —— 那才会触发 `unrecognized_keys`。
- **单据只能挂叶子**：中间层不能当业务单据的客户。**判据是「有没有子节点」，不是「`parent_id !== null`」** —— 后端 `require_leaf_customer` 与前端都统一到这一条（旧口径是两层树的等价写法，深度 ≥ 3 时会把第 3/4 层全放进候选、选中即被拒）。前端的四个纯函数收口在 `src/api/customer.tree.ts`（`buildCustomerTree` / `rootCustomerIdOf` / `leafCustomersOf` / `leafCustomersUnder`），**任何「根客户 / 叶子客户」判定都走它们**，不要就地写 `parent_id !== null` 或「只上溯一层」。
  - **`leafCustomersOf` 与 `leafCustomersUnder` 只差一个作用域**：前者给**全树**的叶子，后者给「所选根那一支子树内」的叶子（入参带 `rootId`，与前者同一份「parent_id → children 索引 + 显式栈 + `seen` 断环 + 按 id 去重」口径）。**「先选一个根、再从它下面选」的下拉一律用后者** —— 写完再按 `root_id` 过滤前者的结果要先拼整棵树（`buildCustomerTree`），贵一个量级，且脏数据口径要多一处同步。现有两处消费方：零件 PDF 批量上传的行内客户列（`usePartBatchPdf.ts::leafCustomerOptions`）、送货单扫码台的**送货分组成员候选**（`views/com/delivery/DeliveryNoteScan.vue::leafCustomerOptions`）。守卫见 `api/__tests__/customerTree.spec.ts` 的 C10 组 + `views/com/delivery/components/__tests__/DeliveryGroupEditor.leafCandidates.spec.ts`。
  - ⚠️ **送货分组成员候选必须是叶子、不是「L1 的全部后代」**：后端 `validate_group_members` 放宽到「L1 的任意后代」，但零件只挂在叶子上（入单叶子闸门 20104），**且送货分组唯一的消费方是打印分页**（`views/com/delivery/utils/deliveryNotePrintRows.ts::buildL2GroupMap` 按成员的 `customer_id` 建映射，打印行项用自己的**叶子 `customer_id`** 去查）⇒ 候选里放中间层匹配不到任何行项，白占一个成员位。
- **展示位统一走 `src/utils/elTableCell.ts::renderCustomerCell`**（主行 `customer_path` + 次行 L1；消费方跨 5 个域，调用点数随新列定义增长，**别在注释里数它**）。送货单**打印预览表刻意不共用**（保持单行并自己渲染 `PrintRow.l2_customer`）—— 它必须与导出到 xlsx 的单格文本逐字一致。
- ⚠️ **部署顺序：后端必须先上。** 本批把多个 `customer_path` 加成守门 schema 的**必填键**，反序发布时 `parse` 当场抛 ZodError ⇒ 对应页面数据恒空 / 白屏。**失败发生在 Zod 契约层而不是网络层**，现场常常只看到一句「加载失败」甚至零红色报错。点名的必填键：

  | schema | 影响面 |
  |---|---|
  | `composables/queries/schemas.ts::customerSchema` | 全站客户筛选器 + 客户一览页空白 |
  | 同上 `::partSchema`（`GET /com/union-list`） | 零件一览整页数据恒空 |
  | 同上 `::assemblyOutSchema` / `::assemblyDetailFlatSchema` | 装配件详情页 / `PartAssemblyLinkCard` 白屏 |
  | `views/parts/detail/composables/partDetailSchema.ts` | 零件详情页 |
  | `views/inspection/composables/inspectionSchema.ts` | 待品检页（队列行 `.strict()`）+ **品检扫码树**（`inspectionScanPartSchema` / `inspectionScanAssemblySchema`，守门在 `api/inspection.ts::scanInspection` 的 parse ⇒ 缺键时扫码弹窗整个打不开） |
  | `views/cnc/composables/pendingProgrammingSchema.ts` | 待编程一览 |
  | `views/dashboard/composables/dashboardSnapshotSchema.ts` | 大屏聚合 + 两张抽屉 |
  | `views/com/delivery/composables/deliveryNoteSchema.ts` | 送货单域 |
  | `views/production/queue/composables/productionQueueSchema.ts` | 生产队列域：`queuePoolItemSchema` / `queueHeldBatchSchema` / `queuePendingBatchSchema` 三条 ⇒ 工序板（候选池 + 工人列）与待下发面板全空 |
  | `views/outsource/composables/outsourceQueueSchema.ts` | 外协看板：`outsourceQueueCandidateSchema` / `outsourceQueueHeldBatchSchema` 两条 ⇒ 单工序看板（候选池 + 公司列）全空 |
  | `composables/queries/schemas.ts::quotablePartSchema`（`GET /outsource-quotes/quotable-parts`） | 报价一览的**可报价零件 picker 恒空** ——⚠️ 这条的守门点在 **api 层**（`api/outsource.ts` 的 `outsourceQuotablePartListResultSchema.parse`，该端点由 shell 的 `loadLookups()` 裸调、**没有 queryFn 承载**），不按 schema 所在文件找会以为它走 queryFn |

  ⚠️ **「反着来」（漏声明）同样是事故，只是没有任何报错**：本批第一轮就把上表最后两行的
  `customer_path` 漏在了 schema 之外 —— Zod 默认 strip 把它静默丢掉、parse 全绿，
  `queueItemToCard.ts` / `outsourceItemToCard.ts` 的 `customer_path || customer_name`
  于是永远走右半边，五条卡片链路的 tooltip「客户」行集体退回单段名，**typecheck 与 lint
  都绿**（当时 DTO 侧还声明成可选，两边形状对不上也无人报错）。补声明的同一次改动里要
  一并把「缺键 → 抛」与「parse 后拿得到值」两条断言写上，否则下一次漏声明仍然是零信号。

- **`.strict()` 的对称代价**：`assemblyDetailFlatSchema` 是 `.strict()` 的，**后端每给行 VO 加一个键而前端没同步补声明，整条链路当场白屏**（2026-10-17 的 `customer_path` 就这么漏过一次：详情页 / `PartAssemblyLinkCard` 全挂）。strict 的其它行 VO 同理。守卫见 `schemas.spec.ts` 的 S15b（少键必抛）/ S17b（多键必抛）—— 两条都在，这轮回归才被当场抓住。
- **漏声明 = 静默降级，不是报错**：非 strict 的 schema 漏声明 `customer_path` 时 parse 全绿，只是展示位无声退回「单段名 + L1 次行」。新增必填列要在同一次改动里把 schema、TS 类型、展示层三条一起对齐。

#### 用户可见文案变更清单（2026-10-17，**未经产品确认**）

这批改的是**列 label / placeholder / hint / 报错文案**，理由是「二级」「分厂」「一级 / 二级」这类带层级数或中间层名的叫法在任意深度树上直接说谎。**产品要回退，看这张表逐条改回即可**（列 `key` / localStorage 快照 key 一律没动，回退 label 零风险）。

⚠️ **表里每一行的「改前」都能在 `git show 9e4fd15:<文件>` 里检索到**（本分支的真实基线）—— 写这张表的唯一用途是让产品照着改回去，出现「改前」根本不是历史字符串的行等于这条回退路径不可操作。同一条改动在不同文件里的字符串**不要求逐字相同**（下面第 2 行就是两段），按文件分列。

| 位置 | 改前 | 改后 |
|---|---|---|
| `components/BatchCard.vue` tooltip 两行 label | `客户(L1)` / `客户(L2)` | `客户(集团)` / `客户` |
| `views/parts/list/partsListColumnDefs.ts` / `views/inspection/inspectionColumnDefs.ts` 客户筛选 hint | `选一级客户自动级联其下二级客户` | `选中任一层级的客户，自动包含它与其下全部子客户（后端按客户子树展开）` |
| `views/outsource/outsourceQuoteColumnDefs.ts` 客户筛选 hint | `选一级客户自动级联其下二级客户（后端按客户子树展开）` | `选中任一层级的客户，自动包含它与其下全部子客户（后端按客户子树展开）` |
| `views/parts/new/components/PartBatchPdfTab.vue` 客户列头 / placeholder | `分厂` / `选分厂` | `客户` / `选末级部门` |
| `views/parts/new/components/PartEntryFormDialog.vue` placeholder | `选择一级 / 二级客户` | `选择客户（末级部门）` |
| `views/assemblies/components/AssemblyEditDialog.vue` placeholder | `选择二级客户` | `选择末级客户` |
| `views/com/delivery/deliveryNoteLineItemsColumnDefs.ts` 列 label | `客户（二级）` | `客户` |
| `views/com/delivery/deliveryNotePrintColumnDefs.ts` 列 label | `分厂` | `客户` |
| `views/customers/CustomerList.vue` 新建/编辑弹窗「父客户」行 | 可编辑 `el-select`，placeholder `不选 = 一级客户；选了一个一级客户 = 二级`（编辑模式下能改父客户） | 只读 `el-input` + hint `客户层级不可移动；如需调整请删除后在目标父节点下重建。`（编辑模式不再能改父层级，newChild 模式显示完整祖先路径） |
| `views/customers/CustomerList.vue` 删除确认框后代计数 | `（一级客户「X」仍有 N 个二级子节点，删除将一起拒绝）` | `（客户「X」下仍有 N 个子节点，删除将被拒绝）` |
| `views/parts/new/composables/usePartBatchPdf.ts` 三处报错 | `以下 N 行未指定分厂（二级客户），请补全后再提交：` / `第 i-j 行（分厂 xxx）：` / `N 个分厂组请求失败` | `以下 N 行未指定客户（单据只能挂在末级部门），请补全后再提交：` / `第 i-j 行（客户 xxx）：` / `N 个客户组请求失败` |
| `views/com/delivery/components/DeliveryGroupEditor.vue` label / placeholder / hint | `L2 成员` / `选择该一级客户下的 L2 客户（可空）` / `扫码时如果工件的 L2 客户命中这里任一成员，将按 GROUP 路由到本分组对应草稿。` | `分组成员` / `选择该一级客户下的末级部门（可空）` / `打印送货单时，同一分组的成员归入同一组打印页（组内行数多时再分页），各分组之间不混页，便于按收货单位拆单。` |
| `views/com/delivery/components/DeliveryGroupPanel.vue` 空态 / 未分组行标题 | `该一级客户下还没有 L2 客户` / `未分组 L2` | `该一级客户下还没有末级部门` / `未分组` |
| `views/com/delivery/components/DeliveryGroupPanel.vue` 删除确认框后半句 | `该分组下的 DRAFT 草稿将不再路由。` | `该分组下的客户会回到未分组，打印时各自独立成页。` |

⚠️ **上表 `DeliveryGroupEditor.vue` 那行的「改前」hint 本身也是一句假承诺**：它在基线里就写着「将按 GROUP 路由到本分组对应草稿」，而送货单草稿只按 `customer_id`=**L1** 查（扫码台拉草稿的 query 只有 `statuses=DRAFT` + `customer_id=l1Id`），全仓 `delivery_group_id` 零引用 —— 后端早已没有「按 GROUP 找草稿」的能力。**真要回退这一行，别把这句原样装回去。**

**本批新增、改前无对应字符串的用户可见文案**（回退它们等于回退行为，不在上面的「改文案」表里，单列在此免得漏看）：

| 位置 | 文案 | 为什么是新增 |
|---|---|---|
| `views/parts/new/composables/usePartBatchManual.ts` 提交校验 | `「X」还有下级部门，单据只能挂在末级部门` | 改前**没有**前端这道闸：中间层客户能选中、能提交，由后端返 20104 拒收。回退 = 删掉这段校验（连带 `leafCustomersOf` 那一次判定），不是换个说法。 |
| `views/com/delivery/DeliveryNoteScan.vue` 送货分组成员候选 `leafCustomerOptions` | 候选 = 所选 L1 **子树内的叶子**（`leafCustomersUnder`） | 这不是文案，是**行为**：改前是「所选 L1 的**直接子**」。后端两条契约都放宽到任意深度了（`list_for_l1` 的成员名 / `ungrouped_customers` 走 `subtree_ids` + `paths_of`；入单侧新增叶子闸门 20104），前端停在「直接子」就是功能死结 —— 零件挂在 L3 叶子上、候选只有 L2（中间层）⇒ ① 面板「未分组」tag 里看得见的 L3 叶子在编辑器里**选不到**；② 送货分组只服务打印分页，而打印行项按自己的**叶子 `customer_id`** 去匹配分组 ⇒ 中间层成员匹配不到任何行项，白占成员位。回退 = 把候选换回 `c.parent_id === l1`，那会把这两条一起带回来。 |

⚠️ **有一处 hint 刻意没跟**：外协发出零件的表头 hint 仍是「只判零件直属客户等值」—— 那个端点的筛选语义确实是等值，不是子树，跟着展示一起改会把筛选语义讲错。

### 序列号一键释放（2026-10-19 新立域）

现场残留大量已完成 / 已取消工单仍占着序列号（装配件尤其多），号池被死号压住、新建工单拿不到号。新增 MANAGER 专属的**全局一键**清理工具（入口在零件一览页工具栏），**破坏性、不可撤销**。

- **三条文件各归其位**：api 在 `src/api/serial.ts`（文件名取前端实体「序列号」，同 `shelves.ts` 的扁平惯例 —— 本端点同改 `t_assembly` + `t_part` 两表，塞进 `assembly.ts` 会误导）；守门 schema 在 `views/parts/list/composables/serialReleaseSchema.ts`（域内，与消费它的 `useSerialRelease` 同居）；`useSerialRelease.ts` 挂在 `usePartsListStore` 的 `serialRelease` 切片上，**刻意与 query / filters / batch 零耦合**（后端全表扫，不吃筛选 / 分页 / 勾选，挂上去会让人误以为释放范围与当前列表有关）。
- **判据是角色不是权限点**：`auth.hasRole('MANAGER')` 内联、无常量文件，理由见「RBAC」一节新登记的那一条（后端只有 `require_role(Role::Manager)`，RBAC 面板里没有 `serial.*` 码）。
- **两段式破坏性流程的必备三件**：① `dry_run: true` 先预览，**只有拿到经守门的响应才开对话框**（预览失败时对话框内容没意义，让管理员在空框上点「确认释放」比不弹更危险）；② `preview` 快照的**唯一清位点**是 `previewOpen` 上的 watch（显隐一落 false 就清）—— 右上角 × 只 emit `update:modelValue` 不发业务事件，清位若漏在调用方 wiring 上，就会留下一份「已消费的明细」被将来的重开路径重新摆给管理员看；③ 确认按钮的 `:disabled` **不是唯一闸门**，`onConfirmRelease` 里也设一道（无 preview / `released_total === 0` ⇒ warning + 零请求），本仓对不可逆动作一律「函数里也设一道闸」（同 `useQueueMove`）。
- **后端 `dry_run` 是危险默认值**：它带 `#[serde(default)]` ⇒ **空 body 等价于真跑**（后端 dto.rs 自称已知风险）。前端因此在 apply 路径上**比对出参回显的 `dry_run === false`**，不符即抛（走既有 onError：失效 + 报错），绝不照常弹「已释放 N 个」—— 回显错位时报成功等于对管理员说谎。同一份守卫见 `api/serial.ts` 文件头与 `useSerialRelease.spec.ts` 的 U10。
- **WS 事件 `TERMINAL_SERIALS_RELEASED` 进 `AFFECTS_DASHBOARD` 白名单**：它是**纯汇总事件**（payload 只有 `assembly_count` / `part_count` 两个计数、无 id 列表、无展示字段），不能让某一行就地消失，但不改白名单的话常驻大屏会静默停在释放前的状态（三 query 都是 `gcTime: POSITIVE_INFINITY` + 无 `refetchInterval`，只有 WS 事件与共屏失效两条通道）。元素数守卫在 `useDashboardInvalidation.spec.ts` 的 I1。
- ⚠️ **部署顺序是双前置**：① 后端 `serial` 域所在的分支要先进主干（2026-10-19 该域只在后端 worktree 上，根 checkout 里**没有** `src/modules/serial/`）；② 合并后再上前端。反序时点按钮只拿到 404 + 一句 axios 错误，不会破坏本页其它数据。跨仓字段对账（真读后端 `dto.rs` 的字段集 / 判别位大小写 / 可空性）见 `src/api/__tests__/serial.contract.spec.ts` 的 V 组，本机读不到后端仓时整段跳过并打 `[跳过]` 提示。

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

### RBAC（角色权限面板，2026-10-14）

- **`hasRole` / `hasPermission` 对 ADMIN 元角色通配**（`stores/auth.ts`）：`roles` 含 `'ADMIN'` 时两者对任意参数返回 true。**新增任何直接读 `roles` 数组做权限判定的消费方都会绕过通配** —— 枚举精确匹配对纯 ADMIN 账号全 false，表现为「有权限却全站无入口」且不报错；一切角色 / 权限点判定走 `hasRole` / `hasPermission`。
- **`CurrentUser.permissions` 是必填 wire 契约**（`views/auth/sessionSchema.ts` 显式声明）：后端恒下发该键，前端闸门按它判；旧 localStorage 里的用户对象由 `stores/auth.ts::loadFromStorage` 补 `?? []`（迁移补丁，不是 wire 兜底）。**部署顺序：后端必须先上** —— 反序时登录与 `/iam/me` 的守门 `parse` 抛 ZodError ⇒ 全员被踢登录页循环。
- **读侧 vs 写侧 schema 的 strict 口径相反**：会话链路（`views/auth/sessionSchema.ts`）刻意**不** `.strict()`（后端加派生字段不该让所有人登不进去）；RBAC 面板（`views/iam/roles/composables/rbacSchema.ts`）接 `.strict()`（写侧多一个字段即抛 —— 授权清单悄悄多 / 少一项就是一次没被看见的授权决定，必须当场红）。
- **权限点闸门（2026-10-15 第二批后共 20 个码）**：常量按域分文件 —— `utils/partsPermissions.ts`（1 个：`part.drawing.print`：零件详情文件页打印 / 报工台图纸预览下载闸 / 零件一览批量打印栏）、`utils/deliveryNotePermissions.ts`（2 个：`delivery_note.view`：送货单查看读点，前端不加按钮闸；`delivery_note.print`：送货单打印入口；**前端-only** —— 后端打印端点已下线，纯由面板控制）、`utils/productionPermissions.ts`（12 个：`production.view` / `production.config` / `queue.view` / `queue.dispatch` / `queue.recall` / `queue.allocate` / `batch.split` / `batch.transition` / `batch.deliver` / `batch.cancel` / `batch.repair` / `inspection.view`）、`utils/outsourcePermissions.ts`（5 个：`outsource.view` / `outsource.quote.edit` / `outsource.quote.approve` / `outsource.move` / `outsource.company.manage`）、`utils/printTemplatePermissions.ts`（**0 个权限点、1 个角色码**，2026-10-16 送货单打印模板新增：⚠️ **本域判据刻意是「角色」不是「权限点」** —— 后端 `/api/v2/print-templates` 的列表 / 上传 / 软删三条端点全是 handler 层 `require_role(Role::Manager)`，RBAC 面板里没有任何 `print_template.*` 码，自造一个就是「前端比后端宽/窄」的分叉；将来后端真的加了权限点，这里再改判据并同步后端种子。页面的**入口**可见性另由路由守卫的 `meta.menuCode = 'print_templates_designer'` 单查菜单树决定 —— 守卫管「能不能进页面」，本文件管「页面上哪些按钮可点」，两者都成立才有效）。读点（`production.view` / `queue.view` / `inspection.view` / `outsource.view` / `delivery_note.view`）由后端权限与菜单共同决定，**前端不加按钮闸**；`batch.deliver` 本批无 UI 闸。凡有后端端点闸的写点，前端跟着读同一个码做入口显隐，才不会出现「可见却 403」/「授权了却看不见」的分叉。
- **消费方一览（2026-10-15 第二批）**：`production.config` → 工序映射「保存映射」（`ProcessWorkTypeMappingTab`；⚠️ **`ShelfList` 的「保存货架」刻意不加此闸** —— 它把货架基本字段（后端 MANAGER 角色守卫）与工序映射（`production.config`）耦合在一次保存里，加闸会造成「MANAGER 被撤点后货架无法保存」）；`queue.dispatch` → 队列「发送到工序」（右键菜单 + `PendingPoolCard` 点击/拖入 + `PendingBatchesPanel`「自动下发」按钮）；`queue.recall` → 队列召回（`useQueueRecall.canRecall` + 右键菜单）；`queue.allocate` → `useQueueMove` 三个 move 包装与 `runAutoAllocate` 入口；`batch.split` → 队列/外协看板「拆分批次」、零件详情批次监控「拆分」；`batch.transition` → 待品检操作列（品检通过/指定工序）与扫码树弹窗**四按钮**（品检通过/指定工序/送检/**强制送检**；⚠️ **强制送检沿用同一道 `canTransition` 闸门、无新增权限点** —— 后端强制送检与普通送检**同端点** `POST /api/v2/prod/batches/{batch_id}/to-inspection`、**同权限点** `batch.transition`，差异只是可选入参 `force: true`，缺省时行为逐字不变）、零件详情操作栏「品检通过/指定工序」（`usePartDetail.canInspect`）；`batch.cancel` → 零件详情批次监控「取消」；`batch.repair` → 返修接收「返修」列 + `RepairStartDialog.onSubmit`；`outsource.move` → 外协收发两个包装（`useOutsourceQueueMove`）；`outsource.quote.edit` / `outsource.quote.approve` → 报价一览操作列与 `actionColumnWidth`（`canWithdraw` 已删：报价 withdraw 端点下线、不可实现）；`outsource.company.manage` → 外协公司「新增/编辑/删除」（「对账」是只读跳转，不加闸）。
- **行为变更登记（2026-10-15）**：① `useQueueMove`（`queue.allocate`）与 `useOutsourceQueueMove`（`outsource.move`）从**零闸门**转为包装入口早退 —— 改前队列侧拖拽 / 右键两条路径均不设防，外协侧拖拽不设防（右键「回收生产」当时由看板菜单侧的角色版 `canMove` 先闸：MANAGER / CLERK / INSPECTOR），两域都在后端提交时以 403 兜底；改后无权账号在包装入口早退（warning + 零请求，早退沿用既有失效对账路径）。② 该闸**有意放宽在写包装内、不 gate 菜单派生层**：队列右键菜单的「派给工人 / 转交给工人」仍按目标集渲染，点击才提示无权限（拖拽路径没有可隐藏的入口）；板级「空菜单是不是权限造成的」判定（`QueueBoard.byPermission`）已把 `queue.allocate` 一并算上，避免把「只授了移动权限」误报成无权。③ 配套迁移：`queue.recall` / `batch.split` / `batch.transition` / `batch.repair` / 外协报价五个判定从角色集改判权限点（外协 `canCreate` / `canEdit` / `canApprove` / `canReject` / `canSoftDelete` 保留角色形参签名但不再参与判定，沿 `partsPermissions.ts` 的 `void role` 形态）。
- **「0 权限点 / 1 角色码」域闸共 2 个（2026-10-19 起）**，判据与理由完全同款 —— 后端端点只有 handler 层 `require_role(Role::Manager)`、RBAC 面板里没有对应码，自造一个权限点就是「前端比后端宽 / 窄」的分叉；将来后端真的加了权限点，再改判据并同步后端种子。**看清两者形态不一样**：
  - `utils/printTemplatePermissions.ts` —— **有常量文件**（`canManageTemplates`），因为该域有三条端点 + 一个独立页面要复用同一个判定；
  - `views/parts/list/composables/useSerialRelease.ts` 的 `auth.hasRole('MANAGER')` —— **内联、无常量文件**，因为序列号一键释放是单域单端点、单入口（`serialRelease` 切片已挂在 `usePartsListStore` 上），把一行判定抽成 `utils/serialPermissions.ts` 只会多一层没有第二个消费方的中转。
  ⇒ **全仓 `utils/*Permissions.ts` 里永远不会有 `serial.*` 码**，下一个要给序列号域加动作的人别去找（那是本条登记的唯一目的）。
- **部署顺序与存量会话**：后端必须先上（`/iam/me` 与登录响应里的 `permissions` 才含新码）；**存量会话（localStorage 缓存的 user 对象）要刷新或重登**才会拿到新权限点 —— 否则非 ADMIN 账号全部新闸门恒 false，入口集体消失且零报错（读点页面本身也由后端权限与菜单共同决定）。
- **⚠️ 部署顺序：送货单打印模板域（`views/printTemplates/`，2026-10-16 新立）前后端必须同批发布。** 本域与上面货架（`capacity` / `current_load`）是完全同构的故障：`printTemplateSchema` 是 `.strict()` 且 `customer_name` **必填**（键恒在、值可空），而后端 `print_template/vo.rs` 的行 VO 在 2026-10-16 review 第 2 轮才补上该字段 ⇒ **旧版本后端不返这个键**，上传（201 的 body 一样）/ 列表（每行）/ 打印对话框自动选用**三条路径同时**抛 ZodError。**表现是静默的**：列表恒空 + 每次弹「加载失败」，打印对话框的自动选用集体失败（一行 12px 黄色小字 + 一行 `console.warn`、零 toast —— 见 `printTemplateSchema.ts` 文件头「读侧 vs 写侧」一节与 `PrintPreviewDialog.vue` 的 catch 分支），上传那一支最阴：`uploadPrintTemplate` 是「先 POST 落库、再 `parse` 出参」，所以字节其实**已经存进库了**，前端才抛 ZodError 并弹一个报错出来。排障时先怀疑部署顺序，别去查配置、别去查权限（本域的判据是 `utils/printTemplatePermissions.ts::canManageTemplates` 的角色码，与权限点无关）。⚠️ **刻意不加 wire 兜底**：`customer_name` 没有改成 `.nullish()`，那会把上述**响的**失败换成一种更隐蔽的静默降级（客户列恒显示「（已删除的客户）」），与本文件上面四处（报工台 / `CurrentUser.permissions` / RBAC 存量会话 / 货架）一贯「写清部署顺序、不放松 schema」的处置相悖 —— `views/auth/sessionSchema.ts` 那条 `?? []` 之所以被标注成「迁移补丁，不是 wire 兜底」，正是同一条纪律。字段真源与跨仓对账见 `src/api/__tests__/printTemplates.contract.spec.ts` 的 V7 组（真读后端 `vo.rs`，本机读不到后端仓时整段跳过并打 `[跳过]` 提示）。

### tagsView per-user 持久化

`src/stores/tagsView.ts` 自管 localStorage，key 为 `myerp.tags_view.<userId>`：同账号重登恢复标签栏，换账号互不可见。归属切换唯一入口 `switchOwner(userId)`，由 auth 的 `setUser()` 驱动；登出走 `switchOwner(null)`（只清内存、**不写盘**）。**store 初始化不读 localStorage**，hydrate 只由 `switchOwner` 触发。`pinia-plugin-persistedstate` 已卸载（它的 key 入参是 storeId，做不到 per-user 隔离）。

### dashboard WS 单例

`src/api/dashboard.ts` 是全仓唯一 WS 入口（`createGlobalState` + VueUse `useWebSocket`），承载 `/ws/dashboard?token=<jwt>`。

- **URL 用模块级 `shallowRef<string | undefined>` + 显式 `syncWsUrl()`，不用 `computed`**（computed 会缓存住旧 token，logout→重登后仍握吊销 token → `40105` 死循环）。
- **`undefined` 是「无 token 不要连」的哨兵**。禁止无 token 时拿裸 URL 握手（后端必回 `40100`，是无意义重试刷屏的来源）。
- **重试不封顶**（`retries: -1`，退避 1s→10s 封顶），失败日志前 3 次完整诊断、之后每 30 次一行。WS 是 dashboard 唯一更新通道，封顶重试会让页面静默停更。诊断输出：脱敏 URL（`token=***`）/ closeCode + reason / hadErrorEvent / tokenExpired。
- **关闭码分流**（逐行契约表在后端 `docs/api/dashboard.md` §7.1「关闭码表」：code × reason × 发出点 × 前端应做什么；`4001` 的判定收在 `src/modules/dashboard/handler.rs` 的纯函数 `reauth_close_code`（`TOKEN_EXPIRED` 40102 → `(4001, "access token expired")`；`UNAUTHORIZED` 40100 / `SESSION_REVOKED` 40105 → `(4001, "auth expired")`；其余 → `(1011, "re-auth unavailable")`），`1011` / `1012` / `4003` 见该文件内各 `close_with(&mut sender, <code>, …)` 发出点旁的注释）：`1000` / `1001` / `1006` / `1011` / `1012` → 继续无限重试；`4001`（连接期间 re-auth 失败）→ **停重连（URL 置 undefined）+ 不清 session**，只派发 `auth:session-lost` 交 app 层处置（清会话的职责在 app 层，`access token expired` 时本地 refresh token 仍然有效，WS 层删 localStorage 等于直接踢人）；`4003`（慢消费方丢了 n 条事件）→ 继续重试 **+ 派发 `dashboard:full-refetch` 立即全量 invalidate**（该事件由 `views/dashboard/composables/useDashboardInvalidation.ts` 接收；必须走立即路径而非 500ms 防抖，丢的事件在服务端已不可追溯）。**`1006` 不在关闭那一刻派全量重取** —— 那时连接还没恢复，重取只能拿回断连前的同一份事实；它的补偿点在重连之后（见「重连 snapshot 的补偿语义」）。
- **`4001` 的两段 reason 由 app 层（`src/router/index.ts` 的 `auth:session-lost` listener）分流**，字面量必须与后端 `handler.rs::reauth_close_code` 的产出逐字对齐（reason 拆分那次改动在后端仓，本仓只消费不解释）：`access token expired` = 只是这枚 access JWT 自然过期、`TOKEN_EXPIRED` 40102 ⇒ `auth.refreshOrLogout(router)`，成功后必须 `reconnectDashboard()` 恢复长连接（refreshOrLogout 走 `/iam/me`，成功响应不触发 40102，不一定发生 refresh，没人派发 `auth:session-changed`，漏掉这句 WS 会永远停在 `undefined`）；`auth expired` = 会话真被吊销、`UNAUTHORIZED` 40100 / `SESSION_REVOKED` 40105 ⇒ `auth.forceLogout(router)`；`null` 按「可能只是过期」走 refresh 分支，其它未知的非空 reason 保守 forceLogout。
- **主动关闭的判定绑在 socket 实例上**：`useWebSocket` 的 `ws.onclose` 无条件调 `onDisconnected`（`explicitlyClosed` 只挡 `autoReconnect` 分支），所以 token 刷新换连接那次 `code 1000` 必须靠「待关闭的 socket 实例」这一等值比较剔除，不能按 code 吞。**`useWebSocket` 传 `autoConnect: false`**：它只关掉 VueUse 自己的 `watch(urlRef, open)`，`immediate` 首次建连不受影响；不关掉的话那条 watch 与本文件的 `watch(wsUrl, …)` 同 flush 且注册更早，会先跑 `open()` 把 wsRef 换成新 socket，导致取不到「即将关闭的旧实例」。因实例绑定，标记滞留也不会吞掉别的连接的失败（一个 WebSocket 只派发一次 close 事件）。
- **分层禁令**：WS 层**禁止** import `stores/auth`、`vue-router`、`@tanstack/vue-query`，全部走 CustomEvent 解耦。
- **`4001` 只在已建立的连接上有效**，握手阶段的鉴权失败只会表现为 `1006`（后端 upgrade 前直接回 HTTP `401`，浏览器 WS API 不暴露握手期 status）。所以会话真死的最终兜底是 HTTP 侧 `40105 → auth:logout`，不是 WS 侧的 `4001`；也**不要**加「握手失败几次就登出」的启发式，那会把代理 / 后端故障误判成会话失效。
- **dev 环境必须有 `/ws` 反代**（`vite.config.ts` `server.proxy`）。Vite 8 的 dev upgrade 监听器只对匹配到的 proxy context 转发，缺了表现为「页面数据正常但控制台一直刷 WS 报错」。生产 / 预发由 nginx 的 `location ^~ /ws/` 负责。

#### 为什么没有「全事件横幅」

本仓**刻意不消费「除 `SCAN_BANNER` 外的 WS 事件」做展示**。曾经的 `components/NotificationBanner.vue` 整条下线，理由是三条契约漂移叠在一起（不要照 v1 的文档把它复活）：

1. **它支持的 8 个 kind 里 6 个是 v1 遗留**（`PICKED_UP` / `RETURNED` / `INSPECTED` / `PLACED_ON_SHELF` / `RELEASED` / `RECALLED`），`/ws/` 只反代到 backend-rust，后端**零产出方**，永远收不到；
2. **v2 事件的 payload 不带展示字段** —— 约 40 个 kind 全是 id / 计数（旧横幅要的 `drawing_no` / `name` / `customer_path` / `is_urgent` / `planned_delivery_date` / `worker_name` 一个都拿不到），唯一例外是 `PART_TO_INSPECTION` 带 `shelf_code`，而那不是展示文案；
3. **它对 `onDashboardEvent` 无白名单** ⇒ 每条 WS 事件都弹一条：`drawing_no=''` + `name=''` 落到兜底分支渲染成 `「 · 已进入货架等待加工」`，装配体事件走专用分支渲染成 `「装配体  已取消」`。

⇒ 现在的形态是「一条**只消费 `SCAN_BANNER`** 的事件条」，不是「把 `DashboardEventType` 逐个 case 的横幅」。要新增展示事件，先确认后端真的产出它、且它的 payload 真的带展示字段，再加 schema 字段与一个组件分支 —— 别改成一个无白名单的通用横幅。

#### 两条浮层组件

| 组件 | 位置 | 消费的事件 |
|---|---|---|
| `views/dashboard/components/ScanBanner.vue` | 右下角浮层（`Teleport to="body"`） | `onDashboardEvent` 里 `event_type === 'SCAN_BANNER'` |
| `views/dashboard/components/WsConnectionIndicator.vue` | `MainLayout` 顶栏 `.header-right` 内、`UserDropdown` 左侧 | `onDashboardConnection` |

两条都放**域内** `views/dashboard/components/`，不上提 `src/components/`：它们依赖 dashboard 域的 WS 契约与守门 schema（域内依赖），且只有 MainLayout 一个消费方，不满足「零个域内依赖 + 多域复用」的上提判据 —— 与 `BatchCard.vue` 那种 6 个跨域消费方才上提的判据**相反**。⚠️ `MainLayout.vue` 里那两条 import 是全仓仅有的 `layouts/ → views/` 边，属**有意识的取舍**（消费方是应用外壳而非某个页面）。**若将来出现第二个壳层**（Kiosk 屏 / 打印页）要复用作标，应届时把两条**整体上提到 `src/components/`**，而不是再加一条 `layouts → views` 边。

**⚠️ `ScanBanner` 的 `bottom: 72px` 是硬值，不是随手取的数**：`components/PagedTable.vue` 的 `.pagination` 是右对齐的，恰好就在页面右下角（全部列表页都是这个壳）。贴底（24px）会盖住「下一页」按钮 4 秒。同理，入场动画用 `translateY` —— 入场方向与浮层位置对齐，贴右下角的层从下方滑入。

#### `SCAN_BANNER`：唯一带展示字段的事件

v2 后端约 40 个事件里，**只有 `SCAN_BANNER` 的 payload 带展示字段**（6 键，守门 schema 在 `views/dashboard/composables/bannerSchema.ts`）：

| 字段 | 语义 | 可空 |
|---|---|---|
| `action` | 报工台上刚发生的动作：`PICKED_UP` / `RETURNED` / `INSPECTED` | 否（枚举） |
| `worker_name` | 作业工人姓名 | 否 |
| `serial_no` | 工单序列号，终态工单为 NULL | 是 |
| `drawing_no` | 图纸号（`serial_no` 的兜底来源） | 否 |
| `quantity` | 本次动作涉及的件数 | 否 |
| `system_delivery_date` | 系统交期，展示层只取 `M-DD` | 是 |

`system_delivery_date` 刻意用宽松的 `z.string().nullable()` 而非日期格式闸：后端 `ScanBannerItem.system_delivery_date` 是 `Option<chrono::NaiveDate>`（后端 `src/modules/prod/scan/vo/transition.rs`，三个序列化单测断言恒为 `"2026-10-27"` / `null`）⇒ wire 上只有 `YYYY-MM-DD` 与 `null` 两种形态，类型不再是未决项。保持宽松的理由是**展示层只取 `M-DD`** —— `slice(5,10)` 对带时刻的漂移形态仍能正确降级，而加严的唯一效果是把漂移变成「事件被静默丢弃 + 一行 warn」，对展示正确性零收益。

**它不进 `AFFECTS_DASHBOARD` 白名单** —— 纯展示事件。dashboard 三张报表的数据事实由同一次扫码提交产生的既有状态翻转事件（`PART_PICKED_UP` / `WORKER_SCAN_*` …）承载，把它加进白名单等于每次扫码多刷一遍大屏。守卫：`composables/__tests__/useDashboardInvalidation.spec.ts` 的 I1 用例断言白名单元素数（**加它那条断言就会红**）。

**Zod 守门的第三种形态：推送通道**。本仓的守门点共有三种落点 —— ① queryFn（HTTP 首取的三个 dashboard 端点）；② 没有 queryFn 承载的单次拉取（api 层直接 `parse`）；③ **推送通道** —— `SCAN_BANNER` 既没有 queryFn 承载，也不是 api 层的函数调用，WS 层只负责把帧原样 fan-out，⇒ `.safeParse()` 落在**组件的 `onDashboardEvent` 回调内**（`ScanBanner.vue` 的 `onEvent`）。坏事件**丢弃 + 一行 warn**，绝不让异常冒泡把整条订阅链带走（`dispatch()` 里虽有一层 try/catch，但那样会静默吞掉整条事件，连日志都没有）。**守卫**：`components/__tests__/ScanBanner.spec.ts` 的 S3 / S4 —— 把 `safeParse` 整段摘掉时它们必须变红，否则这次守门是零测试信号。

#### 连接状态订阅：即刻回放 + `expected` 分流

- **`onDashboardConnection` 订阅即刻回放当前状态**（`onDashboardStatus` 是它的三态薄封装，共享同一份订阅集合）。连接状态是组件的**初始渲染输入**，不是「发生了什么」的增量通知 —— push-only 订阅对后挂的组件等于零信息：大屏常驻时 WS 早就连上了，指示器若恰好没等到一次状态变更，就会一直停在初始值。**新增任何状态类订阅接口时都要带这一下回放。**
- **`DashboardConnectionState` 四字段**：`status`（`connecting` / `open` / `closed`）/ `expected` / `retries` / `lastError`。`retries` 复用 WS 层既有的失败计数（连上后归零，退避不封顶所以会一直涨）；`lastError` 取 `reportFailure` 里已算好的 closeCode / reason，4001 分支不算失败（那是终止性事件，不是可重试的失败）。
- **`expected` 的判据绑在「待关闭 socket 实例」的等值比较上**（`api/dashboard.ts` 的 `expectedClosingWs`），**不是按 close code 猜**：code 1000 也可能由服务端 / 中间层主动发出，那是真实断开。**指示器四态必须按它分流** —— 主动关闭（登出 / token 刷新换连接）与真实断开落在同一个 `'closed'` 上，对 UI 含义恰好相反：`open` 绿「已连接」/ `connecting` 黄点呼吸「重连中…」/ `closed` + `expected` 灰「已连接」/ `closed` + 非 `expected` 红「已断开」。诊断信息（重试次数 / close code / reason）留在 tooltip 里，顶栏只留四态那一句。

#### 重连 snapshot 的补偿语义

后端 `handle_socket` **每次连接（含每次重连）**都会推一帧新鲜的 snapshot。`dispatch()` 的 `snapshot` 分支据此分两种处理：

- **首次连接**（`connectedCount === 1`）→ 显式 no-op。那一帧与首屏 HTTP 全量首取重复，触发补偿等于让三个 dashboard query 白刷一遍（首屏还会闪一次 loading）。
- **重连之后** → 派 `dashboard:full-refetch`，复用 `useDashboardInvalidation.ts` 的立即失效通道（与 4003 共用信号、共用接收方，两者零改动）。

**为什么必须有这一步**：dashboard 三个 query 是 `gcTime: POSITIVE_INFINITY` + **无 `refetchInterval`**（`staleTime` 只决定「下次取数放不放行」，不产生定时器），WS 又是它们唯一的增量通道 ⇒ 断连期间丢的事件没有任何补偿通道，大屏会**静默停更**。首帧 snapshot 在首次连接下仅作就绪信号，在重连时承担断线期数据补偿 —— 这是同一个分支按「是不是首次连接」分的流，不是两套机制。

守卫：`api/dashboard.spec.ts` 的 C5（首次不派）/ C6（重连派）/ C7（换连接也算重连）。

### 图表

业务组件一律走 `vue-echarts`（`app.component('VChart', VChart)` 全局注册），模块化注册统一在 `src/plugins/echarts.ts`。**禁止**在业务组件内值导入 `echarts/core` + `echarts.init()` + 自写 ResizeObserver / dispose 生命周期（type-only import 不受限）。`src/components/EChart.vue` 是历史兜底薄壳，不在新增代码中使用。

### 共享批次卡片

`src/components/BatchCard.vue` 是全仓唯一的批次卡片（200×96 固定盒），消费方：生产队列的工序候选池 / 工人列 / 待下发池，外协发送接收看板的候选池 / 外协公司列。**局部 import**（与 `PagedTable` / `ColumnVisibilityPopover` 同风格），不进 `main.ts` 全局注册。view-model 是 `src/types/batchCard.ts` 的 `BatchCardModel`（局部 import，不属 `types/productionQueue.ts`）。

- **DTO 差异只能在适配层消化，组件零 `api/*` 依赖。** 三个 wire DTO 各自经 `views/production/queue/utils/queueItemToCard.ts`（`poolItemToCard` / `heldToCard` / `pendingBatchToCard`）或 `views/outsource/composables/outsourceItemToCard.ts` 转成本类型；**适配层各域自持，不要为了对称集中到共享目录**。
- **改尺寸 / body 行数会同时影响全部消费方。** 200×96 是硬预算：body 恒 4 行 × 18px 行高（4×18 + 3×2 gap + 上下各 8 padding + 上下各 1px 边框 = 96px，无余量），长文本一律 ellipsis 不换行。**新信息只能进 tooltip，不得加第 5 行。**
- `BatchCardModel` 的两类扩展字段性质不同：`version?: number` 是 `t_part_batch` 的一列、**非领域概念**故在顶层（外协收发的 OCC 锚）；`extra?: BatchCardExtra` 是**单域扩展槽**、只进 tooltip（外协公司 / 工序 / 单价 / 发出时间 / 接收可免填性）。新增域信息优先走 `extra`，别往顶层堆领域字段。
- **左侧 4px 竖条只承载「这条批次有制定工序链且链指针未漂移」这一个语义**（`has_process_chain`，绿；无链落 `var(--el-border-color-lighter)`）。加急只剩 body 的「加急」tag 一个通道（`.is-urgent` 红底是报工台 `.part-row` 的样式，批次卡片没有），**不进边框**；`.is-selected` 的主色描边照旧盖住竖条（交互反馈优先于语义色）。三个适配层里该字段来源不同：候选池 / 工人持有 / 外协候选透传后端派生列，待下发按 `process_chain_id !== '0'` 推导，外协在途恒 `false`（外协收发阶段不判链）。
- `has_process_chain` 只回答「有没有链且指针对得上」，**不回答「下一道工序能免填吗」** —— 后者是 `chain_state` / `chain_resolvable` 的事（放回页、外协接收各有消费点），两者不要互相推导。
- 报工台（`views/production/scan/`）列表行 `.part-row` 与 `components/BatchPickerDialog.vue` 的 `.batch-row` 走同一条规则（`views/production/scan/chainAccent.ts` 的**类绑定** `chainRowClass()`）：**流程区分不进边框**（由顶栏 `flowLabel` + 路由承担），报工台各文件 scoped CSS 里不得再出现按流程硬编码的左边框色。**禁止**用模板 inline `:style` 承载这个语义色 —— inline 优先于任何非 `!important` 规则，会盖住 `.is-selected` / `.is-urgent` 的 `border-color` 简写，表现为选中态左边框退成中性色。级联口径与 `BatchCard.vue` 相反：`.has-chain` 排在全部状态类**之后**（同档 0,2,0 靠源码顺序取胜），左边框恒归链语义（选中色与链色同为一个绿，肉眼无差，但口径只有一条）。
- **报工台列表行卡（`.part-row`）的模板 + CSS 只有一份**：`views/production/scan/components/PartRowCard.vue`，四页（取件 / 放回 / 送检 / 查看持有）都用它。`.has-chain` 规则因此**只落在那个组件的 scoped CSS 里**，页面 scoped CSS 里一份都不该有（Vue scoped 会命中子组件根元素，页面里另写一份会盖掉它）。同理 `.preview-btn` 是绝对定位覆盖在卡上，让位只能加在组件根内的 `.part-row-main` 上；`readonly` prop 供查看持有页去 pointer / hover（那页整卡不可点）。守卫：`__tests__/ScanReturnChainFlow.spec.ts` 的源码契约用例（⚠️ 它只拦页面里的 inline `borderLeftColor`，**不拦**页面 scoped CSS 里另写的 class 形态行样式）。
- `PendingPoolCard.vue` 是**工序投放卡**（不是批次卡），只是盒模型与 BatchCard 对齐，刻意保持独立、不合并。

### 图纸预览

图纸预览有**两条**链路（2026-10-13）：首选 `GET /files/objects/{id}/preview` 的 **CI 转图直链**（`usePreviewPolling` 轮询 + `ImagePager` 渲染，浏览器不下载整份 PDF），`GET /files/objects/{id}/content` 的 blob 保留为**「查看原始 PDF」逃生口 + 转图不可用时的自动兜底 + 非图纸文件（3D / G 代码）内嵌预览的唯一形态**。两者不是替代关系 —— `fetchPartFileContent` 零调用点时不要当遗留清掉。

- **每个承载弹窗会同时挂 `ImagePager`（图片模式，默认）与 `PdfViewer`（原始 PDF / 兜底）**。五处承载点里 `FileListCard` / `AssemblyChildrenTable` / `PartDrawingPreviewDialog` / `DrawingPreviewPane` / `PartPreviewDialog` 把两条路径合成同一个 `preview.degraded` + `showOriginalPdf` 的 `wantsOriginalPdf` 信号，一个提供「用户主动退回原始 PDF」，另一个提供「转图端点不支持 / CI 失败 / 等超时」的自动兜底，**合并成一条 watch**，不给降级单开代码路径。`OutsourceQuotePdfPreview` 是**受控 props 形态**（不是这个形状）：caller 把 `drawingShowOriginal ? [] : preview.pages.value` 传给 `pages`、子组件按 `pages.length` 分流，用户切回由 `viewOriginal` 事件驱动，子组件内既没有 `showOriginalPdf` 也没有 `degraded` 合流。
- **降级必须是有告知的**：`usePreviewPolling` 把每个降级原因填进 `degradedReason`，承载点渲染成一行 `.degrade-hint`。静默兜底会让 CI 挂了无人察觉（现场只看到「预览变慢了 / 变成 PDF 了」）。
- **失败语义一律按 `ApiError.code` 分流，且它是信封业务码、不是 HTTP 状态码**：`api/http.ts` 的响应拦截器在响应体是信封时装 `new ApiError(payload.code, …)`，后端 `AppError::into_response()` 对 21116 / 21117 / 21118 一律返信封 ⇒ 前端读到的 `code` 是 `21116`，**不是**它那个 HTTP 400。白名单在 `types/part_file.ts`：立即降级组 `PREVIEW_UNSUPPORTED_CODES = [400, 502, 21116, 21118]`（400 / 502 只兜**无信封**的代理层错误）、有限自愈组 `PREVIEW_SELF_HEAL_CODES = [21117]` 且至多重试 `PREVIEW_SELF_HEAL_MAX_RETRY = 1` 次 —— 因为后端对 FAILED 行做的是「重置为 PENDING + 清 `ci_job_id` 后重走推进流程」= 重新提交一个按页计费的 CI job。**后端 wire 上 `state` 只有 `READY` / `PENDING`**，失败不在 `state` 里（前端 `FilePreviewState` 不得再加 `'FAILED'`，`error` 字段后端恒为 `null`）。守卫：`src/api/files/__tests__/previewContract.spec.ts`（走真实 `api/http.ts` 拦截器 + 真实信封形状；能找到后端仓时再对着 `shared/error.rs` 与 `preview/dto.rs` 核一遍码表）。
- **「查看原始 PDF」是单向的**：点过之后没有回到图片模式的入口（`showOriginalPdf` 只在换文件 / 关弹窗 / 切 tab 时复位）。逃生口存在即达标，往返入口是已知缺口。
- **两条端点都吃 `items[].id`（文件对象 id），不吃 owner id**：装配件总装图（owner=ASSEMBLY）与零件图纸（owner=PART）走同一条端点，owner 语义由后端按文件行解析。
- **预览接口可传 `?size=view|thumb|full`（缺省 `view`，2026-10-12 新增）**：后端按档位给 `pages[]` 的图片直链追加**部署级固定 EdgeOne 参数**（`view` = `eo-img.resize=l/2560`、`thumb` = `eo-img.resize=w/480`、`full` 无参数），直链仍无签名、不过期。参数值由后端 env `COS_PREVIEW_IMAGE_VIEW_PARAMS` / `COS_PREVIEW_IMAGE_THUMB_PARAMS` 控制，每档只允许**单轴**（`w/` 与 `h/` 同用会拉伸失真）。**前端当前不传该参数**（吃默认 `view` 档）；非法值后端返信封 `40001`。
- **⚠️ 部署前置：跨域预览图的 CORP 头（2026-10-12）**：EdgeOne 必须对该预览域 `previews/*` 追加响应头 `Cross-Origin-Resource-Policy: cross-origin` —— dev/preview（Vite serve）的 COEP `require-corp` 会拦截无 CORP 头的跨域图片（表现为图片加载失败，而地址栏直开却正常）。生产 nginx 当前不带 COOP/COEP、不受此约束；将来若给 nginx 加上这两个头，必须同步确认该 CORP 头存在。
- **源图渲染配方与 `preview_seed` 渲染版本挂钩（2026-10-12）**：CI 出图配方（ImageDpi=300 / Quality=90）参与 `preview_seed` 渲染版本的计算 —— 改配方必须同步递增 rust 侧 `PREVIEW_RECIPE_VERSION`，否则旧 `READY` 行与缓存不换代（细节以 backend-rust 为准）。
- **轮询预算**（`usePreviewPolling` 内常量，注释里有量级理由）：次数上限 30、墙钟上限 120s、单次等待封顶 8s、指数退避倍率 1.6、建议间隔缺失时落 1s 下限。次数闸与墙钟闸各堵一个退化方向（后端建议间隔给太大 / 给 0），少一条就会出现「等五分钟」或「两分钟打上百次请求」。**与后端节流不打架**：后端 `next_poll_at` 缺省 2s（env `PREVIEW_POLL_BACKOFF_SECONDS` 可调 1..=5），未到期时直接返 PENDING 且**零外部 IO**；本层第 1 次等待就是 2s、之后指数退避只会更慢，永远抢不到节流戳前面。
- **角色不区分预览路径**：后端 `/preview` 与 `/content` 对 5 个角色（含 `SHELF_ACCOUNT`）都放开，前端不按角色分流。`/files/objects/{id}/url`（下载）**刻意没放开**，前端闸门见 `utils/partsPermissions`。

两个预览组件的缩放模型与承载高度契约（都容易被改版静默破坏）。

- **`ImagePager` 只有单 scale 模型**（`scale` + `tx`/`ty`），不是 `PdfViewer` 的双 scale：图片没有「按新分辨率重渲染」这一步（源图分辨率是 CI 出图时定死的），故 `renderScale`/`viewScale` 合并，`fitPending` + `ResizeObserver` 补算那套也不需要（`<img>` 的 `@load` 一次就给出 `naturalWidth/Height`）。**缩放区间 `[0.1, 10]`**（对齐 `PdfViewer` 的 `viewScale`，没有 `renderScale` 那条 `[0.4, 3]` 步进区间），fit 的夹逼区间 `[0.05, 8]` 与 `PdfViewer` 同款；`userZoomed` 与翻页归位（`userZoomed` / `scale` / `tx` / `ty` 四样）的语义与 `PdfViewer` 同款。**能力取舍**：图片模式**没有矢量缩放（放大看细节会糊）、没有文字选中**，因此逃生口是必须的而非可选优化 —— 每个承载点都要保留「查看原始 PDF」，组件本体刻意不内置该入口（它不持有 `fileId`、也不知道原始 PDF 在哪）。**键盘可达**：`.img-viewport` 是本组件唯一的交互面，带 `tabindex` / `@keydown`（方向键翻页、Home/End 首末页、`+`/`-` 缩放、`0` 复位），键盘路径只转调工具栏那批函数、不自实现。守卫：`src/components/__tests__/ImagePager.spec.ts`（fit / 翻页四样归位 / `fit=false` / `userZoomed` 优先 / 单页无翻页入口 / 键盘），承载高度由 `PdfPreviewDialogContract.spec.ts` 守。

- **`PdfViewer` 默认 fit 到容器**（`fit` prop，默认 `true`，全仓所有 `<PdfViewer>` 承载点生效；承载点清单以 `src/components/__tests__/PdfPreviewDialogContract.spec.ts` 的表 + 例外为准，不在本文件数）。`render()` 在 `fit && !userZoomed` 时按 `min(容器宽 / 页宽@1, 容器高 / 页高@1)` 算比例写进 **`renderScale`**（不是 `viewScale` —— CSS transform 放大矢量图只会糊），夹逼区间 `[0.05, 8]` 与 +/- 的 `[0.4, 3]` **刻意不同**（A1 图纸在 1100px 弹窗里需 0.2 上下，套 0.4 下限会撑出容器）。三条要点：① 容器尺寸为 0（宿主尚未布局）时回落 `initialScale` 并由 `ResizeObserver` 补渲一次，该观察者**只在 fit 失败时动作**（跟着每次尺寸变化重渲会造成 canvas layout shift 抖动）；② `userZoomed` 由 `zoomIn` / `zoomOut` / `onWheel` 三条**缩放入口**置位（滚轮只动 `viewScale`，但同样是「我要看多大」的表态）—— 置位的作用是 `render()` 不得再覆写工人选的比例（`zoomIn` 的实现正是「改 `renderScale` → `render()`」，无条件覆写等于 +/- 失效）；③ **清位分两类，口径不同**：**用户动作类**（复位按钮 / 双击、工具栏翻页、外部改 `page` prop）统一调 `resetView()`，它把 `userZoomed`（让 fit 重算）、`viewScale = 1`、`tx = ty = 0` **三样一起**归位 ⇒ 语义是「回到整页塞进容器的大小」，不是「回到 1 倍」；三样缺一「翻页 = 重新适应整页」就不成立 —— 不清标志则滚轮用户下一页仍以「fit × 自己的缩放」呈现、出容器，**不清平移则翻页后看到的是新一页的一角**（`tx`/`ty` 是 stage 的 CSS translate，与两个 scale 互不干涉）。切 `url` 也归这一类（同样三样归位，只是不调 `resetView` 而是调 `load()`，避免重复渲染）。翻页/复位重置是刻意的：图纸各页图幅不同（封面 A0、正图 A4 混排），带着上一页的缩放或平移都会让下一张图看不到全貌。**宿主改配置类**只有 `props.fit` watch，它**只清 `userZoomed`、刻意不动 `viewScale` 与平移** —— 切 `fit` 是宿主行为而非用户对这份文件的动作，用户没表态就不替他丢掉已调好的缩放与位置（该 prop 目前零调用方，是留给将来承载点的 opt-out 口子）。`fit` 是 opt-out 口子：将来某个承载点要固定比例时传 `:fit="false"`，不要改组件本体。守卫：`src/components/__tests__/PdfViewer.spec.ts`（含滚轮翻页、拖动平移后翻页、ResizeObserver 补渲三条用例）。
- **用 `el-dialog` 承载预览组件处必须挂对应 class**：`.pdf-preview-dialog`（`PdfViewer`）/ `.img-preview-dialog`（`ImagePager`），两支高度规则在 `src/styles/index.scss` 里逐条并列。同一个弹窗承载两者时**两个 class 都要挂**。**例外**是「宿主自带确定高度、无需该 class」的那些承载点（`DrawingPreviewPane` 的 `.file-preview` flex 链、`PartPreviewDialog` 的 aspect-ratio、`OutsourceQuotePdfPreview` 的 `.drawing-frame-wrap` 自给 `height:70vh` + column）—— 名单以 `src/components/__tests__/PdfPreviewDialogContract.spec.ts` 头注释的清单为准，不在本文件数。守卫同该 spec（白名单是人工判定的，新增承载点要一并加表）。

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
- **放回页 NEXT 分支的确认框：三个出口 + 禁右上角 ×**：确认框是 `chain_state='NEXT'` 唯一能到达 `ProcessPickerDialog` 的路，只给「按链放回 / 取消」的话，工人一旦不同意管理员配的工序链（临时插单、改道）就被困死 —— 取消只清选中态，再点卡片还是同一个框。工序链是配置不是命令，「换一道工序」不是冗余出口。**同时必须 `:show-close="false"`**，理由见「弹窗关闭权」一节；同页另外三个弹窗关掉不致命（确认栏的「取消选择」就能恢复），所以它们不禁 ×。

### 弹窗关闭权

**一个弹窗若是某条路径的唯一出口，它的关闭权就必须收在自己手里** —— 右上角 × 只
`emit('update:modelValue', false)`、不发业务事件，而很多弹窗的收尾逻辑只挂在
`@cancel` / `@confirm` 上。× 一关就留下「输入填好了、选中态留着、却无处可提交」的死角。

- **`QuantityDialog` 禁右上角 ×**（`:show-close="false"`）。放回 / 送检两页的每条提交都从它过，它是那条路径唯一的提交闸门；× 只 emit `update:modelValue(false)`、不发 `cancel`，调用方的 `selectedPart` / `selectedNextProcessId` 全部留着（送检页那条路上确认栏还已经消失，工人既无弹窗也无确认栏可走）。同款理由见「货架自动选择」一节末尾的放回页确认框判据。**刻意不用 `@closed` 发 `cancel` 兜**：本弹窗的显隐由调用方程序化置 false（`onQtyConfirm` 第一行就置），那也触发 `@closed` ⇒ 提交在途时会把调用方的选中态抽走；**送检页** `submitInspect` 在 `await mutateAsync` 之后才读 `selectedPart.value.serial_no` 组装成功文案，选中态被抽走即空指针（放回页 / 取件页在 await 之前就取完值、或 `@cancel` 只置自己的显隐标志，不靠这层）。三页同口径比「只在出问题的那个页面加补丁」好维护。

### 拖拽投放（Sortable）

看板类页面的跨容器拖拽用 `vue-draggable-plus`。三条已踩过的坑：

- **投放容器一律用二参重载** `useDraggable(el, options)`，**不传 list**。传 list 会挂上库的内建 handler（`list.value.splice(...)`），而库假定 list 就是渲染源 ⇒ Sortable 改的数组与 Vue 渲染的数组不同源。容器在 `v-if` 内时用 `src/composables/useLazyDraggable.ts`（它把首次绑定延后到 el ref 解析之后，并强制 `immediate: false`）。
- **不传 list 就必须自己补 `onRemove` 做 DOM 回滚。** 内建 handler 的第一句是 `from.insertBefore(item, from.children[oldIndex])`（把 Sortable 搬过的节点放回源容器），改二参后这层消失；而 **`invalidate` 补不回来** —— Sortable 已经把节点搬到源容器 DOM 之外，`invalidate` 只重新渲染 vdom 里已有的东西。失败时两侧 query 数据都没变，keyed diff 对这个外来节点连 `patchElement` 都做不到，卡片永久留在错误列并累积；成功时源列数据虽已变、keyed diff 会卸载那张卡，但**卸载只删得掉该 vnode 的 DOM footprint**，footprint 之外的节点同样删不掉。用 `dndSourceTracker.ts` 的 `restoreNodeToSource`。同时加 `sort: false` 关掉容器内重排（该选项只在「落点实例 === 拖拽起点实例」时被读，跨实例投放走 group 的 checkPull/checkPut，不受影响）。
- **Sortable 容器的直接子元素必须全是可拖项**（混入 header / 空态会让 `oldIndex` 与可拖项下标错位）。空态用**兄弟覆盖层**（`position:absolute; inset:0; pointer-events:none`）承载，别用 `v-if` 把容器整个摘掉 —— 空容器必须仍是合法投放目标（给空闲工人派活是主场景）。
- **可拖元素 == vnode 的 DOM footprint ⇒ 卡片类组件的根必须是单个元素。** 根一旦是多根 vnode（Fragment），Vue 会在两侧插锚点（`el-tooltip` 包根就是这个形状：`ElPopper` 的 render 是 `renderSlot`，外加默认 `teleported: true` 留 2 个 teleport 占位注释），锚点跟着留在源容器而卡片元素被搬走；`restoreNodeToSource` 按 `from.children[oldIndex]` 放回时元素序列已位移，卡片被插到**自己那对锚点范围之外**，之后 Vue 卸载走 `removeFragment()` 只删锚点、够不到卡片 ⇒ 每投放一次残留一个幻影卡片（徽标 / 计数照常更新，刷新浏览器才恢复）。同一条约束的另一面：**dev 构建保留模板注释，根元素上方不许有任何注释或元素**，否则组件同样变成多根。`BatchCard` 因此把 `el-tooltip` 放在根内部的触发区 `.card-body` 上，`data-*` / `v-bind="$attrs"` 全部留在根 div。守卫：`src/components/__tests__/BatchCardDndFootprint.spec.ts`。

## 已知风险

- 依赖 `xlsx@0.18.5` 有原型污染 + ReDoS 高危漏洞（npm 官方无修复版本）。仅用于内部只读 Excel 解析（parser / 视图已统一收口，不执行公式宏），攻击面可控，后续迁 SheetJS CDN 版或 exceljs。
- `src/three/OcctStepLoader.ts::buildTopology` 递归取子形状（face / wire / edge）时，每个子形状的 wasm 句柄都直接塞进 `TopologyNode.children[].handle`，**全程不释放** —— `releaseShape()` 只释放根句柄。一次复杂 STEP 的面 / 线 / 边量级足以让 wasm arena 迅速膨胀。当前刻意延后：仓内**没有任何释放子句柄的入口**（`shapeCache.forget()` / `shapeCache.reset()` 只按**根句柄**删缓存条目，子句柄从来不是表里的键），所以子句柄一释放，`children[].handle` 就变成悬空数字；而 `inspectLastLoaded()` / `getTopology()` / `getStats()` 三个调试导出（无代码调用方，仅供浏览器控制台排查 OCCT 解析结果）是现场唯一的排查手段，数字悬空后就再也没法拿它们比对。要动 `buildTopology` 的子形状遍历前先读这条。
