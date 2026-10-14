// src/views/wecom/webhooks/__tests__/weComWebhookSchema.spec.ts
//
// 2026-10-17 新建：webhook 通道域的 Zod schema 单测。覆盖四组：
//
//  1. **键集守门**：`.strict()` 少一个键必抛、多一个键必抛。
//  2. **信封形状**：`GET /cron/wecom/webhooks` 的出参是 `{items:[…]}`，**不是裸数组** ——
//     写成 `z.array` 时症状是「每一屏都抛、列表恒空、零告警」。
//  3. **完整地址永不出参**：`url_masked` 必填、`webhook_url` 多出来必抛（这条不变量就是
//     「响亮地失败」换来的 —— 没有它，后端误把完整地址带出来时会被 Zod 默认的 strip 静默吞掉、
//     悄悄进到某个组件的 props 里）。
//  4. **表单校验**：新建（地址必填 + 格式）/ 改档（地址留空 = 不改，但填了半截仍拒）。

import { describe, expect, it } from 'vitest';
import {
  makeWeComWebhookFormSchema,
  toWeComWebhookFieldErrors,
  weComWebhookListSchema,
  weComWebhookSchema,
} from '../weComWebhookSchema';

const ROW = {
  id: '9000000000000903',
  version: 1,
  name: '生产群',
  url_masked: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=693a***faaa',
  is_default: false,
  created_at: '2026-10-17 08:00:00',
  updated_at: '2026-10-17 08:00:00',
};

const GOOD_URL = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=693a0000-1111-2222-3333-44445555ffff';

describe('weComWebhookSchema — 行（7 键，.strict()）', () => {
  it('S1：好行过守门，键集与契约逐字相等', () => {
    const parsed = weComWebhookSchema.parse(ROW);
    expect(parsed.id).toBe('9000000000000903');
    expect(Object.keys(parsed).sort()).toEqual(Object.keys(ROW).sort());
    expect(Object.keys(parsed)).toHaveLength(7);
  });

  it('S2：少一个键必抛（少 url_masked ⇒ 列表页那一列整列 undefined 且零报错）', () => {
    const { url_masked: _drop, ...noMasked } = ROW;
    expect(() => weComWebhookSchema.parse(noMasked)).toThrow();
  });

  it('S3：多一个键必抛', () => {
    expect(() => weComWebhookSchema.parse({ ...ROW, webhook_url: GOOD_URL })).toThrow();
  });

  it('S4：id 必须是 string（雪花 id 走 z.number() 会丢 19 位精度）', () => {
    expect(() => weComWebhookSchema.parse({ ...ROW, id: 9000000000000903 })).toThrow();
  });
});

describe('weComWebhookListSchema — 信封（1 键）', () => {
  it('L1：信封对象能过守门；裸数组必须抛', () => {
    expect(weComWebhookListSchema.safeParse({ items: [ROW] }).success).toBe(true);
    // ⚠️ 把 schema 写成 z.array 时症状是「每一屏都抛、列表恒空、零告警」；反过来把出参当裸
    // 数组消费则会在守门通过后拿到对象、`data.value.map is not a function`。
    expect(weComWebhookListSchema.safeParse([ROW]).success).toBe(false);
  });

  it('L2：items 不是数组必抛', () => {
    expect(weComWebhookListSchema.safeParse({ items: ROW }).success).toBe(false);
  });

  it('L3：信封多一个键必抛（后端将来加 total 时必须显式决策）', () => {
    expect(weComWebhookListSchema.safeParse({ items: [ROW], total: 1 }).success).toBe(false);
  });
});

describe('makeWeComWebhookFormSchema', () => {
  it('F1：新建态地址必填', () => {
    const parsed = makeWeComWebhookFormSchema('create').safeParse({ name: '生产群', webhook_url: '' });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(toWeComWebhookFieldErrors(parsed.error.issues).webhook_url).toBe('请填写 webhook 地址');
    }
  });

  it('F2：新建态格式不对必拦（前端提前拦 21803）', () => {
    const parsed = makeWeComWebhookFormSchema('create').safeParse({
      name: '生产群',
      webhook_url: 'https://example.com/hook',
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(toWeComWebhookFieldErrors(parsed.error.issues).webhook_url).toContain('地址格式不正确');
    }
  });

  it('F3：新建态合法值能过，且前后空格被 trim', () => {
    const parsed = makeWeComWebhookFormSchema('create').parse({
      name: '  生产群  ',
      webhook_url: `  ${GOOD_URL}  `,
    });
    expect(parsed.name).toBe('生产群');
    expect(parsed.webhook_url).toBe(GOOD_URL);
  });

  it('F4：改档态地址留空**合法**（空串 = 后端「沿用旧密文」）', () => {
    const parsed = makeWeComWebhookFormSchema('edit').safeParse({ name: '生产群', webhook_url: '' });
    expect(parsed.success).toBe(true);
  });

  it('F5：改档态「填了半截」仍被拒（否则用户以为改成功了、实际拿的还是旧密文）', () => {
    const parsed = makeWeComWebhookFormSchema('edit').safeParse({
      name: '生产群',
      webhook_url: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=',
    });
    expect(parsed.success).toBe(false);
  });

  it('F6：地址含控制字符必拒（HTTP 头注入的原料，后端也会拒，但前端先标红更省事）', () => {
    const parsed = makeWeComWebhookFormSchema('create').safeParse({
      name: '生产群',
      webhook_url: `${GOOD_URL}\nX-Evil: 1`,
    });
    expect(parsed.success).toBe(false);
  });

  it('F7：名称必填 + 超长必拒', () => {
    expect(makeWeComWebhookFormSchema('create').safeParse({ name: '  ', webhook_url: GOOD_URL }).success).toBe(false);
    expect(
      makeWeComWebhookFormSchema('create').safeParse({ name: 'x'.repeat(51), webhook_url: GOOD_URL }).success,
    ).toBe(false);
  });

  it('F8：null / undefined 的地址归一成空串（不抛 TypeError）', () => {
    const parsed = makeWeComWebhookFormSchema('edit').safeParse({
      name: '生产群',
      webhook_url: undefined,
    });
    expect(parsed.success).toBe(true);
  });
});

describe('toWeComWebhookFieldErrors', () => {
  it('T1：同字段多 issue 只取第一条', () => {
    const out = toWeComWebhookFieldErrors([
      { path: ['name'], message: '第一条' },
      { path: ['name'], message: '第二条' },
    ]);
    expect(out).toEqual({ name: '第一条' });
  });
});
