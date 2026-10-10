// src/views/auth/__tests__/sessionSchema.spec.ts
//
// 2026-10-14 新增：认证链路守门 schema（`../sessionSchema`）的单测。
//
// 这份 spec 存在的理由与 `views/iam/roles/__tests__/rbacSchema.spec.ts` 是一组**对照**：
// 本文件守「读侧（会话）刻意不 `.strict()`、但必填键一个不漏」，那边守「写侧（面板）
// 刻意 `.strict()`」。两条口径是刻意相反的，所以两份 spec 必须成对存在 —— 只守一边
// 时，另一边的口径会在改版里被无声地漂走：
//   - 本文件的「未知键通过」用例被删/被改成 `.strict()` ⇒ 后端给 CurrentUser 加一个
//     派生字段就会让**全员**登不进去（`/iam/me` 复核抛 ZodError → 踢登录页循环）；
//   - 本文件的「缺 permissions 抛错」用例被删 ⇒ 旧后端上线后前端无声地把整个账号
//     的权限点判成空 ⇒ 所有人都变成「什么权限都没有」，且不报任何错。
//
// 环境：node（纯 schema，无 DOM 依赖）。

import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { currentUserSchema, loginResponseSchema, menuNodeSchema } from '../sessionSchema';

/** 造一份合法的菜单节点；`overrides` 用于逐字段做负向用例。 */
function makeMenuNode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '999990000000000001',
    version: 0,
    parent_id: null,
    code: 'roles_list',
    title: '角色权限',
    path: '/iam/roles',
    // 2026-10-14：与生产 t_menu.icon 对齐（权威值 Lock；父节点 auth_group 才是 Key）。
    icon: 'Lock',
    sort_order: 40,
    children: [],
    ...overrides,
  };
}

/** 造一份合法的当前用户；`overrides` 用于逐字段做负向用例。 */
function makeUser(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '1900000000000000001',
    username: 'alice',
    full_name: 'Alice',
    is_active: true,
    roles: ['MANAGER', 'QC_LEAD'],
    shelf_ids: [],
    menus: [makeMenuNode()],
    permissions: ['part.drawing.print', 'queue.dispatch'],
    ...overrides,
  };
}

describe('menuNodeSchema', () => {
  // 验收 8：递归 schema —— children 元素与父同形（真实菜单树是两层分组）。
  it('M1：递归解析两层菜单树（children 元素与父节点同形）', () => {
    const parsed = menuNodeSchema.parse(
      makeMenuNode({
        code: 'auth_group',
        title: '权限管理',
        path: null,
        children: [makeMenuNode({ code: 'users_list', parent_id: 'g1', path: '/users' })],
      }),
    );
    expect(parsed.code).toBe('auth_group');
    expect(parsed.children).toHaveLength(1);
    expect(parsed.children[0]!.code).toBe('users_list');
    expect(parsed.children[0]!.children).toEqual([]);
  });

  // 验收 4：认证链路刻意不 strict ⇒ 未知键被 Zod 默认 strip 掉。
  it('M2：parse 结果里未知键被 strip（不抛 unrecognized_keys）', () => {
    const parsed = menuNodeSchema.parse(makeMenuNode({ some_derived_field: '后端新加的' }));
    expect(parsed).not.toHaveProperty('some_derived_field');
    expect(parsed.code).toBe('roles_list');
  });

  // 验收 6：必填键显式声明 —— 缺 code 必须抛（否则路由守卫会拿 undefined 去比菜单树）。
  it('M3：缺 code 抛 ZodError（必填键显式声明，不靠 strip 静默放过）', () => {
    const { code: _dropped, ...withoutCode } = makeMenuNode();
    expect(() => menuNodeSchema.parse(withoutCode)).toThrow(ZodError);
  });

  it('M4：id 必须是字符串（雪花 ID 走 JSON string，Number 会丢精度）', () => {
    // 字面量不能直接写 19 位数字（ESLint 的 no-loss-of-precision 会拦，且它拦得对：
    // JS Number 下 1900000000000000001 与 1900000000000000000 是同一个值）。这里用
    // Number() 从字符串转，正好构造出「后端哪天把 serialize_i64 去掉」的那种坏响应。
    const numericSnowflake = Number('1900000000000000001');
    expect(() => menuNodeSchema.parse(makeMenuNode({ id: numericSnowflake }))).toThrow(
      ZodError,
    );
  });

  it('M5：path / icon / parent_id 可空但键必须存在', () => {
    const parsed = menuNodeSchema.parse(
      makeMenuNode({ path: null, icon: null, parent_id: 'g1' }),
    );
    expect(parsed.path).toBeNull();
    expect(parsed.icon).toBeNull();
    expect(parsed.parent_id).toBe('g1');
  });
});

