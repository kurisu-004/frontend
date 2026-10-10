// src/api/__tests__/rbac.spec.ts
//
// 2026-10-14 新增：`src/api/rbac.ts` 的**负向守卫** —— 8 个 api 函数**不允许**做 Zod 校验。
//
// 为什么是负向断言：本文件的守门点在 query hook 的 queryFn
// （`@/views/iam/roles/composables/useRolesQuery`），api 层只发请求 + 用类型标注返回。
// Zod 的 parse 入口返回**深拷贝**，在 api 层再走一遍等于每屏数据被校验并克隆两遍；
// 而且 api 层一旦 parse，queryFn 那次就变成纯浪费，两处校验点还会随字段增删各自漂移。
//
// ⚠️ 这条守卫与 `views/iam/roles/__tests__/` 下的坏响应用例是一**对**：本文件守
// 「parse 没有被搬回 api 层」，那边的 query hook 用例守「parse 真的接在 queryFn 的返回
// 路径上」。少了本文件，把 parse 加回 api 层是零测试信号；少了那边，把 parse 从
// queryFn 删掉也是零测试信号。**两个方向都要有人在。**
//
// 同时钉死 8 个端点的 URL、HTTP 方法与请求体形态 —— URL 打错就是 404 / 405，而 404
// 只在「点一下才发现」时暴露。

import { beforeEach, describe, expect, it, vi } from 'vitest';

// 把 schema 模块整体桩掉，`parse` 用可断言的 spy：api 层今天只用 `import type` 引类型
// （`@/types/rbac`），域内 schema 模块根本不会被加载 ⇒ spy 恒 0 次调用；哪天有人改成
// 运行时 import 并挂上 parse，这些断言立刻红。
const schemaParse = vi.hoisted(() => ({
  roleDef: vi.fn(),
  roleGrants: vi.fn(),
  permissionGroup: vi.fn(),
  menuNode: vi.fn(),
}));

vi.mock('@/views/iam/roles/composables/rbacSchema', () => ({
  roleDefSchema: { parse: schemaParse.roleDef },
  roleGrantsSchema: { parse: schemaParse.roleGrants },
  permissionGroupSchema: { parse: schemaParse.permissionGroup },
  menuNodeSchema: { parse: schemaParse.menuNode },
}));

const httpGetMock = vi.fn();
const httpPostMock = vi.fn();

vi.mock('@/api/http', () => ({
  api: {
    get: (...args: unknown[]) => httpGetMock(...args),
    post: (...args: unknown[]) => httpPostMock(...args),
  },
}));

import {
  createRole,
  deactivateRole,
  getRoleGrants,
  listMenus,
  listPermissions,
  listRoles,
  saveRoleGrants,
  updateRole,
} from '../rbac';

const ROLE_ID = '1900000000000000101';

/** 后端真实 wire 形态：雪花 ID 是 JSON **string**，`version` / `user_count` 是 number。 */
const ROLE_ROW = {
  id: ROLE_ID,
  code: 'QC_LEAD',
  name: '品检组长',
  description: '品检放行权限',
  is_system: false,
  is_active: true,
  version: 3,
  user_count: 2,
};

const GRANTS = {
  role_id: ROLE_ID,
  role_code: 'QC_LEAD',
  is_system: false,
  version: 4,
  menu_codes: ['users_list', 'shelves_list'],
  permission_codes: ['part.drawing.print'],
};

beforeEach(() => {
  schemaParse.roleDef.mockReset();
  schemaParse.roleGrants.mockReset();
  schemaParse.permissionGroup.mockReset();
  schemaParse.menuNode.mockReset();
  httpGetMock.mockReset();
  httpPostMock.mockReset();
});

describe('rbac api 层不做 Zod 校验（负向守卫）', () => {
  it('N1：8 个 api 函数一律不调用 schema.parse', async () => {
    httpGetMock.mockResolvedValue({ data: [ROLE_ROW] });
    httpPostMock.mockResolvedValue({ data: ROLE_ROW });

    await listRoles();
    await createRole({ code: 'QC_LEAD', name: '品检组长' });
    await updateRole(ROLE_ID, { name: '品检组长', version: 3 });
    await deactivateRole(ROLE_ID, { version: 3, delete: false });
    await getRoleGrants(ROLE_ID);
    await saveRoleGrants(ROLE_ID, { menu_codes: [], permission_codes: [], version: 4 });
    await listPermissions();
    await listMenus();

    expect(schemaParse.roleDef).not.toHaveBeenCalled();
    expect(schemaParse.roleGrants).not.toHaveBeenCalled();
    expect(schemaParse.permissionGroup).not.toHaveBeenCalled();
    expect(schemaParse.menuNode).not.toHaveBeenCalled();
  });

  it('N2：坏响应原样透传（字段全错也照返，不 reject、不裁剪、不修正）', async () => {
    // 这条是 N1 的行为侧镜像：真在 api 层挂过 parse，这里必然抛 ZodError。
    // 用「每个字段类型都错」而不是「少一个字段」—— 后者对 `.optional()` 的 schema 不敏感。
    const garbage = { id: 42, code: null, version: 'v3', user_count: '两人', extra: true };

    httpGetMock.mockResolvedValue({ data: [garbage] });
    await expect(listRoles()).resolves.toEqual([garbage]);

    httpGetMock.mockResolvedValue({ data: { ...GRANTS, menu_codes: 'users_list' } });
    await expect(getRoleGrants(ROLE_ID)).resolves.toEqual({
      ...GRANTS,
      menu_codes: 'users_list',
    });

    httpPostMock.mockResolvedValue({ data: garbage });
    await expect(updateRole(ROLE_ID, { name: 'x', version: 3 })).resolves.toEqual(garbage);

    httpGetMock.mockResolvedValue({ data: { not: 'an array' } });
    await expect(listPermissions()).resolves.toEqual({ not: 'an array' });
    await expect(listMenus()).resolves.toEqual({ not: 'an array' });
  });
});

