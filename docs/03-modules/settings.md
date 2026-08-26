# 设置（工种 / 工序）

> **目标读者**：前端开发（维护工种-工序字典页）
> **核心价值**：工厂基础字典维护——工种、工序、工种↔工序多对多映射，三页一组构成车间业务底层配置
> **最后更新**：2026-08-26 · **维护者**：@frontend-team

---

## 一、入口与路由

| 路径 | 路由名 | menuCode | 守卫 |
|---|---|---|---|
| `/settings/work-types` | `WorkTypeList` | `work_types_list` | `requireAuth` |
| `/settings/processes` | `ProcessList` | `processes_list` | `requireAuth` |
| `/settings/work-type-processes` | `WorkTypeProcess` | `work_type_processes_list` | `requireAuth` |

父级为 `MainLayout` 子树。守卫是 router 默认 `requireAuth`；**角色未在 meta 中硬编码**，依赖后端菜单树（`user.menus`）是否下发对应 code。当前实际只有 MANAGER 在菜单里能看到这三项。

## 二、关键页面

| 文件 | 职责 |
|---|---|
| `src/views/settings/WorkTypeList.vue` | 工种一览（CRUD + 列显隐 popover + PagedTable） |
| `src/views/settings/ProcessList.vue` | 工序一览（CRUD，filter 含 `category` INHOUSE/OUTSOURCE） |
| `src/views/settings/WorkTypeProcess.vue` | 工种↔工序映射（左侧工种 + 右侧该工种可选工序的多选界面） |

三个页面风格统一：`el-card` 筛选条 → `ColumnVisibilityPopover` 列显隐 → `PagedTable` 数据区 → 顶部「新增」绿色按钮（仅 MANAGER 可见）。`ProcessList.vue` 顶部的「新增工序」按钮用 `v-if="isManager"` 控制显示。

## 三、主要 API 调用

| 模块 | 端点 | 实例 | 说明 |
|---|---|---|---|
| `src/api/workType.ts` | `/work-types`、`/work-types/{id}/processes` | `api`（v1） | 工种 CRUD + 映射读写 |
| `src/api/process.ts` | `/processes` | `api`（v1） | 工序 CRUD，按 `category` 筛选 |

| 函数 | HTTP | 用途 |
|---|---|---|
| `listWorkTypes(params)` | GET | 工种列表（`code_like` 模糊） |
| `createWorkType` / `updateWorkType` / `softDeleteWorkType` | POST | 工种写入，软删除 |
| `getWorkTypeProcesses` / `setWorkTypeProcesses` | GET / POST | 映射读写 |
| `listProcesses(params)` | GET | 工序列表（支持 `category` 过滤） |
| `createProcess` / `updateProcess` / `softDeleteProcess` | POST | 工序写入，软删除 |

`category` 是工序的维度：`INHOUSE`（自产）/ `OUTSOURCE`（外协），统计与外协下拉都消费这个枚举。

## 四、常量与枚举

| 文件 | 用途 |
|---|---|
| `src/constants/partStatus.ts` | `STATUS_LABEL` / `STATUS_TAG_TYPE`：工单状态的 label + Element Plus tag type 映射，统计页与生产总览复用 |
| `src/api/parts/batch.ts` | 批量送检 / 批量扫码相关常量（quantity / tolerance） |
| `src/api/parts/bid.ts` | 投标相关常量（bid sheet 列定义） |
| `src/api/parts/crud.ts` | CRUD 通用列宽 / 默认 pageSize 等 |
| `src/api/parts/file.ts` | 上传相关常量（MIME / size limit） |

> 注：本目录下的 `constants/` 仅 `partStatus.ts` 一个文件，其余按"按域归口"分散到对应 `api/<domain>/` 子目录；新增设置域相关常量建议放 `src/api/workType/` 或 `src/api/process/`。

## 五、权限

| 角色 | 可见 | 改 |
|---|---|---|
| MANAGER | 是 | 是 |
| CLERK / INSPECTOR / SHELF_ACCOUNT / CNC_PROGRAMMER | 否（菜单不发） | — |

破坏性操作（删除工种 / 删除工序 / 重置映射）都用 `el-popconfirm` 二次确认；删除是软删除（`/soft-delete`），后端写 `deleted_at` 即可保留历史关联。

## 六、相关 composable / utils

- `usePermissions` — 提供 `isManager` 控制新增 / 删除按钮显隐。
- `useColumnVisibility` — 列显隐持久化（localStorage）。

## 七、后端契约

- 三个域目前**仍在 v1 FastAPI 上**，后端 Rust 主仓 `~/Code/hsh-erp-rust/docs/api/` 暂无 `work-types.md` / `processes.md` 文档；接口行为以 `src/api/workType.ts` + `src/api/process.ts` 的端点为准。
- v2 切换排期待定：列入 `docs/03-modules/README.md` 的「未上线域」表。

## 八、关键约束与陷阱

- **工种-工序多对多**：删除工种前需检查映射（`getWorkTypeProcesses` 返回非空 → 提示先清映射）。后端 service 层会校验，前端也要兜底提示，避免「删除后映射残留导致后续下拉空白」。
- **状态码集中在 constants**：避免散落到各 list 视图；新增 status 时**先改 `constants/partStatus.ts`**，再改类型 / 后端。
- **变更会冲击所有 list 视图**：工种 / 工序字典一变，工人 (`Worker.work_type_id`)、装配、外协报价筛选全部受影响；批量改字典前在 changelog 里通告。
- **雪花 ID 必须 string**：`workType.id` / `process.id` 都是 string，前端严禁 `Number()`。
- **`ProcessList.vue` 工序列宽**：`code` / `name` / `category` 三列在窄屏会被压缩；如有新增列建议先收口到 `ColumnVisibilityPopover`。
- **category 枚举变更**：要同步改 `src/types/process.ts` 的 `ProcessCategory` 联合类型，并 grep 所有 `category ===` 判断处。

## 九、未来扩展位

### 9.1 `#future-pages`

- 工种 / 工序的 Excel 导入导出：复用 `xlsx`（只读解析，攻击面可控），可放设置菜单下作为子页。
- 历史版本对比：工种-工序映射变更审计，配合 `audit_log` 后端表展示 diff。
- 字典变更广播：字典变更后通过 dashboard WS 推一个 `DICT_CHANGED` 事件，其他业务页订阅后刷新本地缓存。
