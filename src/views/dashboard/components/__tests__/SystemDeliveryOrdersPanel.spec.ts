// @vitest-environment happy-dom
// src/views/dashboard/components/__tests__/SystemDeliveryOrdersPanel.spec.ts
//
// SystemDeliveryOrdersPanel.vue 三个 variant（upcoming / overdue / partial）的渲染契约。
// 组件零网络请求、零 useQuery（items / total 走 props 传入），故测试不需要 QueryClient /
// VueQueryPlugin。items 类型是 dashboard 域窄 VO（SystemDeliveryOrderData，10 字段），
// 不是 PartListItem。
//
// 覆盖：
//   - P1：upcoming 变体 —— 行内 6 个子元素的顺序与文案（序列号 / 名称 / 数量 / 二级客户 /
//         状态 / 系统交期）
//   - P2：名称 tooltip 的 content 是完整 name（窄屏 ellipsis 的唯一兜底手段）
//   - P3：非 partial 变体数量列渲染纯数值
//   - P4：二级客户为空 → 渲染 '—' 且对应 tooltip disabled
//   - P5：系统交期只出 MM/DD 且不含倒计文案；逾期件带 overdue 类（overdue 桶的核心样式）
//   - P6：三个 variant 的标题 / 空态文案（判据口径以标题 + 空态文案承载）
//   - P7：`.urgent` 红底行三个 variant 都有（加急语义独立于交期分桶）
//   - P8：partial 数量列出「20 / 64」，已交部分单独成节点（走主题色的入口）
//   - P9：partial 数量列 tooltip 单位随 row_type 分流（件 / 套）
//   - P10：组件不再 slice —— 服务端已按 30 条截断，标题不再带 Top N
//   - P11：点行 → emit rowClick(item)（原样透传，row_type 不在组件内分流）
//   - P12：partial「已交 3 / 总 100」变体（delivered_quantity 是必填非 null 字段）
//   - P13：#header-extra slot 渲染在标题行内（供父组件插 upcoming / overdue 的 radio）
//   - P14：total > items.length 时标题 tooltip 出「共 N 条，仅显示前 M 条」；相等 /
//         缺省时 tooltip disabled（浮层不启用）
//   - P15：组件不按 delivered_quantity 过滤或重分桶（装配件落在 partial 且已交 0 仍出行）
//   - P16：rowClickable —— 谓词判不可点的行不 emit、挂 row--locked（视觉可辨）、
//         与加急红底并存、未传谓词时全可点（零配置回退）
//   - P17：system_delivery_date 为 null → 交期列「—」占位（partial 桶无窗口会真遇到）
//
// 测试策略：
//   - vitest.config.ts 只有 vue() 插件，没有 unplugin-vue-components ⇒ 所有 el-* 组件
//     必须显式 stub，否则是未解析组件；
//   - el-tooltip stub 同时渲染 default slot（本体）与 content slot（浮层），两个 slot
//     各包一层带类名的 div —— 单测才能把「行里渲染了什么」与「tooltip 渲染了什么」分开
//     断言（P8 的数量列与 P9 的 tooltip 文案都要靠它）。真实 ElTooltip 经 ElOnlyChild
//     直出子节点、不产生包裹层，故 stub 的**外层** div 即行内一个 grid 子项 ⇒ P1 仍能
//     断言子元素恒为 6 个。同一条性质在真实 EP 下也让 header 的 tooltip 不改变
//     .list-header 的两个 flex 子项（.list-title + slot）—— 但 stub 自带一层外壳、
//     它在测试里恰恰是第三个子项，**这条断不了**，只作记录（真正要锁的是 P13 的
//     「radio 在 .list-header 内」）。

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineComponent, h, type PropType } from 'vue';
import { mount } from '@vue/test-utils';
import SystemDeliveryOrdersPanel from '../SystemDeliveryOrdersPanel.vue';
import type { SystemDeliveryOrderData } from '@/views/dashboard/composables/dashboardSnapshotSchema';

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

type Variant = 'upcoming' | 'overdue' | 'partial';

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

/** 交期面板行（SystemDeliveryOrder VO，10 字段）。delivered_quantity 是必填非 null：
 *  展示值，0 合法（未交过 / 装配件凑不满整一套）；row_type 决定 quantity 与
 *  delivered_quantity 的单位（件 / 套）与数量列 tooltip 文案。 */
