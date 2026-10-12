// @vitest-environment happy-dom
// src/views/production/scan/components/__tests__/ProcessPickerDialog.spec.ts
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
  // 卡片桩把工序的标识透成 data-* —— 「只渲染收窄集合内的那几条」只能这样断言。
  HmiPickerCard: {
    name: 'HmiPickerCardStub',
    props: ['code', 'name', 'category', 'isSelected', 'disabled', 'hint'],
    template:
      '<div class="stub-card" :data-code="code" :data-name="name" :data-category="category" />',
  },
};

type PickerAllowed = InstanceType<typeof ProcessPickerDialog>['$props']['allowedProcessIds'];

/** 后端 `ProcessOut` 的完整行（`listProcesses` 的 items 元素）。 */
function process(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '190000000000001',
    version: 1,
    code: 'CUT',
    name: '切割',
    category: 'INHOUSE',
    sort_order: 0,
    description: null,
    requires_approval: false,
    color: null,
    is_cnc: false,
    created_at: '2026-10-01 10:00:00',
    updated_at: '2026-10-01 10:00:00',
    ...over,
  };
}

const PROCESSES = [
  process(),
  process({ id: '190000000000002', code: 'WELD', name: '焊接', sort_order: 1 }),
  process({ id: '190000000000003', code: 'SUB', name: '委外喷涂', category: 'OUTSOURCE' }),
];

beforeEach(() => {
  h.listProcesses.mockReset().mockResolvedValue({ items: [], total: 0 });
  h.ElMessage.error.mockReset();
});

/**
 * `kind` 的取值**从组件 props 派生**，不手写联合 —— 手写一份等于把组件的 kind 声明复制
 * 到测试里：将来 `ProcessPickerDialog.vue` 加第 5 个 kind 时，下面的用例循环不会红，
 * 只有真去渲染那个 kind 时才会发现用例根本没覆盖它。
 *
 * 取法走 `InstanceType<...>['$props']`（本仓 Vue 版本未导出 `ComponentProps` 这个
 * 泛型助手；它对 `defineComponent` 出来的 SFC 同样能拿到同一份 props 类型）。
 */
type PickerKind = InstanceType<typeof ProcessPickerDialog>['$props']['kind'];

