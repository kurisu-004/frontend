// src/stores/tagsView.ts
//
// 2026-09-28 新增：全局 tagsView tab 管理 Pinia setup store。
// 参考 vue-element-admin 的 tagsView 形态：每个打开过的菜单页变成一个 tab，
// 重复点击侧栏菜单复用现有 tab（不再新建），可右键关闭 / 关闭其他 / 关闭全部 /
// 刷新，标签栏状态跨刷新保留。登出时由 auth 的 teardownSession() 切归属
// （switchOwner(null)）：只清内存、**不写盘** —— 保住该用户下次登录恢复自己的
// 标签栏（写盘等于把存档覆盖成空，缺陷 B 就算没修）。
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
//   - 持久化：**按用户分 key 的手动 localStorage**（M-4 同批缺陷 B 修复，2026-10-02）。
//     原实现用 pinia-plugin-persistedstate@^4 + 单 key `tags_view`，换账号登录会
//     看到上一账号的标签栏。插件形态做不到 per-user 隔离的三个原因：
//     1. `key` 函数只在 store 创建时被求值一次即冻结（插件 `parsePersistKey` 与
//        `optionsParser` 只在实例化时各跑一次，`$subscribe` 复用同一个配置对象）；
//     2. 该函数的入参是 **storeId**（'tags-view'）而非 userId，拿不到当前用户；
//     3. Pinia store 实例跨 logout→login 存活（登出不 reload），配置对象不会重建。
//     证据只留函数名与版本（pinia-plugin-persistedstate@4.7.1）：**不写该包的 dist
//     行号** —— 包已于 2026-10-02 从 package.json 卸载、node_modules 内不存在，行号
//     无法在仓内复核，留着只会制造「已验证」的假象。
//     故改为本文件内自管：deep watch（见文件末）触发 persistNow() 写
//     `myerp.tags_view.<userId>`，归属切换由 switchOwner() 驱动
//     （唯一写点 = src/stores/auth.ts 的 setUser）。
//   - store 初始化路径**不读** localStorage：hydrate 只能由 switchOwner() 触发。
//     理由：src/layouts/components/__tests__/TagsView.spec.ts 用裸
//     `setActivePinia(createPinia())`（不注册 VueQueryPlugin），而 M-4 之后
//     useAuthStore() 在 store 首次创建时要调 useQueryClient()（需要 VueQueryPlugin
//     + injection context）。若改成初始化期自行读 localStorage 定归属，就得先拿到
//     userId → 得先调 useAuthStore() → 该 spec 会抛
//     "vue-query hooks can only be used inside setup()..."（证据见
//     src/stores/auth.ts setup 顶部注释）。注意这条脆弱点**不是** `pinia._a`：
//     读 localStorage 本身不需要 app。

import { ref, nextTick, watch, type Ref } from 'vue';
import { defineStore } from 'pinia';

/** 2026-10-02 新增：旧版全局 key（插件时代，跨账号共享）的兼容读点，一次性迁移后删除。 */
const LEGACY_STORAGE_KEY = 'tags_view';

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

