// src/views/repair/__tests__/RepairStartDialog.spec.ts
//
// 2026-10-03 新增：返修下发对话框的**请求体守卫** —— body 绝不含 quantity。
//
// 为什么要有这个 guard：后端 `RepairDispatchRequest`（prod 域 repair-dispatch）只有
// batch_id / version / shelf_id / next_process_id / reason / note 六个字段，且 serde
// 未开 `deny_unknown_fields` ⇒ 多带 quantity 会被**静默忽略**，而端点语义是「整批
// 返修」。此前对话框有一个「返修数量」输入框，操作员填 3/10 提交后整批 10 件被返修，
// UI 还弹「返修完成 · 已下发」—— 用户拿到的是静默错结果。数量控件与 payload 字段
// 都已删除，本测试钉住「将来谁再加回来都会红」。
//
// 断言手法：mount + EP 最小 stub（vitest 配置只挂 vue() 插件、不挂
// unplugin-vue-components ⇒ el-* 组件在测试里解析不到，必须自己注册）。
// el-select / el-option 桩成原生 <select> / <option>，这样选值就是一次 setValue，
// 不必模拟 EP 内部的下拉浮层。

// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import type { InspectionBatchListItem } from '@/api/parts';
import RepairStartDialog from '../RepairStartDialog.vue';

const mocks = vi.hoisted(() => ({
  repairDispatch: vi.fn(),
  listShelves: vi.fn(),
  listProcesses: vi.fn(),
  /** 两台货架：生产 Tab 走 useShelfProcessFilter 的桩，品检 Tab 走 listShelves 的返回。 */
  shelves: [
    { id: '190000000000301', code: 'SH-A', name: '生产架 A', is_active: true },
    { id: '190000000000302', code: 'SH-B', name: '生产架 B', is_active: true },
  ],
  processes: [{ id: '190000000000201', code: 'P-10', name: '装配' }],
}));

