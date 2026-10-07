<!--
  打印送货单对话框（2026-10-08 重写）。

  相对 2026-08 的旧版（调后端 /print 转发 python）三处根本变化：
  1. **xlsx 由前端本地生成**（hucre，动态 import）：模板由用户上传，逐格校验后
     才允许导出；后端两条打印端点已下线。
  2. **按分厂分组（el-tabs）**：一张送货单一个收货单位，按送货分组规则（或未分组 L2）
     分组，每组一个 tab / 一个 sheet，每 sheet 最多 10 条。
  3. **表头排序 + 行拖拽 + 行拆分 + 列拖拽**共存，行拖拽会清掉排序标记（自定义顺序优先）。

  交互契约：
  · 每个 tab 一张独立 el-table（子组件 `PrintGroupTable`）—— Sortable 绑的是 EP 内部
    渲染出的 `<tbody>`，多 tab 复用同一个实例会把 A 表的拖拽算到 B 表的下标上；
  · tab 顺序 = 分组键在 `line_items` 中**首次出现**的顺序；
  · tab name = groupKey（`g_<gid>` / `c_<l2id>` 语义字符串，非索引）；
  · 表头排序走 EP 内置比较 + 客户端 `sortPrintRows`，`prop` 是 snake_case 字段名本身；
  · 数量列**只读**，要改必须走行尾「拆分」（守恒校验在 PrintSplitEditor 里）；
  · 司机变更立即落库（`POST /com/delivery/note/{id}/driver`）。
-->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { useDialogSize } from '@/composables/useDialogSize';
import { useColumnVisibility } from '@/composables/useColumnVisibility';
import { useQueryClient } from '@tanstack/vue-query';
import ColumnVisibilityPopover from '@/components/ColumnVisibilityPopover.vue';
import { triggerBrowserDownload } from '@/utils/download';
import { setNoteDriver } from '@/api/com/deliveryNote';
import { useDeliveryDriversQuery } from '../composables/useDeliveryDriversQuery';
import { useDeliveryGroupsQuery } from '../composables/useDeliveryGroupsQuery';
import { invalidateDeliveryNotesQuery } from '../composables/useDeliveryNoteListStore';
import {
  buildDeliveryNotePrintColumnDefs,
  PRINT_PREVIEW_LIST_KEY,
} from '../deliveryNotePrintColumnDefs';
import type { DeliveryNoteLineItemData } from '../composables/deliveryNoteSchema';
import PrintGroupTable from './PrintGroupTable.vue';
import {
  assertTemplateMatches,
  fetchTemplateBytes,
  type TemplateSource,
} from '../utils/deliveryNoteTemplate';
import {
  buildL2GroupMap,
  groupIntoSheets,
  groupRows,
  safeSheetName,
  type PrintGroupRef,
  type PrintRow,
} from '../utils/deliveryNotePrintRows';
import { renderDeliveryNoteWorkbook, XLSX_MIME } from '../utils/deliveryNoteWorkbook';
import { DELIVERY_NOTE_TEMPLATE_CONTRACT } from '../utils/deliveryNoteTemplateContract';

const props = defineProps<{
  modelValue: boolean;
  note: {
    id: string;
    version: number;
    delivery_note_no: string;
    part_count: number;
    /** 单据归属的 L1 客户 id —— 送货分组查询的入参（打印时才知道有没有分组规则）。 */
    customer_id: string;
    driver_worker_name: string | null;
    line_items: readonly DeliveryNoteLineItemData[];
  };
}>();

const emit = defineEmits<{ 'update:modelValue': [v: boolean] }>();

const dlg = useDialogSize({ desktopWidth: 1200 });
const qc = useQueryClient();

// ============================================================
// 模板（用户上传 + 逐格校验）
// ============================================================
const uploadRef = ref<{ clearFiles: () => void } | null>(null);
const templateSource = ref<TemplateSource | null>(null);
const templateName = ref('');
const templateDiffs = ref<string[]>([]);
const templateLoading = ref(false);

const templateOk = computed(() => templateSource.value !== null && templateDiffs.value.length === 0);

/** el-upload 的 `:limit="1"` 意味着第二次选同一文件不触发 on-change；
 *  必须先 clearFiles() 清掉内部列表（仓内同款注释见 PurchaseOrderImportDialog）。 */
function onExceed(): void {
  uploadRef.value?.clearFiles();
}

