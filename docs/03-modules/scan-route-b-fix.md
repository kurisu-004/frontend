# 路线 B 修复计划：`POST /api/v2/delivery-notes/scan`（前端）

> **状态**：规划稿（2026-08-26，待评审；2026-08-27 字段精简 + 错误码重写）。
> **配套后端文档**：[`/Users/ren/Code/hsh-erp-rust/docs/api/delivery-notes/scan-route-b-fix.md`](../../../../../hsh-erp-rust/docs/api/delivery-notes/scan-route-b-fix.md)
> **关联模块文档**：[`delivery-notes.md`](./delivery-notes.md) · `DeliveryNoteScan.vue` 是落地页

---

## Context

`POST /api/v2/delivery-notes/scan`（扫码建单）的用户场景：

| 场景 | 当前实现 | 用户期望（路线 B） |
|---|---|---|
| ① 散件 + 全部已送检（A 组） | 200 `ADDED` | 不变 |
| ② 散件 + 仅候选待送检（B 组） | 21405 错误，前端 `parseBlockMessage` 兜底 | 200 `CANDIDATES_AVAILABLE` + `unresolved_targets[]`（单元素）|
| ③ 装配件 + 全部子件 A 组 | 200 `ADDED` | 不变 |
| ④ 装配件 + 部分子件 B 组 | 21418 错误，弹 `BatchSubmitInspectionConfirmDialog` | 200 `PARTIAL_ADDED` + `added_batches[]` + `unresolved_targets[]`（多元素） |
| ⑤ 任一批次 C 组 | 21405 错误 | **21419 硬错误** → `ElMessage.error`（不进入 200 路径） |

**问题**：场景 ②、④ 当前要走"扫不上 → 错误 toast → 弹窗驱动一键送检 → 关闭 → 重扫"的两段式工作流。路线 B 把 ②、④ 改成"软成功"，让前端可以直接从 200 响应里取候选批次列表，弹窗入口从错误路径迁到成功路径。

> **重要**：当前 21418 / 21405 触发的 `BatchSubmitInspectionConfirmDialog` 在功能上是对的——**只是入口错了**。路线 B 要把"入口"从错误路径迁到 200 路径，弹窗本身的零件送检逻辑可以保留（甚至可复用）。

### batch 状态 5 类分组（2026-08-27 新增）

| 组 | 状态 | 前端动作 |
|---|---|---|
| **A 直接入单** | `READY_TO_SHIP`, `INSPECTION` | 直接 toast 成功，刷新草稿卡 |
| **B 候选→一键送检** | `PENDING`, `PROGRAMMING`, `IN_PROCESS`(非工人持有), `REPAIRING` | 弹候选弹窗 → 选一个 → 调 `to-inspection` 送检 → **自动 re-scan**（品检无需重扫） |
| **C 直接报错** | `DELIVERED`, `OUTSOURCE`, `IN_PROCESS`(工人持有), `COMPLETED`, `CANCELLED` | `ElMessage.error` 提示 `21419 BIZ_DELIVERY_BATCH_STATE_INVALID` |

### 两段式自动重试工作流

```ts
// 伪代码——前端在 scan 拿到 CANDIDATES_AVAILABLE / PARTIAL_ADDED 后：
for (const batch of unresolvedTargets.flatMap(t => t.available_batches)) {
  await toInspection(batch.batch_id)   // 调用重命名后的 batch-scan-inspect
}
// 所有 B 组批次送完 → 自动重新调用 scan，品检无需手动再次扫码
await scanDelivery(originalCode)
```

scan 端点已保证**幂等**：相同 serial_no 重复扫描返回 `ALREADY_PRESENT`，不会创建新草稿。

---

## 一、目标响应契约（与后端共同）

