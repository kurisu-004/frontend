// composables/useColumnDrag.ts
//
// 2026-08-28 修订：applyDrag 接受 el-table 组件实例 ref / 元素 ref / 裸元素，
//                  DOM 解析职责收回 composable；表头未渲染时不放弃，挂
//                  MutationObserver 在 .el-table 根上等表头出现再绑。
// 2026-08-28 修订：表头 <tr> 重建后自愈重绑。
// 2026-08-27 修订：列顺序拖动状态管理。
//
// 设计要点：
// - 持久化 key: myerp.list.<userId>.<listKey>_columnOrder（与 _columns 并列，互不污染）
// - lenient 策略：restore 时只覆盖 defs 中存在的 key；新列追加到末尾、删列自动剔除
// - 拖动事件 onEnd 才写盘（v-for 重排期间不让 watch 触发额外副作用）
// - applyDrag() 把 useDraggable 绑到**表头 <tr>**；Sortable 选项：
//     draggable: 'th.col-draggable'  ← 关键：只把可拖列计入排序 / 索引（gutter
//       th / fixed 列 / type 列自动从索引序列里剔除，oldIndex/newIndex 与子序列对齐）
//     handle: '.col-drag-handle'
//     filter: '.col-no-drag'
//   消费方通过 dragLabelClass(def) 把 'col-draggable' / 'col-no-drag' / 'col-key-<key>'
//   打到 <el-table-column :label-class-name>，从而落到 <th> 上。
// - 绑定列表是内部 dragKeys（只含当前实际渲染的可拖动列子序列），不再直接绑
//   orderedKeys — 后者含隐藏列 / 不可拖列，索引与 sortablejs 给的 oldIndex/newIndex
//   不对应。
//   合并算法（onEnd 触发）：
//     1. onStart 从 DOM 的 th.col-draggable 同步 dragKeys，并快照 subSet（拖动前
//        可拖列集合）；vue-draggable-plus 在 onUpdate 里原地 splice dragKeys。
//     2. onEnd 读 dragKeys.value 得到 newSub（拖动后顺序）；
//     3. orderedKeys.map：subSet 内的 key 按 newSub 顺序替换；subSet 外的 key 锚定
//        在原槽位（即隐藏列 / 不可拖列不动位置，可拖列在自己占的槽位里按新顺序重排）。
//     4. 防御：newSub.length !== subSet.size 直接放弃合并（只 console.warn，不写盘）。
// - 2026-08-28 修订：DOM 解析职责收回 composable。
//   背景：把 findElTableHeaderRow 留在 consumer 里、调用方自己拿 `<tr>` 再传进来
//   的模式有两个 bug：
//     A. EP 数据从「空数组」变「有数据」会重建表头 DOM，原 Sortable 实例留在旧节点；
//     B. applyDrag 执行时表头尚未渲染，consumer 的 findElTableHeaderRow 返回 null
//        → applyDrag 根本没被调用 → observer 也就永远挂不上 → 永久失效。
//   新 applyDrag 三种 target：
//     1. el-table 组件实例 ref（首选）—— 取 $el.closest('.el-table') ?? $el；
//     2. HTMLElement ref / 裸 HTMLElement —— 自身匹配 .el-table 就用自身；
//        否则 closest('.el-table')；再退化为元素自身（mock DOM 没有 .el-table 包装）。
//   observer 挂在 .el-table 根（不是 header wrapper）—— 覆盖机制 B（header wrapper
//   整体被替换 / 首次插入都能捕获）。
//   useDraggable 在 applyDrag 同步栈内创建（immediate: false），rAF / observer 回调里
//   只调 inner.start / inner.destroy —— vue-draggable-plus 的 useDraggable 在无
//   currentInstance 时注册 onScopeDispose / onMounted 会打警告且清理失效。
// - 不做组件级 vitest：applyDrag 的 DOM 行为靠 Phase 2 端到端冒烟验证
//
// 用法（消费方 0 强转）：
//   const drag = useColumnDrag(columnDefs, { listKey: 'parts_list' })
//   const tableRef = ref<InstanceType<typeof ElTable>>()
//   drag.applyDrag(tableRef)        // 一行搞定，类型自动适配
//   <el-table-column v-for="d in drag.orderedDefs.value" :key="d.columnKey ?? d.key"
//     :label-class-name="drag.dragLabelClass(d)" ... :draggable="false" />
//
// 旧签名仍兼容：
//   drag.applyDrag(headerRowRef)    // Ref<HTMLElement | null>
//   drag.applyDrag(headerRow as HTMLElement)  // 旧 HTMLElement 一次性签名

