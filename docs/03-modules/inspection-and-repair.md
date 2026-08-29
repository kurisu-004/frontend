# 品检与返修

> **目标读者**：前端开发（添加/修改品检/返修域页面）
> **核心价值**：单件 / 批量品检 + 返修流转；批量过品与批量一键送检是当前最大跨域聚合点
> **最后更新**：2026-08-26 · **维护者**：@frontend-team

---

## 一、入口与路由

| 项 | 值 |
|---|---|
| 待品检 | `/inspection/pending` |
| 返修接收 | `/repair/receive` |
| 守卫 | `requireAuth: true`（所有登录用户） |
| 父级 | `MainLayout` 子树 |
| 待品检 menuCode | `inspection_pending` |
| 返修接收 menuCode | `repair_receive` |

路由定义见 `src/router/index.ts`。两个页面都挂在「订单管理」侧栏下，与 `/parts` 同级。

## 二、关键页面

| 文件 | 职责 |
|---|---|
| `src/views/inspection/InspectionPending.vue` | 全仓最大单文件（34.5K），INSPECTION 状态零件一览；顶部搜索 + 5min 自动刷新 + 共 N 条；行内「品检通过」「指定工序」两个动作；加急行整行红底。复用了 `<PartListShell>` 收口 filter / 列显隐 / 表格 / 分页壳 |
| `src/views/repair/RepairReceive.vue` | 返修接收主页面（14.7K），双 Tab：「已送货」（DELIVERED 批次，可点「返修」弹一步式 dialog） / 「返修中」（REPAIRING 批次，纯查询）。表格风格复用零件一览；扫码命中已送货列表直接弹 dialog，未命中复用 `findPartBySerialAndPrompt` 提示 |
| `src/views/repair/RepairStartDialog.vue` | 返修开工弹窗（8.5K），一步式收集数量 + 工序 + 货架（INSPECTION / PRODUCTION zone） |
| `src/views/inspection/composables/useInspectionList.ts` | InspectionPending 的 fetcher；fetch 失败抛错，由 `PartListShell.safeFetcher` 接住 |

## 三、主要 API 调用

| 端点 | 实例 | 用途 |
|---|---|---|
| `POST /parts/batch-pass-inspection` | `apiV2` | 批量通过品检（N≤200，单 round-trip，per-item 失败走 `data.failed[]`） |
| `POST /parts/batch-scan-inspect` | `apiV2` | 批量一键送检（共享品检架 + per-item decision） |
| `POST /parts/{id}/scan-inspect` | `apiV2` | 单件一键送检（2026-08-25 切 v2；InspectionPending 唯一的单件调用点已跟切） |
| `GET /parts/repair-batches` | `api`（v1） | 返修接收 · 已送货列表 |
| `GET /parts/repairing-batches` | `api`（v1） | 返修接收 · 返修中列表 |
| `POST /parts/{id}/start-repair` | `api`（v1） | 创建维修工单（INSPECTION/READY_TO_SHIP/DELIVERED → REPAIRING；支持 batch_id + quantity 部分返修） |
| `POST /parts/{id}/complete-repair` | `api`（v1） | 返修完成（→ ON_SHELF 或 → INSPECTION；shelf.zone 决定去向） |

v1/v2 混合期：inspection 域已切 v2（pass/batch-pass/scan-inspect/batch-scan-inspect 全部走 `apiV2`），repair 域仍走 v1（生命周期端点在 Rust 主仓尚未实施）。

## 三点五、批次级 caller OCC（2026-08-29 起）

5 个 inspection / 状态迁移端点入参**必带** `version`，锚 `t_part_batch.version`（不是 `t_part.version`）：

| 端点 | 必填字段 |
|---|---|
| `POST /parts/{id}/to-inspection` | `target_inspection_shelf_id` / `batch_id` / `version` |
| `POST /parts/{id}/to-ship` | `batch_id` / `version` |
| `POST /parts/{id}/to-process` | `shelf_id` / `next_process_id` / `batch_id` / `version` |
| `POST /parts/batch-to-inspection` | `target_inspection_shelf_id` / `items[].batch_id` / `items[].version` |
| `POST /parts/batch-to-ship` | `items[].batch_id` / `items[].version` |

