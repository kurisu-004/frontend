// @vitest-environment happy-dom
// src/views/dashboard/components/__tests__/UpcomingDeliveryListDrawer.spec.ts
//
// UpcomingDeliveryListDrawer 三态渲染回归保护。
// 覆盖：
//   - U1：modelValue=true + statuses.length > 0 → 抽屉渲染 + 表头展示
//   - U2：modelValue=false → useDashboardDeliveryOrders enabled=false，请求不被发
//   - U3：rows 非空 → el-table 显示 N 行
//   - U4：rows 为空 + pending=false → 「该日该层无工单」empty text
//   - U5：v-model 双向同步 —— update:modelValue 事件正确发出
// 2026-09-30（Phase 7）追加：vue-echarts 8.3 适配后回归保护：
//   - U6：el-drawer direction=btt + size=60%（Phase 5 改 btt 防回归）
//   - U7：el-table 行点击 → emit('rowClick', part)（Phase 5 新增行点击事件防回归）
//
// 「交期统计口径」覆盖（U8~U10）：倒计列取当前口径对应的交期字段 / system 口径下
// 系统交期为空则倒计列留空 / header 口径标签随 basis 变化。日期取 2099 年的远期值：
// deliveryDaysLeftText 对 >3 天的远期返回空串，倒计时稳定回落到 MM/DD，断言不随
// 「测试运行当天」漂移。
//
// 「头部件数不谎报」覆盖（U11~U15）：件数取服务端 total（不受 items 截断影响），
// 被截断时追加「仅显示前 N 条」；首次加载（isPending）与请求失败（error）期都不渲染
// 「共 0 件」；后台 refetch 期（isPending=false、isFetching=true、data 仍在）头部照常
// 渲染 —— 开关盯的是 isPending，不是 isFetching。
//
// ElTable stub 照抄真实 Element Plus 的做法：按 :data 渲染 .mock-row，行内 provide
// 出当前行（MockTableRow），列 stub inject 后按该行喂自己的 scoped slot ⇒ 模板里的
// `const { row } = undefined` 不再抛错，且列断言真的绑定到 :data 的行上（:data 为空时
// 列内容一个都不渲染，U4 有对应的反向断言）。

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

const fetchDeliveryOrdersMock = vi.fn();
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