function makeOrder(overrides: Partial<SystemDeliveryOrderData> = {}): SystemDeliveryOrderData {
  return {
    id: '180000000000001',
    serial_no: 'F1016',
    name: '连杆总成左前',
    quantity: 1791,
    status: 'IN_PROCESS',
    system_delivery_date: isoOffset(2),
    customer_name: '南海路厂区',
    is_urgent: true,
    delivered_quantity: 0,
    row_type: 'PART',
    ...overrides,
  };
}

function mountPanel(
  variant: Variant,
  items: SystemDeliveryOrderData[],
  extra: {
    total?: number;
    slots?: Record<string, string>;
    rowClickable?: (item: SystemDeliveryOrderData) => boolean;
  } = {},
) {
  return mount(SystemDeliveryOrdersPanel, {
    props: {
      variant,
      items,
      ...(extra.total === undefined ? {} : { total: extra.total }),
      ...(extra.rowClickable === undefined ? {} : { rowClickable: extra.rowClickable }),
    },
    slots: extra.slots ?? {},
    global: globalConfig,
  });
}

/** header 标题上的那个 tooltip（total 信息的唯一通道）。行内另有 3 个 tooltip，按所在
 *  位置区分（`.element.closest` 走到 .list-header 即为 header 的那个）。
 *  缺它即说明 header 的 tooltip 被摘掉了。 */
function headerTooltip(wrapper: ReturnType<typeof mountPanel>) {
  const stub = wrapper
    .findAllComponents(ElTooltipStub)
    .find((tip) => tip.element.closest('.list-header') !== null);
  if (!stub) throw new Error('header 标题上必须有 el-tooltip（total 信息的通道）');
  return stub;
}

/** 行内的 tooltip（排除 header 标题上那个），顺序固定：名称 / 数量 / 二级客户。
 *  按位置而非全局下标定位 —— header 加了 tooltip 会整体平移下标。 */
function rowTooltips(wrapper: ReturnType<typeof mountPanel>) {
  return wrapper
    .findAllComponents(ElTooltipStub)
    .filter((tip) => tip.element.closest('.list-header') === null);
}

// ---- 样式级守卫用的源码工具（vitest 不处理 SFC <style>，CSS 只能读源码） ----

/** 组件源码原文（仅供 P18 的样式契约断言用；渲染类断言一律走挂载）。
 *  注意用 `import.meta.url` 字符串而不是 `new URL(...)`：本 spec 跑在 happy-dom 下，
 *  裸 `new URL` 命中的是 happy-dom 的 URL 实现，node 的 fileURLToPath 认不出来
 *  （同 BatchCard.spec.ts 的 B14）。 */
const PANEL_SRC = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../SystemDeliveryOrdersPanel.vue'),
  'utf8',
);

/** 把注释逐字符替换成空格（位置不变，只在真实代码上判定），避免注释里的字面量
 *  让样式断言假通过（做法同 PurchaseOrderImportDeliveryPrefill.spec.ts）。 */
function stripComments(src: string): string {
  const blank = (m: string): string => m.replace(/[^\n]/g, ' ');
  return src
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/^[ \t]*\/\/[^\n]*$/gm, blank);
}

/** 只取 <style> 段，避免模板里的同名字符串被当成规则命中。 */
const STYLE_SRC = /<style[^>]*>([\s\S]*?)<\/style>/.exec(stripComments(PANEL_SRC))?.[1] ?? '';

/** 取 `selector { … }` 的块内容（**含**嵌套子规则），按花括号配平截取 —— 起始深度
 *  从 1 起，否则嵌套子规则的收尾 } 会让整块提前截断。
 *  取不到（选择器被改名/删除）返回空串，由用例断言负责报错。 */
function ruleBody(src: string, selector: string): string {
  const at = src.indexOf(`${selector} {`);
  if (at < 0) return '';
  const bodyStart = at + selector.length + 2;
  let depth = 1;
  for (let i = bodyStart; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(bodyStart, i);
    }
  }
  return src.slice(bodyStart);
}

