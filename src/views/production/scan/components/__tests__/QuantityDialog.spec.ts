// @vitest-environment happy-dom
// src/views/production/scan/components/__tests__/QuantityDialog.spec.ts
//
// 大号触屏数量弹窗的回归守卫。2026-10-11 放回 / 送检页把「指定数量」接进正常流程后，
// 本组件从「只在取件页顺带用一下」变成**放回与送检每次提交前的必经一步**（见
// `ScanReturnParts.vue::openQtyDialog` 与 `ScanInspectParts.vue::openQtyDialog`），
// 却没有自己的任何用例 —— 它一旦坏掉，症状是「放回 / 送检提交的数量恒为批次全量」
// 或「数量调到 0 也能提交」，两处都不报错，只在数据上慢慢体现。
//
// 三条要紧的不变量：
//   1. **打开时默认 = max**（整批）。工人在 HMI 上只想整批放回时点一下「确定」即可，
//      不必先按几十次「归零」再往回加 —— 打开就等于 0 会让「确定」按钮直接是禁用的。
//   2. 「确定」emit 的就是当前显示的那个数。
//   3. **`<= 0` 不可确认**：后端 `q <= 0` 返 20111，弹窗这一层拦住比事后报错好。
//      拦两道 —— 按钮 `disabled`（DOM 闸门）+ `onConfirm` 里的 `if (qty <= 0) return`
//      （行为闸门）：disabled 的原生按钮在某些环境里仍能收到 click。
//   4. **右上角 × 必须不存在**（`:show-close="false"`）：放回 / 送检每条提交都从本弹窗
//      过、而它是唯一提交闸门，× 只关弹窗不发 `cancel` ⇒ 调用方的选中态留着，
//      送检页那条路上连确认栏都已经消失（见组件注释）。

import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import QuantityDialog from '../QuantityDialog.vue';

const stubs = {
  'el-dialog': {
    name: 'ElDialogStub',
    // ⚠️ `showClose` 必须列进 props 并透出成 data-*：Element Plus 的 el-dialog 把它
    // 默认成 true，父组件不显式传 `:show-close="false"` 时 × 会渲染出来，而 × 只 emit
    // `update:modelValue(false)`、不发业务事件。桩若不接这个 prop，`String(undefined)`
    // 恒为 'undefined'，断言就成了恒真。
    props: ['modelValue', 'title', 'width', 'showClose'],
    template:
      '<div v-if="modelValue" class="mock-dialog" :data-showclose="String(showClose)"><slot /><slot name="footer" /></div>',
  },
  'el-button': {
    name: 'ElButtonStub',
    props: { disabled: Boolean },
    emits: ['click'],
    template:
      '<button :disabled="disabled" :data-disabled="String(disabled)" @click="$emit(\'click\')"><slot /></button>',
  },
};

async function mountDialog(max: number) {
  const w = mount(QuantityDialog, {
    props: { modelValue: false, max, serialNo: 'SN-1', partName: '法兰盘', actionLabel: '放回' },
    global: { stubs },
  });
  await w.setProps({ modelValue: true });
  return w;
}

/** 按文案取弹窗内的一个按钮（.btn-grid / .footer-btn 都在按钮上）。 */
function buttonByText(w: ReturnType<typeof mount>, text: string) {
  const btn = w.findAll('button').find((b) => b.text().replace(/\s+/g, '') === text);
  expect(btn, `弹窗里没有「${text}」按钮`).toBeDefined();
  return btn!;
}