```ts
interface ScanDeliveryOut {
  outcome: ScanOutcome
  resolved: ScanResolved
  note: ScanNoteSummary
  added_batches: ScanAddedBatch[]                 // 场景 ①、③、④-已挂载部分
  unresolved_targets?: ScanUnresolvedTarget[]     // 场景 ②（单元素）、④（多元素）
}

interface ScanResolved {
  kind: 'PART' | 'ASSEMBLY'
  /** kind=PART → part.id；kind=ASSEMBLY → assembly.id */
  id: string
  serial_no: string
  drawing_no: string
  name: string
  // ❌ 已删除：assembly_id（scan 不扫子件）、child_count（驱动决策不需要）
}

interface ScanAddedBatch {
  batch_id: string
  part_id: string        // 跨子件必须保留
  serial_no: string      // 跨子件必须保留
  quantity: number
}

interface ScanUnresolvedTarget {
  part_id: string
  serial_no: string
  drawing_no: string
  name: string
  /** 该 part 的 B 组候选批次 */
  available_batches: ScanAvailableBatch[]
}

interface ScanAvailableBatch {
  batch_id: string
  quantity: number
  status: BatchStatus   // 强类型枚举（替代魔法字符串）
  // ❌ 已删除：part_id / serial_no / drawing_no / name / location
  //    part 级信息从外层 unresolved_targets[] 推得
  //    location 不参与驱动决策
}

/** 后端 BatchStatusDto 镜像——10 个 SCREAMING_SNAKE_CASE 值 */
export type BatchStatus =
  | 'PENDING' | 'PROGRAMMING' | 'IN_PROCESS' | 'INSPECTION'
  | 'READY_TO_SHIP' | 'DELIVERED' | 'REPAIRING' | 'OUTSOURCE'
  | 'COMPLETED' | 'CANCELLED'

export type ScanOutcome =
  | 'ADDED'
  | 'ALREADY_PRESENT'
  | 'CANDIDATES_AVAILABLE'
  | 'PARTIAL_ADDED'
```

### 错误码迁移

| 错误码 | 旧触发 | 路线 B 后 |
|---|---|---|
| `21405 BIZ_DELIVERY_NOTE_PART_NOT_READY` | scan 路径 | **重命名为 `21419 BIZ_DELIVERY_BATCH_STATE_INVALID`**（C 组短路） |
| `21418 BIZ_DELIVERY_ASSEMBLY_PARTS_NOT_READY` | scan 路径 | deprecated，scan 不再触发 |
| `21417 SCAN_UNKNOWN_CODE` | scan 路径 | 不变，仍走 `ElMessage.error` |
| `21406 PART_ALREADY_ASSIGNED` | scan 路径 | 不变，仍走 `ElMessage.error` |

> ⚠️ **前端 i18n key 同步迁移**：常量名 / 错误码字符串作为 i18n key 散落在 `useDeliveryScanSubmission` 等多处，需要全仓梳理。

---

## 二、改动清单

### F.1 类型层（`frontend/src/types/deliveryNote.ts`）

#### ① 改造 `ScanOutcome`（`deliveryNote.ts:195`）

```ts
export type ScanOutcome =
  | 'ADDED'                  // A 组覆盖所有 target
  | 'ALREADY_PRESENT'        // A 组覆盖所有 target，但都已在本单（幂等）
  | 'CANDIDATES_AVAILABLE'   // 散件仅 B 组 → unresolved_targets 单元素
  | 'PARTIAL_ADDED'          // 装配件 A+B 混合 → unresolved_targets 多元素
```

#### ② 精简 `ScanResolved`（`deliveryNote.ts:198-210`）

```ts
export interface ScanResolved {
  kind: 'PART' | 'ASSEMBLY'
  id: string
  serial_no: string
  drawing_no: string
  name: string
}
```

#### ③ 新增 `BatchStatus` + 精简 `ScanAvailableBatch`

```ts
/** 后端 BatchStatusDto 镜像——10 个值。 */
export type BatchStatus =
  | 'PENDING' | 'PROGRAMMING' | 'IN_PROCESS' | 'INSPECTION'
  | 'READY_TO_SHIP' | 'DELIVERED' | 'REPAIRING' | 'OUTSOURCE'
  | 'COMPLETED' | 'CANCELLED'

/** 后端 AvailableBatchDto 精简版——只保留 batch 级维度。 */
export interface ScanAvailableBatch {
  batch_id: string
  quantity: number
  status: BatchStatus
}
```