describe('SystemDeliveryOrdersPanel — 6 列渲染契约（upcoming 变体）', () => {
  it('P1：行内 6 个子元素，顺序为 序列号 / 名称 / 数量 / 二级客户 / 状态 / 系统交期', () => {
    const wrapper = mountPanel('upcoming', [makeOrder()]);
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
    const wrapper = mountPanel('upcoming', [makeOrder({ name: '连杆总成左前支架焊接件A' })]);
    const tooltips = rowTooltips(wrapper);

    expect(tooltips).toHaveLength(2);
    expect(tooltips[0].props('content')).toBe('连杆总成左前支架焊接件A');
    expect(tooltips[0].props('disabled')).toBe(false);
    expect(tooltips[0].props('showAfter')).toBe(200);
    wrapper.unmount();
  });

  it('P3：非 partial 变体数量列渲染纯数值（不出现斜杠与已送色块）', () => {
    const wrapper = mountPanel('upcoming', [makeOrder({ quantity: 1 })]);
    const qty = wrapper.find('.row-qty');

    expect(qty.text()).toBe('1');
    expect(qty.find('.row-qty-done').exists()).toBe(false);
    expect(qty.find('.row-qty-sep').exists()).toBe(false);
    wrapper.unmount();
  });

  it('P4：二级客户为空 → 渲染 "—"，且该 tooltip disabled（不弹空浮层）', () => {
    const wrapper = mountPanel('upcoming', [makeOrder({ customer_name: null })]);
    expect(wrapper.find('.row-customer').text()).toBe('—');

    const tooltips = rowTooltips(wrapper);
    expect(tooltips[1].props('content')).toBe('');
    expect(tooltips[1].props('disabled')).toBe(true);
    wrapper.unmount();
  });

  it('P5：系统交期只出 MM/DD 且不含倒计文案；overdue 桶的行挂 overdue 类（逾期红）', () => {
    const due = isoOffset(2);
    const soon = mountPanel('upcoming', [makeOrder({ system_delivery_date: due })]);
    const text = soon.find('.list-rows .row').text();

    expect(text).toContain(mmdd(due));
    expect(text).not.toContain('天后到期');
    expect(text).not.toContain('已逾期');
    expect(text).not.toContain('今天到期');
    // 2 天后 → due-soon（橙）
    expect(soon.find('.row-due').classes()).toContain('due-soon');
    expect(soon.find('.row-due').classes()).not.toContain('overdue');
    soon.unmount();

    // overdue 桶的行 system_delivery_date < today，deliveryUrgencyClass 恒返 'overdue'。
    // 组件不自己判窗口（判据在服务端），但样式表必须有该分支，否则逾期交期静默退成灰。
    const overdueDate = isoOffset(-52);
    const overdue = mountPanel('overdue', [makeOrder({ system_delivery_date: overdueDate })]);
    expect(overdue.find('.row-due').text()).toBe(mmdd(overdueDate));
    expect(overdue.find('.row-due').classes()).toContain('overdue');
    overdue.unmount();
  });
});

