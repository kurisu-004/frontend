<!--
  PartBatchMonitorBody.vue

  批次监控卡 body 子组件（2026-09-17 UI 调整第 2 轮）：
  - 把 PartBatchMonitorCard 内 el-table + 列拖动 + 列设置工具条抽成子组件，
    让 wrapCard=true（包 el-card + header）与 wrapCard=false（裸渲染）共用
    同一份 body，避免模板两份 v-if/v-else 重复整张表 + 拆分 dialog。
  - 所有 props 由父组件（PartBatchMonitorCard）注入，子组件不持有任何状态。

  ⚠️ **待验证项（2026-10-10 登记，本轮无法验证）**：本页这一轮第一次进了
  `<keep-alive :include>`（路由名 `PartDetail`），而本组件里的 `el-table` 是**列宽靠
  DOM 实测**的 EP 组件。全仓 `onActivated` / `doLayout` 零出现 —— 别处没踩过不等于本
  页也没事：别的表格页早已被缓存、且它们进 keep-alive 之前就没出现过问题，而本页是
  **新变量**。切走再回来时值得留意两类症状：列宽塌陷（列头与单元格对不齐）、选中行高亮
  残留（`rowClassName` 依赖的父级 `selectedBatchId` 与内部 table 状态脱节）。
  本轮**不盲改**：真要补的话是 `onActivated` 里取 `tableRef` 调 `doLayout()`，但在没有
  复现之前加上去是拿一个猜出来的修法换一条新的时序分支。回归时按上面两条症状对一遍，
  真复现了再补。
-->
<template>
  <el-table
    v-if="batches.length > 0"
    ref="tableRef"
    :data="batches"
    size="small"
    border
    stripe
    :row-class-name="rowClassName"
    @row-click="onRowClick"
  >
    <!--
      2026-08-27 T22：列顺序拖动接入。drag.orderedDefs 提供持久化顺序；
      用 <template v-for> 包裹以兼容 Vue 3 同元素 v-for + v-if 优先级问题。
      操作列（fixed="right"）受 canManageBatches 控制，保留为字面量 <el-table-column>。
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
    <el-table-column v-if="canManageBatches" label="操作" width="130" align="center" fixed="right">
      <template #default="{ row }">
        <el-button
          v-if="!isTerminalBatch(row as PartBatch) && (row as PartBatch).quantity > 1"
          link
          type="primary"
          size="small"
          @click.stop="openSplitDialog(row as PartBatch)"
          >拆分</el-button
        >
        <el-button
          v-if="!isTerminalBatch(row as PartBatch)"
          link
          type="danger"
          size="small"
          @click.stop="$emit('cancelBatch', row as PartBatch)"
          >取消</el-button
        >
      </template>
    </el-table-column>
  </el-table>
  <el-empty v-else description="暂无批次" />

  <!-- 2026-08-27 T22：列设置按钮（仅列表态展示；空态无表可设） -->
  <div v-if="batches.length > 0" class="table-toolbar">
    <ColumnVisibilityPopover
      :defs="columnDefs"
      :model-value="columnVisibility.currentMap"
      @update:model-value="columnVisibility.update"
      @reset="columnVisibility.showAll"
      @resetOrder="drag.reset"
    />
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import ColumnDragHandle from '@/components/ColumnDragHandle.vue';
import ColumnVisibilityPopover from '@/components/ColumnVisibilityPopover.vue';
import type { ColumnDef, ColumnVisibilityApi } from '@/composables/useColumnVisibility';
import type { ColumnDragApi } from '@/composables/useColumnDrag';
import type { PartBatch } from '@/api/parts';
import type { OrderStatus } from '@/types/parts';

defineProps<{
  batches: PartBatch[];
  canManageBatches: boolean;
  statusTagType: (s: OrderStatus) => 'primary' | 'success' | 'warning' | 'info' | 'danger';
  statusLabelOf: (s: string | null | undefined) => string;
  rowClassName: (args: { row: PartBatch }) => string;
  onRowClick: (row: PartBatch) => void;
  isTerminalBatch: (b: PartBatch) => boolean;
  openSplitDialog: (b: PartBatch) => void;
  drag: ColumnDragApi;
  columnIdentifier: (d: ColumnDef) => string;
  columnVisibility: ColumnVisibilityApi;
  resolveDraggable: (d: ColumnDef) => boolean;
  columnDefs: ColumnDef[];
}>();

defineEmits<{
  cancelBatch: [batch: PartBatch];
}>();

// 2026-09-17 review 第 2 轮修复：父组件 PartBatchMonitorCard 通过模板 ref 拿 body
// 实例，从这里拿 el-table 实例调 drag.applyDrag()。Vue 3 template ref 机制只匹配
// <script setup> 里顶层同名 ref —— 之前 template 写 `ref="tableRef"` 但脚本里没
// 声明同名 ref，绑定永远为空，applyDrag 拿 undefined 静默失效。
// 现在通过 defineExpose({ tableRef }) 把这个真实 ref 暴露出去，父组件 onMounted
// 时按 ref 自动拿到 el-table 实例。
const tableRef = ref();
// 2026-09-17 修订：放弃 InstanceType<typeof ElTable> 类型（applyDrag 内部已
// 用 unknown/AnyInstanceLike 兼容各种形态，强类型反而会触发 vue-tsc "类型不
// 兼容" 噪声），改用无类型约束的 ref —— applyDrag 运行时正常解析。
defineExpose({ tableRef });
</script>
