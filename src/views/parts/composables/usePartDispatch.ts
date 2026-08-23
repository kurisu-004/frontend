// views/parts/composables/usePartDispatch.ts
//
// 2026-08-22 从 PartsList.vue 抽出：单件下发 + 批量下发 + 召回（2026-08-05）。
//
// 2026-08-22：不用 useDialogSize（弹窗 size 在模板里写死即可，避免引入额外 composable
// 依赖）。

import { ref, type Ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  placeOnShelf,
  recallToPending,
  recallToProgramming,
  sendToProgramming,
} from '@/api/parts'
import { listShelves } from '@/api/shelves'
import { listProcesses } from '@/api/process'
import type { Shelf } from '@/types/shelf'
import type { Process } from '@/types/process'
import type { PartListItem } from '@/types/parts'
import { useShelfProcessFilter } from '@/composables/useShelfProcessFilter'
import { useAuthSession } from '@/composables/useAuthSession'
import type { SelectedRowType } from './usePartBatchSelection'

interface TableRef {
  toggleRowSelection(row: PartListItem, selected: boolean): void
}

export interface UsePartDispatchDeps {
  fetchList: () => Promise<void>
  selectedIds: Set<string>
  selectedRows: Ref<PartListItem[]>
  selectedRowTypes: Map<string, SelectedRowType>
  getTable: () => TableRef | null | undefined
}

