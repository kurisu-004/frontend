<!--
  UpcomingDeliveryChart.vue
  dashboard「交期分桶」横向堆叠柱状图，时间窗 14 天（today → today+13）。
  3 series 分层（底层已送货 / 中层待品检待送货 / 顶层品检前），点击某一层 emit
  barLayerClick 给父组件打开抽屉。

  数据来源：snapshot.upcoming_delivery: {date, count, by_status}[]（by_status
  必填对象，OrderStatus → 件数）。分桶落在哪个日期列上由**交期统计口径**决定
  （props.basis：planned = planned_delivery_date 计划交期 / system =
  system_delivery_date 系统交期），后端按 basis 换 SQL 日期列，wire 形态不变。

  口径开关（2026-10-04 新增）：
  - 位置：图卡内**右上角绝对定位浮层**（.chart-wrap 拿 position: relative 做定位
    上下文），不新增头部行、不改左栏 flex 布局；
  - 组件**不持口径状态**：props.basis 进、emit('update:basis') 出，唯一状态源是父组件
    DashboardView（与抽屉的 update:modelValue 同风格，不用 defineModel）；
  - 开关旁挂一句随口径变化的提示，用 el-tooltip 承载（trigger 含 hover + focus +
    触发元素 tabindex=0，键盘也能读到；aria-label 挂在无 role 的 span 上会被多数
    屏幕阅读器忽略，title 则只对鼠标悬停生效）：system_delivery_date 可空，后端对
    NULL 做范围比较恒 false ⇒ 未填系统交期的工单在系统口径下整件不计入；
    planned_delivery_date 是 NOT NULL 列，计划口径无此缺失。两种口径的统计结果不可
    互相替代，各桶件数随口径变化，而两口径合计**无可比大小关系**（同一工单的两列可能
    落在窗口内外不同侧）。不说清楚用户会把差异误读成数据丢失。
  - 宽度预算：3 个图例项 ≈230px + 开关 ≈165px ≈ 395px。最窄双栏视口 1101px
    （单列断点 1100px 再宽 1px）下左栏可用宽 =（1101 − 165 侧栏 − 16 .el-main
    padding − 32 .dashboard padding − 16 grid gap）按 3fr/5fr 分 ≈514px，
    .chart-wrap 扣掉自身 8px×2 padding ≈498px（用的是 box-shadow，没有 border）。
    395 < 498 ⇒ 不撞，余量 ~100px；≤1100px 走单列布局，图表区更宽。图例因此钉
    left: 0（不居中），给右侧留出开关。

  口径占位提示（2026-10-04 新增）：props.stale = 父组件 snapshot query 的
  isPlaceholderData，即「换了键、新键还没数据、正拿上一份占位」，此刻图上的数字属于
  **上一个口径**。不给提示就成了「开关已切到系统、数字还是计划的」。实现是一层绝对
  定位的半透明覆盖层（纯 DOM，不进 ECharts option）⇒ 与 updateOptions.notMerge 的
  整份替换互不干扰；z-index 压在口径开关之下，开关始终可点、可继续切口径。
  prop 名用 stale 而不是「加载中」类的名字：这一层要表达的是「数字不是当前口径的」，
  不是「正在取数」。同 queryKey 的后台 refetch（WS 事件驱动的周期性刷新）会让
  isFetching 为 true，而那时图上数字是当前且正确的，拿它当信号就会让这层在用户什么都
  没干时反复播报「口径切换中」。

  视觉 / 实现规则（改动本图时必须守住的不变量）：
  - 颜色走 EP 预设 hex（success #67c23a / warning #e6a23c / danger #f56c6c），
    与 UpcomingDeliveryListDrawer 的 LAYER_COLOR 一致，形成「柱色 ↔ 抽屉层标签」
    闭环。**必须用 hex 而非 var(--el-color-*)** —— ECharts Canvas renderer 解析
    CSS var() 不可靠，会出现「系列不渲染」或「取色失败」静默 fail。
  - LAYERS 顺序 [bottom, middle, top] 必须与 series 渲染顺序、legend.data 顺序
    逐字一致，否则 ECharts 打印「xxx series not exists」；LAYERS 顺序同时是视觉
    「完成度递增」（已送货 → 待品检待送货 → 品检前），配 yAxis.inverse=true 让
    today 在顶。
  - series.name（中文 label）与 legend.data 字符串相等，但 barLayerClick emit 出
    的是英文 layer.key。
  - tooltip formatter 拼 innerHTML，**只允许拼模块常量 + 后端 ISO 日期 + 数字**，
    禁插用户输入。
  - 走 vue-echarts 8.3 的全局 <v-chart>（theme v5 + renderer canvas + autoresize +
    updateOptions.notMerge），不自管 echarts.init / ResizeObserver / dispose。
  - series 加 emphasis.focus='series'，hover 时本层高亮、其余弱化。
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
    <!-- 口径开关浮层：受控用法（:model-value 进、@change 出），选中态由父组件
         持有。el-radio-button 用 value 属性（EP ≥2.6）而非已废弃的 label 当值。 -->
    <div class="basis-toggle">
      <el-radio-group
        :model-value="basis"
        size="small"
        aria-label="交期统计口径"
        @change="onBasisChange"
      >
        <el-radio-button value="planned">计划交期</el-radio-button>
        <el-radio-button value="system">系统交期</el-radio-button>
      </el-radio-group>
      <el-tooltip :content="basisHint" placement="bottom" :trigger="['hover', 'focus']">
        <span class="basis-hint" tabindex="0" :aria-label="basisHint">ⓘ</span>
      </el-tooltip>
    </div>
    <!-- 口径占位期间盖一层半透明提示：keepPreviousData 让图上数字还是上一口径的，
         没有这层就成了「开关已切、数字没切」。不吃点击（见样式里的 pointer-events）。 -->
    <div v-if="stale" class="chart-pending" role="status">
      <span class="chart-pending-text">口径切换中…</span>
    </div>
  </div>
