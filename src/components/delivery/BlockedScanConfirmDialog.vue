<!--
  扫码阻塞确认对话框（2026-08-23 新增；2026-08-25 切到 v2 批量端点）。

  用途：扫码建单页遇到 21418 / 21405 时弹出，列出阻塞件；
  品检员一键确认后批量通过品检（useBulkPassInspection → v2 batch 端点），
  父组件拿到 pass-success 后自动用 originalCode 重扫。

  设计要点：
  - 父组件应已把 'on note DN-XXX' 冲突项剔除；本组件不再二次过滤。
  - 「一键通过品检」按钮在所有 failure 都带 part_id 时可用；
    21405 散件 message 解析出的占位 item 没有 part_id → disabled + tooltip。
  - 部分通过：保留弹窗 + emit pass-partial，父组件 toast 即可，不自动重扫。
-->
<script setup lang="ts">
import { computed } from 'vue'
import { ElMessage } from 'element-plus'
import { CircleCheck } from '@element-plus/icons-vue'

import { useDialogSize } from '@/composables/useDialogSize'
import { useBulkPassInspection } from '@/composables/useBulkPassInspection'
import type { BulkPassItem, BulkPassFailure } from '@/composables/useBulkPassInspection'
import type { BlockedScanItem } from '@/types/deliveryNote'

interface Props {
  /** v-model 显隐 */
  modelValue: boolean
  /** 阻塞件列表（父组件应已剔除 'on note DN-XXX' 冲突项） */
  failures: BlockedScanItem[]
  /** 后端 message，作为弹窗副标题展示 */
  reason: string
  /** 扫码时缓存的 code，emit pass-success 时父组件用它重扫 */
  originalCode: string
}

const props = defineProps<Props>()

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void
  /** 全部通过品检 → 父组件重扫 originalCode */
  (e: 'pass-success'): void
  /** 部分通过 → 父组件 toast + 保留弹窗 */
  (e: 'pass-partial', result: { passed: BulkPassItem[]; failed: BulkPassFailure[] }): void
  /** 用户点取消 */
  (e: 'cancel'): void
}>()

const dlg = useDialogSize({ desktopWidth: 880 })
const bulk = useBulkPassInspection()

// 2026-08-24：标题只显示汇总，剥离 "失败明细：..." 之后的部分
// （明细已在表格里，title 重复展示既冗余又触发水平滚动）
const shortReason = computed(() => {
  const r = props.reason ?? ''
  const cut = r.split(/失败明细[:：]/)[0].trim()
  return cut || r
})

// BlockedScanItem[] → BulkPassItem[]
const items = computed<BulkPassItem[]>(() =>
  props.failures.map((f) => ({
    // canBulkPass 已 guard 所有 f.part_id 是非空字符串 → 这里强断言
    part_id: f.part_id as string,
    batch_id: f.batch_id ?? undefined,
    label: `${f.serial_no} · ${f.name}`,
  })),
)

// 「一键通过品检」可用条件：列表非空 + 每个 failure 都有 part_id。
// 2026-08-25：后端已扩展 ScanFailureDto，21418 一律带 part_id；21405 散件
// message 解析出的占位 item 没 part_id（payload 解析不出 part 级 ID）→
// 这种场景下按钮 disabled，由用户手动走单件品检流程。
const canBulkPass = computed(
  () =>
    props.failures.length > 0 &&
    props.failures.every(
      (f) => typeof f.part_id === 'string' && f.part_id.length > 0,
    ),
)

// 2026-08-25：tooltip 文案改为业务描述（21405 散件 part_id 缺失）
const disabledTooltip = computed(() =>
  canBulkPass.value ? '' : '存在缺少 part_id 的行（多为 21405 散件），请手动通过品检',
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
    :title="`未送检阻塞：${shortReason}`"
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
      :title="`下列 ${failures.length} 项零件尚未通过品检，确认后一键置送检状态并自动重加入单`"
    />
    <el-table
      :data="failures"
      stripe
      border
      max-height="380"
      empty-text="无阻塞项"
      class="blocked-table"
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
          <el-tag v-if="row.status" type="warning" size="small" effect="light">
            {{ row.status }}
          </el-tag>
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
      <div class="blocked-footer">
        <span v-if="bulk.running.value" class="blocked-progress">
          进度 {{ bulk.progress.done }} / {{ bulk.progress.total }}
        </span>
        <div class="blocked-actions">
          <el-button @click="onCancel">取消</el-button>
          <el-tooltip
            :content="disabledTooltip"
            :disabled="canBulkPass"
            placement="top"
          >
            <el-button
              type="success"
              :loading="bulk.running.value"
              :disabled="!canBulkPass"
              @click="onConfirm"
            >
              <el-icon><CircleCheck /></el-icon>
              <span>一键全部通过品检</span>
            </el-button>
          </el-tooltip>
        </div>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
.blocked-table {
  margin-top: 12px;
}
.blocked-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
}
.blocked-actions {
  display: inline-flex;
  gap: 8px;
  margin-left: auto;
}
.blocked-progress {
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
.muted {
  color: var(--el-text-color-secondary);
}
</style>
