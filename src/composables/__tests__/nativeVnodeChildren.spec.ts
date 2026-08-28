// src/composables/__tests__/nativeVnodeChildren.spec.ts
//
// 回归守卫单测：扫描 src/**/*.{vue,ts}，断言不存在
//   h('<原生小写标签>', <props>, () => <expr>)
// 形态的 cellRender 写法。
//
// 2026-08-27 踩坑记录：
//   Vue 3 的 h() 第三参数对原生元素必须是 string / number / 数组 / VNode；
//   传函数会被 normalizeChildren 当成 slots（SLOTS_CHILDREN），
//   而 mountElement 只处理 TEXT_CHILDREN / ARRAY_CHILDREN，
//   结果是原生元素内什么都不渲染——整片单元格空白，
//   表头与字面量列正常所以特别容易漏看。
//   组件用法（h(ElTag, ...)、h(RouterLink, ...)）传函数 children 是正确的，
//   本守卫仅针对原生小写标签，避免误伤。

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const SRC = join(ROOT, 'src')

interface Hit {
  file: string
  line: number
  column: number
  text: string
}

// 递归收集目标文件，跳过 node_modules / __tests__ / 本 spec 自身。
function collectFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__' || entry === '.git') continue
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) {
      collectFiles(full, out)
      continue
    }
    if (/\.(vue|ts)$/.test(entry)) {
      const rel = relative(SRC, full).split(sep).join('/')
      if (rel === 'composables/__tests__/nativeVnodeChildren.spec.ts') continue
      out.push(full)
    }
  }
  return out
}

function makeHit(source: string, anchor: number) {
  const uptoAnchor = source.slice(0, anchor)
  const line = uptoAnchor.split('\n').length
  const lastNl = uptoAnchor.lastIndexOf('\n')
  const column = anchor - (lastNl + 1) + 1
  const lineEnd = source.indexOf('\n', anchor)
  const text = source.slice(anchor, lineEnd === -1 ? source.length : lineEnd).trim()
  return { line, column, text }
}