export const useTagsViewStore = defineStore('tags-view', () => {
  // ===== state =====
  // 2026-09-28：setup store 内部通过 .value 读写（auth.ts 不变量）。返回到
  // Pinia proxy 后调用方写 tags.xxx 自动解包，所以消费者无需关心 .value。
  const visitedViews: Ref<TagView[]> = ref<TagView[]>([]);
  /** keep-alive :include 列表；与 visitedViews.path 联动增删，affix 不参与删除。 */
  const cachedViewNames: Ref<string[]> = ref<string[]>([]);
  // 2026-10-02 新增：当前标签栏归属的用户 id。刻意用普通变量而非 ref —— 不参与
  // 响应式（真正需要 watch 的只有两个数组），也不进任何序列化。null = 当前无登录
  // 用户，此时 persistNow() 一律早退（见该函数注释：早退是硬需求）。
  let ownerId: string | null = null;

  // ===== getters =====
  // 2026-09-28 修复：移除 `isActive` 占位 getter（永远返回 false，是 dead code）。
  // 「当前激活 tab」判定依赖当前 route.path，由 TagsView.vue 通过 `useRoute()`
  // 完成（store 不 import vue-router，沿 auth store 不变量）。
  //
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
   * 拖动排序。affix 不可参与（拖动源或目标在 affix 槽位直接放弃），
   * 同位置或越界视为 no-op。直接 splice visitedViews；watch 回调
   * 会在下一 tick 把新顺序写回该用户自己的 localStorage key，刷新后顺序保留。
   * 2026-09-29 新增：供 vue-draggable-plus onUpdate 与外部程序化排序共用。
   */
  function reorderViews(oldIndex: number, newIndex: number): void {
    const list = visitedViews.value;
    if (oldIndex === newIndex) return;
    if (oldIndex < 0 || oldIndex >= list.length) return;
    if (newIndex < 0 || newIndex >= list.length) return;
    if (list[oldIndex]?.affix || list[newIndex]?.affix) return;
    const [moved] = list.splice(oldIndex, 1);
    list.splice(newIndex, 0, moved);
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
   * 清空所有状态（**含 affix tab**）。
   *
   * 2026-10-02：当前**无生产调用方** —— 唯一的历史调用方 `auth.logout()` 已改走
   * `teardownSession()` → `setUser(null)` → `switchOwner(null)`（清内存但不写盘，
   * 能保住该用户自己的标签栏存档）。TagsView.vue 的「关闭全部」用的是
   * `removeAllViews()`（保留 affix）。保留本 action 供未来「彻底清空含 affix」的
   * 场景使用，不要因为搜不到调用点就当活代码删掉 —— 语义与 removeAllViews 不同，
   * 两者不可互相替代。
   */
  function reset(): void {
    visitedViews.value.splice(0, visitedViews.value.length);
    cachedViewNames.value.splice(0, cachedViewNames.value.length);
  }

  // ===== 持久化（2026-10-02 新增：per-user key 手动 localStorage）=====

  /** 标签栏持久化 key：per-user 隔离维度是 userId，key 形如
   *  `myerp.tags_view.<userId>`。
   *  2026-10-02 订正（review 第 2 轮）：**有意偏离**仓内另外两个 per-user 持久化
   *  先例（`src/composables/useListFilterPersist.ts` 的 `myerp.list.<userId>.<key>`、
   *  `src/composables/useColumnVisibility.ts` 的 `myerp.list.<userId>.<key>_columns`）——
   *  那两个把 userId 放在**中间**并保留末位 `<名>` 段，本 key 把 userId 放在**末尾**
   *  且省略 `<名>` 段。理由：本 store 只有一份持久化数据，`myerp.<域>.<userId>`
   *  本身已唯一表达「哪个用户的哪份标签栏」，再加末位名只是冗余；且该 key 在
   *  M-4 合并前从未上线（上一版是单 key `tags_view`），改 key 形状没有存量迁移成本。 */
  function storageKey(id: string): string {
    return `myerp.tags_view.${id}`;
  }

  /**
   * 把当前内存状态写到「当前归属用户」的 localStorage key。
   *
   * **ownerId === null 早退是硬需求**：登出时 switchOwner(null) 会清空两个数组，
   * 若此时仍写盘就是把该用户的标签栏覆盖成空数组 —— 那等于缺陷 B 没修成。switchOwner
   * 已保证「先置 null 再清内存」，watch 回调（flush:'pre'，微任务）跑时读到的
   * 一定是 null。
   */
  function persistNow(): void {
    if (ownerId === null) return;
    try {
      localStorage.setItem(
        storageKey(ownerId),
        JSON.stringify({
          visitedViews: visitedViews.value,
          cachedViewNames: cachedViewNames.value,
        }),
      );
    } catch {
      // localStorage 配额满 / 隐私模式禁用：静默降级为「本次会话不持久化」，
      // 不影响内存态标签栏功能。
    }
  }

  /**
   * 旧版全局 key（插件时代，跨账号共享）一次性迁移到当前用户自己的 key。
   *
   * 独立 try/catch 是硬需求：即使 JSON 解析失败也必须走到 removeItem，否则旧 key
   * 会永久残留，每来一个新用户都被迁一次。只在 per-user key 本身没数据时 adopt
   * （旧 key 里的 tab 可能已经属于另一个账号，无脑 append 会串号）。
   */
  function adoptLegacyKey(): void {
    try {
      const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
      if (!raw) return;
      if (visitedViews.value.length === 0) {
        try {
          const parsed = JSON.parse(raw) as {
            visitedViews?: TagView[];
            cachedViewNames?: string[];
          };
          if (Array.isArray(parsed.visitedViews)) {
            visitedViews.value.push(...parsed.visitedViews);
          }
          if (Array.isArray(parsed.cachedViewNames)) {
            cachedViewNames.value.push(...parsed.cachedViewNames);
          }
        } catch {
          // 坏数据直接丢弃，removeItem 仍要跑
        }
      }
      localStorage.removeItem(LEGACY_STORAGE_KEY);
    } catch {
      // localStorage 不可用：放弃迁移（下次还会再试）
    }
  }

  /** 从指定用户 key hydrate 到内存（坏数据当空，独立 try/catch）。 */
  function hydrateFrom(id: string): void {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(storageKey(id));
    } catch {
      raw = null;
    }
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as {
        visitedViews?: TagView[];
        cachedViewNames?: string[];
      };
      if (Array.isArray(parsed.visitedViews)) {
        visitedViews.value.push(...parsed.visitedViews);
      }
      if (Array.isArray(parsed.cachedViewNames)) {
        cachedViewNames.value.push(...parsed.cachedViewNames);
      }
    } catch {
      // 坏数据当空处理，不抛
    }
  }

  /**
   * 切换标签栏归属用户 —— **本 store 唯一的 hydrate 入口**。
   *
   * 由 `src/stores/auth.ts` 的 `setUser()` 驱动（登录成功 / 登出 / token 刷新
   * 三条路径都汇到它），store 初始化期不调用。
   *
   * - `null`（无登录用户）：先置 `ownerId = null` 再清内存，且不写盘 → 旧账号的
   *   标签栏留在自己的 key 里，同账号下次登录能恢复；换个账号登录则看不到它。
   * - 非 `null`：先置归属再清内存 + 从该用户 key hydrate（同步完成后由 watch
   *   把结果写回，等价于「写穿」，无需额外 persist 调用）。
   * - 目标与当前相同则早退（幂等）—— 这条是「token 刷新不丢标签栏」的唯一保证：
   *   `auth:tokens-refreshed` 会以同一 userId 再调一次 setUser → switchOwner，若没有
   *   早退，每次刷新 token 都会把内存标签栏清成空再从 localStorage 重填（表现为
   *   用户可见的标签栏闪空）。
   */
  function switchOwner(userId: string | null): void {
    if (userId === ownerId) return;
    ownerId = userId;
    // 统一先清内存：换账号时避免旧归属的 tab 混进新归属；ownerId 已是 null 的
    // 情况下此处 mutation 触发的 watch 会在 persistNow 里早退，不写盘。
    visitedViews.value.splice(0, visitedViews.value.length);
    cachedViewNames.value.splice(0, cachedViewNames.value.length);
    if (userId === null) return;
    hydrateFrom(userId);
    adoptLegacyKey();
  }

  // 2026-10-02：替代原持久化插件的 $subscribe。
  // 深度监听是硬需求（下面这行 `deep` 选项）—— addView 的两条去重 early-return 只改
  // **数组内对象**的 fullPath / title / icon（见本文件 addView），浅 watch 观察不到，
  // tab 元数据会丢同步。flush 沿默认 'pre'（微任务），spec 里 flushPersist() 等待一 tick。
  watch([visitedViews, cachedViewNames], persistNow, { deep: true });

  return {
    visitedViews,
    cachedViewNames,
    isAffix,
    addView,
    removeView,
    removeOtherViews,
    removeAllViews,
    reorderViews, // 2026-09-29 新增
    refreshSelectedView,
    reset,
    switchOwner, // 2026-10-02 新增：per-user 持久化归属切换
  };
});
