<!--
  PartsList.vue

  2026-08-22 重构：拆分壳。背景与组装工作（query / filters / edit / batch /
  print / dispatch / 列可见性）下沉到 views/parts/composables/ 下的 6 个 composable；
  表格 / 批量栏 / 两个下发对话框拆到 components/ 下 4 个子组件。本文件只保留：

  - 顶部 filter-card（行类型 + 重置 + 操作按钮组）；
  - PartsTable（承载全部表格逻辑）；
  - PartsBatchBar（批量操作栏）；
  - 隐藏 iframe（批量打印预览，必须留在壳内以便 onMounted 同步 ctx.print.iframeRef）；
  - el-pagination；
  - PartsDispatchDialog / PartsBatchDispatchDialog；
  - PurchaseOrderImportDialog（采购订单 Excel 导入）。

  2026-08-22 同步移除所有手机适配：
  - 删除 ResponsiveList 卡片视图；
  - 删除 el-drawer 手机筛选抽屉；
  - 删除 isMobile / paginationLayout / locationText / anyFilterActive /
    openMobileFilter / confirmMobileFilter / resetMobileFilter /
    syncStatusDraft / syncNextProcessDraft / syncLocationDraft 等移动端相关代码与样式；
  - 原 @include until(sm) 全部清除。
-->
<template>
  <div class="parts-list">
    <el-card shadow="never" class="filter-card">
      <div class="filter-row">
        <!-- 行类型 + 重置（2026-08-20 保留在顶部 filter-card） -->
        <div class="filter-group filter-group--rowtype">
          <el-select
            v-model="search.rowType"
            placeholder="类型"
            style="width: 140px"
            @change="onRowTypeChange"
          >
            <el-option label="全部" value="ALL" />
            <el-option label="仅零件" value="PART" />
            <el-option label="仅装配件" value="ASSEMBLY" />
          </el-select>

          <el-button @click="onReset">
            <el-icon><RefreshLeft /></el-icon>
            <span>重置</span>
          </el-button>
        </div>

        <!-- 操作组 -->
        <div class="filter-group filter-group--actions">
          <!-- INSPECTOR 看不到导入按钮（PR-I 2026-07-20）；
               2026-08-05：CNC 与 INSPECTOR 同样对待（看不到导入/批量/下发） -->
          <el-button
            v-if="canEdit"
            @click="router.push('/parts/new?tab=pdf')"
          >
            <el-icon><Document /></el-icon>
            <span>从 PDF/Excel 批量导入</span>
          </el-button>

          <!-- 2026-08-12：采购订单 Excel 导入（解析系统交期和订单号；同 canEdit 闸门） -->
          <el-button
            v-if="canEdit"
            @click="orderImportVisible = true"
          >
            <el-icon><Upload /></el-icon>
            <span>解析系统交期和订单号</span>
          </el-button>

          <!-- 批量打印 / 批量下发 toggle（2026-07-17 打印；2026-07-22 下发；INSPECTOR 不可见） -->
          <template v-if="canEdit">
            <template v-if="!batchMode">
              <el-button type="success" plain @click="onEnterBatchMode">
                <el-icon><Printer /></el-icon>
                <span>批量打印图纸</span>
              </el-button>
              <el-button type="primary" plain @click="onEnterBatchDispatchMode">
                <el-icon><Promotion /></el-icon>
                <span>批量下发</span>
              </el-button>
            </template>
            <el-button v-else type="warning" @click="onExitBatchMode">
              <el-icon><Close /></el-icon>
              <span>退出批量模式</span>
            </el-button>
          </template>

          <el-tag v-if="isCncProgrammer" type="warning" effect="plain" size="small">
            编程员视图：默认查看「编程中」零件
          </el-tag>
          <span v-if="total > 0" class="total-hint">共 {{ total }} 条</span>
        </div>
      </div>
    </el-card>

    <PartsTable ref="partsTableRef" :ctx="ctx" />

    <PartsBatchBar v-if="batchMode" :ctx="ctx" />

    <!-- 隐藏 iframe：批量打印用（仿 FileListCard.vue 的 print 实现）。
         必须留在壳内：onMounted 时同步赋值给 ctx.print.iframeRef，确保 onBatchPrint
         触发时 iframe 已挂载。 -->
    <iframe
      ref="iframeRef"
      style="position: fixed; right: 0; bottom: 0; width: 1px; height: 1px; border: 0; opacity: 0; pointer-events: none;"
      title="批量打印预览"
    />

    <div class="pagination">
      <el-pagination
        v-model:current-page="page"
        v-model:page-size="pageSize"
        :page-sizes="[10, 20, 50, 100]"
        :total="total"
        layout="total, sizes, prev, pager, next, jumper"
        :pager-count="7"
        background
        size="small"
        @current-change="fetchList"
        @size-change="onPageSizeChange"
      />
    </div>

    <PartsDispatchDialog :ctx="ctx" />
    <PartsBatchDispatchDialog :ctx="ctx" />

    <!-- 2026-08-12：采购订单 Excel 导入对话框（解析系统交期和订单号） -->
    <PurchaseOrderImportDialog
      v-model="orderImportVisible"
      @success="fetchList"
    />
  </div>
