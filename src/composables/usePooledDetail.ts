// 通用并发限流 helper（2026-08-24 新增）。
//
// 用途：把 Promise.all(items.map(worker)) 限流到 concurrency 个并行 worker，
// 避免后端 / 网关被瞬时打爆。语义：
//   - 任一 worker 抛错 → 该位置返回 null，**不阻断**其他 worker；
//   - 全部并行结束后一并返回 (results | nulls)[]，下标与 items 一一对应；
//   - 调用方只关心"已成功的子集" / "失败的占位"。
//
// 与 useBulkPassInspection.ts 的区别：
//   - useBulkPassInspection 是 v2 批量端点（POST /parts/batch-pass-inspection）
//     的 composable 包装，并发已下放到后端顺序处理；UI 关心「成功 / 失败分类」，
//     不需要中间进度。2026-08-25 之前曾是前端 worker pool 方案（见 git log）。
//   - usePooledDetail 只关心"拉数据"（幂等 GET），失败丢弃即可；不适合做
//     副作用密集的写操作。
//
// 不抽 useBulkPassInspection 进 usePooledDetail：那边一次 round-trip 副作用
// 与"独立 GET 失败可丢弃"语义完全不同，合并会破坏弹窗的错误聚合需求。

export interface PooledOptions {
  /** 并发上限，默认 4。 */
  concurrency?: number
}

export async function runPooled<T, R>(
  items: readonly T[],
  worker: (item: T, index: number) => Promise<R>,
  opts: PooledOptions = {},
): Promise<Array<R | null>> {
  const concurrency = Math.max(1, opts.concurrency ?? 4)
  const results: Array<R | null> = new Array(items.length).fill(null)
  let cursor = 0

  async function pump(): Promise<void> {
    while (true) {
      const idx = cursor
      cursor += 1
      if (idx >= items.length) return
      try {
        results[idx] = await worker(items[idx], idx)
      } catch {
        // 与 DeliveryNoteScan.vue:362 旧行为一致：失败丢弃，下游用 null 占位
        results[idx] = null
      }
    }
  }

  const n = Math.min(concurrency, items.length)
  await Promise.all(Array.from({ length: n }, pump))
  return results
}