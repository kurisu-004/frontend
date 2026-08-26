# 后端需求：一键送检（scan-inspect 单件 + 批量）

> 交付对象：hsh-erp-rust 后端 agent
> 提出方：myERP 前端（Ren / 2026-08-25）
> 适用范围：v2 业务 REST（`/api/v2`），不动 v1
> 关联：扫码建单 21418 / 21405 阻塞、品检员扫码台（`src/views/inspection/InspectionPending.vue`）
> 关联需求：v1 Python 后端已有等价实现 `POST /api/v1/parts/{part_id}/scan-inspect`（PR-I 2026-08-12，参见 `/Users/ren/Documents/Code/myERP/api/v1/part.py:927-951` + `service/part.py:4099-4210`）

---

## 背景

### 业务痛点

工人生产完工件后未主动送检（`IN_PROCESS + PRODUCTION_SHELF` 状态滞留），导致：

1. 品检员在 `InspectionPending` 看不到该件
2. CLERK 在 `/delivery-notes/scan` 扫码建单时被 21418 / 21405 拒绝
3. 装配件任一子件状态非 `INSPECTION / READY_TO_SHIP`，整组装配件 21418 整套拒绝

上一轮修复（`docs/api-requirements/batch-pass-inspection.md` + commit 66e3bc2）只覆盖了"已送检但未过检"的场景——通过 `batch-pass-inspection` 把 `INSPECTION → READY_TO_SHIP` 一键完成。这对"工人未送检"无效，因为工件状态根本还没到 `INSPECTION`。

### 目标

参考 v1 后端的 `scan-inspect` 能力，在 v2 实现同等语义：

- 状态流转 `PENDING / PROGRAMMING / IN_PROCESS+PRODUCTION_SHELF → INSPECTION`，随后按 `decision` 分流 PASS（→ `READY_TO_SHIP`）或 FAIL（→ `IN_PROCESS` 带回退工序）
- 同时提供批量版（共享品检架 + per-item 数量 + 可选 decision），覆盖装配件 N≤200 子件整组送检

### v2 当前缺口

- part 模块当前只上线 `pass_inspection`（单件 + 批量）
- 状态机 `can_transition_to` 白名单仅 `(INSPECTION → READY_TO_SHIP)` 和 `(PROGRAMMING → INSPECTION)`（后者注释明确说 service 不暴露）
- **没有 `scan_inspect` 端点**
- **`fail_inspection` 也没有**（grep 0 命中）；scan-inspect 的 FAIL 分支必须依赖它，**强烈推荐本 PR 一并补全**

---

## 需求 1：单件一键送检

### `POST /api/v2/parts/{part_id}/scan-inspect`

权限：**Manager / Inspector**（与现有 `pass_inspection` 对齐，复用 `PASS_INSPECTION_ROLES` 常量 `src/modules/part/handler.rs:34`）

Request body（`ScanInspectRequest`）：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `target_inspection_shelf_id` | string (i64) | ✓ | 雪花 ID；shelf.zone 必须 = `INSPECTION` 且 `is_active` |
| `decision` | `'PASS'` \| `'FAIL'` | ✓ | 第二步动作 |
| `shelf_id` | string (i64)? | FAIL 必填 | 目标生产货架 id（PRODUCTION 区 active） |
| `next_process_id` | string (i64)? | FAIL 必填 | 下一道工序 id（必须与 `shelf_id` 对应映射） |
| `note` | string? | — | ≤ 500 字符，FAIL 时品检备注 |
| `batch_id` | string (i64)? | — | 目标批次 id；缺省按状态唯一批次解析（多批次工单必须指定） |
| `quantity` | i32? | — | 部分数量；缺省 = 批次全量；>0 且 ≤ 批次剩余量 |

Response 200 `data`：`PartOut`

### 业务流程（service 层）

仿 v1 `service/part.py:4099-4210`，单事务：

