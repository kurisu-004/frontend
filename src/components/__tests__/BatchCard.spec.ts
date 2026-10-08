// @vitest-environment happy-dom
// src/components/__tests__/BatchCard.spec.ts
//
// 2026-10-02 新增：BatchCard.vue 组件 spec —— 生产队列看板**唯一**批次卡片的
// 渲染契约。组件零 DTO 依赖、零网络请求，全部断言都是纯渲染 / 事件 / class 形态。
//
// 2026-10-03：随组件升为全仓共享组件迁到 src/components/（BatchCard.spec 从
// views/workers/components/__tests__ 一并搬家，断言逐条保留），并补 C 系列用例：
// `extra` 领域扩展槽（只进 tooltip、逐行判空）与 `version`（不渲染、仅随 model 透传）。
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
//   - B13：**竖条两级**（2026-10-09）：`has_process_chain` 真 ⇒ 语义绿；假 ⇒ 中性边框色。
//   - B13b：加急**不再参与**边框（加急只走 body 的「加急」tag）—— 加急 + 无链的卡片
//         竖条必须与「非加急 + 无链」逐字一致。
//   - B14：**源码契约**（读 BatchCard.vue 原文，不挂载组件）—— `.is-selected` 规则必须
//         用 `border-color` 简写给四边统一上色，且不得出现 `border-top-color` /
//         `border-right-color` / `border-bottom-color` 单边上色。左边框恒为 4px，只染
//         其余三边时勾选态的左边框只剩 1px 外圈撑着，视觉上比其它三边细一圈。
//         B11 只断言类名、抓不到这类样式回归，故单列一条源码契约（与
//         src/styles/__tests__/elementPlusManualImportStyles.spec.ts 同款做法）。
//   - B15：源码契约 —— `accentColor` prop 已删除（竖条语义收敛到链之后，全仓零调用方，
//         留着就是一个能被误用的公开 API）。
//
// 环境限制（2026-10-02 记档）：vitest 下 Vue 的 useCssVars 是空实现 ⇒ 模板里
// `v-bind(accentVar)` 产出的 CSS 变量不落 DOM，**样式层的左边框色不可断言**。
// 但 script-setup 的 ref 在 dev 构建下留在 `wrapper.vm.$.setupState` 上，故
// 竖条色改从 `setupState.accentVar` 断言（等价于模板拿到的那个值）。
//
// 测试策略：
//   - vue-test-utils mount + EP 组件 stub（el-tooltip / el-checkbox）；
//   - el-tooltip stub 同时渲染 default（卡片本体）与 content（tooltip 详情）两个 slot
//     到带类名的包裹里，B3 / B12 才能区分「body 有没有」与「tooltip 有没有」；
//   - 组件自身不 import element-plus（无 ElMessage 路径），故无需模块级 vi.mock。

import { describe, expect, it } from 'vitest';
import { defineComponent, h, type PropType } from 'vue';
import { mount } from '@vue/test-utils';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import BatchCard from '../BatchCard.vue';
import type { BatchCardModel } from '@/types/batchCard';

/** 组件源码原文（仅供 B14 的样式契约断言用；渲染类断言一律走挂载，不读源码）。
 *  注意用 `import.meta.url` 字符串而不是 `new URL(...)`：本 spec 跑在 happy-dom 下，
 *  裸 `new URL` 命中的是 happy-dom 的 URL 实现，node 的 fileURLToPath 认不出来。 */
const BATCH_CARD_SRC = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../BatchCard.vue'),
  'utf8',
);

/** 取出 `selector { … }` 这条规则的花括号内原文。取不到（选择器被改名/删除）返回空串，
 *  由用例断言负责报错 —— 刻意不抛，免得选择器拼错时栈里看不到是哪个断言。 */
function cssRuleBody(src: string, selector: string): string {
  const at = src.indexOf(`${selector} {`);
  if (at < 0) return '';
  const bodyStart = at + selector.length + 2;
  const end = src.indexOf('}', bodyStart);
  return src.slice(bodyStart, end < 0 ? src.length : end);
}

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
    has_process_chain: false,
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

/** tooltip 区域的纯文本（断言「用户真正看到的内容」；html() 会带源码注释文字）。 */
function tooltipTextOf(wrapper: ReturnType<typeof mountCard>): string {
  return wrapper.find('.el-tooltip-stub__content').text();
}

