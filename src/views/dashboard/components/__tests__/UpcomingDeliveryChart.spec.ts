// @vitest-environment happy-dom
// src/views/dashboard/components/__tests__/UpcomingDeliveryChart.spec.ts
//
// 2026-09-30 重写：UpcomingDeliveryChart 已迁 vue-echarts 8.3（Phase 4 改造），
// 原 mock 策略 vi.mock('echarts/core') + lastChart! 探针断言全部失效——
// vue-echarts 内部走自己的 useChart lifecycle，不暴露 init / setOption / on
// 给外部探针。本 spec 改为在 mount options 里 stub `v-chart` 组件，断言改读
// `wrapper.findComponent({ name: 'VChart' }).props('option').*` —— 完全跳过
// 真实 echarts 渲染（happy-dom 无 canvas），覆盖 Phase 4-6 引入的 vue-echarts 架构变迁：
//   - <v-chart> 由 main.ts:82 全局注册（test 环境未加载 main.ts → 走 mount stubs 兜底）
//   - vue-echarts 内部自管 init / ResizeObserver / dispose lifecycle
//   - chartOption 是 computed，props.option 改 vue-echarts 自管 setOption（不暴露给我们）
//   - click @click 透传 ECElementEvent payload，seriesName 即 series.name（中文 label）
//
// stub 覆盖策略说明（全局 vs 局部）：
//   全局：vi.mock('vue-echarts') + 期望 main.ts 加载 → 在测试环境 main.ts 不被加载，
//   SFC 模板里 <v-chart> 无解析来源，render 失败。
//   局部（采用）：mount options `global.stubs: { 'v-chart': ... }` 不依赖 main.ts 加载，
//   直接给模板里 <v-chart> 一个 Vue 组件替身；stub 的 props 列表与真实 VChart 一致，
//   测试侧 `wrapper.findComponent({ name: 'VChart' }).props('option')` 才能正常返回
//   SFC 传入的 option 对象。
//   click 驱动走 `wrapper.findComponent({ name: 'VChart' }).vm.$emit('click', payload)`，
//   与真 vue-echarts 行为对齐（vue-echarts 内部 chart.on('click', ...) → emit('click', ECElementEvent)）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { nextTick } from 'vue';
import type { UpcomingDeliveryEntryData } from '@/views/dashboard/composables/dashboardSnapshotSchema';

import UpcomingDeliveryChart from '../UpcomingDeliveryChart.vue';

/** 2026-09-30 新增：v-chart stub 组件（与真实 vue-echarts 8.3 的 prop/emits 列表对齐）。
 *  留空 template —— happy-dom 下不必渲染任何东西，仅作为 prop holder 即可。
 *  真实 vue-echarts 在内部跑 init / setOption / ResizeObserver，本 spec 不关心。 */
const VChartStub = {
  name: 'VChart',
  props: [
    'option',
    'theme',
    'initOptions',
    'updateOptions',
    'autoresize',
    'loading',
    'loadingType',
    'loadingOptions',
    'group',
    'manualUpdate',
  ],
  emits: [
    'click',
    'mouseover',
    'mouseout',
    'legendselectchanged',
    'legendselected',
    'legendunselected',
    'updated',
    'finished',
  ],
  template: '<div class="mock-vchart" />',
};

