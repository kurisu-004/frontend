// src/views/users/__tests__/usersColumnVisibilityGuard.spec.ts
//
// 2026-10-10 新增：跨文件不变量「恒可见列（操作列）恒可见」的守卫单测。
//
// 为什么需要它：操作列**在** `buildUsersColumnDefs` 的输出里（行内按钮由注入的 actions
// 渲染），但它必须永远可见。恒可见**不**由列定义自身保证，而是靠 `UserTable.vue` 把它从
// `ColumnVisibilityPopover` 的候选列表里剔除 —— `useColumnVisibility.update()` 会剪掉不在
// 新 map 里的键，而 `isVisible()` 对未知键返回 true ⇒ 不列进候选 = 恒可见。
//
// 这个不变量横跨两个文件（store 传全量 defs ↔ UserTable 过滤），任一侧漏改就**静默失效**
// （操作列整列消失，用户无法自救），今天也没有仓内先例可抄，所以补一条守卫把两侧钉在一起。
//
// 三条断言：
//   1. 前提：`buildUsersColumnDefs` 的输出里确实存在恒可见列（否则守卫无的放矢，且日后
//      有人删掉 `fixed: 'right'` 会被这条抓住）；
//   2. 纯函数层：按 `isAlwaysVisibleColumn` 过滤后，候选里不再有任何恒可见列；
//   3. 接线层：扫 `UserTable.vue` 源码，断言 `visibilityDefs` 走的是 `isAlwaysVisibleColumn`
//      而不是硬编码列 key 名单（名单会随新增吸附列静默漏项）。
//
// ⚠️ 断言 3 是**源码扫描**（fs 口径），与 `styles/__tests__/elementPlusManualImportStyles.spec.ts`
// 同款做法。若将来 UserTable.vue 重构到把过滤逻辑挪进别的模块，请同步改本守卫的扫描目标。

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildUsersColumnDefs, isAlwaysVisibleColumn, type UsersColumnActions } from '../usersColumnDefs';

const USER_TABLE_VUE = fileURLToPath(new URL('../components/UserTable.vue', import.meta.url));

/** 一个不产生任何副作用的假动作集（守卫只关心列的元数据，不关心行内按钮）。 */
const ACTIONS: UsersColumnActions = {
  openWxBind: () => undefined,
  openRoles: () => undefined,
  edit: () => undefined,
  resetPassword: () => undefined,
  deactivate: () => undefined,
};

/** 两个表头筛选状态机的静态假值：本守卫不触发筛选，只读列的元数据。
 *  `active` / `filteredValue` / `count` 的声明型是 `ComputedRef`，这里用 `{ value }`
 *  假值 + 整体 cast（守卫不渲染、不 watch）。 */
function fakeDeps(): Parameters<typeof buildUsersColumnDefs>[0] {
  const refOf = <T>(v: T) => ({ value: v });
  return {
    usernameFilter: {
      visible: refOf(false),
      draft: refOf(''),
      active: refOf(false),
      sync: () => undefined,
      confirm: () => undefined,
      reset: () => undefined,
    },
    activeFilter: {
      options: [
        { text: '启用', value: 'true' },
        { text: '停用', value: 'false' },
      ],
      filteredValue: refOf([]),
      active: refOf(false),
      count: refOf(0),
    },
    actions: ACTIONS,
  } as unknown as Parameters<typeof buildUsersColumnDefs>[0];
}

const DEFS = buildUsersColumnDefs(fakeDeps());

describe('恒可见列守卫（操作列恒可见）', () => {
  it('前提：defs 里确实有恒可见列（fixed / draggable:false），否则守卫无的放矢', () => {
    const alwaysVisible = DEFS.filter(isAlwaysVisibleColumn);
    expect(alwaysVisible.map((d) => d.key)).toEqual(['actions']);
    // 操作列同时踩中两条判据（fixed='right' 与显式 draggable:false）。
    const actions = alwaysVisible[0];
    expect(actions?.fixed).toBe('right');
    expect(actions?.draggable).toBe(false);
    // 数据列一个都不该被判成恒可见（否则用户会失去关掉数据列的能力）。
    expect(DEFS.filter((d) => d.key !== 'actions' && isAlwaysVisibleColumn(d))).toHaveLength(0);
  });

  it('纯函数层：过滤后的候选里不再有任何恒可见列（恒可见列用户点不掉）', () => {
    const candidates = DEFS.filter((d) => !isAlwaysVisibleColumn(d));
    expect(candidates.map((d) => d.key)).toEqual([
      'username',
      'full_name',
      'roles',
      'is_active',
      'last_login_at',
    ]);
    expect(candidates.filter(isAlwaysVisibleColumn)).toHaveLength(0);
  });

  it('接线层：UserTable.vue 的候选过滤走 isAlwaysVisibleColumn，不硬编码列 key 名单', () => {
    const src = readFileSync(USER_TABLE_VUE, 'utf8');
    expect(src).toMatch(/isAlwaysVisibleColumn/);
    // 硬编码 key 名单的两种典型写法：`.key !== 'actions'` / `.key === 'actions'`。
    expect(src).not.toMatch(/\.key\s*[!=]==?\s*'[^']+'/);
  });
});