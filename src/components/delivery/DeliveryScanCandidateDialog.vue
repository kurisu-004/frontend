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
  - 「目标品检架 ID」dev-stage 用 el-input 让用户手动输入；后续 PR 替换为
    usePartLocationTree 选品检架（与 InspectionPending 共享），见 brief 决策。
  - items 字段：仅 batch_id + quantity + label（route B 字段收敛）。
-->
<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'

import { useBulkScanInspect } from '@/composables/useBulkScanInspect'
import type { BulkScanItem } from '@/composables/useBulkScanInspect'
import type { ScanUnresolvedTarget, ScanAvailableBatch } from '@/types/deliveryNote'

interface Props {
  /** v-model 显隐 */
  modelValue: boolean
  /** route B 未就绪工单列表（每个含 available_batches[]） */
  targets: ScanUnresolvedTarget[]
}

const props = defineProps<Props>()

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void
  /** 全部 / 部分送检成功后 emit，父级用 originalScanCode 重扫 */
  (e: 'done'): void
}>()

const bulk = useBulkScanInspect()
const submitting = ref(false)

/** 用户输入的目标品检架 ID（雪花 ID 数字字符串）。
 * 当前实现：dev-stage 用 el-input 让用户手动输入品检架 ID。
 * 后续迭代将替换为 usePartLocationTree 选品检架（与 InspectionPending 共享）。 */
const targetShelfIdInput = ref<string>('')

/** 所有未送检批次的总批次数（UI 文案用） */
const totalBatchCount = computed(() =>
  props.targets.reduce((sum, t) => sum + t.available_batches.length, 0),
)

/** flatItems：把 ScanUnresolvedTarget[] 展平为 BulkScanItem[]
 *  供 useBulkScanInspect().run() 直接消费。 */
const flatItems = computed<BulkScanItem[]>(() =>
  props.targets.flatMap((t) =>
    t.available_batches.map((b: ScanAvailableBatch) => ({
      batch_id: b.batch_id,
      quantity: b.quantity,
      label: `${t.serial_no} / 批 ${b.batch_id}`,
    })),
  ),
)

async function onConfirm(): Promise<void> {
  const shelfId = targetShelfIdInput.value.trim()
  if (!shelfId) {
    ElMessage.warning('请输入目标品检架 ID')
    return
  }
  if (!/^\d+$/.test(shelfId)) {
    ElMessage.warning('品检架 ID 必须是数字')
    return
  }
  submitting.value = true
  try {
    const result = await bulk.run({
      target_inspection_shelf_id: shelfId,
      items: flatItems.value,
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
      :title="`下列 ${targets.length} 个工单（${totalBatchCount} 个批次）未送检；选择品检架后一键送检`"
      class="candidate-alert"
    />

    <div class="shelf-picker">
      <span class="picker-label">目标品检架 ID（共享）</span>
      <el-input
        v-model="targetShelfIdInput"
        placeholder="输入品检架 ID（数字），如 12345"
        clearable
        style="width: 360px"
      />
      <span class="picker-hint muted">
        dev-stage 临时输入；后续切 usePartLocationTree 选品检架
      </span>
    </div>

    <div v-if="targets.length === 0" class="muted">无未送检项</div>
    <el-table v-else :data="targets" max-height="320" border>
      <el-table-column prop="serial_no" label="序列号" align="center" />
      <el-table-column prop="drawing_no" label="图号" align="center" />
      <el-table-column prop="name" label="名称" align="center" />
      <el-table-column label="候选批次数" width="120" align="center">
        <template #default="{ row }">
          {{ row.available_batches.length }}
        </template>
      </el-table-column>
    </el-table>

    <template #footer>
      <el-button @click="emit('update:modelValue', false)">取消</el-button>
      <el-button
        type="primary"
        :loading="submitting"
        :disabled="targets.length === 0"
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
.picker-hint {
  font-size: 12px;
}
.muted {
  color: var(--el-text-color-secondary);
}
</style>