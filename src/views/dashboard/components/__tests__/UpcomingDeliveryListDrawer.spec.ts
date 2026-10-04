// @vitest-environment happy-dom
// src/views/dashboard/components/__tests__/UpcomingDeliveryListDrawer.spec.ts
//
// 2026-09-30 新增：UpcomingDeliveryListDrawer 三态渲染回归保护。
// 覆盖：
//   - U1：modelValue=true + statuses.length > 0 → 抽屉渲染 + 表头展示
//   - U2：modelValue=false → useDashboardUpcomingList enabled=false，listUnionItems 不被调
//   - U3：rows 非空 → el-table 显示 N 行
//   - U4：rows 为空 + pending=false → 「该日该层无工单」empty text
//   - U5：v-model 双向同步 —— update:modelValue 事件正确发出
// 2026-09-30（Phase 7）追加：vue-echarts 8.3 适配后回归保护：
//   - U6：el-drawer direction=btt + size=60%（Phase 5 改 btt 防回归）
//   - U7：el-table 行点击 → emit('rowClick', part)（Phase 5 新增行点击事件防回归）
//
// 2026-10-04 追加「交期统计口径」覆盖（U8~U10）：倒计列取当前口径对应的交期字段 /
// system 口径下系统交期为空则倒计列留空 / header 口径标签随 basis 变化。日期取
// 2099 年的远期值：deliveryDaysLeftText 对 >3 天的远期返回空串，倒计时稳定回落到
// MM/DD，断言不随「测试运行当天」漂移。
//
// 2026-10-05 追加「头部件数不谎报」覆盖（U11 / U12）：件数取服务端 total，被
// 服务端 limit 截断（total > 取回条数）时追加「仅显示前 N 条」提示，未截断时
// 不渲染任何提示。
// 2026-10-05 追加 U13：换键（切 basis / 切日期 / 切层）后新键尚无数据、isPending 为
// true 时，头部**不渲染件数** —— 此时渲染「共 0 件」会被读成一个权威计数（该 query 无
// placeholderData，pending 期 query.data 恒 undefined）。
//
// 2026-10-04 纯测试基建修复（零生产代码改动）：原 ElTable stub 只按 :data 数行、
// 根本不渲染默认 slot，等于整张表一个单元格都不渲染 —— 任何列级断言在这样一张空表上
// 都无从谈起。修法照抄真实 Element Plus 的做法：stub 的 ElTable 按 :data 渲染
// .mock-row，行内 provide 出当前行（MockTableRow），列 stub inject 后按该行喂自己的
// scoped slot ⇒ 模板里的 `const { row } = undefined` 不再抛错，且列断言真的绑定到
// :data 的行上（:data 为空时列内容一个都不渲染，U4 有对应的反向断言）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { h, inject, nextTick, provide, toRef, type Ref, type VNode } from 'vue';
import type { OrderStatus } from '@/types/parts';
import type { DeliveryBasis } from '@/types/dashboard';

/** 行上下文的 provide key（与真实 el-table 的 table store 同一层语义）。 */
const ROW_KEY = Symbol('mock-el-table-row');

interface MockRow {
  id: string;
  [k: string]: unknown;
}
interface Slots {
  default?: (props?: Record<string, unknown>) => VNode[] | undefined;
}

/** 单行的上下文壳：provide 出当前行，内部照常渲染 el-table 的默认 slot。 */
const MockTableRow = {
  name: 'MockTableRow',
  props: ['row'],
  setup(props: { row: MockRow }, ctx: { slots: Slots }) {
    provide(ROW_KEY, toRef(props, 'row'));
    return () => ctx.slots['default']?.() ?? [];
  },
};

/** 行感知版 el-table：按 :data 渲染 .mock-row，每行内重新求值默认 slot（= 各列）。 */
const ElTableStub = {
  name: 'ElTable',
  props: ['data', 'stripe', 'emptyText'],
  emits: ['row-click', 'selection-change'],
  setup(props: { data?: MockRow[] }, ctx: { slots: Slots }) {
    return () =>
      h('div', { class: 'mock-table' }, (props.data ?? []).map((r) =>
        h('div', { class: 'mock-row', key: r.id }, [
          String(r.id),
          h(MockTableRow, { row: r }, { default: () => ctx.slots['default']?.() ?? [] }),
        ]),
      ));
  },
};

