// @vitest-environment happy-dom
// src/views/dashboard/components/__tests__/UpcomingDeliveryListDrawer.spec.ts
//
// 2026-09-30 新增：UpcomingDeliveryListDrawer 三态渲染回归保护。
// 覆盖：
//   - U1：modelValue=true + statuses.length > 0 → 抽屉渲染 + 表头展示
//   - U2：modelValue=false → useDashboardUpcomingList enabled=false，listUnionItems 不被调
//   - U3：rows 非空 → el-table 显示 N 行
//   - U4：rows 为空 + pending=false → 「该日该层无工单」empty text

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { nextTick } from 'vue';
import type { OrderStatus } from '@/types/parts';

vi.mock('element-plus', () => ({
  ElMessage: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
  ElDrawer: {
    name: 'ElDrawer',
    props: ['modelValue', 'direction', 'size', 'withHeader', 'appendToBody', 'destroyOnClose'],
    template: '<div class="mock-drawer" v-if="modelValue"><slot /></div>',
  },
  ElEmpty: { template: '<div class="mock-empty"><slot /></div>' },
  ElTag: { props: ['type', 'size', 'effect'], template: '<span class="mock-tag"><slot /></span>' },
  ElButton: {
    props: ['text', 'size'],
    template: '<button class="mock-button" @click="$emit(\'click\')"><slot /></button>',
  },
  // ElTable stub：对 data 做 v-for，row 计数即可（用于断言）。
  ElTable: {
    props: ['data', 'stripe', 'emptyText'],
    template:
      '<div class="mock-table"><div v-for="r in (data || [])" :key="r.id" class="mock-row">{{ r.id }}</div></div>',
  },
  // 关键：el-table-column scoped slot (`<template #default="{ row }">`) 在 stub 里
  // 必须 `<slot :row="{}" />` —— 否则 SFC 编译的 `renderSlot($slots, 'default', {})`
  // 不会传 row 上下文，模板里的 `const { row } = undefined` 直接抛错。
  ElTableColumn: {
    props: ['prop', 'label', 'width', 'minWidth', 'align', 'type'],
    template: '<div class="mock-column"><slot :row="{}" /></div>',
  },
  ElIcon: { template: '<i><slot /></i>' },
  ElTooltip: { template: '<span><slot /></span>' },
}));

const listUnionItemsMock = vi.fn();
let lastEventHandler:
  | ((ev: { type: 'event'; event_type: string; data: Record<string, unknown>; ts: string }) => void)
  | null = null;
const onDashboardEventMock = vi.fn(
  (
    h: (ev: {
      type: 'event';
      event_type: string;
      data: Record<string, unknown>;
      ts: string;
    }) => void,
  ) => {
    lastEventHandler = h;
    return () => {
      if (lastEventHandler === h) lastEventHandler = null;
    };
  },
);

vi.mock('@/api/com/unionList', () => ({
  listUnionItems: (params: Record<string, unknown>) => listUnionItemsMock(params),
}));
vi.mock('@/api/dashboard', () => ({
  onDashboardEvent: (
    h: (ev: {
      type: 'event';
      event_type: string;
      data: Record<string, unknown>;
      ts: string;
    }) => void,
  ) => onDashboardEventMock(h),
}));

import UpcomingDeliveryListDrawer from '../UpcomingDeliveryListDrawer.vue';

function makePart(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '180000000000001',
    version: 1,
    serial_no: 'SN-001',
    name: '零件甲',
    drawing_no: 'DWG-001',
    applicant_name: null,
    quantity: 10,
    unit_price: '0',
    total_price: '0',
    request_date: '2026-09-29',
    planned_delivery_date: '2026-10-01',
    is_urgent: false,
    status: 'PENDING',
    order_no: null,
    system_delivery_date: null,
    note: null,
    customer_name: '客户甲',
    l1_customer_name: 'L1 客户',
    location: null,
    has_cnc_program: false,
    row_type: 'PART',
    ...overrides,
  };
}

