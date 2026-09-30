<!--
  UpcomingDeliveryChart.vue
  2026-09-29 新增：未来 7 天交期分桶柱状图（ECharts 核心 API 直接用，不引入 vue-echarts）。

  数据来源：snapshot.upcoming_delivery: {date, count}[]（date 'YYYY-MM-DD'，count i64 → string）
  视觉规则：
    - 今天 = 红色柱（#f56c6c，EP danger 默认）
    - 后 1-3 天 = 橙色柱（#e6a23c，EP warning 默认）
    - 后 4-6 天 = 蓝色柱（#1e4d8b，项目 primary）
    2026-09-30 bugfix：ECharts canvas 不解析 CSS var()，改用 hex 字面量
    （与 src/views/statistics/OverviewTab.vue:204,212,232,234 同形态）。
-->
<template>
  <div class="chart-wrap">
    <div ref="chartRef" class="chart" :style="{ height }" />
  </div>
</template>

<script setup lang="ts">
// 2026-09-29 新增：dashboard「未来 7 天交期」柱状图组件。
//
// 设计要点：
//   - 直接 import echarts/core + BarChart + CanvasRenderer + Grid/Tooltip/LabelLayout，
//     避免拉全量 ~900KB bundle。
//   - props.buckets 由父组件 DashboardView 派生（snapshot.upcoming_delivery）。
//     组件本身不消费 Zod schema —— 守门发生在 useDashboardSnapshot.queryFn 入口，
//     入参已经是 z.infer 后的强类型 UpcomingDeliveryEntryData[]。
//   - 后端返的 buckets 可能不足 7 天（缺数据日期），前端按 today → today+6
//     补 0 桶 + 默认蓝色，确保柱子始终 7 根。
//
// 视觉规则（沿方案 §2）：
//   - 今天（diff === 0） → 红色（#f56c6c）
//   - 后 1-3 天（diff 1..3） → 橙色（#e6a23c）
//   - 后 4-6 天（diff 4..6） → 蓝色（#1e4d8b）
// 2026-09-30 bugfix：ECharts canvas renderer 不解析 CSS var()，改 hex 字面量
// 锁定视觉（与 OverviewTab.vue 同形态）。

import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import * as echarts from 'echarts/core';
import 'echarts/theme/v5'; // 2026-09-30 bugfix：与全局 <EChart> 锁定同一主题
import { BarChart } from 'echarts/charts';
import { GridComponent, TooltipComponent } from 'echarts/components';
import { LabelLayout } from 'echarts/features';
import { CanvasRenderer } from 'echarts/renderers';
import type { ECharts, EChartsCoreOption } from 'echarts/core';
import type { UpcomingDeliveryEntryData } from '@/views/dashboard/composables/dashboardSnapshotSchema';

const props = withDefaults(
  defineProps<{
    buckets: UpcomingDeliveryEntryData[];
    height?: string;
  }>(),
  { height: '300px' },
);

echarts.use([BarChart, GridComponent, LabelLayout, TooltipComponent, CanvasRenderer]);

const chartRef = ref<HTMLDivElement | null>(null);
const chart = shallowRef<ECharts | null>(null);
let resizeObserver: ResizeObserver | null = null;

/** 2026-09-29 新增：把 ISO 'YYYY-MM-DD' + 偏移天数转 'MM/DD' 标签。 */
function formatLabel(iso: string): string {
  return iso.slice(5).replace(/-/g, '/');
}

/** 2026-09-29 新增：从 buckets 派生出 7 柱对齐的 (label, count, color) 三元组。
 *  后端返的 buckets 可能不足 7 天（缺数据日期桶），补 0 桶 + 蓝色。 */
function buildSeries(
  buckets: UpcomingDeliveryEntryData[],
): { xLabels: string[]; counts: number[]; colors: string[] } {
  const map = new Map<string, number>();
  for (const b of buckets) {
    map.set(b.date, Number(b.count) || 0);
  }
  const xLabels: string[] = [];
  const counts: number[] = [];
  const colors: string[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + i);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const iso = `${yyyy}-${mm}-${dd}`;
    xLabels.push(formatLabel(iso));
    counts.push(map.get(iso) ?? 0);
    // 2026-09-30 bugfix：CSS var() 在 ECharts canvas renderer 不被解析，
    // 柱子会透明不可见。改 hex 字面量（与 OverviewTab.vue 同形态）。
    if (i === 0) {
      colors.push('#f56c6c'); // 今天：EP danger 默认红
    } else if (i <= 3) {
      colors.push('#e6a23c'); // 后 1-3 天：EP warning 默认橙
    } else {
      colors.push('#1e4d8b'); // 后 4-6 天：项目 primary 藏青
    }
  }
  return { xLabels, counts, colors };
}

/** 2026-09-29 新增：ECharts 配置 builder。 */
function buildOption(buckets: UpcomingDeliveryEntryData[]): EChartsCoreOption {
  const { xLabels, counts, colors } = buildSeries(buckets);
  return {
    grid: { left: 40, right: 16, top: 24, bottom: 32 },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (params: unknown) => {
        const arr = params as Array<{ axisValue: string; data: number; color: string }>;
        if (!arr.length) return '';
        const p = arr[0];
        return `${p.axisValue}<br/><span style="display:inline-block;width:8px;height:8px;background:${p.color};margin-right:4px;"></span>${p.data} 件`;
      },
    },
    xAxis: {
      type: 'category',
      data: xLabels,
      axisLine: { lineStyle: { color: '#dcdfe6' } },
      axisTick: { show: false },
      axisLabel: { color: '#606266', fontSize: 12 },
    },
    yAxis: {
      type: 'value',
      axisLine: { show: false },
      axisTick: { show: false },
      splitLine: { lineStyle: { color: '#f0f2f5' } },
      axisLabel: { color: '#909399', fontSize: 12 },
    },
    series: [
      {
        type: 'bar',
        data: counts.map((c, i) => ({
          value: c,
          itemStyle: { color: colors[i], borderRadius: [4, 4, 0, 0] },
        })),
        barWidth: '60%',
        // ECharts v6 bar label：显数字在柱顶
        label: {
          show: true,
          position: 'top',
          color: '#606266',
          fontSize: 12,
          formatter: (params: unknown) => {
            const p = params as { value: number };
            return p.value > 0 ? String(p.value) : '';
          },
        },
      },
    ],
  };
}

function initChart(el: HTMLDivElement): void {
  // 2026-09-30 bugfix：与全局 src/components/EChart.vue:83 对齐，
  // 锁定 v5 主题，避免 ECharts 6 默认主题带来的 subtle 视觉差异。
  const c = echarts.init(el, 'v5', { renderer: 'canvas' });
  chart.value = c;
  c.setOption(buildOption(props.buckets), true);
  resizeObserver = new ResizeObserver(() => c.resize());
  resizeObserver.observe(el);
}

onMounted(() => {
  const el = chartRef.value;
  if (el) initChart(el);
});

watch(
  () => props.buckets,
  (next) => {
    const c = chart.value;
    if (!c) return;
    c.setOption(buildOption(next), true);
  },
  { deep: true },
);

onBeforeUnmount(() => {
  if (resizeObserver) {
    resizeObserver.disconnect();
    resizeObserver = null;
  }
  if (chart.value) {
    chart.value.dispose();
    chart.value = null;
  }
});
</script>

<style lang="scss" scoped>
.chart-wrap {
  width: 100%;
  min-width: 0;
  background: #fff;
  border-radius: 6px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
  padding: 8px;
}
.chart {
  width: 100%;
  min-width: 0;
}
</style>