1. 解析批次 `_resolve_target_batch`，白名单 `{PENDING, PROGRAMMING, IN_PROCESS}`；多批次工单缺省报错 20109
2. **拒绝 IN_PROCESS + WORKER** → 抛 `20103 BIZ_INVALID_TRANSITION`，message 提示"工人持有件请先归还或送检"
3. **拒绝 IN_PROCESS + 非 PRODUCTION_SHELF** → 抛 `20103`，message 提示"不在生产架上，无法快捷品检"
4. 校验品检架：`_validate_inspection_shelf`，新增 zone=INSPECTION（`20511`）和 is_active（`20512`）检查
5. 部分量拆批 `_maybe_split`（或 `split_batch_for_partial_pass`）
6. **第一步**（搬到 INSPECTION）：
   - `t_part.status = 'INSPECTION'`，`location = 'INSPECTION_SHELF'`，`current_holder_id = shelf.id`，OCC 守卫
   - INSERT `t_part_event`：`event_type='INSPECTED'`，`from_status` 记录原状态，`to_status='INSPECTION'`，`note` 区分来源：
     - PENDING → "扫码快捷品检：来自待下发 → 品检架 {code}"
     - PROGRAMMING → "扫码快捷品检：来自编程中 → 品检架 {code}"
     - IN_PROCESS → "扫码快捷品检：来自生产架 → 品检架 {code}"
   - WS 广播 `INSPECTED`（`docs/api/websocket.md`）
7. **第二步**（decision 分流，**同事务**）：
   - `PASS` → 调现有 `pass_inspection_core(part_id, batch_id=target.id)`（已存在，复用）
   - `FAIL` → 调 `fail_inspection_core(part_id, shelf_id, next_process_id, note, batch_id=target.id)`（**依赖需求 3**，若未实现则此分支抛 501）

---

## 需求 2：批量一键送检

### `POST /api/v2/parts/batch-scan-inspect`

权限：**Manager / Inspector**

Request body（`BatchScanInspectRequest`）：

```rust
pub struct BatchScanInspectRequest {
    pub target_inspection_shelf_id: String,  // 共享品检架
    pub items: Vec<BatchScanInspectItem>,    // 1..=200
}

pub struct BatchScanInspectItem {
    pub part_id: i64,
    pub decision: Option<ScanDecision>,  // 缺省 = PASS
    pub shelf_id: Option<String>,        // FAIL 必填（validator 拦截）
    pub next_process_id: Option<String>, // FAIL 必填
    pub note: Option<String>,
    pub batch_id: Option<String>,
    pub quantity: Option<i32>,
}
```

- `ScanDecision` enum：`{PASS | FAIL}`，serde `rename_all = "UPPERCASE"`
- **批量场景下 `decision` 可选，缺省 PASS**：
  - 装配件整组送检高频诉求是"全过检"（避免每行 UI 抖动）
  - 但允许 per-item `FAIL` 处理"整组里特定子件需打回"边缘场景

Response 200 `data`：`BatchScanInspectOut`

```rust
pub struct BatchScanInspectOut {
    pub submitted: Vec<PartOut>,                    // 成功并完成 PASS/FAIL 流转的件
    pub failed: Vec<BatchScanInspectFailure>,       // per-item 失败明细
}

pub struct BatchScanInspectFailure {
    pub part_id: i64,           // 雪花 ID 字符串（serialize_i64）
    pub code: i32,              // 业务错误码（见错误码表）
    pub message: String,        // 错误 message，原样透传
}
```

错误码（端点级）：
- `40001 VALIDATION_ERROR`：`items` 为空 / > 200
- `40300 FORBIDDEN`：角色不足

**单件失败码放 `failed[]` 内**，与现有 `batch-pass-inspection` 范式一致（`docs/api/parts.md:42-46`）。

### 事务/并发设计约束

- **共享外层事务**：handler `state.pool.begin()` → service 内部循环 → handler `commit()`；失败 item 不中断后续 item
- **per-item 状态机复用**：每件走与现有单件 `pass_inspection` / `fail_inspection` **完全相同**的 service fn，确保：
  - `t_part_event` 写入一致（事件类型、操作人、时间戳、备注）
  - OCC 行为一致（version 校验）
  - WS 广播一致
- **实现建议**：service 层 `batch_scan_inspect` 内部循环调 `scan_inspect_core`（共用 service fn）；handler 只做参数校验 + 编排
- **并发**：单请求顺序处理即可（N=200 在 PG 一次 round-trip 内完全可接受）

---

## 需求 3（强烈推荐）：单件品检打回

### `POST /api/v2/parts/{part_id}/fail-inspection`

v2 当前**没有** `fail_inspection` 端点（grep 0 命中）。scan-inspect 的 FAIL 分支必须依赖它。**强烈推荐本 PR 一并实现**，否则 scan-inspect 的 FAIL 路径只能抛 501 `NOT_IMPLEMENTED`，与 v1 行为不一致。

权限：**Manager / Inspector**