</template>

<script setup lang="ts">
// views/parts/PartsList.vue
//
// 2026-08-22 重构壳：仅保留 filter-card / PartsTable / PartsBatchBar / iframe /
// 分页 / 两个下发 dialog / 采购单导入 dialog；其余全部下沉到 composables/。
// 移除所有手机适配代码（ResponsiveList 卡片视图、el-drawer 移动筛选抽屉等）。

import { h, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  ElAutocomplete,
  ElCheckbox,
  ElDatePicker,
  ElIcon,
  ElInput,
  ElInputNumber,
  ElSwitch,
  ElTag,
  ElTreeSelect,
} from 'element-plus'
import { useRoute, useRouter, RouterLink } from 'vue-router'
import {
  Close,
  Document,
  Printer,
  Promotion,
  RefreshLeft,
  Search,
  Upload,
} from '@element-plus/icons-vue'
import PartsTable from './components/PartsTable.vue'
import PartsBatchBar from './components/PartsBatchBar.vue'
import PartsDispatchDialog from './components/PartsDispatchDialog.vue'
import PartsBatchDispatchDialog from './components/PartsBatchDispatchDialog.vue'
import PurchaseOrderImportDialog from './components/PurchaseOrderImportDialog.vue'
import { useAuthSession } from '@/composables/useAuthSession'
import { useBarcodeScanner } from '@/composables/useBarcodeScanner'
import {
  useColumnVisibility,
  type ColumnDef,
} from '@/composables/useColumnVisibility'
import {
  initialPartsSearch,
  usePartsListQuery,
} from './composables/usePartsListQuery'
import { usePartsColumnFilters } from './composables/usePartsColumnFilters'
import { usePartInlineEdit } from './composables/usePartInlineEdit'
import { usePartBatchSelection } from './composables/usePartBatchSelection'
import { useBatchPrint } from './composables/useBatchPrint'
import { usePartDispatch } from './composables/usePartDispatch'
import ColumnFilterPopover from '@/components/ColumnFilterPopover.vue'
import {
  ORDER_STATUS_LABEL,
  ORDER_STATUS_TAG_TYPE,
  PART_SORT_KEY_TO_PROP,
} from '@/types/parts'
import type { PartListItem } from '@/types/parts'
import type { PartsListCtx } from './composables/partsListCtx'

// ============ 角色 & 默认筛选 ============
const { hasRole } = useAuthSession()
const isCncProgrammer = hasRole('CNC_PROGRAMMER')
// PR-I 2026-07-20：INSPECTOR 看不到导入 / 批量打印 / 下发按钮
// 行内编辑权限：与后端 POST /parts/{id}/update 一致（MANAGER / CLERK）
const canEdit = hasRole('MANAGER') || hasRole('CLERK')

const route = useRoute()
const router = useRouter()

// ============ 列可见性 + 列顺序拖动 defs（2026-08-27 Task 6 升级）============
// 「操作」和 batch 模式下的「selection」列不放进 defs → 始终可见。
// columnDefs 在 composables 全部建好之后声明，cellRender / headerRender 工厂里
// 才能拿到 filters / edit 等响应式 ref。
const query = usePartsListQuery({ isCncProgrammer })
const partsTableRef = ref<InstanceType<typeof PartsTable> | null>(null)
const getTable = () => partsTableRef.value?.tableRef ?? null

const filters = usePartsColumnFilters({
  search: query.search,
  onSearch: query.onSearch,
  snapshot: query.snapshotPersist,
})

const batch = usePartBatchSelection({ items: query.items, getTable })

query.registerBeforeSearch(() => {
  if (batch.batchMode.value) batch.clearAllSelection()
})
query.registerAfterFetch(() => {
  if (batch.batchMode.value) batch.restoreTableSelection()
})

const print = useBatchPrint({
  selectedIds: batch.selectedIds,
  selectedRowTypes: batch.selectedRowTypes,
})

const dispatch = usePartDispatch({
  fetchList: query.fetchList,
  selectedIds: batch.selectedIds,
  selectedRows: batch.selectedRows,
  selectedRowTypes: batch.selectedRowTypes,
  getTable,
})

const edit = usePartInlineEdit({
  items: query.items,
  fetchList: query.fetchList,
  customerTree: filters.customerTree,
  canEdit,
  isBatchMode: () => batch.batchMode.value,
})