describe('SystemDeliveryOrdersPanel — 变体文案与红底归属', () => {
  it('P6a：upcoming 变体的标题 / 空态文案（判据口径由标题 + 空态文案承载）', () => {
    const filled = mountPanel('upcoming', [makeOrder()]);
    // 标题必须「含今天」：服务端 upcoming 桶判据是 sdd >= today，写「今天之后」会把
    // 今天到期（该桶最常见的一档）排除在标题之外。
    expect(filled.find('.list-title').text()).toContain('今天及以后到期');
    expect(filled.find('.list-subtitle').exists()).toBe(false);
    filled.unmount();

    const empty = mountPanel('upcoming', []);
    expect(empty.findAll('.list-rows .row')).toHaveLength(0);
    expect(empty.find('.mock-empty').text()).toBe('暂无今天及以后到期的未交工单');
    empty.unmount();
  });

  it('P6b：overdue 变体的标题 / 空态文案（空态以「未交工单」收尾，点破真实判据）', () => {
    const filled = mountPanel('overdue', [makeOrder({ system_delivery_date: isoOffset(-3) })], {
      total: 9,
    });
    expect(filled.find('.list-title').text()).toContain('已逾期未交');
    expect(filled.find('.list-subtitle').exists()).toBe(false);
    // header 的口径信息通道是标题 tooltip：真实判据「一件都没交过」由标题 / 空态文案
    // 承载，行数口径由 tooltip 承载，两处都不能掉。
    expect(headerTooltip(filled).props('content')).toBe('共 9 条，仅显示前 1 条');
    filled.unmount();

    const empty = mountPanel('overdue', []);
    expect(empty.find('.mock-empty').text()).toBe('暂无已逾期未交工单');
    empty.unmount();
  });

  it('P6c：partial 变体的标题 / 空态文案（不超限 → 标题 tooltip 禁用，不出浮层）', () => {
    const filled = mountPanel('partial', [makeOrder({ delivered_quantity: 20, quantity: 64 })], {
      total: 1,
    });
    expect(filled.find('.list-title').text()).toContain('部分已交');
    expect(filled.find('.list-subtitle').exists()).toBe(false);
    expect(headerTooltip(filled).props('content')).toBe('');
    expect(headerTooltip(filled).props('disabled')).toBe(true);
    filled.unmount();

    const empty = mountPanel('partial', []);
    expect(empty.findAll('.list-rows .row')).toHaveLength(0);
    expect(empty.find('.mock-empty').text()).toBe('暂无部分已交工单');
    empty.unmount();
  });

  it('P7：`.urgent` 红底行三个变体都有（加急是工单自身标记，与交期分桶无关）', () => {
    for (const variant of ['upcoming', 'overdue', 'partial'] as Variant[]) {
      const w = mountPanel(variant, [
        makeOrder({ is_urgent: true, delivered_quantity: variant === 'partial' ? 20 : 0 }),
      ]);
      expect(w.find('.list-rows .row').classes(), variant).toContain('urgent');
      w.unmount();
    }

    const notUrgent = mountPanel('overdue', [makeOrder({ is_urgent: false })]);
    expect(notUrgent.find('.list-rows .row').classes()).not.toContain('urgent');
    notUrgent.unmount();
  });
});

