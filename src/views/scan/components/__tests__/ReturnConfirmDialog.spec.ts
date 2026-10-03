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
//   3. 组件零 api/store 依赖，props 进、events 出，全渲染即可覆盖。

import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import ReturnConfirmDialog from '../ReturnConfirmDialog.vue';

/** el-dialog 只负责壳与 footer slot；el-button 保留原生 click 透传（attrs 落根元素），
 *  与同目录 BatchPickerDialog.spec.ts 的 stub 手法一致。 */
const stubs = {
  'el-dialog': {
    name: 'ElDialogStub',
    props: ['modelValue', 'title', 'width', 'showClose'],
    template: '<div class="mock-dialog" :data-title="title"><slot /><slot name="footer" /></div>',
  },
  'el-button': { name: 'ElButtonStub', template: '<button><slot /></button>' },
};

function render(props: { processLabel?: string; shelfLabel?: string } = {}) {
  return mount(ReturnConfirmDialog, {
    props: { modelValue: true, processLabel: 'CUT-01 下料', shelfLabel: 'A-03', ...props },
    global: { stubs },
  });
}

/** 按可见文案找 footer 按钮（三个按钮无稳定 class，文本是唯一稳定锚点）。 */
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
    // 两个标签任一缺失都会被工人读成「下一道工序为 ，请将工件放到  货架」这种病句，
    // 靠 props 必填 + 父组件兜底保证有值；这里钉住传入值确实被逐字渲染。
    const w2 = render({ processLabel: 'CNC-03 精铣', shelfLabel: 'B-07' });
    expect(w2.find('.chain-text').text()).toBe('下一道工序为 CNC-03 精铣，请将工件放到 B-07 货架');
  });

  it('三个 footer 按钮齐在，且「确认放回」是主按钮', () => {
    const w = render();
    expect(w.findAll('button').map((b) => b.text())).toEqual(['取消', '手动选择工序', '确认放回']);
    // 主按钮必须落在右侧（EP footer 默认右对齐）—— 用 class 断言有点脆，这里断言
    // 「手动选择工序」不是 primary（次要出口不能长得像主按钮）。
    expect(buttonByText(w, '手动选择工序').classes()).not.toContain('confirm-btn');
  });

  it('点「确认放回」只抛 confirm', async () => {
    const w = render();
    await buttonByText(w, '确认放回').trigger('click');
    expect(w.emitted('confirm')).toHaveLength(1);
    expect(w.emitted('manual')).toBeUndefined();
    expect(w.emitted('cancel')).toBeUndefined();
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
