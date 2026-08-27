<template>
  <div class="process-list">
    <el-card shadow="never" class="filter-card">
      <el-form inline>
        <el-form-item label="代码">
          <el-input v-model="search.code_like" clearable style="width: 160px" />
        </el-form-item>
        <el-form-item label="类别">
          <el-select v-model="search.category" clearable style="width: 120px">
            <el-option label="自产" value="INHOUSE" />
            <el-option label="外协" value="OUTSOURCE" />
          </el-select>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="fetchList"><el-icon><Search /></el-icon><span>查询</span></el-button>
          <el-button @click="onReset"><el-icon><RefreshLeft /></el-icon><span>重置</span></el-button>
          <el-button v-if="isManager" type="success" @click="onNew"><el-icon><Plus /></el-icon><span>新增工序</span></el-button>
        </el-form-item>
      </el-form>
    </el-card>

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
      :data="rows"
      row-key="id"
      v-loading="loading"
      stripe
      border
      size="small"
    >
      <template #empty>
        <el-empty description="暂无工序" />
      </template>
      <el-table-column type="index" label="#" width="50" />
      <!--
        2026-08-27 T15：列顺序拖动接入。drag.orderedDefs 提供持久化顺序；
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
      <el-table-column v-if="isManager" label="操作" min-width="180" fixed="right" align="center">
        <template #default="{ row }">
          <el-button link type="primary" size="small" @click="onEdit(row as Process)">编辑</el-button>
          <el-button link type="danger" size="small" @click="onDelete(row as Process)">删除</el-button>
        </template>
      </el-table-column>

      </el-table>

    <el-dialog
      v-model="dialogVisible"
      :title="dialogTitle"
      :width="dialogSize.width"
      :top="dialogSize.top"
      :fullscreen="dialogSize.fullscreen"
      @closed="onDialogClosed"
    >
      <el-form :model="form" label-width="80px" label-position="right">
        <el-form-item label="代码" required>
          <el-input v-model="form.code" :disabled="!!editing" placeholder="如 车 / 铣 / CNC / 热处理" />
        </el-form-item>
        <el-form-item label="名称" required>
          <el-input v-model="form.name" />
        </el-form-item>
        <el-form-item label="类别" required>
          <el-select v-model="form.category" style="width: 100%">
            <el-option label="自产" value="INHOUSE" />
            <el-option label="外协" value="OUTSOURCE" />
          </el-select>
        </el-form-item>
        <el-form-item label="需要审批">
          <el-switch
            v-model="form.requires_approval"
            :disabled="form.category === 'INHOUSE'"
            active-text="需要审批"
            inactive-text="直接发送"
            inline-prompt
            style="--el-switch-off-color: #67c23a"
          />
        </el-form-item>
        <el-form-item label="排序">
          <el-input-number v-model="form.sort_order" :min="0" />
        </el-form-item>
        <el-form-item label="描述">
          <el-input v-model="form.description" type="textarea" :rows="2" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="onSave">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, h, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox, ElTag } from 'element-plus'
import { Search, RefreshLeft, Plus } from '@element-plus/icons-vue'
import ColumnVisibilityPopover from '@/components/ColumnVisibilityPopover.vue'
import ColumnDragHandle from '@/components/ColumnDragHandle.vue'
import {
  useColumnVisibility,
  resolveDraggable,
  type ColumnDef,
} from '@/composables/useColumnVisibility'
import { useColumnDrag, columnIdentifier } from '@/composables/useColumnDrag'
import { useDialogSize } from '@/composables/useDialogSize'
import { usePermissions } from '@/composables/usePermissions'
import { findElTableThead } from '@/utils/elTable'
import { useListStatePersist } from '@/composables/useListFilterPersist'
import {
  createProcess,
  listProcesses,
  softDeleteProcess,
  updateProcess,
} from '@/api/process'
import type { Process, ProcessCategory } from '@/types/process'
import { PROCESS_CATEGORY_LABEL } from '@/types/process'

const { isManager } = usePermissions()
const dialogSize = useDialogSize({ desktopWidth: 460 })

const loading = ref(false)
const saving = ref(false)
const rows = ref<Process[]>([])
const search = reactive<{ code_like: string; category: ProcessCategory | undefined }>({
  code_like: '',
  category: undefined,
})

// ============ 筛选状态持久化 ============
const { restore: restoreProcessFilter, clear: clearProcessFilter } = useListStatePersist(
  'process_list',
  { search },
)

