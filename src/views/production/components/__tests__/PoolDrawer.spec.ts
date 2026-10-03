// @vitest-environment happy-dom
// src/views/production/components/__tests__/PoolDrawer.spec.ts
//
// 2026-10-03 review 第 2 轮新增：PoolDrawer 的 Sortable 接线 guard。
// 本组件此前**零测试**，而「DOM 放回必须 WorkerColumn / PoolDrawer 两处都挂」正是
// 二参重载方案的唯一正确性前提 —— 少挂一处就漏一种来源的投放失败（幻影节点留在池里
// 或工人列里，invalidate 清不掉），且这种缺陷在真机上表现为「同一位置两张同批次卡」
// 逐次累积，单靠手点刷新也恢复不了。
//
// 覆盖：
//   - D1：Sortable 用二参重载（不传 list）+ group 与工人列同名（跨容器投放的前提）。
//   - D2：sort: false 且不带 onMove（池内重排由 Sortable 的 sort 开关关掉；
//     onMove 只从**源**实例读取，挂在落点侧覆盖不了「工人列拖进池时的池内重排」）。
//   - D3：onRemove 把被拖节点放回 `from.children[oldIndex]`（DOM 下标）—— 与
//     WorkerColumn 侧 W10 对称，两处缺一不可。
//   - D4：撤回投放（onStart 记工人源 → onAdd 消费）调 moveBatchToPool，
//     to.shelf_id 取当前激活货架；无工人源时不发请求。
//   - D5：目标货架为空 → ElMessage.warning 且不发请求。
//
// 测试策略：
//   - vi.mock('vue-draggable-plus') 捕获 useDraggable 的入参与 options（happy-dom
//     无头环境无法模拟 Sortable 的 _onDragOver / _onDrop，options 回调就是组件与
//     库之间唯一的契约面）；
//   - dndSourceTracker 用真实实现：onStart 记、onAdd 取的配对本身是被测行为的一半；
//   - EP 组件 stub（el-tag / el-tooltip）+ vi.mock('element-plus') 把 ElMessage
//     桩成 no-op。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick, ref, type ComputedRef } from 'vue';
import { mount } from '@vue/test-utils';
import type { BatchCardModel } from '@/types/batchCard';
import type { ProcessPoolView } from '@/types/workerPool';

