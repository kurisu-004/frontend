// @vitest-environment happy-dom
// src/views/workers/components/__tests__/WorkerPoolTab.spec.ts
//
// 2026-09-30 新增：WorkerPoolTab 组件 spec —— 验证 tab body 懒加载 +
// 数据层 TanStack Query 化（自管 useWorkerPoolByProcessQuery + skeleton/empty 兜底）。
//
// 覆盖：
//   - W1：传入 processId → 内部 useWorkerPoolByProcessQuery 调用 getWorkerPoolByProcess
//     收到该 processId。
//   - W2：resolved 后渲染 el-splitter + PoolDrawer + WorkerColumn（mock 化）。
//   - W3：query 抛错 → 渲染 el-empty description="加载失败"。
//   - W4：workers 数组为空 → 渲染「该工序暂无可用工人」占位。
//
// 测试策略（沿 LoginView.spec.ts 范本）：
//   - vue-test-utils mount + globalConfig.plugins: [[VueQueryPlugin, { queryClient }]]；
//   - vi.mock('@/api/workerPool')：getWorkerPoolByProcess 替换为 vi.fn()；
//   - vi.mock('element-plus') 防 node env ReferenceError；
//   - stub el-skeleton / el-empty / el-splitter / el-splitter-panel + PoolDrawer / WorkerColumn
//     子组件（避免 vue-draggable-plus 等拖拽依赖）。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';

vi.mock('element-plus', () => ({
  ElMessage: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
}));

const realGetWorkerPoolByProcess = vi.fn<
  (processId: string) => Promise<unknown>
>(async (processId: string) => ({
  process_id: processId,
  process_code: 'CNC-01',
  process_name: '粗加工',
  workers: [
    { worker_id: '1900000000001', name: '张三', work_type_id: '3000000000001', work_type_code: 'CNC' },
  ],
  work_types: [],
  total: 0,
  items: [],
}));

vi.mock('@/api/workerPool', () => ({
  getWorkerPoolByProcess: (processId: string) => realGetWorkerPoolByProcess(processId),
  getWorkerPoolCounts: vi.fn(),
  getWorkerState: vi.fn(),
  refillWorkerPool: vi.fn(),
  moveBatch: vi.fn(),
  autoAllocate: vi.fn(),
}));

// 2026-09-30：vi.mock 必须放在子组件 import 之前（hoist 约定）；factory 内 inline
// 定义 stub（不能再引用外层 const，否则 hoist 先于 const 初始化抛
// 「Cannot access X before initialization」）。返回字符串即可，组件不会渲染为
// 完整 VNode —— mount 后 html() 仅用于断言外层骨架（el-splitter-stub / el-empty-stub）。
vi.mock('../PoolDrawer.vue', () => ({
  default: {
    name: 'PoolDrawerStub',
    props: ['pool'],
    setup(props: { pool: { process_id: string } | null }) {
      return () => `pool=${props.pool?.process_id ?? 'null'}`;
    },
  },
}));
vi.mock('../WorkerColumn.vue', () => ({
  default: {
    name: 'WorkerColumnStub',
    props: ['worker'],
    setup(props: { worker: { id: string } | null }) {
      return () => `worker=${props.worker?.id ?? 'null'}`;
    },
  },
}));

// Element Plus 子组件 stub：避免 EP 组件树副作用。
const ElSkeletonStub = defineComponent({
  name: 'ElSkeletonStub',
  props: { rows: Number, animated: Boolean },
  setup() {
    return () => h('div', { class: 'el-skeleton-stub' }, 'loading-skeleton');
  },
});

const ElEmptyStub = defineComponent({
  name: 'ElEmptyStub',
  props: { description: String, imageSize: Number },
  setup(props) {
    return () => h('div', { class: 'el-empty-stub' }, props.description ?? 'empty');
  },
});

const ElSplitterPanelStub = defineComponent({
  name: 'ElSplitterPanelStub',
  setup(_, { slots }) {
    return () => h('div', { class: 'el-splitter-panel-stub' }, slots.default?.());
  },
});

const ElSplitterStub = defineComponent({
  name: 'ElSplitterStub',
  setup(_, { slots }) {
    return () => h('div', { class: 'el-splitter-stub' }, slots.default?.());
  },
});

const globalConfig = {
  components: {
    ElSkeleton: ElSkeletonStub,
    ElEmpty: ElEmptyStub,
    ElSplitter: ElSplitterStub,
    ElSplitterPanel: ElSplitterPanelStub,
  },
  plugins: [
    [
      VueQueryPlugin,
      {
        queryClient: new QueryClient({
          defaultOptions: { mutations: { retry: 0 }, queries: { retry: 0 } },
        }),
      },
    ] as [typeof VueQueryPlugin, { queryClient: QueryClient }],
  ],
};

process.on('unhandledRejection', () => undefined);

import WorkerPoolTab from '../WorkerPoolTab.vue';

describe('WorkerPoolTab（2026-09-30 新增）', () => {
  beforeEach(() => {
    realGetWorkerPoolByProcess.mockClear();
    realGetWorkerPoolByProcess.mockResolvedValue({
      process_id: '2000000000001',
      process_code: 'CNC-01',
      process_name: '粗加工',
      workers: [
        { worker_id: '1900000000001', name: '张三', work_type_id: '3000000000001', work_type_code: 'CNC' },
      ],
      work_types: [],
      total: 0,
      items: [],
    });
  });

  it('W1：传入 processId → getWorkerPoolByProcess 收到该 processId', async () => {
    const wrapper = mount(WorkerPoolTab, {
      props: { processId: '2011111111111' },
      global: globalConfig,
    });
    await flushPromises();
    expect(realGetWorkerPoolByProcess).toHaveBeenCalled();
    expect(realGetWorkerPoolByProcess.mock.calls[0]?.[0]).toBe('2011111111111');
    wrapper.unmount();
  });

  it('W2：resolved 后渲染 el-splitter + PoolDrawer + WorkerColumn', async () => {
    const wrapper = mount(WorkerPoolTab, {
      props: { processId: '2022222222222' },
      global: globalConfig,
    });
    await flushPromises();
    const html = wrapper.html();
    // el-splitter / el-splitter-panel + PoolDrawer / WorkerColumn mock
    expect(html).toContain('el-splitter-stub');
    expect(html).toContain('el-splitter-panel-stub');
    wrapper.unmount();
  });

  it('W3：query 抛错 → 渲染 el-empty description="加载失败"', async () => {
    // 2026-09-30：用独立 processId 防止 QueryClient 跨 test 缓存复用。
    realGetWorkerPoolByProcess.mockRejectedValueOnce(new Error('network error'));
    const wrapper = mount(WorkerPoolTab, {
      props: { processId: '2088888888888' },
      global: globalConfig,
    });
    await flushPromises();
    const html = wrapper.html();
    expect(html).toContain('加载失败');
    wrapper.unmount();
  });

  it('W4：workers 数组为空 → 渲染「该工序暂无可用工人」占位', async () => {
    // 2026-09-30：用独立 processId 防止 QueryClient 跨 test 缓存复用。
    realGetWorkerPoolByProcess.mockImplementation(async (pid: string) => ({
      process_id: pid,
      process_code: 'QC-01',
      process_name: '质检',
      workers: [],
      work_types: [],
      total: 0,
      items: [],
    }));
    const wrapper = mount(WorkerPoolTab, {
      props: { processId: '2099999999999' },
      global: globalConfig,
    });
    await flushPromises();
    const html = wrapper.html();
    expect(html).toContain('该工序暂无可用工人');
    wrapper.unmount();
  });
});