// @vitest-environment happy-dom
// src/utils/__tests__/outsourceQuotePermissions.spec.ts
//
// 2026-10-14 新增（review 第 1 轮 M2）：外协报价权限工具的单测，重点锁**角色矩阵的
// 构造**——`roleMapFromHasRole` 必须走 `auth.hasRole`，因为 ADMIN 的通配短路在 hasRole
// 里（`stores/auth.ts`）。直读 `auth.user.roles` 时纯 ADMIN 账号拿到的 MANAGER / CLERK
// 全是 false ⇒ 报价一览的「新建 / 提交 / 审批」按钮全部消失，且没有任何报错。
//
// 环境依赖：auth store setup 首行是 `useQueryClient()` ⇒ 必须先注册 pinia 再注册
// VueQueryPlugin（沿用 `__tests__/deliveryNotePermissions.spec.ts` 的同款底座）。

import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { createApp } from 'vue';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';
import { useAuthStore } from '@/stores/auth';
import {
  canApprove,
  canCreate,
  hasManageQuotesRole,
  roleMapFromHasRole,
} from '../outsourceQuotePermissions';
import type { CurrentUser } from '@/types/user';

function setRoles(roles: string[]): void {
  const base: CurrentUser = {
    id: 'u1',
    username: 'tester',
    full_name: '测试',
    is_active: true,
    roles,
    shelf_ids: [],
    menus: [],
    permissions: [],
  };
  useAuthStore().user = base;
}

/** 与 store 同款调用形态：把 auth.hasRole 透传给矩阵构造器。 */
function roleMapFromAuth(): ReturnType<typeof roleMapFromHasRole> {
  const auth = useAuthStore();
  return roleMapFromHasRole((role) => auth.hasRole(role));
}

beforeEach(() => {
  const app = createApp({});
  app.use(createPinia());
  app.use(VueQueryPlugin, { queryClient: new QueryClient() });
  setActivePinia(app.config.globalProperties.$pinia);
});

describe('roleMapFromHasRole —— 经 auth.hasRole（ADMIN 通配短路生效）', () => {
  it('纯 ADMIN 账号：MANAGER / CLERK 全 true', () => {
    setRoles(['ADMIN']);
    expect(roleMapFromAuth()).toEqual({ MANAGER: true, CLERK: true });
  });

  it('MANAGER 账号：MANAGER true、CLERK false（不通配）', () => {
    setRoles(['MANAGER']);
    expect(roleMapFromAuth()).toEqual({ MANAGER: true, CLERK: false });
  });

  it('CLERK 账号：CLERK true、MANAGER false', () => {
    setRoles(['CLERK']);
    expect(roleMapFromAuth()).toEqual({ MANAGER: false, CLERK: true });
  });

  it('自定义角色账号（如 QC_LEAD）：两个业务角色键都不命中', () => {
    setRoles(['QC_LEAD']);
    expect(roleMapFromAuth()).toEqual({ MANAGER: false, CLERK: false });
  });
});

describe('权限判定消费矩阵（矩阵被 correct 构造后判定才成立）', () => {
  it('纯 ADMIN ⇒ 可新建、可审批（审批仅 MANAGER，经通配命中）', () => {
    setRoles(['ADMIN']);
    const rm = roleMapFromAuth();
    expect(hasManageQuotesRole(rm)).toBe(true);
    expect(canCreate(rm)).toBe(true);
    expect(canApprove({ status: 'SUBMITTED' }, rm)).toBe(true);
  });

  it('CLERK ⇒ 可新建但不可审批（原有口径不因本轮改动放宽）', () => {
    setRoles(['CLERK']);
    const rm = roleMapFromAuth();
    expect(canCreate(rm)).toBe(true);
    expect(canApprove({ status: 'SUBMITTED' }, rm)).toBe(false);
  });

  it('无关角色 ⇒ 全关', () => {
    setRoles(['INSPECTOR']);
    const rm = roleMapFromAuth();
    expect(canCreate(rm)).toBe(false);
    expect(canApprove({ status: 'SUBMITTED' }, rm)).toBe(false);
  });
});
