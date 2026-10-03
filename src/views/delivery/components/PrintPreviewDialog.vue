<!--
  送货单打印预览对话框。

  设计要点：
  - 列：勾选（仅 label 模式）/ 序号（拖动 handle + 数字）/ 订单号 / 分厂 / 申请人 /
    图号 / 名称 / 数量
  - 初始顺序 = 详情页当前 ``note.line_items`` 的内存顺序（含用户列头排序的结果）
  - 行可拖动：vue-draggable-plus（包 Sortable.js）绑到 el-table 渲染出的 tbody
  - 用户拖动只影响预览副本；详情页 ``note.line_items`` 不变
  - 单上有装配件子件时显示「合并为一套 / 分开打印所有子件」radio；合并模式预览折叠
    子件为父行；导出时把父行 round-trip 展开为组内各 part 的代表批次 id 连续。
  - 装配件套数全由后端算（shippable_sets），前端只读展示、不让用户填；后端没给这个数
    （字段整体缺失）时渲染「—」而不是「0 套」—— 两者业务含义相反（见 utils/assemblySets）。
  - ``mode`` prop 双模式：
      · 'note'  = 只导送货单
      · 'label' = 只导标签，支持勾选部分行；列首加 el-table 原生 selection 列
  - 取消 → 关闭对话框
-->
<script setup lang="ts">
import { computed, h, nextTick, ref, watch } from 'vue';
import { ElMessage, ElTag, ElTable, type TableInstance } from 'element-plus';
import { Rank } from '@element-plus/icons-vue';
import { useLazyDraggable } from '@/composables/useLazyDraggable';

import { printNote, printNoteLabels } from '@/api/deliveryNote';
import { useDialogSize } from '@/composables/useDialogSize';
import { triggerBrowserDownload } from '@/utils/download';
import type { DeliveryNoteDetailOut, DeliveryNoteLineItem } from '@/types/deliveryNote';
import {
  resolveDraggable,
  useColumnVisibility,
  type ColumnDef,
} from '@/composables/useColumnVisibility';
import { columnIdentifier, useColumnDrag } from '@/composables/useColumnDrag';
import ColumnDragHandle from '@/components/ColumnDragHandle.vue';
import ColumnVisibilityPopover from '@/components/ColumnVisibilityPopover.vue';
import { assemblyTotalSetsOfGroup, shippableSetsOfGroup } from '../utils/assemblySets';

const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    note: DeliveryNoteDetailOut | null;
    /** 2026-08-07：'note' = 只导送货单；'label' = 只导标签（可勾选行） */
    mode?: 'note' | 'label';
  }>(),
  { mode: 'note' },
);

const emit = defineEmits<{
  'update:modelValue': [v: boolean];
}>();

const dlg = useDialogSize({ desktopWidth: 1100 });

// 2026-09-21 对齐 TS 严格：模板 ref 收紧为 EP TableInstance；null 初值
const previewTableRef = ref<TableInstance | null>(null);
const rows = ref<PreviewRow[]>([]);
const tbodyRef = ref<HTMLElement | null>(null);
const loading = ref(false);

// 2026-08-07：标签模式的勾选状态
const selectedRows = ref<PreviewRow[]>([]);

// 2026-08-04：单上是否含有装配件子件
const hasAssemblies = computed(() => props.note?.line_items.some((li) => li.assembly_id) ?? false);
// 2026-08-07 改默认：单上含装配件子件时直接合并为一套打印（与后端 merge_assemblies 默认一致）
const mergeMode = ref<'separate' | 'merge'>('merge');

// 2026-08-07：是否为标签导出模式
const isLabelMode = computed(() => props.mode === 'label');

interface PreviewAssemblyRow {
  id: string;
  is_asm_row: true;
  assembly_id: string;
  order_no: string;
  customer_name: string;
  applicant_name: string;
  drawing_no: string;
  name: string;
  /** 2026-10-04：本单可出货套数（后端算，前端只读）；后端没给这个字段时 null → 渲染「—」 */
  quantity: number | null;
  unit: string;
  /** 2026-10-04：装配件工单总套数（数量列 tooltip 的对照值）；后端没给时 null */
  assembly_quantity: number | null;
  /** 2026-10-04：组内每个 part 的代表批次 id（custom_order / line_item_ids 的唯一来源） */
  memberIds: string[];
}
type PreviewRow = DeliveryNoteLineItem | PreviewAssemblyRow;

