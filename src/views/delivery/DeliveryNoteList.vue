<!--
  送货单一览（PR-G 2026-07-22 新增；2026-07-23 增强）

  - 文员 / MANAGER：filter (statuses × customer_id × keyword) → table → 操作
    (详情 / 提交 / 撤回 / 删除 / 打印)
  - 顶部「新建草稿」按钮：弹 el-dialog 选一级客户 + 送货日期 + 备注，
    勾选零件后原子创建 + 入件，跳详情页
  - 配送日期列、送货日期列
  - 打印按钮（list）：GET /delivery-notes/{id}/print → Axios blob + onDownloadProgress →
    按钮右侧 <el-progress type="circle"> 实时显示百分比

  形态对齐 frontend/src/views/outsource/OutsourceQuoteList.vue
-->
<script setup lang="ts">
import { computed, h, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox, ElTag } from 'element-plus'
import { Van, Promotion } from '@element-plus/icons-vue'

import {
  createNote as createNoteApi,
  listNotes,
  softDeleteNote,
  type AddPartsItem,
} from '@/api/deliveryNote'
import {
  DELIVERY_NOTE_STATUS_LABEL,
  DELIVERY_NOTE_STATUS_TAG,
  type DeliveryNoteOut,
  type DeliveryNoteStatus,
} from '@/types/deliveryNote'
import {
  canSoftDelete,
  defaultStatusesForRole,
  hasManageNoteRole,
} from '@/utils/deliveryNotePermissions'
import { listCustomers } from '@/api/customer'
import { useAuthSession } from '@/composables/useAuthSession'
import {
  useColumnVisibility,
  resolveDraggable,
  type ColumnDef,
} from '@/composables/useColumnVisibility'
import { useColumnDrag, columnIdentifier } from '@/composables/useColumnDrag'
import { findElTableThead } from '@/utils/elTable'
import { useListStatePersist } from '@/composables/useListFilterPersist'
import ColumnVisibilityPopover from '@/components/ColumnVisibilityPopover.vue'
import ColumnDragHandle from '@/components/ColumnDragHandle.vue'
import PagedTable from '@/components/PagedTable.vue'
import PartPickerDialog from '@/components/delivery/PartPickerDialog.vue'

const router = useRouter()
const route = useRoute()
const { hasRole } = useAuthSession()
const role = computed(() => ({
  MANAGER: hasRole('MANAGER'),
  CLERK: hasRole('CLERK'),
  INSPECTOR: hasRole('INSPECTOR'),
}))

// ============================================================
// 一览过滤
// ============================================================
const allStatuses: DeliveryNoteStatus[] = ['DRAFT', 'SUBMITTED', 'PICKED_UP', 'ARCHIVED']
const statuses = ref<DeliveryNoteStatus[]>(defaultStatusesForRole(role.value))
const customerId = ref<string>('')
const keyword = ref('')
// 2026-08-25 T7：items / total / loading / page 已迁到 <PagedTable>；pageSize 持久化镜像留在 view
const pagedRef = ref()
const pageSize = ref(50)

// ============ 筛选状态持久化（2026-07-30 commit 4B；2026-08-25 T7：page 不再持久化）============
// 把 4 个离散 ref 包成一个对象传给 useListStatePersist；restore 后逐个 .value 写回。
// page 排除。优先级：URL ?statuses= > restore 快照 > 角色默认
const { restore: restoreNoteListFilter } = useListStatePersist(
  'delivery_note_list',
  { statuses, customerId, keyword, pageSize },
  { exclude: new Set(['page']) },
)