import {
  computed,
  isRef,
  nextTick,
  onBeforeUnmount,
  ref,
  watch,
  type ComputedRef,
  type Ref,
} from 'vue'
import { useDraggable } from 'vue-draggable-plus'
import { findElTableHeaderRow } from '@/utils/elTable'
import { useAuthSession } from './useAuthSession'
import { resolveDraggable, type ColumnDef } from './useColumnVisibility'

export interface UseColumnDragOptions {
  listKey: string
}

/** 任意 ref 形态 —— 故意只声明 `readonly value: unknown`，让消费方不用关心 ref
 *  装的具体是 HTMLElement、组件实例、还是 `ref()` 无参默认的 `Ref<any>`。
 *  Vue 的 Ref<T> 是协变的，Ref<T> 始终可赋值给 `{ readonly value: unknown }`。
 *  运行时用 isRef(target) + '$el' in value + closest in value 三段判定具体形态。 */
type AnyRefLike = { readonly value: unknown }

/** 任意 el-table 组件实例形态 —— `InstanceType<typeof ElTable>` 带一堆 EP 成员，
 *  但结构上一定含 `$el: HTMLElement`；这里只声明 `$el?: unknown` 保持最大兼容，
 *  不污染公共签名为 any。运行时再判断 $el 是否真的是 HTMLElement。 */
type AnyInstanceLike = { $el?: unknown }

/** applyDrag 接受的 target 形态（按运行时判定顺序）：
 *  1. AnyRefLike — 任意 Vue Ref（`tableRef`、`ref()` 无参、`InstanceType<typeof ElTable>` 的 Ref 都行）；
 *  2. AnyInstanceLike — 裸组件实例（`tableRef.value`，或直接传实例）；
 *  3. HTMLElement — 裸元素 / `findElTableHeaderRow(el)` 的返回值（旧签名兼容）；
 *  4. null | undefined — 不绑、不抛错。 */
export type ApplyDragTarget =
  | AnyRefLike
  | AnyInstanceLike
  | HTMLElement
  | null
  | undefined

export interface ColumnDragApi<T extends ColumnDef = ColumnDef> {
  /** 当前顺序的 columnKey 列表（v-for :key 用） */
  orderedKeys: Ref<string[]>
  /** 按 orderedKeys 重排后的 ColumnDef 列表（v-for 绑这个） */
  orderedDefs: ComputedRef<T[]>
  /** 在表头 <tr> 上挂 useDraggable；找不到表头时不放弃，挂 MutationObserver
   *  在 .el-table 根上等表头出现再绑（覆盖机制 A：EP 重建表头；机制 B：表头初始未渲染）。
   *
   *  推荐用法（一行搞定，不用任何强转）：
   *    const tableRef = ref<InstanceType<typeof ElTable>>()
   *    drag.applyDrag(tableRef)
   *
   *  target 接受（按运行时判定顺序）：
   *    1. 任意 Vue ref —— `ref()` 无参 / `Ref<HTMLElement|null>` / `Ref<InstanceType<typeof ElTable>>` 全部兼容
   *    2. 裸 el-table 组件实例（带 `$el` 字段）—— `drag.applyDrag(tableRef.value)` 也行
   *    3. 裸 HTMLElement（表格根容器 或 表头 <tr>，旧签名兼容）
   *    4. null / undefined —— 不绑、不抛错
   *
   *  运行时归一化（无 any / 无 cast）：isRef(target) → 取 value → 判 '$el' → 判 closest 链。
   *  公共签名用 `{ readonly value: unknown }` / `{ $el?: unknown }` 而不是 Ref<T>，
   *  这样消费方写 `drag.applyDrag(tableRef)` 不需要任何 `as unknown as Ref<...>` 强转。 */
  applyDrag: (
    target: ApplyDragTarget,
    options?: { handle?: string; animation?: number },
  ) => void
  /** 给 <el-table-column :label-class-name> 用：可拖列打上 col-draggable +
   *  col-key-<key>，不可拖列打上 col-no-drag。sortablejs 据此识别可排序子元素。 */
  dragLabelClass: (def: T) => string
  /** 还原到 defs 初始顺序 + 清持久化 */
  reset: () => void
  /** 仅清持久化（不改内存） */
  clear: () => void
  /** 是否已挂 useDraggable（调试用） */
  isBound: () => boolean
}

