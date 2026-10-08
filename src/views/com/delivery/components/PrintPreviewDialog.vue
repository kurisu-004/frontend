<!--
  打印送货单对话框：`openXlsx/saveXlsx` 模板 round-trip 保住 merges / 列宽 / 打印设置，
  **单元格样式要另开 `readStyles` 才进模型**（见 utils/deliveryNoteWorkbook.ts 文件头）。

  送货单按分厂分组（el-tabs）：一张送货单一个收货单位，按送货分组规则（或未分组 L2）
  分组，每组一个 tab / 一个 sheet，每 sheet 最多 10 条。

  「打印标签」不经本对话框（2026-10-09）：用户在表格里勾选零件 / 装配件行后直接导出，
  实现在 utils/deliveryNoteLabelExport（草稿卡片与详情页共用）。所以本组件只剩送货单
  一条链路，`mode` / 标签模式的模板区、司机下拉、勾选集合等全部随之下线。

  表头排序 + 行拖拽 + 行拆分 + 列拖拽共存，行拖拽会清掉排序标记（自定义顺序优先）。

  交互契约：
  · 每个 tab 一张独立 el-table（子组件 `PrintGroupTable`）—— Sortable 绑的是 EP 内部
    渲染出的 `<tbody>`，多 tab 复用同一个实例会把 A 表的拖拽算到 B 表的下标上；
  · tab 顺序 = 分组键在 `line_items` 中**首次出现**的顺序；
  · tab name = groupKey（`g_<gid>` / `c_<l2id>` 语义字符串，非索引）；
  · 表头排序走 EP 内置比较 + 客户端 `sortPrintRows`，`prop` 是 snake_case 字段名本身；
  · 数量列**只读**，要改必须走行尾「拆分」（守恒校验在 PrintSplitEditor 里）；
  · 司机变更**在导出确认时随本次导出一并落库**（下拉切换是纯本地态）。
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
/** 仅本地选中态。切换下拉**不发请求**（2026-10-08：改动随「导出」确认一并落库，见
 *  persistSelectedDriver）—— 关对话框即放弃，与「改完就生效」的直觉相反是刻意的：
 * 打印对话框是一次性动作，点「取消」不该在服务端留下一条 version 变更。 */
const driverId = ref<string>('');
/** 司机落库中（只在 persistSelectedDriver 的 await 期间为 true）。 */
const driverSaving = ref(false);

const hasDriver = computed(() => Boolean(props.note.driver_worker_name));
const selectedDriverName = computed(
  () => driverQuery.drivers.value.find((d) => d.id === driverId.value)?.name ?? null,
);

/**
 * 导出前把所选司机落库；成功返回 true。
 *
 * 落库判据只有一条：**用户在下拉里选过**（`driverId` 非空）。没碰过下拉 ⇒ 用单据上已有的
 * 司机名导出，`driverId` 保持 `''` ⇒ 不 POST。
 *
 * ⚠️ **不能拿司机名当判据**：司机名允许重名（后端列表同名时按 id 定序 ⇒ 同名是预期数据现状）。
 * 按名短路会让「选了同名不同 id 的司机」静默跳过落库 ⇒ 单据仍绑着旧 id，`POST /{id}/pickup`
 * 会用错人，用户的显式选择也进不了审计。省一次写不值得换一个语义洞。
 * 副作用：每次导出只要选了司机就 POST 一次（幂等、推进 version）—— 用户「明确选了司机」
 * 本身就值得留一条审计记录。
 *
 * `POST /com/delivery/note/{id}/driver` 会推进 version ⇒ 成功后失效本域，
 * 让详情 / 草稿看板看到新 version 与新司机名。
 */
