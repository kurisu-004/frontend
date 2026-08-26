# 扫码建单状态规范化与 ScanFailureDto 字段补齐（2026-08-26）

> 交付对象：hsh-erp-rust 后端 agent
> 提出方：myERP 前端（Ren_mac）
> 适用范围：v2 业务 REST（`/api/v2`），不动 v1
> 关联：扫码建单 21418 / 21405 阻塞流程（`src/components/delivery/BatchSubmitInspectionConfirmDialog.vue`）

## 背景

前端合并 `fix/scan-send-inspect-button` 后用户复现以下问题：

| # | 现象 | 根因 |
|---|---|---|
| 1 | 扫码建单阻塞弹窗选品检架后「一键送检」按钮不激活 | 后端 `ScanFailureDto` 在 21405 path 未填 `part_id` / `batch_id` / `drawing_no` / `status`；前端 `BatchSubmitInspectionConfirmDialog.canBulkSubmit`（`src/components/delivery/BatchSubmitInspectionConfirmDialog.vue:136-145`）要求所有 failure 有 part_id，否则按钮 disabled |
| 2 | 阻塞弹窗表格 status 列显示原始英文 `IN_PROCESS` 而非中文「生产中」 | 前端显示层未查 `ORDER_STATUS_LABEL`（已修：`fix(delivery-dialog)` commit，本文档不涉及） |
| 3 | 提交草稿遇 21405 直接报错无确认弹窗 | 前端 filter 把 `INSPECTION` 当「已送检可入单」（add-to-draft 视角），但后端 submit 时要求 `READY_TO_SHIP`（已修：`fix(delivery-scan)` commit，本文档不涉及） |

后端扫描结果（Explore 2 调研）：

- 后端 `PartStatus` enum + serde 100% 使用 `IN_PROCESS` 带下划线（`~/Code/hsh-erp-rust/src/modules/part/statemachine.rs:22-43`），全仓 grep `INPROCESS` 0 命中
- 后端 DB 无 CHECK 约束（`migrations/20260811100005_005_create_part_tables.sql:3`），历史 SQL 写入或脏数据迁移可能产生 `INPROCESS` 无下划线变体
- 21405 错误 message 含 `status={X}` token，前端 `parseBlockMessage` 已能解析，但 DTO 字段未填齐

## 需求 1：业务规则明确化

### 入单（add_parts / scanDelivery）允许的状态

- `INSPECTION`（已送检 / 待贴标）✅
- `READY_TO_SHIP`（合格）✅
- 其它 ❌ → 走 21418（装配件带 `failures[]`）/ 21405（散件无 `failures`）阻塞弹窗

### 提交（submitNote DRAFT → SUBMITTED）允许的状态

- `READY_TO_SHIP` ✅
- 其它（含 `INSPECTION` / `IN_PROCESS` 等）❌ → 抛 21405，message 形如 `batch BATCH-2026-001 status=INSPECTION (must be READY_TO_SHIP at submit)`（`service/lifecycle.rs:78-81` 的 `format!("batch {} status={} ...", b.batch_no, b.status)` 实际产物）

### 验收

- ✅ 在 `~/Code/hsh-erp-rust/docs/api/delivery-notes.md` 的 `POST /delivery-notes/{id}/submit` 节新增 `### 状态白名单` 子节，列出「submit 仅允许 `READY_TO_SHIP`」规则；并在扫码建单 21418 / 21405 节列出入单白名单 `INSPECTION / READY_TO_SHIP`
- ✅ `~/Code/hsh-erp-rust/src/modules/delivery_note/service/lifecycle.rs:74-84` 注释引用上述规则（防 future drift）

## 需求 2：DB CHECK 约束 + 脏数据迁移

### 现状

- `t_part.status` `varchar(20)` 无 CHECK 约束（migration 注释明确）
- `t_part_batch.status` `varchar(20)` 无 CHECK 约束
- 历史 SQL 可能写入脏数据（如 `INPROCESS` 无下划线、`in_process` 小写等）

### 要求

1. 新增 migration（含 CHECK 约束）：

   ```sql
   -- 文件名示例：YYYYMMDDHHMMSS_NNN_add_part_status_check.sql
   ALTER TABLE t_part
     ADD CONSTRAINT t_part_status_check
     CHECK (status IN (
       'PENDING', 'PROGRAMMING', 'IN_PROCESS', 'INSPECTION',
       'READY_TO_SHIP', 'DELIVERED', 'REPAIRING', 'OUTSOURCE',
       'COMPLETED', 'CANCELLED'
     ));

   ALTER TABLE t_part_batch
     ADD CONSTRAINT t_part_batch_status_check
     CHECK (status IN (
       'PENDING', 'PROGRAMMING', 'IN_PROCESS', 'INSPECTION',
       'READY_TO_SHIP', 'DELIVERED', 'REPAIRING', 'OUTSOURCE',
       'COMPLETED', 'CANCELLED'
     ));
   ```

