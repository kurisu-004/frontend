// @vitest-environment happy-dom
// src/views/workers/components/__tests__/PendingPoolCard.spec.ts
//
// 2026-09-30 新增：PendingPoolCard 组件 spec —— 验证自管
// useWorkerPoolByProcessQuery + 单击下发 / 拖拽交互（从原 PendingPoolsPanel 拆出）。
//
// 覆盖：
//   - P1：传入 process → 内部 useWorkerPoolByProcessQuery 调用 getWorkerPoolByProcess
//     收到该 process.id。
//   - P2：标题 + badge 渲染（process.code + process.name + items.length badge）。
//   - P3：selectedIds 空 → 单击触发 ElMessage.warning，不调 bulkDispatchMutation。
//   - P4：selectedIds 非空 → 单击触发 bulkDispatchMutation.mutate({ batchIds, targetProcessId })。
//
// 测试策略（沿 LoginView.spec.ts 范本）：
//   - vue-test-utils mount + globalConfig.plugins: [[VueQueryPlugin, { queryClient }]]；
//   - vi.mock('@/api/workerPool') + vi.mock('element-plus')。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref, type PropType } from 'vue';
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
  workers: [],
  work_types: [],
  total: 5,
  items: [
    { batch_id: '3000000000001', part_id: '4000000000001', batch_no: 1, quantity: 5, serial_no: null, name: 'x', drawing_no: 'DWG', system_delivery_date: null, customer_name: null, parent_customer_name: null, customer_path: null, applicant_name: null, location: 'PRODUCTION_SHELF', shelf_id: '5000000000001', shelf_code: 'A-01', shelf_name: 'A 区', is_urgent: false, note: null, current_process_step_id: null, has_cnc_program: false, version: 1 },
    { batch_id: '3000000000002', part_id: '4000000000002', batch_no: 1, quantity: 3, serial_no: null, name: 'y', drawing_no: 'DWG', system_delivery_date: null, customer_name: null, parent_customer_name: null, customer_path: null, applicant_name: null, location: 'PRODUCTION_SHELF', shelf_id: '5000000000001', shelf_code: 'A-01', shelf_name: 'A 区', is_urgent: false, note: null, current_process_step_id: null, has_cnc_program: false, version: 1 },
  ],
}));

vi.mock('@/api/workerPool', () => ({
  getWorkerPoolByProcess: (processId: string) => realGetWorkerPoolByProcess(processId),
  getWorkerPoolCounts: vi.fn(),
  getWorkerState: vi.fn(),
  refillWorkerPool: vi.fn(),
  assignWorkerPool: vi.fn(),
  removeFromWorkerPool: vi.fn(),
  autoAllocate: vi.fn(),
}));

import PendingPoolCard from '../PendingPoolCard.vue';

// Element Plus 子组件 stub。
const ElTagStub = defineComponent({
  name: 'ElTagStub',
  props: { type: String, size: String },
  setup(_, { slots }) {
    return () => h('span', { class: 'el-tag-stub' }, slots.default?.());
  },
});

