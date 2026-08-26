# 后端需求：批量通过品检 + 21418 failures 扩展

> 交付对象：hsh-erp-rust 后端 agent
> 提出方：myERP 前端（Ren / 2026-08-24）
> 适用范围：v2 业务 REST（`/api/v2`），不动 v1
> 关联：阻塞弹窗 21418 / 21405 一键通过品检（`composables/useBulkPassInspection.ts`）

---

## 背景

前端在用户扫码建单遇 21418 / 21405 时，由 `BatchSubmitInspectionConfirmDialog`（`src/components/delivery/BatchSubmitInspectionConfirmDialog.vue`）统一弹出；该对话框对 `status === 'INSPECTION'` 的失败子件提供「同时过检此件」列，勾选后追加调 `POST /parts/batch-pass-inspection`。

历史背景：本需求提出时（2026-08-24），扫码建单阻塞弹窗由 `BlockedScanConfirmDialog`（已删除，commit `f33583a`）消费 worker pool：

- 9 件阻塞 → 9 次 `POST /api/v1/parts/{id}/pass-inspection` 串/并发
- 9 次 round-trip + 9 个独立事务
- 失败语义依赖前端聚合，没有原子性

更根本的问题：**当时 21418 响应的 `data.failures[]` 只带 `serial_no / name / reason`**（`src/modules/delivery_note/dto.rs:544-548`），前端拿不到 `part_id`，所以弹窗的"一键通过"按钮默认 disabled（已删除组件 `BlockedScanConfirmDialog.vue` 的 `canBulkPass` guard）。

本次需求两个变更一起上：
1. 新增批量通过品检端点（v2）— 替代 worker pool
2. 扩展 `ScanFailureDto` — 让 21418 的 failures 自带 `part_id`，弹窗可直接喂给 batch 端点

落地后，`batchPassInspection` 在扫码建单侧被 `BatchSubmitInspectionConfirmDialog` 的「同时过检此件」分支消费；在提交草稿侧仍由 `BatchInspectionConfirmDialog` 消费（INSPECTION-only 路径，行为不变）。

---

## 需求 1：批量通过品检端点

### `POST /api/v2/parts/batch-pass-inspection`

权限: **Manager / Inspector**（与单件 `POST /parts/{id}/pass-inspection` 对齐）

Request body:

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `items` | array | ✓ | 1..=200 条 |
| `items[].part_id` | string (i64) | ✓ | 雪花 ID（与全仓约定一致，前端用 `string` 传） |
| `items[].batch_id` | string (i64)? | — | 缺省按状态唯一 INSPECTION 批次解析（与单件 `pass-inspection` 行为一致） |
| `items[].quantity` | i32? | — | 缺省 = 批次全量；< 批次量时拆分 |

Response 200 `data`：`BatchPassInspectionOut`

| 字段 | 类型 | 说明 |
|---|---|---|
| `passed` | [PartOut] | 成功通过的件（沿用现有 PartOut 序列化，含 `#[serde(serialize_with = "shared::types::serialize_i64")]`） |
| `failed` | [BatchPassFailure] | 失败明细（见下） |

`failed[]`：

| 字段 | 类型 | 说明 |
|---|---|---|
| `part_id` | string (i64) | 雪花 ID；与 request `items[].part_id` 一一对应 |
| `code` | i32 | 业务错误码（复用现有 part 域 20101 / 20103 / 20104） |
| `message` | string | 错误 message，原样透传 |

错误码（端点级别，非 per-item）：

| code | 名称 | 触发场景 |
|---|---|---|
| 40001 | VALIDATION_ERROR | `items` 为空 / 超过 200 / 元素缺 part_id / part_id 不是数字 |
| 40300 | FORBIDDEN | 角色不足（非 Manager / Inspector） |

**200 OK 的语义**：调用整体成功（即"request 被处理"）；per-item 失败走 `data.failed[]`，**不抛错**。这与现有 `batchUpdatePartsOrderInfo` (`api/v1/part.py:408`) 的部分失败模式一致。

### 事务/并发设计约束（给后端 agent 决策参考）

