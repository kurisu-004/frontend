<!--
  UpcomingDeliveryChart.vue
  2026-09-29 新增：未来 7 天交期分桶柱状图（ECharts 核心 API 直接用，不引入 vue-echarts）。
  2026-09-30 重构：单 series 改为 3 series 分层堆叠（顶层品检前 / 中层待品检待送货 /
  底层已送货），点击某一层 emit 事件给父组件打开抽屉。
  数据来源：snapshot.upcoming_delivery: {date, count, by_status}[]（by_status
  必填对象，OrderStatus → 件数）。
  视觉规则：
    - 顶层（top）= #1e4d8b 藏青（项目 primary）
    - 中层（middle）= #2c6cb8 蓝
    - 底层（bottom）= #4a8fd6 浅蓝
    - 2026-09-30 bugfix：ECharts canvas 不解析 CSS var()，全程 hex 字面量
      （与 src/views/statistics/OverviewTab.vue:204,212,232,234 同形态）。
-->
<template>
  <div class="chart-wrap">
    <div ref="chartRef" class="chart" :style="{ height }" />
  </div>
</template>

<script setup lang="ts">
// 2026-09-29 新增 + 2026-09-30 重构：dashboard「未来 7 天交期」柱状图组件。
//
// 设计要点：
//   - 直接 import echarts/core + BarChart + CanvasRenderer + Grid/Tooltip/LabelLayout，
//     避免拉全量 ~900KB bundle。
//   - props.buckets 由父组件 DashboardView 派生（snapshot.upcoming_delivery）。
//     组件本身不消费 Zod schema —— 守门发生在 useDashboardSnapshot.queryFn 入口，
//     入参已经是 z.infer 后的强类型 UpcomingDeliveryEntryData[]。
//   - 后端返的 buckets 可能不足 7 天（缺数据日期），前端按 today → today+6
//     补 0 桶，确保柱子始终 7 根。
//
// 2026-09-30 重构（plan §2.2）：
//   - 从单 series 改 3 series 堆叠（stack: 'delivery'）。
//   - 每 series 的 data = props.buckets.map(b => sum(b.by_status[layer.statuses])）。
//   - layer.statuses 来自模块级 LAYERS 常量，颜色用项目三主色（沿 src/styles/
//     variables.scss），不依赖日期色阶。
//   - 边框圆角：仅顶层 series 设 [4, 4, 0, 0]，其它 0。
//   - tooltip 自定义 formatter：日期 + 总件数 + 三层各自件数（>0 才列）。
//   - legend top:0，data 走 LAYERS.map(l => l.label)。
//   - click handler 通过 emit('barLayerClick', { date, layer, statuses })，
//     让父组件 DashboardView 打开 UpcomingDeliveryListDrawer。

import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import * as echarts from 'echarts/core';
import 'echarts/theme/v5'; // 2026-09-30 bugfix：与全局 <EChart> 锁定同一主题
import { BarChart } from 'echarts/charts';
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import { LabelLayout } from 'echarts/features';
import { CanvasRenderer } from 'echarts/renderers';
import type { ECharts, EChartsCoreOption } from 'echarts/core';
import type { UpcomingDeliveryEntryData } from '@/views/dashboard/composables/dashboardSnapshotSchema';
import type { OrderStatus } from '@/types/parts';

/** 2026-09-30 新增：3 层状态分组（沿 plan §2「状态分层映射」+ 项目主色）。
 *  - 顶层（top）5 状态：PENDING / PROGRAMMING / IN_PROCESS / REPAIRING / OUTSOURCE（品检前）
 *  - 中层（middle）2 状态：INSPECTION / READY_TO_SHIP（待品检 / 待送货）
 *  - 底层（bottom）1 状态：DELIVERED（已送货）
 *
 *  COMPLETED / CANCELLED 后端 SQL 沿现状 WHERE 排除，不会出现；不需要进 LAYERS。
 *  颜色用项目三主色（藏青 / 蓝 / 浅蓝），不用日期色阶。 */
interface UpcomingLayer {
  readonly key: 'top' | 'middle' | 'bottom';
  readonly label: string;
  readonly color: string;
  readonly statuses: readonly OrderStatus[];
}

const props = withDefaults(
  defineProps<{
    buckets: UpcomingDeliveryEntryData[];
    height?: string;
  }>(),
  { height: '320px' },
);

const emit = defineEmits<{
  barLayerClick: [payload: {
    date: string;
    layer: UpcomingLayer['key'];
    statuses: readonly OrderStatus[];
  }];
}>();

/** 2026-09-30 新增：3 层状态分组实例（必须在 defineProps/defineEmits 之后，
 *  沿 vue/define-macros-order ESLint 约定）。 */
const LAYERS: readonly UpcomingLayer[] = [
  {
    key: 'top',
    label: '品检前',
    color: '#1e4d8b',
    statuses: ['PENDING', 'PROGRAMMING', 'IN_PROCESS', 'REPAIRING', 'OUTSOURCE'],
  },
  {
    key: 'middle',
    label: '待品检/待送货',
    color: '#2c6cb8',
    statuses: ['INSPECTION', 'READY_TO_SHIP'],
  },
  {
    key: 'bottom',
    label: '已送货',
    color: '#4a8fd6',
    statuses: ['DELIVERED'],
  },
] as const;

echarts.use([
  BarChart,
  GridComponent,
  LabelLayout,
  LegendComponent,
  TooltipComponent,
  CanvasRenderer,
]);

