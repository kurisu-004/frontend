<script setup lang="ts">
/**
 * 返修接收 (Repair Receive) 主页面（PR-M 2026-08-04 续）
 *
 * 双 Tab:
 * - 「已送货」(DELIVERED)：操作栏点「返修」→ 弹一步式 dialog（含数量 + 工序 + 货架）
 * - 「返修中」(REPAIRING)：纯查询，无操作按钮
 *
 * 表格风格复用零件一览：el-table + 列显隐 + 排序 + 加急红底 + 客户 el-tree-select 筛选。
 *
 * 扫码：useBarcodeScanner 全局监听；命中已送货列表弹 dialog；未命中复用报工台 findPartBySerialAndPrompt。
 */
import { h, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElTag } from 'element-plus'
import { Filter, Tools } from '@element-plus/icons-vue'
import {
  listRepairBatches,
  listRepairingBatches,
  type PartItem,
} from '@/api/parts'
import { useBarcodeScanner } from '@/composables/useBarcodeScanner'
import { useCustomerTree } from '@/composables/useCustomerTree'
import {
  useColumnVisibility,
  resolveDraggable,
  type ColumnDef,
} from '@/composables/useColumnVisibility'
import { useColumnDrag, columnIdentifier } from '@/composables/useColumnDrag'
import { findAllByCode, findPartBySerialAndPrompt } from '@/utils/scanHelpers'
import { findElTableThead } from '@/utils/elTable'
import ColumnVisibilityPopover from '@/components/ColumnVisibilityPopover.vue'
import ColumnDragHandle from '@/components/ColumnDragHandle.vue'
import RepairStartDialog from './RepairStartDialog.vue'

const { onScan } = useBarcodeScanner()
const { tree: customerTree } = useCustomerTree()

type TabKey = 'delivered' | 'repairing'
const activeTab = ref<TabKey>('delivered')

// —— 列表状态 ——
const rows = ref<PartItem[]>([])
const total = ref(0)
const loading = ref(false)
const limit = ref(50)
const offset = ref(0)

// —— 筛选状态（精简版；后端 /repair-batches 仅支持 keyword + customer_id + serial_no） ——
const search = reactive<{
  keyword: string
  orderNo: string
  serialNo: string
  customerId: string
  isUrgent: boolean | null
  plannedDeliverySortAsc: boolean
}>({
  keyword: '',
  orderNo: '',
  serialNo: '',
  customerId: '',
  isUrgent: null,
  plannedDeliverySortAsc: true,
})

// —— Dialog 状态 ——
const startDialog = ref<{ open: boolean; target: PartItem | null }>({
  open: false,
  target: null,
})

// —— 客户 popover 状态 ——
const customerPopoverVisible = ref(false)
const customerDraft = ref<string | null>(null)

function syncCustomerDraft(): void {
  customerDraft.value = search.customerId || null
}
function resetCustomer(): void {
  search.customerId = ''
  customerDraft.value = null
  customerPopoverVisible.value = false
  onSearch()
}
function confirmCustomer(): void {
  search.customerId = customerDraft.value ?? ''
  customerPopoverVisible.value = false
  offset.value = 0
  void loadList()
}

