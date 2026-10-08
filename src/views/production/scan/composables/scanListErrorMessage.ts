// views/production/scan/composables/scanListErrorMessage.ts
//
// 报工台列表加载失败时的**文案收口**，供 4 个调用点共用：取件 / 放回 / 送检三页的
// `refresh()` 与 `HeldPartsBadge` 的 `fetchHeld()`。三页走 `ElMessage.error`，
// 徽章把文案写进抽屉内的 `errorMsg`，故本模块只负责**产出文案**，不负责弹窗。
//
// 2026-10-10：机制下沉到跨域通用的 `src/utils/contractDriftError.ts`（`views/users` 的
// 列表 / 企微绑定查询是同一种 Zod 漂移失败），本文件保留**域内口吻**（给产线看的文案 +
// 本域 console 标签）与 2 参签名 —— 4 个调用点一行未改。

import { contractDriftErrorText } from '@/utils/contractDriftError';

/** 契约漂移时给产线看的固定文案：不含 Zod 的 issues 结构，细节只进 console */
export const SCAN_LIST_CONTRACT_DRIFT_TEXT = '列表数据格式异常，请截图上报';

/**
 * 把列表请求抛出的异常转成可直接展示的文案。
 *
 * **为什么需要这个收口**：报工台两个列表端点的出参走 `scanPartListResultSchema` 契约
 * 守门（见 `src/composables/queries/schemas.ts`），形状不符时 API 边界**故意**抛
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
 * 本函数**只转文案**：不吞异常、不重试、不改调用点的控制流。是否提示、是否重试由调用点决定。
 */
export function scanListErrorText(e: unknown, fallback: string): string {
  return contractDriftErrorText(e, {
    driftText: SCAN_LIST_CONTRACT_DRIFT_TEXT,
    fallback,
    logTag: '[scan] 列表响应未通过 Zod 契约守门',
  });
}