</template>

<script setup lang="ts">
// dashboard「交期分桶」柱状图组件。
//
// 设计要点：
//   - 不直用 echarts/core —— 全部委托给全局 <v-chart>。
//   - LAYERS 颜色走 Element Plus 预设 hex（success #67c23a / warning #e6a23c /
//     danger #f56c6c），与 UpcomingDeliveryListDrawer 的 LAYER_COLOR 保持一致，
//     形成「柱状图色块 ↔ 抽屉层标签」的视觉闭环。必须用 hex 而非
//     var(--el-color-*)：ECharts Canvas renderer 解析 CSS var() 不可靠。
//   - props.buckets 由父组件 DashboardView 派生（snapshot.upcoming_delivery）。
//     组件本身不消费 Zod schema —— 守门发生在 useDashboardSnapshot.queryFn 入口，
//     入参已经是 z.infer 后的强类型 UpcomingDeliveryEntryData[]。
//   - 后端返的 buckets 可能不足 14 天（缺数据日期），前端按 today → today+13
//     补 0 桶，确保柱子始终 14 根。
//   - chartOption 是 computed（依赖 props.buckets），vue-echarts 内部 watch 自动 setOption。
//   - click @click payload 类型 ECElementEvent，seriesName 即 series.name（中文 label），
//     dataIndex 即 yAxis category 索引；反查 LAYERS.find(l => l.label === seriesName)
//     得到 layer，emit 时仍用 layer.key（英文 ID）以保父组件契约不变。
//   - 2026-10-04：交期统计口径 props.basis 是**只读入参** + emit('update:basis') 出参
//     （受控组件，状态源在 DashboardView）。柱状图不因口径改任何渲染逻辑 —— buckets
//     由父组件按当前口径的 snapshot 派生，组件只负责画；口径真正要驱动的是后端请求
//     （useDashboardSnapshot 的 queryKey 含 basis）与下钻（抽屉按 basis 发日期窗口）。
//   - vue-echarts autoresize prop 自管 ResizeObserver，无需手写 observe / disconnect。
//   - 主题锁 v5。

import { computed } from 'vue';
import type { ECElementEvent } from 'echarts/core';
import type { EChartsCoreOption } from 'echarts/core';
import type { UpcomingDeliveryEntryData } from '@/views/dashboard/composables/dashboardSnapshotSchema';
import type { OrderStatus } from '@/types/parts';
import type { DeliveryBasis } from '@/types/dashboard';

/** 3 层状态分组。
 *  - 顶层（top）4 状态：PENDING / PROGRAMMING / IN_PROCESS / OUTSOURCE（品检前）
 *  - 中层（middle）2 状态：INSPECTION / READY_TO_SHIP（待品检 / 待送货）
 *  - 底层（bottom）1 状态：DELIVERED（已送货）
 *
 *  COMPLETED / CANCELLED 后端 SQL 沿现状 WHERE 排除，不会出现；不需要进 LAYERS。
 *  REPAIRING 后端 2026-10-01 起不再产生，也不进 LAYERS —— 保留它不会降级也不会 400
 *  （statuses 在后端零校验 + `= ANY` 文本比较），但会恒匹配 0 行，即点了顶层柱看到
 *  空抽屉。
 *  颜色走 EP 预设 hex（success green #67c23a / warning orange #e6a23c /
 *  danger red #f56c6c），对齐项目其它 danger/warning/success 标签。
 *  **必须用 hex 而非 var()** —— ECharts Canvas renderer 解析 var() 不可靠。 */
