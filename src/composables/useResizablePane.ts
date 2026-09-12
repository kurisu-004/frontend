// src/composables/useResizablePane.ts
//
// 2026-09-12 新增：三栏 splitter 大小持久化（CLAUDE.md 配套：替换硬编码 CSS flex）。
// 注意：此处的「单例」语义是 per-key —— 每个 storageKey 对应独立的 ref trio，
// 避免同页多 splitter 互相覆盖。多次调用 useResizablePane('same_key', ...) 各自
// 持有自己的 ref；但读 / 写同一 localStorage key 时仍能共享。
//
// 启动时优先从 localStorage 读；不存在则用 defaults。
// resize-end → 把 {left, center, right}（px → percent）写回 localStorage（try/catch 兜底）。
//
// EP 的 el-splitter @resize-end 事件签名是 (index: number, sizes: number[])：
// sizes 是各 panel 的像素宽度（不是百分比），所以持久化前要把 px 转 percent，
// 恢复时再从 percent 转回 px 字符串传给 :size。

import { ref, type Ref } from 'vue'

export interface PaneSize { left: number; center: number; right: number }

export interface UseResizablePaneReturn {
  leftSize: Ref<string>
  centerSize: Ref<string>
  rightSize: Ref<string>
  /** 绑定到 <el-splitter @resize-end="onResizeEnd">。
   *  接受 EP 的 (index, sizes: number[]) 签名；sizes 是 px。 */
  onResizeEnd: (index: number, sizes: number[]) => void
}

export function useResizablePane(
  storageKey: string,
  defaults: PaneSize,
): UseResizablePaneReturn {
  const stored = readStored(storageKey)
  const initial = stored ?? defaults

  const leftSize = ref<string>(`${initial.left}%`)
  const centerSize = ref<string>(`${initial.center}%`)
  const rightSize = ref<string>(`${initial.right}%`)

  function onResizeEnd(_index: number, sizes: number[]): void {
    if (!Array.isArray(sizes) || sizes.length !== 3) return
    const total = sizes[0] + sizes[1] + sizes[2]
    if (total <= 0) return
    const next: PaneSize = {
      left: Math.round((sizes[0] / total) * 1000) / 10,
      center: Math.round((sizes[1] / total) * 1000) / 10,
      right: Math.round((sizes[2] / total) * 1000) / 10,
    }
    writeStored(storageKey, next)
    // 同步本地 ref：刷新页面 / 切路由后 useResizablePane 会再读 localStorage，
    // 但在内存里也更新一下，避免 splitter 内部 px 与 prop :size 短期不一致。
    leftSize.value = `${next.left}%`
    centerSize.value = `${next.center}%`
    rightSize.value = `${next.right}%`
  }

  return { leftSize, centerSize, rightSize, onResizeEnd }
}

function readStored(key: string): PaneSize | null {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const v = JSON.parse(raw) as Partial<PaneSize> | null
    if (
      v
      && typeof v.left === 'number'
      && typeof v.center === 'number'
      && typeof v.right === 'number'
    ) {
      return { left: v.left, center: v.center, right: v.right }
    }
  } catch {
    /* ignore */
  }
  return null
}

function writeStored(key: string, v: PaneSize): void {
  try {
    localStorage.setItem(key, JSON.stringify(v))
  } catch {
    /* quota exceeded → ignore */
  }
}
