<template>
  <div class="worker-list">
    <el-card shadow="never" class="filter-card">
      <el-form inline @submit.prevent="onSearch">
        <el-form-item label="姓名">
          <el-input
            v-model="search.name_like"
            placeholder="模糊匹配"
            clearable
            style="width: 160px"
            @keyup.enter="onSearch"
          />
        </el-form-item>
        <el-form-item label="状态">
          <el-select
            v-model="search.is_active"
            placeholder="全部"
            clearable
            style="width: 110px"
          >
            <el-option label="在职" :value="true" />
            <el-option label="停用" :value="false" />
          </el-select>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="onSearch">
            <el-icon><Search /></el-icon>
            <span>查询</span>
          </el-button>
          <el-button @click="onReset">
            <el-icon><RefreshLeft /></el-icon>
            <span>重置</span>
          </el-button>
          <el-button type="success" @click="onNew">
            <el-icon><Plus /></el-icon>
            <span>新增工人</span>
          </el-button>
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
        <el-empty description="暂无工人" />
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
      <el-table-column label="操作" min-width="220" fixed="right" align="center">
        <template #default="{ row }">
          <el-button link type="primary" size="small" @click="onEdit(row as Worker)">编辑</el-button>
          <el-button
            v-if="(row as Worker).is_active"
            link
            type="warning"
            size="small"
            @click="onDeactivate(row as Worker)"
          >停用</el-button>
          <el-button
            v-else
            link
            type="success"
            size="small"
            @click="onReactivate(row as Worker)"
          >启用</el-button>
        </template>
      </el-table-column>

      <!-- 手机卡片视图已移除（2026-08-25 mobile 适配清理） -->
    </el-table>

    <!-- 新增/编辑弹窗 -->
    <el-dialog
      v-model="dialogVisible"
      :title="editing ? '编辑工人' : '新增工人'"
      :width="workerDlg.width"
      :top="workerDlg.top"
      @closed="onDialogClosed"
    >
      <el-form :model="form" label-width="80px" ref="formRef">
        <el-form-item label="工牌码" required>
          <el-input
            v-model="form.badge_code"
            placeholder="工牌上的条码/二维码值"
            clearable
          />
        </el-form-item>
        <el-form-item label="姓名" required>
          <el-input v-model="form.name" placeholder="工人姓名" clearable />
        </el-form-item>
        <el-form-item label="工种">
          <el-select v-model="form.work_type_id" clearable placeholder="未分配" style="width: 100%">
            <el-option
              v-for="wt in workTypeOptions"
              :key="wt.id"
              :label="`${wt.code} / ${wt.name}`"
              :value="wt.id"
            />
          </el-select>
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
import { useDialogSize } from '@/composables/useDialogSize'
import {
  useColumnVisibility,
  resolveDraggable,
  type ColumnDef,
} from '@/composables/useColumnVisibility'
import { useColumnDrag, columnIdentifier } from '@/composables/useColumnDrag'
import { useListStatePersist } from '@/composables/useListFilterPersist'
import {
  createWorker,
  deactivateWorker,
  listWorkers,
  reactivateWorker,
  updateWorker,
} from '@/api/worker'
import { listWorkTypes } from '@/api/workType'
import type { Worker } from '@/types/worker'
import type { WorkType } from '@/types/workType'

const loading = ref(false)
const saving = ref(false)
const rows = ref<Worker[]>([])
const total = ref(0)

const workTypes = ref<WorkType[]>([])
const workTypeOptions = computed(() => workTypes.value)
const workTypeNameById = computed<Record<string, string>>(() => {
  const map: Record<string, string> = {}
  for (const wt of workTypes.value) map[wt.id] = wt.name
  return map
})

const search = reactive<{ name_like: string; is_active: boolean | undefined }>({
  name_like: '',
  is_active: undefined,
})

// ============ 筛选状态持久化 ============
const { restore: restoreWorkerFilter, clear: clearWorkerFilter } = useListStatePersist(
  'worker_list',
  { search },
)

