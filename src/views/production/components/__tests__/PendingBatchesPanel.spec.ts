// @vitest-environment happy-dom
// src/views/production/components/__tests__/PendingBatchesPanel.spec.ts
//
// 2026-10-02 新增：PendingBatchesPanel.vue 组件 spec —— 待下发批次列（Sortable
// 拖拽**源**）。聚焦新增的「拖入工序卡高亮」事件源：Sortable 的 _onMove 只从被拖起
// 的容器（源）取 options.onMove，投放目标（工序卡）侧挂了在真机上永不触发 ⇒ 高亮态
// 必须由本容器上报 process.id，父级 WorkerQueueBoard 落到 PendingPoolCard 的
// dropping prop。本 spec 就是这条跨组件链路的回归 guard。
//
// 覆盖：
//   - H1：Sortable 配置挂在源容器上（三参重载：el + list + options）。
//   - H1b：源容器带 data-pending-pool 标记（投放侧来源白名单的锚点，见 PendingPoolCard）。
//   - H2：onMove 的 evt.related = 悬停的工序卡根 div → emit hover-process(该工序 id)。
//   - H3：onMove 的 related 缺 dataset.processId / 为 null → emit hover-process(null)。
//   - H4：onEnd → emit hover-process(null)（落在工序卡上 / 中途取消都会走，不会残留）。
//   - H4b：onStart → emit hover-process(null)（防御性复位：拖拽开始即清零，覆盖 onEnd
//     尚未触发的窗口；不是某条具体残留场景的回归守卫）。
//   - H5：渲染 batch 列表（BatchCard）+ 全选 / 自动下发工具条基本接线。
//
// 测试策略：
//   - vi.mock('vue-draggable-plus') 捕获 useDraggable 的 options，再手动驱动回调
//     （Sortable 的 _onDragOver / _onMove 由指针坐标驱动，happy-dom 无头环境无法模拟；
//     options 回调就是组件与 Sortable 之间唯一的契约面）。
//   - EP 组件 stub：el-checkbox / el-button / el-skeleton / el-empty + el-tooltip
//     （BatchCard 用）+ el-checkbox（BatchCard 勾选角标用）。
//   - 组件自身不发请求（batches 走 prop），故无需 QueryClient。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref, type PropType } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import PendingBatchesPanel from '../PendingBatchesPanel.vue';
import type { PendingBatchItemDto } from '@/api/workerPool.contract';
import type { UsePendingDispatchReturn } from '@/views/production/composables/usePendingDispatch';

const captured = vi.hoisted(() => ({
  calls: [] as { list: unknown; options: Record<string, unknown> }[],
}));