#### ④ 新增 `ScanAddedBatch`（与后端 AddedBatchDto 对齐）

```ts
/** 已挂载批次（`added_batches[]`）；跨子件场景 part_id/serial_no 必填。 */
export interface ScanAddedBatch {
  batch_id: string
  part_id: string
  serial_no: string
  quantity: number
}
```

#### ⑤ 改造 `ScanUnresolvedTarget`（吸收原 `ScanBlockedTarget` + `ScanAvailableBatch`）

```ts
export interface ScanUnresolvedTarget {
  part_id: string
  serial_no: string
  drawing_no: string
  name: string
  /** 该 part 的 B 组候选批次 */
  available_batches: ScanAvailableBatch[]
}
```

#### ⑥ 改造 `ScanDeliveryOut`（`deliveryNote.ts:260-267`）

```ts
export interface ScanDeliveryOut {
  outcome: ScanOutcome
  resolved: ScanResolved
  note: ScanNoteSummary
  /** 场景 ①、③、④-已挂载部分；其余场景为 `[]` */
  added_batches: ScanAddedBatch[]
  /** 场景 ②（单元素）、④（多元素）；其余场景为 undefined */
  unresolved_targets?: ScanUnresolvedTarget[]
}
```

#### ⑦ 移除废弃类型

- `ScanDeliveryOut.message`（后端不发）
- `BlockedScanItem` / `BLOCK_SCAN_CODES` / `BlockScanCode`（21418/21405 不再触发）
- 保留 `ScanRecentItem`（`recent_items` 字段后端继续发）

### F.2 提交逻辑（`useDeliveryScanSubmission.ts:85-211`）

#### `handleScan` 不变

只需保证最终调 `await scanDelivery(code)` 即可。

#### `applySuccess` 重写（`useDeliveryScanSubmission.ts:124-135`）

```ts
async function applySuccess(out: ScanDeliveryOut): Promise<void> {
  // 1) 草稿卡更新（场景 ①、③、④-成功部分都生效）
  opts.writeDraftFromScan(out.note)
  void opts.refreshDraftDetail(out.note.id).catch(() => {})

  // 2) 按 outcome 分流
  switch (out.outcome) {
    case 'ADDED':
      ElMessage.success(`已加入 ${out.resolved.serial_no} → ${out.note.delivery_note_no}`)
      return
    case 'ALREADY_PRESENT':
      ElMessage.warning(`${out.resolved.serial_no} 已在 ${out.note.delivery_note_no} 上`)
      return
    case 'CANDIDATES_AVAILABLE':
      // 散件仅 B 组 → 弹"候选批次选择"弹窗（送检后自动 re-scan）
      if (!out.unresolved_targets || out.unresolved_targets.length === 0) {
        ElMessage.warning(`${out.resolved.serial_no} 当前无可入单批次`)
        return
      }
      candidatesFailures.value = out.unresolved_targets
        .flatMap(t => t.available_batches.map(b => toCandidateScanItem(b, t)))
      candidatesOriginalCode.value = currentScanCode.value
      candidatesDialogVisible.value = true
      return
    case 'PARTIAL_ADDED':
      // 装配件 A+B 混合 → 弹"部分入单"弹窗（v3.1 简化方案：串行触发）
      if (!out.unresolved_targets || out.unresolved_targets.length === 0) {
        ElMessage.success(`部分入单：${out.added_batches.length} 项成功`)
        return
      }
      partialAddedSummary.value = {
        added: out.added_batches,
        blocked: out.unresolved_targets,
      }
      partialOriginalCode.value = currentScanCode.value
      partialDialogVisible.value = true
      return
  }
}

/// 把 B 组批次 + 外层 part 信息合并成弹窗 props 形态
function toCandidateScanItem(b: ScanAvailableBatch, t: ScanUnresolvedTarget): CandidateScanItem {
  return {
    batch_id: b.batch_id,
    quantity: b.quantity,
    status: b.status,
    part_id: t.part_id,         // 从外层补
    serial_no: t.serial_no,     // 从外层补
    drawing_no: t.drawing_no,   // 从外层补
    name: t.name,               // 从外层补
  }
}
```