describe('rbac 八个端点的 URL / 方法 / 请求体契约', () => {
  it('U1：listRoles 打 GET /iam/roles 且不传 params', async () => {
    httpGetMock.mockResolvedValue({ data: [] });
    await listRoles();
    expect(httpGetMock).toHaveBeenCalledTimes(1);
    expect(httpGetMock.mock.calls[0]![0]).toBe('/iam/roles');
    expect(httpGetMock.mock.calls[0]![1]).toBeUndefined();
  });

  it('U2：createRole 打 POST /iam/roles，body 原样透传', async () => {
    httpPostMock.mockResolvedValue({ data: ROLE_ROW });
    await createRole({ code: 'QC_LEAD', name: '品检组长', description: null });
    expect(httpPostMock.mock.calls[0]![0]).toBe('/iam/roles');
    expect(httpPostMock.mock.calls[0]![1]).toEqual({
      code: 'QC_LEAD',
      name: '品检组长',
      description: null,
    });
  });

  it('U3：updateRole 打 POST /iam/roles/{id}/update，body 必带 version', async () => {
    httpPostMock.mockResolvedValue({ data: ROLE_ROW });
    await updateRole(ROLE_ID, { code: 'QC_HEAD', name: '品检组长', version: 3 });
    expect(httpPostMock.mock.calls[0]![0]).toBe(`/iam/roles/${ROLE_ID}/update`);
    expect(httpPostMock.mock.calls[0]![1]).toEqual({
      code: 'QC_HEAD',
      name: '品检组长',
      version: 3,
    });
  });

  it('U4：deactivateRole 打 POST /iam/roles/{id}/deactivate，body 带 version + delete', async () => {
    httpPostMock.mockResolvedValue({ data: { affected_user_count: 5 } });
    await expect(deactivateRole(ROLE_ID, { version: 3, delete: true })).resolves.toEqual({
      affected_user_count: 5,
    });
    expect(httpPostMock.mock.calls[0]![0]).toBe(`/iam/roles/${ROLE_ID}/deactivate`);
    expect(httpPostMock.mock.calls[0]![1]).toEqual({ version: 3, delete: true });
  });

  it('U5：getRoleGrants 打 GET /iam/roles/{id}/grants', async () => {
    httpGetMock.mockResolvedValue({ data: GRANTS });
    await expect(getRoleGrants(ROLE_ID)).resolves.toEqual(GRANTS);
    expect(httpGetMock.mock.calls[0]![0]).toBe(`/iam/roles/${ROLE_ID}/grants`);
  });

  it('U6：saveRoleGrants 打 POST 同路径，body 两个数组 + version（整包替换语义）', async () => {
    httpPostMock.mockResolvedValue({ data: GRANTS });
    await saveRoleGrants(ROLE_ID, {
      menu_codes: ['users_list'],
      permission_codes: ['queue.dispatch'],
      version: 4,
    });
    expect(httpPostMock.mock.calls[0]![0]).toBe(`/iam/roles/${ROLE_ID}/grants`);
    expect(httpPostMock.mock.calls[0]![1]).toEqual({
      menu_codes: ['users_list'],
      permission_codes: ['queue.dispatch'],
      version: 4,
    });
  });

  it('U7：listPermissions / listMenus 打 GET /iam/permissions 与 /iam/menus', async () => {
    httpGetMock.mockResolvedValue({ data: [] });
    await listPermissions();
    expect(httpGetMock.mock.calls[0]![0]).toBe('/iam/permissions');
    await listMenus();
    expect(httpGetMock.mock.calls[1]![0]).toBe('/iam/menus');
  });

  it('U8：雪花 ID 形参原样进路径（不做 Number 转换、不 encode）', async () => {
    // 19 位 ID 走 Number() 会丢精度 ⇒ 路径段必须是字符串直插。
    httpGetMock.mockResolvedValue({ data: GRANTS });
    await getRoleGrants('1900000000000000101');
    expect(httpGetMock.mock.calls[0]![0]).toBe('/iam/roles/1900000000000000101/grants');
  });

  it('U9：域内 schema 的引用不存在（api 层不引 views/iam/roles 的 schema 模块）', async () => {
    // 守 CLAUDE.md「api 层引域内 schema 默认用 import type，运行时值引入只允许出现在
    // 没有 queryFn 承载的守门点」：本文件的 8 个函数全部有 queryFn 承载（useRolesQuery），
    // 所以 api → views/iam/roles 这条**运行时边不该存在**。这里用模块图断边做静态断言。
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../rbac.ts', import.meta.url), 'utf8'),
    );
    expect(src).not.toMatch(/from\s+'@\/views\//);
  });
});