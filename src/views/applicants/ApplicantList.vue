<!--
  ApplicantList.vue

  /applicants — 客户管理 → 申请人一览。

  表格：# / 姓名 / 所属一级客户 / 创建时间 / 操作。
  筛选：按所属一级客户 + 姓名模糊。
  新增/编辑 dialog：姓名 + 一级客户下拉（仅 root）。
  模板沿用 WorkTypeList.vue 的简洁风格。
-->
<template>
  <div class="applicant-list">
    <el-card shadow="never" class="filter-card">
      <el-form inline>
        <el-form-item label="一级客户">
          <el-select
            v-model="search.customerId"
            placeholder="全部"
            clearable
            filterable
            style="width: 200px"
          >
            <el-option
              v-for="r in rootOptions"
              :key="r.id"
              :label="r.name"
              :value="r.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="姓名">
          <el-input
            v-model="search.nameLike"
            placeholder="模糊匹配"
            clearable
            style="width: 200px"
            @keyup.enter="fetchList"
            @clear="fetchList"
          />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="fetchList">
            <el-icon><Search /></el-icon><span>查询</span>
          </el-button>
          <el-button @click="onReset">
            <el-icon><RefreshLeft /></el-icon><span>重置</span>
          </el-button>
          <el-button type="success" @click="onNew">
            <el-icon><Plus /></el-icon><span>新增申请人</span>
          </el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <el-card shadow="never">
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
        v-loading="loading"
        row-key="id"
        empty-text="暂无申请人"
        stripe
        border
        size="small"
      >
        <template #empty>
          <el-empty description="暂无申请人" />
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
        <el-table-column label="操作" min-width="180" fixed="right" align="center">
          <template #default="{ row }">
            <el-button link type="primary" size="small" @click="onEdit(row as Applicant)">编辑</el-button>
            <el-button link type="danger" size="small" @click="onDelete(row as Applicant)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog
      v-model="dialogVisible"
      :title="editing ? '编辑申请人' : '新增申请人'"
      :width="applicantDlg.width"
      :top="applicantDlg.top"
      :fullscreen="applicantDlg.fullscreen"
      :close-on-click-modal="false"
      @closed="onDialogClosed"
    >
      <el-form
        ref="formRef"
        :model="form"
        :rules="rules"
        label-width="100px"
        label-position="right"
      >
        <el-form-item label="姓名" prop="name">
          <el-input v-model="form.name" placeholder="例如：林雪强" maxlength="50" show-word-limit />
        </el-form-item>
        <el-form-item label="一级客户" prop="customerId">
          <el-select
            v-model="form.customerId"
            placeholder="选择一级客户"
            filterable
            style="width: 100%"
          >
            <el-option
              v-for="r in rootOptions"
              :key="r.id"
              :label="r.name"
              :value="r.id"
            />
          </el-select>
          <p class="form-hint">申请人只能挂在一级客户下。</p>
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
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import { Plus, RefreshLeft, Search } from '@element-plus/icons-vue'
import ColumnVisibilityPopover from '@/components/ColumnVisibilityPopover.vue'
import ColumnDragHandle from '@/components/ColumnDragHandle.vue'
import {
  useColumnVisibility,
  resolveDraggable,
  type ColumnDef,
} from '@/composables/useColumnVisibility'
import { useColumnDrag, columnIdentifier } from '@/composables/useColumnDrag'
import { useDialogSize } from '@/composables/useDialogSize'
import { useListStatePersist } from '@/composables/useListFilterPersist'
import { listCustomers, type Customer } from '@/api/customer'
import {
  createApplicant,
  listApplicants,
  softDeleteApplicant,
  updateApplicant,
} from '@/api/applicant'
import type { Applicant } from '@/types/applicant'
// 2026-08-25 统一日期格式化：原本地 formatDate 输出 YYYY-MM-DD HH:mm:ss（无时区转换），
// 改为 utils/date.formatDateTime（toISOString → UTC）。若后端发无 'Z' 的本地时间会相差 8h。
import { formatDateTime } from '@/utils/date'

// ============ 列可见性 + 列顺序拖动 ============
// 「#」和「操作」列不放进 defs → 始终可见,且不出现在列设置弹窗。
// 2026-08-27 T15：补 prop / minWidth / align + 文本列走 cellRender(PartListShell 同款)。
// 2026-08-27 修正：原生元素 children 不能传函数（Vue 3 会当 slots 处理 → 渲染为空），改为直接传值。
const columnDefs: ColumnDef[] = [
  { key: 'name', label: '姓名', prop: 'name', minWidth: 160, align: 'center' },
  {
    key: 'customer_name', label: '所属一级客户', minWidth: 180, align: 'center',
    cellRender: ({ row }) => h('span', null, (row as Applicant).customer_name || '—'),
  },
  {
    key: 'created_at', label: '创建时间', minWidth: 180, align: 'center',
    cellRender: ({ row }) => h('span', null, formatDateTime((row as Applicant).created_at)),
  },
]
const columnVisibility = useColumnVisibility(columnDefs, { listKey: 'applicant_list' })
const drag = useColumnDrag(columnDefs, { listKey: 'applicant_list' })