// F2 fix（2026-08-27 Task 6 review）：unit_price / total_price 列从 columnDefs
// 条件性包含，非 canEdit 用户（INSPECTOR）整列隐藏 — 恢复原 v-if canEdit gate 行为。
// 18 列拆 base（前 9 列）+ price（10-11 列，仅 canEdit）+ tail（后 7 列），
// 条件性 spread 保持原默认顺序；useColumnVisibility / useColumnDrag 在 setup 期
// 一次性拿到 snapshot，canEdit 是 setup 期静态布尔，不会变。
const baseColumnDefs: ColumnDef[] = [
  // 1. 序列号（popover + 普通 cell；fixed='left' → 默认不可拖）
  {
    key: 'serial_no',
    label: '序列号',
    columnKey: 'serial_no',
    prop: 'serial_no',
    minWidth: 110,
    fixed: 'left',
    sortable: 'custom',
    showOverflowTooltip: true,
    align: 'center',
    headerRender: () => h(ColumnFilterPopover, {
      label: '序列号',
      active: filters.serialNoFilter.active.value,
      visible: filters.serialNoFilter.visible.value,
      'onUpdate:visible': (v: boolean) => { filters.serialNoFilter.visible.value = v },
      onShow: filters.serialNoFilter.sync,
      onConfirm: filters.serialNoFilter.confirm,
      onReset: filters.serialNoFilter.reset,
    }, {
      default: () => h(ElInput, {
        modelValue: filters.serialNoFilter.draft.value,
        'onUpdate:modelValue': (v: string) => { filters.serialNoFilter.draft.value = v },
        placeholder: '序列号（ILIKE 子串）',
        clearable: true,
        size: 'small',
        class: filters.serialNoFlash.value ? 'scan-flash' : '',
        onKeyupEnter: filters.serialNoFilter.confirm,
      }, {
        prefix: () => h(ElIcon, null, () => h(Search)),
      }),
    }),
    // 2026-08-27 修正：原生元素 children 不能传函数（Vue 3 会当 slots 处理 → 渲染为空），改为直接传值。
    cellRender: ({ row }) => {
      const r = row as PartListItem
      return h('span', { class: r.serial_no ? '' : 'muted' }, r.serial_no || '—')
    },
  },

  // 2. 订单号（popover + el-input 编辑）
  {
    key: 'order_no',
    label: '订单号',
    columnKey: 'order_no',
    prop: 'order_no',
    minWidth: 130,
    sortable: 'custom',
    showOverflowTooltip: true,
    align: 'center',
    headerRender: () => h(ColumnFilterPopover, {
      label: '订单号',
      active: filters.orderNoFilter.active.value,
      width: 280,
      hint: '订单号子串搜索；勾选「仅空白」覆盖输入',
      visible: filters.orderNoFilter.visible.value,
      'onUpdate:visible': (v: boolean) => { filters.orderNoFilter.visible.value = v },
      onShow: filters.orderNoFilter.sync,
      onConfirm: filters.orderNoFilter.confirm,
      onReset: filters.orderNoFilter.reset,
    }, {
      default: () => h('div', { class: 'filter-input-row' }, [
        h(ElInput, {
          modelValue: filters.orderNoFilter.draft.value,
          'onUpdate:modelValue': (v: string) => { filters.orderNoFilter.draft.value = v },
          placeholder: '订单号（ILIKE 子串）',
          clearable: true,
          size: 'small',
          onKeyupEnter: filters.orderNoFilter.confirm,
        }, {
          prefix: () => h(ElIcon, null, () => h(Search)),
        }),
        h(ElCheckbox, {
          modelValue: filters.orderNoFilter.isNullDraft.value === true,
          'onUpdate:modelValue': (v: string | number | boolean) => {
            filters.orderNoFilter.isNullDraft.value = v === true ? true : undefined
          },
        }, () => '仅空白'),
      ]),
    }),
    cellRender: ({ row }) => {
      const r = row as PartListItem
      if (edit.editingId.value === r.id) {
        return h(ElInput, {
          modelValue: edit.editBuffer.order_no,
          'onUpdate:modelValue': (v: string) => { edit.editBuffer.order_no = v },
          size: 'small',
        })
      }
      return h('span', null, r.order_no || '—')
    },
  },

  // 3. 图号（popover + el-input 编辑；fixed='left'）
  {
    key: 'drawing_no',
    label: '图号',
    columnKey: 'drawing_no',
    prop: 'drawing_no',
    minWidth: 130,
    fixed: 'left',
    sortable: 'custom',
    showOverflowTooltip: true,
    align: 'center',
    headerRender: () => h(ColumnFilterPopover, {
      label: '图号',
      active: filters.drawingNoFilter.active.value,
      visible: filters.drawingNoFilter.visible.value,
      'onUpdate:visible': (v: boolean) => { filters.drawingNoFilter.visible.value = v },
      onShow: filters.drawingNoFilter.sync,
      onConfirm: filters.drawingNoFilter.confirm,
      onReset: filters.drawingNoFilter.reset,
    }, {
      default: () => h(ElInput, {
        modelValue: filters.drawingNoFilter.draft.value,
        'onUpdate:modelValue': (v: string) => { filters.drawingNoFilter.draft.value = v },
        placeholder: '图号（ILIKE 子串）',
        clearable: true,
        size: 'small',
        onKeyupEnter: filters.drawingNoFilter.confirm,
      }, {
        prefix: () => h(ElIcon, null, () => h(Search)),
      }),
    }),
    cellRender: ({ row }) => {
      const r = row as PartListItem
      if (edit.editingId.value === r.id) {
        return h(ElInput, {
          modelValue: edit.editBuffer.drawing_no,
          'onUpdate:modelValue': (v: string) => { edit.editBuffer.drawing_no = v },
          size: 'small',
        })
      }
      return h('span', null, r.drawing_no)
    },
  },

  // 4. 名称（popover + el-input 编辑 / router-link / 装配件 tag）
  {
    key: 'name',
    label: '名称',
    columnKey: 'name',
    prop: 'name',
    minWidth: 200,
    sortable: 'custom',
    showOverflowTooltip: true,
    align: 'center',
    headerRender: () => h(ColumnFilterPopover, {
      label: '名称',
      active: filters.nameFilter.active.value,
      visible: filters.nameFilter.visible.value,
      'onUpdate:visible': (v: boolean) => { filters.nameFilter.visible.value = v },
      onShow: filters.nameFilter.sync,
      onConfirm: filters.nameFilter.confirm,
      onReset: filters.nameFilter.reset,
    }, {
      default: () => h(ElInput, {
        modelValue: filters.nameFilter.draft.value,
        'onUpdate:modelValue': (v: string) => { filters.nameFilter.draft.value = v },
        placeholder: '名称（ILIKE 子串）',
        clearable: true,
        size: 'small',
        onKeyupEnter: filters.nameFilter.confirm,
      }, {
        prefix: () => h(ElIcon, null, () => h(Search)),
      }),
    }),
    cellRender: ({ row }) => {
      const r = row as PartListItem
      if (edit.editingId.value === r.id) {
        return h(ElInput, {
          modelValue: edit.editBuffer.name,
          'onUpdate:modelValue': (v: string) => { edit.editBuffer.name = v },
          size: 'small',
        })
      }
      // 2026-08-27 fix（约束 #11）：EP 合成空行 { row: {} } 时 row.id 为 undefined；
      // router-link :to 会拼出 /parts/undefined → 触发 Vue Router warn。无 id 就不渲染链接。
      const isAssembly = r.row_type === 'ASSEMBLY'
      const linkPath = isAssembly ? `/assemblies/${r.id}` : `/parts/${r.id}`
      const children: ReturnType<typeof h>[] = []
      if (isAssembly) {
        children.push(h(ElTag, {
          type: 'warning',
          size: 'small',
          effect: 'plain',
          style: 'margin-right: 4px;',
        }, () => '装配件'))
      }
      if (r.id) {
        children.push(h(RouterLink, {
          to: linkPath,
          class: 'name-link',
        }, () => r.name))
      } else {
        children.push(h('span', null, r.name))
      }
      // h() 不能返回数组 — 用 fragment 包一层
      return h('span', null, children)
    },
  },

  // 5. 客户（popover + el-tree-select）
  {
    key: 'customer',
    label: '客户',
    columnKey: 'customer',
    minWidth: 180,
    showOverflowTooltip: true,
    align: 'center',
    headerRender: () => h(ColumnFilterPopover, {
      label: '客户',
      active: filters.customerFilter.active.value,
      width: 280,
      hint: '选一级客户自动级联其下二级客户',
      visible: filters.customerFilter.visible.value,
      'onUpdate:visible': (v: boolean) => { filters.customerFilter.visible.value = v },
      onShow: filters.customerFilter.sync,
      onConfirm: filters.customerFilter.confirm,
      onReset: filters.customerFilter.reset,
    }, {
      default: () => h(ElTreeSelect, {
        modelValue: filters.customerFilter.draft.value,
        'onUpdate:modelValue': (v: string | number | null) => {
          filters.customerFilter.draft.value = v != null ? String(v) : null
        },
        data: filters.customerTree.value,
        nodeKey: 'id',
        props: { label: 'name', children: 'children' },
        checkStrictly: true,
        clearable: true,
        filterable: true,
        placeholder: '选择客户',
        teleported: false,
        style: 'width: 100%',
        onClear: () => { filters.customerFilter.draft.value = null },
      }),
    }),
    cellRender: ({ row }) => {
      const r = row as PartListItem
      if (r.customer_path) return h('span', null, r.customer_path)
      if (r.customer_name) return h('span', { class: 'muted' }, r.customer_name)
      return h('span', { class: 'muted' }, '—')
    },
  },

  // 6. 申请人（el-autocomplete 编辑）
  {
    key: 'applicant',
    label: '申请人',
    columnKey: 'applicant',
    minWidth: 160,
    showOverflowTooltip: true,
    align: 'center',
    cellRender: ({ row }) => {
      const r = row as PartListItem
      if (edit.editingId.value === r.id) {
        return h(ElAutocomplete, {
          modelValue: edit.editBuffer.applicant_name,
          'onUpdate:modelValue': (v: string | number) => { edit.editBuffer.applicant_name = String(v ?? '') },
          valueKey: 'name',
          fetchSuggestions: edit.applicantSuggest,
          triggerOnFocus: true,
          debounce: 0,
          loading: edit.applicantLoading.value,
          placeholder: '选择或输入申请人姓名',
          clearable: true,
          size: 'small',
          style: 'width: 100%',
        })
      }
      return h('span', null, r.applicant_name || '—')
    },
  },

  // 7. 状态（原生 :filters + 选中计数 badge；column-key=「status」）
  {
    key: 'status',
    label: '状态',
    columnKey: 'status',
    minWidth: 140,
    align: 'center',
    filters: filters.statusNativeOptions,
    filteredValue: filters.statusFilteredValue.value,
    headerRender: () => h('span', { class: 'status-header' }, [
      '状态',
      filters.statusSelectedCount.value > 0
        ? h('span', { class: 'status-count' }, `(${filters.statusSelectedCount.value})`)
        : null,
    ]),
    cellRender: ({ row }) => {
      const r = row as PartListItem
      const children: ReturnType<typeof h>[] = [
        h(ElTag, {
          type: ORDER_STATUS_TAG_TYPE[r.status] ?? 'info',
          effect: 'plain',
          size: 'small',
        }, () => ORDER_STATUS_LABEL[r.status] ?? r.status),
      ]
      if (r.has_been_repaired) {
        children.push(h(ElTag, {
          type: 'warning',
          size: 'small',
          effect: 'dark',
          style: 'margin-left: 4px',
        }, () => '返修'))
      }
      return h('span', null, children)
    },
  },

  // 8. 数量（el-input-number 编辑）
  {
    key: 'quantity',
    label: '数量',
    columnKey: 'quantity',
    prop: 'quantity',
    minWidth: 110,
    sortable: 'custom',
    align: 'right',
    cellRender: ({ row }) => {
      const r = row as PartListItem
      if (edit.editingId.value === r.id) {
        return h(ElInputNumber, {
          modelValue: edit.editBuffer.quantity,
          'onUpdate:modelValue': (v: number | undefined) => { edit.editBuffer.quantity = v ?? 1 },
          min: 1,
          precision: 0,
          controls: false,
          size: 'small',
          style: 'width: 90px',
        })
      }
      return h('span', null, r.quantity)
    },
  },

  // 9. 已送数量（装配件行恒为 '—'）
  {
    key: 'delivered_quantity',
    label: '已送数量',
    columnKey: 'delivered_quantity',
    prop: 'delivered_quantity',
    minWidth: 100,
    align: 'right',
    cellRender: ({ row }) => {
      const r = row as PartListItem
      if (r.row_type === 'ASSEMBLY') {
        return h('span', { class: 'muted' }, '—')
      }
      return h('span', null, r.delivered_quantity ?? 0)
    },
  },
]