/** 行感知版 el-table-column：inject 出 MockTableRow 提供的当前行喂 scoped slot。 */
const ElTableColumnStub = {
  name: 'ElTableColumn',
  props: ['prop', 'label', 'width', 'minWidth', 'align', 'type'],
  setup(_props: Record<string, unknown>, ctx: { slots: Slots }) {
    const row = inject<Ref<MockRow | undefined> | undefined>(ROW_KEY, undefined);
    return () => h('div', { class: 'mock-column' }, ctx.slots['default']?.({ row: row?.value }));
  },
};

// vi.mock('element-plus') 的 factory 被提升到文件顶部、且在静态 import 的 SFC 之前
// 求值 ⇒ factory 内不能引用本文件的顶层 const（TDZ），也拿不到 MockTableRow。故
// factory 里的 ElTable / ElTableColumn 只是**空形状占位**（本组件模板不 import
// element-plus，模板里的 <el-table> / <el-table-column> 一律由 makeMountOpts 的
// global.components 解析），真正生效的行感知形状见上面那份。
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
  ElTable: {},
  ElTableColumn: {},
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
      basis: DeliveryBasis;
    }> = {},
  ) {
    const statuses: readonly OrderStatus[] = ['PENDING', 'PROGRAMMING'];
    const opts: Parameters<typeof mount>[1] = {
      props: {
        modelValue: true,
        date: '2026-10-01',
        layer: 'top' as const,
        statuses,
        // 口径必填 prop，缺省 planned（与视图缺省口径一致）
        basis: 'planned' as DeliveryBasis,
        ...overrides,
      },
      global: {
        plugins: [VueQueryPlugin],
        provide: { VUE_QUERY_CLIENT: testQueryClient },
        // 注册全局 stub：vi.mock('element-plus') 替换的 module export 不能被
        // Vue 自动注册到组件表里；这里手动用 kebab-case 注册保证 SFC 模板里
        // 的 <el-tag> / <el-table> 等可以解析。
        // 2026-09-30（Phase 7）调整：el-drawer / el-table 加 name + props/emits，
        // 让 wrapper.findComponent({ name: 'ElDrawer' / 'ElTable' }) 能命中
        // （U6 / U7 依赖此能力）。
        components: {
          'el-drawer': {
            name: 'ElDrawer',
            props: ['modelValue', 'direction', 'size', 'withHeader', 'appendToBody', 'destroyOnClose'],
            emits: ['update:modelValue'],
            template: '<div class="mock-drawer"><slot /></div>',
          },
          'el-empty': {
            name: 'ElEmpty',
            props: ['imageSize', 'description'],
            template: '<div class="mock-empty"><slot /></div>',
          },
          'el-tag': {
            name: 'ElTag',
            props: ['type', 'size', 'effect'],
            template: '<span class="mock-tag"><slot /></span>',
          },
          'el-button': {
            name: 'ElButton',
            props: ['text', 'size'],
            emits: ['click'],
            template: '<button class="mock-button" @click="$emit(\'click\')"><slot /></button>',
          },
          'el-table': ElTableStub,
          'el-table-column': ElTableColumnStub,
          'el-icon': { name: 'ElIcon', template: '<i><slot /></i>' },
          'el-tooltip': {
            name: 'ElTooltip',
            template: '<span><slot /></span>',
          },
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
    // 表头件数：header 是单行（日期 · 层标签 · 共 N 件），mock 1 条 → 「共 1 件」
    expect(wrapper.find('.header-total').exists()).toBe(true);
    expect(wrapper.find('.header-total').text()).toBe('共 1 件');
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
    // 反向断言：:data 为空时列模板一个都不渲染。若列 stub 喂的是与 :data 无关的假行，
    // 这条会挂 —— 说明列级断言真的绑在 :data 的行上，而不是绑在桩产物上。
    expect(wrapper.find('.cell-due').exists()).toBe(false);
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

  // 2026-09-30（Phase 7）新增：Phase 5 把 el-drawer 方向从 rtl 改为 btt + size 480→60%。
  it('U6：el-drawer direction=btt + size=60%（Phase 5 改动防回归）', async () => {
    listUnionItemsMock.mockResolvedValue({ items: [], total: 0, limit: 500, offset: 0 });

    const wrapper = mount(UpcomingDeliveryListDrawer, makeMountOpts());

    // vi.mock('element-plus') 的 ElDrawer stub 与 makeMountOpts 内全局注册的
    // el-drawer 行为对齐；这里取全局注册那份（先注册优先）做 props 断言。
    const drawer = wrapper.findComponent({ name: 'ElDrawer' });
    expect(drawer.exists()).toBe(true);
    expect(drawer.props('direction')).toBe('btt');
    expect(drawer.props('size')).toBe('60%');

    wrapper.unmount();
  });

  // 2026-09-30（Phase 7）新增：Phase 5 新增行点击 → emit('rowClick', part)。
  // 通过 stub ElTable 的 vm.$emit('row-click', part) 直接驱动（沿 vue-echarts 8.3 适配思路：
  // happy-dom 下 .el-table__row click 事件冒泡链路脆弱，直接 emit 最稳）。
  it('U7：el-table 行点击 → emit rowClick(part)', async () => {
    const part = makePart({ id: '180000000000001' });
    listUnionItemsMock.mockResolvedValue({
      items: [part],
      total: 1,
      limit: 500,
      offset: 0,
    });

    const wrapper = mount(UpcomingDeliveryListDrawer, makeMountOpts());
    await new Promise((resolve) => setTimeout(resolve, 80));
    await nextTick();

    const elTable = wrapper.findComponent({ name: 'ElTable' });
    expect(elTable.exists()).toBe(true);
    // el-table @row-click emit 名 = 'row-click'（kebab-case，vue 事件命名约定）
    elTable.vm.$emit('row-click', part);
    await nextTick();

    const events = wrapper.emitted('rowClick');
    expect(events).toBeTruthy();
    expect(events?.[0]?.[0]).toMatchObject({ id: '180000000000001' });

    wrapper.unmount();
  });

  // ==========================================================================
  // 交期统计口径（planned / system）—— 倒计列与 header 自解释
  // ==========================================================================

  /** 远期日期（>3 天）⇒ deliveryDaysLeftText 返回空串、倒计时稳定回落到 MM/DD，
   *  断言不随「测试运行当天」漂移。两个日期刻意拉开，一眼能看出取的是哪个字段。 */
  const FAR_PLANNED = '2099-12-31';
  const FAR_SYSTEM = '2099-11-30';

  it('U8：倒计列按 basis 取字段（planned 取计划交期 / system 取系统交期）', async () => {
    listUnionItemsMock.mockResolvedValue({
      items: [makePart({ planned_delivery_date: FAR_PLANNED, system_delivery_date: FAR_SYSTEM })],
      total: 1,
      limit: 500,
      offset: 0,
    });

    const plannedWrapper = mount(UpcomingDeliveryListDrawer, makeMountOpts());
    await new Promise((resolve) => setTimeout(resolve, 80));
    await nextTick();
    expect(plannedWrapper.findAll('.cell-due')).toHaveLength(1);
    expect(plannedWrapper.find('.cell-due').text()).toBe('12/31');
    plannedWrapper.unmount();

    const systemWrapper = mount(UpcomingDeliveryListDrawer, makeMountOpts({ basis: 'system' }));
    await new Promise((resolve) => setTimeout(resolve, 80));
    await nextTick();
    expect(systemWrapper.findAll('.cell-due')).toHaveLength(1);
    expect(systemWrapper.find('.cell-due').text()).toBe('11/30');
    systemWrapper.unmount();
  });

  it('U9：system 口径下系统交期为空 → 倒计列留空、不挂逾期样式', async () => {
    listUnionItemsMock.mockResolvedValue({
      items: [makePart({ planned_delivery_date: FAR_PLANNED, system_delivery_date: null })],
      total: 1,
      limit: 500,
      offset: 0,
    });

    const wrapper = mount(UpcomingDeliveryListDrawer, makeMountOpts({ basis: 'system' }));
    await new Promise((resolve) => setTimeout(resolve, 80));
    await nextTick();

    // 未填系统交期的工单本来就不会出现在系统口径的抽屉里；这里钉的是「万一出现
    // （后端某天放宽了 NULL 处理）也不会显示成逾期 2099 年的计划交期倒计时」。
    const due = wrapper.find('.cell-due');
    expect(due.text()).toBe('');
    expect(due.classes()).not.toContain('overdue');
    expect(due.classes()).not.toContain('due-soon');
    wrapper.unmount();
  });

  it('U10：header 口径标签随 basis 变化（抽屉自解释当前口径）', async () => {
    listUnionItemsMock.mockResolvedValue({
      items: [makePart()],
      total: 1,
      limit: 500,
      offset: 0,
    });

    const plannedWrapper = mount(UpcomingDeliveryListDrawer, makeMountOpts());
    await new Promise((resolve) => setTimeout(resolve, 80));
    await nextTick();
    expect(plannedWrapper.text()).toContain('计划交期');
    plannedWrapper.unmount();

    const systemWrapper = mount(UpcomingDeliveryListDrawer, makeMountOpts({ basis: 'system' }));
    await new Promise((resolve) => setTimeout(resolve, 80));
    await nextTick();
    expect(systemWrapper.text()).toContain('系统交期');
    systemWrapper.unmount();
  });

  // ==========================================================================
  // 2026-10-05：头部件数按 total 渲染 + 被 limit 截断时出提示
  // ==========================================================================

  it('U11：total(9) > 取回条数(2) → 头部件数是 9 且追加「仅显示前 2 条」', async () => {
    // 端点 limit 被后端 clamp(1, 200)，rows.length 只是本页拿回来的条数。
    listUnionItemsMock.mockResolvedValue({
      items: [makePart({ id: '180000000000001' }), makePart({ id: '180000000000002' })],
      total: 9,
      limit: 500,
      offset: 0,
    });

    const wrapper = mount(UpcomingDeliveryListDrawer, makeMountOpts());
    await new Promise((resolve) => setTimeout(resolve, 80));
    await nextTick();

    expect(wrapper.findAll('.mock-row')).toHaveLength(2);
    expect(wrapper.find('.header-total').text()).toBe('共 9 件');
    expect(wrapper.find('.header-truncated').exists()).toBe(true);
    expect(wrapper.find('.header-truncated').text()).toBe('仅显示前 2 条');
    wrapper.unmount();
  });

  it('U12：total === rows.length → 只出「共 N 件」，不渲染截断提示', async () => {
    listUnionItemsMock.mockResolvedValue({
      items: [makePart({ id: '180000000000001' }), makePart({ id: '180000000000002' })],
      total: 2,
      limit: 500,
      offset: 0,
    });

    const wrapper = mount(UpcomingDeliveryListDrawer, makeMountOpts());
    await new Promise((resolve) => setTimeout(resolve, 80));
    await nextTick();

    expect(wrapper.find('.header-total').text()).toBe('共 2 件');
    expect(wrapper.find('.header-truncated').exists()).toBe(false);
    wrapper.unmount();
  });

  it('U13：换键 pending 期头部不渲染件数（不把「共 0 件」当权威计数抛出去）', async () => {
    // 挂起一个永不 settle 的请求 ⇒ query.data 恒 undefined、isPending 恒 true
    // （该 query 无 placeholderData）。此时 total 派生为 0，渲染出来会被读成
    // 「服务端确认 0 件」，而真相是「还没拿到数据」。
    listUnionItemsMock.mockReturnValue(new Promise(() => {}));

    const wrapper = mount(UpcomingDeliveryListDrawer, makeMountOpts());
    await nextTick();

    expect(wrapper.find('.header-total').exists()).toBe(false);
    // pending 期也没有截断提示可判（0 > 0 不成立），两侧都不出现
    expect(wrapper.find('.header-truncated').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('共 0 件');
    wrapper.unmount();
  });
});
