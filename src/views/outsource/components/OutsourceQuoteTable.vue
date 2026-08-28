<!--
  OutsourceQuoteTable.vue — 报价一览 el-table 子组件（2026-08-25 T13 从 OutsourceQuoteList.vue 抽出）

  本组件 = 纯受控 el-table + 列头 popover（statuses / customer）。
  - 业务状态由 useOutsourceQuoteTable() 持有（search / popover / 排序 / 列可见性 / 行类名）
  - 父组件通过 :ctx prop 传入 useOutsourceQuoteTable 实例
  - 行点击 → emit('row-click', row)；操作列按钮 → emit('action', { type, row })
    （避免子组件直接 import useOutsourceQuoteForm 业务函数）
  - 列头 popover（statuses / customer）状态由 useOutsourceQuoteTable 持有 → 子组件只调 sync*/confirm*/reset*
  - 不持有：dialog state（由父组件 / useOutsourceQuoteForm 持有）
-->
<template>
  <div class="quote-table-wrap">
    <div class="table-toolbar">
      <ColumnVisibilityPopover
        :defs="quoteColumnDefs"
        :model-value="columnVisibility.currentMap"
        @update:model-value="columnVisibility.update"
        @reset="columnVisibility.showAll"
        @reset-order="drag.reset"
      />
    </div>
    <PagedTable ref="pagedRef" :fetcher="fetcher" :default-page-size="20">
      <template #default="{ items, loading }">
        <el-table
          ref="tableRef"
          :data="items"
          v-loading="loading"
          row-key="id"
          :empty-text="emptyText"
          stripe
          border
          size="small"
          :default-sort="defaultSort"
          :row-class-name="quoteRowClassName"
          @sort-change="onSortChange"
          @row-click="onRowClick"
        >
          <template #empty>
            <el-empty :description="emptyText" />
          </template>

          <!--
            2026-08-27 T16：列顺序拖动接入。
            OutsourceQuoteTable 是被多个 shell 复用的子组件，drag listKey 用 `outsource_quote_table`（独立）
            与 composable 内的 visibility listKey `outsource_quote_list` 区分开，避免与父视图持久化冲突。
            「状态」/「客户」两列带列头 popover，从 v-for 中剔除（保留 popover header 不能与简单 handle 模板共存），
            改为字面量 <el-table-column>，拖动仅作用于其他数据列。
            fixed="right" 操作列保留为字面量 <el-table-column>。
            2026-08-28 改造：drag.applyDrag(tableRef) 传 el-table 实例 ref 即可，无需解析 headerRow。
          -->
          <template v-for="d in drag.orderedDefs.value" :key="columnIdentifier(d)">
            <el-table-column
              v-if="columnVisibility.isVisible(d.key)"
              :prop="d.prop ?? d.key"
              :label="d.label"
              :width="d.width"
              :min-width="d.minWidth"
              :sortable="d.sortable"
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

          <!-- 状态列（带列头 popover 过滤；不可拖；保留原模板） -->
          <el-table-column
            v-if="columnVisibility.isVisible('status')"
            label="状态"
            min-width="110"
            align="center"
            column-key="status"
          >
            <template #header>
              <span class="header-cell">
                <span>状态</span>
                <el-popover
                  :width="220"
                  placement="bottom-start"
                  trigger="click"
                  :show-arrow="false"
                  v-model:visible="statusPopoverVisible"
                  @show="syncStatusDraft"
                >
                  <template #reference>
                    <el-icon
                      class="filter-icon"
                      :class="{ active: statusFilterActive }"
                    >
                      <Filter />
                    </el-icon>
                  </template>
                  <div style="margin-bottom: 6px; color: var(--text-secondary); font-size: 12px">
                    多选状态（提交确认后生效）
                  </div>
                  <el-checkbox-group v-model="statusDraft">
                    <el-checkbox
                      v-for="opt in statusOptions"
                      :key="opt.value"
                      :value="opt.value"
                      :label="opt.label"
                    />
                  </el-checkbox-group>
                  <div class="filter-actions">
                    <el-button size="small" link @click="resetStatusDraft">重置</el-button>
                    <el-button
                      size="small"
                      type="primary"
                      @click="confirmStatusFilter"
                    >确定</el-button>
                  </div>
                </el-popover>
              </span>
            </template>
            <template #default="{ row }">
              <el-tag
                :type="(statusTagType((row as OutsourceQuote).status) || 'info') as 'info' | 'success' | 'warning' | 'danger'"
                size="small"
                effect="plain"
              >
                {{ statusLabel((row as OutsourceQuote).status) }}
              </el-tag>
            </template>
          </el-table-column>

          <!-- 客户列（带列头 popover 过滤 L1 客户；不可拖；保留原模板） -->
          <el-table-column
            v-if="columnVisibility.isVisible('customer')"
            label="客户"
            min-width="180"
            show-overflow-tooltip
            align="center"
            column-key="customer"
          >
            <template #header>
              <span class="header-cell">
                <span>客户</span>
                <el-popover
                  :width="280"
                  placement="bottom-start"
                  trigger="click"
                  :show-arrow="false"
                  v-model:visible="customerPopoverVisible"
                  @show="syncCustomerDraft"
                >
                  <template #reference>
                    <el-icon
                      class="filter-icon"
                      :class="{ active: customerFilterActive }"
                    >
                      <Filter />
                    </el-icon>
                  </template>
                  <div style="margin-bottom: 6px; color: var(--text-secondary); font-size: 12px">
                    选一级客户自动级联其下二级客户
                  </div>
                  <el-tree-select
                    v-model="customerDraft"
                    :data="customerTree"
                    node-key="id"
                    :props="{ label: 'name', children: 'children' }"
                    check-strictly
                    clearable
                    filterable
                    placeholder="选择客户"
                    :teleported="false"
                    style="width: 100%"
                    @clear="customerDraft = null"
                  />
                  <div class="filter-actions">
                    <el-button size="small" link @click="resetCustomerDraft">重置</el-button>
                    <el-button
                      size="small"
                      type="primary"
                      @click="confirmCustomerFilter"
                    >确定</el-button>
                  </div>
                </el-popover>
              </span>
            </template>
            <template #default="{ row }">
              <span v-if="(row as OutsourceQuote).customer_path">{{ (row as OutsourceQuote).customer_path }}</span>
              <span v-else class="muted">—</span>
            </template>
          </el-table-column>

          <!-- 操作列（始终可见；不放进 defs） -->
          <el-table-column label="操作" :min-width="actionColumnWidth" fixed="right" align="center">
            <template #default="{ row }">
              <el-button
                v-if="canEdit(row as OutsourceQuote, roleMap)"
                size="small"
                @click.stop="$emit('action', { type: 'submit', row: row as OutsourceQuote })"
              >提交审核</el-button>
              <el-button
                v-if="canApprove(row as OutsourceQuote, roleMap)"
                size="small"
                type="success"
                @click.stop="$emit('action', { type: 'approve', row: row as OutsourceQuote })"
              >通过</el-button>
              <el-button
                v-if="canReject(row as OutsourceQuote, roleMap)"
                size="small"
                type="danger"
                @click.stop="$emit('action', { type: 'reject', row: row as OutsourceQuote })"
              >拒绝</el-button>
              <el-button
                v-if="canSoftDelete(row as OutsourceQuote, roleMap)"
                size="small"
                type="danger"
                @click.stop="$emit('action', { type: 'delete', row: row as OutsourceQuote })"
              >删除</el-button>
            </template>
          </el-table-column>
        </el-table>
      </template>
    </PagedTable>
  </div>
