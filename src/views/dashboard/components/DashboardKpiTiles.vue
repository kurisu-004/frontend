<!--
  DashboardKpiTiles.vue
  dashboard 域 KPI 横排 5 tile（语义按风险递进排列）：
    - 逾期未交（snapshot.overdue_count）
    - 今日到期（交期分桶的首桶 count，后端恒从 today 起按序生成）
    - N 天到期（交期分桶全 N 桶 count 之和；N = props.days）
    - 在加工（工人在手加工批次数，snapshot.in_process.length）
    - 在检（品检区待品检批次数，snapshot.in_inspection_count）

  视觉：
  - 逾期红 / 今日橙 / N 天与在加工用 --primary-color（沿用项目主色，凸显「正在车间
    进行」生产实况）/ 在检用 --el-color-info（品检态相对中性，未必紧急）；
  - grid-template-columns: repeat(5, minmax(0, 1fr))，≤900px 退化为
    repeat(2, minmax(0, 1fr))（两行 + 一行）；
  - 各 tile 内部 el-statistic title / suffix 沿用原约定。

  Props 由父组件 DashboardView 通过 composables 派生传入，组件本身不持状态。
  逾期数**不做角色闸门**：后端该端点对所有登录用户返真实数字，前端加占位反而会
  自相矛盾（非 Manager 看到「需 Manager 权限」但同页其它人看到真实数字）。
-->
<template>
  <div class="kpi-row">
    <!-- 1. 逾期未交 -->
    <el-card shadow="never" class="kpi-card">
      <el-statistic
        :value="overdueCount"
        title="逾期未交"
        :value-style="{ color: 'var(--el-color-danger)' }"
      >
        <template #suffix>件</template>
      </el-statistic>
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

    <!-- 3. 窗口内到期（天数随柱状图窗口天数联动） -->
    <el-card shadow="never" class="kpi-card">
      <el-statistic :value="windowCount" :title="`${days} 天到期`" :value-style="{ color: 'var(--primary-color)' }">
        <template #suffix>件</template>
      </el-statistic>
    </el-card>

    <!-- 4. 在加工 -->
    <el-card shadow="never" class="kpi-card">
      <el-statistic
        :value="inProcessCount"
        title="在加工"
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
//   - 逾期未交 = snapshot.overdue_count（服务端 COUNT，工单级：装配件算 1 条）
//   - 今日到期 = 交期分桶的首桶 count（后端恒从 today 起按序生成，首桶即今天）
//   - N 天到期 = 交期分桶全 N 桶 count 之和（N = days，非按某个自然周切）
//   - 在加工 = 工人在手加工批次数（snapshot.in_process.length；后端硬约束
//     status='IN_PROCESS' AND location='WORKER'，语义是「压在工人手上」）
//   - 在检 = 品检区待品检批次数（snapshot.in_inspection_count，服务端 COUNT）
//
// 六个 props 全部由父组件 DashboardView 派生后传入；组件自身不消费 Zod schema、
// 不发请求。

withDefaults(
  defineProps<{
    /** 逾期未交件数（工单级） */
    overdueCount: number;
    /** 今日到期件数（交期分桶首桶的 count） */
    todayCount: number;
    /** 窗口内到期件数（交期分桶全 N 桶 count 之和） */
    windowCount: number;
    /** 柱状图窗口天数，只用于把窗口内到期的标签渲染成「N 天到期」。 */
    days?: number;
    /** 在加工件数（工人在手加工批次数） */
    inProcessCount: number;
    /** 在检件数（品检区待品检批次数） */
    inInspectionCount: number;
  }>(),
  { days: 14 },
);
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
</style>
