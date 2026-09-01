// composables/useOutsourceReceivingList.ts
//
// 待接收 tab 的业务状态 + 业务函数（2026-08-25 T12 从 OutsourceSendReceive.vue 抽出）。
//
// 持有：
//   - receivingFilter：filter bar 持久化（pageSize 不再持久化，详见 2026-08-31 注释）
//   - receivingPagedRef：<PagedTable> 模板 ref
//   - shelves / processes：页级 lookup（接收 dialog 用；shell 装载后通过 setter 注入）
//   - receiveDialogVisible / receiveTarget / receiveBranch / receiveShelf /
//     receiveProcess / receiveQuantity / receiveSubmitting：接收 dialog 状态
//   - useShelfProcessFilter 双向收窄（仅 production 分支）
//
// 不持有：
//   - customers（页级共享 lookup，由 shell 持有并下传）
//   - activeTab（页级 shell 持有）
//   - 发送 tab 相关状态
//
// 子组件约定：
//   - OutsourceReceivingTab 通过 props 读 receivingFilter / receiveDialogXxx，
//     通过 defineExpose 把 refresh() 暴露给页级 shell 用于「发送后联动刷新」。

import { computed, reactive, ref, type Ref } from 'vue'
import { ElMessage } from 'element-plus'
import { listOutsourceInFlight } from '@/api/outsource'
import {
  receiveFromOutsource,
  toInspection,
} from '@/api/parts'
import { useConfirm } from '@/composables/useConfirm'
import { useListStatePersist } from '@/composables/useListFilterPersist'
import { useShelfProcessFilter } from '@/composables/useShelfProcessFilter'
import type { Process } from '@/types/process'
import type { OutsourceInFlightItem } from '@/types/outsource'
import type { Shelf as ShelfItem } from '@/types/shelf'

type Branch = 'production' | 'inspection'

export interface UseOutsourceReceivingListOptions {
  shelves: Ref<readonly ShelfItem[]>
  processes: Ref<readonly Process[]>
}