// 仅 canEdit 用户（MANAGER / CLERK）看到；INSPECTOR 整列隐藏 — 见 usePartInlineEdit
// 与原 PartsTable `v-if="canEdit && columnVisibility.isVisible(...)"` 行为对齐。
const priceColumnDefs: ColumnDef[] = [
  // 10. 单价（el-input-number 编辑）
  {
    key: 'unit_price',
    label: '单价',
    columnKey: 'unit_price',
    prop: 'unit_price',
    minWidth: 120,
    sortable: 'custom',
    align: 'right',
    cellRender: ({ row }) => {
      const r = row as PartListItem
      if (canEdit && edit.editingId.value === r.id) {
        return h(ElInputNumber, {
          modelValue: edit.editBuffer.unit_price,
          'onUpdate:modelValue': (v: number | undefined) => { edit.editBuffer.unit_price = v ?? 0 },
          min: 0,
          precision: 2,
          step: 0.01,
          controls: false,
          size: 'small',
          style: 'width: 100px',
        })
      }
      return h('span', null, r.unit_price)
    },
  },

  // 11. 总价（computed）
  {
    key: 'total_price',
    label: '总价',
    columnKey: 'total_price',
    prop: 'total_price',
    minWidth: 120,
    sortable: 'custom',
    align: 'right',
    cellRender: ({ row }) => {
      const r = row as PartListItem
      return h('span', null, edit.displayTotalPrice(r))
    },
  },
]

