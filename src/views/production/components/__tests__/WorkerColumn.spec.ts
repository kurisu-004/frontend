// @vitest-environment happy-dom
// src/views/production/components/__tests__/WorkerColumn.spec.ts
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
//   - W6：空态 el-empty 是 .col-body 的**兄弟覆盖层**：容器仍在（非空/空态都要存在，
//     空列是 POOL→WORKER 的主落点），且容器内没有任何非可拖子元素。
//   - W7：卡片渲染在 .col-body 容器内，容器带 data-worker-id（拖拽源的识别锚点）。
//   - W8：state query 的调用点**只传 workerId 一个实参**（2026-10-04 新增）—— 桩不受
//     真实签名约束，接线层没有类型锚，必须在实参元组上断言，否则 shelfId 这类
//     第二维度被悄悄加回时无一条用例会红。
//   - W9：空列也把 Sortable 绑到了 .col-body 上（start(el) 收到的就是该容器节点）——
//     容器不渲染 ⇒ watch 走 destroy 分支 ⇒ 空列没有任何 Sortable 实例，拖不进去。
//   - W10：options 带 sort: false 且**不带** onMove（容器内重排由 Sortable 的 sort
//     开关关掉，不靠 onMove 守卫）。
//   - W11：options 带 onRemove，且把被拖节点放回 `from.children[oldIndex]`（DOM 下标）。
//     二参形态下库不挂内建 onRemove，缺了它投放失败时幻影节点留在落点列、invalidate
//     清不掉。断言必须落在「放回原下标位置」而不仅是「函数存在」。
//   - W12（2026-10-06）：卡片上派发 contextmenu → 注入的 openBatchContextMenu 被调一次，
//     参数是**被右键那张卡**的 BatchCardModel（含 recall 必需的 version）；用例渲染两张
//     卡并右键第二张，否则「那张卡」与「唯一那张卡」不可区分。W12b：未提供 opener 时
//     右键不抛错（inject 缺省 noop 兜底）。
//   - W13 / W13b（2026-10-06）：Sortable 容器 .col-body 内的节点构成 —— 只有卡片根元素
//     与 v-for 的 2 个空文本锚点，**没有注释节点**（dev 构建保留模板注释，注释同样是
//     容器直接子节点）；空列时零元素子节点、容器仍是合法投放目标。
//
// 测试策略：
//   - vi.mock('vue-draggable-plus') 捕获 useDraggable 的入参与 options（happy-dom
//     无头环境无法模拟 Sortable 的 _onDragOver，options 回调就是组件与库之间唯一的
//     契约面）；
//   - vi.mock('@/composables/queries/useWorkerStateByWorkerQuery') 桩掉数据源
//     （held_batches / max_held / current_held 全在本 spec 自造），并记录实参元组
//     供 W8 断言调用点只传 workerId（工厂不受真实签名约束，桩必须自带这个锚）；
//   - dndSourceTracker 用**真实实现**：onStart 记、onAdd 取的读写配对本身就是被测行为
//     的一半，桩掉它等于把要守的东西一起桩掉；
//   - EP 组件 stub（el-card / el-avatar / el-tag / el-progress / el-skeleton /
//     el-empty / el-tooltip）+ vi.mock('element-plus') 把 ElMessage 桩成 no-op。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick, ref, type PropType } from 'vue';
import { mount } from '@vue/test-utils';
import type { HeldBatchItemDto } from '@/api/workerPool.contract';
import type { Worker } from '@/types/workerPool';

const captured = vi.hoisted(() => ({
  calls: [] as { list: unknown; options: Record<string, unknown> }[],
  /** useLazyDraggable 在 flush:'post' 的 watch 里调 start(el)，这里收容器节点。 */
  starts: [] as unknown[],
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
      start: (el?: unknown) => captured.starts.push(el),
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
  /** 2026-10-04：桩记录的入参元组。vi.mock 工厂不受真实签名约束，组件若把 shelfId
   *  之类的第二维度加回来（或改回 inject）不会有任何类型报错，只有这里的实参个数
   *  断言能让它变红。 */
  args: [] as unknown[][],
}));

