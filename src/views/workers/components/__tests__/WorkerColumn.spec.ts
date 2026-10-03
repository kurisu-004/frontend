// @vitest-environment happy-dom
// src/views/workers/components/__tests__/WorkerColumn.spec.ts
//
// 2026-10-03 新增：WorkerColumn.vue 的拖拽落点分发 + Sortable 接线回归 guard。
// 本 spec 守的是用户报的那个 bug（批次移到工人手中后该工人卡片显示不正确）的整条
// 前端链路：Sortable onStart 记源 → onAdd 分发 → 注入的 move 包装被调。
//
// 覆盖：
//   - W1：Sortable 用**二参重载**（不传 list）—— 库的内建 onAdd/onRemove 假定「传进来
//     的 list 就是渲染源」，而本组件的渲染源是 query 派生出的 heldBatches，传镜像数组
//     只会往一个没人看的数组里 splice。
//   - W2：候选池源 → moveBatchToWorker(batchId, 本列 worker, 卡片自带的真实货架)。
//   - W3：工人源（**另一名**工人）→ moveBatchBetweenWorkers(batchId, 源工人, 本列工人)，
//     且不发 POOL→WORKER。此即「主症状」的修复点：此前只有 W2 一条路径。
//   - W4：拖回自己那一列 → 两个包装都不调（不构成一次移动）。
//   - W5：既无候选池源也无工人源 → 两个包装都不调。
//   - W6：空态 el-empty **不在** Sortable 容器内（容器直接子元素必须全是可拖项）。
//   - W7：卡片渲染在 .col-body 容器内，容器带 data-worker-id（拖拽源的识别锚点）。
//
// 测试策略：
//   - vi.mock('vue-draggable-plus') 捕获 useDraggable 的入参与 options（happy-dom
//     无头环境无法模拟 Sortable 的 _onDragOver，options 回调就是组件与库之间唯一的
//     契约面）；
//   - vi.mock('@/composables/queries/useWorkerStateByWorkerQuery') 桩掉数据源
//     （held_batches / max_held / current_held 全在本 spec 自造）；
//   - dndSourceTracker 用**真实实现**：onStart 记、onAdd 取的读写配对本身就是被测行为
//     的一半，桩掉它等于把要守的东西一起桩掉；
//   - EP 组件 stub（el-card / el-avatar / el-tag / el-progress / el-skeleton /
//     el-empty / el-tooltip）+ vi.mock('element-plus') 把 ElMessage 桩成 no-op。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref, type ComputedRef, type PropType } from 'vue';
import { mount } from '@vue/test-utils';
import type { HeldBatchItemDto } from '@/api/workerPool.contract';
import type { Worker } from '@/types/workerPool';

const captured = vi.hoisted(() => ({
  calls: [] as { list: unknown; options: Record<string, unknown> }[],
}));

