<!--
  PartQuoteCard.vue

  外协报价卡（PartDetail 第 8 张卡）：
  - 仅当 canViewQuotes 为真时由 shell 渲染
  - 报价列表（来自 usePartQuote.fetchQuotes）
  - 新建报价对话框（form ref 局部维护，提交 emit create）
  - 状态门控的「新建」按钮

  2026-08-28 改造（B 组 batch 1 列拖动接入）：
  - el-table 在 el-card 内 v-if 控制（quotes.length > 0 时挂载）→
    传 el-table 实例 ref 给 drag.applyDrag(tableRef)，composable 内部 watch +
    MutationObserver 自愈（覆盖 quotes=0 → 加载后挂载的过渡）。
  - 「操作」fixed="right" 列保留为字面量 <el-table-column>。
  - 拖点挂到表头 <tr>（列换序；绑 thead 会变成拖整行）。
-->
<template>
  <el-card
    shadow="never"
    class="quote-card"
    v-loading="quotesLoading"
  >
    <template #header>
      <div class="card-header">
        <span class="card-title">
          <el-icon><Document /></el-icon>
          <span>外协报价</span>
        </span>
        <el-button
          v-if="canCreateQuoteNow"
          link
          type="primary"
          size="small"
          @click="openCreateDialog"
        >
          <el-icon><Plus /></el-icon>
          <span>新建外协报价</span>
        </el-button>
      </div>
    </template>
    <el-table
      v-if="quotes.length > 0"
      ref="tableRef"
      :data="quotes"
      size="small"
      border
      stripe
    >
      <!--
        2026-08-27 T23：列顺序拖动接入。drag.orderedDefs 提供持久化顺序；
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
          :header-align="d.headerAlign"
          :show-overflow-tooltip="d.showOverflowTooltip"
          :label-class-name="drag.dragLabelClass(d)"
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
      <el-table-column label="操作" min-width="120" align="center" fixed="right">
        <template #default="{ row }">
          <el-button
            link
            type="primary"
            size="small"
            @click="onViewQuoteDetail"
          >详情</el-button>
        </template>
      </el-table-column>
    </el-table>
    <el-empty v-else description="暂无外协报价" />

    <!-- 2026-08-27 T23：列设置按钮（仅列表态展示；空态无表可设） -->
    <div v-if="quotes.length > 0" class="table-toolbar">
      <ColumnVisibilityPopover
        :defs="columnDefs"
        :model-value="columnVisibility.currentMap"
        @update:model-value="columnVisibility.update"
        @reset="columnVisibility.showAll"
        @reset-order="drag.reset"
      />
    </div>

    <!-- 新建外协报价 对话框 -->
    <el-dialog
      v-model="createVisible"
      title="新建外协报价（DRAFT）"
      :width="createDlg.width"
      :top="createDlg.top"
      :fullscreen="createDlg.fullscreen"
      :close-on-click-modal="false"
      @closed="onCreateClosed"
    >
      <el-form
        ref="createFormRef"
        :model="createForm"
        :rules="quoteRules"
        label-width="100px"
      >
        <el-form-item label="零件">
          <el-input
            :model-value="partName ?? ''"
            disabled
            placeholder="当前零件"
          />
        </el-form-item>
        <el-form-item label="外协公司" prop="outsource_company_id">
          <el-select
            v-model="createForm.outsource_company_id"
            filterable
            style="width:100%"
          >
            <el-option
              v-for="c in companies"
              :key="c.id"
              :label="c.name"
              :value="c.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="工序(OUTSOURCE)" prop="process_id">
          <el-select
            v-model="createForm.process_id"
            filterable
            style="width:100%"
          >
            <el-option
              v-for="p in outsourceProcesses"
              :key="p.id"
              :label="`${p.code} ${p.name}`"
              :value="p.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="单价(元)" prop="price">
          <el-input v-model="createForm.price" type="number" :precision="2" :step="0.01" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="createForm.note" type="textarea" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createVisible = false">取消</el-button>
        <el-button
          type="primary"
          :loading="createSubmitting"
          @click="onCreateConfirm"
        >保存为 DRAFT</el-button>
      </template>
    </el-dialog>
  </el-card>
</template>

<script setup lang="ts">
import { computed, h, onMounted, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElTag, type FormInstance, type FormRules } from 'element-plus'
import { Document, Plus } from '@element-plus/icons-vue'
import { formatDateTime } from '@/utils/date'
import { useDialogSize } from '@/composables/useDialogSize'
import {
  resolveDraggable,
  useColumnVisibility,
  type ColumnDef,
} from '@/composables/useColumnVisibility'
import { columnIdentifier, useColumnDrag } from '@/composables/useColumnDrag'
import ColumnDragHandle from '@/components/ColumnDragHandle.vue'
import ColumnVisibilityPopover from '@/components/ColumnVisibilityPopover.vue'
import { OUTSOURCE_QUOTE_STATUS_LABEL, OUTSOURCE_QUOTE_STATUS_TAG, type OutsourceQuote } from '@/types/outsource'
import type { Process } from '@/types/process'
import type { OrderStatus } from '@/types/parts'
import type { QuoteCreateForm } from '../composables/usePartQuote'