#### `applyError` 简化（删除 21405/21418 处理，`useDeliveryScanSubmission.ts:146-181`）

```ts
function applyError(code: string, e: unknown): void {
  // 路线 B 后，scan 路径只在以下场景返回错误：
  //   - 21419 BIZ_DELIVERY_BATCH_STATE_INVALID：C 组（DELIVERED/OUTSOURCE/IN_PROCESS工人持有/COMPLETED/CANCELLED）
  //   - 21417 SCAN_UNKNOWN_CODE：扫不到对应 part / assembly
  //   - 21406 PART_ALREADY_ASSIGNED：所有 A/B 组都空 + 全部 conflict
  //   - 20104 INVALID_VALUE / 21416 SCOPE_MISMATCH / 21407 MULTIPLE_CUSTOMERS / 40300 FORBIDDEN / 40001 VALIDATION
  // 全部走 ElMessage.error 兜底即可。
  if (code === '21419') {
    ElMessage.error('该批次当前状态不允许扫描（已发货/外协中/被工人持有/已完成/已取消）')
    return
  }
  const fallback = (e as { message?: string } | null | undefined)?.message ?? '扫码失败'
  ElMessage.error(fallback)
}
```

并删除 `parseBlockMessage`（`useDeliveryScanSubmission.ts:190-202`）。

#### 新增状态

```ts
// 场景 ②
const candidatesFailures = ref<CandidateScanItem[]>([])
const candidatesDialogVisible = ref(false)
const candidatesOriginalCode = ref<string | null>(null)

// 场景 ④（v3.1 简化方案：仅跟踪当前正在处理的子件）
const partialAddedSummary = ref<{
  added: ScanAddedBatch[]
  blocked: ScanUnresolvedTarget[]
} | null>(null)
const partialDialogVisible = ref(false)
const partialOriginalCode = ref<string | null>(null)
const partialCurrentIndex = ref(0)  // 串行触发用
```

#### 新增回调（含两段式自动重试）

```ts
async function onCandidatesSubmitSuccess(): Promise<void> {
  candidatesDialogVisible.value = false
  // 弹窗内已对每个 candidate 调 to-inspection；现在自动 re-scan
  if (candidatesOriginalCode.value) {
    await handleScan(candidatesOriginalCode.value)
  }
}

async function onPartialSuccess(): Promise<void> {
  // 当前子件处理完 → 推进到下一个 unresolved_target
  if (!partialAddedSummary.value) return
  partialCurrentIndex.value++
  if (partialCurrentIndex.value >= partialAddedSummary.value.blocked.length) {
    // 全部 B 组处理完 → re-scan
    partialDialogVisible.value = false
    if (partialOriginalCode.value) {
      await handleScan(partialOriginalCode.value)
    }
  }
  // 否则弹窗继续显示下一个子件（由 v-if 驱动）
}
```

### F.3 弹窗组件

#### 复用 `BatchSubmitInspectionConfirmDialog.vue`（小幅扩展）

现有弹窗消费 `BlockedScanItem[]`，调整 props 为新的 `CandidateScanItem[]`（**注意**：新形态不带 `location` 字段，删除"所在位置"列；`status` 改为强类型枚举）：

```ts
export interface CandidateScanItem {
  batch_id: string
  quantity: number
  status: BatchStatus           // 强类型枚举（替代魔法字符串）
  part_id: string               // 从外层 unresolved_target 补
  serial_no: string             // 从外层 unresolved_target 补
  drawing_no: string            // 从外层 unresolved_target 补
  name: string                  // 从外层 unresolved_target 补
}
```

