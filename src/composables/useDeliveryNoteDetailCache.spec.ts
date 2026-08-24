import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDeliveryNoteDetailCache } from './useDeliveryNoteDetailCache'
import type { DeliveryNoteDetailOut } from '@/types/deliveryNote'

function fakeDetail(id: string, version = 1): DeliveryNoteDetailOut {
  // 其它字段按 DeliveryNoteDetailOut 占位（vitest 不强制类型完整）
  return {
    id,
    version,
    delivery_note_no: `DN-${id}`,
    customer_id: '1',
    status: 'DRAFT',
    part_count: 0,
    line_items: [],
    scanned_serials: [],
  } as unknown as DeliveryNoteDetailOut
}

describe('useDeliveryNoteDetailCache', () => {
  let cache: ReturnType<typeof useDeliveryNoteDetailCache>

  beforeEach(() => {
    vi.useFakeTimers()
    cache = useDeliveryNoteDetailCache()
  })

  afterEach(() => {
    cache.clear()
    vi.useRealTimers()
  })

  it('peek：未拉取返回 null', () => {
    expect(cache.peek('1')).toBeNull()
  })

  it('get：fetcher 命中缓存不调 fetcher', async () => {
    const fetcher = vi.fn(async (id: string) => fakeDetail(id))
    await cache.get('1', fetcher)
    expect(fetcher).toHaveBeenCalledTimes(1)
    await cache.get('1', fetcher)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('get：fetcher 未命中调一次，结果写入；peek 返回', async () => {
    const fetcher = vi.fn(async (id: string) => fakeDetail(id, 3))
    const d = await cache.get('1', fetcher)
    expect(d?.version).toBe(3)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(cache.peek('1')?.version).toBe(3)
  })

  it('get：并发同 noteId，fetcher 只调一次', async () => {
    let resolveFn!: (v: DeliveryNoteDetailOut) => void
    const fetcher = vi.fn(
      (id: string) =>
        new Promise<DeliveryNoteDetailOut>((res) => {
          resolveFn = res
        }),
    )
    const p1 = cache.get('1', fetcher)
    const p2 = cache.get('1', fetcher)
    resolveFn(fakeDetail('1'))
    const [a, b] = await Promise.all([p1, p2])
    expect(a).toBe(b)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('invalidate：清除缓存，下次 get 重拉', async () => {
    const fetcher = vi.fn(async (id: string) => fakeDetail(id))
    await cache.get('1', fetcher)
    expect(fetcher).toHaveBeenCalledTimes(1)
    cache.invalidate('1')
    await cache.get('1', fetcher)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('TTL 过期：5 min 后 get 重拉', async () => {
    const fetcher = vi.fn(async (id: string) => fakeDetail(id))
    await cache.get('1', fetcher)
    expect(fetcher).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(5 * 60 * 1000 + 1)
    await cache.get('1', fetcher)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('fetcher 抛错：get 返回 null，pending 清理（下次 get 会重试）', async () => {
    let n = 0
    const fetcher = vi.fn(async (_id: string) => {
      n += 1
      if (n === 1) throw new Error('boom')
      return fakeDetail('1')
    })
    const r1 = await cache.get('1', fetcher)
    expect(r1).toBeNull()
    expect(fetcher).toHaveBeenCalledTimes(1)
    const r2 = await cache.get('1', fetcher)
    expect(r2).not.toBeNull()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('put：显式写入覆盖', async () => {
    cache.put('1', fakeDetail('1', 5))
    expect(cache.peek('1')?.version).toBe(5)
    cache.put('1', fakeDetail('1', 7))
    expect(cache.peek('1')?.version).toBe(7)
  })

  it('clear：清空所有缓存', async () => {
    const fetcher = vi.fn(async (id: string) => fakeDetail(id))
    await cache.get('1', fetcher)
    await cache.get('2', fetcher)
    cache.clear()
    expect(cache.peek('1')).toBeNull()
    expect(cache.peek('2')).toBeNull()
  })
})
