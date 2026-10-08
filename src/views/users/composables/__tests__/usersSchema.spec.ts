// src/views/users/composables/__tests__/usersSchema.spec.ts
//
// 2026-10-10 新增：账号管理域的 Zod 守门 / 表单 schema 单测。三类回归守卫：
//
//  1. 分页信封的 `total` / `limit` / `offset`：后端 `UserListOut` 三个字段是**裸 `i64`**
//     ⇒ wire 上是 JSON number（同一 VO 里挂 `serialize_i64` 的是雪花 ID），schema 只按
//     number 守门，**不**做 string → number 的二次归一。
//  2. **缺字段必须 parse 失败**：Zod 默认 strip 会把后端漏发的键静默丢掉，前端照样
//     「通过」校验、那一列整列失效 ⇒ 每个键都显式声明，且行 / 信封层 `.strict()`。
//  3. `wxIdentitySchema` 对 `null` 的处理：未绑定时后端信封 `data` 是 **null**（不是
//     `[]`），所以必须有另一个 `wxIdentityOrNullSchema` 接受两态。

import { describe, expect, it } from 'vitest';
import { ROLE_OPTIONS, SHELF_SCOPED_ROLE } from '../../usersConstants';
import {
  toFieldErrors,
  userFormSchema,
  userListResultSchema,
  wxBindFormSchema,
  wxIdentityOrNullSchema,
  wxIdentitySchema,
  type UserFormInput,
  type WxBindFormInput,
} from '../../usersSchema';

/** 一行账号（后端 `UserOut` 的 10 字段 wire 形态；id 是雪花**字符串**）。 */
const ROW = {
  id: '1900000000000000001',
  version: 3,
  username: 'zhangsan',
  full_name: '张三',
  phone: null,
  is_active: true,
  last_login_at: '2026-10-10T08:30:00',
  created_at: '2026-01-01T00:00:00',
  updated_at: '2026-10-01T00:00:00',
  roles: [
    {
      id: '1900000000000000002',
      version: 1,
      role: 'SHELF_ACCOUNT',
      scope_type: 'shelf',
      scope_id: '1900000000000000003',
      shelf_code: 'SH-A01',
      shelf_name: '生产架 A01',
    },
  ],
};

/** 一条企微绑定（后端 `WxIdentityOut` 的 6 字段 wire 形态）。 */
const WX = {
  id: '1900000000000000010',
  corp_id: 'ww1234567890',
  wx_user_id: 'zhangsan',
  user_id: '1900000000000000001',
  version: 2,
  created_at: '2026-10-01T09:00:00',
};

describe('userListResultSchema', () => {
  it('计数是 JSON number 时能 parse（后端 UserListOut 三个计数是裸 i64）', () => {
    const parsed = userListResultSchema.parse({
      items: [ROW],
      total: 1,
      limit: 20,
      offset: 0,
    });
    expect(parsed.total).toBe(1);
    expect(parsed.limit).toBe(20);
    expect(parsed.offset).toBe(0);
    expect(parsed.items[0]?.id).toBe('1900000000000000001');
    // 雪花 ID 全链路保持 string（禁 Number()：19 位 ID 在 JS Number 下丢精度）。
    expect(typeof parsed.items[0]?.id).toBe('string');
  });

  it('计数传 string 即失败（归一在 api 层 normalizeListResult，schema 不再兼容 string）', () => {
    expect(() =>
      userListResultSchema.parse({ items: [], total: '0', limit: 20, offset: 0 }),
    ).toThrow();
  });

  it('缺任一键即 parse 失败（Zod strip 陷阱的回归守卫）', () => {
    // 缺 total：后端漏发计数 ⇒ 必须抛，而不是静默丢成 undefined 塞进分页组件。
    expect(() => userListResultSchema.parse({ items: [], limit: 20, offset: 0 })).toThrow();
    // 缺 items 同理。
    expect(() => userListResultSchema.parse({ total: 0, limit: 20, offset: 0 })).toThrow();
    // 行内缺 roles（后端漏发）⇒ 抛。
    const { roles, ...rowWithoutRoles } = ROW;
    expect(roles).toHaveLength(1);
    expect(() =>
      userListResultSchema.parse({
        items: [rowWithoutRoles],
        total: 1,
        limit: 20,
        offset: 0,
      }),
    ).toThrow();
  });

  it('多一个键即抛（信封与行都 .strict()：后端加字段会被这里挡住、需要同步决策）', () => {
    expect(() =>
      userListResultSchema.parse({
        items: [],
        total: 0,
        limit: 20,
        offset: 0,
        extra: true,
      }),
    ).toThrow();
    expect(() =>
      userListResultSchema.parse({
        items: [{ ...ROW, nickname: '三儿' }],
        total: 1,
        limit: 20,
        offset: 0,
      }),
    ).toThrow();
  });

  it('可空字段接受 null（DB NULL → JSON null，不是键缺失）', () => {
    const parsed = userListResultSchema.parse({
      items: [{ ...ROW, phone: null, last_login_at: null, roles: [] }],
      total: 1,
      limit: 20,
      offset: 0,
    });
    expect(parsed.items[0]?.last_login_at).toBeNull();
    expect(parsed.items[0]?.roles).toEqual([]);
  });
});

