// @vitest-environment happy-dom
// src/views/production/queue/components/__tests__/ProcessBoardTab.spec.ts
//
// 单工序 tab body 组件的 spec：tab 懒加载 + skeleton / empty 兜底。
//
// 2026-10-08 重构：数据源从 `GET /prod/pool/{process_id}` 换成
// `GET /prod/queue/processes/{process_id}`（`useQueueBoard`），出参形态从
// `{process_id, process_code, process_name, workers[brief], work_types[], items[]}`
// 换成 `{process{...}, workers[含 held_batches + 容量三字段], items[], total, ts}`。
// **请求数**也从「1 + N」（1 个工序详情 + N 个单工人 state）降为恒 1 ——
// 本 spec 的 P5 正是这条不变式的回归 guard。
//
// 覆盖：
//   - P1：传入 processId → 内部 fetchQueueBoard 收到该 processId。
//   - P2：resolved 后渲染 el-splitter + PoolDrawer + WorkerColumn（mock 化）。
//   - P3：query 抛错 → 渲染 el-empty description="加载失败"。
//   - P4：workers 数组为空 → 渲染「该工序暂无可用工人」占位。
//   - P5（2026-10-08 新增）：打开一个工序 tab **只发 1 个**请求 —— 工人列不再自管
//     单工人 state 请求（N+1 收口）。
//   - P6（2026-10-08 新增）：workers[] 的容量三字段与 held_batches 原样透传给
//     WorkerColumn（不再有 `max_held: 0 / is_online: true` 这类占位值）。
//
// 测试策略（沿 LoginView.spec.ts 范本）：
//   - vue-test-utils mount + globalConfig.plugins: [[VueQueryPlugin, { queryClient }]]；
//   - vi.mock('@/api/productionQueue')：fetchQueueBoard 替换为 vi.fn()；
//   - vi.mock('element-plus') 防 node env ReferenceError；
//   - stub el-skeleton / el-empty / el-splitter / el-splitter-panel + PoolDrawer /
//     WorkerColumn 子组件（避免 vue-draggable-plus 等拖拽依赖）。

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

/** 工序看板出参（QueueBoard）：工人内联 held_batches 与容量三字段。 */
const realFetchQueueBoard = vi.fn<(processId: string) => Promise<unknown>>(async (processId) => ({
  process: {
    process_id: processId,
    process_code: 'CNC-01',
    process_name: '粗加工',
    color: '#409EFF88',
  },
  workers: [makeWorker()],
  items: [],
  total: 0,
  ts: '2026-10-08T09:12:33+08:00',
}));

vi.mock('@/api/productionQueue', () => ({
  fetchQueueBoard: (processId: string) => realFetchQueueBoard(processId),
  fetchQueueSnapshot: vi.fn(),
  fetchPendingBatches: vi.fn(),
  dispatchBatches: vi.fn(),
  previewAutoDispatch: vi.fn(),
  recallToPending: vi.fn(),
  moveBatch: vi.fn(),
  autoAllocate: vi.fn(),
  refillQueue: vi.fn(),
}));

/** 单个工人（后端 QueueWorker 原样）。 */
function makeWorker(workerId = '1900000000001') {
  return {
    worker_id: workerId,
    name: '张三',
    work_type_code: 'CNC',
    badge_code: 'G001',
    max_held: 3,
    current_held: 1,
    capacity_remaining: 2,
    held_batches: [
      {
        batch_id: '3000000000001',
        part_id: '4000000000001',
        batch_no: 1,
        quantity: 1,
        serial_no: null,
        drawing_no: 'DRW-1',
        name: '连杆',
        system_delivery_date: '2026-10-20',
        planned_delivery_date: '2026-10-25',
        is_urgent: false,
        has_cnc_program: false,
        customer_name: null,
        parent_customer_name: null,
        applicant_name: null,
        location: 'WORKER',
        note: null,
        version: 3,
      },
    ],
  };
}

