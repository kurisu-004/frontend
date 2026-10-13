// @vitest-environment happy-dom
// src/views/mail/accounts/__tests__/mailAccountSchema.spec.ts
//
// 2026-10-16 新增：邮箱账号域 Zod schema 单测。四组：
//
//  1. **守门 schema**（account / list / meta）：雪花 ID 恒为 string、**信封是 `{items:[]}`
//     而不是裸数组**、未知 preset 放行（后端刻意降级）、缺键即抛（Zod strip 陷阱）、
//     **多一个键即抛**（`.strict()`）。**删除端点没有出参 schema**（后端返 `R<()>`、
//     `data` 是 `null`，没有形状可守）。
//  2. **`encrypted_secret` 必须当场抛**：授权码密文入库、出参**绝不**带回。本 schema 刻意
//     不声明它 + `.strict()` ⇒ 后端哪天误带出来时 parse 抛错（响亮的失败），而不是被
//     Zod 默认的 strip 静默吞掉、静默进到组件 props 里。**这条不变量就是「响亮地失败」
//     换来的**，所以必须有断言守着。
//  3. **表单校验**：建档 / 改档两种模式（secret 必填 vs 留空 = 不改）、三个上限
//     **与后端 `validate_*` 同口径**（50 / 120 / 200）、account 必须含 `@`、授权码拦控制
//     字符、字段聚焦（红字落到具体输入项）。
//  4. **字段错误聚合**：同字段多 issue 只取第一条。
//
// 环境：happy-dom（与同域其它 spec 同款；本文件只跑 zod，不碰 DOM —— 那行 pragma 是照抄
// 同目录 spec 的形态，不是「本文件需要 DOM」）。

import { describe, expect, it } from 'vitest';
import {
  MAIL_ACCOUNT_ACCOUNT_MAX,
  MAIL_ACCOUNT_NAME_MAX,
  MAIL_ACCOUNT_SECRET_MAX,
  mailAccountListSchema,
  mailAccountPresetSchema,
  mailAccountSchema,
  mailMetaSchema,
  makeMailAccountFormSchema,
  toMailAccountFieldErrors,
  type MailAccountFormField,
  type MailAccountFormModel,
} from '../mailAccountSchema';

