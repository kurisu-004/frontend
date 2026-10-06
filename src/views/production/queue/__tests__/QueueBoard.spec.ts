// @vitest-environment happy-dom
// src/views/production/queue/__tests__/QueueBoard.spec.ts
//
// 生产队列看板（路由 /production/worker-queue）的接线 guard。
//
// 2026-10-08 重写：数据源从「工序计数 + 每工人 state + batches/pending」换成
// 「队列快照 + 工序看板 + queue/pending」；本页进页面请求数恒为 3（processes +
// queue/snapshot + queue/pending），per-process 详情只有切到对应 tab 才发，且是
// **1 个请求**（工人列零请求）。
//
// 覆盖：
//   - T1：mount 时不抛任何 setup 异常（通用 mount 冒烟 guard）。
//   - T2：进页面**不发** per-process 看板请求（tab 懒加载核心 guard）。
//   - T2b：进页面只发队列快照一条请求（无 per-process、无 pending）。
//   - T3：fetchQueueSnapshot 零参调用（端点不接 Query extractor / 无货架维度）。
//   - T4：拖入高亮的跨面板接线（源面板 emit → 板级 ref → 工序池面板 prop）。
//   - T5：provide 三个 move 包装（含 WORKER→WORKER 包装）—— 工人列落点与候选池
//     抽屉的 @add 全靠 inject 拿包装，漏 provide 就退化为「不发请求」。
//   - T6：provide openBatchContextMenu + 权限闸（canRecall 为假时菜单打不开、且给出
//     warning 而非静默）+ 菜单 open 收到 (evt, batch)。
//   - T7：菜单 emit('recall') → useQueueRecall.recallBatch 拿到那张卡。
//   - T7b：召回通路不新增首屏请求 —— 四个端点的调用次数快照（T2b 只锁集合不锁次数，
//     本用例补上次数这一维）。
//
// 测试策略：
//   - vue-test-utils mount + globalConfig.plugins: [[VueQueryPlugin, { queryClient }]]；
//   - vi.mock('@/api/productionQueue') + vi.mock('@/stores/auth') +
//     vi.mock('element-plus') +
//     vi.mock('@/views/production/queue/composables/useQueueMove') +
//     vi.mock('@/views/production/queue/composables/useQueueDispatch') +
//     vi.mock('@/composables/queries/useProcessesQuery') +
//     vi.mock 子组件 PendingBatchesPanel / PendingPoolsPanel / ProcessBoardTab；
//   - vi.mock('@/api/process') 兜底 useProcessesQuery 内部 import；
//   - vi.mock('vue-router') 让 useRoute / useRouter 不报 undefined error。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref, type Ref } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';
// 下面 vi.mock('element-plus') 里定义的 EP stub：QueueBoard 的模板不 import 组件，
// 解析不到模块导出就会退化成同名原生标签（<el-tab-pane> 原样输出、label 槽不渲染）。
// 要断言渲染结果就得把 stub 显式注册进 global.components —— T8 依赖这一点。
import { ElSplitter, ElSplitterPanel, ElTabPane, ElTabs } from 'element-plus';

vi.mock('element-plus', () => ({
  ElMessage: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
  ElAlert: defineComponent({
    name: 'ElAlertStub',
    props: { title: String, type: String, closable: Boolean, showIcon: Boolean },
    setup(_, { slots }) {
      return () => h('div', { class: 'el-alert-stub' }, slots.default?.());
    },
  }),
  ElSkeleton: defineComponent({
    name: 'ElSkeletonStub',
    props: { rows: Number, animated: Boolean },
    setup() {
      return () => h('div', { class: 'el-skeleton-stub' });
    },
  }),
  ElTabs: defineComponent({
    name: 'ElTabsStub',
    props: { modelValue: String },
    setup(_, { slots }) {
      return () => h('div', { class: 'el-tabs-stub' }, slots.default?.());
    },
  }),
  ElTabPane: defineComponent({
    name: 'ElTabPaneStub',
    props: { name: String, lazy: Boolean },
    // label 槽一并渲染：T8 要断言「待下发」tab 标题徽标读的是快照的 pending_count，
    // 断言落在真实渲染出来的标签文本上（而不是去摸组件内部的 computed）。
    setup(_, { slots }) {
      return () =>
        h('div', { class: 'el-tab-pane-stub' }, [
          h('div', { class: 'el-tab-pane-stub__label' }, slots.label?.()),
          slots.default?.(),
        ]);
    },
  }),
  ElButton: defineComponent({
    name: 'ElButtonStub',
    setup(_, { slots }) {
      return () => h('button', { class: 'el-button-stub' }, slots.default?.());
    },
  }),
  ElSplitter: defineComponent({
    name: 'ElSplitterStub',
    setup(_, { slots }) {
      return () => h('div', { class: 'el-splitter-stub' }, slots.default?.());
    },
  }),
  ElSplitterPanel: defineComponent({
    name: 'ElSplitterPanelStub',
    setup(_, { slots }) {
      return () => h('div', { class: 'el-splitter-panel-stub' }, slots.default?.());
    },
  }),
}));

