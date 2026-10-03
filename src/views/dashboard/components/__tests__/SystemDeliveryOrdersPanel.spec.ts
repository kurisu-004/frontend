// @vitest-environment happy-dom
// src/views/dashboard/components/__tests__/SystemDeliveryOrdersPanel.spec.ts
//
// 2026-10-03 新增：SystemDeliveryOrdersPanel.vue 两个 variant（urgent / partial）的
// 渲染契约。组件零网络请求、零 useQuery（items 走 props 传入），故测试不需要
// QueryClient / VueQueryPlugin。
//
// 覆盖：
//   - P1：urgent 变体 —— 行内 6 个子元素的顺序与文案（序列号 / 名称 / 数量 / 二级客户 /
//         状态 / 系统交期）
//   - P2：名称 tooltip 的 content 是完整 name（窄屏 ellipsis 的唯一兜底手段）
//   - P3：urgent 数量列渲染纯数值
//   - P4：二级客户为空 → 渲染 '—' 且对应 tooltip disabled
//   - P5：系统交期只出 MM/DD，且不含「天后到期」「已逾期」倒计文案；逾期 / 临近配色类
//         仍由 deliveryUrgencyClass 驱动
//   - P6：两个 variant 的标题 / 副标题 / 空态文案
//   - P7：urgent 变体有 `.urgent` 红底行、partial 变体没有
//   - P8：partial 数量列出「20 / 64」，已交部分单独成节点（走主题色的入口）
//   - P9：partial 数量列 tooltip 显式标单位（装配件行「套」/ 零件行「件」）
//   - P10：limit 上限截断（Top N 与实际渲染行数一致）
//   - P11：点行 → emit rowClick(item)
//
// 测试策略：
//   - vitest.config.ts 只有 vue() 插件，没有 unplugin-vue-components ⇒ 所有 el-* 组件
//     必须显式 stub，否则是未解析组件；
//   - el-tooltip stub 同时渲染 default slot（本体）与 content slot（浮层），两个 slot
//     各包一层带类名的 div —— 单测才能把「行里渲染了什么」与「tooltip 渲染了什么」分开
//     断言（P8 的数量列与 P9 的 tooltip 文案都要靠它）。真实 ElTooltip 经 ElOnlyChild
//     直出子节点、不产生包裹层，故 stub 的**外层** div 即行内一个 grid 子项 ⇒ P1 仍能
//     断言子元素恒为 6 个。

import { describe, expect, it } from 'vitest';
import { defineComponent, h, type PropType } from 'vue';
import { mount } from '@vue/test-utils';
import SystemDeliveryOrdersPanel from '../SystemDeliveryOrdersPanel.vue';
import type { PartListItem } from '@/types/parts';

/** el-tooltip stub：default slot = 行内本体，content slot = 浮层。
 *  content / placement / showAfter / disabled 是普通 props，单测可从 props 直接断言。
 *  浮层同时兼容两种入参形态：有 #content slot 就渲染 slot，否则渲染 content prop
 *  （真实 ElTooltip 两种形态都支持，浮层文案都能从 DOM 读出来）。 */
const ElTooltipStub = defineComponent({
  name: 'ElTooltipStub',
  props: {
    content: { type: String as PropType<string>, default: '' },
    placement: String,
    showAfter: Number,
    disabled: Boolean,
  },
  setup(props, { slots }) {
    return () =>
      h('span', { class: 'el-tooltip-stub' }, [
        h('span', { class: 'el-tooltip-stub__body' }, slots.default?.()),
        h('span', { class: 'el-tooltip-stub__content' }, slots.content?.() ?? props.content),
      ]);
  },
});

const ElTagStub = defineComponent({
  name: 'ElTagStub',
  props: { type: String, size: String, effect: String },
  setup(_, { slots }) {
    return () => h('span', { class: 'mock-tag' }, slots.default?.());
  },
});

const ElCardStub = defineComponent({
  name: 'ElCardStub',
  props: { shadow: String },
  setup(_, { slots }) {
    return () =>
      h('div', { class: 'mock-card' }, [
        h('div', { class: 'mock-card__header' }, slots.header?.()),
        h('div', { class: 'mock-card__body' }, slots.default?.()),
      ]);
  },
});

const ElIconStub = defineComponent({
  name: 'ElIconStub',
  setup(_, { slots }) {
    return () => h('i', { class: 'mock-icon' }, slots.default?.());
  },
});

const ElEmptyStub = defineComponent({
  name: 'ElEmptyStub',
  props: { imageSize: Number, description: String },
  setup(props) {
    return () => h('div', { class: 'mock-empty' }, props.description);
  },
});

const globalConfig = {
  components: {
    ElTooltip: ElTooltipStub,
    ElTag: ElTagStub,
    ElCard: ElCardStub,
    ElIcon: ElIconStub,
    ElEmpty: ElEmptyStub,
  },
};

