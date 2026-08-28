<!--
  DeliveryDraftCard.vue

  2026-08-25 T11 从 DeliveryNoteScan.vue 抽出：单张草稿卡片（el-card）+ body el-table + footer 4 按钮。

  设计要点：
  - 纯受控展示：所有数据 / loading 态由 props 传入；所有 user action 通过 emit 回给 shell。
  - el-table 实例 ref 在本组件内部声明（避免 T9 教训「template ref on readonly prop 静默失败」）。
    通过 emit('set-table-ref', el) 把实例回传给 shell → useDeliveryDraftBoard.setTableRef。
  - props.rows 是 shell 调 board.foldedRows(noteId) 拿到的 MergedDraftRow[] 引用；
    board 内部按 noteId 缓存 computed，确保引用稳定（避免 EP 自动 clearSelection 误清勾选）。

  props:
    draft             — 当前草稿 header（ScanNoteSummary）
    rows              — foldBySerial 后的行（el-table 数据源）
    selectedRows      — 当前勾选行（由 board.selectedByNote[noteId] 透传）
    selectionCount    — 当前勾选行数（用于打印标签按钮文案 "(n)"）
    printing          — 打印标签 loading 态
    deleting          — 删除草稿 loading 态
    submitting        — 提交草稿 loading 态
    canPrint          — 「打印送货单」按钮可用（角色 + ≥1 零件）
    canSubmit         — 「提交草稿」按钮可用（status === 'DRAFT'）
    rowClassName      — 行 className 函数（绿底渲染已打印行）

  emits:
    goto-detail         — 点 header 跳转详情
    selection-change    — el-table 勾选变化
    remove              — 移除某行
    print-labels        — 打印标签
    print-note          — 打开打印送货单预览
    delete-draft        — 删除草稿
    submit-draft        — 提交草稿
    set-table-ref       — el-table 实例注册 / 反注册
-->
<script setup lang="ts">
import { h, ref } from 'vue'
import { Delete, Printer } from '@element-plus/icons-vue'
import type { MergedDraftRow } from '../composables/useDeliveryDraftBoard'
import type { ScanNoteSummary } from '@/types/deliveryNote'
import {
  resolveDraggable,
  useColumnVisibility,
  type ColumnDef,
} from '@/composables/useColumnVisibility'
import { columnIdentifier, useColumnDrag } from '@/composables/useColumnDrag'
import ColumnDragHandle from '@/components/ColumnDragHandle.vue'
import ColumnVisibilityPopover from '@/components/ColumnVisibilityPopover.vue'

defineProps<{
  draft: ScanNoteSummary
  rows: MergedDraftRow[]
  selectedRows: MergedDraftRow[]
  selectionCount: number
  printing: boolean
  deleting: boolean
  submitting: boolean
  canPrint: boolean
  canSubmit: boolean
  rowClassName: (info: { row: MergedDraftRow }) => string
}>()

const emit = defineEmits<{
  (e: 'goto-detail'): void
  (e: 'selection-change', rows: MergedDraftRow[]): void
  (e: 'remove', row: MergedDraftRow): void
  (e: 'print-labels'): void
  (e: 'print-note'): void
  (e: 'delete-draft'): void
  (e: 'submit-draft'): void
  (e: 'set-table-ref', el: any): void
}>()

// el-table 实例本地声明；emit 上传给 shell（board.setTableRef 内部 Map 管理）。
// T9 教训：template ref 不能写到 readonly prop 上（Vue 静默失败）。
const tableEl = ref<any>(null)

function handleTableRef(el: any): void {
  tableEl.value = el
  emit('set-table-ref', el)
}

// 2026-08-27 Task 8：列顺序拖动 + 可见性。
// 2026-08-27 修正：原生元素 children 不能传函数（Vue 3 会当 slots 处理 → 渲染为空），改为直接传值。
const columnDefs: ColumnDef[] = [
  {
    key: 'serial_no', label: '序列号', prop: 'serial_no', minWidth: 100,
    // 2026-08-27 修正：原生元素 children 不能传函数（Vue 3 会当 slots 处理 → 渲染为空），改为直接传值。
    cellRender: ({ row }) => h('span',
      { class: { muted: !(row as MergedDraftRow).serial_no } },
      (row as MergedDraftRow).serial_no || '—'),
  },
  { key: 'name', label: '名称', prop: 'name', minWidth: 110, showOverflowTooltip: true },
  { key: 'quantity', label: '数量', prop: 'quantity', width: 60, align: 'right' },
  {
    key: 'system_delivery_date', label: '系统交期', width: 90, align: 'center',
    cellRender: ({ row }) => h('span', null,
      (row as MergedDraftRow).system_delivery_date || '—'),
  },
]
const columnVisibility = useColumnVisibility(columnDefs, { listKey: 'delivery_draft_card' })
const drag = useColumnDrag(columnDefs, { listKey: 'delivery_draft_card' })