vi.mock('vue-draggable-plus', () => ({
  // 必须自己复刻 vue-draggable-plus 的重载判定，否则二参重载的 options 会被误当 list。
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
  props: {
    modelValue: { type: [Boolean, String, Number], default: false },
    indeterminate: Boolean,
  },
  emits: ['change', 'update:modelValue'],
  setup(props, { emit, slots }) {
    return () =>
      h('label', { class: 'el-checkbox-stub' }, [
        h('input', {
          class: 'el-checkbox-stub__input',
          type: 'checkbox',
          checked: props.modelValue === true,
          // 用户点一下 = 模型值取反（EP 真实 el-checkbox 同语义：派发新的勾选值）
          onChange: () => emit('change', !props.modelValue),
        }),
        slots.default?.(),
      ]);
  },
});

const ElButtonStub = defineComponent({
  name: 'ElButtonStub',
  props: { type: String, size: String, loading: Boolean, disabled: Boolean },
  emits: ['click'],
  setup(props, { emit, slots }) {
    return () =>
      h(
        'button',
        {
          class: 'el-button-stub',
          disabled: props.disabled,
          onClick: () => emit('click'),
        },
        slots.default?.(),
      );
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
  setup(_, { slots }) {
    return () => h('div', { class: 'el-empty-stub' }, slots.default?.());
  },
});

const globalConfig = {
  components: {
    ElTooltip: ElTooltipStub,
    ElCheckbox: ElCheckboxStub,
    ElButton: ElButtonStub,
    ElSkeleton: ElSkeletonStub,
    ElEmpty: ElEmptyStub,
  },
};

function makeDto(overrides: Partial<PendingBatchItemDto> = {}): PendingBatchItemDto {
  return {
    batch_id: '3000000000009',
    part_id: '4000000000001',
    batch_no: 1024,
    quantity: 12,
    serial_no: 'SN-0001',
    name: '连杆',
    drawing_no: 'DRW-1',
    planned_delivery_date: null,
    system_delivery_date: '2026-10-20',
    customer_name: '某某零件厂',
    parent_customer_name: '某某集团',
    applicant_name: '张三',
    is_urgent: false,
    note: null,
    version: 1,
    current_process_step_id: '0',
    process_chain_id: '6000000000001',
    ...overrides,
  };
}

/** 构造一个「工序卡根 div」形状的 related：Sortable 的 _onDragOver 在目标容器内
 *  找不到匹配 `draggable` 的子元素（工序卡用 `.never` ⇒ 必然找不到）时，把 related
 *  退化成容器元素本身。 */
function fakeProcessCardEl(processId?: string): HTMLElement {
  const el = document.createElement('div');
  if (processId !== undefined) el.dataset.processId = processId;
  return el;
}

function mountPanel(
  batches: PendingBatchItemDto[] = [makeDto()],
  extra: {
    selected?: string[];
    setSelectedIds?: (ids: string[]) => void;
    autoDispatchMutate?: ReturnType<typeof vi.fn>;
  } = {},
) {
  return mount(PendingBatchesPanel, {
    props: {
      batches,
      total: batches.length,
      isLoading: false,
      selectedIds: ref<Set<string>>(new Set<string>(extra.selected ?? [])),
      setSelectedIds: extra.setSelectedIds ?? vi.fn(),
      autoDispatchMutation: {
        mutate: extra.autoDispatchMutate ?? vi.fn(),
        isPending: ref(false),
      } as unknown as UsePendingDispatchReturn['autoDispatchMutation'],
    },
    global: globalConfig,
  });
}

/** 取出本面板 Sortable 配置（useLazyDraggable 内部三参重载：el + list + options）。 */
function capturedOptions(): Record<string, unknown> {
  expect(captured.calls).toHaveLength(1);
  return captured.calls[0].options;
}

describe('PendingBatchesPanel（2026-10-02 拖入高亮事件源）', () => {
  beforeEach(() => {
    captured.calls.length = 0;
  });

  it('H1：Sortable 配置挂在源容器上，且带 list（本面板是可拖源，工序卡侧是纯目标）', async () => {
    const wrapper = mountPanel();
    await flushPromises();
    const call = captured.calls[0];
    expect(call.list).not.toBeNull();
    const options = capturedOptions();
    expect(typeof options.onMove).toBe('function');
    expect(typeof options.onEnd).toBe('function');
    // 池内不重排 + 不接收外部投放：顺序由后端排定，投放目标是工序卡容器
    expect(options.sort).toBe(false);
    expect(options.group).toMatchObject({ name: 'pending-batches', put: false, pull: true });
    wrapper.unmount();
  });

  it('H1b：拖拽源容器带 data-pending-pool 标记（投放侧来源白名单的锚点）', async () => {
    // PendingPoolCard.onDrop 用 evt.from.dataset.pendingPool 判来源：Sortable 的
    // `put: true` 布尔形态不做 group 名比对，任何 Sortable 来源都会被 onAdd 接受。
    // 本用例钉住标记的存在 —— 标记一旦从模板上被删掉，来源白名单会静默变成
    // 「拒收一切投放」，而该失败点只落在 PendingPoolCard 侧，很难定位。
    const wrapper = mountPanel();
    await flushPromises();
    const el = wrapper.find('.pending-cards');
    expect(el.exists()).toBe(true);
    expect((el.element as HTMLElement).dataset.pendingPool).toBe('1');
    wrapper.unmount();
  });

  it('H2：onMove 悬停到工序卡 → emit hover-process(该工序 id)', async () => {
    const wrapper = mountPanel();
    await flushPromises();
    const onMove = capturedOptions().onMove as (evt: unknown) => void;
    onMove({ related: fakeProcessCardEl('2000000000001') });
    // 事件名 camelCase：模板侧 @hover-process 编译成同一个 handler key（onHoverProcess）
    expect(wrapper.emitted('hoverProcess')).toEqual([['2000000000001']]);
    wrapper.unmount();
  });

  it('H3：related 缺 processId / 为 null → emit hover-process(null)', async () => {
    const wrapper = mountPanel();
    await flushPromises();
    const onMove = capturedOptions().onMove as (evt: unknown) => void;
    onMove({ related: fakeProcessCardEl() });
    onMove({ related: null });
    // 悬停回到待下发池内部（related 不是工序卡）时必须派 null，否则旧高亮残留
    expect(wrapper.emitted('hoverProcess')).toEqual([[null], [null]]);
    wrapper.unmount();
  });

  it('H4：onEnd → emit hover-process(null)（落在工序卡上与中途取消都会走到）', async () => {
    const wrapper = mountPanel();
    await flushPromises();
    const options = capturedOptions();
    (options.onMove as (evt: unknown) => void)({ related: fakeProcessCardEl('2000000000001') });
    (options.onEnd as (evt: unknown) => void)({});
    expect(wrapper.emitted('hoverProcess')).toEqual([['2000000000001'], [null]]);
    wrapper.unmount();
  });

  it('H4b：onStart 单独触发 → emit hover-process(null)（防御性复位）', async () => {
    // 这是**防御性复位**的契约锚点，不是某条具体残留场景的回归守卫：onStart 每次
    // 拖拽只触发一次，且必然先于本次拖拽的首次 onMove，所以真实拖拽里不可能出现
    // 「onMove 在前、onStart 在后」的顺序。「从工序卡 A 拖回待下发池」这条路径上
    // isOwner 的 revert 分支自己就会派发 onMove(related=源容器) ⇒ 高亮本来就会被清。
    // 它的价值只在覆盖「onEnd 尚未触发」的窗口，成本一次 emit。
    const wrapper = mountPanel();
    await flushPromises();
    (capturedOptions().onStart as (evt: unknown) => void)({});
    expect(wrapper.emitted('hoverProcess')).toEqual([[null]]);
    wrapper.unmount();
  });

  it('H5：渲染 batch 列表（BatchCard）+ 勾选 / 自动下发基本接线', async () => {
    const setSelectedIds = vi.fn();
    const wrapper = mountPanel(
      [
        makeDto({ batch_id: '3000000000009' }),
        makeDto({ batch_id: '3000000000010', name: '齿轮' }),
      ],
      { setSelectedIds },
    );
    await flushPromises();
    const cards = wrapper.findAll('.batch-card');
    expect(cards).toHaveLength(2);
    expect(cards[0].attributes('data-batch-id')).toBe('3000000000009');
    expect(wrapper.text()).toContain('总计 2 件待下发');
    // 待下发池是唯一有勾选语义的场景 ⇒ BatchCard 一律 selectable
    expect(cards[0].classes()).toContain('is-selectable');

    // 工具条「全选」：勾上 → setSelectedIds 收全量 id
    expect(wrapper.text()).toContain('已选 0 件');
    await wrapper.find('.el-checkbox-stub__input').trigger('change');
    expect(setSelectedIds).toHaveBeenCalledWith(['3000000000009', '3000000000010']);
    wrapper.unmount();
  });

  it('H5b：自动下发按钮随选中数启用，空选中时不发请求', async () => {
    const autoDispatchMutate = vi.fn();
    const empty = mountPanel([makeDto()], { autoDispatchMutate });
    await flushPromises();
    // 无选中 → 按钮 disabled（不发请求的入口被 UI 层挡住）
    expect(empty.find('.el-button-stub').attributes('disabled')).toBeDefined();
    empty.unmount();

    const selected = mountPanel([makeDto()], {
      autoDispatchMutate,
      selected: ['3000000000009'],
    });
    await flushPromises();
    expect(selected.find('.el-button-stub').attributes('disabled')).toBeUndefined();
    await selected.find('.el-button-stub').trigger('click');
    expect(autoDispatchMutate).toHaveBeenCalledWith({ batchIds: ['3000000000009'] });
    selected.unmount();
  });

  it('H5c：batches 为空 → 渲染空态（且不挂 Sortable 列表容器）', async () => {
    const wrapper = mountPanel([]);
    await flushPromises();
    expect(wrapper.findAll('.batch-card')).toHaveLength(0);
    expect(wrapper.find('.el-empty-stub').exists()).toBe(true);
    wrapper.unmount();
  });
});
