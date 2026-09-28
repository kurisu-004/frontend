// src/stores/__tests__/tagsView.spec.ts
//
// 2026-09-28 新增：useTagsViewStore (Pinia setup store) 单测。
//
// 覆盖：
//   - addView：去重（按 path）、affix 置顶、noTagsView skip、cache 同步
//   - removeView：同步清理 cache、affix 不删
//   - removeOtherViews：保留 affix + 当前
//   - removeAllViews：仅留 affix
//   - refreshSelectedView：临时摘 cache → nextTick 恢复
//   - reset()：清空两者 + 触发持久化写入 localStorage
//
// 测试基础设施：每个用例前重置 Pinia + 注册 piniaPluginPersistedstate（store
// 用到了 persist 块，不注册插件则不会触发 storage 写入，但 actions / state 仍可
// 走通 —— 这里注册插件是为了 reset() 触发 localStorage 的断言）。
// 本 store 无 useMutation，无需 VueQueryPlugin。
// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { createApp } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate';

import { useTagsViewStore, type TagView } from '../tagsView';

function makeView(overrides: Partial<TagView> = {}): TagView {
  return {
    path: '/p',
    fullPath: '/p',
    name: 'P',
    title: 'P',
    ...overrides,
  };
}

function attachPinia(): void {
  // 2026-09-28：每个用例重建 Pinia + 注册持久化插件。注册顺序关键：
  //   1) app.use(pinia) 必须先调，否则 pinia._a 未设置，后续 pinia.use(plugin)
  //      会进入 toBeInstalled 队列而永远不会被消费（plugin 不生效）；
  //   2) pinia.use(piniaPluginPersistedstate) 在 _a 已设的情况下直接 push 到 _p。
  // 本 store 不调 useMutation，无需 VueQueryPlugin。
  const pinia = createPinia();
  const app = createApp({});
  app.use(pinia);
  pinia.use(piniaPluginPersistedstate);
  setActivePinia(pinia);
}

/** 等待 Vue watch 异步触发 → pinia-plugin-persistedstate 的 $subscribe 写入
 *  localStorage 是异步的（Vue 默认 watch 是 flush:'pre'，需要 tick）。 */
async function flushPersist(): Promise<void> {
  await nextTick();
  await new Promise<void>((r) => setTimeout(r, 0));
}

