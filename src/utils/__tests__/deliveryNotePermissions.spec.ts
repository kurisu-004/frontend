// @vitest-environment happy-dom
// src/utils/__tests__/deliveryNotePermissions.spec.ts
//
// 送货单权限 helper 的真值表守卫（2026-10-08 新增；此前该模块 9 个导出零覆盖）。
//
// **首要目标是锁死「打印入口与司机状态解耦」**：canPrint 只看权限点 `delivery_note.print`
// + 状态 + 行项数。打印对话框里的司机下拉只是**可选**便利口，导出不按它 gate；指定司机的
// 强制点在「一键送货」的确认对话框（DeliveryDriverPickerDialog，由 canDeliver 把关），
// 与本函数无关 ⇒ 两处之间不存在互相等待，哪天谁把司机写回 canPrint 只会平白多挡一批人。
// 本文件里所有带 `driver_worker_name: null` 的用例都是这条解耦的回归锁。
//
// ⚠️ **2026-10-14（RBAC 控制面板）**：只有 `canPrint` 的判据从「管理角色」换成权限点
// `delivery_note.print`，其余 8 个 helper 一律**仍按角色判**（下面「不误伤相邻 helper」
// 那一组就是钉这件事的）。因此本 spec 需要 pinia 注入：`canPrint` 内部调
// `useAuthStore().hasPermission(...)`，而 auth store setup 首行是 `useQueryClient()`
// ⇒ `app.use(createPinia())` 必须早于 `app.use(VueQueryPlugin, { queryClient })`。
//
// 另有一条**签名兼容**守卫：`canPrint(note, role)` 的 `role` 形参一字未改（三个消费方
// 的 git diff 为空），但它已不参与判定 —— 钉住「换角色值不改结论」，把「判据真搬走了」
// 写进用例；少了这条，改回读 role map 不会有任何测试信号。
//
// 2026-10-15（RBAC 面板第二批）：补一组常量表断言（逐字锁码 + 导出面），形态对齐同目录
// `productionPermissions.spec.ts` —— 上半篇的 helper 用例只碰判定逻辑，常量拼写漂移没有
// 任何测试信号。`delivery_note.view` 前端**零消费方**（读点由后端权限与菜单共同决定），
// 登记它是为了让常量表与后端 seeds 的 20 码全集对齐。

import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { createApp } from 'vue';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';
import * as permissionModule from '../deliveryNotePermissions';
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
import { useAuthStore } from '@/stores/auth';
import type { CurrentUser } from '@/types/user';

const ALL_STATUSES = ['DRAFT', 'SUBMITTED', 'PICKED_UP', 'ARCHIVED'] as const;
const MANAGE_ROLES: RoleMapLike[] = [{ MANAGER: true }, { CLERK: true }, { INSPECTOR: true }];
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

/** 造一个持有 `delivery_note.print` 的账号（canPrint 的正例底座）。 */
function withPrintPermission(over: Partial<CurrentUser> = {}): void {
  const base: CurrentUser = {
    id: 'u1',
    username: 'tester',
    full_name: '测试',
    is_active: true,
    roles: ['CLERK'],
    shelf_ids: [],
    menus: [],
    permissions: ['delivery_note.print'],
  };
  Object.assign(base, over);
  useAuthStore().user = base;
}

/** 造一个**没有**该权限点的账号（canPrint 的负例底座）。 */
function withoutPrintPermission(over: Partial<CurrentUser> = {}): void {
  withPrintPermission({ permissions: [], ...over });
}

beforeEach(() => {
  const app = createApp({});
  app.use(createPinia());
  app.use(VueQueryPlugin, { queryClient: new QueryClient() });
  setActivePinia(app.config.globalProperties.$pinia);
});

describe('deliveryNotePermissions 常量表（2026-10-15 第二批）', () => {
  it('2 个权限点 code 与后端 seeds 逐字一致', () => {
    expect(permissionModule.DELIVERY_NOTE_PRINT_PERMISSION).toBe('delivery_note.print');
    expect(permissionModule.DELIVERY_NOTE_VIEW_PERMISSION).toBe('delivery_note.view');
  });

  it('导出面恰为 11 个运行时导出（2 常量 + 9 helper，防改名 / 误删）', () => {
    // 类型（RoleMapLike / PrintableNoteLike）编译期擦除，不在下面的键集里。
    expect(Object.keys(permissionModule).sort()).toEqual(
      [
        'DELIVERY_NOTE_PRINT_PERMISSION',
        'DELIVERY_NOTE_VIEW_PERMISSION',
        'hasManageNoteRole',
        'canAddRemoveParts',
        'canSubmit',
        'canRecall',
        'canSoftDelete',
        'canPrint',
        'canDeliver',
        'canView',
        'defaultStatusesForRole',
      ].sort(),
    );
  });
});