/** 2026-10-04 新增：雪花 id 比较。后端把 id 序列化成 string（> 2^53，转 number 会丢
 *  精度），故按 BigInt 比数值；非纯数字串降级字典序，保证本函数不抛。
 *  不可退化成 Number(a) < Number(b)：两个仅在 2^53 之后有差别的 19 位 id 转 number
 *  后相等，会让代表批次永远不换、静默选错。 */
function idLessThan(a: string, b: string): boolean {
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) return BigInt(a) < BigInt(b);
  return a < b;
}

// 2026-08-07：同 part 多批次折叠（_split 产生同 part 同送货单）。
// 永远开启，先于装配体折叠：每 part 仅产出一行，quantity 求和。
// 行 id = 该 part 下 id 最小的批次 = 后端 custom_order 认可的代表批次（代表口径 = 最小 id）；
// 显式取 min 令前端不依赖 line_items 的返回顺序。
// 与 DeliveryNoteLineItem 1:1 → DeliveryNoteLineItem（保留原 part_id 用于 asm 折叠判断）。
function foldSamePart(items: DeliveryNoteLineItem[]): DeliveryNoteLineItem[] {
  const qty = new Map<string, number>();
  const rep = new Map<string, DeliveryNoteLineItem>();
  const order: string[] = [];
  for (const li of items) {
    const pid = String(li.part_id);
    const cur = rep.get(pid);
    if (cur === undefined) {
      rep.set(pid, li);
      order.push(pid);
      qty.set(pid, li.quantity);
      continue;
    }
    qty.set(pid, qty.get(pid)! + li.quantity);
    if (idLessThan(li.id, cur.id)) rep.set(pid, li);
  }
  return order.map((pid) => ({ ...rep.get(pid)!, quantity: qty.get(pid)! }));
}

// 预览表格行：合并模式构造父行 + 散件；非合并模式 = line_items 拷贝
const previewRows = computed<PreviewRow[]>(() => {
  if (!props.note) return [];
  // 2026-08-07：先做同 part 折叠，再做装配体折叠。装配体折叠对折叠后的 part 唯一行生效。
  const flat = foldSamePart(props.note.line_items);
  if (!mergeMode.value || mergeMode.value === 'separate') {
    return [...flat];
  }
  const result: PreviewRow[] = [];
  const insertedAsm = new Set<string>();
  flat.forEach((li) => {
    if (!li.assembly_id) {
      result.push(li);
      return;
    }
    if (insertedAsm.has(li.assembly_id)) return;
    const siblings = flat.filter((x) => x.assembly_id === li.assembly_id);
    result.push({
      id: `ASM_${li.assembly_id}`,
      is_asm_row: true,
      assembly_id: li.assembly_id,
      order_no: siblings[0]?.assembly_order_no ?? '',
      customer_name: siblings[0]?.customer_name ?? '',
      applicant_name: siblings[0]?.applicant_name ?? '',
      drawing_no: li.assembly_drawing_no ?? '',
      name: li.assembly_name ?? '',
      // 2026-10-04：两个套数字段都是后端算的只读值，口径见 utils/assemblySets。
      // quantity = 本单可出货套数（shippable_sets，后端整体没给时 null → 渲染「—」，
      // 不可兜成 0：「没给数」与「凑不齐整套」业务含义相反）；
      // assembly_quantity = 装配件工单总套数（tooltip 的对照值）。
      quantity: shippableSetsOfGroup(siblings),
      unit: '套',
      assembly_quantity: assemblyTotalSetsOfGroup(siblings),
      // 组内各 part 的代表批次 id 在建行时定死：导出与预览共用同一份，不再二次折叠
      memberIds: siblings.map((s) => String(s.id)),
    });
    insertedAsm.add(li.assembly_id);
  });
  return result;
});

// tbodyRef 在 setup 时为 null（弹窗未打开），且 <el-dialog destroy-on-close> 关闭时
// 销毁 slot、reopen 时 <tbody> 是新元素 ⇒ 必须用 useLazyDraggable：它把首次绑定延后到
// el ref 解析之后，refreshTbodyRef() 写 ref 即自动重绑，无需手动 start()。
useLazyDraggable(tbodyRef, rows, {
  handle: '.drag-handle',
  draggable: 'tr',
  animation: 150,
  ghostClass: 'sortable-ghost',
  onEnd(evt: { oldIndex?: number; newIndex?: number }) {
    const { oldIndex, newIndex } = evt;
    if (oldIndex == null || newIndex == null || oldIndex === newIndex) return;
    const next = rows.value.slice();
    const [moved] = next.splice(oldIndex, 1);
    if (moved) next.splice(newIndex, 0, moved);
    rows.value = next;
  },
});

