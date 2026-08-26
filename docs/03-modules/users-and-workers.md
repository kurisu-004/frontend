# 账号 / 工人

> **目标读者**：前端开发（维护账号管理、工人花名册、扫码台工牌识别）
> **核心价值**：双轨实体管理——系统账号（登录 + 权限）与车间工人（业务花名册 + 工牌）是两条独立主线，权限模型分两层
> **最后更新**：2026-08-26 · **维护者**：@frontend-team

---

## 一、入口与路由

| 路径 | 路由名 | menuCode | 守卫 |
|---|---|---|---|
| `/users` | `UserList` | `users_list` | `requireAuth` |
| `/workers` | `WorkerList` | `workers_list` | `requireAuth` |

父级 `MainLayout` 子树，菜单分组为「权限管理」（`breadcrumb` 一致）。守卫只用 `requireAuth`；具体角色能否进取决于后端菜单树是否下发对应 code。

## 二、关键页面

| 文件 | 职责 |
|---|---|
| `src/views/users/UserList.vue` | 账号管理：列表 + 角色管理弹窗 + 新增 / 编辑 / 停用 / 重置密码 |
| `src/views/WorkerList.vue` | 工人一览（**位于 `src/views/` 根目录，不在 `users/` 子目录**） |

`UserList.vue` 顶部固定「新增账号」按钮 + `ColumnVisibilityPopover` 列显隐 + `PagedTable` 分页；每行操作列有「角色 / 编辑 / 重置密码 / 停用 / 删除」。重置密码用 `el-popconfirm` 二次确认（默认值 `changeme`）。

`WorkerList.vue` 顶部 `el-form` 筛选（姓名 + 状态），下面 `el-table` + 列显隐 + 分页；MANAGER 可见「新增工人」按钮，其他角色只读。

## 三、主要 API 调用

### 账号（`src/api/users.ts`，走 `api` v1）

| 函数 | HTTP | 用途 |
|---|---|---|
| `listUsers(params)` | GET | 账号列表（`username_like` / `is_active`） |
| `createUser` / `updateUser` / `deactivateUser` | POST | CRUD；`/users` + `/users/{id}/update` + `/users/{id}/deactivate` |
| `resetUserPassword(id)` | POST `/users/{id}/reset-password` | 管理员重置为 `changeme`；后端会轮转其 refresh token |
| `listUserRoles` / `addUserRole` / `removeUserRole` | GET / POST | 角色增删（含 `scope_type` / `scope_id` 货架范围） |

### 工人（`src/api/worker.ts`，走 `api` v1）

| 函数 | HTTP | 用途 |
|---|---|---|
| `listWorkers(params)` | GET | 工人列表（`name_like` / `is_active`） |
| `getWorker` / `createWorker` / `updateWorker` / `deactivateWorker` / `reactivateWorker` | GET / POST | CRUD；复用 `/workers/{id}/update` 等动词后缀路径 |
| `findWorkerByBadge(badgeCode)` | POST `/workers/verify-badge` | **工牌扫码定位**：单点 query，避开了旧「GET /workers 拉全表客户端 find」的越权 + 500 条硬上限两个问题 |

`findWorkerByBadge` 关键约定：业务错误码 `20201`（`BIZ_WORKER_NOT_FOUND`）/ `20202`（`BIZ_WORKER_INACTIVE`）**不抛错**，前端按 `null` 处理（"未识别"是合法的扫描业务态）；其余网络错误原样抛 `ApiError`。该端点对 SHELF_ACCOUNT 也开放（`require_auth()` 即可），是工位扫码台能跑通的根因。

## 四、双轨实体模型

账号和工人在后端是**两张独立表**，不要尝试合并：

| 维度 | 账号（User） | 工人（Worker） |
|---|---|---|
| 用途 | 登录系统 + 鉴权 | 车间业务归属 + 工牌识别 |
| 关键字段 | username / password / roles[] | name / work_type_id / badge_code / shelf_ids[] |
| 关系 | 一对多 / 多对多 → 工人 | 反向 |
| 角色 / 工种 | 5 种角色（见下） | 来自 `settings/work-types` 字典 |

一个账号可对应 0 / 1 / 多个工人（不一定一一对应：管理员账号通常无 worker 记录，工人账号也可挂多个工人用于代理）。

## 五、角色 vs 工种

**两个独立维度**，不要混为一谈。

账号角色（5 种，写在 `UserRole.role` 字段，由后端菜单表控制可见性）：

