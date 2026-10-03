// @vitest-environment happy-dom
// src/views/scan/components/__tests__/ReturnConfirmDialog.spec.ts
//
// 2026-10-04 新增：放回流程「链已知」单确认弹窗的渲染 + 事件契约守卫。
//
// 为什么这批断言值得单独钉住：
//   1. 主文案是**工人照着执行**的唯一依据（「下一道工序为 X，请将工件放到 Y 货架」）。
//      少了工序名或货架码，工人物件会放到没配该工序的架上（worker-scan 报
//      20507 BIZ_SHELF_PROCESS_NOT_MAPPED），但那时已经离架了。
//   2. 三个 footer 按钮对应三条**不同**的流程出口：确认放回（提交）/ 手动选择工序
//      （回落手选）/ 取消（整次作废）。把「手动选择工序」误接成 cancel 的后果是
//      工人想改判却把整次选择清空，只能重新扫工牌 + 重新选件。
//   3. 两个结构性决策：右上角 × 禁用（:show-close="false"）、确认按钮的重复提交闩锁。
//      两者都是「删掉也不会让任何用例变红」的那类改动，本文件把它们钉住。
//   4. 组件零 api/store 依赖，props 进、events 出，全渲染即可覆盖。

import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import ReturnConfirmDialog from '../ReturnConfirmDialog.vue';

/** el-dialog 只负责壳与 footer slot；el-button 保留原生 click 透传（attrs 落根元素），
 *  与同目录 BatchPickerDialog.spec.ts 的 stub 手法一致。el-button 显式声明
 *  type / plain 两个 prop 并落到 data-* 上：按钮的「主次形态」只能靠这两个 prop 断言
 *  （class 是模板里写死的字符串，拿 class 断言等于断言「模板没被改」）。 */
const stubs = {
  'el-dialog': {
    name: 'ElDialogStub',
    props: ['modelValue', 'title', 'width', 'showClose'],
    template: '<div class="mock-dialog" :data-title="title"><slot /><slot name="footer" /></div>',
  },
  'el-button': {
    name: 'ElButtonStub',
    props: { type: String, plain: Boolean, loading: Boolean, size: String },
    template:
      '<button :data-type="type" :data-plain="String(plain)" :data-loading="String(loading)"><slot /></button>',
  },
};

function render(props: { processLabel?: string; shelfLabel?: string } = {}) {
  return mount(ReturnConfirmDialog, {
    props: { modelValue: true, processLabel: 'CUT-01 下料', shelfLabel: 'A-03', ...props },
    global: { stubs },
  });
}

/** 按可见文案找 footer 按钮（三个按钮共享 class 的部分，文本是唯一稳定锚点）。 */
function buttonByText(w: ReturnType<typeof render>, text: string) {
  const btn = w.findAll('button').find((b) => b.text() === text);
  if (!btn)
    throw new Error(`找不到按钮「${text}」，实际：${w.findAll('button').map((b) => b.text())}`);
  return btn;
}

describe('ReturnConfirmDialog / 文案与三出口', () => {
  it('主文案逐字渲染派生的下一工序名 + 目标货架码', () => {
    const w = render();
    expect(w.find('.chain-text').text()).toBe('下一道工序为 CUT-01 下料，请将工件放到 A-03 货架');
    // 两个标签声明成**必填** prop（没有默认值）：任一缺失都会被 vue-tsc 拦下，
    // 「下一道工序为 ，请将工件放到  货架」这种病句没有机会渲染出来。这里钉住传入值
    // 确实被逐字渲染。
    const w2 = render({ processLabel: 'CNC-03 精铣', shelfLabel: 'B-07' });
    expect(w2.find('.chain-text').text()).toBe('下一道工序为 CNC-03 精铣，请将工件放到 B-07 货架');
  });

  it('三个 footer 按钮齐在，且「确认放回」是主按钮、「手动选择工序」是次要按钮', () => {
    const w = render();
    expect(w.findAll('button').map((b) => b.text())).toEqual(['取消', '手动选择工序', '确认放回']);
    // 次要出口不能长得像主按钮：手动按钮必须 non-primary + plain，确认按钮必须 primary。
    const manual = buttonByText(w, '手动选择工序');
    expect(manual.attributes('data-type')).toBe('default');
    expect(manual.attributes('data-plain')).toBe('true');
    expect(buttonByText(w, '确认放回').attributes('data-type')).toBe('primary');
  });

  // `:show-close="false"` 是组件与 ShelfPickerDialog 骨架的刻意差异：右上角 × 关闭时
  // 不抛任何业务事件，父组件的推荐架 state 留着，下次选件时确认栏会带着上一次的架。
  // 删掉这行 = × 绕过 cancelSelect，且没有任何用例会红。
  it('右上角 × 禁用（showClose=false）：强制走 footer 三选一', () => {
    const dialog = render().findComponent({ name: 'ElDialogStub' });
    expect(dialog.props('showClose')).toBe(false);
  });

  it('点「确认放回」只抛 confirm', async () => {
    const w = render();
    await buttonByText(w, '确认放回').trigger('click');
    expect(w.emitted('confirm')).toHaveLength(1);
    expect(w.emitted('manual')).toBeUndefined();
    expect(w.emitted('cancel')).toBeUndefined();
  });

  // 「确认放回」一下就触发写操作（worker-scan）。父组件 v-if 挂载本组件让物理双击
  // 落不到同一按钮上，但组件内还有一道闩锁：连点两次只抛一次 confirm，且按钮进入
  // loading。删掉闩锁 ⇒ 同一件被提交两次（后端第二次必得 20507）。
  it('连点两次「确认放回」只抛一次 confirm，且按钮转 loading', async () => {
    const w = render();
    const btn = buttonByText(w, '确认放回');
    expect(btn.attributes('data-loading')).toBe('false');
    await btn.trigger('click');
    await btn.trigger('click');
    expect(w.emitted('confirm')).toHaveLength(1);
    expect(buttonByText(w, '确认放回').attributes('data-loading')).toBe('true');
  });

  it('点「手动选择工序」抛 manual（不是 cancel）并把 modelValue 收到 false', async () => {
    const w = render();
    await buttonByText(w, '手动选择工序').trigger('click');
    expect(w.emitted('manual')).toHaveLength(1);
    expect(w.emitted('cancel')).toBeUndefined();
    expect(w.emitted('confirm')).toBeUndefined();
    expect(w.emitted('update:modelValue')).toEqual([[false]]);
  });

  it('点「取消」抛 cancel 并把 modelValue 收到 false', async () => {
    const w = render();
    await buttonByText(w, '取消').trigger('click');
    expect(w.emitted('cancel')).toHaveLength(1);
    expect(w.emitted('confirm')).toBeUndefined();
    expect(w.emitted('manual')).toBeUndefined();
    expect(w.emitted('update:modelValue')).toEqual([[false]]);
  });
});
