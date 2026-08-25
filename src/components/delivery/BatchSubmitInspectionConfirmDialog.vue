<!--
  批量一键送检确认对话框（2026-08-25 新增）。

  用途：扫码建单页遇到 21418 / 21405 时，按 failures[].status 分流：
  - status ∈ {PENDING, PROGRAMMING, IN_PROCESS} → 弹本对话框
  - status === 'INSPECTION' → 弹 BlockedScanConfirmDialog（保留旧行为）

  用户选一个品检架（共享）+ 调整每件数量 → 一键调 apiV2.batchScanInspect
  （POST /parts/batch-scan-inspect）。品检员/管理员确认后把生产中的工件搬上
  品检架，submit-success 时父组件用 originalCode 重扫。

  设计要点：
  - 镜像 BlockedScanConfirmDialog 的弹窗结构 + onConfirm 三态分流
    （submit-success / submit-partial / cancel）。
  - 顶部加品检架 el-select（共享架，必填；confirm disabled when 没选）。
  - 表格列：serial_no · drawing_no · 状态 chip · 数量（el-input-number）。
    数量默认 = 该件全量（与 batch-pass-inspection 范式一致）。
  - 「同时过检此件」列：仅 status==='INSPECTION' 的行启用；勾选后弹窗
    onConfirm 拆成两批：先送检未送检的，再过检已送检的。

  申请见 docs/api-requirements/scan-inspect.md。
-->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Upload } from '@element-plus/icons-vue'

import { useDialogSize } from '@/composables/useDialogSize'
import { useBulkScanInspect } from '@/composables/useBulkScanInspect'
import type { BulkScanFailure } from '@/composables/useBulkScanInspect'
import { listShelves } from '@/api/shelves'
import type { Shelf } from '@/types/shelf'
import type { BlockedScanItem } from '@/types/deliveryNote'

interface Props {
  /** v-model 显隐 */
  modelValue: boolean
  /** 待送检件列表（父组件应已剔除 'on note DN-XXX' 冲突项，且仅保留 status ∈ {PENDING, PROGRAMMING, IN_PROCESS}） */
  failures: BlockedScanItem[]
  /** 后端 message，作为弹窗副标题展示 */
  reason: string
  /** 扫码时缓存的 code，emit submit-success 时父组件用它重扫 */
  originalCode: string
}

const props = defineProps<Props>()

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void
  /** 全部送检成功 → 父组件重扫 originalCode */
  (e: 'submit-success'): void
  /** 部分送检 → 父组件 toast + 保留弹窗 */
  (e: 'submit-partial', result: { passed: BlockedScanItem[]; failed: BulkScanFailure[] }): void
  /** 用户点取消 */
  (e: 'cancel'): void
}>()

const dlg = useDialogSize({ desktopWidth: 920 })
const bulk = useBulkScanInspect()

// ============ 品检架候选 ============
// 扫码建单角色（CLERK / MANAGER / INSPECTOR）没有 SHELF_ACCOUNT 货架绑定，
// 因此本对话框直接拉全场 INSPECTION active 货架让用户选一个。
const shelves = ref<Shelf[]>([])
const selectedShelfId = ref<string | null>(null)
const shelvesLoading = ref(false)
const shelvesError = ref<string | null>(null)

async function loadShelves(): Promise<void> {
  shelvesLoading.value = true
  shelvesError.value = null
  try {
    const result = await listShelves({ zone: 'INSPECTION', is_active: true })
    shelves.value = result.items
  } catch (e) {
    shelvesError.value = (e as Error)?.message ?? '加载品检架失败'
    shelves.value = []
  } finally {
    shelvesLoading.value = false
  }
}

onMounted(() => {
  void loadShelves()
})

// ============ 副标题：去掉"失败明细：..."之后的部分（明细已在表格）============
const shortReason = computed(() => {
  const r = props.reason ?? ''
  const cut = r.split(/失败明细[:：]/)[0].trim()
  return cut || r
})

// ============ per-row 数量（默认 = 该件 quantity）============
const rowQuantities = ref<Record<string, number | null>>({})
// 返回该行用户调过的数量；未调过返回 null（提交时 fallback 到 row.quantity 全量）。
// 防御：part_id 可能为 undefined（21405 散件），返回 null 不参与索引。
function getQuantity(row: BlockedScanItem): number | null {
  if (!row.part_id) return null
  return row.part_id in rowQuantities.value
    ? rowQuantities.value[row.part_id] ?? null
    : null
}
function setQuantity(row: BlockedScanItem, val: number | null): void {
  if (!row.part_id) return
  rowQuantities.value = { ...rowQuantities.value, [row.part_id]: val }
}