describe('QuantityDialog / 默认值与确认', () => {
  it('Q1：打开时默认 = max（整批），不是 0', async () => {
    const w = await mountDialog(12);
    expect(w.find('.qty-number').text()).toBe('12');
    expect(w.find('.qty-max').text()).toBe('/ 12');
    // 「上限」那一行是弹窗给出的事实来源：后端 q > batch.quantity 返 20111
    expect(w.text()).toContain('上限');
    w.unmount();
  });

  it('Q2：点「确定」emit 当前显示的数量', async () => {
    const w = await mountDialog(12);
    // 加法在上限处夹住：12 已经是 max，+1 之后仍是 12
    await buttonByText(w, '+1').trigger('click');
    expect(w.find('.qty-number').text()).toBe('12');
    await buttonByText(w, '-10').trigger('click');
    expect(w.find('.qty-number').text()).toBe('2');

    await buttonByText(w, '确定放回').trigger('click');
    expect(w.emitted('confirm')).toEqual([[2]]);
    w.unmount();
  });

  it('Q3：数量调到 0 时「确定」不可确认（既 disabled 也不 emit）', async () => {
    const w = await mountDialog(12);
    await buttonByText(w, '归零').trigger('click');
    expect(w.find('.qty-number').text()).toBe('0');

    const ok = buttonByText(w, '确定放回');
    expect(ok.attributes('data-disabled')).toBe('true');
    // disabled 的原生按钮在部分环境仍能收到 click ⇒ 组件内那道 `if (qty <= 0) return`
    // 是真正的行为闸门，必须单独验
    await ok.trigger('click');
    expect(w.emitted('confirm')).toBeUndefined();
    w.unmount();
  });

  it('Q4：「最大化」回到上限，「-1」不越过 0 下限', async () => {
    const w = await mountDialog(5);
    await buttonByText(w, '-10').trigger('click');
    expect(w.find('.qty-number').text()).toBe('0');
    await buttonByText(w, '最大化').trigger('click');
    expect(w.find('.qty-number').text()).toBe('5');
    // 「+10」也不会超过上限（后端 20111 的前端对应物）
    await buttonByText(w, '+10').trigger('click');
    expect(w.find('.qty-number').text()).toBe('5');
    w.unmount();
  });

  it('Q5：点「取消」只 emit cancel，不 emit confirm', async () => {
    const w = await mountDialog(4);
    await buttonByText(w, '取消').trigger('click');
    expect(w.emitted('cancel')).toHaveLength(1);
    expect(w.emitted('confirm')).toBeUndefined();
    // 关闭由 emit('update:modelValue', false) 表达（v-model 直通，组件不持有显隐状态）
    expect(w.emitted('update:modelValue')).toEqual([[false]]);
    w.unmount();
  });

  // ⛔ 2026-10-11：放回 / 送检每条提交都从本弹窗过，它是那条路径唯一的提交闸门。
  // × 只 emit update:modelValue(false)、不发 cancel ⇒ 调用方的 selectedPart /
  // selectedNextProcessId 全部留着；送检页那条路上确认栏已经消失（awaitingScan 已
  // 置 false），工人既没弹窗也没确认栏可走。
  it('Q7：右上角 × 被关掉 —— 关闭权只在 footer 两键上', async () => {
    const w = await mountDialog(7);
    expect(
      w.find('.mock-dialog').attributes('data-showclose'),
      'showClose 没显式关成 false ⇒ 右上角 × 会渲染出来（Element Plus 默认 true）',
    ).toBe('false');
    w.unmount();
  });

  // 2026-10-11 接进正常流程之后，每次提交都是「开着 → 改数量 → 提交」，而 max 会随
  // 列表刷新变化（部分流转后余量变小）。开着期间改 max，旧值可能已越界 ⇒ 重开必须
  // 回到**新的** max。这条路径此前零覆盖。
  it('Q6：开着时改 max → 归零 → 取消 → 再开，值回到新的 max', async () => {
    const w = await mountDialog(12);
    expect(w.find('.qty-number').text()).toBe('12');

    // 开着期间上界被改小（模拟部分流转后列表刷新，max 变小）
    await w.setProps({ max: 5 });
    await buttonByText(w, '归零').trigger('click');
    expect(w.find('.qty-number').text()).toBe('0');

    // 取消关掉（v-model 由调用方回写 false）
    await buttonByText(w, '取消').trigger('click');
    await w.setProps({ modelValue: false });

    // 再开：必须取**新的** max，而不是残留的 0 或旧 max
    await w.setProps({ modelValue: true });
    expect(w.find('.qty-number').text(), '重开时默认值必须跟随新的 max').toBe('5');
    expect(w.find('.qty-max').text()).toBe('/ 5');

    // 且不能确认到越界值（旧 max 12 那套夹逼已随 max 一起换掉）
    await buttonByText(w, '+10').trigger('click');
    expect(w.find('.qty-number').text()).toBe('5');
    w.unmount();
  });
});
