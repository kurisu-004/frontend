import { describe, it, expect } from 'vitest'
import { listWorkers, listProcessPools, listWorkerHeld, assignBatch, returnBatch } from '../workerPool'

describe('workerPool API (mock fixtures)', () => {
  it('listWorkers returns 3 workers', async () => {
    const workers = await listWorkers()
    expect(workers).toHaveLength(3)
    expect(workers[0]!.badge_code).toBe('W001')
    expect(workers[2]!.capacity_remaining).toBe(0)
  })

  it('listProcessPools returns 2 processes', async () => {
    const pools = await listProcessPools()
    expect(pools).toHaveLength(2)
    expect(pools[0]!.process_code).toBe('CNC-01')
    expect(pools[0]!.batches).toHaveLength(2)
    expect(pools[1]!.batches).toHaveLength(1)
  })

  it('listWorkerHeld returns held batches for known worker', async () => {
    const { worker_id, held } = await listWorkerHeld('1900000000001')
    expect(worker_id).toBe('1900000000001')
    expect(held).toHaveLength(1)
    expect(held[0]!.batch_no).toBe('B2026-08-010')
  })

  it('listWorkerHeld returns empty array for worker without held', async () => {
    const { held } = await listWorkerHeld('1900000000002')
    expect(held).toEqual([])
  })

  it('assignBatch returns batch with version+1', async () => {
    const result = await assignBatch({
      worker_id: '1900000000001',
      batch_id: '3000000000001',
      shelf_id: '5000000000001',
      process_id: '2000000000001',
    })
    expect(result.batch_id).toBe('3000000000001')
    expect(result.version).toBe(2)
  })

  it('returnBatch throws on unknown batch', async () => {
    await expect(
      returnBatch({
        worker_id: '1900000000001',
        batch_id: '9999999999999',
        shelf_id: '5000000000001',
        next_process_id: '2000000000002',
      }),
    ).rejects.toThrow(/not found/)
  })
})
