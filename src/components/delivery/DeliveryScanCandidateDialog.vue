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
-->
<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'

import { buildSelectedScanItems, useBulkScanInspect } from '@/composables/useBulkScanInspect'
import { listShelves } from '@/api/shelves'
import type { Shelf } from '@/types/shelf'
import type { ScanUnresolvedTarget, ScanAvailableBatch } from '@/types/deliveryNote'

// 路线 B 弹窗内的扁平批次行（每个 ScanAvailableBatch 摊平成 el-table 一行，
// 附带外层 ScanUnresolvedTarget 的 part 级信息以展示序列号/图号/名称）。
// 2026-08-31 新增：批次勾选送检（route B 部分挑选）。
interface FlatBatchRow extends ScanAvailableBatch {
  part_id: string
  serial_no: string
  drawing_no: string
  name: string
}

interface Props {
  /** v-model 显隐 */
  modelValue: boolean
  /** route B 未就绪工单列表（每个含 available_batches[]） */
  targets: ScanUnresolvedTarget[]
  /** 可选；预选品检架 id（雪花 ID 字符串）。父级若已锁定品检架可传入。 */
  defaultShelfId?: string
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

// 弹窗打开时刷新货架（覆盖父级 defaultShelfId 变化 + 货架启用状态变更）
watch(
  () => props.modelValue,
  (v) => {
    if (v) {
      if (props.defaultShelfId) selectedShelfId.value = props.defaultShelfId
      selectedBatchIds.value = new Set() // 重置勾选（防止上次会话残留）
      void loadShelves()
    }
  },
)

onMounted(() => {
  if (props.modelValue) void loadShelves()
})

/** flatBatches：把 ScanUnresolvedTarget[] 展平为 FlatBatchRow[]，供 el-table 渲染。 */
const flatBatches = computed<FlatBatchRow[]>(() =>
  props.targets.flatMap((t) =>
    t.available_batches.map((b: ScanAvailableBatch) => ({
      ...b,
      part_id: t.part_id,
      serial_no: t.serial_no,
      drawing_no: t.drawing_no,
      name: t.name,
    })),
  ),
)

/**
 * el-table @selection-change 回调：把当前勾选行同步到 selectedBatchIds。
 * 注意：参数是当前可见勾选行（Element Plus 行为），不是 toggle diff；
 * 用新 Set 整体替换以确保与 UI 状态一致。
 */
function onSelectionChange(rows: FlatBatchRow[]): void {
  selectedBatchIds.value = new Set(rows.map((r) => r.batch_id))
}

const canConfirm = computed(
  () =>
    flatBatches.value.length > 0 &&
    selectedBatchIds.value.size > 0 &&
    selectedShelfId.value !== null &&
    selectedShelfId.value.length > 0 &&
    !shelvesLoading.value,
)

async function onConfirm(): Promise<void> {
  const shelfId = selectedShelfId.value
  if (!shelfId) {
    ElMessage.warning('请选择品检架')
    return
  }
  if (selectedBatchIds.value.size === 0) {
    ElMessage.warning('请至少勾选一个批次')
    return
  }
  const items = buildSelectedScanItems(props.targets, selectedBatchIds.value)
  submitting.value = true
  try {
    const result = await bulk.run({
      target_inspection_shelf_id: shelfId,
      items,
    })
    if (result.failed.length === 0) {
      ElMessage.success(`已送检 ${result.submitted.length} 项`)
      emit('done')
      emit('update:modelValue', false)
    } else if (result.submitted.length === 0) {
      ElMessage.error(`全部送检失败：${result.failed[0]?.message ?? '未知错误'}`)
    } else {
      ElMessage.warning(
        `部分送检：${result.submitted.length} 项成功 / ${result.failed.length} 项失败`,
      )
      // 部分成功也视为「resolved enough」——重扫走 CANDIDATES_AVAILABLE 二次判定
      emit('done')
      emit('update:modelValue', false)
    }
  } finally {
    submitting.value = false
  }
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
      :title="`下列 ${targets.length} 个工单（${flatBatches.length} 个批次）未送检；勾选要送检的批次后选择品检架一键送检`"
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
        一键送检
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