| 角色 | 说明 |
|---|---|
| `MANAGER` | 系统管理员，全权限 |
| `CLERK` | 业务员（订单 / 送货单） |
| `INSPECTOR` | 品检 / 返修 |
| `SHELF_ACCOUNT` | 工控机账号（货架台 / 扫码台），业务上必须能进 `/scan/*` 但菜单树不含 `scan_badge`，靠 router meta 的 `allowRoles` 短路放行 |
| `CNC_PROGRAMMER` | CNC 编程员，子角色，常与 INSPECTOR 共存 |

工人工种（来自 `settings/work-types` 字典，存 `Worker.work_type_id`）：CNC 操作员 / 装配工 / 检验员等，**与账号角色无映射关系**。

## 六、工牌扫码流程

工位扫码台入口 `/scan/badge`（`router meta` 走 `allowRoles: ['SHELF_ACCOUNT']` 短路放行）：

1. 用户扫码枪扫工牌条码 → 前端读字符串 → `findWorkerByBadge(code)`。
2. 命中 → 缓存到扫码台本地 session（`useScanSession`）→ 跳 `/scan/action` 选操作。
3. 未命中（`null`）→ 提示「工牌未识别，请联系管理员」。
4. 网络错误 → 原样抛出 `ApiError`，弹 `ElMessage.error`。

## 七、权限

| 路径 | MANAGER | CLERK | INSPECTOR | SHELF_ACCOUNT | CNC_PROGRAMMER |
|---|---|---|---|---|---|
| `/users`（账号管理） | RW | R | R | — | R |
| `/workers`（工人一览） | RW | R | R | R（仅自己） | R |
| `/scan/*`（扫码台） | — | — | — | RW（`allowRoles`） | — |

工人一览的「仅自己」逻辑目前由后端 `listWorkers` 过滤；前端不强行隐藏入口。

## 八、相关 composable / utils

- `useAuthSession` — 当前账号角色 / 菜单树来源；`usePermissions` 在它之上提供 `ComputedRef` 派生。
- `useScanSession` — 扫码台工牌识别后的本地状态。
- `useColumnVisibility` — 列表列显隐持久化。

## 九、后端契约

- `~/Code/hsh-erp-rust/docs/api/users.md` — 账号 CRUD + 角色管理 + 重置密码。
- `~/Code/hsh-erp-rust/docs/api/worker-pool.md` — 工人池（**注意文件名为 `worker-pool.md`，不是 `workers.md`**），含工牌扫码定位端点规范与错误码。
- 当前两个域**仍在 v1 FastAPI**，未上线 v2 切换。

## 十、关键约束与陷阱

- **账号与工人是两个独立实体**：不要尝试在前端 union / 合并字段；后端表结构、API、权限、生命周期都不同。
- **删除账号前必须清空 session**：v2 用 Redis 存 session；账号停用 / 删除后端会清理对应 session，**前端不要主动 logout 该用户**（会让对方误以为是被踢出）。
- **工牌条码全局唯一**：由后端唯一索引约束；前端不用做唯一性校验，依赖后端 `409` 错误码。
- **角色增删不是 CRUD**：`addUserRole` / `removeUserRole` 是独立端点（不是 PUT 整张角色表），原因是一个用户可同时挂多个角色且各自带 `scope_type` / `scope_id`。
- **重置密码后必须通知用户本人**：重置为默认 `changeme`，前端应在 UI 上提示「请用户首次登录后立即修改」。
- **雪花 ID 必须 string**：`user.id` / `worker.id` / `role.id` 都是 string，模板里 `:row-key="id"` 默认是 string 不要改。
- **SHELF_ACCOUNT 不能调 `GET /workers`**：router 强制 MANAGER 才能调列表（防止工控机拉全表）；扫码定位走专用端点 `POST /workers/verify-badge`。

## 十一、未来扩展位

### 11.1 `#future-pages`

- 工人绩效统计 tab：在 `/statistics` 下增加按工人聚合的 tab，复用 `WorkerStatsTab`（已存在），挂载 `worker_id` 维度。
- 账号批量导入：Excel 上传 + 校验，参考设置域的导入导出模式；不实现前先走单条新增。
- 工牌补打 / 重置：管理员入口，调用一个新端点生成新条码（物理工牌损坏场景）。
- 工人离职交接：工人 `deactivate` 时把其 `shelf_ids` 上的在制件强制收回，避免「工人离职了但货架上还有他的件」。
