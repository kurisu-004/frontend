// src/utils/__tests__/elTable.spec.ts
//
// 2026-08-27 新增：findElTableHeaderRow + findElTableTbody 单元测试。
//
// 实现里只用 .querySelector(selector) / .querySelectorAll('tr')，
// jsdom 不在本项目依赖里，所以手搓一个最小化的 Mock DOM：
// 只支持 elTable.ts 实际用到的 selector 模式（class / tag / 空格后代 / > 直接子 / 复合 tag.class）。
// 这样不引入额外依赖，又能精确覆盖策略分支。

import { describe, it, expect } from 'vitest'
import { findElTableHeaderRow, findElTableHeaderWrapper, findElTableTbody } from '../elTable'

interface MockEl {
  tagName: string
  className: string
  children: MockEl[]
  querySelector(selector: string): MockEl | null
  querySelectorAll(selector: string): MockEl[]
}

type Segment = { part: string; combinator: ' ' | '>' | undefined }

// 把 selector 拆为 segment 序列。例如 ".a .b > c" →
// [{part:'.a',combinator:undefined}, {part:'.b',combinator:' '}, {part:'c',combinator:'>'}]
function tokenize(sel: string): Segment[] {
  const segs: Segment[] = []
  let buf = ''
  let combinator: ' ' | '>' | undefined = undefined
  let isFirst = true
  let i = 0

  const flush = (): void => {
    if (buf) {
      segs.push({ part: buf, combinator: isFirst ? undefined : combinator })
      buf = ''
      combinator = undefined
      isFirst = false
    }
  }

  while (i < sel.length) {
    const ch = sel[i] as string
    if (ch === ' ' || ch === '\t' || ch === '\n') {
      if (buf) flush()
      // 空白只是分隔：若已声明 > 则保留 >，否则若非首段则置默认 ' '
      if (combinator === undefined && !isFirst) combinator = ' '
      i++
    } else if (ch === '>') {
      if (buf) flush()
      combinator = '>'
      i++
    } else {
      buf += ch
      i++
    }
  }
  flush()
  return segs
}

