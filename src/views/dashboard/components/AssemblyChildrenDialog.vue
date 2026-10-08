<!--
  AssemblyChildrenDialog.vue
  2026-10-10 新增：dashboard 交期面板点**装配件行**后的子件列表弹窗。

  形态：
    - el-dialog 居中 modal（useDialogSize desktopWidth: 1200，比 PartPreviewDialog 的
      960 宽一档 —— 本弹窗是 5 列表格，960 装不下；层级也比零件预览低一层）；
    - 表格 5 列：序列号 / 名称 / 数量 / 状态 / 系统交期（**基础列，不显示已交量** ——
      装配件的「部分已交」是套级口径，子件级已交量与之不同源也不同单位）；
    - 空态 el-empty；点行 emit('childClick', child) 且**不关闭自己**（两级弹窗叠开，
      用户要在子件列表上连续点多个子件对比）。

  ⚠️ **必须 append-to-body**：`layouts/MainLayout.vue:275` 的
  `.main-content { position: relative; z-index: 1 }` 形成一个 stacking context，
  留在原位的弹窗其 z-index 被该上下文封顶，而从它里面点开的 PartPreviewDialog
  （已 append-to-body，teleport 到 body）在**根** stacking context 里参与排序 ⇒
  「后开的弹窗反而被先开的压住」。同 `views/inspection/InspectionPending.vue` 的
  嵌套弹窗硬约束。

  数据源：useAssemblyChildrenQuery 传 props.assemblyId（GET /assemblies/{id}
  的 children[]，零新增后端端点）。排序沿服务端口径（serial_no ASC NULLS LAST,
  id ASC），前端不再排。

  Props / Events：
    - modelValue：boolean（v-model 双向绑定）；
    - assemblyId：string | null（父组件传入选中装配件行 id；null = 未选 / 已清）；
      组件不自己存 id，只受控于 props，避免两处状态不同步；
    - @childClick(child)：父组件据此打开 PartPreviewDialog（子件列表保持开启）。
-->
<template>
  <el-dialog
    :model-value="modelValue"
    :width="dlg.width"
    :top="dlg.top"
    :fullscreen="dlg.fullscreen"
    title="装配件子件"
    :show-close="true"
    :append-to-body="true"
    @update:model-value="(v) => emit('update:modelValue', v)"
  >
    <div v-if="showEmpty" class="dialog-empty">
      <el-empty description="该装配件暂无子件" :image-size="60" />
    </div>

    <el-table
      v-else
      v-loading="isFetching"
      :data="children"
      stripe
      style="width: 100%"
      @row-click="onRowClick"
    >
      <el-table-column label="序列号" width="110">
        <template #default="{ row }">{{ row.serial_no ?? '—' }}</template>
      </el-table-column>
      <el-table-column prop="name" label="名称" min-width="220" show-overflow-tooltip />
      <el-table-column prop="quantity" label="数量" width="90" align="right" />
      <el-table-column label="状态" width="100">
        <template #default="{ row }">
          <el-tag
            :type="ORDER_STATUS_TAG_TYPE[row.status as OrderStatus]"
            size="small"
            effect="plain"
          >
            {{ ORDER_STATUS_LABEL[row.status as OrderStatus] }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="系统交期" width="110" align="right">
        <template #default="{ row }">
          <span :class="['cell-due', deliveryUrgencyClass(row.system_delivery_date)]">
            {{ formatDeliveryDate(row.system_delivery_date) }}
          </span>
        </template>
      </el-table-column>
    </el-table>
  </el-dialog>
</template>

<script setup lang="ts">
// 2026-10-10 新增：装配件子件列表弹窗（交期面板点装配件行的下钻）。
// 组件零 api 直调、零排序、零分页 —— 取数全在 useAssemblyChildrenQuery，排序沿服务端。
// 不写 retry：信任 main.ts 全局 queries.retry: 0。

import { computed } from 'vue';
import { useDialogSize } from '@/composables/useDialogSize';
import { deliveryUrgencyClass, formatDeliveryDate } from '@/utils/deliveryDate';
import { ORDER_STATUS_LABEL, ORDER_STATUS_TAG_TYPE, type OrderStatus } from '@/types/parts';
import { useAssemblyChildrenQuery } from '@/views/dashboard/composables/useAssemblyChildrenQuery';
import type { AssemblyChildRowData } from '@/views/dashboard/composables/assemblyChildrenSchema';

const props = defineProps<{
  modelValue: boolean;
  /** 选中装配件 id；null = 未选。取数闸门 = !!assemblyId。 */
  assemblyId: string | null;
}>();

const emit = defineEmits<{
  'update:modelValue': [v: boolean];
  childClick: [child: AssemblyChildRowData];
}>();

const dlg = useDialogSize({ desktopWidth: 1200 });

const { children, isFetching } = useAssemblyChildrenQuery(() => props.assemblyId);

/** 空态只在「已拿到数据且确实为空」时出：取数中仍渲染 v-loading 的表格骨架，
 *  否则弹窗一开就闪一下「暂无子件」。 */
const showEmpty = computed(() => !isFetching.value && children.value.length === 0);

/** 点行 → 抛给父组件开零件预览弹窗。**不关闭自己**：两级叠着，用户要能连续点多个子件。 */
function onRowClick(row: AssemblyChildRowData): void {
  emit('childClick', row);
}
</script>

<style lang="scss" scoped>
.dialog-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 240px;
}
.cell-due {
  color: var(--text-secondary);
}
.cell-due.overdue {
  color: var(--el-color-danger);
}
.cell-due.due-soon {
  color: var(--el-color-warning);
  font-weight: 600;
}
</style>
