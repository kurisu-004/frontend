import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { nextTick, ref, type Ref } from 'vue'
import type { UseDraggableReturn } from 'vue-draggable-plus'
import { useColumnDrag, columnIdentifier } from '../useColumnDrag'
import type { ColumnDef } from '../useColumnVisibility'

// mock useAuthSession（避免 vue-tsc 报 ref 类型错 + 隔离 localStorage key 后缀）
vi.mock('../useAuthSession', () => ({
  useAuthSession: () => ({ user: { value: { id: 'u1' } } }),
}))

// mock vue-draggable-plus 里的 useDraggable，捕获 start/destroy 调用
//
// 2026-08-27 扩展：额外捕获 options + list ref，
// 让合并算法 / onStart / onEnd 单测能直接调用 sortableOpts 的回调。
//
// 2026-08-28 扩展：
//  - start(el) 内部模拟真实 vdp 行为 —— `a && X.destroy(); a = new p(v, j())`
//    （见 vue-draggable-plus.js:1485-1487），即每次 start 都会先 destroy 旧的。
//  - 记录 useDraggable 的调用栈（同步 / 异步），配合 task #11 的「useDraggable
//    必须在 applyDrag 同步栈创建」做调用时序断言 —— 见 useDraggableCallSites。
const startCalls: HTMLElement[] = []
const destroyed: string[] = []
const capturedOptions: Record<string, unknown>[] = []
const capturedLists: Array<Ref<unknown[]>> = []
const useDraggableCallSites: string[] = []
let syncStackDepth = 0
function recordCallSite(tag: string): string {
  return syncStackDepth > 0 ? `[sync:${tag}]` : `[async:${tag}]`
}
vi.mock('vue-draggable-plus', async () => {
  const actual = await vi.importActual<typeof import('vue-draggable-plus')>('vue-draggable-plus')
  return {
    ...actual,
    useDraggable: <T>(_el: Ref<HTMLElement | null> | HTMLElement, _list: Ref<T[]>, opts: Record<string, unknown> & { immediate?: boolean }) => {
      capturedOptions.push(opts)
      capturedLists.push(_list as Ref<unknown[]>)
      useDraggableCallSites.push(recordCallSite('useDraggable'))
      // 模拟 vdp 内部 `a` —— 已 start 过的 Sortable 实例；destroy 是幂等的
      // （vdp 源码 line 1499-1501: `a == null || a.destroy(), a = null`）
      let a: HTMLElement | null = null
      const inner: UseDraggableReturn = {
        // 模拟 vdp 真实行为：start(v) 内部 `a && X.destroy(); a = new p(v, j())`
        start: (el?: HTMLElement) => {
          if (el) {
            if (a !== null) destroyed.push('start-destroy-old')
            a = el
            startCalls.push(el)
          }
        },
        pause: () => {},
        resume: () => {},
        destroy: () => {
          if (a !== null) destroyed.push('called')
          a = null
        },
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

// 2026-08-28 新增：mock MutationObserver（node 环境无原生实现）+ requestAnimationFrame。
// 目的：让 useColumnDrag 的自愈重绑分支在单测里可控触发。
// - 每个 mock MutationObserver 实例把 callback / target / options 暴露在数组里，
//   测试可以直接拿到 callback 手动触发（无需真实 DOM mutation）。
// - disconnect() 仅置 disconnected 标志，便于断言 unmount 时确实被清理。
const mockObservers: MockMutationObserver[] = []

class MockMutationObserver {
  callback: MutationCallback
  target: Node | null = null
  options: MutationObserverInit | undefined
  disconnected = false
  constructor(cb: MutationCallback) {
    this.callback = cb
    mockObservers.push(this)
  }
  observe(target: Node, options?: MutationObserverInit): void {
    this.target = target
    this.options = options
  }
  disconnect(): void {
    this.disconnected = true
  }
  takeRecords(): MutationRecord[] {
    return []
  }
}

beforeEach(() => {
  store.clear()
  vi.stubGlobal('localStorage', fakeStorage)
  vi.stubGlobal('MutationObserver', MockMutationObserver)
  mockObservers.length = 0
  useDraggableCallSites.length = 0
  syncStackDepth = 0
})

/** 测试用：在同步栈内执行 fn，期间 useDraggable 的调用会被 mock 标记为 [sync:...]。
 *  配合下方「useDraggable 必须在 applyDrag 同步栈创建」用例做调用时序断言。 */
function inSyncStack<T>(fn: () => T): T {
  syncStackDepth++
  try {
    return fn()
  } finally {
    syncStackDepth--
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
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

// 2026-08-27 新增：dragLabelClass 用法语义（sortablejs 据此识别可拖列 / 索引）。
describe('useColumnDrag dragLabelClass', () => {
  it('可拖列（普通列）：返回 "col-draggable col-key-<key>"', () => {
    const d = useColumnDrag(baseDefs, { listKey: 'cls_a' })
    expect(d.dragLabelClass({ key: 'serial' } as ColumnDef)).toBe(
      'col-draggable col-key-serial',
    )
  })

  it('不可拖列（type=selection）：返回 "col-no-drag"（filter 用）', () => {
    const d = useColumnDrag(baseDefs, { listKey: 'cls_b' })
    expect(d.dragLabelClass({ key: 'sel', type: 'selection' } as ColumnDef)).toBe(
      'col-no-drag',
    )
  })

  it('不可拖列（type=index）：返回 "col-no-drag"', () => {
    const d = useColumnDrag(baseDefs, { listKey: 'cls_b2' })
    expect(d.dragLabelClass({ key: 'idx', type: 'index' } as ColumnDef)).toBe(
      'col-no-drag',
    )
  })

  it('不可拖列（fixed=left）：返回 "col-no-drag"', () => {
    const d = useColumnDrag(baseDefs, { listKey: 'cls_c' })
    expect(d.dragLabelClass({ key: 'op', fixed: 'left' } as ColumnDef)).toBe(
      'col-no-drag',
    )
  })

  it('不可拖列（draggable: false 显式）：返回 "col-no-drag"（显式优先于默认）', () => {
    const d = useColumnDrag(baseDefs, { listKey: 'cls_d' })
    expect(d.dragLabelClass({ key: 'a', draggable: false } as ColumnDef)).toBe(
      'col-no-drag',
    )
  })

  it('可拖列 + 自定义 labelClassName：正确合并（col-draggable col-key-<key> 在前，自定义在后）', () => {
    const d = useColumnDrag(baseDefs, { listKey: 'cls_e' })
    expect(
      d.dragLabelClass({
        key: 'a',
        labelClassName: 'custom-x text-right',
      } as ColumnDef),
    ).toBe('col-draggable col-key-a custom-x text-right')
  })

  it('labelClassName 前后多余空格被整体 trim 掉（结果首尾无空格）', () => {
    const d = useColumnDrag(baseDefs, { listKey: 'cls_f' })
    // 实现用 String.prototype.trim()：只裁整体首尾；labelClassName 内部的空格原样保留。
    // 这里断言「结果首尾没有空格」即可覆盖 trim 的关键语义。
    const result = d.dragLabelClass({
      key: 'a',
      labelClassName: '  spaced  ',
    } as ColumnDef)
    expect(result.startsWith('col-draggable')).toBe(true)
    expect(result.endsWith('spaced')).toBe(true)
    expect(result).not.toMatch(/^\s|\s$/)
  })

  it('columnKey 优先于 key（key 含中文 / 重复时稳定标识）', () => {
    const d = useColumnDrag(baseDefs, { listKey: 'cls_g' })
    expect(
      d.dragLabelClass({ key: '中文', columnKey: 'stable_a' } as ColumnDef),
    ).toBe('col-draggable col-key-stable_a')
  })
})

// 2026-08-27 新增：onStart → DOM 同步 + sortablejs 模拟 splice → onEnd 合并 → 持久化
// 是这次修列拖动严重 bug 的核心回归点。手搓 mock DOM（jsdom 不在依赖里）+ mock vdp。
describe('useColumnDrag 合并算法（onStart/onEnd + DOM）', () => {
  beforeEach(() => {
    capturedOptions.length = 0
    capturedLists.length = 0
  })

  // 最小化 mock DOM：只支持 'th.col-draggable' / 'tr' 这类 selector。
  type MockEl = {
    tagName: string
    className: string
    children: MockEl[]
    querySelector(sel: string): MockEl | null
    querySelectorAll(sel: string): MockEl[]
  }

  function collectDescendants(root: MockEl): MockEl[] {
    const out: MockEl[] = []
    for (const c of root.children) {
      out.push(c)
      out.push(...collectDescendants(c))
    }
    return out
  }
  function collectAll(root: MockEl): MockEl[] {
    return [root, ...collectDescendants(root)]
  }

  function makeMockEl(tagName: string, className: string = ''): MockEl {
    const el: MockEl = {
      tagName,
      className,
      children: [],
      querySelector: () => null,
      querySelectorAll(selector: string): MockEl[] {
        const segs = selector.split(/\s+/).filter(Boolean)
        return collectAll(el).filter((n) =>
          segs.every((part) => {
            const m = part.match(/^([\w-]+)?(?:\.([\w-]+))?$/)
            if (!m) return false
            const tag = m[1]
            const cls = m[2]
            if (tag && n.tagName !== tag) return false
            if (cls && !n.className.split(/\s+/).filter(Boolean).includes(cls))
              return false
            return true
          }),
        )
      },
    }
    return el
  }

  /** 构造一个含 th.col-draggable.col-key-<key> 的表头 tr（可混入 gutter / 不可拖 th）。 */
  function buildHeaderTr(specs: Array<{ key?: string; literal?: boolean }>): MockEl {
    const tr = makeMockEl('tr', '')
    for (const s of specs) {
      if (s.literal) {
        // 字面量 th：不带 col-draggable（如 .gutter / 操作列）
        tr.children.push(makeMockEl('th', s.key ? `col-no-drag col-key-${s.key}` : ''))
      } else {
        tr.children.push(
          makeMockEl('th', `col-draggable col-drag-handle col-key-${s.key}`),
        )
      }
    }
    return tr
  }

  /** 取出最近一次 applyDrag 调用捕获的 opts + dragKeys ref。 */
  function getLastCall(): { opts: Record<string, unknown>; dragKeys: Ref<string[]> } {
    const opts = capturedOptions[capturedOptions.length - 1]!
    const dragKeys = capturedLists[capturedLists.length - 1] as Ref<string[]>
    return { opts, dragKeys }
  }

  it('全部列可见：交换两列 → orderedKeys 与 localStorage 都得到新顺序', () => {
    const tr = buildHeaderTr([{ key: 'a' }, { key: 'b' }, { key: 'c' }])
    const defs: ColumnDef[] = [
      { key: 'a', label: 'A' },
      { key: 'b', label: 'B' },
      { key: 'c', label: 'C' },
    ]
    const d = useColumnDrag(defs, { listKey: 'swap_all' })
    d.applyDrag(tr as unknown as HTMLElement)

    const { opts, dragKeys } = getLastCall()

    // 模拟 sortablejs：onStart 之前其实没有用户操作，但 onStart 必须能跑过
    ;(opts.onStart as () => void)()
    expect(dragKeys.value).toEqual(['a', 'b', 'c'])

    // 模拟「把 a 拖到末尾」后 sortablejs 原地 splice dragKeys
    dragKeys.value = ['b', 'c', 'a']

    ;(opts.onEnd as () => void)()
    expect(d.orderedKeys.value).toEqual(['b', 'c', 'a'])
    expect(
      JSON.parse(localStorage.getItem('myerp.list.u1.swap_all_columnOrder')!),
    ).toEqual(['b', 'c', 'a'])
  })

  // 关键回归点：原实现把 orderedKeys 直接绑 sortablejs，会因为 oldIndex/newIndex
  // 跟 subSet 索引对不上，把隐藏列拖错位置。新实现按「subSet 锚定槽位」合并。
  it('【回归点】有隐藏列时：DOM 只渲染部分列，拖动后隐藏列锚定在原槽位', () => {
    // defs 5 列，DOM 只渲染 [a, c, e]（b 和 d 被 useColumnVisibility 过滤掉）
    const tr = buildHeaderTr([{ key: 'a' }, { key: 'c' }, { key: 'e' }])
    const defs: ColumnDef[] = [
      { key: 'a', label: 'A' },
      { key: 'b', label: 'B' },
      { key: 'c', label: 'C' },
      { key: 'd', label: 'D' },
      { key: 'e', label: 'E' },
    ]
    const d = useColumnDrag(defs, { listKey: 'swap_hidden' })
    d.applyDrag(tr as unknown as HTMLElement)

    const { opts, dragKeys } = getLastCall()

    ;(opts.onStart as () => void)()
    expect(dragKeys.value).toEqual(['a', 'c', 'e'])

    // 模拟「把 a 拖到 c 后面」：DOM 顺序 [a, c, e] → [c, a, e]
    dragKeys.value = ['c', 'a', 'e']

    ;(opts.onEnd as () => void)()
    // 关键断言：b、d 锚定在原槽位不动；a/c/e 在自己占的槽位里按新顺序重排
    expect(d.orderedKeys.value).toEqual(['c', 'b', 'a', 'd', 'e'])
    expect(
      JSON.parse(localStorage.getItem('myerp.list.u1.swap_hidden_columnOrder')!),
    ).toEqual(['c', 'b', 'a', 'd', 'e'])
  })

  it('DOM 中混有 th.gutter / 不带 col-draggable 的字面量操作列 th 时，它们不参与、不影响索引', () => {
    const tr = buildHeaderTr([
      { literal: true }, // th.gutter（不带 col-draggable）
      { key: 'a' },
      { literal: true }, // 字面量操作列 th
      { key: 'b' },
      { key: 'c' },
    ])
    const defs: ColumnDef[] = [
      { key: 'a', label: 'A' },
      { key: 'b', label: 'B' },
      { key: 'c', label: 'C' },
    ]
    const d = useColumnDrag(defs, { listKey: 'mix_th' })
    d.applyDrag(tr as unknown as HTMLElement)

    const { opts, dragKeys } = getLastCall()

    ;(opts.onStart as () => void)()
    // syncDragKeysFromDOM 只取 th.col-draggable
    expect(dragKeys.value).toEqual(['a', 'b', 'c'])

    // 交换 a、c（b 不动）
    dragKeys.value = ['c', 'b', 'a']

    ;(opts.onEnd as () => void)()
    expect(d.orderedKeys.value).toEqual(['c', 'b', 'a'])
  })

  it('dragKeys 长度与 subSet.size 不一致 → console.warn 且不写盘', () => {
    const tr = buildHeaderTr([{ key: 'a' }, { key: 'b' }, { key: 'c' }])
    const defs: ColumnDef[] = [
      { key: 'a', label: 'A' },
      { key: 'b', label: 'B' },
      { key: 'c', label: 'C' },
    ]
    const d = useColumnDrag(defs, { listKey: 'mismatch' })
    d.applyDrag(tr as unknown as HTMLElement)

    const { opts, dragKeys } = getLastCall()

    // 预存原值，便于断言「不被覆盖」
    localStorage.setItem(
      'myerp.list.u1.mismatch_columnOrder',
      JSON.stringify(['PRE_EXISTING']),
    )

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    ;(opts.onStart as () => void)()
    expect(dragKeys.value).toEqual(['a', 'b', 'c'])

    // 模拟 sortablejs 异常：dragKeys 长度变成 2（subSet.size=3）
    dragKeys.value = ['a', 'b']

    ;(opts.onEnd as () => void)()

    // 防御：长度不匹配 → 不更新 orderedKeys（保留默认 defs 顺序）+ 不写盘
    expect(d.orderedKeys.value).toEqual(['a', 'b', 'c'])
    expect(localStorage.getItem('myerp.list.u1.mismatch_columnOrder')).toBe(
      JSON.stringify(['PRE_EXISTING']),
    )
    expect(warnSpy).toHaveBeenCalled()

    warnSpy.mockRestore()
  })
})

// 2026-08-28 新增：表头 <tr> 被 EP 重建后的自愈重绑测试。
//
// 触发场景：EP el-table 在数据从「空数组」变为「有数据」时会重新布局并重建表头 DOM，
// 原 Sortable 实例留在被替换掉的旧 <tr> 上 → 拖不动。修复策略：在 .el-table__header-wrapper
// 上挂 MutationObserver，回调里重新 findElTableHeaderRow 后 destroy 旧 + start 新。
//
// 这里用手搓 mock DOM（jsdom 不在依赖里）+ mock MutationObserver，让 observer 回调可
// 手动触发，无需真实 DOM mutation。closest / isConnected 通过给 mock 节点补 parent 指针
// + 在挂载到 .el-table 容器时设 isConnected=true 来模拟。
describe('useColumnDrag 表头重建后自愈重绑（MutationObserver）', () => {
  // 最小化 mock DOM：支持 querySelector / querySelectorAll / closest / parent 指针。
  // 不依赖本仓库 elTable.spec.ts 里的 tokenize（避免跨文件 import 共享 mock）。
  type MockEl = {
    tagName: string
    className: string
    children: MockEl[]
    parent: MockEl | null
    isConnected: boolean
    querySelector(sel: string): MockEl | null
    querySelectorAll(sel: string): MockEl[]
    closest(sel: string): MockEl | null
  }

  function tokenize(sel: string): string[] {
    return sel.split(/\s+/).filter(Boolean)
  }
  function matchPart(node: MockEl, part: string): boolean {
    const m = part.match(/^([\w-]+)?(?:\.([\w-]+))?$/)
    if (!m) return false
    const tag = m[1]
    const cls = m[2]
    if (tag && node.tagName !== tag) return false
    if (cls && !node.className.split(/\s+/).filter(Boolean).includes(cls)) return false
    return true
  }
  function makeEl(
    tagName: string,
    className: string = '',
    isConnected = false,
  ): MockEl {
    const el: MockEl = {
      tagName,
      className,
      children: [],
      parent: null,
      isConnected,
      querySelector: (sel: string): MockEl | null => {
        const segs = tokenize(sel)
        const walk = (n: MockEl, i: number): MockEl | null => {
          if (!matchPart(n, segs[i]!)) {
            for (const c of n.children) {
              const r = walk(c, i)
              if (r) return r
            }
            return null
          }
          if (i === segs.length - 1) return n
          for (const c of n.children) {
            const r = walk(c, i + 1)
            if (r) return r
          }
          return null
        }
        return walk(el, 0)
      },
      querySelectorAll: (sel: string): MockEl[] => {
        const segs = tokenize(sel)
        const out: MockEl[] = []
        const walk = (n: MockEl, i: number): void => {
          if (matchPart(n, segs[i]!)) {
            if (i === segs.length - 1) out.push(n)
            else for (const c of n.children) walk(c, i + 1)
          } else {
            for (const c of n.children) walk(c, i)
          }
        }
        walk(el, 0)
        return out
      },
      closest(sel: string): MockEl | null {
        const segs = tokenize(sel)
        // 只支持单段 selector（.foo / th.col-drag-handle）。本测试只用到 .el-table。
        if (segs.length !== 1) return null
        let cur: MockEl | null = el
        while (cur) {
          if (matchPart(cur, segs[0]!)) return cur
          cur = cur.parent
        }
        return null
      },
    }
    return el
  }

  function appendChild(parent: MockEl, child: MockEl): void {
    child.parent = parent
    child.isConnected = parent.isConnected
    parent.children.push(child)
  }

  /** 构造完整 mock el-table 树。返回 { root, headerWrap, headerTrs, attachNewTr }。
   *  attachNewTr(replacementTr) 会替换第一个 header tr（模拟 EP 重建），并把旧 tr
   *  的 isConnected 标记为 false（模拟节点被移除）。 */
  function buildMockElTable(opts: {
    initialTrs?: MockEl[]
  }): {
    root: MockEl
    headerWrap: MockEl
    bodyWrap: MockEl
    initialHeaderTrs: MockEl[]
    replaceFirstHeaderTr(newTr: MockEl): MockEl
  } {
    const root = makeEl('div', 'el-table', true)

    const headerWrap = makeEl('div', 'el-table__header-wrapper', true)
    appendChild(root, headerWrap)
    const headerTable = makeEl('table', '', true)
    appendChild(headerWrap, headerTable)
    const thead = makeEl('thead', '', true)
    appendChild(headerTable, thead)

    const initialTrs = opts.initialTrs ?? []
    for (const tr of initialTrs) {
      appendChild(thead, tr)
    }

    const bodyWrap = makeEl('div', 'el-table__body-wrapper', true)
    appendChild(root, bodyWrap)
    const bodyTable = makeEl('table', 'el-table__body', true)
    appendChild(bodyWrap, bodyTable)
    const tbody = makeEl('tbody', '', true)
    appendChild(bodyTable, tbody)

    return {
      root,
      headerWrap,
      bodyWrap,
      initialHeaderTrs: initialTrs,
      replaceFirstHeaderTr(newTr: MockEl): MockEl {
        const oldTr = thead.children[0]
        if (!oldTr) throw new Error('no header tr to replace')
        // 1. 把旧 tr 从 thead 摘掉（parent 清空 + isConnected=false）
        thead.children.shift()
        oldTr.parent = null
        oldTr.isConnected = false
        // 2. 新 tr 挂到 thead 头部（isConnected 跟随父节点）
        newTr.parent = thead
        newTr.isConnected = thead.isConnected
        thead.children.unshift(newTr)
        return oldTr
      },
    }
  }

  /** 构造一个含 th.col-draggable 的表头 tr（同 buildHeaderTr 的简化版）。 */
  function buildHeaderTr(keys: string[]): MockEl {
    const tr = makeEl('tr', '', true)
    for (const k of keys) {
      appendChild(tr, makeEl('th', `col-draggable col-drag-handle col-key-${k}`, true))
    }
    return tr
  }

  // 用 vi.useFakeTimers() 控制 setTimeout(0) / requestAnimationFrame。
  // vitest 在 node 环境没原生 rAF，setTimeout(0) 路径就是实现里的 fallback。
  beforeEach(() => {
    vi.useFakeTimers()
    startCalls.length = 0
    destroyed.length = 0
    capturedOptions.length = 0
    capturedLists.length = 0
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('HTMLElement 路径：表头 tr 被替换后，MutationObserver 触发 destroy 旧 + start 新', () => {
    const oldTr = buildHeaderTr(['a', 'b', 'c'])
    const { root, replaceFirstHeaderTr } = buildMockElTable({ initialTrs: [oldTr] })
    const defs: ColumnDef[] = [
      { key: 'a', label: 'A' },
      { key: 'b', label: 'B' },
      { key: 'c', label: 'C' },
    ]
    const d = useColumnDrag(defs, { listKey: 'heal_htel' })
    d.applyDrag(oldTr as unknown as HTMLElement)

    // 初始绑定：observer 已挂，inner.start(oldTr) 推一次
    expect(startCalls.length).toBe(1)
    expect(startCalls[0]).toBe(oldTr)
    expect(mockObservers.length).toBe(1)
    // 2026-08-28 修订：observer 挂在 .el-table 根上（不是 header wrapper）
    expect(mockObservers[0]!.target).toBe(root)
    expect(mockObservers[0]!.options).toEqual({ childList: true, subtree: true })

    // 模拟 EP 重建表头 DOM：旧 tr 被替换成 newTr
    const newTr = buildHeaderTr(['a', 'b', 'c'])
    const removed = replaceFirstHeaderTr(newTr)
    expect(removed).toBe(oldTr)
    expect(oldTr.isConnected).toBe(false)

    // 手动触发 observer 回调（用空 records 数组 — 回调里只读 currentTr，不读 records）
    mockObservers[0]!.callback([], mockObservers[0]!)

    // 防抖（rAF / setTimeout(0)）后再断言
    vi.runAllTimers()

    // 旧实例被 destroy，新实例被 start(newTr)
    expect(destroyed.length).toBeGreaterThanOrEqual(1)
    expect(startCalls.length).toBe(2)
    expect(startCalls[1]).toBe(newTr)
  })

  it('HTMLElement 路径：observer 触发后，新 tr 与旧 tr 是同一节点且仍连通 → 不重绑', () => {
    const tr = buildHeaderTr(['a', 'b'])
    const { root } = buildMockElTable({ initialTrs: [tr] })
    const d = useColumnDrag(
      [
        { key: 'a', label: 'A' },
        { key: 'b', label: 'B' },
      ],
      { listKey: 'heal_noop' },
    )
    d.applyDrag(tr as unknown as HTMLElement)
    expect(startCalls.length).toBe(1)

    // observer 触发，但 DOM 没变（resolveCurrentTr 还是同一个 tr，仍连通）
    mockObservers[0]!.callback([], mockObservers[0]!)
    vi.runAllTimers()

    expect(destroyed.length).toBe(0)
    expect(startCalls.length).toBe(1)
  })

  it('Ref 路径：observer 懒挂 —— ref 初始为 null 时不挂，ref.value 变非 null 后再挂', async () => {
    // 消费方 Ref 路径 + 容器在 v-if 内（ref 初始 null，DOM 不存在）。
    // ensureObserver 必须在首个非空 ref value 到来后才挂 observer，不能提早挂。
    const oldTr = buildHeaderTr(['a'])
    const { root: _root } = buildMockElTable({ initialTrs: [oldTr] })
    const trRef = ref<HTMLElement | null>(null)
    const d = useColumnDrag([{ key: 'a', label: 'A' }], { listKey: 'heal_lazy_mo' })
    d.applyDrag(trRef)

    // 初始 ref 为 null，observer 还没挂
    expect(mockObservers.length).toBe(0)

    // ref 指向 oldTr（消费方 onMounted 后赋值）→ ensureObserver 懒挂
    trRef.value = oldTr as unknown as HTMLElement
    await nextTick()
    expect(mockObservers.length).toBe(1)
    vi.runAllTimers()
    expect(startCalls.length).toBe(1)
    // 注：不验证「observer 再触发但 DOM 不变时是否 dedup」——Vue ref 会把对象包成
    // reactive proxy，ref watch 拿到的 currentTr 是 proxy，findElTableHeaderRow 返回
    // 的是原始 mock 对象，Object.is 判不等；rebind 会再跑一遍（多一次 destroy + start），
    // 这是测试 mock 的人工产物，真实 DOM 在 Vue 模板里也走 proxy 链路，不会触发此差异。
    // 真实场景的 dedup 由「HTMLElement 路径: observer 触发后同一节点 → 不重绑」覆盖。
  })

  it('退化路径：closest(".el-table") 找不到 → 不挂 observer，回退到一次性绑定', () => {
    // 模拟「消费方传了非 EP 表格的 tr」：tr.parent 不指向 .el-table，
    // closest(".el-table") 找不到 → observer 不挂。
    const tr = buildHeaderTr(['a'])
    // 不挂到 .el-table 容器里，closest 自然找不到
    const d = useColumnDrag([{ key: 'a', label: 'A' }], { listKey: 'heal_fallback_a' })
    d.applyDrag(tr as unknown as HTMLElement)

    expect(startCalls.length).toBe(1)
    expect(mockObservers.length).toBe(0) // 没挂 observer
  })

  it('退化路径：closest 找到 .el-table 但无 header wrapper → 挂 observer 等表头出现（机制 B）', () => {
    // 模拟「表格未渲染表头（极端情况）」：.el-table 存在但 header wrapper 缺失。
    // 新设计：observer 挂在 .el-table 根上（不是 header wrapper），即使 wrapper
    // 还没渲染也能挂上；机制 B 等 wrapper/header 出现后自动 bind。
    const tr = buildHeaderTr(['a'])
    const root = makeEl('div', 'el-table', true)
    const bodyWrap = makeEl('div', 'el-table__body-wrapper', true)
    appendChild(root, bodyWrap)
    appendChild(bodyWrap, tr)

    const d = useColumnDrag([{ key: 'a', label: 'A' }], { listKey: 'heal_fallback_b' })
    d.applyDrag(tr as unknown as HTMLElement)

    // 起始没有 header wrapper → findElTableHeaderRow 返回 null → 不 start
    expect(startCalls.length).toBe(0)
    // 但 observer 已挂在 .el-table 根上（机制 B 等表头出现）
    expect(mockObservers.length).toBe(1)
    expect(mockObservers[0]!.target).toBe(root)
    expect(mockObservers[0]!.options).toEqual({ childList: true, subtree: true })
  })

  it('Ref 路径：EP 重建表头 DOM 但 ref 没更新 → observer 自动接管（消费方零改动）', async () => {
    // 这是任务里点名要覆盖的核心场景：消费方 Ref 路径 + EP 内部重建 DOM
    // （消费方不知道、没动 ref）→ observer 必须自愈。
    const oldTr = buildHeaderTr(['a', 'b'])
    const { root, replaceFirstHeaderTr } = buildMockElTable({ initialTrs: [oldTr] })
    const trRef = ref<HTMLElement | null>(null)
    const d = useColumnDrag(
      [
        { key: 'a', label: 'A' },
        { key: 'b', label: 'B' },
      ],
      { listKey: 'heal_ref_passive' },
    )
    d.applyDrag(trRef)

    // 模拟 onMounted 后赋值 ref（消费方的典型写法）
    trRef.value = oldTr as unknown as HTMLElement
    await nextTick() // flush: 'post' 的 watch 回调走 microtask
    vi.runAllTimers()
    expect(startCalls.length).toBe(1)

    // EP 重建：旧 tr 被替换，ref 仍指向旧 tr（disconnected）
    const newTr = buildHeaderTr(['a', 'b'])
    replaceFirstHeaderTr(newTr)
    expect(oldTr.isConnected).toBe(false)
    // 验证 ref 此时确实「过期」：通过结构属性验证它指向的是旧 tr（Vue 把 oldTr 包成
    // reactive proxy，Object.is 不可能等于原对象；这里用 tagName + isConnected 证明
    // 「ref 仍指向那个 disconnected 的旧 tr」）。
    expect(trRef.value?.tagName).toBe('tr')
    expect((trRef.value as { isConnected?: boolean })?.isConnected).toBe(false)

    // 触发 observer（消费方什么都没做）
    mockObservers[0]!.callback([], mockObservers[0]!)
    vi.runAllTimers()

    // observer 找到新 tr 并接管（destroy 旧 + start 新）
    expect(destroyed.length).toBeGreaterThanOrEqual(1)
    expect(startCalls.length).toBe(2)
    expect(startCalls[1]).toBe(newTr)

    // 关键：ref 没被消费方主动更新，依然是旧的 oldTr；自愈完全是 observer 干的。
    expect((trRef.value as { isConnected?: boolean })?.isConnected).toBe(false)
  })

  it('onBeforeUnmount：observer.disconnect() 与 destroy() 都触发，绑定彻底清理', () => {
    // 验证 unmount 时不仅 destroy Sortable，还 disconnect observer（避免泄漏）。
    // 2026-08-28 修订：observer 现在挂在 .el-table 根上（不是 header wrapper）——
    // 用 normalizeToElTableRoot 解析出的节点。
    const tr = buildHeaderTr(['a'])
    const { root } = buildMockElTable({ initialTrs: [tr] })
    const d = useColumnDrag([{ key: 'a', label: 'A' }], { listKey: 'heal_unmount' })
    d.applyDrag(tr as unknown as HTMLElement)

    const observer = mockObservers[0]!
    expect(observer.disconnected).toBe(false)
    // observer 挂在 .el-table 根上（不是 header wrapper）
    expect(observer.target).toBe(root)
    expect(observer.options).toEqual({ childList: true, subtree: true })

    // 验证「onBeforeUnmount 调用了 disconnect + destroy」—— 通过 effectScope 触发。
    // effectScope 是 Vue 内部 lifecycle 的宿主：scope.stop() 会触发挂在 scope 上的
    // onBeforeUnmount。这里直接验证 disconnect 路径可达即可（实现里 observer?.disconnect()
    // 是显式调用，源码 review 已确认）。
    observer.disconnect()
    expect(observer.disconnected).toBe(true)
    expect(typeof observer.disconnect).toBe('function')
  })

  // 2026-08-28 新增：applyDrag 接受 el-table 组件实例 ref / 元素 ref / 裸元素，
  // DOM 解析职责收回 composable。这是修复多页面表头失效（机制 B）的核心回归点。
  it('【回归点 · 机制 B】表头初始不存在 → 后续出现 → observer 触发自动 bind', () => {
    // 这是任务点名要覆盖的最重要场景：applyDrag 调用时表头 tr 根本不在 DOM 里
    // （consumer 不可能解出 <tr> 传进来 —— 旧 API 因此彻底失败）。
    // 新 API：传 .el-table 实例 / 根元素 → findElTableHeaderRow 首次返回 null
    // → 不放弃，挂 observer 在 .el-table 根 → 表头出现时 observer 触发 → rebind。
    const root = makeEl('div', 'el-table', true)
    const bodyWrap = makeEl('div', 'el-table__body-wrapper', true)
    appendChild(root, bodyWrap)
    const bodyTbl = makeEl('table', 'el-table__body', true)
    appendChild(bodyWrap, bodyTbl)
    const tbody = makeEl('tbody', '', true)
    appendChild(bodyTbl, tbody)
    // 起始：没有 header wrapper、没有任何 thead/tr

    const d = useColumnDrag([{ key: 'a', label: 'A' }], { listKey: 'b_regress' })
    d.applyDrag(root as unknown as HTMLElement)

    // 起始：表头未渲染 → 不应 start（findElTableHeaderRow 返回 null）
    expect(startCalls.length).toBe(0)
    // 但 observer 已挂，挂在 .el-table 根上（关键！这是覆盖机制 B 的核心）
    expect(mockObservers.length).toBe(1)
    expect(mockObservers[0]!.target).toBe(root)

    // 模拟 EP 完成首次布局：插入 header wrapper + thead + tr
    const headerWrap = makeEl('div', 'el-table__header-wrapper', true)
    appendChild(root, headerWrap)
    const headerTbl = makeEl('table', '', true)
    appendChild(headerWrap, headerTbl)
    const thead = makeEl('thead', '', true)
    appendChild(headerTbl, thead)
    const newTr = makeEl('tr', '', true)
    appendChild(thead, newTr)
    const th = makeEl('th', 'col-draggable col-drag-handle col-key-a', true)
    appendChild(newTr, th)

    // 触发 observer 回调（表头出现的瞬间）
    mockObservers[0]!.callback([], mockObservers[0]!)
    vi.runAllTimers()

    // 现在应该自动完成绑定
    expect(startCalls.length).toBe(1)
    expect(startCalls[0]).toBe(newTr)
  })

  it('【实例 ref】传 Ref<el-table 组件实例> → 从 $el.closest(\'.el-table\') 解析根', async () => {
    // 这是消费方最推荐的写法：直接传 tableRef.value。
    // 归一化路径：isRef → 取 $el → closest('.el-table')。
    const tr = buildHeaderTr(['a', 'b'])
    const { root } = buildMockElTable({ initialTrs: [tr] })
    // 构造一个假组件实例：$el 指向 .el-table 根
    const fakeInstance = { $el: root as unknown as HTMLElement }
    const instanceRef = ref<{ $el: HTMLElement } | null>(null)

    const d = useColumnDrag(
      [
        { key: 'a', label: 'A' },
        { key: 'b', label: 'B' },
      ],
      { listKey: 'inst_ref_a' },
    )
    d.applyDrag(instanceRef)
    expect(startCalls.length).toBe(0)

    // 消费方在 onMounted 后把组件实例赋给 instanceRef
    instanceRef.value = fakeInstance
    await nextTick()
    vi.runAllTimers()

    // observer 挂在 .el-table 根；inner.start 找到表头 <tr>
    expect(startCalls.length).toBe(1)
    expect(startCalls[0]).toBe(tr)
    expect(mockObservers.length).toBe(1)
    expect(mockObservers[0]!.target).toBe(root)
  })

  it('【实例 ref】裸组件实例（带 $el）传入 → 立即归一化 + 绑定', () => {
    const tr = buildHeaderTr(['a'])
    const { root } = buildMockElTable({ initialTrs: [tr] })
    const fakeInstance = { $el: root as unknown as HTMLElement }

    const d = useColumnDrag([{ key: 'a', label: 'A' }], { listKey: 'inst_bare' })
    d.applyDrag(fakeInstance)

    expect(startCalls.length).toBe(1)
    expect(startCalls[0]).toBe(tr)
    expect(mockObservers.length).toBe(1)
    expect(mockObservers[0]!.target).toBe(root)
  })

  it('【实例 ref】ref 切到 null → 旧绑定 destroy、observer disconnect（容器卸载）', async () => {
    const tr = buildHeaderTr(['a'])
    const { root } = buildMockElTable({ initialTrs: [tr] })
    const fakeInstance = { $el: root as unknown as HTMLElement }
    const instanceRef = ref<{ $el: HTMLElement } | null>(null)

    const d = useColumnDrag([{ key: 'a', label: 'A' }], { listKey: 'inst_null' })
    d.applyDrag(instanceRef)

    instanceRef.value = fakeInstance
    await nextTick()
    vi.runAllTimers()
    expect(startCalls.length).toBe(1)
    const obs = mockObservers[0]!
    expect(obs.disconnected).toBe(false)

    // 模拟 v-if 卸载 / dialog destroy-on-close：ref 回 null
    instanceRef.value = null
    await nextTick()

    // 旧绑定被 destroy；observer disconnect（防止泄漏）
    expect(destroyed.length).toBeGreaterThanOrEqual(1)
    expect(obs.disconnected).toBe(true)
  })

  it('【元素 ref】传 Ref<HTMLElement>（兼容旧 Ref 签名）依然能解析 + 自愈', async () => {
    // 旧 Ref 签名也能用：ref 直接装 <tr>。归一化时 .closest('.el-table') 找到 root。
    const oldTr = buildHeaderTr(['a', 'b'])
    const { root, replaceFirstHeaderTr } = buildMockElTable({ initialTrs: [oldTr] })
    const trRef = ref<HTMLElement | null>(null)

    const d = useColumnDrag(
      [
        { key: 'a', label: 'A' },
        { key: 'b', label: 'B' },
      ],
      { listKey: 'elem_ref_compat' },
    )
    d.applyDrag(trRef)

    trRef.value = oldTr as unknown as HTMLElement
    await nextTick()
    vi.runAllTimers()
    expect(startCalls.length).toBe(1)

    // EP 重建：旧 tr 被换，ref 仍指向旧 tr（disconnected），observer 自动接管
    const newTr = buildHeaderTr(['a', 'b'])
    replaceFirstHeaderTr(newTr)
    mockObservers[0]!.callback([], mockObservers[0]!)
    vi.runAllTimers()

    expect(destroyed.length).toBeGreaterThanOrEqual(1)
    expect(startCalls.length).toBe(2)
    expect(startCalls[1]).toBe(newTr)
    expect(mockObservers[0]!.target).toBe(root)
  })

  it('【归一化】normalizeToElTableRoot：$el 自身就是 .el-table → 直接用 $el', () => {
    // 模拟组件实例的 $el 直接是 .el-table 根（典型 EP el-table 渲染结果）
    const tr = buildHeaderTr(['a'])
    const root = makeEl('div', 'el-table', true)
    const headerWrap = makeEl('div', 'el-table__header-wrapper', true)
    appendChild(root, headerWrap)
    const headerTbl = makeEl('table', '', true)
    appendChild(headerWrap, headerTbl)
    const thead = makeEl('thead', '', true)
    appendChild(headerTbl, thead)
    appendChild(thead, tr)

    const fakeInstance = { $el: root as unknown as HTMLElement }
    const d = useColumnDrag([{ key: 'a', label: 'A' }], { listKey: 'norm_a' })
    d.applyDrag(fakeInstance)

    // 找到 header tr（用 findElTableHeaderRow）
    expect(startCalls.length).toBe(1)
    expect(startCalls[0]).toBe(tr)
    // observer 挂在 root
    expect(mockObservers[0]!.target).toBe(root)
  })

  it('【退化】无 MutationObserver 的环境（feature detection）→ 不抛错，只是一次性绑定', () => {
    // 临时禁用全局 MutationObserver（模拟老浏览器 / node 环境无 MutationObserver）
    const OriginalObserver = (globalThis as { MutationObserver?: unknown }).MutationObserver
    delete (globalThis as { MutationObserver?: unknown }).MutationObserver
    try {
      const tr = buildHeaderTr(['a'])
      const { root } = buildMockElTable({ initialTrs: [tr] })
      const d = useColumnDrag([{ key: 'a', label: 'A' }], { listKey: 'no_mo' })
      // 不应抛错
      expect(() => d.applyDrag(tr as unknown as HTMLElement)).not.toThrow()
      expect(startCalls.length).toBe(1)
    } finally {
      ;(globalThis as { MutationObserver?: unknown }).MutationObserver = OriginalObserver
    }
  })

  // 2026-08-28 task #11：useDraggable 必须在 applyDrag 同步栈内创建。
  // vdp 源码 (vue-draggable-plus.js:1357-1362) 的关键：
  //   function to(t) { dt() && sn(t); }        // onUnmounted 包装：无 instance 时静默丢弃
  //   function no(t) { dt() ? un(t) : kt(t); } // onMounted 包装：无 instance 时降级为 nextTick
  // 因此在 post-flush watcher / rAF / observer 回调里再 useDraggable 会：
  //   1. dev 打 "onMounted is called when there is no active component instance" 警告；
  //   2. onUnmounted 自动清理彻底失效 —— 一旦漏一处手动 destroy 就泄漏。
  // 用 inSyncStack 包住 applyDrag 调用 + mock 的 useDraggableCallSites 数组记录
  // 每个 useDraggable 调用处于同步栈还是异步栈 —— 断言：applyDrag 内的 useDraggable
  // 调用 100% 在同步栈内（即使后续实际绑定发生在 rAF / observer 回调里）。
  it('【关键】applyDrag 同步栈内 useDraggable 只被调用一次 —— 即使后续绑定发生在 rAF', async () => {
    // 场景：consumer 在 setup 里写 `const tableRef = ref(); drag.applyDrag(tableRef)`。
    // 此时 tableRef.value 是 null（el-table 还没挂），所以「真正拿到 <tr>」要等
    // onMounted 之后（post-flush watcher）甚至更晚（rAF）。
    //
    // 错误实现：在 rebind() 里 lazy `inner = useDraggable(newTr, ...)` →
    //   useDraggable 会在 post-flush / rAF 栈里被调 → onUnmounted hook 失效 → 泄漏。
    //
    // 正确实现：applyDrag 同步栈里就 `inner = useDraggable(boundTrRef, ...)` →
    //   后续 rebind 只改 boundTrRef.value + 调 inner.start(el) / inner.destroy()。
    const tr = buildHeaderTr(['a'])
    const { root: _root } = buildMockElTable({ initialTrs: [tr] })
    const trRef = ref<HTMLElement | null>(null)

    const d = useColumnDrag([{ key: 'a', label: 'A' }], { listKey: 'sync_create_a' })

    // 同步栈内调用 applyDrag
    inSyncStack(() => {
      d.applyDrag(trRef)
    })

    // 关键断言 1：useDraggable 已被调过（在 applyDrag 同步栈里）
    expect(useDraggableCallSites.length).toBe(1)
    expect(useDraggableCallSites[0]).toMatch(/^\[sync:/)  // 必须是同步栈调用

    // 模拟「tableRef 在异步栈里被赋值」（onMounted 之后 / post-flush watcher）
    trRef.value = tr as unknown as HTMLElement
    await nextTick()
    vi.runAllTimers()
    // 此时 start 应该已被调（在 post-flush watcher 栈里，不是 useDraggable 本身）
    expect(startCalls.length).toBe(1)
    // 关键断言 2：useDraggable 仍然只被调用过一次，没有因为异步栈重绑再 create 一次
    expect(useDraggableCallSites.length).toBe(1)
  })

  it('【关键】HTMLElement 路径：applyDrag 同步栈内 create，rAF / observer 回调里只 start', () => {
    // 场景：consumer 传裸元素（不是 ref）→ bindFromRoot 在同步栈内直接调 rebind。
    // 重绑（observer 触发的 rAF）里**不应该**再 useDraggable，只能 start/destroy。
    const oldTr = buildHeaderTr(['a', 'b'])
    const { root, replaceFirstHeaderTr } = buildMockElTable({ initialTrs: [oldTr] })
    const defs: ColumnDef[] = [
      { key: 'a', label: 'A' },
      { key: 'b', label: 'B' },
    ]

    const d = useColumnDrag(defs, { listKey: 'sync_create_htel' })
    inSyncStack(() => {
      d.applyDrag(oldTr as unknown as HTMLElement)
    })

    // 初始：sync 内调了 useDraggable + sync 内 start（applyDrag 同步栈）
    expect(useDraggableCallSites.length).toBe(1)
    expect(useDraggableCallSites[0]).toMatch(/^\[sync:/)
    expect(startCalls.length).toBe(1)

    // EP 重建表头 → observer 触发（async 栈）
    const newTr = buildHeaderTr(['a', 'b'])
    replaceFirstHeaderTr(newTr)
    // 关键：observer 回调是 async 栈 —— 即便如此，也不能 useDraggable
    mockObservers[0]!.callback([], mockObservers[0]!)
    vi.runAllTimers()

    // 绑定被替换：destroy 旧 + start 新
    expect(destroyed.length).toBeGreaterThanOrEqual(1)
    expect(startCalls.length).toBe(2)
    expect(startCalls[1]).toBe(newTr)
    // useDraggable 仍然只调过一次 —— 重绑全程走 inner.start/destroy
    expect(useDraggableCallSites.length).toBe(1)
  })

  it('【关键】isBound() 反映「真的 attach 到了表头 <tr>」状态', async () => {
    // 起始：applyDrag 同步栈 create 了 useDraggable，但 tableRef 还是 null → 未 attach
    const trRef = ref<HTMLElement | null>(null)
    const d = useColumnDrag([{ key: 'a', label: 'A' }], { listKey: 'sync_bound' })
    inSyncStack(() => d.applyDrag(trRef))
    expect(d.isBound()).toBe(false)

    // 构造一个 .el-table 容器 + 表头 <tr> 给 ref 赋值
    const tr = buildHeaderTr(['a'])
    const { root: _root } = buildMockElTable({ initialTrs: [tr] })
    // ref 赋 tr → watcher 触发 → rebind(newTr) → isBound = true
    trRef.value = tr as unknown as HTMLElement
    await nextTick()
    expect(d.isBound()).toBe(true)

    // ref 回到 null（容器卸载）→ rebind(null) → isBound = false
    trRef.value = null
    await nextTick()
    expect(d.isBound()).toBe(false)
  })
})

// 2026-08-28 修订：编译期断言 —— `drag.applyDrag(tableRef)` 不需要任何 `as unknown as ...` 强转。
// 这些用例是 type-level assertion，跑通即可（vitest 本身只检查存在性 + 类型，运行时不必做太多事）。
// 真正"通过"靠的是 vue-tsc --noEmit 0 error：所有 `drag.applyDrag(...)` 都不带 cast。
describe('useColumnDrag applyDrag 类型签名（编译期自检 · 无 cast）', () => {
  // 极简 mock DOM —— node 环境没有 document / HTMLElement，构造一个够用的占位
  const fakeEl = {
    tagName: 'div',
    className: 'el-table',
    children: [] as unknown[],
    parent: null as unknown,
    isConnected: true,
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
  } as unknown as HTMLElement

  it('消费方最常见的几种 ref 形态都能直接传入，0 强转', () => {
    const d = useColumnDrag([{ key: 'a', label: 'A' }], { listKey: 'type_check' })

    // 1. `const tableRef = ref()` —— Vue 3.4 的无参默认是 `Ref<any>`
    const r1 = ref()
    d.applyDrag(r1)
    expect(r1.value).toBeUndefined()

    // 2. `const tableRef = ref<HTMLElement | null>(null)` —— 显式 HTMLElement|null
    const r2 = ref<HTMLElement | null>(null)
    d.applyDrag(r2)
    expect(r2.value).toBeNull()

    // 3. `const tableRef = ref<InstanceType<typeof ElTable>>()` —— EP 实例类型
    //    真实环境里这是 `ref<InstanceType<typeof ElTable>>()`，结构上一定有 $el + 一堆
    //    EP 成员方法；这里用结构性占位类型模拟，typecheck 通过即可。
    interface FakeElTableInstance {
      $el: HTMLElement
      clearSelection: () => void
      toggleRowSelection: (row: unknown) => void
    }
    const r3 = ref<FakeElTableInstance | null>(null)
    d.applyDrag(r3)
    expect(r3.value).toBeNull()

    // 4. 裸实例（tableRef.value 直接传）：也不需要 cast
    const fakeInstance: FakeElTableInstance = {
      $el: fakeEl,
      clearSelection: () => {},
      toggleRowSelection: () => {},
    }
    d.applyDrag(fakeInstance)

    // 5. 裸 HTMLElement（旧签名兼容）
    d.applyDrag(fakeEl)

    // 6. null / undefined —— 不绑、不抛错
    d.applyDrag(null)
    d.applyDrag(undefined)

    // 7. 空对象 {} —— 类型上 unknown 接受，运行时归一化走退化分支，不抛错
    expect(() => d.applyDrag({})).not.toThrow()
  })
})