// 单行/多行扫描：在源码中找出 `h('native', <props>, () => ...)` 形态。
// 关键约束：props 里出现的 `() =>`（事件处理器、computed）是合法的——
// 它们在大括号内，所以本算法用「顶层逗号」把它们排除掉。
// 算法：
//   1. 锚点 h(  + 紧跟引号小写 tag（必须是原生 HTML，否则视为组件放过）；
//   2. 从 tag 字符串结束位置起跟踪括号/方括号/大括号配平，
//      记录 h(...) 这一层的「顶层逗号」次数；
//   3. 第一个顶层逗号后跳过空白，若紧跟 `()=>` / `() =>` 形态 → 命中。
function scanSource(file: string, source: string): Hit[] {
  const hits: Hit[] = []
  const len = source.length
  let i = 0

  while (i < len - 1) {
    if (source[i] !== 'h' || source[i + 1] !== '(') { i++; continue }
    const anchor = i
    i += 2
    while (i < len && /\s/.test(source[i])) i++
    if (i >= len) break
    const quote = source[i]
    if (quote !== "'" && quote !== '"' && quote !== '`') { i = anchor + 1; continue }
    const tagStart = i + 1
    i++
    while (i < len && source[i] !== quote) i++
    if (i >= len) { i = anchor + 1; continue }
    const tag = source.slice(tagStart, i)
    i++
    // tag 必须是单段小写字母 + 数字，不含 `-` / `.`：
    //   - 含 `.` → 命名空间组件 `Foo.Bar`，放过
    //   - 含 `-` → Vue 3 视为自定义组件（kebab-case 组件如 `router-link` 等
    //     也用 h('xxx-yyy', ..., () => slot) 写法，传函数 children 是合法的）
    if (!/^[a-z][a-z0-9]*$/.test(tag)) { i = anchor + 1; continue }

    let depthP = 1
    let depthB = 0
    let depthC = 0
    let topCommas = 0
    let inStr: string | null = null
    let escaped = false
    let lineCount = 0
    let scanned = 0
    const maxChars = 4000
    const maxLines = 30
    let hit = false
    let finished = false

    // 每次看到顶层逗号，把「下一个非空白 token」标记为待检测位置。
    // 一旦进入非空白字符就检测一次；命中则记 hit。
    let awaitingToken = false

    while (i < len) {
      if (scanned > maxChars || lineCount > maxLines) break
      const ch = source[i]
      scanned++

      if (inStr) {
        if (escaped) { escaped = false; i++; continue }
        if (ch === '\\') { escaped = true; i++; continue }
        if (ch === inStr) inStr = null
        i++; continue
      }
      if (ch === "'" || ch === '"' || ch === '`') { inStr = ch; i++; continue }
      if (ch === '/' && source[i + 1] === '/') {
        while (i < len && source[i] !== '\n') i++
        continue
      }
      if (ch === '/' && source[i + 1] === '*') {
        i += 2
        while (i < len - 1 && !(source[i] === '*' && source[i + 1] === '/')) i++
        i = Math.min(len, i + 2)
        continue
      }
      if (ch === '\n') { lineCount++; i++; continue }

      // 还在等待下一个 token（最近一次顶层逗号后）？跳过空白。
      if (awaitingToken && depthP === 1 && depthB === 0 && depthC === 0 && /\s/.test(ch)) {
        i++; continue
      }
      // 等待中的第一个非空白字符 → 检查是否为 () => 形态
      if (awaitingToken && depthP === 1 && depthB === 0 && depthC === 0) {
        if (ch === '(') {
          // 跳到匹配的 ')'，再检查后面是否有 =>
          let j = i + 1
          let innerP = 1
          while (j < len && innerP > 0) {
            const cj = source[j]
            if (cj === '(') innerP++
            else if (cj === ')') {
              innerP--
              if (innerP === 0) break
            }
            j++
          }
          // j 指向 ')'
          let k = j + 1
          while (k < len && /\s/.test(source[k])) k++
          if (k + 1 < len && source[k] === '=' && source[k + 1] === '>') {
            hit = true
          }
          // 命中或未命中 `() =>` 形态 —— 这是 children 的位置，
          // 不再需要继续扫（同一 h() 调用不会再产生新的 top-level 逗号）
          awaitingToken = false
          finished = true
          break
        }
        // 其他起始 token（{ / [ / 'literal' / 标识符 / null / 数字）按合法对待，
        // 清掉 awaitingToken 继续扫（让外层括号配平推进，碰下一个顶层逗号时再触发）
        awaitingToken = false
      }

      if (ch === '(') { depthP++; i++; continue }
      if (ch === ')') {
        depthP--
        if (depthP === 0) { finished = true; i++; break }
        i++; continue
      }
      if (ch === '{') { depthB++; i++; continue }
      if (ch === '}') { depthB--; i++; continue }
      if (ch === '[') { depthC++; i++; continue }
      if (ch === ']') { depthC--; i++; continue }
      if (ch === ',' && depthP === 1 && depthB === 0 && depthC === 0) {
        topCommas++
        awaitingToken = true
        i++; continue
      }
      i++
    }

    if (hit) {
      hits.push({ file, ...makeHit(source, anchor) })
    }
    if (!finished) { i = anchor + 1; continue }
    if (!hit) { i = anchor + 1; continue }
  }
  return hits
}

describe('原生元素 cellRender 不应传函数 children', () => {
  const files = collectFiles(SRC)
  const allHits: Hit[] = []

  for (const f of files) {
    const src = readFileSync(f, 'utf8')
    allHits.push(...scanSource(f, src))
  }

  it('命中数为 0', () => {
    if (allHits.length > 0) {
      const list = allHits
        .map((h) => `  ${relative(ROOT, h.file)}:${h.line}:${h.column}\n    ${h.text}`)
        .join('\n')
      throw new Error(
        `发现 ${allHits.length} 处原生元素传函数 children（Vue 3 会当 slots → 渲染为空）：\n${list}\n`
        + '请把 h("<native>", props, () => X) 改为 h("<native>", props, X)；'
        + '多行 / 数组形式请先提取局部变量再传入。组件写法 h(ElXxx, ..., () => ...) 不会被本守卫命中，可保持原样。',
      )
    }
    expect(allHits.length).toBe(0)
  })
})