/** 构造 localStorage key：含 user.id 后缀，避免共享浏览器账号污染。 */
function storageKey(listKey: string): string {
  let suffix = 'anon'
  try {
    const { user } = useAuthSession()
    if (user.value?.id) suffix = String(user.value.id)
  } catch {
    /* useAuthSession 在 setup 外调用会失败 → 落到 anon */
  }
  return `myerp.list.${suffix}.${listKey}_columnOrder`
}

function persist(listKey: string, keys: string[]): void {
  try {
    localStorage.setItem(storageKey(listKey), JSON.stringify(keys))
  } catch {
    /* 静默失败（localStorage 满 / 隐私模式等） */
  }
}

/** 从 localStorage 恢复：lenient — 只取 defs 中存在的 key；缺失 key 视为新增追加到末尾；
 *  非法 key（非 string / 不在 defs 中）一律丢弃。解析失败回退到默认顺序。 */
function restore(listKey: string, defKeys: string[]): string[] {
  try {
    const raw = localStorage.getItem(storageKey(listKey))
    if (!raw) return [...defKeys]
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return [...defKeys]
    const set = new Set(defKeys)
    const known = parsed.filter((k): k is string => typeof k === 'string' && set.has(k))
    const missing = defKeys.filter((k) => !known.includes(k))
    return [...known, ...missing]
  } catch {
    return [...defKeys]
  }
}

/** 取列稳定标识：columnKey 优先，回落 key */
export function columnIdentifier(def: ColumnDef): string {
  return def.columnKey ?? def.key
}

/** 标记类前缀：sortablejs 通过该前缀识别「这个 <th> 属于哪一列」。 */
const COL_KEY_CLASS_PREFIX = 'col-key-'

/** 从 th 的 className 里解析 col-key-<key>。返回 null 表示该 th 没打标记。 */
function parseColKeyFromClass(className: string): string | null {
  const classes = className.split(/\s+/)
  for (const c of classes) {
    if (c.startsWith(COL_KEY_CLASS_PREFIX)) return c.slice(COL_KEY_CLASS_PREFIX.length)
  }
  return null
}

/** 从表头 <tr> 内同步出「当前实际渲染的可拖动列」key 序列。
 *  排序与 <th> 在 DOM 里的物理顺序一致，sortablejs 给的 oldIndex/newIndex 也按此序列。 */
function syncDragKeysFromDOM(rowHeaderEl: HTMLElement): string[] {
  const ths = Array.from(rowHeaderEl.querySelectorAll<HTMLElement>('th.col-draggable'))
  const keys: string[] = []
  for (const th of ths) {
    const k = parseColKeyFromClass(th.className)
    if (k) keys.push(k)
  }
  return keys
}

/** 从三种 target 形态中归一化出「.el-table 根元素」。
 *  - 实例 ref / 实例本身：取 $el，再 closest('.el-table') ?? $el；
 *  - 元素 ref / 元素本身：自身匹配 .el-table 用自身；否则 closest('.el-table')；
 *    再退化为元素自身（mock DOM 没有 .el-table 包装时也能工作）。
 *  任何中间步骤返回 null 都用下一级 fallback，最终至少是原始元素。
 *  返回 null 当且仅当 target 本身就是 null / undefined。
 *  注：用 className 字符串匹配代替 classList.contains —— 兼容测试的 mock DOM
 *  （mock 只暴露 className: string，不暴露 classList / nodeType）。className
 *  在真 DOM 上也是 string（DOM Living Standard: HTMLElement.className），无回归。 */
function hasElTableClass(el: { className?: string } | null | undefined): boolean {
  if (!el || typeof el.className !== 'string') return false
  return el.className.split(/\s+/).includes('el-table')
}

