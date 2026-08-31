<!-- 报价一览页 — 外协报价 CRUD + MANAGER 审批
     2026-07-16 重排：列头 popover 筛选 + 列头排序 + 分页 sizes
     2026-08-25 T13：拆为装配壳 + OutsourceQuoteTable + 3 个 dialog + 2 个 composables。
     本文件只保留：
       - 顶部 filter-card（keyword + 重置 + 共 N 条 + 新建按钮）
       - OutsourceQuoteTable（表格组件）
       - 3 个 dialog（create / approve+reject / drawing preview）
       - 图纸预览业务（ensureDrawing + previewDrawing + 缓存）
       - 页级 lookup 装载（processes / parts；companies-by-process 由 form composable 内调）
       - shell onMounted 编排（loadLookups → restore → refresh）
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage } from 'element-plus'
import { RefreshLeft, Search } from '@element-plus/icons-vue'
import { useAuthSession } from '@/composables/useAuthSession'
import { useCustomerTree } from '@/composables/useCustomerTree'
import { listProcesses } from '@/api/process'
import type { Process } from '@/types/process'
import { listPartFiles } from '@/api/assembly'
import { listQuotableParts } from '@/api/outsource'
import { api } from '@/api/http'
import type { PartFileItem } from '@/types/part_file'
import type { PartListItem } from '@/types/parts'
import { canCreate, rolesArrayToMap } from '@/utils/outsourceQuotePermissions'
import { useOutsourceQuoteTable } from './composables/useOutsourceQuoteTable'
import { useOutsourceQuoteForm } from './composables/useOutsourceQuoteForm'
import OutsourceQuoteTableComponent from './components/OutsourceQuoteTable.vue'
import OutsourceQuoteCreateDialog from './components/OutsourceQuoteCreateDialog.vue'
import OutsourceQuoteReviewDialog from './components/OutsourceQuoteReviewDialog.vue'
import OutsourceQuotePdfPreview from './components/OutsourceQuotePdfPreview.vue'

const { user } = useAuthSession()
const roleMap = computed(() => rolesArrayToMap(user.value?.roles ?? []))
const route = useRoute()
const { tree: customerTree } = useCustomerTree()

// ============================================================
// 列表 composable（search / sort / popover / 列可见性 / 行类名）
// ============================================================
const table = useOutsourceQuoteTable({ roleMap })

// ============================================================
// 表单 composable（create / approve / reject / delete / submit）
// 页级 parts / processes lookup 由 shell 装载，下放给 form composable。
// 表格刷新由 form composable 内部需要时调（创建 / 审批成功）
// ============================================================
const processes = ref<Process[]>([])
const parts = ref<PartListItem[]>([])
const allParts = ref<PartListItem[]>([])  // 未去重的全量（create 表单可能用）

/** PR-H 2026-07-28：dedupe picker 行（PR-fix-0.2.0）
 *  折叠同一 (part_id, next_process_id) 的多批次行。 */