const captured = vi.hoisted(() => ({
  calls: [] as { list: unknown; options: Record<string, unknown> }[],
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

import PoolDrawer from '../PoolDrawer.vue';
// 工人源由**源侧** WorkerColumn 的 onStart 写入（跨组件通道，PoolDrawer 只在 onAdd
// 消费），本 spec 直接用真实实现补上那一半，模拟「从工人列拖进工序池」。
import { recordWorkerSource } from '@/utils/dndSourceTracker';

const ElTagStub = defineComponent({
  name: 'ElTagStub',
  props: { type: String, size: String },
  setup(_, { slots }) {
    return () => h('span', { class: 'el-tag-stub' }, slots.default?.());
  },
});
const ElTooltipStub = defineComponent({
  name: 'ElTooltipStub',
  props: {
    placement: String,
    showAfter: Number,
    disabled: Boolean,
    content: { type: [String, Object] as unknown as () => string | Record<string, unknown> },
  },
  setup(_, { slots }) {
    return () =>
      h('div', { class: 'el-tooltip-stub' }, [
        h('div', { class: 'el-tooltip-stub__body' }, slots.default?.()),
        h('div', { class: 'el-tooltip-stub__content' }, slots.content?.()),
      ]);
  },
});

const globalConfig = {
  components: { ElTag: ElTagStub, ElTooltip: ElTooltipStub },
};

const PROCESS_ID = '2000000000001';

function makeCard(overrides: Partial<BatchCardModel> = {}): BatchCardModel {
  return {
    batch_id: '3000000000001',
    part_id: '4000000000001',
    batch_no: 'B1024',
    part_name: '连杆',
    drawing_no: 'DRW-1',
    serial_no: 'SN-0001',
    quantity: 12,
    system_delivery_date: '2026-10-20',
    planned_delivery_date: null,
    is_urgent: false,
    has_cnc_program: false,
    customer_l1: '某某集团',
    customer_l2: '某某零件厂',
    applicant_name: '张三',
    note: null,
    location: 'A-01',
    shelf_id: '5000000000001',
    ...overrides,
  };
}

function makePool(batches: BatchCardModel[] = [makeCard()]): ProcessPoolView {
  return {
    process_id: PROCESS_ID,
    process_code: 'CNC-01',
    process_name: '粗加工',
    batches,
  };
}

function mountDrawer(
  pool: ProcessPoolView | null = makePool(),
  provided: Record<string, unknown> = {},
) {
  return mount(PoolDrawer, {
    props: { pool },
    global: {
      components: globalConfig.components,
      provide: {
        shelfId: ref('5000000000009') as unknown as ComputedRef<string>,
        moveBatchToPool: vi.fn(async () => true),
        ...provided,
      },
    },
  });
}

/** Sortable 捕获到的 options（本 spec 只 mount 一个抽屉 ⇒ 恒 1 条记录）。 */
function capturedOptions(): Record<string, unknown> {
  expect(captured.calls).toHaveLength(1);
  return captured.calls[0].options;
}

/** 造一个 Sortable 原生事件的最小载荷：item 是工人列里的卡片，from 是那个工人列。
 *  源侧的 recordWorkerSource 由 WorkerColumn 负责，本抽屉的 onStart 记的是**池**源，
 *  与撤回路径无关，故这里不驱动本组件的 onStart。 */
function workerDragEvent(
  batchId: string,
  shelfId = '',
  workerId = '1900000000001',
): { item: HTMLElement; from: HTMLElement } {
  const item = document.createElement('div');
  item.dataset.batchId = batchId;
  item.dataset.shelfId = shelfId;
  const from = document.createElement('div');
  from.dataset.workerId = workerId;
  // 源侧 WorkerColumn.onDragStart 的真实效果
  recordWorkerSource(batchId, workerId);
  return { item, from };
}

describe('PoolDrawer（2026-10-03 review 第 2 轮 Sortable 接线）', () => {
  beforeEach(() => {
    captured.calls.length = 0;
    captured.starts.length = 0;
  });

  it('D1：Sortable 用二参重载（不传 list），group 与工人列同名', () => {
    const wrapper = mountDrawer();
    expect(captured.calls[0].list).toBeNull();
    const options = capturedOptions();
    expect(options.group).toBe('work-orders');
    expect(typeof options.onStart).toBe('function');
    expect(typeof options.onAdd).toBe('function');
    wrapper.unmount();
  });

  it('D2：池内重排由 sort:false 关掉，不用 onMove 守卫', () => {
    const wrapper = mountDrawer();
    const options = capturedOptions();
    // 候选池顺序由后端排定，本就无重排语义；二参形态下库不挂内建 onUpdate，重排后
    // 无人回滚 DOM 顺序。sort 只在「落点实例 === 拖拽起点实例」时被 Sortable 读取，
    // 跨实例投放走 group 的 checkPull / checkPut，不看它。
    expect(options.sort).toBe(false);
    expect(options.onMove).toBeUndefined();
    wrapper.unmount();
  });

  it('D3：onRemove 把被拖节点放回 from.children[oldIndex]（与 WorkerColumn 对称）', () => {
    const wrapper = mountDrawer();
    const onRemove = capturedOptions().onRemove as (e: unknown) => void;
    // 回归 guard：本容器既是源（工序池 → 工人列）又是落点（工人列 → 工序池），
    // 二参形态下库不挂内建 onRemove，缺了它「撤回失败（20507 货架未映射等）」时卡片
    // 永久留在池里，而 invalidate 救不回来（两侧 query 数据都没变，Vue 只
    // patchElement，不会删不在 vdom 里的外来节点）。
    expect(typeof onRemove).toBe('function');

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

    onRemove({ item: card, from: source, oldIndex: 1 });

    expect(card.parentElement).toBe(source);
    expect(Array.from(source.children).map((el) => el.id)).toEqual(['a', 'card', 'c']);
    expect(target.children).toHaveLength(0);
    wrapper.unmount();
  });

  it('D3b：oldIndex 越界时退回追加到末尾（等价库内建实现的 appendChild 退化）', () => {
    const wrapper = mountDrawer();
    const onRemove = capturedOptions().onRemove as (e: unknown) => void;
    const source = document.createElement('div');
    const a = document.createElement('div');
    const card = document.createElement('div');
    source.appendChild(a);

    // 源容器只剩 1 个子节点却报 oldIndex = 5 ⇒ children[5] 为 undefined
    onRemove({ item: card, from: source, oldIndex: 5 });

    expect(Array.from(source.children)).toEqual([a, card]);
    wrapper.unmount();
  });

  it('D3c：oldIndex 缺失时不抛，落点容器被清空', () => {
    const wrapper = mountDrawer();
    const onRemove = capturedOptions().onRemove as (e: unknown) => void;
    const source = document.createElement('div');
    const target = document.createElement('div');
    const card = document.createElement('div');
    target.appendChild(card);

    expect(() => onRemove({ item: card, from: source })).not.toThrow();
    expect(card.parentElement).toBe(source);
    expect(target.children).toHaveLength(0);
    wrapper.unmount();
  });

  it('D4：撤回投放（工人源）→ moveBatchToPool(batchId, 源工人, 当前激活货架)', async () => {
    const moveBatchToPool = vi.fn(async () => true);
    const wrapper = mountDrawer(makePool(), { moveBatchToPool });
    const options = capturedOptions();

    // 源容器 = WorkerColumn 的 .col-body（data-worker-id）
    const evt = workerDragEvent('3000000000009');
    await (options.onAdd as (e: unknown) => Promise<void>)(evt);

    expect(moveBatchToPool).toHaveBeenCalledTimes(1);
    expect(moveBatchToPool).toHaveBeenCalledWith('3000000000009', '1900000000001', '5000000000009');
    wrapper.unmount();
  });

  it('D4b：拿不到工人源（不是从工人列拖来的）→ 不发请求', async () => {
    const moveBatchToPool = vi.fn(async () => true);
    const wrapper = mountDrawer(makePool(), { moveBatchToPool });
    const options = capturedOptions();

    // 只有 batchId，onStart 未记录过工人源
    const item = document.createElement('div');
    item.dataset.batchId = '3000000000009';
    await (options.onAdd as (e: unknown) => Promise<void>)({
      item,
      from: document.createElement('div'),
    });

    expect(moveBatchToPool).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('D5：目标货架为空 → ElMessage.warning 且不发请求', async () => {
    const { ElMessage } = await import('element-plus');
    const moveBatchToPool = vi.fn(async () => true);
    const wrapper = mountDrawer(makePool(), {
      moveBatchToPool,
      shelfId: ref('') as unknown as ComputedRef<string>,
    });
    const options = capturedOptions();

    const evt = workerDragEvent('3000000000009');
    await (options.onAdd as (e: unknown) => Promise<void>)(evt);

    expect(ElMessage.warning).toHaveBeenCalledWith('请先选择目标货架');
    expect(moveBatchToPool).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('D6：pool 为 null 时走「无工序数据」分支，不渲染 Sortable 容器', async () => {
    const wrapper = mountDrawer(null);
    await nextTick();
    expect(wrapper.find('.pool-cards').exists()).toBe(false);
    expect(wrapper.find('.pool-empty').exists()).toBe(true);
    // containerRef 恒 null ⇒ useLazyDraggable 的 watch 走 destroy 分支，无实例。
    // 记录仍在 captured.calls 里（useDraggable 在 setup 期就调了），但 start 未被调。
    expect(captured.starts).toHaveLength(0);
    wrapper.unmount();
  });

  it('D7：卡片渲染在 .pool-cards 内并带 data-shelf-id（move 的 from.shelf_id 来源）', () => {
    const wrapper = mountDrawer(makePool([makeCard({ batch_id: '3000000000001' })]));
    const body = wrapper.find('.pool-cards');
    expect(body.exists()).toBe(true);
    expect(body.attributes('data-process-id')).toBe(PROCESS_ID);
    const card = body.find('.batch-card');
    expect(card.exists()).toBe(true);
    // 候选池跨所有货架，from.shelf_id 必须是卡片自带的真实货架而非当前激活货架
    expect(card.attributes('data-shelf-id')).toBe('5000000000001');
    wrapper.unmount();
  });

  it('D8：onStart 记的是**池**源 { processId, shelfId }（供工人列的 onAdd 消费）', async () => {
    const wrapper = mountDrawer();
    const options = capturedOptions();
    const batchId = '3000000000007';

    // 从池里拖出：from 是本容器（data-process-id），卡片自带 data-shelf-id
    const item = document.createElement('div');
    item.dataset.batchId = batchId;
    item.dataset.shelfId = '5000000000007';
    const from = document.createElement('div');
    from.dataset.processId = PROCESS_ID;
    (options.onStart as (e: unknown) => void)({ item, from });

    // 本抽屉不消费池源，但记录必须落库：消费方是 WorkerColumn 的 onAdd（POOL→WORKER）
    const { consumePoolSource } = await import('@/utils/dndSourceTracker');
    expect(consumePoolSource(batchId)).toEqual({ processId: PROCESS_ID, shelfId: '5000000000007' });
    wrapper.unmount();
  });
});