/** 2026-09-30 沿用：组件对齐 today → today+13；测试用 today = 当前 Date。 */
function todayIso(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function makeBucket(overrides: Partial<UpcomingDeliveryEntryData> = {}): UpcomingDeliveryEntryData {
  return {
    date: '2026-10-01',
    count: 0,
    by_status: {},
    ...overrides,
  };
}

interface SeriesShape {
  name: string;
  stack?: string;
  data: number[];
  itemStyle?: { color?: string; borderRadius?: number | number[] };
  emphasis?: { focus?: string };
}
interface OptionShape {
  series: SeriesShape[];
  legend: { data: string[] };
  xAxis: { type: string };
  yAxis: { type: string; data?: string[]; inverse?: boolean };
  grid: { left: number; right?: number; top?: number; bottom?: number };
}

/** 2026-09-30 新增：从 wrapper 取 VChart 实例的当前 option。 */
function readOption(wrapper: ReturnType<typeof mount>): OptionShape {
  const vchart = wrapper.findComponent({ name: 'VChart' });
  expect(vchart.exists()).toBe(true);
  const option = vchart.props('option') as OptionShape;
  expect(option).toBeTruthy();
  return option;
}

describe('UpcomingDeliveryChart — vue-echarts 8.3 适配（2026-09-30 重写）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('C1：3 series 全部 stack=delivery，颜色按 LAYERS.color（红/黄/亮青绿，自下而上）', async () => {
    const buckets: UpcomingDeliveryEntryData[] = [
      makeBucket({
        date: '2026-10-01',
        count: 6,
        by_status: { PENDING: 3, INSPECTION: 2, DELIVERED: 1 },
      }),
    ];
    const wrapper = mount(UpcomingDeliveryChart, {
      props: { buckets, height: '320px' },
      global: { stubs: { 'v-chart': VChartStub } },
    });

    await nextTick();
    await flushPromises();

    const option = readOption(wrapper);

    // 3 series 全部 stack='delivery'
    expect(option.series).toHaveLength(3);
    for (const s of option.series) {
      expect(s.stack).toBe('delivery');
    }

    // 颜色顺序：bottom=#67c23a（已送货） / middle=#e6a23c（待品检/待送货） / top=#f56c6c（品检前）
    // 沿 Phase 4：LAYERS 顺序 [bottom, middle, top]
    // 2026-10-01 修正：本断言原写死旧「警示三色」（#0FFCBE / #FFCC00 / #B4121B），
    // 但源码 LAYERS.color 早已随 UpcomingDeliveryListDrawer 的 LAYER_COLOR 一起换成
    // Element Plus 预设 hex 以形成视觉闭环，测试没跟上 → 长期红灯。同步更新为现值。
    // 不变量是「三层三色且与抽屉 LAYER_COLOR 一致」，hex 本身随设计调整可以变。
    expect(option.series[0]?.itemStyle?.color).toBe('#67c23a');
    expect(option.series[1]?.itemStyle?.color).toBe('#e6a23c');
    expect(option.series[2]?.itemStyle?.color).toBe('#f56c6c');

    // legend data 顺序：已送货 / 待品检/待送货 / 品检前
    expect(option.legend.data).toEqual(['已送货', '待品检/待送货', '品检前']);

    // 2026-10-01 bugfix 防回归：legend.data 与 series.name 必须逐字相等，
    // 否则 ECharts 在 setOption / resize 重算 legend 时打印
    // 「xxx series not exists」警告（控制台 6 条噪音）。
    expect(option.legend.data).toEqual(option.series.map((s) => s.name));

    wrapper.unmount();
  });

  it('C2：layer.key=top 时，top series.data[0] = bucket.by_status 求和', async () => {
    // 顶层 statuses = [PENDING, PROGRAMMING, IN_PROCESS, REPAIRING, OUTSOURCE]
    const buckets: UpcomingDeliveryEntryData[] = [
      makeBucket({
        date: todayIso(),
        count: 10,
        by_status: { PENDING: 1, PROGRAMMING: 2, IN_PROCESS: 3, REPAIRING: 0, OUTSOURCE: 0 },
      }),
    ];
    const wrapper = mount(UpcomingDeliveryChart, {
      props: { buckets, height: '320px' },
      global: { stubs: { 'v-chart': VChartStub } },
    });

    await nextTick();
    await flushPromises();

    const option = readOption(wrapper);
    // 顶层 series.name === '品检前'（2026-10-01：series.name 改为中文 label 对齐 legend.data）
    const topSeries = option.series.find((s) => s.name === '品检前');
    expect(topSeries).toBeTruthy();
    // data[0] = 1+2+3 = 6
    expect(topSeries?.data[0]).toBe(6);

    wrapper.unmount();
  });

  it('C3：click emit payload = { date, layer, statuses }', async () => {
    const buckets: UpcomingDeliveryEntryData[] = [
      makeBucket({ date: todayIso(), count: 5, by_status: { PENDING: 5 } }),
    ];
    const wrapper = mount(UpcomingDeliveryChart, {
      props: { buckets, height: '320px' },
      global: { stubs: { 'v-chart': VChartStub } },
    });

    await nextTick();
    await flushPromises();

    // 2026-09-30 新增：直接通过 stub VChart 的 vm.$emit('click', payload) 驱动，
    // 与 vue-echarts 内部 chart.on('click', ...) → emit('click', ECElementEvent) 行为对齐。
    const vchart = wrapper.findComponent({ name: 'VChart' });
    vchart.vm.$emit('click', { seriesName: '待品检/待送货', dataIndex: 0 });

    const events = wrapper.emitted('barLayerClick');
    expect(events).toBeTruthy();
    expect(events?.[0]?.[0]).toEqual({
      date: todayIso(),
      layer: 'middle',
      statuses: ['INSPECTION', 'READY_TO_SHIP'],
    });

    wrapper.unmount();
  });

  it('C4：未知 seriesName → 不 emit（防御性）', async () => {
    const buckets: UpcomingDeliveryEntryData[] = [makeBucket({ date: '2026-10-01', count: 1 })];
    const wrapper = mount(UpcomingDeliveryChart, {
      props: { buckets, height: '320px' },
      global: { stubs: { 'v-chart': VChartStub } },
    });

    await nextTick();
    await flushPromises();

    const vchart = wrapper.findComponent({ name: 'VChart' });
    vchart.vm.$emit('click', { seriesName: 'unknown', dataIndex: 0 });
    expect(wrapper.emitted('barLayerClick')).toBeFalsy();

    wrapper.unmount();
  });

  it('C5：vue-echarts initOptions={renderer:"canvas"} + theme="v5"', async () => {
    const wrapper = mount(UpcomingDeliveryChart, {
      props: { buckets: [makeBucket()], height: '320px' },
      global: { stubs: { 'v-chart': VChartStub } },
    });

    await nextTick();
    await flushPromises();

    const vchart = wrapper.findComponent({ name: 'VChart' });
    expect(vchart.props('theme')).toBe('v5');
    // initOptions 在 SFC 模板里直接写 `:init-options="{ renderer: 'canvas' }"`
    const initOptions = vchart.props('initOptions') as { renderer?: string } | undefined;
    expect(initOptions).toBeTruthy();
    expect(initOptions?.renderer).toBe('canvas');

    wrapper.unmount();
  });

  // 2026-10-01 重构：横向堆叠 + emphasis 防回归
  it('T1：横向堆叠 — xAxis=type:value, yAxis=type:category', async () => {
    const buckets: UpcomingDeliveryEntryData[] = [
      makeBucket({
        date: '2026-10-01',
        count: 6,
        by_status: { PENDING: 3, INSPECTION: 2, DELIVERED: 1 },
      }),
    ];
    const wrapper = mount(UpcomingDeliveryChart, {
      props: { buckets, height: '320px' },
      global: { stubs: { 'v-chart': VChartStub } },
    });

    await nextTick();
    await flushPromises();

    const option = readOption(wrapper);
    expect(option.xAxis.type).toBe('value');
    expect(option.yAxis.type).toBe('category');

    wrapper.unmount();
  });

  it('T2：series 含 emphasis.focus=series', async () => {
    const buckets: UpcomingDeliveryEntryData[] = [
      makeBucket({
        date: '2026-10-01',
        count: 6,
        by_status: { PENDING: 3, INSPECTION: 2, DELIVERED: 1 },
      }),
    ];
    const wrapper = mount(UpcomingDeliveryChart, {
      props: { buckets, height: '320px' },
      global: { stubs: { 'v-chart': VChartStub } },
    });

    await nextTick();
    await flushPromises();

    const option = readOption(wrapper);
    expect(option.series).toHaveLength(3);
    for (const s of option.series) {
      expect(s.emphasis?.focus).toBe('series');
    }

    wrapper.unmount();
  });

  it('T3：grid.left 预留日期轴宽度（>= 50）', async () => {
    const buckets: UpcomingDeliveryEntryData[] = [
      makeBucket({
        date: '2026-10-01',
        count: 6,
        by_status: { PENDING: 3, INSPECTION: 2, DELIVERED: 1 },
      }),
    ];
    const wrapper = mount(UpcomingDeliveryChart, {
      props: { buckets, height: '320px' },
      global: { stubs: { 'v-chart': VChartStub } },
    });

    await nextTick();
    await flushPromises();

    const option = readOption(wrapper);
    expect(option.grid.left).toBeGreaterThanOrEqual(50);

    wrapper.unmount();
  });
});
