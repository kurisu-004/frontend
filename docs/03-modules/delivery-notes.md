# 送货单

> **目标读者**：前端开发（添加/修改送货单域页面）
> **核心价值**：送货单管理（CRUD + 详情 + 缓存）+ 扫码建单（v2）+ 司机送货台；2026-08-24 全量切 v2
> **最后更新**：2026-08-26 · **维护者**：@frontend-team

---

## 一、入口与路由

| 路径 | 名称 | 说明 |
|---|---|---|
| `/delivery-notes` | `DeliveryNoteList` | 送货单一览 |
| `/delivery-notes/:id` | `DeliveryNoteDetail` | 详情（含分件扫码 UI） |
| `/delivery-notes/scan` | `DeliveryNoteScan` | 扫码建单（v2 入口，2026-08-21 上线） |
| `/delivery-dispatch/badge` | `DispatchBadge` | 司机工牌识别（全屏独立） |
| `/delivery-dispatch/notes` | `DispatchNotes` | 司机待送货单选择 + 逐件扫 |

路由定义见 `src/router/index.ts`。送货单管理三页（list / detail / scan）共用 menuCode `delivery_notes_manage`，挂在「订单管理」侧栏下；扫码建单**不暴露为独立菜单**，通过列表页顶部「扫码建单」按钮进入。司机送货台是全屏独立路由树（脱离 `MainLayout`），与工位扫码台同形态。

## 二、关键页面

| 文件 | 职责 |
|---|---|
| `src/views/delivery/DeliveryNoteList.vue` | 送货单一览（18.5K）；筛选 / 排序 / 分页；状态机操作按钮 |
| `src/views/delivery/DeliveryNoteDetail.vue` | 详情（8.1K），2026-08-25 拆为壳 + 3 子组件 + composable |
| `src/views/delivery/DeliveryNoteScan.vue` | 扫码建单（13.6K），v2 入口；选 L1 客户 → 草稿卡 → 扫码加件 → 提交 |
| `src/views/delivery-dispatch/DispatchBadgeGate.vue` | 司机工牌识别（3.8K） |
| `src/views/delivery-dispatch/DispatchNoteList.vue` | 司机待送货单（13.4K）；逐件扫 + 确认送达 |

### DeliveryNoteDetail 拆分后结构

- `<DeliveryNoteHeaderCard>` — page-header + info card + 送货日期 picker
- `<DeliveryNoteLineItemsTable>` — 列显隐 + 树形 line items 表
- `<DeliveryNoteDispatchControls>` — 状态机操作按钮
- composable `useDeliveryNoteDetail` — 数据 + 派生 + 列显隐
- composable `useDeliveryNoteActions` — 业务操作（confirmDangerous + 业务 API）

## 三、子组件

### `src/views/delivery/components/`（8 个）

| 文件 | 职责 |
|---|---|
| `DeliveryDraftCard.vue` | 草稿卡（扫码建单页消费） |
| `DeliveryNoteHeaderCard.vue` | 详情头卡 |
| `DeliveryNoteLineItemsTable.vue` | 行项目表（树形 + 列显隐） |
| `DeliveryNoteDispatchControls.vue` | 状态机操作按钮 |
| `DeliveryGroupEditor.vue` | 送货分组编辑 |
| `DeliveryGroupPanel.vue` | 送货分组面板 |
| `DeliveryScanBar.vue` | 扫码条 |
| `DeliveryDateChip.vue` | 送货日期 chip |

### `src/components/delivery/`（5 个弹窗）

| 文件 | 职责 |
|---|---|
| `BatchInspectionConfirmDialog.vue` | 批量过品确认弹窗（消费 `useBulkPassInspection`） |
| `BatchSubmitInspectionConfirmDialog.vue` | 批量送检确认弹窗（消费 `useBulkScanInspect`，处理 21418 / 21405 失败分流） |
| `BlockedScanConfirmDialog.vue` | 阻塞扫码弹窗（21418 / 21405 失败明细） |
| `PartPickerDialog.vue` | 零件选择弹窗 |
| `PrintPreviewDialog.vue` | 打印预览弹窗 |

