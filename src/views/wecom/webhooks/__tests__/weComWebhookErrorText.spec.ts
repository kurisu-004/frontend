// src/views/wecom/webhooks/__tests__/weComWebhookErrorText.spec.ts
//
// 2026-10-17 新建：webhook 通道域文案收口的单测。
//
// ⚠️ **本文件是「码值变了」的红灯处**（照 `mailAccountErrorText.spec.ts` /
//   `mailDigestErrorText.spec.ts` 的同款纪律）：全仓只有本文件与 `weComWebhookErrorText.ts`
//   允许出现裸码值。改后端码段时漏改映射表 ⇒ 这里的「码值 ↔ 文案」逐条断言当场红；
//   漏改 store 的分流分支则由 `useWeComWebhooksStore.spec.ts` 的 E 组守（那条是静默失配：
//   分支不命中时用户拿到的仍是兜底文案，功能性断言反而测不出来）。
//
// 覆盖：
//   - E1：四个域内码逐条命中表里的人话；
//   - E2：40901 在表里（走的是 store 的 warning 分支，不是本函数，但表要收）；
//   - E3：表里查不到的码 → 走 `contractDriftErrorText`（普通 Error 返 message、缺 message 回落
//     fallback）；
//   - E4：ZodError → 固定漂移文案 + console.error（人话给用户、细节给 console）；
//   - E5：裸码值守卫 —— 21801 / 21802 / 21804 / 21805（wecom-daily 域的码）**不在**本表里。

import { describe, expect, it, vi } from 'vitest';
import { ZodError, z } from 'zod';
import {
  WECOM_WEBHOOK_ERROR_CODES,
  WECOM_WEBHOOK_ERROR_TEXT,
  weComWebhookErrorText,
} from '../weComWebhookErrorText';

function apiError(code: number, message = `后端 ${code}`): Error & { code: number } {
  return Object.assign(new Error(message), { code });
}

describe('weComWebhookErrorText — 码值 ↔ 文案逐条钉死', () => {
  it('E1：四个域内码各命中一句人话', () => {
    expect(weComWebhookErrorText(apiError(WECOM_WEBHOOK_ERROR_CODES.URL_INVALID), 'x')).toBe(
      'webhook 地址格式不合法，应为 https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…',
    );
    expect(weComWebhookErrorText(apiError(WECOM_WEBHOOK_ERROR_CODES.NOT_FOUND), 'x')).toBe(
      'Webhook 不存在或已删除，请刷新后重试',
    );
    expect(weComWebhookErrorText(apiError(WECOM_WEBHOOK_ERROR_CODES.NAME_DUPLICATE), 'x')).toBe(
      'Webhook 名称重复，请换一个',
    );
    expect(weComWebhookErrorText(apiError(WECOM_WEBHOOK_ERROR_CODES.IN_USE), 'x')).toBe(
      '该 Webhook 已被每日总结配置引用，不能删除',
    );
  });

  it('E2：码值逐条对齐后端契约（21803 / 21806 / 21807 / 21808 + 通用段 40901）', () => {
    expect(WECOM_WEBHOOK_ERROR_CODES.URL_INVALID).toBe(21803);
    expect(WECOM_WEBHOOK_ERROR_CODES.NOT_FOUND).toBe(21806);
    expect(WECOM_WEBHOOK_ERROR_CODES.NAME_DUPLICATE).toBe(21807);
    expect(WECOM_WEBHOOK_ERROR_CODES.IN_USE).toBe(21808);
    expect(WECOM_WEBHOOK_ERROR_CODES.VERSION_CONFLICT).toBe(40901);
    // 映射表的键集 = 常量表的键集（不多不少）⇒ 有人加了码忘了配文案时本用例不会红，
    // 但下面那条「每个码都有非空文案」会红。
    expect(Object.keys(WECOM_WEBHOOK_ERROR_TEXT).sort()).toEqual(
      Object.values(WECOM_WEBHOOK_ERROR_CODES)
        .map(String)
        .sort(),
    );
    for (const [code, text] of Object.entries(WECOM_WEBHOOK_ERROR_TEXT)) {
      expect(text, `码 ${code} 的文案不能为空`).toBeTruthy();
    }
  });

  it('E3：表里查不到的码 → 普通 Error 返 message、缺 message 回落 fallback', () => {
    expect(weComWebhookErrorText(new Error('网络超时'), 'fallback')).toBe('网络超时');
    expect(weComWebhookErrorText({}, 'fallback')).toBe('fallback');
    expect(weComWebhookErrorText(null, 'fallback')).toBe('fallback');
    // 后端 message 只进日志，表里的人话优先（表命中时不透传后端 message）
    expect(weComWebhookErrorText(apiError(21807, 'SMTP 内部日志文案'), 'fallback')).toBe(
      'Webhook 名称重复，请换一个',
    );
  });

  it('E4：ZodError → 固定漂移文案 + console.error（细节只进 console）', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const zodErr = new ZodError([{ code: 'custom', path: ['id'], message: '缺 id' }]);
    expect(weComWebhookErrorText(zodErr, 'fallback')).toBe('服务端返回的数据格式不符合预期，请联系管理员');
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('E5：wecom-daily 域的四个码**不在**本表里（按「谁抛的码归谁」归属）', () => {
    // 21801 / 21802 / 21804 / 21805 由 /cron/wecom-daily/* 抛，文案在 weComDailyErrorText。
    for (const code of [21801, 21802, 21804, 21805]) {
      expect(WECOM_WEBHOOK_ERROR_TEXT[code], `码 ${code} 不该出现在 webhook 表里`).toBeUndefined();
    }
  });

  it('E6：schema 的守门失败能给出漂移文案（一条真实的 ZodError 走一遍）', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const result = z.object({ a: z.string() }).safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(weComWebhookErrorText(result.error, 'fallback')).toBe(
        '服务端返回的数据格式不符合预期，请联系管理员',
      );
    }
    spy.mockRestore();
  });
});