export function useOutsourceReceivingList(
  options: UseOutsourceReceivingListOptions,
) {
  const { dangerous: confirmDangerous } = useConfirm()

  // ============ 列表 filter（持久化） ============
  // 2026-08-31 双实例修复：pageSize 不再持久化（与 PartListShell 一致），
  // 每次进入视图从 <PagedTable :default-page-size="20"> 起算。
  const receivingError = ref<string | null>(null)
  const receivingFilter = reactive({ keyword: '', customer_id: '' })
  const receivingPagedRef = ref()

  // 待接收 tab 持久化（2026-07-30 commit 4B）；2026-08-25 T7：page 不再持久化
  const persist = useListStatePersist(
    'outsource_send_receive_receiving',
    { receivingFilter },
  )

  // ============ 加急行红底 ============
  function receivingRowClassName({ row }: { row: OutsourceInFlightItem }): string {
    return row.is_urgent ? 'row-urgent' : ''
  }

  async function receivingFetcher(params: { page: number; pageSize: number }) {
    receivingError.value = null
    try {
      const items = await listOutsourceInFlight({
        keyword: receivingFilter.keyword || undefined,
        limit: params.pageSize,
        offset: (params.page - 1) * params.pageSize,
      })
      return { items, total: items.length }
    } catch (e) {
      receivingError.value = (e as Error).message ?? '加载待接收列表失败'
      ElMessage.error(receivingError.value)
      return { items: [], total: 0 }
    }
  }

  async function refreshReceiving(): Promise<void> {
    await receivingPagedRef.value?.fetch()
  }

  function onReceivingSearch(): void {
    void receivingPagedRef.value?.reset()
  }
  function onReceivingReset(): void {
    receivingFilter.keyword = ''
    receivingFilter.customer_id = ''
    void receivingPagedRef.value?.reset()
  }

  // ============ 接收 dialog 状态 ============
  const receiveDialogVisible = ref(false)
  const receiveTarget = ref<OutsourceInFlightItem | null>(null)
  const receiveSubmitting = ref(false)
  const receiveQuantity = ref<number>(0)
  const receiveBranch = ref<Branch>('production')
  const receiveShelf = ref('')
  const receiveProcess = ref('')

  // 分支对应货架 / 工序过滤（壳里拿到的 shelves / processes 是只读 lookup）
  const productionShelves = computed(() =>
    options.shelves.value.filter((s) => s.zone === 'PRODUCTION' && s.is_active),
  )
  const inspectionShelves = computed(() =>
    options.shelves.value.filter((s) => s.zone === 'INSPECTION' && s.is_active),
  )
  const inhouseProcesses = computed(() =>
    options.processes.value.filter((p) => p.category === 'INHOUSE'),
  )

  // 2026-07-17：useShelfProcessFilter 双向收窄（仅 production 分支）。
  // inspection 分支无 next_process，走 INSPECTION 货架不过滤。
  const {
    filteredShelves: filteredProductionShelves,
    filteredProcesses: filteredInhouseProcesses,
    load: loadReceiveMap,
  } = useShelfProcessFilter(
    productionShelves,
    inhouseProcesses,
    computed({
      get: () => receiveShelf.value || null,
      set: (v) => { receiveShelf.value = v ?? '' },
    }),
    computed({
      get: () => receiveProcess.value || null,
      set: (v) => { receiveProcess.value = v ?? '' },
    }),
  )

  function openReceive(row: OutsourceInFlightItem): void {
    receiveTarget.value = row
    receiveBranch.value = 'production'
    receiveShelf.value = ''
    receiveProcess.value = ''
    receiveQuantity.value = row.quantity
    receiveDialogVisible.value = true
    // 2026-07-17：弹窗打开后异步加载映射（仅在 shelves/processes 已就绪时有效）
    void loadReceiveMap()
  }

  function onReceiveDialogClosed(): void {
    receiveTarget.value = null
    receiveShelf.value = ''
    receiveProcess.value = ''
    receiveBranch.value = 'production'
  }

  const receiveBranchLabel = computed(() =>
    receiveBranch.value === 'production'
      ? '进入生产货架继续加工'
      : '品检',
  )

  async function onConfirmReceive(): Promise<void> {
    if (!receiveTarget.value) return
    if (!receiveShelf.value) {
      ElMessage.warning('请选择货架')
      return
    }
    if (receiveBranch.value === 'production' && !receiveProcess.value) {
      ElMessage.warning('生产分支请选择下一道 INHOUSE 工序')
      return
    }
    if (receiveQuantity.value < 1 || receiveQuantity.value > receiveTarget.value.quantity) {
      ElMessage.warning(`数量必须在 1 ~ ${receiveTarget.value.quantity} 之间`)
      return
    }
    if (!await confirmDangerous(
      '接收外协件',
      `确认接收「${receiveTarget.value.drawing_no}」（批次 ${receiveTarget.value.batch_no}，${receiveQuantity.value} / ${receiveTarget.value.quantity} 件，${receiveBranchLabel.value}）？`,
      { type: 'warning', confirmText: '确认接收', cancelText: '取消' },
    )) return
    receiveSubmitting.value = true
    try {
      const qty = receiveQuantity.value === receiveTarget.value.quantity ? null : receiveQuantity.value
      if (receiveBranch.value === 'production') {
        await receiveFromOutsource(receiveTarget.value.part_id, {
          shelf_id: receiveShelf.value,
          next_process_id: receiveProcess.value,
          batch_id: receiveTarget.value.batch_id,
          quantity: qty,
        })
        ElMessage.success('已下发到生产货架')
      } else {
        // 2026-08-28 路线 B：OUTSOURCE → INSPECTION 走 toInspection（仅送检，不自动 PASS）。
        // 后续由品检员手动 toShip。
        // 2026-09-01：toInspection 已回退 v1（Python FastAPI
        //   /parts/{id}/receive-from-outsource-to-inspection），
        //   payload 字段名 `shelf_id`，无 `version`（OCC 锚由 v1 service 层按
        //   t_part_batch 处理，无需前端传）。
        await toInspection(receiveTarget.value.part_id, {
          shelf_id: receiveShelf.value,
          batch_id: receiveTarget.value.batch_id,
          quantity: qty,
        })
        ElMessage.success('已送检，等待品检')
      }
      receiveDialogVisible.value = false
      await refreshReceiving()
      // PR-H 2026-07-29：「已接收历史」tab 已移除（功能由 per-company 对账页承担）
    } catch (e) {
      ElMessage.error((e as Error).message ?? '操作失败')
    } finally {
      receiveSubmitting.value = false
    }
  }

  return {
    // state
    receivingError,
    receivingFilter,
    receivingPagedRef,
    receiveDialogVisible,
    receiveTarget,
    receiveSubmitting,
    receiveQuantity,
    receiveBranch,
    receiveShelf,
    receiveProcess,
    // 派生
    inspectionShelves,
    filteredProductionShelves,
    filteredInhouseProcesses,
    receiveBranchLabel,
    // 持久化恢复（shell 在 onMounted 里调一次，把 snapshot 写回 receivingFilter / pageSize）
    restore: persist.restore,
    snapshot: persist.snapshot,
    clearPersisted: persist.clear,
    // handlers
    receivingFetcher,
    refreshReceiving,
    onReceivingSearch,
    onReceivingReset,
    receivingRowClassName,
    openReceive,
    onReceiveDialogClosed,
    onConfirmReceive,
  }
}