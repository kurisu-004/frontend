// @vitest-environment happy-dom
// src/utils/__tests__/partsPermissions.spec.ts
//
// 2026-10-14（RBAC 控制面板）：判据从「角色枚举」迁到**权限点** `part.drawing.print`。
//
// 本 spec 的两条主线：
//   1. **行为闸门**：按权限点判 —— 有该点 → 可见；没有 → 不可见。ADMIN 元角色靠
//      `hasPermission` 的通配短路放行（那条通配本身在 stores/auth.ts 的 spec 里钉）。
//   2. **签名兼容**：形参 `role` 一字未改（消费方零改动），且**不再参与判定** —— 钉住
//      「同一个角色 map 换成别的角色值，结论不变」，把「判据真的搬走了」这件事写进用例。
//      少了这条，把判定改回读 role map 不会有任何测试信号。
//
// ⚠️ **需要 pinia 注入**（本 spec 用例数从「纯函数」变成「读 store」）：`canPrintPartDrawing`
// 内部调 `useAuthStore().hasPermission(...)`，而 auth store 的 setup 首行是
// `useQueryClient()` —— 必须 `app.use(createPinia())` **早于**
// `app.use(VueQueryPlugin, { queryClient })`，否则首次 useAuthStore() 直接抛
// "vue-query hooks can only be used inside setup()"。

import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { createApp } from 'vue';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';

import {
  canDownloadPartFile,
  canPrintPartDrawing,
  type PartRoleMapLike,
} from '../partsPermissions';
import { useAuthStore } from '@/stores/auth';
import type { CurrentUser } from '@/types/user';

function seedUser(user: Partial<CurrentUser>): void {
  const base: CurrentUser = {
    id: 'u1',
    username: 'tester',
    full_name: '测试',
    is_active: true,
    roles: [],
    shelf_ids: [],
    menus: [],
    permissions: [],
  };
  Object.assign(base, user);
  useAuthStore().user = base;
}

beforeEach(() => {
  const app = createApp({});
  app.use(createPinia());
  app.use(VueQueryPlugin, { queryClient: new QueryClient() });
  setActivePinia(app.config.globalProperties.$pinia);
});

describe('canPrintPartDrawing —— 按权限点判（2026-10-14）', () => {
  it('持有 part.drawing.print ⇒ 可见', () => {
    seedUser({ permissions: ['part.drawing.print'] });
    expect(canPrintPartDrawing({})).toBe(true);
  });

  it('不持有该权限点 ⇒ 不可见（哪怕角色是 MANAGER）', () => {
    // 这是本次改动的核心：**角色不再是判据**。管理员可以在 RBAC 面板从 MANAGER 手里
    // 收回图纸打印，前端必须跟着收 —— 继续按角色判的话入口还在、点下去吃 403。
    seedUser({ roles: ['MANAGER'], permissions: [] });
    expect(canPrintPartDrawing({ MANAGER: true })).toBe(false);
  });

  it('只有别的权限点 ⇒ 不可见（不按前缀/包含匹配）', () => {
    seedUser({ permissions: ['queue.dispatch', 'other.part.drawing.print'] });
    expect(canPrintPartDrawing({})).toBe(false);
  });

  it('ADMIN 元角色通配放行（hasPermission 的短路，最高危那条的落点）', () => {
    seedUser({ roles: ['ADMIN'], permissions: [] });
    expect(canPrintPartDrawing({})).toBe(true);
  });

  it('未登录 / 无 user ⇒ 不可见', () => {
    seedUser({ permissions: ['part.drawing.print'] });
    useAuthStore().user = null;
    expect(canPrintPartDrawing({})).toBe(false);
  });

  it('**角色形参不再参与判定**（签名兼容用例：同一权限点下改角色值，结论不变）', () => {
    seedUser({ roles: ['MANAGER'], permissions: ['part.drawing.print'] });
    const CASES: PartRoleMapLike[] = [
      {},
      { MANAGER: false },
      { CLERK: true },
      { INSPECTOR: true, CLERK: false },
      { CNC_PROGRAMMER: true, MANAGER: true },
    ];
    // 有权限点 ⇒ 一律可见，与角色 map 长什么样无关。
    for (const c of CASES) expect(canPrintPartDrawing(c)).toBe(true);

    // 无权限点 ⇒ 一律不可见（ADMIN 通配那条已单列，这里是非 ADMIN 账号）。
    seedUser({ roles: ['CLERK'], permissions: [] });
    for (const c of CASES) expect(canPrintPartDrawing(c)).toBe(false);
  });
});

describe('canDownloadPartFile —— 与打印同判据（2026-10-14）', () => {
  it('持有权限点 ⇒ 可见', () => {
    seedUser({ permissions: ['part.drawing.print'] });
    expect(canDownloadPartFile({})).toBe(true);
  });

  it('不持有 ⇒ 不可见', () => {
    seedUser({ permissions: [] });
    expect(canDownloadPartFile({})).toBe(false);
  });

  it('纯 SHELF_ACCOUNT（工控机）没有该权限点 ⇒ 不可见下载入口', () => {
    // 这正是工控机账号的形状（报工台路由守卫角色）。后端对 `/files/objects/{id}/url`
    // 刻意没放开（预签直链可外传），前端若在这里放行就是「可见但必 403」。
    seedUser({ roles: ['SHELF_ACCOUNT'], permissions: [] });
    expect(canDownloadPartFile({})).toBe(false);
  });

  it('ADMIN 通配 ⇒ 可见', () => {
    seedUser({ roles: ['ADMIN'], permissions: [] });
    expect(canDownloadPartFile({})).toBe(true);
  });

  // 两条端点共用同一个权限点：哪天后端只改了其中一条，本用例立刻红，
  // 提醒同步拆成两个判据而不是悄悄让两边分叉。
  it('与 canPrintPartDrawing 逐场景同进同出（共用同一权限点）', () => {
    const SCENARIOS: Array<Pick<CurrentUser, 'roles' | 'permissions'>> = [
      { roles: [], permissions: [] },
      { roles: ['MANAGER'], permissions: [] },
      { roles: ['CLERK'], permissions: ['part.drawing.print'] },
      { roles: ['ADMIN'], permissions: [] },
      { roles: ['SHELF_ACCOUNT'], permissions: ['part.drawing.print'] },
    ];
    for (const s of SCENARIOS) {
      seedUser(s);
      expect(canDownloadPartFile({}), JSON.stringify(s)).toBe(canPrintPartDrawing({}));
    }
  });
});