export function usePartDispatch(deps: UsePartDispatchDeps) {
  // ============ 共享数据 ============
  const shelves = ref<Shelf[]>([])
  const processes = ref<Process[]>([])

  // ============ 单件下发 ============
  const dispatchVisible = ref(false)
  const dispatchMode = ref<'direct' | 'cnc'>('direct')
  const dispatchShelfId = ref<string | null>(null)
  const dispatchNextProcessId = ref<string | null>(null)
  const dispatchPartId = ref<string | null>(null)
  const dispatchSubmitting = ref(false)
  // 2026-07-17：useShelfProcessFilter 双向收窄货架/工序下拉
  const {
    filteredShelves,
    filteredProcesses,
    load: loadShelfProcessMap,
  } = useShelfProcessFilter(
    shelves,
    processes,
    dispatchShelfId,
    dispatchNextProcessId,
  )

  async function onDispatch(row: PartListItem): Promise<void> {
    dispatchPartId.value = row.id
    dispatchShelfId.value = null
    dispatchNextProcessId.value = null
    dispatchMode.value = 'direct'
    try {
      const [shelfResp, procResp] = await Promise.all([
        listShelves({ zone: 'PRODUCTION', is_active: true, limit: 200 }),
        listProcesses({ limit: 200 }),
      ])
      shelves.value = shelfResp.items
      processes.value = procResp.items
      // 2026-07-17：弹窗打开后异步加载映射（不阻塞 dialog 出现）
      void loadShelfProcessMap()
    } catch {
      shelves.value = []
      processes.value = []
    }
    dispatchVisible.value = true
  }

  function onDispatchClosed(): void {
    dispatchPartId.value = null
    dispatchShelfId.value = null
    dispatchNextProcessId.value = null
    dispatchMode.value = 'direct'
  }

  async function onDispatchConfirm(): Promise<void> {
    if (!dispatchPartId.value) return
    if (dispatchMode.value === 'direct'
      && (!dispatchShelfId.value || !dispatchNextProcessId.value)) return
    dispatchSubmitting.value = true
    try {
      if (dispatchMode.value === 'cnc') {
        await sendToProgramming(dispatchPartId.value)
        ElMessage.success('已发送至 CNC 编程')
      } else {
        await placeOnShelf(
          dispatchPartId.value,
          dispatchShelfId.value!,
          dispatchNextProcessId.value!,
        )
        ElMessage.success('下发成功')
      }
      dispatchVisible.value = false
      void deps.fetchList()
    } catch (e) {
      ElMessage.error((e as Error).message ?? '下发失败')
    } finally {
      dispatchSubmitting.value = false
    }
  }

  // ============ 批量下发 ============
  // 状态完全独立于单件下发（batchDispatchShelfId / batchDispatchNextProcessId），避免互相踩。
  const batchDispatchVisible = ref(false)
  const batchDispatchAction = ref<'shelf' | 'programming'>('shelf')
  const batchDispatchShelfId = ref<string | null>(null)
  const batchDispatchNextProcessId = ref<string | null>(null)
  const batchDispatchSubmitting = ref(false)
  const {
    filteredShelves: batchFilteredShelves,
    filteredProcesses: batchFilteredProcesses,
    load: loadBatchShelfProcessMap,
  } = useShelfProcessFilter(
    shelves,
    processes,
    batchDispatchShelfId,
    batchDispatchNextProcessId,
  )

  async function onOpenBatchDispatch(): Promise<void> {
    if (deps.selectedIds.size === 0) {
      ElMessage.warning('请先选择待下发零件')
      return
    }
    batchDispatchAction.value = 'shelf'
    batchDispatchShelfId.value = null
    batchDispatchNextProcessId.value = null
    // 货架/工序数据复用模块级缓存，按需首次加载
    if (shelves.value.length === 0) {
      try {
        shelves.value = (await listShelves({
          zone: 'PRODUCTION', is_active: true, limit: 200,
        })).items
      } catch { shelves.value = [] }
    }
    if (processes.value.length === 0) {
      try {
        processes.value = (await listProcesses({ limit: 200 })).items
      } catch { processes.value = [] }
    }
    void loadBatchShelfProcessMap()
    batchDispatchVisible.value = true
  }

  async function onBatchDispatchConfirm(): Promise<void> {
    if (deps.selectedIds.size === 0) return
    if (batchDispatchAction.value === 'shelf'
      && (!batchDispatchShelfId.value || !batchDispatchNextProcessId.value)) return
    // 快照：迭代过程中会修改 selectedIds/selectedRows
    const targets = deps.selectedRows.value
      .filter((r) => deps.selectedIds.has(r.id))
      .map((r) => ({ id: r.id, label: r.serial_no || r.drawing_no || r.id }))
    if (targets.length === 0) {
      ElMessage.warning('当前页没有已选零件，请翻到已选页或重新选择')
      return
    }

    const failures: { label: string; message: string }[] = []
    let successCount = 0
    batchDispatchSubmitting.value = true
    try {
      for (const t of targets) {
        try {
          if (batchDispatchAction.value === 'programming') {
            await sendToProgramming(t.id)
          } else {
            await placeOnShelf(
              t.id,
              batchDispatchShelfId.value!,
              batchDispatchNextProcessId.value!,
            )
          }
          successCount++
          // 成功项：移出三个状态源（selectedIds / selectedRowTypes / selectedRows）
          deps.selectedIds.delete(t.id)
          deps.selectedRowTypes.delete(t.id)
          const tbl = deps.getTable()
          const row = deps.selectedRows.value.find((r) => r.id === t.id)
          if (tbl && row) tbl.toggleRowSelection(row, false)
          // 注：selectedRows.value 是 ref，这里通过 deps.selectedRows（Ref）改值
          deps.selectedRows.value = deps.selectedRows.value.filter((r) => r.id !== t.id)
        } catch (e) {
          failures.push({
            label: t.label,
            message: (e as Error).message ?? '未知错误',
          })
        }
      }
      if (successCount > 0) ElMessage.success(`成功下发 ${successCount} 件`)
      if (failures.length > 0) {
        ElMessage.error(
          `失败 ${failures.length} 件：${failures
            .map((f) => `${f.label}（${f.message}）`)
            .join('；')}`,
        )
      }
      if (failures.length === 0) batchDispatchVisible.value = false
      await deps.fetchList()  // 内部 nextTick → restoreTableSelection
    } finally {
      batchDispatchSubmitting.value = false
    }
  }

  // ============ 召回（2026-08-05）============
  const { hasRole } = useAuthSession()
  // 2026-08-05 召回权限：与后端 POST /parts/{id}/recall-* 一致
  const canRecallToPendingAuth = hasRole('MANAGER') || hasRole('CLERK')
  const canRecallToProgrammingAuth =
    hasRole('MANAGER') || hasRole('CNC_PROGRAMMER')

  /** 召回按钮可见性：与后端 `_resolve_target_batch` expect 保持一致。
   *  不显式判定 status=='PROGRAMMING'：PROGRAMMING 是 PROGRAMMING DB status；
   *  行 location 在该态下为 'OFFICE'，自然被排除。 */
  function canRecallToPending(row: PartListItem): boolean {
    if (!canRecallToPendingAuth) return false
    if (row.row_type === 'ASSEMBLY') return false
    if (row.status === 'PROGRAMMING') return true
    return row.status === 'IN_PROCESS' && row.location === 'PRODUCTION_SHELF'
  }

  function canRecallToProgramming(row: PartListItem): boolean {
    if (!canRecallToProgrammingAuth) return false
    if (row.row_type === 'ASSEMBLY') return false
    return row.status === 'IN_PROCESS' && row.location === 'PRODUCTION_SHELF'
  }

  async function onRecallToPending(row: PartListItem): Promise<void> {
    const label = row.serial_no || row.drawing_no || row.id
    try {
      await ElMessageBox.confirm(
        `确认召回「${label}」为待生产？`,
        '召回确认',
        { type: 'warning', confirmButtonText: '确认召回', cancelButtonText: '取消' },
      )
    } catch {
      // 用户取消
      return
    }
    try {
      await recallToPending(row.id, { batch_id: row.batch_id ?? null })
      ElMessage.success('已召回为待生产')
      void deps.fetchList()
    } catch (e) {
      ElMessage.error((e as Error).message ?? '召回失败')
    }
  }

  async function onRecallToProgramming(row: PartListItem): Promise<void> {
    const label = row.serial_no || row.drawing_no || row.id
    try {
      await ElMessageBox.confirm(
        `确认召回「${label}」为待编程？`,
        '召回确认',
        { type: 'warning', confirmButtonText: '确认召回', cancelButtonText: '取消' },
      )
    } catch {
      // 用户取消
      return
    }
    try {
      await recallToProgramming(row.id, { batch_id: row.batch_id ?? null })
      ElMessage.success('已召回为待编程')
      void deps.fetchList()
    } catch (e) {
      ElMessage.error((e as Error).message ?? '召回失败')
    }
  }

  return {
    // 共享数据
    shelves,
    processes,
    // 单件下发
    dispatchVisible,
    dispatchMode,
    dispatchShelfId,
    dispatchNextProcessId,
    dispatchPartId,
    dispatchSubmitting,
    filteredShelves,
    filteredProcesses,
    onDispatch,
    onDispatchClosed,
    onDispatchConfirm,
    // 批量下发
    batchDispatchVisible,
    batchDispatchAction,
    batchDispatchShelfId,
    batchDispatchNextProcessId,
    batchDispatchSubmitting,
    batchFilteredShelves,
    batchFilteredProcesses,
    onOpenBatchDispatch,
    onBatchDispatchConfirm,
    // 召回
    canRecallToPending,
    canRecallToProgramming,
    onRecallToPending,
    onRecallToProgramming,
  }
}