function dedupeByPartProcess(rows: PartListItem[]): PartListItem[] {
  const seen = new Set<string>()
  const out: PartListItem[] = []
  for (const r of rows) {
    const key = `${r.id}::${r.next_process_id ?? 'null'}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(r)
  }
  return out
}

async function loadLookups(): Promise<void> {
  try {
    const ps = await listProcesses({ limit: 200 })
    processes.value = ps.items.filter((p) => p.category === 'OUTSOURCE')
    // PR-H 2026-07-28：新建报价 picker 改为「仅显示外协工序货架上的零件」
    // PR-fix-0.2.0 dedup：行=批次折叠到 (part_id, next_process_id)。
    const raw = await listQuotableParts({ limit: 500 })
    allParts.value = raw
    parts.value = dedupeByPartProcess(raw)
  } catch (e) {
    ElMessage.error((e as Error).message ?? '下拉数据加载失败')
  }
}

const form = useOutsourceQuoteForm({
  parts: () => allParts.value,
  processes: () => processes.value,
  refresh: table.refresh,
})

// ============================================================
// 图纸行内预览（2026-07-16）：行点击 / 图号链接 → 拉取该零件的 DRAWING
// → blob URL → 全屏 PDF / 图片预览
// ============================================================
const drawingPreviewVisible = ref(false)
const drawingPreviewUrl = ref<string | null>(null)
const drawingPreviewTitle = ref('图纸预览')
const drawingPreviewIsPdf = ref(false)
const drawingPreviewLoading = ref(false)
// 缓存：同一 part_id 重复点不重复拉取
const drawingCache = new Map<string, PartFileItem | null>()

const IMAGE_FILE_TYPES = new Set([
  'PNG', 'JPG', 'JPEG', 'GIF', 'BMP', 'TIF', 'TIFF', 'WEBP',
])
function isPdfType(t: string): boolean {
  return t.toUpperCase() === 'PDF'
}
function isImageType(t: string): boolean {
  return IMAGE_FILE_TYPES.has(t.toUpperCase())
}

async function ensureDrawing(partId: string): Promise<PartFileItem | null> {
  if (drawingCache.has(partId)) return drawingCache.get(partId) ?? null
  const files = await listPartFiles(partId, 'DRAWING')
  const f = files[0] ?? null
  drawingCache.set(partId, f)
  return f
}

async function previewDrawing(row: { part_id?: string; part_drawing_no?: string | null; part_name?: string | null }): Promise<void> {
  if (!row.part_id) return
  drawingPreviewLoading.value = true
  try {
    const f = await ensureDrawing(row.part_id)
    if (!f) {
      ElMessage.warning('该零件暂无图纸')
      return
    }
    const resp = await api.get<Blob>(
      `/files/${encodeURIComponent(f.id)}/content`,
      { responseType: 'blob' },
    )
    if (drawingPreviewUrl.value) URL.revokeObjectURL(drawingPreviewUrl.value)
    drawingPreviewUrl.value = URL.createObjectURL(resp.data)
    drawingPreviewTitle.value = `图纸预览 — ${row.part_drawing_no ?? ''} / ${row.part_name ?? ''}`
    drawingPreviewIsPdf.value = isPdfType(f.file_type)
    drawingPreviewVisible.value = true
  } catch (e) {
    ElMessage.error((e as Error).message ?? '图纸加载失败')
  } finally {
    drawingPreviewLoading.value = false
  }
}

function closeDrawingPreview(): void {
  drawingPreviewVisible.value = false
  if (drawingPreviewUrl.value) {
    URL.revokeObjectURL(drawingPreviewUrl.value)
    drawingPreviewUrl.value = null
  }
}

onBeforeUnmount(() => {
  if (drawingPreviewUrl.value) URL.revokeObjectURL(drawingPreviewUrl.value)
})

// ============================================================
// 操作列路由：OutsourceQuoteTable emit('action') → form composable
// ============================================================
function onTableAction(payload: { type: 'submit' | 'approve' | 'reject' | 'delete'; row: import('@/types/outsource').OutsourceQuote }): void {
  if (payload.type === 'submit') void form.onSubmit(payload.row)
  else if (payload.type === 'approve') form.openApprove(payload.row)
  else if (payload.type === 'reject') form.openReject(payload.row)
  else if (payload.type === 'delete') void form.onDelete(payload.row)
}

// ============================================================
// 初始化：lookup → restore → refresh
// ============================================================
onMounted(async () => {
  await loadLookups()
  table.restore(route.query.statuses)
  await table.refresh()
})

// 模板里需要的别名（columnVisibility 已下沉到 OutsourceQuoteTable）
const search = table.search
const pagedRef = table.pagedRef
</script>

<template>
  <div class="page">
    <!-- 顶部 filter-card：仅保留 keyword + 重置 + 共 N 条 + 新建 -->
    <el-card shadow="never" class="filter-card">
      <div class="filter-row">
        <el-input
          v-model="search.keyword"
          placeholder="序列号 / 图号 / 名称（前缀搜索）"
          clearable
          style="width: 280px"
          @keyup.enter="table.onSearch"
          @clear="table.onSearch"
        >
          <template #prefix>
            <el-icon><Search /></el-icon>
          </template>
        </el-input>

        <el-button @click="table.onReset">
          <el-icon><RefreshLeft /></el-icon>
          <span>重置</span>
        </el-button>

        <el-button
          v-if="canCreate(roleMap)"
          type="success"
          @click="form.openCreate"
        >
          新建报价
        </el-button>

        <span v-if="pagedRef?.total && pagedRef.total > 0" class="total-hint">共 {{ pagedRef.total }} 条</span>
      </div>
    </el-card>

    <el-card shadow="never">
      <OutsourceQuoteTableComponent
        :ctx="{
          table,
          roleMap,
          customerTree,
        }"
        @row-click="previewDrawing"
        @preview-drawing="previewDrawing"
        @action="onTableAction"
      />
    </el-card>

    <!-- 新建 DRAFT 报价 -->
    <OutsourceQuoteCreateDialog
      :model-value="form.showCreate.value"
      :form="form.createForm"
      :rules="form.createRules"
      :parts="parts"
      :processes="processes"
      :companies="form.companies.value"
      :companies-loading="form.companiesLoading.value"
      @update:model-value="(v: boolean) => (form.showCreate.value = v)"
      @update:part-id="(v: string) => (form.createForm.part_id = v)"
      @update:process-id="(v: string) => (form.createForm.process_id = v)"
      @update:company-id="(v: string) => (form.createForm.outsource_company_id = v)"
      @update:price="(v: string) => (form.createForm.price = v)"
      @update:note="(v: string) => (form.createForm.note = v)"
      @form-ref="(el) => { form.createFormRef.value = el ?? undefined }"
      @part-change="form.onCreatePartChange"
      @confirm="form.onCreate"
    />

    <!-- 通过 -->
    <OutsourceQuoteReviewDialog
      :model-value="form.showApprove.value"
      mode="approve"
      :review-note="form.reviewNote.value"
      @update:model-value="(v: boolean) => (form.showApprove.value = v)"
      @update:note="(v: string) => (form.reviewNote.value = v)"
      @confirm="form.onApprove"
    />

    <!-- 拒绝 -->
    <OutsourceQuoteReviewDialog
      :model-value="form.showReject.value"
      mode="reject"
      :review-note="form.reviewNote.value"
      @update:model-value="(v: boolean) => (form.showReject.value = v)"
      @update:note="(v: string) => (form.reviewNote.value = v)"
      @confirm="form.onReject"
    />

    <!-- 图纸行内预览（2026-07-16） -->
    <OutsourceQuotePdfPreview
      :model-value="drawingPreviewVisible"
      :url="drawingPreviewUrl"
      :title="drawingPreviewTitle"
      :is-pdf="drawingPreviewIsPdf"
      @update:model-value="(v: boolean) => (drawingPreviewVisible = v)"
      @close="closeDrawingPreview"
    />
  </div>
</template>

<style lang="scss" scoped>
.page {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.filter-card {
  :deep(.el-card__body) {
    padding: 12px 16px;
  }
}

.filter-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.total-hint {
  font-size: 13px;
  color: var(--text-secondary);
  margin-left: auto;
}
</style>