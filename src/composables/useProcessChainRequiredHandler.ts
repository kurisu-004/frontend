// 2026-09-16 PR-3 新增：后端 20706 BIZ_PROCESS_CHAIN_REQUIRED 错误兜底。
//
// 触发场景（后端 service `place_on_shelf` / `release_from_programming` /
// `send_to_outsource` 共三条路径）：
//   - part.process_chain_id IS NULL（即该零件尚未制定工艺链）
//   - 业务要求「下发前必须先制定工序链」，否则返 20706 (HTTP 409) + msg "请先制定工序链"
//
// 前端兜底策略：
//   - 检测到 20706 → 弹 ElMessageBox.confirm 提示「需要先制定工序链」
//   - 用户点「前往制定」→ router.push /production/process-design?part_id=XXX
//   - 让用户立即补单工艺链后再回来重试下发，避免反复失败
//
// 集成点：
//   - usePartDispatch.ts：onDispatchConfirm（单件）/ onBatchDispatchConfirm（批量）
//     两条 placeOnShelf 调用都 wrap
//   - usePartCncGroups.ts：onReleaseToShelf（releaseFromProgramming）
//   - PendingProgrammingList.vue：onReleaseConfirm（releaseFromProgramming）
//   - useOutsourceSendableList.ts：onConfirmSend + onConfirmBatchSend（sendToOutsource）
//
// 注意：part_id 由 caller 显式传入（不依赖 ApiError.payload 反查），避免
// 后端响应结构改动把这条 UI 流误伤。

import { ElMessage, ElMessageBox } from 'element-plus';
import type { ApiError } from '@/api/http';

/** 20706 BIZ_PROCESS_CHAIN_REQUIRED —— 后端 src/shared/error.rs::code 新增。 */
export const BIZ_PROCESS_CHAIN_REQUIRED = 20706;

/** 兜底是否真的命中 20706（type guard；其它业务错原样 throw 给上层）。 */
export function isProcessChainRequiredError(e: unknown): e is ApiError {
  return (
    !!e &&
    typeof e === 'object' &&
    'code' in e &&
    (e as { code: unknown }).code === BIZ_PROCESS_CHAIN_REQUIRED
  );
}

/**
 * 20706 错误兜底：弹确认框 → 用户点「前往制定」则跳工序制定页（带 part_id 深链）。
 *
 * @param e              try/catch 捕获的错误对象
 * @param partId         当前操作的 part 雪花 ID 字符串（用于 deep link）；
 *                       null/undefined → 不带 part_id，仅跳工艺制定列表
 * @param router         vue-router 实例（由 caller 注入；不直接 import 以保持纯函数）
 * @returns Promise<boolean>  true = 已处理（弹框 + 跳转 / 用户取消）；false = 非 20706，
 *                       caller 应继续原 throw / 兜底。
 */
export async function handleProcessChainRequired(
  e: unknown,
  partId: string | null | undefined,
  router: { push: (path: string) => Promise<unknown> | unknown },
): Promise<boolean> {
  if (!isProcessChainRequiredError(e)) return false;

  const message = e.message || '请先制定工序链';
  const target = partId
    ? `/production/process-design?part_id=${encodeURIComponent(partId)}`
    : '/production/process-design';

  try {
    await ElMessageBox.confirm(`${message}，是否前往工序制定页？`, '需要先制定工序链', {
      type: 'warning',
      confirmButtonText: '前往制定',
      cancelButtonText: '取消',
      closeOnClickModal: false,
      closeOnPressEscape: true,
    });
    await router.push(target);
  } catch {
    // 用户取消确认框 —— 静默 return，不弹错（caller 后续流程继续按用户的取消走）
  }
  return true;
}

/**
 * 给批量下发场景准备的助手：返回「未命中 20706 时给 caller 的回退错误消息」。
 * 20706 已弹过跳转框，caller 不需要再 toast；其它错误码走 toast 兜底。
 */
export function processChainRequiredFallbackMessage(e: unknown, partLabel: string): string | null {
  if (isProcessChainRequiredError(e)) return null;
  return `${partLabel}：${(e as { message?: string } | null)?.message ?? '未知错误'}`;
}

/** 单件场景快速调用版：检测到 20706 直接 ElMessage.warning 不弹框（用于 inline 操作）。
 *  适用场景：扫码台 RETURN / PICK_UP 等高频小屏，弹框打断手感；这里仅 toast 兜底，
 *  详细「前往制定」流程留给详情页 / 列表页的大屏路径。 */
export function quickWarnProcessChainRequired(e: unknown, fallback = '请先制定工序链'): void {
  if (isProcessChainRequiredError(e)) {
    ElMessage.warning(e.message || fallback);
  }
}
