<!-- 报价一览页 — 外协报价 CRUD + 报价审批（`outsource.quote.approve` 权限点）

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
     业务（ensureDrawing + previewDrawing + 转图轮询 + blob 缓存）、3 个 dialog 的挂载。

     2026-10-13 图纸预览切 CI 转图直链：
     - PDF 的**首选**渲染路径是 `GET /files/objects/{id}/preview` → 逐页图片直链 →
       `OutsourceQuotePdfPreview` 里的 `<ImagePager>`；`/content` blob 降级为
       「查看原始 PDF」逃生口 + 转图不可用时的自动兜底。
     - 图片类文件不参与转图，仍是 blob → el-image。
     - 降级原因以 `degradeHint` 传进弹窗渲染成一行提示，不静默换渲染路径。
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessage } from 'element-plus';
import { RefreshLeft } from '@element-plus/icons-vue';
import { listProcesses } from '@/api/process';
import { listQuotableParts } from '@/api/outsource';
import { fetchPartFileContent, listPartFilesByOwner } from '@/api/files/objects';
import { usePreviewPolling } from '@/composables/usePreviewPolling';
import { canCreate } from '@/utils/outsourceQuotePermissions';
import { useOutsourceQuoteListStore } from './composables/useOutsourceQuoteListStore';
import { useOutsourceQuoteForm } from './composables/useOutsourceQuoteForm';
import type { OutsourceQuoteSchema } from './composables/outsourceListSchema';
import OutsourceQuoteTableComponent from './components/OutsourceQuoteTable.vue';
import OutsourceQuoteCreateDialog from './components/OutsourceQuoteCreateDialog.vue';
import OutsourceQuoteReviewDialog from './components/OutsourceQuoteReviewDialog.vue';
import OutsourceQuotePdfPreview from './components/OutsourceQuotePdfPreview.vue';
import type { Process } from '@/types/process';
import type { OutsourceQuote, QuotablePart } from '@/types/outsource';
import type { PartFileItem } from '@/types/part_file';

const route = useRoute();
// store 必须在壳 setup 内首调（不变量 #1：切片链路上的 onBeforeUnmount 会绑到本组件）。
const store = useOutsourceQuoteListStore();
const form = useOutsourceQuoteForm();

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
// 图纸行内预览：行点击 / 图号链接 → 该零件的 DRAWING → CI 转图直链（或原始 PDF blob）
// ============================================================
const drawingPreviewVisible = ref(false);
const drawingPreviewUrl = ref<string | null>(null);
const drawingPreviewTitle = ref('图纸预览');
const drawingPreviewIsPdf = ref(false);
const drawingPreviewLoading = ref(false);
// 2026-10-13：用户在图片模式下点「查看原始 PDF」。
const drawingShowOriginal = ref(false);
// 缓存：同一 part_id 重复点不重复拉取
const drawingCache = new Map<string, PartFileItem | null>();

function isPdfType(t: string): boolean {
  return t.toUpperCase() === 'PDF';
}

/**
 * CI 转图轮询（2026-10-13）。只有 PDF 才有转图可言；弹窗关着时不轮询。
 * `drawingPreviewFile` 存的是**文件对象 id 所在的 PartFileItem**，预览端点只认它。
 */
const drawingPreviewFile = ref<PartFileItem | null>(null);
const preview = usePreviewPolling({
  fileId: () =>
    drawingPreviewFile.value && isPdfType(drawingPreviewFile.value.file_type)
      ? drawingPreviewFile.value.id
      : '',
  enabled: () => drawingPreviewVisible.value,
});

async function ensureDrawing(partId: string): Promise<PartFileItem | null> {
  if (drawingCache.has(partId)) return drawingCache.get(partId) ?? null;
  // v2 /files/objects?owner_id=…&kind=…（owner 多态）
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
    drawingPreviewFile.value = f;
    drawingShowOriginal.value = false;
    drawingPreviewTitle.value = `图纸预览 — ${row.part_drawing_no ?? ''} / ${row.part_name ?? ''}`;
    drawingPreviewIsPdf.value = isPdfType(f.file_type);
    // PDF 不预拉 blob：先走转图，用户点「查看原始 PDF」或转图降级时再拉。
    // 提前拉会让「图片模式省带宽」当场作废。图片类文件仍是 blob → el-image。
    if (!drawingPreviewIsPdf.value) await loadDrawingBlob(f);
    drawingPreviewVisible.value = true;
  } catch (e) {
    ElMessage.error((e as Error).message ?? '图纸加载失败');
  } finally {
    drawingPreviewLoading.value = false;
  }
}

