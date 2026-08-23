// composables/usePrintedLabels.ts
//
// 草稿卡片「打印标签」状态记录（2026-08-23 新增）。
//
// 背景：
//   - 草稿卡片 footer 加「打印标签」按钮；下载 XLSX 后需要在浏览器侧持久化
//     "已打印过"的 batch id，下次进入页面 / 刷新页面后仍能在表格里渲染绿底。
//   - 后端不引入新字段（用户已确认；项目 §已知安全风险 决定零后端改动），
//     完全前端 localStorage 闭环。
//
// 形态：
//   - 模块级 composable 单例（与 useBarcodeScanner / useAuthSession 同款风格，
//     详见 CLAUDE.md §状态管理）。
//   - localStorage key = 'delivery_scan_printed_labels_v1'（带 _v1 便于将来
//     形状变更时灰度切换）；内容形如
//       { [noteId: string]: { [batchId: string]: true } }
//     仅存存在即已打印，无计数 / 无时间戳。
//
// 容错：
//   - localStorage 读 / 写失败（quota exceeded、隐私模式 disabled、JSON 损坏）
//     全部静默吞掉。打印流不能因持久化失败而中断——下一轮写入会自然覆盖。
//   - store 跨组件 / 跨路由共享：同一 ref 实例 → 模板自动响应（foldBySerial
//     里 isPrintedBatch 也会自动反映最新状态）。

import { ref, type Ref } from 'vue'

const KEY = 'delivery_scan_printed_labels_v1'

/** 形状：noteId → batchId → true。 */
export type Store = Record<string, Record<string, true>>

function readStore(): Store {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Store
    }
    return {}
  } catch {
    return {}
  }
}

/** 模块级 ref，所有调用方共享同一份响应式状态。 */
const _store: Ref<Store> = ref<Store>(readStore())

function persist(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(_store.value))
  } catch {
    /* quota / 隐私模式 / disabled — 静默忽略，下次写入覆盖 */
  }
}

export function usePrintedLabels() {
  /** 跨 note 查单个 batch 是否已打印（O(n) where n = 草稿数；草稿量 < 200 可接受）。 */
  function isPrintedBatch(batchId: string): boolean {
    const map = _store.value
    for (const noteId of Object.keys(map)) {
      if (map[noteId]?.[batchId]) return true
    }
    return false
  }

  /** 单 note 内精确查：foldBySerial 用此避免遍历其他 note。 */
  function isPrintedForNote(noteId: string, batchId: string): boolean {
    return !!_store.value[noteId]?.[batchId]
  }

  /** 标记若干 batch 为已打印（下载成功后调用）。空数组 no-op。 */
  function markPrinted(noteId: string, batchIds: string[]): void {
    if (!batchIds.length) return
    const bucket = { ...(_store.value[noteId] ?? {}) }
    for (const id of batchIds) bucket[id] = true
    _store.value = { ..._store.value, [noteId]: bucket }
    persist()
  }

  /** 取消标记（移除某个 batch 时同步清理，避免脏绿底）。 */
  function unmark(noteId: string, batchIds: string[]): void {
    if (!batchIds.length) return
    const bucket = _store.value[noteId]
    if (!bucket) return
    const next = { ...bucket }
    for (const id of batchIds) delete next[id]
    if (Object.keys(next).length === 0) {
      const { [noteId]: _drop, ...rest } = _store.value
      void _drop
      _store.value = rest
    } else {
      _store.value = { ..._store.value, [noteId]: next }
    }
    persist()
  }

  return {
    isPrintedBatch,
    isPrintedForNote,
    markPrinted,
    unmark,
    store: _store,
  }
}