// @vitest-environment happy-dom
// src/views/workers/components/__tests__/BatchCard.spec.ts
//
// 2026-10-02 新增：BatchCard.vue 组件 spec —— 生产队列看板**唯一**批次卡片的
// 渲染契约。组件零 DTO 依赖、零网络请求，全部断言都是纯渲染 / 事件 / class 形态。
//
// 覆盖：
//   - B1：header 渲染 part_name + :title（长名被 ellipsis 截断，title 兜底）；
//   - B2：body 恒渲染 4 项（serial_no / ×quantity / system_delivery_date / batch_no）；
//   - B3：**body 交期只取 system_delivery_date**，planned_delivery_date 不进 body
//         （两个字段都有值的 fixture：body 只有系统交期，计划交期只出现在 tooltip）；
//   - B4：system_delivery_date 为 null → 渲染 '—'（日期位不留空）；
//   - B5 / B6：is_urgent → 「加急」tag；has_cnc_program → 「已编程」tag；false 不渲染；
//   - B7：selectable=false 不渲染勾选角标（只有待下发池有多选语义）；
//   - B8：点勾选框 → emit toggleSelect（**camelCase**，模板侧监听同形）；
//   - B9：父级透传的 data-* 落到根 div（inheritAttrs:false + v-bind="$attrs" 回归 guard）；
//   - B10：根 div 恒渲染 data-batch-id（拖放链路读 batch_id 的锚点）；
//   - B11：is-selected 类只在 selectable 场景成立（工序池 / 工人列的卡片没有勾选语义）；
//   - B12：batch_no 为空 → tooltip 的批次号行不渲染（顺带覆盖 tooltip 的 v-if）。
//   - B13：accentColor 三级优先级（显式值 > 加急橙 > transparent）。
//
// 环境限制（2026-10-02 记档）：vitest 下 Vue 的 useCssVars 是空实现 ⇒ 模板里
// `v-bind(accentVar)` 产出的 CSS 变量不落 DOM，**样式层的左边框色不可断言**。
// 但 script-setup 的 ref 在 dev 构建下留在 `wrapper.vm.$.setupState` 上，故
// accentColor 的优先级改从 `setupState.accentVar` 断言（等价于模板拿到的那个值）。
//
// 测试策略：
//   - vue-test-utils mount + EP 组件 stub（el-tooltip / el-checkbox）；
//   - el-tooltip stub 同时渲染 default（卡片本体）与 content（tooltip 详情）两个 slot
//     到带类名的包裹里，B3 / B12 才能区分「body 有没有」与「tooltip 有没有」；
//   - 组件自身不 import element-plus（无 ElMessage 路径），故无需模块级 vi.mock。

import { describe, expect, it } from 'vitest';
import { defineComponent, h, type PropType } from 'vue';
import { mount } from '@vue/test-utils';
import BatchCard from '../BatchCard.vue';
import type { BatchCardModel } from '@/types/workerPool';

/** el-tooltip stub：default slot = 卡片本体，content slot = 详情浮层。
 *  两者各包一层带类名的 div，单测才能把「body 渲染了什么」与「tooltip 渲染了什么」
 *  断言分开。 */
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

/** el-checkbox stub：把 @change 接到内层 input 的 change 上（EP 真实行为同源：
 *  勾选变化才派发 change，模型值不带 payload 的语义由 BatchCard 侧消费）。 */
const ElCheckboxStub = defineComponent({
  name: 'ElCheckboxStub',
  props: { modelValue: { type: [Boolean, String, Number], default: false } },
  emits: ['change', 'update:modelValue'],
  setup(props, { emit, slots }) {
    return () =>
      h('span', { class: 'el-checkbox-stub' }, [
        h('input', {
          class: 'el-checkbox-stub__input',
          type: 'checkbox',
          checked: props.modelValue === true,
          onChange: () => emit('change', !props.modelValue),
        }),
        slots.default?.(),
      ]);
  },
});

const globalConfig = {
  components: {
    ElTooltip: ElTooltipStub,
    ElCheckbox: ElCheckboxStub,
  },
};

/** 完整 fixture（2026-10-02）：字段集对齐 BatchCardModel，batch_no 已带 B 前缀
 *  （前缀由适配层 poolItemToCard 拼好，组件不认裸数字）。 */
function makeBatch(overrides: Partial<BatchCardModel> = {}): BatchCardModel {
  return {
    batch_id: '3000000000009',
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
    location: 'SH-A01',
    shelf_id: '5000000000001',
    ...overrides,
  };
}

function mountCard(
  batch: BatchCardModel = makeBatch(),
  props: Record<string, unknown> = {},
  attrs: Record<string, unknown> = {},
) {
  return mount(BatchCard, {
    props: { batch, ...props },
    attrs,
    global: globalConfig,
  });
}

