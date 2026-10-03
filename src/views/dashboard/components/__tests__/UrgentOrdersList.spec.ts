// @vitest-environment happy-dom
// src/views/dashboard/components/__tests__/UrgentOrdersList.spec.ts
//
// 2026-10-03 新增：UrgentOrdersList.vue「最紧急工单」行的渲染契约。组件零网络请求、
// 零 useQuery（items 走 props 传入），故测试不需要 QueryClient / VueQueryPlugin。
//
// 覆盖：
//   - R1：行内 6 个子元素的顺序与文案（序列号 / 名称 / 数量 / 二级客户 / 状态 / 交期）
//   - R2：名称 tooltip 的 content 是完整 name（窄屏 ellipsis 的唯一兜底手段）
//   - R3：数量渲染数值
//   - R4：二级客户为空 → 渲染 '—' 且对应 tooltip disabled
//   - R5：系统交期只出 MM/DD，且不含「天后到期」「已逾期」倒计文案；逾期 / 临近配色类
//         仍由 deliveryUrgencyClass 驱动
//   - R6：过滤口径 —— system_delivery_date 为 null 的剔除、超 7 天窗口（today+7 起）剔除
//   - R7：点行 → emit rowClick(item)
//
// 测试策略：
//   - vitest.config.ts 只有 vue() 插件，没有 unplugin-vue-components ⇒ 所有 el-* 组件
//     必须显式 stub，否则是未解析组件；
//   - el-tooltip stub **只渲染 default slot**（外面包一个 span），这样 .row 的直接子元素
//     恒为 6 个 —— 与浏览器侧「ElOnlyChild 不产生包裹层」的实测结论同形，R1 可以直接
//     断言子元素个数与顺序；tooltip 文案改从 stub 的 content prop 断言（等价于真实
//     ElTooltip 收到的入参）。

import { describe, expect, it, vi } from 'vitest';
import { defineComponent, h, type PropType } from 'vue';
import { mount } from '@vue/test-utils';
import UrgentOrdersList from '../UrgentOrdersList.vue';
import type { PartListItem } from '@/types/parts';

/** el-tooltip stub：只出 default slot（包一层 span 占住 grid 的一个子项位）。
 *  content / placement / showAfter / disabled 是普通 props，单测从 props 断言。 */
const ElTooltipStub = defineComponent({
  name: 'ElTooltipStub',
  props: {
    content: { type: String as PropType<string>, default: '' },
    placement: String,
    showAfter: Number,
    disabled: Boolean,
  },
  setup(_, { slots }) {
    return () => h('span', { class: 'el-tooltip-stub' }, slots.default?.());
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

// 组件自身不 import element-plus（无 ElMessage 路径），模块级 mock 只是为了让
// 「el-* 只能来自 stub」这件事在文件里自解释；真正生效的是下面的 global 注册。
vi.mock('element-plus', () => ({
  ElTooltip: ElTooltipStub,
  ElTag: ElTagStub,
  ElCard: ElCardStub,
  ElIcon: ElIconStub,
  ElEmpty: ElEmptyStub,
}));

const globalConfig = {
  components: {
    ElTooltip: ElTooltipStub,
    ElTag: ElTagStub,
    ElCard: ElCardStub,
    ElIcon: ElIconStub,
    ElEmpty: ElEmptyStub,
  },
};

/** 相对今天偏移 n 天的本地 ISO（'YYYY-MM-DD'）。组件的 7 天窗口口径是 today+6。 */
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

function mountList(items: PartListItem[], limit?: number) {
  return mount(UrgentOrdersList, {
    props: { items, ...(limit === undefined ? {} : { limit }) },
    global: globalConfig,
  });
}

describe('UrgentOrdersList — 6 列渲染契约（2026-10-03）', () => {
  it('R1：行内 6 个子元素，顺序为 序列号 / 名称 / 数量 / 二级客户 / 状态 / 系统交期', () => {
    const wrapper = mountList([makePart()]);
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

  it('R2：名称 tooltip 的 content 是完整 name（6 列里名称列最宽也不够放 p90 名字）', () => {
    const wrapper = mountList([makePart({ name: '连杆总成左前支架焊接件A' })]);
    const tooltips = wrapper.findAllComponents(ElTooltipStub);

    expect(tooltips).toHaveLength(2);
    expect(tooltips[0].props('content')).toBe('连杆总成左前支架焊接件A');
    expect(tooltips[0].props('disabled')).toBe(false);
    expect(tooltips[0].props('showAfter')).toBe(200);
    wrapper.unmount();
  });

  it('R3：数量渲染数值（≤4 位真实数据，窄屏 32px 列）', () => {
    const wrapper = mountList([makePart({ quantity: 1 })]);
    expect(wrapper.find('.row-qty').text()).toBe('1');
    wrapper.unmount();
  });

  it('R4：二级客户为空 → 渲染 "—"，且该 tooltip disabled（不弹空浮层）', () => {
    const wrapper = mountList([makePart({ customer_name: null })]);
    expect(wrapper.find('.row-customer').text()).toBe('—');

    const tooltips = wrapper.findAllComponents(ElTooltipStub);
    expect(tooltips[1].props('content')).toBe('');
    expect(tooltips[1].props('disabled')).toBe(true);
    wrapper.unmount();
  });

  it('R5：系统交期只出 MM/DD，且不含倒计文案；逾期 / 临近配色类保留', () => {
    const due = isoOffset(2);
    const wrapper = mountList([makePart({ system_delivery_date: due })]);
    const text = wrapper.find('.list-rows .row').text();

    expect(text).toContain(mmdd(due));
    expect(text).not.toContain('天后到期');
    expect(text).not.toContain('已逾期');
    expect(text).not.toContain('今天到期');
    // 2 天后 → due-soon（橙）
    expect(wrapper.find('.row-due').classes()).toContain('due-soon');

    const overdue = mountList([makePart({ system_delivery_date: isoOffset(-52) })]);
    expect(overdue.find('.row-due').text()).toBe(mmdd(isoOffset(-52)));
    expect(overdue.find('.row-due').classes()).toContain('overdue');
    overdue.unmount();
    wrapper.unmount();
  });

  it('R6：过滤口径 —— system_delivery_date 为 null 的剔除，超 7 天窗口的剔除', () => {
    const inWindow = makePart({ id: '1', system_delivery_date: isoOffset(6) });
    const noDue = makePart({ id: '2', system_delivery_date: null });
    const outOfWindow = makePart({ id: '3', system_delivery_date: isoOffset(7) });

    const wrapper = mountList([inWindow, noDue, outOfWindow]);
    const rows = wrapper.findAll('.list-rows .row');

    expect(rows).toHaveLength(1);
    expect(rows[0].find('.row-serial').text()).toBe('F1016');
    // 全部被滤掉 → empty 分支
    const empty = mountList([noDue, outOfWindow]);
    expect(empty.findAll('.list-rows .row')).toHaveLength(0);
    expect(empty.find('.mock-empty').exists()).toBe(true);
    empty.unmount();
    wrapper.unmount();
  });

  it('R7：点行 → emit rowClick(item)', async () => {
    const part = makePart();
    const wrapper = mountList([part]);

    await wrapper.find('.list-rows .row').trigger('click');

    const events = wrapper.emitted('rowClick');
    expect(events).toBeTruthy();
    expect(events?.[0]?.[0]).toMatchObject({ id: part.id, serial_no: 'F1016' });
    wrapper.unmount();
  });
});