Request body（`FailInspectionRequest`）：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `shelf_id` | string (i64) | ✓ | 目标生产货架 id（PRODUCTION 区 active） |
| `next_process_id` | string (i64) | ✓ | 下一道工序 id |
| `note` | string? | — | ≤ 500 字符 |
| `batch_id` | string (i64)? | — | 目标批次 id；缺省按状态唯一 INSPECTION 批次解析 |
| `quantity` | i32? | — | 部分数量；缺省 = 批次全量 |

Response：`PartOut`

业务流转（单事务）：
1. 解析批次 `_resolve_target_batch`，白名单 `{INSPECTION}`（必须先已送检）
2. 校验 shelf（zone=PRODUCTION）+ next_process 与 shelf 映射
3. 部分量拆批
4. 状态机迁移 `INSPECTION → IN_PROCESS`
5. 副作用：
   - `t_part.status = 'IN_PROCESS'`，`location = 'PRODUCTION_SHELF'`，`current_holder_id = shelf.id`，`next_process_id = ...`
   - INSERT `t_part_event`：`event_type='INSPECTION_FAILED'`，`from_status='INSPECTION'`，`to_status='INSPECTION' → 'IN_PROCESS'`，`note` 透传
   - WS 广播 `INSPECTION_FAILED`
6. OCC 守卫（version 校验）

错误码：
- `20103 BIZ_INVALID_TRANSITION` — 状态不在 INSPECTION
- `20104 BIZ_INVALID_VALUE` — shelf 不在 PRODUCTION 区 / next_process 与 shelf 不匹配
- `20109 BIZ_PART_BATCH_NOT_FOUND`
- `20111 BIZ_PART_BATCH_INVALID_QUANTITY`
- `40901 VERSION_CONFLICT`
- `40001` / `40300`

---

## 状态机扩展

`src/modules/part/statemachine.rs:84-94` 当前 `can_transition_to`：

```rust
matches!(
    (self, to),
    (Self::INSPECTION, Self::READY_TO_SHIP)
        | (Self::PROGRAMMING, Self::INSPECTION)  // 注释说"仅为对称，service 不暴露"
)
```

**扩展后**：

```rust
matches!(
    (self, to),
    (Self::INSPECTION,    Self::READY_TO_SHIP)
        | (Self::PROGRAMMING, Self::INSPECTION)
        | (Self::PENDING,     Self::INSPECTION)   // NEW
        | (Self::IN_PROCESS,  Self::INSPECTION)   // NEW
)
```

**注释同步更新**：删除"PROGRAMMING → INSPECTION 仅对称、service 不暴露"，本次 PR 让 service 暴露 PROGRAMMING + 新增 PENDING/IN_PROCESS 路径。

`IN_PROCESS + WORKER` 拒绝、`IN_PROCESS + 非 PRODUCTION_SHELF` 拒绝走 **service 层校验**（不污染状态机表，仿 v1 `service/part.py:4140-4164`）。

**单测补充**（`#[cfg(test)] mod tests`）：

- `can_transition_to_pending_to_inspection` → `true`
- `can_transition_to_in_process_to_inspection` → `true`
- `can_transition_to_inspection_to_inspection` → `false`（非法自环）
- `can_transition_to_ready_to_ship_to_inspection` → `false`（非法反向）

---

## 错误码分段

### 复用

- `20103 BIZ_INVALID_TRANSITION` — 状态不在白名单 / IN_PROCESS+WORKER / IN_PROCESS+非 PRODUCTION_SHELF
- `20104 BIZ_INVALID_VALUE` — FAIL 缺 shelf_id / next_process_id；shelf 不在对应 zone；next_process 与 shelf 不匹配
- `20109 BIZ_PART_BATCH_NOT_FOUND` — batch_id 不属于该 part
- `20111 BIZ_PART_BATCH_INVALID_QUANTITY` — quantity ≤ 0 或 > 批次剩余量
- `40901 VERSION_CONFLICT` — OCC 冲突
- `40001 VALIDATION_ERROR` — payload shape 错 / items 空 / > 200
- `40300 FORBIDDEN` — 非 Manager / Inspector
- `20501 BIZ_SHELF_NOT_FOUND` — shelf 不存在

### 新增（`src/shared/error.rs`）

| code | 名称 | 触发场景 |
|---|---|---|
| `20511` | `BIZ_SHELF_NOT_INSPECTION_ZONE` | `target_inspection_shelf.zone ≠ 'INSPECTION'` |
| `20512` | `BIZ_SHELF_INACTIVE` | `target_inspection_shelf.is_active = false` |

