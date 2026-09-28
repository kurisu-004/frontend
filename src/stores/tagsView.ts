// src/stores/tagsView.ts
//
// 2026-09-28 新增：全局 tagsView tab 管理 Pinia setup store。
// 参考 vue-element-admin 的 tagsView 形态：每个打开过的菜单页变成一个 tab，
// 重复点击侧栏菜单复用现有 tab（不再新建），可右键关闭 / 关闭其他 / 关闭全部 /
// 刷新，标签栏状态跨刷新保留，登出时由 auth.logout() 钩入 reset() 清空。
//
// 设计要点：
//   - setup 风格 + 显式 return（沿 src/stores/auth.ts 不变量 #1 #2）。
//   - 不 import vue-router（沿 auth store 约束）；afterEach 注册放在 TagsView.vue
//     组件里，store 只收 plain values。
//   - 消费侧禁止解构（auth store 不变量 #3）：const tags = useTagsViewStore(); tags.xxx。
//   - 去重身份键：path（不含 query/hash）；导航目标用 fullPath 保留 query/hash。
//   - affix 排序：插入时若 affix 为真则 unshift 到位置 0，关闭 / 关闭其他 /
//     关闭全部都不碰 affix（vue-element-admin 行为）。
//   - 缓存同步：cachedViewNames 跟随 visitedViews 增删；refreshSelectedView 临时
//     从 cachedViewNames 移除 name → nextTick 重新 push，触发 keep-alive 重挂载。
//   - 持久化：pinia-plugin-persistedstate@^4（仓内首例使用）；plugin 必须在 main.ts
//     里 Pinia 之后、VueQueryPlugin 之前注册。

import { ref, nextTick, type Ref } from 'vue';
import { defineStore } from 'pinia';

/**
 * 单个已访问 tab 的描述。
 *
 * - `path` 是 visited 身份（不含 query/hash），用于 dedup；
 * - `fullPath` 是导航目标（保留 query/hash）；
 * - `name` 在 addView 构造时 narrow 为 string，keep-alive :include 只接受 string；
 *   `name` 缺失（RouteRecordName 是 string | symbol | null | undefined）会被 addView
 *   防御性跳过缓存而非报错。
 */
export interface TagView {
  path: string;
  fullPath: string;
  name: string;
  title: string;
  icon?: string;
  affix?: boolean;
}