interface UpcomingLayer {
  readonly key: 'top' | 'middle' | 'bottom';
  readonly label: string;
  readonly color: string;
  readonly statuses: readonly OrderStatus[];
}

const props = withDefaults(
  defineProps<{
    buckets: UpcomingDeliveryEntryData[];
    /** 2026-10-04 新增：交期统计口径（唯一状态源在父组件，本组件只读 + emit）。
     *  必填不兜默认值：默认值会掩盖父组件漏传 wiring，柱状图就会静默按计划交期画。 */
    basis: DeliveryBasis;
    /** 2026-10-04 新增：图上数字是否还是**上一个口径**的（父组件传该 query 的
     *  isPlaceholderData，即换键占位中）。为 true 时盖一层「口径切换中」提示。
     *  必填同上，不兜默认值 —— 默认 false 会让「正在占位」这个状态静默消失。 */
    stale: boolean;
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
  /** 2026-10-04 新增：口径切换上抛（父组件改 basis → snapshot 换键 refetch）。 */
  'update:basis': [value: DeliveryBasis];
}>();

/** 3 层状态分组实例（必须在 defineProps/defineEmits 之后，沿 vue/define-macros-order
 *  ESLint 约定）。
 *  顺序 [bottom, middle, top] —— ECharts 横向堆叠时，series 数组中后入的 series 会
 *  渲染在更靠右（视觉顶端）。LAYERS 顺序与系列渲染顺序严格一致，legend.data 与
 *  series.name 也用 LAYERS.map(l => l.label) 保持字符串对齐（否则 ECharts 在
 *  setOption / resize 重算 legend 时打印「xxx series not exists」警告）。 */
const LAYERS: readonly UpcomingLayer[] = [
  {
    key: 'bottom',
    label: '已送货',
    color: '#67c23a',
    statuses: ['DELIVERED'],
  },
  {
    key: 'middle',
    label: '待品检/待送货',
    color: '#e6a23c',
    statuses: ['INSPECTION', 'READY_TO_SHIP'],
  },
  {
    key: 'top',
    label: '品检前',
    color: '#f56c6c',
    statuses: ['PENDING', 'PROGRAMMING', 'IN_PROCESS', 'OUTSOURCE'],
  },
] as const;

/** 把 ISO 'YYYY-MM-DD' 转 'MM/DD' 标签。 */
function formatLabel(iso: string): string {
  return iso.slice(5).replace(/-/g, '/');
}

/** 补全 14 天 ISO 序列（today → today+13）。 */
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

/** 从 bucket 派生某层 count = 该层 statuses 的 by_status 求和。
 *  by_status 是后端 BTreeMap<String, i64> 序列化输出；缺 key 视为 0 件。 */
function layerCount(bucket: UpcomingDeliveryEntryData, layer: UpcomingLayer): number {
  let n = 0;
  for (const st of layer.statuses) {
    const v = bucket.by_status[st];
    if (typeof v === 'number') n += v;
  }
  return n;
}

/** 把 buckets 按 14 天对齐，缺失日期补 0 桶。 */
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

/** 单一对齐数据 computed，chartOption 与 onChartClick 共享，避免重复跑 alignBuckets。 */
const alignedData = computed(() => alignBuckets(props.buckets));

/** ECharts 配置 builder 转 computed。依赖 props.buckets，vue-echarts 内部 watch
 *  自动 setOption（notMerge: true）。 */
const chartOption = computed<EChartsCoreOption>(() => {
  const { xLabels, aligned } = alignedData.value;
  // series.name 必须与 legend.data 逐字相等，
  // 否则 ECharts 在 setOption / resize 重算 legend 时打印
  // 「xxx series not exists」警告（图例显示用 label 中文；click handler 通过
  // LAYERS.find((l) => l.label === seriesName) 反查，emit 时仍用 layer.key 发英文 ID）。
  const series = LAYERS.map((layer) => ({
    name: layer.label,
    type: 'bar' as const,
    stack: 'delivery',
    data: aligned.map((b) => layerCount(b, layer)),
    // barMaxWidth 限宽 18px —— 14 天横向堆叠视觉拥挤，加 max 宽度后保持每根柱
    // 细瘦、不挡数字标；ECharts stacked bar 不需要 barGap 调整（堆叠条本身已经紧密）。
    barMaxWidth: 18,
    // 不设 itemStyle.borderRadius —— 横向堆叠时圆角意义不大，ECharts 内部已对
    // stack 顶段（视觉最右段）自动接管视觉对齐。
    itemStyle: { color: layer.color },
    // 每层数字标在层内顶部
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
    // 顶部留位置给 legend + 每层标；日期轴在 Y，left 需留够标签宽度，底部无 category
    // 轴故 bottom 收窄。
    grid: { left: 60, right: 24, top: 36, bottom: 24 },
    legend: {
      data: LAYERS.map((l) => l.label),
      top: 0,
      // 2026-10-04：钉 left: 0（不居中）。3 个图例项 ≈230px 从左侧起排，右上角
      // 留给口径开关浮层（≈165px）；最窄双栏视口 1101px 下 .chart-wrap 内层 ≈495px，
      // 两者合计 ≈395px 不撞（预算推导见文件头注释）。
      left: 0,
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
        // 防御性注释：rows.push 拼的是 innerHTML。
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
    // 横向图 xAxis=value / yAxis=category，yAxis.inverse=true 让 today 在顶。
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

/** click handler 把 seriesName 反查 LAYERS → emit 给父组件。父组件管 drawer 状态
 *  （沿 useDashboardUpcomingList 的 enabled 闸门）。
 *  vue-echarts 的 @click payload 与 chart.on('click', ...) 形态一致 —— 即
 *  ECElementEvent —— 含 seriesName / dataIndex / value / name 等。 */
function onChartClick(p: ECElementEvent): void {
  const seriesName = p.seriesName;
  const dataIndex = p.dataIndex ?? 0;
  // series.name 是 label（中文），反查用 label。
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

/** 2026-10-04 新增：口径开关提示文案，随当前口径变化。
 *  关键差异只有系统口径有：system_delivery_date 可空，后端对 NULL 做范围比较恒
 *  false ⇒ 未填系统交期的工单在系统口径下**整件不计入**；planned_delivery_date 是
 *  NOT NULL 列，计划口径没有这个缺失。两口径用的**是同一个日期窗口**、只是打在不同
 *  列上，所以合计之间没有大小关系（同一工单的计划交期落在窗口外、系统交期落在窗口
 *  内是常态）——文案只陈述差异来源，不对两个合计做方向性断言。不讲清楚，用户会把
 *  「件数变了」读成数据丢失。 */
const basisHint = computed(() =>
  props.basis === 'system'
    ? '系统交期口径：未填写系统交期的工单整件不计入，合计与计划交期口径不同'
    : '计划交期口径：按计划交期分桶，工单全部计入',
);

/** 2026-10-04 新增：el-radio-group change → emit('update:basis')。
 *  受控用法（本组件不持状态），并把 EP 的 string|number|boolean 收敛回两个合法
 *  口径值，不做 `as DeliveryBasis` 强转。 */
function onBasisChange(v: string | number | boolean | undefined): void {
  emit('update:basis', v === 'system' ? 'system' : 'planned');
}
</script>

<style lang="scss" scoped>
.chart-wrap {
  // 2026-10-04：口径开关浮层的定位上下文（浮层绝对定位于本盒右上角）。
  position: relative;
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
.basis-toggle {
  // 右上角浮层：不占布局空间（不挤压 canvas 高度 / 不改左栏 flex）。
  // 高度 ≈24px（small radio-group），落在 grid.top=36 之上，不遮绘图区。
  // z-index 高于 .chart-pending：换口径期间那层提示要盖住图表，但不能把开关
  // 一起盖灰 —— 开关得保持可点，用户才能继续来回切。
  position: absolute;
  top: 4px;
  right: 8px;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 4px;
}
.basis-hint {
  cursor: help;
  font-size: 13px;
  line-height: 1;
  color: #909399;
  // 键盘可达：el-tooltip 的 trigger 含 focus，元素本身必须可聚焦才能收到 focus 事件。
  &:focus-visible {
    outline: 2px solid var(--el-color-primary);
    outline-offset: 2px;
    border-radius: 50%;
  }
}
.chart-pending {
  // 口径占位期间的「图上数字还不是当前口径」提示层。纯 DOM 覆盖，不进 ECharts
  // option ⇒ 与 updateOptions.notMerge 的整份替换互不影响，也不会触发多余的
  // setOption；绝对定位脱离文档流，不改变 .chart-wrap 尺寸 ⇒ 不触发 autoresize。
  position: absolute;
  inset: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.6);
  // 不吃鼠标事件：占位期间仍可继续点开关 / 点柱子。这一条没有自动化断言兜底
  // （happy-dom 无布局引擎，算不出 pointer-events），属只能靠代码评审守住的不变量。
  pointer-events: none;
}
.chart-pending-text {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
</style>