const props = defineProps<{
  partId: string
  partName: string | null | undefined
  partStatus: OrderStatus
  quotes: OutsourceQuote[]
  quotesLoading: boolean
  canCreateQuoteBase: boolean
  quoteRules: FormRules
  /** 加载新建对话框所需的下拉数据；由父组件 usePartQuote 注入 */
  loadQuoteCreateData: () => Promise<{ companies: { id: string; name: string }[]; outsourceProcesses: Process[] }>
}>()

const emit = defineEmits<{
  (e: 'fetch'): void
  // 2026-08-25 T10p5：dialog 关闭延迟到 API 成功之后（避免 API 失败但 dialog 已关）。
  // shell 调 resolve(ok)：成功才关 dialog + reset submitting。
  (e: 'create', payload: { form: QuoteCreateForm; resolve: (ok: boolean) => void }): void
}>()

const router = useRouter()

/** 状态门控：MANAGER + CLERK 且 part.status ∈ {PENDING, IN_PROCESS, OUTSOURCE, READY_TO_SHIP, REPAIRING} */
const canCreateQuoteNow = computed(() => {
  if (!props.canCreateQuoteBase) return false
  const s = props.partStatus
  return (
    s === 'PENDING'
    || s === 'IN_PROCESS'
    || s === 'OUTSOURCE'
    || s === 'READY_TO_SHIP'
    || s === 'REPAIRING'
  )
})

// ============ 新建报价对话框（局部 UI 状态）============
const createDlg = useDialogSize({ desktopWidth: 640 })
const createVisible = ref(false)
const createSubmitting = ref(false)
const createFormRef = ref<FormInstance>()
const createForm = reactive<QuoteCreateForm>({
  outsource_company_id: '',
  process_id: '',
  price: '',
  note: '',
})

const companies = ref<{ id: string; name: string }[]>([])
const outsourceProcesses = ref<Process[]>([])

async function openCreateDialog() {
  createForm.outsource_company_id = ''
  createForm.process_id = ''
  createForm.price = ''
  createForm.note = ''
  try {
    const data = await props.loadQuoteCreateData()
    companies.value = data.companies
    outsourceProcesses.value = data.outsourceProcesses
  } catch (e) {
    ElMessage.error((e as Error).message ?? '加载下拉数据失败')
    return
  }
  createVisible.value = true
}

function onCreateClosed() {
  createForm.outsource_company_id = ''
  createForm.process_id = ''
  createForm.price = ''
  createForm.note = ''
}

async function onCreateConfirm() {
  if (!createFormRef.value) return
  try {
    await createFormRef.value.validate()
  } catch {
    return
  }
  createSubmitting.value = true
  // shell 调 resolve(ok)：成功才关 dialog + reset submitting。
  emit('create', {
    form: { ...createForm },
    resolve: (ok: boolean) => {
      createSubmitting.value = false
      if (ok) createVisible.value = false
    },
  })
}

function onViewQuoteDetail() {
  // PartDetail 上只读，编辑/审批/删除都走 /outsource/quote
  router.push('/outsource/quote')
}

// 2026-08-27 T23：列顺序拖动 + 可见性。
// 「操作」列固定右侧 → 不进 defs。
// 2026-08-27 修正：原生元素 children 不能传函数（Vue 3 会当 slots 处理 → 渲染为空），改为直接传值。
const columnDefs: ColumnDef[] = [
  {
    key: 'status', label: '状态', minWidth: 110, align: 'center',
    cellRender: ({ row }) => {
      const r = row as OutsourceQuote
      const tagType = (OUTSOURCE_QUOTE_STATUS_TAG[r.status] || 'info') as 'info' | 'success' | 'warning' | 'danger'
      return h(ElTag, { type: tagType, size: 'small', effect: 'plain' }, () => OUTSOURCE_QUOTE_STATUS_LABEL[r.status])
    },
  },
  {
    key: 'outsource_company_name', label: '外协公司', prop: 'outsource_company_name',
    minWidth: 140, showOverflowTooltip: true, align: 'center',
  },
  { key: 'process_code', label: '工序', prop: 'process_code', minWidth: 100, align: 'center' },
  {
    key: 'price', label: '单价(元)', minWidth: 100, align: 'right',
    cellRender: ({ row }) => h('span', null, (row as OutsourceQuote).price),
  },
  {
    key: 'created_at', label: '创建时间', minWidth: 160, align: 'center',
    cellRender: ({ row }) => h('span', { class: 'muted' }, formatDateTime((row as OutsourceQuote).created_at)),
  },
]
const columnVisibility = useColumnVisibility(columnDefs, { listKey: 'part_quote_card' })
const drag = useColumnDrag(columnDefs, { listKey: 'part_quote_card' })

// 2026-08-28 改造：传 el-table 实例 ref，composable 内部解析表头 + MutationObserver
// 自愈。组件挂载时 quotes=0 → tableRef.value=null → composable 不绑；quotes 加载后
// el-table 挂载 → ref 更新 → composable watch 重新归一化 + 表头首次渲染时自愈。
const tableRef = ref()
onMounted(() => {
  emit('fetch')
  drag.applyDrag(tableRef)
})
watch(() => props.partId, () => emit('fetch'))
</script>

<style lang="scss" scoped>
.quote-card {
  :deep(.el-card__body) {
    padding: 16px 20px;
  }
}
.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.card-title {
  font-weight: 600;
  color: var(--text-primary);
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.muted {
  color: var(--text-secondary);
}

// 2026-08-27 T23：列设置工具条（与 PartListShell 同款）
.table-toolbar {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 8px;
}
</style>