const chartRef = ref<HTMLDivElement | null>(null);
const chart = shallowRef<ECharts | null>(null);
let resizeObserver: ResizeObserver | null = null;

/** 2026-09-29 新增：把 ISO 'YYYY-MM-DD' + 偏移天数转 'MM/DD' 标签。 */
function formatLabel(iso: string): string {
  return iso.slice(5).replace(/-/g, '/');
}

/** 2026-09-30 新增：补全 7 天 ISO 序列（today → today+6）。 */
function nextSevenDays(): string[] {
  const out: string[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + i);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    out.push(`${yyyy}-${mm}-${dd}`);
  }
  return out;
}

/** 2026-09-30 新增：从 bucket 派生某层 count = 该层 statuses 的 by_status 求和。
 *  by_status 是后端 BTreeMap<String, i64> 序列化输出；缺 key 视为 0 件。 */
function layerCount(bucket: UpcomingDeliveryEntryData, layer: UpcomingLayer): number {
  let n = 0;
  for (const st of layer.statuses) {
    const v = bucket.by_status[st];
    if (typeof v === 'number') n += v;
  }
  return n;
}

/** 2026-09-30 新增：把 buckets 按 7 天对齐，缺失日期补 0 桶。 */
function alignBuckets(
  buckets: UpcomingDeliveryEntryData[],
): { xLabels: string[]; aligned: UpcomingDeliveryEntryData[] } {
  const map = new Map<string, UpcomingDeliveryEntryData>();
  for (const b of buckets) map.set(b.date, b);
  const isos = nextSevenDays();
  const aligned: UpcomingDeliveryEntryData[] = [];
  const xLabels: string[] = [];
  for (const iso of isos) {
    xLabels.push(formatLabel(iso));
    const existing = map.get(iso);
    if (existing) {
      aligned.push(existing);
    } else {
      aligned.push({ date: iso, count: 0, by_status: {} });
    }
  }
  return { xLabels, aligned };
}

/** 2026-09-30 新增：ECharts 配置 builder。 */
function buildOption(buckets: UpcomingDeliveryEntryData[]): EChartsCoreOption {
  const { xLabels, aligned } = alignBuckets(buckets);
  const series = LAYERS.map((layer, idx) => ({
    name: layer.key,
    type: 'bar' as const,
    stack: 'delivery',
    data: aligned.map((b) => layerCount(b, layer)),
    itemStyle: {
      color: layer.color,
      // 仅顶层圆角（柱顶圆角 4px），其它 0。
      borderRadius: idx === 0 ? [4, 4, 0, 0] : 0,
    },
    // 每层数字标在层内顶部（沿 plan §2.2 #4）
    label: {
      show: true,
      position: 'insideTop',
      color: '#fff',
      fontSize: 11,
      formatter: (params: unknown) => {
        const p = params as { value: number };
        return p.value > 0 ? String(p.value) : '';
      },
    },
  }));

  return {
    // 顶部留位置给 legend + 每层标
    grid: { left: 40, right: 16, top: 36, bottom: 32 },
    legend: {
      data: LAYERS.map((l) => l.label),
      top: 0,
      textStyle: { fontSize: 12, color: '#606266' },
      itemWidth: 12,
      itemHeight: 12,
    },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (params: unknown) => {
        const arr = params as Array<{
          axisValue: string;
          seriesName: string;
          value: number;
          color: string;
          dataIndex: number;
        }>;
        if (!arr.length) return '';
        // 通过 aligned[0] === arr[0].dataIndex 找总件数（取所有 series 求和）
        // params 顺序与 LAYERS 顺序无关，用 axisValueLabel 反查 aligned。
        const total = arr.reduce((s, p) => s + (Number(p.value) || 0), 0);
        const dataIndex = arr[0]?.dataIndex ?? 0;
        const bucket = aligned[dataIndex];
        const dateLabel = bucket?.date ?? '';
        const rows: string[] = [`<b>${dateLabel}</b> · 共 ${total} 件`];
        for (const layer of LAYERS) {
          const n = layerCount(bucket ?? { date: '', count: 0, by_status: {} }, layer);
          if (n > 0) {
            rows.push(
              `<span style="display:inline-block;width:8px;height:8px;background:${layer.color};margin-right:4px;"></span>${layer.label} ${n} 件`,
            );
          }
        }
        return rows.join('<br/>');
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
    series,
  };
}

function initChart(el: HTMLDivElement): void {
  // 2026-09-30 bugfix：与全局 src/components/EChart.vue:83 对齐，
  // 锁定 v5 主题，避免 ECharts 6 默认主题带来的 subtle 视觉差异。
  const c = echarts.init(el, 'v5', { renderer: 'canvas' });
  chart.value = c;
  c.setOption(buildOption(props.buckets), true);
  // 2026-09-30 新增：click handler 把 seriesName 反查 LAYERS → emit 给父组件。
  // 父组件管 drawer 状态（沿 useDashboardUpcomingList 的 enabled 闸门）。
  c.on('click', (p: { seriesName?: string; dataIndex?: number }) => {
    const seriesName = p.seriesName;
    const dataIndex = p.dataIndex ?? 0;
    const layer = LAYERS.find((l) => l.key === seriesName);
    if (!layer) return;
    // 取对齐后 aligned[dataIndex].date（保证 ISO 形态稳定）
    const { aligned } = alignBuckets(props.buckets);
    const bucket = aligned[dataIndex];
    if (!bucket) return;
    emit('barLayerClick', {
      date: bucket.date,
      layer: layer.key,
      statuses: layer.statuses,
    });
  });
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