describe('SystemDeliveryOrdersPanel — partial 变体数量列', () => {
  it('P8：数量列出「20 / 64」，已交部分单独成节点', () => {
    const wrapper = mountPanel('partial', [
      makeOrder({ delivered_quantity: 20, quantity: 64 }),
    ]);
    const qty = wrapper.find('.row-qty');

    expect(qty.text()).toBe('20/64');
    expect(qty.find('.row-qty-done').text()).toBe('20');
    expect(qty.find('.row-qty-sep').text()).toBe('/');
    wrapper.unmount();
  });

  // delivered_quantity 是必填非 null 字段：0 语义是「一件都没交过 / 装配件凑不满整一套」。
  it('P8b：delivered_quantity = 0 时数量列出「0 / 总量」（不隐藏、不改文案）', () => {
    const wrapper = mountPanel('partial', [makeOrder({ delivered_quantity: 0, quantity: 64 })]);
    expect(wrapper.find('.row-qty').text()).toBe('0/64');
    wrapper.unmount();
  });

  it('P12：partial 变体「已交 3 / 总 100」渲染断言（含 tooltip 文案）', () => {
    const wrapper = mountPanel('partial', [
      makeOrder({ delivered_quantity: 3, quantity: 100, serial_no: 'F2001', name: '转向节' }),
    ]);

    const qty = wrapper.find('.row-qty');
    expect(qty.text()).toBe('3/100');
    expect(qty.find('.row-qty-done').text()).toBe('3');
    expect(qty.find('.row-qty-sep').text()).toBe('/');
    // 行内 3 个 tooltip：名称 / 数量 / 二级客户。
    expect(rowTooltips(wrapper)[1]?.props('content')).toBe('已送 3 件 / 总量 100 件');
    expect(wrapper.findAll('.list-rows .el-tooltip-stub__content')[1]?.text()).toBe(
      '已送 3 件 / 总量 100 件',
    );
    wrapper.unmount();
  });

  it('P9：数量列 tooltip 单位随 row_type 分流（PART=件 / ASSEMBLY=套）', () => {
    // 工单级行源：装配件替换其子件行出现，其「已交」是**套数**，与零件行的件数不同单位。
    const part = mountPanel('partial', [
      makeOrder({ row_type: 'PART', delivered_quantity: 20, quantity: 64 }),
    ]);
    const assembly = mountPanel('partial', [
      makeOrder({
        row_type: 'ASSEMBLY',
        delivered_quantity: 3,
        quantity: 8,
        name: '前桥总成',
      }),
    ]);

    // 行内 3 个 tooltip：名称 / 数量 / 二级客户。
    expect(rowTooltips(part)[1]?.props('content')).toBe('已送 20 件 / 总量 64 件');
    expect(rowTooltips(assembly)[1]?.props('content')).toBe('已送 3 套 / 总量 8 套');
    // 浮层也被 stub 渲染进 DOM，text 可直接断言
    expect(part.findAll('.list-rows .el-tooltip-stub__content')[1]?.text()).toBe(
      '已送 20 件 / 总量 64 件',
    );
    expect(assembly.findAll('.list-rows .el-tooltip-stub__content')[1]?.text()).toBe(
      '已送 3 套 / 总量 8 套',
    );
    assembly.unmount();
    part.unmount();
  });

  it('P10：组件不再 slice —— 入参多少条就渲染多少条，标题不带 Top N', () => {
    // 上限由服务端定（每桶 30 条）。组件再 slice 一次会让 header 的「共 N 条」与实际行数
    // 在服务端放宽上限时对不上，故这两条都必须成立。
    const items = Array.from({ length: 5 }, (_, i) =>
      makeOrder({ id: `p${i}`, serial_no: `P${i}`, delivered_quantity: 1 }),
    );
    const wrapper = mountPanel('partial', items, { total: 5 });

    expect(wrapper.findAll('.list-rows .row')).toHaveLength(5);
    expect(wrapper.find('.list-title').text()).not.toContain('Top');
    wrapper.unmount();
  });

  // 桶归属由服务端 EXISTS / NOT EXISTS 已交批次判定，与 delivered_quantity 无关：
  // 装配件可能落在 partial 桶却 delivered_quantity === 0（装了 3 套、每个子件都交了
  // 40%，凑不满整一套）。组件若按该值过滤，这行会凭空消失。
  it('P15：partial 桶里的装配件行即便已交 0 也照常出行（不做按已交量的重分桶 / 过滤）', () => {
    const items = [
      makeOrder({ id: 'a1', row_type: 'ASSEMBLY', delivered_quantity: 0, quantity: 3 }),
      makeOrder({ id: 'p1', row_type: 'PART', delivered_quantity: 12, quantity: 64 }),
    ];
    const wrapper = mountPanel('partial', items);

    expect(wrapper.findAll('.list-rows .row')).toHaveLength(2);
    expect(wrapper.findAll('.row-qty')[0]?.text()).toBe('0/3');
    wrapper.unmount();
  });
});

