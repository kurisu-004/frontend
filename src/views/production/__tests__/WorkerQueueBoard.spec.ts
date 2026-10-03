// @vitest-environment happy-dom
// src/views/production/__tests__/WorkerQueueBoard.spec.ts
//
// 2026-09-30 hotfix 第 1 轮：WorkerQueueBoard.vue TDZ regression guard。
//
// 2026-09-30 契约对齐后重写：
//   - `useWorkerPoolCountsQuery` 去 params 形参（后端 `GET /prod/pool/counts`
//     handler 只接 State + CurrentUser，无 Query extractor；`WorkerPoolCountsOut`
//     也没有 shelf_id 维度）⇒ 2026-09-30 hotfix 加的 shelfId TDZ 约束**已退休**，
//     T1 保留作通用 mount 冒烟 guard，T2 改断言「零参调用 + 零 shelf 维度」。
//   - useWorkerQueue 不再有 loadBoard / workerHeld（唯一非 TanStack 数据源已删）。
//   - PendingPoolCard 不再自管 useWorkerPoolByProcessQuery（懒加载 N+1 修复）⇒
//     本页进页面请求数恒为 3：processes + pool/counts + batches/pending。
//
// 覆盖：
//   - T1：mount 时不抛任何 setup 异常（通用冒烟 + TDZ 回归 guard）。
//   - T2：进页面只发 3 类请求，**不发** per-process 详情（N+1 懒加载核心 guard）。
//   - T3：getWorkerPoolCounts 零参调用（后端无 shelf 维度）。
//   - T4：拖入高亮的跨面板接线（源面板 emit → 板级 ref → 工序池面板 prop）。
//   - T5：provide 三个 move 包装（含 2026-10-03 新增的 WORKER→WORKER 包装）——
//     WorkerColumn 落点全靠 inject 拿包装，漏 provide 就退化为「不发请求」。
//
// 测试策略：
//   - vue-test-utils mount + globalConfig.plugins: [[VueQueryPlugin, { queryClient }]]；
//   - vi.mock('@/api/workerPool') + vi.mock('@/stores/auth') + vi.mock('element-plus') +
//     vi.mock('@/views/production/composables/useWorkerQueue') +
//     vi.mock('@/views/production/composables/usePendingDispatch') +
//     vi.mock('@/composables/queries/useProcessesQuery') +
//     vi.mock 子组件 PendingBatchesPanel / PendingPoolsPanel / WorkerPoolTab；
//   - vi.mock('@/api/process') 兜底 useProcessesQuery 内部 import；
//   - vi.mock('vue-router') 让 useRoute / useRouter 不报 undefined error。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref, type Ref } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';

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
    setup(_, { slots }) {
      return () => h('div', { class: 'el-tab-pane-stub' }, slots.default?.());
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

// 2026-09-30：getWorkerPoolCounts 零参 mock（后端端点无 Query extractor）。
const realGetWorkerPoolCounts = vi.fn<
  () => Promise<{
    counts: Array<{
      process_id: string;
      process_code: string;
      process_name: string;
      count: number;
    }>;
    total: number;
  }>
>(async () => ({ counts: [], total: 0 }));

// 2026-09-30 懒加载 guard：per-process 详情**不应**在进页面时被请求。
const realGetWorkerPoolByProcess = vi.fn<(processId: string) => Promise<unknown>>(
  async (processId: string) => ({
    process_id: processId,
    process_code: 'CNC-01',
    process_name: '粗加工',
    workers: [],
    work_types: [],
    total: 0,
    items: [],
  }),
);

const realGetWorkerState = vi.fn<() => Promise<unknown>>(async () => ({}));
const realFetchPendingBatches = vi.fn<
  () => Promise<{ items: unknown[]; total: number; limit: number; offset: number }>
>(async () => ({ items: [], total: 0, limit: 200, offset: 0 }));

vi.mock('@/api/workerPool', () => ({
  getWorkerPoolCounts: () => realGetWorkerPoolCounts(),
  getWorkerPoolByProcess: (processId: string) => realGetWorkerPoolByProcess(processId),
  getWorkerState: () => realGetWorkerState(),
  refillWorkerPool: vi.fn(),
  moveBatch: vi.fn(),
  autoAllocate: vi.fn(),
}));

// 2026-09-30 懒加载 guard：进页面只应发这一条（待下发列表）。
vi.mock('@/api/pendingBatches', () => ({
  fetchPendingBatches: () => realFetchPendingBatches(),
  dispatchBatches: vi.fn(),
  previewAutoDispatch: vi.fn(),
}));

// 2026-09-30 hotfix 第 1 轮 T2：auth.activeShelfId 用响应式 ref 暴露，测试可改值。
const activeShelfIdRef: Ref<string | undefined> = ref<string | undefined>();
vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({
    activeShelfId: activeShelfIdRef,
    // 其它 stub 字段，WorkerQueueBoard 不消费但 mock 形态保完整。
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

// 2026-09-30：loadBoard / workerHeld / loading 已随 TanStack 硬约束清理删除 ——
// 本 mock 只保留 WorkerQueueBoard 实际消费的面（error + 三个 move 包装）。
// 2026-10-03：补 moveBatchBetweenWorkers（WORKER→WORKER，WorkerColumn 落点消费）。
// 走 vi.hoisted：vi.mock 工厂被提升到模块顶部求值，直接闭包引用下面模块体里的
// const 会在工厂被提前求值时命中 TDZ（同文件里 realGetWorkerPoolCounts 等同理）。
const { moveBatchBetweenWorkersMock } = vi.hoisted(() => ({
  moveBatchBetweenWorkersMock: vi.fn(async () => true),
}));
vi.mock('@/views/production/composables/useWorkerQueue', () => ({
  useWorkerQueue: () => ({
    moveBatchToWorker: vi.fn(),
    moveBatchToPool: vi.fn(),
    moveBatchBetweenWorkers: moveBatchBetweenWorkersMock,
    error: ref<string | null>(null),
  }),
}));

vi.mock('@/views/production/composables/usePendingDispatch', () => ({
  usePendingDispatch: () => ({
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
// 2026-10-02：PendingBatchesPanel / PendingPoolsPanel 两个 stub 补上「拖入高亮」
// 链路的接缝（前者可 emit hoverProcess、后者回显 hoveredProcessId），让 T4 能在
// 组件级守住 WorkerQueueBoard 这一段的接线；两侧组件内部逻辑分别由
// PendingBatchesPanel.spec.ts / PendingPoolsPanel.spec.ts 覆盖。
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
vi.mock('../components/WorkerPoolTab.vue', () => ({
  default: defineComponent({
    name: 'WorkerPoolTabStub',
    props: { processId: String },
    setup() {
      return () => h('div', { class: 'worker-pool-tab-stub' });
    },
  }),
}));

// vue-router stub —— 提供 query / replace 方法。
const routeQuery: Ref<Record<string, unknown>> = ref({});
vi.mock('vue-router', () => ({
  useRoute: () => ({ query: routeQuery.value }),
  useRouter: () => ({ replace: vi.fn().mockResolvedValue(undefined) }),
}));

import WorkerQueueBoard from '../WorkerQueueBoard.vue';

// 公共环境未处理 rejection（vue-query 异步 + 子组件 mount）。
process.on('unhandledRejection', () => undefined);

let testQueryClient: QueryClient;

describe('WorkerQueueBoard（2026-09-30 契约对齐 + 懒加载 N+1 修复）', () => {
  beforeEach(() => {
    realGetWorkerPoolCounts.mockClear();
    realGetWorkerPoolCounts.mockResolvedValue({ counts: [], total: 0 });
    realGetWorkerPoolByProcess.mockClear();
    realGetWorkerState.mockClear();
    realFetchPendingBatches.mockClear();
    realFetchPendingBatches.mockResolvedValue({ items: [], total: 0, limit: 200, offset: 0 });
    activeShelfIdRef.value = undefined;
    testQueryClient = new QueryClient({
      defaultOptions: { mutations: { retry: 0 }, queries: { retry: 0 } },
    });
  });

  it('T1：mount 时 setup 阶段不抛异常（含历史 shelfId TDZ 回归 guard）', async () => {
    // 历史背景：2026-09-30 hotfix 第 1 轮 —— useWorkerPoolCountsQuery 的 params getter
    // `() => ({ shelf_id: shelfId.value })` 在 setup 时被 toValue 触发，而 shelfId 声明
    // 在其之后 ⇒ ReferenceError。counts 端点去 shelf 维度后该约束已退休，但本用例
    // 保留作通用 mount 冒烟 guard。
    activeShelfIdRef.value = '5000000000001';
    let mountError: unknown = null;
    try {
      const wrapper = mount(WorkerQueueBoard, {
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
    // v-for 全部 INHOUSE 工序，每张 PendingPoolCard 自管 useWorkerPoolByProcessQuery
    // 算 items.length 徽标 ⇒ 进页面即打 N 个 `GET /prod/pool/{pid}`。徽标现改走
    // useWorkerPoolCountsQuery（聚合计数，单请求）⇒ per-process 详情只有切到对应
    // tab（el-tab-pane :lazy）才拉。
    activeShelfIdRef.value = '5000000000001';
    const wrapper = mount(WorkerQueueBoard, {
      global: {
        plugins: [[VueQueryPlugin, { queryClient: testQueryClient }]],
      },
    });
    await flushPromises();
    await testQueryClient.refetchQueries();
    await flushPromises();

    expect(realGetWorkerPoolByProcess).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('T2b：进页面只发 counts 一条请求（无 per-process、无 worker state、无 pending）', async () => {
    // 进页面的 3 个 query 各自的请求面：
    //   - useProcessesQuery  → 本 spec mock 成同步 data ⇒ 0 请求
    //   - useWorkerPoolCountsQuery → 1 请求（聚合，单货架无关）
    //   - usePendingBatchesQuery  → 被 usePendingDispatch 一并 mock 掉 ⇒ 0 请求
    //     （该 composable 自身的请求面由 usePendingDispatch.spec.ts 覆盖）
    // 另有两条「tab 激活后才发」的查询在进页面时必为 0 次：
    //   - useWorkerPoolByProcessQuery（WorkerPoolTab 内，:lazy）
    //   - useWorkerStateByWorkerQuery（WorkerColumn 内，WorkerPoolTab 的右栏）
    activeShelfIdRef.value = '5000000000001';
    const wrapper = mount(WorkerQueueBoard, {
      global: {
        plugins: [[VueQueryPlugin, { queryClient: testQueryClient }]],
      },
    });
    await flushPromises();
    await testQueryClient.refetchQueries();
    await flushPromises();

    expect(realGetWorkerPoolCounts).toHaveBeenCalled();
    expect(realGetWorkerPoolByProcess).not.toHaveBeenCalled();
    expect(realGetWorkerState).not.toHaveBeenCalled();
    expect(realFetchPendingBatches).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('T3：getWorkerPoolCounts 零参调用（后端端点无 Query extractor / 无 shelf 维度）', async () => {
    activeShelfIdRef.value = '5000000000001';
    const wrapper = mount(WorkerQueueBoard, {
      global: {
        plugins: [[VueQueryPlugin, { queryClient: testQueryClient }]],
      },
    });
    await flushPromises();
    await testQueryClient.refetchQueries();

    expect(realGetWorkerPoolCounts).toHaveBeenCalled();
    // 一个参数都不能有
    expect(realGetWorkerPoolCounts.mock.calls[0]).toHaveLength(0);
    wrapper.unmount();
  });

  it('T5：provide 三个 move 包装（含 WORKER→WORKER 包装）', async () => {
    // 回归 guard：WorkerColumn 的 onDragAdd 只 inject、不 import，漏 provide 时 inject
    // 拿到 noop 兜底 ⇒「工人之间转交」表现为拖了没反应，且控制台一条报错都没有。
    activeShelfIdRef.value = '5000000000001';
    const wrapper = mount(WorkerQueueBoard, {
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
    const wrapper = mount(WorkerQueueBoard, {
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
});
