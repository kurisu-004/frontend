// @vitest-environment happy-dom
// src/views/production/components/__tests__/PendingPoolsPanel.spec.ts
//
// 2026-10-02 新增：PendingPoolsPanel.vue 组件 spec —— 工序投放卡列。组件本身无逻辑，
// 只有一条值得守的映射：**hoveredProcessId → 逐张 PendingPoolCard 的 dropping**。
// 它是「拖到工序卡上高亮」跨组件链路的中间一环（源面板 emit → QueueBoard ref
// → 本面板 prop → PendingPoolCard 的 .is-dropping），任一环断掉都表现为「拖入时工序
// 卡不亮」且无任何报错。
//
// 覆盖：
//   - V1：processes 为空 → 空态文案；
//   - V2：逐卡渲染 code / name / count 徽标（零网络请求，徽标由父级透传）；
//   - V3：hoveredProcessId 命中的那张卡带 is-dropping，其余不带；
//   - V4：hoveredProcessId = null（未悬停）→ 无卡带 is-dropping；
//   - V5：自产 + 外协同时给 → 两组卡片都渲染，分割线恰好 1 个且位于两组之间；
//   - V6：只有自产（外协组为空）→ 无分割线；
//   - V7：只有外协（自产组为空）→ 外协卡正常渲染、无空态文案、无分割线；
//   - V8：两组都非空时，拖拽悬停高亮对外协卡同样生效（分组没把 :dropping 接线弄断）。
//
// 测试策略：
//   - 真实挂 PendingPoolCard（它是本面板唯一的产物，.pool-card / .is-dropping 都在它上面）；
//   - vi.mock('vue-draggable-plus') 桩掉 Sortable 绑定（本 spec 不测拖放）；
//   - EP stub：el-tag。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref, type Ref } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import PendingPoolsPanel from '../PendingPoolsPanel.vue';
import type { ProcessCategory } from '@/types/process';
import type { UseQueueDispatchReturn } from '../../composables/useQueueDispatch';

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
  category: ProcessCategory;
}

const PROCESSES: PanelProcess[] = [
  {
    id: '2000000000001',
    code: 'CNC-01',
    name: '粗加工',
    color: '#1e4d8bff',
    count: 3,
    category: 'INHOUSE',
  },
  {
    id: '2000000000002',
    code: 'CNC-02',
    name: '精加工',
    color: null,
    count: 0,
    category: 'INHOUSE',
  },
];

const OUTSOURCE_PROCESS: PanelProcess = {
  id: '2000000000003',
  code: 'OUT-01',
  name: '外协热处理',
  color: '#E74C3CFF',
  count: 2,
  category: 'OUTSOURCE',
};

const OUTSOURCE_PROCESS_2: PanelProcess = {
  id: '2000000000004',
  code: 'OUT-02',
  name: '外协喷涂',
  color: null,
  count: 1,
  category: 'OUTSOURCE',
};

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
      } as unknown as UseQueueDispatchReturn['dispatchMutation'],
      hoveredProcessId,
    },
    global: globalConfig,
  });
}

describe('PendingPoolsPanel（拖入高亮透传口 + 按 category 分组）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('V1：processes 为空 → 空态文案（不渲染任何工序卡）', async () => {
    const wrapper = mountPanel([], null);
    await flushPromises();
    expect(wrapper.findAll('.pool-card')).toHaveLength(0);
    expect(wrapper.text()).toContain('暂无可下发工序');
    // 2026-10-04：空态时两组都为空 ⇒ 不画分割线
    expect(wrapper.findAll('.pool-divider')).toHaveLength(0);
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

  it('V5：自产 + 外协 → 两组都渲染，分割线恰好 1 个且位于两组之间', async () => {
    const wrapper = mountPanel([...PROCESSES, OUTSOURCE_PROCESS], null);
    await flushPromises();

    const cards = wrapper.findAll('.pool-card');
    expect(cards).toHaveLength(3);
    expect(cards[0].text()).toContain('CNC-01');
    expect(cards[1].text()).toContain('CNC-02');
    expect(cards[2].text()).toContain('OUT-01');

    // 两组容器恒在（空组只是没有卡片）
    const groups = wrapper.findAll('.pool-group');
    expect(groups).toHaveLength(2);
    expect(groups[0].findAll('.pool-card')).toHaveLength(2);
    expect(groups[1].findAll('.pool-card')).toHaveLength(1);

    // 分割线恰好 1 个，且在 DOM 上位于两个 .pool-group 之间
    const dividers = wrapper.findAll('.pool-divider');
    expect(dividers).toHaveLength(1);
    const children = Array.from(wrapper.element.children) as HTMLElement[];
    const groupIdx = children.reduce<number[]>(
      (acc, el, i) => (el.classList.contains('pool-group') ? [...acc, i] : acc),
      [],
    );
    const dividerIdx = children.findIndex((el) => el.classList.contains('pool-divider'));
    expect(groupIdx).toEqual([0, 2]);
    expect(dividerIdx).toBe(1);

    // 需求「只用分割线上下分开」⇒ 两组内除卡片外不得有任何标题/文字节点
    for (const group of groups) {
      expect(group.element.children.length).toBe(group.findAll('.pool-card').length);
    }
    wrapper.unmount();
  });

  it('V6：只有自产工序（外协组为空）→ 无分割线、无空态', async () => {
    const wrapper = mountPanel(PROCESSES, null);
    await flushPromises();
    expect(wrapper.findAll('.pool-card')).toHaveLength(2);
    expect(wrapper.findAll('.pool-divider')).toHaveLength(0);
    expect(wrapper.text()).not.toContain('暂无可下发工序');
    wrapper.unmount();
  });

  it('V7：只有外协工序（自产组为空）→ 外协卡渲染、无空态文案、无分割线', async () => {
    const wrapper = mountPanel([OUTSOURCE_PROCESS, OUTSOURCE_PROCESS_2], null);
    await flushPromises();
    const cards = wrapper.findAll('.pool-card');
    expect(cards).toHaveLength(2);
    expect(cards[0].text()).toContain('OUT-01');
    expect(cards[1].text()).toContain('OUT-02');
    // 只有一组非空不构成「无可下发工序」
    expect(wrapper.text()).not.toContain('暂无可下发工序');
    expect(wrapper.findAll('.pool-divider')).toHaveLength(0);
    wrapper.unmount();
  });

  it('V8：两组都非空时，拖拽悬停高亮对外协卡同样生效', async () => {
    const wrapper = mountPanel([...PROCESSES, OUTSOURCE_PROCESS], '2000000000003');
    await flushPromises();
    const cards = wrapper.findAll('.pool-card');
    expect(cards[0].classes()).not.toContain('is-dropping');
    expect(cards[1].classes()).not.toContain('is-dropping');
    expect(cards[2].classes()).toContain('is-dropping');

    // 切回自产卡：跨组切换同样生效
    await wrapper.setProps({ hoveredProcessId: '2000000000001' });
    const after = wrapper.findAll('.pool-card');
    expect(after[0].classes()).toContain('is-dropping');
    expect(after[2].classes()).not.toContain('is-dropping');
    wrapper.unmount();
  });
});
