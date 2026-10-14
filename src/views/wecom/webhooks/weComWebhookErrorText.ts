// src/views/wecom/webhooks/weComWebhookErrorText.ts
//
// 2026-10-17 新建：企业微信 **webhook 通道**域的**文案收口**，两个消费方共用 —— 读端点的
// error 桥接（`composables/useWeComWebhooksQuery.ts`）与页面级 store 的统一写错误入口
// （`composables/useWeComWebhooksStore.ts::handleWriteError`）。
//
// 两层结构，与 `views/mail/accounts/mailAccountErrorText.ts` 同款分工：
//   - 本文件是**域内口吻**：四个业务错误码各配一句「用户该做什么」的话；
//   - 机制（识别 ZodError + console.error + fallback）是跨域的，在
//     `src/utils/contractDriftError.ts`。
// 改文案只改本文件一处。
//
// ⚠️ **为什么每日总结的四条码（21801 / 21802 / 21804 / 21805）不归本文件**：那些码由
//   **wecom-daily 域**的端点抛出，不由任何 `/cron/wecom/webhooks` 端点抛出。按「谁抛的码归
//   谁」分，比按「哪个页面会显示」分更耐改版 —— 反过来，每日总结页也会显示 webhook 域的码
//   （它的 `webhook_id` 指向 webhook 域的行，写端点被拒时抛的是 webhook 域的码），那由
//   **每日总结页的错误桥接**决定查哪张表（见 `views/wecom/daily/weComDailyErrorText.ts`）。
//
// ⚠️ **裸码值只许出现在本文件与 `weComWebhookErrorText.spec.ts` 两处**（钉死映射表的回归用例，
//   它就是要让「码值变了」红起来的那一处）。

import { contractDriftErrorText } from '@/utils/contractDriftError';

/** 契约漂移时给管理员看的固定文案：不含 Zod 的 issues 结构，细节只进 console。 */
export const WECOM_WEBHOOK_CONTRACT_DRIFT_TEXT = '服务端返回的数据格式不符合预期，请联系管理员';

/** 2026-10-17 冻结的错误码（后端 scheduled_task 域 wecom 子域），**全仓前端唯一一处码值
 * 来源**（每日总结那四个码在 `views/wecom/daily/weComDailyErrorText.ts`，同一 218xx 段）。
 *
 *  **单一来源约定**（改后端码段时本仓只改这一处）：
 *   - 映射表（下方 `WECOM_WEBHOOK_ERROR_TEXT`）用**具名键**索引，不用裸数字；
 *   - store 的错误分流（`useWeComWebhooksStore.ts::handleWriteError`）引常量；
 *   - 单测的 `apiError(…)` 实参引常量；
 *   - 其余注释 / JSDoc 里提到码值的地方一律引常量名 —— 裸数字只允许出现在本文件与它那份 spec。
 *
 *  键名与后端常量名不是逐字对应（后端 `BIZ_WECOM_WEBHOOK_URL_INVALID` ↔ 本表 `URL_INVALID`），
 *  **语义一一对应即可**，键名是前端内部标识，不参与 wire 契约。 */
export const WECOM_WEBHOOK_ERROR_CODES = {
  /** OCC 版本冲突：这一行已被他人改动。**通用段非本域专有**（mail / users 域共用同一个值）。 */
  VERSION_CONFLICT: 40901,
  /** webhook 地址格式不合法。 */
  URL_INVALID: 21803,
  /** 通道不存在（改档 / 软删 / 置默认 / 测连通的目标 id 已被别人删掉）。 */
  NOT_FOUND: 21806,
  /** 自定义名称重复（同一部署内名称唯一，便于在每日总结的选择器里区分两条同名通道）。 */
  NAME_DUPLICATE: 21807,
  /** 通道被引用禁止删除（当前被每日总结配置的 `webhook_id` 选中）。 */
  IN_USE: 21808,
} as const;

/** 业务码 → 人话。**逐条对应上表的四个域内码**（后端 message 是给日志看的，统一
 * 「操作失败：xxx」对操作员没有指导性）。
 *
 * ⚠️ 40901 也在表里，但它**不走本函数** —— store 的 `handleWriteError` 单独分支：提示语是
 * warning 而非 error，且必须顺带重拉列表（照 `useMailAccountsStore.ts` 的同款处置）。
 * 表里这一条只服务于「别的调用方直接问本函数」的场景。
 *
 * ⚠️ 21802（推送失败）**刻意不在本表**：前端**不替后端猜原因**，只给可执行的下一步
 * （「检查 webhook 是否仍有效（机器人是否已被移出群）」），而那条提示只在**每日总结页**
 * 出现（发送是每日总结的动作，webhook 列表页不推送内容）。它的归属见
 * `views/wecom/daily/weComDailyErrorText.ts`。 */
export const WECOM_WEBHOOK_ERROR_TEXT: Partial<Record<number, string>> = {
  [WECOM_WEBHOOK_ERROR_CODES.VERSION_CONFLICT]: '配置已被他人修改，请刷新后重试',
  [WECOM_WEBHOOK_ERROR_CODES.URL_INVALID]:
    'webhook 地址格式不合法，应为 https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…',
  [WECOM_WEBHOOK_ERROR_CODES.NOT_FOUND]: 'Webhook 不存在或已删除，请刷新后重试',
  [WECOM_WEBHOOK_ERROR_CODES.NAME_DUPLICATE]: 'Webhook 名称重复，请换一个',
  [WECOM_WEBHOOK_ERROR_CODES.IN_USE]: '该 Webhook 已被每日总结配置引用，不能删除',
};

/**
 * 把本域请求抛出的异常转成可直接展示的文案（供 `ElMessage` toast）。
 *
 * 分流顺序：
 *   1. 命中业务码表 ⇒ 返表里的人话（后端 message 只进日志）；
 *   2. 其余异常交给 `contractDriftErrorText` —— 它负责识别 ZodError（契约漂移，给固定
 *      文案 + console.error 原始 issues）与普通 Error（返 `e.message`，缺 message 时
 *      回落 `fallback`）。
 */
export function weComWebhookErrorText(e: unknown, fallback: string): string {
  const code = (e as { code?: number } | null | undefined)?.code;
  if (typeof code === 'number') {
    const mapped = WECOM_WEBHOOK_ERROR_TEXT[code];
    if (mapped) return mapped;
  }
  return contractDriftErrorText(e, {
    driftText: WECOM_WEBHOOK_CONTRACT_DRIFT_TEXT,
    fallback,
    logTag: '[wecom] webhook 响应未通过 Zod 契约守门',
  });
}