`version` 不符 → **40901 BIZ_VERSION_CONFLICT**。批量端点 per-item 落 `failed[]`，不中断整批；单件端点直接 4xx 抛错。

### version 来源

- `DeliveryNoteLineItem.version`（note detail `line_items[]` 每行带 batch version）
- `listInspectionBatches` 行的 `version`（与 `OutsourceSendableItem.version` 约定一致，batch level）
- `OutsourceSendableItem.version`（外协接收批量）
- `submit` 返回 `unresolved_targets[].available_batches[].version` + scan 同样字段
- `PartBatch.version`（通过 `listPartBatches(partId)` 取得）

### `/parts/worker-scan` 豁免

纯扫码流，前端手头无 version；保留 service 内部 OCC（不外推到 caller）。

### 前端契约位置

- 类型：`src/composables/useBulkPassInspection.ts` `BulkPassItem.version` / `src/composables/useBulkScanInspect.ts` `BulkScanItem.version`（均必填）
- API 类型：`src/api/parts/batch.ts` `BatchToShipItem.version` / `BatchToInspectionItem.version`（均必填）
- 单测：`src/composables/useBulkPassInspection.spec.ts` + `src/composables/useBulkScanInspect.spec.ts` 各加 40901 落 `failed[]` + `version` 端到端透传用例

详见 [plan](../../../.claude/plans/claude-plans-2026-08-29-submit-candidat-idempotent-hamster.md)（F.1–F.4 段）。

## 四、批量过品的实现

两个批量 composable 是本域的关键抽象：

### `useBulkPassInspection`

- 调用 `apiV2.batchPassInspection(items)` 一次，单 round-trip 处理 N≤200 件。
- 返回 `{ passed, failed }`：`passed[]` 按 part_id 反向找回原始 `BulkPassItem`（保留 `label`，弹窗可定位）；`failed[]` 透传后端 code + message。
- 端点级错误（VALIDATION_ERROR / FORBIDDEN 等）走 catch：把请求 items 全部标为失败抛回，弹窗走 part-partial / 全失败兜底分支。
- `progress: { done, total }` 字段保留供 UI 进度条使用；单 round-trip 语义下 done 一次跳到 total，但保留字段便于未来扩展（流式返回 / 多批次拆分）。
- 单测：`composables/useBulkPassInspection.spec.ts`。

### `useBulkScanInspect`

- 镜像 `useBulkPassInspection` 的契约（`BulkScanItem` / `BulkScanFailure` / `BulkScanResult` / `BulkScanProgress` 字段命名对称）。
- 必传 `{ target_inspection_shelf_id, items }`：共享品检架 + per-item decision（缺省 PASS）+ per-item 数量。
- FAIL 路径需要同时给 `shelf_id` + `next_process_id`（前端 UI 默认全 PASS，validator 由后端拦截）。
- 单测：`composables/useBulkScanInspect.spec.ts`。

替代了之前的 worker pool 方案（9 件 → 9 次 POST）：v2 单次 round-trip 不需要前端并发控制，progress 字段保留仅为后续扩展。

## 五、相关 composable / utils

| 名称 | 文件 | 作用 |
|---|---|---|
| `useBulkPassInspection` | `src/composables/useBulkPassInspection.ts` | 批量过品 |
| `useBulkScanInspect` | `src/composables/useBulkScanInspect.ts` | 批量送检 |
| `usePartLocationTree` | `src/composables/usePartLocationTree.ts` | 选品检架 / 工序共享树；`in-flight Promise` 去重并发 reload |
| `useInspectionList` | `src/views/inspection/composables/useInspectionList.ts` | InspectionPending 的 fetcher |
| `useBarcodeScanner` | `src/composables/useBarcodeScanner.ts` | 全局扫码枪 keydown 监听 |
| `useCustomerTree` | `src/composables/useCustomerTree.ts` | 客户树筛选 |
| `useColumnVisibility` | `src/composables/useColumnVisibility.ts` | 列显隐 popover |
| `PartListShell` | `src/components/PartListShell.vue` | 过滤卡 + 列显隐 + 表格 + 分页 + 加急红底 复用壳 |
| `findPartBySerialAndPrompt` | `src/utils/scanHelpers.ts` | 扫码错页提示，VNode message 多行渲染 |

