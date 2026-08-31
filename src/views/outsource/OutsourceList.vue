<template>
  <div class="outsource-list">
    <el-card shadow="never" class="filter-card">
      <el-form inline>
        <el-form-item label="公司名">
          <el-input v-model="search.name_like" clearable style="width: 200px" />
        </el-form-item>
        <el-form-item label="状态">
          <el-select v-model="search.is_active" clearable style="width: 120px">
            <el-option label="启用" :value="true" />
            <el-option label="停用" :value="false" />
          </el-select>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="fetchList">
            <el-icon><Search /></el-icon><span>查询</span>
          </el-button>
          <el-button @click="onReset">
            <el-icon><RefreshLeft /></el-icon><span>重置</span>
          </el-button>
          <el-button type="success" @click="onNew">
            <el-icon><Plus /></el-icon><span>新增外协公司</span>
          </el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <el-card shadow="never">
      <!-- 2026-08-25：删除 ResponsiveList 包装（手机卡片视图随 T1 撤掉），改用纯 el-table。
           ColumnVisibilityPopover 按 T2 模板提到 .table-toolbar 顶层 div。
           2026-08-25 (T7)：el-pagination 收口到 <PagedTable>；原 `search.offset/limit` 已迁出 search，PagedTable 内部管 -->
      <div class="table-toolbar">
        <ColumnVisibilityPopover
          :defs="columnDefs"
          :model-value="columnVisibility.currentMap" @update:model-value="columnVisibility.update"
          @reset="columnVisibility.showAll"
          @reset-order="drag.reset"
        />
      </div>
      <PagedTable ref="pagedRef" :fetcher="fetcher" :default-page-size="100" pagination-layout="total, sizes, prev, pager, next, jumper">
        <template #default="{ items, loading }">
          <el-table
            ref="tableRef"
            :data="items"
            v-loading="loading"
            row-key="id"
            stripe
            border
            size="small"
          >
            <template #empty>
              <el-empty description="暂无外协公司" />
            </template>
            <el-table-column type="index" label="#" width="50" />
            <!--
              2026-08-27 T16：列顺序拖动接入。drag.orderedDefs 提供持久化顺序；
              用 <template v-for> 包裹以兼容 Vue 3 同元素 v-for + v-if 优先级问题。
              type=index / fixed="right" 操作列保留为字面量 <el-table-column>。
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
            <el-table-column label="操作" min-width="280" fixed="right" align="center">
              <template #default="{ row }">
                <el-button link type="primary" size="small" @click="onEdit(row as OutsourceCompany)">编辑</el-button>
                <el-button link type="warning" size="small" @click="onManageProcesses(row as OutsourceCompany)">维护工序</el-button>
                <el-button link type="success" size="small" @click="onBilling(row as OutsourceCompany)">对账</el-button>
                <el-button link type="danger" size="small" @click="onDelete(row as OutsourceCompany)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
        </template>
      </PagedTable>
    </el-card>

    <!-- CRUD 对话框 -->
    <el-dialog
      v-model="dialogVisible"
      :title="editing ? '编辑外协公司' : '新增外协公司'"
      :width="companyDlg.width"
      :top="companyDlg.top"
      :close-on-click-modal="false"
      @closed="onDialogClosed"
    >
      <el-form :model="form" label-width="100px">
        <el-form-item label="公司名" required>
          <el-input v-model="form.name" :disabled="!!editing" placeholder="如 福州精工外协" />
        </el-form-item>
        <el-form-item label="联系人">
          <el-input v-model="form.contact_name" />
        </el-form-item>
        <el-form-item label="联系电话">
          <el-input v-model="form.contact_phone" />
        </el-form-item>
        <el-form-item label="地址">
          <el-input v-model="form.address" />
        </el-form-item>
        <el-form-item label="启用">
          <el-switch v-model="form.is_active" />
        </el-form-item>
        <!-- 2026-08-22 a11y：el-checkbox-group 根元素非 labelable -->
        <el-form-item v-if="!editing" label="工序能力（创建时）" :for="''">
          <el-checkbox-group v-model="form.process_ids" class="process-check-group" aria-label="工序能力">
            <el-checkbox
              v-for="p in outsourceProcesses"
              :key="p.id"
              :value="p.id"
            >
              {{ p.code }} — {{ p.name }}
            </el-checkbox>
            <span v-if="outsourceProcesses.length === 0" class="muted">
              没有 OUTSOURCE 工序，请先在「设置 → 工序管理」中新增
            </span>
          </el-checkbox-group>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="onSave">保存</el-button>
      </template>
    </el-dialog>

    <!-- 维护工序能力对话框 -->
    <el-dialog
      v-model="manageDialogVisible"
      :title="managing ? `维护「${managing.name}」的工序能力` : ''"
      :width="companyDlg.width"
      :top="companyDlg.top"
      :close-on-click-modal="false"
      @closed="onManageDialogClosed"
    >
      <el-form label-width="80px">
        <!-- 2026-08-22 a11y：el-checkbox-group 根元素非 labelable -->
        <el-form-item label="可执行外协工序" :for="''">
          <el-checkbox-group v-model="manageForm.process_ids" class="process-check-group" aria-label="可执行外协工序">
            <el-checkbox
              v-for="p in outsourceProcesses"
              :key="p.id"
              :value="p.id"
            >
              {{ p.code }} — {{ p.name }}
            </el-checkbox>
            <span v-if="outsourceProcesses.length === 0" class="muted">
              没有 OUTSOURCE 工序，请先在「设置 → 工序管理」中新增
            </span>
          </el-checkbox-group>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="manageDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="onSaveProcesses">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { h, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElTag } from 'element-plus'