// ============ 列可见性 + 列顺序拖动 ============
// 「#」和「操作」列不放进 defs → 始终可见。
// 2026-08-27 T15：补 prop / minWidth / align + 复杂单元格走 cellRender。
const columnDefs: ColumnDef[] = [
  { key: 'code', label: '代码', prop: 'code', minWidth: 120, align: 'center' },
  { key: 'name', label: '名称', prop: 'name', minWidth: 160, align: 'center' },
  {
    key: 'category', label: '类别', minWidth: 100, align: 'center',
    cellRender: ({ row }) => h(ElTag,
      { type: (row as Process).category === 'INHOUSE' ? 'primary' : 'warning', size: 'small' },
      () => PROCESS_CATEGORY_LABEL[(row as Process).category]),
  },
  {
    key: 'requires_approval', label: '审批模式', minWidth: 110, align: 'center',
    cellRender: ({ row }) => h(ElTag,
      { type: (row as Process).requires_approval ? 'warning' : 'success', size: 'small' },
      () => (row as Process).requires_approval ? '需要审批' : '直接发送'),
  },
  { key: 'sort_order', label: '排序', prop: 'sort_order', minWidth: 80, align: 'center' },
]
const columnVisibility = useColumnVisibility(columnDefs, { listKey: 'process_list' })
const drag = useColumnDrag(columnDefs, { listKey: 'process_list' })
// 2026-08-27 T15：列拖动 onMounted 挂 useDraggable 到 <thead>
const tableRef = ref()

const dialogVisible = ref(false)
const editing = ref<Process | null>(null)
const dialogTitle = computed(() => (editing.value ? '编辑工序' : '新增工序'))
const form = reactive<{
  code: string; name: string; category: ProcessCategory
  sort_order: number; description: string
  requires_approval: boolean
}>({
  code: '', name: '', category: 'INHOUSE',
  sort_order: 0, description: '',
  requires_approval: true,  // OUTSOURCE 默认；INHOUSE 在保存时由后端强制为 false
})

async function fetchList(): Promise<void> {
  loading.value = true
  try {
    const res = await listProcesses({
      code_like: search.code_like || undefined,
      category: search.category,
      limit: 200,
    })
    rows.value = res.items
  } catch (e) {
    ElMessage.error((e as Error).message ?? '加载失败')
  } finally {
    loading.value = false
  }
}

function onReset(): void { search.code_like = ''; search.category = undefined; fetchList() }
function onNew(): void {
  editing.value = null
  Object.assign(form, {
    code: '', name: '', category: 'INHOUSE',
    sort_order: 0, description: '',
    requires_approval: true,
  })
  dialogVisible.value = true
}
function onEdit(row: Process): void {
  editing.value = row
  Object.assign(form, {
    code: row.code, name: row.name, category: row.category,
    sort_order: row.sort_order,
    description: row.description ?? '',
    requires_approval: row.requires_approval ?? true,
  })
  dialogVisible.value = true
}

async function onSave(): Promise<void> {
  if (!form.code.trim() || !form.name.trim()) {
    ElMessage.warning('代码与名称不能为空')
    return
  }
  saving.value = true
  try {
    if (editing.value) {
      await updateProcess(editing.value.id, {
        name: form.name.trim(),
        category: form.category,
        sort_order: form.sort_order,
        description: form.description.trim() || null,
        requires_approval: form.requires_approval,
      })
      ElMessage.success('已保存')
    } else {
      await createProcess({
        code: form.code.trim(),
        name: form.name.trim(),
        category: form.category,
        sort_order: form.sort_order,
        description: form.description.trim() || null,
        requires_approval: form.requires_approval,
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
  Object.assign(form, {
    code: '', name: '', category: 'INHOUSE',
    sort_order: 0, description: '',
    requires_approval: true,
  })
}

async function onDelete(row: Process): Promise<void> {
  await ElMessageBox.confirm(
    `确认删除工序「${row.name}」?被引用时拒绝。`,
    '提示',
    { confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning' },
  ).then(async () => {
    try {
      await softDeleteProcess(row.id)
      ElMessage.success('已删除')
      fetchList()
    } catch (e) {
      ElMessage.error((e as Error).message ?? '删除失败')
    }
  }).catch(() => undefined)
}

onMounted(() => {
  // 先尝试恢复 localStorage 中的搜索条件
  const persisted = restoreProcessFilter()
  if (persisted) {
    Object.assign(search, persisted.search)
  }
  void fetchList()
  // 2026-08-27 T15：列顺序拖动挂 useDraggable 到 <thead>
  const root = tableRef.value?.$el as HTMLElement | undefined
  if (!root) return
  const thead = findElTableThead(root)
  if (thead) drag.applyDrag(thead)
})
</script>

<style lang="scss" scoped>
.process-list { display: flex; flex-direction: column; gap: 12px; }
.table-toolbar {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 8px;
}
</style>