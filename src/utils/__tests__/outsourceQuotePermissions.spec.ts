// @vitest-environment happy-dom
// src/utils/__tests__/outsourceQuotePermissions.spec.ts
//
// 2026-10-14 新增（review 第 1 轮 M2），2026-10-15 重写为**权限点判定范式**（RBAC 面板
// 第二批）：五个判定函数（canCreate / canEdit / canApprove / canReject / canSoftDelete）
// 的判据从「角色枚举」迁到 `auth.hasPermission(...)`，本 spec 跟着锁权限点口径。
//
// 覆盖：
//   1. ADMIN 元角色经 `hasPermission` 通配 —— 纯 ADMIN（permissions 为空）五个判定全 true；
//   2. 空权限集 → 全 false；
//   3. `outsource.quote.edit` 只管编辑侧（新建 / 编辑 / 软删），批不了（approve false）；
//   4. `outsource.quote.approve` 只管审批侧（通过 / 拒绝），编不了；
//   5. 状态闸与权限闸**相乘**：canEdit 只认 DRAFT、canApprove 只认 SUBMITTED、
//      canSoftDelete 只认 DRAFT / REJECTED；
//   6. `roleMapFromHasRole` 仍走 `auth.hasRole`（ADMIN 通配）—— 它的消费方只剩
//      `defaultStatusesForRole`（列表默认筛哪一档），不再参与写权限；
//   7. `canWithdraw` 已删除（报价 update / withdraw 端点下线、零消费，不可实现）。
//
// 环境依赖：auth store setup 首行是 `useQueryClient()` ⇒ 必须先注册 pinia 再注册
// VueQueryPlugin（沿用 `__tests__/deliveryNotePermissions.spec.ts` 的同款底座）。

import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { createApp } from 'vue';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';
import { useAuthStore } from '@/stores/auth';
import * as quotePermissions from '../outsourceQuotePermissions';
import {
  canApprove,
  canCreate,
  canEdit,
  canReject,
  canSoftDelete,
  roleMapFromHasRole,
  type RoleLike,
} from '../outsourceQuotePermissions';
import type { CurrentUser } from '@/types/user';

/** 角色 / 权限点双输入（迁移后写权限只看 permissions；roles 仍喂 roleMap 用例）。 */
function setUser(roles: string[], permissions: string[]): void {
  const base: CurrentUser = {
    id: 'u1',
    username: 'tester',
    full_name: '测试',
    is_active: true,
    roles,
    shelf_ids: [],
    menus: [],
    permissions,
  };
  useAuthStore().user = base;
}

/** 判定函数保留的形参（迁移后不再参与判定），测试侧给一个空矩阵保持调用形态。 */
const role: RoleLike = {};

/** 与 store 同款调用形态：把 auth.hasRole 透传给矩阵构造器。 */
function roleMapFromAuth(): ReturnType<typeof roleMapFromHasRole> {
  const auth = useAuthStore();
  return roleMapFromHasRole((r) => auth.hasRole(r));
}

beforeEach(() => {
  const app = createApp({});
  app.use(createPinia());
  app.use(VueQueryPlugin, { queryClient: new QueryClient() });
  setActivePinia(app.config.globalProperties.$pinia);
});

describe('权限点判定：ADMIN 通配与空集', () => {
  it('纯 ADMIN（permissions 为空）⇒ 新建 / 编辑 / 审批 / 拒绝 / 软删全放行', () => {
    // ADMIN 通配短路在 `hasPermission` 里（stores/auth.ts）：没有它，纯 ADMIN 账号
    // 在报价一览会看到一份没有任何操作按钮的表格，且零报错。
    setUser(['ADMIN'], []);
    expect(canCreate(role)).toBe(true);
    expect(canEdit({ status: 'DRAFT' }, role)).toBe(true);
    expect(canApprove({ status: 'SUBMITTED' }, role)).toBe(true);
    expect(canReject({ status: 'SUBMITTED' }, role)).toBe(true);
    expect(canSoftDelete({ status: 'DRAFT' }, role)).toBe(true);
  });

  it('无任何权限点（哪怕角色是 MANAGER / CLERK）⇒ 全关 —— 角色不再参与写权限判定', () => {
    setUser(['MANAGER', 'CLERK'], []);
    expect(canCreate(role)).toBe(false);
    expect(canEdit({ status: 'DRAFT' }, role)).toBe(false);
    expect(canApprove({ status: 'SUBMITTED' }, role)).toBe(false);
    expect(canReject({ status: 'SUBMITTED' }, role)).toBe(false);
    expect(canSoftDelete({ status: 'DRAFT' }, role)).toBe(false);
  });
});