// ============ 列可见性 + 列顺序拖动 ============
// 「操作」列不放进 defs（始终可见且按 tab 显隐）。其余 12 列走 v-for 拖动。
// 2026-08-27 T16：补 prop / width / minWidth / align / sortable + ElTag 列走 cellRender(PartListShell 同款)。
const columnDefs: ColumnDef[] = [
  { key: 'serial_no', label: '流水号', prop: 'serial_no', width: 100, sortable: false },
  { key: 'drawing_no', label: '图号', prop: 'drawing_no', width: 160 },
  { key: 'name', label: '名称', prop: 'name', minWidth: 200 },
  { key: 'quantity', label: '数量', prop: 'quantity', width: 80, align: 'right' },
  {
    key: 'customer', label: '客户', minWidth: 180,
    cellRender: ({ row }) => {
      const r = row as PartItem
      return r.customer_path
        ? h('span', null, () => r.customer_path)
        : h('span', { class: 'muted' }, () => '—')
    },
  },
  { key: 'order_no', label: '订单号', prop: 'order_no', width: 120 },
  {
    key: 'status', label: '状态', width: 120,
    cellRender: ({ row }) => {
      const r = row as PartItem
      const t = r.status === 'DELIVERED' ? 'success' : r.status === 'REPAIRING' ? 'danger' : 'info'
      return h(ElTag, { type: t, effect: 'plain', size: 'small' }, () => r.status)
    },
  },
  {
    key: 'next_process', label: '下一工序', minWidth: 140,
    cellRender: ({ row }) => {
      const r = row as PartItem
      return r.next_process_name
        ? h('span', null, () => r.next_process_name)
        : h('span', { class: 'muted' }, () => '—')
    },
  },
  { key: 'planned_delivery_date', label: '计划交期', prop: 'planned_delivery_date', width: 120, sortable: true },
  {
    key: 'is_urgent', label: '加急', width: 64, align: 'center',
    cellRender: ({ row }) => {
      const r = row as PartItem
      // 2026-08-27 T16：cellRender 类型要求返回 VNode（非 null），用空 span 代替 null。
      return r.is_urgent
        ? h(ElTag, { type: 'danger', size: 'small' }, () => '急')
        : h('span', null, () => '')
    },
  },
  {
    key: 'has_been_repaired', label: '返修', width: 64, align: 'center',
    cellRender: ({ row }) => {
      const r = row as PartItem
      return r.has_been_repaired
        ? h(ElTag, { type: 'warning', size: 'small', effect: 'dark' }, () => '返修')
        : h('span', null, () => '')
    },
  },
  {
    key: 'location', label: '所在位置', minWidth: 160,
    cellRender: ({ row }) => {
      const r = row as PartItem
      return r.current_holder_display
        ? h('span', null, () => r.current_holder_display)
        : h('span', { class: 'muted' }, () => '—')
    },
  },
]
const columnVisibility = useColumnVisibility(columnDefs, {
  listKey: 'repair_receive_columns',
})
const drag = useColumnDrag(columnDefs, { listKey: 'repair_receive_columns' })
// 2026-08-27 T16：列拖动 onMounted 挂 useDraggable 到 <thead>
const tableRef = ref()

// —— 列表加载 ——
async function loadList(): Promise<void> {
  loading.value = true
  try {
    const params = {
      keyword: search.keyword || undefined,
      serial_no: search.serialNo || undefined,
      customer_id: search.customerId || undefined,
      limit: limit.value,
      offset: offset.value,
    }
    const result =
      activeTab.value === 'delivered'
        ? await listRepairBatches(params)
        : await listRepairingBatches(params)
    rows.value = result.items
    total.value = result.total
  } catch (e) {
    ElMessage.error((e as Error).message ?? '列表加载失败')
  } finally {
    loading.value = false
  }
}

function onSearch(): void {
  offset.value = 0
  void loadList()
}
function onReset(): void {
  search.keyword = ''
  search.orderNo = ''
  search.serialNo = ''
  search.isUrgent = null
  search.plannedDeliverySortAsc = true
  offset.value = 0
  void loadList()
}

async function switchTab(tab: TabKey): Promise<void> {
  activeTab.value = tab
  offset.value = 0
  await loadList()
}

// —— 操作按钮 ——
function onClickStartRepair(row: PartItem): void {
  startDialog.value = { open: true, target: row }
}
async function onDialogConfirm(): Promise<void> {
  await loadList()
}

// —— 扫描处理 ——
async function handleScan(code: string): Promise<void> {
  const found = findAllByCode(rows.value, code).filter((r) =>
    activeTab.value === 'delivered'
      ? r.status === 'DELIVERED'
      : r.status === 'REPAIRING',
  )
  if (found.length >= 1) {
    if (activeTab.value === 'delivered') {
      onClickStartRepair(found[0])
    }
    // 返修中 tab 是纯查询：只命中列表，不弹 dialog
    return
  }
  // 未命中：复用报工台兜底（提示该零件位置）
  await findPartBySerialAndPrompt(code)
}

// —— 生命周期 ——
let unsubScan: (() => void) | null = null
onMounted(async () => {
  // 2026-08-27 T16：列顺序拖动挂 useDraggable 到 <thead>（RepairReceive 不在嵌套 tab 内，el-table 始终在 DOM）
  const root = tableRef.value?.$el as HTMLElement | undefined
  if (root) {
    const thead = findElTableThead(root)
    if (thead) drag.applyDrag(thead)
  }
  await loadList()
  unsubScan = onScan((code) => void handleScan(code))
})
onBeforeUnmount(() => {
  if (unsubScan) unsubScan()
})

// —— 行 className（加急红底） ——
function rowClassName(opts: { row: PartItem }): string {
  const classes: string[] = []
  if (opts.row.is_urgent) classes.push('row-urgent')
  return classes.join(' ')
}
</script>

