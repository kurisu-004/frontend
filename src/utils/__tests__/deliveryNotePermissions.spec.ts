// src/utils/__tests__/deliveryNotePermissions.spec.ts
//
// 送货单权限 helper 的真值表守卫（2026-10-08 新增；此前该模块 9 个导出零覆盖）。
//
// **首要目标是锁死 2026-10-08 修掉的死锁**：canPrint 曾把「已指定司机」写进入口判据，
// 而唯一能指定司机的地方是打印对话框内的下拉 —— 进对话框的按钮与对话框里的下拉互相
// 等待，结果两个页面的「打印送货单」按钮**永远不出现**。本文件里所有带
// `driver_worker_name: null` 的用例都是这条死锁的回归锁：哪天谁又把司机写回
// canPrint，它们会集体转红。

import { describe, expect, it } from 'vitest';
import {
  canDeliver,
  canPrint,
  canRecall,
  canSoftDelete,
  canSubmit,
  hasManageNoteRole,
  type PrintableNoteLike,
  type RoleMapLike,
} from '../deliveryNotePermissions';

const ALL_STATUSES = ['DRAFT', 'SUBMITTED', 'PICKED_UP', 'ARCHIVED'] as const;
const MANAGE_ROLES: RoleMapLike[] = [
  { MANAGER: true },
  { CLERK: true },
  { INSPECTOR: true },
];
/** `RoleMapLike` 的宽形态：验证「传进来的角色键一个都不认识」时不会误放行
 *  （`RoleMapLike` 三个键全可选，写死它的字面量类型连无关角色都写不进去）。 */
type AnyRoleMap = RoleMapLike & Record<string, boolean | undefined>;

function note(over: Partial<PrintableNoteLike> = {}): PrintableNoteLike {
  return {
    status: 'DRAFT',
    part_count: 1,
    driver_worker_name: '李四',
    ...over,
  };
}

describe('hasManageNoteRole', () => {
  it.each<[string, RoleMapLike]>([
    ['MANAGER', { MANAGER: true }],
    ['CLERK', { CLERK: true }],
    ['INSPECTOR', { INSPECTOR: true }],
  ])('%s 命中放行角色表', (_role, map) => {
    expect(hasManageNoteRole(map)).toBe(true);
  });

  it.each<[string, AnyRoleMap]>([
    ['MANAGER: false', { MANAGER: false }],
    ['空角色集', {}],
    ['只有无关角色', { CNC_PROGRAMMER: true }],
  ])('%s 不命中（读值不读键存在性）', (_label, map) => {
    expect(hasManageNoteRole(map)).toBe(false);
  });
});

describe('canPrint —— 死锁回归锁', () => {
  // ⚠️ 下面两条是本次修复的核心断言：司机没指定时**仍然**允许进打印对话框。
  it('driver_worker_name 为 null 时仍返回 true（不能把按钮锁死成看不见）', () => {
    expect(canPrint(note({ driver_worker_name: null }), { MANAGER: true })).toBe(true);
  });

  it('driver_worker_name 为空串时同样返回 true', () => {
    expect(canPrint(note({ driver_worker_name: '' }), { CLERK: true })).toBe(true);
  });

  it('司机名有无**不影响**结果（判据里根本没有这一项）', () => {
    const withDriver = canPrint(note({ driver_worker_name: '李四' }), { MANAGER: true });
    const without = canPrint(note({ driver_worker_name: null }), { MANAGER: true });
    expect(withDriver).toBe(without);
  });
});

describe('canPrint 真值表', () => {
  it.each(ALL_STATUSES)('status=%s 且有行项 → 四个状态全放行（含已送货补打）', (status) => {
    expect(canPrint(note({ status }), { MANAGER: true })).toBe(true);
  });

  it.each(MANAGE_ROLES.map((r) => [Object.keys(r)[0]!, r] as [string, RoleMapLike]))(
    '%s 可见打印入口',
    (_label, role) => {
      expect(canPrint(note(), role)).toBe(true);
    },
  );

  it('非管理角色恒 false（无论状态、件数、司机如何）', () => {
    const unrelatedRole: AnyRoleMap = { CNC_PROGRAMMER: true };
    for (const status of ALL_STATUSES) {
      for (const part_count of [0, 1, 99]) {
        expect(canPrint(note({ status, part_count }), {})).toBe(false);
        expect(canPrint(note({ status, part_count }), unrelatedRole)).toBe(false);
        expect(
          canPrint(note({ status, part_count }), { MANAGER: false, CLERK: false }),
        ).toBe(false);
      }
    }
  });

  it('part_count === 0 恒 false（空单无物可打，角色与司机都救不回来）', () => {
    for (const role of MANAGE_ROLES) {
      for (const driver_worker_name of [null, '李四']) {
        expect(canPrint(note({ part_count: 0, driver_worker_name }), role)).toBe(false);
      }
    }
  });

  it('part_count 为负数也 false（守卫写成 < 0 会放过脏数据）', () => {
    expect(canPrint(note({ part_count: -1 }), { MANAGER: true })).toBe(false);
  });

  it('未知 status 放行（判据不做白名单比对，后端新增枚举时不会误伤）', () => {
    expect(canPrint(note({ status: 'WHATEVER' }), { MANAGER: true })).toBe(true);
  });
});

describe('canPrint 不误伤相邻 helper（本次只动 canPrint）', () => {
  it('canSubmit 仍限 DRAFT', () => {
    expect(canSubmit('DRAFT', { MANAGER: true })).toBe(true);
    for (const status of ['SUBMITTED', 'PICKED_UP', 'ARCHIVED'] as const) {
      expect(canSubmit(status, { MANAGER: true })).toBe(false);
    }
  });

  it('canRecall 仍限 SUBMITTED', () => {
    expect(canRecall('SUBMITTED', { MANAGER: true })).toBe(true);
    expect(canRecall('DRAFT', { MANAGER: true })).toBe(false);
  });

  it('canSoftDelete 仍限 DRAFT', () => {
    expect(canSoftDelete('DRAFT', { CLERK: true })).toBe(true);
    expect(canSoftDelete('SUBMITTED', { CLERK: true })).toBe(false);
  });

  it('canDeliver 仍限 SUBMITTED + 行项 > 0（送货是不可逆动作，没顺手放开）', () => {
    expect(canDeliver('SUBMITTED', { MANAGER: true }, 1)).toBe(true);
    expect(canDeliver('DRAFT', { MANAGER: true }, 1)).toBe(false);
    expect(canDeliver('SUBMITTED', { MANAGER: true }, 0)).toBe(false);
  });
});