function render(
  props: { kind?: PickerKind; hint?: string; allowedProcessIds?: PickerAllowed } = {},
) {
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

// 「作用说明」那行（`.picker-purpose`）只在两个自助恢复 kind 下渲染：
// 放回页（return）与送检页（inspection）走的是既有观感，多一行文字就是对两个不在本组件
// 职责内的页面的可见 UI 变更；两个新 kind 的确认动作不选货架，工人需要一个能确认语义
// 的地方，故它们才有这句。
describe('ProcessPickerDialog / 作用说明行的渲染范围', () => {
  it('takeover / outsource：渲染作用说明', async () => {
    for (const kind of ['takeover', 'outsource'] as const) {
      const w = render({ kind });
      await flushPromises();
      expect(w.find('.picker-purpose').exists(), `${kind} 应有作用说明`).toBe(true);
    }
  });

  it('return / inspection：不渲染作用说明（既有两页观感零变化）', async () => {
    for (const kind of ['return', 'inspection'] as const) {
      const w = render({ kind });
      await flushPromises();
      expect(w.find('.picker-purpose').exists(), `${kind} 不该多出作用说明行`).toBe(false);
    }
  });
});

// 2026-10-16 新增：`allowedProcessIds` 收窄。扫码接管 / 外协收回两条自助恢复路径的目标
// 工序必须落在工人工种映射内（写端点会拒），所以候选由后端按工种算好后传进来；放回页
// （`ScanReturnParts.vue`，`kind="return"`）不传这个 prop，观感必须逐字不变。
describe('ProcessPickerDialog / allowedProcessIds 收窄候选', () => {
  /** 已渲染的工序代码（按工序分类 tab 顺序，与渲染顺序一致）。 */
  async function renderedCodes(props: Parameters<typeof render>[0] = {}): Promise<string[]> {
    h.listProcesses.mockResolvedValue({ items: PROCESSES, total: PROCESSES.length });
    const w = render(props);
    await flushPromises();
    return w.findAll('.stub-card').map((c) => c.attributes('data-code') ?? '');
  }

  it('传集合：只渲染集合内的工序，集合外的卡片一张都不出现', async () => {
    const codes = await renderedCodes({
      kind: 'takeover',
      allowedProcessIds: ['190000000000001', '190000000000003'],
    });

    expect(codes).toEqual(['CUT', 'SUB']);
    // 集合外的工序确实在全量里（否则本用例会成为「列表本来就只有两条」的假绿）
    expect(PROCESSES.map((p) => p.code)).toContain('WELD');
  });

  it('不传：渲染全部工序（放回页 `ScanReturnParts.vue` 的观感零变化）', async () => {
    for (const kind of ['return', 'inspection'] as const) {
      expect(await renderedCodes({ kind }), `${kind} 不得被收窄`).toEqual(['CUT', 'WELD', 'SUB']);
    }
  });

  it('收窄到 0 条：空态说「你的工种没有工序」，不是「该分类暂无工序」', async () => {
    // 空集合与「这个分类本来就没有工序」是两件事 —— 后者会让人以为整个工种没配工序。
    h.listProcesses.mockResolvedValue({ items: PROCESSES, total: PROCESSES.length });
    const w = render({ kind: 'takeover', allowedProcessIds: [] });
    await flushPromises();

    const empty = w.findAll('.tab-empty');
    expect(empty, '两个分类 tab 都进空态').toHaveLength(2);
    for (const el of empty) {
      expect(el.text()).toContain('你的工种暂无可选工序');
      expect(el.text()).not.toContain('暂无工序');
    }
    expect(w.findAll('.stub-card')).toHaveLength(0);
    // 一条都选不出来 ⇒ 确认按钮禁用，工人提交不了空选择
    expect(w.find('.confirm-btn').attributes('disabled')).toBeDefined();
  });

  it('未收窄且该分类真的没有工序：沿用原空态文案（区分两种空）', async () => {
    h.listProcesses.mockResolvedValue({ items: [PROCESSES[0]!], total: 1 });
    const w = render({ kind: 'return' });
    await flushPromises();

    const empty = w.findAll('.tab-empty');
    expect(empty).toHaveLength(1);
    expect(empty[0]!.text()).toBe('「外协」暂无工序');
  });

  // 2026-10-16 review 第 1 轮：空态文案（「你的工种暂无可选工序」还是「暂无工序」）与卡片
  // 列表必须来自**同一时刻的同一份快照**。
  //
  // 改坏时的症状：`restricted` 是响应式的、卡片列表却不是（watch 依赖刻意不含
  // `allowedProcessIds`，理由是避开数组 prop 引用抖动）⇒ 弹窗开着、父组件换一次候选集，
  // 空态文案已经翻到另一种「空」、卡片还停在上一份筛选结果 —— 同一屏两句话互相打脸，且
  // 两句都「有依据」（文案说的是真 prop、卡片说的是真数据）。
  //
  // 断言方式：弹窗打开后把 `allowedProcessIds` 从 `[]` 改成 `null`，卡片集**不会**重跑
  // （本组件刻意不重跑 `listProcesses`），那么文案也不许翻 —— 否则就是文案在描述一份
  // 不再生效的快照。
  it('打开后改 allowedProcessIds：卡片不重跑，空态文案也不许翻（同一快照）', async () => {
    h.listProcesses.mockResolvedValue({ items: PROCESSES, total: PROCESSES.length });
    const w = render({ kind: 'takeover', allowedProcessIds: [] });
    await flushPromises();

    expect(w.findAll('.tab-empty')[0]!.text()).toContain('你的工种暂无可选工序');
    expect(h.listProcesses).toHaveBeenCalledTimes(1);

    await w.setProps({ allowedProcessIds: null });
    await flushPromises();

    // 候选集换了，但本组件的快照没换（`listProcesses` 刻意不重跑）
    expect(h.listProcesses, 'watch 依赖刻意不含 allowedProcessIds，不该重拉').toHaveBeenCalledTimes(
      1,
    );
    expect(w.findAll('.stub-card'), '卡片集与空态文案必须是同一份快照').toHaveLength(0);
    for (const el of w.findAll('.tab-empty')) {
      expect(el.text()).toContain('你的工种暂无可选工序');
    }
  });
});
