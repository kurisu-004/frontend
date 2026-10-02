// src/views/parts/detail/components/__tests__/ProcessChainCard.spec.ts
// @vitest-environment happy-dom
//
// 2026-10-02 新增：工序链时间轴卡的渲染守卫。
//
// 为什么要有（背景，两个用户可见缺陷都落在这张卡上）：
//   1. 工序名退化成裸 process_id：字典（processesLookup）在进页面时为空，
//      卡片回退渲染 step.process_id。
//   2. 一进页面没有任何节点高亮：currentStepId 恒 null ⇒ currentIndex = -1 ⇒
//      `.current-step` 永不命中，且「没选中批次」与「批次没绑定步骤」在 UI 上
//      长得一样（全灰）。
//
// 覆盖：
//   - C1：传 processesLookup → 渲染工序名而非 process_id；字典缺失时回退 id 且带 title。
//   - C2：currentStepId 命中 → 该节点带 current-step + 「当前」徽标，前置节点为「已完成」。
//   - C3：未选中批次 → 无节点带 current-step，提示「未选中批次，请点击批次行」。
//   - C3b：批次已选中但没绑工序链步骤（currentStepId=null 且 selectedBatchId 非空）
//          → 提示「所选批次未绑定工序链步骤」。两种成因在 currentStepId 上无法区分
//          （都是 null），所以判据必须是选中态。
//   - C3c：批次已选中、currentStepId 非空但不在链上 → 同上文案。
//   - C4：steps 为空 → 空态「暂无工序链」，不出提示条。
//
// 挂载手法沿 src/views/auth/__tests__/LoginCard.spec.ts：仓内日常开发走
// unplugin-vue-components 自动注册 el-*，vitest 单独跑不走该插件，故挂最小 stub。
// ⚠️ 本文件**不**需要 `vi.mock('element-plus')` —— 那条桩法是为触发
// `ElMessage` 的组件准备的（node env 下 EP 内部 normalizeAppendTo 会读
// document），而本组件只用 el-* 组件 + v-loading 指令，全程不碰 ElMessage，
// 挂 stub 即可。

import { describe, it, expect } from 'vitest';
import { defineComponent, h } from 'vue';
import { mount } from '@vue/test-utils';
import ProcessChainCard from '../ProcessChainCard.vue';
import type { ProcessChainStepDto } from '@/api/processChain.contract';

const ElCardStub = defineComponent({
  name: 'ElCardStub',
  setup(_, { slots }) {
    return () => h('div', { class: 'el-card-stub' }, [slots.header?.(), slots.default?.()]);
  },
});

/** el-timeline-item 把 class 透传到根节点（真实 EP 也是这么做的），
 *  断言 `current-step` 靠的就是它。 */
const ElTimelineItemStub = defineComponent({
  name: 'ElTimelineItemStub',
  inheritAttrs: false,
  setup(_, { slots, attrs }) {
    return () => h('div', { class: ['el-timeline-item-stub', attrs.class as string] }, [
      attrs.timestamp ? h('div', { class: 'ts' }, String(attrs.timestamp)) : null,
      slots.default?.(),
    ]);
  },
});

const ElTimelineStub = defineComponent({
  name: 'ElTimelineStub',
  setup(_, { slots }) {
    return () => h('div', { class: 'el-timeline-stub' }, slots.default?.());
  },
});

const ElAlertStub = defineComponent({
  name: 'ElAlertStub',
  setup(_, { attrs }) {
    const title = String(attrs.title ?? '');
    return () => h('div', { class: 'el-alert-stub', title }, title);
  },
});

const ElEmptyStub = defineComponent({
  name: 'ElEmptyStub',
  setup(_, { attrs }) {
    return () => h('div', { class: 'el-empty-stub' }, String(attrs.description ?? ''));
  },
});

const ElIconStub = defineComponent({
  name: 'ElIconStub',
  setup(_, { slots }) {
    return () => h('i', { class: 'el-icon-stub' }, slots.default?.());
  },
});

const globalConfig = {
  components: {
    ElCard: ElCardStub,
    ElTimeline: ElTimelineStub,
    ElTimelineItem: ElTimelineItemStub,
    ElAlert: ElAlertStub,
    ElEmpty: ElEmptyStub,
    ElIcon: ElIconStub,
  },
  directives: {
    loading: () => undefined,
  },
};

