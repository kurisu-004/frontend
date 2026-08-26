# 货架 / CNC

> **目标读者**：前端开发（添加/修改本域页面）
> **核心价值**：车间物理货架与工序的绑定管理 + CNC 待编程员专属工作台，是工位扫码台与品检流水的源头
> **最后更新**：2026-08-26 · **维护者**：@frontend-team

---

货架是零件在车间的物理坐标，CNC 是零件被加工前的「待编程」中间状态。两个域共同决定车间里「零件该放哪 / 下一步交给谁」。货架管理主要由车间管理员维护，CNC 待编程一览是 CNC 编程员的专属入口。

## 一、入口与路由

| Path | Name | menuCode | 守卫 | 备注 |
|---|---|---|---|---|
| `/shelves` | `ShelfList` | `shelves_list` | requireAuth | 侧栏车间 → 货架管理 |
| `/cnc/pending` | `PendingProgramming` | `pending_programming` | requireAuth | 侧栏顶层菜单；CNC 编程员专属 |

两路由均在 `MainLayout` 子树之下，定义于 `src/router/index.ts`。

## 二、关键页面

| 文件 | 职责 |
|---|---|
| `src/views/shelves/ShelfList.vue` | 货架 CRUD + 货架↔工序映射（多对多），列可见性 popover，物理顺序排序；「编辑工序」弹窗用 `useShelfProcessFilter` 双向过滤 |
| `src/views/cnc/PendingProgrammingList.vue` | 待编程一览（status=PROGRAMMING 的零件），CNC 编程员专属；行内操作：「详情」跳 `/parts/:id`、「下发到生产」弹选下一道工序 + 目标 PRODUCTION 货架（POST `/parts/{id}/release-from-programming`）；自动刷新（5min）可选 |

## 三、主要 API 调用

均走 v1（尚未切 v2）。

| 文件 | 关键端点 | 实例 | 备注 |
|---|---|---|---|
| `src/api/shelves.ts` | `GET /shelves`、`POST /shelves`、`POST /shelves/{id}/update`、`POST /shelves/{id}/deactivate`、`GET/POST /shelves/{id}/processes` | `api` (v1) | 共享 HMI picker：`/shelves/for-return`、`/shelves/for-inspection` |
| `src/api/shelves.ts` | `GET /shelves/processes` | `api` (v1) | 批量取所有 active 货架的工序映射（给 `useShelfProcessFilter` 一次性消费，避免 N+1） |
| `src/api/cnc.ts` | `GET /parts/{id}/cnc-programs`、`GET /parts/{id}/setup-sheets`、`POST /parts/{id}/cnc-programs`、`POST /parts/{id}/setup-sheets`、`POST /cnc-programs/{fileId}/delete` | `api` (v1) | 单文件 G 代码 / 设定单上传下载 |
| `src/api/cnc.ts` | `POST /parts/{id}/cnc-pair` | `api` (v1) | **配对上传**：G 代码 + 设定单必须同时提交（multipart，`gcode_file` + `setup_file`） |

## 四、货架分类与绑定

货架按 `zone` 划分为 3 类：

| zone | 中文 | 用途 | 关联组件 |
|---|---|---|---|
| `PRODUCTION` | 在制件架 | 工人扫码领取 / 放回的目标货架；按工序映射过滤 | HMI 卡片网格 `ScanActionPicker` |
| `INSPECTION` | 品检架 | 品检流水落点；送检对话框与品检通过后放置位置 | `ScanInspectParts`、品检弹窗 |
| `HMI` | 工位扫码台 | 物理位置标记；扫码台用 | 旧式 HMI 选件（与上两类不冲突） |

**货架-工序绑定**（多对多）：
- 一架可对应多道工序（如「A-01」同时承接 CNC 与钳工）；
- 一道工序可挂多架（按 current_load ASC 排序，自动推荐）；
- `setShelfProcesses({process_ids: string[]})` 全量替换映射。

## 五、相关 composable / utils

| 文件 | 用途 |
|---|---|
| `src/composables/useShelfProcessFilter.ts` | 货架↔工序双向 reactive 过滤；后端 `GET /shelves/processes` 一次性拉全量映射；选了不兼容的对端时清空对端 + `ElMessage.warning` 提示 |
| `src/composables/useActiveShelfSelection.ts` | SHELF_ACCOUNT 多货架场景的当前作业货架选择器；单架自动选、多架弹选择器、wildcard（未绑架）走通配；sessionStorage 跨账号切换自动失效（key 含 username） |

## 六、CNC 待编程

CNC 编程员（CNC_PROGRAMMER + MANAGER）的工作台，**仅看到 status=PROGRAMMING 的零件**：

- **单文件下载**：列表行内可分别下 G 代码 / 设定单；后端返回临时签名 URL。
- **配对上传**：弹 dialog 同时上传 G 代码（`.nc` / `.tap` / `.cnc` / `.mpf` / `.ngc`） + 设定单（PDF）——后端原子性校验两文件同时存在，缺一拒收。
- **下发到生产**：弹 dialog 选下一道工序 + PRODUCTION 货架，调 `POST /parts/{id}/release-from-programming`，状态 PROGRAMMING → IN_PROCESS。
- **加急行**：el-table `row-class-name` 整行红底（与 PartsList 同款）。

## 七、权限要求

| 操作 | MANAGER | CLERK | INSPECTOR | SHELF_ACCOUNT | CNC_PROGRAMMER |
|---|---|---|---|---|---|
| `/shelves` 增/改/停用 | 允许 | 允许 | 只读 | 只读 | 否 |
| `/cnc/pending` 进入 | 允许 | 否 | 否 | 否 | 允许 |
| G 代码上传 / 下发 | 允许 | 否 | 否 | 否 | 允许 |

权限两层叠加：
- **路由级**：`menuCode` 守卫；
- **行级 / 列级**：UI 用 `v-if` 控显隐。

## 八、后端契约锚链

- `~/Code/hsh-erp-rust/docs/api/shelves.md`（v2 迁移后生效）
- `~/Code/hsh-erp-rust/docs/api/cnc.md`（v2 迁移后生效）

## 九、关键约束与陷阱

- **HMI picker 共用**：`/shelves/for-return?next_process_id=...`（`kind: 'process'|'shelf'`）同时被工位扫码台与本域货架管理消费，按 current_load ASC 排序 + 系统推荐架 id。无 active 架映射该 process 时后端返 `20506 BIZ_SHELF_NO_MATCH_FOR_PROCESS`。
- **CNC 配对原子性**：`/parts/{id}/cnc-pair` 必须同时上传 G 代码 + 设定单；前端 el-upload 必须在同一 dialog 提交，不可拆两次调单文件端点（会导致数据不一致）。
- **货架-工位绑定 ≠ 货架-工人绑定**：当前仅多对多映射到「工序」，物理工人只能通过 SHELF_ACCOUNT ↔ 货架的账号绑定关系扫码。
- **雪花 ID 字符串**：`shelf_id` / `process_id` 全程 string。
- **物理顺序字段 `display_order`**：默认升序展示；未设置时显「未设置」warning tag。

## 十、未来扩展位

### #future-pages

- **货架-工人绑定**：与 SHELF_ACCOUNT 多对一账户绑定不同，物理工人花名册（`t_worker`）目前未与货架直接绑定；扩展后可在 HMI 选择工人时按货架过滤。
- **CNC 自动配对上传**：当前需要两次选文件；可扩展为「按图纸号自动匹配历史设定单」一键上传。
- **货架二维码打印**：每架生成带 `code` 的 PDF 标签页（复用 `printPartDrawingBatch` 的批量合并能力）。
