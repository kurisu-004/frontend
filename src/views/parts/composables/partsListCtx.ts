// views/parts/composables/partsListCtx.ts
//
// 2026-08-22 从 PartsList.vue 拆分重构中新增：子组件通信契约。
//
// 设计：所有子组件（PartsTable / BatchBar / DispatchDialog 等）通过 :ctx prop
// 接收整个 composable 群组；不用 provide/inject（避免组件树层级混乱，
// 子组件相互之间无强耦合）。
//
// 每个子组件可从 ctx 里按需取自己关心的 ref/computed/function，
// 由调用方在模板里负责 .value 解包。

import type { Ref } from 'vue'
import type { usePartsListQuery } from './usePartsListQuery'
import type { usePartsColumnFilters } from './usePartsColumnFilters'
import type { usePartInlineEdit } from './usePartInlineEdit'
import type { usePartBatchSelection } from './usePartBatchSelection'
import type { useBatchPrint } from './useBatchPrint'
import type { usePartDispatch } from './usePartDispatch'
import type { useColumnVisibility } from '@/composables/useColumnVisibility'

/** 视图对外暴露的所有 composable 集合 + 视图级权限/配置。 */
export interface PartsListCtx {
  query: ReturnType<typeof usePartsListQuery>
  filters: ReturnType<typeof usePartsColumnFilters>
  edit: ReturnType<typeof usePartInlineEdit>
  batch: ReturnType<typeof usePartBatchSelection>
  print: ReturnType<typeof useBatchPrint>
  dispatch: ReturnType<typeof usePartDispatch>
  /** MANAGER / CLERK 行内编辑 + 下发 + 批量模式可见性 */
  canEdit: boolean
  /** CNC 编程员视图（默认 statuses=['PROGRAMMING']） */
  isCncProgrammer: boolean
  columnVisibility: ReturnType<typeof useColumnVisibility>
  columnDefs: readonly { readonly key: string; readonly label: string }[]
}

/** el-table 子组件 ref 透出类型（封装 clearSelection / toggleRowSelection / sort）。
 *
 *  2026-08-22：模板里嵌套对象里的 ref 不会自动解包，由消费侧（PartsTable.vue）解到
 *  顶层局部变量后再用。这里只保证字段形状。 */
export type PartsTableRef = Ref<{
  clearSelection(): void
  toggleRowSelection(row: unknown, selected: boolean): void
  sort(prop: string, order: 'ascending' | 'descending' | null): void
} | null>