/** 相对今天偏移 n 天的本地 ISO（'YYYY-MM-DD'）。 */
function isoOffset(n: number): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + n);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/** 该日期的 MM/DD 形态（与 formatDeliveryDate 输出一致）。 */
function mmdd(iso: string): string {
  return iso.slice(5).replace('-', '/');
}

function makePart(overrides: Partial<PartListItem> = {}): PartListItem {
  return {
    id: '180000000000001',
    version: 1,
    serial_no: 'F1016',
    name: '连杆总成左前',
    drawing_no: 'DWG-001',
    applicant_name: null,
    quantity: 1791,
    unit_price: '0',
    total_price: '0',
    request_date: isoOffset(-10),
    planned_delivery_date: isoOffset(3),
    is_urgent: true,
    status: 'IN_PROCESS',
    order_no: null,
    system_delivery_date: isoOffset(2),
    note: null,
    customer_name: '南海路厂区',
    l1_customer_name: '南海集团',
    location: null,
    has_cnc_program: false,
    ...overrides,
  };
}

function mountPanel(
  variant: 'urgent' | 'partial',
  items: PartListItem[],
  limit?: number,
) {
  return mount(SystemDeliveryOrdersPanel, {
    props: { variant, items, ...(limit === undefined ? {} : { limit }) },
    global: globalConfig,
  });
}

describe('SystemDeliveryOrdersPanel — 6 列渲染契约（urgent 变体）', () => {
  it('P1：行内 6 个子元素，顺序为 序列号 / 名称 / 数量 / 二级客户 / 状态 / 系统交期', () => {
    const wrapper = mountPanel('urgent', [makePart()]);
    const row = wrapper.find('.list-rows .row');

    expect(row.exists()).toBe(true);
    // el-tooltip 经 ElOnlyChild 直出子节点、不产生包裹层 ⇒ 行仍恒为 6 个 grid 子项。
    const cells = row.element.children;
    expect(cells).toHaveLength(6);
    // row-due 带 urgency 配色类（此处 due-soon），只取首个 class token 对齐列位。
    expect([...cells].map((c) => c.classList[0])).toEqual([
      'row-serial',
      'el-tooltip-stub',
      'row-qty',
      'el-tooltip-stub',
      'mock-tag',
      'row-due',
    ]);
    expect(row.find('.row-serial').text()).toBe('F1016');
    expect(row.find('.row-name').text()).toBe('连杆总成左前');
    expect(row.find('.row-qty').text()).toBe('1791');
    expect(row.find('.row-customer').text()).toBe('南海路厂区');
    expect(row.find('.mock-tag').text()).toBe('生产中');
    expect(row.find('.row-due').text()).toBe(mmdd(isoOffset(2)));
    wrapper.unmount();
  });

  it('P2：名称 tooltip 的 content 是完整 name（6 列里名称列最宽也不够放 p90 名字）', () => {
    const wrapper = mountPanel('urgent', [makePart({ name: '连杆总成左前支架焊接件A' })]);
    const tooltips = wrapper.findAllComponents(ElTooltipStub);

    expect(tooltips).toHaveLength(2);
    expect(tooltips[0].props('content')).toBe('连杆总成左前支架焊接件A');
    expect(tooltips[0].props('disabled')).toBe(false);
    expect(tooltips[0].props('showAfter')).toBe(200);
    wrapper.unmount();
  });

  it('P3：urgent 数量列渲染纯数值（不出现斜杠与已送色块）', () => {
    const wrapper = mountPanel('urgent', [makePart({ quantity: 1 })]);
    const qty = wrapper.find('.row-qty');

    expect(qty.text()).toBe('1');
    expect(qty.find('.row-qty-done').exists()).toBe(false);
    expect(qty.find('.row-qty-sep').exists()).toBe(false);
    wrapper.unmount();
  });

  it('P4：二级客户为空 → 渲染 "—"，且该 tooltip disabled（不弹空浮层）', () => {
    const wrapper = mountPanel('urgent', [makePart({ customer_name: null })]);
    expect(wrapper.find('.row-customer').text()).toBe('—');

    const tooltips = wrapper.findAllComponents(ElTooltipStub);
    expect(tooltips[1].props('content')).toBe('');
    expect(tooltips[1].props('disabled')).toBe(true);
    wrapper.unmount();
  });

  it('P5：系统交期只出 MM/DD，且不含倒计文案；逾期 / 临近配色类保留', () => {
    const due = isoOffset(2);
    const wrapper = mountPanel('urgent', [makePart({ system_delivery_date: due })]);
    const text = wrapper.find('.list-rows .row').text();

    expect(text).toContain(mmdd(due));
    expect(text).not.toContain('天后到期');
    expect(text).not.toContain('已逾期');
    expect(text).not.toContain('今天到期');
    // 2 天后 → due-soon（橙）
    expect(wrapper.find('.row-due').classes()).toContain('due-soon');

    const overdue = mountPanel('urgent', [makePart({ system_delivery_date: isoOffset(-52) })]);
    expect(overdue.find('.row-due').text()).toBe(mmdd(isoOffset(-52)));
    expect(overdue.find('.row-due').classes()).toContain('overdue');
    overdue.unmount();
    wrapper.unmount();
  });

  it('P11：点行 → emit rowClick(item)', async () => {
    const part = makePart();
    const wrapper = mountPanel('urgent', [part]);

    await wrapper.find('.list-rows .row').trigger('click');

    const events = wrapper.emitted('rowClick');
    expect(events).toBeTruthy();
    expect(events?.[0]?.[0]).toMatchObject({ id: part.id, serial_no: 'F1016' });
    wrapper.unmount();
  });
});