弹窗组件做**最小改动**：
- 删"所在位置"列（location 字段已删除）
- "当前状态"列改用 `<el-tag :type="statusTagType(b.status)">` 区分颜色（INSPECTION 警告色，B 组 4 个蓝色，C 组灰色）
- props 字段名不变，内部用 `CandidateScanItem[]`

```ts
function statusTagType(s: BatchStatus): 'warning' | 'primary' | 'info' {
  if (s === 'INSPECTION') return 'warning'
  if (s === 'PENDING' || s === 'PROGRAMMING' || s === 'IN_PROCESS' || s === 'REPAIRING') {
    return 'primary'  // B 组
  }
  return 'info'  // C 组（按理不应进候选，但防御性兜底）
}
```

#### 简化方案：`PartialAddedDialog.vue` v3.1 串行触发

**v3.1 方案**（**建议先做**）：直接复用 `BatchSubmitInspectionConfirmDialog`，串行处理 `unresolved_targets[]` 中每个子件：

```vue
<!-- 在 DeliveryNoteScan.vue 中 -->
<BatchSubmitInspectionConfirmDialog
  v-if="currentUnresolvedTarget"
  v-model="submission.partialDialogVisible.value"
  :failures="currentUnresolvedTarget.available_batches.map(b => toCandidate(b, currentUnresolvedTarget))"
  :reason="`${currentUnresolvedTarget.serial_no} 子件需送检（${submissionIndex + 1}/${submissionTotal}）`"
  :original-code="submission.partialOriginalCode.value"
  @submit-success="submission.onPartialSuccess"
  @submit-partial="submission.onPartialPartial"
/>
```

**v3.2 升级方案**（按需）：新建 `PartialAddedDialog.vue`，用折叠面板（`el-collapse`）一次性展示所有未就绪子件 + 各自的可送检批次列表，每个折叠项内嵌入弹窗驱动送检。详见前端 `delivery-notes.md` 模块文档。

### F.4 `DeliveryNoteScan.vue` 适配（`frontend/src/views/delivery/DeliveryNoteScan.vue:211-222`）

```vue
<!-- 场景 ② 候选弹窗 -->
<BatchSubmitInspectionConfirmDialog
  v-model="submission.candidatesDialogVisible.value"
  :failures="submission.candidatesFailures.value"
  reason="该零件无可入单批次，请挑一个送检"
  :original-code="submission.candidatesOriginalCode.value"
  @submit-success="submission.onCandidatesSubmitSuccess"
  @submit-partial="submission.onCandidatesSubmitPartial"
  @cancel="submission.onCandidatesCancel"
/>

<!-- 场景 ④ 部分入单调阅弹窗（v3.1 简化方案：串行触发）-->
<BatchSubmitInspectionConfirmDialog
  v-if="submission.partialCurrentUnresolvedTarget.value"
  v-model="submission.partialDialogVisible.value"
  :failures="submission.partialCurrentUnresolvedTarget.value.available_batches.map(b => toCandidate(b, submission.partialCurrentUnresolvedTarget.value))"
  :reason="`${submission.partialCurrentUnresolvedTarget.value.serial_no} 子件需送检`"
  :original-code="submission.partialOriginalCode.value"
  @submit-success="submission.onPartialSuccess"
  @submit-partial="submission.onPartialPartial"
/>
```

### F.5 删除已废弃代码

- `useDeliveryScanSubmission.ts:190-202` `parseBlockMessage` 函数
- `frontend/src/types/deliveryNote.ts:273-313` `BlockedScanItem` / `BLOCK_SCAN_CODES` / `BlockScanCode`
- `CandidateScanItem.location` 字段（DTO 已删除）
- 任何 `grep` 命中的 `21418` / `21405`（旧码字符串） / `parseBlockMessage` / `BlockedScanItem` 调用点（仅保留 `add_parts` 路径可能仍触发的兜底 toast，并迁移到 `21419`）

### F.6 WS 监听兼容