---

## 文档同步

### `/Users/ren/Code/hsh-erp-rust/docs/api/parts.md`

- 端点列表加三行（单件 scan-inspect、批量 batch-scan-inspect、单件 fail-inspection）
- 状态机节更新 `can_transition_to` 白名单
- 「未上线端点」节移除 `POST /parts/{id}/scan-inspect`、`POST /parts/{id}/fail-inspection`
- 共享 DTO 段加 `ScanDecision` / `ScanInspectRequest` / `BatchScanInspectItem` / `BatchScanInspectRequest` / `BatchScanInspectFailure` / `BatchScanInspectOut` / `FailInspectionRequest`
- 错误码表加 20511 / 20512

### `/Users/ren/Code/hsh-erp-rust/docs/api/delivery-notes.md`

21418 `BizWithFailures` 段加注：

> 前端可基于 `data.failures[].status` 区分触发端点：
> - `status ∈ {PENDING, PROGRAMMING, IN_PROCESS}` → 触发 `POST /parts/batch-scan-inspect`（一键送检）
> - `status === 'INSPECTION'` → 触发 `POST /parts/batch-pass-inspection`（一键过检）

### `/Users/ren/Code/hsh-erp-rust/docs/api/index.md`

- 顶部「模块 API」表 part 行从"未上线"更新到"已上线"，写明端点数（5：pass 单/批量、scan 单/批量、fail 单件）

---

## 实施 checklist

按顺序执行；每步可独立 commit：

1. [ ] `src/modules/part/statemachine.rs`：`can_transition_to` 扩白名单 + 单测覆盖 `PENDING→INSPECTION` / `IN_PROCESS→INSPECTION`；更新注释
2. [ ] `src/shared/error.rs`：新增 `BIZ_SHELF_NOT_INSPECTION_ZONE(20511)` / `BIZ_SHELF_INACTIVE(20512)` 常量 + `AppError` 构造 helper
3. [ ] `src/modules/part/dto.rs` 新增：
   - `ScanDecision` enum（`{PASS | FAIL}`，serde rename_all = "UPPERCASE"）
   - `ScanInspectRequest { target_inspection_shelf_id, decision, shelf_id?, next_process_id?, note?, batch_id?, quantity? }`
   - `BatchScanInspectItem { part_id, decision?, shelf_id?, next_process_id?, note?, batch_id?, quantity? }`
   - `BatchScanInspectRequest { target_inspection_shelf_id, items }`
   - `BatchScanInspectFailure { part_id, code, message }`
   - `BatchScanInspectOut { submitted: Vec<PartOut>, failed: Vec<BatchScanInspectFailure> }`
   - `FailInspectionRequest { shelf_id, next_process_id, note?, batch_id?, quantity? }`（需求 3）
4. [ ] `src/modules/part/service.rs` 实现：
   - `_validate_inspection_shelf` 扩 zone=INSPECTION / is_active 检查（抛 20511 / 20512）
   - `scan_inspect_core`：完整流程（步骤 1-7，见需求 1）
   - `scan_inspect`：薄包装调 `scan_inspect_core`
   - `batch_scan_inspect`：循环 `scan_inspect_core`，失败收集到 `failed[]`，最大 200
   - `fail_inspection_core`（需求 3）：状态机 `INSPECTION → IN_PROCESS`，仿 `pass_inspection_core`
   - `fail_inspection`：薄包装
   - `BATCH_SCAN_INSPECT_MAX_ITEMS = 200` 常量
5. [ ] `src/modules/part/handler.rs` 新增路由：
   - `POST /batch-scan-inspect`（handler `batch_scan_inspect`，items 长度校验 → service → commit）
   - `POST /{part_id}/scan-inspect`（handler `scan_inspect`，薄包装）
   - `POST /{part_id}/fail-inspection`（需求 3）
   - 权限统一用 `PASS_INSPECTION_ROLES` 常量
6. [ ] `src/modules/part/mod.rs` 注册路由（**关键顺序**）：

   ```rust
   Router::new()
       .route("/batch-pass-inspection",   post(handler::batch_pass_inspection))
       .route("/batch-scan-inspect",      post(handler::batch_scan_inspect))     // NEW
       .route("/batch-fail-inspection",   post(handler::batch_fail_inspection))  // NEW（推荐需求 3 的批量版，可选）
       .route("/{part_id}/pass-inspection", post(handler::pass_inspection))
       .route("/{part_id}/scan-inspect",    post(handler::scan_inspect))         // NEW
       .route("/{part_id}/fail-inspection", post(handler::fail_inspection))       // NEW（推荐）
   ```

   静态段必须在 `/{part_id}/...` 之前（`handler.rs:16-17` 注释强调）