/** 拉原始 PDF 的 blob URL（原始 PDF 模式共用；caller 负责 revoke）。 */
async function loadDrawingBlob(f: PartFileItem): Promise<void> {
  const blob = await fetchPartFileContent(f.id);
  if (drawingPreviewFile.value?.id !== f.id) return; // 期间换了行 ⇒ 丢弃
  if (drawingPreviewUrl.value) URL.revokeObjectURL(drawingPreviewUrl.value);
  drawingPreviewUrl.value = URL.createObjectURL(blob);
}

/**
 * PDF 的原始 PDF 路径有两条触发：用户点「查看原始 PDF」，或转图轮询降级。
 * 二者合并成一条 watch —— 降级那一刻的表现与用户主动切换完全一致。
 *
 * ⚠️ 模板上的 `:pages` 传的是 `drawingShowOriginal ? [] : preview.pages.value` 而不是
 * 直接传 `preview.pages.value`：那个子组件用「pages 非空」判图片模式，而转图 ready
 * 之后 pages 就一直非空，直接传会让「查看原始 PDF」变成**空操作** —— 点击确实触发了
 * 本 watch 的 blob 拉取，但子组件仍停在图片模式分支上，用户看不到任何变化。
 */
watch(
  [drawingPreviewFile, drawingShowOriginal, preview.degraded],
  async ([f, wantOriginal, degraded]) => {
    if (!f || !isPdfType(f.file_type)) return;
    if (!wantOriginal && !degraded) return;
    try {
      await loadDrawingBlob(f);
    } catch (e) {
      ElMessage.error((e as Error).message ?? '加载原始 PDF 失败');
    }
  },
  { immediate: true },
);

/**
 * 「有东西在路上」的文案，传给弹窗的 `busyHint`。
 *
 * 判据与弹窗那三条分支一一对应：**两条路都还没有可渲染的东西**时给提示，null 才表示
 * 真的没有可预览内容。分两档是因为它们在说不同的事：转图在等 CI，「查看原始 PDF」
 * 已点、blob 在路上 —— 混成一句会让工人以为点按钮没用。
 *
 * ⚠️ 「已决定看原始 PDF」这一档的判据必须**同时**看 `drawingShowOriginal` 与
 * `preview.degraded`：降级那一刻 loading 已经落回 false，只认它的话会一路返回 null，
 * 于是 `pages=[]` + `url=null` + `busyHint=null` 正好落进子组件的「无可预览内容」，
 * 而它正上方的 `.degrade-hint` 写的是「已改用原始 PDF 预览」—— 两句话自相矛盾，
 * 且 `/content` 失败时会永久停在这里。其余五处承载点靠
 * `wantsOriginalPdf = showOriginalPdf || preview.degraded` 天然覆盖这一档，
 * 只有这条受控 props 形态要在 caller 侧手写判据，手写就容易漏。
 */
const drawingBusyHint = computed<string | null>(() => {
  if (!drawingPreviewIsPdf.value) return null;
  if (drawingShowOriginal.value || preview.degraded.value) {
    return drawingPreviewUrl.value ? null : '加载原始 PDF…';
  }
  return preview.loading.value ? '图纸转图中…' : null;
});

function closeDrawingPreview(): void {
  drawingPreviewVisible.value = false;
  if (drawingPreviewUrl.value) {
    URL.revokeObjectURL(drawingPreviewUrl.value);
    drawingPreviewUrl.value = null;
  }
  drawingPreviewFile.value = null;
  drawingShowOriginal.value = false;
  preview.stop();
}

// ============================================================
// 操作列路由：OutsourceQuoteTable emit('action') → form composable
// ============================================================
// 行类型走 `OutsourceQuoteSchema`（表格 `emit('action')` 的 row 就是它）。表单包装收的是
// `OutsourceQuote`（`@/types/outsource`），两者字段同构、只差 `status` 的宽度：schema 按
// `z.string()` 收（DB 里存着 legacy 值，见 outsourceListSchema.ts），类型是活跃值 + legacy
// 的联合。这一处显式 cast，不把 payload 标成 `any`。
function onTableAction(payload: {
  type: 'submit' | 'approve' | 'reject' | 'delete';
  row: OutsourceQuoteSchema;
}): void {
  const row = payload.row as OutsourceQuote;
  if (payload.type === 'submit') void form.onSubmit(row);
  else if (payload.type === 'approve') form.openApprove(row);
  else if (payload.type === 'reject') form.openReject(row);
  else void form.onDelete(row);
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
  preview.stop();
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
      :pages="drawingShowOriginal ? [] : preview.pages.value"
      :degrade-hint="preview.degradedReason.value"
      :busy-hint="drawingBusyHint"
      @update:model-value="(v: boolean) => (drawingPreviewVisible = v)"
      @close="closeDrawingPreview"
      @viewOriginal="drawingShowOriginal = true"
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
