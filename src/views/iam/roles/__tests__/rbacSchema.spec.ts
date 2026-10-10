// src/views/iam/roles/__tests__/rbacSchema.spec.ts
//
// 2026-10-14 新增：RBAC 面板守门 schema（`../composables/rbacSchema`）的单测。
//
// 本文件与 `src/views/auth/__tests__/sessionSchema.spec.ts` 是一组**刻意相反**的对照，
// 两条口径必须成对维护（缺一条时，另一条会在改版里被无声地漂走）：
//   - 本文件：**面板是写侧**（管理员在写权限）⇒ 守门接 `.strict()`，后端加字段立刻红，
//     要决策；坏响应必须在守门层当场炸掉，不能让管理员看着一份「完整」的授权清单，
//     实际生效的却与他以为的不同。
//   - 会话那份：**认证链路是读侧** ⇒ 不接 `.strict()`，后端加派生字段照常通过，
//     因为那里守门失败 = 全员登不进去。
//
// 另外覆盖两条接线约束：
//   - 菜单树守门**复用** `views/auth/sessionSchema` 的 `menuNodeSchema`（不写第二份）；
//   - 表单 schema 的 trim / min 链式顺序（全空格绕过必填）。

import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { menuNodeSchema } from '@/views/auth/sessionSchema';
import {
  permissionGroupSchema,
  roleDefSchema,
  roleDefListSchema,
  roleFormSchema,
  roleGrantsSchema,
} from '../composables/rbacSchema';

function makeRole(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '1900000000000000101',
    code: 'QC_LEAD',
    name: '品检组长',
    description: '品检放行',
    is_system: false,
    is_active: true,
    version: 3,
    user_count: 2,
    ...overrides,
  };
}

function makeGrants(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    role_id: '1900000000000000101',
    role_code: 'QC_LEAD',
    is_system: false,
    version: 4,
    menu_codes: ['users_list', 'shelves_list'],
    permission_codes: ['part.drawing.print'],
    ...overrides,
  };
}

describe('roleDefSchema —— 面板是写侧，守门接 .strict()', () => {
  it('R1：合法角色行通过', () => {
    const parsed = roleDefSchema.parse(makeRole());
    expect(parsed.code).toBe('QC_LEAD');
    expect(parsed.version).toBe(3);
    expect(parsed.user_count).toBe(2);
  });

  // 这是本文件的核心对照点：面板守门**多一个键就抛**，与认证链路相反。
  it('R2：多一个未知键抛 ZodError（后端加字段必须当场决策，不能静默生效）', () => {
    expect(() => roleDefSchema.parse(makeRole({ extra_flag: true }))).toThrow(ZodError);
  });

  it('R3：必填键任一缺失都抛（漏发 = 那一列整列失效且无报错）', () => {
    for (const key of ['id', 'code', 'name', 'is_system', 'is_active', 'version', 'user_count']) {
      const clone = makeRole();
      delete clone[key];
      expect(() => roleDefSchema.parse(clone), `缺 ${key} 应当抛错`).toThrow(ZodError);
    }
  });

  it('R4：id 必须是字符串（雪花 ID 走 JSON string）', () => {
    expect(() => roleDefSchema.parse(makeRole({ id: Number('1900000000000000101') }))).toThrow(
      ZodError,
    );
  });

  it('R5：description 可为 null，但键必须存在', () => {
    expect(roleDefSchema.parse(makeRole({ description: null })).description).toBeNull();
    const missing = makeRole();
    delete missing.description;
    expect(() => roleDefSchema.parse(missing)).toThrow(ZodError);
  });

  it('R6：自定义角色 code 不锁枚举（QC_LEAD 这类自建 code 必须能过）', () => {
    expect(roleDefSchema.parse(makeRole({ code: 'SOME_FUTURE_ROLE' })).code).toBe(
      'SOME_FUTURE_ROLE',
    );
  });

  it('R7：roleDefListSchema 是裸数组（端点无分页信封），每个元素各自守门', () => {
    expect(roleDefListSchema.parse([makeRole(), makeRole({ code: 'ADMIN', is_system: true })])).toHaveLength(2);
    expect(() => roleDefListSchema.parse([makeRole(), { bad: true }])).toThrow(ZodError);
    expect(() => roleDefListSchema.parse('不是数组')).toThrow(ZodError);
  });
});

