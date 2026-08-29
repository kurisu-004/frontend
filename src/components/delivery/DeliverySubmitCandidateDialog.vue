<!--
  submit 后 CANDIDATES_AVAILABLE 候选批次一键过检确认对话框（2026-08-29 新增）。

  用途：送货单 submit 后端返回 outcome=CANDIDATES_AVAILABLE 时弹出。
  后端语义：note 仍是 DRAFT，但仍有挂在单上的 INSPECTION 批次未过检。
  本对话框让用户一键 INSPECTION → READY_TO_SHIP，过检成功 emit('done')
  → 父级 fetchDetail 拿新 version → 再次 submit。

  与 DeliveryScanCandidateDialog 的区别：
  - 不需要选品检架（over-inspection 直接 READY_TO_SHIP）
  - 走 useBulkPassInspection（不是 useBulkScanInspect；路线是 INSPECTION → READY_TO_SHIP）
  - 父级回调是「拿新 version + 重 submit」（不是「重扫」）

  items 字段：仅 batch_id + version + quantity + label（route B 字段收敛）；
  后端 service 按 batch_id 反查 t_part_batch.part_id，前端不重复带 part_id。
-->
<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'

import { useBulkPassInspection } from '@/composables/useBulkPassInspection'
import type { BulkPassItem } from '@/composables/useBulkPassInspection'
import type { ScanUnresolvedTarget } from '@/types/deliveryNote'

interface Props {
  /** v-model 显隐 */
  modelValue: boolean
  /** submit 返回的未过检工单列表（每个含 available_batches[]，均为 INSPECTION 状态） */
  targets: ScanUnresolvedTarget[]
}

const props = defineProps<Props>()

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void
  /** 全部 / 部分过检成功后 emit，父级 fetchDetail 拿新 version + 再次 submit。
   *  若再次返回 CANDIDATES_AVAILABLE（极端：过检后又有新 INSPECTION 批次）由父级
   *  的 doSubmit 守卫（submittingByNote）兜底再次触发弹窗。 */
  (e: 'done'): void
  /** 用户取消 */
  (e: 'cancel'): void
}>()

const bulk = useBulkPassInspection()
const submitting = ref(false)

/** 所有未过检批次的总批次数（UI 文案用） */
const totalBatchCount = computed(() =>
  props.targets.reduce((sum, t) => sum + t.available_batches.length, 0),
)

/** flatItems：把 ScanUnresolvedTarget[] 展平为 BulkPassItem[]
 *  供 useBulkPassInspection().run() 直接消费。
 *  透传 b.version（caller OCC 锚 t_part_batch）。 */
const flatItems = computed<BulkPassItem[]>(() =>
  props.targets.flatMap((t) =>
    t.available_batches.map((b) => ({
      batch_id: b.batch_id,
      version: b.version,
      quantity: b.quantity,
      label: `${t.serial_no} / 批 ${b.batch_id}`,
    })),
  ),
)

async function onConfirm(): Promise<void> {
  if (!props.targets.length) return
  submitting.value = true
  try {
    const result = await bulk.run(flatItems.value)
    if (result.failed.length === 0) {
      ElMessage.success(`已过检 ${result.passed.length} 项`)
      emit('done')
      emit('update:modelValue', false)
    } else if (result.passed.length > 0) {
      ElMessage.warning(`部分过检：${result.passed.length} 成功 / ${result.failed.length} 失败`)
      // 部分成功也视为「resolved enough」——重 submit 走 CANDIDATES_AVAILABLE 二次判定
      emit('done')
      emit('update:modelValue', false)
    } else {
      ElMessage.error(`全部失败：${result.failed[0]?.message ?? '未知错误'}`)
    }
  } finally {
    submitting.value = false
  }
}

function onCancel(): void {
  emit('update:modelValue', false)
  emit('cancel')
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    title="未过检件确认（提交）"
    width="640px"
    append-to-body
    :close-on-click-modal="false"
    destroy-on-close
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
  >
    <el-alert
      type="warning"
      :closable="false"
      :title="`送货单中仍有 ${targets.length} 个工单（${totalBatchCount} 个批次）未过检；确认后一键过检并重新提交`"
      class="candidate-alert"
    />

    <div v-if="targets.length === 0" class="muted">无未过检项</div>
    <el-table v-else :data="targets" max-height="320" border>
      <el-table-column prop="serial_no" label="序列号" align="center" />
      <el-table-column prop="drawing_no" label="图号" align="center" />
      <el-table-column prop="name" label="名称" align="center" />
      <el-table-column label="候选批次数" width="120" align="center">
        <template #default="{ row }">
          {{ row.available_batches.length }}
        </template>
      </el-table-column>
      <el-table-column label="状态" width="120" align="center">
        <template #default="{ row }">
          <el-tag type="warning" size="small" effect="light">
            {{ row.available_batches[0]?.status ?? 'INSPECTION' }}
          </el-tag>
        </template>
      </el-table-column>
    </el-table>

    <template #footer>
      <el-button @click="onCancel">取消</el-button>
      <el-button
        type="primary"
        :loading="submitting"
        :disabled="targets.length === 0"
        @click="onConfirm"
      >
        一键过检并重新提交
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.candidate-alert {
  margin-bottom: 12px;
}
.muted {
  color: var(--el-text-color-secondary);
}
</style>