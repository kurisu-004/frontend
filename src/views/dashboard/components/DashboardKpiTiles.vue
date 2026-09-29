<!--
  DashboardKpiTiles.vue
  2026-09-29 新增：dashboard 域 KPI 横排 4 tile。
  - 逾期未交（Manager-only；非 Manager 渲染「需 Manager 权限」占位）
  - 今日到期（snapshot.upcoming_delivery 中 date === today 的 count 之和）
  - 本周到期（snapshot.upcoming_delivery 7 天 count 总和）
  - 紧急工单（useDashboardUrgentList.urgentCount）

  Props 由父组件 DashboardView 通过 composables 派生传入，组件本身不持状态。
  视觉：沿仓库卡片白底 + box-shadow 0 1px 3px rgba(0,0,0,0.08)；颜色按语义
  区分（逾期 danger / 今日 warning / 本周 primary / 紧急 success）。
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

    <!-- 3. 本周到期 -->
    <el-card shadow="never" class="kpi-card">
      <el-statistic
        :value="weekCount"
        title="本周到期"
        :value-style="{ color: 'var(--primary-color)' }"
      >
        <template #suffix>件</template>
      </el-statistic>
    </el-card>

    <!-- 4. 紧急工单 -->
    <el-card shadow="never" class="kpi-card">
      <el-statistic
        :value="urgentCount"
        title="紧急工单"
        :value-style="{
          color: urgentCount > 0 ? 'var(--el-color-danger)' : 'var(--text-primary)',
        }"
      >
        <template #suffix>件</template>
      </el-statistic>
    </el-card>
  </div>
</template>

<script setup lang="ts">
// 2026-09-29 新增：dashboard KPI 4 tile 展示壳。
//
// 验收要求（与方案 §2 对齐）：
//   - 今日到期 = upcoming_delivery 中 date === today 的 count 之和
//   - 本周到期 = upcoming_delivery 7 天 count 之和
//   - 紧急工单 = useDashboardUrgentList.items.filter(p => p.is_urgent).length
//   - 逾期未交 = useDashboardOverdue.overdue_undelivered_count（Manager-only）
//
// count 来自 backend-rust UpcomingDeliveryBucket.count（serde-i64 → string），
// 这里要 Number() 转换为数字。注意 count 可能是字符串或数字（API 兜底），
// 故用 Number() 兜底 → NaN 时 sum 仍为 0。

import { Lock } from '@element-plus/icons-vue';

defineProps<{
  /** Manager 角色标记；true 显逾期数字，false 显占位 */
  manager: boolean;
  /** 逾期未交件数（来自 useDashboardOverdue.overdueCount） */
  overdueCount: number;
  /** 今日到期件数（snapshot.upcoming_delivery 中 date === today 的 count 之和） */
  todayCount: number;
  /** 本周到期件数（snapshot.upcoming_delivery 7 天 count 总和） */
  weekCount: number;
  /** 紧急工单件数（useDashboardUrgentList.urgentCount） */
  urgentCount: number;
}>();
</script>

<style lang="scss" scoped>
.kpi-row {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
  // 移动端 fallback：≤640px 退化为 2 列
  @media (max-width: 640px) {
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
