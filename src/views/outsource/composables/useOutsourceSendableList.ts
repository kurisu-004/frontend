// composables/useOutsourceSendableList.ts
//
// 可发送 tab 的业务状态 + 业务函数（2026-08-25 T12 从 OutsourceSendReceive.vue 抽出）。
//
// 持有：
//   - sendableFilter / sendablePageSize：filter bar + 分页持久化
//   - sendablePagedRef：<PagedTable> 模板 ref（用于 fetch / reset / 读 pageSize）
//   - sendQueue / batchSending / scanInput：扫码批量发送队列（PR-I 2026-07-20）
//   - sendDialogVisible / sendTarget / sendSelectedCompanyId / sendQuantity /
//     sendSubmitting：发送 dialog 状态（行级 + 扫码级共用）
//
// 不持有：
//   - customers（页级共享 lookup，由 shell 持有并下传）
//   - activeTab（页级 shell 持有）
//   - 接收 tab 相关状态
//
// 子组件约定：
//   - OutsourceSendableTab 通过 props 读 sendableFilter / sendQueue / sendDialogXxx，
//     通过 emit('sent') 把发送成功事件上抛给页级 shell，
//     shell 收到后调 receivingTabRef.refresh() 联动刷新「待接收」tab。
//
// 跨 composable 通信：
//   - opts.onSent()：发送成功（单件 + 批量均会触发）→ shell 拿这个钩子去刷 receiving tab。
//     这里不直接持有 receiving tab 的 refresh 引用，是为了保持 composable 单例纯净。

import { ElMessage } from 'element-plus'
import { reactive, ref } from 'vue'
import {
  getPartBySerial,
  listOutsourceSendable,
  sendToOutsource as sendPartToOutsource,
  type PartItem,
  type SendToOutsourcePayload,
} from '@/api/parts'
import { useConfirm } from '@/composables/useConfirm'
import { useListStatePersist } from '@/composables/useListFilterPersist'
import type {
  ApprovedQuoteForSendItem,
  OutsourceSendableItem,
} from '@/types/outsource'
import type { DirectOutsourceCandidateItem } from '@/types/directOutsource'

/** 与 OutsourceSendReceive.vue 同步：合并后的可发送项类型别名 */
export type SendableItem = OutsourceSendableItem

export interface SendQueueItem {
  part: { id: string; serial_no: string; drawing_no: string; name: string }
  outsource_company_id: string
  outsource_company_name: string
  process_id: string
  process_name: string
  /** 直接发送时为 null；APPROVAL 时为单件报价 */
  price: number | null
  /** OCC：发送时必传（批次 TPartBatch.version） */
  version: number
  /** 2026-07-29 PR-fix-0.2.0 批次化：可发送批次 id（雪花 ID 字符串） */
  batch_id: string
  /** 2026-07-30：发送数量（默认批次全量） */
  quantity: number
  // 入队后做标记，给 UI 看
  _failed?: boolean
  _failMsg?: string
}

export interface UseOutsourceSendableListOptions {
  /** 发送成功后回调（shell 用来触发 receiving tab 刷新） */
  onSent?: () => void
}