// ============ 兼过检勾选（仅 status==='INSPECTION' 的行启用）============
// 设计说明：扫码建单 21418 失败明细里可能同时含 IN_PROCESS 子件 + 已 INSPECTION 子件
// （典型场景：装配件混合状态）。本对话框默认只处理 status ∈ {PENDING/PROGRAMMING/IN_PROCESS}
// 的"未送检"行；用户在表格里勾选"同时帮它过检"，则确认时拆成两批调用。
const checkedAlsoPass = ref<Set<string>>(new Set())
function toggleAlsoPass(partId: string): void {
  const next = new Set(checkedAlsoPass.value)
  if (next.has(partId)) next.delete(partId)
  else next.add(partId)
  checkedAlsoPass.value = next
}

const inspectableFailures = computed(() =>
  props.failures.filter(
    (f) =>
      f.status === 'PENDING' ||
      f.status === 'PROGRAMMING' ||
      f.status === 'IN_PROCESS',
  ),
)
const passableFailures = computed(() =>
  props.failures.filter((f) => f.status === 'INSPECTION'),
)

// ============ 可用条件 ============
// - 至少一个"待送检"行（inspectableFailures 非空）
// - 所有 failure 都有 part_id（21405 散件 message 解析出的占位 item 没有 part_id）
// - 已选品检架
const canBulkSubmit = computed(
  () =>
    inspectableFailures.value.length > 0 &&
    selectedShelfId.value !== null &&
    selectedShelfId.value.length > 0 &&
    props.failures.every(
      (f) => typeof f.part_id === 'string' && f.part_id.length > 0,
    ),
)

const disabledTooltip = computed(() => {
  if (shelvesError.value) return `品检架加载失败：${shelvesError.value}`
  if (!selectedShelfId.value) return '请先选择品检架'
  if (inspectableFailures.value.length === 0) {
    return '列表中没有可送检的件（status ∉ {PENDING, PROGRAMMING, IN_PROCESS}）'
  }
  return ''
})

// ============ actions ============

function onCancel(): void {
  emit('update:modelValue', false)
  emit('cancel')
}

// 关闭弹窗的统一入口（submit-success / partial 都用）
function closeDialog(): void {
  emit('update:modelValue', false)
}

// BlockedScanItem[] → BulkScanItem[]
function toBulkScanItems(
  rows: BlockedScanItem[],
): import('@/composables/useBulkScanInspect').BulkScanItem[] {
  return rows.map((f) => {
    const q = getQuantity(f)
    return {
      part_id: f.part_id as string, // canBulkSubmit guard 已确保非空
      batch_id: f.batch_id ?? undefined,
      quantity: q ?? undefined,
      decision: 'PASS', // 批量场景默认全 PASS
      label: `${f.serial_no} · ${f.name}`,
    }
  })
}