vi.mock('@/api/dashboard', () => ({
  fetchDeliveryOrders: (params: Record<string, unknown>) => fetchDeliveryOrdersMock(params),
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
import { qk } from '@/composables/queries/keys';

/** 下钻明细行（DeliveryOrderDetail VO，9 字段）。两列交期恒同时返回，倒计列由组件
 *  按当前口径自己选列。 */
function makeDetail(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '180000000000001',
    serial_no: 'SN-001',
    drawing_no: 'DWG-001',
    name: '零件甲',
    l1_customer_name: 'L1 客户',
    customer_name: '客户甲',
    status: 'PENDING',
    planned_delivery_date: '2026-10-01',
    system_delivery_date: null,
    ...overrides,
  };
}

/** 下钻响应（DeliveryOrderDetailOut VO）。date / basis 是请求参数回显，total 不受
 *  items 截断影响（服务端最多返 200 行）。 */
function makeOut(items: unknown[], total: number): Record<string, unknown> {
  return {
    date: '2026-10-01',
    basis: 'planned',
    total,
    items,
    ts: '2026-10-07T14:30:00.123+08:00',
  };
}

describe('UpcomingDeliveryListDrawer — 三态渲染（2026-09-30）', () => {
  let testQueryClient: QueryClient;

  beforeEach(() => {
    fetchDeliveryOrdersMock.mockReset();
    onDashboardEventMock.mockClear();
    lastEventHandler = null;
    // queries.retry: 0 与生产 main.ts 的全局默认对齐。插件自建 client 时用的是库默认
    // （queries.retry: 3 + 指数退避），错误态用例会等 1s+2s+4s 才落 error 态，既慢又
    // 不确定；显式关掉后错误态一次请求即定型。
    testQueryClient = new QueryClient({
      defaultOptions: { mutations: { retry: 0 }, queries: { retry: 0 } },
    });
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
        // 口径必填 prop，用例统一从 planned 起步
        basis: 'planned' as DeliveryBasis,
        ...overrides,
      },
      global: {
        // client 随插件一起传，testQueryClient.getQueryCache() 才能看到组件建的
        // query、defaultOptions 才真的生效（U14 依赖前者）。
        plugins: [[VueQueryPlugin, { queryClient: testQueryClient }]],
        // 注册全局 stub：vi.mock('element-plus') 替换的 module export 不能被
        // Vue 自动注册到组件表里；这里手动用 kebab-case 注册保证 SFC 模板里
        // 的 <el-tag> / <el-table> 等可以解析。el-drawer / el-table 带 name +
        // props/emits，wrapper.findComponent({ name: 'ElDrawer' / 'ElTable' })
        // 才能命中（U6 / U7 依赖此能力）。
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
    fetchDeliveryOrdersMock.mockResolvedValue(makeOut([makeDetail()], 1));

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

  it('U2：modelValue=false → useDashboardDeliveryOrders enabled=false，请求不发', async () => {
    fetchDeliveryOrdersMock.mockResolvedValue(makeOut([], 0));

    const wrapper = mount(UpcomingDeliveryListDrawer, makeMountOpts({ modelValue: false }));

    await new Promise((resolve) => setTimeout(resolve, 50));
    await nextTick();

    expect(fetchDeliveryOrdersMock).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('U3：rows 非空 → el-table 显示 N 行', async () => {
    fetchDeliveryOrdersMock.mockResolvedValue(makeOut([makeDetail({ id: '180000000000001' }), makeDetail({ id: '180000000000002' })], 2));

    const wrapper = mount(UpcomingDeliveryListDrawer, makeMountOpts());

    await new Promise((resolve) => setTimeout(resolve, 80));
    await nextTick();

    expect(wrapper.findAll('.mock-row')).toHaveLength(2);
    expect(wrapper.text()).toContain('共 2 件');
    wrapper.unmount();
  });

  it('U4：rows 为空 + pending=false → emptyText 生效', async () => {
    fetchDeliveryOrdersMock.mockResolvedValue(makeOut([], 0));

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
    fetchDeliveryOrdersMock.mockResolvedValue(makeOut([], 0));

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

  // el-drawer 方向 btt + size 60%（防回归）。
  it('U6：el-drawer direction=btt + size=60%（Phase 5 改动防回归）', async () => {
    fetchDeliveryOrdersMock.mockResolvedValue(makeOut([], 0));

    const wrapper = mount(UpcomingDeliveryListDrawer, makeMountOpts());

    // vi.mock('element-plus') 的 ElDrawer stub 与 makeMountOpts 内全局注册的
    // el-drawer 行为对齐；这里取全局注册那份（先注册优先）做 props 断言。
    const drawer = wrapper.findComponent({ name: 'ElDrawer' });
    expect(drawer.exists()).toBe(true);
    expect(drawer.props('direction')).toBe('btt');
    expect(drawer.props('size')).toBe('60%');

    wrapper.unmount();
  });

  // 行点击 → emit('rowClick', part)。通过 stub ElTable 的 vm.$emit('row-click', part)
  // 直接驱动（happy-dom 下 .el-table__row click 事件冒泡链路脆弱，直接 emit 最稳）。
  it('U7：el-table 行点击 → emit rowClick(part)', async () => {
    const row = makeDetail({ id: '180000000000001' });
    fetchDeliveryOrdersMock.mockResolvedValue(makeOut([row], 1));

    const wrapper = mount(UpcomingDeliveryListDrawer, makeMountOpts());
    await new Promise((resolve) => setTimeout(resolve, 80));
    await nextTick();

    const elTable = wrapper.findComponent({ name: 'ElTable' });
    expect(elTable.exists()).toBe(true);
    // el-table @row-click emit 名 = 'row-click'（kebab-case，vue 事件命名约定）
    elTable.vm.$emit('row-click', row);
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
    fetchDeliveryOrdersMock.mockResolvedValue(makeOut([makeDetail({ planned_delivery_date: FAR_PLANNED, system_delivery_date: FAR_SYSTEM })], 1));

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
    fetchDeliveryOrdersMock.mockResolvedValue(makeOut([makeDetail({ planned_delivery_date: FAR_PLANNED, system_delivery_date: null })], 1));

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
    fetchDeliveryOrdersMock.mockResolvedValue(makeOut([makeDetail()], 1));

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
  // 头部件数按 total 渲染 + 被服务端截断时出提示
  // ==========================================================================

  it('U11：total(9) > 取回条数(2) → 头部件数是 9 且追加「仅显示前 2 条」', async () => {
    // items 被服务端截断到 200 行，rows.length 只是本页拿回来的条数。
    fetchDeliveryOrdersMock.mockResolvedValue(makeOut([makeDetail({ id: '180000000000001' }), makeDetail({ id: '180000000000002' })], 9));

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
    fetchDeliveryOrdersMock.mockResolvedValue(makeOut([makeDetail({ id: '180000000000001' }), makeDetail({ id: '180000000000002' })], 2));

    const wrapper = mount(UpcomingDeliveryListDrawer, makeMountOpts());
    await new Promise((resolve) => setTimeout(resolve, 80));
    await nextTick();

    expect(wrapper.find('.header-total').text()).toBe('共 2 件');
    expect(wrapper.find('.header-truncated').exists()).toBe(false);
    wrapper.unmount();
  });

  it('U13：首次加载 pending 期头部不渲染件数（不把「共 0 件」当权威计数抛出去）', async () => {
    // 挂起一个永不 settle 的请求 ⇒ query.data 恒 undefined、isPending 恒 true
    // （该 query 无 placeholderData）。此时 total 派生为 0，渲染出来会被读成
    // 「服务端确认 0 件」，而真相是「还没拿到数据」。
    // 用例名只钉「首次加载」这一种形态：换键（切 basis / 切日期 / 切层）走的是同一个
    // 分支且同样 isPending（新键无 data），不必单列。
    fetchDeliveryOrdersMock.mockReturnValue(new Promise(() => {}));

    const wrapper = mount(UpcomingDeliveryListDrawer, makeMountOpts());
    await nextTick();

    expect(wrapper.find('.header-total').exists()).toBe(false);
    // pending 期也没有截断提示可判（0 > 0 不成立），两侧都不出现
    expect(wrapper.find('.header-truncated').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('共 0 件');
    wrapper.unmount();
  });

  it('U14：请求失败 → 不渲染「共 0 件」，只出错误块（0 件 ≠ 没拿到数据）', async () => {
    // 失败后 isPending 归 false、total 回落 0。若头部只盯 isPending，会渲染出
    // 「共 0 件」与下方红色错误块并存，自相矛盾且会被读成服务端确认了 0 件。
    fetchDeliveryOrdersMock.mockRejectedValue(new Error('boom'));

    const wrapper = mount(UpcomingDeliveryListDrawer, makeMountOpts());
    await new Promise((resolve) => setTimeout(resolve, 80));
    await nextTick();

    expect(wrapper.find('.list-error').exists()).toBe(true);
    expect(wrapper.find('.list-error').text()).toContain('boom');
    expect(wrapper.find('.header-total').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('共 0 件');
    // total 回落 0 时截断提示同样不该出现（0 > 0 不成立）
    expect(wrapper.find('.header-truncated').exists()).toBe(false);
    wrapper.unmount();
  });

  it('U15：后台 refetch 期（isPending=false / isFetching=true）头部照常渲染件数', async () => {
    // 已有数据 + 同键 invalidate 触发的后台 refetch：此时 query 已有 data、status 不是
    // pending，只有 fetchStatus 是 fetching。头部件数必须留着 —— 数字是当前且正确的，
    // 整段闪烁反而是大屏噪音。若把 composable 的 isPending 误接成 isFetching，本条红。
    fetchDeliveryOrdersMock.mockResolvedValue(makeOut([makeDetail({ id: '180000000000001' }), makeDetail({ id: '180000000000002' })], 2));

    const wrapper = mount(UpcomingDeliveryListDrawer, makeMountOpts());
    await new Promise((resolve) => setTimeout(resolve, 80));
    await nextTick();
    expect(wrapper.find('.header-total').text()).toBe('共 2 件');

    // 换成永不 settle 的实现 + 失效该 query ⇒ 进入「有旧数据、正在后台重取」的状态
    fetchDeliveryOrdersMock.mockReturnValue(new Promise(() => {}));
    void testQueryClient.invalidateQueries({ queryKey: qk.dashboardPrefix });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await nextTick();

    const query = testQueryClient.getQueryCache().getAll()[0];
    // 前置校验：确实处在 fetching + 有 data 的组合，否则本条是空断言
    expect(query?.state.fetchStatus).toBe('fetching');
    expect(query?.state.data).toBeTruthy();
    expect(query?.state.status).not.toBe('pending');

    expect(wrapper.find('.header-total').exists()).toBe(true);
    expect(wrapper.find('.header-total').text()).toBe('共 2 件');
    expect(wrapper.findAll('.mock-row')).toHaveLength(2);
    wrapper.unmount();
  });
});