<template>
  <div class="repair-receive">
    <el-tabs
      v-model="activeTab"
      @tab-change="(t) => void switchTab(t as TabKey)"
    >
      <el-tab-pane label="已送货" name="delivered" />
      <el-tab-pane label="返修中" name="repairing" />
    </el-tabs>

    <!-- 筛选卡：搜索 + 客户 popover + 加急 + 重置 + 列显隐 -->
    <el-card shadow="never" class="filter-card">
      <div class="filter-row">
        <div class="filter-group">
          <el-input
            v-model="search.keyword"
            placeholder="图号 / 名称"
            clearable
            style="width: 240px"
            @keyup.enter="onSearch"
            @clear="onSearch"
          />
          <el-input
            v-model="search.serialNo"
            placeholder="序列号"
            clearable
            style="width: 160px"
            @keyup.enter="onSearch"
            @clear="onSearch"
          />
        </div>

        <div class="filter-group">
          <!-- 客户列头 el-tree-select（与 PartsList 同款） -->
          <el-popover
            :width="280"
            placement="bottom-start"
            trigger="click"
            v-model:visible="customerPopoverVisible"
            @show="syncCustomerDraft"
          >
            <template #reference>
              <el-button
                :class="['filter-btn', { 'is-active': !!search.customerId }]"
                @click="customerPopoverVisible = !customerPopoverVisible"
              >
                <el-icon><Filter /></el-icon>
                <span>{{ search.customerId ? '客户(1)' : '客户' }}</span>
              </el-button>
            </template>
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
            />
            <div class="filter-actions">
              <el-button size="small" link @click="resetCustomer">重置</el-button>
              <el-button size="small" type="primary" @click="confirmCustomer"
                >确定</el-button
              >
            </div>
          </el-popover>

          <el-checkbox
            :model-value="search.isUrgent === true"
            @update:model-value="(v: boolean | string | number) => { search.isUrgent = v === true ? true : null; onSearch() }"
            >仅加急</el-checkbox
          >

          <el-button @click="onReset">重置</el-button>
        </div>
      </div>
    </el-card>

    <div class="table-toolbar">
      <ColumnVisibilityPopover
        :defs="columnDefs"
        :model-value="columnVisibility.currentMap"
        @update:model-value="(v: Record<string, boolean>) => (columnVisibility.currentMap = v)"
        @reset-order="drag.reset"
      />
    </div>
    <el-table
      ref="tableRef"
      :data="rows"
      :row-key="(row: PartItem) => row.id"
      v-loading="loading"
      stripe
      border
      size="small"
      :row-class-name="rowClassName"
    >
      <template #empty>
        <el-empty
          :description="
            activeTab === 'delivered' ? '暂无已送货件' : '暂无返修中件'
          "
        />
      </template>

      <!--
        2026-08-27 T16：列顺序拖动接入。drag.orderedDefs 提供持久化顺序；
        用 <template v-for> 包裹以兼容 Vue 3 同元素 v-for + v-if 优先级问题。
        「操作」列按 tab 显隐 → 保留为字面量 <el-table-column>（不进 v-for）。
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

      <!-- 操作列：已送货 tab 显示「返修」按钮；返修中 tab 隐藏整列 -->
      <el-table-column
        v-if="activeTab === 'delivered'"
        label="操作"
        width="100"
        fixed="right"
      >
        <template #default="{ row }">
          <el-button
            type="warning"
            size="small"
            @click="onClickStartRepair(row as PartItem)"
          >
            <el-icon><Tools /></el-icon>
            <span>返修</span>
          </el-button>
        </template>
      </el-table-column>

      <!-- 手机卡片视图已移除（2026-08-25 mobile 适配清理） -->
    </el-table>

    <!-- 分页 -->
    <div class="pagination-row">
      <el-pagination
        layout="total, prev, pager, next, sizes"
        :total="total"
        :page-size="limit"
        :current-page="Math.floor(offset / limit) + 1"
        :page-sizes="[20, 50, 100, 200]"
        @size-change="(s: number) => { limit = s; offset = 0; void loadList() }"
        @current-change="(p: number) => { offset = (p - 1) * limit; void loadList() }"
      />
    </div>

    <RepairStartDialog
      v-model="startDialog.open"
      :target="startDialog.target"
      @confirm="onDialogConfirm"
    />
  </div>
</template>

<style scoped>
.repair-receive {
  padding: 16px;
}
.filter-card {
  margin-bottom: 12px;
}
.filter-row {
  display: flex;
  gap: 16px;
  align-items: center;
  flex-wrap: wrap;
}
.filter-group {
  display: flex;
  gap: 8px;
  align-items: center;
}
.filter-btn {
  border: 1px solid #dcdfe6;
  background: #fff;
}
.filter-btn.is-active {
  color: #409eff;
  border-color: #b3d8ff;
  background: #ecf5ff;
}
.filter-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
}
.muted {
  color: #909399;
}
.pagination-row {
  display: flex;
  justify-content: flex-end;
  margin-top: 12px;
}
.table-toolbar {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 8px;
}
:deep(.row-urgent) {
  background: #fde2e2 !important;
}
</style>
