// views/parts/composables/usePartBatchSelection.ts
//
// 2026-08-22 从 PartsList.vue 抽出：批量选中状态机（print / dispatch 两动作共用）。
//
// 关键点：
// - 跨页选择由 selectedIds（reactive Set）维护真实状态。
// - selectedRowTypes 记录每个 id 的行类型（PART / ASSEMBLY），打印时拆分批次。
// - restoreTableSelection 在 fetchList 后由 view 在 nextTick 恢复勾选 UI。
// - table ref 通过 deps.getTable() 解耦（PartsList → partsListRef.elTableRef）。

import { computed, nextTick, reactive, ref, type Ref } from 'vue'
import type { PartListItem } from '@/types/parts'

export type BatchAction = 'print' | 'dispatch'
export type SelectedRowType = 'PART' | 'ASSEMBLY'

interface TableRef {
  clearSelection(): void
  toggleRowSelection(row: PartListItem, selected: boolean): void
}

export interface UsePartBatchSelectionDeps {
  items: Ref<PartListItem[]>
  /** 返回 el-table ref；可能为 null（mount 前 / 组件卸载后） */
  getTable: () => TableRef | null | undefined
}

export function usePartBatchSelection(deps: UsePartBatchSelectionDeps) {
  const batchMode = ref(false)
  const batchAction = ref<BatchAction>('print')
  const selectedRows = ref<PartListItem[]>([])
  /** 跨页选择真实状态来源：所有已选行的 id（含非当前页）。
   *  2026-07-22 bugfix：必须用 reactive 包一层，否则模板里的 .size 不响应，
   *  count 永远 0、按钮永远 disabled。 */
  const selectedIds = reactive(new Set<string>())
  /** 2026-07-30：记录每个选中 id 的行类型，用于批量打印拆分 */
  const selectedRowTypes = reactive(new Map<string, SelectedRowType>())

  // ============ count ============
  // 2026-07-31：批量栏拆分计数（零件 / 装配件）。两个 computed 双校验：
  // 只把「仍在 selectedIds 中 + 有类型记录」的 id 计进来，避免 selectedRowTypes
  // 残留 id 被算成有效计数。
  const batchSelectedPartCount = computed(() => {
    let n = 0
    for (const [id, t] of selectedRowTypes) {
      if (selectedIds.has(id) && t !== 'ASSEMBLY') n++
    }
    return n
  })
  const batchSelectedAssemblyCount = computed(() => {
    let n = 0
    for (const [id, t] of selectedRowTypes) {
      if (selectedIds.has(id) && t === 'ASSEMBLY') n++
    }
    return n
  })

  // ============ selectable ============
  function isBatchSelectable(row: PartListItem): boolean {
    if (batchAction.value === 'print') {
      // 2026-08-01 (revised)：批量打印允许勾选所有顶层行——
      // 独立零件（row_type='PART' && !__is_child）+ 装配件行（row_type='ASSEMBLY'）。
      // 顶层行在 el-table 中即为最外层可见行（items.value 顶层）；子件 row_key 是
      // CHILD_${id}，loadChildren 设了 __is_child=true，必须禁用避免双重打印。
      // 单个子件打印走 PartDetail 详情页（FileListCard → printPartDrawing）。
      return !(row as { __is_child?: boolean }).__is_child
    }
    // 下发模式：仅未下发零件（PENDING）；保持原语义，装配件+子件都不能整批下发。
    return row.status === 'PENDING' && row.row_type !== 'ASSEMBLY'
  }

  // ============ 生命周期 ============
  function clearAllSelection(): void {
    selectedIds.clear()
    selectedRows.value = []
    selectedRowTypes.clear()
    deps.getTable()?.clearSelection()
  }

  function onEnterBatchMode(): void {
    batchAction.value = 'print'
    batchMode.value = true
    clearAllSelection()
  }
  function onEnterBatchDispatchMode(): void {
    batchAction.value = 'dispatch'
    batchMode.value = true
    clearAllSelection()
  }
  function onExitBatchMode(): void {
    batchMode.value = false
    clearAllSelection()
  }

  // ============ selection-change 合并 ============
  // 按 ID 合并：先移除当前页所有 ID（不论是否还在 rows 中），再加入 rows 中可选行的 ID
  // 关键：必须同步清理 selectedRowTypes，否则取消勾选会在 Map 里残留，
  // onBatchPrint 遍历 selectedRowTypes 时会把残留 id 当成有效选择送给后端（Bug 3）。
  function onSelectionChange(rows: PartListItem[]): void {
    const currentPageIds = new Set(deps.items.value.map((r) => r.id))
    for (const id of [...selectedIds]) {
      if (currentPageIds.has(id)) {
        selectedIds.delete(id)
        selectedRowTypes.delete(id)
      }
    }
    for (const r of rows) {
      if (isBatchSelectable(r)) {
        selectedIds.add(r.id)
        selectedRowTypes.set(r.id, r.row_type === 'ASSEMBLY' ? 'ASSEMBLY' : 'PART')
      }
    }
    rebuildSelectedRows(rows)
  }

  function onSelectAllPage(): void {
    const table = deps.getTable()
    if (!table) return
    for (const row of deps.items.value) {
      if (isBatchSelectable(row)) {
        table.toggleRowSelection(row, true)
        selectedIds.add(row.id)
        selectedRowTypes.set(row.id, row.row_type === 'ASSEMBLY' ? 'ASSEMBLY' : 'PART')
      }
    }
    rebuildSelectedRows(deps.items.value)
  }

  function onClearSelection(): void {
    clearAllSelection()
  }

  /** 重新构建 selectedRows：当前页用最新 row 对象，其他页保留既有快照。 */
  function rebuildSelectedRows(currentPageRows: PartListItem[]): void {
    const pageMap = new Map(currentPageRows.map((r) => [r.id, r]))
    const next: PartListItem[] = []
    const seen = new Set<string>()
    for (const id of selectedIds) {
      const fromPage = pageMap.get(id)
      if (fromPage) {
        next.push(fromPage)
      } else {
        const fromSnapshot = selectedRows.value.find((r) => r.id === id)
        if (fromSnapshot) next.push(fromSnapshot)
      }
      seen.add(id)
    }
    selectedRows.value = next
  }

  function onBatchRowClick(
    row: PartListItem,
    _column: unknown,
    _event: MouseEvent,
  ): void {
    if (!batchMode.value) return
    if (!isBatchSelectable(row)) return
    const table = deps.getTable()
    if (!table) return
    const shouldSelect = !selectedIds.has(row.id)
    table.toggleRowSelection(row, shouldSelect)
    // toggleRowSelection 不会同步触发 @selection-change（在已保留勾选状态下切换时
    // 视实现可能不触发），所以这里手动维护 selectedIds/selectedRows/selectedRowTypes。
    if (shouldSelect) {
      selectedIds.add(row.id)
      selectedRowTypes.set(row.id, row.row_type === 'ASSEMBLY' ? 'ASSEMBLY' : 'PART')
      if (!selectedRows.value.find((r) => r.id === row.id)) {
        selectedRows.value = [...selectedRows.value, row]
      }
    } else {
      selectedIds.delete(row.id)
      selectedRowTypes.delete(row.id)
      selectedRows.value = selectedRows.value.filter((r) => r.id !== row.id)
    }
  }

  /** fetchList 更新 items 后用 nextTick 恢复当前页 checkbox UI。
   *  2026-07-31：保留跨页选择（不主动剔除「不在当前页」的 id）；仅清理不可选项。
   *  必须同步清理 selectedRowTypes，否则 onBatchPrint 遍历 Map 时残留 id 会被当成
   *  有效选择送给后端（Bug 3 路径 2）。 */
  function restoreTableSelection(): void {
    if (!batchMode.value) return
    const table = deps.getTable()
    if (!table) return
    for (const r of deps.items.value) {
      if (!isBatchSelectable(r)) {
        selectedIds.delete(r.id)
        selectedRowTypes.delete(r.id)
      }
    }
    // 同步 row types（防止 items 刷新后类型变化，如装配件状态翻转）
    for (const r of deps.items.value) {
      if (selectedIds.has(r.id)) {
        selectedRowTypes.set(r.id, r.row_type === 'ASSEMBLY' ? 'ASSEMBLY' : 'PART')
      }
    }
    rebuildSelectedRows(deps.items.value)
    nextTick(() => {
      const t = deps.getTable()
      if (!t) return
      t.clearSelection()
      for (const row of deps.items.value) {
        if (selectedIds.has(row.id)) {
          t.toggleRowSelection(row, true)
        }
      }
    })
  }

  return {
    // state
    batchMode,
    batchAction,
    selectedRows,
    selectedIds,
    selectedRowTypes,
    batchSelectedPartCount,
    batchSelectedAssemblyCount,
    // helpers
    isBatchSelectable,
    clearAllSelection,
    onEnterBatchMode,
    onEnterBatchDispatchMode,
    onExitBatchMode,
    onSelectionChange,
    onSelectAllPage,
    onClearSelection,
    rebuildSelectedRows,
    onBatchRowClick,
    restoreTableSelection,
  }
}
