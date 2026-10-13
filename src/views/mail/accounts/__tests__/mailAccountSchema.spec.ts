// @vitest-environment happy-dom
// src/views/mail/accounts/__tests__/mailAccountSchema.spec.ts
//
// 2026-10-16 新增：邮箱账号域 Zod schema 单测。四组：
//
//  1. **守门 schema**（account / list / meta / deleteResult）：雪花 ID 恒为 string、
//     枚举越界即抛、缺键即抛（Zod strip 陷阱）、**多一个键即抛**（`.strict()`）。
//  2. **`encrypted_secret` 必须当场抛**：授权码密文入库、出参**绝不**带回。本 schema 刻意
//     不声明它 + `.strict()` ⇒ 后端哪天误带出来时 parse 抛错（响亮的失败），而不是被
//     Zod 默认的 strip 静默吞掉、静默进到组件 props 里。**这条不变量就是「响亮地失败」
//     换来的**，所以必须有断言守着。
//  3. **表单校验**：建档 / 改档两种模式（secret 必填 vs 留空 = 不改）、name / account
//     的 trim 与长度上限、换行拦截、字段聚焦（红字落到具体输入项）。
//  4. **字段错误聚合**：同字段多 issue 只取第一条。
//
// 环境：默认 node（本文件不碰 DOM）。

import { describe, expect, it } from 'vitest';
import {
  MAIL_ACCOUNT_ACCOUNT_MAX,
  MAIL_ACCOUNT_NAME_MAX,
  MAIL_ACCOUNT_SECRET_MAX,
  mailAccountDeleteResultSchema,
  mailAccountListSchema,
  mailAccountPresetSchema,
  mailAccountSchema,
  mailMetaSchema,
  makeMailAccountFormSchema,
  toMailAccountFieldErrors,
  type MailAccountFormField,
  type MailAccountFormModel,
} from '../mailAccountSchema';

/** 后端 `MailAccountOut` 的 wire 形态（9 键，全显式声明）。 */
const ACCOUNT = {
  id: '9000000000000902',
  version: 1,
  name: '采购部邮箱',
  preset: 'NET_EASE_163',
  account: 'purchase@example.com',
  is_default: true,
  created_at: '2026-10-16 08:00:00',
  updated_at: '2026-10-16 08:00:00',
};

const PRESET_OPTION = {
  value: 'NET_EASE_163',
  label: '网易 163',
  host: 'smtp.163.com',
  port: 465,
  tls_mode: 'WRAPPED',
};

describe('mailAccountSchema — 守门', () => {
  it('合法行逐字透传（parse 不改值）', () => {
    expect(mailAccountSchema.parse(ACCOUNT)).toEqual(ACCOUNT);
  });

  it('id 必须是 string：传 number 即抛（19 位雪花 ID 在 JS Number 下会丢精度）', () => {
    expect(() => mailAccountSchema.parse({ ...ACCOUNT, id: Number(ACCOUNT.id) })).toThrow();
  });

  it('version 必须是 number：传 string 即抛（它是 OCC 锚，不是 ID）', () => {
    expect(() => mailAccountSchema.parse({ ...ACCOUNT, version: '1' })).toThrow();
  });

  it('preset 枚举越界即抛（前端只守取值域，成员清单由 /mail/meta 下发）', () => {
    expect(mailAccountPresetSchema.safeParse('NET_EASE_163').success).toBe(true);
    expect(mailAccountPresetSchema.safeParse('TENCENT_QQ').success).toBe(true);
    expect(mailAccountPresetSchema.safeParse('GMAIL').success).toBe(false);
    expect(() => mailAccountSchema.parse({ ...ACCOUNT, preset: 'GMAIL' })).toThrow();
  });

  it('缺必填键即抛（Zod 默认 strip 会把缺字段悄悄吞掉 ⇒ 那一列整列 undefined）', () => {
    for (const key of Object.keys(ACCOUNT)) {
      const bad: Record<string, unknown> = { ...ACCOUNT };
      delete bad[key];
      expect(() => mailAccountSchema.parse(bad), `缺 ${key} 应当抛`).toThrow();
    }
  });

  it('多一个键即抛（`.strict()`：响亮地失败，而不是静默 strip）', () => {
    expect(() => mailAccountSchema.parse({ ...ACCOUNT, is_active: true })).toThrow();
  });

  // ⚠️ 本组是「响亮地失败」这条设计意图的唯一防线，别删。
  it('⚠️ 后端若误带 encrypted_secret，守门**当场抛**（绝不静默 strip）', () => {
    expect(() => mailAccountSchema.parse({ ...ACCOUNT, encrypted_secret: 'AAAA' })).toThrow();
    expect(() =>
      mailAccountSchema.parse({ ...ACCOUNT, encrypted_secret_mask: 'AA**BB' }),
    ).toThrow();
  });
});