describe('useTagsViewStore', () => {
  beforeEach(() => {
    localStorage.clear();
    attachPinia();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ===== addView =====
  describe('addView', () => {
    it('把新 tab 加到 visitedViews 末尾，并把 name push 到 cachedViewNames', () => {
      const tags = useTagsViewStore();
      tags.addView(makeView({ path: '/parts', fullPath: '/parts', name: 'PartsList', title: '零件一览' }));
      expect(tags.visitedViews).toHaveLength(1);
      expect(tags.visitedViews[0].path).toBe('/parts');
      expect(tags.visitedViews[0].affix).toBeUndefined();
      expect(tags.cachedViewNames).toEqual(['PartsList']);
    });

    it('同 path 二次 addView 不重复，但同步更新 fullPath / title', () => {
      const tags = useTagsViewStore();
      tags.addView(makeView({ path: '/parts', fullPath: '/parts?status=active', name: 'PartsList', title: '零件一览' }));
      tags.addView(makeView({ path: '/parts', fullPath: '/parts?status=inactive', name: 'PartsList', title: '零件一览' }));
      expect(tags.visitedViews).toHaveLength(1);
      expect(tags.visitedViews[0].fullPath).toBe('/parts?status=inactive');
      // cachedViewNames 不重复 push
      expect(tags.cachedViewNames).toEqual(['PartsList']);
    });

    it('affix tab unshift 到 visitedViews 首位；cache 也加入；重复 add 不挪位', () => {
      const tags = useTagsViewStore();
      tags.addView(makeView({ path: '/parts', fullPath: '/parts', name: 'PartsList', title: '零件一览' }));
      tags.addView(makeView({ path: '/dashboard', fullPath: '/dashboard', name: 'Dashboard', title: '首页', affix: true }));
      expect(tags.visitedViews).toHaveLength(2);
      expect(tags.visitedViews[0].path).toBe('/dashboard');
      expect(tags.visitedViews[0].affix).toBe(true);
      expect(tags.visitedViews[1].path).toBe('/parts');
      expect(tags.cachedViewNames).toEqual(['PartsList', 'Dashboard']);

      // 重复 add 已存在的 affix 不挪位
      tags.addView(makeView({ path: '/dashboard', fullPath: '/dashboard?x=1', name: 'Dashboard', title: '首页', affix: true }));
      expect(tags.visitedViews).toHaveLength(2);
      expect(tags.visitedViews[0].path).toBe('/dashboard');
      expect(tags.visitedViews[0].fullPath).toBe('/dashboard?x=1');
    });

    it('name 为空字符串（缺 route.name）时仅入 visited，不入 cachedViewNames', () => {
      const tags = useTagsViewStore();
      tags.addView(makeView({ path: '/unknown', fullPath: '/unknown', name: '', title: '无名' }));
      expect(tags.visitedViews).toHaveLength(1);
      expect(tags.cachedViewNames).toEqual([]);
    });
  });

  // ===== removeView =====
  describe('removeView', () => {
    it('删除非 affix tab + 同步从 cachedViewNames 移除', () => {
      const tags = useTagsViewStore();
      tags.addView(makeView({ path: '/a', fullPath: '/a', name: 'A', title: 'A' }));
      tags.addView(makeView({ path: '/b', fullPath: '/b', name: 'B', title: 'B' }));
      expect(tags.visitedViews).toHaveLength(2);
      expect(tags.cachedViewNames).toEqual(['A', 'B']);

      const removed = tags.removeView(makeView({ path: '/a', name: 'A' }));
      expect(removed).toBe('/a');
      expect(tags.visitedViews).toHaveLength(1);
      expect(tags.visitedViews[0].path).toBe('/b');
      expect(tags.cachedViewNames).toEqual(['B']);
    });

    it('affix tab 不删（返回 null）', () => {
      const tags = useTagsViewStore();
      tags.addView(makeView({ path: '/dashboard', fullPath: '/dashboard', name: 'Dashboard', title: '首页', affix: true }));
      const removed = tags.removeView(makeView({ path: '/dashboard', name: 'Dashboard', affix: true }));
      expect(removed).toBeNull();
      expect(tags.visitedViews).toHaveLength(1);
      expect(tags.cachedViewNames).toEqual(['Dashboard']);
    });

    it('删除不在列表中的 view 返回 null，无副作用', () => {
      const tags = useTagsViewStore();
      tags.addView(makeView({ path: '/a', fullPath: '/a', name: 'A' }));
      const removed = tags.removeView(makeView({ path: '/nonexistent', name: 'X' }));
      expect(removed).toBeNull();
      expect(tags.visitedViews).toHaveLength(1);
      expect(tags.cachedViewNames).toEqual(['A']);
    });
  });

  // ===== removeOtherViews =====
  describe('removeOtherViews', () => {
    it('保留所有 affix + 当前 view；其余移除 + cache 同步', () => {
      const tags = useTagsViewStore();
      tags.addView(makeView({ path: '/dashboard', fullPath: '/dashboard', name: 'Dashboard', title: '首页', affix: true }));
      tags.addView(makeView({ path: '/a', fullPath: '/a', name: 'A', title: 'A' }));
      tags.addView(makeView({ path: '/b', fullPath: '/b', name: 'B', title: 'B' }));
      tags.addView(makeView({ path: '/c', fullPath: '/c', name: 'C', title: 'C' }));

      tags.removeOtherViews(makeView({ path: '/b', name: 'B' }));

      expect(tags.visitedViews.map((v) => v.path)).toEqual(['/dashboard', '/b']);
      expect(tags.cachedViewNames).toEqual(['Dashboard', 'B']);
    });

    it('当前 view 是 affix 时仍保留；非 affix 也会保留', () => {
      const tags = useTagsViewStore();
      tags.addView(makeView({ path: '/dashboard', fullPath: '/dashboard', name: 'Dashboard', title: '首页', affix: true }));
      tags.addView(makeView({ path: '/a', fullPath: '/a', name: 'A' }));
      tags.addView(makeView({ path: '/b', fullPath: '/b', name: 'B' }));
      tags.removeOtherViews(makeView({ path: '/dashboard', name: 'Dashboard', affix: true }));
      expect(tags.visitedViews.map((v) => v.path)).toEqual(['/dashboard']);
      expect(tags.cachedViewNames).toEqual(['Dashboard']);
    });
  });

  // ===== removeAllViews =====
  describe('removeAllViews', () => {
    it('仅留所有 affix，cache 同步', () => {
      const tags = useTagsViewStore();
      tags.addView(makeView({ path: '/dashboard', fullPath: '/dashboard', name: 'Dashboard', title: '首页', affix: true }));
      tags.addView(makeView({ path: '/a', fullPath: '/a', name: 'A' }));
      tags.addView(makeView({ path: '/b', fullPath: '/b', name: 'B' }));
      tags.removeAllViews();
      expect(tags.visitedViews.map((v) => v.path)).toEqual(['/dashboard']);
      expect(tags.cachedViewNames).toEqual(['Dashboard']);
    });

    it('无 affix 时不强制保留当前 —— 全部清空（vue-element-admin 行为：本 action 仅保留 affix）', () => {
      const tags = useTagsViewStore();
      tags.addView(makeView({ path: '/a', fullPath: '/a', name: 'A' }));
      tags.addView(makeView({ path: '/b', fullPath: '/b', name: 'B' }));
      tags.removeAllViews();
      // 仅留 affix；全无 affix → 列表为空（vue-element-admin 行为：本 action 仅删
      // 非 affix；外层 TagsView.vue 在调用此 action 后会保留当前激活 view 的兜底）。
      expect(tags.visitedViews).toHaveLength(0);
      expect(tags.cachedViewNames).toEqual([]);
    });
  });

  // ===== refreshSelectedView =====
  describe('refreshSelectedView', () => {
    it('临时从 cachedViewNames 移除当前 name → nextTick 重新 push', async () => {
      const tags = useTagsViewStore();
      tags.addView(makeView({ path: '/a', fullPath: '/a', name: 'A' }));
      tags.addView(makeView({ path: '/b', fullPath: '/b', name: 'B' }));
      expect(tags.cachedViewNames).toEqual(['A', 'B']);

      const promise = tags.refreshSelectedView(makeView({ path: '/a', name: 'A' }));
      // 同步阶段已被摘掉
      expect(tags.cachedViewNames).toEqual(['B']);
      await promise;
      await nextTick();
      // nextTick 之后重新 push 回末尾
      expect(tags.cachedViewNames).toEqual(['B', 'A']);
    });

    it('name 为空字符串时 no-op，不抛错', async () => {
      const tags = useTagsViewStore();
      tags.addView(makeView({ path: '/a', fullPath: '/a', name: 'A' }));
      await expect(
        tags.refreshSelectedView(makeView({ path: '/a', name: '' })),
      ).resolves.toBeUndefined();
      expect(tags.cachedViewNames).toEqual(['A']);
    });

    it('name 不在缓存中时 no-op', async () => {
      const tags = useTagsViewStore();
      tags.addView(makeView({ path: '/a', fullPath: '/a', name: 'A' }));
      await expect(
        tags.refreshSelectedView(makeView({ path: '/x', name: 'X' })),
      ).resolves.toBeUndefined();
      expect(tags.cachedViewNames).toEqual(['A']);
    });
  });

  // ===== updateVisitedView =====
  describe('updateVisitedView', () => {
    it('按 path 定位已访问 tab 并同步元数据', () => {
      const tags = useTagsViewStore();
      tags.addView(makeView({ path: '/parts', fullPath: '/parts', name: 'PartsList', title: '零件一览' }));
      tags.updateVisitedView(
        makeView({ path: '/parts', fullPath: '/parts?status=active', name: 'PartsList', title: '零件一览 (active)' }),
      );
      expect(tags.visitedViews).toHaveLength(1);
      expect(tags.visitedViews[0].fullPath).toBe('/parts?status=active');
      expect(tags.visitedViews[0].title).toBe('零件一览 (active)');
    });

    it('path 不存在时 no-op（不入新 entry，仅 update）', () => {
      const tags = useTagsViewStore();
      tags.addView(makeView({ path: '/a', fullPath: '/a', name: 'A' }));
      tags.updateVisitedView(makeView({ path: '/x', fullPath: '/x', name: 'X', title: 'X' }));
      expect(tags.visitedViews).toHaveLength(1);
      expect(tags.visitedViews[0].path).toBe('/a');
    });
  });

  // ===== reset =====
  describe('reset', () => {
    it('清空 visitedViews + cachedViewNames，并触发 localStorage 写入', async () => {
      const tags = useTagsViewStore();
      tags.addView(makeView({ path: '/dashboard', fullPath: '/dashboard', name: 'Dashboard', title: '首页', affix: true }));
      tags.addView(makeView({ path: '/a', fullPath: '/a', name: 'A' }));
      expect(tags.visitedViews).toHaveLength(2);
      expect(tags.cachedViewNames).toEqual(['Dashboard', 'A']);
      // 持久化插件的 $subscribe 是异步的（Vue watch 默认 flush:'pre'），等 tick。
      await flushPersist();
      expect(localStorage.getItem('tags_view')).not.toBeNull();

      tags.reset();
      expect(tags.visitedViews).toHaveLength(0);
      expect(tags.cachedViewNames).toEqual([]);
      await flushPersist();
      // plugin 默认是异步写；reset 后再次读到的是空数组
      const persisted = JSON.parse(localStorage.getItem('tags_view') || '{}');
      const visited = persisted.visitedViews ?? [];
      expect(Array.isArray(visited)).toBe(true);
      expect(visited).toHaveLength(0);
    });
  });

  // ===== 持久化恢复（plugin 行为）=====
  describe('persistence', () => {
    it('store 首次创建时从 localStorage 恢复 visitedViews + cachedViewNames', () => {
      // 1) 先准备一份 localStorage payload（模拟上一次会话关闭前）
      localStorage.setItem(
        'tags_view',
        JSON.stringify({
          visitedViews: [
            { path: '/dashboard', fullPath: '/dashboard', name: 'Dashboard', title: '首页', affix: true },
            { path: '/parts', fullPath: '/parts?status=active', name: 'PartsList', title: '零件一览' },
          ],
          cachedViewNames: ['Dashboard', 'PartsList'],
        }),
      );
      // 2) 新建 Pinia + 插件 → store 首次创建时自动恢复
      attachPinia();
      const tags = useTagsViewStore();
      expect(tags.visitedViews).toHaveLength(2);
      expect(tags.visitedViews[0].path).toBe('/dashboard');
      expect(tags.visitedViews[0].affix).toBe(true);
      expect(tags.cachedViewNames).toEqual(['Dashboard', 'PartsList']);
    });
  });
});