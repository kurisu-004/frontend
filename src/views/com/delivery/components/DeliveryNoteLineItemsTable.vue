<!--
  DeliveryNoteLineItemsTable.vue

  送货单详情「零件列表」卡（DeliveryNoteDetail 第 2 张卡）：
  - 顶部 actions：列显隐 popover + 移除选中（加件入口随 `POST /{id}/add-parts` 下线）
  - 主区域：el-table（tree-props + selection + sort-change + 列顺序拖动）
     行高亮 = 「已打印标签」绿底，口径与扫码建单页的草稿卡片同款：**零件行取任一批次
     已打印（any），装配件父行取全部批次已打印（all）**。

  行形态是 `PartTreeRow`（装配件父行 + 零件行），由父 composable 派生后注入；
  本组件只负责 UI 编排 + 选择事件转发。列定义**只有一份**（域根
  `deliveryNoteLineItemsColumnDefs.ts`，含 cellRender / 宽度 / 排序等元数据），
  可见性与列顺序都直接吃它 —— 不在组件内另建副本。

  业务状态（note / treeLineItems / columnVisibility / selectedRows / role）由父组件通过
  prop 注入；状态标签的文案映射由列定义自己读 `@/types/parts`（域根那份列定义是唯一
  一份渲染逻辑，不再经 prop 注入两个等价 helper）。

  2026-08-25 frontend-overall-refactor：从 DeliveryNoteDetail.vue 抽出。
  2026-08-27 T17：接入列顺序拖动（HTMLElement 路径 — el-card v-if="note" 始终为 truthy 后 el-table 一直在 DOM）。
  2026-10-09：删掉组件内的列定义副本（本文件曾有第二份，与域根那份重复且已漂移）；
    勾选列对装配件父行也放开（INSPECTOR 能打印但不能改单，原来「装配件父行不可勾」会把
    它们挡在打印之外）；勾选列开 `reserve-selection`，打印后绿底重算不丢勾选。
  2026-10-10：硬编码 `type="index"` 的「#」列换成「序号」列（取行上的 `seq`）—— 编号口径 =
    加入送货单的先后顺序。`type` 仍是 `index`（**不是**普通数据列）：EP 的树箭头与缩进只落在
    第一个 `type === 'default'` 的列上，改成普通列会把箭头搬进「序号」格（模板里有完整论证）。
    **这一列刻意不进 `columnDefs`**（钉在首位的唯一办法，理由见模板里那段注释）；defs 仍是那
    12 列，不受本次改动影响。
