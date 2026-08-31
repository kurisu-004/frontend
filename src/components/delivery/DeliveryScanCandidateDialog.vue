<!--
  route B 候选批次一键送检确认对话框（2026-08-28 后端路线 B 重构新增）。

  用途：扫码建单页遇到 CANDIDATES_AVAILABLE / PARTIAL_ADDED outcome 时弹出。
  父组件 DeliveryNoteScan 在 useDeliveryScanSubmission 命中后设置 candidateTargets /
  candidateDialogVisible，本对话框渲染未送检工单列表，让用户选一个共享品检架后
  一键调用 useBulkScanInspect().run()（POST /parts/batch-to-inspection）。
  全部 / 部分成功 → emit('done') → 父级用 originalScanCode 重扫（B 组升 A 后入单）。

  设计要点：
  - 与 BatchSubmitInspectionConfirmDialog 风格一致（el-dialog + #footer slot），但更轻量：
    route B 不再含 per-row 数量编辑 / 「同时过检」分支（route B inspection 不支持 FAIL）。
  - 2026-08-28 fix：dev-stage 的 el-input + 数字 regex 替换为 el-select + listShelves
    拉 INSPECTION zone active 货架列表（与 InspectionPending 同款），避免手敲 ID。
  - items 字段：仅 batch_id + quantity + label（route B 字段收敛）。
  - 2026-08-31 扩展：合并 A 组（attachable_batches，「加入」送货单）+ B 组
    （available_batches，「送检」后入单），onConfirm 分流：ATTACHABLE 走
    attach-batches，INSPECTABLE 走 batch-to-inspection。默认全勾（用户取消即部分处理）。
-->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'

import { buildSelectedScanItems, useBulkScanInspect } from '@/composables/useBulkScanInspect'
import { attachBatches } from '@/api/deliveryNote'
import { listShelves } from '@/api/shelves'
import type { Shelf } from '@/types/shelf'
import type { ScanUnresolvedTarget } from '@/types/deliveryNote'

// 路线 B 弹窗内的扁平批次行（每个 ScanAvailableBatch + ScanAttachableBatch 摊平成 el-table 一行，
// 附带外层 ScanUnresolvedTarget 的 part 级信息以展示序列号/图号/名称）。
// 2026-08-31 扩展：合并 A+B 组，每行加 `kind` 决定走 attach 还是 inspect。
type BatchKind = 'ATTACHABLE' | 'INSPECTABLE'

interface FlatBatchRow {
  batch_id: string
  quantity: number
  status: string
  version: number
  kind: BatchKind
  part_id: string
  serial_no: string
  drawing_no: string
  name: string
}

interface Props {
  /** v-model 显隐 */
  modelValue: boolean
  /** route B 未就绪工单列表（每个含 available_batches[] + attachable_batches[]） */
  targets: ScanUnresolvedTarget[]
  /** 可选；预选品检架 id（雪花 ID 字符串）。父级若已锁定品检架可传入。 */
  defaultShelfId?: string
  /** 2026-08-31 新增：attach-batches endpoint 必填。 */
  noteId: string
}

const props = defineProps<Props>()

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void
  /** 全部 / 部分送检成功后 emit，父级用 originalScanCode 重扫 */
  (e: 'done'): void
}>()

const bulk = useBulkScanInspect()
const submitting = ref(false)

/** 用户勾选的批次 id 集合；弹窗打开时（modelValue 变 true）重置为空集。 */
const selectedBatchIds = ref(new Set<string>())

// ============ 品检架候选（INSPECTION zone active）============
// 2026-08-28 fix：dev-stage el-input + 数字 regex 改为 el-select + listShelves，
// 复用 InspectionPending 的 picker 模式（`listShelves({zone, is_active, limit})`）。
const shelves = ref<Shelf[]>([])
const selectedShelfId = ref<string | null>(props.defaultShelfId ?? null)
const shelvesLoading = ref(false)
const shelvesError = ref<string | null>(null)

async function loadShelves(): Promise<void> {
  shelvesLoading.value = true
  shelvesError.value = null
  try {
    const result = await listShelves({ zone: 'INSPECTION', is_active: true, limit: 200 })
    shelves.value = result.items
    // 若 defaultShelfId 不在候选列表里（已被禁用 / 切走），回退到不选中
    if (props.defaultShelfId && !shelves.value.some((s) => s.id === props.defaultShelfId)) {
      selectedShelfId.value = null
    }
  } catch (e) {
    shelvesError.value = (e as Error)?.message ?? '加载品检架失败'
    shelves.value = []
  } finally {
    shelvesLoading.value = false
  }
}

