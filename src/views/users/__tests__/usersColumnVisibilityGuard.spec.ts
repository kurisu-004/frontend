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
// 四条断言：
//   1. 前提：`buildUsersColumnDefs` 的输出里确实存在恒可见列（否则守卫无的放矢，且日后
//      有人删掉 `fixed: 'right'` 会被这条抓住）；
//   2. 纯函数层：按 `isAlwaysVisibleColumn` 过滤后，候选里不再有任何恒可见列；
//   3. 接线层：扫 `UserTable.vue` 源码，断言 `visibilityDefs` 走的是 `isAlwaysVisibleColumn`
//      而不是硬编码列 key 名单（名单会随新增吸附列静默漏项）；
//   4. 守卫自身：扫描到的源码非空且含 `visibilityDefs` —— 断言 3 是 `not.toMatch`，
//      扫描源一旦变空串它会恒绿，守卫就空转了（比正则不严谨更糟）。
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
    // 禁止范围 = **恒可见列的 key 与字面量比较**：`.key !== 'actions'` / `.key === "actions"`
    // （单双引号都认，prettier 不强制引号风格，只认单引号会漏网）。
    //   - 名单从 `DEFS` 现算而不是写死 'actions'：日后新增第二个吸附 / 不可拖列时守卫自动
    //     跟着覆盖（写死名单会随新增静默漏项，正是这条断言要防的反模式）；
    //   - 只比 `.key`，不拦 `d.prop === '…'` 等与可见性无关的比较：整段一刀切会在日后
    //     为别的用途写一句合法的 key 比较时误报，误报久了就会被人加白名单绕开守卫。
    const alwaysVisibleKeys = DEFS.filter(isAlwaysVisibleColumn).map((d) =>
      d.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    );
    expect(alwaysVisibleKeys.length).toBeGreaterThan(0);
    const hardcodedAlwaysVisibleCompare = new RegExp(
      `\\.key\\s*[!=]==?\\s*['"](?:${alwaysVisibleKeys.join('|')})['"]`,
    );
    expect(src).not.toMatch(hardcodedAlwaysVisibleCompare);
  });

  // 断言 3 的探测范围本身就是不变量：扫描源一旦换文件 / 变成空串，正则匹配会恒不命中 ⇒
  // `not.toMatch` 永远绿、守卫空转。这里把「非空 + 真的含 `isAlwaysVisibleColumn`」钉住。
  it('守卫自身：扫描到的 UserTable.vue 源码非空且含过滤判据（防 not.toMatch 恒绿空转）', () => {
    const src = readFileSync(USER_TABLE_VUE, 'utf8');
    expect(src.length).toBeGreaterThan(0);
    expect(src).toContain('visibilityDefs');
  });
});