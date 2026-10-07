<!-- 报价一览页 — 外协报价 CRUD + MANAGER 审批

     2026-10-09 重构（列表交互 + 迁 TanStack Query + 表头筛选）：
     - 列表状态从 `useOutsourceQuoteTable()` composable + `OutsourceQuoteTable` 的
       `:ctx` prop 模式改为 Pinia store `useOutsourceQuoteListStore`（与外协公司一览 /
       外协对账页统一）；子组件直接消费 store。
     - 主查询改走域内 query hook `useOutsourceQuotesQuery`，page / pageSize / 筛选 /
       排序全部进 queryKey。
     - 表头筛选补齐：图号（`drawing_no`）、名称（`name`）、外协公司（等值下拉）、
       状态（EP 原生 `:filters` → `statuses[]`）；客户沿用原有 popover 形态但换成共享
       `ColumnFilterPopover` 外壳。顶部 filter 卡收缩为「新建 + 重置筛选 + 共 N 条」。
     - 六条写路径（create / submit / approve / reject / soft-delete）全部走 useMutation
       + 失效；`submit` 与 `soft-delete` **必传 `version`**（后端本轮设为必填）。
     - 新建表单校验从 el-form `FormRules` 换成 Zod（`OutsourceQuoteFormSchema.ts`）。

     仍留在本页壳里的：页级 lookup（OUTSOURCE 工序列表 / 可报价零件 picker）、图纸预览
     业务（ensureDrawing + previewDrawing + blob 缓存）、3 个 dialog 的挂载。
-->
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessage } from 'element-plus';
import { RefreshLeft } from '@element-plus/icons-vue';
import { listProcesses } from '@/api/process';
import { listQuotableParts } from '@/api/outsource';
import { listPartFilesByOwner } from '@/api/assembly';
import { api } from '@/api/http';
import { canCreate } from '@/utils/outsourceQuotePermissions';
import { useOutsourceQuoteListStore } from './composables/useOutsourceQuoteListStore';
import { useOutsourceQuoteForm } from './composables/useOutsourceQuoteForm';
import type { OutsourceQuoteSchema } from './composables/outsourceListSchema';
import OutsourceQuoteTableComponent from './components/OutsourceQuoteTable.vue';
import OutsourceQuoteCreateDialog from './components/OutsourceQuoteCreateDialog.vue';
import OutsourceQuoteReviewDialog from './components/OutsourceQuoteReviewDialog.vue';
import OutsourceQuotePdfPreview from './components/OutsourceQuotePdfPreview.vue';
import type { Process } from '@/types/process';
import type { QuotablePart } from '@/types/outsource';
import type { PartFileItem } from '@/types/part_file';

const route = useRoute();
// store 必须在壳 setup 内首调（不变量 #1：切片链路上的 onBeforeUnmount 会绑到本组件）。
const store = useOutsourceQuoteListStore();
const form = useOutsourceQuoteForm({ refresh: store.query.fetchList });

// ============================================================
// 页级 lookup：OUTSOURCE 工序列表 + 可报价零件 picker
// ============================================================
const processes = ref<Process[]>([]);
// picker 候选源 —— 「有活跃 PENDING 批次的零件」，一零件一行。
const parts = ref<QuotablePart[]>([]);

async function loadLookups(): Promise<void> {
  // 拆成两段独立 try —— 一个 try 包两个 await 时 quotable-parts 失败会把已成功的
  // processes 结果一起废掉（且报错文案笼统，操作员分不清是哪个下拉空了）。
  try {
    const ps = await listProcesses({ limit: 200 });
    processes.value = ps.items.filter((p) => p.category === 'OUTSOURCE');
  } catch (e) {
    ElMessage.error((e as Error).message ?? '工序数据加载失败');
  }
  try {
    const r = await listQuotableParts({ limit: 500 });
    parts.value = r.items;
  } catch (e) {
    ElMessage.error((e as Error).message ?? '可报价零件加载失败');
  }
}

// ============================================================
// 图纸行内预览：行点击 / 图号链接 → 该零件的 DRAWING → blob URL → 全屏预览
// ============================================================
const drawingPreviewVisible = ref(false);
const drawingPreviewUrl = ref<string | null>(null);
const drawingPreviewTitle = ref('图纸预览');
const drawingPreviewIsPdf = ref(false);
const drawingPreviewLoading = ref(false);
// 缓存：同一 part_id 重复点不重复拉取
const drawingCache = new Map<string, PartFileItem | null>();