- **每件独立事务**：与现 worker pool 的失败语义等价——`passed` 不被 `failed` 拖累；任意一件 commit 后失败，不影响已通过的件。
- **状态机复用**：passed 单件走与现有单件 `pass-inspection` **完全相同**的 `INSPECTION → READY_TO_SHIP` 路径（`src/modules/part/statemachine.rs`），确保：
  - `t_part_event` 写入一致（事件类型、操作人、时间戳、备注等）
  - 流水号 / actual_delivery_date 等副作用一致
  - OCC 行为一致（version 校验）
- **实现建议**：service 层 `batch_pass_inspection` 内部循环调单件 service fn（共用事务边界），handler 层只做参数校验 + 编排。不要重写一遍状态机。
- **并发**：单请求顺序处理即可（N=200 在 PG 一次 round-trip 内完全可接受；不需要内部并发）。
- **超时**：与单件端点一致（10s 量级）；前端 `bulkPassInspection` 调本端点时可考虑 30s+（前端会有进度反馈）。

---

## 需求 2：扩展 `ScanFailureDto`

### 当前定义

`src/modules/delivery_note/dto.rs:544-548`：

```rust
/// 扫码入单失败子件明细（用于 21418 装配件整套拒绝响应）。
#[derive(Debug, Clone, Serialize)]
pub struct ScanFailureDto {
    pub serial_no: String,
    pub name: String,
    pub reason: String,
}
```

### 目标定义

```rust
/// 扫码入单失败子件明细（用于 21418 装配件整套拒绝响应）。
///
/// `part_id` 是关键：前端「一键通过品检」按钮依赖它把 failures
/// 喂给 `POST /parts/batch-pass-inspection`。21405 散件失败无
/// part_id 时填 0，前端会 guard 跳过。
#[derive(Debug, Clone, Serialize)]
pub struct ScanFailureDto {
    #[serde(serialize_with = "crate::shared::types::serialize_i64")]
    pub part_id: i64,
    #[serde(serialize_with = "crate::shared::types::serialize_i64", skip_serializing_if = "Option::is_none")]
    pub batch_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub drawing_no: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    pub serial_no: String,
    pub name: String,
    pub reason: String,
}
```

### 填值规则

| 字段 | 21418 装配件整套拒绝 | 21405 散件拒绝 |
|---|---|---|
| `part_id` | 真实 part_id（必填） | 0（无 part 级，21405 走 message 解析 fallback） |
| `batch_id` | 当前 INSPECTION 批次 id（必填） | null |
| `drawing_no` | 真实图号 | null |
| `status` | 实际阻塞状态（如 `OUTSOURCE`） | null |
| `serial_no` | 真实 serial_no | "—"（占位，前端不消费） |
| `name` | 名称 | "扫码件"（占位） |
| `reason` | `status=XXX` 串 | 后端 message 原样 |

### 文档同步

- `docs/api/delivery-notes.md:100-107` 的 `skipped[]` 字段表追加 `part_id` / `batch_id` / `drawing_no` / `status`，标明「21405 场景 part_id=0、其它字段为 null」
- 21418 / 21405 节描述里加一行"前端可基于 part_id 构造批量通过品检请求"

---

## 错误码分段提示

- 20101 `BIZ_PART_NOT_FOUND` — 复用
- 20103 `BIZ_INVALID_TRANSITION` — 复用
- 20104 `BIZ_INVALID_VALUE` — 复用
- 40001 `VALIDATION_ERROR` — 端点参数错误
- 40300 `FORBIDDEN` — 角色不足

不要新增 part 域业务码（201xx 段已够用）；如果 40300 不够细粒度，可考虑 40301 `SHELF_MISMATCH`（ShelfAccount 不在本范围），但本次默认 Manager / Inspector 不涉及。

---

## 实施 checklist

按顺序执行；每步可独立 commit：

1. [ ] `src/modules/part/dto.rs` 新增：
   - `BatchPassItem { part_id, batch_id?, quantity? }`
   - `BatchPassFailure { part_id, code, message }`
   - `BatchPassInspectionOut { passed: Vec<PartOut>, failed: Vec<BatchPassFailure> }`
   - `BatchPassInspectionRequest { items: Vec<BatchPassItem> }`