// 弹窗打开时刷新货架 + 默认全选（覆盖父级 defaultShelfId 变化 + 货架启用状态变更）
watch(
  () => props.modelValue,
  (v) => {
    if (v) {
      if (props.defaultShelfId) selectedShelfId.value = props.defaultShelfId
      // 2026-08-31 改：默认全选（Element Plus el-table type="selection" 不支持「打开即默认全选」，
      // 用 selectedBatchIds 模拟；用户取消勾选即走部分处理路径）。
      selectedBatchIds.value = new Set(flatBatches.value.map((r) => r.batch_id))
      void loadShelves()
    }
  },
  { immediate: true },  // 2026-08-31 加：与 onMounted 二选一，避免重复 loadShelves
)

/** flatBatches：把 ScanUnresolvedTarget[] 展平为 FlatBatchRow[]，合并 A+B 两组。
 *  顺序：ATTACHABLE 在前（同类聚集），INSPECTABLE 在后。 */
const flatBatches = computed<FlatBatchRow[]>(() =>
  props.targets.flatMap((t) => {
    const attachableRows: FlatBatchRow[] = t.attachable_batches.map((b) => ({
      batch_id: b.batch_id,
      quantity: b.quantity,
      status: b.status,
      version: b.version,
      kind: 'ATTACHABLE' as const,
      part_id: t.part_id,
      serial_no: t.serial_no,
      drawing_no: t.drawing_no,
      name: t.name,
    }))
    const inspectableRows: FlatBatchRow[] = t.available_batches.map((b) => ({
      batch_id: b.batch_id,
      quantity: b.quantity,
      status: b.status,
      version: b.version,
      kind: 'INSPECTABLE' as const,
      part_id: t.part_id,
      serial_no: t.serial_no,
      drawing_no: t.drawing_no,
      name: t.name,
    }))
    return [...attachableRows, ...inspectableRows]
  }),
)

/**
 * el-table @selection-change 回调：把当前勾选行同步到 selectedBatchIds。
 * 注意：参数是当前可见勾选行（Element Plus 行为），不是 toggle diff；
 * 用新 Set 整体替换以确保与 UI 状态一致。
 */
function onSelectionChange(rows: FlatBatchRow[]): void {
  selectedBatchIds.value = new Set(rows.map((r) => r.batch_id))
}

/** 是否勾了 INSPECTABLE 行（决定货架是否必填） */
const hasInspectableSelected = computed(() =>
  flatBatches.value
    .filter((r) => selectedBatchIds.value.has(r.batch_id))
    .some((r) => r.kind === 'INSPECTABLE'),
)

const canConfirm = computed(
  () =>
    flatBatches.value.length > 0 &&
    selectedBatchIds.value.size > 0 &&
    !shelvesLoading.value &&
    // 货架仅在勾了 INSPECTABLE 时必填
    (!hasInspectableSelected.value || (selectedShelfId.value !== null && selectedShelfId.value.length > 0)),
)