</template>

<script setup lang="ts">
// views/outsource/components/OutsourceQuoteTable.vue
//
// 2026-08-25 T13：从 OutsourceQuoteList.vue 抽出：纯 el-table + 列头 popover。
// 业务状态（search / 排序 / 列可见性 / popover 状态 / 行类名）由 ctx.table（useOutsourceQuoteTable）持有。
// 操作列通过 emit('action', { type, row }) 上抛给 shell，由 shell 路由到 useOutsourceQuoteForm
// 的 submit / approve / reject / delete handler。
// 行点击 → emit('row-click', row) 用于图纸预览；图号链接点击 → emit('preview-drawing', row)。

import { h, ref } from 'vue'
import { Filter } from '@element-plus/icons-vue'
import { ElLink } from 'element-plus'
import ColumnVisibilityPopover from '@/components/ColumnVisibilityPopover.vue'
import ColumnDragHandle from '@/components/ColumnDragHandle.vue'
import PagedTable from '@/components/PagedTable.vue'
import {
  resolveDraggable,
  type ColumnDef,
} from '@/composables/useColumnVisibility'
import { useColumnDrag, columnIdentifier } from '@/composables/useColumnDrag'
import {
  OUTSOURCE_QUOTE_STATUS_LABEL,
  OUTSOURCE_QUOTE_STATUS_TAG,
  type OutsourceQuote,
  type OutsourceQuoteStatus,
} from '@/types/outsource'
import {
  canApprove,
  canEdit,
  canReject,
  canSoftDelete,
  rolesArrayToMap,
} from '@/utils/outsourceQuotePermissions'
import {
  STATUS_OPTIONS,
  QUOTE_COLUMN_DEFS,
} from '../composables/useOutsourceQuoteTable'
import type { useCustomerTree } from '@/composables/useCustomerTree'
import type { ComputedRef } from 'vue'