## 六、InspectionPending 内部结构

- 用 `<PartListShell>` 收口 filter / 列显隐 / 表格 / 分页 / 加急红底；列定义 / 操作列仍在本文件。
- 表格列：批次 / 零件（serial_no + drawing_no + name）/ 客户 / 优先级 / 操作。
- 加急行整行红底 `#fde2e2`（与零件一览同款）。
- 批量过品按钮（一键）：多选后批量过品，调 `useBulkPassInspection`。
- 顶部搜索：图号 / 名称（前缀搜索）+ 序列号 + 计划日期范围 + 客户树筛选；手动刷新 + 5min 自动刷新。

## 七、RepairReceive 内部结构

- 双 Tab：`delivered` / `repairing`，`activeTab` 切换不重发请求。
- 「已送货」Tab 操作：点「返修」→ 弹 `RepairStartDialog`（数量 + 工序 + 货架），提交调 `startPartRepair`。
- 「返修中」Tab 纯查询，无操作按钮。
- 扫码：`useBarcodeScanner` 全局监听；命中已送货列表弹 dialog；未命中复用 `findPartBySerialAndPrompt` 提示。
- 表格风格复用零件一览：`el-table` + 列显隐 + 排序 + 加急红底 + 客户 el-tree-select 筛选。

## 八、权限要求

| 角色 | 权限 |
|---|---|
| `INSPECTOR` | 品检通过 / 打回 / 返修改 |
| `MANAGER` | 全权 |
| `CLERK` | 返修读 + 创建维修工单 |
| 其他角色 | 菜单不可见 |

后端 `POST /parts/batch-pass-inspection` / `batch-scan-inspect` 路由级 require role `Manager / Inspector`。

## 九、后端契约锚链

| 文档 | 路径 |
|---|---|
| part 域 API（含 pass / scan-inspect / batch 端点） | `~/Code/hsh-erp-rust/docs/api/parts.md` |
| 批量过品需求 | `docs/api-requirements/batch-pass-inspection.md` |
| 扫码送检需求 | `docs/api-requirements/scan-inspect.md` |

## 十、关键约束与陷阱

- **批量乐观锁与冲突处理**：v2 `batch-pass-inspection` / `batch-scan-inspect` 是后端顺序处理 + per-item 原子；前端拿到 `{ passed, failed }` 后由弹窗决定是否继续后续动作（如部分通过 → 调 submitNote 仅包通过的）。
- **返修接收创建维修工单的副作用**：v1 端点 `startPartRepair` 会触发批次拆分（`batch_id` + `quantity` 部分返修路径），需确认调用方传入的 `batch_id` 与当前状态一致。
- **`usePartLocationTree` 共享品检架**：批量送检必填 `target_inspection_shelf_id`，从该 composable 选取（zone=INSPECTION, is_active）。
- **加急红底**：`PartListShell.rowClassName` 已收口；不要在本视图再写一份。
- **雪花 ID 必为 string**：`part_id` / `batch_id` / `shelf_id` / `next_process_id` 全部 `string`，不要 `Number()`。

## 十一、跨域锚链

- 送检入口在 [scan-station.md](scan-station.md)（扫码台 PICK_UP / RETURN / INSPECT 三页均消费 `useBulkScanInspect` 共享批量送检）。
- 品检通过后状态变更触发的实时推送见 [dashboard.md](dashboard.md)（WebSocket 单例）。

## 十二、未来扩展位

- 批量取消品检（INSPECTION → IN_PROCESS 的批量 reverse）
- 返修工时统计（按工人 / 按工序聚合）
- 复检策略（首次 FAIL 后回流的判定规则）
- 跨批次合并品检（多个 batch 共享品检架的场景）