async function onConfirm(): Promise<void> {
  if (selectedBatchIds.value.size === 0) {
    ElMessage.warning('请至少勾选一个批次')
    return
  }

  const selectedRows = flatBatches.value.filter((r) =>
    selectedBatchIds.value.has(r.batch_id),
  )
  const inspectable = selectedRows.filter((r) => r.kind === 'INSPECTABLE')
  const attachable = selectedRows.filter((r) => r.kind === 'ATTACHABLE')

  // 货架仅在有 INSPECTABLE 时必填
  const shelfId = selectedShelfId.value
  if (inspectable.length > 0 && !shelfId) {
    ElMessage.warning('请选择品检架')
    return
  }

  submitting.value = true
  try {
    let inspectOk = 0
    let inspectFail = 0
    let attachOk = 0
    let attachFail = 0

    // 1) INSPECTABLE：一键送检（复用 buildSelectedScanItems，喂只剩 INSPECTABLE 的临时结构）
    if (inspectable.length > 0 && shelfId) {
      const items = buildSelectedScanItems(
        filterTargetsByKind(props.targets, 'INSPECTABLE', selectedBatchIds.value),
        selectedBatchIds.value,
      )
      const result = await bulk.run({
        target_inspection_shelf_id: shelfId,
        items,
      })
      inspectOk = result.submitted.length
      inspectFail = result.failed.length
    }

    // 2) ATTACHABLE：attach-batches
    if (attachable.length > 0) {
      const result = await attachBatches(
        props.noteId,
        attachable.map((r) => ({ batch_id: r.batch_id, version: r.version })),
      )
      attachOk = result.attached
      attachFail = result.conflicts.length
    }

    // 3) 汇总 toast
    const totalOk = inspectOk + attachOk
    const totalFail = inspectFail + attachFail
    if (totalFail === 0 && totalOk > 0) {
      ElMessage.success(`已处理 ${totalOk} 项`)
      emit('done')
      emit('update:modelValue', false)
    } else if (totalOk === 0) {
      ElMessage.error('全部处理失败，请检查后重试')
    } else {
      ElMessage.warning(
        `部分处理：送检 ${inspectOk}/${inspectable.length}，加入 ${attachOk}/${attachable.length}`,
      )
      // 部分成功也算 resolved（父级重扫会再判定）
      emit('done')
      emit('update:modelValue', false)
    }
  } finally {
    submitting.value = false
  }
}

/** helper：从 props.targets 中筛出只含指定 kind 行的临时结构，喂给 buildSelectedScanItems。
 *  ATTACHABLE 不走送检，本函数目前只用 INSPECTABLE 路径；保留 ATTACHABLE 分支便于对称扩展。 */
function filterTargetsByKind(
  targets: ScanUnresolvedTarget[],
  _kind: 'INSPECTABLE' | 'ATTACHABLE',
  selected: Set<string>,
): ScanUnresolvedTarget[] {
  return targets
    .map((t) => ({
      ...t,
      available_batches: t.available_batches.filter((b) => selected.has(b.batch_id)),
      attachable_batches: [],
    }))
    .filter((t) => t.available_batches.length > 0)
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    title="未送检件确认（路线 B）"
    width="640px"
    append-to-body
    :close-on-click-modal="false"
    destroy-on-close
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
  >
    <el-alert
      type="info"
      :closable="false"
      :title="`勾选要处理的批次：A 组「加入」送货单；B 组「送检」后入单。已默认全选。`"
      class="candidate-alert"
    />

    <div class="shelf-picker">
      <span class="picker-label">目标品检架（共享）</span>
      <el-select
        v-model="selectedShelfId"
        :loading="shelvesLoading"
        placeholder="选择 INSPECTION 区 active 货架"
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

    <div v-if="flatBatches.length === 0" class="muted">无未送检批次</div>
    <el-table
      v-else
      :data="flatBatches"
      row-key="batch_id"
      max-height="320"
      border
      aria-label="未送检候选批次列表"
      empty-text="该工单下暂无可送检批次"
      @selection-change="onSelectionChange"
    >
      <el-table-column type="selection" width="44" fixed="left" />
      <!-- 2026-08-31 新增：动作列，区分 ATTACHABLE（加入） / INSPECTABLE（送检） -->
      <el-table-column label="动作" width="80" align="center">
        <template #default="{ row }">
          <el-tag
            :type="row.kind === 'ATTACHABLE' ? 'success' : 'warning'"
            size="small"
          >
            {{ row.kind === 'ATTACHABLE' ? '加入' : '送检' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="serial_no" label="序列号" min-width="90" align="center" />
      <el-table-column prop="drawing_no" label="图号" min-width="110" align="center" show-overflow-tooltip />
      <el-table-column prop="name" label="名称" min-width="80" align="center" show-overflow-tooltip />
      <el-table-column prop="batch_id" label="批次ID" min-width="140" align="center" show-overflow-tooltip>
        <template #default="{ row }">
          {{ row.batch_id }}
        </template>
      </el-table-column>
      <el-table-column prop="quantity" label="数量" width="70" align="center" />
      <el-table-column prop="status" label="状态" width="90" align="center" />
    </el-table>

    <template #footer>
      <el-button @click="emit('update:modelValue', false)">取消</el-button>
      <el-button
        type="primary"
        :loading="submitting"
        :disabled="!canConfirm"
        @click="onConfirm"
      >
        确认处理
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.candidate-alert {
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
.muted {
  color: var(--el-text-color-secondary);
}
</style>