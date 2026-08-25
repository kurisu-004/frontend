// 2026-08-25 新增：统一 ElMessageBox.confirm 文案的薄封装 composable。
// 把 try/catch + 转 bool 的样板压到一处，view 层只关心标题/正文/按钮文案。
import { ElMessageBox } from 'element-plus'

export interface ConfirmOptions {
  confirmText?: string
  cancelText?: string
  type?: 'warning' | 'info' | 'success' | 'error'
}

/**
 * 提供一个 dangerous() 二次确认调用。
 * 返回 Promise<boolean>：true 表示用户点了确认，false 表示取消或关闭。
 */
export function useConfirm() {
  async function dangerous(
    title: string,
    message: string,
    opts: ConfirmOptions = {},
  ): Promise<boolean> {
    try {
      await ElMessageBox.confirm(message, title, {
        confirmButtonText: opts.confirmText ?? '确认',
        cancelButtonText: opts.cancelText ?? '取消',
        type: opts.type ?? 'warning',
      })
      return true
    } catch {
      return false
    }
  }

  return { dangerous }
}