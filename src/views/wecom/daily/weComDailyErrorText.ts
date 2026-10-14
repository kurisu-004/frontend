// src/views/wecom/daily/weComDailyErrorText.ts
//
// 2026-10-17 新建：企业微信**每日总结**域的**文案收口**，三个消费方共用 —— 三条读端点的
// error 桥接（`composables/useWeComDailyQuery.ts`）、页面级 store 的统一写错误入口
// （`composables/useWeComDailyStore.ts::handleWriteError`）、以及 `WeComLogTable.vue` 里失败行
// 的错误列。
//
// 两层结构，与 `views/mail/digest/mailDigestErrorText.ts` 同款分工：
//   - 本文件是**域内口吻**：四个业务错误码各配一句「用户该做什么」的话；
//   - 机制（识别 ZodError + console.error + fallback）是跨域的，在
//     `src/utils/contractDriftError.ts`。
// 改文案只改本文件一处。
//
// ⚠️ **webhook 域的四条码（21803 / 21806 / 21807 / 21808）不归本文件**：那些码由
//   `/cron/wecom/webhooks` 的端点抛出。按「谁抛的码归谁」分更耐改版 —— 反过来，本页的
//   `webhook_id` 指向 webhook 域的行，写端点被拒时抛的是 **webhook 域的码**（比如「选中的
//   通道已被删除」= 21806），所以 `weComDailyErrorText()` 在查完本域那张表之后**还要再查
//   webhook 域那张表**（照 `mailDigestErrorText` 查 `MAIL_ACCOUNT_ERROR_TEXT` 的同款做法）：
//   只查本域表的话，用户点保存看到的是一句兜底的「保存失败」，完全不知道「你选的那条通道
//   已经不在了」。
//
// ⚠️ **裸码值只许出现在 `views/wecom/webhooks/weComWebhookErrorText.ts`、
//   本文件与它们各自的 spec 里**（钉死映射表的回归用例）。

import { contractDriftErrorText } from '@/utils/contractDriftError';
import { WECOM_WEBHOOK_ERROR_TEXT } from '@/views/wecom/webhooks/weComWebhookErrorText';

/** 契约漂移时给管理员看的固定文案：不含 Zod 的 issues 结构，细节只进 console。 */
export const WECOM_DAILY_CONTRACT_DRIFT_TEXT = '服务端返回的数据格式不符合预期，请联系管理员';

/** 2026-10-17 冻结的错误码（后端 scheduled_task 域 wecom-daily 子域），**全仓前端唯一一处
 * 码值来源**。webhook 子域的四个码在 `views/wecom/webhooks/weComWebhookErrorText.ts`，
 * **同一 218xx 段**（本域占 21801 / 21802 / 21804 / 21805，webhook 域占 21803 / 21806..08），
 *  改段号时两边要一起看。
 *
 *  **单一来源约定**（改后端码段时本仓只改这两处）：
 *   - 映射表（下方 `WECOM_DAILY_ERROR_TEXT`）用**具名键**索引，不用裸数字；
 *   - store 的错误分流（`useWeComDailyStore.ts::handleWriteError`）引常量；
 *   - 单测的 `apiError(…)` 实参引常量；
 *   - 其余注释 / JSDoc 里提到码值的地方一律引常量名。 */
export const WECOM_DAILY_ERROR_CODES = {
  /** OCC 版本冲突：配置已被他人改动。**通用段非本域专有**（40901 全仓共用）。 */
  VERSION_CONFLICT: 40901,
  /** 没有可用的推送通道（`webhook_id` 为空，或指向的行已被软删）。 */
  NOT_CONFIGURED: 21801,
  /** 推送失败（webhook 地址失效 / 机器人已被移出群 / 网络）。 */
  SEND_FAILED: 21802,
  /** 频率与配套字段 / 数值组合非法。 */
  CONFIG_INVALID: 21804,
  /** 配置不存在。 */
  CONFIG_NOT_FOUND: 21805,
} as const;

/** 业务码 → 人话。**逐条对应上表的四个域内码**（后端 message 是给日志看的，统一
 * 「操作失败：xxx」对操作员没有指导性）。
 *
 * ⚠️ 40901 也在表里，但它**不走本函数** —— store 的 `handleWriteError` 单独分支：提示语是
 * warning 而非 error，且必须顺带重拉配置（照 `useMailDigestStore.ts` 的同款处置）。
 *
 * ⚠️ **21802 的文案刻意不替后端猜原因**：前端不知道这次失败到底是「地址失效」「机器人被移出
 * 群」还是「超时」，凭 wire 上的某个派生字段去猜就会有一半是错的。给一句**可执行的下一步**
 * 就够 —— 让管理员自己去验通道是否还有效（必要时去 webhook 配置页测连通）。 */
export const WECOM_DAILY_ERROR_TEXT: Partial<Record<number, string>> = {
  [WECOM_DAILY_ERROR_CODES.VERSION_CONFLICT]: '配置已被他人修改，请刷新后重试',
  [WECOM_DAILY_ERROR_CODES.NOT_CONFIGURED]:
    '没有可用的推送通道，请到「企业微信 → Webhook 配置」新增一条并在本页选择它',
  [WECOM_DAILY_ERROR_CODES.SEND_FAILED]:
    '企业微信推送失败，请检查 webhook 是否仍有效（机器人是否已被移出群）',
  [WECOM_DAILY_ERROR_CODES.CONFIG_INVALID]:
    '推送配置组合不合法，请检查频率 / 触发时刻 / 内容开关 / 人数与分片上限',
  [WECOM_DAILY_ERROR_CODES.CONFIG_NOT_FOUND]: '配置不存在，请刷新后重试',
};

/**
 * 把本域请求抛出的异常转成可直接展示的文案（供 `ElMessage` toast 或表格内文本）。
 *
 * 分流顺序（顺序有讲究）：
 *   1. 命中本域码表 ⇒ 返表里的人话；
 *   2. 本域表查不到时**再查 webhook 域那张表**（21803 / 21806 / 21807 / 21808）—— 本页的
 *      `webhook_id` 指向 webhook 域的行，「保存 / 立即发送」被拒时可能抛的是那边的码
 *      （典型：选中的通道已被别人删掉 = 21806）；
 *   3. 其余异常交给 `contractDriftErrorText` —— 它负责识别 ZodError（契约漂移，给固定
 *      文案 + console.error 原始 issues）与普通 Error（返 `e.message`，缺 message 时回落
 *      `fallback`）。
 */
export function weComDailyErrorText(e: unknown, fallback: string): string {
  const code = (e as { code?: number } | null | undefined)?.code;
  if (typeof code === 'number') {
    const mapped = WECOM_DAILY_ERROR_TEXT[code] ?? WECOM_WEBHOOK_ERROR_TEXT[code];
    if (mapped) return mapped;
  }
  return contractDriftErrorText(e, {
    driftText: WECOM_DAILY_CONTRACT_DRIFT_TEXT,
    fallback,
    logTag: '[wecom-daily] 响应未通过 Zod 契约守门',
  });
}