2. **数据迁移**：migration 启动时先跑以下查询，**预期 0 行**：

   ```sql
   SELECT 't_part' AS tbl, status, COUNT(*) AS cnt
   FROM t_part
   WHERE status NOT IN (
     'PENDING', 'PROGRAMMING', 'IN_PROCESS', 'INSPECTION',
     'READY_TO_SHIP', 'DELIVERED', 'REPAIRING', 'OUTSOURCE',
     'COMPLETED', 'CANCELLED'
   )
   GROUP BY status
   UNION ALL
   SELECT 't_part_batch' AS tbl, status, COUNT(*) AS cnt
   FROM t_part_batch
   WHERE status NOT IN (
     'PENDING', 'PROGRAMMING', 'IN_PROCESS', 'INSPECTION',
     'READY_TO_SHIP', 'DELIVERED', 'REPAIRING', 'OUTSOURCE',
     'COMPLETED', 'CANCELLED'
   )
   GROUP BY status;
   ```

3. 若查询有非 0 行：
   - 在 migration 内先 `UPDATE` 修复（保留 audit log）
   - 常见映射：`INPROCESS` → `IN_PROCESS`
   - 修复后再加 CHECK 约束

4. **CHECK 约束生效后所有 INSERT/UPDATE 必须经白名单**

### 验收

- ✅ migration 文件名格式 `YYYYMMDDHHMMSS_NNN_add_part_status_check.sql`（与既有命名一致）
- ✅ 上方 SELECT 查询返回 0 行
- ✅ 尝试写入脏数据被 DB 拒绝：`UPDATE t_part SET status = 'INPROCESS' WHERE id = <test_id>` 应报 constraint violation

## 需求 3：21405 路径返回 `ScanFailureDto[]`

### 现状

`ScanFailureDto` 定义（`~/Code/hsh-erp-rust/src/modules/delivery_note/dto.rs:542-563`）字段已齐全，`drawing_no` **已存在**：

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
    #[serde(
        serialize_with = "crate::shared::types::serialize_i64_opt",
        skip_serializing_if = "Option::is_none"
    )]
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

**真正的 gap**：21418 path 用 `AppError::BizWithFailures { failures: [...] }`（`service/scan.rs:418-437`）正常返回 `data.failures[]`；**21405 路径根本没构造 `ScanFailureDto`**，5 个 throw 站点全部走 `AppError::biz(code, message)` 直接序列化 message 到顶层 `message` 字段：

| 文件:行 | 场景 | 当前返回 |
|---|---|---|
| `service/scan.rs:449-452` | 散件 conflict 走到 not-ready（其他单挂载走完） | `message: "part 批次状态 {st}，不可入单"` |
| `service/scan.rs:456-459` | 散件兜底（无 eligible + no already + no conflict + no not-ready） | `message: "no eligible batches to attach for the scanned code"` |
| `service/inner.rs:402-409` | 入单时 batch 状态非 `INSPECTION / READY_TO_SHIP` | `message: "part {id} 批次 {batch_no} status={st}, only INSPECTION / READY_TO_SHIP allowed at draft entry"` |
| `service/lifecycle.rs:74-83` | submit 时 batch 状态非 `READY_TO_SHIP` | `message: "batch {batch_no} status={st} (must be READY_TO_SHIP at submit)"` |
| `service/lifecycle.rs:301-310` | pickup 时 batch 状态非 `READY_TO_SHIP` | `message: "batch {batch_no} status={st}, must be READY_TO_SHIP at pickup"` |

21418 构造点：`service/scan.rs:316-324`（status 不在候选池）、`service/scan.rs:359-367`（挂在别单 conflict）。其它 21418 失败明细经 `serde_json::json!` 手工序列化（`service/scan.rs:418-437`），不走 `ScanFailureDto::serialize` 自动派生。

### 要求

**设计决策**：21405 path 重构为 `AppError::BizWithFailures`，对齐 21418 模式（与 dto.rs:542-546 docstring 原意一致：`part_id: 0` 作为「无 part 级 ID」哨兵）。落地步骤：

1. **保留 `ScanFailureDto` 不动**——`drawing_no` / `name` / `batch_id: Option<i64>` / `status: Option<String>` 等字段已齐全，i64 → 字符串由 `serialize_i64` 自动派生。**不要**新增 `drawing_no` 或改类型。

