<!--
  UpcomingDeliveryChart.vue
  2026-09-29 新增：未来 7 天交期分桶柱状图（ECharts 核心 API 直接用，不引入 vue-echarts）。
  2026-09-30 重构：单 series 改为 3 series 分层堆叠（顶层品检前 / 中层待品检待送货 /
  底层已送货），点击某一层 emit 事件给父组件打开抽屉。
  数据来源：snapshot.upcoming_delivery: {date, count, by_status}[]（by_status
  必填对象，OrderStatus → 件数）。
  视觉规则（2026-09-30 末次调整）：
    - 底层（bottom）= #0FFCBE 亮青绿（已送货）
    - 中层（middle）= #FFCC00 警示黄（待品检 / 待送货）
    - 顶层（top）= #B4121B 警示红（品检前所有工序异常累积）
  2026-10-01 重构：参考 echarts 官方 stacked-horizontal-bar 示例，改为横向堆叠；series 加 emphasis.focus='series'。
  2026-09-30（Phase 4 vue-echarts 化）重构：迁 vue-echarts 8.3 <v-chart>，
  移除 echarts.init / ResizeObserver / dispose 自管（vue-echarts 自管生命周期）。
  - 时间窗从 7 天扩到 14 天（today → today+13），让 ops 看到两周趋势。
  - LAYERS 顺序调整为 [bottom, middle, top] —— 视觉从下到上按"完成度递增"
    （已送货 → 待品检待送货 → 品检前），配 yAxis.inverse=true 让 today 在顶。
  - 移除 series.itemStyle.borderRadius（横向堆叠时圆角意义不大）。
  - 保留：横向堆叠 + emphasis.focus='series' + theme='v5' + renderer='canvas'。
  - click 通过 @click emit 透传（vue-echarts 的 @click payload 与 chart.on('click', ...)
    形态一致 —— seriesName / dataIndex / value 等字段由 ECElementEvent 提供）。
-->
<template>
  <div class="chart-wrap">
    <v-chart
      class="chart"
      :option="chartOption"
      :update-options="{ notMerge: true }"
      :init-options="{ renderer: 'canvas' }"
      :style="{ height: height, width: '100%' }"
      theme="v5"
      autoresize
      @click="onChartClick"
    />
  </div>
</template>

<script setup lang="ts">
// 2026-09-29 新增 + 2026-09-30 重构 + 2026-09-30 Phase 4 迁 vue-echarts 8.3：
// dashboard「未来 14 天交期」柱状图组件。
//
// 设计要点：
//   - 不再直用 echarts/core —— 全部委托给全局 <v-chart>（main.ts:82 注册）。
//   - LAYERS 颜色与项目主色解耦（项目主色三蓝是为 UI 框架配的，dashboard
//     "剩余 / 紧急 / 已完成" 语义用 警示红 / 警示黄 / 亮青绿 三色更贴切）。
//   - props.buckets 由父组件 DashboardView 派生（snapshot.upcoming_delivery）。
//     组件本身不消费 Zod schema —— 守门发生在 useDashboardSnapshot.queryFn 入口，
//     入参已经是 z.infer 后的强类型 UpcomingDeliveryEntryData[]。
//   - 后端返的 buckets 可能不足 14 天（缺数据日期），前端按 today → today+13
//     补 0 桶，确保柱子始终 14 根。
//   - chartOption 是 computed（依赖 props.buckets），vue-echarts 内部 watch 自动 setOption。
//   - click @click payload 类型 ECElementEvent，seriesName 即 series.name（中文 label），
//     dataIndex 即 yAxis category 索引；反查 LAYERS.find(l => l.label === seriesName)
//     得到 layer，emit 时仍用 layer.key（英文 ID）以保父组件契约不变。
//   - vue-echarts autoresize prop 自管 ResizeObserver，无需手写 observe / disconnect。
//   - 主题仍锁 v5（沿 src/components/EChart.vue:83 + 2026-09-30 bugfix）。