vi.mock('@/api/parts', () => ({ repairDispatch: mocks.repairDispatch }));
vi.mock('@/api/shelves', () => ({ listShelves: mocks.listShelves }));
vi.mock('@/api/process', () => ({ listProcesses: mocks.listProcesses }));
vi.mock('element-plus', () => ({
  ElMessage: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));
// 过滤 composable 内部走共享 query（需要 VueQueryPlugin），本测试不关心过滤逻辑，
// 只关心最终打出的 payload ⇒ 桩成「原样返回两个列表」。
vi.mock('@/composables/useShelfProcessFilter', () => ({
  useShelfProcessFilter: () => ({
    filteredShelves: mocks.shelves,
    filteredProcesses: mocks.processes,
  }),
}));

// —— EP 最小 stub：只渲染插槽，el-select/el-option 桩成原生元素以便 setValue ——

const slotOnly = (name: string) =>
  defineComponent({
    name,
    setup(_props, { slots }) {
      return () => h('div', slots.default?.());
    },
  });

const ElDialogStub = defineComponent({
  name: 'ElDialogStub',
  props: ['modelValue', 'title'],
  setup(_props, { slots }) {
    return () => h('div', { class: 'el-dialog-stub' }, slots.default?.());
  },
});

const ElTabsStub = defineComponent({
  name: 'ElTabsStub',
  props: ['modelValue'],
  emits: ['update:modelValue'],
  setup(_props, { slots }) {
    return () => h('div', { class: 'el-tabs-stub' }, slots.default?.());
  },
});

const ElSelectStub = defineComponent({
  name: 'ElSelectStub',
  props: ['modelValue', 'disabled'],
  emits: ['update:modelValue'],
  setup(props, { slots, emit }) {
    return () =>
      h(
        'select',
        {
          class: 'el-select-stub',
          disabled: props.disabled,
          onChange: (e: Event) => emit('update:modelValue', (e.target as HTMLSelectElement).value),
        },
        slots.default?.(),
      );
  },
});

const ElOptionStub = defineComponent({
  name: 'ElOptionStub',
  props: ['value', 'label', 'disabled'],
  setup(props) {
    return () => h('option', { value: props.value, disabled: props.disabled }, props.label);
  },
});

const ElButtonStub = defineComponent({
  name: 'ElButtonStub',
  props: ['disabled', 'loading', 'type', 'link', 'size'],
  emits: ['click'],
  setup(props, { slots, emit }) {
    return () =>
      h(
        'button',
        { class: 'el-button-stub', disabled: props.disabled, onClick: () => emit('click') },
        slots.default?.(),
      );
  },
});

function makeTarget(over: Partial<InspectionBatchListItem> = {}): InspectionBatchListItem {
  return {
    batch_id: '190000000000123',
    batch_no: 7,
    quantity: 10,
    status: 'DELIVERED',
    is_repairing: false,
    location: null,
    version: 3,
    parent_batch_id: null,
    current_holder_id: null,
    holder_name: null,
    next_process_id: null,
    next_process_name: null,
    delivery_note_id: null,
    delivery_note_no: null,
    part_id: '190000000000001',
    serial_no: 'SN-9001',
    drawing_no: 'DWG-R1',
    name: '返修件',
    order_no: null,
    planned_delivery_date: '2026-10-20',
    is_urgent: false,
    part_version: 1,
    created_at: '2026-10-01 08:00:00',
    updated_at: '2026-10-01 08:00:00',
    customer_id: '190000000000002',
    customer_name: '客户甲',
    l1_customer_name: null,
    ...over,
  };
}

async function mountDialog(target: InspectionBatchListItem) {
  mocks.repairDispatch.mockReset();
  mocks.repairDispatch.mockResolvedValue({});
  mocks.listShelves.mockResolvedValue({ items: mocks.shelves });
  mocks.listProcesses.mockResolvedValue({ items: mocks.processes });
  const wrapper = mount(RepairStartDialog, {
    props: { modelValue: true, target },
    global: {
      components: {
        ElDialog: ElDialogStub,
        ElTabs: ElTabsStub,
        ElTabPane: slotOnly('ElTabPaneStub'),
        ElForm: slotOnly('ElFormStub'),
        ElFormItem: slotOnly('ElFormItemStub'),
        ElSelect: ElSelectStub,
        ElOption: ElOptionStub,
        ElButton: ElButtonStub,
        ElIcon: slotOnly('ElIconStub'),
      },
    },
  });
  // 挂载时 watch(immediate) 会拉一次货架/工序字典
  await flushPromises();
  return wrapper;
}

/** mountDialog 是 async（等字典拉取），取它的 await 结果作为 wrapper 类型。 */
type DialogWrapper = Awaited<ReturnType<typeof mountDialog>>;

/** 三个下拉的 DOM 顺序：工序 / 生产货架 / 品检货架（两个 tab 的 pane 都渲染）。 */
function selects(wrapper: DialogWrapper) {
  return wrapper.findAll('select');
}

async function clickButton(wrapper: DialogWrapper, text: string): Promise<void> {
  const btn = wrapper.findAll('button').find((b) => b.text().includes(text));
  if (!btn) throw new Error(`找不到按钮：${text}`);
  await btn.trigger('click');
  await flushPromises();
}

describe('RepairStartDialog 下发载荷（整批返修，不带 quantity）', () => {
  it('D1：下发到生产架 —— body 恰为 shelf_id / version / next_process_id，无 quantity', async () => {
    const wrapper = await mountDialog(makeTarget());
    const sels = selects(wrapper);
    await sels[0]!.setValue('190000000000201'); // 下一道工序
    await sels[1]!.setValue('190000000000301'); // 目标生产货架
    await clickButton(wrapper, '完成 · 下发到生产架');

    expect(mocks.repairDispatch).toHaveBeenCalledTimes(1);
    const [batchId, body] = mocks.repairDispatch.mock.calls[0] as [string, Record<string, unknown>];
    expect(batchId).toBe('190000000000123');
    expect(body).not.toHaveProperty('quantity');
    expect(body).toEqual({
      shelf_id: '190000000000301',
      version: 3,
      next_process_id: '190000000000201',
    });
  });

  it('D2：送检到品检架 —— 同样不带 quantity，且 next_process_id 为 null', async () => {
    const wrapper = await mountDialog(makeTarget());
    wrapper.findComponent(ElTabsStub).vm.$emit('update:modelValue', 'inspect');
    await flushPromises();
    await selects(wrapper)[2]!.setValue('190000000000302'); // 品检货架
    await clickButton(wrapper, '完成 · 送检到该架');

    const [, body] = mocks.repairDispatch.mock.calls[0] as [string, Record<string, unknown>];
    expect(body).not.toHaveProperty('quantity');
    expect(body).toEqual({
      shelf_id: '190000000000302',
      version: 3,
      next_process_id: null,
    });
  });

  it('D3：批次量 3 / 10 也不发数量 —— 端点是整批返修，无「部分返修」这条交互', async () => {
    const wrapper = await mountDialog(makeTarget({ quantity: 3 }));
    const sels = selects(wrapper);
    await sels[0]!.setValue('190000000000201');
    await sels[1]!.setValue('190000000000301');
    await clickButton(wrapper, '完成 · 下发到生产架');

    const [, body] = mocks.repairDispatch.mock.calls[0] as [string, Record<string, unknown>];
    expect(Object.keys(body).sort()).toEqual(['next_process_id', 'shelf_id', 'version']);
  });
});