// ============ 列可见性 + 列顺序拖动 ============
// 「操作」列不放进 defs → 始终可见
// 2026-08-27 T17：补 prop / minWidth / align + 文本列走 cellRender(PartListShell 同款)。
const columnDefs: ColumnDef[] = [
  { key: 'delivery_note_no', label: '单号', prop: 'delivery_note_no', minWidth: 180, align: 'center' },
  {
    key: 'delivery_date', label: '送货日期', minWidth: 120, align: 'center',
    cellRender: ({ row }) => h('span', null, () => (row as DeliveryNoteOut).delivery_date ?? '—'),
  },
  {
    key: 'customer', label: '客户', minWidth: 130, align: 'center',
    cellRender: ({ row }) => h('span', null, () => {
      const r = row as DeliveryNoteOut
      return r.customer_path ?? r.customer_name ?? '—'
    }),
  },
  {
    key: 'status', label: '状态', minWidth: 80, align: 'center',
    cellRender: ({ row }) => {
      const r = row as DeliveryNoteOut
      return h(ElTag,
        { type: DELIVERY_NOTE_STATUS_TAG[r.status] || 'info', size: 'small', effect: 'plain' },
        () => DELIVERY_NOTE_STATUS_LABEL[r.status])
    },
  },
  { key: 'part_count', label: '零件数', prop: 'part_count', minWidth: 70, align: 'center' },
  {
    key: 'submitted_at', label: '提交时间', minWidth: 170, align: 'center',
    cellRender: ({ row }) => {
      const r = row as DeliveryNoteOut
      return h('span', null, () => r.submitted_at ? new Date(r.submitted_at!).toLocaleString() : '—')
    },
  },
  {
    key: 'picked_up_at', label: '领取时间', minWidth: 170, align: 'center',
    cellRender: ({ row }) => {
      const r = row as DeliveryNoteOut
      return h('span', null, () => r.picked_up_at ? new Date(r.picked_up_at!).toLocaleString() : '—')
    },
  },
  {
    key: 'driver_worker_name', label: '司机', prop: 'driver_worker_name', minWidth: 80, align: 'center',
    cellRender: ({ row }) => h('span', null, () => (row as DeliveryNoteOut).driver_worker_name ?? '—'),
  },
]
const columnVisibility = useColumnVisibility(columnDefs, { listKey: 'delivery_note_list' })
const drag = useColumnDrag(columnDefs, { listKey: 'delivery_note_list' })
// 2026-08-27 T17：列拖动 onMounted 挂 useDraggable 到 <thead>。本视图为顶层路由，
// PagedTable 内 <el-table> 始终在 DOM（无 destroy-on-close / v-if）→ HTMLElement 路径。
const tableRef = ref()

const customers = ref<{ id: string; name: string; path: string; parent_id: string | null }[]>([])

/** 一级客户视图：新建草稿弹框专用；list-filter 处仍用全集 */
const rootCustomers = computed(() =>
  customers.value.filter((c) => c.parent_id === null),
)

async function loadCustomers() {
  try {
    const list = await listCustomers()
    customers.value = list.map((c: any) => ({
      id: c.id,
      name: c.name,
      parent_id: c.parent_id ?? null,
      path: c.parent_name ? `${c.parent_name} / ${c.name}` : c.name,
    }))
  } catch (e) {
    // ignore
  }
}

// 2026-08-25 T7：fetcher 给 PagedTable；其它地方仍调 fetchList() 触发刷新
async function fetcher(params: { page: number; pageSize: number }) {
  try {
    const resp = await listNotes({
      statuses: statuses.value.length ? statuses.value : undefined,
      customer_id: customerId.value || undefined,
      keyword: keyword.value.trim() || undefined,
      limit: params.pageSize,
      offset: (params.page - 1) * params.pageSize,
    })
    return { items: resp.items, total: resp.total }
  } catch (e) {
    ElMessage.error((e as Error).message ?? '查询失败')
    return { items: [], total: 0 }
  }
}

async function fetchList() {
  await pagedRef.value?.fetch()
}

function resetFilter() {
  statuses.value = defaultStatusesForRole(role.value)
  customerId.value = ''
  keyword.value = ''
  void pagedRef.value?.reset()
}

// 2026-08-25 T7：替换原 @click="page = 1; fetchList()"（page 已被 PagedTable 接管）
function resetToFirstPage() {
  void pagedRef.value?.reset()
}

onMounted(async () => {
  // 2026-08-27 T17：列顺序拖动挂 useDraggable 到 <thead>（HTMLElement 路径）
  const root = tableRef.value?.$el as HTMLElement | undefined
  if (root) {
    const thead = findElTableThead(root)
    if (thead) drag.applyDrag(thead)
  }
  await loadCustomers()
  // 2026-07-30 commit 4B：筛选项恢复（与 OutsourceQuoteList 同优先级）
  //   1) URL ?statuses=  → 最高优先
  //   2) restore() 快照里 statuses / customerId / keyword / pageSize
  //   3) 角色默认（已在 ref initializer 注入到 statuses.value；restore 不覆盖现有值）
  const urlStatusesRaw = route.query.statuses
  const urlStatuses: DeliveryNoteStatus[] = typeof urlStatusesRaw === 'string'
    ? urlStatusesRaw.split(',').filter((s): s is DeliveryNoteStatus =>
        allStatuses.includes(s as DeliveryNoteStatus))
    : []
  if (urlStatuses.length > 0) {
    statuses.value = [...urlStatuses]
  } else {
    const persisted = restoreNoteListFilter() as
      | { statuses?: DeliveryNoteStatus[]; customerId?: string; keyword?: string; pageSize?: number }
      | null
      | undefined
    if (persisted) {
      if (Array.isArray(persisted.statuses)) statuses.value = [...persisted.statuses]
      if (typeof persisted.customerId === 'string') customerId.value = persisted.customerId
      if (typeof persisted.keyword === 'string') keyword.value = persisted.keyword
      if (typeof persisted.pageSize === 'number') {
        pagedRef.value!.pageSize.value = persisted.pageSize
      }
    }
  }
  // 2026-08-25 T7：双向同步 PagedTable.pageSize → view 本地 pageSize（持久化写盘）
  watch(
    () => pagedRef.value?.pageSize?.value,
    (s) => { if (typeof s === 'number') pageSize.value = s },
  )
  await fetchList()
})