import { computed } from 'vue';
import type { ECElementEvent } from 'echarts/core';
import type { EChartsCoreOption } from 'echarts/core';
import type { UpcomingDeliveryEntryData } from '@/views/dashboard/composables/dashboardSnapshotSchema';
import type { OrderStatus } from '@/types/parts';

/** 2026-09-30 重构 + Phase 4 调整：3 层状态分组。
 *  - 顶层（top）5 状态：PENDING / PROGRAMMING / IN_PROCESS / REPAIRING / OUTSOURCE（品检前）
 *  - 中层（middle）2 状态：INSPECTION / READY_TO_SHIP（待品检 / 待送货）
 *  - 底层（bottom）1 状态：DELIVERED（已送货）
 *
 *  COMPLETED / CANCELLED 后端 SQL 沿现状 WHERE 排除，不会出现；不需要进 LAYERS。
 *  Phase 4 调整：颜色用"警示色阶"（红 / 黄 / 亮青绿），更贴合 dashboard
 *  风险语境的视觉直觉；不再用项目主色三蓝（沿 plan §3.2）。 */
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

/** 2026-09-30 新增 + Phase 4 调整：3 层状态分组实例（必须在 defineProps/defineEmits 之后，
 *  沿 vue/define-macros-order ESLint 约定）。
 *  Phase 4 顺序：[bottom, middle, top] —— ECharts 横向堆叠时，series 数组中后入的
 *  series 会渲染在更靠右（视觉顶端）。LAYERS 顺序与系列渲染顺序严格一致，
 *  legend.data 与 series.name 也用 LAYERS.map(l => l.label) 保持字符串对齐
 *  （沿 2026-10-01 bugfix：避免「xxx series not exists」警告）。 */
const LAYERS: readonly UpcomingLayer[] = [
  {
    key: 'bottom',
    label: '已送货',
    color: '#0FFCBE',
    statuses: ['DELIVERED'],
  },
  {
    key: 'middle',
    label: '待品检/待送货',
    color: '#FFCC00',
    statuses: ['INSPECTION', 'READY_TO_SHIP'],
  },
  {
    key: 'top',
    label: '品检前',
    color: '#B4121B',
    statuses: ['PENDING', 'PROGRAMMING', 'IN_PROCESS', 'REPAIRING', 'OUTSOURCE'],
  },
] as const;

/** 2026-09-29 新增：把 ISO 'YYYY-MM-DD' + 偏移天数转 'MM/DD' 标签。 */
function formatLabel(iso: string): string {
  return iso.slice(5).replace(/-/g, '/');
}