export const useTagsViewStore = defineStore(
  'tags-view',
  () => {
    // ===== state =====
    // 2026-09-28：setup store 内部通过 .value 读写（auth.ts 不变量）。返回到
    // Pinia proxy 后调用方写 tags.xxx 自动解包，所以消费者无需关心 .value。
    const visitedViews: Ref<TagView[]> = ref<TagView[]>([]);
    /** keep-alive :include 列表；与 visitedViews.path 联动增删，affix 不参与删除。 */
    const cachedViewNames: Ref<string[]> = ref<string[]>([]);

    // ===== getters =====
    /** 当前激活 tab（用于菜单 active / 高亮判定）。按 path 对比，不看 fullPath，
     *  保证 /parts?status=A 与 /parts?status=B 共享同一 tab。
     *
     *  当前实现保留为占位（永远返回 false）—— 实际判定由 TagsView.vue 通过
     *  `route.path === view.path` 完成，store 不 import vue-router。
     *  保留函数形态以备视图层将来要"哪个 tab 是当前 selected"等复合查询。 */
    function isActive(_view: TagView): boolean {
      return false;
    }

    /** affix 判定：仅看字段，不参与删除逻辑（删除路径在 removeView / removeOtherViews
     *  / removeAllViews 内联判定 affix）。 */
    function isAffix(view: TagView): boolean {
      return view.affix === true;
    }

    // ===== actions =====
    /**
     * 登记一次访问。重复 path → 同步更新 fullPath（保留最新 query/hash），不重建。
     * affix → unshift 到位置 0。非 affix + name 缺失 → 不入缓存但仍入 visitedViews。
     * meta.noTagsView === true → skip 整个流程（login / 错误页）。
     */
    function addView(view: TagView): void {
      const list = visitedViews.value;
      if (view.affix) {
        // affix 路径：以 path 为身份键，若已存在则仅更新元数据（不挪位、不复制）
        const existing = list.find((v) => v.path === view.path);
        if (existing) {
          existing.fullPath = view.fullPath;
          existing.title = view.title;
          existing.icon = view.icon;
          return;
        }
        list.unshift({
          path: view.path,
          fullPath: view.fullPath,
          name: view.name,
          title: view.title,
          icon: view.icon,
          affix: true,
        });
      } else {
        // 非 affix 路径：以 path 为身份键去重
        const existing = list.find((v) => v.path === view.path);
        if (existing) {
          existing.fullPath = view.fullPath;
          existing.title = view.title;
          existing.icon = view.icon;
          return;
        }
        list.push({
          path: view.path,
          fullPath: view.fullPath,
          name: view.name,
          title: view.title,
          icon: view.icon,
        });
      }

      // 缓存同步：仅在 name 是 string 时 push（RouteRecordName 兼容）
      if (typeof view.name === 'string' && view.name.length > 0) {
        if (!cachedViewNames.value.includes(view.name)) {
          cachedViewNames.value.push(view.name);
        }
      }
    }

    /**
     * 关闭一个 tab。affix 不删除（vue-element-admin 行为）。返回被删除 tab
     * 的 fullPath（用于上层调用方决定跳哪个邻居），无操作时返回 null。
     */
    function removeView(view: TagView): string | null {
      if (view.affix) return null;
      const list = visitedViews.value;
      const idx = list.findIndex((v) => v.path === view.path);
      if (idx === -1) return null;
      const removed = list.splice(idx, 1)[0];
      // 缓存同步：name 存在时一并从 cachedViewNames 移除
      if (typeof removed.name === 'string' && removed.name.length > 0) {
        const cache = cachedViewNames.value;
        const ci = cache.indexOf(removed.name);
        if (ci !== -1) cache.splice(ci, 1);
      }
      return removed.fullPath;
    }

    /**
     * 关闭除当前 tab 外的所有非 affix tab。保留所有 affix 与当前 view（即使当前
     * view 非 affix —— vue-element-admin 行为）。
     */
    function removeOtherViews(view: TagView): void {
      const list = visitedViews.value;
      // 仅保留 affix + 当前 view（无论其 affix 标记）
      const keep = list.filter((v) => v.affix || v.path === view.path);
      // 缓存同步：删除所有不再 visited 的 name
      const keepNames = new Set(
        keep.filter((v) => typeof v.name === 'string').map((v) => v.name as string),
      );
      cachedViewNames.value = cachedViewNames.value.filter((n) => keepNames.has(n));
      list.splice(0, list.length, ...keep);
    }

    /**
     * 关闭所有非 affix tab。保留所有 affix（vue-element-admin 行为）。
     */
    function removeAllViews(): void {
      const list = visitedViews.value;
      const keep = list.filter((v) => v.affix);
      const keepNames = new Set(
        keep.filter((v) => typeof v.name === 'string').map((v) => v.name as string),
      );
      cachedViewNames.value = cachedViewNames.value.filter((n) => keepNames.has(n));
      list.splice(0, list.length, ...keep);
    }

    /**
     * 软刷新当前 tab（MainLayout 顶栏「刷新」按钮 / 右键菜单「刷新」共用）。
     * 实现：临时从 cachedViewNames 移除 → nextTick 重新 push，触发 keep-alive
     * 重挂载组件。比 :key 切换 router-view 更轻（不破坏 transition）。
     */
    async function refreshSelectedView(view: TagView): Promise<void> {
      if (typeof view.name !== 'string' || view.name.length === 0) return;
      const cache = cachedViewNames.value;
      const idx = cache.indexOf(view.name);
      if (idx === -1) return;
      cache.splice(idx, 1);
      await nextTick();
      cache.push(view.name);
    }

    /**
     * 更新已访问 tab 的元数据（title / fullPath 等），按 path 定位。当前主要
     * 用于路由 query 变化时同步 title；保留为 public 以备未来扩展。
     */
    function updateVisitedView(view: TagView): void {
      const list = visitedViews.value;
      const existing = list.find((v) => v.path === view.path);
      if (existing) {
        existing.fullPath = view.fullPath;
        existing.title = view.title;
        existing.icon = view.icon;
        existing.name = view.name;
      }
    }

    /**
     * 清空所有状态（登出时由 auth.logout() 调用）。persist 插件会在同步 mutation
     * 后立即写 localStorage → 下次以游客身份进入应用时看到空 tags 条。
     */
    function reset(): void {
      visitedViews.value.splice(0, visitedViews.value.length);
      cachedViewNames.value.splice(0, cachedViewNames.value.length);
    }

    return {
      visitedViews,
      cachedViewNames,
      isActive,
      isAffix,
      addView,
      removeView,
      removeOtherViews,
      removeAllViews,
      refreshSelectedView,
      updateVisitedView,
      reset,
    };
  },
  {
    // 2026-09-28 新增：仓内首例使用 pinia-plugin-persistedstate@^4。plugin 仅在
    // store 首次创建时从 localStorage 恢复一次（行为沿 pinia 文档 §persist 章节）。
    // v4 API 用 `pick`（不是 v3 的 `paths`）—— 仅持久化 visitedViews 与
    // cachedViewNames，isActive / isAffix 是 computed-style 函数不入 storage。
    //
    // 注意：不显式传 `storage` —— plugin 默认走 `window.localStorage`。显式
    // 写 `storage: localStorage` 会在模块顶层求值，破坏 node env 下的 imports
    // （仓内部分 composable spec 走 node 环境，见 vitest.config.ts）。
    persist: {
      key: 'tags_view',
      pick: ['visitedViews', 'cachedViewNames'],
    },
  },
);