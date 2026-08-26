// 2026-08-26 新增：worker-pool 域前端 API。
// 阶段一（当前）：全部走 fixtures（__fixtures__/workerPool.fixtures.ts），模拟 200ms 网络延迟。
// 阶段二（后端补齐 endpoints 后）：将每个函数体替换为 apiV2 调用，
//   endpoint 规格见 docs/api-requirements/worker-pool.md。
//
// 注意：v2 endpoint 必须用 apiV2（CLAUDE.md #2），禁止 api.post('/v2/...')。

import type { Worker, ProcessPoolView, WorkOrderCard, AssignRequest, ReturnRequest } from '@/types/workerPool'
import {
  FIXTURE_WORKERS,
  FIXTURE_PROCESS_POOLS,
  FIXTURE_HELD_BY_WORKER,
} from './__fixtures__/workerPool.fixtures'

// TODO 阶段二：import { apiV2 } from '@/api/http'

/** 模拟网络延迟 */
function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** GET /api/v2/admin/worker-pool/workers（待后端实现） */
export async function listWorkers(): Promise<Worker[]> {
  await delay(200)
  return FIXTURE_WORKERS.map((w) => ({ ...w }))
}

/** GET /api/v2/admin/worker-pool/pools（待后端实现） */
export async function listProcessPools(): Promise<ProcessPoolView[]> {
  await delay(200)
  return FIXTURE_PROCESS_POOLS.map((p) => ({
    ...p,
    batches: p.batches.map((b) => ({ ...b })),
  }))
}

/** GET /api/v2/admin/worker-pool/workers/{worker_id}/held（待后端实现） */
export async function listWorkerHeld(worker_id: string): Promise<{ worker_id: string; held: WorkOrderCard[] }> {
  await delay(200)
  const held = FIXTURE_HELD_BY_WORKER[worker_id] ?? []
  return { worker_id, held: held.map((b) => ({ ...b })) }
}

/** POST /api/v2/admin/worker-pool/assign（待后端实现）
 *  乐观返回 batch + version+1。阶段二：return (await apiV2.post<{data: WorkOrderCard}>('/admin/worker-pool/assign', req)).data.data
 */
export async function assignBatch(req: AssignRequest): Promise<WorkOrderCard> {
  await delay(300)
  const all = [
    ...FIXTURE_PROCESS_POOLS.flatMap((p) => p.batches),
    ...Object.values(FIXTURE_HELD_BY_WORKER).flat(),
  ]
  const found = all.find((b) => b.batch_id === req.batch_id)
  if (!found) throw new Error(`batch ${req.batch_id} not found`)
  return { ...found, version: found.version + 1 }
}

/** POST /api/v2/admin/worker-pool/return（待后端实现） */
export async function returnBatch(req: ReturnRequest): Promise<WorkOrderCard> {
  await delay(300)
  const all = [
    ...FIXTURE_PROCESS_POOLS.flatMap((p) => p.batches),
    ...Object.values(FIXTURE_HELD_BY_WORKER).flat(),
  ]
  const found = all.find((b) => b.batch_id === req.batch_id)
  if (!found) throw new Error(`batch ${req.batch_id} not found`)
  return { ...found, version: found.version + 1 }
}