/** 后端 `MailAccountOut` 的 wire 形态：**12 键，一个都不能少**（少一个 `.strict()` 就抛）。 */
const ACCOUNT = {
  id: '9000000000000902',
  version: 1,
  name: '采购部邮箱',
  preset: 'NET_EASE_163',
  preset_label: '网易 163',
  account: 'purchase@example.com',
  host: 'smtp.163.com',
  port: 465,
  tls_mode: 'WRAPPED',
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

  it('preset：入参侧仍守封闭集（用户只能选这两家）', () => {
    expect(mailAccountPresetSchema.safeParse('NET_EASE_163').success).toBe(true);
    expect(mailAccountPresetSchema.safeParse('TENCENT_QQ').success).toBe(true);
    expect(mailAccountPresetSchema.safeParse('GMAIL').success).toBe(false);
  });

  it('preset：⚠️ 出参侧放行未知字面量（后端对它是刻意降级不丢行，不是错误）', () => {
    // 后端 `MailAccountOut::from_row` 对库里未知的 preset 降级为「该行自身字面量 +
    // 空 host/port」。出参拿枚举守它 ⇒ 一行脏数据 / 后端先加一家就把**整个列表**炸成
    // parse 抛、页面空白，正是那段降级设计要避免的「以为邮箱全没了」。
    const degraded = {
      ...ACCOUNT,
      preset: 'GMAIL',
      preset_label: '',
      host: '',
      port: 0,
      tls_mode: '',
    };
    expect(mailAccountSchema.parse(degraded)).toEqual(degraded);
    // 同款降级在 meta 的选项上也要放行。
    expect(mailMetaSchema.parse({ presets: [{ ...PRESET_OPTION, value: 'GMAIL' }] })).toEqual({
      presets: [{ ...PRESET_OPTION, value: 'GMAIL' }],
    });
  });

  it('preset_label / host / tls_mode / port 是**必填键且可为空值**（未知 preset 的降级态）', () => {
    // 后端在未知 preset 时给的是「空串 / 0」，不是 null、也不是省略键 ⇒ `.min(1)` 或
    // `.nonempty()` 会把那一行拒掉，正是刚上面那条测试要放行的东西。
    for (const key of ['preset_label', 'host', 'tls_mode'] as const) {
      expect(() => mailAccountSchema.parse({ ...ACCOUNT, [key]: '' })).not.toThrow();
      const bad: Record<string, unknown> = { ...ACCOUNT };
      delete bad[key];
      expect(() => mailAccountSchema.parse(bad), `缺 ${key} 应当抛`).toThrow();
    }
    expect(() => mailAccountSchema.parse({ ...ACCOUNT, port: 0 })).not.toThrow();
    const noPort: Record<string, unknown> = { ...ACCOUNT };
    delete noPort['port'];
    expect(() => mailAccountSchema.parse(noPort)).toThrow();
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

describe('mailAccountListSchema / mailMetaSchema — 守门', () => {
  it('列表：出参是**信封对象** `{items:[…]}`（后端 `MailAccountListOut`），不是裸数组', () => {
    expect(mailAccountListSchema.parse({ items: [ACCOUNT] })).toEqual({ items: [ACCOUNT] });
    expect(mailAccountListSchema.parse({ items: [] })).toEqual({ items: [] });
    // ⚠️ 写成裸数组时**每一屏**都抛 ZodError ⇒ 列表恒空且零报错线索（用户只看到空白表）
    expect(() => mailAccountListSchema.parse([ACCOUNT])).toThrow();
    // items 不是数组即抛（信封层被改形状）
    expect(() => mailAccountListSchema.parse({ items: ACCOUNT })).toThrow();
    // 元素逐条走同款守门
    expect(() =>
      mailAccountListSchema.parse({ items: [{ ...ACCOUNT, encrypted_secret: 'AAAA' }] }),
    ).toThrow();
    // 信封多一个键即抛（.strict()，后端将来加 total 必须同步决策）
    expect(() => mailAccountListSchema.parse({ items: [ACCOUNT], total: 1 })).toThrow();
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

  it('meta 的预设选项 value 也放行未知字面量（同 account.preset：后端加一家不会炸页面）', () => {
    const next = { ...PRESET_OPTION, value: 'GMAIL', label: 'Gmail' };
    expect(mailMetaSchema.parse({ presets: [next] })).toEqual({ presets: [next] });
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

  it('account：必填、必须含 @、有上限、拦任何空白字符（与后端 validate_account 同口径）', () => {
    const schema = makeMailAccountFormSchema('edit');
    // at(n) 造一个**恰好 n 字**、含 @ 的合法账号（后端 `.chars().count()` 口径）
    const at = (n: number): string => `${'x'.repeat(n - 5)}@a.co`;
    expect(schema.safeParse({ ...base, account: '' }).success).toBe(false);
    // ⚠️ 必须含 @：后端对不含 @ 的账号（典型是照旧文案填了个 QQ 号）返 21704，而 21704 的
    // message 是给日志看的，糊到 toast 上要用户自己翻译 ⇒ 这里提前拦并给可执行提示。
    const noAt = schema.safeParse({ ...base, account: '123456789' });
    expect(noAt.success).toBe(false);
    expect(noAt.success === false && toMailAccountFieldErrors(noAt.error.issues).account).toBe(
      '请填写完整邮箱地址（如 xxx@163.com）',
    );
    // 后端是 `char::is_whitespace()`，比只拦 \r\n 宽（制表符 / 全角空格也算）
    expect(schema.safeParse({ ...base, account: 'a@b.com x@y.com' }).success).toBe(false);
    expect(schema.safeParse({ ...base, account: 'a@b.com\r\nBcc: x@y.com' }).success).toBe(false);
    // 上限 120（后端 `.chars().count()` 是**字数**不是字节数）
    expect(schema.safeParse({ ...base, account: at(MAIL_ACCOUNT_ACCOUNT_MAX) }).success).toBe(true);
    expect(schema.safeParse({ ...base, account: at(MAIL_ACCOUNT_ACCOUNT_MAX + 1) }).success).toBe(
      false,
    );
  });

  it('三个上限与后端逐字同口径（50 / 120 / 200）', () => {
    // 这三个数与后端 `service.rs` 的三个 validate_* 同源；漂了就是「浏览器过了、后端 21704
    // 拒」，而 21704 的 message 是给日志看的。改动这里必须同步改后端。
    expect([MAIL_ACCOUNT_NAME_MAX, MAIL_ACCOUNT_ACCOUNT_MAX, MAIL_ACCOUNT_SECRET_MAX]).toEqual([
      50, 120, 200,
    ]);
  });

  it('secret：拦超长与**全部控制字符**，不按某一家服务商的规则卡字符集', () => {
    const schema = makeMailAccountFormSchema('edit');
    // 163 是 16 位字母数字、QQ 16 位带横线 —— 前端按任一家的规则写死都会在录另一家时
    // 给出「格式不正确」而实际值是对的。最终判据在后端（真发信时才验）。
    expect(schema.safeParse({ ...base, secret: 'A'.repeat(MAIL_ACCOUNT_SECRET_MAX) }).success).toBe(
      true,
    );
    expect(
      schema.safeParse({ ...base, secret: 'x'.repeat(MAIL_ACCOUNT_SECRET_MAX + 1) }).success,
    ).toBe(false);
    // 后端 `char::is_control()` = Unicode Cc = U+0000..U+001F + U+007F..U+009F。
    // 只拦 \r\n 时 \0 / \x1b 会一路进到 SMTP 的 AUTH 命令行（凭据注入面）。
    for (const ctrl of ['\u0000', '\u000b', '\u001f', '\u007f', '\u009f']) {
      expect(
        schema.safeParse({ ...base, secret: `abc${ctrl}def` }).success,
        `授权码含 ${ctrl} 应当被拒`,
      ).toBe(false);
    }
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