// 2026-08-27 Task 8：列顺序拖动 + 可见性。
// 与既有 useLazyDraggable 行拖（绑 tbody）独立 —— 列拖挂表头 <tr>，DOM 容器完全分离。
// label 模式首列 selection 勾选列不进 defs（type='selection' 自动不可拖 + v-if 条件）。
// 2026-08-27 修正：原生元素 children 不能传函数（Vue 3 会当 slots 处理 → 渲染为空），改为直接传值。
const columnDefs: ColumnDef[] = [
  {
    // 序号列：保留行拖手柄 .drag-handle（vue-draggable-plus 行拖的 handle 选择器）。
    // cellRender 必须返回单个 VNode；行内多根包 <div>。
    key: 'index',
    label: '序号',
    width: 72,
    align: 'center',
    cellRender: ({ $index }) =>
      h('div', null, [
        h('span', { class: 'drag-handle', title: '拖动排序' }, h(Rank)),
        h('span', { class: 'row-index' }, $index + 1),
      ]),
  },
  {
    key: 'order_no',
    label: '订单号',
    prop: 'order_no',
    minWidth: 120,
    showOverflowTooltip: true,
    align: 'center',
    cellRender: ({ row }) => h('span', null, (row as PreviewRow).order_no || '—'),
  },
  {
    key: 'customer_name',
    label: '分厂',
    prop: 'customer_name',
    minWidth: 160,
    showOverflowTooltip: true,
    align: 'center',
    cellRender: ({ row }) => h('span', null, (row as PreviewRow).customer_name || '—'),
  },
  {
    key: 'applicant_name',
    label: '申请人',
    prop: 'applicant_name',
    minWidth: 100,
    align: 'center',
    cellRender: ({ row }) => h('span', null, (row as PreviewRow).applicant_name || '—'),
  },
  { key: 'drawing_no', label: '图号', prop: 'drawing_no', minWidth: 140, align: 'center' },
  {
    key: 'name',
    label: '名称',
    minWidth: 180,
    showOverflowTooltip: true,
    align: 'center',
    cellRender: ({ row }) => {
      const r = row as PreviewRow;
      if (isAsmRow(r)) {
        return h('div', null, [
          h(ElTag, { type: 'warning', size: 'small', class: 'asm-tag' }, () => '装配件'),
          h('span', null, r.name),
        ]);
      }
      return h('span', null, r.name);
    },
  },
];
// 「数量」列不进 defs：装配件父行渲染「可出货套数 + tooltip」而普通行是纯文本，
// 两套渲染不便走 cellRender。
const columnVisibility = useColumnVisibility(columnDefs, { listKey: 'print_preview_dialog' });
const drag = useColumnDrag(columnDefs, { listKey: 'print_preview_dialog' });

// 2026-08-28 改造：传 el-table 实例 ref，composable 内部解析表头 + MutationObserver 自愈
// （行拖 useLazyDraggable 仍走 tbody，独立 watcher 不动）
drag.applyDrag(previewTableRef);

watch(
  () => [props.modelValue, mergeMode.value],
  async ([open]) => {
    if (open && props.note) {
      // 拷贝当前内存顺序作为预览初始顺序（不污染详情页）
      rows.value = previewRows.value;
      await nextTick();
      refreshTbodyRef();
      // 2026-08-07：label 模式默认全选
      if (isLabelMode.value) {
        await selectAll();
      }
    }
  },
  // 2026-08-24 bugfix：扫码建单页用 v-if 挂载本组件，首次进入时 modelValue
  // 已经是 true（无 false→true 的「变化」），watch 默认不立即触发会导致
  // rows 永远是空数组。详情页始终挂载的调用方不受影响（mount 时 open=false，
  // 不进 if 分支，tbodyRef 保持 null，useLazyDraggable 不会绑定）。
  { immediate: true },
);

watch(previewRows, async (next) => {
  rows.value = next;
  await nextTick();
  refreshTbodyRef();
  // 2026-08-07：合并模式切换后重置全选
  if (isLabelMode.value) {
    await selectAll();
  }
});

