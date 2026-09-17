<!--
  PartBatchMonitorBody.vue

  批次监控卡 body 子组件（2026-09-17 UI 调整第 2 轮）：
  - 把 PartBatchMonitorCard 内 el-table + 列拖动 + 列设置工具条抽成子组件，
    让 wrapCard=true（包 el-card + header）与 wrapCard=false（裸渲染）共用
    同一份 body，避免模板两份 v-if/v-else 重复整张表 + 拆分 dialog。
  - 所有 props 由父组件（PartBatchMonitorCard）注入，子组件不持有任何状态。
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