-->
<template>
  <el-card v-if="note" shadow="never" class="line-items-card">
    <template #header>
      <div class="card-header">
        <span>零件列表 ({{ displayRowCount }})</span>
        <div class="actions">
          <!-- 2026-08-02：列显隐控制；2026-08-27 T17 增 @resetOrder -->
          <ColumnVisibilityPopover
            :defs="columnDefs"
            :model-value="columnVisibility.currentMap"
            @update:model-value="(v: Record<string, boolean>) => columnVisibility.update(v)"
            @reset="columnVisibility.showAll"
            @resetOrder="drag.reset"
          />
          <el-button
            v-if="canEdit && selectedRows.length"
            type="danger"
            size="small"
            @click="emit('removeSelected')"
          >
            移除选中 ({{ selectedRows.length }})
          </el-button>
        </div>
      </div>
    </template>
    <!-- 2026-08-22 a11y：selection 列所在 table 加 aria-label -->
    <!--
      2026-10-09：`checkStrictly: true` 是硬要求，不能删。
      EP 的 `treeProps.checkStrictly` 默认 false ⇒ 勾选在父子间级联：勾「装配件父行」
      （用户想出 1 张「N 套」标签）会把全部子件行一起勾上，同一批货出两轮标签；反向
      勾满全部子件也会把父行勾上。「一行 = 一张标签」只有不联动才成立。

      2026-10-11：selection 列挂 `:selectable="canSelectPartRow"` —— **子件行不可勾选**
      （打印标签按套出，子件不是独立打印单元；判据与注释见 utils 的 `canSelectPartRow`）。
      这一挂同时补上了表头全选那条路：`treeProps.checkStrictly` 管不到它（EP
      `store/watcher._toggleAllSelection` 另建 treeProps 并把 `checkStrictly` 写死 false），
      但 `util.toggleRowStatus` 递归子节点时**同一个 `selectable` 一路下传** ⇒ 全选只勾
      顶层行（装配件父行 + 散件），与逐行点击同一口径。
      ⚠️ 已知代价：子件行不再能被单独勾选打印标签（产品已拍板）。移除批次 / 绿底 /
      序号排名都不受影响 —— 它们走 `useDeliveryNoteActions.rowIdToBatchIds` 的树递归与
      `assignSeq` 的顶层行排名，都不读勾选集。
    -->
    <el-table
      ref="tableRef"
      class="line-items-table"
      :data="treeLineItems"
      row-key="id"
      aria-label="送货单明细列表"
      :row-class-name="deliveryLineRowClassName"
      :tree-props="{ children: 'children', hasChildren: 'has_children', checkStrictly: true }"
      default-expand-all
      stripe
      border
      height="500"
      highlight-current-row
      @selection-change="onSelectionChange"
      @sort-change="onSortChange"
    >
      <!-- selection / 序号 始终可见，不放 defs。
           可见条件 = 可改单 **或** 可打印：INSPECTOR 能打印但不能改单，把勾选列只挂在
           canEdit 下会让他们看不到「打印标签」要用的勾选入口。装配件父行同样可勾 ——
           它代表整套货，标签就是按套出的。`reserve-selection` 让打印后绿底触发的行重算
           不丢勾选（连续打多批时体验）。子件行由 `:selectable` 拦掉。 -->
      <el-table-column
        v-if="showSelection"
        type="selection"
        width="50"
        reserve-selection
        :selectable="canSelectPartRow"
      />
      <!--
        2026-10-10：「序号」列（替换原先 `type="index"` 的 `#` 列）—— 按**加入送货单的先后
        顺序**编号，取值是行上的 `seq`（由 `buildPartTreeRows` 按 `min_seq` 稠密排名写好，
        见 utils/deliveryNotePartRows.ts 的「序号」一节）。

        ⚠️ **必须硬编码在 defs 的 v-for 之外、不能进 `columnDefs`**（这是钉在首位的唯一办法）：
        `useColumnDrag` 的 `restore()` 对**快照里缺失的 key 一律追加到末尾**（lenient 策略，
        见 composables/useColumnDrag.ts::restore）。若进 defs，localStorage 里已存过那 12 列
        顺序的老用户首次看到它就会出现在**最右侧**；而它又是「不可拖动」的固定列，老用户根本
        拖不回来，只能点「重置列顺序」—— 那不是「钉在首位」想要的效果。
        不进 defs 也顺带与被替换掉的 `#` 列行为一致：**不进列显隐弹窗**（序号不可关）。

        ⚠️ **`type` 必须是 `index`、不能是 `default`**（EP 的树列机制，见
        node_modules/element-plus/es/components/table/src/table-body/render-helper.mjs 的
        `firstDefaultColumnIndex`）：展开箭头与每级 16px 缩进只落在**第一个 `type === 'default'`
        的列**上，`type` 不传时默认就是 `'default'`。写成 `prop="seq"` 的普通数据列，它就成了
        第一个 default 列 ⇒ 箭头 + 缩进被搬进「序号」单元格，而本列改造前（`type="index"`）
        箭头是在「序列号」列的 —— 那是一次没被计划登记的观感变更。`type="index"` 不参与该判定，
        箭头留在「序列号」列。
        两处配套事实（都是实测结论，不是推断）：
        - 显式 `width` **压得住** `type="index"` 的强制 48px（`setColumnForcedProps` 先跑、
          `setColumnWidth` 后跑，后者按 `width` prop 重算 `realWidth`）；
        - 提供了 `#default` 插槽就用自己的内容，不再走 EP 注入的 `$index + 1`。
        守卫：`components/__tests__/DeliveryPartTablesTreeColumn.spec.ts`（真 el-table 断
        箭头落在哪一列）。

        ⚠️ **不带 `sortable`（有意）**：EP 对 index 列强制 `sortable: false`
        （table-column/config.mjs 的 `cellForced.index`，且 `registerNormalWatchers` 的
        sortable watcher 只在 prop **变化**时才回写，本列 prop 恒定 ⇒ 挂 `sortable` 也是死的），
        实测点表头无反应、th 上也没有 `is-sortable`。即「箭头归位」与「该列可排序」二者只能
        取一：选箭头归位（保持本列改造前的树形观感），序号列纯展示。默认序本就是入单序，用户
        要换维度排序走 defs 那 12 列。
        ⇒ 排序不再可能从这一列触发，`onLineItemSort` 收到的 prop 恒不为 `'seq'`。

        `width="80"` 的来由：表头只装列名「序号」28px + `.cell` 左右 padding 24px = 52px
        （无排序箭头、无 caret，都不在这一列），80 里的余量留给 3~4 位数的编号。

        单元格内容走 `seqCellText()`：装配件的**子件行留空** —— 它嵌在父行下、不是独立的一行，
        编号由父行代表（排名只看顶层行，见 buildPartTreeRows::assignSeq）。判据是**域内单一
        出口**而非组件私有，草稿卡片那张表也调它。

        两层排序的配合：排序会经过两层，两层都在、且指向同一个目标序 ⇒ 不打架 ——
        - 第一层是父 composable 排 `line_items`（按 `prop` 取**批次字段**）：`seq` 不在行项上
          （它是行形上的显示值）⇒ 取值恒 undefined ⇒ 比较器返回 0 ⇒ `Array.prototype.sort` 稳定
          ⇒ 这一层对 `seq` 是恒等变换，保住后端返回序；
        - 第二层是 EP 的 `sortData`（store/watcher.mjs 的 `execSort` → `orderBy(data, sortProp, …)`，
          同样稳定）按**行上的** `seq` 排顶层行，方向跟着点击的升 / 降序（子件行数组不在其内）；
        - 三态第三下（`order = null`）两层同时回默认序：EP 在 `changeSortCondition` 里把
          `sortingColumn` 置 null 并从 `_data` 重算（回 `:data` 给的顺序），composable 侧
          清掉 `sortBy`（回后端序）。
        ⚠️ 本列**当前不参与**任何一层的排序触发（`sortable` 见上）；即便将来有人给它加上
        `sortable`，上述同向性依然成立，不会出现两层互相覆盖出一屏乱序。
      -->
      <el-table-column type="index" prop="seq" label="序号" width="80" align="center">
        <template #default="{ row }">{{ seqCellText(row as PartTreeRow) }}</template>
      </el-table-column>
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
    </el-table>
  </el-card>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import type { TableInstance } from 'element-plus';
