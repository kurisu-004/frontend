<script setup lang="ts">
// DeliveryNoteScan — 扫码建单页面（装配壳；2026-08-25 T11 拆分）。
//
// 2026-08-25 拆分说明（任务 §T11）：
//   - 业务状态 / 函数全部下移到 composables：
//       useDeliveryDraftBoard        — 草稿卡片列表 + 移除 / 打印标签 / 删除草稿
//       useDeliveryScanSubmission    — 扫码主流程 + 草稿提交 + 打印送货单预览
//   - 视图层切为 3 个子组件：
//       DeliveryScanBar              — 顶部 L1 客户选择条
//       DeliveryGroupPanel           — 分组规则面板（含编辑器 dialog）
//       DeliveryDraftCard            — 单张草稿卡片（重复 4-5 次）
//   - 装配壳只负责：拉客户全集 + 订阅扫码枪 + watch L1 变化触发 reload + 编排 3 子组件 +
//     装配 3 个 page-level dialog（BatchSubmitInspectionConfirmDialog / PrintPreviewDialog /
//     BatchInspectionConfirmDialog）+ router.push。
//
// 设计要点（沿用原 v3）：
//   - useBarcodeScanner 扫码枪订阅 → handleScan → scanDelivery（后端 find-or-create）。
//   - DeliveryGroupEditor 已内嵌到 DeliveryGroupPanel，本组件不再持有。
//   - applySuccess 同步刷新 draftDetails（扫码命中后立即把最新 line_items 拉回）。

import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { useBarcodeScanner } from '@/composables/useBarcodeScanner'
import { useDeliveryScanState } from '@/composables/useDeliveryScanState'
import { listCustomers, type Customer } from '@/api/customer'
import {
  createDeliveryGroup,
  listDeliveryGroups,
  softDeleteDeliveryGroup,
  updateDeliveryGroup,
} from '@/api/deliveryGroup'
import { useAuthSession } from '@/composables/useAuthSession'
import { canPrint } from '@/utils/deliveryNotePermissions'
import type { DeliveryGroupListOut, DeliveryGroupOut } from '@/types/deliveryGroup'
import type { ScanNoteSummary } from '@/types/deliveryNote'
import { useDeliveryDraftBoard } from './composables/useDeliveryDraftBoard'
import { useDeliveryScanSubmission } from './composables/useDeliveryScanSubmission'
import DeliveryScanBar from './components/DeliveryScanBar.vue'
import DeliveryGroupPanel from './components/DeliveryGroupPanel.vue'
import DeliveryDraftCard from './components/DeliveryDraftCard.vue'
import BatchSubmitInspectionConfirmDialog from '@/components/delivery/BatchSubmitInspectionConfirmDialog.vue'
import BatchInspectionConfirmDialog from '@/components/delivery/BatchInspectionConfirmDialog.vue'
import PrintPreviewDialog from '@/components/delivery/PrintPreviewDialog.vue'

const router = useRouter()

// ============ L1 / 客户全集 ============
const scanState = useDeliveryScanState()
const auth = useAuthSession()

/** 全量客户列表（listCustomers() 返回平铺）。 */
const allCustomers = ref<Customer[]>([])
/** 一级客户全集（parent_id === null）。 */
const rootCustomers = computed<Customer[]>(() =>
  allCustomers.value.filter((c) => c.parent_id === null),
)
/** 当前 L1 下的 L2 客户全集（分组编辑器用）。 */
const allL2Customers = computed<Customer[]>(() => {
  if (!scanState.l1CustomerId.value) return []
  return allCustomers.value.filter((c) => c.parent_id === scanState.l1CustomerId.value)
})

/** CurrentUser.roles → boolean map（canPrint 用）。 */
const roleMap = computed<{ MANAGER?: boolean; CLERK?: boolean; INSPECTOR?: boolean }>(() => {
  const r = auth.user.value?.roles ?? []
  return {
    MANAGER: r.includes('MANAGER'),
    CLERK: r.includes('CLERK'),
    INSPECTOR: r.includes('INSPECTOR'),
  }
})

// ============ 分组态 ============
const groups = ref<DeliveryGroupListOut>({ groups: [], ungrouped_customers: [] })
const groupsLoading = ref(false)

/** 拉当前 L1 下的分组 + 未分组 L2。 */
async function reloadGroups(l1Id: string): Promise<void> {
  if (!l1Id) {
    groups.value = { groups: [], ungrouped_customers: [] }
    return
  }
  groupsLoading.value = true
  try {
    groups.value = await listDeliveryGroups(l1Id)
  } catch (e) {
    ElMessage.error((e as Error).message ?? '加载分组规则失败')
  } finally {
    groupsLoading.value = false
  }
}

// ============ 草稿卡片业务（board）============
const board = useDeliveryDraftBoard()

// ============ 扫码 + 提交 + 预览（submission）============
const submission = useDeliveryScanSubmission({
  writeDraftFromScan: board.writeDraftFromScan,
  refreshDraftDetail: board.refreshDraftDetail,
  onDraftRemoved: (noteId) => {
    delete submission.submittingByNote[noteId]
    board.clearNoteLocalState(noteId)
  },
})

