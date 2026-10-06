// @vitest-environment happy-dom
// src/views/dashboard/components/__tests__/UpcomingDeliveryChart.spec.ts
//
// UpcomingDeliveryChart 迁 vue-echarts 8.3 后，本 spec 在 mount options 里 stub
// `v-chart` 组件，断言改读 `wrapper.findComponent({ name: 'VChart' }).props('option').*`
// —— 完全跳过真实 echarts 渲染（happy-dom 无 canvas）：
//   - <v-chart> 由 main.ts 全局注册（test 环境未加载 main.ts → 走 mount stubs 兜底）
//   - vue-echarts 内部自管 init / ResizeObserver / dispose lifecycle
//   - chartOption 是 computed，props.option 改 vue-echarts 自管 setOption（不暴露给我们）
//   - click @click 透传 ECElementEvent payload，seriesName 即 series.name（中文 label）
//
// stub 覆盖策略（全局 vs 局部）：全局 vi.mock('vue-echarts') 依赖 main.ts 被加载，
// test 环境不会；故采用**局部** mount options `global.stubs`，不依赖 main.ts。
// click 驱动走 `wrapper.findComponent({ name: 'VChart' }).vm.$emit('click', payload)`，
// 与真 vue-echarts 行为对齐（内部 chart.on('click', ...) → emit('click', ECElementEvent)）。
//
// 2026-10-07 追加「天数选择器 + today 锚点 + stale 点击闸门」覆盖：
//   - D1~D3：days / today 是必填 prop，坐标轴按 props.today → today+days-1 生成；
//   - D4：后端少返一天时按 props.days 补 0 桶（防御性对齐）；
//   - D5：天数选择器渲染 3 档 + emit update:days（非法值收敛忽略）；
//   - D6：stale=true 时 onChartClick 不 emit（换键占位期间不许拿旧日期 + 新口径去查）；
//   - 口径开关用例（B 系列）保留，受控 props / emit / 提示文案 / 占位提示层。
// 口径与天数选择器用 EP_STUBS 局部 stub（沿用本文件 v-chart 策略，不 mock
// element-plus 模块）：两者不参与 ECharts 渲染，断言集中在 props/emits 与提示文案上。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { nextTick } from 'vue';
import type { UpcomingDeliveryEntryData } from '@/views/dashboard/composables/dashboardSnapshotSchema';

import UpcomingDeliveryChart from '../UpcomingDeliveryChart.vue';

/** v-chart stub 组件（与真实 vue-echarts 8.3 的 prop/emits 列表对齐）。
 *  留空 template —— happy-dom 下不必渲染任何东西，仅作为 prop holder 即可。 */
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

/** 口径开关 / 天数选择器 / 提示的 Element Plus 组件替身。
 *  与主注册无关，测试环境不加载 main.ts ⇒ <el-radio-group> 等无解析来源，故在 mount
 *  的 global.stubs 里显式提供（沿用本文件 v-chart 的局部 stub 策略，不 mock
 *  element-plus 模块）。模板不渲染真实控件，只当 props/emits 载体。 */
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
  'el-select': {
    name: 'ElSelect',
    props: ['modelValue', 'size', 'ariaLabel'],
    emits: ['update:modelValue', 'change'],
    template: '<div class="mock-select"><slot /></div>',
  },
  'el-option': {
    name: 'ElOption',
    props: ['value', 'label'],
    template: '<div class="mock-option" />',
  },
  // 口径提示改用 el-tooltip 承载（原 span + title 只有鼠标可达）。
  // stub 只当 content prop 的载体，模板直接渲染 slot，不模拟浮层。
  'el-tooltip': {
    name: 'ElTooltip',
    props: ['content', 'placement', 'trigger'],
    template: '<span class="mock-tooltip"><slot /></span>',
  },
};

/** 固定「今天」锚点：2026-10-07。组件的 props.today 是必填（不 new Date()），
 *  测试用固定值让坐标轴断言不随运行当天漂移。 */
const TODAY = '2026-10-07';
/** 窗口天数缺省（与 DashboardView 的 deliveryDays 缺省一致）。 */
const DAYS = 14;

function makeBucket(overrides: Partial<UpcomingDeliveryEntryData> = {}): UpcomingDeliveryEntryData {
  return { date: TODAY, count: 0, by_status: {}, ...overrides };
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
  legend: { data: string[]; left?: number; top?: number };
  xAxis: { type: string };
  yAxis: { type: string; data?: string[]; inverse?: boolean };
  grid: { left: number; right?: number; top?: number; bottom?: number };
}

