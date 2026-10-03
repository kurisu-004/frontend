// @vitest-environment happy-dom
// src/views/production/components/__tests__/PendingPoolsPanel.spec.ts
//
// 2026-10-02 新增：PendingPoolsPanel.vue 组件 spec —— 自产工序卡列。组件本身无逻辑，
// 只有一个值得守的映射：**hoveredProcessId → 逐张 PendingPoolCard 的 dropping**。
// 它是「拖到工序卡上高亮」跨组件链路的中间一环（源面板 emit → WorkerQueueBoard ref
// → 本面板 prop → PendingPoolCard 的 .is-dropping），任一环断掉都表现为「拖入时工序
// 卡不亮」且无任何报错。
//
// 覆盖：
//   - V1：processes 为空 → 空态文案；
//   - V2：逐卡渲染 code / name / count 徽标（零网络请求，徽标由父级透传）；
//   - V3：hoveredProcessId 命中的那张卡带 is-dropping，其余不带；
//   - V4：hoveredProcessId = null（未悬停）→ 无卡带 is-dropping。
//
// 测试策略：
//   - 真实挂 PendingPoolCard（它是本面板唯一的产物，.pool-card / .is-dropping 都在它上面）；
//   - vi.mock('vue-draggable-plus') 桩掉 Sortable 绑定（本 spec 不测拖放）；
//   - EP stub：el-tag。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref, type Ref } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import PendingPoolsPanel from '../PendingPoolsPanel.vue';
import type { UsePendingDispatchReturn } from '@/views/production/composables/usePendingDispatch';

vi.mock('vue-draggable-plus', () => ({
  useDraggable: () => ({
    option: () => undefined,
    destroy: () => undefined,
    start: () => undefined,
    pause: () => undefined,
    resume: () => undefined,
  }),
}));

const ElTagStub = defineComponent({
  name: 'ElTagStub',
  props: { type: String, size: String },
  setup(_, { slots }) {
    return () => h('span', { class: 'el-tag-stub' }, slots.default?.());
  },
});

const globalConfig = {
  components: { ElTag: ElTagStub },
};

interface PanelProcess {
  id: string;
  code: string;
  name: string;
  color: string | null;
  count: number | string;
}

const PROCESSES: PanelProcess[] = [
  { id: '2000000000001', code: 'CNC-01', name: '粗加工', color: '#1e4d8bff', count: 3 },
  { id: '2000000000002', code: 'CNC-02', name: '精加工', color: null, count: 0 },
];

function mountPanel(
  processes: PanelProcess[] = PROCESSES,
  hoveredProcessId: string | null = null,
  mutate = vi.fn(),
) {
  return mount(PendingPoolsPanel, {
    props: {
      processes,
      selectedIds: ref<Set<string>>(new Set<string>()) as Ref<Set<string>>,
      dispatchMutation: {
        mutate,
        mutateAsync: vi.fn(async () => undefined),
      } as unknown as UsePendingDispatchReturn['dispatchMutation'],
      hoveredProcessId,
    },
    global: globalConfig,
  });
}

describe('PendingPoolsPanel（2026-10-02 拖入高亮透传口）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('V1：processes 为空 → 空态文案（不渲染任何工序卡）', async () => {
    const wrapper = mountPanel([], null);
    await flushPromises();
    expect(wrapper.findAll('.pool-card')).toHaveLength(0);
    expect(wrapper.text()).toContain('暂无可下发工序');
    wrapper.unmount();
  });

  it('V2：逐卡渲染 code / name / count 徽标（零网络请求）', async () => {
    const wrapper = mountPanel();
    await flushPromises();
    const cards = wrapper.findAll('.pool-card');
    expect(cards).toHaveLength(2);
    expect(cards[0].text()).toContain('CNC-01');
    expect(cards[0].text()).toContain('粗加工');
    expect(cards[0].text()).toContain('3');
    expect(cards[1].text()).toContain('CNC-02');
    expect(cards[1].text()).toContain('0');
    // 工序色落到左边框（工序色的语义位），未设置时回落主色
    expect(cards[0].attributes('style')).toContain('border-left-color: #1e4d8bff');
    expect(cards[1].attributes('style')).toContain('border-left-color: var(--el-color-primary)');
    wrapper.unmount();
  });

  it('V3：hoveredProcessId 命中的那张卡带 is-dropping，其余不带', async () => {
    const wrapper = mountPanel(PROCESSES, '2000000000002');
    await flushPromises();
    const cards = wrapper.findAll('.pool-card');
    expect(cards[0].classes()).not.toContain('is-dropping');
    expect(cards[1].classes()).toContain('is-dropping');

    // 悬停目标切换：高亮必须跟着 move，不能停在上一张
    await wrapper.setProps({ hoveredProcessId: '2000000000001' });
    const after = wrapper.findAll('.pool-card');
    expect(after[0].classes()).toContain('is-dropping');
    expect(after[1].classes()).not.toContain('is-dropping');
    wrapper.unmount();
  });

  it('V4：hoveredProcessId = null（未悬停）→ 无卡带 is-dropping', async () => {
    const wrapper = mountPanel(PROCESSES, null);
    await flushPromises();
    for (const card of wrapper.findAll('.pool-card')) {
      expect(card.classes()).not.toContain('is-dropping');
    }
    wrapper.unmount();
  });
});
