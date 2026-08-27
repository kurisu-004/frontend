import { describe, it, expect, beforeEach, vi } from 'vitest'
import { nextTick, ref, type Ref } from 'vue'
import type { UseDraggableReturn } from 'vue-draggable-plus'
import { useColumnDrag, columnIdentifier } from '../useColumnDrag'
import type { ColumnDef } from '../useColumnVisibility'

// mock useAuthSession（避免 vue-tsc 报 ref 类型错 + 隔离 localStorage key 后缀）
vi.mock('../useAuthSession', () => ({
  useAuthSession: () => ({ user: { value: { id: 'u1' } } }),
}))

// mock vue-draggable-plus 里的 useDraggable，捕获 start/destroy 调用
const startCalls: HTMLElement[] = []
const destroyed: string[] = []
vi.mock('vue-draggable-plus', async () => {
  const actual = await vi.importActual<typeof import('vue-draggable-plus')>('vue-draggable-plus')
  return {
    ...actual,
    useDraggable: <T>(_el: Ref<HTMLElement | null> | HTMLElement, _list: Ref<T[]>, opts: Record<string, unknown> & { immediate?: boolean }) => {
      const inner: UseDraggableReturn = {
        start: (el?: HTMLElement) => { if (el) startCalls.push(el) },
        pause: () => {},
        resume: () => {},
        destroy: () => { destroyed.push('called') },
        closest: () => null,
        save: () => [],
        toArray: () => [],
        option: (name: string, value?: unknown) => value,
      }
      // 模拟 immediate:false → 不自动 start
      if (opts.immediate !== false) startCalls.push(_el as HTMLElement)
      return inner
    },
  }
})

// vitest 跑在 node 环境，没有 localStorage global；用 Map 模拟一个最小子集。
const store = new Map<string, string>()
const fakeStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => {
    store.set(k, v)
  },
  removeItem: (k: string) => {
    store.delete(k)
  },
  clear: () => store.clear(),
  key: (i: number) => Array.from(store.keys())[i] ?? null,
  get length() {
    return store.size
  },
}
beforeEach(() => {
  store.clear()
  vi.stubGlobal('localStorage', fakeStorage)
})

const baseDefs: ColumnDef[] = [
  { key: 'serial', label: '序列号' },
  { key: 'unit_price', label: '单价' },
  { key: 'note', label: '备注' },
]

describe('useColumnDrag', () => {
  beforeEach(() => store.clear())

  it('默认顺序等于 defs 顺序（无持久化）', () => {
    const d = useColumnDrag(baseDefs, { listKey: 'test_a' })
    expect(d.orderedKeys.value).toEqual(['serial', 'unit_price', 'note'])
    expect(d.orderedDefs.value.map(columnIdentifier)).toEqual(['serial', 'unit_price', 'note'])
  })

  it('restore 从 localStorage 读取持久化顺序', () => {
    localStorage.setItem('myerp.list.u1.test_b_columnOrder', JSON.stringify(['note', 'serial']))
    const d = useColumnDrag(baseDefs, { listKey: 'test_b' })
    expect(d.orderedKeys.value).toEqual(['note', 'serial', 'unit_price'])
  })

  it('restore lenient：缺失 key 追加到末尾，非法 key 丢弃', () => {
    localStorage.setItem(
      'myerp.list.u1.test_c_columnOrder',
      JSON.stringify(['note', 'DELETED_KEY', 'serial']),
    )
    const d = useColumnDrag(baseDefs, { listKey: 'test_c' })
    expect(d.orderedKeys.value).toEqual(['note', 'serial', 'unit_price'])
  })

  it('restore 静默失败回退到默认顺序', () => {
    localStorage.setItem('myerp.list.u1.test_d_columnOrder', '{not json')
    const d = useColumnDrag(baseDefs, { listKey: 'test_d' })
    expect(d.orderedKeys.value).toEqual(['serial', 'unit_price', 'note'])
  })

  it('reset 还原到 defs 初始顺序 + 清持久化', () => {
    localStorage.setItem('myerp.list.u1.test_e_columnOrder', JSON.stringify(['note']))
    const d = useColumnDrag(baseDefs, { listKey: 'test_e' })
    d.orderedKeys.value = ['note', 'unit_price', 'serial']
    d.reset()
    expect(d.orderedKeys.value).toEqual(['serial', 'unit_price', 'note'])
    // reset 会按新顺序落盘，因此 storage 中存在值（这里断言「存在」以区分 clear）
    expect(localStorage.getItem('myerp.list.u1.test_e_columnOrder')).not.toBeNull()
  })

  it('clear 仅清持久化不改内存', () => {
    localStorage.setItem('myerp.list.u1.test_f_columnOrder', JSON.stringify(['note']))
    const d = useColumnDrag(baseDefs, { listKey: 'test_f' })
    const before = [...d.orderedKeys.value]
    d.clear()
    expect(d.orderedKeys.value).toEqual(before)
    expect(localStorage.getItem('myerp.list.u1.test_f_columnOrder')).toBeNull()
  })

  it('orderedDefs 跟随 orderedKeys 重排', async () => {
    const d = useColumnDrag(baseDefs, { listKey: 'test_g' })
    d.orderedKeys.value = ['note', 'serial', 'unit_price']
    await nextTick()
    expect(d.orderedDefs.value.map((c) => c.label)).toEqual(['备注', '序列号', '单价'])
  })
})

describe('useColumnDrag applyDrag Ref 签名', () => {
  beforeEach(() => { startCalls.length = 0; destroyed.length = 0 })

  it('传 Ref 时，ref 从 null 切到 HTMLElement 触发 start(el)', async () => {
    const d = useColumnDrag(baseDefs, { listKey: 'test_ref_a' })
    const theadRef = ref<HTMLElement | null>(null)
    d.applyDrag(theadRef)
    expect(startCalls.length).toBe(0)  // 初始 null 不应触发 start

    const el = {} as HTMLElement
    theadRef.value = el
    await nextTick()
    // Vue ref 会把对象包成 reactive proxy，start() 收到的是 ref.value（proxy）；
    // toContain 通过 Object.is 判定，故用 ref.value 比对。
    expect(startCalls.length).toBe(1)
    expect(startCalls[0]).toBe(theadRef.value)
  })

  it('传 Ref 时，ref 切到新元素时先 destroy 旧的再 start 新的', async () => {
    const d = useColumnDrag(baseDefs, { listKey: 'test_ref_b' })
    const theadRef = ref<HTMLElement | null>(null)
    d.applyDrag(theadRef)

    const el1 = {} as HTMLElement
    theadRef.value = el1
    await nextTick()
    expect(startCalls.length).toBe(1)
    expect(startCalls[0]).toBe(theadRef.value)
    expect(destroyed.length).toBe(0)

    const el2 = {} as HTMLElement
    theadRef.value = el2
    await nextTick()
    expect(startCalls.length).toBe(2)
    expect(startCalls[1]).toBe(theadRef.value)
    expect(destroyed.length).toBeGreaterThanOrEqual(1)
  })

  it('传 HTMLElement 时维持 Phase 1 行为（立即 start 一次）', () => {
    const d = useColumnDrag(baseDefs, { listKey: 'test_ref_c' })
    const el = {} as HTMLElement
    d.applyDrag(el)
    expect(startCalls).toContain(el)
  })
})
