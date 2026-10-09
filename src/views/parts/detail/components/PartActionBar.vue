<!--
  PartActionBar.vue

  零件详情页底部操作卡（品检通过 / 指定工序 / 取消订单 / 删除 + 目标批次标识）。
  2026-10-10 从 `PartDetail.vue` 抽出：它横跨「详情是否已加载」「批次状态」「角色」
  三类门控，与 shell 的确认框、软删收尾强耦合，内联在 shell 里让两者互相牵扯。

  边界：**纯展示 + 事件转发**。本组件不发任何请求、不认识 actions、也不知道 vue-router
  —— 点哪个按钮一律 emit 出去，shell 决定做什么（弹框 / 关框 / 摘标签 / 跳转）。

  ⚠️ 门控口径必须逐字保持（后端角色集逐条对齐 `usePartDetail.ts` 的权限矩阵注释）：
    - 两个品检按钮：`canInspect && inspectionBatch` —— 锚是**批次**不是 `part.status`
      （`t_part.status` 是 min-progress 派生列，多批次工单上批次已在品检而整单状态还在
      靠前，按整单判会让这一批永远动不了；推导见 `composables/inspectionBatch.ts`）；
    - 取消订单：`canCancelPart && status !== 'CANCELLED' && status !== 'COMPLETED'`；
    - 删除：`canDeletePart`（后端软删只收 MANAGER）。
  两个品检按钮共用**同一个** `inspectionBatch` prop —— 一个锚批次，必然打同一个批次。

  ⚠️ 根元素是单个普通 div（内层才是 `el-card`）：卡片组件的根必须是单元素才等于它的
    vnode DOM footprint，多根会让 Vue 插锚点（同 CLAUDE.md「拖拽投放」那节）。
-->
<template>
  <div v-if="visible" class="part-action-bar">
    <el-card shadow="never" class="bottom-actions">
      <div class="action-row">
        <!--
          品检相关：⚠️ 判据是**批次**而非 `part.status`，理由见文件头。两个按钮打在
          同一个 `inspectionBatch` 上，左侧标识让用户按下之前就能确认是哪个批次。
        -->
        <template v-if="canInspect && inspectionBatch">
          <span class="inspection-anchor">
            目标批次
            <span class="mono">{{ inspectionBatch.batch_label }}</span>
            （{{ inspectionBatch.quantity }} 件）
          </span>
          <el-button type="success" :loading="passSubmitting" @click="emit('pass')"
            >品检通过</el-button
          >
          <el-button type="warning" @click="emit('openFailInsp')">指定工序</el-button>
        </template>
        <el-button
          v-if="canCancelPart && status !== 'CANCELLED' && status !== 'COMPLETED'"
          type="warning"
          @click="emit('cancelOrder')"
          >取消订单</el-button
        >
        <el-button v-if="canDeletePart" type="danger" @click="emit('deletePart')">删除</el-button>
      </div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import type { PartBatch } from '@/api/parts';
import type { OrderStatus } from '@/types/parts';

defineProps<{
  /** 详情是否已加载（原 shell 里的 `v-if="part"`；未加载时整卡不渲染）。 */
  visible: boolean;
  /** `part.status`；`visible` 为 false 时不读。取消订单按钮的门控判据之一。 */
  status: OrderStatus | null;
  canInspect: boolean;
  canCancelPart: boolean;
  canDeletePart: boolean;
  /** 品检锚批次（与 `PartFailInspectionDialog` 回显的、以及两个写操作的锚是同一个）。 */
  inspectionBatch: PartBatch | null;
  /** 「品检通过」按钮的提交态（loading）。 */
  passSubmitting: boolean;
}>();

const emit = defineEmits<{
  pass: [];
  openFailInsp: [];
  cancelOrder: [];
  deletePart: [];
}>();
</script>

<style lang="scss" scoped>
.part-action-bar {
  width: 100%;
}

.bottom-actions {
  .action-row {
    display: flex;
    justify-content: flex-end;
    align-items: center;
    gap: 10px;
  }

  // 品检按钮组左侧的锚批次标识。必须可见 —— 用户要能在按下之前确认那是哪个批次。
  .inspection-anchor {
    font-size: 13px;
    color: var(--text-secondary);
    margin-right: 4px;
  }
}

.mono {
  font-family: 'SF Mono', Menlo, Consolas, monospace;
}
</style>
