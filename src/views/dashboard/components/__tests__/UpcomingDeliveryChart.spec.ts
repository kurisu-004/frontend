// @vitest-environment happy-dom
// src/views/dashboard/components/__tests__/UpcomingDeliveryChart.spec.ts
//
// 2026-09-30 重写：UpcomingDeliveryChart 已迁 vue-echarts 8.3（Phase 4 改造），
// 原 mock 策略 vi.mock('echarts/core') + lastChart! 探针断言全部失效——
// vue-echarts 内部走自己的 useChart lifecycle，不暴露 init / setOption / on
// 给外部探针。本 spec 改为在 mount options 里 stub `v-chart` 组件，断言改读
// `wrapper.findComponent({ name: 'VChart' }).props('option').*` —— 完全跳过
// 真实 echarts 渲染（happy-dom 无 canvas），覆盖 Phase 4-6 引入的 vue-echarts 架构变迁：
//   - <v-chart> 由 main.ts 全局注册（test 环境未加载 main.ts → 走 mount stubs 兜底）
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
//
// 2026-10-04 追加「交期统计口径」覆盖（B1~B6）：切换控件渲染 / basis prop 驱动选中态
// （受控）/ 切换 emit update:basis / 口径提示文案随 basis 变（el-tooltip 承载 + 键盘
// 可达 + 无方向性断言）/ legend 钉 left: 0 / 口径占位提示层随 stale 显隐。
// 口径开关用 EP_STUBS 局部 stub（沿用本文件 v-chart 策略，不 mock element-plus 模块）：
// 口径不参与渲染，断言集中在 props/emits 与提示文案上。

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

/** 2026-10-04 新增：口径开关的 Element Plus 组件替身。
 *  与主注册无关，测试环境不加载 main.ts ⇒ <el-radio-group> 无解析来源，故在 mount
 *  的 global.stubs 里显式提供（沿用本文件 v-chart 的局部 stub 策略，不 mock
 *  element-plus 模块）。el-radio-group 只当 props/emits 载体，模板不渲染真实控件。 */