// ============ 扫码枪订阅 ============
const { onScan } = useBarcodeScanner()
let unsubScan: (() => void) | null = null

// ============ 草稿卡片：行为函数（透传 board / submission 业务）============
/** 草稿卡片 row 是否允许打印（角色 + 至少 1 个零件；与 detail page 同款）。 */
function canPrintNote(d: ScanNoteSummary): boolean {
  const partCount = (d as { part_count?: number }).part_count ?? d.recent_items.length
  return canPrint(roleMap.value, partCount)
}

/** 草稿卡片 row 是否允许提交（status === 'DRAFT'）。 */
function canSubmitDraft(d: ScanNoteSummary): boolean {
  return d.status === 'DRAFT'
}

// ============ 卡片跳转 ============
function gotoDetail(draft: ScanNoteSummary): void {
  void router.push(`/delivery-notes/${draft.id}`)
}

function gotoAllDrafts(): void {
  if (!scanState.l1CustomerId.value) return
  void router.push({
    path: '/delivery-notes',
    query: { statuses: 'DRAFT', customer_id: scanState.l1CustomerId.value },
  })
}

// ============ 分组：create / update / delete ============
async function onGroupCreate(payload: { name: string; member_customer_ids: string[] }): Promise<void> {
  if (!scanState.l1CustomerId.value) return
  try {
    await createDeliveryGroup({
      customer_id: scanState.l1CustomerId.value,
      name: payload.name,
      member_customer_ids: payload.member_customer_ids,
    })
    ElMessage.success('分组已创建')
    await reloadGroups(scanState.l1CustomerId.value)
  } catch (e) {
    ElMessage.error((e as Error).message ?? '保存分组失败')
  }
}

async function onGroupUpdate(payload: {
  group: DeliveryGroupOut
  name: string
  member_customer_ids: string[]
}): Promise<void> {
  try {
    await updateDeliveryGroup(payload.group.id, {
      version: payload.group.version,
      name: payload.name,
      member_customer_ids: payload.member_customer_ids,
    })
    ElMessage.success('分组已更新')
    if (scanState.l1CustomerId.value) {
      await reloadGroups(scanState.l1CustomerId.value)
    }
  } catch (e) {
    ElMessage.error((e as Error).message ?? '保存分组失败')
  }
}

async function onGroupDelete(g: DeliveryGroupOut): Promise<void> {
  try {
    await softDeleteDeliveryGroup(g.id, { version: g.version })
    ElMessage.success('分组已删除')
    if (scanState.l1CustomerId.value) {
      await reloadGroups(scanState.l1CustomerId.value)
    }
  } catch (e) {
    ElMessage.error((e as Error).message ?? '删除分组失败')
  }
}

// ============ 草稿卡片：emit → 业务函数桥接 ============
function onCardGotoDetail(d: ScanNoteSummary): void {
  gotoDetail(d)
}
function onCardSelectionChange(d: ScanNoteSummary, rows: any[]): void {
  board.onSelectionChange(d.id, rows)
}
function onCardRemove(d: ScanNoteSummary, row: any): void {
  void board.onRemove(d, row)
}
function onCardPrintLabels(d: ScanNoteSummary): void {
  void board.onPrintLabels(d)
}
function onCardDeleteDraft(d: ScanNoteSummary): void {
  void board.onDeleteDraft(d)
}
function onCardPrintNote(d: ScanNoteSummary): void {
  void submission.openPrintNote(d)
}
function onCardSubmitDraft(d: ScanNoteSummary): void {
  void submission.onSubmitDraft(d)
}
function onCardTableRef(d: ScanNoteSummary, el: any): void {
  board.setTableRef(d.id, el)
}

// ============ 生命周期 ============
onMounted(async () => {
  // L1 持久化恢复：单例扫描整个页面载入后从 localStorage 读回；只触发一次
  scanState.init()
  // 扫码枪订阅：每页独立挂载；卸载时退订避免劫持到其他页
  unsubScan = onScan((code) => { void submission.handleScan(code) })
  // 拉客户全集
  try {
    allCustomers.value = await listCustomers()
  } catch (e) {
    ElMessage.error((e as Error).message ?? '加载客户列表失败')
  }
})

/**
 * L1 变化（init 从 localStorage 恢复 / 用户切换 el-select）→ 重拉分组 + 草稿。
 *
 * 用 immediate: true 处理「重入页面时 watch 不会 fire 已有值」的问题：
 * useDeliveryScanState 是模块级单例，_l1CustomerId 在页面间共享。
 */
watch(
  scanState.l1CustomerId,
  async (id) => {
    if (!id) {
      groups.value = { groups: [], ungrouped_customers: [] }
      return
    }
    await Promise.all([reloadGroups(id), board.reloadDrafts(id)])
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  unsubScan?.()
  unsubScan = null
})
</script>

