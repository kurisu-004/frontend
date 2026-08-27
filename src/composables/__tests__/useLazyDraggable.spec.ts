import { describe, it, expect, beforeEach, vi } from 'vitest'
import { nextTick, ref } from 'vue'

// vi.mock 会被提升到 import 之上，工厂里不能引用普通 const（TDZ），必须用 vi.hoisted。
const { startSpy, capturedOptions } = vi.hoisted(() => ({
  startSpy: vi.fn(),
  capturedOptions: [] as Record<string, unknown>[],
}))

vi.mock('vue-draggable-plus', () => ({
  useDraggable: (_el: unknown, _list: unknown, options: Record<string, unknown>) => {
    capturedOptions.push(options)
    return {
      start: startSpy,
      pause: vi.fn(),
      resume: vi.fn(),
      destroy: vi.fn(),
      option: vi.fn(),
      save: vi.fn(),
      toArray: vi.fn(),
      closest: vi.fn(),
    }
  },
}))

import { useLazyDraggable } from '../useLazyDraggable'

beforeEach(() => {
  startSpy.mockClear()
  capturedOptions.length = 0
})

describe('useLazyDraggable', () => {
  it('强制 immediate: false，即使调用方传了 true 也覆写，其余选项原样透传', () => {
    useLazyDraggable(ref<HTMLElement | null>(null), ref<number[]>([]), {
      group: 'work-orders',
      animation: 150,
      immediate: true,
    })
    expect(capturedOptions).toHaveLength(1)
    expect(capturedOptions[0]).toMatchObject({
      group: 'work-orders',
      animation: 150,
      immediate: false,
    })
  })

  it('elRef 为 null 时不调 start()（回归守卫：此前会 new Sortable(null) 抛错）', async () => {
    useLazyDraggable(ref<HTMLElement | null>(null), ref<number[]>([]))
    await nextTick()
    expect(startSpy).not.toHaveBeenCalled()
  })

  it('elRef 由 null 转非 null 后自动 start(el)', async () => {
    const elRef = ref<HTMLElement | null>(null)
    useLazyDraggable(elRef, ref<number[]>([]))
    await nextTick()
    expect(startSpy).not.toHaveBeenCalled()

    const el = {} as HTMLElement
    elRef.value = el
    await nextTick()
    expect(startSpy).toHaveBeenCalledTimes(1)
    expect(startSpy).toHaveBeenCalledWith(el)
  })

  it('elRef 换成新节点时重绑（覆盖 el-dialog destroy-on-close 重建 tbody 的场景）', async () => {
    const elRef = ref<HTMLElement | null>(null)
    useLazyDraggable(elRef, ref<number[]>([]))

    const first = {} as HTMLElement
    elRef.value = first
    await nextTick()

    const second = {} as HTMLElement
    elRef.value = second
    await nextTick()

    expect(startSpy).toHaveBeenCalledTimes(2)
    expect(startSpy).toHaveBeenLastCalledWith(second)
  })

  it('elRef 被置回 null 时不调 start()', async () => {
    const elRef = ref<HTMLElement | null>({} as HTMLElement)
    useLazyDraggable(elRef, ref<number[]>([]))
    await nextTick()
    startSpy.mockClear()

    elRef.value = null
    await nextTick()
    expect(startSpy).not.toHaveBeenCalled()
  })
})