const loading = ref(false)
const saving = ref(false)
const rows = ref<Applicant[]>([])
const customers = ref<Customer[]>([])
const search = reactive({ customerId: '' as string | '', nameLike: '' })
// 2026-08-27 T15：列拖动 onMounted 挂 useDraggable 到表头 <tr>（列换序；绑 thead 会变成拖整行，2026-08-27 修正）
const tableRef = ref()

// ============ 筛选状态持久化 ============
const { restore: restoreApplicantFilter, clear: clearApplicantFilter } = useListStatePersist(
  'applicant_list',
  { search },
)

const rootOptions = computed(() =>
  customers.value
    .filter((c) => c.parent_id === null)
    .map((c) => ({ id: c.id, name: c.name })),
)

async function fetchList(): Promise<void> {
  loading.value = true
  try {
    const res = await listApplicants({
      customer_id: search.customerId || undefined,
      name_like: search.nameLike || undefined,
      limit: 200,
    })
    rows.value = res.items
  } catch (e) {
    ElMessage.error((e as Error).message ?? '加载失败')
  } finally {
    loading.value = false
  }
}

async function loadCustomers(): Promise<void> {
  try {
    customers.value = await listCustomers()
  } catch (e) {
    ElMessage.error((e as Error).message ?? '客户列表加载失败')
  }
}

function onReset(): void {
  search.customerId = ''
  search.nameLike = ''
  fetchList()
}

// ===== Dialog =====
interface FormState {
  name: string
  customerId: string
}
const formRef = ref<FormInstance>()
const applicantDlg = useDialogSize({ desktopWidth: 480 })
const dialogVisible = ref(false)
const editing = ref<Applicant | null>(null)
const form = reactive<FormState>({ name: '', customerId: '' })

const rules: FormRules = {
  name: [{ required: true, message: '请输入申请人姓名', trigger: 'blur' }],
  customerId: [{ required: true, message: '请选择一级客户', trigger: 'change' }],
}

function onNew(): void {
  editing.value = null
  form.name = ''
  form.customerId = rootOptions.value[0]?.id ?? ''
  dialogVisible.value = true
}

function onEdit(row: Applicant): void {
  editing.value = row
  form.name = row.name
  form.customerId = row.customer_id
  dialogVisible.value = true
}

async function onSave(): Promise<void> {
  if (!formRef.value) return
  try {
    await formRef.value.validate()
  } catch {
    return
  }
  saving.value = true
  try {
    const payload = {
      name: form.name.trim(),
      customer_id: form.customerId,
    }
    if (editing.value) {
      await updateApplicant(editing.value.id, payload)
      ElMessage.success('已保存')
    } else {
      await createApplicant(payload)
      ElMessage.success('已新增')
    }
    dialogVisible.value = false
    await fetchList()
  } catch (e) {
    ElMessage.error((e as Error).message ?? '保存失败')
  } finally {
    saving.value = false
  }
}

function onDialogClosed(): void {
  editing.value = null
  form.name = ''
  form.customerId = ''
}

async function onDelete(row: Applicant): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `确认软删除申请人「${row.name}」？被未软删零件引用时拒绝。`,
      '删除申请人',
      { confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning' },
    )
  } catch {
    return
  }
  try {
    await softDeleteApplicant(row.id)
    ElMessage.success('已删除')
    await fetchList()
  } catch (e) {
    ElMessage.error((e as Error).message ?? '删除失败')
  }
}

onMounted(async () => {
  // 先尝试恢复 localStorage 中的搜索条件
  const persisted = restoreApplicantFilter()
  if (persisted) {
    Object.assign(search, persisted.search)
  }
  await loadCustomers()
  await fetchList()
  // 2026-08-28 改造：传 el-table 实例 ref 即可，composable 内部解析表头 <tr> +
  // MutationObserver 自愈（表头首次出现 / EP 重建都能覆盖）。
  drag.applyDrag(tableRef)
})
</script>

<style lang="scss" scoped>
.applicant-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.filter-card :deep(.el-card__body) {
  padding: 16px 20px;
}
.form-hint {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--text-secondary);
}
.table-toolbar {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 8px;
}
</style>