function isPdfType(t: string): boolean {
  return t.toUpperCase() === 'PDF';
}

async function ensureDrawing(partId: string): Promise<PartFileItem | null> {
  if (drawingCache.has(partId)) return drawingCache.get(partId) ?? null;
  // v2 /part-files?owner_id=…&kind=…（owner 多态）
  const files = (await listPartFilesByOwner(partId, 'DRAWING')).items;
  const f = files[0] ?? null;
  drawingCache.set(partId, f);
  return f;
}

async function previewDrawing(row: OutsourceQuoteSchema): Promise<void> {
  drawingPreviewLoading.value = true;
  try {
    const f = await ensureDrawing(row.part_id);
    if (!f) {
      ElMessage.warning('该零件暂无图纸');
      return;
    }
    // v2 无 /files/* 路由，文件内容走 /part-files/{id}/content
    const resp = await api.get<Blob>(`/part-files/${encodeURIComponent(f.id)}/content`, {
      responseType: 'blob',
    });
    if (drawingPreviewUrl.value) URL.revokeObjectURL(drawingPreviewUrl.value);
    drawingPreviewUrl.value = URL.createObjectURL(resp.data);
    drawingPreviewTitle.value = `图纸预览 — ${row.part_drawing_no ?? ''} / ${row.part_name ?? ''}`;
    drawingPreviewIsPdf.value = isPdfType(f.file_type);
    drawingPreviewVisible.value = true;
  } catch (e) {
    ElMessage.error((e as Error).message ?? '图纸加载失败');
  } finally {
    drawingPreviewLoading.value = false;
  }
}

function closeDrawingPreview(): void {
  drawingPreviewVisible.value = false;
  if (drawingPreviewUrl.value) {
    URL.revokeObjectURL(drawingPreviewUrl.value);
    drawingPreviewUrl.value = null;
  }
}

// ============================================================
// 操作列路由：OutsourceQuoteTable emit('action') → form composable
// ============================================================
function onTableAction(payload: { type: 'submit' | 'approve' | 'reject' | 'delete'; row: any }): void {
  if (payload.type === 'submit') void form.onSubmit(payload.row);
  else if (payload.type === 'approve') form.openApprove(payload.row);
  else if (payload.type === 'reject') form.openReject(payload.row);
  else void form.onDelete(payload.row);
}

onMounted(async () => {
  // 图号点击 → 预览图纸的回调注入 store（弹窗与 blob 逻辑留在壳，store 不碰 DOM）。
  store.registerPreviewDrawing((row) => void previewDrawing(row));
  // restoreState 末尾开 enabled 闸（首屏只发一次请求）。
  store.query.restoreState(route.query.statuses);
  await Promise.all([loadLookups(), store.options.loadCompanyOptions()]);
});

onBeforeUnmount(() => {
  if (drawingPreviewUrl.value) URL.revokeObjectURL(drawingPreviewUrl.value);
  store.$dispose();
});
</script>

<template>
  <div class="page">
    <!-- 顶部 filter 卡：筛选全部搬进表头，这里只留「新建报价 + 重置筛选 + 共 N 条」 -->
    <el-card shadow="never" class="filter-card">
      <div class="filter-row">
        <el-button v-if="canCreate(store.roleMap)" type="success" @click="form.openCreate">
          新建报价
        </el-button>
        <el-button @click="store.query.resetAllFilters">
          <el-icon><RefreshLeft /></el-icon><span>重置筛选</span>
        </el-button>
        <span v-if="store.query.total > 0" class="total-hint">共 {{ store.query.total }} 条</span>
      </div>
    </el-card>

    <el-card shadow="never">
      <OutsourceQuoteTableComponent @row-click="previewDrawing" @action="onTableAction" />
    </el-card>

    <!-- 新建 DRAFT 报价 -->
    <OutsourceQuoteCreateDialog
      :model-value="form.showCreate.value"
      :form="form.createForm"
      :field-errors="form.createFieldErrors.value"
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
      @partChange="form.onCreatePartChange"
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

    <!-- 图纸行内预览 -->
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
.filter-card :deep(.el-card__body) {
  padding: 12px 16px;
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