// ============================================================
// 新建草稿对话框（2026-07-23 重写：送日期、零件勾选）
// ============================================================
const createDialogOpen = ref(false)
const createCustomerId = ref<string>('')
// 默认送货日期 = 今天 (YYYY-MM-DD 格式)
/** @type {import('vue').Ref<string>} */
const createDeliveryDate = ref<string>(formatToday())
const createNoteText = ref<string>('')
const creating = ref(false)
/** 候选弹框选出的 part id 列表（弹框 emit submit 时合并） */
const selectedItems = ref<AddPartsItem[]>([])
/** 候选弹框自身的可见性（PartPickerDialog 的 v-model） */
const pickerDialogOpen = ref(false)

function formatToday(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function openCreate() {
  createCustomerId.value = ''
  createDeliveryDate.value = formatToday()
  createNoteText.value = ''
  selectedItems.value = []
  createDialogOpen.value = true
}

/** 当用户在弹框里勾完零件，按下「加入 (N)」时回传（2026-07-29 批次条目） */
function onPickerSubmit(items: AddPartsItem[]) {
  selectedItems.value = items
}

async function submitCreate() {
  if (!createCustomerId.value) {
    ElMessage.warning('请选择一级客户')
    return
  }
  if (!createDeliveryDate.value) {
    ElMessage.warning('请选择送货日期')
    return
  }
  creating.value = true
  try {
    const note = await createNoteApi({
      customer_id: createCustomerId.value,
      delivery_date: createDeliveryDate.value,
      items: selectedItems.value,
      note: createNoteText.value.trim() || null,
    })
    ElMessage.success(
      `已创建草稿 ${note.delivery_note_no}（含 ${selectedItems.value.length} 批）`,
    )
    createDialogOpen.value = false
    router.push(`/delivery-notes/${note.id}`)
  } catch (e) {
    ElMessage.error((e as Error).message ?? '创建失败')
  } finally {
    creating.value = false
  }
}

// ============================================================
// 行操作
// 2026-08-07：操作栏瘦身——提交 / 撤回 / 打印（送货单 + 标签）按钮全部移除，
// 全部操作统一在详情页（DeliveryNoteDetail.vue）里完成。本页只保留：
//   · 详情（跳详情页）
//   · 删除（仅 DRAFT；CLERK / MANAGER）
// ============================================================
async function onSoftDelete(n: DeliveryNoteOut) {
  try {
    await ElMessageBox.confirm(
      `确认删除 ${n.delivery_note_no}（草稿）？关联零件会解除。`,
      '删除送货单',
      { type: 'warning', confirmButtonText: '确认删除', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  try {
    await softDeleteNote(n.id, { version: n.version })
    ElMessage.success('已删除')
    fetchList()
  } catch (e) {
    ElMessage.error((e as Error).message ?? '删除失败')
  }
}
</script>

<template>
  <div class="delivery-note-list">
    <el-card shadow="never" class="filter-card">
      <el-form inline class="filter-form">
        <div style="display: flex; margin-bottom: 15px;">
          <el-form-item label="状态">
            <el-select
              v-model="statuses"
              multiple
              clearable
              placeholder="全部"
              style="width: 380px"
            >
              <el-option v-for="s in allStatuses" :key="s" :label="DELIVERY_NOTE_STATUS_LABEL[s]" :value="s" />
            </el-select>
          </el-form-item>
          <el-form-item label="客户">
            <el-select
              v-model="customerId"
              clearable
              filterable
              placeholder="全部"
              style="width: 200px"
            >
              <el-option v-for="c in customers" :key="c.id" :label="c.path" :value="c.id" />
            </el-select>
          </el-form-item>
        </div>

  
        <div style="display: flex; align-items: center; justify-content: space-between;">
          <div>
            <el-form-item label="单号">
              <el-input v-model="keyword" placeholder="DN-20260723-…" clearable style="width: 200px" />
            </el-form-item>
              <el-form-item>
                <el-button type="primary" @click="resetToFirstPage()">查询</el-button>
                <el-button @click="resetFilter">重置</el-button>
              </el-form-item>
          </div>
          
          <div class="delivery-list-actions">
            <el-button v-if="hasManageNoteRole(role)" type="primary" @click="$router.push('/delivery-notes/scan')">
              <el-icon><Promotion /></el-icon>
              <span>扫码建单</span>
            </el-button>
            <el-button v-if="hasManageNoteRole(role)" type="success" @click="openCreate">
              <el-icon><Van /></el-icon>
              新建草稿
            </el-button>
          </div>


        </div>

      </el-form>
    </el-card>

    <el-card shadow="never" style="margin-top: 16px">
      <template #header>
        <div class="dnl-card-header">
          <ColumnVisibilityPopover
            :defs="columnDefs"
            :model-value="columnVisibility.currentMap" @update:model-value="columnVisibility.update"
            @reset="columnVisibility.showAll"
            @reset-order="drag.reset"
          />
        </div>
      </template>
    <!-- 2026-08-25 (T7)：el-table + el-pagination 收口到 <PagedTable> -->
    <PagedTable ref="pagedRef" :fetcher="fetcher" :default-page-size="50" pagination-layout="total, sizes, prev, pager, next">
      <template #default="{ items, loading }">
    <el-table
      ref="tableRef"
      v-loading="loading"
      :data="items"
      :row-key="(r: DeliveryNoteOut) => r.id"
      :max-height="'calc(100vh - 360px)'"
      highlight-current-row
      stripe
      border
      :empty-text="loading ? '加载中' : '无数据'"
    >
      <!--
        2026-08-27 T17：列顺序拖动接入。drag.orderedDefs 提供持久化顺序；
        用 <template v-for> 包裹以兼容 Vue 3 同元素 v-for + v-if 优先级问题。
        fixed="right" 操作列保留为字面量 <el-table-column>。
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
      <el-table-column label="操作" min-width="120" fixed="right" align="center">
        <template #default="scope">
          <div style="display: flex; align-items: center; gap: 0px;">
            <el-button link type="primary" @click="$router.push(`/delivery-notes/${(scope.row as DeliveryNoteOut).id}`)">
              详情
            </el-button>
            <el-button
              v-if="canSoftDelete((scope.row as DeliveryNoteOut).status, role)"
              link
              type="danger"
              @click="onSoftDelete(scope.row as DeliveryNoteOut)"
            >
              删除
            </el-button>
          </div>
        </template>
      </el-table-column>
    </el-table>
      </template>
    </PagedTable>
    </el-card>

    <!-- 新建草稿对话框（2026-07-23 重写） -->
    <el-dialog v-model="createDialogOpen" title="新建送货单草稿" width="640px">
      <el-form label-width="90px">
        <el-form-item label="一级客户" required>
          <el-select
            v-model="createCustomerId"
            filterable
            placeholder="选择一级客户（L1 root）"
            style="width: 100%"
          >
            <el-option
              v-for="c in rootCustomers"
              :key="c.id"
              :label="c.name"
              :value="c.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="送货日期" required>
          <el-date-picker
            v-model="createDeliveryDate"
            type="date"
            value-format="YYYY-MM-DD"
            placeholder="选择送货日期"
            style="width: 100%"
          />
        </el-form-item>
        <el-form-item label="备注">
          <el-input
            v-model="createNoteText"
            type="textarea"
            :rows="2"
            maxlength="500"
            show-word-limit
            placeholder="可选备注"
          />
        </el-form-item>
        <el-form-item label="预选零件">
          <div class="picker-summary">
            <el-tag v-if="!createCustomerId" type="info" effect="plain">请先选客户</el-tag>
            <template v-else>
              <el-tag v-if="!selectedItems.length" type="warning" effect="plain">
                暂未勾选（可在弹出框里勾选 INSPECTION / READY_TO_SHIP 批次）
              </el-tag>
              <el-tag v-else type="success" effect="plain">
                已勾 {{ selectedItems.length }} 批
              </el-tag>
              <el-button
                size="small"
                type="primary"
                style="margin-left: 8px"
                @click="pickerDialogOpen = true"
              >
                {{ selectedItems.length ? '重新选择' : '选择零件' }}
              </el-button>
            </template>
          </div>
        </el-form-item>
      </el-form>

      <PartPickerDialog
        v-model="pickerDialogOpen"
        :customer-id="createCustomerId"
        @submit="onPickerSubmit"
      />

      <template #footer>
        <el-button @click="createDialogOpen = false">取消</el-button>
        <el-button type="primary" :loading="creating" @click="submitCreate">
          创建
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.delivery-note-list { padding: 16px; }
.filter-card :deep(.el-form-item) { margin-bottom: 0; }
.pager { margin-top: 16px; justify-content: flex-end; }
.dnl-card-header {
  display: flex;
  justify-content: flex-end;
  align-items: center;
}
.picker-summary {
  display: flex;
  align-items: center;
}
.delivery-list-actions {
  display: inline-flex;
  gap: 8px;
}
</style>