const tailColumnDefs: ColumnDef[] = [
  // 12. 请购日期（popover + el-date-picker 编辑）
  {
    key: 'request_date',
    label: '请购日期',
    columnKey: 'request_date',
    prop: 'request_date',
    minWidth: 150,
    sortable: 'custom',
    align: 'center',
    headerRender: () => h(ColumnFilterPopover, {
      label: '请购日期',
      active: filters.requestDateFilter.active.value,
      width: 280,
      visible: filters.requestDateFilter.visible.value,
      'onUpdate:visible': (v: boolean) => { filters.requestDateFilter.visible.value = v },
      onConfirm: filters.requestDateFilter.confirm,
      onReset: filters.requestDateFilter.reset,
    }, {
      default: () => h(ElDatePicker, {
        modelValue: filters.requestDateFilter.range.value,
        'onUpdate:modelValue': (v: [string, string] | null) => { filters.requestDateFilter.range.value = v },
        type: 'daterange',
        valueFormat: 'YYYY-MM-DD',
        rangeSeparator: '~',
        startPlaceholder: '起点',
        endPlaceholder: '终点',
        unlinkPanels: true,
        clearable: true,
        size: 'small',
        teleported: false,
        style: 'width: 100%',
      }),
    }),
    cellRender: ({ row }) => {
      const r = row as PartListItem
      if (edit.editingId.value === r.id) {
        return h(ElDatePicker, {
          modelValue: edit.editBuffer.request_date,
          'onUpdate:modelValue': (v: string) => { edit.editBuffer.request_date = v },
          type: 'date',
          valueFormat: 'YYYY-MM-DD',
          size: 'small',
          style: 'width: 138px',
          clearable: false,
        })
      }
      return h('span', null, r.request_date)
    },
  },

  // 13. 计划交期（popover + el-date-picker 编辑）
  {
    key: 'planned_delivery_date',
    label: '计划交期',
    columnKey: 'planned_delivery_date',
    prop: 'planned_delivery_date',
    minWidth: 150,
    sortable: 'custom',
    align: 'center',
    headerRender: () => h(ColumnFilterPopover, {
      label: '计划交期',
      active: filters.plannedDateFilter.active.value,
      width: 280,
      visible: filters.plannedDateFilter.visible.value,
      'onUpdate:visible': (v: boolean) => { filters.plannedDateFilter.visible.value = v },
      onConfirm: filters.plannedDateFilter.confirm,
      onReset: filters.plannedDateFilter.reset,
    }, {
      default: () => h(ElDatePicker, {
        modelValue: filters.plannedDateFilter.range.value,
        'onUpdate:modelValue': (v: [string, string] | null) => { filters.plannedDateFilter.range.value = v },
        type: 'daterange',
        valueFormat: 'YYYY-MM-DD',
        rangeSeparator: '~',
        startPlaceholder: '起点',
        endPlaceholder: '终点',
        unlinkPanels: true,
        clearable: true,
        size: 'small',
        teleported: false,
        style: 'width: 100%',
      }),
    }),
    cellRender: ({ row }) => {
      const r = row as PartListItem
      if (edit.editingId.value === r.id) {
        return h(ElDatePicker, {
          modelValue: edit.editBuffer.planned_delivery_date,
          'onUpdate:modelValue': (v: string) => { edit.editBuffer.planned_delivery_date = v },
          type: 'date',
          valueFormat: 'YYYY-MM-DD',
          size: 'small',
          style: 'width: 138px',
          clearable: false,
        })
      }
      return h('span', null, r.planned_delivery_date)
    },
  },

  // 14. 系统交期（popover + 「仅空白」 + el-date-picker 编辑）
  {
    key: 'system_delivery_date',
    label: '系统交期',
    columnKey: 'system_delivery_date',
    prop: 'system_delivery_date',
    minWidth: 150,
    sortable: 'custom',
    align: 'center',
    headerRender: () => h(ColumnFilterPopover, {
      label: '系统交期',
      active: filters.systemDateFilter.active.value,
      width: 300,
      hint: '区间 + 「仅空白」checkbox；勾选后区间失效',
      visible: filters.systemDateFilter.visible.value,
      'onUpdate:visible': (v: boolean) => { filters.systemDateFilter.visible.value = v },
      onShow: filters.systemDateFilter.sync,
      onConfirm: filters.systemDateFilter.confirm,
      onReset: filters.systemDateFilter.reset,
    }, {
      default: () => h('div', { class: 'filter-input-row' }, [
        h(ElDatePicker, {
          modelValue: filters.systemDateFilter.range.value,
          'onUpdate:modelValue': (v: [string, string] | null) => { filters.systemDateFilter.range.value = v },
          type: 'daterange',
          valueFormat: 'YYYY-MM-DD',
          rangeSeparator: '~',
          startPlaceholder: '起点',
          endPlaceholder: '终点',
          unlinkPanels: true,
          clearable: true,
          size: 'small',
          teleported: false,
          style: 'flex: 1',
        }),
        h(ElCheckbox, {
          modelValue: filters.systemDateFilter.isNullDraft.value === true,
          'onUpdate:modelValue': (v: string | number | boolean) => {
            filters.systemDateFilter.isNullDraft.value = v === true ? true : undefined
          },
        }, () => '仅空白'),
      ]),
    }),
    cellRender: ({ row }) => {
      const r = row as PartListItem
      if (edit.editingId.value === r.id) {
        return h(ElDatePicker, {
          modelValue: edit.editBuffer.system_delivery_date,
          'onUpdate:modelValue': (v: string | null) => { edit.editBuffer.system_delivery_date = v },
          type: 'date',
          valueFormat: 'YYYY-MM-DD',
          size: 'small',
          style: 'width: 138px',
          clearable: true,
        })
      }
      return h('span', null, r.system_delivery_date || '—')
    },
  },

  // 15. 加急（el-switch 编辑 / el-tag / '—'）
  {
    key: 'is_urgent',
    label: '加急',
    columnKey: 'is_urgent',
    minWidth: 80,
    align: 'center',
    cellRender: ({ row }) => {
      const r = row as PartListItem
      if (edit.editingId.value === r.id) {
        return h(ElSwitch, {
          modelValue: edit.editBuffer.is_urgent,
          'onUpdate:modelValue': (v: string | number | boolean) => { edit.editBuffer.is_urgent = v === true },
          size: 'small',
        })
      }
      if (r.is_urgent) {
        return h(ElTag, {
          type: 'danger',
          effect: 'plain',
          size: 'small',
        }, () => '加急')
      }
      return h('span', { class: 'muted' }, '—')
    },
  },

  // 16. 下一道工序（原生 :filters + 选中计数 badge；装配件行恒为 '—'）
  {
    key: 'next_process',
    label: '下一道工序',
    columnKey: 'next_process',
    minWidth: 130,
    align: 'center',
    filters: filters.nextProcessOptions.value,
    filteredValue: filters.nextProcessFilteredValue.value,
    headerRender: () => h('span', { class: 'status-header' }, [
      '下一道工序',
      filters.nextProcessSelectedCount.value > 0
        ? h('span', { class: 'status-count' }, `(${filters.nextProcessSelectedCount.value})`)
        : null,
    ]),
    cellRender: ({ row }) => {
      const r = row as PartListItem
      if (r.row_type === 'ASSEMBLY') {
        return h('span', { class: 'muted' }, '—')
      }
      if (r.next_process_name) {
        return h('span', null, r.next_process_name)
      }
      return h('span', { class: 'muted' }, '—')
    },
  },

  // 17. 所在位置（popover + el-tree-select 多选）
  {
    key: 'location',
    label: '所在位置',
    columnKey: 'location',
    minWidth: 150,
    showOverflowTooltip: true,
    align: 'center',
    headerRender: () => h(ColumnFilterPopover, {
      label: '所在位置',
      active: filters.locationFilter.active.value,
      width: 260,
      hint: '选大类命中该类全部；选叶子精确到货架/工人/外协公司',
      visible: filters.locationFilter.visible.value,
      'onUpdate:visible': (v: boolean) => { filters.locationFilter.visible.value = v },
      onShow: filters.locationFilter.onShow,
      onConfirm: filters.locationFilter.confirm,
      onReset: filters.locationFilter.reset,
    }, {
      default: () => h(ElTreeSelect, {
        modelValue: filters.locationFilter.draft.value,
        'onUpdate:modelValue': (v: unknown) => {
          filters.locationFilter.draft.value = Array.isArray(v) ? v.map(String) : []
        },
        data: filters.locationTree.value,
        nodeKey: 'id',
        props: { label: 'name', children: 'children' },
        multiple: true,
        showCheckbox: true,
        checkStrictly: true,
        checkOnClickNode: true,
        clearable: true,
        filterable: true,
        teleported: false,
        placeholder: '选择位置',
        style: 'width: 100%',
        onClear: () => { filters.locationFilter.draft.value = [] },
      }),
    }),
    cellRender: ({ row }) => {
      const r = row as PartListItem
      if (r.location === 'PRODUCTION_SHELF' && r.shelf_code) {
        return h('span', null, `货架 ${r.shelf_code}`)
      }
      if (r.location === 'INSPECTION_SHELF' && r.shelf_code) {
        return h('span', null, `品检 ${r.shelf_code}`)
      }
      if (r.location === 'WORKER' && r.worker_name) {
        return h('span', null, r.worker_name)
      }
      if (r.location === 'OUTSOURCE_COMPANY' && r.outsource_company_name) {
        return h('span', null, `外协 ${r.outsource_company_name}`)
      }
      return h('span', { class: 'muted' }, '—')
    },
  },

  // 18. 备注（el-input 编辑）
  {
    key: 'note',
    label: '备注',
    columnKey: 'note',
    minWidth: 160,
    showOverflowTooltip: true,
    align: 'center',
    cellRender: ({ row }) => {
      const r = row as PartListItem
      if (edit.editingId.value === r.id) {
        return h(ElInput, {
          modelValue: edit.editBuffer.note,
          'onUpdate:modelValue': (v: string) => { edit.editBuffer.note = v },
          size: 'small',
        })
      }
      return h('span', null, r.note || '—')
    },
  },
]