/** body 区域的纯文本（body 是 4 行硬预算，改动后逐行内容都要能断言）。 */
function bodyTextOf(wrapper: ReturnType<typeof mountCard>): string {
  return wrapper.find('.el-tooltip-stub__body').text();
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

  it('B13：竖条只给「有链且指针未漂移」——真 ⇒ 语义绿，假 ⇒ 中性边框色', () => {
    // 绿边框的唯一语义：有制定工序链且 current_process_step_id 指向的工序 == 当前工序
    const chained = mountCard(makeBatch({ has_process_chain: true }));
    expect(accentVarOf(chained)).toBe('var(--el-color-success)');
    chained.unmount();

    // 无链 / 链指针漂移：落回与另外三边同色的中性边框色（不是透明，竖条恒可见）
    const noChain = mountCard(makeBatch({ has_process_chain: false }));
    expect(accentVarOf(noChain)).toBe('var(--el-border-color-lighter)');
    noChain.unmount();
  });

  // 加急件与有链件高度重叠，两者抢同一条竖条时谁后渲染谁盖谁 —— 边框让位给链。
  it('B13b：加急不再参与竖条（false + is_urgent 的竖条与普通无链卡逐字一致）', () => {
    const urgent = mountCard(makeBatch({ has_process_chain: false, is_urgent: true }));
    const plain = mountCard(makeBatch({ has_process_chain: false, is_urgent: false }));
    expect(accentVarOf(urgent)).toBe(accentVarOf(plain));
    expect(accentVarOf(urgent)).not.toBe('var(--el-color-success)');
    // 加急的承载物仍是 body 上的 tag（删掉的只是边框这一层语义）
    expect(urgent.find('.tag--urgent').exists()).toBe(true);
    urgent.unmount();
    plain.unmount();
  });

  it('B14：勾选态四边统一主色描边（源码契约，不用单边 border-*-color）', () => {
    const rule = cssRuleBody(BATCH_CARD_SRC, '.batch-card.is-selected');
    // 选择器本身必须还在，否则下面的断言会因为空串而假绿
    expect(rule).not.toBe('');
    // `border-color` 简写不重置 border-width / border-style：左边框仍是 4px，四边同色
    expect(rule).toContain('border-color: var(--el-color-primary)');
    // 单边上色会让 4px 左边框在勾选态只剩 1px 外圈撑着，比其它三边细一圈
    for (const single of ['border-top-color', 'border-right-color', 'border-bottom-color']) {
      expect(rule).not.toContain(single);
    }
    // 加急语义的承载物（橙色 tag）仍在 body 里
    expect(BATCH_CARD_SRC).toContain('tag--urgent');
  });

  it('B15：源码契约 —— accentColor prop 已删除（竖条语义只剩链）', () => {
    // 保留它就等于留一个能被误用的公开 API（传进来会盖掉链语义，而全仓零调用方）
    expect(BATCH_CARD_SRC).not.toContain('accentColor');
    expect(BATCH_CARD_SRC).not.toContain('accent-color');
    // 竖条色仍然由 accentVar 驱动（CSS 侧 v-bind(accentVar)），别改成写死的字面量
    expect(BATCH_CARD_SRC).toContain('border-left-color: v-bind(accentVar)');
  });

  // ===== 2026-10-03：共享化后的扩展字段（extra 扩展槽 / version OCC 锚） =====

  it('C1：body 恒 4 行 —— extra 全部渲染进 tooltip，一行都不许挤进 body', () => {
    // 卡片 200×96 是硬预算（4×18 行高 + 3×2 gap + 上下各 8 padding + 上下各 1px
    // 边框 = 96px，无余量）。外协信息若有一条漏进 body，卡片就会溢出裁切。
    const wrapper = mountCard(
      makeBatch({
        version: 7,
        extra: {
          outsource_company_name: '宏远外协',
          outsource_process_name: '外协热处理',
          price: '12.50',
          sent_at: '2026-10-01 09:30',
          can_auto_receive: false,
        },
      }),
    );
    expect(wrapper.findAll('.el-tooltip-stub__body .row')).toHaveLength(4);
    const body = bodyTextOf(wrapper);
    for (const leaked of ['宏远外协', '外协热处理', '12.50', '2026-10-01 09:30']) {
      expect(body).not.toContain(leaked);
      expect(tooltipTextOf(wrapper)).toContain(leaked);
    }
    wrapper.unmount();
  });

  it('C2：extra 五个字段各出一行中文标签', () => {
    const wrapper = mountCard(
      makeBatch({
        extra: {
          outsource_company_name: '宏远外协',
          outsource_process_name: '外协热处理',
          price: '12.50',
          sent_at: '2026-10-01 09:30',
          can_auto_receive: false,
        },
      }),
    );
    const text = tooltipTextOf(wrapper);
    expect(text).toContain('外协公司');
    expect(text).toContain('外协工序');
    expect(text).toContain('单价');
    expect(text).toContain('发出时间');
    // can_auto_receive=false 是**否定语义**，必须给可读文案而不是空值占位
    expect(text).toContain('接收');
    expect(text).toContain('需手填工序');
    wrapper.unmount();
  });

  it('C3：can_auto_receive=true → 渲染「可自动带出」；null / undefined → 整行不渲染', () => {
    const auto = mountCard(makeBatch({ extra: { can_auto_receive: true } }));
    expect(tooltipTextOf(auto)).toContain('可自动带出');
    auto.unmount();

    // 三态布尔的「未知」侧：既不报可自动、也不报需手填
    const unknown = mountCard(makeBatch({ extra: { can_auto_receive: null } }));
    expect(tooltipTextOf(unknown)).not.toContain('接收');
    unknown.unmount();

    const absent = mountCard(makeBatch({ extra: {} }));
    expect(tooltipTextOf(absent)).not.toContain('接收');
    absent.unmount();
  });

  it('C4：extra 为 undefined → tooltip 与生产队列域下逐行一致（无任何外协标签）', () => {
    // 回归 guard：共享组件不能因为扩了槽就让既有域的 tooltip 多出空行 / 空标签。
    const withExtra = mountCard();
    const plain = mountCard(makeBatch({ extra: undefined }));
    expect(tooltipTextOf(plain)).toBe(tooltipTextOf(withExtra));
    for (const label of ['外协公司', '外协工序', '单价', '发出时间', '接收']) {
      expect(tooltipTextOf(plain)).not.toContain(label);
    }
    withExtra.unmount();
    plain.unmount();
  });

  it('C5：extra 逐行判空（部分填、其余 null 不留空标签）', () => {
    const wrapper = mountCard(
      makeBatch({
        extra: {
          outsource_company_name: '宏远外协',
          outsource_process_name: null,
          price: null,
          sent_at: undefined,
          can_auto_receive: null,
        },
      }),
    );
    const text = tooltipTextOf(wrapper);
    expect(text).toContain('外协公司');
    for (const label of ['外协工序', '单价', '发出时间', '接收']) {
      expect(text).not.toContain(label);
    }
    wrapper.unmount();
  });

  it('C6：hasDetails 把 extra 算进去 —— 只有 extra 内容时 tooltip 仍能弹', () => {
    // 空槽 {} / 全 null 不算「有详情」：否则会弹出一个只有空白的浮层。
    const onlyExtra = mountCard(
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
        extra: { outsource_company_name: '宏远外协' },
      }),
    );
    expect(onlyExtra.findComponent(ElTooltipStub).props('disabled')).toBe(false);
    onlyExtra.unmount();

    const emptySlot = mountCard(
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
        extra: {},
      }),
    );
    expect(emptySlot.findComponent(ElTooltipStub).props('disabled')).toBe(true);
    emptySlot.unmount();
  });

  it('C7：version 只作为 model 字段透传，卡片不渲染也不影响任何既有渲染', () => {
    const withVersion = mountCard(makeBatch({ version: 9 }));
    const withoutVersion = mountCard(makeBatch({ version: undefined }));
    // 渲染结果逐字一致：OCC 锚是消费侧（外协收发写端点）的事，卡片不感知
    expect(bodyTextOf(withVersion)).toBe(bodyTextOf(withoutVersion));
    expect(tooltipTextOf(withVersion)).toBe(tooltipTextOf(withoutVersion));
    // model 上确实带着（消费侧从 props.batch.version 读，不是从 DOM 挖）
    expect((withVersion.props('batch') as BatchCardModel).version).toBe(9);
    withVersion.unmount();
    withoutVersion.unmount();
  });
});