2. [ ] `src/modules/part/service.rs` 实现 `batch_pass_inspection`，内部循环调现有的单件 `pass_inspection`（共用 service fn，确保状态机 / 事件写入一致）
3. [ ] `src/modules/part/handler.rs` 新增路由 `POST /batch-pass-inspection`（注意：必须在 `/{part_id}/` catch-all 之前注册，参考 `api/v1/part.py:929-930` 注释「注册顺序」）
4. [ ] `src/modules/part/mod.rs` 把 handler route 装进 `pub fn router()`（当前是空 Router，需要确认 v2 路由前缀是 `/api/v2/parts`，见 `src/modules/mod.rs:60`）
5. [ ] `src/modules/delivery_note/dto.rs` 扩展 `ScanFailureDto`（按上面目标定义）
6. [ ] `src/modules/delivery_note/service.rs` 在 21418 / 21405 抛出点填 part_id：
   - 21418：从子件 part 实体直接读 id / batch_id / drawing_no / status
   - 21405：part_id=0，其它字段 null
7. [ ] `docs/api/parts.md`（**新建**，按 `delivery-notes.md` 模板：模块说明 → 端点列表 → 逐端点字段表 → 共享 DTO）
   - 端点列表加 `POST /api/v2/parts/batch-pass-inspection`
   - 共享 DTO 段加 `BatchPassItem` / `BatchPassFailure` / `BatchPassInspectionOut` / `BatchPassInspectionRequest`
   - "未上线域" 段从 `docs/api/index.md` 的 part 行删除
8. [ ] `docs/api/delivery-notes.md` 21418 节 `skipped[]` 字段表追加 `part_id` / `batch_id` / `drawing_no` / `status`，描述里加批量品检指引
9. [ ] `docs/api/index.md` 顶部「模块 API」表 part 行从"未上线"移到"已上线"，写明端点数（1：batch-pass-inspection）
10. [ ] `tests/part_api.rs`（**新建**或扩展）加：
    - happy path：3 件 INSPECTION 状态 → batch 全部通过，返 `passed=3, failed=0`
    - partial failure：3 件中 1 件 IN_PROCESS → 返 `passed=2, failed=1 (20103)`
    - validation：items=[] → 40001
    - permission：Clerk 角色 → 40300

---

## 前端落地（参考，非本仓 PR 范围）

本次变更落地后，前端 `bulkPassInspection` 可从 worker pool 切换到新端点：

```ts
// api/parts.ts
export interface BatchPassInspectionRequest {
  items: { part_id: string; batch_id?: string; quantity?: number }[]
}
export interface BatchPassFailureFE { part_id: string; code: number; message: string }
export interface BatchPassInspectionOutFE {
  passed: PartItem[]
  failed: BatchPassFailureFE[]
}

export async function batchPassInspection(
  items: BatchPassInspectionRequest['items'],
): Promise<BatchPassInspectionOutFE> {
  const { data } = await apiV2.post<BatchPassInspectionOutFE>(
    '/parts/batch-pass-inspection',
    { items },
  )
  return data
}
```

`BatchSubmitInspectionConfirmDialog` 切到新端点后：
- 「同时过检此件」勾选行的 `part_id` 真正可用（`ScanFailureDto` 扩展后）
- N 件阻塞 → 1 次 `batchPassInspection` round-trip，无竞态
- 错误码 20101 / 20103 走 `data.failed[]`，UI 仍可逐件标红

迁移 changelog：
- 2026-08-26（commit `45cc6df`）：扫码阻塞对话框切换为送检（`BatchSubmitInspectionConfirmDialog`），消费 `useBulkScanInspect`；INSPECTION 行通过「同时过检此件」列复用本端点。
- 2026-08-26（commit `f33583a`）：删除孤儿 `BlockedScanConfirmDialog`（已无引用）。
- 提交草稿时 INSPECTION-only 的过检仍由 `BatchInspectionConfirmDialog` 消费本端点，行为不变。

`useBulkPassInspection` 保留作为 fallback（万一后端部署延迟，前端照常工作）。