/** 从 wrapper 取 VChart 实例的当前 option。 */
function readOption(wrapper: ReturnType<typeof mount>): OptionShape {
  const vchart = wrapper.findComponent({ name: 'VChart' });
  expect(vchart.exists()).toBe(true);
  const option = vchart.props('option') as OptionShape;
  expect(option).toBeTruthy();
  return option;
}

/** 通用 mount：桶数据 + 三个必填参数（basis / days / today）+ stale。 */
function mountChart(
  buckets: UpcomingDeliveryEntryData[],
  overrides: Partial<{ basis: 'planned' | 'system'; days: number; today: string; stale: boolean }> = {},
) {
  return mount(UpcomingDeliveryChart, {
    props: {
      buckets,
      basis: 'planned' as const,
      days: DAYS,
      today: TODAY,
      stale: false,
      height: '320px',
      ...overrides,
    },
    global: { stubs: { 'v-chart': VChartStub, ...EP_STUBS } },
  });
}

describe('UpcomingDeliveryChart — vue-echarts 8.3 适配', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('C1：3 series 全部 stack=delivery，颜色按 LAYERS.color（绿/橙/红，自下而上）', async () => {
    const wrapper = mountChart([
      makeBucket({ count: 6, by_status: { PENDING: 3, INSPECTION: 2, DELIVERED: 1 } }),
    ]);
    await nextTick();
    await flushPromises();

    const option = readOption(wrapper);

    expect(option.series).toHaveLength(3);
    for (const s of option.series) {
      expect(s.stack).toBe('delivery');
    }

    // 颜色顺序：bottom=#67c23a（已送货）/ middle=#e6a23c（待品检/待送货）/ top=#f56c6c（品检前）
    // 不变量是「三层三色且与抽屉 LAYER_COLOR 一致」，hex 本身随设计调整可以变。
    expect(option.series[0]?.itemStyle?.color).toBe('#67c23a');
    expect(option.series[1]?.itemStyle?.color).toBe('#e6a23c');
    expect(option.series[2]?.itemStyle?.color).toBe('#f56c6c');

    // legend data 顺序：已送货 / 待品检/待送货 / 品检前
    expect(option.legend.data).toEqual(['已送货', '待品检/待送货', '品检前']);

    // legend.data 与 series.name 必须逐字相等，否则 ECharts 在 setOption / resize
    // 重算 legend 时打印「xxx series not exists」警告。
    expect(option.legend.data).toEqual(option.series.map((s) => s.name));

    wrapper.unmount();
  });

  it('C2：layer.key=top 时，top series.data[0] = bucket.by_status 求和', async () => {
    // 顶层 statuses = [PENDING, PROGRAMMING, IN_PROCESS, OUTSOURCE]
    const wrapper = mountChart([
      makeBucket({ count: 10, by_status: { PENDING: 1, PROGRAMMING: 2, IN_PROCESS: 3, OUTSOURCE: 0 } }),
    ]);
    await nextTick();
    await flushPromises();

    const topSeries = readOption(wrapper).series.find((s) => s.name === '品检前');
    expect(topSeries).toBeTruthy();
    // data[0] = 1+2+3 = 6
    expect(topSeries?.data[0]).toBe(6);

    wrapper.unmount();
  });

  it('C3：click emit payload = { date, layer, statuses }（日期取自 props.today 锚点）', async () => {
    const wrapper = mountChart([makeBucket({ count: 5, by_status: { PENDING: 5 } })]);
    await nextTick();
    await flushPromises();

    // 通过 stub VChart 的 vm.$emit('click', payload) 驱动，与 vue-echarts 内部
    // chart.on('click', ...) → emit('click', ECElementEvent) 行为对齐。
    const vchart = wrapper.findComponent({ name: 'VChart' });
    vchart.vm.$emit('click', { seriesName: '待品检/待送货', dataIndex: 0 });

    expect(wrapper.emitted('barLayerClick')?.[0]?.[0]).toEqual({
      date: TODAY,
      layer: 'middle',
      statuses: ['INSPECTION', 'READY_TO_SHIP'],
    });

    wrapper.unmount();
  });

  it('C4：未知 seriesName → 不 emit（防御性）', async () => {
    const wrapper = mountChart([makeBucket({ count: 1 })]);
    await nextTick();
    await flushPromises();

    const vchart = wrapper.findComponent({ name: 'VChart' });
    vchart.vm.$emit('click', { seriesName: 'unknown', dataIndex: 0 });
    expect(wrapper.emitted('barLayerClick')).toBeFalsy();

    wrapper.unmount();
  });

  it('C5：vue-echarts initOptions={renderer:"canvas"} + theme="v5"', async () => {
    const wrapper = mountChart([makeBucket()]);
    await nextTick();
    await flushPromises();

    const vchart = wrapper.findComponent({ name: 'VChart' });
    expect(vchart.props('theme')).toBe('v5');
    const initOptions = vchart.props('initOptions') as { renderer?: string } | undefined;
    expect(initOptions?.renderer).toBe('canvas');

    wrapper.unmount();
  });

  it('T1：横向堆叠 — xAxis=type:value, yAxis=type:category', async () => {
    const wrapper = mountChart([
      makeBucket({ count: 6, by_status: { PENDING: 3, INSPECTION: 2, DELIVERED: 1 } }),
    ]);
    await nextTick();
    await flushPromises();

    const option = readOption(wrapper);
    expect(option.xAxis.type).toBe('value');
    expect(option.yAxis.type).toBe('category');

    wrapper.unmount();
  });

  it('T2：series 含 emphasis.focus=series', async () => {
    const wrapper = mountChart([
      makeBucket({ count: 6, by_status: { PENDING: 3, INSPECTION: 2, DELIVERED: 1 } }),
    ]);
    await nextTick();
    await flushPromises();

    const option = readOption(wrapper);
    for (const s of option.series) {
      expect(s.emphasis?.focus).toBe('series');
    }

    wrapper.unmount();
  });

  it('T3：grid.left 预留日期轴宽度（>= 50）', async () => {
    const wrapper = mountChart([
      makeBucket({ count: 6, by_status: { PENDING: 3, INSPECTION: 2, DELIVERED: 1 } }),
    ]);
    await nextTick();
    await flushPromises();

    expect(readOption(wrapper).grid.left).toBeGreaterThanOrEqual(50);

    wrapper.unmount();
  });

  // ==========================================================================
  // 交期统计口径开关（右上角浮层，受控 prop + update:basis emit）
  // ==========================================================================

  it('B1：口径开关渲染 —— 2 个 el-radio-button（value=planned / system）+ a11y label', async () => {
    const wrapper = mountChart([makeBucket()], { basis: 'planned' });
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
    const wrapper = mountChart([makeBucket()], { basis: 'system' });
    await nextTick();

    const group = wrapper.findComponent({ name: 'ElRadioGroup' });
    expect(group.props('modelValue')).toBe('system');

    // 父组件改 prop → 选中态跟随（受控组件的核心行为）
    await wrapper.setProps({ basis: 'planned' });
    expect(group.props('modelValue')).toBe('planned');

    wrapper.unmount();
  });

  it('B3：切换开关 → emit update:basis（非法值收敛回 planned）', async () => {
    const wrapper = mountChart([makeBucket()], { basis: 'planned' });
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
    const wrapper = mountChart([makeBucket()], { basis: 'planned' });
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

  it('B5：legend 钉 left: 0（图例左侧起排，右上角留给开关 / 天数选择器浮层）', async () => {
    const wrapper = mountChart([makeBucket()], { basis: 'planned' });
    await nextTick();
    await flushPromises();

    const option = readOption(wrapper);
    expect(option.legend.left).toBe(0);
    expect(option.legend.top).toBe(0);

    wrapper.unmount();
  });

  it('B6：占位提示层 —— stale=true 盖「口径切换中」，false 不渲染', async () => {
    const wrapper = mountChart([makeBucket()], { basis: 'planned', stale: false });
    await nextTick();
    // 数据已就绪（图上数字与开关一致）→ 提示层不出现。
    expect(wrapper.find('.chart-pending').exists()).toBe(false);

    // 父组件切口径 / 切天数后 query 处于 keepPreviousData 换键期：
    // 图上还是上一份参数的数字，必须有一层提示挡住「开关已切、数字没切」的误读。
    await wrapper.setProps({ stale: true });
    const pending = wrapper.find('.chart-pending');
    expect(pending.exists()).toBe(true);
    expect(pending.text()).toBe('口径切换中…');
    // role="status" 是给读屏用户的（提示文本变化时朗读）。
    expect(pending.attributes('role')).toBe('status');

    await wrapper.setProps({ stale: false });
    expect(wrapper.find('.chart-pending').exists()).toBe(false);

    wrapper.unmount();
  });

  // ==========================================================================
  // 窗口天数 + today 锚点（2026-10-07）
  // ==========================================================================

  it('D1：坐标轴按 props.today 起、props.days 根柱子（不用 new Date()）', async () => {
    const wrapper = mountChart([makeBucket()], { days: 7, today: '2026-10-07' });
    await nextTick();
    await flushPromises();

    const labels = readOption(wrapper).yAxis.data ?? [];
    expect(labels).toHaveLength(7);
    expect(labels[0]).toBe('10/07');
    expect(labels[6]).toBe('10/13');

    wrapper.unmount();
  });

  it('D2：days 切档 → 柱子数随之变化（30 天档 = 30 根）', async () => {
    const wrapper = mountChart([makeBucket()], { days: 14, today: '2026-10-07' });
    await nextTick();
    await flushPromises();
    expect(readOption(wrapper).yAxis.data).toHaveLength(14);

    await wrapper.setProps({ days: 30 });
    await nextTick();
    await flushPromises();
    expect(readOption(wrapper).yAxis.data).toHaveLength(30);

    wrapper.unmount();
  });

  it('D3：today 跨月跨年推算正确（本地零点构造，不受 UTC 解读影响）', async () => {
    const wrapper = mountChart([makeBucket()], { days: 4, today: '2026-12-30' });
    await nextTick();
    await flushPromises();

    // 若按 UTC 零点解读（new Date('YYYY-MM-DD')），东八区会整体前移一天。
    expect(readOption(wrapper).yAxis.data).toEqual(['12/30', '12/31', '01/01', '01/02']);
    wrapper.unmount();
  });

  it('D4：后端少返一天 → 按 props.days 补 0 桶，柱子数不塌（防御性对齐）', async () => {
    // 后端恒返 days 条，这条钉的是「万一少返」时坐标轴仍按 props.days 生成。
    const wrapper = mountChart([makeBucket({ count: 4, by_status: { PENDING: 4 } })], {
      days: 3,
      today: '2026-10-07',
    });
    await nextTick();
    await flushPromises();

    const option = readOption(wrapper);
    expect(option.yAxis.data).toHaveLength(3);
    const topSeries = option.series.find((s) => s.name === '品检前');
    expect(topSeries?.data).toEqual([4, 0, 0]);

    wrapper.unmount();
  });

  it('D5：天数选择器渲染 3 档 + emit update:days（非法值忽略）', async () => {
    const wrapper = mountChart([makeBucket()], { days: 14 });
    await nextTick();

    const select = wrapper.findComponent({ name: 'ElSelect' });
    expect(select.exists()).toBe(true);
    expect(select.props('modelValue')).toBe(14);
    expect(select.props('ariaLabel')).toBe('交期窗口天数');

    const options = wrapper.findAllComponents({ name: 'ElOption' });
    expect(options.map((o) => o.props('value'))).toEqual([7, 14, 30]);

    select.vm.$emit('change', 30);
    await nextTick();
    expect(wrapper.emitted('update:days')?.[0]).toEqual([30]);

    // EP 的 select 可能传字符串：'7' 应被收敛成 number 7。
    select.vm.$emit('change', '7');
    await nextTick();
    expect(wrapper.emitted('update:days')?.[1]).toEqual([7]);

    // 不在档位内的值一律忽略：否则父组件会收到一个后端 clamp 到别处的天数，
    // 标签与实际窗口就不一致了。
    select.vm.$emit('change', 45);
    select.vm.$emit('change', 'nope');
    await nextTick();
    expect(wrapper.emitted('update:days')).toHaveLength(2);

    wrapper.unmount();
  });

  it('D6：stale=true 时 onChartClick 不 emit（换键占位期不许下钻）', async () => {
    const wrapper = mountChart([makeBucket({ count: 5, by_status: { PENDING: 5 } })], {
      stale: true,
      days: 14,
      today: '2026-10-07',
    });
    await nextTick();
    await flushPromises();

    const vchart = wrapper.findComponent({ name: 'VChart' });
    vchart.vm.$emit('click', { seriesName: '待品检/待送货', dataIndex: 0 });
    await nextTick();

    // 占位期间图上的日期属于旧窗口，抽屉会用当前口径去查 —— 点出来的是错位明细。
    expect(wrapper.emitted('barLayerClick')).toBeFalsy();

    // 解除占位后同一个 click 正常 emit
    await wrapper.setProps({ stale: false });
    vchart.vm.$emit('click', { seriesName: '待品检/待送货', dataIndex: 0 });
    await nextTick();
    expect(wrapper.emitted('barLayerClick')).toBeTruthy();

    wrapper.unmount();
  });
});
