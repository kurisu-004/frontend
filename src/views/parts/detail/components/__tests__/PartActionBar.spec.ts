// src/views/parts/detail/components/__tests__/PartActionBar.spec.ts
// @vitest-environment happy-dom
//
// 2026-10-10 新增：底部操作卡从 `PartDetail.vue` 抽出后的门控守卫。
//
// 为什么要有：这张卡承载本域最容易回归的一段口径 —— **两个品检按钮必须打在同一个批次**。
// 判据曾经分叉过（品检通过按 `find(INSPECTION)` 取列表首条、指定工序按 shell 传的
// `selectedBatchId` 取用户当前选中行），多批次工单上两个按钮打不同的批次而界面上完全
// 看不出来。抽出成组件后，「共用同一个 `inspectionBatch` prop」这条从「约定」变成
// 「组件的 props 形状」，钉住它。
//
// 另钉三条门控：`canInspect` 短路、取消订单排除终态、删除只看角色。
//
// 挂载手法沿同目录 `ProcessChainCard.spec.ts`：仓内开发走 unplugin-vue-components 自动
// 注册 el-*，vitest 单独跑不走该插件，故挂最小 stub。本组件不用 ElMessage，无需
// `vi.mock('element-plus')`。

import { describe, it, expect } from 'vitest';
import { defineComponent, h } from 'vue';
import { mount } from '@vue/test-utils';
import PartActionBar from '../PartActionBar.vue';
import type { PartBatch } from '@/api/parts';
import type { OrderStatus } from '@/types/parts';

const ElCardStub = defineComponent({
  name: 'ElCardStub',
  setup(_, { slots }) {
    return () => h('div', { class: 'el-card-stub' }, [slots.header?.(), slots.default?.()]);
  },
});

// ⚠️ 刻意**不**声明 `emits`：stub 不接事件，父级模板上的 `@pass` / `@click` 等会作为
// attrs 落到根 `<button>` 上变成原生监听 ⇒ `trigger('click')` 恰好触发一次，
// 不会出现「组件事件 + 原生事件各触发一次」的重复计数。
const ElButtonStub = defineComponent({
  name: 'ElButtonStub',
  inheritAttrs: false,
  setup(_, { slots, attrs }) {
    return () =>
      h(
        'button',
        {
          ...attrs,
          class: 'el-button-stub',
          disabled: attrs.disabled === true || attrs.loading === true,
        },
        slots.default?.(),
      );
  },
});

const globalConfig = { components: { ElCard: ElCardStub, ElButton: ElButtonStub } };

function makeBatch(over: Partial<PartBatch> = {}): PartBatch {
  return {
    id: 'B_INSPECTION',
    version: 3,
    part_id: '42',
    batch_no: 2,
    batch_label: 'L2',
    quantity: 7,
    status: 'INSPECTION',
    is_repairing: false,
    location: 'INSPECTION_SHELF',
    current_holder_id: null,
    current_holder_display: '',
    current_process_step_id: null,
    next_process_name: null,
    delivery_note_id: null,
    delivery_note_no: null,
    parent_batch_id: null,
    created_at: '2026-10-10 08:00:00',
    updated_at: '2026-10-10 08:00:00',
    ...over,
  };
}

function mountBar(props: {
  visible?: boolean;
  status?: OrderStatus | null;
  canInspect?: boolean;
  canCancelPart?: boolean;
  canDeletePart?: boolean;
  inspectionBatch?: PartBatch | null;
  passSubmitting?: boolean;
}) {
  return mount(PartActionBar, {
    props: {
      visible: props.visible ?? true,
      status: props.status ?? 'IN_PROCESS',
      canInspect: props.canInspect ?? true,
      canCancelPart: props.canCancelPart ?? true,
      canDeletePart: props.canDeletePart ?? true,
      inspectionBatch: props.inspectionBatch === undefined ? makeBatch() : props.inspectionBatch,
      passSubmitting: props.passSubmitting ?? false,
    },
    global: globalConfig,
  });
}

/** 按钮文本列表（按渲染顺序）。 */
function buttonTexts(wrapper: ReturnType<typeof mountBar>): string[] {
  return wrapper.findAll('button').map((b) => b.text());
}

