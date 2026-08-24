<!--
  批量品检确认对话框（2026-08-23 新增）。

  用途：送货单详情页提交 / 扫码页二次确认 共用。
  父组件已过滤：status ∉ {INSPECTION, READY_TO_SHIP}。
  父组件拿到 pass-success 后接着调 submitNote(noteId, {version: noteVersion})。

  与 BlockedScanConfirmDialog 共用 useBulkPassInspection；
  区别仅在：数据源 = DeliveryNoteLineItem，emit pass-success 后父组件
  接 submitNote，而不是用 originalCode 重扫。
-->
<script setup lang="ts">
import { computed } from 'vue'
import { ElMessage } from 'element-plus'
import { Select } from '@element-plus/icons-vue'

import { useDialogSize } from '@/composables/useDialogSize'
import { useBulkPassInspection } from '@/composables/useBulkPassInspection'
import type { BulkPassItem, BulkPassFailure } from '@/composables/useBulkPassInspection'
import type { DeliveryNoteLineItem } from '@/types/deliveryNote'

interface Props {
  /** v-model 显隐 */
  modelValue: boolean
  /** 未送检零件列表（父组件已过滤 status ∉ {INSPECTION, READY_TO_SHIP}） */
  uninspectedItems: DeliveryNoteLineItem[]
  /** 当前 note id（仅展示用，真正 submit 在父组件做） */
  noteId: string
  /** 乐观锁；emit pass-success 后父组件 submitNote 透传 */
  noteVersion: number
  /** 调用来源（预留扩展如 'recall'；当前仅 'submit'） */
  source: 'submit'
}

const props = defineProps<Props>()

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void
  /** 全部通过 → 父组件接着 submitNote(noteId, {version: noteVersion}) */
  (e: 'pass-success'): void
  /** 部分通过 → 父组件 toast + 保留弹窗 */
  (e: 'pass-partial', result: { passed: BulkPassItem[]; failed: BulkPassFailure[] }): void
  /** 用户点取消 */
  (e: 'cancel'): void
}>()

const dlg = useDialogSize({ desktopWidth: 640 })
const bulk = useBulkPassInspection()

// noteId 截断展示（雪花 ID 很长）
const noteShortId = computed(() =>
  props.noteId.length > 8 ? `${props.noteId.slice(0, 8)}…` : props.noteId,
)

// DeliveryNoteLineItem[] → BulkPassItem[]
// 2026-08-23：DeliveryNoteLineItem.id 才是 batch_id（行身份），
// 顶层未直接命名 batch_id。fallback undefined 让 useBulkPassInspection 全量过检。
const items = computed<BulkPassItem[]>(() =>
  props.uninspectedItems.map((li) => ({
    part_id: li.part_id,
    batch_id: li.id || undefined,
    quantity: li.quantity,
    label: `${li.serial_no ?? li.drawing_no} · ${li.name}`,
  })),
)

// 「一键通过品检」可用条件：列表非空 + 每个 li 都有 part_id
const canBulkPass = computed(
  () =>
    props.uninspectedItems.length > 0 &&
    props.uninspectedItems.every(
      (li) => typeof li.part_id === 'string' && li.part_id.length > 0,
    ),
)

const disabledTooltip = computed(() =>
  canBulkPass.value
    ? ''
    : '存在缺少 part_id 的行，无法通过品检',
)

function onCancel(): void {
  emit('update:modelValue', false)
  emit('cancel')
}

async function onConfirm(): Promise<void> {
  if (!canBulkPass.value) return
  const result = await bulk.run(items.value)
  if (result.failed.length === 0) {
    ElMessage.success(`已通过品检 ${result.passed.length} 项`)
    emit('update:modelValue', false)
    emit('pass-success')
  } else if (result.passed.length > 0) {
    ElMessage.warning(
      `部分通过：${result.passed.length} 项成功 / ${result.failed.length} 项失败`,
    )
    emit('pass-partial', result)
  } else {
    ElMessage.error(`全部失败：${result.failed[0]?.message ?? '未知错误'}`)
  }
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    :title="`品检确认：送货单 ${noteShortId}`"
    :width="dlg.width.value"
    :top="dlg.top.value"
    :fullscreen="dlg.fullscreen.value"
    append-to-body
    :close-on-click-modal="false"
    destroy-on-close
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
  >
    <el-alert
      type="warning"
      :closable="false"
      :title="`送货单中有 ${uninspectedItems.length} 个未送检零件，确认后一键通过品检并提交草稿`"
    />
    <el-table
      :data="uninspectedItems"
      stripe
      border
      max-height="380"
      empty-text="无未送检件"
      class="batch-table"
    >
      <el-table-column prop="serial_no" label="序列号" min-width="100" align="center">
        <template #default="{ row }">
          <span :class="{ muted: !row.serial_no }">{{ row.serial_no || '—' }}</span>
        </template>
      </el-table-column>
      <el-table-column prop="drawing_no" label="图号" min-width="100" align="center" />
      <el-table-column prop="name" label="名称" min-width="110" show-overflow-tooltip />
      <el-table-column prop="quantity" label="数量" width="80" align="right" />
      <el-table-column label="当前状态" min-width="120" align="center">
        <template #default="{ row }">
          <el-tag type="warning" size="small" effect="light">{{ row.status }}</el-tag>
        </template>
      </el-table-column>
    </el-table>

    <template #footer>
      <div class="batch-footer">
        <span class="batch-version">乐观锁 version: {{ noteVersion }}</span>
        <div class="batch-actions">
          <span v-if="bulk.running.value" class="batch-progress">
            进度 {{ bulk.progress.done }} / {{ bulk.progress.total }}
          </span>
          <el-button @click="onCancel">取消</el-button>
          <el-tooltip
            :content="disabledTooltip"
            :disabled="canBulkPass"
            placement="top"
          >
            <el-button
              type="primary"
              :loading="bulk.running.value"
              :disabled="!canBulkPass"
              @click="onConfirm"
            >
              <el-icon><Select /></el-icon>
              <span>一键全部通过品检并提交</span>
            </el-button>
          </el-tooltip>
        </div>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
.batch-table {
  margin-top: 12px;
}
.batch-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
}
.batch-actions {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}
.batch-progress {
  color: var(--el-text-color-secondary);
  font-size: 13px;
  margin-right: 4px;
}
.batch-version {
  color: var(--el-text-color-secondary);
  font-size: 12px;
  font-family: 'JetBrains Mono', 'SFMono-Regular', Consolas, monospace;
}
.muted {
  color: var(--el-text-color-secondary);
}
</style>
