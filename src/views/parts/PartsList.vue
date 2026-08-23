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

import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  Close,
  Document,
  Printer,
  Promotion,
  RefreshLeft,
  Upload,
} from '@element-plus/icons-vue'
import PartsTable from './components/PartsTable.vue'
import PartsBatchBar from './components/PartsBatchBar.vue'
import PartsDispatchDialog from './components/PartsDispatchDialog.vue'
import PartsBatchDispatchDialog from './components/PartsBatchDispatchDialog.vue'
import PurchaseOrderImportDialog from './components/PurchaseOrderImportDialog.vue'
import { useAuthSession } from '@/composables/useAuthSession'
import { useBarcodeScanner } from '@/composables/useBarcodeScanner'
import { useColumnVisibility } from '@/composables/useColumnVisibility'
import {
  initialPartsSearch,
  usePartsListQuery,
} from './composables/usePartsListQuery'
import { usePartsColumnFilters } from './composables/usePartsColumnFilters'
import { usePartInlineEdit } from './composables/usePartInlineEdit'
import { usePartBatchSelection } from './composables/usePartBatchSelection'
import { useBatchPrint } from './composables/useBatchPrint'
import { usePartDispatch } from './composables/usePartDispatch'
import { PART_SORT_KEY_TO_PROP } from '@/types/parts'
import type { PartsListCtx } from './composables/partsListCtx'

// ============ 角色 & 默认筛选 ============
const { hasRole } = useAuthSession()
const isCncProgrammer = hasRole('CNC_PROGRAMMER')
// PR-I 2026-07-20：INSPECTOR 看不到导入 / 批量打印 / 下发按钮
// 行内编辑权限：与后端 POST /parts/{id}/update 一致（MANAGER / CLERK）
const canEdit = hasRole('MANAGER') || hasRole('CLERK')

const route = useRoute()
const router = useRouter()

// ============ 列可见性 defs ============
// 「操作」和 batch 模式下的「selection」列不放进 defs → 始终可见
const columnDefs = [
  { key: 'serial_no', label: '序列号' },
  { key: 'order_no', label: '订单号' },
  { key: 'drawing_no', label: '图号' },
  { key: 'name', label: '名称' },
  { key: 'customer', label: '客户' },
  { key: 'applicant', label: '申请人' },
  { key: 'status', label: '状态' },
  { key: 'quantity', label: '数量' },
  { key: 'unit_price', label: '单价' },
  { key: 'total_price', label: '总价' },
  { key: 'request_date', label: '请购日期' },
  { key: 'planned_delivery_date', label: '计划交期' },
  { key: 'system_delivery_date', label: '系统交期' },
  { key: 'delivered_quantity', label: '已送数量' },
  { key: 'is_urgent', label: '加急' },
  { key: 'next_process', label: '下一道工序' },
  { key: 'location', label: '所在位置' },
  { key: 'note', label: '备注' },
] as const

// ============ Composable 装配顺序 ============
// deps 必须先建好；query 与 batch 之间有横切依赖（beforeSearch / afterFetch），
// 按此顺序注入。详见各 composable 顶部注释。
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
