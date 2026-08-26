// 2026-08-26 新增：工人队列调度看板的共享状态（composable 模块级单例，遵循 CLAUDE.md #1）。
// 状态：workers / processPools / workerHeld / loading / error。
// 写入走乐观更新：先改本地 ref，API 失败回滚到操作前快照。

import { ref, type Ref } from 'vue'
import {
  listWorkers,
  listProcessPools,
  listWorkerHeld,
  assignBatch,
  returnBatch,
} from '@/api/workerPool'
import type { Worker, ProcessPoolView, WorkOrderCard } from '@/types/workerPool'

// 模块级单例 state
const workers = ref<Worker[]>([])
const processPools = ref<ProcessPoolView[]>([])
const workerHeld = ref<Record<string, WorkOrderCard[]>>({})
const loading = ref(false)
const error = ref<string | null>(null)

export function useWorkerQueue() {
  async function loadBoard(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      const [w, pp] = await Promise.all([listWorkers(), listProcessPools()])
      workers.value = w

      const clonedPools: ProcessPoolView[] = pp.map((p) => ({
        ...p,
        batches: p.batches.map((b) => ({ ...b })),
      }))
      processPools.value = clonedPools

      const heldMap: Record<string, WorkOrderCard[]> = {}
      await Promise.all(
        w.map(async (worker) => {
          const { held } = await listWorkerHeld(worker.id)
          heldMap[worker.id] = held.map((b) => ({ ...b }))
        }),
      )
      workerHeld.value = heldMap
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'load failed'
    } finally {
      loading.value = false
    }
  }

  // 在所有 pool + workerHeld 中查找 batch
  function locateBatch(batch_id: string): {
    pool: ProcessPoolView | null
    workerId: string | null
    idx: number
    batch: WorkOrderCard | null
  } {
    for (const p of processPools.value) {
      const idx = p.batches.findIndex((b) => b.batch_id === batch_id)
      if (idx >= 0) return { pool: p, workerId: null, idx, batch: p.batches[idx]! }
    }
    for (const [wid, list] of Object.entries(workerHeld.value)) {
      const idx = list.findIndex((b) => b.batch_id === batch_id)
      if (idx >= 0) return { pool: null, workerId: wid, idx, batch: list[idx]! }
    }
    return { pool: null, workerId: null, idx: -1, batch: null }
  }

  async function moveBatchToWorker(
    batch_id: string,
    to_worker_id: string,
    shelf_id: string,
    process_id: string,
  ): Promise<boolean> {
    const target = workers.value.find((w) => w.id === to_worker_id)
    if (!target) {
      error.value = `worker ${to_worker_id} not found`
      return false
    }
    if (target.capacity_remaining <= 0) {
      error.value = `${target.name} 持有已满（${target.current_held}/${target.max_held}）`
      return false
    }

    const loc = locateBatch(batch_id)
    if (!loc.batch) {
      error.value = `batch ${batch_id} not found`
      return false
    }

    // 乐观更新：先在本地移动
    const original = loc.batch
    const moved: WorkOrderCard = { ...original, version: original.version + 1 }
    if (loc.pool) {
      loc.pool.batches.splice(loc.idx, 1)
    } else if (loc.workerId) {
      workerHeld.value[loc.workerId]!.splice(loc.idx, 1)
    }
    const targetList = workerHeld.value[to_worker_id] ?? []
    targetList.push(moved)
    workerHeld.value[to_worker_id] = targetList
    target.current_held += 1
    target.capacity_remaining -= 1

    try {
      await assignBatch({ worker_id: to_worker_id, batch_id, shelf_id, process_id })
      return true
    } catch (e) {
      // 回滚
      if (loc.pool) {
        loc.pool.batches.splice(loc.idx, 0, original)
      } else if (loc.workerId) {
        workerHeld.value[loc.workerId]!.splice(loc.idx, 0, original)
      }
      const rollbackIdx = (workerHeld.value[to_worker_id] ?? []).findIndex(
        (b) => b.batch_id === batch_id,
      )
      if (rollbackIdx >= 0) workerHeld.value[to_worker_id]!.splice(rollbackIdx, 1)
      target.current_held -= 1
      target.capacity_remaining += 1
      error.value = e instanceof Error ? e.message : 'assign failed'
      return false
    }
  }

  async function moveBatchToPool(
    batch_id: string,
    from_worker_id: string,
    shelf_id: string,
    next_process_id: string,
  ): Promise<boolean> {
    const list = workerHeld.value[from_worker_id]
    if (!list) {
      error.value = `worker ${from_worker_id} has no held`
      return false
    }
    const idx = list.findIndex((b) => b.batch_id === batch_id)
    if (idx < 0) {
      error.value = `batch ${batch_id} not held by ${from_worker_id}`
      return false
    }
    const original = list[idx]!
    const targetPool = processPools.value.find((p) => p.process_id === next_process_id)
    if (!targetPool) {
      error.value = `process ${next_process_id} not found`
      return false
    }

    const moved: WorkOrderCard = { ...original, version: original.version + 1 }
    list.splice(idx, 1)
    targetPool.batches.push(moved)
    const worker = workers.value.find((w) => w.id === from_worker_id)
    if (worker) {
      worker.current_held -= 1
      worker.capacity_remaining += 1
    }

    try {
      await returnBatch({ worker_id: from_worker_id, batch_id, shelf_id, next_process_id })
      return true
    } catch (e) {
      // 回滚
      list.splice(idx, 0, original)
      const rollbackIdx = targetPool.batches.findIndex((b) => b.batch_id === batch_id)
      if (rollbackIdx >= 0) targetPool.batches.splice(rollbackIdx, 1)
      if (worker) {
        worker.current_held += 1
        worker.capacity_remaining -= 1
      }
      error.value = e instanceof Error ? e.message : 'return failed'
      return false
    }
  }

  return {
    workers: workers as Ref<Worker[]>,
    processPools: processPools as Ref<ProcessPoolView[]>,
    workerHeld: workerHeld as Ref<Record<string, WorkOrderCard[]>>,
    loading: loading as Ref<boolean>,
    error: error as Ref<string | null>,
    loadBoard,
    moveBatchToWorker,
    moveBatchToPool,
  }
}