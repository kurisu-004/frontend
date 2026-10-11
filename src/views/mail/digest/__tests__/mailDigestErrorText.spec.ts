// src/views/mail/digest/__tests__/mailDigestErrorText.spec.ts
//
// 2026-10-14 新增：交期汇总邮件域**错误码映射表**的防漂移回归。
//
// 为什么需要这一组：本域第一版把码段写成 `215xx`，后端实查后发现 `215xx` 已被 outsource
// 发货域占用（`BIZ_OUTSOURCE_SHIPMENT_*=21501..21504`，至今在用），改用了全新的 `217xx`
// 段。前端跟着迁。**这类漂移不会自己暴露**：映射表失配时 `mailDigestErrorText` 只是
// 匹配不到、静默落到通用兜底文案，字段聚焦（`focusField`）也随之失效 —— 用户看到的是
// 一句毫无指导性的「操作失败」，而不是任何报错。于是把它钉在单测里：
//
//   1. 码值逐条钉死（`MAIL_DIGEST_ERROR_CODES` 全表深比较）—— 后端换段时本组当场红；
//   2. 五个业务码都必须映射到**非空中文文案**（键漏登记 ⇒ 红）；
//   3. 老段 `215xx` 明确**不再**命中（反向钉死，避免有人「两个段都留着」和稀泥）。
//
// 环境：默认 node（本文件不碰 DOM）。不 mock `@/utils/contractDriftError` —— 本组要验的
// 正是「命中映射表时压根不进兜底分支」。

import { describe, expect, it } from 'vitest';
import {
  MAIL_DIGEST_CONTRACT_DRIFT_TEXT,
  MAIL_DIGEST_ERROR_CODES,
  MAIL_DIGEST_ERROR_TEXT,
  mailDigestErrorText,
} from '../mailDigestErrorText';

/** 造一个带 ApiError 形态 code 的异常（`api/http.ts` 的响应拦截器抛的就是它）。 */
function apiError(code: number, message = `后端 ${code}`): Error & { code: number } {
  return Object.assign(new Error(message), { code });
}

/** 五个本域业务码（不含 OCC 的 40901）—— 任务书点名的「都要有文案」那一组。 */
const BIZ_CODES = [
  MAIL_DIGEST_ERROR_CODES.SMTP_NOT_CONFIGURED,
  MAIL_DIGEST_ERROR_CODES.SMTP_SEND_FAILED,
  MAIL_DIGEST_ERROR_CODES.INVALID_RECIPIENT,
  MAIL_DIGEST_ERROR_CODES.INVALID_FREQUENCY_COMBO,
  MAIL_DIGEST_ERROR_CODES.CONFIG_NOT_FOUND,
] as const;

/** 非 ASCII（中文 / 英文标点）占比 = 0 即「纯数字」，那种文案对用户毫无意义。 */
function hasChinese(s: string): boolean {
  return /[\u4e00-\u9fa5]/.test(s);
}

describe('MAIL_DIGEST_ERROR_CODES：码值逐条钉死', () => {
  it('全表深比较（键名与码值同时被钉住，增删改任一都会红）', () => {
    expect({ ...MAIL_DIGEST_ERROR_CODES }).toEqual({
      // 2026-10-14：整段从 215xx 迁到 217xx（215xx 已被后端 outsource 发货域占用）
      VERSION_CONFLICT: 40901,
      SMTP_NOT_CONFIGURED: 21701,
      SMTP_SEND_FAILED: 21702,
      INVALID_RECIPIENT: 21703,
      INVALID_FREQUENCY_COMBO: 21704,
      CONFIG_NOT_FOUND: 21705,
    });
  });

  it('五个业务码互不重复（撞码会让两条错误共用一句文案）', () => {
    expect(new Set(BIZ_CODES).size).toBe(BIZ_CODES.length);
  });

  it('业务码与 OCC 段（4xxxx）不相交', () => {
    // OCC 走 4xxxx HTTP 语义段、业务码走 2xxxx 业务段，两段不得互串
    for (const code of BIZ_CODES) {
      expect(Math.floor(code / 10000)).toBe(2);
    }
    expect(Math.floor(MAIL_DIGEST_ERROR_CODES.VERSION_CONFLICT / 10000)).toBe(4);
  });
});