7. [ ] `docs/api/parts.md`：端点表 + 状态机节 + 共享 DTO + 错误码表
8. [ ] `docs/api/delivery-notes.md`：21418 段 status 分流注释
9. [ ] `docs/api/index.md`：part 行从"未上线"移到"已上线"
10. [ ] `tests/part_api.rs` 扩展（或新建 `tests/part_scan_inspect.rs`）：
    - `PENDING + PASS` → status='READY_TO_SHIP'
    - `PROGRAMMING + PASS` → status='READY_TO_SHIP'
    - `IN_PROCESS+PRODUCTION_SHELF + PASS` → status='READY_TO_SHIP'
    - `IN_PROCESS+WORKER` → 20103
    - `IN_PROCESS+非 PRODUCTION_SHELF` → 20103
    - `FAIL` 缺 `shelf_id` → 20104
    - `FAIL` 缺 `next_process_id` → 20104
    - `target_shelf.zone=PRODUCTION` → 20511
    - `target_shelf.is_active=false` → 20512
    - `batch-scan-inspect` items 空 → 40001
    - `batch-scan-inspect` items > 200 → 40001
    - `batch-scan-inspect` 3 件混合 → 2 submitted + 1 failed（断 OCC）
    - `batch-scan-inspect` 非 Manager/Inspector → 40300
    - `fail-inspection`（需求 3）happy path：INSPECTION → IN_PROCESS + INSPECTION_FAILED 事件
11. [ ] `src/modules/part/statemachine.rs` 单测补充（见状态机扩展节）

---

## 前端落地（参考，非本仓 PR 范围）

本次变更落地后，前端 `api/parts.ts:697-706` 的 `scanInspect` 可从 `api.post` 切到 `apiV2.post`：

```ts
// 现有
export async function scanInspect(id: string, payload: ScanInspectPayload): Promise<PartItem> {
  const resp = await api.post<PartItem>(`/parts/${id}/scan-inspect`, payload)
  return resp.data
}

// 切到 v2 后
export async function scanInspect(id: string, payload: ScanInspectPayload): Promise<PartItem> {
  const resp = await apiV2.post<PartItem>(`/parts/${id}/scan-inspect`, payload)
  return resp.data
}
```

新增批量端点：

```ts
export interface BatchScanInspectItemFE {
  part_id: string
  decision?: 'PASS' | 'FAIL' | null
  shelf_id?: string | null
  next_process_id?: string | null
  note?: string | null
  batch_id?: string | null
  quantity?: number | null
}
export interface BatchScanInspectFailureFE { part_id: string; code: number; message: string }
export interface BatchScanInspectOutFE { submitted: PartItem[]; failed: BatchScanInspectFailureFE[] }

export async function batchScanInspect(req: {
  target_inspection_shelf_id: string
  items: BatchScanInspectItemFE[]
}): Promise<BatchScanInspectOutFE> {
  const { data } = await apiV2.post<BatchScanInspectOutFE>('/parts/batch-scan-inspect', req)
  return data
}
```

`DeliveryNoteScan.vue:478-513` 的 `applyError` 按 `failures[].status` 分流：

- 统一弹 `BatchSubmitInspectionConfirmDialog`（见 `src/components/delivery/BatchSubmitInspectionConfirmDialog.vue`）；dialog 内部按 `failures[].status` 自动拆成两批：
  - `status ∈ {PENDING, PROGRAMMING, IN_PROCESS}` → 调 `batchScanInspect`（`POST /parts/batch-scan-inspect`）一键送检
  - `status === 'INSPECTION'` 且用户在「同时过检此件」列勾选 → 在确认时追加调 `batchPassInspection`（`POST /parts/batch-pass-inspection`）过检
- 父组件 `DeliveryNoteScan.vue` 无需再按 status 拆分弹窗

新弹窗位于 `src/components/delivery/BatchSubmitInspectionConfirmDialog.vue`，顶部加 `el-select` 选品检架（拉 `listShelves({ zone: 'INSPECTION', is_active: true })`），每行可调部分数量，「同时过检此件」列仅 `status === 'INSPECTION'` 的行启用。

详见 `/Users/ren/.claude/plans/pure-cooking-deer.md`（本仓 plan 文件，前端 §B 全节）。