/** 视图 ctx：caller 注入的 composable 集合 */
export interface OutsourceQuoteTableCtx {
  table: ReturnType<typeof import('../composables/useOutsourceQuoteTable').useOutsourceQuoteTable>
  /** user.roles（用于 canEdit / canApprove / etc 权限判断） */
  roleMap: ComputedRef<ReturnType<typeof rolesArrayToMap>> | ReturnType<typeof rolesArrayToMap>
  /** 客户级联树（列头客户 popover 用） */
  customerTree: ReturnType<typeof useCustomerTree>['tree'] | ReturnType<typeof useCustomerTree>['tree']['value']
}

const props = defineProps<{
  ctx: OutsourceQuoteTableCtx
}>()

const emit = defineEmits<{
  (e: 'row-click', row: OutsourceQuote): void
  (e: 'preview-drawing', row: OutsourceQuote): void
  (e: 'action', payload: { type: 'submit' | 'approve' | 'reject' | 'delete'; row: OutsourceQuote }): void
}>()

// ============ 解构 ctx 到顶层（模板自动解包）============
const {
  pagedRef,
  fetcher,
  defaultSort,
  emptyText,
  columnVisibility,
  actionColumnWidth,
  onSortChange,
  quoteRowClassName,
  // 列头 popover（status / customer）
  statusFilterActive,
  statusPopoverVisible,
  statusDraft,
  customerFilterActive,
  customerPopoverVisible,
  customerDraft,
  syncStatusDraft,
  resetStatusDraft,
  confirmStatusFilter,
  syncCustomerDraft,
  resetCustomerDraft,
  confirmCustomerFilter,
} = props.ctx.table

const { customerTree, roleMap } = props.ctx

// 列头 popover 的 status 选项
const statusOptions = STATUS_OPTIONS

// quoteColumnDefs 给 ColumnVisibilityPopover 用（保持「操作列不进 defs」契约；
// 「状态」/「客户」两列带列头 popover，也在此 defs 中以便开关显隐，但不走 v-for 拖动）。
const quoteColumnDefs = QUOTE_COLUMN_DEFS

