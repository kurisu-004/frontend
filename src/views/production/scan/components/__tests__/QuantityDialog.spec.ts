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

import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import QuantityDialog from '../QuantityDialog.vue';

const stubs = {
  'el-dialog': {
    name: 'ElDialogStub',
    props: ['modelValue', 'title', 'width'],
    // 只在开着时渲染，与生产行为一致（`@closed` 之后内容才被 destroy）
    template: '<div v-if="modelValue" class="mock-dialog"><slot /><slot name="footer" /></div>',
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
});