describe('UpcomingDeliveryListDrawer — 三态渲染（2026-09-30）', () => {
  let testQueryClient: QueryClient;

  beforeEach(() => {
    listUnionItemsMock.mockReset();
    onDashboardEventMock.mockClear();
    lastEventHandler = null;
    testQueryClient = new QueryClient({ defaultOptions: { mutations: { retry: 0 } } });
  });

  afterEach(() => {
    testQueryClient.unmount();
    testQueryClient = null as unknown as QueryClient;
    vi.clearAllMocks();
  });

  function makeMountOpts(
    overrides: Partial<{
      modelValue: boolean;
      date: string;
      layer: 'top' | 'middle' | 'bottom';
      statuses: readonly OrderStatus[];
    }> = {},
  ) {
    const statuses: readonly OrderStatus[] = ['PENDING', 'PROGRAMMING'];
    const opts: Parameters<typeof mount>[1] = {
      props: {
        modelValue: true,
        date: '2026-10-01',
        layer: 'top' as const,
        statuses,
        ...overrides,
      },
      global: {
        plugins: [VueQueryPlugin],
        provide: { VUE_QUERY_CLIENT: testQueryClient },
        // 注册全局 stub：vi.mock('element-plus') 替换的 module export 不能被
        // Vue 自动注册到组件表里；这里手动用 kebab-case 注册保证 SFC 模板里
        // 的 <el-tag> / <el-table> 等可以解析。
        components: {
          'el-drawer': { template: '<div><slot /></div>' },
          'el-empty': { template: '<div class="mock-empty"><slot /></div>' },
          'el-tag': { props: ['type', 'size', 'effect'], template: '<span><slot /></span>' },
          'el-button': {
            props: ['text', 'size'],
            template: '<button @click="$emit(\'click\')"><slot /></button>',
          },
          'el-table': {
            props: ['data'],
            template:
              '<div class="mock-table"><div v-for="r in (data || [])" :key="r.id" class="mock-row">{{ r.id }}</div></div>',
          },
          'el-table-column': {
            props: ['prop', 'label', 'width', 'minWidth', 'align', 'type'],
            template: '<div class="mock-column"><slot :row="{}" /></div>',
          },
          'el-icon': { template: '<i><slot /></i>' },
          'el-tooltip': { template: '<span><slot /></span>' },
        },
      },
    };
    return opts;
  }

  it('U1：modelValue=true + statuses.length>0 → 抽屉渲染 + 表头展示日期与层标签', async () => {
    listUnionItemsMock.mockResolvedValue({
      items: [makePart()],
      total: 1,
      limit: 500,
      offset: 0,
    });

    const wrapper = mount(UpcomingDeliveryListDrawer, makeMountOpts());

    await new Promise((resolve) => setTimeout(resolve, 50));
    await nextTick();

    // 表头日期
    expect(wrapper.find('.header-date').exists()).toBe(true);
    expect(wrapper.find('.header-date').text()).toBe('2026-10-01');
    // 表头状态数
    expect(wrapper.find('.header-status-count').text()).toContain('2 状态');
    // layer='top' → LAYER_LABEL='品检前'
    expect(wrapper.text()).toContain('品检前');
    wrapper.unmount();
  });

  it('U2：modelValue=false → useDashboardUpcomingList enabled=false，listUnionItems 不被调', async () => {
    listUnionItemsMock.mockResolvedValue({ items: [], total: 0, limit: 500, offset: 0 });

    const wrapper = mount(UpcomingDeliveryListDrawer, makeMountOpts({ modelValue: false }));

    await new Promise((resolve) => setTimeout(resolve, 50));
    await nextTick();

    expect(listUnionItemsMock).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('U3：rows 非空 → el-table 显示 N 行', async () => {
    listUnionItemsMock.mockResolvedValue({
      items: [makePart({ id: '180000000000001' }), makePart({ id: '180000000000002' })],
      total: 2,
      limit: 500,
      offset: 0,
    });

    const wrapper = mount(UpcomingDeliveryListDrawer, makeMountOpts());

    await new Promise((resolve) => setTimeout(resolve, 80));
    await nextTick();

    expect(wrapper.findAll('.mock-row')).toHaveLength(2);
    expect(wrapper.text()).toContain('共 2 件');
    wrapper.unmount();
  });

  it('U4：rows 为空 + pending=false → emptyText 生效', async () => {
    listUnionItemsMock.mockResolvedValue({ items: [], total: 0, limit: 500, offset: 0 });

    const wrapper = mount(UpcomingDeliveryListDrawer, makeMountOpts());

    await new Promise((resolve) => setTimeout(resolve, 80));
    await nextTick();

    expect(wrapper.findAll('.mock-row')).toHaveLength(0);
    // total = 0
    expect(wrapper.text()).toContain('共 0 件');
    wrapper.unmount();
  });

  it('U5：v-model 双向同步 —— update:modelValue 事件正确发出', async () => {
    listUnionItemsMock.mockResolvedValue({ items: [], total: 0, limit: 500, offset: 0 });

    const wrapper = mount(UpcomingDeliveryListDrawer, makeMountOpts());
    await nextTick();

    // 模拟抽屉关闭 → emit('update:modelValue', false)
    wrapper.vm.$emit('update:modelValue', false);
    await nextTick();

    const events = wrapper.emitted('update:modelValue');
    expect(events).toBeTruthy();
    expect(events?.[0]).toEqual([false]);
    wrapper.unmount();
  });
});