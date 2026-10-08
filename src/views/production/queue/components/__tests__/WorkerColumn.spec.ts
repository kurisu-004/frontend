// @vitest-environment happy-dom
// src/views/production/queue/components/__tests__/WorkerColumn.spec.ts
//
// 工人列的拖拽落点分发 + Sortable 接线回归 guard。守的是「批次移到工人手中后该工人
// 卡片显示不正确」这条用户报过的 bug 的整条前端链路：Sortable onStart 记源 → onAdd
// 分发 → 注入的 move 包装被调。
//
// 2026-10-08：组件不再自管 query（后端把持有批次与容量三字段内联进工序看板的
// `workers[]`），props 收敛成单个 `worker: QueueWorkerSchema`。旧用例里「桩 query
// 观察调用点只传 workerId 一维」的 W8 随之删除 —— 数据不再经过 query 调用点，那条
// 防线改由 W15 接住（api 模块 tripwire + 零调用断言）。
// ⚠️ schema 侧只守「字段齐不齐」（productionQueueSchema.spec.ts 的 Q-B2 / Q-B3），
// 挡不住有人把自管 query 加回本组件 —— 字段再齐，多发的那次请求照样发生。
//
// 覆盖：
//   - W1：Sortable 用**二参重载**（不传 list）—— 库的内建 onAdd/onRemove 假定「传进来
//     的 list 就是渲染源」，而本组件的渲染源是 props 派生的 heldBatches，传镜像数组
//     只会往一个没人看的数组里 splice。
//   - W2：候选池源 → moveBatchToWorker(batchId, version, 本列工人, 卡片自带的真实货架)。
//   - W2b（2026-10-08）：卡片没带 data-batch-version → version 实参是 NaN 而不是 0
//     （守卫在 useQueueMove：0 是形态合法的假 version，会让后端按 OCC 冲突拒一次
//     用户没做错的投放）。
//   - W3：工人源（**另一名**工人）→ moveBatchBetweenWorkers(batchId, version, 源工人,
//     本列工人)，且不发 POOL→WORKER。此即「主症状」的修复点：此前只有 W2 一条路径。
//   - W4：拖回自己那一列 → 两个包装都不调（不构成一次移动）。
//   - W5：既无候选池源也无工人源 → 两个包装都不调。
//   - W6：空态 el-empty 是 .col-body 的**兄弟覆盖层**：容器仍在（非空/空态都要存在，
//     空列是 POOL→WORKER 的主落点），且容器内没有任何非可拖子元素。
//   - W7：卡片渲染在 .col-body 容器内，容器带 data-worker-id（拖拽源的识别锚点）。
//   - W9：空列也把 Sortable 绑到了 .col-body 上（start(el) 收到的就是该容器节点）——
//     容器不渲染 ⇒ watch 走 destroy 分支 ⇒ 空列没有任何 Sortable 实例，拖不进去。
//   - W10：options 带 sort: false 且**不带** onMove（容器内重排由 Sortable 的 sort
//     开关关掉，不靠 onMove 守卫）。
//   - W11：options 带 onRemove，且把被拖节点放回 `from.children[oldIndex]`（DOM 下标）。
//     二参形态下库不挂内建 onRemove，缺了它投放失败时幻影节点留在落点列、invalidate
//     清不掉。断言必须落在「放回原下标位置」而不仅是「函数存在」。
//   - W12：卡片上派发 contextmenu → 注入的 openBatchContextMenu 被调一次，参数是**被
//     右键那张卡**的 BatchCardModel（含 recall 必需的 version）；用例渲染两张卡并右键
//     第二张，否则「那张卡」与「唯一那张卡」不可区分。W12b：未提供 opener 时右键不抛错
//     （inject 缺省 noop 兜底）。
//   - W13 / W13b：Sortable 容器 .col-body 内的节点构成 —— 只有卡片根元素与 v-for 的
//     2 个空文本锚点，**没有注释节点**（dev 构建保留注释，注释同样是容器直接子节点）；
//     空列时零元素子节点、容器仍是合法投放目标。
//   - W14（2026-10-08 新增）：容量三字段直接渲染 props —— 「加载中占位 …」分支已
//     消失（数据一次请求到齐，列内不存在中间态）。
//   - W15（2026-10-08 新增）：挂载 + 完整交互窗口内对 `@/api/productionQueue`
//     **零请求** —— N+1 收口这条不变式的真守卫。
//
// 测试策略：
//   - vi.mock('vue-draggable-plus') 捕获 useDraggable 的入参与 options（happy-dom
//     无头环境无法模拟 Sortable 的 _onDragOver，options 回调就是组件与库之间唯一的
//     契约面）；
//   - 工人数据经 **props** 注入（不再桩 query）—— 每个用例造自己的 QueueWorkerSchema；
//   - dndSourceTracker 用**真实实现**：onStart 记、onAdd 取的读写配对本身就是被测行为
//     的一半，桩掉它等于把要守的东西一起桩掉；
//   - EP 组件 stub（el-card / el-avatar / el-tag / el-progress / el-empty /
//     el-tooltip）+ vi.mock('element-plus') 把 ElMessage 桩成 no-op。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick, type PropType } from 'vue';
import { mount } from '@vue/test-utils';
import type { QueueHeldBatchDto } from '@/api/productionQueue.contract';
import type { QueueWorkerSchema } from '../../composables/productionQueueSchema';

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