describe('wxIdentitySchema / wxIdentityOrNullSchema', () => {
  it('已绑态：6 个键全在，雪花 ID 是字符串', () => {
    const parsed = wxIdentitySchema.parse(WX);
    expect(parsed.wx_user_id).toBe('zhangsan');
    expect(parsed.version).toBe(2);
    expect(typeof parsed.user_id).toBe('string');
  });

  it('未绑态：data 是 null，orNull 版接受且保留 null', () => {
    expect(wxIdentityOrNullSchema.parse(null)).toBeNull();
    expect(wxIdentityOrNullSchema.parse(WX)?.wx_user_id).toBe('zhangsan');
  });

  it('非 null 版对 null 抛错（别让未绑态悄悄过守门）', () => {
    expect(() => wxIdentitySchema.parse(null)).toThrow();
  });

  it('缺 corp_id / version 即抛（企微绑定详情与解绑 OCC 锚都依赖它们）', () => {
    const { corp_id, ...withoutCorp } = WX;
    const { version, ...withoutVersion } = WX;
    expect(corp_id).toBeTruthy();
    expect(version).toBe(2);
    expect(() => wxIdentitySchema.parse(withoutCorp)).toThrow();
    expect(() => wxIdentitySchema.parse(withoutVersion)).toThrow();
  });
});

describe('userFormSchema', () => {
  it('username / full_name 先 trim 再校验（全空格过不了必填）', () => {
    expect(
      userFormSchema.safeParse({ username: '   ', full_name: '张三', password: '' }).success,
    ).toBe(false);
    const ok = userFormSchema.parse({ username: '  zhangsan ', full_name: ' 张三 ', password: '' });
    expect(ok.username).toBe('zhangsan');
    expect(ok.full_name).toBe('张三');
  });

  it('password 不 trim（前后空格是合法字符）且编辑态可空 = 不改密', () => {
    const parsed = userFormSchema.parse({ username: 'a', full_name: 'b', password: ' pwd ' });
    expect(parsed.password).toBe(' pwd ');
  });

  it('超长字段被拒（上限与后端列宽对齐：用户名 / 姓名 50）', () => {
    expect(
      userFormSchema.safeParse({ username: 'a'.repeat(51), full_name: 'b', password: '' }).success,
    ).toBe(false);
    expect(
      userFormSchema.safeParse({ username: 'a', full_name: 'b'.repeat(51), password: '' }).success,
    ).toBe(false);
  });

  it('toFieldErrors 按字段聚合 issue，同字段只取第一条', () => {
    const parsed = userFormSchema.safeParse({ username: '', full_name: '   ', password: '' });
    expect(parsed.success).toBe(false);
    const errs = toFieldErrors<UserFormInput>(
      parsed.error?.issues as unknown as Array<{ path: PropertyKey[]; message: string }>,
    );
    expect(errs.username).toBe('请输入用户名');
    expect(errs.full_name).toBe('请输入姓名');
  });
});

describe('wxBindFormSchema', () => {
  it('wx_user_id 先 trim 再校验，空 / 全空格都拒', () => {
    expect(wxBindFormSchema.safeParse({ wx_user_id: '   ' }).success).toBe(false);
    const parsed = wxBindFormSchema.parse({ wx_user_id: '  ZhangSan ' });
    expect(parsed.wx_user_id).toBe('ZhangSan');
    const errs = toFieldErrors<WxBindFormInput>(
      wxBindFormSchema.safeParse({ wx_user_id: '' }).error?.issues as unknown as Array<{
        path: PropertyKey[];
        message: string;
      }>,
    );
    expect(errs.wx_user_id).toBe('请输入企业微信成员 UserID');
  });
});

describe('ROLE_OPTIONS', () => {
  it('5 个候选的 value 互不重复，且含需绑货架的那个角色', () => {
    expect(ROLE_OPTIONS.map((o) => o.value)).toEqual([
      'MANAGER',
      'CLERK',
      'SHELF_ACCOUNT',
      'INSPECTOR',
      'CNC_PROGRAMMER',
    ]);
    expect(new Set(ROLE_OPTIONS.map((o) => o.value)).size).toBe(ROLE_OPTIONS.length);
    // SHELF_SCOPED_ROLE 是「加的时候要选货架」的唯一角色，漏进候选 = 该账号加不上货架范围。
    expect(ROLE_OPTIONS.some((o) => o.value === SHELF_SCOPED_ROLE)).toBe(true);
  });

  it('每个候选都有非空中文 label（label 空 = 下拉里一行空白）', () => {
    for (const o of ROLE_OPTIONS) {
      expect(o.label.length).toBeGreaterThan(0);
    }
  });
});