const columnDefs: ColumnDef[] = [
  ...baseColumnDefs,
  ...(canEdit ? priceColumnDefs : []),
  ...tailColumnDefs,
]

const columnVisibility = useColumnVisibility(columnDefs, { listKey: 'parts_list_columns' })

// ============ 采购订单 Excel 导入对话框可见性 ============
const orderImportVisible = ref(false)

// ============ 装配 ctx（子组件通信契约）============
const ctx: PartsListCtx = {
  query,
  filters,
  edit,
  batch,
  print,
  dispatch,
  canEdit,
  isCncProgrammer,
  columnVisibility,
  columnDefs,
}

// ============ 隐藏 iframe：onMounted 同步赋值给 ctx.print.iframeRef ============
const iframeRef = ref<HTMLIFrameElement | null>(null)

// ============ 顶层解构：模板自动解包 ============
const {
  search,
  items: _items,  // 由 PartsTable 直接消费 query.items，无需顶层解构
  total,
  page,
  pageSize,
  fetchList,
  onReset,
  onRowTypeChange,
  onPageSizeChange,
  restoreState,
  tableKey: _tableKey,  // 由 PartsTable 直接消费 query.tableKey
  registerBeforeSearch: _rbs,  // 已在上方调用
  registerAfterFetch: _raf,  // 已在上方调用
  snapshotPersist: _snapshot,  // 由 filters 内部消费
  onSearch: _onSearch,  // 由 filters 内部消费
} = query

