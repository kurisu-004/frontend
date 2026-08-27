<template>
  <div class="shelf-page">
    <div class="page-header">
      <h2>货架管理</h2>
      <el-button type="primary" @click="showCreate = true">新增货架</el-button>
    </div>
    <div class="table-toolbar">
      <ColumnVisibilityPopover
        :defs="columnDefs"
        :model-value="columnVisibility.currentMap" @update:model-value="columnVisibility.update"
        @reset="columnVisibility.showAll"
        @reset-order="drag.reset"
      />
    </div>
    <el-table
      ref="tableRef"
      :data="items"
      v-loading="loading"
      row-key="id"
      empty-text="暂无货架"
      stripe
      :default-sort="{ prop: 'display_order', order: 'ascending' }"
    >
      <template #empty>
        <el-empty description="暂无货架" />
      </template>
      <!--
        2026-08-27 T15：列顺序拖动接入。drag.orderedDefs 提供持久化顺序；
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
      <el-table-column label="操作" min-width="160" fixed="right" align="center">
        <template #default="{ row }">
          <el-button link size="small" @click="editShelf(row)">编辑</el-button>
          <el-popconfirm v-if="row.is_active" title="确认停用？" @confirm="doDeactivate(String(row.id))">
            <template #reference><el-button link size="small" type="danger">停用</el-button></template>
          </el-popconfirm>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog
      v-model="showCreate"
      :title="editingShelf ? '编辑货架' : '新增货架'"
      :width="shelfDlg.width"
      :top="shelfDlg.top"
      :fullscreen="shelfDlg.fullscreen"
      @closed="resetForm"
    >
      <el-form ref="shelfFormRef" :model="shelfForm" :rules="shelfRules" label-width="80px">
        <el-form-item label="代码" prop="code"><el-input v-model="shelfForm.code" :disabled="!!editingShelf" placeholder="如 PROD-A1" /></el-form-item>
        <el-form-item label="名称" prop="name"><el-input v-model="shelfForm.name" placeholder="如 生产区-A1 货架" /></el-form-item>
        <el-form-item label="区域" prop="zone">
          <el-select v-model="shelfForm.zone" style="width:100%">
            <el-option label="生产区" value="PRODUCTION" /><el-option label="品检区" value="INSPECTION" />
          </el-select>
        </el-form-item>
        <el-form-item label="位置" prop="location"><el-input v-model="shelfForm.location" placeholder="可选的自由文本" /></el-form-item>
        <el-form-item label="物理顺序" prop="display_order">
          <el-input-number
            v-model="shelfForm.display_order"
            :min="0"
            :step="1"
            controls-position="right"
            placeholder="0=未设置"
          />
          <span class="field-hint">用于共享 HMI 卡片网格 picker 的物理顺序；0=未设置</span>
        </el-form-item>
        <el-form-item label="工序">
          <el-select
            v-model="selectedProcessIds"
            multiple filterable
            placeholder="选择该货架可执行的工序（可多选）"
            style="width:100%"
          >
            <el-option
              v-for="p in allProcesses"
              :key="p.id"
              :label="`${p.code} — ${p.name}`"
              :value="p.id"
            >
              <span style="font-weight:600">{{ p.code }}</span>
              <span style="margin-left:4px">{{ p.name }}</span>
              <el-tag :type="p.category === 'INHOUSE' ? 'primary' : 'warning'" size="small" style="margin-left:6px">{{ PROCESS_CATEGORY_LABEL[p.category] }}</el-tag>
            </el-option>
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showCreate = false">取消</el-button>
        <el-button type="primary" @click="saveShelf" :loading="saving">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted, h } from 'vue'
import { ElMessage, ElTag } from 'element-plus'
import ColumnVisibilityPopover from '@/components/ColumnVisibilityPopover.vue'
import ColumnDragHandle from '@/components/ColumnDragHandle.vue'
import {
  useColumnVisibility,
  resolveDraggable,
  type ColumnDef,
} from '@/composables/useColumnVisibility'
import { useColumnDrag, columnIdentifier } from '@/composables/useColumnDrag'
import { useDialogSize } from '@/composables/useDialogSize'
import { findElTableThead } from '@/utils/elTable'
import { listShelves, createShelf, updateShelf, deactivateShelf, getShelfProcesses, setShelfProcesses } from '@/api/shelves'
import { listProcesses } from '@/api/process'
import type { Shelf } from '@/types/shelf'
import type { Process } from '@/types/process'
import { PROCESS_CATEGORY_LABEL } from '@/types/process'