import { Search, RefreshLeft, Plus } from '@element-plus/icons-vue'
import ColumnVisibilityPopover from '@/components/ColumnVisibilityPopover.vue'
import ColumnDragHandle from '@/components/ColumnDragHandle.vue'
import PagedTable from '@/components/PagedTable.vue'
import {
  useColumnVisibility,
  resolveDraggable,
  type ColumnDef,
} from '@/composables/useColumnVisibility'
import { useColumnDrag, columnIdentifier } from '@/composables/useColumnDrag'
import { useConfirm } from '@/composables/useConfirm'
import { useDialogSize } from '@/composables/useDialogSize'
import { useListStatePersist } from '@/composables/useListFilterPersist'
import {
  createOutsourceCompany,
  getOutsourceCompany,
  listOutsourceCompanies,
  setOutsourceCompanyProcesses,
  softDeleteOutsourceCompany,
  updateOutsourceCompany,
} from '@/api/outsource'
import type { OutsourceCompany } from '@/types/outsource'
import { listProcesses } from '@/api/process'
import type { Process } from '@/types/process'

const router = useRouter()
const companyDlg = useDialogSize({ desktopWidth: 520 })

const { dangerous: confirmDangerous } = useConfirm()

const saving = ref(false)
// 2026-08-25 T7：page/pageSize/total/loading/items 已迁到 <PagedTable> 内部；view 不再持有
const pagedRef = ref()
// search 只保留过滤项（不含分页）
const search = reactive<{ name_like: string; is_active: boolean | undefined }>({
  name_like: '',
  is_active: undefined,
})

// ============ 筛选状态持久化（2026-07-30 commit 4B；2026-08-25 T7：search 只含过滤项）============
const { restore: restoreOutsourceCompanyFilter } = useListStatePersist(
  'outsource_company_list',
  { search },
)

