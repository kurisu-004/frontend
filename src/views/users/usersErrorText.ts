// src/views/users/usersErrorText.ts
//
// 2026-10-10 新增：账号管理域的**文案收口**，三个消费方共用 —— 列表主查询
// （`useUsersQuery`）、企微绑定状态查询（`useUsersListStore`）、企微绑定对话框的
// 加载失败块（`WxBindDialog`）。三处都是「Zod 守门失败 ⇒ ZodError」的同一种失败，
// 收口机制走跨域通用的 `src/utils/contractDriftError.ts`。
//
// **域内留一层薄壳而不是直接把通用函数的 3 个参数摊到三个调用点**：漂移文案与 console
// 标签是本域的「口吻」，属于域知识，放域根（与 `usersSchema.ts` / `usersConstants.ts` 同层）；
// 机制（识别 ZodError + console.error + fallback）是跨域的，放在 `utils/`。改文案只改本文件。

import { contractDriftErrorText } from '@/utils/contractDriftError';

/** 契约漂移时给管理员看的固定文案：不含 Zod 的 issues 结构，细节只进 console。 */
export const USERS_CONTRACT_DRIFT_TEXT = '服务端返回的数据格式不符合预期，请联系管理员';

/**
 * 把本域请求抛出的异常转成可直接展示的文案（供 `ElMessage` toast 或弹窗内文本块）。
 * 参数与契约见 `src/utils/contractDriftError.ts::contractDriftErrorText`。
 */
export function usersErrorText(e: unknown, fallback: string): string {
  return contractDriftErrorText(e, {
    driftText: USERS_CONTRACT_DRIFT_TEXT,
    fallback,
    logTag: '[users] 响应未通过 Zod 契约守门',
  });
}