// 2026-10-08：api 模块整体桩成「一被调用就记账」的 tripwire（W15 守它）。
// 组件树当前对 `@/api/productionQueue` 只有 type import（type 会被编译期抹掉），
// 所以这个 mock 的 factory 在 W1~W14 里**根本不会执行** —— 它只在有人把自管 query
// 加回工人列时才被解析到。列名的枚举在本 spec 里是刻意的冗余：新增端点时补一行，
// 补漏的后果是新端点不在断言面里（漏报，不会假绿在「误以为守住了」上）。
const apiCalls = vi.hoisted(() => [] as string[]);

vi.mock('@/api/productionQueue', () => ({
  fetchQueueSnapshot: vi.fn(() => {
    apiCalls.push('fetchQueueSnapshot');
    return Promise.reject(new Error('api tripwire: fetchQueueSnapshot'));
  }),
  fetchQueueBoard: vi.fn(() => {
    apiCalls.push('fetchQueueBoard');
    return Promise.reject(new Error('api tripwire: fetchQueueBoard'));
  }),
  fetchPendingBatches: vi.fn(() => {
    apiCalls.push('fetchPendingBatches');
    return Promise.reject(new Error('api tripwire: fetchPendingBatches'));
  }),
  dispatchBatches: vi.fn(() => {
    apiCalls.push('dispatchBatches');
    return Promise.reject(new Error('api tripwire: dispatchBatches'));
  }),
  previewAutoDispatch: vi.fn(() => {
    apiCalls.push('previewAutoDispatch');
    return Promise.reject(new Error('api tripwire: previewAutoDispatch'));
  }),
  recallToPending: vi.fn(() => {
    apiCalls.push('recallToPending');
    return Promise.reject(new Error('api tripwire: recallToPending'));
  }),
  moveBatch: vi.fn(() => {
    apiCalls.push('moveBatch');
    return Promise.reject(new Error('api tripwire: moveBatch'));
  }),
  autoAllocate: vi.fn(() => {
    apiCalls.push('autoAllocate');
    return Promise.reject(new Error('api tripwire: autoAllocate'));
  }),
  refillQueue: vi.fn(() => {
    apiCalls.push('refillQueue');
    return Promise.reject(new Error('api tripwire: refillQueue'));
  }),
  AUTO_DISPATCH_SKIP_REASON_LABELS: {},
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
// 进度条桩把 format 的返回值渲染出来 —— W14 要断言的正是「当前/上限」那段文案
// （el-progress 的 format 回调），只渲染一个空 div 的话占位分支（'…'）与真实数字
// 在断言里无法区分。
const ElProgressStub = defineComponent({
  name: 'ElProgressStub',
  props: { percentage: Number, format: Function, status: String },
  setup(props) {
    return () =>
      h('div', { class: 'el-progress-stub' }, [
        props.format ? String(props.format(props.percentage ?? 0)) : '',
      ]);
  },
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

/** 本列工人 id（后端 QueueWorker 原样透传，无中间 view-model 改写）。 */
const SELF_WORKER_ID = '1900000000002';

function makeHeld(overrides: Partial<QueueHeldBatchDto> = {}): QueueHeldBatchDto {
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
    has_process_chain: false,
    customer_name: '某某零件厂',
    parent_customer_name: '某某集团',
    applicant_name: '张三',
    location: 'WORKER',
    note: null,
    has_cnc_program: false,
    version: 3,
    ...overrides,
  };
}

/** 造本列工人 props（容量三字段随持有数派生，与后端口径一致：
 *  current_held = 持有批次数，capacity_remaining = max_held - current_held）。 */
function makeWorker(held: QueueHeldBatchDto[] = [makeHeld()]): QueueWorkerSchema {
  return {
    worker_id: SELF_WORKER_ID,
    name: '李四',
    work_type_code: 'CNC',
    badge_code: 'G002',
    max_held: 3,
    current_held: held.length,
    capacity_remaining: 3 - held.length,
    held_batches: held,
  };
}

function mountColumn(
  held: QueueHeldBatchDto[] = [makeHeld()],
  provided: Record<string, unknown> = {},
) {
  return mount(WorkerColumn, {
    props: { worker: makeWorker(held) },
    global: {
      components: globalConfig.components,
      // 不 provide shelfId —— 组件已删掉 inject('shelfId')（队列数据全部由后端按批次
      // 真实位置返回，前端不拼货架）。
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

/**
 * 造一个形状与 Sortable 原生事件一致的最小载荷。
 *
 * `version` 走卡片的 `data-batch-version` dataset（2026-10-08 起 move 必传 OCC 锚）：
 * 落点只拿得到 evt.item，读不到渲染源里的 batch 对象 ⇒ version 必须随 DOM 一起搬过来。
 * 传 `version: undefined` 时**不写该 dataset**，用来复现「卡片没填 version」的形态。
 */
function dragEvent(
  dataset: { batchId: string; version?: number },
  fromDataset: Record<string, string> = {},
) {
  const item = document.createElement('div');
  item.dataset.batchId = dataset.batchId;
  if (dataset.version !== undefined) item.dataset.batchVersion = String(dataset.version);
  const from = document.createElement('div');
  for (const [k, v] of Object.entries(fromDataset)) from.dataset[k] = v;
  return { item, from };
}

/** 全部 move 用例的卡片 version（真形态是整数 OCC 锚）。 */
const CARD_VERSION = 11;

describe('WorkerColumn（拖拽落点分发）', () => {
  beforeEach(() => {
    captured.calls.length = 0;
    captured.starts.length = 0;
    apiCalls.length = 0;
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

  it('W2：候选池源 → moveBatchToWorker(batchId, version, 本列工人, 卡片真实货架)', async () => {
    const moveBatchToWorker = vi.fn(async () => true);
    const moveBatchBetweenWorkers = vi.fn(async () => true);
    const wrapper = mountColumn([makeHeld()], { moveBatchToWorker, moveBatchBetweenWorkers });
    const options = capturedOptions();

    // 源容器 = PoolDrawer 的 .pool-cards（只有 data-process-id），卡片带 data-shelf-id
    recordPoolSource('3000000000009', {
      processId: '2000000000001',
      shelfId: '5000000000009',
    });
    (options.onStart as (e: unknown) => void)(dragEvent({ batchId: '3000000000009', version: CARD_VERSION }));
    await (options.onAdd as (e: unknown) => Promise<void>)(dragEvent({ batchId: '3000000000009', version: CARD_VERSION }));

    expect(moveBatchToWorker).toHaveBeenCalledTimes(1);
    expect(moveBatchToWorker).toHaveBeenCalledWith(
      '3000000000009',
      CARD_VERSION,
      SELF_WORKER_ID,
      '5000000000009',
    );
    expect(moveBatchBetweenWorkers).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('W2b（2026-10-08）：卡片没带 data-batch-version → 实参是 NaN（守卫在 useQueueMove）', async () => {
    // 回归 guard：move 的 version 是后端必填的 OCC 锚，而落点只能从 DOM 读。卡片缺该
    // dataset（某个适配层忘了填 version）时**不能退化成 0** —— 0 是形态合法的假 version，
    // 会让后端按 OCC 冲突（40901）拒一次用户没做错的投放。正确形态是 NaN，由
    // useQueueMove 的 version 守卫拦下（warning + 早退，零请求；守卫本身由
    // useQueueMove.spec.ts 守）。
    // 形参显式声明（含 version）：断言要读 calls[0][1]
    const moveBatchToWorker = vi.fn(async (_batchId: string, _version: number) => true);
    const wrapper = mountColumn([makeHeld()], { moveBatchToWorker });
    const options = capturedOptions();

    recordPoolSource('3000000000009', {
      processId: '2000000000001',
      shelfId: '5000000000009',
    });
    await (options.onAdd as (e: unknown) => Promise<void>)(
      dragEvent({ batchId: '3000000000009' }),
    );

    expect(moveBatchToWorker).toHaveBeenCalledTimes(1);
    expect(moveBatchToWorker.mock.calls[0]![1]).toBeNaN();
    wrapper.unmount();
  });

  it('W3：工人源（另一名工人）→ moveBatchBetweenWorkers(batchId, version, 源工人, 本列工人)，且不发 POOL→WORKER', async () => {
    const moveBatchToWorker = vi.fn(async () => true);
    const moveBatchBetweenWorkers = vi.fn(async () => true);
    const wrapper = mountColumn([makeHeld()], { moveBatchToWorker, moveBatchBetweenWorkers });
    const options = capturedOptions();

    // 源容器 = 另一个工人列（data-worker-id = 源工人）
    const evt = dragEvent({ batchId: '3000000000009', version: CARD_VERSION }, { workerId: '1900000000001' });
    (options.onStart as (e: unknown) => void)(evt);
    await (options.onAdd as (e: unknown) => Promise<void>)(evt);

    expect(moveBatchBetweenWorkers).toHaveBeenCalledTimes(1);
    expect(moveBatchBetweenWorkers).toHaveBeenCalledWith(
      '3000000000009',
      CARD_VERSION,
      '1900000000001',
      SELF_WORKER_ID,
    );
    expect(moveBatchToWorker).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('W4：拖回自己那一列 → 两个包装都不调（不构成一次移动）', async () => {
    const moveBatchToWorker = vi.fn(async () => true);
    const moveBatchBetweenWorkers = vi.fn(async () => true);
    const wrapper = mountColumn([makeHeld()], { moveBatchToWorker, moveBatchBetweenWorkers });
    const options = capturedOptions();

    const evt = dragEvent({ batchId: '3000000000009', version: CARD_VERSION }, { workerId: SELF_WORKER_ID });
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

    await (options.onAdd as (e: unknown) => Promise<void>)(dragEvent({ batchId: '3000000000009', version: CARD_VERSION }));

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
    expect((col.element as HTMLElement).dataset.workerId).toBe(SELF_WORKER_ID);
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
    expect((col.element as HTMLElement).dataset.workerId).toBe(SELF_WORKER_ID);
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

  it('W14：容量三字段直接渲染 props（无「加载中」中间态与占位分支）', () => {
    // 2026-10-08：数据由父级 tab 一次请求到齐，列内不再有 loading / error 两级互斥
    // 分支，也就没有「max_held / current_held 暂显 …」的占位。断言落在进度条的
    // format 输出上（`current_held/max_held`）—— 若有人把占位分支加回来，这里会看到
    // 「…/…」而不是真实数字。
    const wrapper = mountColumn([makeHeld(), makeHeld({ batch_id: '3000000000002' })]);
    // 两张卡 ⇒ current_held=2 / max_held=3
    expect(wrapper.find('.el-progress-stub').text()).toBe('2/3');
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
    // （BatchCard 的 tooltip 在根**内部**、不包根，所以这里不存在中间层）；容器侧的
    // 节点构成由 W13 守
    const cardEl = cards[1]!.element as HTMLElement;
    expect(cardEl.parentElement?.classList.contains('col-body')).toBe(true);
    wrapper.unmount();
  });

  it('W13（2026-10-06）：Sortable 容器 .col-body 内只有卡片（无注释节点、无包裹层）', () => {
    // 「Sortable 容器的直接子元素必须全是可拖项」。dev 构建保留模板注释，注释节点同样
    // 是容器的直接子节点 —— 有人在容器 div 内留注释就红；为右键菜单加一层包裹
    // 也会让元素子节点数超过卡片数。
    //
    // 2026-10-06 口径说明（两条不变式各守一层，别把两者的断言写法互抄）：
    //   - BatchCardDndFootprint.spec.ts 的 D2 守**第一层**：卡片组件根必须是单元素
    //     （可拖元素 == vnode 的 DOM footprint）。它的宿主用 h() 渲染，children 是
    //     vnode 数组、不经过 Fragment vnode ⇒ 没有锚点 ⇒ 那里 `childNodes` 与
    //     `children` 相等是对的。**本用例的容器是模板编译产物，照搬那个写法必错。**
    //   - 本用例守**第二层**：Sortable 容器的直接子节点只能是卡片。模板里的 keyed
    //     v-for 会编译成 Fragment ⇒ 必然额外留下 2 个空文本锚点（Vue 的 fragment 锚），
    //     实测 2 卡时 children=2 / childNodes=4。
    //
    // 承重的是前两条（元素数 == 卡片数、注释数 == 0）：两者都不依赖上面那个常数，
    // 往容器里塞元素或注释都会红。第三条总数断言只是冗余网 —— 万一将来 Vue 改了
    // fragment 锚点行为，只有它需要跟着更新，且失效方向是假红、不会假绿。
    const wrapper = mountColumn([
      makeHeld({ batch_id: '3000000000001' }),
      makeHeld({ batch_id: '3000000000002', batch_no: 2 }),
    ]);
    const col = wrapper.find('.col-body').element as HTMLElement;
    const nodes = Array.from(col.childNodes);

    expect(nodes.filter((n) => n.nodeType === Node.ELEMENT_NODE)).toHaveLength(2);
    expect(nodes.filter((n) => n.nodeType === Node.COMMENT_NODE)).toHaveLength(0);
    // 冗余网（见上方口径说明）：剩下只能是那两个 fragment 空文本锚点
    expect(nodes).toHaveLength(4);
    for (const child of Array.from(col.children)) {
      // 只认卡片根 div：BatchCard 的 tooltip 在根**内部**（.el-tooltip-stub 包的是
      // 卡片内部的触发区），所以容器的直接子元素里不会出现它 —— 不给这个位置留口子
      expect(child.matches('.batch-card')).toBe(true);
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

  it('W12b：未 provide opener 时右键不抛错（inject 缺省 noop）', async () => {
    // 完全不 provide move 包装与 opener（板级契约缺失的极端形态）⇒ 右键退化为无反应、
    // 拖拽落点退化为 noop，都不炸回调。
    const wrapper = mount(WorkerColumn, {
      props: { worker: makeWorker([makeHeld()]) },
      global: { components: globalConfig.components },
    });
    const card = wrapper.find('.col-body').find('.batch-card');
    await expect(card.trigger('contextmenu')).resolves.not.toThrow();
    wrapper.unmount();
  });

  it('W15：挂载 + 跑完整交互期间对 api 层零请求（N+1 收口的真守卫）', async () => {
    // 这条不变式的守门点在这里，不在 ProcessBoardTab.spec.ts 的 P5。
    //
    // 为什么 P5 顶不住：P5 把 WorkerColumn 整个 vi.mock 成 stub，stub 组件不发请求，
    // 于是「工人列自己多发一次单工人 state 请求」这种 N+1 复发**照样绿** —— P5 只能
    // 挡住「ProcessBoardTab 自己重复请求同一端点」。本用例真挂载 WorkerColumn 及其
    // 子树（BatchCard），并把 `@/api/productionQueue` 整体桩成记账 tripwire：有人把
    // `useWorkerStateByWorkerQuery` 之类自管 query 加回组件，模块在运行期被解析到桩、
    // 立刻记账 ⇒ 本用例红。
    //
    // 断言落在「整个交互窗口内零调用」而不是「mount 当下零调用」：query 常在
    // onMounted / watch(post) 之后才首次触发，只查 mount 当下会漏。
    const wrapper = mountColumn([makeHeld(), makeHeld({ batch_id: '3000000000002' })]);

    // 非空列：跑一次完整拖拽落点（W2 路径）+ 右键（W12 路径）
    const options = capturedOptions();
    recordPoolSource('3000000000009', {
      processId: '2000000000001',
      shelfId: '5000000000009',
    });
    (options.onStart as (e: unknown) => void)(dragEvent({ batchId: '3000000000009', version: CARD_VERSION }));
    await (options.onAdd as (e: unknown) => Promise<void>)(dragEvent({ batchId: '3000000000009', version: CARD_VERSION }));
    await wrapper.findAll('.batch-card')[1]!.trigger('contextmenu', { clientX: 10, clientY: 20 });

    // 空列再挂一次：空列是 POOL→WORKER 的主落点，复发多半落在空列分支上
    const emptyWrapper = mountColumn([]);
    await nextTick();
    expect(emptyWrapper.find('.col-body').exists()).toBe(true);

    await nextTick();
    expect(apiCalls).toEqual([]);
    wrapper.unmount();
    emptyWrapper.unmount();
  });
});