function matchSegment(el: MockEl, part: string): boolean {
  // 支持单层 selector：纯 class（.foo）/ 纯 tag（tr）/ 复合（th.col-draggable）
  const m = part.match(/^([\w-]+)?(?:\.([\w-]+))?$/)
  if (!m) return false
  const tag = m[1]
  const cls = m[2]
  if (tag && el.tagName !== tag) return false
  if (cls && !el.className.split(/\s+/).filter(Boolean).includes(cls)) return false
  return true
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

function matchChain(node: MockEl, segments: Segment[], idx: number): boolean {
  if (idx >= segments.length) return true
  if (!matchSegment(node, segments[idx]!.part)) return false
  if (idx === segments.length - 1) return true
  const next = segments[idx + 1]!
  const candidates = next.combinator === '>' ? node.children : collectDescendants(node)
  return candidates.some((c) => matchChain(c, segments, idx + 1))
}

/** 沿 segment 链向前推进：每一步筛出「与当前候选集按 combinator 关联、且匹配下一段」的子集。
 *  最终 candidates 就是 selector 命中的节点集合（匹配的是最后一段）。 */
function stepForward(root: MockEl, segs: Segment[]): MockEl[] | null {
  if (segs.length === 0) return null
  let candidates = collectAll(root).filter((n) => matchSegment(n, segs[0]!.part))
  for (let i = 1; i < segs.length; i++) {
    const seg = segs[i]!
    const next: MockEl[] = []
    for (const c of candidates) {
      const pool = seg.combinator === '>' ? c.children : collectDescendants(c)
      for (const p of pool) {
        if (matchSegment(p, seg.part) && !next.includes(p)) next.push(p)
      }
    }
    candidates = next
    if (candidates.length === 0) return []
  }
  return candidates
}

function findFirst(root: MockEl, selector: string): MockEl | null {
  const segs = tokenize(selector)
  const res = stepForward(root, segs)
  return res && res.length > 0 ? res[0]! : null
}

function findAll(root: MockEl, selector: string): MockEl[] {
  const segs = tokenize(selector)
  const res = stepForward(root, segs)
  return res ?? []
}

function makeEl(tagName: string, className: string = ''): MockEl {
  const el: MockEl = {
    tagName,
    className,
    children: [],
    querySelector: (selector) => findFirst(el, selector),
    querySelectorAll: (selector) => findAll(el, selector),
  }
  return el
}

interface BuildOpts {
  /** header 区域 tr 列表；不传则不构建 header wrapper */
  headerTrs?: Array<{ ths: Array<{ className: string }> }>
  /** body 行（tbody 始终存在）；不传则 tbody 为空 */
  bodyTrs?: Array<{ className?: string }>
}

// 构造一个简化的 EP el-table DOM 树。
// - header 部分按 .el-table__header-wrapper > table > thead > tr > th
// - body 部分按 .el-table__body-wrapper > table.el-table__body > tbody > tr
function buildElTable(opts: BuildOpts = {}): MockEl {
  const root = makeEl('div', 'el-table')

  // body 部分：始终构建 wrapper（bodyTrs 不传 / 传空数组都建空 tbody）
  const bodyWrap = makeEl('div', 'el-table__body-wrapper')
  const bodyTbl = makeEl('table', 'el-table__body')
  const tbody = makeEl('tbody', '')
  for (const trSpec of opts.bodyTrs ?? []) {
    const tr = makeEl('tr', trSpec.className ?? '')
    tbody.children.push(tr)
  }
  bodyTbl.children.push(tbody)
  bodyWrap.children.push(bodyTbl)
  root.children.push(bodyWrap)

  if (opts.headerTrs !== undefined) {
    const headerWrap = makeEl('div', 'el-table__header-wrapper')
    const headerTbl = makeEl('table', 'el-table__header')
    const thead = makeEl('thead', '')
    for (const trSpec of opts.headerTrs) {
      const tr = makeEl('tr', '')
      for (const thSpec of trSpec.ths) {
        const th = makeEl('th', thSpec.className)
        tr.children.push(th)
      }
      thead.children.push(tr)
    }
    headerTbl.children.push(thead)
    headerWrap.children.push(headerTbl)
    root.children.push(headerWrap)
  }

  return root
}

describe('findElTableHeaderRow', () => {
  it('单层表头：返回那个 tr', () => {
    const root = buildElTable({
      headerTrs: [{ ths: [{ className: 'col-draggable col-key-a' }] }],
    })
    const tr = findElTableHeaderRow(root as unknown as HTMLElement)
    expect(tr).not.toBeNull()
    expect(tr!.tagName).toBe('tr')
  })

  it('多级表头：handle 在第二行 → 返回第二个 tr', () => {
    // 第一行是组表头（无 handle），第二行是叶子列（带 handle）。
    // 这是 EP 多级表头 + 列拖动的典型结构。
    const root = buildElTable({
      headerTrs: [
        { ths: [{ className: '' }, { className: '' }] }, // 组表头，无 handle
        { ths: [{ className: 'col-drag-handle col-draggable col-key-a' }] }, // 叶子行
      ],
    })
    const tr = findElTableHeaderRow(root as unknown as HTMLElement)
    const allTrs = root.querySelectorAll('tr')
    expect(tr).not.toBeNull()
    expect(tr).toBe(allTrs[1])
  })

  it('多级表头 handle 在第一行 → 返回第一行（优先匹配含 handle 的第一个 tr）', () => {
    const root = buildElTable({
      headerTrs: [
        { ths: [{ className: 'col-drag-handle' }] },
        { ths: [{ className: '' }] },
      ],
    })
    const tr = findElTableHeaderRow(root as unknown as HTMLElement)
    const allTrs = root.querySelectorAll('tr')
    expect(tr).toBe(allTrs[0])
  })

  it('无 .el-table__header-wrapper → null（表格未挂载 / 容器已卸载）', () => {
    // 不传 headerTrs → 不构建 header wrapper
    const root = buildElTable({ bodyTrs: [] })
    expect(findElTableHeaderRow(root as unknown as HTMLElement)).toBeNull()
  })

  it('header wrapper 存在但 thead 内无 tr → null', () => {
    // 列被全隐藏 / 空表头场景
    const root = buildElTable({ headerTrs: [] })
    expect(findElTableHeaderRow(root as unknown as HTMLElement)).toBeNull()
  })

  it('入参为 null → null', () => {
    expect(findElTableHeaderRow(null)).toBeNull()
  })
})

describe('findElTableTbody', () => {
  it('基本场景：返回 .el-table__body > tbody', () => {
    const root = buildElTable({ bodyTrs: [{ className: 'row' }] })
    const tbody = findElTableTbody(root as unknown as HTMLElement)
    expect(tbody).not.toBeNull()
    expect(tbody!.tagName).toBe('tbody')
    expect(tbody!.className).toBe('')
  })

  it('无 body wrapper → null（防御：表格未挂载 / 容器已卸载）', () => {
    const root = makeEl('div', 'el-table')
    expect(findElTableTbody(root as unknown as HTMLElement)).toBeNull()
  })

  it('入参为 null → null', () => {
    expect(findElTableTbody(null)).toBeNull()
  })
})

// 2026-08-28 新增：findElTableHeaderWrapper 用于 useColumnDrag 自愈重绑挂
// MutationObserver。仅在 .el-table 根 + header wrapper 同时存在时才挂 observer。
describe('findElTableHeaderWrapper', () => {
  it('基本场景：返回 .el-table__header-wrapper', () => {
    const root = buildElTable({ headerTrs: [{ ths: [{ className: '' }] }] })
    const wrap = findElTableHeaderWrapper(root as unknown as HTMLElement)
    expect(wrap).not.toBeNull()
    expect(wrap!.className).toBe('el-table__header-wrapper')
  })

  it('无 .el-table__header-wrapper → null', () => {
    const root = makeEl('div', 'el-table')
    expect(findElTableHeaderWrapper(root as unknown as HTMLElement)).toBeNull()
  })

  it('入参为 null → null', () => {
    expect(findElTableHeaderWrapper(null)).toBeNull()
  })
})
