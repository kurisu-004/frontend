// @vitest-environment happy-dom
// src/views/workers/components/__tests__/PendingPoolCard.spec.ts
//
// 2026-09-30 新增：PendingPoolCard 组件 spec —— 单击下发 / 拖拽交互。
// 2026-09-30 重写（懒加载 + 后端 dispatch bulk-only 收敛）：
//   - 组件**不再自管 useWorkerPoolByProcessQuery**，徽标改由 `count` prop 透传
//     （来自 useWorkerPoolCountsQuery 的聚合计数）⇒ P1 反转为「不发请求」guard；
//   - `bulkDispatchMutation` 更名 `dispatchMutation`（后端 dispatch 已 bulk-only，
//     `POST /batches/bulk-dispatch` 端点删除，两 mutation 合并为一个）。
//
// 覆盖：
//   - P1：**零网络请求** —— mount 不调 getWorkerPoolByProcess（懒加载核心 guard：
//     本卡在默认首屏 tab 内 v-for 全部工序，改前是 N+1 请求源头）；
//   - P2：标题 + badge 渲染（process.code + process.name + count prop）；
//   - P3：selectedIds 空 → 单击触发 ElMessage.warning，不调 dispatchMutation；
//   - P4：selectedIds 非空 → 单击触发 dispatchMutation.mutate({ batchIds, targetProcessId })；
//   - P5：拖拽 drop → 同样触发 dispatchMutation.mutate（单 batch）。
//
// 测试策略（沿 LoginView.spec.ts 范本）：
//   - vue-test-utils mount + globalConfig.plugins: [[VueQueryPlugin, { queryClient }]]；
//   - vi.mock('@/api/workerPool') + vi.mock('element-plus')。

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
}));

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

vi.mock('@/api/workerPool', () => ({
  getWorkerPoolByProcess: (processId: string) => realGetWorkerPoolByProcess(processId),
  getWorkerPoolCounts: vi.fn(),
  getWorkerState: vi.fn(),
  refillWorkerPool: vi.fn(),
  moveBatch: vi.fn(),
  autoAllocate: vi.fn(),
}));

import PendingPoolCard from '../PendingPoolCard.vue';
import type { UsePendingDispatchReturn } from '@/views/workers/composables/usePendingDispatch';

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

/** 极简 mutation stub —— 只需 mutate 被断言；返回类型与真实 UseMutationReturn 的
 *  差异由 cast 吸收（与仓库既有 spec 范本一致）。 */
function makeMutationStub(
  mutate: ReturnType<typeof vi.fn>,
): UsePendingDispatchReturn['dispatchMutation'] {
  return { mutate, mutateAsync: vi.fn(async () => undefined) } as unknown as
    UsePendingDispatchReturn['dispatchMutation'];
}

function mountCard(
  selectedIds: Ref<Set<string>>,
  count: number | string = 7,
  mutate = vi.fn(),
) {
  return mount(PendingPoolCard, {
    props: {
      process: { id: '2000000000001', code: 'CNC-01', name: '粗加工' },
      count,
      selectedIds,
      dispatchMutation: makeMutationStub(mutate),
    },
    global: globalConfig,
  });
}

describe('PendingPoolCard（2026-09-30 懒加载 + bulk-only 收敛）', () => {
  beforeEach(() => {
    realGetWorkerPoolByProcess.mockClear();
  });

  it('P1：mount 不发任何 per-process 详情请求（懒加载核心 guard）', async () => {
    // 回归 guard：本卡位于**默认首屏激活的「待下发」tab**内，且 v-for 全部 INHOUSE
    // 工序。改前每张卡自管 useWorkerPoolByProcessQuery 算 items.length 徽标 ⇒
    // 进页面即打 N 个 `GET /prod/pool/{pid}`（N+1），与「切 tab 才懒加载」的设计
    // 意图完全相反。徽标现已改走 useWorkerPoolCountsQuery（聚合计数，单请求）。
    const wrapper = mountCard(ref(new Set<string>()));
    await flushPromises();
    expect(realGetWorkerPoolByProcess).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('P2：标题 + badge 渲染（process.code + process.name + count prop）', async () => {
    const wrapper = mountCard(ref<Set<string>>(new Set<string>()), 7);
    await flushPromises();
    const html = wrapper.html();
    expect(html).toContain('CNC-01');
    expect(html).toContain('粗加工');
    // count = 7 → badge 显示 7
    expect(html).toContain('>7<');
    wrapper.unmount();
  });

  it('P2b：count = 0 时徽标显示 0（不再退化为空串）', async () => {
    const wrapper = mountCard(ref<Set<string>>(new Set<string>()), 0);
    await flushPromises();
    expect(wrapper.html()).toContain('>0<');
    wrapper.unmount();
  });

  it('P2c：count = \'…\'（父级 counts 加载中占位）原样透传', async () => {
    const wrapper = mountCard(ref<Set<string>>(new Set<string>()), '…');
    await flushPromises();
    expect(wrapper.html()).toContain('…');
    wrapper.unmount();
  });

  it('P3：selectedIds 空 → 单击触发 ElMessage.warning，不调 dispatchMutation', async () => {
    const mutate = vi.fn();
    const wrapper = mountCard(ref<Set<string>>(new Set<string>()), 7, mutate);
    await flushPromises();
    const { ElMessage } = await import('element-plus');
    await wrapper.find('.pool-card').trigger('click');
    expect(ElMessage.warning).toHaveBeenCalledWith('请先选择待下发批次');
    expect(mutate).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('P4：selectedIds 非空 → 单击触发 dispatchMutation.mutate({ batchIds, targetProcessId })', async () => {
    const mutate = vi.fn();
    const wrapper = mountCard(ref<Set<string>>(new Set(['3000000000001', '3000000000002'])), 7, mutate);
    await flushPromises();
    await wrapper.find('.pool-card').trigger('click');
    // 2026-09-30：批量下发复用 dispatch 端点（bulk-only），单条即 targets.length===1
    expect(mutate).toHaveBeenCalledWith({
      batchIds: ['3000000000001', '3000000000002'],
      targetProcessId: '2000000000001',
    });
    wrapper.unmount();
  });

  it('P5：拖拽 drop（单 batch）→ 同样触发 dispatchMutation.mutate', async () => {
    const mutate = vi.fn();
    const wrapper = mountCard(ref<Set<string>>(new Set<string>()), 7, mutate);
    await flushPromises();
    await wrapper.find('.pool-card').trigger('drop', {
      dataTransfer: { getData: () => '3000000000009' },
    });
    expect(mutate).toHaveBeenCalledWith({
      batchIds: ['3000000000009'],
      targetProcessId: '2000000000001',
    });
    wrapper.unmount();
  });

  it('P6：drop 无 dataTransfer 内容 → 不触发 mutate', async () => {
    const mutate = vi.fn();
    const wrapper = mountCard(ref<Set<string>>(new Set<string>()), 7, mutate);
    await flushPromises();
    await wrapper.find('.pool-card').trigger('drop', {
      dataTransfer: { getData: () => '' },
    });
    expect(mutate).not.toHaveBeenCalled();
    wrapper.unmount();
  });
});
