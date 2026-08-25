import type { Ref } from 'vue'

export interface DialogSizeOptions {
  desktopWidth?: string | number
  /** 已废弃：保留参数名以兼容调用方，但忽略值 */
  fullscreenOnMobile?: boolean
}

export interface DialogSizeResult {
  width: string | number
  top: string
  fullscreen: false
}

/**
 * 2026-08-25 重构：移除 mobile 适配后简化为静态桌面尺寸。
 * 保留函数签名（含 fullscreenOnMobile 字段）以便调用方逐步迁移。
 */
export function useDialogSize(
  options: DialogSizeOptions | Ref<DialogSizeOptions> = {},
): DialogSizeResult {
  const opts = 'value' in options ? options.value : options
  return {
    width: opts.desktopWidth ?? '600px',
    top: '15vh',
    fullscreen: false,
  }
}