import ColumnVisibilityPopover from '@/components/ColumnVisibilityPopover.vue';
import ColumnDragHandle from '@/components/ColumnDragHandle.vue';
import { resolveDraggable, type ColumnDef } from '@/composables/useColumnVisibility';
import { useColumnDrag, columnIdentifier } from '@/composables/useColumnDrag';
import { canPrint } from '@/utils/deliveryNotePermissions';
import type { DeliveryNoteDetailData } from '../composables/deliveryNoteSchema';
import type { DeliveryNoteRoleMap } from '../composables/useDeliveryNoteDetail';
import { canSelectPartRow, seqCellText, type PartTreeRow } from '../utils/deliveryNotePartRows';

interface Props {
  note: DeliveryNoteDetailData | null;
  /** 权限 flag（可勾选移除 / 改单） */
  canEdit: boolean;
  /** 角色矩阵（打印判据 canPrint(note, role) 需要它） */
  role: DeliveryNoteRoleMap;
  /** 树形化后的行（composable 提供） */
  treeLineItems: PartTreeRow[];
  /** 列定义（域根唯一一份，含 cellRender / 宽度 / 排序元数据） */
  columnDefs: readonly ColumnDef[];
  columnVisibility: {
    isVisible: (key: string) => boolean;
    update: (next: Record<string, boolean>) => void;
    showAll: () => void;
    currentMap: Record<string, boolean>;
  };
  /** 勾选中的零件 / 装配件行（行本身可能代表多个批次） */
  selectedRows: PartTreeRow[];
  /** 行样式 helper（composable 提供；绿底判据在那侧） */
  deliveryLineRowClassName: (ctx: { row: PartTreeRow }) => string;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  /** 点「移除选中」 */
  removeSelected: [];
  /** 勾选变化（一行 = 零件 / 装配件，不是批次 id） */
  selectionChange: [rows: PartTreeRow[]];
  /** 排序变化 */
  sortChange: [
    sort: {
      prop: string | null;
      order: 'ascending' | 'descending' | null;
    },
  ];
}>();