async function onFileChange(file: { raw?: File; name?: string }): Promise<void> {
  if (!file?.raw) return;
  templateLoading.value = true;
  templateDiffs.value = [];
  try {
    const bytes = new Uint8Array(await file.raw.arrayBuffer());
    const src: TemplateSource = { kind: 'local', bytes, filename: file.name ?? 'template.xlsx' };
    const { openXlsx } = await import('hucre');
    templateDiffs.value = await assertTemplateMatches(await openXlsx(bytes));
    templateName.value = src.filename;
    // 校验不过就不留字节：导出按钮已经 disabled，留着只会让人以为「换模板」这一步过了。
    templateSource.value = templateDiffs.value.length === 0 ? src : null;
    if (templateDiffs.value.length === 0) ElMessage.success('模板校验通过');
  } catch (e) {
    templateSource.value = null;
    templateName.value = file.name ?? '';
    templateDiffs.value = [`模板解析失败：${(e as Error).message}`];
  } finally {
    templateLoading.value = false;
  }
}

// ============================================================
// 司机
// ============================================================
const driverQuery = useDeliveryDriversQuery(computed(() => props.modelValue));
const driverId = ref<string>('');
const driverSaving = ref(false);

const hasDriver = computed(() => Boolean(props.note.driver_worker_name));
const selectedDriverName = computed(
  () => driverQuery.drivers.value.find((d) => d.id === driverId.value)?.name ?? null,
);

async function onDriverChange(): Promise<void> {
  const id = driverId.value;
  if (!id) return;
  driverSaving.value = true;
  try {
    await setNoteDriver(props.note.id, { version: props.note.version, driver_worker_id: id });
    await invalidateDeliveryNotesQuery(qc);
    ElMessage.success('已指定司机');
  } catch (e) {
    ElMessage.error((e as Error).message ?? '指定司机失败');
  } finally {
    driverSaving.value = false;
  }
}

// ============================================================
// 装配件合并模式
// ============================================================
const hasAssemblies = computed(() => props.note.line_items.some((li) => li.assembly_id));
/** 默认「合并一套」：装配件子件逐行打会让收货人收到一堆看不懂的子件。 */
const mergeMode = ref<'merge' | 'separate'>('merge');

// ============================================================
// 分组（el-tabs）
// ============================================================
// 分组规则来自 `GET /com/delivery/group?customer_id=<L1>`：分组内的 L2 按组名归堆，
// 未分组的 L2 **各自一 sheet**（按 L2 拆单是收货习惯，合成一张收货人找不到自己那批）。
const groupsQuery = useDeliveryGroupsQuery(
  computed(() => (props.modelValue ? props.note.customer_id : '')),
);

const groupsByKey = computed(() =>
  groupRows(props.note.line_items, buildL2GroupMap(groupsQuery.data.value), mergeMode.value),
);

const tabs = computed<PrintGroupRef[]>(() => [...groupsByKey.value.values()].map((v) => v.ref));
const activeTab = ref<string>('');

/** 每 tab 的行数组 / 排序态（key = groupKey）。子组件只发事件，写回集中在这里。 */
const rowsByKey = ref<Record<string, PrintRow[]>>({});
const sortModeByKey = ref<Record<string, 'column' | 'custom'>>({});

// 打开 / mergeMode / 分组数据变化 → 重建各 tab 的行（拷贝，拖拽与排序只动副本）。
watch(
  () => [props.modelValue, mergeMode.value, groupsQuery.data.value] as const,
  ([open]) => {
    if (!open) return;
    const rows: Record<string, PrintRow[]> = {};
    const sorts: Record<string, 'column' | 'custom'> = {};
    for (const [key, { rows: r }] of groupsByKey.value) {
      rows[key] = r.map((x) => ({ ...x }));
      sorts[key] = 'column';
    }
    rowsByKey.value = rows;
    sortModeByKey.value = sorts;
    if (!rowsByKey.value[activeTab.value]) activeTab.value = tabs.value[0]?.groupKey ?? '';
  },
  { immediate: true },
);

function rowsOf(groupKey: string): PrintRow[] {
  return rowsByKey.value[groupKey] ?? [];
}

function setRows(groupKey: string, next: PrintRow[]): void {
  rowsByKey.value = { ...rowsByKey.value, [groupKey]: next };
}

function setSortMode(groupKey: string, mode: 'column' | 'custom'): void {
  sortModeByKey.value = { ...sortModeByKey.value, [groupKey]: mode };
}

function tabNameOf(groupKey: string): string {
  return tabs.value.find((t) => t.groupKey === groupKey)?.groupName ?? groupKey;
}

const totalRows = computed(() =>
  Object.values(rowsByKey.value).reduce((sum, rows) => sum + rows.length, 0),
);