const STEPS: ProcessChainStepDto[] = [
  { id: 'step-1', sort_order: 0, process_id: 'p-cut', estimated_minutes: 10 },
  { id: 'step-2', sort_order: 1, process_id: 'p-weld', estimated_minutes: 20 },
  { id: 'step-3', sort_order: 2, process_id: 'p-paint', estimated_minutes: 0 },
];

const LOOKUP = {
  'p-cut': { code: 'CUT', name: '切割' },
  'p-weld': { code: 'WELD', name: '焊接' },
  'p-paint': { code: 'PAINT', name: '喷涂' },
};

function mountCard(props: {
  steps?: ProcessChainStepDto[];
  currentStepId?: string | null;
  selectedBatchId?: string | null;
  processesLookup?: Record<string, { code: string; name: string }>;
}) {
  return mount(ProcessChainCard, {
    props: {
      steps: props.steps ?? STEPS,
      currentStepId: props.currentStepId ?? null,
      selectedBatchId: props.selectedBatchId ?? null,
      loading: false,
      ...(props.processesLookup === undefined ? {} : { processesLookup: props.processesLookup }),
    },
    global: globalConfig,
  });
}

describe('ProcessChainCard', () => {
  it('C1：传字典时渲染工序名而非 process_id', () => {
    const wrapper = mountCard({ processesLookup: LOOKUP });
    const text = wrapper.text();
    expect(text).toContain('切割');
    expect(text).toContain('焊接');
    expect(text).toContain('喷涂');
    expect(text).not.toContain('p-cut');
    expect(text).not.toContain('p-weld');
    // 工序名带 title 兜底，悬停可见完整内容
    expect(wrapper.find('.step-name').attributes('title')).toBe('切割');
  });

  it('C1b：字典缺失时回退 process_id，且仍带 title', () => {
    const wrapper = mountCard({});
    const first = wrapper.find('.step-name');
    expect(first.text()).toBe('p-cut');
    expect(first.attributes('title')).toBe('p-cut');
  });

  it('C2：currentStepId 命中 → 该节点带 current-step + 「当前」徽标，前置节点为「已完成」', () => {
    const wrapper = mountCard({ currentStepId: 'step-2', processesLookup: LOOKUP });
    const items = wrapper.findAll('.el-timeline-item-stub');
    expect(items).toHaveLength(3);
    expect(items[0]!.classes()).not.toContain('current-step');
    expect(items[1]!.classes()).toContain('current-step');
    expect(items[2]!.classes()).not.toContain('current-step');
    expect(items[0]!.text()).toContain('已完成');
    expect(items[1]!.text()).toContain('当前');
    expect(items[2]!.text()).not.toContain('已完成');
    expect(items[2]!.text()).not.toContain('当前');
  });

  it('C3：未选中批次 → 无节点高亮，提示「未选中批次，请点击批次行」', () => {
    const wrapper = mountCard({ currentStepId: null, selectedBatchId: null, processesLookup: LOOKUP });
    expect(wrapper.findAll('.current-step')).toHaveLength(0);
    const alert = wrapper.find('.el-alert-stub');
    expect(alert.exists()).toBe(true);
    expect(alert.text()).toContain('未选中批次，请点击批次行');
  });

  it('C3b：批次已选中但没绑工序链步骤（currentStepId=null）→ 提示「未绑定工序链步骤」', () => {
    // 初始批次（PENDING）/ 已取消批次的 current_process_step_id 恒为 null，
    // 兜底选中它们时就会落进这一支，文案不能谎称「未选中批次」。
    const wrapper = mountCard({
      currentStepId: null,
      selectedBatchId: 'b1',
      processesLookup: LOOKUP,
    });
    expect(wrapper.findAll('.current-step')).toHaveLength(0);
    expect(wrapper.find('.el-alert-stub').text()).toContain('所选批次未绑定工序链步骤');
  });

  it('C3c：批次已选中、currentStepId 非空但不在链上 → 同「未绑定工序链步骤」', () => {
    const wrapper = mountCard({
      currentStepId: 'step-404',
      selectedBatchId: 'b1',
      processesLookup: LOOKUP,
    });
    expect(wrapper.findAll('.current-step')).toHaveLength(0);
    expect(wrapper.find('.el-alert-stub').text()).toContain('所选批次未绑定工序链步骤');
  });

  it('C4：steps 为空 → 空态文案，且不出现提示条', () => {
    const wrapper = mountCard({ steps: [], currentStepId: 'step-1', processesLookup: LOOKUP });
    expect(wrapper.find('.el-empty-stub').text()).toContain('暂无工序链');
    expect(wrapper.find('.el-alert-stub').exists()).toBe(false);
  });
});