/** 队列快照（GET /prod/queue/snapshot，零参调用）。 */
const realFetchQueueSnapshot = vi.fn<
  () => Promise<{
    processes: Array<{
      process_id: string;
      process_code: string;
      process_name: string;
      color: string | null;
      category: 'INHOUSE' | 'OUTSOURCE';
      pool_count: number;
    }>;
    pending_count: number;
    ts: string;
  }>
>(async () => ({ processes: [], pending_count: 0, ts: '2026-10-08T09:12:33+08:00' }));

/** 懒加载 guard：单工序看板请求**不应**在进页面时被发出。 */
const realFetchQueueBoard = vi.fn<(processId: string) => Promise<unknown>>(async (processId) => ({
  process: { process_id: processId, process_code: 'CNC-01', process_name: '粗加工', color: null },
  workers: [],
  items: [],
  total: 0,
  ts: '2026-10-08T09:12:33+08:00',
}));

const realFetchPendingBatches = vi.fn<
  () => Promise<{ items: unknown[]; total: number; limit: number; offset: number }>
>(async () => ({ items: [], total: 0, limit: 200, offset: 0 }));

vi.mock('@/api/productionQueue', () => ({
  fetchQueueSnapshot: () => realFetchQueueSnapshot(),
  fetchQueueBoard: (processId: string) => realFetchQueueBoard(processId),
  fetchPendingBatches: () => realFetchPendingBatches(),
  dispatchBatches: vi.fn(),
  previewAutoDispatch: vi.fn(),
  recallToPending: vi.fn(),
  moveBatch: vi.fn(),
  autoAllocate: vi.fn(),
  refillQueue: vi.fn(),
}));

// auth.activeShelfId 用响应式 ref 暴露，测试可改值。
const activeShelfIdRef: Ref<string | undefined> = ref<string | undefined>();
vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({
    activeShelfId: activeShelfIdRef,
    // 其它 stub 字段，QueueBoard 不消费但 mock 形态保完整。
    isAuthenticated: ref(false),
    user: ref(null),
    token: ref<string | null>(null),
    hasRole: () => false,
    hasMenuCode: () => false,
    canOperateShelf: () => false,
    getAuthHeader: () => ({}),
  }),
}));

vi.mock('@/api/process', () => ({
  listProcesses: vi.fn().mockResolvedValue({ items: [], total: 0, limit: 200, offset: 0 }),
  getProcess: vi.fn(),
  createProcess: vi.fn(),
  updateProcess: vi.fn(),
  softDeleteProcess: vi.fn(),
}));

// 本 mock 只保留 QueueBoard 实际消费的面（error + 三个 move 包装；含
// moveBatchBetweenWorkers —— WORKER→WORKER，工人列落点消费）。
// 走 vi.hoisted：vi.mock 工厂被提升到模块顶部求值，直接闭包引用下面模块体里的
// const 会在工厂被提前求值时命中 TDZ（同文件里 realFetchQueueSnapshot 等同理）。
const { moveBatchBetweenWorkersMock } = vi.hoisted(() => ({
  moveBatchBetweenWorkersMock: vi.fn(async () => true),
}));
vi.mock('@/views/production/queue/composables/useQueueMove', () => ({
  useQueueMove: () => ({
    moveBatchToWorker: vi.fn(),
    moveBatchToPool: vi.fn(),
    moveBatchBetweenWorkers: moveBatchBetweenWorkersMock,
    error: ref<string | null>(null),
  }),
}));

