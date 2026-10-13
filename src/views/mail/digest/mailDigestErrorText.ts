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
// 2026-10-16：邮箱域的三个码（21706 / 21707 / 21708）在**本页也会出现** —— 本页的配置
// 里存着 `sender_account_id`，所以「保存 / 立即发送」可能因「那条邮箱没了（21706）」被
// 拒。它们的**码值与文案都在邮箱域那一份**（`views/mail/accounts/mailAccountErrorText.ts`，
//  见该文件头「为什么这三个码归它」），本页只**查表**不重写 —— 重写就是同一句人话的两个
// 真源，后端改码或改措辞时两处会各自漂。
import { MAIL_ACCOUNT_ERROR_TEXT } from '@/views/mail/accounts/mailAccountErrorText';

/** 契约漂移时给管理员看的固定文案：不含 Zod 的 issues 结构，细节只进 console。 */
export const MAIL_DIGEST_CONTRACT_DRIFT_TEXT = '服务端返回的数据格式不符合预期，请联系管理员';

/** 2026-10-14 冻结的错误码（后端 mail_digest 域），**全仓前端唯一一处码值来源**。
 *
 *  ⚠️ **段号是 217xx，不是 215xx**。本域第一版实现时按「215 段往后排」猜成了 215xx，
 *  后端实查后发现 **`215xx` 已被 outsource 发货域占用**
 *  （`BIZ_OUTSOURCE_SHIPMENT_NOT_FOUND=21501` / `…INVALID_TRANSITION=21502` /
 *  `…NO_OPEN=21503` / `…QUANTITY_EXCEEDS=21504`，后端 `src/shared/error.rs` 有单测钉死
 *  `== 21501`，至今在用），于是改用了全新的 217xx 段。前端整体跟着迁过来。
 *
 *  **单一来源约定**（改后端码段时本仓只改这一处）：
 *   - 映射表（下方 `MAIL_DIGEST_ERROR_TEXT`）用**具名键**索引，不用裸数字；
 *   - store 的错误分流（`useMailDigestStore.ts::handleWriteError`）引常量；
 *   - 单测的 `apiError(…)` 实参引常量；
 *   - 其余注释 / JSDoc 里提到码值的地方一律写「对齐后端 217xx」并带上常量名 ——
 *     裸数字只允许出现在本文件与 `mailDigestErrorText.spec.ts`（钉死映射表的回归用例，
 *     它就是要让「码值变了」红起来的那一处）。
 *
 *  键名与后端常量名不是逐字对应（后端 `BIZ_MAIL_RECIPIENT_INVALID` ↔ 本表
 *  `INVALID_RECIPIENT`），**语义一一对应即可**，键名是前端内部标识，不参与 wire 契约。 */
export const MAIL_DIGEST_ERROR_CODES = {
  /** OCC 版本冲突：配置已被他人改动。后端 `BIZ_VERSION_CONFLICT`，通用段非本域专有。 */
  VERSION_CONFLICT: 40901,
  /** SMTP 未配置。后端 `BIZ_MAIL_NOT_CONFIGURED`。 */
  SMTP_NOT_CONFIGURED: 21701,
  /** SMTP 发送失败。后端 `BIZ_MAIL_SEND_FAILED`。 */
  SMTP_SEND_FAILED: 21702,
  /** 收件人邮箱格式不合法。后端 `BIZ_MAIL_RECIPIENT_INVALID`。 */
  INVALID_RECIPIENT: 21703,
  /** 频率与配套字段组合非法。后端 `BIZ_MAIL_CONFIG_INVALID`。 */
  INVALID_FREQUENCY_COMBO: 21704,
  /** 配置不存在。后端 `BIZ_MAIL_CONFIG_NOT_FOUND`。 */
  CONFIG_NOT_FOUND: 21705,
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
    '没有可用的发信邮箱，请到「邮件 → 邮箱设置」新增一条邮箱账号，并在本页选择它',
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
 *   1. 命中业务码表 ⇒ 返表里的人话（后端 message 只进日志）。**本域表查不到时再看邮箱域
 *      那张表**（21706 / 21707 / 21708）—— 本页的 `sender_account_id` 指向邮箱域的行，
 *      写端点被拒时抛的是邮箱域的码；只查本域表的话，用户点保存看到的是一句兜底的
 *      「保存失败」，完全不知道「你选的那个邮箱已经不存在了」。
 *   2. 其余异常交给 `contractDriftErrorText` —— 它负责识别 ZodError（契约漂移，给固定
 *      文案 + console.error 原始 issues）与普通 Error（返 `e.message`，缺 message 时
 *      回落 `fallback`）。
 */
export function mailDigestErrorText(e: unknown, fallback: string): string {
  const code = (e as { code?: number } | null | undefined)?.code;
  if (typeof code === 'number') {
    const mapped = MAIL_DIGEST_ERROR_TEXT[code] ?? MAIL_ACCOUNT_ERROR_TEXT[code];
    if (mapped) return mapped;
  }
  return contractDriftErrorText(e, {
    driftText: MAIL_DIGEST_CONTRACT_DRIFT_TEXT,
    fallback,
    logTag: '[mail-digest] 响应未通过 Zod 契约守门',
  });
}