// batch / print / dispatch / edit / filters / columnVisibility 各取局部变量
// 仅用于模板顶部 filter-card。
const { batchMode, onEnterBatchMode, onEnterBatchDispatchMode, onExitBatchMode } = batch

// 抑制「_ 解构变量未使用」lint —— 这些值已被各 composable / PartsTable 内部消费。
void _items
void _tableKey
void _rbs
void _raf
void _snapshot
void _onSearch
void initialPartsSearch  // 仅 re-export

// ============ 扫码：序列号直搜 ============
const { onScan } = useBarcodeScanner()
const unsubPartsListScan = onScan((code) => {
  // 2026-08-04：扫码命中序列号时给输入框加 0.6s 脉冲动画（视觉反馈）
  // editingId 守卫放在 composable 内部（onSerialNoScan 内部判 editingId != null）
  // —— 这里直接转发即可。
  if (edit.editingId.value != null) return
  filters.onSerialNoScan(code)
})

onMounted(async () => {
  // 1) 优先从 URL ?status= 注入；否则从 localStorage 恢复
  query.restoreState(route.query.status)
  void query.fetchList()

  // 2026-07-29 PR-fix-0.2.0：表头排序箭头要等 el-table 挂载后手动调一次 sort()，
  // 否则离开页面再回来时 refs 已恢复但表头不显示箭头（:default-sort 是 one-time prop）。
  await nextTick()
  const sortProp = PART_SORT_KEY_TO_PROP[query.sortBy.value] ?? 'planned_delivery_date'
  const sortOrder = query.sortDir.value === 'ASC' ? 'ascending' : 'descending'
  partsTableRef.value?.tableRef?.sort(sortProp, sortOrder)

  // 隐藏 iframe 必须在 onBatchPrint 跑之前挂上 ref
  print.iframeRef.value = iframeRef.value

  // 加载下一道工序选项供原生 :filters 展示
  void filters.loadNextProcessOptions()
})

onBeforeUnmount(() => {
  unsubPartsListScan()
})
</script>

<style lang="scss" scoped>
.parts-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

// 2026-08-22：原 mobile `@include until(sm)` 已全部清除；filter-row 保持一行布局。
.filter-card {
  :deep(.el-card__body) {
    padding: 12px 16px;
  }
}

.filter-row {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: nowrap;
}

.filter-group {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

// 操作组靠右
.filter-group--actions {
  margin-left: auto;
}

.total-hint {
  font-size: 13px;
  color: var(--text-secondary);
}

.pagination {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  padding: 0 4px;
}
</style>
