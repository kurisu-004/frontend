// 2026-08-26 新增：Sortable 拖拽 wiring（pool ↔ worker columns 跨列拖动）。
// 监听 onAdd：源 → 目标的迁移。源信息从被拖元素的 data-* 读出（由 WorkOrderCard 暴露）。
//
// 调用时机：父页面 onMounted 后 nextTick，确保 .col-body / .section-body 已挂载。

import Sortable from 'sortablejs'
import { ElMessage } from 'element-plus'

interface DndCallbacks {
  moveBatchToWorker: (
    batch_id: string,
    to_worker_id: string,
    shelf_id: string,
    process_id: string,
  ) => Promise<boolean>
  moveBatchToPool: (
    batch_id: string,
    from_worker_id: string,
    shelf_id: string,
    next_process_id: string,
  ) => Promise<boolean>
  shelfId: string
}

export function useSortableDnd(cb: DndCallbacks): { cleanup: () => void } {
  const instances: Sortable[] = []

  // 1. pool sections（每个工序一个 Sortable 实例）
  document.querySelectorAll<HTMLElement>('.section-body').forEach((el) => {
    const processId = el.dataset.processId ?? ''
    const s = Sortable.create(el, {
      group: 'work-orders',
      animation: 150,
      ghostClass: 'sortable-ghost',
      onAdd: async (evt) => {
        const cardEl = evt.item as HTMLElement
        const batchId = cardEl.dataset.batchId
        const fromWorkerId = cardEl.dataset.fromWorkerId
        if (!batchId || !fromWorkerId) {
          // 异常来源：从 worker column 拖进来但缺少来源信息 → 拒绝
          cardEl.remove()
          ElMessage.error('无法识别工单来源')
          return
        }
        const ok = await cb.moveBatchToPool(batchId, fromWorkerId, cb.shelfId, processId)
        if (!ok) {
          // 失败时让 Sortable 把元素移回原处（乐观更新已回滚，所以这里只是清理 DOM 残留）
          cardEl.remove()
          ElMessage.error('撤回失败')
        } else {
          ElMessage.success(`已撤回工单到工序 ${processId}`)
        }
      },
    })
    instances.push(s)
  })

  // 2. worker columns（每个工人一个 Sortable 实例）
  document.querySelectorAll<HTMLElement>('.col-body').forEach((el) => {
    const workerId = el.dataset.workerId ?? ''
    const s = Sortable.create(el, {
      group: 'work-orders',
      animation: 150,
      ghostClass: 'sortable-ghost',
      onAdd: async (evt) => {
        const cardEl = evt.item as HTMLElement
        const batchId = cardEl.dataset.batchId
        const fromProcessId = cardEl.dataset.fromProcessId
        if (!batchId || !fromProcessId) {
          cardEl.remove()
          ElMessage.error('无法识别工单来源')
          return
        }
        const ok = await cb.moveBatchToWorker(batchId, workerId, cb.shelfId, fromProcessId)
        if (!ok) {
          cardEl.remove()
          ElMessage.error('分配失败（工人可能已满）')
        } else {
          ElMessage.success(`已分配给工人 ${workerId}`)
        }
      },
    })
    instances.push(s)
  })

  return {
    cleanup: () => {
      instances.forEach((s) => s.destroy())
      instances.length = 0
    },
  }
}