// ============ 列可见性 + 列顺序拖动 ============
// 「#」和「操作」列不放进 defs → 始终可见。
// 2026-08-27 T16：补 prop / minWidth / align + 文本列走 cellRender(PartListShell 同款)。
// 2026-08-27 修正：原生元素 children 不能传函数（Vue 3 会当 slots 处理 → 渲染为空），改为直接传值。
const columnDefs: ColumnDef[] = [
  { key: 'name', label: '公司名', prop: 'name', minWidth: 160, align: 'center' },
  {
    key: 'contact_name', label: '联系人', minWidth: 100, align: 'center',
    cellRender: ({ row }) => h('span', null, (row as OutsourceCompany).contact_name || '—'),
  },
  {
    key: 'contact_phone', label: '联系电话', minWidth: 120, align: 'center',
    cellRender: ({ row }) => h('span', null, (row as OutsourceCompany).contact_phone || '—'),
  },
  {
    key: 'address', label: '地址', prop: 'address', minWidth: 200, showOverflowTooltip: true, align: 'center',
    cellRender: ({ row }) => h('span', null, (row as OutsourceCompany).address || '—'),
  },
  {
    key: 'is_active', label: '状态', minWidth: 80, align: 'center',
    cellRender: ({ row }) => h(ElTag,
      { type: (row as OutsourceCompany).is_active ? 'success' : 'info', size: 'small' },
      () => (row as OutsourceCompany).is_active ? '启用' : '停用'),
  },
]
const columnVisibility = useColumnVisibility(columnDefs, { listKey: 'outsource_company_list' })
const drag = useColumnDrag(columnDefs, { listKey: 'outsource_company_list' })
// 2026-08-28 改造：applyDrag 接受 el-table 实例 ref，内部归一化根 + MutationObserver 自愈
const tableRef = ref()

const outsourceProcesses = ref<Process[]>([])

// CRUD dialog state
const dialogVisible = ref(false)
const editing = ref<OutsourceCompany | null>(null)
const form = reactive<{
  name: string
  contact_name: string
  contact_phone: string
  address: string
  is_active: boolean
  process_ids: string[]
}>({
  name: '',
  contact_name: '',
  contact_phone: '',
  address: '',
  is_active: true,
  process_ids: [],
})

// 维护工序 dialog state
const manageDialogVisible = ref(false)
const managing = ref<OutsourceCompany | null>(null)
const manageForm = reactive<{ process_ids: string[] }>({ process_ids: [] })

// PagedTable fetcher：分页参数从 params 读；过滤项从 view 本地 search 闭包读
async function fetcher(params: { page: number; pageSize: number }) {
  return await listOutsourceCompanies({
    name_like: search.name_like || undefined,
    is_active: search.is_active,
    limit: params.pageSize,
    offset: (params.page - 1) * params.pageSize,
  })
}

// view 其它地方触发刷新的薄包装（保持调用方不变）
async function fetchList(): Promise<void> {
  await pagedRef.value?.fetch()
}

async function fetchOutsourceProcesses(): Promise<void> {
  try {
    const res = await listProcesses({ category: 'OUTSOURCE', limit: 200 })
    outsourceProcesses.value = res.items
  } catch (e) {
    ElMessage.error((e as Error).message ?? '加载外协工序失败')
  }
}

function onReset(): void {
  search.name_like = ''
  search.is_active = undefined
  // 2026-08-25 T7：重置同时调 reset 把页码拨回 1
  void pagedRef.value?.reset()
}

function onNew(): void {
  editing.value = null
  form.name = ''
  form.contact_name = ''
  form.contact_phone = ''
  form.address = ''
  form.is_active = true
  form.process_ids = []
  dialogVisible.value = true
}

function onEdit(row: OutsourceCompany): void {
  editing.value = row
  form.name = row.name
  form.contact_name = row.contact_name ?? ''
  form.contact_phone = row.contact_phone ?? ''
  form.address = row.address ?? ''
  form.is_active = row.is_active
  form.process_ids = []
  dialogVisible.value = true
}