vi.mock('@/views/production/queue/composables/useQueueDispatch', () => ({
  useQueueDispatch: () => ({
    batches: ref([]),
    total: ref(50),
    isLoading: ref(false),
    selectedIds: ref<Set<string>>(new Set()),
    selectedCount: ref(0),
    setSelectedIds: vi.fn(),
    autoDispatchMutation: { mutate: vi.fn(), isPending: ref(false) },
    dispatchMutation: { mutate: vi.fn(), isPending: ref(false) },
  }),
}));

vi.mock('@/composables/queries/useProcessesQuery', () => ({
  useProcessesQuery: () => ({
    data: ref({ items: [], total: 0, limit: 200, offset: 0 }),
    isLoading: ref(false),
    error: ref<Error | null>(null),
  }),
}));

// 子组件 stub —— 避免引入 el-table / el-tabs 真实组件在 happy-dom 下的复杂性。
// PendingBatchesPanel / PendingPoolsPanel 两个 stub 带上「拖入高亮」链路的接缝
// （前者可 emit hoverProcess、后者回显 hoveredProcessId），让 T4 能在组件级守住
// QueueBoard 这一段的接线；两侧组件内部逻辑分别由各自 spec 覆盖。
vi.mock('../components/PendingBatchesPanel.vue', () => ({
  default: defineComponent({
    name: 'PendingBatchesPanelStub',
    emits: ['hoverProcess'],
    setup(_, { emit }) {
      return () =>
        h(
          'div',
          {
            class: 'pending-batches-stub',
            onClick: () => emit('hoverProcess', '2000000000001'),
          },
          'mock-pending-batches',
        );
    },
  }),
}));
vi.mock('../components/PendingPoolsPanel.vue', () => ({
  default: defineComponent({
    name: 'PendingPoolsPanelStub',
    props: { hoveredProcessId: { type: String, default: null } },
    setup(props) {
      return () =>
        h('div', { class: 'pending-pools-stub' }, `mock-hover:${String(props.hoveredProcessId)}`);
    },
  }),
}));
vi.mock('../components/ProcessBoardTab.vue', () => ({
  default: defineComponent({
    name: 'ProcessBoardTabStub',
    props: { processId: String },
    setup() {
      return () => h('div', { class: 'worker-pool-tab-stub' });
    },
  }),
}));

// 2026-10-06：右键召回菜单（板级单例）与召回 composable 的接线 guard。
// 两个都桩掉的理由：
//   - 菜单：本 spec 的 element-plus 是整体 mock，真实 el-menu / el-menu-item 在这里
//     解析不出来（模板组件解析走全局注册，不走模块 import），真实组件会打一串
//     "Failed to resolve component" 噪声。桩只保留两条接线面 —— expose 的 open 与
//     recall emit，组件自身行为由 BatchContextMenu.spec.ts 覆盖。
//   - useQueueRecall：只需观察 recallBatch 是否被转交、canRecall 是否被读，
//     写请求 / 确认弹窗 / 失效链由 useQueueRecall.spec.ts 覆盖。
// 走 vi.hoisted：工厂被提升到模块顶部求值，裸引用模块级 const 会命中 TDZ。
const { menuOpenCalls, recallBatchMock, recallable } = vi.hoisted(() => ({
  menuOpenCalls: [] as unknown[][],
  recallBatchMock: vi.fn(async () => undefined),
  /** 权限闸的开关：默认 false ⇒ opener 直接早退（与本 spec 的 auth mock 一致） */
  recallable: { ok: false },
}));
vi.mock('../components/BatchContextMenu.vue', () => ({
  default: defineComponent({
    name: 'BatchContextMenuStub',
    emits: ['recall'],
    setup(_, { expose }) {
      expose({ open: (...args: unknown[]) => menuOpenCalls.push(args) });
      return () => h('div', { class: 'batch-context-menu-stub' });
    },
  }),
}));
vi.mock('@/views/production/queue/composables/useQueueRecall', () => ({
  useQueueRecall: () => ({
    // getter 而非 ref 快照：用例可随时改 recallable.ok，改完立即生效
    canRecall: {
      get value(): boolean {
        return recallable.ok;
      },
    },
    recallMutation: { mutate: vi.fn(), isPending: ref(false) },
    recallBatch: recallBatchMock,
  }),
}));