const EP_STUBS = {
  'el-radio-group': {
    name: 'ElRadioGroup',
    props: ['modelValue', 'size', 'ariaLabel'],
    emits: ['update:modelValue', 'change'],
    template: '<div class="mock-radio-group"><slot /></div>',
  },
  'el-radio-button': {
    name: 'ElRadioButton',
    props: ['value', 'label', 'disabled'],
    template: '<label class="mock-radio-button"><slot /></label>',
  },
  // 2026-10-04：口径提示改用 el-tooltip 承载（原 span + title 只有鼠标可达）。
  // stub 只当 content prop 的载体，模板直接渲染 slot，不模拟浮层。
  'el-tooltip': {
    name: 'ElTooltip',
    props: ['content', 'placement', 'trigger'],
    template: '<span class="mock-tooltip"><slot /></span>',
  },
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
      props: { buckets, basis: 'planned' as const, stale: false, height: '320px' },
      global: { stubs: { 'v-chart': VChartStub, ...EP_STUBS } },
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
    // 顶层 statuses = [PENDING, PROGRAMMING, IN_PROCESS, OUTSOURCE]
    const buckets: UpcomingDeliveryEntryData[] = [
      makeBucket({
        date: todayIso(),
        count: 10,
        by_status: { PENDING: 1, PROGRAMMING: 2, IN_PROCESS: 3, OUTSOURCE: 0 },
      }),
    ];
    const wrapper = mount(UpcomingDeliveryChart, {
      props: { buckets, basis: 'planned' as const, stale: false, height: '320px' },
      global: { stubs: { 'v-chart': VChartStub, ...EP_STUBS } },
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
      props: { buckets, basis: 'planned' as const, stale: false, height: '320px' },
      global: { stubs: { 'v-chart': VChartStub, ...EP_STUBS } },
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
      props: { buckets, basis: 'planned' as const, stale: false, height: '320px' },
      global: { stubs: { 'v-chart': VChartStub, ...EP_STUBS } },
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
      props: { buckets: [makeBucket()], basis: 'planned' as const, stale: false, height: '320px' },
      global: { stubs: { 'v-chart': VChartStub, ...EP_STUBS } },
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
      props: { buckets, basis: 'planned' as const, stale: false, height: '320px' },
      global: { stubs: { 'v-chart': VChartStub, ...EP_STUBS } },
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
      props: { buckets, basis: 'planned' as const, stale: false, height: '320px' },
      global: { stubs: { 'v-chart': VChartStub, ...EP_STUBS } },
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
      props: { buckets, basis: 'planned' as const, stale: false, height: '320px' },
      global: { stubs: { 'v-chart': VChartStub, ...EP_STUBS } },
    });

    await nextTick();
    await flushPromises();

    const option = readOption(wrapper);
    expect(option.grid.left).toBeGreaterThanOrEqual(50);

    wrapper.unmount();
  });

  // ==========================================================================
  // 2026-10-04：交期统计口径开关（右上角浮层，受控 prop + update:basis emit）
  // ==========================================================================

  /** 口径用例共用的 mount：桶数据随便给一个，切口径不改渲染逻辑。 */
  function mountChart(basis: 'planned' | 'system') {
    const buckets: UpcomingDeliveryEntryData[] = [
      makeBucket({ date: todayIso(), count: 4, by_status: { PENDING: 4 } }),
    ];
    return mount(UpcomingDeliveryChart, {
      props: { buckets, basis, stale: false, height: '320px' },
      global: { stubs: { 'v-chart': VChartStub, ...EP_STUBS } },
    });
  }

  it('B1：口径开关渲染 —— 2 个 el-radio-button（value=planned / system）+ a11y label', async () => {
    const wrapper = mountChart('planned');
    await nextTick();

    const group = wrapper.findComponent({ name: 'ElRadioGroup' });
    expect(group.exists()).toBe(true);
    expect(group.props('modelValue')).toBe('planned');
    expect(group.props('ariaLabel')).toBe('交期统计口径');

    const buttons = wrapper.findAllComponents({ name: 'ElRadioButton' });
    expect(buttons).toHaveLength(2);
    expect(buttons[0]?.props('value')).toBe('planned');
    expect(buttons[1]?.props('value')).toBe('system');
    // 文案用默认 slot 给（EP ≥2.6 的 value 当值、label 只作展示文本的老写法已废弃）
    expect(buttons[0]?.text()).toBe('计划交期');
    expect(buttons[1]?.text()).toBe('系统交期');

    wrapper.unmount();
  });

  it('B2：选中态由 basis prop 驱动（组件不持状态）', async () => {
    const wrapper = mountChart('system');
    await nextTick();

    const group = wrapper.findComponent({ name: 'ElRadioGroup' });
    expect(group.props('modelValue')).toBe('system');

    // 父组件改 prop → 选中态跟随（受控组件的核心行为）
    await wrapper.setProps({ basis: 'planned' });
    expect(group.props('modelValue')).toBe('planned');

    wrapper.unmount();
  });

  it('B3：切换开关 → emit update:basis（非法值收敛回 planned）', async () => {
    const wrapper = mountChart('planned');
    await nextTick();

    const group = wrapper.findComponent({ name: 'ElRadioGroup' });
    group.vm.$emit('change', 'system');
    await nextTick();
    expect(wrapper.emitted('update:basis')?.[0]).toEqual(['system']);

    // 组件不直接改自身状态：emit 之外没有任何本地切换动作
    group.vm.$emit('change', 'bogus');
    await nextTick();
    expect(wrapper.emitted('update:basis')?.[1]).toEqual(['planned']);

    wrapper.unmount();
  });

  it('B4：口径提示文案随 basis 变化（el-tooltip 承载，且不含「合计更少」方向性断言）', async () => {
    const wrapper = mountChart('planned');
    await nextTick();

    const tooltip = () => wrapper.findComponent({ name: 'ElTooltip' });
    const hint = () => wrapper.find('.basis-hint');
    expect(hint().exists()).toBe(true);
    // 键盘可达：触发元素必须可聚焦，且 tooltip trigger 含 focus（EP 默认只 hover）。
    expect(hint().attributes('tabindex')).toBe('0');
    expect(tooltip().props('trigger')).toEqual(['hover', 'focus']);
    // 读屏用户直接读 aria-label，无需等浮层。
    expect(hint().attributes('aria-label')).toBe('计划交期口径：按计划交期分桶，工单全部计入');
    expect(tooltip().props('content')).toBe('计划交期口径：按计划交期分桶，工单全部计入');

    await wrapper.setProps({ basis: 'system' });
    const systemHint = '系统交期口径：未填写系统交期的工单整件不计入，合计与计划交期口径不同';
    expect(tooltip().props('content')).toBe(systemHint);
    expect(hint().attributes('aria-label')).toBe(systemHint);
    // 两个口径用的是同一个日期窗口、只是打在不同列上，合计无可比大小关系，
    // 文案里不得出现「少于 / 小于 / ≤」这类可被反例击穿的方向性断言。
    expect(systemHint).not.toMatch(/少于|小于|≤|不超过/);

    wrapper.unmount();
  });

  it('B5：legend 钉 left: 0（图例左侧起排，右上角留给口径开关浮层）', async () => {
    const wrapper = mountChart('planned');
    await nextTick();
    await flushPromises();

    const option = readOption(wrapper) as OptionShape & {
      legend: { data: string[]; left?: number; top?: number };
    };
    expect(option.legend.left).toBe(0);
    expect(option.legend.top).toBe(0);

    wrapper.unmount();
  });

  it('B6：口径占位提示层 —— stale=true 盖「口径切换中」，false 不渲染', async () => {
    const wrapper = mountChart('planned');
    await nextTick();
    // 数据已就绪（图上数字与开关一致）→ 提示层不出现。
    expect(wrapper.find('.chart-pending').exists()).toBe(false);

    // 父组件切口径后 snapshot 处于 keepPreviousData 换键期（isPlaceholderData=true）：
    // 图上还是上一口径的数字，必须有一层提示挡住「开关已切、数字没切」的误读。
    await wrapper.setProps({ stale: true });
    const pending = wrapper.find('.chart-pending');
    expect(pending.exists()).toBe(true);
    expect(pending.text()).toBe('口径切换中…');
    // role="status" 是给读屏用户的（提示文本变化时朗读）；「不吃点击」是 CSS
    // pointer-events，happy-dom 无布局引擎算不出，这条只能靠代码评审守住。
    expect(pending.attributes('role')).toBe('status');

    await wrapper.setProps({ stale: false });
    expect(wrapper.find('.chart-pending').exists()).toBe(false);

    wrapper.unmount();
  });
});