function normalizeToElTableRoot(target: unknown): HTMLElement | null {
  if (target == null) return null
  // 实例形态：带 $el 属性（HTMLElement 不会有 $el —— mock DOM 不算 HTMLElement）
  const maybeInstance = target as { $el?: HTMLElement | null }
  if (
    maybeInstance &&
    '$el' in maybeInstance &&
    maybeInstance.$el &&
    typeof (maybeInstance.$el as HTMLElement).closest === 'function'
  ) {
    const el = maybeInstance.$el as HTMLElement
    const root = el.closest('.el-table') as HTMLElement | null
    return root ?? el
  }
  // 元素形态
  const el = target as HTMLElement
  if (el && typeof (el as { closest?: unknown }).closest === 'function') {
    if (hasElTableClass(el)) return el
    const root = (el as HTMLElement).closest('.el-table') as HTMLElement | null
    if (root) return root
  }
  // 退化：mock DOM / 非 EP 表格 → 直接用元素自身
  return el as HTMLElement
}

export function useColumnDrag<T extends ColumnDef>(
  defs: readonly T[],
  options: UseColumnDragOptions,
): ColumnDragApi<T> {
  const defKeys = defs.map(columnIdentifier)
  const orderedKeys = ref<string[]>(restore(options.listKey, defKeys))

  const orderedDefs = computed<T[]>(() => {
    const map = new Map(defs.map((d) => [columnIdentifier(d), d]))
    const result: T[] = []
    for (const k of orderedKeys.value) {
      const d = map.get(k)
      if (d) result.push(d)
    }
    // 防御：defs 中新增但 orderedKeys 没有的 key（不应发生，restore 已 merge）
    for (const d of defs) {
      if (!orderedKeys.value.includes(columnIdentifier(d))) result.push(d)
    }
    return result
  })

  // 内部 dragKeys：只装当前实际渲染的可拖动列 key。vue-draggable-plus 会在拖动时
  // 原地 splice 这个数组，oldIndex/newIndex 与 <th> 在 DOM 里的物理顺序对齐。
  // 初值留空数组——onStart 会从 DOM 同步。
  const dragKeys = ref<string[]>([])

  // 2026-08-28 新增：表头 DOM 重建后自愈用的 MutationObserver。
  // 暴露在 setup 闭包外层，便于 onBeforeUnmount.disconnect()，避免泄漏。
  let observer: MutationObserver | null = null
  // 是否已成功 attach Sortable 到某个表头 <tr>（isBound API 暴露）。
  // useDraggable 自身的 Sortable 实例生命周期由 vdp 内部维护（onUnmounted 自动清理），
  // 我们只关心「真的绑上了可拖列」这个状态给 isBound() 返回。
  let isAttached = false

  /** 防抖调度：rAF 优先，fallback setTimeout(0)。合并同一帧内的多次 mutation 触发。 */
  function scheduleRaf(cb: () => void): void {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(cb)
      return
    }
    setTimeout(cb, 0)
  }

  /** 给 <el-table-column :label-class-name> 用。可拖列打 col-draggable + col-key-<key>；
   *  不可拖列打 col-no-drag（filter 用）。 */
  function dragLabelClass(def: T): string {
    const custom = def.labelClassName ?? ''
    if (resolveDraggable(def) && !def.type && !def.fixed) {
      return `col-draggable ${COL_KEY_CLASS_PREFIX}${columnIdentifier(def)} ${custom}`.trim()
    }
    return `col-no-drag ${custom}`.trim()
  }

  function applyDrag(
    target: ApplyDragTarget,
    dragOpts?: { handle?: string; animation?: number },
  ): void {
    // 闭包内的 onStart snapshot + onEnd merge state
    let subSet: Set<string> = new Set()

    /** 当前绑定的表头 <tr>。所有「实际绑到哪个节点」的真相都来自这里。 */
    let currentTr: HTMLElement | null = null
    /** 防抖标志：同一帧内多次 mutation 只触发一次真实重绑。 */
    let scheduled = false
    /** 当前已解析的 .el-table 根（observer 挂载点）。 */
    let tableRoot: HTMLElement | null = null

    /** 通用 Sortable 选项：绑 dragKeys，draggable 只认 th.col-draggable。 */
    const sortableOpts = {
      draggable: 'th.col-draggable',
      handle: dragOpts?.handle ?? '.col-drag-handle',
      filter: '.col-no-drag',
      animation: dragOpts?.animation ?? 150,
      direction: 'horizontal' as const,
      onStart: () => {
        // 2026-08-27 修订：从 DOM 同步当前可见的可拖动列子序列；这一步必须在
        // sortablejs splice dragKeys 之前完成（onStart 在 drop 之前触发）。
        // 2026-08-28 修订：用闭包内 currentTr 而非外部 target，确保读到的是
        // 当前实际绑定节点（重绑后取到的是新 <tr>，不是消费方传进来的旧节点）。
        const el = currentTr
        if (!el) return
        dragKeys.value = syncDragKeysFromDOM(el)
        subSet = new Set(dragKeys.value)
      },
      onEnd: () => {
        // onUpdate 已经在内部把 DOM 还原并原地 splice dragKeys；此时 dragKeys.value
        // 已经是新顺序。不要再读 DOM（DOM 已被还原）。
        const newSub = [...dragKeys.value]
        if (newSub.length !== subSet.size) {
          // 防御：长度不匹配 = sortablejs 在 drag 过程中出了意外（最常见是
          // dragKeys 被外部改动 / DOM 重渲染打断了排序），直接放弃合并、不写盘。
          // eslint-disable-next-line no-console
          console.warn(
            '[useColumnDrag] dragKeys length mismatch:',
            `expected ${subSet.size}, got ${newSub.length}. Skipping merge.`,
          )
          return
        }
        if (subSet.size === 0) return
        let i = 0
        orderedKeys.value = orderedKeys.value.map((k) =>
          subSet.has(k) ? newSub[i++] ?? k : k,
        )
        persist(options.listKey, orderedKeys.value)
      },
    }

    // ─── 关键：useDraggable 必须在 applyDrag 同步栈内创建 ─────────────────
    //
    // 为什么不能用「lazy create」模式：
    //   consumer 传的 tableRef 在 setup 阶段**必然是 null**（el-table 还没挂）。
    //   因此真正能拿到 <tr> 的时刻是 consumer 的 onMounted 之后（post-flush watcher
    //   回调）甚至更晚（rAF / observer 回调）—— 那时 getCurrentInstance() 已经
    //   返回 null。
    //
    //   vdp 内部（dist/vue-draggable-plus.js:1357-1362）的关键代码：
    //     function to(t) { dt() && sn(t); }        // onUnmounted 包装：无 instance 时静默丢弃
    //     function no(t) { dt() ? un(t) : kt(t); }  // onMounted 包装：无 instance 时降级为 nextTick
    //   因此在异步上下文里再 useDraggable() 会：
    //     1. dev 下打 Vue 「onMounted is called when there is no active component instance」警告；
    //     2. onUnmounted 自动清理彻底失效 —— 只能靠我们 onBeforeUnmount 手动 destroy，
    //        一旦漏一处就泄漏（依赖手动清理 = 脆）。
    //
    // 正确做法：创建占位 ref，在 applyDrag 同步栈里把 useDraggable 挂上去，
    //   后续 rebind 只改 ref.value + 调 inner.start / inner.destroy（vdp 内部
    //   的 start(v) 实现是 `a && X.destroy(); a = new p(v, j())` —— 不依赖 Vue
    //   生命周期上下文，可以在异步栈里安全调）。
    //
    // vdp 不 watch target ref（源码 line 1488-1496 只 watch options `i`），
    //   不会和我们的 rebind 双重绑定。
    const boundTrRef: Ref<HTMLElement | null> = ref(null)
    const inner = useDraggable(boundTrRef, dragKeys, { ...sortableOpts, immediate: false })

    /** 从 tableRoot 出发找表头 <tr>。找不到返回 null。 */
    function resolveCurrentTr(): HTMLElement | null {
      return tableRoot ? findElTableHeaderRow(tableRoot) : null
    }

    /** 幂等重绑：同一节点且仍连通 → 跳过；否则 destroy 旧 + start 新。
     *  **不再调 useDraggable** —— 见上方 applyDrag 开头的「关键」注释。
     *  isConnected 用于检测「节点被 EP 替换」（引用未变不可能，但 ref 路径下
     *  消费方可能把同一个 ref 指向旧 tr —— 此时 isConnected=false → 仍要重绑）。 */
    function rebind(newTr: HTMLElement | null): void {
      const sameNode = newTr !== null && newTr === currentTr
      const stillConnected =
        currentTr !== null &&
        (currentTr as { isConnected?: boolean }).isConnected !== false
      if (sameNode && stillConnected) return
      currentTr = newTr
      // 保持 boundTrRef 与 currentTr 同步（一致性保证 + 调试可见）
      boundTrRef.value = newTr
      if (!newTr) {
        // 表头消失（机制 B 中初次未渲染 / EP 重建瞬间）—— 销毁 Sortable，等 observer
        // 再次回调时通过 rebind(newTr) 重建。vdp 的 destroy() 内部 `a == null || a.destroy()`
        // 是幂等的，重复调安全。try/catch 包裹：防止 Sortable 内部抛错把 Vue
        // 调度器拉下水（startTime undefined 路径）。
        try { inner.destroy() } catch { /* swallow */ }
        isAttached = false
        return
      }
      // start(v) 内部 `a && X.destroy(); a = new p(v, j())` —— 自己处理旧实例 + 新建。
      // 可以在 rAF / observer 回调里安全调（不需要 currentInstance）。
      // try/catch 包裹：transient <tr> 上构造 Sortable 抛错时不让 Vue 调度器
      // 看到 —— observer 下一帧 mutation 触发 scheduleRebind 重建。
      try {
        inner.start(newTr)
        isAttached = true
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[useColumnDrag] Sortable start failed, will retry on next mutation:', err)
        isAttached = false
      }
    }

    /** MutationObserver 回调入口：同一帧内只调度一次真实重绑。 */
    function scheduleRebind(): void {
      if (scheduled) return
      scheduled = true
      scheduleRaf(() => {
        scheduled = false
        try {
          rebind(resolveCurrentTr())
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn('[useColumnDrag] rAF rebind swallowed error:', err)
        }
      })
    }

    /** 懒挂 observer：挂在 .el-table 根上（不是 header wrapper）—— 覆盖机制 B
     *  （header wrapper 整体被替换 / 首次插入都能捕获）。仅监听 childList + subtree
     *  —— EP 会频繁改 <th> 的 class/style（排序状态、fixed 偏移、hover），监听
     *  attributes 会触发重绑风暴甚至死循环。
     *  找不到 root / 浏览器无 MutationObserver 时不挂（退化到一次性绑定，不抛错）。 */
    function ensureObserver(): void {
      if (observer || !tableRoot) return
      const MO = (typeof MutationObserver !== 'undefined' ? MutationObserver : null) as
        | typeof MutationObserver
        | null
      if (!MO) return
      observer = new MO(scheduleRebind)
      observer.observe(tableRoot, { childList: true, subtree: true })
    }

    /** 把当前 target（ref 或裸值）解析成 .el-table 根，写入 tableRoot。 */
    function resolveRoot(): HTMLElement | null {
      const raw = isRef(target) ? target.value : target
      return normalizeToElTableRoot(raw)
    }

    /** 拿到根后分支：
     *  - tableRoot 是 .el-table：尝试 findElTableHeaderRow → bind，挂 observer 覆盖
     *    机制 A（表头被 EP 重建）+ 机制 B（表头尚未渲染出现后自动 bind）；
     *  - tableRoot 是其他元素（消费方给了 <tr> / mock DOM 无 .el-table 包装）：
     *    把它本身当 bind 目标（兼容旧 HTMLElement 一次性签名），不挂 observer。
     *  - tableRoot 是 null：不绑、不挂。
     *  整体 try/catch 兜底：2026-08-31 调查发现 Vue DevTools 浏览器扩展的
     *  profiler 在 EP 重建表头 / 我们的 rAF 重绑窗口里访问 component.$startTime
     *  会抛 "Cannot read properties of undefined (reading 'startTime')"。
     *  错误从 extension content script 冒到 Vue 调度器，被 V8 报告成
     *  `et.reportAllChanges @ n.timeout`。我们既管不了扩展、也不能调它的内部
     *  时序，最稳妥的做法是把自己这条路径上任何同步 / 异步抛错都吞掉 —— rebind
     * 内部已 try/catch，这里再裹一层兜住 resolveRoot / findElTableHeaderRow /
     *  ensureObserver 这些「dispatch 之前」的失败。 */
    function bindFromRoot(): void {
      try {
        if (!tableRoot) {
          rebind(null)
          return
        }
        if (hasElTableClass(tableRoot)) {
          rebind(findElTableHeaderRow(tableRoot))
          ensureObserver()
          return
        }
        // 退化路径：mock DOM 没有 .el-table 包装 / 旧 HTMLElement 签名直接传 <tr>
        rebind(tableRoot)
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[useColumnDrag] bindFromRoot swallowed error:', err)
      }
    }

    // 取首次归一化的根（Ref 起始可能是 null / 实例 .$el 未挂）；用于 immediate 路径
    tableRoot = resolveRoot()

    if (isRef(target)) {
      // Ref / 实例 ref 路径：watch ref 值变化时重新归一化 + 重绑。
      // 2026-08-31 修订：把 initial bind 从「flush: 'post' 的 watch 立即回调」
      // 改为「显式 nextTick + 后续 watch 用 flush: 'sync'」。
      // 原因：consumer 在 onMounted 里调 applyDrag() 时，flush: 'post' 的
      // immediate 回调被进入 post-mount scheduler 队列 —— 此时 EP 可能还在
      // 自己的 patch 周期里，findElTableHeaderRow 拿到的可能是 transient <tr>，
      // 与 Sortable 构造函数 + Vue 调度器交叉触发「Cannot read properties
      // of undefined」的 scheduler 错误。改成 nextTick + flush: 'sync' 让首次
      // 绑定在 mount 完成的下一个 microtask 边界同步执行，绕过 post-mount
      // 队列；后续 ref 变化时直接同步重绑（DOM 已稳定，无 post-mount race）。
      nextTick(() => {
        try {
          tableRoot = resolveRoot()
          if (!tableRoot) {
            rebind(null)
            return
          }
          bindFromRoot()
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn('[useColumnDrag] initial nextTick bind swallowed error:', err)
        }
      })
      watch(
        target,
        () => {
          try {
            tableRoot = resolveRoot()
            if (!tableRoot) {
              // 容器被卸载：disconnect observer + 走 rebind(null) 统一销毁 Sortable
              // + 清 isAttached 标志
              observer?.disconnect()
              observer = null
              rebind(null)
              return
            }
            bindFromRoot()
          } catch (err) {
            // eslint-disable-next-line no-console
            console.warn('[useColumnDrag] watch rebind swallowed error:', err)
          }
        },
        // 后续 ref 变化直接同步重绑（DOM 已挂好且通常不会有 EP 内部 patch 与
        // 我们的 start 竞争；observer 自愈会覆盖 EP 重建表头的情况）。
        { flush: 'sync' },
      )
      return
    }
    // 裸 HTMLElement / 实例：挂一次即生效（observer 自愈后续 EP 重建 / 机制 B）
    bindFromRoot()
  }

  function reset(): void {
    orderedKeys.value = [...defKeys]
    persist(options.listKey, orderedKeys.value)
  }

  function clear(): void {
    try {
      localStorage.removeItem(storageKey(options.listKey))
    } catch {
      /* silent */
    }
  }

  onBeforeUnmount(() => {
    // 2026-08-28 修订：vdp 内部的 useDraggable 已在创建时注册了 onUnmounted
    // 自动清理（`to(X.destroy)` —— 因为 useDraggable 是在 applyDrag 同步栈内
    // 创建的，getCurrentInstance() 有值，hook 成功挂上）。这里我们只负责自己
    // 持有的 observer 的 disconnect，避免 headerWrapper 被卸载后 observer
    // 仍持有它的引用 → 内存泄漏。
    observer?.disconnect()
    observer = null
  })

  return {
    orderedKeys,
    orderedDefs,
    applyDrag,
    dragLabelClass,
    reset,
    clear,
    isBound: () => isAttached,
  }
}

/** 重新导出 resolveDraggable 便于消费方从同一入口引用。 */
export { resolveDraggable }