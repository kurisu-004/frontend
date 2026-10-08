// views/production/queue/composables/queueListErrorMessage.ts
//
// 生产队列列表加载失败时的**文案收口**，与报工台的
// `views/production/scan/composables/scanListErrorMessage.ts` 同形：各域自持一份（域内不出域，
// 也避免一个「给 4 个域共用」的小工具把三个域的文案差异藏进参数表）。
//
// 为什么需要收口：队列看板的出参走 `queueBoardSchema` / `queueSnapshotSchema` 契约守门
// （Zod，见同目录 `productionQueueSchema.ts`），形状不符时 API 边界**故意**抛
// ZodError —— 「响亮地炸」是设计意图，不能降级成静默兜底（空看板 / 假 0 件会把契约漂移
// 藏起来）。但 `ZodError.message` 是 issues 的 JSON 文本，直接弹给车间里的人就是一坨
// 噪音，而真正的排障信息（哪个键、期望什么类型）在浏览器控制台里才有用。
// 故：**人话给现场，细节给 console**。

import { ZodError } from 'zod';

/** 契约漂移时给现场看的固定文案：不含 Zod 的 issues 结构，细节只进 console */
export const QUEUE_LIST_CONTRACT_DRIFT_TEXT = '看板数据格式异常，请截图上报';

/**
 * 把队列请求抛出的异常转成可直接展示的文案。
 *
 * 契约：
 * - `ZodError` ⇒ 固定文案 + `console.error` 打原始 error（含完整 issues）；
 * - 其它异常 ⇒ 原样返回 `e.message`，缺 message 时回落到调用点给的 `fallback`。
 *
 * 本函数**只转文案**：不吞异常、不重试、不改调用点的控制流。
 */
export function queueListErrorText(e: unknown, fallback: string): string {
  if (e instanceof ZodError) {
    console.error('[queue] 看板响应未通过 Zod 契约守门（疑似后端契约漂移）', e);
    return QUEUE_LIST_CONTRACT_DRIFT_TEXT;
  }
  return (e as Error | null | undefined)?.message ?? fallback;
}
