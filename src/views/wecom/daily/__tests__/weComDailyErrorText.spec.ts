// src/views/wecom/daily/__tests__/weComDailyErrorText.spec.ts
//
// 2026-10-17 新建：每日总结域文案收口的单测。
//
// ⚠️ **本文件是「码值变了」的红灯处**（照 `mailDigestErrorText.spec.ts` 的同款纪律）：全仓只有
//   本文件、`weComDailyErrorText.ts` 与 webhook 那两份允许出现裸码值。
//
// 覆盖：
//   - E1：四个域内码逐条命中表里的人话；
//   - E2：码值逐条对齐后端契约（21801 / 21802 / 21804 / 21805 + 通用段 40901）；
//   - E3：**跨表兜底** —— 本域表查不到时再查 webhook 域那张表（21803 / 21806 / 21807 / 21808）。
//     这条是本域与 webhook 子域共用一个 `webhook_id` 的直接后果：选中的通道被别人删掉时抛的
//     是 21806，只查本域表的话用户看到的是一句兜底的「保存失败」。
//   - E4：ZodError → 固定漂移文案 + console.error；
//   - E5：21802 的文案**不替后端猜原因**（只给可执行的下一步）。

import { describe, expect, it, vi } from 'vitest';
import { ZodError, z } from 'zod';
import {
  WECOM_DAILY_ERROR_CODES,
  WECOM_DAILY_ERROR_TEXT,
  weComDailyErrorText,
} from '../weComDailyErrorText';
import { WECOM_WEBHOOK_ERROR_CODES } from '@/views/wecom/webhooks/weComWebhookErrorText';

function apiError(code: number, message = `后端 ${code}`): Error & { code: number } {
  return Object.assign(new Error(message), { code });
}

describe('weComDailyErrorText — 码值 ↔ 文案逐条钉死', () => {
  it('E1：四个域内码各命中一句人话', () => {
    expect(weComDailyErrorText(apiError(WECOM_DAILY_ERROR_CODES.NOT_CONFIGURED), 'x')).toBe(
      '没有可用的推送通道，请到「企业微信 → Webhook 配置」新增一条并在本页选择它',
    );
    expect(weComDailyErrorText(apiError(WECOM_DAILY_ERROR_CODES.SEND_FAILED), 'x')).toBe(
      '企业微信推送失败，请检查 webhook 是否仍有效（机器人是否已被移出群）',
    );
    expect(weComDailyErrorText(apiError(WECOM_DAILY_ERROR_CODES.CONFIG_INVALID), 'x')).toBe(
      '推送配置组合不合法，请检查频率 / 触发时刻 / 内容开关 / 人数与分片上限',
    );
    expect(weComDailyErrorText(apiError(WECOM_DAILY_ERROR_CODES.CONFIG_NOT_FOUND), 'x')).toBe(
      '配置不存在，请刷新后重试',
    );
  });

  it('E2：码值逐条对齐后端契约（21801 / 21802 / 21804 / 21805 + 通用段 40901）', () => {
    expect(WECOM_DAILY_ERROR_CODES.NOT_CONFIGURED).toBe(21801);
    expect(WECOM_DAILY_ERROR_CODES.SEND_FAILED).toBe(21802);
    expect(WECOM_DAILY_ERROR_CODES.CONFIG_INVALID).toBe(21804);
    expect(WECOM_DAILY_ERROR_CODES.CONFIG_NOT_FOUND).toBe(21805);
    expect(WECOM_DAILY_ERROR_CODES.VERSION_CONFLICT).toBe(40901);
    expect(Object.keys(WECOM_DAILY_ERROR_TEXT).sort()).toEqual(
      Object.values(WECOM_DAILY_ERROR_CODES)
        .map(String)
        .sort(),
    );
    for (const [code, text] of Object.entries(WECOM_DAILY_ERROR_TEXT)) {
      expect(text, `码 ${code} 的文案不能为空`).toBeTruthy();
    }
  });

  it('E3：本域表查不到时**再查 webhook 域那张表**（选中的通道被别人删掉 = 21806）', () => {
    expect(weComDailyErrorText(apiError(WECOM_WEBHOOK_ERROR_CODES.NOT_FOUND), '保存失败')).toBe(
      'Webhook 不存在或已删除，请刷新后重试',
    );
    expect(weComDailyErrorText(apiError(WECOM_WEBHOOK_ERROR_CODES.IN_USE), '保存失败')).toBe(
      '该 Webhook 已被每日总结配置引用，不能删除',
    );
    expect(weComDailyErrorText(apiError(WECOM_WEBHOOK_ERROR_CODES.URL_INVALID), '保存失败')).toBe(
      'webhook 地址格式不合法，应为 https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…',
    );
  });

  it('E4：两边都查不到的码 → 普通 Error 返 message、缺 message 回落 fallback', () => {
    expect(weComDailyErrorText(new Error('网络超时'), 'fallback')).toBe('网络超时');
    expect(weComDailyErrorText({}, 'fallback')).toBe('fallback');
    expect(weComDailyErrorText(null, 'fallback')).toBe('fallback');
  });

  it('E5：ZodError → 固定漂移文案 + console.error（细节只进 console）', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const zodErr = new ZodError([{ code: 'custom', path: ['chunks'], message: '缺 chunks' }]);
    expect(weComDailyErrorText(zodErr, 'fallback')).toBe('服务端返回的数据格式不符合预期，请联系管理员');
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('E6：21802 的文案**不替后端猜原因**（只给可执行的下一步，不出现具体原因断言）', () => {
    const text = weComDailyErrorText(apiError(WECOM_DAILY_ERROR_CODES.SEND_FAILED, '企业微信返回 93000 invalid webhook url'), 'x');
    // 后端那条 message 说的是「地址非法」，而前端文案说的是「去检查通道是否还有效」—— 前端
    // 只给下一步，不复述后端的具体原因（它在 wire 上可能变，而这一步永远有效）。
    expect(text).not.toContain('93000');
    expect(text).not.toContain('invalid webhook url');
  });

  it('E7：schema 的守门失败能给出漂移文案（一条真实的 ZodError 走一遍）', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const result = z.object({ chunks: z.array(z.string()) }).safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(weComDailyErrorText(result.error, 'fallback')).toBe(
        '服务端返回的数据格式不符合预期，请联系管理员',
      );
    }
    spy.mockRestore();
  });
});