describe('roleGrantsSchema —— 整包替换语义的授权包', () => {
  it('G1：合法授权包通过', () => {
    const parsed = roleGrantsSchema.parse(makeGrants());
    expect(parsed.menu_codes).toEqual(['users_list', 'shelves_list']);
    expect(parsed.permission_codes).toEqual(['part.drawing.print']);
  });

  it('G2：ADMIN 的全量返回能过（后端对 ADMIN 返回全量，不是特殊结构）', () => {
    const parsed = roleGrantsSchema.parse(
      makeGrants({ role_code: 'ADMIN', is_system: true, menu_codes: [], permission_codes: [] }),
    );
    expect(parsed.role_code).toBe('ADMIN');
    expect(parsed.menu_codes).toEqual([]);
  });

  it('G3：多一个未知键抛（面板侧同样 strict）', () => {
    expect(() => roleGrantsSchema.parse(makeGrants({ inherited_from: 'x' }))).toThrow(ZodError);
  });

  it('G4：menu_codes / permission_codes 必须是数组（整包替换的载荷形态）', () => {
    expect(() => roleGrantsSchema.parse(makeGrants({ menu_codes: 'users_list' }))).toThrow(ZodError);
    expect(() => roleGrantsSchema.parse(makeGrants({ permission_codes: null }))).toThrow(ZodError);
  });
});

describe('permissionGroupSchema', () => {
  function makeGroup(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      domain: 'part',
      items: [
        { code: 'part.drawing.print', name: '零件图纸打印', description: null, is_active: true },
      ],
      ...overrides,
    };
  }

  it('P1：合法分组通过', () => {
    const parsed = permissionGroupSchema.parse(makeGroup());
    expect(parsed.domain).toBe('part');
    expect(parsed.items[0]!.code).toBe('part.drawing.print');
  });

  it('P2：items 元素缺 code 抛错（少一个权限点 = 该码永远授不出去且无报错）', () => {
    expect(() =>
      permissionGroupSchema.parse(
        makeGroup({ items: [{ name: '零件图纸打印', description: null, is_active: true }] }),
      ),
    ).toThrow(ZodError);
  });

  it('P3：多一个未知键抛（strict 口径一致）', () => {
    expect(() => permissionGroupSchema.parse(makeGroup({ icon: 'Key' }))).toThrow(ZodError);
  });
});

describe('菜单树 schema 的复用（不写第二份）', () => {
  it('M1：面板消费的 menuNodeSchema 就是会话链路那一份（同一引用）', async () => {
    // 复用必须是「同一个对象」而不是「长得一样的两份」：两份各写一遍时，字段漂移会让
    // 「能在面板里勾出来的菜单」与「侧栏实际认的菜单」分叉，而后端只认后者。
    const exported = await import('../composables/rbacSchema');
    const session = await import('@/views/auth/sessionSchema');
    expect(exported.menuNodeSchema).toBe(session.menuNodeSchema);
  });

  it('M2：它能解析面板用的菜单树数据源（GET /iam/menus）', () => {
    const parsed = menuNodeSchema.array().parse([
      {
        id: 'g1',
        version: 0,
        parent_id: null,
        code: 'auth_group',
        title: '权限管理',
        path: null,
        icon: 'Key',
        sort_order: 30,
        children: [
          {
            id: 'r1',
            version: 0,
            parent_id: 'g1',
            code: 'roles_list',
            title: '角色权限',
            path: '/iam/roles',
            icon: 'Key',
            sort_order: 40,
            children: [],
          },
        ],
      },
    ]);
    expect(parsed[0]!.children[0]!.code).toBe('roles_list');
  });
});

describe('roleFormSchema —— 表单校验', () => {
  it('F1：合法输入通过，trim 先于 min（全空格会被 min 拦下）', () => {
    const parsed = roleFormSchema.parse({ code: '  QC_LEAD  ', name: '  品检组长 ', description: '' });
    expect(parsed.code).toBe('QC_LEAD');
    expect(parsed.name).toBe('品检组长');
  });

  it('F2：全空格的 name 被必填拦下（链式顺序硬约束）', () => {
    expect(() => roleFormSchema.parse({ code: 'X', name: '   ', description: '' })).toThrow(ZodError);
  });

  it('F3：超长字段被拦下', () => {
    expect(() =>
      roleFormSchema.parse({ code: 'a'.repeat(51), name: 'ok', description: '' }),
    ).toThrow(ZodError);
    expect(() =>
      roleFormSchema.parse({ code: 'ok', name: 'b'.repeat(51), description: '' }),
    ).toThrow(ZodError);
  });
});