### 内部子组件（`src/views/scan/components/` 复用）

`BatchPickerDialog` / `DeliveryDateChip` / `HeldPartsBadge` / `ProcessPickerDialog` / `QuantityDialog` / `ScrollFabPair` / `ShelfPickerDialog` —— 扫码建单页大量复用扫码台 HMI 组件。

## 四、主要 API 调用

### `src/api/deliveryNote.ts`（17 个端点，全部 `apiV2`，2026-08-24 切）

`listNotes` / `listPickupPending` / `createNote` / `getNote` / `listBatchDeliveryDetails` / `listNoteEvents` / `addParts` / `removeParts` / `submitNote` / `recallNote` / `pickupScan` / `pickup` / `softDeleteNote` / `listCandidateParts` / `updateNote` / `printNote` / `scanDelivery`。

### `src/api/deliveryGroup.ts`（V2 P1，全部 `apiV2`）

`listDeliveryGroups` / `createDeliveryGroup` / `updateDeliveryGroup` / `softDeleteDeliveryGroup`。

## 五、相关 composable

| 名称 | 文件 | 作用 |
|---|---|---|
| `useDeliveryNoteDetailCache` | `src/composables/useDeliveryNoteDetailCache.ts` | 5 分钟 in-memory 缓存 + in-flight Promise 去重（**含 spec.ts**） |
| `useDeliveryScanState` | `src/composables/useDeliveryScanState.ts` | 扫码建单页 L1 客户选择持久化（localStorage key `delivery_scan_l1_v1`） |
| `useDeliveryNoteActions` | `src/views/delivery/composables/useDeliveryNoteActions.ts` | 业务函数（submit / recall / scan / print）+ confirmDangerous 二次确认 |
| `useDeliveryNoteDetail` | `src/views/delivery/composables/useDeliveryNoteDetail.ts` | 数据 + 派生 + 列显隐 |
| `useDeliveryDraftBoard` | `src/views/delivery/composables/useDeliveryDraftBoard.ts` | 草稿看板（多草稿同时编辑） |
| `useDeliveryScanSubmission` | `src/views/delivery/composables/useDeliveryScanSubmission.ts` | 扫码提交流（草稿 → 提交 → 失败分流） |
| `usePrintedLabels` | `src/composables/usePrintedLabels.ts` | 已打印标签去重 |
| `usePooledDetail` | `src/composables/usePooledDetail.ts` | 详情 N+1 GET 并发限流（默认 4 并发）；任一失败 → 该位置返回 null，不阻断其他 worker |

### `useDeliveryNoteDetailCache` 详解

- 5 分钟 TTL（`TTL_MS = 5 * 60 * 1000`）；过期自动清理 entry。
- 模块级 `cache: Map<noteId, { detail, loadedAt }>` + 模块级 `pending: Map<noteId, Promise>` 去重并发 reload。
- 失效语义：
  - mutation 后端返新 detail → `put(noteId, detail)` 直接写入（避免又调一次 fetcher）。
  - 状态变更可能影响行数（add / remove / scan 命中） → `invalidate(noteId)` 下次 get 重拉。
  - note 从本地消失（submit / softDelete） → `invalidate(noteId)`。
- 不持久化（DRAFT 内容实时变化，缓存到 disk 极易脏）；不跨标签页（BroadcastChannel 过度设计）。

## 六、业务流程

**状态机**：`DRAFT → SUBMITTED → PICKING_UP → IN_TRANSIT → DELIVERED → CONFIRMED`。