// 2026-08-27 T16：列顺序拖动接入。
// 「状态」/「客户」两列带列头 popover，不能套通用 drag-handle 模板 → 改 literal <el-table-column>。
// drag 的 defs 从 QUOTE_COLUMN_DEFS 里滤掉这两列后，再补回 prop / width / sortable / showOverflowTooltip / align 等元数据
// （v-for 模板需要这些字段渲染 <el-table-column>）。
// drag listKey 用 `outsource_quote_table`（独立），与 composable 内的 visibility listKey `outsource_quote_list` 区分。
// 2026-08-27 修正：原生元素 children 不能传函数（Vue 3 会当 slots 处理 → 渲染为空），改为直接传值。
function renderDrawingNoCell({ row }: { row: unknown }): ReturnType<typeof h> {
  const r = row as OutsourceQuote
  if (!r.part_drawing_no) {
    return h('span', { class: 'muted' }, '—')
  }
  return h(ElLink,
    {
      type: 'primary',
      underline: false,
      onClick: (e: MouseEvent) => {
        e.stopPropagation()
        emit('preview-drawing', r)
      },
    },
    () => r.part_drawing_no)
}

const draggableColumnDefs: ColumnDef[] = [
  { key: 'part_serial_no', label: '序列号', prop: 'part_serial_no',
    minWidth: 100, sortable: 'custom', showOverflowTooltip: true, align: 'center' },
  { key: 'part_drawing_no', label: '图号', prop: 'part_drawing_no',
    minWidth: 120, sortable: 'custom', showOverflowTooltip: true, align: 'center',
    cellRender: renderDrawingNoCell },
  { key: 'part_name', label: '名称', prop: 'part_name',
    minWidth: 180, sortable: 'custom', showOverflowTooltip: true, align: 'center' },
  { key: 'outsource_company_name', label: '外协公司', prop: 'outsource_company_name',
    minWidth: 160, sortable: 'custom', showOverflowTooltip: true, align: 'center' },
  { key: 'process_code', label: '工序', prop: 'process_code',
    minWidth: 100, sortable: 'custom', align: 'center' },
  { key: 'price', label: '外协报价(元)', prop: 'price',
    minWidth: 110, align: 'right', sortable: 'custom' },
  { key: 'part_unit_price', label: '订单单价(元)', prop: 'part_unit_price',
    minWidth: 110, align: 'right', sortable: 'custom',
    cellRender: ({ row }) => {
      const r = row as OutsourceQuote
      return h('span', { class: { muted: !r.part_unit_price } }, r.part_unit_price ?? '—')
    } },
]
const drag = useColumnDrag(draggableColumnDefs, { listKey: 'outsource_quote_table' })

function statusLabel(s: OutsourceQuoteStatus): string {
  return OUTSOURCE_QUOTE_STATUS_LABEL[s] ?? s
}
function statusTagType(
  s: OutsourceQuoteStatus,
): 'info' | 'success' | 'warning' | 'danger' | '' {
  return OUTSOURCE_QUOTE_STATUS_TAG[s] ?? 'info'
}

function onRowClick(row: unknown): void {
  emit('row-click', row as OutsourceQuote)
}

const tableRef = ref()
// 2026-08-28 改造：传 el-table 实例 ref，composable 内部解析表头 + MutationObserver 自愈
drag.applyDrag(tableRef)
</script>

<style lang="scss" scoped>
.quote-table-wrap {
  background: #fff;
}

.table-toolbar {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 8px;
}

.header-cell {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  justify-content: center;
}

.filter-icon {
  font-size: 14px;
  color: var(--text-secondary);
  cursor: pointer;
  &.active {
    color: var(--primary-color);
  }
}

.filter-actions {
  margin-top: 12px;
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
  border-top: 1px solid var(--border-color-lighter);
  padding-top: 8px;
}

.muted {
  color: var(--text-secondary);
}

// 行点击 cursor（与原 OutsourceQuoteList 同款）
:deep(.el-table__row.quote-row-clickable) {
  cursor: pointer;
}

// 加急行红底（与 PartsList / 看板同款）
:deep(.el-table__row.row-urgent) > td.el-table__cell {
  background-color: #fde2e2 !important;
}
:deep(.el-table__row.row-urgent:hover > td.el-table__cell) {
  background-color: #fbcaca !important;
}
</style>