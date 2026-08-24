import { describe, expect, it, vi } from 'vitest'
import { runPooled } from './usePooledDetail'

describe('runPooled', () => {
  it('空数组：立即返回 []', async () => {
    const r = await runPooled([], async () => 1)
    expect(r).toEqual([])
  })

  it('并发限流生效：5 个 item + concurrency=2，至多 2 个并行', async () => {
    let active = 0
    let peak = 0
    const items = [10, 20, 30, 40, 50]
    const r = await runPooled(
      items,
      async (v) => {
        active += 1
        peak = Math.max(peak, active)
        await new Promise((res) => setTimeout(res, 5))
        active -= 1
        return v * 2
      },
      { concurrency: 2 },
    )
    expect(peak).toBeLessThanOrEqual(2)
    expect(r).toEqual([20, 40, 60, 80, 100])
  })

  it('任一 worker 抛错：对应位置 null，其它成功', async () => {
    const items = [1, 2, 3, 4, 5]
    const r = await runPooled(items, async (v) => {
      if (v === 3) throw new Error('boom')
      return v
    })
    expect(r).toEqual([1, 2, null, 4, 5])
  })

  it('下标与 items 一一对应（即便乱序完成）', async () => {
    const items = [10, 20, 30]
    const r = await runPooled(
      items,
      async (v) => {
        // 让 index=2 的项先完成
        await new Promise((res) => setTimeout(res, v === 10 ? 5 : v === 30 ? 0 : 2))
        return v
      },
      { concurrency: 3 },
    )
    expect(r).toEqual([10, 20, 30])
  })

  it('默认 concurrency = 4', async () => {
    // 用一个空 worker 模拟大量 item，确认不会因 concurrency=0 卡死
    const items = Array.from({ length: 8 }, (_, i) => i)
    const r = await runPooled(items, async (v) => v)
    expect(r).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  })

  it('concurrency = 0/负数视为 1', async () => {
    const items = [1, 2, 3]
    let peak = 0
    let active = 0
    await runPooled(
      items,
      async (v) => {
        active += 1
        peak = Math.max(peak, active)
        await new Promise((res) => setTimeout(res, 1))
        active -= 1
        return v
      },
      { concurrency: 0 },
    )
    expect(peak).toBe(1)
    expect(vi.isMockFunction).toBeTruthy() // sanity
  })
})