// ============ 列可见性 + 列顺序拖动 ============
// 「操作」列不放进 defs → 始终可见。
// 2026-08-27 T15：补 prop / width / minWidth / align + 复杂单元格走 cellRender。
const columnDefs: ColumnDef[] = [
  { key: 'code', label: '代码', prop: 'code', minWidth: 110, align: 'center' },
  { key: 'name', label: '名称', prop: 'name', minWidth: 140, align: 'center' },
  {
    key: 'zone', label: '区域', minWidth: 90, align: 'center',
    cellRender: ({ row }) => h(ElTag,
      { type: (row as Shelf).zone === 'PRODUCTION' ? 'primary' : 'warning', size: 'small' },
      () => (row as Shelf).zone === 'PRODUCTION' ? '生产' : '品检'),
  },
  { key: 'location', label: '位置', prop: 'location', minWidth: 120, align: 'center' },
  {
    key: 'display_order', label: '物理顺序', prop: 'display_order', minWidth: 100, align: 'center', sortable: true,
    cellRender: ({ row }) => h(ElTag,
      { type: (row as Shelf).display_order > 0 ? 'info' : 'warning', size: 'small', effect: 'plain' },
      () => (row as Shelf).display_order > 0 ? String((row as Shelf).display_order) : '未设置'),
  },
  { key: 'account_count', label: '账号数', prop: 'account_count', minWidth: 80, align: 'center' },
  {
    key: 'is_active', label: '状态', minWidth: 80, align: 'center',
    cellRender: ({ row }) => h(ElTag,
      { type: (row as Shelf).is_active ? 'success' : 'danger', size: 'small' },
      () => (row as Shelf).is_active ? '启用' : '停用'),
  },
]
const columnVisibility = useColumnVisibility(columnDefs, { listKey: 'shelf_list' })
const drag = useColumnDrag(columnDefs, { listKey: 'shelf_list' })

const items = ref<Shelf[]>([])
const loading = ref(false)
const shelfDlg = useDialogSize({ desktopWidth: 400 })
// 2026-08-27 T15：列拖动 onMounted 挂 useDraggable 到 <thead>
const tableRef = ref()

const showCreate = ref(false)
const saving = ref(false)
const allProcesses = ref<Process[]>([])
const selectedProcessIds = ref<string[]>([])
const editingShelf = ref<Shelf | null>(null)
const shelfFormRef = ref()
const shelfForm = reactive({ code: '', name: '', zone: 'PRODUCTION' as string, location: '', display_order: 0 })
const shelfRules = {
  code: [{ required: true, message: '必填' }],
  name: [{ required: true, message: '必填' }],
  zone: [{ required: true, message: '必选' }],
}

async function fetchData() {
  loading.value = true
  try { items.value = (await listShelves({ limit: 200 })).items }
  finally { loading.value = false }
}

function resetForm() { shelfForm.code = ''; shelfForm.name = ''; shelfForm.zone = 'PRODUCTION'; shelfForm.location = ''; shelfForm.display_order = 0; selectedProcessIds.value = []; editingShelf.value = null }
async function editShelf(s: any) { const sh = s as Shelf; editingShelf.value = sh; shelfForm.code = sh.code; shelfForm.name = sh.name; shelfForm.zone = sh.zone; shelfForm.location = sh.location ?? ''; shelfForm.display_order = sh.display_order ?? 0; showCreate.value = true; try { const sp = await getShelfProcesses(String(sh.id)); selectedProcessIds.value = sp.processes.map((p) => p.process_id) } catch { selectedProcessIds.value = [] } }

async function saveShelf() {
  const valid = await shelfFormRef.value?.validate().catch(() => false)
  if (!valid) return
  saving.value = true
  try {
    let shelfId: string
    if (editingShelf.value) {
      await updateShelf(String(editingShelf.value.id), {
        name: shelfForm.name,
        location: shelfForm.location || undefined,
        display_order: shelfForm.display_order,
      })
      shelfId = String(editingShelf.value.id)
    } else {
      const created = await createShelf({
        code: shelfForm.code,
        name: shelfForm.name,
        zone: shelfForm.zone,
        location: shelfForm.location || undefined,
        display_order: shelfForm.display_order,
      })
      shelfId = String(created.id)
    }
    await setShelfProcesses(shelfId, { process_ids: selectedProcessIds.value })
    showCreate.value = false
    await fetchData()
    ElMessage.success('已保存')
  } catch (e: any) { ElMessage.error(e?.message || '保存失败') }
  finally { saving.value = false }
}

async function doDeactivate(id: string) { await deactivateShelf(id); await fetchData(); ElMessage.success('已停用') }

onMounted(async () => {
  await fetchData()
  try { const res = await listProcesses({ limit: 200 }); allProcesses.value = res.items } catch { /* ignore */ }
  // 2026-08-27 T15：列顺序拖动挂 useDraggable 到 <thead>
  const root = tableRef.value?.$el as HTMLElement | undefined
  if (!root) return
  const thead = findElTableThead(root)
  if (thead) drag.applyDrag(thead)
})
</script>

<style lang="scss" scoped>
.page-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; h2 { margin: 0; font-size: 18px; } }
.field-hint {
  margin-left: 12px;
  font-size: 12px;
  color: #909399;
}
.table-toolbar {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 8px;
}
</style>