async function persistSelectedDriver(): Promise<boolean> {
  const id = driverId.value;
  if (!id) return true;
  driverSaving.value = true;
  try {
    await setNoteDriver(props.note.id, { version: props.note.version, driver_worker_id: id });
    await invalidateDeliveryNotesQuery(qc);
    return true;
  } catch (e) {
    ElMessage.error((e as Error).message ?? '指定司机失败，已取消导出');
    // 落库失败最常见的是 409（手上 version 已被别人推进）。失效本域，下一轮 refetch
    // 就能拿到新 version，对话框里直接重试即成 —— 否则用户只能关页面重新进来。
    //
    // 2026-10-08 修正措辞：这一处失效的作用对象是**对话框所在的页面**，且扫码页上它
    // 真的会命中活跃 observer —— 第一宿主页 `DeliveryNoteScan.vue` 无条件实例化
    // `useDeliveryDraftBoard()`，其 `['delivery-notes','list',params]` observer 在选中
    // L1 时就是活的（要看到草稿卡、进而点开本对话框，L1 必然已选），而
    // `invalidateDeliveryNotesQuery` 失效的是整个 `['delivery-notes']` 前缀
    // ⇒ 草稿看板会回流。对话框自身不持有 `delivery-notes/*` 的 query。
    await invalidateDeliveryNotesQuery(qc);
    return false;
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

/** 重建各 tab 的行（拷贝，拖拽与排序只动副本，父组件的 map 不被就地改）。 */
function rebuildRows(): void {
  const rows: Record<string, PrintRow[]> = {};
  const sorts: Record<string, 'column' | 'custom'> = {};
  for (const [key, { rows: r }] of groupsByKey.value) {
    rows[key] = r.map((x) => ({ ...x }));
    sorts[key] = 'column';
  }
  rowsByKey.value = rows;
  sortModeByKey.value = sorts;
  if (!rowsByKey.value[activeTab.value]) activeTab.value = tabs.value[0]?.groupKey ?? '';
}

// 打开 / mergeMode / 分组数据变化 → 重建各 tab 的行。
watch(
  () => [props.modelValue, mergeMode.value, groupsQuery.data.value] as const,
  ([open]) => {
    if (!open) {
      // 关对话框即放弃本地态：详情页的 v-if 只判 detail.note，组件不卸载
      // （destroy-on-close 只销毁插槽）⇒ 不复位的话「选司机 → 取消 → 重开」下拉还显示
      // 那个**从未落库**的司机。「本单已指定：X」提示继续承担回显职责（VO 只有名字，
      // 无法预选下拉项）。
      driverId.value = '';
      return;
    }
    rebuildRows();
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

const driverNameOfExport = computed(
  () => selectedDriverName.value ?? props.note.driver_worker_name ?? '',
);

const exportDisabled = computed(() => {
  if (exporting.value) return true;
  return !templateOk.value || totalRows.value === 0 || !driverNameOfExport.value;
});

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
  if (exportDisabled.value) return;
  exporting.value = true;
  try {
    const src = templateSource.value;
    if (!src) return;
    // 司机先落库：打印即「这次确认了送货人」。落库失败（409 / 21409 / 网络）时中止，
    // 不产出文件 —— 否则会下载出一张页脚写着 A 司机、单据上却是 B 司机的送货单。
    if (!(await persistSelectedDriver())) return;
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
      </span>

      <!-- 列可见性是**对话框级**偏好（N 张表共用一份 print_preview_dialog 快照，
           见下方列可见性段注释）。 -->
      <span class="toolbar-item">
        <ColumnVisibilityPopover
          :defs="columnDefs"
          :model-value="columnVisibility.currentMap"
          @update:model-value="columnVisibility.update"
          @reset="columnVisibility.showAll"
          @resetOrder="resetOrderToken += 1"
        />
      </span>

      <!-- 司机下拉：送货单模板页脚的「送货人」字段；打印即确认，改动随导出落库。 -->
      <span class="toolbar-item">
        司机
        <el-select
          v-model="driverId"
          placeholder="选择司机"
          filterable
          style="width: 180px"
          :loading="driverSaving"
          :disabled="exporting || driverSaving"
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