// ============ 列可见性 + 列顺序拖动 ============
// 「#」和「操作」列不放进 defs → 始终可见。
// 2026-08-27 T15：补 prop / width / minWidth / align + 复杂单元格走 cellRender(PartListShell 同款)。
// 2026-08-27 修正：原生元素 children 不能传函数（Vue 3 会当 slots 处理 → 渲染为空），改为直接传值。
const columnDefs: ColumnDef[] = [
  { key: 'badge_code', label: '工牌码', prop: 'badge_code', minWidth: 160, align: 'center' },
  { key: 'name', label: '姓名', prop: 'name', minWidth: 120, align: 'center' },
  {
    key: 'work_type', label: '工种', minWidth: 120, align: 'center',
    cellRender: ({ row }) => {
      const w = row as Worker
      return w.work_type_id
        ? h(ElTag, { size: 'small', type: 'primary' },
            () => workTypeNameById.value[w.work_type_id!] || '...')
        : h('span', { style: 'color: #c0c4cc' }, '未分配')
    },
  },
  {
    key: 'is_active', label: '状态', minWidth: 100, align: 'center',
    cellRender: ({ row }) => {
      const w = row as Worker
      return h(ElTag, {
        type: w.is_active ? 'success' : 'info', effect: 'light', size: 'small',
      }, () => w.is_active ? '在职' : '停用')
    },
  },
  { key: 'created_at', label: '创建时间', prop: 'created_at', minWidth: 170, align: 'center' },
  { key: 'updated_at', label: '更新时间', prop: 'updated_at', minWidth: 170, align: 'center' },
]
const columnVisibility = useColumnVisibility(columnDefs, { listKey: 'worker_list' })
const drag = useColumnDrag(columnDefs, { listKey: 'worker_list' })

// 2026-08-27 T15：列拖动 onMounted 挂 useDraggable 到表头 <tr>（列换序；绑 thead 会变成拖整行，2026-08-27 修正）
const tableRef = ref()
const dialogVisible = ref(false)
const editing = ref<Worker | null>(null)
const form = reactive<{ badge_code: string; name: string; work_type_id: string | null }>({
  badge_code: '',
  name: '',
  work_type_id: null,
})
const formRef = ref<{ validate: () => Promise<boolean> } | null>(null)
// 弹窗尺寸：桌面 420px，手机 92vw + 6vh
const workerDlg = useDialogSize({ desktopWidth: 420 })

async function fetchList(): Promise<void> {
  loading.value = true
  try {
    const res = await listWorkers({
      name_like: search.name_like || undefined,
      is_active: search.is_active,
      limit: 200,
    })
    rows.value = res.items
    total.value = res.total
  } catch (e) {
    ElMessage.error((e as Error).message ?? '加载失败')
  } finally {
    loading.value = false
  }
}

function onSearch(): void {
  fetchList()
}
function onReset(): void {
  search.name_like = ''
  search.is_active = undefined
  fetchList()
}
function onNew(): void {
  editing.value = null
  form.badge_code = ''
  form.name = ''
  form.work_type_id = null
  dialogVisible.value = true
}
function onEdit(row: Worker): void {
  editing.value = row
  form.badge_code = row.badge_code
  form.name = row.name
  form.work_type_id = row.work_type_id ?? null
  dialogVisible.value = true
}

async function onSave(): Promise<void> {
  if (!form.badge_code.trim() || !form.name.trim()) {
    ElMessage.warning('工牌码和姓名不能为空')
    return
  }
  saving.value = true
  try {
    if (editing.value) {
      await updateWorker(editing.value.id, {
        badge_code: form.badge_code.trim(),
        name: form.name.trim(),
        work_type_id: form.work_type_id,
      })
      ElMessage.success('已保存')
    } else {
      await createWorker({
        badge_code: form.badge_code.trim(),
        name: form.name.trim(),
        work_type_id: form.work_type_id,
      })
      ElMessage.success('已新增')
    }
    // 客户端不再持有 worker 缓存（findWorkerByBadge 改打后端），无需手动失效。
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
  form.badge_code = ''
  form.name = ''
  form.work_type_id = null
}

async function onDeactivate(row: Worker): Promise<void> {
  await ElMessageBox.confirm(
    `确认停用「${row.name}」？停用后该工牌将不能扫码领取。`,
    '提示',
    { confirmButtonText: '停用', cancelButtonText: '取消', type: 'warning' },
  )
    .then(async () => {
      await deactivateWorker(row.id)
      ElMessage.success('已停用')
      fetchList()
    })
    .catch(() => undefined)
}

async function onReactivate(row: Worker): Promise<void> {
  try {
    await reactivateWorker(row.id)
    ElMessage.success('已重新启用')
    fetchList()
  } catch (e) {
    ElMessage.error((e as Error).message ?? '启用失败')
  }
}

onMounted(async () => {
  // 先尝试恢复 localStorage 中的搜索条件
  const persisted = restoreWorkerFilter()
  if (persisted) {
    Object.assign(search, persisted.search)
  }
  await fetchList()
  try {
    const res = await listWorkTypes({ limit: 200 })
    workTypes.value = res.items
  } catch {
    // 不阻塞主页面
  }
  // 2026-08-28 改造：传 el-table 实例 ref 即可，composable 内部解析表头 <tr> +
  // MutationObserver 自愈（表头首次出现 / EP 重建都能覆盖）。
  drag.applyDrag(tableRef)
})
</script>

<style lang="scss" scoped>
.worker-list { display: flex; flex-direction: column; gap: 12px; }
.filter-card :deep(.el-card__body) { padding-bottom: 0; }
.muted { color: var(--text-secondary); }
.table-toolbar {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 8px;
}
</style>