/** sheet 分配（容量 / 跨组不混 / sheet 名清洗都在纯函数里，这里只做组装）。 */
const sheets = computed(() =>
  groupIntoSheets(
    new Map(
      Object.entries(rowsByKey.value).map(([k, rows]) => [
        k,
        { ref: { groupKey: k, groupName: tabNameOf(k) }, rows },
      ]),
    ),
    DELIVERY_NOTE_TEMPLATE_CONTRACT.dataRowCount,
  ),
);

// ============================================================
// 列可见性（快照 key = print_preview_dialog，既有值不许改）
// ============================================================
// 列可见性是**对话框级**偏好（N 张表共用一份快照，key 沿用既有 `print_preview_dialog`）；
// 列**顺序**是**每张表**一份（快照 key = `print_preview_dialog__<groupKey>`，见
// deliveryNotePrintColumnDefs::printColumnOrderListKey）—— 一个序列表达不了 N 张表的
// 列顺序，用户拖 A 表的列不该牵动 B 表。老版本那条单序列
// `print_preview_dialog_columnOrder` 随之作废，不可迁移。
const columnDefs = buildDeliveryNotePrintColumnDefs();
const columnVisibility = useColumnVisibility(columnDefs, { listKey: PRINT_PREVIEW_LIST_KEY });
/** 「重置列顺序」信号量：popover 只有一颗按钮，作用在全部 N 张表上。 */
const resetOrderToken = ref(0);

// ============================================================
// 导出
// ============================================================
const exporting = ref(false);
const exportDisabled = computed(
  () => !templateOk.value || exporting.value || totalRows.value === 0 || !driverNameOfExport.value,
);

const driverNameOfExport = computed(
  () => selectedDriverName.value ?? props.note.driver_worker_name ?? '',
);

/** 「导出」disabled 的原因（tooltip 显示；空串 = 可导出）。 */
const exportHint = computed(() => {
  if (!templateOk.value) {
    return templateDiffs.value.length > 0
      ? `模板校验未通过：${templateDiffs.value.join('；')}`
      : '请先上传送货单模板';
  }
  if (totalRows.value === 0) return '没有可打印的行项';
  if (!driverNameOfExport.value) return '请先指定司机（页脚「送货人」与 pickup 都要它）';
  return '';
});

function todayParts(): { year: string; month: string; date: string } {
  const d = new Date();
  return {
    year: String(d.getFullYear()),
    month: String(d.getMonth() + 1),
    date: String(d.getDate()),
  };
}

