<!--
  DashboardKpiTiles.vue
  dashboard 域 KPI 横排 5 tile（语义按风险递进排列）：
    - 逾期未交（Manager-only；非 Manager 渲染「需 Manager 权限」占位）
    - 今日到期（snapshot.upcoming_delivery 中 date === today 的 count 之和）
    - 两周到期（snapshot.upcoming_delivery 全 14 天桶 count 总和）
    - 在制（snapshot.in_process.length）
    - 在检（snapshot.on_inspection_shelves.length）

  视觉：
  - 逾期红 / 今日橙 / 两周与在制用 --primary-color（沿用项目主色，凸显「正在车间
    进行」生产实况）/ 在检用 --el-color-info（品检态相对中性，未必紧急）；
  - grid-template-columns: repeat(5, minmax(0, 1fr))，≤900px 退化为
    repeat(2, minmax(0, 1fr))（两行 + 一行）；
  - 各 tile 内部 el-statistic title / suffix 沿用原约定。

  Props 由父组件 DashboardView 通过 composables 派生传入，组件本身不持状态。
  视觉：沿仓库卡片白底 + box-shadow 0 1px 3px rgba(0,0,0,0.08)；颜色按语义区分。
-->
<template>
  <div class="kpi-row">
    <!-- 1. 逾期未交（Manager-only） -->
    <el-card shadow="never" class="kpi-card">
      <el-statistic
        :value="overdueCount"
        title="逾期未交"
        :value-style="manager ? { color: 'var(--el-color-danger)' } : { color: 'var(--text-secondary)' }"
      >
        <template #suffix>件</template>
      </el-statistic>
      <div v-if="!manager" class="kpi-restricted">
        <el-icon :size="14"><Lock /></el-icon>
        <span>需 Manager 权限</span>
      </div>
    </el-card>

    <!-- 2. 今日到期 -->
    <el-card shadow="never" class="kpi-card">
      <el-statistic
        :value="todayCount"
        title="今日到期"
        :value-style="{ color: todayCount > 0 ? 'var(--el-color-warning)' : 'var(--text-primary)' }"
      >
        <template #suffix>件</template>
      </el-statistic>
    </el-card>

    <!-- 3. 两周到期 -->
    <el-card shadow="never" class="kpi-card">
      <el-statistic
        :value="weekCount"
        title="两周到期"
        :value-style="{ color: 'var(--primary-color)' }"
      >
        <template #suffix>件</template>
      </el-statistic>
    </el-card>

    <!-- 4. 在制 -->
    <el-card shadow="never" class="kpi-card">
      <el-statistic
        :value="inProcessCount"
        title="在制"
        :value-style="{ color: 'var(--primary-color)' }"
      >
        <template #suffix>件</template>
      </el-statistic>
    </el-card>

    <!-- 5. 在检 -->
    <el-card shadow="never" class="kpi-card">
      <el-statistic
        :value="inInspectionCount"
        title="在检"
        :value-style="{ color: inInspectionCount > 0 ? 'var(--el-color-info)' : 'var(--text-primary)' }"
      >
        <template #suffix>件</template>
      </el-statistic>
    </el-card>
  </div>
</template>

<script setup lang="ts">
// dashboard KPI 5 tile 展示壳。
//
// 口径：
//   - 今日到期 = upcoming_delivery 中 date === today 的 count 之和
//   - 两周到期 = upcoming_delivery 全 14 天桶 count 之和（快照本身只返 14 天，
//     故全桶求和即两周窗口；非按某个自然周切）
//   - 在制 = snapshot.in_process.length（车间生产中件）
//   - 在检 = snapshot.on_inspection_shelves.length（在检货架件数）
//   - 逾期未交 = useDashboardOverdue.overdue_undelivered_count（Manager-only）
//
// 四个 props 全部由父组件 DashboardView 从 snapshot 派生后传入；组件自身不消费
// Zod schema、不发请求。

import { Lock } from '@element-plus/icons-vue';

defineProps<{
  /** Manager 角色标记；true 显逾期数字，false 显占位 */
  manager: boolean;
  /** 逾期未交件数（来自 useDashboardOverdue.overdueCount） */
  overdueCount: number;
  /** 今日到期件数（snapshot.upcoming_delivery 中 date === today 的 count 之和） */
  todayCount: number;
  /** 两周到期件数（snapshot.upcoming_delivery 全 14 天桶 count 之和） */
  weekCount: number;
  /** 在制件数（snapshot.in_process.length，派生） */
  inProcessCount: number;
  /** 在检件数（snapshot.on_inspection_shelves.length，派生） */
  inInspectionCount: number;
}>();
</script>

<style lang="scss" scoped>
.kpi-row {
  display: grid;
  // 5 tile 横向 grid，minmax(0,1fr) 防止内容溢出撑爆列宽
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 12px;
  // ≤900px 退化为 2 列（两行 + 一行）
  @media (max-width: 900px) {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
.kpi-card {
  background: #fff;
  border-radius: 6px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
  :deep(.el-card__body) {
    padding: 14px 16px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  :deep(.el-statistic__title) {
    font-size: 13px;
    color: var(--text-secondary);
  }
  :deep(.el-statistic__content) {
    font-size: 24px;
    font-weight: 600;
  }
}
.kpi-restricted {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--text-secondary);
}
</style>