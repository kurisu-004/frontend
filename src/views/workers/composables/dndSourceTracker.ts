// 2026-08-26 新增：工人队列看板跨组件拖拽的"源信息"传递（vuedraggable @start → @change.added）。
//
// 机制：vuedraggable 在 @change.added 时只能拿到 evt.added.element（目标列的卡片对象）
// 和 evt.from（源容器 DOM 节点），但拿不到"这张卡片原本属于哪个 process / worker"。
// 折中：@start 时（DOM dataset 还完整）把 batchId → sourceId 写到模块级 Map；
// @change.added 时读 + delete。
//
// 模块级单例（不是 Pinia，CLAUDE.md #1）：WorkerColumn 与 PoolDrawer 共用同一份 Map。
// 用 "w:" 前缀隔离"源 process_id"和"源 worker_id"两类条目（同 batchId 不会冲突）。

const sources = new Map<string, string>()

/** 记录卡片从某工序 pool 拖出（WorkerColumn 接收端使用）。 */
export function recordSource(batchId: string, fromProcessId: string): void {
  sources.set(batchId, fromProcessId)
}

/** 记录卡片从某 worker 列拖出（PoolDrawer 接收端使用）。 */
export function recordWorkerSource(batchId: string, fromWorkerId: string): void {
  sources.set(`w:${batchId}`, fromWorkerId)
}

/** 读 + 删：卡片从某工序 pool 拖出。WorkerColumn 在 @change.added 时调用。 */
export function consumeProcessSource(batchId: string): string | undefined {
  const v = sources.get(batchId)
  sources.delete(batchId)
  return v
}

/** 读 + 删：卡片从某 worker 列拖出。PoolDrawer 在 @change.added 时调用。 */
export function consumeWorkerSource(batchId: string): string | undefined {
  const v = sources.get(`w:${batchId}`)
  sources.delete(`w:${batchId}`)
  return v
}
