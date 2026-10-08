<!--
  AssemblyChildrenDialog.vue
  2026-10-10 新增：dashboard 交期面板点**装配件行**后的子件列表弹窗。

  形态：
    - el-dialog 居中 modal（useDialogSize desktopWidth: 1200，比 PartPreviewDialog 的
      960 宽一档 —— 本弹窗是 5 列表格，960 装不下；层级也比零件预览低一层）；
    - 表格 5 列：序列号 / 名称 / 数量 / 状态 / 系统交期（**基础列，不显示已交量** ——
      装配件的「部分已交」是套级口径，子件级已交量与之不同源也不同单位）；
    - 三态渲染：error（图标 + 错误文案）/ 空态 el-empty / v-loading 表格。**失败不能
      退化成空态** —— 否则「装配件取不到」会被读成「该装配件没有子件」，与 PartPreviewDialog
      的 filesError 分支同款处理。error 与空态两条占位都按 `modelValue` 门控：关闭时父
      组件会清掉 assemblyId，queryKey 落到空串占位键、children 立刻变空，不门控的话
      el-dialog 的 leave 动画途中会闪出占位文案，看着像数据被清掉；
    - 系统交期可空（t_part 该列可空）：空值出「—」占位，不留看不出是空还是缺列的空格；
    - 点行 emit('childClick', child) 且**不关闭自己**（两级弹窗叠开，用户要在子件列表上
      连续点多个子件对比 —— 每次先关掉零件预览弹窗，子件列表原样留在下面）。

  ⚠️ **必须 append-to-body**：`layouts/MainLayout.vue` 的
  `.main-content { position: relative; z-index: 1 }` 形成一个 stacking context，
  留在原位的弹窗其 z-index 被该上下文封顶，而从它里面点开的 PartPreviewDialog
  （已 append-to-body，teleport 到 body）在**根** stacking context 里参与排序 ⇒
  「后开的弹窗反而被先开的压住」。同 `views/inspection/InspectionPending.vue` 的
  嵌套弹窗硬约束。

  数据流：useAssemblyChildrenQuery 传 props.assemblyId（GET /assemblies/{id}
  的 children[]，零新增后端端点）。排序沿服务端口径（serial_no ASC NULLS LAST,
  id ASC），前端不再排。

  新鲜度：useAssemblyChildrenQuery 的 staleTime 20min 不产生定时器，靠本组件注册
  `useDashboardInvalidation(qk.assemblyPrefix)` 订阅 dashboard 的 AFFECTS_DASHBOARD
  事件集（已含 ASSEMBLY_UPDATED / DELETED / CANCELLED）即时失效 —— 与
  PartPreviewDialog 对 part-batches 域做的是同一件事（同域 WS 失效管道，两个弹窗各订阅
  自己的前缀，互不误伤）。

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
    <div v-if="showError" class="dialog-error">
      <el-icon color="#f56c6c"><WarningFilled /></el-icon>
      <span>{{ errorText }}</span>
    </div>

    <div v-else-if="showEmpty" class="dialog-empty">
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
            {{ formatDeliveryDate(row.system_delivery_date) || '—' }}
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
import { WarningFilled } from '@element-plus/icons-vue';
import { useDialogSize } from '@/composables/useDialogSize';
import { deliveryUrgencyClass, formatDeliveryDate } from '@/utils/deliveryDate';
import { ORDER_STATUS_LABEL, ORDER_STATUS_TAG_TYPE, type OrderStatus } from '@/types/parts';
import { qk } from '@/composables/queries/keys';
import { useDashboardInvalidation } from '@/views/dashboard/composables/useDashboardInvalidation';
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

const { children, isFetching, error } = useAssemblyChildrenQuery(() => props.assemblyId);

// staleTime 20min 下，别人改了这个装配件的子件（增删子件 / 取消 / 更新）时靠 WS 事件
// 即时失效，不等 20min 自然过期。传前缀键而非精确键：切了 assemblyId 之后新那条也会
// 被覆盖（同 PartPreviewDialog 对 part-batches 域的做法）。
useDashboardInvalidation(qk.assemblyPrefix);

/** 错误文案（失败态与空态必须分开，见文件头「三态渲染」）。 */
const errorText = computed<string | null>(() => error.value?.message ?? null);

/** 失败态：只在弹窗开着时出。关闭过渡期（el-dialog 的 leave 动画，约 300ms）里父组件
 * 已把 assemblyId 置 null ⇒ queryKey 落到空串占位键、data 变 undefined，若不按
 * modelValue 门控，关闭动画途中会闪一下「暂无子件」/ 错误文案 —— 看着像数据丢了。 */
const showError = computed(() => props.modelValue && errorText.value !== null);

/** 空态只在「弹窗开着 + 已拿到数据 + 没报错 + 确实为空」时出：取数中仍渲染
 *  v-loading 的表格骨架，否则弹窗一开就闪一下「暂无子件」。关闭过渡期同理不出占位 ——
 *  那一刻正文退回空表格（EP 的「暂无数据」），但**不出现**「该装配件暂无子件」这句
 *  对本装配件的断言，避免关闭动画被读成数据被清掉。 */
const showEmpty = computed(
  () =>
    props.modelValue &&
    !isFetching.value &&
    errorText.value === null &&
    children.value.length === 0,
);

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
.dialog-error {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 240px;
  color: var(--el-color-danger);
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