vi.mock('@/composables/queries/useWorkerStateByWorkerQuery', () => ({
  useWorkerStateByWorkerQuery: (...args: unknown[]) => {
    stateRef.args.push(args);
    return {
      data: stateRef.data,
      isLoading: ref(false),
      error: ref<Error | null>(null),
    };
  },
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
      // 2026-10-04：不再 provide shelfId —— 组件已删掉 inject('shelfId')，
      // state query 只按 workerId 取数（桩 query，见上方 vi.mock）。
      provide: {
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
    captured.starts.length = 0;
    stateRef.args.length = 0;
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

  it('W6：空态 el-empty 是 .col-body 的兄弟覆盖层，容器本身仍在', () => {
    const wrapper = mountColumn([]);
    // 回归 guard：空工人列是 POOL→WORKER 的主落点。容器一旦不渲染，空列就没有任何
    // Sortable 实例，「给空闲工人派活」根本放不进去（卡片弹回源容器）。
    const col = wrapper.find('.col-body');
    expect(col.exists()).toBe(true);
    expect((col.element as HTMLElement).dataset.workerId).toBe(SELF_WORKER.id);
    // 容器内不得混入任何非可拖子元素（空态 ⇒ 零子元素）
    expect(col.element.children).toHaveLength(0);
    // 空态插画仍渲染，且必须是容器的兄弟节点而非后代
    const empty = wrapper.find('.el-empty-stub');
    expect(empty.exists()).toBe(true);
    expect(empty.element.closest('.col-body')).toBeNull();
    const overlay = wrapper.find('.col-empty');
    expect(overlay.exists()).toBe(true);
    expect(overlay.element.parentElement?.classList.contains('col-content')).toBe(true);
    // 覆盖层的另一半保证（pointer-events:none 不吃落点判定）在样式区，单测环境不注入
    // scoped 样式、无法断言，靠 W9 守住「容器确实有 Sortable 实例」这一侧。
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

  it('W8：state query 只接 workerId 一个维度（无 shelfId 第二参）', () => {
    // 2026-10-04 接线 guard：本组件的 query 调用点与 composable 签名之间没有任何
    // 类型锚（桩是零参的），历史上 shelfId 就是在这里悄悄加回去的 —— 而
    // auth.activeShelfId 对 MANAGER / CLERK / INSPECTOR 恒空 ⇒ enabled 恒 false
    // ⇒ 持有列表静默显示「暂无持有工单」+ 0/0。断言落在**实参元组**上。
    const wrapper = mountColumn();
    expect(stateRef.args).toHaveLength(1);
    expect(stateRef.args[0]).toHaveLength(1);
    // 唯一实参是返回 worker.id 的 getter，调用它应拿到本列 worker 的 id
    const only = stateRef.args[0][0];
    expect(typeof only).toBe('function');
    expect((only as () => string)()).toBe(SELF_WORKER.id);
    wrapper.unmount();
  });

  it('W9：空列也把 Sortable 绑在 .col-body 上（start 收到的就是该容器节点）', async () => {
    // 回归 guard：useLazyDraggable 在 flush:'post' 的 watch 里 start(el) / destroy()。
    // 容器若在空态下不渲染，watch 走 destroy 分支 ⇒ 该列一个 Sortable 实例都没有 ⇒
    // 拖到空列 = 无落点，拖拽被取消、卡片弹回源容器。
    const wrapper = mountColumn([]);
    await nextTick();
    const col = wrapper.find('.col-body');
    expect(col.exists()).toBe(true);
    expect(captured.starts).toContain(col.element);
    wrapper.unmount();
  });

  it('W10：容器内重排由 sort:false 关掉，不用 onMove 守卫', () => {
    const wrapper = mountColumn([makeHeld()]);
    const options = capturedOptions();
    // 本 UI 每次落位都是「一次写操作 + 一次失效」，无重排语义；二参形态下库不挂内建
    // onUpdate，重排后无人回滚 DOM 顺序，故用 Sortable 的 sort 开关直接关掉。
    expect(options.sort).toBe(false);
    // onMove 只从**源**实例读取，本列作为落点时读的是对方实例的 ⇒ 挂在源侧覆盖不了
    // 「别的列拖进本列时的容器内重排」，不是正确工具，不该再出现。
    expect(options.onMove).toBeUndefined();
    wrapper.unmount();
  });

  it('W11：onRemove 把被拖节点放回 from.children[oldIndex]（二参形态的 DOM 放回补齐）', () => {
    const wrapper = mountColumn([makeHeld()]);
    const onRemove = capturedOptions().onRemove as (e: unknown) => void;
    // 回归 guard（2026-10-03）：传 list 时库的内建 onRemove 第一句
    // 就是 from.insertBefore(item, from.children[oldIndex])，投放成败都先把节点放回源列。
    // 改二参形态后内建 handler 整个不挂 ⇒ 投放失败（20204 容量超限最常见）时卡片留在
    // 落点列，而 invalidate 救不回来：两侧 query 数据都没变，Vue 的 keyed diff 只
    // patchElement，永远不删不在 vdom 里的外来节点。
    expect(typeof onRemove).toBe('function');

    // 造出「源列 [A, 卡片, C] → Sortable 已把卡片搬进落点列」的现场
    const source = document.createElement('div');
    const a = document.createElement('div');
    a.id = 'a';
    const card = document.createElement('div');
    card.id = 'card';
    const c = document.createElement('div');
    c.id = 'c';
    const target = document.createElement('div');
    source.append(a, c);
    target.appendChild(card);

    // 卡片原下标 = 1（[A, card, C]）；节点已被摘走，from.children[1] 现在是 C
    onRemove({ item: card, from: source, oldIndex: 1 });

    // 放回原位：父节点是源列，顺序 A → 卡片 → C
    expect(card.parentElement).toBe(source);
    expect(Array.from(source.children).map((el) => el.id)).toEqual(['a', 'card', 'c']);
    // 落点列已被清空，不留幻影节点
    expect(target.children).toHaveLength(0);
    wrapper.unmount();
  });

  it('W12（2026-10-06）：卡片右键 → 注入的 opener 被调一次，参数是**第二张**卡的 model', async () => {
    const openBatchContextMenu = vi.fn();
    // 两张卡（batch_id / version 都不同）且右键**第二张**：单卡场景下「拿到那张卡」
    // 与「拿到唯一那张卡」无法区分，实现误传 heldBatches[0] 也会照样通过
    const first = makeHeld({ batch_id: '3000000000001', batch_no: 1024, version: 3 });
    const second = makeHeld({ batch_id: '3000000000002', batch_no: 2048, version: 8 });
    const wrapper = mountColumn([first, second], { openBatchContextMenu });

    const cards = wrapper.find('.col-body').findAll('.batch-card');
    expect(cards).toHaveLength(2);
    await cards[1]!.trigger('contextmenu', { clientX: 320, clientY: 240 });

    expect(openBatchContextMenu).toHaveBeenCalledTimes(1);
    const [evt, passed] = openBatchContextMenu.mock.calls[0]!;
    // 第一参是原始 MouseEvent（含坐标，菜单靠它定位）
    expect(evt).toBeInstanceOf(Event);
    expect((evt as MouseEvent).clientX).toBe(320);
    // 第二参就是被右键那张卡的 BatchCardModel —— 注意这里**不能**与 held DTO 做身份
    // 比对：卡片是 heldToCard 适配层现产出的新对象，heldBatches 里的原始 DTO 不是它。
    // 鉴别口径落在两张卡各自不同的字段上（batch_id / version / batch_no）：实现若误传
    // heldBatches[0]，这三个字段会全部对不上。
    expect(passed).toMatchObject({
      batch_id: '3000000000002',
      version: 8,
      batch_no: 'B2048',
    });
    expect(passed).not.toMatchObject({ batch_id: '3000000000001' });
    expect(passed).not.toMatchObject({ version: 3 });
    // 右键监听落在卡片根 div 上、且没有为它加包裹层：卡片的父节点就是 Sortable 容器
    // （BatchCard 的 tooltip 在根**内部**，不是包根；容器侧口径由 W13 守）
    const cardEl = cards[1]!.element as HTMLElement;
    expect(cardEl.parentElement?.classList.contains('col-body')).toBe(true);
    expect(cardEl.matches('.batch-card')).toBe(true);
    wrapper.unmount();
  });

  it('W13（2026-10-06）：Sortable 容器 .col-body 内只有卡片（无注释节点、无包裹层）', () => {
    // 「Sortable 容器的直接子元素必须全是可拖项」。dev 构建保留模板注释，注释节点同样
    // 是容器的直接子节点 —— 有人在容器 div 内留注释就红；为右键菜单加一层包裹
    // 也会让元素子节点数超过卡片数。口径按 DOM 实测定：模板里的 keyed v-for 额外留下
    // 2 个空文本锚点（Vue 的 fragment 锚），除此之外只允许卡片根元素。
    const wrapper = mountColumn([
      makeHeld({ batch_id: '3000000000001' }),
      makeHeld({ batch_id: '3000000000002', batch_no: 2 }),
    ]);
    const col = wrapper.find('.col-body').element as HTMLElement;
    const nodes = Array.from(col.childNodes);

    expect(nodes.filter((n) => n.nodeType === Node.ELEMENT_NODE)).toHaveLength(2);
    expect(nodes.filter((n) => n.nodeType === Node.COMMENT_NODE)).toHaveLength(0);
    // 剩下的只能是那两个 fragment 空文本锚点；多出来的任何节点（注释 / 文本 / 包裹层）
    // 都会让这个总数对不上
    expect(nodes).toHaveLength(4);
    for (const child of Array.from(col.children)) {
      expect(child.matches('.batch-card, .el-tooltip-stub')).toBe(true);
    }
    wrapper.unmount();
  });

  it('W13b：空列的容器内零节点（空容器仍须是合法投放目标）', () => {
    const wrapper = mountColumn([]);
    const col = wrapper.find('.col-body').element as HTMLElement;
    // 空 v-for 只剩 2 个 fragment 空文本锚点：一个元素子节点都没有，也**没有**注释
    expect(col.children).toHaveLength(0);
    expect(col.childNodes).toHaveLength(2);
    expect(Array.from(col.childNodes).filter((n) => n.nodeType === Node.COMMENT_NODE)).toHaveLength(
      0,
    );
    wrapper.unmount();
  });

  it('W12b（2026-10-06）：未 provide opener 时右键不抛错（inject 缺省 noop）', async () => {
    stateRef.data = ref<FakeWorkerState | undefined>({
      worker_id: SELF_WORKER.id,
      worker_name: SELF_WORKER.name,
      work_type_code: SELF_WORKER.work_type_code,
      max_held: 3,
      current_held: 1,
      capacity_remaining: 2,
      pool_count_by_process: [],
      held_batches: [makeHeld()],
    });
    // 完全不 provide（板级 opener 缺失的极端形态）⇒ 右键退化为无反应，不炸回调
    const wrapper = mount(WorkerColumn, {
      props: { worker: SELF_WORKER },
      global: { components: globalConfig.components },
    });
    const card = wrapper.find('.col-body').find('.batch-card');
    await expect(card.trigger('contextmenu')).resolves.not.toThrow();
    wrapper.unmount();
  });
});