async function onExport(): Promise<void> {
  const src = templateSource.value;
  if (!src || exportDisabled.value) return;
  exporting.value = true;
  try {
    const bytes = await fetchTemplateBytes(src);
    const { openXlsx } = await import('hucre');
    // 导出前再校验一次：用户在「上传 → 导出」之间可能又传了别的模板，或文件被外部覆盖。
    const diffs = await assertTemplateMatches(await openXlsx(bytes));
    if (diffs.length > 0) {
      templateDiffs.value = diffs;
      templateSource.value = null;
      ElMessage.error('模板校验未通过，已取消导出');
      return;
    }
    const out = await renderDeliveryNoteWorkbook(bytes, sheets.value, {
      driverName: driverNameOfExport.value,
      ...todayParts(),
    });
    triggerBrowserDownload(
      // `out` 是 hucre 的 Uint8Array（TS 5.7+ 泛型到 ArrayBufferLike，而
      // BlobPart 要 ArrayBuffer 变体）—— 复制进一个新的 ArrayBuffer 再包，零拷贝
      // 假设都不成立但体积只有几十 KB，且比 `as BlobPart` 强转诚实。
      new Blob([out.slice().buffer as ArrayBuffer], { type: XLSX_MIME }),
      `${props.note.delivery_note_no}.xlsx`,
    );
    ElMessage.success(`已导出 ${sheets.value.length} 个 sheet`);
    emit('update:modelValue', false);
  } catch (e) {
    ElMessage.error((e as Error).message ?? '导出失败');
  } finally {
    exporting.value = false;
  }
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    title="打印送货单"
    :width="dlg.width"
    :top="dlg.top"
    :close-on-click-modal="false"
    destroy-on-close
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
  >
    <div class="print-toolbar">
      <span class="toolbar-item">
        模板
        <el-upload
          ref="uploadRef"
          :auto-upload="false"
          :show-file-list="false"
          accept=".xlsx"
          :limit="1"
          :on-change="onFileChange"
          :on-exceed="onExceed"
        >
          <el-button size="small" :loading="templateLoading">选择模板</el-button>
        </el-upload>
        <span v-if="templateName" class="file-name">{{ templateName }}</span>
        <el-tag v-if="templateOk" type="success" size="small" effect="plain">已校验</el-tag>
        <el-tag v-else-if="templateDiffs.length" type="danger" size="small" effect="plain">
          校验未通过（{{ templateDiffs.length }}）
        </el-tag>
        <ColumnVisibilityPopover
          :defs="columnDefs"
          :model-value="columnVisibility.currentMap"
          @update:model-value="columnVisibility.update"
          @reset="columnVisibility.showAll"
          @resetOrder="resetOrderToken += 1"
        />
      </span>

      <span class="toolbar-item">
        司机
        <el-select
          v-model="driverId"
          placeholder="选择司机"
          filterable
          style="width: 180px"
          :loading="driverSaving"
          @change="onDriverChange"
        >
          <el-option
            v-for="d in driverQuery.drivers.value"
            :key="d.id"
            :value="d.id"
            :label="d.name"
          />
        </el-select>
        <span v-if="hasDriver && !driverId" class="muted">
          本单已指定：{{ note.driver_worker_name }}
        </span>
      </span>

      <!-- 2026-08-04：仅当单上含装配件子件时显示（el-radio-button 更醒目） -->
      <el-radio-group v-if="hasAssemblies" v-model="mergeMode" size="small" class="merge-toggle">
        <el-radio-button value="merge">合并一套</el-radio-button>
        <el-radio-button value="separate">分开打子件</el-radio-button>
      </el-radio-group>
    </div>

    <div v-if="templateDiffs.length" class="template-diffs">
      <div v-for="(d, i) in templateDiffs" :key="i" class="template-diff">{{ d }}</div>
    </div>

    <el-tabs v-model="activeTab" class="print-tabs">
      <el-tab-pane v-for="t in tabs" :key="t.groupKey" :name="t.groupKey">
        <template #label>
          <span class="tab-label">
            <span class="tab-label__code">{{ t.groupName }}</span>
            <span class="tab-label__count">({{ rowsOf(t.groupKey).length }})</span>
          </span>
        </template>
        <PrintGroupTable
          :rows="rowsOf(t.groupKey)"
          :sort-mode="sortModeByKey[t.groupKey] ?? 'column'"
          :column-defs="columnDefs"
          :column-visibility="columnVisibility"
          :group-key="t.groupKey"
          :reset-order-token="resetOrderToken"
          @update:rows="(next: PrintRow[]) => setRows(t.groupKey, next)"
          @update:sort-mode="(m: 'column' | 'custom') => setSortMode(t.groupKey, m)"
        />
        <div class="group-hint">
          本组 {{ rowsOf(t.groupKey).length }} 条 → Sheet「{{ safeSheetName(tabNameOf(t.groupKey)) }}」（容量
          {{ DELIVERY_NOTE_TEMPLATE_CONTRACT.dataRowCount }}/张）
          <span v-if="sortModeByKey[t.groupKey] === 'custom'" class="muted">（已手动调序）</span>
        </div>
      </el-tab-pane>
    </el-tabs>

    <template #footer>
      <span class="footer-hint">共 {{ totalRows }} 条 · {{ sheets.length }} 个 sheet</span>
      <el-button @click="emit('update:modelValue', false)">取消</el-button>
      <!-- data-role 供组件级用例定位「导出」按钮（按钮数随分组数变化，按位置取是脆的） -->
      <el-tooltip :disabled="!exportHint" :content="exportHint" placement="top">
        <span class="btn-wrap">
          <el-button
            type="primary"
            data-role="export"
            :loading="exporting"
            :disabled="exportDisabled"
            @click="onExport"
          >
            导出 xlsx
          </el-button>
        </span>
      </el-tooltip>
    </template>
  </el-dialog>
</template>

<style scoped>
.print-toolbar {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}
.toolbar-item {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.file-name {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.merge-toggle {
  margin-left: auto;
}
.template-diffs {
  margin-bottom: 8px;
  padding: 8px 12px;
  background: var(--el-color-danger-light-9, #fef0f0);
  border: 1px solid var(--el-color-danger-light-8, #fde2e2);
  border-radius: 4px;
  font-size: 12px;
  color: var(--el-color-danger);
}
.template-diff {
  line-height: 18px;
}
.group-hint {
  margin-top: 6px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.footer-hint {
  float: left;
  font-size: 13px;
  color: var(--el-text-color-secondary);
  line-height: 32px;
}
.tab-label {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
}
.tab-label__code {
  font-weight: 600;
}
.muted {
  color: var(--el-text-color-secondary);
}
/* el-tooltip 的触发子元素必须能接收事件的单元素；按钮 disabled 后不派发事件，
   套一层 span 承接 hover（否则禁用态拿不到 tooltip）。 */
.btn-wrap {
  display: inline-block;
}
</style>