async function onSave(): Promise<void> {
  if (!form.name.trim()) {
    ElMessage.warning('公司名不能为空')
    return
  }
  saving.value = true
  try {
    if (editing.value) {
      await updateOutsourceCompany(editing.value.id, {
        name: form.name.trim(),
        contact_name: form.contact_name.trim() || null,
        contact_phone: form.contact_phone.trim() || null,
        address: form.address.trim() || null,
        is_active: form.is_active,
      })
      ElMessage.success('已保存')
    } else {
      await createOutsourceCompany({
        name: form.name.trim(),
        contact_name: form.contact_name.trim() || null,
        contact_phone: form.contact_phone.trim() || null,
        address: form.address.trim() || null,
        is_active: form.is_active,
        process_ids: form.process_ids,
      })
      ElMessage.success('已新增')
    }
    dialogVisible.value = false
    fetchList()
  } catch (e) {
    ElMessage.error((e as Error).message ?? '保存失败')
  } finally {
    saving.value = false
  }
}

function onDialogClosed(): void {
  editing.value = null
  form.name = ''
  form.contact_name = ''
  form.contact_phone = ''
  form.address = ''
  form.is_active = true
  form.process_ids = []
}

async function onManageProcesses(row: OutsourceCompany): Promise<void> {
  managing.value = row
  manageForm.process_ids = []
  manageDialogVisible.value = true
  try {
    const detail = await getOutsourceCompany(row.id)
    manageForm.process_ids = detail.processes.map((p) => p.process_id)
  } catch (e) {
    ElMessage.error((e as Error).message ?? '加载公司详情失败')
  }
}

async function onSaveProcesses(): Promise<void> {
  if (!managing.value) return
  saving.value = true
  try {
    await setOutsourceCompanyProcesses(managing.value.id, {
      process_ids: manageForm.process_ids,
    })
    ElMessage.success('工序能力已更新')
    manageDialogVisible.value = false
    fetchList()
  } catch (e) {
    ElMessage.error((e as Error).message ?? '保存失败')
  } finally {
    saving.value = false
  }
}

function onManageDialogClosed(): void {
  managing.value = null
  manageForm.process_ids = []
}

function onBilling(row: OutsourceCompany): void {
  // 跳到外协对账页（2026-07-28 新增）
  void router.push(`/outsource/companies/${row.id}/sent-parts`)
}

async function onDelete(row: OutsourceCompany): Promise<void> {
  if (!await confirmDangerous(
    '提示',
    `确认删除外协公司「${row.name}」？若有工序映射会拒绝。`,
    { type: 'warning', confirmText: '删除', cancelText: '取消' },
  )) return
  try {
    await softDeleteOutsourceCompany(row.id)
    ElMessage.success('已删除')
    fetchList()
  } catch (e) {
    ElMessage.error((e as Error).message ?? '删除失败')
  }
}

onMounted(() => {
  // 2026-08-28 改造：传 el-table 实例 ref，composable 内部解析表头 + MutationObserver 自愈
  drag.applyDrag(tableRef)

  void fetchOutsourceProcesses()
  // 从 localStorage 恢复搜索；强制将当前页重置到第 1 页（避免恢复到无数据页）
  const persisted = restoreOutsourceCompanyFilter() as
    | { search?: Partial<typeof search> }
    | null
    | undefined
  if (persisted) {
    if (persisted.search) Object.assign(search, persisted.search)
  }
  void fetchList()
})
</script>

<style lang="scss" scoped>
.outsource-list { display: flex; flex-direction: column; gap: 12px; }
// 2026-08-25：ColumnVisibilityPopover 收纳位（ResponsiveList 拆掉后从子组件抽出提到顶层）
.table-toolbar {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 8px;
}
.pagination {
  display: flex;
  justify-content: flex-end;
  margin-top: 12px;
}
.process-check-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 200px;
  overflow-y: auto;
}
.muted { color: #909399; font-size: 12px; }
</style>