export function useOutsourceSendableList(
  options: UseOutsourceSendableListOptions = {},
) {
  const { dangerous: confirmDangerous } = useConfirm()

  // ============ 列表 filter + 分页（持久化） ============
  const sendableError = ref<string | null>(null)
  const sendableFilter = reactive({ keyword: '', customer_id: '' })
  const sendablePagedRef = ref()
  // pageSize 持久化镜像（与 T7 同步：PagedTable.pageSize → view 本地 pageSize）
  const sendablePageSize = ref(20)

  // 可发送 tab 持久化（2026-07-30 commit 4B）；2026-08-25 T7：page 不再持久化
  const persist = useListStatePersist(
    'outsource_send_receive_sendable',
    { sendableFilter, sendablePageSize },
  )

  async function sendableFetcher(params: { page: number; pageSize: number }) {
    sendableError.value = null
    try {
      const r = await listOutsourceSendable({
        keyword: sendableFilter.keyword || undefined,
        customer_id: sendableFilter.customer_id || undefined,
        limit: params.pageSize,
        offset: (params.page - 1) * params.pageSize,
      })
      return { items: r.items, total: r.total }
    } catch (e) {
      sendableError.value = (e as Error).message ?? '加载可发送列表失败'
      ElMessage.error(sendableError.value)
      return { items: [], total: 0 }
    }
  }

  async function refreshSendable(): Promise<void> {
    await sendablePagedRef.value?.fetch()
  }

  function onSendableSearch(): void {
    void sendablePagedRef.value?.reset()
  }
  function onSendableReset(): void {
    sendableFilter.keyword = ''
    sendableFilter.customer_id = ''
    void sendablePagedRef.value?.reset()
  }

  // ============ 加急行红底 ============
  function sendableRowClassName({ row }: { row: SendableItem }): string {
    return row.is_urgent ? 'row-urgent' : ''
  }

  // ============ 发送 dialog 状态 ============
  const sendDialogVisible = ref(false)
  const sendTarget = ref<SendableItem | null>(null)
  const sendSelectedCompanyId = ref<string>('')
  const sendQuantity = ref<number>(0)
  const sendSubmitting = ref(false)

  function canSend(item: SendableItem): boolean {
    if (item.status_label !== 'sendable') return false
    if (item.send_mode === 'DIRECT') {
      return item.company_options.length >= 1
    }
    // APPROVAL: outsource_company_id 由后端确定
    return true
  }

  function openSend(item: SendableItem): void {
    if (!canSend(item)) {
      ElMessage.warning('该零件当前状态不满足发送条件')
      return
    }
    sendTarget.value = item
    sendQuantity.value = item.batch_quantity
    // 直接发送：默认选第一家公司（不能为空数组；前端必有 ≥1）
    if (item.send_mode === 'DIRECT') {
      sendSelectedCompanyId.value = item.company_options[0]?.id ?? ''
    } else {
      sendSelectedCompanyId.value = ''
    }
    sendDialogVisible.value = true
  }

  async function onConfirmSend(): Promise<void> {
    if (!sendTarget.value) return
    const target = sendTarget.value
    if (target.send_mode === 'DIRECT' && !sendSelectedCompanyId.value) {
      ElMessage.warning('请选择外协公司')
      return
    }
    if (sendQuantity.value < 1 || sendQuantity.value > target.batch_quantity) {
      ElMessage.warning(`数量必须在 1 ~ ${target.batch_quantity} 之间`)
      return
    }
    const companyId: string = target.send_mode === 'DIRECT'
      ? sendSelectedCompanyId.value
      : (target.outsource_company_id ?? '')
    const companyName: string = target.send_mode === 'DIRECT'
      ? target.company_options.find((c) => c.id === sendSelectedCompanyId.value)?.name ?? ''
      : (target.outsource_company_name ?? '')
    if (!await confirmDangerous(
      '发送外协',
      `确认把「${target.part_drawing_no}」（批次 ${target.batch_no}，${sendQuantity.value} / ${target.batch_quantity} 件）发送到「${companyName}」？`,
      { type: 'warning', confirmText: '确认发送', cancelText: '取消' },
    )) return
    sendSubmitting.value = true
    try {
      const payload: SendToOutsourcePayload = {
        outsource_company_id: companyId,
        next_process_id: target.next_process_id,
        version: target.version,
        // 2026-07-29 PR-fix-0.2.0 批次化：显式携带 batch_id，
        // 多批次工单下避免 _resolve_target_batch fallback 选错批次。
        batch_id: target.batch_id,
        quantity: sendQuantity.value === target.batch_quantity ? null : sendQuantity.value,
      }
      await sendPartToOutsource(target.part_id, payload)
      ElMessage.success('已发送至外协')
      sendDialogVisible.value = false
      await refreshSendable()
      // 发送成功后该零件应出现在「待接收」tab，主动 refresh 一次
      options.onSent?.()
    } catch (e) {
      ElMessage.error((e as Error).message ?? '发送失败')
    } finally {
      sendSubmitting.value = false
    }
  }

  // ============ 扫码批量发送队列（PR-I 2026-07-20） ============
  const sendQueue = ref<SendQueueItem[]>([])
  const batchSending = ref(false)
  const scanInput = ref('')

  async function handleScannedSerialForSend(code: string): Promise<void> {
    const trimmed = code.trim()
    if (!trimmed) return
    let part: PartItem
    try {
      part = await getPartBySerial(trimmed)
    } catch (e) {
      ElMessage.error(`序列号 ${trimmed} 未找到：${(e as Error).message}`)
      return
    }
    // 已在队列里？
    if (sendQueue.value.find((q) => q.part.id === part.id)) {
      ElMessage.warning(`${part.serial_no ?? trimmed} 已在发送队列中`)
      return
    }
    // 必须在当前可发送列表里（status_label === 'sendable'）
    // 2026-08-25 T7：sendableItems 已迁到 PagedTable；通过暴露的 items 读取当前页
    const sendableList = (sendablePagedRef.value?.items?.value ?? []) as SendableItem[]
    const match = sendableList.find(
      (it) => it.part_id === part.id && it.status_label === 'sendable',
    )
    if (!match) {
      ElMessage.warning(`${part.serial_no ?? trimmed} 当前不在可发送列表（可能状态不满足或没有 APPROVED 报价）`)
      return
    }
    // 直接发送 + 多公司 → 强制用户先选公司（不让扫码盲目入队）
    if (match.send_mode === 'DIRECT' && match.company_options.length > 1) {
      sendTarget.value = match
      sendSelectedCompanyId.value = match.company_options[0]?.id ?? ''
      sendDialogVisible.value = true
      ElMessage.info('该外协工序映射了多家公司，请先在弹窗中选择后再扫码入队')
      return
    }
    // 直接发送 + 单公司 或 APPROVAL → 直接入队
    const companyId: string = match.send_mode === 'DIRECT'
      ? (match.company_options[0]?.id ?? '')
      : (match.outsource_company_id ?? '')
    const companyName: string = match.send_mode === 'DIRECT'
      ? (match.company_options[0]?.name ?? '')
      : (match.outsource_company_name ?? '')
    sendQueue.value.push({
      part: {
        id: part.id,
        serial_no: part.serial_no ?? '',
        drawing_no: part.drawing_no,
        name: part.name,
      },
      outsource_company_id: companyId,
      outsource_company_name: companyName,
      process_id: match.next_process_id ?? '',
      process_name: match.next_process_name ?? '',
      price: match.send_mode === 'DIRECT' ? null : Number(match.price),
      version: match.version,
      // 2026-07-29 PR-fix-0.2.0 批次化：携带 batch_id 供发送时回传
      batch_id: match.batch_id,
      // 2026-07-30：默认批次全量
      quantity: match.batch_quantity,
    })
    ElMessage.success(`已加入发送队列：${part.serial_no ?? trimmed}`)
  }

  function onScanInputEnter(): void {
    const code = scanInput.value
    scanInput.value = ''
    void handleScannedSerialForSend(code)
  }

  function onScanInputClear(): void {
    scanInput.value = ''
  }

  function removeFromSendQueue(idx: number): void {
    sendQueue.value.splice(idx, 1)
  }

  function clearSendQueue(): void {
    sendQueue.value = []
  }

  async function onConfirmBatchSend(): Promise<void> {
    if (sendQueue.value.length === 0) return
    if (!await confirmDangerous(
      '批量发送',
      `确认批量发送 ${sendQueue.value.length} 件零件到外协？`,
      { type: 'warning', confirmText: '确认发送', cancelText: '取消' },
    )) return  // 用户取消
    batchSending.value = true
    const errors: { serial: string; msg: string; idx: number }[] = []
    let okCount = 0
    // 串行 for 循环：避免并发踩状态机；失败项保留在队列可重试
    for (let i = 0; i < sendQueue.value.length; i++) {
      const item = sendQueue.value[i]
      try {
        const payload: SendToOutsourcePayload = {
          outsource_company_id: item.outsource_company_id,
          next_process_id: item.process_id,
          version: item.version,
          // 2026-07-29 PR-fix-0.2.0 批次化：显式携带 batch_id。
          batch_id: item.batch_id,
          quantity: item.quantity,
        }
        await sendPartToOutsource(item.part.id, payload)
        okCount++
        // 成功后从队列移除
        sendQueue.value.splice(i, 1)
        i--  // 抵消 splice 导致的位移
      } catch (e) {
        const msg = (e as Error).message ?? '未知错误'
        errors.push({
          serial: item.part.serial_no || item.part.drawing_no,
          msg,
          idx: i,
        })
        sendQueue.value[i]._failed = true
        sendQueue.value[i]._failMsg = msg
      }
    }
    batchSending.value = false
    if (okCount > 0) {
      ElMessage.success(`成功发送 ${okCount} 件`)
      await refreshSendable()
      options.onSent?.()
    }
    if (errors.length > 0) {
      ElMessage.error(
        `失败 ${errors.length} 件：${errors.map((e) => `${e.serial} (${e.msg})`).join('; ')}`,
      )
    }
  }

  return {
    // state
    sendableError,
    sendableFilter,
    sendablePagedRef,
    sendablePageSize,
    sendQueue,
    batchSending,
    scanInput,
    sendDialogVisible,
    sendTarget,
    sendSelectedCompanyId,
    sendQuantity,
    sendSubmitting,
    // 持久化恢复（shell 在 onMounted 里调一次，把 snapshot 写回 sendableFilter / pageSize）
    restore: persist.restore,
    snapshot: persist.snapshot,
    clearPersisted: persist.clear,
    // handlers
    sendableFetcher,
    refreshSendable,
    onSendableSearch,
    onSendableReset,
    sendableRowClassName,
    canSend,
    openSend,
    onConfirmSend,
    handleScannedSerialForSend,
    onScanInputEnter,
    onScanInputClear,
    removeFromSendQueue,
    clearSendQueue,
    onConfirmBatchSend,
  }
}

// 类型 re-export 方便模板里直接 `import type { SendableItem } from '../composables/useOutsourceSendableList'`
export type { ApprovedQuoteForSendItem, DirectOutsourceCandidateItem }