describe('mailAccountListSchema / mailMetaSchema / 删除结果 — 守门', () => {
  it('列表：一次性返全部的数组形态，元素逐条走同款守门', () => {
    expect(mailAccountListSchema.parse([ACCOUNT])).toEqual([ACCOUNT]);
    expect(() => mailAccountListSchema.parse([{ ...ACCOUNT, preset: 'GMAIL' }])).toThrow();
    // 顶层不是数组即抛（信封搞错时）
    expect(() => mailAccountListSchema.parse({ items: [ACCOUNT] })).toThrow();
  });

  it('meta：presets 由后端下发 host / port / tls_mode，前端只守结构', () => {
    const meta = { presets: [PRESET_OPTION] };
    expect(mailMetaSchema.parse(meta)).toEqual(meta);
    expect(mailMetaSchema.parse({ presets: [] })).toEqual({ presets: [] });
    // 少 host（页面那条只读描述行就没得显示）即抛
    const { host: _dropped, ...noHost } = PRESET_OPTION;
    expect(() => mailMetaSchema.parse({ presets: [noHost] })).toThrow();
    // 多一个键即抛（后端加字段必须同步前端决策）
    expect(() => mailMetaSchema.parse({ presets: [{ ...PRESET_OPTION, retry: 3 }] })).toThrow();
  });

  it('删除结果：`deleted` 恒 true（失败不返 200，21708 会抛错）', () => {
    expect(mailAccountDeleteResultSchema.parse({ deleted: true })).toEqual({ deleted: true });
    expect(() => mailAccountDeleteResultSchema.parse({ deleted: false })).not.toThrow();
    expect(() => mailAccountDeleteResultSchema.parse({})).toThrow();
  });
});