describe('PartActionBar', () => {
  it('A1：两个品检按钮共用同一个 inspectionBatch —— 目标批次标识与按钮同块渲染，且回显的是它', () => {
    const batch = makeBatch({ batch_label: 'L9', quantity: 12 });
    const wrapper = mountBar({ inspectionBatch: batch });
    const anchor = wrapper.find('.inspection-anchor');
    expect(anchor.exists()).toBe(true);
    expect(anchor.text()).toContain('L9');
    expect(anchor.text()).toContain('12');
    // 按钮组里确实有那两个按钮（共用这个锚的另一半证据）
    expect(buttonTexts(wrapper)).toContain('品检通过');
    expect(buttonTexts(wrapper)).toContain('指定工序');
  });

  it('A2：inspectionBatch 为 null → 两个品检按钮与目标批次标识整体消失（其余按钮不受影响）', () => {
    const wrapper = mountBar({ inspectionBatch: null });
    expect(wrapper.find('.inspection-anchor').exists()).toBe(false);
    const texts = buttonTexts(wrapper);
    expect(texts).not.toContain('品检通过');
    expect(texts).not.toContain('指定工序');
    expect(texts).toContain('取消订单');
    expect(texts).toContain('删除');
  });

  it('A3：canInspect 为 false 时同样不渲染两个品检按钮（角色门控在按钮组之前）', () => {
    const wrapper = mountBar({ canInspect: false });
    expect(wrapper.find('.inspection-anchor').exists()).toBe(false);
    expect(buttonTexts(wrapper)).not.toContain('品检通过');
  });

  it('A4：详情未加载（visible=false）→ 整卡不渲染', () => {
    const wrapper = mountBar({ visible: false });
    expect(wrapper.find('.el-card-stub').exists()).toBe(false);
    expect(buttonTexts(wrapper)).toEqual([]);
  });

  it('A5：取消订单在 CANCELLED / COMPLETED 两个终态下都不出现', () => {
    expect(buttonTexts(mountBar({ status: 'CANCELLED' }))).not.toContain('取消订单');
    expect(buttonTexts(mountBar({ status: 'COMPLETED' }))).not.toContain('取消订单');
    expect(buttonTexts(mountBar({ status: 'IN_PROCESS' }))).toContain('取消订单');
  });

  it('A6：删除只由 canDeletePart 决定（后端软删仅 MANAGER）', () => {
    expect(buttonTexts(mountBar({ canDeletePart: false }))).not.toContain('删除');
    expect(buttonTexts(mountBar({ canDeletePart: true }))).toContain('删除');
  });

  it('A7：四个按钮各自 emit 自己的事件，且都不自己发请求', async () => {
    const wrapper = mountBar({ passSubmitting: false });
    const texts = buttonTexts(wrapper);
    const index = (label: string) => texts.indexOf(label);

    await wrapper.findAll('button')[index('品检通过')]!.trigger('click');
    await wrapper.findAll('button')[index('指定工序')]!.trigger('click');
    await wrapper.findAll('button')[index('取消订单')]!.trigger('click');
    await wrapper.findAll('button')[index('删除')]!.trigger('click');

    expect(wrapper.emitted('pass')).toHaveLength(1);
    expect(wrapper.emitted('openFailInsp')).toHaveLength(1);
    expect(wrapper.emitted('cancelOrder')).toHaveLength(1);
    expect(wrapper.emitted('deletePart')).toHaveLength(1);
  });

  it('A8：passSubmitting 只作用在「品检通过」按钮上（提交中禁用，不牵连另外三个）', () => {
    const wrapper = mountBar({ passSubmitting: true });
    const texts = buttonTexts(wrapper);
    const buttons = wrapper.findAll('button');
    const passBtn = buttons[texts.indexOf('品检通过')]!;
    const failBtn = buttons[texts.indexOf('指定工序')]!;
    const cancelBtn = buttons[texts.indexOf('取消订单')]!;
    const delBtn = buttons[texts.indexOf('删除')]!;
    expect(passBtn.attributes('disabled')).toBeDefined();
    expect(failBtn.attributes('disabled')).toBeUndefined();
    expect(cancelBtn.attributes('disabled')).toBeUndefined();
    expect(delBtn.attributes('disabled')).toBeUndefined();
  });
});