2. **21405 throw 站点改为 `BizWithFailures`**（5 处全部）：
   - `service/scan.rs:449-452` → `BizWithFailures { failures: vec![ScanFailureDto { part_id: 0, batch_id: None, drawing_no: None, status: Some(st.clone()), serial_no: "".into(), name: "".into(), reason: format!("part 批次状态 {st}，不可入单") }] }`
   - `service/scan.rs:456-459` → 同上哨兵项，`reason: "no eligible batches to attach for the scanned code".into()`
   - `service/inner.rs:402-409` → 含真实 `batch_id`（`batch.id`），`status: Some(batch.status.clone())`，`part_id: 0`，`reason: format!("part {id} 批次 {batch_no} status={st}, ...")`. `serial_no` / `name` 留空串（message 中无图号/件号时按空串走，不影响前端渲染）
   - `service/lifecycle.rs:74-83` → 含真实 `batch_id`（`b.id`），`status: Some(b.status.clone())`，`part_id: 0`
   - `service/lifecycle.rs:301-310` → 同上

3. **`part_id: 0` 哨兵约定**：后端在 message 解析不出 part 级 ID 时填 `0`，**前端必须把 `part_id: 0` 当「不可一键送检」信号**——见「前端配套改动」节。

4. **现有 message 字符串保留**（`reason` 字段填原 message 内容，前端 `parseBlockMessage` 解析逻辑不变），并继续在 `AppError::BizWithFailures.message` 顶层放同样字符串（兼容性）。

### 前端配套改动（耦合项）

`src/components/delivery/BatchSubmitInspectionConfirmDialog.vue:141-143` 当前 guard：

```ts
props.failures.every(
  (f) => typeof f.part_id === 'string' && f.part_id.length > 0,
),
```

**问题**：`serialize_i64` 把 `i64: 0` 序列化为 JSON 字符串 `"0"`，`"0".length > 0` 为 true → 哨兵失效，按钮仍可点击 → 后续 `POST /parts/batch-pass-inspection` 会以 `part_id: "0"` 提交 → 后端 4xx。

**修复**（前端 PR 配套，**不在本文档范围**）：把 guard 改为数值判定：

```ts
props.failures.every(
  (f) => typeof f.part_id === 'string' && Number(f.part_id) > 0,
),
```

并在 `disabledTooltip` 增加分支：`所有 failure.part_id 都 <= 0` 时提示「需要手动通过品检（无 part 级 ID）」。

### 验收

- ✅ 5 个 21405 站点 throw 全部走 `BizWithFailures`（grep `code::BIZ_DELIVERY_NOTE_PART_NOT_READY` 应 0 命中 `AppError::biz`，仅命中 `BizWithFailures`）
- ✅ 21405 响应 body 的 `data.failures[]` 非空，至少含 1 个 `ScanFailureDto`，`part_id` 为字符串 `"0"` 或真实雪花 ID
- ✅ `data.failures[].batch_id` / `status` 在 message 含对应字段时填实值，否则为 `null`
- ✅ 前端 PR 合入后：扫码建单 21405 阻塞弹窗仅含「哨兵」failure 时按钮 disabled + tooltip 提示「需要手动通过品检」；含真实 `part_id` 时按钮可激活
- ✅ 21418 path 行为不变（回归）

## 文档归档

后端完成后请在本需求文档底部追加「完成情况」section，列出：

- 实施的 migration 编号
- 修改的 DTO / handler 列表（`file:line`）
- 验收测试的 SQL 输出 / curl 响应

例：

```markdown
## 完成情况（YYYY-MM-DD 后端 agent 填）

### Migration

- `20260828HHMMSS_007_add_part_status_check.sql`

### 修改文件

- `src/modules/delivery_note/dto.rs:547-563` — 新增 `drawing_no` 字段
- `src/modules/delivery_note/service/scan.rs:316-365` — 21405 path 填 part_id / batch_id / drawing_no / status
- `docs/api/delivery-notes.md` — 补入入单 / submit 业务规则说明
- `src/modules/delivery_note/service/lifecycle.rs:74-84` — 注释引用新文档

### 验收

- ✅ SELECT 查询返回 0 行
- ✅ curl 21405 路径响应：`{"data": {"failures": [{"serial_no": "", "part_id": "0", "batch_id": null, "drawing_no": null, "status": "INSPECTION", "name": "", "reason": "batch BATCH-001 status=INSPECTION (must be READY_TO_SHIP at submit)"}]}, "message": "..."}`
- ✅ 前端扫码建单阻塞弹窗选架后「一键送检」按钮可激活
```
