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
//   - reset()：清空两者 + 写回该用户自己的 per-user key
//   - 2026-10-02（缺陷 B）：per-user key 持久化 —— switchOwner('u1') 写入 →
//     新 Pinia + switchOwner('u1') 恢复；不同 owner 互不可见；switchOwner(null)
//     清内存不写盘；旧全局 key 一次性迁移后被 removeItem
//
// 测试基础设施：每个用例前重置 Pinia。
// 2026-10-02：原「注册持久化插件」一段已删 —— store 改为内部 watch + 手动
// localStorage（pinia-plugin-persistedstate 已从 package.json 卸载），插件注册不再
// 是持久化的前提。store setup 路径不读 localStorage（hydrate 只由 switchOwner 驱动），
// 故也无需 VueQueryPlugin。
// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';

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
  // 2026-10-02：插件已移除，只需一个 active pinia 即可实例化 store
  // （store setup 路径不读 localStorage，hydrate 只由 switchOwner 驱动）。
  const pinia = createPinia();
  setActivePinia(pinia);
}

/** 等待 store 内部 watch（flush:'pre'，微任务）触发 → persistNow 写 localStorage。 */
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
      tags.addView(
        makeView({ path: '/parts', fullPath: '/parts', name: 'PartsList', title: '零件一览' }),
      );
      expect(tags.visitedViews).toHaveLength(1);
      expect(tags.visitedViews[0].path).toBe('/parts');
      expect(tags.visitedViews[0].affix).toBeUndefined();
      expect(tags.cachedViewNames).toEqual(['PartsList']);
    });

    it('同 path 二次 addView 不重复，但同步更新 fullPath / title', () => {
      const tags = useTagsViewStore();
      tags.addView(
        makeView({
          path: '/parts',
          fullPath: '/parts?status=active',
          name: 'PartsList',
          title: '零件一览',
        }),
      );
      tags.addView(
        makeView({
          path: '/parts',
          fullPath: '/parts?status=inactive',
          name: 'PartsList',
          title: '零件一览',
        }),
      );
      expect(tags.visitedViews).toHaveLength(1);
      expect(tags.visitedViews[0].fullPath).toBe('/parts?status=inactive');
      // cachedViewNames 不重复 push
      expect(tags.cachedViewNames).toEqual(['PartsList']);
    });

    it('affix tab unshift 到 visitedViews 首位；cache 也加入；重复 add 不挪位', () => {
      const tags = useTagsViewStore();
      tags.addView(
        makeView({ path: '/parts', fullPath: '/parts', name: 'PartsList', title: '零件一览' }),
      );
      tags.addView(
        makeView({
          path: '/dashboard',
          fullPath: '/dashboard',
          name: 'Dashboard',
          title: '首页',
          affix: true,
        }),
      );
      expect(tags.visitedViews).toHaveLength(2);
      expect(tags.visitedViews[0].path).toBe('/dashboard');
      expect(tags.visitedViews[0].affix).toBe(true);
      expect(tags.visitedViews[1].path).toBe('/parts');
      expect(tags.cachedViewNames).toEqual(['PartsList', 'Dashboard']);

      // 重复 add 已存在的 affix 不挪位
      tags.addView(
        makeView({
          path: '/dashboard',
          fullPath: '/dashboard?x=1',
          name: 'Dashboard',
          title: '首页',
          affix: true,
        }),
      );
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
      tags.addView(
        makeView({
          path: '/dashboard',
          fullPath: '/dashboard',
          name: 'Dashboard',
          title: '首页',
          affix: true,
        }),
      );
      const removed = tags.removeView(
        makeView({ path: '/dashboard', name: 'Dashboard', affix: true }),
      );
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
      tags.addView(
        makeView({
          path: '/dashboard',
          fullPath: '/dashboard',
          name: 'Dashboard',
          title: '首页',
          affix: true,
        }),
      );
      tags.addView(makeView({ path: '/a', fullPath: '/a', name: 'A', title: 'A' }));
      tags.addView(makeView({ path: '/b', fullPath: '/b', name: 'B', title: 'B' }));
      tags.addView(makeView({ path: '/c', fullPath: '/c', name: 'C', title: 'C' }));

      tags.removeOtherViews(makeView({ path: '/b', name: 'B' }));

      expect(tags.visitedViews.map((v) => v.path)).toEqual(['/dashboard', '/b']);
      expect(tags.cachedViewNames).toEqual(['Dashboard', 'B']);
    });

    it('当前 view 是 affix 时仍保留；非 affix 也会保留', () => {
      const tags = useTagsViewStore();
      tags.addView(
        makeView({
          path: '/dashboard',
          fullPath: '/dashboard',
          name: 'Dashboard',
          title: '首页',
          affix: true,
        }),
      );
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
      tags.addView(
        makeView({
          path: '/dashboard',
          fullPath: '/dashboard',
          name: 'Dashboard',
          title: '首页',
          affix: true,
        }),
      );
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

  // ===== reset =====
  describe('reset', () => {
    it('清空 visitedViews + cachedViewNames（含 affix），并把空数组写回该用户自己的 key', async () => {
      const tags = useTagsViewStore();
      // 2026-10-02：必须先有归属用户，persistNow 才会落盘（ownerId === null 一律早退）
      tags.switchOwner('u1');
      tags.addView(
        makeView({
          path: '/dashboard',
          fullPath: '/dashboard',
          name: 'Dashboard',
          title: '首页',
          affix: true,
        }),
      );
      tags.addView(makeView({ path: '/a', fullPath: '/a', name: 'A' }));
      expect(tags.visitedViews).toHaveLength(2);
      expect(tags.cachedViewNames).toEqual(['Dashboard', 'A']);
      // store 内部 watch 是异步的（flush:'pre'），等 tick。
      await flushPersist();
      expect(localStorage.getItem('myerp.tags_view.u1')).not.toBeNull();

      tags.reset();
      expect(tags.visitedViews).toHaveLength(0);
      expect(tags.cachedViewNames).toEqual([]);
      await flushPersist();
      // reset 语义是「彻底清空含 affix」→ 落盘也是空
      const persisted = JSON.parse(localStorage.getItem('myerp.tags_view.u1') || '{}');
      expect(persisted.visitedViews ?? []).toHaveLength(0);
    });
  });

  // ===== 2026-10-02（缺陷 B）：per-user key 持久化 =====
  describe('per-user 持久化（switchOwner）', () => {
    it('switchOwner(u1) 后写入 myerp.tags_view.u1；新 Pinia + switchOwner(u1) 可恢复', async () => {
      const tags = useTagsViewStore();
      tags.switchOwner('u1');
      tags.addView(
        makeView({
          path: '/dashboard',
          fullPath: '/dashboard',
          name: 'Dashboard',
          title: '首页',
          affix: true,
        }),
      );
      tags.addView(
        makeView({
          path: '/parts',
          fullPath: '/parts?status=active',
          name: 'PartsList',
          title: '零件一览',
        }),
      );
      await flushPersist();
      expect(localStorage.getItem('myerp.tags_view.u1')).not.toBeNull();

      // 新会话（新 Pinia + 新 store 实例）→ 同账号重登恢复
      attachPinia();
      const restored = useTagsViewStore();
      restored.switchOwner('u1');
      expect(restored.visitedViews).toHaveLength(2);
      expect(restored.visitedViews[0].path).toBe('/dashboard');
      expect(restored.visitedViews[0].affix).toBe(true);
      expect(restored.visitedViews[1].fullPath).toBe('/parts?status=active');
      expect(restored.cachedViewNames).toEqual(['Dashboard', 'PartsList']);
    });

    it('owner 不同 → 互不可见（u2 看不到 u1 的标签栏）', async () => {
      const tags = useTagsViewStore();
      tags.switchOwner('u1');
      tags.addView(makeView({ path: '/a', fullPath: '/a', name: 'A' }));
      await flushPersist();

      tags.switchOwner('u2');
      expect(tags.visitedViews).toHaveLength(0);
      expect(tags.cachedViewNames).toEqual([]);

      // u2 自己开一个 tab —— 不能污染 u1 的存档
      tags.addView(makeView({ path: '/b', fullPath: '/b', name: 'B' }));
      await flushPersist();
      const u1 = JSON.parse(localStorage.getItem('myerp.tags_view.u1') || '{}');
      expect(u1.visitedViews).toHaveLength(1);
      expect(u1.visitedViews[0].path).toBe('/a');
    });

    it('switchOwner(null) 清内存但不写盘（同账号下次登录还能恢复）', async () => {
      const tags = useTagsViewStore();
      tags.switchOwner('u1');
      tags.addView(makeView({ path: '/a', fullPath: '/a', name: 'A' }));
      await flushPersist();
      expect(localStorage.getItem('myerp.tags_view.u1')).not.toBeNull();

      tags.switchOwner(null);
      expect(tags.visitedViews).toHaveLength(0);
      expect(tags.cachedViewNames).toEqual([]);
      // 清空动作触发的 watch 回来时 ownerId 已是 null → persistNow 早退 → 存档保留
      await flushPersist();
      const persisted = JSON.parse(localStorage.getItem('myerp.tags_view.u1') || '{}');
      expect(persisted.visitedViews).toHaveLength(1);
      expect(persisted.visitedViews[0].path).toBe('/a');
    });

    it('同 owner 早退：连着两次 switchOwner(同一 id) 不清内存（token 刷新不闪空）', () => {
      const tags = useTagsViewStore();
      tags.switchOwner('u1');
      tags.addView(makeView({ path: '/a', fullPath: '/a', name: 'A' }));
      expect(tags.visitedViews).toHaveLength(1);

      // 第二次同 id 调用：若没有首行早退，会先清内存再从 localStorage hydrate
      // （本用例没落盘 → 标签栏变空）
      tags.switchOwner('u1');
      expect(tags.visitedViews).toHaveLength(1);
      expect(tags.visitedViews[0].path).toBe('/a');
    });

    it('旧全局 key 一次性迁移到当前用户 key 并被 removeItem', async () => {
      // 插件时代遗留的跨账号共享 key
      localStorage.setItem(
        'tags_view',
        JSON.stringify({
          visitedViews: [
            {
              path: '/dashboard',
              fullPath: '/dashboard',
              name: 'Dashboard',
              title: '首页',
              affix: true,
            },
          ],
          cachedViewNames: ['Dashboard'],
        }),
      );
      const tags = useTagsViewStore();
      tags.switchOwner('u1');
      // 迁移：旧 key 内容进了 u1 的内存
      expect(tags.visitedViews).toHaveLength(1);
      expect(tags.cachedViewNames).toEqual(['Dashboard']);
      // 旧 key 已删（不留残根，否则下一个用户还会再迁一次）
      expect(localStorage.getItem('tags_view')).toBeNull();
      await flushPersist();
      expect(localStorage.getItem('myerp.tags_view.u1')).not.toBeNull();
    });

    it('旧 key 数据是坏 JSON 时也照样被 removeItem（迁移不因解析失败被跳过）', () => {
      localStorage.setItem('tags_view', 'not-json');
      const tags = useTagsViewStore();
      tags.switchOwner('u1');
      expect(tags.visitedViews).toHaveLength(0);
      expect(localStorage.getItem('tags_view')).toBeNull();
    });
  });
});
