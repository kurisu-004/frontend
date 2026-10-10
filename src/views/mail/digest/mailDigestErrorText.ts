// src/views/mail/digest/mailDigestErrorText.ts
//
// 2026-10-13 新建：交期汇总邮件域的**文案收口**，三个消费方共用 —— 配置查询
// （`composables/useMailDigestQuery.ts` 的三条 query 的 error 桥接）、页面级 store
// 的统一写错误入口（`composables/useMailDigestStore.ts::handleWriteError`）、以及日志
// 表格的错误列。
//
// 两层结构，与 `views/users/usersErrorText.ts` 同款分工：
//   - 本文件是**域内口吻**：六个业务错误码各配一句「用户该做什么」的话；
//   - 机制（识别 ZodError + console.error + fallback）是跨域的，在
//     `src/utils/contractDriftError.ts`。
// 改文案只改本文件一处。

import { contractDriftErrorText } from '@/utils/contractDriftError';

/** 契约漂移时给管理员看的固定文案：不含 Zod 的 issues 结构，细节只进 console。 */
export const MAIL_DIGEST_CONTRACT_DRIFT_TEXT = '服务端返回的数据格式不符合预期，请联系管理员';

/** 2026-10-13 冻结的错误码（后端 mail_digest 域）。导出常量是为了让 store 的分流
 *  分支与单测都引用同一份字面量，不在各处复写数字。 */
export const MAIL_DIGEST_ERROR_CODES = {
  /** OCC 版本冲突：配置已被他人改动。 */
  VERSION_CONFLICT: 40901,
  /** SMTP 未配置。 */
  SMTP_NOT_CONFIGURED: 21501,
  /** SMTP 发送失败。 */
  SMTP_SEND_FAILED: 21502,
  /** 收件人邮箱格式不合法。 */
  INVALID_RECIPIENT: 21503,
  /** 频率与配套字段组合非法。 */
  INVALID_FREQUENCY_COMBO: 21504,
  /** 配置不存在。 */
  CONFIG_NOT_FOUND: 21505,
} as const;

/** 业务码 → 人话。**逐条对应上表的六个码**（后端 message 是给日志看的，统一
 * 「操作失败：xxx」对操作员没有指导性）。
 *
 * ⚠️ 40901 也在表里，但它**不走本函数** —— store 的 `handleWriteError` 单独分支：
 * 提示语是 warning 而非 error，且必须顺带重拉配置（照 `useUsersListStore.ts` 的同款
 * 处置）。表里这一条只服务于「别的调用方直接问本函数」的场景。 */
export const MAIL_DIGEST_ERROR_TEXT: Partial<Record<number, string>> = {
  [MAIL_DIGEST_ERROR_CODES.VERSION_CONFLICT]: '配置已被他人修改，请刷新后重试',
  [MAIL_DIGEST_ERROR_CODES.SMTP_NOT_CONFIGURED]:
    'SMTP 未配置（需设 MAIL_SMTP_USERNAME / MAIL_SMTP_PASSWORD / MAIL_FROM_ADDRESS）',
  [MAIL_DIGEST_ERROR_CODES.SMTP_SEND_FAILED]: '邮件发送失败，请检查 SMTP 配置与收件人地址',
  [MAIL_DIGEST_ERROR_CODES.INVALID_RECIPIENT]: '收件人邮箱格式不合法，请检查收件人列表',
  [MAIL_DIGEST_ERROR_CODES.INVALID_FREQUENCY_COMBO]:
    '发送频率与时间设置不匹配，请检查频率、触发时刻、星期 / 每月几号',
  [MAIL_DIGEST_ERROR_CODES.CONFIG_NOT_FOUND]: '配置不存在，请刷新后重试',
};

/**
 * 把本域请求抛出的异常转成可直接展示的文案（供 `ElMessage` toast 或表格内文本）。
 *
 * 分流顺序（顺序有讲究）：
 *   1. 命中业务码表 ⇒ 返表里的人话（后端 message 只进日志）；
 *   2. 其余异常交给 `contractDriftErrorText` —— 它负责识别 ZodError（契约漂移，给固定
 *      文案 + console.error 原始 issues）与普通 Error（返 `e.message`，缺 message 时
 *      回落 `fallback`）。
 */
export function mailDigestErrorText(e: unknown, fallback: string): string {
  const code = (e as { code?: number } | null | undefined)?.code;
  if (typeof code === 'number') {
    const mapped = MAIL_DIGEST_ERROR_TEXT[code];
    if (mapped) return mapped;
  }
  return contractDriftErrorText(e, {
    driftText: MAIL_DIGEST_CONTRACT_DRIFT_TEXT,
    fallback,
    logTag: '[mail-digest] 响应未通过 Zod 契约守门',
  });
}
