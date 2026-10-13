// src/views/mail/accounts/mailAccountErrorText.ts
//
// 2026-10-16 新建：邮箱账号域的**文案收口**，两个消费方共用 —— 两条读端点的 error 桥接
// （`composables/useMailAccountsQuery.ts`）与页面级 store 的统一写错误入口
// （`composables/useMailAccountsStore.ts::handleWriteError`）。
//
// 两层结构，与 `views/mail/digest/mailDigestErrorText.ts` 同款分工：
//   - 本文件是**域内口吻**：三个业务错误码各配一句「用户该做什么」的话；
//   - 机制（识别 ZodError + console.error + fallback）是跨域的，在
//     `src/utils/contractDriftError.ts`。
// 改文案只改本文件一处。
//
// ⚠️ **为什么交期汇总的三条码（21706 / 21707 / 21708）也归本文件、而不是
// `mailDigestErrorText.ts`**：这三个码由**邮箱域**的端点抛出（建档 / 改档 / 删除邮箱），
// 不由任何 mail-digest 端点抛出。反过来，mail-digest 域的码也不会出现在邮箱页面上。
// 按「谁抛的码归谁」分，比按「哪个页面会显示」分更耐改版 —— 交期汇总配置页同时能显示两
// 边的文案，那由**页面的错误桥接**决定查哪张表，不是由文案表自己的归属决定。

import { contractDriftErrorText } from '@/utils/contractDriftError';

/** 契约漂移时给管理员看的固定文案：不含 Zod 的 issues 结构，细节只进 console。 */
export const MAIL_ACCOUNT_CONTRACT_DRIFT_TEXT = '服务端返回的数据格式不符合预期，请联系管理员';

/** 2026-10-16 冻结的错误码（后端 scheduled_task 域 mail 子域），**全仓前端唯一一处码值
 *  来源**。
 *
 *  **单一来源约定**（改后端码段时本仓只改这一处）：
 *   - 映射表（下方 `MAIL_ACCOUNT_ERROR_TEXT`）用**具名键**索引，不用裸数字；
 *   - store 的错误分流（`useMailAccountsStore.ts::handleWriteError`）引常量；
 *   - 单测的 `apiError(…)` 实参引常量；
 *   - 其余注释 / JSDoc 里提到码值的地方一律引常量名 —— 裸数字只允许出现在本文件与
 *     `mailAccountErrorText.spec.ts`（钉死映射表的回归用例，它就是要让「码值变了」红起来
 *     的那一处）。
 *
 *  ⚠️ 这三个码与 `views/mail/digest/mailDigestErrorText.ts` 的六个码**同段（217xx）但不
 *  重叠** —— 后端 mail_digest 域占 21701..21705，本域从 21706 起顺延。改本域码段时顺手
 *  核一眼 `MAIL_DIGEST_ERROR_CODES` 有没有跟着挪。 */
export const MAIL_ACCOUNT_ERROR_CODES = {
  /** 账号不存在（改档 / 删除 / 设为默认的目标 id 已被别人删掉）。 */
  ACCOUNT_NOT_FOUND: 21706,
  /** 自定义名称重复（同一部署内名称唯一，便于在选择器里区分两条同名登录账号）。 */
  NAME_DUPLICATED: 21707,
  /** 账号被引用禁止删除（当前被某条定时任务的 `sender_account_id` 选中）。 */
  ACCOUNT_IN_USE: 21708,
} as const;

/** 业务码 → 人话。
 *
 *  ⚠️ 21708 的文案刻意**点名引用方**（「已被定时任务选中」）而不是笼统说「无法删除」：
 *  用户的下一步动作是「去那条定时任务里换成别的邮箱」，文案不告诉他去哪他只能猜。
 *  具体的哪一条任务由后端 message 带（进 console），不在这里硬编码。 */
export const MAIL_ACCOUNT_ERROR_TEXT: Partial<Record<number, string>> = {
  [MAIL_ACCOUNT_ERROR_CODES.ACCOUNT_NOT_FOUND]: '邮箱账号不存在，请刷新列表后重试',
  [MAIL_ACCOUNT_ERROR_CODES.NAME_DUPLICATED]: '名称已存在，请换一个名称',
  [MAIL_ACCOUNT_ERROR_CODES.ACCOUNT_IN_USE]: '该邮箱已被定时任务选中，请先在对应任务里改选其它邮箱',
};

/**
 * 把本域请求抛出的异常转成可直接展示的文案（供 `ElMessage` toast）。
 *
 * 分流顺序（顺序有讲究）：
 *   1. 命中业务码表 ⇒ 返表里的人话（后端 message 只进日志）；
 *   2. 其余异常交给 `contractDriftErrorText` —— 它负责识别 ZodError（契约漂移，给固定
 *      文案 + console.error 原始 issues）与普通 Error（返 `e.message`，缺 message 时
 *      回落 `fallback`）。
 */
export function mailAccountErrorText(e: unknown, fallback: string): string {
  const code = (e as { code?: number } | null | undefined)?.code;
  if (typeof code === 'number') {
    const mapped = MAIL_ACCOUNT_ERROR_TEXT[code];
    if (mapped) return mapped;
  }
  return contractDriftErrorText(e, {
    driftText: MAIL_ACCOUNT_CONTRACT_DRIFT_TEXT,
    fallback,
    logTag: '[mail] 邮箱账号响应未通过 Zod 契约守门',
  });
}