describe('SystemDeliveryOrdersPanel — header 单行（slot + total tooltip）', () => {
  it('P13：#header-extra slot 渲染在标题行内（分档 radio 由父组件持有）', () => {
    const wrapper = mountPanel('upcoming', [makeOrder()], {
      slots: { 'header-extra': '<div class="mock-radio">档位切换</div>' },
    });

    expect(wrapper.find('.list-header .mock-radio').text()).toBe('档位切换');
    wrapper.unmount();
  });

  // header 恒一行：四种组合（有/无 slot × 截断/不截断）都只有一个 .list-header，
  // 控件位置不随 total 是否超限而变。
  it('P13b：`.list-header-extra` 在四种组合下都不出现（header 恒一行）', () => {
    const items = [makeOrder({ id: 'p0' })];
    const combos = [
      { total: 99, slots: { 'header-extra': '<div class="mock-radio">档位切换</div>' } },
      { total: 99 },
      { total: 1, slots: { 'header-extra': '<div class="mock-radio">档位切换</div>' } },
      { total: 1 },
    ];
    for (const combo of combos) {
      const wrapper = mountPanel('upcoming', items, combo);
      expect(wrapper.find('.list-header-extra').exists(), JSON.stringify(combo)).toBe(false);
      expect(wrapper.find('.list-header').exists()).toBe(true);
      wrapper.unmount();
    }
  });

  it('P14：total(42) > items.length(2) → 标题 tooltip 出「共 42 条，仅显示前 2 条」', () => {
    // upcoming 桶无时间上界，几百条只显示前 30 条是常态 —— 用户必须能知道被砍了多少。
    // 信息走 tooltip 而不占行高：标题行恒为单行（见 P13b）。
    const items = Array.from({ length: 2 }, (_, i) => makeOrder({ id: `p${i}` }));
    const wrapper = mountPanel('upcoming', items, { total: 42 });

    const tooltip = headerTooltip(wrapper);
    expect(tooltip.props('content')).toBe('共 42 条，仅显示前 2 条');
    expect(tooltip.props('disabled')).toBe(false);
    // 浮层 DOM 侧同步可读（stub 把 content 渲染成 .el-tooltip-stub__content）
    expect(wrapper.find('.list-header .el-tooltip-stub__content').text()).toBe(
      '共 42 条，仅显示前 2 条',
    );
    wrapper.unmount();
  });

  it('P14b：total === items.length / 缺省 → 标题 tooltip disabled（浮层不启用）', () => {
    const items = Array.from({ length: 3 }, (_, i) => makeOrder({ id: `p${i}` }));

    const equal = mountPanel('upcoming', items, { total: 3 });
    expect(headerTooltip(equal).props('content')).toBe('');
    expect(headerTooltip(equal).props('disabled')).toBe(true);
    equal.unmount();

    const noTotal = mountPanel('upcoming', items);
    expect(headerTooltip(noTotal).props('content')).toBe('');
    expect(headerTooltip(noTotal).props('disabled')).toBe(true);
    noTotal.unmount();
  });

  it('P14c：截断 tooltip 与 #header-extra slot 同行共存（radio 仍在 .list-header 内）', () => {
    const wrapper = mountPanel('overdue', [makeOrder()], {
      total: 34,
      slots: { 'header-extra': '<div class="mock-radio">已逾期未交</div>' },
    });

    expect(headerTooltip(wrapper).props('content')).toBe('共 34 条，仅显示前 1 条');
    expect(headerTooltip(wrapper).props('disabled')).toBe(false);
    expect(wrapper.find('.list-header .mock-radio').exists()).toBe(true);
    // radio 与标题同属一行
    expect(wrapper.find('.list-header-extra').exists()).toBe(false);
    wrapper.unmount();
  });
});

describe('SystemDeliveryOrdersPanel — 行点击', () => {
  it('P11：点行 → emit rowClick(item)，row_type 原样透传（不在组件内分流）', async () => {
    const part = makeOrder({ row_type: 'PART' });
    const wrapper = mountPanel('upcoming', [part]);

    await wrapper.find('.list-rows .row').trigger('click');

    const events = wrapper.emitted('rowClick');
    expect(events).toBeTruthy();
    expect(events?.[0]?.[0]).toMatchObject({ id: part.id, serial_no: 'F1016', row_type: 'PART' });
    wrapper.unmount();
  });

  it('P11b：装配件行的 rowClick 也原样带出 row_type=ASSEMBLY（分流在父组件做）', async () => {
    const wrapper = mountPanel('partial', [
      makeOrder({ id: 'asm-1', row_type: 'ASSEMBLY', delivered_quantity: 1, quantity: 3 }),
    ]);

    await wrapper.find('.list-rows .row').trigger('click');

    expect(wrapper.emitted('rowClick')?.[0]?.[0]).toMatchObject({
      id: 'asm-1',
      row_type: 'ASSEMBLY',
    });
    wrapper.unmount();
  });
});