// vi.mock 必须放在子组件 import 之前（hoist 约定）；factory 内 inline
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
    setup(props: {
      worker: { worker_id: string; max_held: number; held_batches: unknown[] } | null;
    }) {
      return () =>
        `worker=${props.worker?.worker_id ?? 'null'};max=${props.worker?.max_held ?? '-'};held=${
          props.worker?.held_batches.length ?? 0
        }`;
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

import ProcessBoardTab from '../ProcessBoardTab.vue';

describe('ProcessBoardTab（单工序看板 tab body）', () => {
  beforeEach(() => {
    realFetchQueueBoard.mockClear();
    realFetchQueueBoard.mockImplementation(async (pid: string) => ({
      process: { process_id: pid, process_code: 'CNC-01', process_name: '粗加工', color: null },
      workers: [makeWorker()],
      items: [],
      total: 0,
      ts: '2026-10-08T09:12:33+08:00',
    }));
  });

  it('P1：传入 processId → fetchQueueBoard 收到该 processId', async () => {
    const wrapper = mount(ProcessBoardTab, {
      props: { processId: '2011111111111' },
      global: globalConfig,
    });
    await flushPromises();
    expect(realFetchQueueBoard).toHaveBeenCalled();
    expect(realFetchQueueBoard.mock.calls[0]?.[0]).toBe('2011111111111');
    wrapper.unmount();
  });

  it('P2：resolved 后渲染 el-splitter + PoolDrawer + WorkerColumn', async () => {
    const wrapper = mount(ProcessBoardTab, {
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

  it('P3：query 抛错 → 渲染 el-empty description="加载失败"', async () => {
    // 用独立 processId 防止 QueryClient 跨 test 缓存复用。
    realFetchQueueBoard.mockRejectedValueOnce(new Error('network error'));
    const wrapper = mount(ProcessBoardTab, {
      props: { processId: '2088888888888' },
      global: globalConfig,
    });
    await flushPromises();
    const html = wrapper.html();
    expect(html).toContain('加载失败');
    wrapper.unmount();
  });

  it('P4：workers 数组为空 → 渲染「该工序暂无可用工人」占位', async () => {
    realFetchQueueBoard.mockImplementation(async (pid: string) => ({
      process: { process_id: pid, process_code: 'QC-01', process_name: '质检', color: null },
      workers: [],
      items: [],
      total: 0,
      ts: '2026-10-08T09:12:33+08:00',
    }));
    const wrapper = mount(ProcessBoardTab, {
      props: { processId: '2099999999999' },
      global: globalConfig,
    });
    await flushPromises();
    const html = wrapper.html();
    expect(html).toContain('该工序暂无可用工人');
    wrapper.unmount();
  });

  it('P5：打开一个工序 tab 只发 1 个请求（工人列零请求，N+1 收口）', async () => {
    // 回归 guard：改前 WorkerColumn 自管「单工人 state」请求，打开一个工序 tab 会打出
    // 1 + N 个请求（N = 该工序可执行工人数）。后端把容量与持有批次内联进 workers[] 之后
    // 请求数必须恒为 1 —— 有人给工人列加回自管 query 时本用例会红。
    realFetchQueueBoard.mockImplementation(async (pid: string) => ({
      process: { process_id: pid, process_code: 'CNC-01', process_name: '粗加工', color: null },
      workers: [makeWorker('1900000000001'), makeWorker('1900000000002')],
      items: [],
      total: 0,
      ts: '2026-10-08T09:12:33+08:00',
    }));
    const wrapper = mount(ProcessBoardTab, {
      props: { processId: '2077777777777' },
      global: globalConfig,
    });
    await flushPromises();
    expect(realFetchQueueBoard).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it('P6：容量三字段与 held_batches 原样透传给工人列（无占位值）', async () => {
    const wrapper = mount(ProcessBoardTab, {
      props: { processId: '2066666666666' },
      global: globalConfig,
    });
    await flushPromises();
    const html = wrapper.html();
    // 旧实现会把容量填 0 / is_online 填 true 占位，列头一度显示 0/0；现在后端给什么
    // 就传什么。
    expect(html).toContain('worker=1900000000001;max=3;held=1');
    wrapper.unmount();
  });
});