describe('hasManageNoteRole（仍按角色判，2026-10-14 未迁）', () => {
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

describe('canPrint —— 打印入口与司机状态解耦的回归锁', () => {
  // ⚠️ 下面两条钉的是「司机没指定时**仍然**允许进打印对话框」——司机不参与本函数判定。
  it('driver_worker_name 为 null 时仍返回 true（不能把按钮锁死成看不见）', () => {
    withPrintPermission();
    expect(canPrint(note({ driver_worker_name: null }), { MANAGER: true })).toBe(true);
  });

  it('driver_worker_name 为空串时同样返回 true', () => {
    withPrintPermission();
    expect(canPrint(note({ driver_worker_name: '' }), { CLERK: true })).toBe(true);
  });

  it('司机名有无**不影响**结果（判据里根本没有这一项）', () => {
    withPrintPermission();
    const withDriver = canPrint(note({ driver_worker_name: '李四' }), { MANAGER: true });
    const without = canPrint(note({ driver_worker_name: null }), { MANAGER: true });
    expect(withDriver).toBe(without);
  });
});

describe('canPrint —— 按权限点判（2026-10-14 判据迁移）', () => {
  it('持有 delivery_note.print ⇒ 可见（与角色无关）', () => {
    withPrintPermission({ roles: [] });
    expect(canPrint(note(), {})).toBe(true);
  });

  it('不持该权限点 ⇒ 不可见，哪怕角色是 MANAGER', () => {
    // 管理员可以在 RBAC 面板把「送货单打印」从某个角色手里收回；继续按角色判的话
    // 入口还在，点下去才发现没权限。
    withoutPrintPermission({ roles: ['MANAGER'] });
    expect(canPrint(note(), { MANAGER: true })).toBe(false);
  });

  it('ADMIN 元角色通配放行', () => {
    withoutPrintPermission({ roles: ['ADMIN'] });
    expect(canPrint(note(), {})).toBe(true);
  });

  it('**角色形参不再参与判定**（签名兼容：换角色值不改结论）', () => {
    const CASES: RoleMapLike[] = [
      {},
      { MANAGER: false },
      { CLERK: true },
      { INSPECTOR: true, MANAGER: true },
    ];
    withPrintPermission({ roles: [] });
    for (const c of CASES) expect(canPrint(note(), c)).toBe(true);

    withoutPrintPermission({ roles: ['CLERK'] });
    for (const c of CASES) expect(canPrint(note(), c)).toBe(false);
  });
});

describe('canPrint 真值表', () => {
  it.each(ALL_STATUSES)('status=%s 且有行项 → 四个状态全放行（含已送货补打）', (status) => {
    withPrintPermission();
    expect(canPrint(note({ status }), { MANAGER: true })).toBe(true);
  });

  it.each(MANAGE_ROLES.map((r) => [Object.keys(r)[0]!, r] as [string, RoleMapLike]))(
    '%s 可见打印入口',
    (_label, role) => {
      withPrintPermission();
      expect(canPrint(note(), role)).toBe(true);
    },
  );

  it('无权限点恒 false（无论状态、件数、司机与角色如何）', () => {
    const unrelatedRole: AnyRoleMap = { CNC_PROGRAMMER: true };
    withoutPrintPermission();
    for (const status of ALL_STATUSES) {
      for (const part_count of [0, 1, 99]) {
        expect(canPrint(note({ status, part_count }), {})).toBe(false);
        expect(canPrint(note({ status, part_count }), unrelatedRole)).toBe(false);
        expect(canPrint(note({ status, part_count }), { MANAGER: false, CLERK: false })).toBe(
          false,
        );
      }
    }
  });

  it('part_count === 0 恒 false（空单无物可打，权限点与司机都救不回来）', () => {
    withPrintPermission();
    for (const role of MANAGE_ROLES) {
      for (const driver_worker_name of [null, '李四']) {
        expect(canPrint(note({ part_count: 0, driver_worker_name }), role)).toBe(false);
      }
    }
  });

  it('part_count 为负数也 false（守卫写成 < 0 会放过脏数据）', () => {
    withPrintPermission();
    expect(canPrint(note({ part_count: -1 }), { MANAGER: true })).toBe(false);
  });

  it('未知 status 放行（判据不做白名单比对，后端新增枚举时不会误伤）', () => {
    withPrintPermission();
    expect(canPrint(note({ status: 'WHATEVER' }), { MANAGER: true })).toBe(true);
  });
});

describe('canPrint 不误伤相邻 helper（2026-10-14 只迁 canPrint）', () => {
  // 下面四条**不需要** pinia 状态：它们仍按角色判，这是本轮刻意留下的边界。
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

  // 边界钉死：这四个 helper 仍读角色 map ⇒ 即使账号没有任何权限点，角色对了照样放行。
  // 哪天有人「顺手把它们也迁到权限点」，这一条会红，提醒那是一次范围外的行为变更。
  it('相邻四个 helper 不读权限点（无权限点的 MANAGER 仍然放行）', () => {
    withoutPrintPermission({ roles: ['MANAGER'] });
    expect(canSubmit('DRAFT', { MANAGER: true })).toBe(true);
    expect(canRecall('SUBMITTED', { MANAGER: true })).toBe(true);
    expect(canSoftDelete('DRAFT', { MANAGER: true })).toBe(true);
    expect(canDeliver('SUBMITTED', { MANAGER: true }, 1)).toBe(true);
  });
});
