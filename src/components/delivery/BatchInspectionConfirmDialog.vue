<!--
  批量品检确认对话框（2026-08-23 新增；2026-08-25 切到 v2 批量端点；
  2026-08-28 切 route B 批量端点 + items 改 batch_id-only）。

  用途：送货单详情页提交 / 扫码页二次确认 共用。
  父组件已过滤：status ∉ {INSPECTION, READY_TO_SHIP}。
  父组件拿到 pass-success 后接着调 submitNote(noteId, {version: noteVersion})。

  调 useBulkPassInspection.run → v2 batchToShip 端点；
  本组件只处理 INSPECTION/READY_TO_SHIP 件一键过检。区别仅在：
  数据源 = DeliveryNoteLineItem，emit pass-success 后父组件接 submitNote，
  而不是用 originalCode 重扫。

  2026-08-28 路线 B 改造：items 字段收敛为 batch_id + quantity + label；
  后端 service 按 batch_id 反查 t_part_batch.part_id，前端不再带 part_id。
-->
<script setup lang="ts">
import { computed, h, ref } from 'vue'
import { ElMessage, ElTag } from 'element-plus'
import { Select } from '@element-plus/icons-vue'

import { useDialogSize } from '@/composables/useDialogSize'
import { useBulkPassInspection } from '@/composables/useBulkPassInspection'
import type { BulkPassResult } from '@/composables/useBulkPassInspection'
import type { DeliveryNoteLineItem } from '@/types/deliveryNote'
import {
  resolveDraggable,
  useColumnVisibility,
  type ColumnDef,
} from '@/composables/useColumnVisibility'
import { columnIdentifier, useColumnDrag } from '@/composables/useColumnDrag'
import ColumnDragHandle from '@/components/ColumnDragHandle.vue'
import ColumnVisibilityPopover from '@/components/ColumnVisibilityPopover.vue'

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
  (e: 'pass-partial', result: BulkPassResult): void
  /** 用户点取消 */
  (e: 'cancel'): void
}>()

const dlg = useDialogSize({ desktopWidth: 640 })
const bulk = useBulkPassInspection()

// 2026-08-27 Task 8：列顺序拖动 + 可见性。
// 「同时过检」/「数量」列不进 defs（el-input-number + v-model + 条件勾选不便走 cellRender）。
const tableRef = ref()
const columnDefs: ColumnDef[] = [
  {
    key: 'serial_no', label: '序列号', prop: 'serial_no', minWidth: 100, align: 'center',
    // 2026-08-27 修正：原生元素 children 不能传函数（Vue 3 会当 slots 处理 → 渲染为空），改为直接传值。
    cellRender: ({ row }) => h('span',
      { class: { muted: !(row as DeliveryNoteLineItem).serial_no } },
      (row as DeliveryNoteLineItem).serial_no || '—'),
  },
  { key: 'drawing_no', label: '图号', prop: 'drawing_no', minWidth: 100, align: 'center' },
  { key: 'name', label: '名称', prop: 'name', minWidth: 110, showOverflowTooltip: true },
  { key: 'quantity', label: '数量', prop: 'quantity', width: 80, align: 'right' },
  {
    key: 'status', label: '当前状态', minWidth: 120, align: 'center',
    cellRender: ({ row }) => h(ElTag, { type: 'warning', effect: 'light', size: 'small' },
      () => (row as DeliveryNoteLineItem).status),
  },
]
const columnVisibility = useColumnVisibility(columnDefs, { listKey: 'batch_inspection_confirm' })
const drag = useColumnDrag(columnDefs, { listKey: 'batch_inspection_confirm' })

// 2026-08-28 改造：传 el-table 实例 ref，composable 内部解析表头 + MutationObserver 自愈
drag.applyDrag(tableRef)

// noteId 截断展示（雪花 ID 很长）
const noteShortId = computed(() =>
  props.noteId.length > 8 ? `${props.noteId.slice(0, 8)}…` : props.noteId,
)

// DeliveryNoteLineItem[] → BulkPassItem[]
// 2026-08-28 路线 B 改造：仅含 batch_id + quantity + label，移除 part_id
// （后端 service 按 batch_id 反查 t_part_batch.part_id）。
// DeliveryNoteLineItem.id 才是 batch_id（行身份，2026-07-29 批次化）。
// 2026-08-29：透传 li.version（caller OCC 锚 t_part_batch，来自后端 line_items[].version）。
const items = computed(() =>
  props.uninspectedItems.map((li) => ({
    batch_id: li.id,
    version: li.version,
    quantity: li.quantity,
    label: `${li.serial_no ?? li.drawing_no} · ${li.name}`,
  })),
)

// 「一键通过品检」可用条件：列表非空。
// batch_id 由 DeliveryNoteLineItem.id 必填保证，不再校验 part_id。
const canBulkPass = computed(
  () => props.uninspectedItems.length > 0,
)

const disabledTooltip = computed(() =>
  canBulkPass.value ? '' : '列表为空',
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
    :width="dlg.width"
    :top="dlg.top"
    :fullscreen="dlg.fullscreen"
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
    <!-- 2026-08-27 Task 8：列设置工具条 -->
    <div class="table-toolbar">
      <ColumnVisibilityPopover
        :defs="columnDefs"
        :model-value="columnVisibility.currentMap"
        @update:model-value="columnVisibility.update"
        @reset="columnVisibility.showAll"
        @reset-order="drag.reset"
      />
    </div>
    <el-table
      ref="tableRef"
      :data="uninspectedItems"
      stripe
      border
      max-height="380"
      empty-text="无未送检件"
      class="batch-table"
    >
      <template v-for="d in drag.orderedDefs.value" :key="columnIdentifier(d)">
        <el-table-column
          v-if="columnVisibility.isVisible(d.key)"
          :prop="d.prop ?? d.key"
          :label="d.label"
          :width="d.width"
          :min-width="d.minWidth"
          :align="d.align"
          :show-overflow-tooltip="d.showOverflowTooltip"
          :column-key="d.columnKey ?? d.key"
          :label-class-name="drag.dragLabelClass(d)"
        >
          <template v-if="d.cellRender" #default="scope">
            <component :is="d.cellRender(scope)" />
          </template>
          <template v-if="resolveDraggable(d) && !d.type && !d.fixed" #header>
            <span>{{ d.label }}</span>
            <ColumnDragHandle :title="`拖动 ${d.label} 列`" />
          </template>
        </el-table-column>
      </template>
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

/* 2026-08-27 Task 8：列设置工具条 */
.table-toolbar {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 8px;
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