async function onConfirm(): Promise<void> {
  if (!canBulkSubmit.value || !selectedShelfId.value) return

  // 第一批：送检 inspectableFailures
  const firstResult = await bulk.run({
    target_inspection_shelf_id: selectedShelfId.value,
    items: toBulkScanItems(inspectableFailures.value),
  })

  // 第二批（可选）：勾选的 INSPECTION 行走 batchPassInspection
  const alsoPassRows = passableFailures.value.filter(
    (f) => f.part_id && checkedAlsoPass.value.has(f.part_id),
  )
  // 这里直接调 batchPassInspection（不在 useBulkScanInspect 范围内，复用现有端点）
  let secondResult: { passed: BlockedScanItem[]; failed: BulkScanFailure[] } | null = null
  if (alsoPassRows.length > 0) {
    const { batchPassInspection } = await import('@/api/parts')
    const resp = await batchPassInspection(
      alsoPassRows.map((f) => ({
        part_id: f.part_id as string,
        batch_id: f.batch_id ?? undefined,
        quantity: getQuantity(f) ?? undefined,
      })),
    )
    secondResult = {
      passed: resp.passed.map((p) => ({ part_id: p.id } as BlockedScanItem)),
      failed: resp.failed.map((f2) => ({
        item: { part_id: f2.part_id } as import('@/composables/useBulkScanInspect').BulkScanItem,
        code: f2.code,
        message: f2.message,
      })),
    }
  }

  // 汇总两批结果
  const totalPassed = firstResult.submitted.length + (secondResult?.passed.length ?? 0)
  const totalFailed = firstResult.failed.length + (secondResult?.failed.length ?? 0)

  if (totalFailed === 0) {
    ElMessage.success(`已送检 ${totalPassed} 项`)
    closeDialog()
    emit('submit-success')
  } else if (totalPassed > 0) {
    ElMessage.warning(
      `部分送检：${totalPassed} 项成功 / ${totalFailed} 项失败`,
    )
    // 保留弹窗让用户看到（按需重试）；合并 failed 给父组件（toast）
    emit('submit-partial', {
      passed: firstResult.submitted.map(
        (it) => ({ part_id: it.part_id } as BlockedScanItem),
      ),
      failed: [...firstResult.failed, ...(secondResult?.failed ?? [])],
    })
  } else {
    const firstMsg = firstResult.failed[0]?.message ?? '未知错误'
    ElMessage.error(`全部失败：${firstMsg}`)
  }
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    :title="`一键送检：${shortReason}`"
    :width="dlg.width.value"
    :top="dlg.top.value"
    :fullscreen="dlg.fullscreen.value"
    append-to-body
    :close-on-click-modal="false"
    destroy-on-close
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
  >
    <el-alert
      type="info"
      :closable="false"
      :title="`下列 ${inspectableFailures.length} 项零件尚未送检；选择品检架并确认后一键搬上 INSPECTION 架`"
      class="submit-alert"
    />

    <!-- 共享品检架选择器 -->
    <div class="shelf-picker">
      <span class="picker-label">目标品检架（共享）</span>
      <el-select
        v-model="selectedShelfId"
        :loading="shelvesLoading"
        placeholder="请选择 INSPECTION 区 active 货架"
        filterable
        style="width: 360px"
        :disabled="shelvesLoading"
      >
        <el-option
          v-for="s in shelves"
          :key="s.id"
          :value="s.id"
          :label="`${s.code} · ${s.name}`"
        />
      </el-select>
      <span v-if="shelvesError" class="muted">{{ shelvesError }}</span>
      <span v-else-if="shelves.length === 0 && !shelvesLoading" class="muted">
        （无 active 的 INSPECTION 货架）
      </span>
    </div>

    <el-table
      :data="failures"
      stripe
      border
      max-height="380"
      empty-text="无阻塞项"
      class="submit-table"
    >
      <el-table-column prop="serial_no" label="序列号" min-width="100" align="center" />
      <el-table-column prop="drawing_no" label="图号" min-width="100" align="center">
        <template #default="{ row }">
          <span :class="{ muted: !row.drawing_no }">{{ row.drawing_no || '—' }}</span>
        </template>
      </el-table-column>
      <el-table-column prop="name" label="名称" min-width="110" show-overflow-tooltip />
      <el-table-column label="状态" width="100" align="center">
        <template #default="{ row }">
          <el-tag
            v-if="row.status"
            :type="row.status === 'INSPECTION' ? 'warning' : 'primary'"
            size="small"
            effect="light"
          >
            {{ row.status }}
          </el-tag>
          <span v-else class="muted">—</span>
        </template>
      </el-table-column>
      <el-table-column label="送检数量" width="130" align="center">
        <template #default="{ row }">
          <el-input-number
            :model-value="getQuantity(row as BlockedScanItem) ?? row.quantity ?? 1"
            :min="1"
            :max="row.quantity ?? 9999"
            size="small"
            :controls="false"
            :disabled="!row.part_id || (row.status !== 'PENDING' && row.status !== 'PROGRAMMING' && row.status !== 'IN_PROCESS')"
            @update:model-value="(v) => setQuantity(row as BlockedScanItem, v as number | null)"
          />
        </template>
      </el-table-column>
      <el-table-column
        v-if="passableFailures.length > 0"
        label="同时过检"
        width="100"
        align="center"
      >
        <template #default="{ row }">
          <el-checkbox
            v-if="row.status === 'INSPECTION' && row.part_id"
            :model-value="checkedAlsoPass.has(row.part_id)"
            @change="() => row.part_id && toggleAlsoPass(row.part_id)"
          />
          <span v-else class="muted">—</span>
        </template>
      </el-table-column>
      <el-table-column
        label="原因"
        min-width="120"
        show-overflow-tooltip
      >
        <template #default="{ row }">
          <span :title="row.reason">
            {{ row.reason.length > 24 ? `${row.reason.slice(0, 24)}…` : row.reason }}
          </span>
        </template>
      </el-table-column>
    </el-table>

    <template #footer>
      <div class="submit-footer">
        <span v-if="bulk.running.value" class="submit-progress">
          进度 {{ bulk.progress.done }} / {{ bulk.progress.total }}
        </span>
        <div class="submit-actions">
          <el-button @click="onCancel">取消</el-button>
          <el-tooltip
            :content="disabledTooltip"
            :disabled="canBulkSubmit && !disabledTooltip"
            placement="top"
          >
            <el-button
              type="primary"
              :loading="bulk.running.value"
              :disabled="!canBulkSubmit"
              @click="onConfirm"
            >
              <el-icon><Upload /></el-icon>
              <span>一键送检</span>
            </el-button>
          </el-tooltip>
        </div>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
.submit-alert {
  margin-bottom: 12px;
}
.shelf-picker {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}
.picker-label {
  font-size: 14px;
  color: var(--el-text-color-regular);
  white-space: nowrap;
}
.submit-table {
  margin-top: 4px;
}
.submit-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
}
.submit-actions {
  display: inline-flex;
  gap: 8px;
  margin-left: auto;
}
.submit-progress {
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
.muted {
  color: var(--el-text-color-secondary);
}
</style>