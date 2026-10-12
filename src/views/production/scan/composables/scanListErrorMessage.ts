// views/production/scan/composables/scanListErrorMessage.ts
//
// 报工台**响应未通过 Zod 守门**时的**文案收口**，供两个调用域共用：① 三页（取件 /
// 放回 / 送检）的 `refresh()` 与 `HeldPartsBadge` 的 `fetchHeld()`，② 扫码找件诊断弹窗
// `LocateDialog` 的查询失败态。前者走 `ElMessage.error`，徽章把文案写进抽屉内的
// `errorMsg`，诊断弹窗把文案渲染在弹窗内的红字区，故本模块只负责**产出文案**。
//
// 2026-10-10：机制下沉到跨域通用的 `src/utils/contractDriftError.ts`（`views/users` 的
// 列表 / 企微绑定查询是同一种 Zod 漂移失败），本文件保留**域内口吻**（给产线看的文案 +
// 本域 console 标签）与 2 参签名 —— 4 个列表调用点一行未改。
//
// 2026-10-15：新增第三个可选参数 `driftText`。诊断弹窗**不是列表**，沿用「列表数据格式
// 异常」会把工人指去查一个他没在看的界面；两个域的收口机制（人话给工人、完整 issues
// 给 console）完全相同，只是那句「什么格式错了」的口吻要分开。

import { contractDriftErrorText } from '@/utils/contractDriftError';

/** 契约漂移时给产线看的固定文案：不含 Zod 的 issues 结构，细节只进 console */
export const SCAN_LIST_CONTRACT_DRIFT_TEXT = '列表数据格式异常，请截图上报';

/** 同款漂移，但发生在扫码找件**诊断**结果上（不是列表）：文案不得说「列表」。 */
export const SCAN_LOCATE_CONTRACT_DRIFT_TEXT = '诊断数据格式异常，请截图上报';

/**
 * 把请求抛出的异常转成可直接展示的文案。
 *
 * **为什么需要这个收口**：报工台两个列表端点与扫码找件诊断端点的出参都走 Zod 契约
 * 守门（见 `./scanSchema.ts`），形状不符时在 queryFn **故意**抛
 * ZodError ——「响亮地炸」是设计意图，不能降级成静默兜底（空列表 / 假 0 件会把契约漂移
 * 藏起来）。但 `ZodError.message` 是 issues 的 JSON 数组文本，直接弹给产线工人就是一坨
 * 噪音，而真正的排障信息（哪个键、期望什么类型）在浏览器控制台里对开发才是有用的。
 * 故：**人话给工人，细节给 console**。
 *
 * 契约（与 `contractDriftErrorText` 逐条一致，本文件只注入域内口吻）：
 * - `ZodError` ⇒ 固定文案 + `console.error` 打原始 error（含完整 issues）；
 * - 其它异常 ⇒ 原样返回 `e.message`，缺 message 时回落到 `fallback`；
 * - `e` 为 null / undefined 时回落 `fallback`，不抛 TypeError。
 *
 * @param e          请求抛出的异常（`ZodError` / `ApiError` / 普通 Error / 未知值）
 * @param fallback   非漂移失败、且异常读不出 message 时的人话兜底
 * @param driftText  漂移时那句「什么格式错了」；缺省用列表口吻（四个列表调用点零改动）
 *
 * 本函数**只转文案**：不吞异常、不重试、不改调用点的控制流。是否提示、是否重试由调用点决定。
 */
export function scanListErrorText(e: unknown, fallback: string, driftText?: string): string {
  return contractDriftErrorText(e, {
    driftText: driftText ?? SCAN_LIST_CONTRACT_DRIFT_TEXT,
    fallback,
    logTag: '[scan] 列表响应未通过 Zod 契约守门',
  });
}
