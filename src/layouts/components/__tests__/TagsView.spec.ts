// src/layouts/components/__tests__/TagsView.spec.ts
//
// 2026-09-28 新增（review 第 2 轮 Minor #3）：TagsView 组件 closeAll 兜底语义单测。
// 覆盖 review 第 2 轮 Major #1 的三个场景：
//   - 仅非 affix tab：closeAll 后 visitedViews 空 + 跳到 '/'
//   - 仅 affix tab（dashboard）：closeAll 后 visitedViews 仍含 dashboard + 路由不变
//   - 混合：closeAll 后只剩 affix + 当前 route 对应的 tab 被清 → 跳到 affix
//
// 测试策略：
//   - vi.mock 替换 vue-router 的 useRouter / useRoute，spy router.push。
//   - 每个用例用 fresh Pinia + 预置 store 状态；onMounted 会再次 addView 当前
//     route，路径已在 visited 里则 addView 是 no-op（dedup by path），不会污染。
//   - el-dropdown / el-dropdown-item / el-icon 用最小 stub 透传事件（沿
//     LoginCard.spec.ts 范本）。
//   - 通过 stub ElDropdown 触发 @command('close-all') 走 onContextMenuCmd 路径。
// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { useTagsViewStore } from '@/stores/tagsView';
import TagsViewComponent from '@/layouts/components/TagsView.vue';

// ===== 顶层 mock：vue-router =====
const pushSpy = vi.fn();
interface MockRoute {
  path: string;
  fullPath: string;
  meta: Record<string, unknown>;
  name: string;
}
let mockRoute: MockRoute = { path: '/', fullPath: '/', meta: {}, name: '' };

vi.mock('vue-router', () => ({
  useRoute: (): MockRoute => mockRoute,
  useRouter: () => ({
    push: pushSpy,
    replace: vi.fn(),
    afterEach: vi.fn(() => vi.fn()),
  }),
}));

// ===== Element Plus 最小 stub =====
// 2026-09-28：仓内 component-level spec 的统一范本是给 el-xxx 写最小 stub，让
// mount 跑得通。本组件涉及 el-dropdown / el-dropdown-menu / el-dropdown-item /
// el-icon —— 前两个是容器，最后一个需要透传 command 事件。
const ElIconStub = {
  name: 'ElIcon',
  template: '<i class="el-icon-stub"><slot /></i>',
};

const ElDropdownStub = {
  name: 'ElDropdown',
  template: '<div class="el-dropdown-stub"><slot /></div>',
  emits: ['command'] as const,
};

const ElDropdownMenuStub = {
  name: 'ElDropdownMenu',
  template: '<ul class="el-dropdown-menu-stub"><slot /></ul>',
};

const ElDropdownItemStub = {
  name: 'ElDropdownItem',
  props: ['command', 'disabled'],
  emits: ['command'] as const,
  template:
    '<button type="button" class="el-dropdown-item-stub" :disabled="disabled" @click="$emit(\'command\', command)"><slot /></button>',
};

// 图标组件 stub（@element-plus/icons-vue 渲染需要，简单 SVG 即可）
const IconStubs: Record<string, object> = {
  Close: { template: '<svg class="icon-stub-close" />' },
  Refresh: { template: '<svg class="icon-stub-refresh" />' },
  CloseBold: { template: '<svg class="icon-stub-close-bold" />' },
  FolderDelete: { template: '<svg class="icon-stub-folder-delete" />' },
};

const globalConfig = {
  components: {
    ...IconStubs,
    ElIcon: ElIconStub,
    ElDropdown: ElDropdownStub,
    ElDropdownMenu: ElDropdownMenuStub,
    ElDropdownItem: ElDropdownItemStub,
  },
};

// ===== 公共 setup =====
function attachPinia(): void {
  const pinia = createPinia();
  setActivePinia(pinia);
}

function setupRoute(path: string): void {
  mockRoute = { path, fullPath: path, meta: {}, name: path.replace(/^\//, '').toUpperCase() || 'ROOT' };
}

/** 触发第一个 ElDropdown stub 的 close-all command。 */
function triggerCloseAll(wrapper: VueWrapper): void {
  const dropdowns = wrapper.findAllComponents(ElDropdownStub);
  expect(dropdowns.length).toBeGreaterThan(0);
  // 命令派发：@command 在 el-dropdown 上声明，emits 在 onContextMenuCmd 内 switch
  dropdowns[0].vm.$emit('command', 'close-all');
}

describe('TagsView closeAll 兜底语义（review 第 2 轮 Major #1）', () => {
  beforeEach(() => {
    localStorage.clear();
    attachPinia();
    pushSpy.mockClear();
    setupRoute('/');
  });

  it('场景 1：仅非 affix tab → closeAll 后 visitedViews 空 + 跳到 /', () => {
    // 2026-09-28：仅 /a /b 两个非 affix，当前 route=/a
    const tags = useTagsViewStore();
    tags.addView({ path: '/a', fullPath: '/a', name: 'A', title: 'A' });
    tags.addView({ path: '/b', fullPath: '/b', name: 'B', title: 'B' });
    setupRoute('/a');

    const wrapper = mount(TagsViewComponent, { global: globalConfig });
    triggerCloseAll(wrapper);

    expect(tags.visitedViews).toHaveLength(0);
    expect(pushSpy).toHaveBeenCalledTimes(1);
    expect(pushSpy).toHaveBeenCalledWith('/');
  });

  it('场景 2：仅 affix tab（dashboard）→ closeAll 后 visitedViews 仍含 dashboard + 路由不变', () => {
    // 2026-09-28：仅 /dashboard 一个 affix，当前 route=/dashboard
    const tags = useTagsViewStore();
    tags.addView({
      path: '/dashboard',
      fullPath: '/dashboard',
      name: 'Dashboard',
      title: '首页',
      affix: true,
    });
    setupRoute('/dashboard');

    const wrapper = mount(TagsViewComponent, { global: globalConfig });
    triggerCloseAll(wrapper);

    expect(tags.visitedViews).toHaveLength(1);
    expect(tags.visitedViews[0].path).toBe('/dashboard');
    expect(tags.visitedViews[0].affix).toBe(true);
    // 当前 route 仍在 visitedViews → 无需 navigation
    expect(pushSpy).not.toHaveBeenCalled();
  });

  it('场景 3：混合 → closeAll 后只剩 affix + 当前 route 对应的 tab 被清 → 跳到 last (dashboard)', () => {
    // 2026-09-28：[/dashboard (affix), /a, /b]，当前 route=/a；右键 close-all 后
    // removeAllViews 只留 affix，/a 被清 → 跳到 last remaining（dashboard）
    const tags = useTagsViewStore();
    tags.addView({
      path: '/dashboard',
      fullPath: '/dashboard',
      name: 'Dashboard',
      title: '首页',
      affix: true,
    });
    tags.addView({ path: '/a', fullPath: '/a', name: 'A', title: 'A' });
    tags.addView({ path: '/b', fullPath: '/b', name: 'B', title: 'B' });
    setupRoute('/a');

    const wrapper = mount(TagsViewComponent, { global: globalConfig });
    triggerCloseAll(wrapper);

    expect(tags.visitedViews.map((v) => v.path)).toEqual(['/dashboard']);
    expect(pushSpy).toHaveBeenCalledTimes(1);
    expect(pushSpy).toHaveBeenCalledWith('/dashboard');
  });
});