/** 2026-09-30 新增 + Phase 4 调整：补全 14 天 ISO 序列（today → today+13）。 */
function nextFourteenDays(): string[] {
  const out: string[] = [];
  for (let i = 0; i < 14; i++) {
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

/** 2026-09-30 新增 + Phase 4 调整：把 buckets 按 14 天对齐，缺失日期补 0 桶。 */
function alignBuckets(
  buckets: UpcomingDeliveryEntryData[],
): { xLabels: string[]; aligned: UpcomingDeliveryEntryData[] } {
  const map = new Map<string, UpcomingDeliveryEntryData>();
  for (const b of buckets) map.set(b.date, b);
  const isos = nextFourteenDays();
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

/** 2026-09-30 新增 + Phase 4 vue-echarts 化：单一对齐数据 computed，
 *  chartOption 与 onChartClick 共享，避免重复跑 alignBuckets（沿 2026-09-30
 *  原 lastAligned 闭包缓存的语义）。 */
const alignedData = computed(() => alignBuckets(props.buckets));

/** 2026-09-30 新增 + Phase 4 vue-echarts 化：ECharts 配置 builder 转 computed。
 *  依赖 props.buckets，vue-echarts 内部 watch 自动 setOption（notMerge: true）。 */
const chartOption = computed<EChartsCoreOption>(() => {
  const { xLabels, aligned } = alignedData.value;
  // 2026-10-01 bugfix + Phase 4 沿用：series.name 必须与 legend.data 逐字相等，
  // 否则 ECharts 在 setOption / resize 重算 legend 时打印
  // 「xxx series not exists」警告（图例显示用 label 中文；click handler 通过
  // LAYERS.find((l) => l.label === seriesName) 反查，emit 时仍用 layer.key 发英文 ID）。
  const series = LAYERS.map((layer) => ({
    name: layer.label,
    type: 'bar' as const,
    stack: 'delivery',
    data: aligned.map((b) => layerCount(b, layer)),
    itemStyle: {
      color: layer.color,
      // 2026-09-30 Phase 4：移除 borderRadius —— 横向堆叠时圆角意义不大，
      // ECharts 内部已对 stack 顶段（视觉最右段）自动接管视觉对齐。
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
    // 2026-10-01 重构：对齐 echarts 官方示例 — hover 时本 series 高亮，其它 series 弱化
    emphasis: { focus: 'series' },
  }));

  return {
    // 顶部留位置给 legend + 每层标
    // 2026-10-01 重构：横向图日期轴在 Y，需 left >= 50；底部无 category 轴，bottom 收窄。
    grid: { left: 60, right: 24, top: 36, bottom: 24 },
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
        // 通过 aligned[dataIndex] 找总件数（取所有 series 求和）
        const total = arr.reduce((s, p) => s + (Number(p.value) || 0), 0);
        const dataIndex = arr[0]?.dataIndex ?? 0;
        const bucket = aligned[dataIndex];
        const dateLabel = bucket?.date ?? '';
        // 2026-09-30（review #4）防御性注释：rows.push 拼的是 innerHTML。
        // 文案源自模块常量（layer.label）+ 后端 ISO 日期串（slice 5 取 MM/DD
        // 格式）+ 件数 number.toString——禁止插任何用户输入；如未来要展示
        // 自由文本字段，必须改 echarts tooltip 的 text-only 渲染或先 HTML
        // escape，否则 XSS。
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
    // 2026-10-01 重构 + Phase 4：横向图 xAxis=value / yAxis=category，
    // yAxis.inverse=true 让 today 在顶（与原 7 天 rtl 排序保持一致的视觉顺序）。
    xAxis: {
      type: 'value',
      axisLine: { show: false },
      axisTick: { show: false },
      splitLine: { lineStyle: { color: '#f0f2f5' } },
      axisLabel: { color: '#909399', fontSize: 12 },
    },
    yAxis: {
      type: 'category',
      data: xLabels,
      inverse: true,
      axisLine: { lineStyle: { color: '#dcdfe6' } },
      axisTick: { show: false },
      axisLabel: { color: '#606266', fontSize: 12 },
    },
    series,
  };
});

/** 2026-09-30 新增 + Phase 4 vue-echarts 化：click handler 把 seriesName 反查
 *  LAYERS → emit 给父组件。父组件管 drawer 状态（沿 useDashboardUpcomingList
 *  的 enabled 闸门）。
 *  vue-echarts 的 @click payload 与 chart.on('click', ...) 形态一致 —— 即
 *  ECElementEvent —— 含 seriesName / dataIndex / value / name 等。 */
function onChartClick(p: ECElementEvent): void {
  const seriesName = p.seriesName;
  const dataIndex = p.dataIndex ?? 0;
  // series.name 是 label (中文)，反查改用 label（沿 2026-10-01 bugfix）。
  const layer = LAYERS.find((l) => l.label === seriesName);
  if (!layer) return;
  // 取对齐后 aligned[dataIndex].date（保证 ISO 形态稳定）。
  const bucket = alignedData.value.aligned[dataIndex];
  if (!bucket) return;
  emit('barLayerClick', {
    date: bucket.date,
    layer: layer.key,
    statuses: layer.statuses,
  });
}
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
