// src/views/mail/accounts/__tests__/mailAccountErrorText.spec.ts
//
// 2026-10-16 新增：邮箱域文案表单测。两组：
//
//  1. **映射表钉死**（唯一允许出现裸码值的地方 —— 它的职责就是让「码值变了」红起来）；
//  2. **分流顺序**：命中码表 ⇒ 表里的人话；ZodError ⇒ 契约漂移文案 + console.error；
//    普通 Error ⇒ `e.message`；啥都没有 ⇒ fallback。
//
// ⚠️ 本域码段（21706..21708）与 mail-digest 域的（21701..21705）**同段相邻**。两组 spec
// 都用**具名常量**（`MAIL_ACCOUNT_ERROR_CODES` / `MAIL_DIGEST_ERROR_CODES`）做实参，
// 本文件唯一例外就是下面那组「钉死码值」的断言 —— 那里的裸数字是故意的。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ZodError } from 'zod';
import {
  MAIL_ACCOUNT_CONTRACT_DRIFT_TEXT,
  MAIL_ACCOUNT_ERROR_CODES,
  MAIL_ACCOUNT_ERROR_TEXT,
  mailAccountErrorText,
} from '../mailAccountErrorText';
import { mailDigestErrorText } from '@/views/mail/digest/mailDigestErrorText';
import { MAIL_DIGEST_ERROR_CODES } from '@/views/mail/digest/mailDigestErrorText';

/** 造一个带 ApiError 形态 code 的异常（`api/http.ts` 的响应拦截器抛的就是它）。 */
function apiError(code: number, message = `后端 ${code}`): Error & { code: number } {
  const e = new Error(message) as Error & { code: number };
  e.code = code;
  return e;
}

describe('MAIL_ACCOUNT_ERROR_CODES — 码值钉死', () => {
  // ⚠️ 这组是全仓前端唯一允许写裸数字的地方（映射表的回归闸门）。改成具名常量引用会让
  // 「后端换码段」变成零信号。
  it('四个码与后端逐字一致；除 21704 外与 mail-digest 域的 21701..21705 不重叠', () => {
    expect(MAIL_ACCOUNT_ERROR_CODES).toEqual({
      CONFIG_INVALID: 21704,
      ACCOUNT_NOT_FOUND: 21706,
      NAME_DUPLICATED: 21707,
      ACCOUNT_IN_USE: 21708,
    });
    // ⚠️ 21704 是**两域共用码**（后端 `BIZ_MAIL_CONFIG_INVALID`）：本域用它报「账号不是完整
    // 邮箱地址 / 授权码含控制字符 / 名称超长」，mail_digest 域用它报「频率与配套字段组合
    // 非法」。它的措辞必须两边都说得通，交期汇总页则由 digest 自己的表先命中。
    const digestCodes = Object.values(MAIL_DIGEST_ERROR_CODES);
    for (const code of Object.values(MAIL_ACCOUNT_ERROR_CODES)) {
      if (code === MAIL_ACCOUNT_ERROR_CODES.CONFIG_INVALID) continue;
      expect(digestCodes).not.toContain(code);
    }
    expect(digestCodes).toContain(MAIL_ACCOUNT_ERROR_CODES.CONFIG_INVALID);
  });

  it('映射表逐条覆盖四个码（漏一条 ⇒ 那条退回兜底文案，用户看不出发生了什么）', () => {
    for (const code of Object.values(MAIL_ACCOUNT_ERROR_CODES)) {
      expect(MAIL_ACCOUNT_ERROR_TEXT[code]).toBeTruthy();
    }
  });

  it('21708 的文案点名引用方（用户下一步是「去那条任务里换邮箱」，不告诉他去哪他只能猜）', () => {
    expect(MAIL_ACCOUNT_ERROR_TEXT[MAIL_ACCOUNT_ERROR_CODES.ACCOUNT_IN_USE]).toContain('定时任务');
  });
});

describe('mailAccountErrorText — 分流顺序', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('E1：命中码表 ⇒ 返表里的人话（后端 message 只进日志）', () => {
    const e = apiError(MAIL_ACCOUNT_ERROR_CODES.NAME_DUPLICATED, '后端原始 message');
    expect(mailAccountErrorText(e, '保存失败')).toBe(MAIL_ACCOUNT_ERROR_TEXT[21707]);
  });

  it('E2：未命中的码 ⇒ 回落普通 Error 的 message', () => {
    expect(mailAccountErrorText(apiError(49999, '网络抖动'), '保存失败')).toBe('网络抖动');
  });

  it('E3：ZodError（契约漂移）⇒ 固定文案 + console.error 原始 issues', () => {
    // 必须造一个**真的** ZodError 实例：`contractDriftErrorText` 的判据是
    // `e instanceof ZodError`（不是 `e.name === 'ZodError'`），拿普通 Error 改个 name
    // 骗过它会得到一条「测了个寂寞」的绿灯。
    let drift: ZodError | null = null;
    try {
      z.object({ id: z.string() }).parse({ version: 1 });
    } catch (e) {
      drift = e as ZodError;
    }
    expect(drift).toBeTruthy();

    expect(mailAccountErrorText(drift, '保存失败')).toBe(MAIL_ACCOUNT_CONTRACT_DRIFT_TEXT);
    expect(errorSpy).toHaveBeenCalled();
  });

  it('E4：null / undefined ⇒ fallback', () => {
    expect(mailAccountErrorText(null, '删除失败')).toBe('删除失败');
    expect(mailAccountErrorText(undefined, '删除失败')).toBe('删除失败');
  });

  it('E5：message 为**空串**时逐字透传（不回落 fallback）—— 照抄 `contractDriftErrorText` 的契约', () => {
    // `??` 只挡 null/undefined，空串是合法取值。故意钉住：哪天有人把它改成 `|| fallback`，
    // 这条会红（那会把「后端返回空 message」显示成一句本域兜底文案，掩盖真实来源）。
    expect(mailAccountErrorText(new Error(), '删除失败')).toBe('');
  });
});

describe('跨域查表：交期汇总页也能读懂邮箱域的码', () => {
  // 2026-10-16：交期汇总的配置里存着 `sender_account_id`，所以「保存 / 立即发送」可能因
  // 「那条邮箱没了」被拒（21706）。它查的是**邮箱域那张表**（不重写文案），所以下面这条
  // 守的是「跨域查表这条线真的接上了」。
  it('C1：mailDigestErrorText 对 21706 返邮箱域的人话，而不是一句兜底的「保存失败」', () => {
    const e = apiError(MAIL_ACCOUNT_ERROR_CODES.ACCOUNT_NOT_FOUND);
    expect(mailDigestErrorText(e, '保存失败')).toBe(MAIL_ACCOUNT_ERROR_TEXT[21706]);
  });

  it('C2：mail_digest 自己的码仍走自己的表（域内优先级不被跨域表抢走）', () => {
    const e = apiError(MAIL_DIGEST_ERROR_CODES.INVALID_RECIPIENT);
    expect(mailDigestErrorText(e, '保存失败')).toContain('收件人');
  });
});