// 2026-08-28 改造：传 el-table 实例 ref，composable 内部解析表头 + MutationObserver 自愈
drag.applyDrag(tableEl)
</script>

<template>
  <el-card shadow="hover" class="draft-card">
    <template #header>
      <div class="draft-card-head" @click="emit('goto-detail')">
        <span class="draft-no draft-no-link">{{ draft.delivery_note_no }}</span>
        <el-tag size="small" type="info" effect="plain">
          {{ draft.scope_label }}
        </el-tag>
      </div>
    </template>
    <div class="draft-card-body">
      <div class="draft-customer">{{ draft.customer_path || '—' }}</div>
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
        :ref="handleTableRef"
        :data="rows"
        :row-key="(row: MergedDraftRow) => row.batch_ids[0]"
        :row-class-name="rowClassName"
        height="240"
        size="small"
        empty-text="暂无加入批次 — 扫码加入"
        @selection-change="(rs: MergedDraftRow[]) => emit('selection-change', rs)"
      >
        <!-- selection 勾选列不进 defs（fixed 列不可拖） -->
        <el-table-column type="selection" width="44" fixed />
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
        <!-- 操作列（每行一个移除按钮）不进 defs -->
        <el-table-column label="" width="56" align="center">
          <template #default="{ row }">
            <el-button
              link
              size="small"
              type="danger"
              @click="emit('remove', row as MergedDraftRow)"
            >
              移除
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>
    <template #footer>
      <!-- 4 按钮等宽：删除草稿 / 打印送货单 / 打印标签 / 提交草稿 -->
      <div class="draft-card-footer">
        <el-button
          type="danger"
          plain
          class="footer-btn"
          :loading="deleting"
          @click="emit('delete-draft')"
        >
          <el-icon><Delete /></el-icon>
          删除草稿
        </el-button>
        <el-button
          type="success"
          plain
          class="footer-btn"
          :disabled="!canPrint"
          @click="emit('print-note')"
        >
          <el-icon><Printer /></el-icon>
          打印送货单
        </el-button>
        <el-button
          type="success"
          plain
          class="footer-btn"
          :disabled="selectionCount === 0"
          :loading="printing"
          @click="emit('print-labels')"
        >
          <el-icon><Printer /></el-icon>
          打印标签{{ selectionCount > 0 ? `（${selectionCount}）` : '' }}
        </el-button>
        <el-button
          type="primary"
          class="footer-btn"
          :disabled="!canSubmit"
          :loading="submitting"
          @click="emit('submit-draft')"
        >
          提交草稿
        </el-button>
      </div>
    </template>
  </el-card>
</template>

<style lang="scss" scoped>
.draft-card {
  flex: 0 0 calc(50% - 6px);
  box-sizing: border-box;
  min-width: 0;
}

.draft-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  cursor: pointer;
}
.draft-no {
  font-family: 'SF Mono', Menlo, Consolas, monospace;
  font-weight: 700;
  font-size: 15px;
  color: var(--text-primary, #303133);
}
.draft-no-link {
  text-decoration: underline;
  text-decoration-color: transparent;
  transition: text-decoration-color 120ms ease;
}
.draft-card-head:hover .draft-no-link {
  text-decoration-color: var(--el-color-primary);
}
.draft-customer {
  font-size: 13px;
  color: var(--el-text-color-regular);
  margin-bottom: 8px;
}
.draft-card-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

/* 2026-08-27 Task 8：列设置工具条 */
.table-toolbar {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 4px;
}

/* footer：4 按钮等宽 */
.draft-card-footer {
  display: flex;
  gap: 8px;
}
.footer-btn {
  flex: 1;
}
:deep(.footer-btn .el-button__inner) {
  justify-content: center;
}

.muted {
  color: var(--el-text-color-secondary);
}
</style>
