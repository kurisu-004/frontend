// 送货单详情（DeliveryNoteDetailOut）模块级缓存（2026-08-24 新增）。
//
// 用途：扫码建单页对同一 noteId 在一次会话内可能拉 5 次详情：
//   - reloadDrafts（Promise.all 内 getNote）
//   - 扫码命中 refreshDraftDetail
//   - 打开打印 openPrintNote
//   - 提交草稿 onSubmitDraft
//   - 提交弹窗 pass-success 后 onSubmitDialogPassSuccess
// 全部命中同一缓存：进入页面一次 reload 拉全，进入会话再点按钮都是缓存返回。
//
// 失效语义：
//   - mutation 后端返 DeliveryNoteDetailOut → put(noteId, detail) 直接写入
//   - 状态变更可能影响行数（add/remove/scan 命中）→ invalidate(noteId) 后下次 get 重拉
//   - note 从本地消失（submit/softDelete）→ invalidate(noteId)
//
// 不持久化：DRAFT 内容实时变化，缓存到 disk 极易脏。
// 不跨标签页：BroadcastChannel 是过度设计。

import type { DeliveryNoteDetailOut } from '@/types/deliveryNote'

/** 缓存兜底过期时间。超过该时长视为失效，下一次 get 会重拉。 */
const TTL_MS = 5 * 60 * 1000

interface CacheEntry {
  detail: DeliveryNoteDetailOut
  loadedAt: number
}

/** 已成功加载的缓存。key = noteId。 */
const cache = new Map<string, CacheEntry>()

/**
 * in-flight Promise，避免并发 reload 同一 note（与 usePartLocationTree 同模式）。
 * value 是 Promise<DeliveryNoteDetailOut | null>，null 表示 fetcher 失败被吞掉。
 */
const pending = new Map<string, Promise<DeliveryNoteDetailOut | null>>()

export function useDeliveryNoteDetailCache() {
  /**
   * 同步读缓存。命中且未过期返回 detail，否则返回 null（并清理过期 entry）。
   */
  function peek(noteId: string): DeliveryNoteDetailOut | null {
    const e = cache.get(noteId)
    if (!e) return null
    if (Date.now() - e.loadedAt > TTL_MS) {
      cache.delete(noteId)
      return null
    }
    return e.detail
  }

  /**
   * 取详情：先看缓存；未命中或过期则调 fetcher 拉新并写入。
   * fetcher 是注入的副作用函数，便于单元测试与复用（getNote /任何等价函数）。
   * 并发同 noteId 的 caller 会共享同一个 in-flight Promise。
   * fetcher 抛错 → 返回 null，pending 清理。
   */
  async function get(
    noteId: string,
    fetcher: (id: string) => Promise<DeliveryNoteDetailOut>,
  ): Promise<DeliveryNoteDetailOut | null> {
    const cached = peek(noteId)
    if (cached) return cached
    const p = pending.get(noteId)
    if (p) return p
    const task = (async () => {
      try {
        const d = await fetcher(noteId)
        cache.set(noteId, { detail: d, loadedAt: Date.now() })
        return d
      } catch {
        return null
      } finally {
        pending.delete(noteId)
      }
    })()
    pending.set(noteId, task)
    return task
  }

  /** 显式写入（mutation 后端已返新 detail 时调用，避免又调一次 fetcher）。 */
  function put(noteId: string, detail: DeliveryNoteDetailOut): void {
    cache.set(noteId, { detail, loadedAt: Date.now() })
  }

  /** 显式失效（mutation 后等待下次 get 重拉，或已知数据已 stale）。 */
  function invalidate(noteId: string): void {
    cache.delete(noteId)
    pending.delete(noteId)
  }

  /** 全部清空（页面切换或用户主动 reset 时）。 */
  function clear(): void {
    cache.clear()
    pending.clear()
  }

  return { peek, get, put, invalidate, clear }
}
