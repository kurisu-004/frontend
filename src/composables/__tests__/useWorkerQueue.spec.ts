import { describe, it, expect, beforeEach, vi } from 'vitest'

describe('useWorkerQueue', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('loadBoard populates workers / processPools / workerHeld', async () => {
    const { useWorkerQueue } = await import('../useWorkerQueue')
    const q = useWorkerQueue()
    await q.loadBoard()
    expect(q.workers.value).toHaveLength(3)
    expect(q.processPools.value).toHaveLength(2)
    expect(q.processPools.value[0]!.batches).toHaveLength(2)
    expect(q.workerHeld.value['1900000000001']).toHaveLength(1)
    expect(q.workerHeld.value['1900000000003']).toHaveLength(2)
    expect(q.loading.value).toBe(false)
  })

  it('moveBatchToWorker 乐观移动：从 pool 减一、目标 worker 加一', async () => {
    const { useWorkerQueue } = await import('../useWorkerQueue')
    const q = useWorkerQueue()
    await q.loadBoard()
    const pool = q.processPools.value[0]!
    const beforePool = pool.batches.length
    const targetWorker = q.workers.value.find((w) => w.id === '1900000000002')!
    const beforeHeld = targetWorker.current_held

    const ok = await q.moveBatchToWorker(
      '3000000000001',
      '1900000000002',
      '5000000000001',
      '2000000000001',
    )

    expect(ok).toBe(true)
    expect(pool.batches).toHaveLength(beforePool - 1)
    expect(q.workerHeld.value['1900000000002']).toHaveLength(1)
    expect(q.workerHeld.value['1900000000002']![0]!.batch_id).toBe('3000000000001')
    expect(targetWorker.current_held).toBe(beforeHeld + 1)
    expect(targetWorker.capacity_remaining).toBe(targetWorker.max_held - targetWorker.current_held)
  })

  it('moveBatchToWorker 拒绝：目标 worker capacity 已满', async () => {
    const { useWorkerQueue } = await import('../useWorkerQueue')
    const q = useWorkerQueue()
    await q.loadBoard()
    // '1900000000003' 王五 capacity_remaining = 0
    const ok = await q.moveBatchToWorker(
      '3000000000001',
      '1900000000003',
      '5000000000001',
      '2000000000001',
    )
    expect(ok).toBe(false)
    expect(q.error.value).toContain('持有已满')
    // 状态未变更
    expect(q.processPools.value[0]!.batches).toHaveLength(2)
  })

  it('moveBatchToPool 乐观撤回：worker 减一、目标 pool 加一', async () => {
    const { useWorkerQueue } = await import('../useWorkerQueue')
    const q = useWorkerQueue()
    await q.loadBoard()
    const before = q.processPools.value[1]!.batches.length
    const ok = await q.moveBatchToPool(
      '3000000000010',
      '1900000000001',
      '5000000000001',
      '2000000000002',
    )
    expect(ok).toBe(true)
    expect(q.workerHeld.value['1900000000001']).toHaveLength(0)
    expect(q.processPools.value[1]!.batches).toHaveLength(before + 1)
  })

  it('API 失败回滚', async () => {
    const { useWorkerQueue } = await import('../useWorkerQueue')
    const q = useWorkerQueue()
    await q.loadBoard()
    const before = q.processPools.value[0]!.batches.length
    // 调用不存在的 batch
    const ok = await q.moveBatchToWorker(
      '9999999999999',
      '1900000000002',
      '5000000000001',
      '2000000000001',
    )
    expect(ok).toBe(false)
    expect(q.processPools.value[0]!.batches).toHaveLength(before)
    expect(q.workerHeld.value['1900000000002']).toEqual([])
  })

  // 2026-08-26 新增：覆盖 WorkerQueueBoard 的 capability 过滤逻辑。
  // 模拟 page 端 filteredWorkers = workers.filter(w => w.process_ids.includes(activeTab))
  it('filteredWorkers：activeTab=2000000000001 命中 W001/W002（不命中 W003）', async () => {
    const { useWorkerQueue } = await import('../useWorkerQueue')
    const q = useWorkerQueue()
    await q.loadBoard()
    const activeTab = '2000000000001'
    const filtered = q.workers.value.filter((w) => w.process_ids.includes(activeTab))
    expect(filtered.map((w) => w.id)).toEqual(['1900000000001', '1900000000002'])
  })

  it('filteredWorkers：activeTab=2000000000002 只命中 W003', async () => {
    const { useWorkerQueue } = await import('../useWorkerQueue')
    const q = useWorkerQueue()
    await q.loadBoard()
    const activeTab = '2000000000002'
    const filtered = q.workers.value.filter((w) => w.process_ids.includes(activeTab))
    expect(filtered.map((w) => w.id)).toEqual(['1900000000003'])
  })

  it('filteredWorkers：activeTab=未知 process_id 返回空', async () => {
    const { useWorkerQueue } = await import('../useWorkerQueue')
    const q = useWorkerQueue()
    await q.loadBoard()
    const activeTab = '9999999999999'
    const filtered = q.workers.value.filter((w) => w.process_ids.includes(activeTab))
    expect(filtered).toEqual([])
  })
})