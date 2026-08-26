import { describe, it, expect, beforeEach, vi } from 'vitest'
import { nextTick } from 'vue'
import { useColumnDrag, columnIdentifier } from '../useColumnDrag'
import type { ColumnDef } from '../useColumnVisibility'

// mock useAuthSession（避免 vue-tsc 报 ref 类型错 + 隔离 localStorage key 后缀）
vi.mock('../useAuthSession', () => ({
  useAuthSession: () => ({ user: { value: { id: 'u1' } } }),
}))

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
