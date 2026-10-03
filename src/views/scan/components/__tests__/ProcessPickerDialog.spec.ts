// @vitest-environment happy-dom
// src/views/scan/components/__tests__/ProcessPickerDialog.spec.ts
//
// 2026-10-04 新增：工序选择弹窗的常驻横幅 `hint` prop 契约。
//
// 为什么这条值得单独立一个文件（而不是在放回页的用例里顺带断言）：放回页的用例把本组件
// 整个桩掉，只能验「hint 传到了弹窗上」，验不了「弹窗真的把它渲染成一块常驻可见的东西」。
// 而 M2 的全部要害就在那一步 —— 送检提醒是用 `ElMessage.warning` 发的，被后开的
// el-dialog 全屏遮罩（`rgba(0,0,0,.5)`）盖住，工人在产线屏幕前根本看不到，那句需求等于
// 没交付。改成弹窗内的 el-alert 后，「常驻 / 非半透明 / 不被遮罩吃掉」就成了组件模板里
// 可执行的事实。
//
// 顺带守另一条：hint 缺省时**一个像素都不多渲染**，两个 kind（return / inspection）都不受
// 影响 —— 送检页及其它调用方不传这个 prop 时的行为必须与改动前逐字一致。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';

const h = vi.hoisted(() => ({
  listProcesses: vi.fn(),
  ElMessage: { error: vi.fn(), warning: vi.fn(), success: vi.fn() },
}));

vi.mock('@/api/process', () => ({ listProcesses: h.listProcesses }));

vi.mock('element-plus', () => ({ ElMessage: h.ElMessage }));

import ProcessPickerDialog from '../ProcessPickerDialog.vue';

const stubs = {
  'el-dialog': {
    name: 'ElDialogStub',
    props: ['modelValue', 'title'],
    template: '<div class="mock-dialog"><slot /><slot name="footer" /></div>',
  },
  // alert 只把 title 透出来当断言锚点
  'el-alert': {
    name: 'ElAlertStub',
    props: ['title', 'type', 'closable', 'showIcon'],
    template: '<div class="mock-alert" :data-title="title" />',
  },
  'el-tabs': { name: 'ElTabsStub', template: '<div class="mock-tabs"><slot /></div>' },
  'el-tab-pane': { name: 'ElTabPaneStub', template: '<div><slot /></div>' },
  'el-button': { name: 'ElButtonStub', template: '<button><slot /></button>' },
  'el-icon': { name: 'ElIconStub', template: '<i><slot /></i>' },
  HmiPickerCard: { name: 'HmiPickerCardStub', template: '<div class="stub-card" />' },
};

beforeEach(() => {
  h.listProcesses.mockReset().mockResolvedValue({ items: [], total: 0 });
  h.ElMessage.error.mockReset();
});

function render(props: { kind?: 'return' | 'inspection'; hint?: string } = {}) {
  return mount(ProcessPickerDialog, {
    props: { modelValue: true, ...props },
    global: { stubs },
  });
}

describe('ProcessPickerDialog / hint 常驻横幅', () => {
  it('传 hint：渲染成不可关闭的 warning 横幅，标题逐字一致', async () => {
    const w = render({ hint: '「CUT-01 下料」为最后一道工序，加工完成后请送检。' });
    await flushPromises();

    const alert = w.find('.mock-alert');
    expect(alert.exists()).toBe(true);
    expect(alert.attributes('data-title')).toBe(
      '「CUT-01 下料」为最后一道工序，加工完成后请送检。',
    );
    // 不可关闭：工人不会把它当成可点掉的通知顺手当成「已读」
    expect(w.findComponent({ name: 'ElAlertStub' }).props('closable')).toBe(false);
    expect(w.findComponent({ name: 'ElAlertStub' }).props('type')).toBe('warning');
  });

  it('不传 hint：不渲染任何横幅（其余调用方零影响）', async () => {
    for (const kind of ['return', 'inspection'] as const) {
      const w = render({ kind });
      await flushPromises();
      expect(w.find('.mock-alert').exists(), `${kind} 不该有横幅`).toBe(false);
    }
  });

  // 横幅必须排在 loading / error / tabs 三种状态**之上**的固定位置：工人在工序列表还在
  // 加载、或加载失败时同样要看到「加工完成后请送检」。本条守住「它在 tabs 之外」。
  it('工序列表加载失败时横幅仍在（提醒不依赖列表加载成功）', async () => {
    h.listProcesses.mockRejectedValue(new Error('boom'));
    const w = render({ hint: '当前为最后一道工序，加工完成后请送检。' });
    await flushPromises();

    expect(w.find('.mock-alert').exists()).toBe(true);
    expect(w.find('.error-state').exists()).toBe(true);
  });

  // 三态里的 loading 一态：listProcesses 挂着不返回的那段时间，弹窗里只有 loading 文案，
  // 横幅照样在（提醒属于弹窗，不属于列表）。少了这条，横幅被挪进 tabs / loading 分支时
  // 只有「加载失败」那一条会红。
  it('工序列表加载中横幅仍在（提醒不依赖列表加载完成）', async () => {
    h.listProcesses.mockReturnValue(new Promise(() => {}));
    const w = render({ hint: '「CUT-01 下料」为最后一道工序，加工完成后请送检。' });
    await flushPromises();

    expect(w.find('.loading-state').exists()).toBe(true);
    expect(w.find('.mock-alert').attributes('data-title')).toBe(
      '「CUT-01 下料」为最后一道工序，加工完成后请送检。',
    );
  });
});