| 流程 | 步骤 |
|---|---|
| 扫码建单 | 选 L1 客户 → 草稿卡 → 扫码加件 → 提交 |
| 司机送货 | 扫码上车（`/delivery-dispatch/badge`） → 待送货单选择 → 逐件扫 → 确认送达 |
| 详情操作 | 添加零件 / 移除零件 / 提交 / 撤回 / 软删 / 扫码领取链接（仅 SUBMITTED 状态） |

扫码建单页遇到 21418（`BIZ_DELIVERY_ASSEMBLY_PARTS_NOT_READY` 装配件整套拒绝）/ 21405 失败时，弹 `<BlockedScanConfirmDialog>` 或 `<BatchSubmitInspectionConfirmDialog>`，按 failures[].status 分流（INSPECTION → 弹 BlockedScanConfirmDialog；IN_PROCESS / PENDING / PROGRAMMING → 弹 BatchSubmitInspectionConfirmDialog）。

## 七、权限要求

| 域 | 角色 |
|---|---|
| 送货单管理（CRUD） | `MANAGER` / `CLERK` |
| 送货单只读 | 其他角色 |
| 扫码建单 | 所有角色（共用 `delivery_notes_manage` menuCode） |
| 司机送货台 | 所有角色（但通常司机账号；后台 `user.menus` 过滤） |

## 八、后端契约锚链

| 文档 | 路径 |
|---|---|
| delivery-notes 域 | `~/Code/hsh-erp-rust/docs/api/delivery-notes.md`（18 端点，完全上线 P1–P4） |
| delivery-groups 域 | `~/Code/hsh-erp-rust/docs/api/delivery-groups.md`（4 端点，P1 完全上线） |

## 九、关键约束与陷阱

- **v2 切换后 `ARRAY_AS_CSV_KEYS` 含 `statuses`**：白名单 key 序列化为 CSV 单值 `?statuses=A,B`（与 v1 重复参数 `?statuses=A&statuses=B` 不同），见 `src/api/http.ts` 的 `ARRAY_AS_CSV_KEYS`。
- **详情缓存策略（5min in-memory）**：mutation 后端已返新 detail 时必须 `put` 写入，不能仅 `invalidate`（避免又调一次 fetcher）。
- **批量过品的阻塞弹窗 `BlockedScanConfirmDialog`**：21418 错误码（`BIZ_DELIVERY_ASSEMBLY_PARTS_NOT_READY` 装配件整套拒绝含不可入单子件），失败明细走 `data.failures[]`（2026-08-25 后端扩展 `ScanFailureDto`）。
- **`usePooledDetail` 失败语义**：任一 worker 抛错 → 该位置返回 null，**不阻断**其他 worker；不适合做副作用密集的写操作（写操作统一走 `useBulkPassInspection` / `useBulkScanInspect` 单 round-trip）。
- **扫码建单走 v2 但 list / detail 仍是 v1（混合期）**：2026-08-24 起全量切 v2，但 delivery_note 的列表 / 详情 / 事件等只读端点从 v1 切到 v2 时序不同，迁移期间务必确认后端对应端点已上线。
- **雪花 ID 必为 string**：`note_id` / `part_id` / `worker_id` / `shelf_id` / `group_id` 全部 `string`。

## 十、跨域锚链

- 批量过品（v2）见 [inspection-and-repair.md](inspection-and-repair.md)（`useBulkPassInspection` / `useBulkScanInspect`）。
- 批量送检（v2）见 [inspection-and-repair.md](inspection-and-repair.md) 的批量过品章节（送检端点对称）。
- 扫码台 HMI 组件复用见 [scan-station.md](scan-station.md)。
- 大屏 WS 实时事件（INSPECT 后状态变更触发推送）见 [dashboard.md](dashboard.md)。

## 十一、未来扩展位

- 路线优化（多送货单最优路径规划）
- 司机绩效统计（按时率 / 拒收率 / 里程）
- 装配件整套入单（跨域原子性，21418 已支持明细，未来扩展自动拆单）
- 电子签收（司机 / 客户双确认）
- 送货单 PDF 直出（替代当前 HTML 打印预览）