describe('SystemDeliveryOrdersPanel — 变体文案与红底归属', () => {
  it('P6a：urgent 变体的标题 / 副标题 / 空态文案', () => {
    const filled = mountPanel('urgent', [makePart()]);
    expect(filled.find('.list-title').text()).toContain('最紧急工单（Top 1）');
    expect(filled.find('.list-subtitle').text()).toBe('按系统交期升序 · 7 天内');
    filled.unmount();

    const empty = mountPanel('urgent', []);
    expect(empty.findAll('.list-rows .row')).toHaveLength(0);
    expect(empty.find('.mock-empty').text()).toBe('暂无 7 天内紧急工单');
    empty.unmount();
  });

  it('P6b：partial 变体的标题 / 副标题 / 空态文案', () => {
    const filled = mountPanel('partial', [
      makePart({ delivered_quantity: 20, quantity: 64 }),
    ]);
    expect(filled.find('.list-title').text()).toContain('部分已交（Top 1）');
    expect(filled.find('.list-subtitle').text()).toBe('存在已交批次 · 7 天内');
    filled.unmount();

    // 本用例只覆盖「无条目」这一条空态路径。字段缺失（delivered_quantity 为
    // null）如何渲染由 systemDeliveryOrders.spec.ts 的 W3 系列断言。
    const empty = mountPanel('partial', []);
    expect(empty.findAll('.list-rows .row')).toHaveLength(0);
    expect(empty.find('.mock-empty').text()).toBe('暂无部分已交工单');
    empty.unmount();
  });

  it('P7：`.urgent` 红底行只属 urgent 变体（partial 的「已交过」不共表红底语义）', () => {
    const urgent = mountPanel('urgent', [makePart({ is_urgent: true })]);
    expect(urgent.find('.list-rows .row').classes()).toContain('urgent');
    urgent.unmount();

    const partial = mountPanel('partial', [
      makePart({ is_urgent: true, delivered_quantity: 20 }),
    ]);
    expect(partial.find('.list-rows .row').classes()).not.toContain('urgent');
    partial.unmount();
  });
});

describe('SystemDeliveryOrdersPanel — partial 变体数量列', () => {
  it('P8：数量列出「20 / 64」，已交部分单独成节点', () => {
    const wrapper = mountPanel('partial', [
      makePart({ delivered_quantity: 20, quantity: 64 }),
    ]);
    const qty = wrapper.find('.row-qty');

    expect(qty.text()).toBe('20/64');
    expect(qty.find('.row-qty-done').text()).toBe('20');
    expect(qty.find('.row-qty-sep').text()).toBe('/');
    wrapper.unmount();
  });

  it('P8b：delivered_quantity 为 null（复用同一 VO 的其余端点恒返 null）时数量列出「0 / 总量」，不崩', () => {
    const wrapper = mountPanel('partial', [makePart({ quantity: 64 })]);
    expect(wrapper.find('.row-qty').text()).toBe('0/64');
    wrapper.unmount();
  });

  it('P9：数量列 tooltip 显式标单位 —— 零件行「件」、装配件行「套」', () => {
    const part = mountPanel('partial', [
      makePart({ delivered_quantity: 20, quantity: 64, row_type: 'PART' }),
    ]);
    const assembly = mountPanel('partial', [
      makePart({ delivered_quantity: 3, quantity: 8, row_type: 'ASSEMBLY' }),
    ]);

    // 行内 3 个 tooltip：名称 / 数量 / 二级客户。
    expect(part.findAllComponents(ElTooltipStub)[1]?.props('content')).toBe(
      '已送 20 件 / 总量 64 件',
    );
    expect(assembly.findAllComponents(ElTooltipStub)[1]?.props('content')).toBe(
      '已送 3 套 / 总量 8 套',
    );
    // 浮层也被 stub 渲染进 DOM，text 可直接断言
    expect(part.findAll('.el-tooltip-stub__content')[1]?.text()).toBe('已送 20 件 / 总量 64 件');
    assembly.unmount();
    part.unmount();
  });

  it('P10：limit 截断 —— 标题 Top N 与实际渲染行数一致', () => {
    const items = Array.from({ length: 5 }, (_, i) =>
      makePart({ id: `p${i}`, serial_no: `P${i}`, delivered_quantity: 1 }),
    );
    const wrapper = mountPanel('partial', items, 3);

    expect(wrapper.findAll('.list-rows .row')).toHaveLength(3);
    expect(wrapper.find('.list-title').text()).toContain('部分已交（Top 3）');
    wrapper.unmount();
  });
});
