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
//   - T6：provide openBatchContextMenu + 区域参数 + 菜单项矩阵派生（无权角色得到一句
//     warning 而不是静默无反馈 / 空白菜单）。
//   - T7：菜单项 onClick → 复用现成 composable（useQueueRecall.recallBatch /
//     useQueueDispatch.dispatchMutation / useQueueMove 的三个 move 包装），板级不新增
//     任何 mutation。
//   - T7b：召回通路不新增首屏请求 —— 四个端点的调用次数快照（T2b 只锁集合不锁次数，
//     本用例补上次数这一维）。
//   - T9：拆批对话框的 `done` → 板级失效 production-queue 三域（失效编排在板级，不在
//     共享对话框内 —— 对话框要同时被外协看板消费）。
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
import { computed, defineComponent, h, nextTick, ref, type Ref } from 'vue';
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
    hasRole: (r: string) => roles.current.includes(r),
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
// moveBatchBetweenWorkers —— WORKER→WORKER，工人列落点消费；moveBatchToWorker ——
// 工序池右键「派给工人」消费）。
// 走 vi.hoisted：vi.mock 工厂被提升到模块顶部求值，直接闭包引用下面模块体里的
// const 会在工厂被提前求值时命中 TDZ（同文件里 realFetchQueueSnapshot 等同理）。
const {
  moveBatchBetweenWorkersMock,
  moveBatchToWorkerMock,
  invalidatePendingMock,
} = vi.hoisted(() => ({
  moveBatchBetweenWorkersMock: vi.fn(async () => true),
  moveBatchToWorkerMock: vi.fn(async () => true),
  invalidatePendingMock: vi.fn(async () => undefined),
}));
vi.mock('@/views/production/queue/composables/useQueueMove', () => ({
  useQueueMove: () => ({
    moveBatchToWorker: moveBatchToWorkerMock,
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
    dispatchMutation: { mutate: dispatchMutateMock, isPending: ref(false) },
  }),
  invalidateQueuePendingAll: invalidatePendingMock,
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

// 2026-10-06：右键召回菜单与召回 composable 的接线 guard。
// 两者都桩掉的理由：
//   - 菜单：换用 `@imengyu/vue3-context-menu` 的**函数模式**后，模板里**没有**任何菜单
//     组件 —— 板级在右键回调里派生 items 并调 `showBatchContextMenu(evt, items)`。本
//     spec 因此把「库」整体 mock 掉，只断言板级**递进去的 items**（菜单本体的固定传参与
//     打开串行化由 src/composables/__tests__/useBatchContextMenu.spec.ts 守）。
//   - useQueueRecall：只需观察 recallBatch 是否被转交、canRecall 是否被读，写请求 /
//     确认弹窗 / 失效链由 useQueueRecall.spec.ts 覆盖。
// 走 vi.hoisted：工厂被提升到模块顶部求值，裸引用模块级 const 会命中 TDZ。
const { menuOpenCalls, recallBatchMock, dispatchMutateMock } = vi.hoisted(() => ({
  menuOpenCalls: [] as unknown[][],
  recallBatchMock: vi.fn(async () => undefined),
  dispatchMutateMock: vi.fn(),
}));
vi.mock('@/composables/useBatchContextMenu', () => ({
  // showBatchContextMenu 是**异步**的（内部要 close → nextTick → show），这里给一个同步
  // 替身：板级对它 fire-and-forget，测试同步可断言 items，不用等 tick。
  showBatchContextMenu: (evt: MouseEvent, items: unknown) => {
    menuOpenCalls.push([evt, items]);
    return Promise.resolve();
  },
}));
vi.mock('@/views/production/queue/composables/useQueueRecall', () => ({
  // 工厂里不碰 vue 的 ref（它被提升到 import 之前会命中 TDZ），canRecall 在**调用**
  // useQueueRecall 时才读下面的模块级 `recallable` —— 那时模块已初始化完。
  useQueueRecall: () => ({
    canRecall: computed(() => recallable.current.value),
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

// 共享拆批对话框的接缝桩：渲染自己的 props、可触发 `done`，让 T7 / T9 能断言「板级把
// source 接给了谁」与「板级在 done 上编排了失效」。对话框自身行为（数量边界 / 422 文案）
// 由它自己的实现覆盖，板级这一段只关心接线。
vi.mock('@/components/BatchSplitDialog.vue', () => ({
  default: defineComponent({
    name: 'BatchSplitDialogStub',
    props: { modelValue: Boolean, source: { type: Object, default: null } },
    emits: ['update:modelValue', 'done'],
    setup: () => () => h('div', { class: 'split-dialog-stub' }),
  }),
}));

import QueueBoard from '../QueueBoard.vue';
import { qk } from '@/composables/queries/keys';

/** 一个 INHOUSE 工序 id（深链 `?tab=` 用它切到「非待下发」tab）。 */
const PROC_INHOUSE = '2000000000001';

/** 召回权限开关（默认 false ⇒ opener 直接早退，与本 spec 的 auth mock 一致）。
 *  真 ref 而不是裸布尔：看板把权限派生进菜单 items 的 computed，裸布尔在 computed 眼里
 *  没有任何依赖 —— 只算一次就锁死快照，「用例改了开关就该立刻反映到 items」恒假。 */
/** 拆批权限开关（默认 true ⇒ 菜单里始终有「拆分批次」候选，剩下的差异才是区域/角色）。
 *  真 ref 而不是裸布尔：看板把权限派生进菜单 items，裸布尔在 computed 眼里没有任何
 *  依赖 —— 只算一次就锁死快照，「用例改了开关就该立刻反映到 items」恒假。 */
const recallable: { current: Ref<boolean> } = { current: ref(false) };

/** 拆批权限（auth mock 的 hasRole 读它）。默认给 MANAGER+CLERK 全权，与 canRecall
 *  同组角色（两个端点各自的 RBAC 声明相同，但板级保留两个独立闸）。 */
const roles: { current: string[] } = { current: ['MANAGER', 'CLERK'] };

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
    recallable.current.value = false;
    roles.current = ['MANAGER', 'CLERK'];
    menuOpenCalls.length = 0;
    recallBatchMock.mockClear();
    dispatchMutateMock.mockClear();
    moveBatchToWorkerMock.mockClear();
    moveBatchBetweenWorkersMock.mockClear();
    invalidatePendingMock.mockClear();
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

  it('T6：provide openBatchContextMenu（带区域参数）+ 空菜单给 warning', async () => {
    // 回归 guard：卡片侧只 inject 这个 opener，漏 provide 就退化为「右键没反应」且
    // 无任何报错（inject 缺省 noop）。第三参是**区域**，由容器给 —— 同一张卡在待下发池 /
    // 工序池 / 工人列上的动作集合不同，而三处卡片字段集一模一样，数据侧无从分辨。
    const { ElMessage } = await import('element-plus');
    activeShelfIdRef.value = '5000000000001';
    const wrapper = mount(QueueBoard, {
      global: { plugins: [[VueQueryPlugin, { queryClient: testQueryClient }]] },
    });
    await flushPromises();
    const provides = (wrapper.vm.$ as unknown as { provides: Record<string, unknown> }).provides;
    const open = provides.openBatchContextMenu as (
      e: MouseEvent,
      b: unknown,
      a: string,
    ) => void;
    expect(typeof open).toBe('function');

    const evt = new MouseEvent('contextmenu');
    const card = { batch_id: '3000000000001', version: 7, quantity: 4 };

    // 无权（既不能召回也不能拆批）：菜单不打开，且给出可读提示而不是静默无反馈
    // （卡片侧已 prevent 掉系统右键菜单，静默早退等于无反馈）
    recallable.current.value = false;
    roles.current = [];
    vi.mocked(ElMessage.warning).mockClear();
    open(evt, card, 'pool');
    expect(menuOpenCalls).toHaveLength(0);
    expect(ElMessage.warning).toHaveBeenCalledWith('当前角色对该批次没有可执行的操作');

    // 有权：坐标与卡片原样送达菜单本体（不再弹提示）
    recallable.current.value = true;
    roles.current = ['MANAGER', 'CLERK'];
    vi.mocked(ElMessage.warning).mockClear();
    open(evt, card, 'pool');
    expect(menuOpenCalls).toHaveLength(1);
    expect(menuOpenCalls[0]![0]).toBe(evt);
    expect(ElMessage.warning).not.toHaveBeenCalled();

    // 外协区域不该走到本页（不可达分支早退，绝不 cast 成一个对不上的菜单矩阵）
    menuOpenCalls.length = 0;
    open(evt, card, 'outsource-candidate');
    expect(menuOpenCalls).toHaveLength(0);
    wrapper.unmount();
  });

  it('T6b：三区菜单矩阵由「区域 × 角色 × 批次状态」逐格派生（纯函数本身的矩阵见 queueBatchMenuItems.spec）', async () => {
    // 本用例只守**接线**：板级把哪个区域、哪张卡、哪些目标集递进派生函数。
    activeShelfIdRef.value = '5000000000001';
    recallable.current.value = true;
    roles.current = ['MANAGER', 'CLERK'];
    const wrapper = mount(QueueBoard, {
      global: { plugins: [[VueQueryPlugin, { queryClient: testQueryClient }]] },
    });
    await flushPromises();
    const provides = (wrapper.vm.$ as unknown as { provides: Record<string, unknown> }).provides;
    const open = provides.openBatchContextMenu as (
      e: MouseEvent,
      b: unknown,
      a: string,
    ) => void;
    const card = {
      batch_id: '3000000000002',
      version: 3,
      quantity: 6,
      shelf_id: '5000000000009',
      batch_no: 'B1002',
      part_name: '连杆',
    };
    const labelsOf = () =>
      (menuOpenCalls[menuOpenCalls.length - 1]![1] as { label: string }[]).map((i) => i.label);

    // 待下发池：没有召回（召回自己没有意义）
    open(new MouseEvent('contextmenu'), card, 'pending');
    expect(labelsOf()).toEqual(['拆分批次']);

    // 工序候选池：召回 + 拆批
    open(new MouseEvent('contextmenu'), card, 'pool');
    expect(labelsOf()).toEqual(['召回到待下发', '拆分批次']);

    // 工人列：召回 + 拆批不给（拆出来的子批次同样在工人手上、没有可执行的下一步）
    open(new MouseEvent('contextmenu'), card, 'worker');
    expect(labelsOf()).toEqual(['召回到待下发']);
    wrapper.unmount();
  });

  it('T7：菜单项 onClick → 复用现成 composable（板级不新增任何 mutation）', async () => {
    // 回归 guard：菜单项的 onClick → 写操作包装是一条直连的闭包链，任一环断掉都表现为
    // 「菜单能打开、点了毫无反应」。四条路径分别落到：
    //   召回 → useQueueRecall / 拆批 → 打开共享对话框 / 派活 → useQueueMove /
    //   转交 → useQueueMove / 下发 → useQueueDispatch。
    activeShelfIdRef.value = '5000000000001';
    recallable.current.value = true;
    roles.current = ['MANAGER', 'CLERK'];
    const wrapper = mount(QueueBoard, {
      global: { plugins: [[VueQueryPlugin, { queryClient: testQueryClient }]] },
    });
    await flushPromises();
    const provides = (wrapper.vm.$ as unknown as { provides: Record<string, unknown> }).provides;
    const open = provides.openBatchContextMenu as (
      e: MouseEvent,
      b: unknown,
      a: string,
    ) => void;

    const card = {
      batch_id: '3000000000002',
      version: 3,
      quantity: 6,
      shelf_id: '5000000000009',
      batch_no: 'B1002',
      part_name: '连杆',
    };
    const itemsOf = () =>
      menuOpenCalls[menuOpenCalls.length - 1]![1] as {
        label: string;
        onClick?: () => void;
        children?: { label: string; onClick?: () => void }[];
      }[];
    const byLabel = (list: ReturnType<typeof itemsOf>, label: string) =>
      list.find((i) => i.label === label);

    // ① 召回 → useQueueRecall.recallBatch（拿到的是**被右键那张卡**）
    open(new MouseEvent('contextmenu'), card, 'pool');
    byLabel(itemsOf(), '召回到待下发')!.onClick!();
    expect(recallBatchMock).toHaveBeenCalledTimes(1);
    expect(recallBatchMock).toHaveBeenCalledWith(card);

    // ② 拆批 → 打开共享对话框（version 守卫生效，source 带齐五个域中立字段）
    byLabel(itemsOf(), '拆分批次')!.onClick!();
    await nextTick();
    const splitDialog = wrapper.findComponent({ name: 'BatchSplitDialogStub' });
    expect(splitDialog.exists()).toBe(true);
    expect(splitDialog.props('source')).toEqual({
      batch_id: '3000000000002',
      version: 3,
      quantity: 6,
      batch_no: 'B1002',
      part_name: '连杆',
    });
    wrapper.unmount();
  });

  it('T7a：工序池右键「派给工人」二级菜单 → moveBatchToWorker 拿到卡片真实货架与目标工人', async () => {
    // 「派给工人」的目标集来自当前 tab 的 board 缓存（与 ProcessBoardTab 那条 useQueueBoard
    // 同 queryKey ⇒ 零新增请求）。这里直接往 testQueryClient 塞一份看板缓存当 tab body 的
    // 数据，断言板级读到的目标集与调用参数。深链 `?tab=` 必须在 mount **之前**写好 ——
    // activeTab 是在 setup 里从 route.query 读的。
    activeShelfIdRef.value = '5000000000001';
    recallable.current.value = true;
    roles.current = ['MANAGER', 'CLERK'];
    routeQuery.value = { tab: PROC_INHOUSE };
    const wrapper = mount(QueueBoard, {
      global: { plugins: [[VueQueryPlugin, { queryClient: testQueryClient }]] },
    });
    testQueryClient.setQueryData(qk.productionQueueBoard(PROC_INHOUSE), {
      workers: [
        { worker_id: 'W-1', name: '张三', held_batches: [] },
        { worker_id: 'W-2', name: '李四', held_batches: [] },
      ],
    });

    const provides = (wrapper.vm.$ as unknown as { provides: Record<string, unknown> }).provides;
    const open = provides.openBatchContextMenu as (
      e: MouseEvent,
      b: unknown,
      a: string,
    ) => void;
    const card = {
      batch_id: '3000000000002',
      version: 3,
      quantity: 6,
      shelf_id: '5000000000009',
      batch_no: 'B1002',
      part_name: '连杆',
    };
    open(new MouseEvent('contextmenu'), card, 'pool');
    const items = menuOpenCalls[menuOpenCalls.length - 1]![1] as {
      label: string;
      children?: { label: string; onClick?: () => void }[];
    }[];
    const assign = items.find((i) => i.label === '派给工人')!;
    expect(assign.children!.map((c) => c.label)).toEqual(['张三', '李四']);

    assign.children![1]!.onClick!();
    expect(moveBatchToWorkerMock).toHaveBeenCalledWith(
      '3000000000002',
      3,
      'W-2',
      '5000000000009',
    );
    wrapper.unmount();
  });

  it('T7c：工人列右键「转交给工人」二级菜单排除自己所在列 → moveBatchBetweenWorkers', async () => {
    // 「自己」从 board 缓存按 batch_id 反查（持有该批次的那一列），不是模板透传 ——
    // 少这一步就会把「转交给自己」也列进菜单，点了必然被后端当无效移动拒。
    activeShelfIdRef.value = '5000000000001';
    recallable.current.value = true;
    roles.current = ['MANAGER', 'CLERK'];
    routeQuery.value = { tab: PROC_INHOUSE };
    const wrapper = mount(QueueBoard, {
      global: { plugins: [[VueQueryPlugin, { queryClient: testQueryClient }]] },
    });
    testQueryClient.setQueryData(qk.productionQueueBoard(PROC_INHOUSE), {
      workers: [
        { worker_id: 'W-1', name: '张三', held_batches: [{ batch_id: '3000000000002' }] },
        { worker_id: 'W-2', name: '李四', held_batches: [] },
      ],
    });

    const provides = (wrapper.vm.$ as unknown as { provides: Record<string, unknown> }).provides;
    const open = provides.openBatchContextMenu as (
      e: MouseEvent,
      b: unknown,
      a: string,
    ) => void;
    const card = { batch_id: '3000000000002', version: 3, quantity: 6, shelf_id: null };
    open(new MouseEvent('contextmenu'), card, 'worker');
    const items = menuOpenCalls[menuOpenCalls.length - 1]![1] as {
      label: string;
      children?: { label: string; onClick?: () => void }[];
    }[];
    const transfer = items.find((i) => i.label === '转交给工人')!;
    expect(transfer.children!.map((c) => c.label)).toEqual(['李四']);

    transfer.children![0]!.onClick!();
    expect(moveBatchBetweenWorkersMock).toHaveBeenCalledWith(
      '3000000000002',
      3,
      'W-1',
      'W-2',
    );
    wrapper.unmount();
  });

  it('T7d：待下发池右键「发送到工序」二级菜单 → dispatchMutation.mutate({batchIds, targetProcessId})', async () => {
    // 目标集是全量工序（含外协工序，与右栏工序卡同源），工序列表 mock 成空 ⇒ 二级菜单
    // 不出现（给一个点开是空白的二级菜单比不给更难解释）。这里断言「空目标集不给该项」。
    activeShelfIdRef.value = '5000000000001';
    roles.current = ['MANAGER', 'CLERK'];
    const wrapper = mount(QueueBoard, {
      global: { plugins: [[VueQueryPlugin, { queryClient: testQueryClient }]] },
    });
    await flushPromises();
    const provides = (wrapper.vm.$ as unknown as { provides: Record<string, unknown> }).provides;
    const open = provides.openBatchContextMenu as (
      e: MouseEvent,
      b: unknown,
      a: string,
    ) => void;
    open(new MouseEvent('contextmenu'), { batch_id: 'X', version: 1, quantity: 3 }, 'pending');
    const items = menuOpenCalls[menuOpenCalls.length - 1]![1] as { label: string }[];
    expect(items.map((i) => i.label)).toEqual(['拆分批次']);
    expect(dispatchMutateMock).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('T9：拆批对话框 done → 板级失效 production-queue 三域（失效编排不在对话框内）', async () => {
    // 回归 guard：拆批对话框是**共享组件**（外协看板也用它），失效编排一旦留在对话框里
    // 就会锁死单域消费方（它 import 了某一方的前缀失效函数）。守法：对话���只发 `done`，
    // 三条前缀失效都由板级编排。
    activeShelfIdRef.value = '5000000000001';
    recallable.current.value = true;
    roles.current = ['MANAGER', 'CLERK'];
    const wrapper = mount(QueueBoard, {
      global: { plugins: [[VueQueryPlugin, { queryClient: testQueryClient }]] },
    });
    await flushPromises();
    const invalidateSpy = vi.spyOn(testQueryClient, 'invalidateQueries');

    wrapper.findComponent({ name: 'BatchSplitDialogStub' }).vm.$emit('done');
    await flushPromises();

    const keys = invalidateSpy.mock.calls.map((c) =>
      JSON.stringify((c[0] as { queryKey?: unknown })?.queryKey),
    );
    // 待下发前缀走本模块自己的失效函数（本 spec 把它 mock 成记账函数）
    expect(invalidatePendingMock).toHaveBeenCalledTimes(1);
    expect(keys).toContain(JSON.stringify(['production-queue', 'board']));
    expect(keys).toContain(JSON.stringify(['production-queue', 'snapshot']));
    invalidateSpy.mockRestore();
    wrapper.unmount();
  });

  it('T7b：召回通路不新增任何首屏请求（锁请求面**与次数**）', async () => {
    // 守住「进页面请求数恒为 3」这条不变式不被写操作 composable 与菜单组件破掉：
    // useQueueRecall 只建 mutation（不建 query），右键菜单本体零请求、「派给工人」的目标集
    // 读的是 tab body 已经填好的同一份缓存。
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