describe('currentUserSchema', () => {
  // 验收 5：permissions 为空数组（后端返了键、值是空）⇒ 通过。
  it('C1：permissions 为空数组通过', () => {
    const parsed = currentUserSchema.parse(makeUser({ permissions: [] }));
    expect(parsed.permissions).toEqual([]);
  });

  // 验收 2：permissions 是必填 —— 缺该键抛错。
  it('C2：缺 permissions 抛 ZodError（旧后端上线会被这里当场挡住）', () => {
    const { permissions: _dropped, ...withoutPermissions } = makeUser();
    expect(() => currentUserSchema.parse(withoutPermissions)).toThrow(ZodError);
  });

  it('C3：permissions 为 null 抛 ZodError（必填键不接受 null 语义）', () => {
    expect(() => currentUserSchema.parse(makeUser({ permissions: null }))).toThrow(ZodError);
  });

  // 验收 3：认证链路刻意不 strict ⇒ 带未知多余键通过。
  it('C4：带未知多余键通过（后端加派生字段不该让全员登出）', () => {
    const parsed = currentUserSchema.parse(makeUser({ avatar_url: 'https://x/y.png', v2: 1 }));
    expect(parsed).not.toHaveProperty('avatar_url');
    expect(parsed.username).toBe('alice');
  });

  // 已知坑 ②：roles 必须是原始大写字符串数组，自定义角色 code 不能被吞。
  it('C5：自定义角色 code（QC_LEAD）出现在 roles 里且原样保留', () => {
    const parsed = currentUserSchema.parse(makeUser({ roles: ['QC_LEAD'] }));
    expect(parsed.roles).toEqual(['QC_LEAD']);
  });

  it('C6：menus 元素逐个过 menuNodeSchema（缺 code 的节点直接抛）', () => {
    const { code: _dropped, ...badNode } = makeMenuNode();
    expect(() => currentUserSchema.parse(makeUser({ menus: [badNode] }))).toThrow(ZodError);
  });

  it('C7：id / username / full_name / is_active / shelf_ids 任一缺失都抛', () => {
    for (const key of ['id', 'username', 'full_name', 'is_active', 'shelf_ids']) {
      const clone = makeUser();
      delete clone[key];
      expect(() => currentUserSchema.parse(clone), `缺 ${key} 应当抛错`).toThrow(ZodError);
    }
  });
});

describe('loginResponseSchema', () => {
  it('L1：合法登录响应通过，user 段由 currentUserSchema 一并守门', () => {
    const parsed = loginResponseSchema.parse({
      token: 'a.b.c',
      refresh_token: 'r1',
      user: makeUser(),
    });
    expect(parsed.token).toBe('a.b.c');
    expect(parsed.user.permissions).toEqual(['part.drawing.print', 'queue.dispatch']);
  });

  it('L2：user 段缺 permissions ⇒ 抛（refresh 响应用同一份 schema）', () => {
    const { permissions: _dropped, ...user } = makeUser();
    expect(() =>
      loginResponseSchema.parse({ token: 'a.b.c', refresh_token: 'r1', user }),
    ).toThrow(ZodError);
  });

  it('L3：缺 refresh_token 抛错（少它会让 http.ts 的 readStoredSession 早退拿不到会话）', () => {
    expect(() => loginResponseSchema.parse({ token: 'a.b.c', user: makeUser() })).toThrow(
      ZodError,
    );
  });
});