// vue-router stub —— 提供 query / replace 方法。
const routeQuery: Ref<Record<string, unknown>> = ref({});
vi.mock('vue-router', () => ({
  useRoute: () => ({ query: routeQuery.value }),
  useRouter: () => ({ replace: vi.fn().mockResolvedValue(undefined) }),
}));

import QueueBoard from '../QueueBoard.vue';

// 公共环境未处理 rejection（vue-query 异步 + 子组件 mount）。
process.on('unhandledRejection', () => undefined);

let testQueryClient: QueryClient;

describe('QueueBoard（生产队列看板接线 guard）', () => {
  beforeEach(() => {
    realFetchQueueSnapshot.mockClear();
    realFetchQueueSnapshot.mockResolvedValue({
      processes: [],
      pending_count: 0,
      ts: '2026-10-08T09:12:33+08:00',
    });
    realFetchQueueBoard.mockClear();
    realFetchPendingBatches.mockClear();
    realFetchPendingBatches.mockResolvedValue({ items: [], total: 0, limit: 200, offset: 0 });
    activeShelfIdRef.value = undefined;
    recallable.ok = false;
    menuOpenCalls.length = 0;
    recallBatchMock.mockClear();
    testQueryClient = new QueryClient({
      defaultOptions: { mutations: { retry: 0 }, queries: { retry: 0 } },
    });
  });

  it('T1：mount 时 setup 阶段不抛异常（通用 mount 冒烟 guard）', async () => {
    // 保留为通用冒烟：看板的 setup 里有多条 query / provide / 深链校正 watch，任一处
    // 在 mount 阶段抛错都表现为整页白屏，而这类错误在组件级 spec 里最难复现。
    // activeShelfId 显式给非空值，顺带守住「货架注入为空时 mount 仍不炸」。
    activeShelfIdRef.value = '5000000000001';
    let mountError: unknown = null;
    try {
      const wrapper = mount(QueueBoard, {
        global: {
          plugins: [[VueQueryPlugin, { queryClient: testQueryClient }]],
        },
      });
      await flushPromises();
      wrapper.unmount();
    } catch (e) {
      mountError = e;
    }
    if (mountError) {
      expect(String(mountError)).not.toMatch(/Cannot access 'shelfId' before initialization/);
    }
    expect(mountError).toBeNull();
  });

  it('T2：进页面**不发** per-process 详情请求（懒加载核心 guard）', async () => {
    // 回归 guard（N+1 修复）：改前 PendingPoolsPanel 在默认首屏「待下发」tab 内
    // v-for 全部工序，每张 PendingPoolCard 自管 per-process 查询算徽标 ⇒ 进页面即打
    // N 个工序详情请求。徽标现改走队列快照（单请求）⇒ 工序看板只有切到对应 tab
    // （el-tab-pane :lazy）才发。
    activeShelfIdRef.value = '5000000000001';
    const wrapper = mount(QueueBoard, {
      global: {
        plugins: [[VueQueryPlugin, { queryClient: testQueryClient }]],
      },
    });
    await flushPromises();
    await testQueryClient.refetchQueries();
    await flushPromises();

    expect(realFetchQueueBoard).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('T2b：进页面只发队列快照一条请求（无 per-process 看板、无 pending 列表）', async () => {
    // 进页面的 3 个 query 各自的请求面：
    //   - useProcessesQuery → 本 spec mock 成同步 data ⇒ 0 请求
    //   - useQueueSnapshot  → 1 请求（单请求跨所有货架聚合，无货架维度）
    //   - useQueueDispatch  → 被本 spec 一并 mock 掉 ⇒ 0 请求
    //     （它自身的请求面由 useQueueDispatch.spec.ts 覆盖）
    // 另有「切到工序 tab 才发」的工序看板查询在进页面时必为 0 次
    // （ProcessBoardTab 内，el-tab-pane :lazy）。
    activeShelfIdRef.value = '5000000000001';
    const wrapper = mount(QueueBoard, {
      global: {
        plugins: [[VueQueryPlugin, { queryClient: testQueryClient }]],
      },
    });
    await flushPromises();
    await testQueryClient.refetchQueries();
    await flushPromises();

    expect(realFetchQueueSnapshot).toHaveBeenCalled();
    expect(realFetchQueueBoard).not.toHaveBeenCalled();
    expect(realFetchPendingBatches).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('T3：fetchQueueSnapshot 零参调用（端点无 Query extractor / 无货架维度）', async () => {
    activeShelfIdRef.value = '5000000000001';
    const wrapper = mount(QueueBoard, {
      global: {
        plugins: [[VueQueryPlugin, { queryClient: testQueryClient }]],
      },
    });
    await flushPromises();
    await testQueryClient.refetchQueries();

    expect(realFetchQueueSnapshot).toHaveBeenCalled();
    // 一个参数都不能有
    expect(realFetchQueueSnapshot.mock.calls[0]).toHaveLength(0);
    wrapper.unmount();
  });

  it('T8：「待下发」tab 标题徽标读快照 pending_count，不是列表 batches.length', async () => {
    // 回归 guard：徽标一度读 `pendingDispatch.batches.length` —— 那是**分页后的页
    // 长度**（limit=200），超过一页就低报。本用例把两个数设成互不相同的值：
    //   快照 pending_count = 42（本 spec mock 的 useQueueDispatch 给 batches = []）
    //   batches.length     = 0
    // 断言落在真实渲染出的标签文本上（el-tab-pane stub 渲染 label 槽）。
    realFetchQueueSnapshot.mockResolvedValue({
      processes: [],
      pending_count: 42,
      ts: '2026-10-08T09:12:33+08:00',
    });
    activeShelfIdRef.value = '5000000000001';
    const wrapper = mount(QueueBoard, {
      global: {
        components: { ElTabs, ElTabPane, ElSplitter, ElSplitterPanel },
        plugins: [[VueQueryPlugin, { queryClient: testQueryClient }]],
      },
    });
    await flushPromises();
    await testQueryClient.refetchQueries();
    await flushPromises();

    const label = wrapper
      .findAll('.el-tab-pane-stub__label')
      .map((w) => w.text())
      .find((t) => t.includes('待下发'));
    expect(label).toBeDefined();
    expect(label).toContain('(42)');
    // 若退回 batches.length（= 0）这里会是 (0)
    expect(label).not.toContain('(0)');
    wrapper.unmount();
  });

  it('T5：provide 三个 move 包装（含 WORKER→WORKER 包装）', async () => {
    // 回归 guard：工人列的 onDragAdd 只 inject、不 import，漏 provide 时 inject
    // 拿到 noop 兜底 ⇒「工人之间转交」表现为拖了没反应，且控制台一条报错都没有。
    activeShelfIdRef.value = '5000000000001';
    const wrapper = mount(QueueBoard, {
      global: { plugins: [[VueQueryPlugin, { queryClient: testQueryClient }]] },
    });
    await flushPromises();
    const provides = (wrapper.vm.$ as unknown as { provides: Record<string, unknown> }).provides;
    expect(typeof provides.moveBatchToWorker).toBe('function');
    expect(typeof provides.moveBatchToPool).toBe('function');
    expect(provides.moveBatchBetweenWorkers).toBe(moveBatchBetweenWorkersMock);
    expect(typeof provides.shelfId).toBe('object');
    wrapper.unmount();
  });

  it('T4：拖入高亮的跨面板接线（源面板 emit → 板级 ref → 工序池面板 prop）', async () => {
    // 2026-10-02 回归 guard：Sortable 的 onMove 只派发给**源**（待下发批次列表），
    // 工序卡（投放目标）侧收不到 ⇒ 高亮态必须由源上报、经板级状态落到工序池面板。
    // 任一环断掉都表现为「拖入工序卡不高亮」且全链路无报错，故在此守住本组件这一段。
    activeShelfIdRef.value = '5000000000001';
    const wrapper = mount(QueueBoard, {
      global: {
        plugins: [[VueQueryPlugin, { queryClient: testQueryClient }]],
      },
    });
    await flushPromises();
    const pools = () => wrapper.find('.pending-pools-stub').text();
    // 初始无悬停目标
    expect(pools()).toBe('mock-hover:null');

    // 源面板上报某个工序 id → 板级状态透传到工序池面板
    await wrapper.find('.pending-batches-stub').trigger('click');
    expect(pools()).toBe('mock-hover:2000000000001');
    wrapper.unmount();
  });

  it('T6（2026-10-06）：provide openBatchContextMenu + 权限闸 + open 入参', async () => {
    // 回归 guard：卡片侧只 inject 这个 opener，漏 provide 就退化为「右键没反应」且
    // 无任何报错（inject 缺省 noop）。权限闸在 opener 内 —— 无权角色连菜单都打不开，
    // 但必须给一句 warning（卡片侧已 prevent 掉系统右键菜单，静默早退等于无反馈）。
    const { ElMessage } = await import('element-plus');
    activeShelfIdRef.value = '5000000000001';
    const wrapper = mount(QueueBoard, {
      global: { plugins: [[VueQueryPlugin, { queryClient: testQueryClient }]] },
    });
    await flushPromises();
    const provides = (wrapper.vm.$ as unknown as { provides: Record<string, unknown> }).provides;
    const open = provides.openBatchContextMenu as (e: MouseEvent, b: unknown) => void;
    expect(typeof open).toBe('function');

    const evt = new MouseEvent('contextmenu');
    const card = { batch_id: '3000000000001', version: 7 };

    // 无权：菜单不被调 open，且给出可读提示
    recallable.ok = false;
    vi.mocked(ElMessage.warning).mockClear();
    open(evt, card);
    expect(menuOpenCalls).toHaveLength(0);
    expect(ElMessage.warning).toHaveBeenCalledWith('没有召回已下发批次的权限');

    // 有权：转发给菜单，坐标与卡片原样送达（不再弹提示）
    recallable.ok = true;
    vi.mocked(ElMessage.warning).mockClear();
    open(evt, card);
    expect(menuOpenCalls).toHaveLength(1);
    expect(menuOpenCalls[0]![0]).toBe(evt);
    expect(menuOpenCalls[0]![1]).toBe(card);
    expect(ElMessage.warning).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('T7（2026-10-06）：菜单 recall 事件 → recallBatch 拿到那张卡', async () => {
    // 回归 guard：菜单 → 板级 onRecall → useQueueRecall.recallBatch 是一条 emit 链，
    // 任一环断掉都表现为「菜单能打开、点召回毫无反应」。
    activeShelfIdRef.value = '5000000000001';
    recallable.ok = true;
    const wrapper = mount(QueueBoard, {
      global: { plugins: [[VueQueryPlugin, { queryClient: testQueryClient }]] },
    });
    await flushPromises();

    const card = { batch_id: '3000000000002', version: 3 };
    wrapper.findComponent({ name: 'BatchContextMenuStub' }).vm.$emit('recall', card);
    await flushPromises();

    expect(recallBatchMock).toHaveBeenCalledTimes(1);
    expect(recallBatchMock).toHaveBeenCalledWith(card);
    wrapper.unmount();
  });

  it('T7b（2026-10-06）：召回通路不新增任何首屏请求（锁请求面**与次数**）', async () => {
    // 守住「进页面请求数恒为 3」这条不变式不被写操作 composable 与菜单组件破掉：
    // useQueueRecall 只建 mutation（不建 query），BatchContextMenu 零请求。
    // 与 T2b 的分工：T2b 只断言「哪些端点被调过」（集合，toHaveBeenCalled 无次数），
    // 本用例把三个端点的调用次数一起锁成一张快照 —— 多打一遍快照（双 fetch /
    // 重复挂载）或新增一条走这三个端点的首屏查询，都会红。
    activeShelfIdRef.value = '5000000000001';
    const wrapper = mount(QueueBoard, {
      global: { plugins: [[VueQueryPlugin, { queryClient: testQueryClient }]] },
    });
    await flushPromises();
    await testQueryClient.refetchQueries();
    await flushPromises();

    expect({
      // 唯一该发的那条：首屏 1 次 + 上面对 refetchQueries() 的显式补刷 1 次
      snapshot: realFetchQueueSnapshot.mock.calls.length,
      // 以下两个端点进页面时必须是 0 次（tab :lazy / pending 被 mock 掉）
      board: realFetchQueueBoard.mock.calls.length,
      pending: realFetchPendingBatches.mock.calls.length,
    }).toEqual({ snapshot: 2, board: 0, pending: 0 });
    wrapper.unmount();
  });
});
