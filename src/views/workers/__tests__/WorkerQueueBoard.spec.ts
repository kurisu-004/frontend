// @vitest-environment happy-dom
// src/views/workers/__tests__/WorkerQueueBoard.spec.ts
//
// 2026-09-30 hotfix 第 1 轮：WorkerQueueBoard.vue TDZ regression guard。
//
// 背景（hotfix 详见 src/views/workers/WorkerQueueBoard.vue 头部注释）：
//   - 原 line 192 才声明 shelfId = computed(auth.activeShelfId ?? '')
//   - 但 line 165 useWorkerPoolCountsQuery(() => ({ shelf_id: shelfId.value })) 已用 shelfId.value
//   - setup 阶段 useWorkerPoolCountsQuery 内部 toValue(getter) 触发 getter 执行
//     → shelfId 还在 TDZ → ReferenceError: Cannot access 'shelfId' before initialization
//   - 修复：shelfId 上移到 auth 声明之后紧邻位置（line 145），保证所有后续引用
//     都在声明之后。
//
// 覆盖：
//   - T1：mount 时不抛 ReferenceError（TDZ regression 核心 guard）。
//   - T2：auth.activeShelfId 改值后 useWorkerPoolCountsQuery 入参自动同步更新
//     （沿 useProcessesQuery T2 reactive params 范本）。
//
// 测试策略：
//   - vue-test-utils mount + globalConfig.plugins: [[VueQueryPlugin, { queryClient }]]；
//   - vi.mock('@/api/workerPool') + vi.mock('@/stores/auth') + vi.mock('element-plus') +
//     vi.mock('@/views/workers/composables/useWorkerQueue') +
//     vi.mock('@/views/workers/composables/usePendingDispatch') +
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

// getWorkerPoolCounts mock —— 验证 reactive params 同步更新。
const realGetWorkerPoolCounts = vi.fn<
  (params: { shelf_id?: string | null }) => Promise<{
    shelf_id: string | null;
    counts: Array<{
      process_id: string;
      process_code: string;
      process_name: string;
      count: number;
    }>;
    total: number;
  }>
>(async () => ({
  shelf_id: null,
  counts: [],
  total: 0,
}));