/** 2026-10-02：读 script-setup 暴露到 setupState 上的 accentVar（proxyRefs 已解包，
 *  拿到的就是模板 `v-bind(accentVar)` 实际使用的那个字符串）。 */
function accentVarOf(wrapper: ReturnType<typeof mountCard>): unknown {
  return (wrapper.vm.$ as unknown as { setupState: Record<string, unknown> }).setupState.accentVar;
}

describe('BatchCard（2026-10-02 全看板唯一批次卡片）', () => {
  it('B1：header 渲染 part_name，并带 :title 兜底长名', () => {
    const wrapper = mountCard(makeBatch({ part_name: '连杆总成左前' }));
    const name = wrapper.find('.part-name');
    expect(name.exists()).toBe(true);
    expect(name.text()).toBe('连杆总成左前');
    // 单行 ellipsis 截断（.part-name 的 white-space:nowrap + overflow:hidden）⇒ 必须
    // 给 title，否则超长零件名在 200px 宽卡片里完全不可读。
    expect(name.attributes('title')).toBe('连杆总成左前');
    wrapper.unmount();
  });

  it('B2：body 渲染 4 项（serial_no / ×quantity / system_delivery_date / batch_no）', () => {
    const wrapper = mountCard();
    expect(wrapper.find('.serial-no').text()).toBe('SN-0001');
    expect(wrapper.find('.qty').text()).toBe('×12');
    expect(wrapper.find('.due').text()).toBe('2026-10-20');
    // batch_no 已由适配层补好 B 前缀，组件直接渲染
    expect(wrapper.find('.batch-no').text()).toBe('B1024');
    wrapper.unmount();
  });

  it('B3：body 交期只取 system_delivery_date，planned_delivery_date 只进 tooltip', () => {
    const wrapper = mountCard(
      makeBatch({ system_delivery_date: '2026-10-20', planned_delivery_date: '2026-11-05' }),
    );
    const body = wrapper.find('.el-tooltip-stub__body').html();
    const tooltip = wrapper.find('.el-tooltip-stub__content').html();
    // 系统交期（唯一有承诺口径的日期）上 body
    expect(body).toContain('2026-10-20');
    // 计划交期不上 body —— 计划交期是会变的，低频查阅项，hover 才看
    expect(body).not.toContain('2026-11-05');
    expect(tooltip).toContain('计划交期');
    expect(tooltip).toContain('2026-11-05');
    wrapper.unmount();
  });

  it('B4：system_delivery_date 为 null → 渲染 —（日期位不留空）', () => {
    const wrapper = mountCard(makeBatch({ system_delivery_date: null }));
    expect(wrapper.find('.due').text()).toBe('—');
    wrapper.unmount();
  });

  it('B4b：serial_no 为 null → 渲染 —', () => {
    const wrapper = mountCard(makeBatch({ serial_no: null }));
    expect(wrapper.find('.serial-no').text()).toBe('—');
    wrapper.unmount();
  });

  it('B5：is_urgent → 渲染「加急」；false → 不渲染', () => {
    const urgent = mountCard(makeBatch({ is_urgent: true }));
    expect(urgent.find('.tag--urgent').text()).toBe('加急');
    urgent.unmount();

    const normal = mountCard(makeBatch({ is_urgent: false }));
    expect(normal.find('.tag--urgent').exists()).toBe(false);
    normal.unmount();
  });

  it('B6：has_cnc_program → 渲染「已编程」；false → 不渲染', () => {
    const programmed = mountCard(makeBatch({ has_cnc_program: true }));
    expect(programmed.find('.tag--cnc').text()).toBe('已编程');
    programmed.unmount();

    const notProgrammed = mountCard(makeBatch({ has_cnc_program: false }));
    expect(notProgrammed.find('.tag--cnc').exists()).toBe(false);
    notProgrammed.unmount();
  });

  it('B7：selectable=false → 不渲染勾选角标；true → 渲染', () => {
    const plain = mountCard(makeBatch(), { selectable: false });
    expect(plain.find('.card-check').exists()).toBe(false);
    plain.unmount();

    const selectable = mountCard(makeBatch(), { selectable: true });
    expect(selectable.find('.card-check').exists()).toBe(true);
    selectable.unmount();
  });

  it('B8：点勾选框 → emit toggleSelect（camelCase，不带 payload）', async () => {
    const wrapper = mountCard(makeBatch(), { selectable: true, selected: false });
    await wrapper.find('.el-checkbox-stub__input').trigger('change');
    const emitted = wrapper.emitted('toggleSelect');
    expect(emitted).toHaveLength(1);
    // 不带 payload：同一张卡数组共用一个监听器，batch_id 由消费侧从 batch.batch_id 读
    expect(emitted?.[0]).toEqual([]);
    wrapper.unmount();
  });

  it('B8b：已勾选态再点 → 同样 emit toggleSelect（翻转由消费侧算）', async () => {
    const wrapper = mountCard(makeBatch(), { selectable: true, selected: true });
    const input = wrapper.find('.el-checkbox-stub__input').element as HTMLInputElement;
    expect(input.checked).toBe(true);
    await wrapper.find('.el-checkbox-stub__input').trigger('change');
    expect(wrapper.emitted('toggleSelect')).toHaveLength(1);
    wrapper.unmount();
  });

  it('B9：父级透传的 data-* 落到根 div（inheritAttrs:false + v-bind="$attrs"）', () => {
    // 工序池卡片靠 data-shelf-id 告诉 PoolDrawer「batch 真实所在货架」
    //（POST /prod/pool/move 的 from.shelf_id 必须等于它，否则后端 20122）。若哪天
    // 删掉 v-bind="$attrs"，这条链路会静默断掉而组件自身毫无症状。
    const wrapper = mountCard(
      makeBatch({ shelf_id: '5000000000001' }),
      {},
      { 'data-shelf-id': '5000000000001' },
    );
    expect(wrapper.find('.batch-card').attributes('data-shelf-id')).toBe('5000000000001');
    wrapper.unmount();
  });

  it('B10：根 div 恒渲染 data-batch-id', () => {
    const wrapper = mountCard();
    expect(wrapper.find('.batch-card').attributes('data-batch-id')).toBe('3000000000009');
    wrapper.unmount();
  });

  it('B11：is-selected 只在 selectable 场景成立', () => {
    const selected = mountCard(makeBatch(), { selectable: true, selected: true });
    expect(selected.find('.batch-card').classes()).toEqual(
      expect.arrayContaining(['batch-card', 'is-selectable', 'is-selected']),
    );
    selected.unmount();

    // 工序池 / 工人列的卡片没有勾选语义：即便父级误传 selected=true 也不该高亮
    const notSelectable = mountCard(makeBatch(), { selectable: false, selected: true });
    expect(notSelectable.find('.batch-card').classes()).toContain('batch-card');
    expect(notSelectable.find('.batch-card').classes()).not.toContain('is-selectable');
    expect(notSelectable.find('.batch-card').classes()).not.toContain('is-selected');
    notSelectable.unmount();
  });

  it('B12：batch_no 为空 → tooltip 的批次号行不渲染', () => {
    const wrapper = mountCard(makeBatch({ batch_no: '' }));
    // 断言渲染文本而非 html：tooltip 的 v-if 行上挂着源码注释，html() 里会出现
    // 注释文字，text() 才是「用户真正看到的内容」。
    const tooltipText = wrapper.find('.el-tooltip-stub__content').text();
    expect(tooltipText).not.toContain('批次号');
    // 其余详情行照常渲染（空的是这一个字段，不是整个 tooltip）
    expect(tooltipText).toContain('序列号');
    wrapper.unmount();
  });

  it('B12b：空值字段逐项不渲染 tooltip 行（不留空壳标签）', () => {
    const wrapper = mountCard(
      makeBatch({
        drawing_no: '',
        serial_no: null,
        batch_no: '',
        customer_l1: null,
        customer_l2: null,
        applicant_name: null,
        planned_delivery_date: null,
        location: null,
        note: null,
      }),
    );
    const tooltipText = wrapper.find('.el-tooltip-stub__content').text();
    for (const label of [
      '图号',
      '序列号',
      '批次号',
      '客户(L1)',
      '客户(L2)',
      '申请人',
      '计划交期',
      '所在位置',
      '备注',
    ]) {
      expect(tooltipText).not.toContain(label);
    }
    wrapper.unmount();
  });

  it('B12c：tooltip 容器恒渲染（有详情时）', () => {
    const wrapper = mountCard();
    expect(wrapper.find('.card-tooltip').exists()).toBe(true);
    expect(wrapper.find('.card-tooltip').text()).toContain('客户(L1)');
    wrapper.unmount();
  });

  it('B13：accentColor 三级优先级：显式值 > 加急橙 > 透明', () => {
    // 显式 accentColor 压过加急回落
    const explicit = mountCard(makeBatch({ is_urgent: true }), { accentColor: '#1e4d8b' });
    expect(accentVarOf(explicit)).toBe('#1e4d8b');
    explicit.unmount();

    // 不传 → 回落加急橙（旧卡片的 #e6a23c = --el-color-warning）
    const urgent = mountCard(makeBatch({ is_urgent: true }));
    expect(accentVarOf(urgent)).toBe('var(--el-color-warning)');
    urgent.unmount();

    // 既不传也不加急 → 透明（只留 4px 透明占位，不与相邻卡片粘连）
    const plain = mountCard(makeBatch({ is_urgent: false }));
    expect(accentVarOf(plain)).toBe('transparent');
    plain.unmount();
  });
});
