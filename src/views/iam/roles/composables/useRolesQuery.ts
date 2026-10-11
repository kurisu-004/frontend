// src/views/iam/roles/composables/useRolesQuery.ts
//
// 2026-10-14 新增：「角色权限」面板的主查询 useQuery 段，从页面级 store
// （`./useRolesStore`）外提成同域独立 hook（无自有状态）。形态照
// `views/users/composables/useUsersQuery.ts`（同为「主查询 + 分页/筛选由 store 持有」
// 的分家形态）。
//
// 三条读查询都在本文件里，因为它们共享同一个数据生命周期：
//   - `useRolesQuery()`      角色列表（面板左列表 + 账号管理的 RoleDialog 下拉共用同一条
//                            `qk.rolesList()` 键 ⇒ 同屏去重靠的就是它）；
//   - `useRoleGrantsQuery()` 选中角色的授权包（**按角色分片**，故 roleId 进 queryKey）；
//   - `useRbacCatalogQuery()` 权限点分组 + 系统菜单树（两条都是常量键、恒为全集）。
//
// 守门点全在本文件（queryFn），api 层零 parse（`src/api/rbac.ts`）—— CLAUDE.md 硬约束：
// parse 返回深拷贝，api 层再走一遍等于每屏数据被校验并克隆两遍。负向守卫见
// `src/api/__tests__/rbac.spec.ts`。

import { computed, toValue, watch, type MaybeRefOrGetter } from 'vue';
import { ElMessage } from 'element-plus';
import { useQuery } from '@tanstack/vue-query';
import { getRoleGrants, listMenus, listPermissions, listRoles } from '@/api/rbac';
import { qk } from '@/composables/queries/keys';
import { menuNodeSchema } from '@/views/auth/sessionSchema';
import { permissionGroupListSchema, roleDefListSchema, roleGrantsSchema } from './rbacSchema';

/** 共享基础数据层的缓存时长：staleTime 30s / gcTime 5min。
 *
 * ⚠️ **gcTime 必须是有限值**（禁 POSITIVE_INFINITY）：`POSITIVE_INFINITY` 只在 dashboard
 * 域成立 —— 那里有 WS 事件做失效通道，而本域没有。同屏进出面板时命中一份 5 分钟前的
 * 角色列表，用户会以为「刚才改的授权没生效」。 */
const SHARED_STALE_MS = 30_000;
const SHARED_GC_MS = 5 * 60_000;

/** 角色列表主查询。
 *
 *  - `enabled` 闸门由调用方控制（store 在 `restoreState()` 末尾开闸，避免双 fetch）；
 *  - **不设 refetchInterval**：本域是「管理员手动改配置」的页面，角色列表与授权是低频
 *    变更 + 写后显式失效就够，轮询只会白白打扰后端；
 *  - 排序**不**在前端做：后端已按 `is_system DESC`（ADMIN 置顶）+ `code ASC` 排好，
 *    前端二次排会把「后端改了排序策略」这件事悄悄吃掉。
 *  - 错误桥接走 watch → ElMessage（不在 setup 抛错）。
 */
export function useRolesQuery(enabled: MaybeRefOrGetter<boolean>) {
  const queryKey = computed(() => qk.rolesList());

  const query = useQuery({
    queryKey,
    queryFn: async () => roleDefListSchema.parse(await listRoles()),
    enabled: computed(() => toValue(enabled)),
    staleTime: SHARED_STALE_MS,
    gcTime: SHARED_GC_MS,
  });

  /** fetchList 别名 = refetch 的 async 包装（视图「刷新」按钮 / 写后刷新 / 测试驱动）。 */
  async function fetchList(): Promise<void> {
    await query.refetch();
  }

  watch(query.error, (e) => {
    if (e) ElMessage.error('角色列表加载失败');
  });

  return {
    query,
    data: query.data,
    isFetching: query.isFetching,
    error: query.error,
    fetchList,
  };
}

/** 选中角色的授权包（`GET /iam/roles/{id}/grants`）。
 *
 *  **参数键**：端点按角色分片返回，roleId 走 queryKey 的独立键位（不进数组对象）——
 *  否则切角色时会命中上一个角色的授权缓存，管理员在 A 角色的勾选上看到的是 B 的。
 *  roleId 为空串 ⇒ 占位键 + `enabled` 闸门拦掉（queryFn 里也有二次守卫）。
 */
export function useRoleGrantsQuery(
  roleId: MaybeRefOrGetter<string>,
  enabled: MaybeRefOrGetter<boolean>,
) {
  const queryKey = computed(() => qk.roleGrants(toValue(roleId)));

  const query = useQuery({
    queryKey,
    queryFn: async ({ queryKey: k }) => {
      const id = k[2] as string;
      if (!id) throw new Error('roleId 为空：授权查询不应被触发');
      return roleGrantsSchema.parse(await getRoleGrants(id));
    },
    enabled: computed(() => toValue(enabled) && !!toValue(roleId)),
    staleTime: SHARED_STALE_MS,
    gcTime: SHARED_GC_MS,
  });

  async function fetchGrants(): Promise<void> {
    await query.refetch();
  }

  watch(query.error, (e) => {
    if (e) ElMessage.error('角色授权加载失败');
  });

  return {
    query,
    data: query.data,
    isFetching: query.isFetching,
    error: query.error,
    fetchGrants,
  };
}

/** 面板右区的两份「全集」数据：权限点分组 + 系统菜单树。
 *
 *  两条都是**常量键**：端点不接 Query extractor，一次返全部。合在一个 hook 里是因为它们
 *  生命周期完全一致（面板一挂载就要、且都是低频变更），拆两个 hook 只是多两次调用。
 *
 *  菜单树用会话链路的 `menuNodeSchema` 守门（**不是** rbacSchema 里的副本，见该文件
 *  顶部的说明）。
 */
export function useRbacCatalogQuery(enabled: MaybeRefOrGetter<boolean>) {
  const permissions = useQuery({
    queryKey: computed(() => qk.permissionsList()),
    queryFn: async () => permissionGroupListSchema.parse(await listPermissions()),
    enabled: computed(() => toValue(enabled)),
    staleTime: SHARED_STALE_MS,
    gcTime: SHARED_GC_MS,
  });

  const menus = useQuery({
    queryKey: computed(() => qk.menusTree()),
    queryFn: async () => menuNodeSchema.array().parse(await listMenus()),
    enabled: computed(() => toValue(enabled)),
    staleTime: SHARED_STALE_MS,
    gcTime: SHARED_GC_MS,
  });

  watch(permissions.error, (e) => {
    if (e) ElMessage.error('权限点加载失败');
  });
  watch(menus.error, (e) => {
    if (e) ElMessage.error('菜单树加载失败');
  });

  return {
    permissionGroups: permissions.data,
    permissionsLoading: permissions.isFetching,
    menuTree: menus.data,
    menusLoading: menus.isFetching,
    reloadCatalog: async (): Promise<void> => {
      await Promise.all([permissions.refetch(), menus.refetch()]);
    },
  };
}