<template>
  <div class="page">
    <!-- 顶部：扫码入口条（L1 客户选择 + 扫码就绪提示）-->
    <DeliveryScanBar
      :l1-id="scanState.l1CustomerId.value"
      :root-customers="rootCustomers"
      @update:l1-id="(v: string) => scanState.setL1CustomerId(v)"
    />

    <!-- 分组规则面板 -->
    <DeliveryGroupPanel
      :groups="groups"
      :loading="groupsLoading"
      :can-create="!!scanState.l1CustomerId.value"
      :l1-id="scanState.l1CustomerId.value"
      :all-l2-customers="allL2Customers"
      @create="onGroupCreate"
      @update="onGroupUpdate"
      @delete="onGroupDelete"
    />

    <!-- 草稿卡片列表 -->
    <div class="drafts-section" v-loading="board.draftsLoading.value">
      <div class="drafts-header">
        <span class="dn-scan-card-title">当前草稿（{{ board.draftsCount.value }}）</span>
        <el-button
          v-if="board.draftsCount.value > 0"
          link
          type="primary"
          @click="gotoAllDrafts"
        >
          查看全部 →
        </el-button>
      </div>

      <el-empty
        v-if="board.draftsCount.value === 0"
        description="暂无草稿 — 扫码枪扫码开始建单"
        :image-size="80"
      />
      <div v-else class="drafts-grid">
        <DeliveryDraftCard
          v-for="d in board.drafts.value"
          :key="d.id"
          :draft="d"
          :rows="board.foldedRows(d.id)"
          :selected-rows="board.selectedByNote[d.id] ?? []"
          :selection-count="board.getSelectionSize(d.id)"
          :printing="board.printingByNote[d.id] ?? false"
          :deleting="board.deletingByNote[d.id] ?? false"
          :submitting="submission.submittingByNote[d.id] ?? false"
          :can-print="canPrintNote(d)"
          :can-submit="canSubmitDraft(d)"
          :row-class-name="board.rowClassName"
          @goto-detail="onCardGotoDetail(d)"
          @selection-change="(rs: any) => onCardSelectionChange(d, rs)"
          @remove="(r: any) => onCardRemove(d, r)"
          @print-labels="onCardPrintLabels(d)"
          @delete-draft="onCardDeleteDraft(d)"
          @print-note="onCardPrintNote(d)"
          @submit-draft="onCardSubmitDraft(d)"
          @set-table-ref="(el: any) => onCardTableRef(d, el)"
        />
      </div>
    </div>

    <!-- ========== 扫码阻塞确认对话框（page-level，shell 渲染；2026-08-26 切换到 BatchSubmitInspectionConfirmDialog，因为阻塞件通常是 IN_PROCESS/PROGRAMMING/PENDING，需送检非过检） ========== -->
    <BatchSubmitInspectionConfirmDialog
      v-model="submission.blockedDialogVisible.value"
      :failures="submission.blockedFailures.value"
      :reason="submission.blockedReason.value"
      :original-code="submission.blockedOriginalCode.value"
      @submit-success="submission.onBlockedSubmitSuccess"
      @submit-partial="submission.onBlockedSubmitPartial"
      @cancel="submission.onBlockedCancel"
    />

    <!-- ========== 打印送货单预览（page-level，shell 渲染） ==========
      v-if 保持：note=null 时（getNote 加载中）不渲染 dialog。openPrintNote
      等 detail 拉回后再开 dialog，避免 PrintPreviewDialog 在 note=null 时
      初始化空表格。 -->
    <PrintPreviewDialog
      v-if="submission.printNotePreviewVisible.value && submission.printNoteTarget.value"
      v-model="submission.printNotePreviewVisible.value"
      :note="submission.printNoteTarget.value"
      mode="note"
    />

    <!-- ========== 提交前未送检确认（page-level，shell 渲染） ========== -->
    <BatchInspectionConfirmDialog
      v-model="submission.submitDialogVisible.value"
      :uninspected-items="submission.submitUninspected.value"
      :note-id="submission.submitTarget.value?.id ?? ''"
      :note-version="submission.submitTarget.value?.version ?? 0"
      source="submit"
      @pass-success="submission.onSubmitDialogPassSuccess"
      @pass-partial="submission.onSubmitDialogPassPartial"
      @cancel="submission.onSubmitDialogCancel"
    />
  </div>
</template>

<style lang="scss" scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.dn-scan-card-title {
  font-weight: 600;
  color: var(--text-primary, #303133);
}

/* ============ 草稿卡片列表 ============ */
.drafts-section {
  background: #fff;
  border-radius: 4px;
  padding: 12px 16px;
  border: 1px solid var(--el-border-color-lighter);
}
.drafts-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.drafts-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}

/* ============ 已打印行绿底（与 DeliveryNoteDetail.vue row-urgent 风格对齐） ============ */
:deep(.el-table__row.row-printed) > td.el-table__cell {
  background-color: #e6f7e6 !important;
}
:deep(.el-table__row.row-printed:hover > td.el-table__cell) {
  background-color: #d6efd6 !important;
}

.muted {
  color: var(--el-text-color-secondary);
}
</style>
