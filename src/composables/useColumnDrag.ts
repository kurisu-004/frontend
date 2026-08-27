// composables/useColumnDrag.ts
//
// 2026-08-27 新增：列顺序拖动状态管理。
//
// 设计要点：
// - 持久化 key: myerp.list.<userId>.<listKey>_columnOrder（与 _columns 并列，互不污染）
// - lenient 策略：restore 时只覆盖 defs 中存在的 key；新列追加到末尾、删列自动剔除
// - 拖动事件 onEnd 才写盘（v-for 重排期间不让 watch 触发额外副作用）
// - applyDrag() 把 useDraggable 绑到 <thead>；handle='.col-drag-handle'，filter='.col-no-drag'
//   （fixed 列 / type=selection|index|expand 不参与拖动；sortablejs 不动它们）
// - 不做组件级 vitest：applyDrag 的 DOM 行为靠 Phase 2 端到端冒烟验证
//
// 用法：
//   const drag = useColumnDrag(columnDefs, { listKey: 'parts_list' })
//   <thead ref="theadRef">...</thead> → drag.applyDrag(theadRef)
//   <el-table-column v-for="d in drag.orderedDefs.value" :key="d.columnKey ?? d.key" ... :draggable="false" />

import { computed, onBeforeUnmount, ref, watch, type ComputedRef, type Ref } from 'vue'
import { useDraggable } from 'vue-draggable-plus'
import { useAuthSession } from './useAuthSession'
import { resolveDraggable, type ColumnDef } from './useColumnVisibility'

export interface UseColumnDragOptions {
  listKey: string
}

export interface ColumnDragApi<T extends ColumnDef = ColumnDef> {
  /** 当前顺序的 columnKey 列表（v-for :key 用） */
  orderedKeys: Ref<string[]>
  /** 按 orderedKeys 重排后的 ColumnDef 列表（v-for 绑这个） */
  orderedDefs: ComputedRef<T[]>
  /** 在 <thead> 上挂 useDraggable；必须在 onMounted 后调（拿到真实 DOM） */
  applyDrag: (
    theadEl: HTMLElement | Ref<HTMLElement | null>,
    options?: { handle?: string; animation?: number },
  ) => void
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

/** 类型守卫：区分 Ref<HTMLElement | null> 和裸 HTMLElement 调用方。
 *  运行时检查 `_value` 属性以避免对 HTMLElement 实例误判（HTMLElement 也有 _value getter，
 *  但 applyDrag 的签名限制参数为 HTMLElement | Ref<HTMLElement | null>，这里做双重保险）。 */
function isRef(v: unknown): v is Ref<HTMLElement | null> {
  return typeof v === 'object' && v !== null && '_value' in (v as object)
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

  // bind 句柄：useDraggable 返回对象含 destroy() / pause() / resume() 等
  let boundRef: { destroy: () => void } | null = null

  function applyDrag(
    theadEl: HTMLElement | Ref<HTMLElement | null>,
    dragOpts?: { handle?: string; animation?: number },
  ): void {
    if (isRef(theadEl)) {
      // 2026-08-27 Phase 2：Ref 路径支持 dialog / destroy-on-close / v-if 场景。
      // 与硬约束 #10（useLazyDraggable 解决 setup 期 null 崩溃）的精神一致：
      // immediate:false 跳过挂载期自动绑定，由 watch 在 ref 转为非 null 时再 start。
      // flush: 'post' 保证 DOM 已 patch 完再绑定；ref 换新节点时先 destroy 旧的再 start 新的。
      const inner = useDraggable(theadEl, orderedKeys, {
        immediate: false,
        handle: dragOpts?.handle ?? '.col-drag-handle',
        filter: '.col-no-drag',
        animation: dragOpts?.animation ?? 150,
        direction: 'horizontal',
        onEnd() {
          // onEnd 时 sortablejs 已原地 splice orderedKeys；此时落盘
          persist(options.listKey, orderedKeys.value)
        },
      })
      watch(
        theadEl,
        (el) => {
          boundRef?.destroy()
          boundRef = null
          if (!el) return
          inner.start(el)
          boundRef = { destroy: () => inner.destroy() }
        },
        { immediate: true, flush: 'post' },
      )
      return
    }
    // HTMLElement 路径（Phase 1 行为）：挂一次即生效
    const el = theadEl as HTMLElement
    const { destroy } = useDraggable(el, orderedKeys, {
      handle: dragOpts?.handle ?? '.col-drag-handle',
      filter: '.col-no-drag',
      animation: dragOpts?.animation ?? 150,
      direction: 'horizontal',
      onEnd() {
        // onEnd 时 sortablejs 已原地 splice orderedKeys；此时落盘
        persist(options.listKey, orderedKeys.value)
      },
    })
    boundRef = { destroy }
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
    boundRef?.destroy()
    boundRef = null
  })

  return {
    orderedKeys,
    orderedDefs,
    applyDrag,
    reset,
    clear,
    isBound: () => boundRef !== null,
  }
}

/** 重新导出 resolveDraggable 便于消费方从同一入口引用。 */
export { resolveDraggable }