vi.mock('@/api/workerPool', () => ({
  getWorkerPoolCounts: (params: { shelf_id?: string | null }) =>
    realGetWorkerPoolCounts(params),
  // 2026-09-30：vi.mock hoist 要求完整 module shape —— 列出 stub 防止 partial mock 副作用
  // （与 useWorkerPoolCountsQuery.spec.ts 范本一致）。
  getWorkerPoolByProcess: vi.fn(),
  getWorkerState: vi.fn(),
  refillWorkerPool: vi.fn(),
  assignWorkerPool: vi.fn(),
  removeFromWorkerPool: vi.fn(),
  autoAllocate: vi.fn(),
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

vi.mock('@/views/workers/composables/useWorkerQueue', () => ({
  useWorkerQueue: () => ({
    loadBoard: vi.fn().mockResolvedValue(undefined),
    moveBatchToWorker: vi.fn(),
    moveBatchToPool: vi.fn(),
    loading: ref(false),
    error: ref<string | null>(null),
    workerHeld: ref({}),
    // 2026-09-30：useWorkerQueue 实际还有其它字段，但 WorkerQueueBoard 只消费这些。
  }),
}));

vi.mock('@/views/workers/composables/usePendingDispatch', () => ({
  usePendingDispatch: () => ({
    batches: ref([]),
    total: ref(50),
    isLoading: ref(false),
    selectedIds: ref<Set<string>>(new Set()),
    selectedCount: ref(0),
    setSelectedIds: vi.fn(),
    autoDispatchMutation: { mutate: vi.fn(), isPending: ref(false) },
    bulkDispatchMutation: { mutate: vi.fn(), isPending: ref(false) },
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
vi.mock('../components/PendingBatchesPanel.vue', () => ({
  default: defineComponent({
    name: 'PendingBatchesPanelStub',
    setup() {
      return () => h('div', { class: 'pending-batches-stub' });
    },
  }),
}));
vi.mock('../components/PendingPoolsPanel.vue', () => ({
  default: defineComponent({
    name: 'PendingPoolsPanelStub',
    setup() {
      return () => h('div', { class: 'pending-pools-stub' });
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

function lastParams(): Record<string, unknown> {
  const calls = realGetWorkerPoolCounts.mock.calls;
  const last = calls[calls.length - 1];
  return (last?.[0] ?? {}) as unknown as Record<string, unknown>;
}

let testQueryClient: QueryClient;

describe('WorkerQueueBoard（2026-09-30 hotfix 第 1 轮 — TDZ regression guard）', () => {
  beforeEach(() => {
    realGetWorkerPoolCounts.mockClear();
    realGetWorkerPoolCounts.mockResolvedValue({
      shelf_id: null,
      counts: [],
      total: 0,
    });
    activeShelfIdRef.value = undefined;
    testQueryClient = new QueryClient({
      defaultOptions: { mutations: { retry: 0 }, queries: { retry: 0 } },
    });
  });

  it('T1：mount 时 setup 阶段不抛 ReferenceError（shelfId TDZ regression 核心 guard）', async () => {
    // 背景：原代码 shelfId 在 line 192 声明，但 line 165 的 useWorkerPoolCountsQuery
    // getter `() => ({ shelf_id: shelfId.value })` 在 setup 时被 useQuery 内部 computed
    // 触发 toValue → 立即读 shelfId.value → shelfId 还在 TDZ → ReferenceError。
    // 修复后 shelfId 上移到 line 145（auth 声明之后），line 165 触发时 shelfId 已声明。
    activeShelfIdRef.value = '5000000000001';
    let mountError: unknown = null;
    try {
      const wrapper = mount(WorkerQueueBoard, {
        global: {
          plugins: [
            [VueQueryPlugin, { queryClient: testQueryClient }],
          ],
        },
      });
      await flushPromises();
      wrapper.unmount();
    } catch (e) {
      mountError = e;
    }
    // 核心断言：setup 阶段不抛 ReferenceError。
    if (mountError) {
      // 让失败信息可读 —— ReferenceError 会显示具体变量名 'shelfId'
      expect(String(mountError)).not.toMatch(/Cannot access 'shelfId' before initialization/);
    }
    expect(mountError).toBeNull();
  });

  it('T2：auth.activeShelfId 改值 → useWorkerPoolCountsQuery 入参 shelf_id 同步更新', async () => {
    // 沿 useProcessesQuery T2 / useWorkerPoolCountsQuery T2 范本：reactive params 变化
    // 应触发 queryFn 用新值调 getWorkerPoolCounts。
    activeShelfIdRef.value = '5000000000001';
    const wrapper = mount(WorkerQueueBoard, {
      global: {
        plugins: [
          [VueQueryPlugin, { queryClient: testQueryClient }],
        ],
      },
    });
    await flushPromises();

    // 首次 refetch —— getWorkerPoolCounts 收到 shelf_id: '5000000000001'
    await testQueryClient.refetchQueries();
    expect(realGetWorkerPoolCounts).toHaveBeenCalled();
    expect(lastParams().shelf_id).toBe('5000000000001');

    // 改 activeShelfId → 触发 queryKey computed → queryFn 用新值
    activeShelfIdRef.value = '5000000000002';
    // 重新拿一份 lastParams（mock.calls 累加）
    const callsBefore = realGetWorkerPoolCounts.mock.calls.length;
    await testQueryClient.refetchQueries();
    await flushPromises();

    expect(realGetWorkerPoolCounts.mock.calls.length).toBeGreaterThan(callsBefore);
    expect(lastParams().shelf_id).toBe('5000000000002');

    wrapper.unmount();
  });
});