describe('权限点判定：edit / approve 两侧分离', () => {
  it('只有 outsource.quote.edit ⇒ 可新建 / 编辑 DRAFT / 软删，但审批侧全关', () => {
    setUser([], ['outsource.quote.edit']);
    expect(canCreate(role)).toBe(true);
    expect(canEdit({ status: 'DRAFT' }, role)).toBe(true);
    expect(canSoftDelete({ status: 'DRAFT' }, role)).toBe(true);
    expect(canSoftDelete({ status: 'REJECTED' }, role)).toBe(true);
    expect(canApprove({ status: 'SUBMITTED' }, role)).toBe(false);
    expect(canReject({ status: 'SUBMITTED' }, role)).toBe(false);
  });

  it('只有 outsource.quote.approve ⇒ 可审批通过 / 拒绝，编辑侧全关', () => {
    setUser([], ['outsource.quote.approve']);
    expect(canApprove({ status: 'SUBMITTED' }, role)).toBe(true);
    expect(canReject({ status: 'SUBMITTED' }, role)).toBe(true);
    expect(canCreate(role)).toBe(false);
    expect(canEdit({ status: 'DRAFT' }, role)).toBe(false);
    expect(canSoftDelete({ status: 'DRAFT' }, role)).toBe(false);
  });

  it('无关权限点 ⇒ 全关', () => {
    setUser([], ['batch.split']);
    expect(canCreate(role)).toBe(false);
    expect(canApprove({ status: 'SUBMITTED' }, role)).toBe(false);
  });
});

describe('权限点 × 状态双闸', () => {
  it('canEdit 只认 DRAFT，canApprove / canReject 只认 SUBMITTED', () => {
    setUser([], ['outsource.quote.edit', 'outsource.quote.approve']);
    expect(canEdit({ status: 'DRAFT' }, role)).toBe(true);
    expect(canEdit({ status: 'SUBMITTED' }, role)).toBe(false);
    expect(canEdit({ status: 'APPROVED' }, role)).toBe(false);
    expect(canApprove({ status: 'SUBMITTED' }, role)).toBe(true);
    expect(canApprove({ status: 'DRAFT' }, role)).toBe(false);
    expect(canReject({ status: 'SUBMITTED' }, role)).toBe(true);
    expect(canReject({ status: 'APPROVED' }, role)).toBe(false);
  });

  it('canSoftDelete 只认 DRAFT / REJECTED，SUBMITTED / APPROVED 不给删', () => {
    setUser([], ['outsource.quote.edit']);
    expect(canSoftDelete({ status: 'DRAFT' }, role)).toBe(true);
    expect(canSoftDelete({ status: 'REJECTED' }, role)).toBe(true);
    expect(canSoftDelete({ status: 'SUBMITTED' }, role)).toBe(false);
    expect(canSoftDelete({ status: 'APPROVED' }, role)).toBe(false);
  });
});

describe('roleMapFromHasRole —— 仍经 auth.hasRole（列表默认筛选的输入）', () => {
  it('纯 ADMIN 账号：MANAGER / CLERK 全 true', () => {
    setUser(['ADMIN'], []);
    expect(roleMapFromAuth()).toEqual({ MANAGER: true, CLERK: true });
  });

  it('MANAGER / CLERK / 自定义角色：逐键命中，不通配', () => {
    setUser(['MANAGER'], []);
    expect(roleMapFromAuth()).toEqual({ MANAGER: true, CLERK: false });
    setUser(['CLERK'], []);
    expect(roleMapFromAuth()).toEqual({ MANAGER: false, CLERK: true });
    setUser(['QC_LEAD'], []);
    expect(roleMapFromAuth()).toEqual({ MANAGER: false, CLERK: false });
  });
});

describe('canWithdraw 已删除（报价 withdraw / update 端点下线，不可实现）', () => {
  it('模块不再导出 canWithdraw', () => {
    // 该端点的前端出口（OutsourceQuoteTable 的 action 通道）里没有 withdraw 这一类，
    // 写权限判据若留着它就是永远点不动的入口；删掉后本断言防止有人「顺手加回来」。
    expect(quotePermissions).not.toHaveProperty('canWithdraw');
  });
});