describe('makeMailAccountFormSchema — 建档 / 改档两种模式', () => {
  const base: MailAccountFormModel = {
    name: '采购部邮箱',
    preset: 'NET_EASE_163',
    account: 'purchase@example.com',
    secret: 'abc123',
  };

  it('建档：合法值过，且 secret 必填', () => {
    expect(makeMailAccountFormSchema('create').safeParse(base).success).toBe(true);
    const blank = makeMailAccountFormSchema('create').safeParse({ ...base, secret: '' });
    expect(blank.success).toBe(false);
    // 红字落到 secret 那一项，不是笼统挂在整份表单上
    expect(
      blank.success === false &&
        toMailAccountFieldErrors(blank.error.issues).secret === '请填写授权码',
    ).toBe(true);
  });

  it('建档：secret 全空白也按「没填」拒（不因为 trim 后是空串就放行）', () => {
    const r = makeMailAccountFormSchema('create').safeParse({ ...base, secret: '   ' });
    expect(r.success).toBe(false);
  });

  it('改档：**secret 留空合法**（wire 上是空串 = 后端「不改授权码」，不是「清空」）', () => {
    const r = makeMailAccountFormSchema('edit').safeParse({ ...base, secret: '' });
    expect(r.success).toBe(true);
    // 两种模式的差别是这一条：建档拒空、编辑放行。少一个模式就是用户永远改不了别的字段。
    expect(makeMailAccountFormSchema('create').safeParse({ ...base, secret: '' }).success).toBe(
      false,
    );
  });

  it('name：必填、trim 后非空、有上限', () => {
    const schema = makeMailAccountFormSchema('edit');
    expect(schema.safeParse({ ...base, name: '  ' }).success).toBe(false);
    expect(schema.safeParse({ ...base, name: 'x'.repeat(MAIL_ACCOUNT_NAME_MAX) }).success).toBe(
      true,
    );
    expect(schema.safeParse({ ...base, name: 'x'.repeat(MAIL_ACCOUNT_NAME_MAX + 1) }).success).toBe(
      false,
    );
    // 前后空格在解析那一刻归一（提交上去的是 trim 后的值）
    const ok = schema.safeParse({ ...base, name: '  采购部邮箱  ' });
    expect(ok.success && ok.data.name).toBe('采购部邮箱');
  });

  it('account：必填、有上限、拦换行', () => {
    const schema = makeMailAccountFormSchema('edit');
    expect(schema.safeParse({ ...base, account: '' }).success).toBe(false);
    expect(
      schema.safeParse({ ...base, account: 'x'.repeat(MAIL_ACCOUNT_ACCOUNT_MAX) }).success,
    ).toBe(true);
    expect(
      schema.safeParse({ ...base, account: 'x'.repeat(MAIL_ACCOUNT_ACCOUNT_MAX + 1) }).success,
    ).toBe(false);
    expect(schema.safeParse({ ...base, account: 'a@b.com\r\nBcc: x@y.com' }).success).toBe(false);
  });

  it('secret：只拦超长与换行，**不**按某一家服务商的规则卡字符集', () => {
    const schema = makeMailAccountFormSchema('edit');
    // 163 是 16 位字母数字、QQ 16 位带横线 —— 前端按任一家的规则写死都会在录另一家时
    // 给出「格式不正确」而实际值是对的。最终判据在后端（真发信时才验）。
    expect(schema.safeParse({ ...base, secret: 'A'.repeat(MAIL_ACCOUNT_SECRET_MAX) }).success).toBe(
      true,
    );
    expect(
      schema.safeParse({ ...base, secret: 'x'.repeat(MAIL_ACCOUNT_SECRET_MAX + 1) }).success,
    ).toBe(false);
    expect(schema.safeParse({ ...base, secret: 'abc\r\ndef' }).success).toBe(false);
  });

  it('preset 枚举越界即红（前端刻意不设业务默认值 ⇒ 用户必须显式选一次）', () => {
    const schema = makeMailAccountFormSchema('edit');
    const r = schema.safeParse({ ...base, preset: '' });
    expect(r.success).toBe(false);
    expect(r.success === false && toMailAccountFieldErrors(r.error.issues).preset).toBeDefined();
  });
});

describe('toMailAccountFieldErrors — 字段错误聚合', () => {
  it('按 path[0] 聚合；同字段多 issue 只取第一条', () => {
    const out = toMailAccountFieldErrors([
      { path: ['name'], message: '请填写名称' },
      { path: ['name'], message: '名称太长' },
      { path: ['account'], message: '请填写登录账号' },
    ]);
    expect(out.name).toBe('请填写名称');
    expect(out.account).toBe('请填写登录账号');
  });

  it('path 为空（笼统挂在整份表单上）的 issue 被忽略：没有对应输入项可标红', () => {
    expect(toMailAccountFieldErrors([{ path: [], message: '整体不合法' }])).toEqual({});
  });

  it('返回的键只能是四个字段之一（键名即 `MailAccountFormField`）', () => {
    const out = toMailAccountFieldErrors([{ path: ['secret'], message: 'x' }]);
    expect(Object.keys(out)).toHaveLength(1);
    const key = Object.keys(out)[0] as MailAccountFormField;
    expect(['name', 'preset', 'account', 'secret']).toContain(key);
  });
});