function isAsmRow(r: unknown): r is PreviewAssemblyRow {
  return typeof r === 'object' && r !== null && (r as PreviewAssemblyRow).is_asm_row === true;
}

/** 2026-10-04 新增：预览行 → 它代表的批次 id 列表（后端 custom_order / line_item_ids 的
 *  唯一口径），只读行上已定死的 id，不在此处二次推导。
 *  - 散件行：previewRows 已按 part 折叠，每行即一个 part 的代表批次 → 行自身 id；
 *  - 装配件父行：memberIds = 该套装下每个 part 各一个代表 id（合并不打散子件，后端据此
 *    归「套」）。 */
function repIdsOfRow(r: PreviewRow): string[] {
  if (isAsmRow(r)) return r.memberIds;
  return [String(r.id)];
}

/** 2026-10-04 新增：装配件父行数量列的 tooltip：工单总套数 vs 本单可出货套数。
 *  任一项后端没给数都显示「—」。 */
function asmQtyTitle(r: PreviewAssemblyRow): string {
  return `工单总套数 ${r.assembly_quantity ?? '—'} 套；本单可出货 ${r.quantity ?? '—'} 套`;
}

// 2026-08-07：标签模式全选 / 反选
async function selectAll(): Promise<void> {
  await nextTick();
  const t = previewTableRef.value;
  if (!t) return;
  // 逐行 toggle true（不用 toggleAllSelection：toggle 语义会全消）
  rows.value.forEach((r) => t.toggleRowSelection(r, true));
}
function invertSelection(): void {
  const t = previewTableRef.value;
  if (!t) return;
  const chosen = new Set(selectedRows.value);
  rows.value.forEach((r) => t.toggleRowSelection(r, !chosen.has(r)));
}

/** 找到 el-table 渲染出的 tbody 并写到 tbodyRef；useLazyDraggable 内部 watcher 看到 ref 变化即重绑。 */
function refreshTbodyRef(): void {
  const root = previewTableRef.value?.$el;
  if (!root) {
    tbodyRef.value = null;
    return;
  }
  tbodyRef.value = root.querySelector(
    '.el-table__body-wrapper .el-table__body > tbody',
  ) as HTMLElement | null;
}

function onCancel(): void {
  emit('update:modelValue', false);
}