describe('MAIL_DIGEST_ERROR_TEXT：五个业务码都有非空中文文案', () => {
  it.each(BIZ_CODES)('%i 已登记且文案非空含中文', (code) => {
    const text = MAIL_DIGEST_ERROR_TEXT[code];
    expect(text).toBeTypeOf('string');
    expect((text ?? '').trim()).not.toBe('');
    expect(hasChinese(text ?? '')).toBe(true);
  });

  it('映射表的键集合与常量表一致（不多不少）', () => {
    expect(Object.keys(MAIL_DIGEST_ERROR_TEXT).sort()).toEqual(
      Object.values(MAIL_DIGEST_ERROR_CODES).map(String).sort(),
    );
  });

  it('文案互不重复（撞文案等于没写文案）', () => {
    const texts = Object.values(MAIL_DIGEST_ERROR_TEXT);
    expect(new Set(texts).size).toBe(texts.length);
  });
});

describe('mailDigestErrorText：命中与兜底', () => {
  it.each(BIZ_CODES)('%i 命中映射表、不落兜底文案', (code) => {
    const text = mailDigestErrorText(apiError(code), '操作失败');
    expect(text).toBe(MAIL_DIGEST_ERROR_TEXT[code]);
    expect(text).not.toBe('操作失败');
  });

  it('40901 也登记了（store 走自己的 warning 分支，表里这条服务于直接问本函数的调用方）', () => {
    expect(MAIL_DIGEST_ERROR_TEXT[MAIL_DIGEST_ERROR_CODES.VERSION_CONFLICT]).toBeTruthy();
  });

  // 反向钉死：老段 215xx 曾是本域的错误码，现已全部作废。若这里将来命中了，
  // 说明有人把两段都留着 —— 那会让「后端到底发的是哪一段」重新变成不确定的。
  it('老段 215xx 一律不再命中（`MAIL_DIGEST_ERROR_TEXT` 里查无此键）', () => {
    for (const legacy of [21501, 21502, 21503, 21504, 21505]) {
      expect(MAIL_DIGEST_ERROR_TEXT[legacy]).toBeUndefined();
    }
  });

  it('未登记的码落 `contractDriftErrorText` 的 message 分支（不是 ZodError ⇒ 不返漂移文案）', () => {
    const text = mailDigestErrorText(apiError(29999, '后端原始 message'), '操作失败');
    expect(text).toBe('后端原始 message');
    expect(text).not.toBe(MAIL_DIGEST_CONTRACT_DRIFT_TEXT);
  });

  it('异常**没有** message 时才回落调用方给的 fallback', () => {
    // 兜底的真实路径是「异常对象上没有 message」（网络层抛的裸对象、自造的 test double），
    // 不是一个带空 message 的 Error。形参签名是 `unknown`，直接传裸对象字面量即可
    // （写成 `{} as Error` 会被 `consistent-type-assertions` 判红）。
    expect(mailDigestErrorText({}, '操作失败')).toBe('操作失败');
  });

  it('⚠️ message 是空串时**逐字透传**、不回落 fallback（utils/contractDriftError 的既定契约）', () => {
    // 这条看着反直觉，但它不是本域的行为、不能由本域「顺手修」：`contractDriftError`
    // 刻意与调用点裸写的 `(e as Error).message ?? fallback` 保持一致（见该文件 doc）。
    // 钉在这里是为了让后人知道兜底空文案的那一格到底归谁 —— 本域改它就是改了跨域通用工具。
    expect(mailDigestErrorText(new Error(''), '操作失败')).toBe('');
  });

  it('e 为 null / undefined 不抛（多一层可选链，直接把异常吞成 fallback）', () => {
    expect(mailDigestErrorText(null, '操作失败')).toBe('操作失败');
    expect(mailDigestErrorText(undefined, '操作失败')).toBe('操作失败');
  });
});
