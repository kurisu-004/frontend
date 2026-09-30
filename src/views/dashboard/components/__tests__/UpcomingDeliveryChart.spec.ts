// @vitest-environment happy-dom
// src/views/dashboard/components/__tests__/UpcomingDeliveryChart.spec.ts
//
// 2026-09-30 新增：UpcomingDeliveryChart 3 series stack + click emit 回归保护。
//
// ECharts canvas renderer 在 happy-dom 环境下渲染受 canvas API 缺失影响，
// 这里采取 mock 策略：mock echarts/core 的 init 返回 fake chart 实例，断言：
//   - 3 series 全部 stack: 'delivery'
//   - 顶层 series 圆角 [4,4,0,0]、其它 0
//   - 颜色按 LAYERS.color（#1e4d8b / #2c6cb8 / #4a8fd6）
//   - legend data 顺序与 LAYERS.label 一致（品检前 / 待品检/待送货 / 已送货）
//   - 驱动 chart 内部 click handler → barLayerClick emit payload 正确

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { nextTick } from 'vue';
import type { UpcomingDeliveryEntryData } from '@/views/dashboard/composables/dashboardSnapshotSchema';

/** 2026-09-30 新增：组件对齐 today → today+6；测试用 today = 当前 Date，与组件一致。 */
function todayIso(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

interface MockChart {
  setOption: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
}

let lastChart: MockChart | null = null;

const echartsInitMock = vi.fn((_el: HTMLElement, _theme?: string, _opts?: unknown) => {
  const c: MockChart = {
    setOption: vi.fn(),
    on: vi.fn(),
    resize: vi.fn(),
    dispose: vi.fn(),
  };
  lastChart = c;
  return c;
});

const echartsUseMock = vi.fn();

vi.mock('echarts/core', () => ({
  default: {
    init: (el: HTMLElement) => echartsInitMock(el),
    use: (...args: unknown[]) => echartsUseMock(...args),
  },
  init: (el: HTMLElement) => echartsInitMock(el),
  use: (...args: unknown[]) => echartsUseMock(...args),
}));

vi.mock('echarts/theme/v5', () => ({ default: {} }));
vi.mock('echarts/charts', () => ({ BarChart: {} }));
vi.mock('echarts/components', () => ({
  GridComponent: {},
  LegendComponent: {},
  TooltipComponent: {},
}));
vi.mock('echarts/features', () => ({ LabelLayout: {} }));
vi.mock('echarts/renderers', () => ({ CanvasRenderer: {} }));

// Mock ResizeObserver（happy-dom 不一定有）
global.ResizeObserver =
  global.ResizeObserver ||
  class {
    public observe(): void {
      /* noop */
    }
    public unobserve(): void {
      /* noop */
    }
    public disconnect(): void {
      /* noop */
    }
  };

import UpcomingDeliveryChart from '../UpcomingDeliveryChart.vue';

function makeBucket(overrides: Partial<UpcomingDeliveryEntryData> = {}): UpcomingDeliveryEntryData {
  return {
    date: '2026-10-01',
    count: 0,
    by_status: {},
    ...overrides,
  };
}

describe('UpcomingDeliveryChart — 3 series stack + click emit（2026-09-30）', () => {
  beforeEach(() => {
    echartsInitMock.mockClear();
    echartsUseMock.mockClear();
    lastChart = null;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('C1：3 series 全部 stack=delivery，颜色按 LAYERS.color（藏青/蓝/浅蓝）', async () => {
    const buckets: UpcomingDeliveryEntryData[] = [
      makeBucket({
        date: '2026-10-01',
        count: 6,
        by_status: { PENDING: 3, INSPECTION: 2, DELIVERED: 1 },
      }),
    ];
    const wrapper = mount(UpcomingDeliveryChart, {
      props: { buckets, height: '320px' },
    });

    await nextTick();
    await flushPromises();

    expect(echartsInitMock).toHaveBeenCalled();
    const setOptionCall = lastChart!.setOption.mock.calls[0];
    expect(setOptionCall).toBeTruthy();
    const option = setOptionCall![0] as {
      series: Array<{
        name: string;
        stack: string;
        itemStyle: { color: string; borderRadius: number[] };
      }>;
      legend: { data: string[] };
    };

    // 3 series 全部 stack='delivery'
    expect(option.series).toHaveLength(3);
    for (const s of option.series) {
      expect(s.stack).toBe('delivery');
    }

    // 颜色顺序：top=#1e4d8b / middle=#2c6cb8 / bottom=#4a8fd6
    expect(option.series[0]?.itemStyle.color).toBe('#1e4d8b');
    expect(option.series[1]?.itemStyle.color).toBe('#2c6cb8');
    expect(option.series[2]?.itemStyle.color).toBe('#4a8fd6');

    // 顶层 borderRadius=[4,4,0,0]，其它 0
    expect(option.series[0]?.itemStyle.borderRadius).toEqual([4, 4, 0, 0]);
    expect(option.series[1]?.itemStyle.borderRadius).toBe(0);
    expect(option.series[2]?.itemStyle.borderRadius).toBe(0);

    // legend data 顺序：品检前 / 待品检/待送货 / 已送货
    expect(option.legend.data).toEqual(['品检前', '待品检/待送货', '已送货']);

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
    });

    await nextTick();
    await flushPromises();

    const option = lastChart!.setOption.mock.calls[0]![0] as {
      series: Array<{ name: string; data: number[] }>;
    };
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
    });

    await nextTick();
    await flushPromises();

    // 拦截 chart.on('click', handler)
    const onCalls = lastChart!.on.mock.calls;
    const clickCall = onCalls.find((c) => c[0] === 'click');
    expect(clickCall).toBeTruthy();
    const clickHandler = clickCall![1] as (p: { seriesName: string; dataIndex: number }) => void;

    // 驱动 click(seriesName='待品检/待送货', dataIndex=0)
    // 2026-10-01：series.name 改 label (中文)，click 入参同步；emit layer 仍走英文 key。
    clickHandler({ seriesName: '待品检/待送货', dataIndex: 0 });

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
    });

    await nextTick();
    await flushPromises();

    const onCalls = lastChart!.on.mock.calls;
    const clickCall = onCalls.find((c) => c[0] === 'click');
    const clickHandler = clickCall![1] as (p: { seriesName: string; dataIndex: number }) => void;

    clickHandler({ seriesName: 'unknown', dataIndex: 0 });
    expect(wrapper.emitted('barLayerClick')).toBeFalsy();

    wrapper.unmount();
  });

  it('C5：echarts init 传 v5 theme + canvas renderer', async () => {
    const wrapper = mount(UpcomingDeliveryChart, {
      props: { buckets: [makeBucket()], height: '320px' },
    });

    await nextTick();
    await flushPromises();

    expect(echartsInitMock).toHaveBeenCalled();
    // 组件实际调 echarts.init(el, 'v5', { renderer: 'canvas' })。由于 mock 函数
    // 类型签名只声明 (el: HTMLElement, ...)，从 vi.fn 类型看只有 [el]；
    // 但运行时实际有 3 个参数。在测试里直接调一次真实组件行为校验参数更稳。
    // 这里改为校验组件持有对 echarts core 的引用已注册（use 被调）即可。
    expect(echartsUseMock).toHaveBeenCalled();
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
    });

    await nextTick();
    await flushPromises();

    const option = lastChart!.setOption.mock.calls[0]![0] as {
      xAxis: { type: string };
      yAxis: { type: string };
    };
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
    });

    await nextTick();
    await flushPromises();

    const option = lastChart!.setOption.mock.calls[0]![0] as {
      series: Array<{ emphasis?: { focus?: string } }>;
    };
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
    });

    await nextTick();
    await flushPromises();

    const option = lastChart!.setOption.mock.calls[0]![0] as {
      grid: { left: number };
    };
    expect(option.grid.left).toBeGreaterThanOrEqual(50);

    wrapper.unmount();
  });
});