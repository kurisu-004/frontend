// src/utils/contractDriftError.ts
//
// 2026-10-10 新增：Zod 契约漂移的**文案收口**（跨域通用工具）。
//
// 为什么放在 `src/utils/` 而不是某个域的 composables 目录：本模块的判据只有一个 ——
// `e instanceof ZodError`，**零域内依赖**（唯一 import 是 `zod`），且已被两个域复用
// （`views/scan` 的报工台列表、`views/users` 的账号管理与企微绑定）。
// 「多域复用 + 零域内依赖」正是 CLAUDE.md「目录归位」给 `src/utils/` 的判据；反过来把
// `views/scan/composables/scanListErrorMessage.ts` 提到 `utils/` 再让 `views/users` 引它，
// 或者把收口整体留在某一域再让另一域引，都会构成「通用工具引单域实现」或跨域依赖，
// 两条都被禁令挡着。本模块只依赖 `zod`，是这条禁令下唯一干净的落点。
//
// **为什么需要收口**：API 边界用 Zod 守门（`schema.parse`），形状不符时**故意**抛
// ZodError ——「响亮地炸」是设计意图，不能降级成静默兜底（空列表 / 假 0 件会把契约漂移
// 藏起来）。但 `ZodError.message` 是 issues 的 JSON 数组文本，直接弹给终端用户就是一坨
// 噪音，而真正的排障信息（哪个键、期望什么类型）在浏览器控制台里对开发才有价值。
// 故：**人话给用户，细节给 console**。
//
// **本模块只转文案**：不吞异常、不重试、不改调用点的控制流。是否提示、是否重试由调用点决定。
// 各域自定「漂移文案」与「console 标签」的口吻（产线说「请截图上报」、管理端说「请联系
// 管理员」），本模块只负责识别与转交。

import { ZodError } from 'zod';

export interface ContractDriftErrorOptions {
  /**
   * 命中契约漂移（ZodError）时给终端用户看的固定文案。
   * **刻意不含** Zod 的 issues 结构；细节只进 console。
   */
  driftText: string;
  /** 异常不是 ZodError、且异常对象上没有 `message` 时的兜底文案。 */
  fallback: string;
  /** `console.error` 的前缀标签，用于在控制台里按域 grep（例如 `'[scan] 列表响应…'`）。 */
  logTag: string;
}

/**
 * 把请求抛出的异常转成可直接展示的文案。
 *
 * 契约：
 * - `ZodError` ⇒ 返回 `driftText` + `console.error` 打原始 error（含完整 issues）；
 * - 其它异常 ⇒ 原样返回 `e.message`，缺 message 时回落到 `fallback`。`message` 是空串
 *   时**逐字透传**（不回落 fallback），调用点原先写的 `(e as Error).message ?? fallback`
 *   也是这个行为 —— 不改任何既有文案。
 *
 * ⚠️ 唯一与调用点裸写的一处行为差异：本函数多一层可选链，`e` 为 null / undefined 时回落
 * `fallback` 而不是抛 TypeError；对 `Error` 实例（含 axios 的 `AxiosError`）结果逐字相同。
 *
 * ⚠️ 渲染期调用要留心：命中漂移时每次求值都会 `console.error` 一次，模板里请经 `computed`
 * 缓存（见 `views/users/components/WxBindDialog.vue` 的 `errorText`）。
 */
export function contractDriftErrorText(e: unknown, options: ContractDriftErrorOptions): string {
  if (e instanceof ZodError) {
    console.error(`${options.logTag}（疑似后端契约漂移）`, e);
    return options.driftText;
  }
  return (e as Error | null | undefined)?.message ?? options.fallback;
}