vi.mock('vue-draggable-plus', () => ({
  // 复刻 vue-draggable-plus 的重载判定：第 2 参的 .value 是数组 ⇒ 三参（list）形态。
  useDraggable: (_el: unknown, listOrOptions: unknown, maybeOptions?: unknown) => {
    const candidate = (listOrOptions as { value?: unknown }) ?? {};
    const hasList = Array.isArray(candidate.value ?? listOrOptions);
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

vi.mock('element-plus', () => ({
  ElMessage: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

/** held_batches 数据源（由各用例自造）。`data` 在 mountColumn 里赋值 —— vi.hoisted
 *  工厂早于模块顶部的 `import { ref }` 求值，不能在里面调 ref()。 */
interface FakeWorkerState {
  worker_id: string;
  worker_name: string;
  work_type_code: string;
  max_held: number;
  current_held: number;
  capacity_remaining: number;
  pool_count_by_process: unknown[];
  held_batches: unknown[];
}

const stateRef = vi.hoisted(() => ({
  data: null as { value: FakeWorkerState | undefined } | null,
}));

vi.mock('@/composables/queries/useWorkerStateByWorkerQuery', () => ({
  useWorkerStateByWorkerQuery: () => ({
    data: stateRef.data,
    isLoading: ref(false),
    error: ref<Error | null>(null),
  }),
}));

import WorkerColumn from '../WorkerColumn.vue';
// 工人源不在本 spec 里手工 record：它必须经组件自己的 onStart 写入，W3/W4 守的正是
// 「onStart 记的源能被 onAdd 取到并按 from ≠ to 分流」这条链路。
import { recordPoolSource } from '@/utils/dndSourceTracker';

const ElCardStub = defineComponent({
  name: 'ElCardStub',
  setup(_, { slots }) {
    return () => h('div', { class: 'el-card-stub' }, [slots.header?.(), slots.default?.()]);
  },
});
const ElAvatarStub = defineComponent({
  name: 'ElAvatarStub',
  setup:
    (_, { slots }) =>
    () =>
      h('span', { class: 'el-avatar-stub' }, slots.default?.()),
});
const ElTagStub = defineComponent({
  name: 'ElTagStub',
  setup:
    (_, { slots }) =>
    () =>
      h('span', { class: 'el-tag-stub' }, slots.default?.()),
});
const ElProgressStub = defineComponent({
  name: 'ElProgressStub',
  props: { percentage: Number, format: Function, status: String },
  setup: () => () => h('div', { class: 'el-progress-stub' }),
});
const ElSkeletonStub = defineComponent({
  name: 'ElSkeletonStub',
  props: { rows: Number, animated: Boolean },
  setup: () => () => h('div', { class: 'el-skeleton-stub' }),
});
const ElEmptyStub = defineComponent({
  name: 'ElEmptyStub',
  props: { description: String, imageSize: Number },
  setup:
    (_, { slots }) =>
    () =>
      h('div', { class: 'el-empty-stub' }, slots.default?.()),
});
const ElTooltipStub = defineComponent({
  name: 'ElTooltipStub',
  props: {
    placement: String,
    showAfter: Number,
    disabled: Boolean,
    content: { type: [String, Object] as PropType<string | Record<string, unknown>> },
  },
  setup(_, { slots }) {
    return () =>
      h('div', { class: 'el-tooltip-stub' }, [
        h('div', { class: 'el-tooltip-stub__body' }, slots.default?.()),
        h('div', { class: 'el-tooltip-stub__content' }, slots.content?.()),
      ]);
  },
});
const ElCheckboxStub = defineComponent({
  name: 'ElCheckboxStub',
  props: { modelValue: { type: [Boolean, String, Number], default: false } },
  setup:
    (_, { slots }) =>
    () =>
      h('span', { class: 'el-checkbox-stub' }, slots.default?.()),
});

const globalConfig = {
  components: {
    ElCard: ElCardStub,
    ElAvatar: ElAvatarStub,
    ElTag: ElTagStub,
    ElProgress: ElProgressStub,
    ElSkeleton: ElSkeletonStub,
    ElEmpty: ElEmptyStub,
    ElTooltip: ElTooltipStub,
    ElCheckbox: ElCheckboxStub,
  },
};

const SELF_WORKER: Worker = {
  id: '1900000000002',
  name: '李四',
  badge_code: 'G002',
  work_type_code: 'CNC',
  max_held: 3,
  current_held: 1,
  capacity_remaining: 2,
  is_online: true,
  process_ids: ['2000000000001'],
};

function makeHeld(overrides: Partial<HeldBatchItemDto> = {}): HeldBatchItemDto {
  return {
    batch_id: '3000000000001',
    part_id: '4000000000001',
    batch_no: 1024,
    quantity: 12,
    serial_no: 'SN-0001',
    name: '连杆',
    drawing_no: 'DRW-1',
    system_delivery_date: '2026-10-20',
    planned_delivery_date: null,
    is_urgent: false,
    customer_name: '某某零件厂',
    parent_customer_name: '某某集团',
    applicant_name: '张三',
    location: 'WORKER',
    shelf_code: null,
    note: null,
    has_cnc_program: false,
    version: 3,
    ...overrides,
  };
}

function mountColumn(
  held: HeldBatchItemDto[] = [makeHeld()],
  provided: Record<string, unknown> = {},
) {
  stateRef.data = ref<FakeWorkerState | undefined>({
    worker_id: SELF_WORKER.id,
    worker_name: SELF_WORKER.name,
    work_type_code: SELF_WORKER.work_type_code,
    max_held: 3,
    current_held: held.length,
    capacity_remaining: 3 - held.length,
    pool_count_by_process: [],
    held_batches: held,
  });
  return mount(WorkerColumn, {
    props: { worker: SELF_WORKER },
    global: {
      components: globalConfig.components,
      provide: {
        shelfId: ref('5000000000001') as unknown as ComputedRef<string>,
        moveBatchToWorker: vi.fn(async () => true),
        moveBatchBetweenWorkers: vi.fn(async () => true),
        ...provided,
      },
    },
  });
}

/** Sortable 捕获到的 options（W1 断言二参形态后，它就是组件与库之间唯一契约面）。 */
function capturedOptions(): Record<string, unknown> {
  expect(captured.calls).toHaveLength(1);
  return captured.calls[0].options;
}

/** 造一个形状与 Sortable 原生事件一致的最小载荷。 */
function dragEvent(dataset: { batchId: string }, fromDataset: Record<string, string> = {}) {
  const item = document.createElement('div');
  item.dataset.batchId = dataset.batchId;
  const from = document.createElement('div');
  for (const [k, v] of Object.entries(fromDataset)) from.dataset[k] = v;
  return { item, from };
}

describe('WorkerColumn（2026-10-03 拖拽落点分发）', () => {
  beforeEach(() => {
    captured.calls.length = 0;
  });

  it('W1：Sortable 用二参重载，不传 list（渲染源与 list 不同源）', () => {
    const wrapper = mountColumn();
    expect(captured.calls[0].list).toBeNull();
    const options = capturedOptions();
    expect(options.group).toBe('work-orders');
    expect(typeof options.onStart).toBe('function');
    expect(typeof options.onAdd).toBe('function');
    wrapper.unmount();
  });

  it('W2：候选池源 → moveBatchToWorker(batchId, 本列工人, 卡片真实货架)', async () => {
    const moveBatchToWorker = vi.fn(async () => true);
    const moveBatchBetweenWorkers = vi.fn(async () => true);
    const wrapper = mountColumn([makeHeld()], { moveBatchToWorker, moveBatchBetweenWorkers });
    const options = capturedOptions();

    // 源容器 = PoolDrawer 的 .pool-cards（只有 data-process-id），卡片带 data-shelf-id
    recordPoolSource('3000000000009', {
      processId: '2000000000001',
      shelfId: '5000000000009',
    });
    (options.onStart as (e: unknown) => void)(dragEvent({ batchId: '3000000000009' }));
    await (options.onAdd as (e: unknown) => Promise<void>)(dragEvent({ batchId: '3000000000009' }));

    expect(moveBatchToWorker).toHaveBeenCalledTimes(1);
    expect(moveBatchToWorker).toHaveBeenCalledWith(
      '3000000000009',
      SELF_WORKER.id,
      '5000000000009',
    );
    expect(moveBatchBetweenWorkers).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('W3：工人源（另一名工人）→ moveBatchBetweenWorkers，且不发 POOL→WORKER', async () => {
    const moveBatchToWorker = vi.fn(async () => true);
    const moveBatchBetweenWorkers = vi.fn(async () => true);
    const wrapper = mountColumn([makeHeld()], { moveBatchToWorker, moveBatchBetweenWorkers });
    const options = capturedOptions();

    // 源容器 = 另一个工人列（data-worker-id = 源工人）
    const evt = dragEvent({ batchId: '3000000000009' }, { workerId: '1900000000001' });
    (options.onStart as (e: unknown) => void)(evt);
    await (options.onAdd as (e: unknown) => Promise<void>)(evt);

    expect(moveBatchBetweenWorkers).toHaveBeenCalledTimes(1);
    expect(moveBatchBetweenWorkers).toHaveBeenCalledWith(
      '3000000000009',
      '1900000000001',
      SELF_WORKER.id,
    );
    expect(moveBatchToWorker).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('W4：拖回自己那一列 → 两个包装都不调（不构成一次移动）', async () => {
    const moveBatchToWorker = vi.fn(async () => true);
    const moveBatchBetweenWorkers = vi.fn(async () => true);
    const wrapper = mountColumn([makeHeld()], { moveBatchToWorker, moveBatchBetweenWorkers });
    const options = capturedOptions();

    const evt = dragEvent({ batchId: '3000000000009' }, { workerId: SELF_WORKER.id });
    (options.onStart as (e: unknown) => void)(evt);
    await (options.onAdd as (e: unknown) => Promise<void>)(evt);

    expect(moveBatchBetweenWorkers).not.toHaveBeenCalled();
    expect(moveBatchToWorker).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('W5：既无候选池源也无工人源 → 两个包装都不调', async () => {
    const moveBatchToWorker = vi.fn(async () => true);
    const moveBatchBetweenWorkers = vi.fn(async () => true);
    const wrapper = mountColumn([makeHeld()], { moveBatchToWorker, moveBatchBetweenWorkers });
    const options = capturedOptions();

    await (options.onAdd as (e: unknown) => Promise<void>)(dragEvent({ batchId: '3000000000009' }));

    expect(moveBatchBetweenWorkers).not.toHaveBeenCalled();
    expect(moveBatchToWorker).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('W6：空态 el-empty 不在 Sortable 容器内（容器直接子元素必须全是可拖项）', () => {
    const wrapper = mountColumn([]);
    // 空态时容器根本不渲染：Sortable 拿不到一个装满非可拖子元素的容器
    expect(wrapper.find('.col-body').exists()).toBe(false);
    expect(wrapper.find('.el-empty-stub').exists()).toBe(true);
    // 空态必须仍占满可视区（否则列底会塌成一条缝）
    expect(wrapper.find('.col-content').exists()).toBe(true);
    wrapper.unmount();
  });

  it('W7：卡片渲染在 .col-body 内，容器带 data-worker-id', () => {
    const wrapper = mountColumn([makeHeld(), makeHeld({ batch_id: '3000000000002', batch_no: 2 })]);
    const col = wrapper.find('.col-body');
    expect(col.exists()).toBe(true);
    expect((col.element as HTMLElement).dataset.workerId).toBe(SELF_WORKER.id);
    expect(col.findAll('.batch-card')).toHaveLength(2);
    // 容器直接子元素全是批次卡（真 el-tooltip 不产生包裹元素，测试里的 stub 多包了
    // 一层 .el-tooltip-stub），没有空态 / skeleton 这类非可拖项混入
    expect(col.find('.el-empty-stub').exists()).toBe(false);
    expect(col.find('.el-skeleton-stub').exists()).toBe(false);
    for (const child of Array.from(col.element.children)) {
      expect(child.matches('.batch-card, .el-tooltip-stub')).toBe(true);
    }
    wrapper.unmount();
  });
});
