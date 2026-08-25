<!--
  PartQuoteCard.vue

  外协报价卡（PartDetail 第 8 张卡）：
  - 仅当 canViewQuotes 为真时由 shell 渲染
  - 报价列表（来自 usePartQuote.fetchQuotes）
  - 新建报价对话框（form ref 局部维护，提交 emit create）
  - 状态门控的「新建」按钮
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
      :data="quotes"
      size="small"
      border
      stripe
    >
      <el-table-column label="状态" min-width="110" align="center">
        <template #default="{ row }">
          <el-tag
            :type="(OUTSOURCE_QUOTE_STATUS_TAG[(row as OutsourceQuote).status] || 'info') as 'info' | 'success' | 'warning' | 'danger'"
            size="small"
            effect="plain"
          >
            {{ OUTSOURCE_QUOTE_STATUS_LABEL[(row as OutsourceQuote).status] }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column
        prop="outsource_company_name"
        label="外协公司"
        min-width="140"
        show-overflow-tooltip align="center"/>
      <el-table-column prop="process_code" label="工序" min-width="100" align="center"/>
      <el-table-column label="单价(元)" min-width="100" align="right">
        <template #default="{ row }">{{ (row as OutsourceQuote).price }}</template>
      </el-table-column>
      <el-table-column label="创建时间" min-width="160" align="center">
        <template #default="{ row }">
          <span class="muted">{{ formatDateTime((row as OutsourceQuote).created_at) }}</span>
        </template>
      </el-table-column>
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
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, type FormInstance, type FormRules } from 'element-plus'
import { Document, Plus } from '@element-plus/icons-vue'
import { formatDateTime } from '@/utils/date'
import { useDialogSize } from '@/composables/useDialogSize'
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
  (e: 'create', form: QuoteCreateForm): void
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
  try {
    emit('create', { ...createForm })
    createVisible.value = false
  } finally {
    createSubmitting.value = false
  }
}

function onViewQuoteDetail() {
  // PartDetail 上只读，编辑/审批/删除都走 /outsource/quote
  router.push('/outsource/quote')
}

onMounted(() => emit('fetch'))
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
</style>