如果有大屏 WS 监听 `DELIVERY_NOTE_SCAN_ADD` 事件，需要在 `payload.outcome` 增加 `'CANDIDATES_AVAILABLE' | 'PARTIAL_ADDED'` 的分支。payload 字段从 `blocked_count`/`candidates_count` 改为 `unresolved_count`。

```bash
grep -rn DELIVERY_NOTE_SCAN_ADD frontend/src  # 确认监听点
```

---

## 三、关键文件清单（前端）

| 文件 | 改动 |
|---|---|
| `frontend/src/types/deliveryNote.ts:180-313` | 改造 `ScanOutcome` / `ScanResolved` / `ScanDeliveryOut`；新增 `BatchStatus` / `ScanAddedBatch` / `ScanUnresolvedTarget`；精简 `ScanAvailableBatch`；删除 `BlockedScanItem` 等 |
| `frontend/src/views/delivery/composables/useDeliveryScanSubmission.ts:85-211` | `applySuccess` 按 outcome 分流；`applyError` 简化并加 `21419` 提示；删除 `parseBlockMessage`；新增 ② ④ 状态 + 回调（含 re-scan） |
| `frontend/src/components/delivery/BatchSubmitInspectionConfirmDialog.vue:1-160` | props 类型从 `BlockedScanItem` 改为新 `CandidateScanItem`；删 `location` 列；`status` tag 列按枚举配色 |
| `frontend/src/views/delivery/DeliveryNoteScan.vue:211-222` | 挂载新的弹窗触发点 |
| `frontend/src/components/delivery/PartialAddedDialog.vue` | **新增**（v3.2 升级方案；v3.1 不需要） |
| i18n 文件 + 错误码常量 | `21405` → `21419` 同步迁移 |

---

## submit outcome 包装（2026-08-29 起）

`POST /api/v2/delivery-notes/{id}/submit` 现在返回两种 outcome（替换原 21405 硬错误）：

| outcome | 说明 | note | unresolved_targets |
|---|---|---|---|
| `SUBMITTED` | 全部批次已 `READY_TO_SHIP`，DRAFT → SUBMITTED 已提交 | 非 null | 缺省 |
| `CANDIDATES_AVAILABLE` | 仍有批次在 `INSPECTION`，本次未提交 | `null` | 非空（INSPECTION 批次列表，每批带 `version`） |

### 前端 UX（F.5 改造）

- `SUBMITTED` → toast「已提交」+ 清掉草稿本地 state（`onDraftRemoved`）。
- `CANDIDATES_AVAILABLE` → 弹 `DeliverySubmitCandidateDialog`，列出 INSPECTION 批次（每批带 `batch_id` + `version`）→ 用户点「一键过检并重新提交」→ 调 `POST /parts/batch-to-ship`（items 每条带 `version`，caller OCC 锚 `t_part_batch`）→ 自动重 submit。

### 实现要点

- `useDeliveryScanSubmission.doSubmit` 用 `out.outcome === 'CANDIDATES_AVAILABLE' || out.unresolved_targets` 判定弹窗（双判定兼容旧 server 漏返 outcome 的情况）。
- 弹窗「一键过检并重新提交」走 `useBulkPassInspection`（route B batch-to-ship），其 `items[].version` 来自 `unresolved_targets[].available_batches[].version`。
- 弹窗成功后调用方重 submit：dialog 的 done 回调里 fetchDetail 拿新 version 后再次调 `doSubmit`；新一轮 submit 又返回 CANDIDATES_AVAILABLE 时（极端场景：过检后又有新 INSPECTION 批次）会再次弹窗，由 `submittingByNote` 守卫防递归。

### 类型 / API 入口

