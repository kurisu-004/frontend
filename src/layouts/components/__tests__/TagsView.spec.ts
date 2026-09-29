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
import type { Ref } from 'vue';
import { useTagsViewStore } from '@/stores/tagsView';
import TagsViewComponent from '@/layouts/components/TagsView.vue';

// ===== 顶层 mock：vue-draggable-plus =====
// 2026-09-29 新增：TagsView.vue 顶层调 useDraggable；mock 替换实现后捕获入参
// （el / list / opts），用于断言拖动接线 + visitedViews 写穿 Pinia 的语义回归。
const capture: {
  el: Ref<HTMLElement | null> | null;
  list: unknown;
  opts: Record<string, unknown> | null;
} = {
  el: null,
  list: null,
  opts: null,
};

vi.mock('vue-draggable-plus', () => ({
  useDraggable: (
    el: Ref<HTMLElement | null>,
    list: unknown,
    opts: Record<string, unknown>,
  ) => {
    capture.el = el;
    capture.list = list;
    capture.opts = opts;
    return {
      start: vi.fn(),
      destroy: vi.fn(),
      option: vi.fn(),
      save: vi.fn(),
      toArray: vi.fn(),
      closest: vi.fn(),
    };
  },
}));

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

// 2026-09-29 新增：拖动接线回归守门。TagsView.vue 用 vue-draggable-plus 把
// visitedViews 绑定为可拖拽 list。原版 draggable 选 '.tag-item'（错误——el-dropdown
// 根 div 才是直接子元素） + visitedViews 是只读 computed，导致拖动全失效。本块 4
// 用例覆盖三处修复：selector / list 写穿 / onMove affix 守卫。
describe('TagsView 拖动接线回归（2026-09-29 拖动失效修复守门）', () => {
  beforeEach(() => {
    localStorage.clear();
    attachPinia();
    pushSpy.mockClear();
    setupRoute('/');
    // 每次用例重置 capture（vitest 跨用例共享模块 mock 状态）
    capture.el = null;
    capture.list = null;
    capture.opts = null;
  });

  it('(a) draggable selector 必须是 .tag-dropdown（不是 .tag-item）', () => {
    // 2026-09-29：el-dropdown 根 div 才是容器直接子元素；el-dropdown 包裹的
    // .tag-item 在 Sortable 视图里没有前序兄弟，索引全为 0 → 拖动视觉失效。
    mount(TagsViewComponent, { global: globalConfig });
    expect(capture.opts).not.toBeNull();
    expect(capture.opts!.draggable).toBe('.tag-dropdown');
  });

  it('(b) list 写穿 Pinia：整体赋值 list.value 后 visitedViews 顺序被同步', () => {
    // 2026-09-29：原 visitedViews 是只读 computed get，Sortable onUpdate 整体赋值
    // 被 Vue 静默吞掉。修复后 computed 带 setter，写穿 tags.visitedViews。
    const tags = useTagsViewStore();
    tags.addView({ path: '/a', fullPath: '/a', name: 'A', title: 'A' });
    tags.addView({ path: '/b', fullPath: '/b', name: 'B', title: 'B' });
    mount(TagsViewComponent, { global: globalConfig });

    // 拖动后 Sortable 整体赋值新顺序：模拟 sort 后列表
    const list = capture.list as Ref<Record<string, unknown>[]>;
    list.value = [
      { path: '/b', fullPath: '/b', name: 'B', title: 'B' },
      { path: '/a', fullPath: '/a', name: 'A', title: 'A' },
    ];

    expect(tags.visitedViews.map((v) => v.path)).toEqual(['/b', '/a']);
  });

  it('(c) onMove affix 守卫：related 是 affix + willInsertAfter=false → false；其它情形 → true', () => {
    // 2026-09-29：阻止非 affix tab 被拖到 affix 之前（affix 必须钉在位置 0）。
    mount(TagsViewComponent, { global: globalConfig });
    const opts = capture.opts as Record<string, unknown>;
    const onMove = opts.onMove as (evt: {
      related: { classList: { contains: (c: string) => boolean } };
      willInsertAfter: boolean;
    }) => boolean;

    const relatedAffix = { classList: { contains: (c: string) => c === 'affix' } };
    const relatedNonAffix = { classList: { contains: () => false } };

    // affix 前插 → 拒绝
    expect(onMove({ related: relatedAffix, willInsertAfter: false })).toBe(false);
    // affix 后插 → 允许
    expect(onMove({ related: relatedAffix, willInsertAfter: true })).toBe(true);
    // 非 affix 前插/后插 → 都允许
    expect(onMove({ related: relatedNonAffix, willInsertAfter: false })).toBe(true);
    expect(onMove({ related: relatedNonAffix, willInsertAfter: true })).toBe(true);
  });

  it('(d) filter 保留为 .affix（钉死 affix 不参与拖动起点）', () => {
    // 2026-09-29：filter: '.affix' 让 Sortable 在 .affix 上 drag cancelled；内层
    // .tag-item.affix 也走 closest 上行匹配，preventOnFilter: false 保持单击 / 右键
    // 穿透。
    mount(TagsViewComponent, { global: globalConfig });
    expect(capture.opts!.filter).toBe('.affix');
    expect(capture.opts!.preventOnFilter).toBe(false);
  });
});