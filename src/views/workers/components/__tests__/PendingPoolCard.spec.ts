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
//   - P5：Sortable 目标端 onAdd（拖入）→ 同样触发 dispatchMutation.mutate（单 batch）。
//
// 2026-10-02（P1~P4 不动，仅改投放路径）：
//   - 拖放从原生 HTML5 DnD 换成 vue-draggable-plus 目标端 onAdd，原生 drop 事件派发
//     路径已随 @drop / dragover 处理器一起删除 ⇒ P5 改为**直接驱动 Sortable 的
//     onAdd 回调**。做法：vi.mock('vue-draggable-plus') 捕获每次 useDraggable 的
//     options，再手动调用（Sortable 内部 _onDragOver → onAdd 的分派无法在 happy-dom
//     下无头模拟，而 options 回调本身就是组件与 Sortable 之间唯一的契约面）。
//   - P6 同步改写：onAdd 收到的 item 缺 data-batch-id（或 item 本身缺失）→ 不 mutate。
//   - P7 / P8：2026-10-02 拖入高亮跨组件联动在本卡片侧的契约锚点 —— 根 div 的
//     data-process-id（源侧 onMove 靠它识别悬停目标）与 dropping prop → .is-dropping。
//
// 测试策略（沿 LoginView.spec.ts 范本）：
//   - vue-test-utils mount + globalConfig.plugins: [[VueQueryPlugin, { queryClient }]]；
//   - vi.mock('@/api/workerPool') + vi.mock('element-plus') + vi.mock('vue-draggable-plus')。

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

/** 2026-10-02：捕获每次 useDraggable 调用的 options，供测试直接驱动 onAdd。
 *  不用真实 Sortable 的原因：投放事件（_onDragOver → onAdd）由 Sortable 内部的
 *  指针/坐标计算驱动，happy-dom 无头环境下无法构造。 */
const captured = vi.hoisted(() => ({
  calls: [] as { list: unknown; options: Record<string, unknown> }[],
}));

vi.mock('vue-draggable-plus', () => ({
  // 必须自己复刻 vue-draggable-plus 的重载判定：二参重载（只传 el + options）的
  // 第二个实参不是 Ref，误当 list 会把真正的 options 记成 list。
  useDraggable: (_el: unknown, listOrOptions: unknown, maybeOptions?: unknown) => {
    const hasList = Array.isArray((listOrOptions as { value?: unknown })?.value ?? listOrOptions);
    const options = (hasList ? maybeOptions : listOrOptions) as Record<string, unknown>;
    captured.calls.push({ list: hasList ? listOrOptions : null, options });
    return {
      option: () => undefined,
      destroy: () => undefined,
      start: () => undefined,
      pause: () => undefined,
      resume: () => undefined,
    };
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
  extraProps: Record<string, unknown> = {},
) {
  return mount(PendingPoolCard, {
    props: {
      process: { id: '2000000000001', code: 'CNC-01', name: '粗加工' },
      count,
      selectedIds,
      dispatchMutation: makeMutationStub(mutate),
      ...extraProps,
    },
    global: globalConfig,
  });
}

/** 取出本卡 Sortable 配置的 onAdd（本 spec 只 mount 单卡 ⇒ 只有 1 条捕获记录，
 *  即该投放目标容器）。 */
function capturedOnAdd(): (evt: unknown) => void {
  expect(captured.calls).toHaveLength(1);
  return captured.calls[0].options.onAdd as (evt: unknown) => void;
}

describe('PendingPoolCard（2026-09-30 懒加载 + bulk-only 收敛）', () => {
  beforeEach(() => {
    realGetWorkerPoolByProcess.mockClear();
    captured.calls.length = 0;
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

  it('P5：Sortable 目标端 onAdd（拖入单 batch）→ 触发 dispatchMutation.mutate', async () => {
    const mutate = vi.fn();
    const wrapper = mountCard(ref<Set<string>>(new Set<string>()), 7, mutate);
    await flushPromises();
    // batch_id 读自被拖节点的 data-batch-id（BatchCard 根 div 上恒渲染），**不读
    // evt.data**：源列表混入非可拖子节点时 data 不可靠。
    capturedOnAdd()({ item: { dataset: { batchId: '3000000000009' } } });
    // 拖拽只发被拖的那一件，**不读 selectedIds**（多选集合只属于单击路径）。
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenCalledWith({
      batchIds: ['3000000000009'],
      targetProcessId: '2000000000001',
    });
    wrapper.unmount();
  });

  it('P6：onAdd 收到的 item 无 data-batch-id → 不触发 mutate', async () => {
    const mutate = vi.fn();
    const wrapper = mountCard(ref<Set<string>>(new Set<string>()), 7, mutate);
    await flushPromises();
    capturedOnAdd()({ item: { dataset: {} } });
    expect(mutate).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('P6b：onAdd 收到的 item 为空串 batchId → 不触发 mutate', async () => {
    const mutate = vi.fn();
    const wrapper = mountCard(ref<Set<string>>(new Set<string>()), 7, mutate);
    await flushPromises();
    capturedOnAdd()({ item: { dataset: { batchId: '' } } });
    expect(mutate).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('P6c：onAdd 收到的 evt 无 item（Sortable 目标无有效落点）→ 不抛也不 mutate', async () => {
    const mutate = vi.fn();
    const wrapper = mountCard(ref<Set<string>>(new Set<string>()), 7, mutate);
    await flushPromises();
    expect(() => capturedOnAdd()({})).not.toThrow();
    expect(mutate).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('P7：根 div 带 data-process-id（源侧 onMove 识别悬停目标的契约锚点）', async () => {
    const wrapper = mountCard(ref<Set<string>>(new Set<string>()), 7);
    await flushPromises();
    expect(wrapper.find('.pool-card').attributes('data-process-id')).toBe('2000000000001');
    wrapper.unmount();
  });

  it('P8：dropping prop 驱动 .is-dropping 高亮（false 时不带该类）', async () => {
    const wrapper = mountCard(ref<Set<string>>(new Set<string>()), 7, vi.fn(), { dropping: true });
    await flushPromises();
    expect(wrapper.find('.pool-card').classes()).toContain('is-dropping');
    await wrapper.setProps({ dropping: false });
    expect(wrapper.find('.pool-card').classes()).not.toContain('is-dropping');
    wrapper.unmount();
  });
});