/** 勾选列可见：能改单（移除）或能打印（打标签）任一即可。 */
const showSelection = computed(
  () => props.canEdit || (props.note != null && canPrint(props.note, props.role)),
);

/**
 * 卡片头计数 = **表格实际展示的行数**（递归摊平树形行，装配件子件行计入）。
 *
 * 2026-10-09 改口径：原先取 `note.line_items.length`，那是**批次条数**，而表体已经按
 * 零件折叠 + 装配件父行摊平 —— 12 个批次常常只有 4 行，头部却写「零件列表 (12)」，
 * 与表里对不上。表格常驻 `default-expand-all`，所以子件行恒可见，直接递归求和即可。
 */
const displayRowCount = computed(() => {
  const walk = (rows: readonly PartTreeRow[]): number =>
    rows.reduce((acc, r) => acc + 1 + walk(r.children ?? []), 0);
  return walk(props.treeLineItems);
});

// 2026-08-27 T17：列顺序拖动接入。
// ⚠️ IIFE 读 props：`columnDefs` 在本组件生命周期内不变（父 composable 只建一次），
// 而 useColumnDrag 的 defs / listKey 都只在 setup 时读一次（沿 PrintGroupTable 写法，
// 绕开 vue/no-setup-props-destructure 的「顶层直读 props 会丢响应性」）。
const drag = (() => {
  const { columnDefs } = props;
  return useColumnDrag(columnDefs, { listKey: 'delivery_note_detail_line_items' });
})();

const tableRef = ref<TableInstance | null>(null);
// 2026-08-28 改造：传 el-table 实例 ref，composable 内部解析表头 + MutationObserver 自愈
drag.applyDrag(tableRef);

/** 移除勾选行后清 EP 的勾选：开了 `reserve-selection` 就不主动清的话，保留集里还留着
 *  已删行的 row-key，同一零件被重新扫码入单会带着没出纸的勾选态回来。 */
function clearSelection(): void {
  tableRef.value?.clearSelection();
}
defineExpose({ clearSelection });

function onSelectionChange(rows: PartTreeRow[]): void {
  emit('selectionChange', rows);
}

function onSortChange(sort: {
  prop: string | null;
  order: 'ascending' | 'descending' | null;
}): void {
  emit('sortChange', sort);
}
</script>

<style lang="scss" scoped>
.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.actions {
  display: flex;
  gap: 8px;
}
.asm-tag {
  margin-right: 6px;
}
.assembly-link {
  color: var(--primary-color);
  text-decoration: none;
}
.assembly-link:hover {
  text-decoration: underline;
}
.muted {
  color: var(--text-secondary);
}

/* ============ 表头 nowrap ============ */
/* 2026-10-09：本表表头统一不折行。
   表头内容 = 列名 + 列拖动手柄(16px) + 排序箭头(24px) + .cell 左右 padding(24px)，
   min-width 不足时 EP 的 `.cell`（`white-space: normal` + `overflow-wrap: break-word`）
   会把排序箭头折成第二段。
   这条规则**刻意只作用于本表**（专属 class + scoped）：写在全局 `src/styles/index.scss`
   会命中全仓每一张接了列拖动的表，而那些表的 `.cell` 是 `overflow: hidden`，效果是
   把「折行」换成「裁切」—— 比折行更糟（表头文案直接看不全）。
   代价：本表在极窄窗口下宁可裁切也不折行。 */
.line-items-table :deep(th.col-draggable > .cell) {
  white-space: nowrap;
}

/* ============ 已打印标签行绿底 ============ */
/* 与扫码建单页的草稿卡片同款判据（同一份 usePrintedLabels 记录 + all/any 口径）。 */
:deep(.el-table__row.row-printed) > td.el-table__cell {
  background-color: #e6f7e6 !important;
}
:deep(.el-table__row.row-printed:hover) > td.el-table__cell {
  background-color: #d6efd6 !important;
}
</style>