const globalConfig = {
  components: {
    ElTag: ElTagStub,
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

describe('PendingPoolCard（2026-09-30 新增）', () => {
  beforeEach(() => {
    realGetWorkerPoolByProcess.mockClear();
    realGetWorkerPoolByProcess.mockResolvedValue({
      process_id: '2000000000001',
      process_code: 'CNC-01',
      process_name: '粗加工',
      workers: [],
      work_types: [],
      total: 5,
      items: [
        { batch_id: '3000000000001', part_id: '4000000000001', batch_no: 1, quantity: 5, serial_no: null, name: 'x', drawing_no: 'DWG', system_delivery_date: null, customer_name: null, parent_customer_name: null, customer_path: null, applicant_name: null, location: 'PRODUCTION_SHELF', shelf_id: '5000000000001', shelf_code: 'A-01', shelf_name: 'A 区', is_urgent: false, note: null, current_process_step_id: null, has_cnc_program: false, version: 1 },
        { batch_id: '3000000000002', part_id: '4000000000002', batch_no: 1, quantity: 3, serial_no: null, name: 'y', drawing_no: 'DWG', system_delivery_date: null, customer_name: null, parent_customer_name: null, customer_path: null, applicant_name: null, location: 'PRODUCTION_SHELF', shelf_id: '5000000000001', shelf_code: 'A-01', shelf_name: 'A 区', is_urgent: false, note: null, current_process_step_id: null, has_cnc_program: false, version: 1 },
      ],
    });
  });

  it('P1：传入 process → getWorkerPoolByProcess 收到该 process.id', async () => {
    const selectedIds = ref(new Set<string>());
    const bulkDispatchMutation = {
      mutate: vi.fn(),
      mutateAsync: vi.fn(async () => undefined),
    } as unknown as PropType<unknown> as never;
    const wrapper = mount(PendingPoolCard, {
      props: {
        process: { id: '2000000000001', code: 'CNC-01', name: '粗加工' },
        selectedIds,
        bulkDispatchMutation,
      },
      global: globalConfig,
    });
    await flushPromises();
    expect(realGetWorkerPoolByProcess).toHaveBeenCalled();
    expect(realGetWorkerPoolByProcess.mock.calls[0]?.[0]).toBe('2000000000001');
    wrapper.unmount();
  });

  it('P2：标题 + badge 渲染（process.code + process.name + items.length badge）', async () => {
    const selectedIds = ref(new Set<string>());
    const bulkDispatchMutation = {
      mutate: vi.fn(),
      mutateAsync: vi.fn(async () => undefined),
    } as unknown as PropType<unknown> as never;
    const wrapper = mount(PendingPoolCard, {
      props: {
        process: { id: '2000000000001', code: 'CNC-01', name: '粗加工' },
        selectedIds,
        bulkDispatchMutation,
      },
      global: globalConfig,
    });
    await flushPromises();
    const html = wrapper.html();
    expect(html).toContain('CNC-01');
    expect(html).toContain('粗加工');
    // items.length = 2 → badge 显示 2
    expect(html).toContain('>2<');
    wrapper.unmount();
  });

  it('P3：selectedIds 空 → 单击触发 ElMessage.warning，不调 bulkDispatchMutation', async () => {
    const selectedIds = ref(new Set<string>());
    const bulkDispatchMutation = {
      mutate: vi.fn(),
      mutateAsync: vi.fn(async () => undefined),
    } as unknown as PropType<unknown> as never;
    const wrapper = mount(PendingPoolCard, {
      props: {
        process: { id: '2000000000001', code: 'CNC-01', name: '粗加工' },
        selectedIds,
        bulkDispatchMutation,
      },
      global: globalConfig,
    });
    await flushPromises();
    const { ElMessage } = await import('element-plus');
    await wrapper.find('.pool-card').trigger('click');
    expect(ElMessage.warning).toHaveBeenCalledWith('请先选择待下发批次');
    expect((bulkDispatchMutation as unknown as { mutate: ReturnType<typeof vi.fn> }).mutate).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('P4：selectedIds 非空 → 单击触发 bulkDispatchMutation.mutate({ batchIds, targetProcessId })', async () => {
    const selectedIds = ref(new Set(['3000000000001', '3000000000002']));
    const bulkDispatchMutation = {
      mutate: vi.fn(),
      mutateAsync: vi.fn(async () => undefined),
    } as unknown as PropType<unknown> as never;
    const wrapper = mount(PendingPoolCard, {
      props: {
        process: { id: '2000000000001', code: 'CNC-01', name: '粗加工' },
        selectedIds,
        bulkDispatchMutation,
      },
      global: globalConfig,
    });
    await flushPromises();
    await wrapper.find('.pool-card').trigger('click');
    expect((bulkDispatchMutation as unknown as { mutate: ReturnType<typeof vi.fn> }).mutate).toHaveBeenCalledWith({
      batchIds: ['3000000000001', '3000000000002'],
      targetProcessId: '2000000000001',
    });
    wrapper.unmount();
  });
});