async function onConfirm(): Promise<void> {
  if (!props.note) return;
  loading.value = true;
  try {
    // custom_order / line_item_ids 口径 = 每个 part 一个代表批次 id（同 part 多批次
    // 折叠后的最小 id）：后端据此校验，多发非代表 id 或漏发代表 id 都判 422。
    // 代表 id 已随行定死（装配件父行存 memberIds、散件行即自身 id），这里只按当前
    // 预览顺序展开。
    const custom_order = rows.value.flatMap((r) => repIdsOfRow(r));
    const mergeFlag = mergeMode.value === 'merge';

    if (isLabelMode.value) {
      // 勾选行 → 代表批次 id 子集（custom_order 仍覆盖全部行，两者正交：
      // 顺序 × 成员，后端先按 custom_order 排序再按 line_item_ids 裁成员）
      const line_item_ids = selectedRows.value.flatMap((r) => repIdsOfRow(r));
      const { blob, filename } = await printNoteLabels(props.note.id, {
        custom_order,
        merge_assemblies: mergeFlag,
        line_item_ids,
      });
      triggerBrowserDownload(blob, filename);
    } else {
      // note 模式 → 仅导送货单，不串联标签下载
      const { blob, filename } = await printNote(props.note.id, {
        custom_order,
        merge_assemblies: mergeFlag,
      });
      triggerBrowserDownload(blob, filename);
    }
    ElMessage.success('已导出');
    emit('update:modelValue', false);
  } catch (e) {
    ElMessage.error((e as Error).message ?? '导出失败');
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <!-- 2026-08-27 fix：destroy-on-close 会重建 slot 内的 <tbody>；watcher 在 reopen 时
       refreshTbodyRef() 写 tbodyRef，useLazyDraggable 内部 watcher 自动重绑新 tbody。 -->
  <el-dialog
    :model-value="modelValue"
    :title="
      isLabelMode ? '标签打印预览（勾选要打印的行，拖动可调顺序）' : '打印预览（拖动行可调整顺序）'
    "
    :width="dlg.width"
    :top="dlg.top"
    :fullscreen="dlg.fullscreen"
    :close-on-click-modal="false"
    destroy-on-close
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
  >
    <div class="preview-tip">
      <span v-if="!isLabelMode">预览共 {{ rows.length }} 行；导出顺序 = 当前预览顺序。</span>
      <el-space v-if="isLabelMode" size="small">
        <span>已选 {{ selectedRows.length }} / {{ rows.length }} 行</span>
        <el-button size="small" @click="selectAll">全选</el-button>
        <el-button size="small" @click="invertSelection">反选</el-button>
      </el-space>
      <!-- 2026-08-04：仅当单上含装配件子件时显示（el-radio-button 更醒目） -->
      <el-radio-group v-if="hasAssemblies" v-model="mergeMode" size="small" class="merge-toggle">
        <el-radio-button value="separate">分开打子件</el-radio-button>
        <el-radio-button value="merge">合并一套</el-radio-button>
      </el-radio-group>
    </div>
    <!-- 2026-08-27 Task 8：列设置工具条 -->
    <div class="table-toolbar">
      <ColumnVisibilityPopover
        :defs="columnDefs"
        :model-value="columnVisibility.currentMap"
        @update:model-value="columnVisibility.update"
        @reset="columnVisibility.showAll"
        @resetOrder="drag.reset"
      />
    </div>
    <!-- 2026-08-22 a11y：selection 列所在的 table 加 aria-label -->
    <el-table
      ref="previewTableRef"
      :data="rows"
      row-key="id"
      aria-label="打印预览列表"
      stripe
      border
      height="500"
      @selection-change="(v: PreviewRow[]) => (selectedRows = v)"
    >
      <!-- 2026-08-07：label 模式首列加 el-table 原生 selection 勾选列（不进 defs：type='selection' 不可拖） -->
      <el-table-column v-if="isLabelMode" type="selection" width="48" />
      <!-- 2026-08-27 Task 8：列顺序拖动接入 -->
      <template v-for="d in drag.orderedDefs.value" :key="columnIdentifier(d)">
        <el-table-column
          v-if="columnVisibility.isVisible(d.key)"
          :prop="d.prop ?? d.key"
          :label="d.label"
          :width="d.width"
          :min-width="d.minWidth"
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
      <!-- 「数量」列不进 defs：装配件父行是「套数 + tooltip」，普通行是纯文本。
           装配件父行后端没给数时渲染「—」（不写 0），单位同步省略。 -->
      <el-table-column label="数量" min-width="120" align="right">
        <template #default="{ row }">
          <span v-if="isAsmRow(row)" class="asm-qty" :title="asmQtyTitle(row)">
            {{ row.quantity ?? '—' }}<span v-if="row.quantity !== null" class="unit">套</span>
          </span>
          <span v-else>{{ row.quantity }}</span>
        </template>
      </el-table-column>
    </el-table>

    <template #footer>
      <el-button @click="onCancel">取消</el-button>
      <!-- 2026-10-04：data-role 供组件级用例定位「导出」按钮（footer 里按钮数随
           label / note 两态与模式切换而变，按位置取按钮是脆的） -->
      <el-button
        type="primary"
        data-role="export"
        :loading="loading"
        :disabled="!rows.length || (isLabelMode && !selectedRows.length)"
        @click="onConfirm"
      >
        {{ isLabelMode ? '导出标签' : '导出送货单' }}
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
/* 2026-08-27 Task 8：列设置工具条 */
.table-toolbar {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 8px;
}

.drag-handle {
  cursor: grab;
  color: var(--primary-color);
  margin-right: 4px;
}
.drag-handle:active {
  cursor: grabbing;
}
.row-index {
  color: var(--text-secondary);
  font-size: 12px;
}
:deep(.sortable-ghost) {
  opacity: 0.4;
  background: #eaf2fb !important;
}
:deep(.sortable-chosen) {
  background: #cce0f4 !important;
}
.preview-tip {
  margin-bottom: 8px;
  color: var(--text-secondary);
  font-size: 13px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
}
.merge-toggle {
  color: var(--text-primary);
}
.asm-tag {
  margin-right: 4px;
}
/* 2026-10-04：装配件父行数量 = 后端算出的可出货套数，只读展示。
   后端没给数时渲染「—」，样式与普通行一致，无需额外修饰。 */
.asm-qty .unit {
  color: var(--text-secondary);
}
</style>
