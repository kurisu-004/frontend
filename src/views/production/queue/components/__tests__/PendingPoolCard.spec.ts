// @vitest-environment happy-dom
// src/views/production/components/__tests__/PendingPoolCard.spec.ts
//
// 2026-09-30 新增：PendingPoolCard 组件 spec —— 单击下发 / 拖拽交互。
// 2026-09-30 重写（懒加载 + 后端 dispatch bulk-only 收敛）：
//   - 组件**不再自管 useWorkerPoolByProcessQuery**，徽标改由 `count` prop 透传
//     （来自 useWorkerPoolCountsQuery 的聚合计数）⇒ P1 反转为「不发请求」guard；
//   - `bulkDispatchMutation` 更名 `dispatchMutation`（后端 dispatch 已 bulk-only，
//     `POST /batches/bulk-dispatch` 端点删除，两 mutation 合并为一个）。
//
// 覆盖：
//   - P1：**零网络请求** —— mount 不调 fetchQueueBoard（懒加载核心 guard：
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
//   - P9：2026-10-02 投放确认守卫 —— onAdd 只认「原生 drop 且落点在本卡内」，
//     dragend（Esc 取消 / 非 Sortable 区域松手）与 target 在本卡外都不得 mutate。
//   - P5b / P10 / P10b：2026-10-02 两条补充语义 —— 落点是卡内**后代元素**也算命中
//     （Node.contains 覆盖后代）；来源必须是待下发池（`data-pending-pool` 标记，
//     Sortable 的 put: true 不做来源白名单）。
//
// 2026-10-04（拖拽投放加二次确认弹窗）：
//   - onAdd 回调变 async：三道守卫 + item/batchId 提取仍在第一个 await 之前同步跑完，
//     守卫命中即静默 return、不弹框；守卫全过才弹确认框，用户取消 ⇒ 不 mutate。
//   - 连带影响：驱动 onAdd 后必须 `await flushPromises()`（或直接 await 回调返回的
//     Promise）再断言 mutate，否则断言会落在 mutate 之前的微任务窗口上（假红 / 假绿）。
//   - P6c / P10b 原先断言「同步不抛」，async 化后异常会变成 unhandled rejection 而非
//     同步 throw ⇒ 改为 `await expect(...).resolves.toBeUndefined()`（真断言 Promise 兑现）。
//   - P11：投放命中 ⇒ 弹一次确认框，message 含该工序 code + name，确认后才 mutate；
//   - P12：确认框 reject（用户取消）⇒ 不 mutate、不发任何请求；
//   - P13：三道守卫任一命中 ⇒ **不弹**确认框（ElMessageBox.confirm 未被调用）。
//
// 测试策略（沿 LoginView.spec.ts 范本）：
//   - vue-test-utils mount + globalConfig.plugins: [[VueQueryPlugin, { queryClient }]]；
//   - vi.mock('@/api/productionQueue') + vi.mock('element-plus') + vi.mock('vue-draggable-plus')。

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
  ElMessageBox: {
    // 默认 resolve（= 用户点确认），beforeEach 会复位
    confirm: vi.fn(async () => undefined),
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

/** 工序看板请求的调用计数（零请求 guard 用）：本卡片不得自管它。 */
const realFetchQueueBoard = vi.fn<(processId: string) => Promise<unknown>>(async (processId) => ({
  process: { process_id: processId, process_code: 'CNC-01', process_name: '粗加工', color: null },
  workers: [],
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

import PendingPoolCard from '../PendingPoolCard.vue';
import type { UseQueueDispatchReturn } from '../../composables/useQueueDispatch';

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
): UseQueueDispatchReturn['dispatchMutation'] {
  return {
    mutate,
    mutateAsync: vi.fn(async () => undefined),
  } as unknown as UseQueueDispatchReturn['dispatchMutation'];
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
 *  即该投放目标容器）。2026-10-04：onAdd 已是 async（确认框），故返回 Promise 版签名。 */
function capturedOnAdd(): (evt: unknown) => Promise<void> {
  expect(captured.calls).toHaveLength(1);
  return captured.calls[0].options.onAdd as (evt: unknown) => Promise<void>;
}

/** 2026-10-02：构造一个「释放在本卡内」的原生 drop 事件投影。
 *  Sortable 派发 add 时把原生事件本体原样挂在 originalEvent 上（vue-draggable-plus
 *  的 handler 组合也透传同一个对象），组件据其 type + target 自证落点。
 *  这里的 originalEvent 只能由测试自造：vi.mock('vue-draggable-plus') 下没有真实
 *  Sortable，也就没有真实的 document 级 drop 监听。 */
function insideDrop(target: Element): { type: string; target: Element } {
  return { type: 'drop', target };
}

/** 2026-10-02：Esc 取消 / 原生拖拽自行终止 ⇒ Sortable 走 _onDrop(dragend)，
 *  此时 onAdd 照样派发（判据只有「父容器变了」），必须由组件的守卫挡掉。 */
function dragEndEvt(target: Element): { type: string; target: Element } {
  return { type: 'dragend', target };
}

/** 2026-10-02：拖拽源容器投影。真实链路里它是 PendingBatchesPanel 的 .pending-cards
 *  （模板上标了 `data-pending-pool="1"`）⇒ 组件的 onDrop 据此做来源白名单。
 *  Sortable 的 `put: true` 布尔形态不做 group 名比对，光有 originalEvent 不足以
 *  证明来源是待下发池。 */
function poolSource(): HTMLElement {
  const el = document.createElement('div');
  el.dataset.pendingPool = '1';
  return el;
}

/** 非待下发池的 Sortable 源（将来页面上出现第二个拖拽列表时的假想来源）——
 *  没有 data-pending-pool 标记，组件必须拒收。 */
function foreignSource(): HTMLElement {
  return document.createElement('div');
}

describe('PendingPoolCard（2026-09-30 懒加载 + bulk-only 收敛）', () => {
  beforeEach(async () => {
    realFetchQueueBoard.mockClear();
    captured.calls.length = 0;
    const { ElMessageBox } = await import('element-plus');
    vi.mocked(ElMessageBox.confirm).mockClear();
    // 默认 = 用户点确认（拖拽投放的二次确认框默认放行，让存量投放用例维持原语义）
    vi.mocked(ElMessageBox.confirm).mockResolvedValue(undefined as never);
  });

  it('P1：mount 不发任何 per-process 详情请求（懒加载核心 guard）', async () => {
    // 回归 guard：本卡位于**默认首屏激活的「待下发」tab**内，且 v-for 全部 INHOUSE
    // 工序。改前每张卡自管 useWorkerPoolByProcessQuery 算 items.length 徽标 ⇒
    // 进页面即打 N 个 `GET /prod/pool/{pid}`（N+1），与「切 tab 才懒加载」的设计
    // 意图完全相反。徽标现已改走 useWorkerPoolCountsQuery（聚合计数，单请求）。
    const wrapper = mountCard(ref(new Set<string>()));
    await flushPromises();
    expect(realFetchQueueBoard).not.toHaveBeenCalled();
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

  it("P2c：count = '…'（父级队列快照加载中占位）原样透传", async () => {
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
    const wrapper = mountCard(
      ref<Set<string>>(new Set(['3000000000001', '3000000000002'])),
      7,
      mutate,
    );
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
    capturedOnAdd()({
      item: { dataset: { batchId: '3000000000009' } },
      from: poolSource(),
      originalEvent: insideDrop(wrapper.find('.pool-card').element),
    });
    // 2026-10-04：onAdd 变 async（确认框），mutate 发生在 await 之后 ⇒ 必须放完微任务
    await flushPromises();
    // 拖拽只发被拖的那一件，**不读 selectedIds**（多选集合只属于单击路径）。
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenCalledWith({
      batchIds: ['3000000000009'],
      targetProcessId: '2000000000001',
    });
    wrapper.unmount();
  });

  it('P5b：落点是卡内**后代元素**（.row / el-tag）时同样算命中 → 触发 mutate', async () => {
    // 语义 guard：真实拖拽里 originalEvent.target 是浏览器算出的指针下最深元素，
    // 几乎不会是卡片根元素本身。组件用 Node.contains 判命中（覆盖后代），若哪天被改成
    // `target === rootEl`，本用例会红。
    const mutate = vi.fn();
    const wrapper = mountCard(ref<Set<string>>(new Set<string>()), 7, mutate);
    await flushPromises();
    capturedOnAdd()({
      item: { dataset: { batchId: '3000000000009' } },
      from: poolSource(),
      // 第 2 行的 .row（内含 el-tag），是典型的「松手落在标签上」落点
      originalEvent: insideDrop(wrapper.findAll('.pool-card .row')[1].element),
    });
    await flushPromises();
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
    capturedOnAdd()({
      item: { dataset: {} },
      from: poolSource(),
      originalEvent: insideDrop(wrapper.find('.pool-card').element),
    });
    // 2026-10-04：放完微任务再断言，避免「短路点被挪到 await 之后」这类回归被漏掉
    await flushPromises();
    expect(mutate).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('P6b：onAdd 收到的 item 为空串 batchId → 不触发 mutate', async () => {
    const mutate = vi.fn();
    const wrapper = mountCard(ref<Set<string>>(new Set<string>()), 7, mutate);
    await flushPromises();
    capturedOnAdd()({
      item: { dataset: { batchId: '' } },
      from: poolSource(),
      originalEvent: insideDrop(wrapper.find('.pool-card').element),
    });
    await flushPromises();
    expect(mutate).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('P6c：onAdd 收到的 evt 无 item（Sortable 目标无有效落点）→ 不抛也不 mutate', async () => {
    const mutate = vi.fn();
    const wrapper = mountCard(ref<Set<string>>(new Set<string>()), 7, mutate);
    await flushPromises();
    // 既无 item 也无 originalEvent ⇒ 投放确认守卫直接短路，返回前不得抛
    // 2026-10-04：onAdd 变 async 后「不抛」要断言 Promise 兑现（异常会走 unhandled
    // rejection 而不是同步 throw，原先的 not.toThrow() 已成空断言）
    await expect(capturedOnAdd()({})).resolves.toBeUndefined();
    expect(mutate).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('P9：originalEvent.type === dragend（Esc 取消 / 外放）→ 不触发 mutate', async () => {
    // 回归 guard：拖到工序卡上（Sortable 已把卡片真实插入目标当占位）后按 Esc，
    // 浏览器触发的是 dragend（该监听挂在被拖节点上，drop 根本不派发），但 _onDrop
    // 仍会因「父容器变了」派发 add ⇒ 组件必须自己挡掉，否则下发一件用户没确认的批次。
    // 覆盖的场景之一：指针在卡片间隙 / 面板空白 / 工具条 / tab 条上松手 —— 那些区域
    // 不在任何 Sortable 容器内，没人 preventDefault 过 dragover ⇒ 浏览器同样改派
    // dragend。
    const mutate = vi.fn();
    const wrapper = mountCard(ref<Set<string>>(new Set<string>()), 7, mutate);
    await flushPromises();
    capturedOnAdd()({
      item: { dataset: { batchId: '3000000000009' } },
      from: poolSource(),
      originalEvent: dragEndEvt(wrapper.find('.pool-card').element),
    });
    await flushPromises();
    expect(mutate).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('P9b：originalEvent.type === drop 但 target 不在本卡内 → 不触发 mutate', async () => {
    // 回归 guard：第二道守卫（落点自证）真正覆盖的是「drop 落在另一个 Sortable 容器
    // 内」——典型是指针从本卡回到待下发池 .pending-cards 后松手，那里是已注册的
    // Sortable，dragover 被 preventDefault ⇒ 真的派发 drop 并冒泡到 document，可
    // target 在本卡之外。
    const mutate = vi.fn();
    const wrapper = mountCard(ref<Set<string>>(new Set<string>()), 7, mutate);
    await flushPromises();
    capturedOnAdd()({
      item: { dataset: { batchId: '3000000000009' } },
      from: poolSource(),
      originalEvent: insideDrop(document.createElement('div')),
    });
    await flushPromises();
    expect(mutate).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('P10：来源不是待下发池（无 data-pending-pool 标记）→ 不触发 mutate', async () => {
    // 业务规则 guard：「只有待下发池能投放到工序卡」。Sortable 的 checkPut 在布尔形态
    // （put: true）下直接 return true、不做 group 名比对，将来页面上出现第二个
    // Sortable 列表时，从它那里拖一张卡进来同样会触发 onAdd。旧实现读
    // dataTransfer.getData('text/plain') 而 Sortable 写的是 'Text' 槽位，恰好免疫 ——
    // 那条免疫是偶然的，现在没了，所以来源白名单必须由组件自己钉。
    const mutate = vi.fn();
    const wrapper = mountCard(ref<Set<string>>(new Set<string>()), 7, mutate);
    await flushPromises();
    capturedOnAdd()({
      item: { dataset: { batchId: '3000000000009' } },
      from: foreignSource(),
      // 其余判据全部通过：drop 事件 + 落点在本卡内 ⇒ 只有来源这一条能挡住
      originalEvent: insideDrop(wrapper.find('.pool-card').element),
    });
    await flushPromises();
    expect(mutate).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('P10b：evt 完全缺 from（异常形态）→ 不触发 mutate 且不抛', async () => {
    const mutate = vi.fn();
    const wrapper = mountCard(ref<Set<string>>(new Set<string>()), 7, mutate);
    await flushPromises();
    // 2026-10-04：async 化后「不抛」改断言 Promise 兑现（理由同 P6c）
    await expect(
      capturedOnAdd()({
        item: { dataset: { batchId: '3000000000009' } },
        originalEvent: insideDrop(wrapper.find('.pool-card').element),
      }),
    ).resolves.toBeUndefined();
    expect(mutate).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('P11：投放命中 → 弹一次确认框（文案含工序 code + name），确认后才 mutate', async () => {
    // 需求 guard：手动拖批次到工序卡是不可逆写操作、手滑高发，mutate 前必须有一次确认。
    // 弹窗只报工序名（卡片 DOM 上只有 data-batch-id，批次号 / 零件名在另一面板的
    // batches 里，接线成本不值）。
    const { ElMessageBox } = await import('element-plus');
    const mutate = vi.fn();
    const wrapper = mountCard(ref<Set<string>>(new Set<string>()), 7, mutate);
    await flushPromises();
    const root = wrapper.find('.pool-card').element;
    const dropped = capturedOnAdd()({
      item: { dataset: { batchId: '3000000000009' } },
      from: poolSource(),
      originalEvent: insideDrop(root),
    });
    // 确认框未决 ⇒ 还没下发
    expect(ElMessageBox.confirm).toHaveBeenCalledTimes(1);
    const [message, title] = vi.mocked(ElMessageBox.confirm).mock.calls[0]!;
    expect(title).toBe('确认下发');
    expect(message).toContain('CNC-01');
    expect(message).toContain('粗加工');
    expect(mutate).not.toHaveBeenCalled();
    await dropped;
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenCalledWith({
      batchIds: ['3000000000009'],
      targetProcessId: '2000000000001',
    });
    wrapper.unmount();
  });

  it('P12：确认框 reject（用户取消）→ 不 mutate、不发任何请求', async () => {
    const { ElMessageBox } = await import('element-plus');
    vi.mocked(ElMessageBox.confirm).mockRejectedValueOnce('cancel' as never);
    const mutate = vi.fn();
    const wrapper = mountCard(ref<Set<string>>(new Set<string>()), 7, mutate);
    await flushPromises();
    await capturedOnAdd()({
      item: { dataset: { batchId: '3000000000009' } },
      from: poolSource(),
      originalEvent: insideDrop(wrapper.find('.pool-card').element),
    });
    await flushPromises();
    expect(ElMessageBox.confirm).toHaveBeenCalledTimes(1);
    expect(mutate).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('P13：三道守卫任一命中 → 不弹确认框（静默丢弃，不打扰用户）', async () => {
    // 守卫是「这次根本不算投放」，此时弹框等于让用户为一个不会发生的下发做决策
    //（按 Esc 取消后还得再点一次「取消」才能消掉弹窗）⇒ 守卫必须整体前置于 await。
    const { ElMessageBox } = await import('element-plus');
    const mutate = vi.fn();
    const wrapper = mountCard(ref<Set<string>>(new Set<string>()), 7, mutate);
    await flushPromises();
    const onAdd = capturedOnAdd();
    const root = wrapper.find('.pool-card').element;
    // 第一道：完成事件不是 drop（Esc 取消 / 非 Sortable 区域松手）
    onAdd({
      item: { dataset: { batchId: '3000000000009' } },
      from: poolSource(),
      originalEvent: dragEndEvt(root),
    });
    // 第二道：落点不在本卡内
    onAdd({
      item: { dataset: { batchId: '3000000000009' } },
      from: poolSource(),
      originalEvent: insideDrop(document.createElement('div')),
    });
    // 第三道：来源不是待下发池
    onAdd({
      item: { dataset: { batchId: '3000000000009' } },
      from: foreignSource(),
      originalEvent: insideDrop(root),
    });
    await flushPromises();
    expect(ElMessageBox.confirm).not.toHaveBeenCalled();
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