describe('SystemDeliveryOrdersPanel — rowClickable（不可点行）', () => {
  /** SHELF_ACCOUNT 场景的真实判据：零件行可点、装配件行不可点。 */
  const shelfAccountRule = (item: SystemDeliveryOrderData) => item.row_type !== 'ASSEMBLY';

  it('P16a：谓词判不可点的行 → 不 emit rowClick（不触发行点击副作用）', async () => {
    const wrapper = mountPanel(
      'partial',
      [
        makeOrder({ id: 'asm-1', row_type: 'ASSEMBLY', delivered_quantity: 1 }),
        makeOrder({ id: 'p-1', row_type: 'PART', delivered_quantity: 1 }),
      ],
      { rowClickable: shelfAccountRule },
    );

    await wrapper.findAll('.list-rows .row')[0]!.trigger('click');
    // 装配件行被谓词挡住 —— 一次都不该 emit
    expect(wrapper.emitted('rowClick')).toBeFalsy();

    // 同一份数据里零件行照常可点（不对称是被记录的取舍，不是整列锁死）
    await wrapper.findAll('.list-rows .row')[1]!.trigger('click');
    expect(wrapper.emitted('rowClick')?.[0]?.[0]).toMatchObject({ id: 'p-1', row_type: 'PART' });
    wrapper.unmount();
  });

  it('P16b：谓词判不可点的行挂 row--locked 类（视觉可辨，不与可点行混淆）', () => {
    const wrapper = mountPanel(
      'partial',
      [
        makeOrder({ id: 'asm-1', row_type: 'ASSEMBLY' }),
        makeOrder({ id: 'p-1', row_type: 'PART' }),
      ],
      { rowClickable: shelfAccountRule },
    );

    const rows = wrapper.findAll('.list-rows .row');
    expect(rows[0]!.classes()).toContain('row--locked');
    expect(rows[1]!.classes()).not.toContain('row--locked');
    wrapper.unmount();
  });

  it('P16c：加急红底与不可点可并存 —— locked 只接管光标 / hover，不吞加急语义', () => {
    const wrapper = mountPanel(
      'partial',
      [makeOrder({ id: 'asm-1', row_type: 'ASSEMBLY', is_urgent: true })],
      { rowClickable: shelfAccountRule },
    );

    const row = wrapper.find('.list-rows .row');
    expect(row.classes()).toContain('urgent');
    expect(row.classes()).toContain('row--locked');
    wrapper.unmount();
  });

  it('P16d：未传 rowClickable → 全部行可点、无 locked 类（零配置回退）', async () => {
    const wrapper = mountPanel('partial', [makeOrder({ id: 'asm-1', row_type: 'ASSEMBLY' })]);

    const row = wrapper.find('.list-rows .row');
    expect(row.classes()).not.toContain('row--locked');
    await row.trigger('click');
    expect(wrapper.emitted('rowClick')?.[0]?.[0]).toMatchObject({ id: 'asm-1' });
    wrapper.unmount();
  });
});

describe('SystemDeliveryOrdersPanel — 空交期占位', () => {
  it('P17：system_delivery_date 为 null → 交期列出「—」且不带紧迫类', () => {
    // partial 桶无窗口、含该列为 NULL 的工单（排序 NULLS LAST）⇒ 这是真会遇到的行，
    // 空白格看不出是「无交期」还是「缺列」，用破折号占位。
    const wrapper = mountPanel('partial', [
      makeOrder({ system_delivery_date: null, delivered_quantity: 1 }),
    ]);

    const due = wrapper.find('.row-due');
    expect(due.text()).toBe('—');
    expect(due.classes()).not.toContain('overdue');
    expect(due.classes()).not.toContain('due-soon');
    wrapper.unmount();
  });
});

// 样式级守卫：vitest 不处理 SFC 的 <style>（happy-dom 里 styleSheets 恒空），CSS 只能
// 读源码断言。锁的是「标题窄档被挤窄时走省略号、不折行」——折行会把 flex-shrink: 0 的
// .el-card__header 撑高、把下面的行挤少。
describe('SystemDeliveryOrdersPanel — header 标题的 ellipsis 规则', () => {
  const titleRule = ruleBody(STYLE_SRC, '.list-title');

  it('P18a：ellipsis 落在 .list-title 的内层 span 上（flex 容器上 text-overflow 不生效）', () => {
    // 选择器本身必须还在，否则下面的断言会因空串而假绿
    expect(titleRule).not.toBe('');
    const child = />\s*span\s*\{([\s\S]*)$/.exec(titleRule);
    expect(child, '.list-title 下应有 `> span` 子规则承载 ellipsis').toBeTruthy();
    expect(child![1]).toMatch(/overflow:\s*hidden/);
    expect(child![1]).toMatch(/text-overflow:\s*ellipsis/);
    expect(child![1]).toMatch(/white-space:\s*nowrap/);
  });

  it('P18b：.list-title 自身不挂 text-overflow（挂上去是死规则）', () => {
    // 剥掉子规则块后剩下的才是 .list-title 自身的声明。
    const own = titleRule.replace(/>\s*span\s*\{[\s\S]*$/, '');
    expect(own).not.toMatch(/text-overflow/);
    expect(own).toMatch(/min-width:\s*0/);
  });
});