- 类型：`src/types/deliveryNote.ts` `SubmitOutcome` / `SubmitDeliveryOut`（`note: DeliveryNoteOut | null` + `unresolved_targets?: ScanUnresolvedTarget[]`）。
- API 入口：`src/api/deliveryNote.ts` `submitNote(noteId, { version })` 返回 `Promise<SubmitDeliveryOut>`。
- 弹窗：`src/components/delivery/DeliverySubmitCandidateDialog.vue`（route B submit 候选 → 一键过检 → 重 submit）。
- 单测：`src/views/delivery/__tests__/useDeliveryScanSubmission.spec.ts` 新增 3 个用例（SUSPENDED / CANDIDATES_AVAILABLE / 21403）。

详见 [plan](../../../.claude/plans/claude-plans-2026-08-29-submit-candidat-idempotent-hamster.md)（前端 F.5 段）。

---

## 四、验证方法

### 4.1 类型 + 静态检查

```bash
pnpm tsc --noEmit
pnpm lint
```

### 4.2 关键负向检查（旧字段不应再出现）

```bash
grep -rn "parseBlockMessage\|BLOCK_SCAN_CODES\|BlockedScanItem" frontend/src  # 应为 0 命中
grep -rn "out\.message\b\|out\.resolved\.batch_id\b\|out\.resolved\.scope\b" frontend/src  # 应为 0 命中
grep -rn "out\.already_present\|out\.skipped\|out\.available_batches\b\|out\.blocked_targets\b" frontend/src  # 应为 0 命中
grep -rn "CandidateScanItem.*location\|available_batches.*location" frontend/src  # 应为 0 命中
```

### 4.3 手工冒烟（起 dev server）

按 5 类状态各扫一次：

| 场景 | 输入状态 | 预期 outcome | 预期 UI 行为 |
|---|---|---|---|
| ① | 散件 READY_TO_SHIP | `ADDED` | toast "已加入 …→ DN-…"，草稿卡 +1 行 |
| ② | 散件 INSPECTION | `ADDED` | toast "已加入 …→ DN-…"，草稿卡 +1 行（INSPECTION 算 A 组） |
| ③ | 散件 PENDING | `CANDIDATES_AVAILABLE` | 弹候选弹窗 → 选一个 → 自动 re-scan → 第二次返回 `ADDED` |
| ④ | 装配件子件 A+B 混合 | `PARTIAL_ADDED` | 弹"部分入单"视图：上半"已成功 N 项"只读；下半逐个处理 B 组子件（v3.1 串行弹窗）；全部送完后自动 re-scan |
| ⑤ | 任一批次 DELIVERED | — | `ElMessage.error` 提示"该批次当前状态不允许扫描"（21419）|
| ⑥ | IN_PROCESS 工人持有 | — | `ElMessage.error`（21419） |
| ⑦ | re-scan 同 serial_no | `ALREADY_PRESENT` | toast warning，不创建新草稿 |

### 4.4 回归

- 原 `21417 SCAN_UNKNOWN_CODE` 仍走 `ElMessage.error`
- 原 `21406 PART_ALREADY_ASSIGNED` 仍走 `ElMessage.error`
- WS `DELIVERY_NOTE_SCAN_ADD` 事件仍发，dashboard 不掉；payload 字段名 `unresolved_count` 替换旧 `blocked_count`/`candidates_count`

---

## 五、实施顺序建议

1. **后端先行**：先合并后端 DTO + service + 状态机白名单 + 错误码重命名到 master（后端文档 [`scan-route-b-fix.md`](../../../../../hsh-erp-rust/docs/api/delivery-notes/scan-route-b-fix.md)）
2. **前端紧跟**：TS 类型改造（可独立编译通过） → `applySuccess` 重写 + `applyError` 加 `21419` 分支 → `BatchSubmitInspectionConfirmDialog` 字段适配 → `DeliveryNoteScan.vue` 挂载 → i18n / 错误码常量同步
3. **删除废弃代码**：`parseBlockMessage` / `BlockedScanItem` / `CandidateScanItem.location` 等
4. **灰度验证**：dev server 手工扫 7 场景（含两段式重试） + 回归 3 个错误码（21417/21406/21419）
5. **可选升级**：v3.2 `PartialAddedDialog.vue` 折叠面板 UX 升级