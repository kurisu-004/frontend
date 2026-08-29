<!--
  送货单详情（PR-G 2026-07-22 新增；2026-08-25 frontend-overall-refactor 拆分）

  形态对齐 frontend/src/views/parts/PartDetail.vue
  不同点：本页主操作是「添加零件」「移除零件」「提交」「撤回」「软删」
  以及「扫码领取」链接（仅 SUBMITTED 状态跳司机扫码台）。

  拆分后结构：
  - <DeliveryNoteHeaderCard> — page-header + info card + 送货日期 picker
  - <DeliveryNoteLineItemsTable> — 列显隐 + 树形 line items 表
  - <DeliveryNoteDispatchControls> — 状态机操作按钮
  - composable useDeliveryNoteDetail — 数据 + 派生 + 列显隐
  - composable useDeliveryNoteActions — 业务操作（confirmDangerous + 业务 API）

  Shell 责任：
  - route id 监听 + fetchDetail
  - 3 个 dialog 可见性（addDialogOpen / previewVisible / submitDialogVisible）
  - 把 actions composable 与 detail composable 桥接（bindings）
  - 事件流 timeline（轻量、本地，留在 shell）
-->
<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage } from 'element-plus'

import PartPickerDialog from '@/components/delivery/PartPickerDialog.vue'
import PrintPreviewDialog from '@/components/delivery/PrintPreviewDialog.vue'
import BatchInspectionConfirmDialog from '@/components/delivery/BatchInspectionConfirmDialog.vue'
import DeliverySubmitCandidateDialog from '@/components/delivery/DeliverySubmitCandidateDialog.vue'
import { formatNoteEventLabel } from '@/types/deliveryNote'
import type { AddPartsItem } from '@/api/deliveryNote'
import type {
  BulkPassFailure,
  BulkPassItem,
} from '@/composables/useBulkPassInspection'
import DeliveryNoteHeaderCard from './components/DeliveryNoteHeaderCard.vue'
import DeliveryNoteLineItemsTable from './components/DeliveryNoteLineItemsTable.vue'
import DeliveryNoteDispatchControls from './components/DeliveryNoteDispatchControls.vue'
import { useDeliveryNoteDetail } from './composables/useDeliveryNoteDetail'
import { useDeliveryNoteActions } from './composables/useDeliveryNoteActions'

const route = useRoute()

const noteId = computed<string>(() => String(route.params.id ?? ''))

const detail = useDeliveryNoteDetail(noteId)

// ============ 业务操作（绑到 detail 的 state）============
const actions = useDeliveryNoteActions({
  note: computed(() =>
    detail.note.value == null
      ? null
      : {
          id: detail.note.value.id,
          version: detail.note.value.version,
          part_count: detail.note.value.part_count,
          delivery_note_no: detail.note.value.delivery_note_no,
          delivery_date: detail.note.value.delivery_date,
        },
  ),
  uninspectedItems: detail.uninspectedItems,
  selectedItemIds: detail.selectedItemIds,
  editDeliveryDate: detail.editDeliveryDate,
  fetchDetail: detail.fetchDetail,
  setSelectedItemIds: detail.setSelectedItemIds,
})

// ============ UI state（dialog 可见性由 shell 持有）============
const addDialogOpen = ref(false)
const previewVisible = ref(false)
const previewMode = ref<'note' | 'label'>('note')
const submitDialogVisible = ref(false)

// ============ 事件流 timeline（数据已在 detail.events）============

// ============ 事件处理 ============
function onBack(): void {
  history.length > 1 ? history.back() : window.location.assign('/delivery-notes')
}

function openAddDialog(): void {
  addDialogOpen.value = true
}

async function onPickerSubmit(items: AddPartsItem[]): Promise<void> {
  const ok = await actions.onAddParts(items)
  if (ok) addDialogOpen.value = false
}

function onPrint(): void {
  previewMode.value = 'note'
  previewVisible.value = true
}

function onPrintLabels(): void {
  previewMode.value = 'label'
  previewVisible.value = true
}

async function onSubmit(): Promise<void> {
  // 先调 actions.onSubmit；如果返回 false + 有未送检件 → 打开批量过检弹窗；
  // 其它情况 actions.onSubmit 已经处理完了。
  const ok = await actions.onSubmit()
  if (!ok && detail.uninspectedItems.value.length > 0) {
    submitDialogVisible.value = true
  }
}

async function onSubmitDialogPassSuccess(): Promise<void> {
  submitDialogVisible.value = false
  await actions.onSubmitDialogPassSuccess()
}

function onSubmitDialogPassPartial(
  result: { passed: BulkPassItem[]; failed: BulkPassFailure[] },
): void {
  actions.onSubmitDialogPassPartial(result)
}

// ============ 生命周期 ============
watch(noteId, () => {
  void detail.fetchDetail().catch((e: Error) => {
    ElMessage.error(e.message ?? '加载失败')
  })
})
onMounted(() => {
  void detail.fetchDetail().catch((e: Error) => {
    ElMessage.error(e.message ?? '加载失败')
  })
})
</script>

<template>
  <div v-loading="detail.loading.value" class="delivery-note-detail">
    <template v-if="detail.note.value">
      <DeliveryNoteHeaderCard
        :note="detail.note.value"
        :edit-delivery-date="detail.editDeliveryDate.value"
        @back="onBack"
        @update:edit-delivery-date="actions.setEditDeliveryDate"
        @delivery-date-change="(v: string | null) => actions.onDeliveryDateChange(v)"
      />

      <DeliveryNoteLineItemsTable
        :note="detail.note.value"
        :can-add="detail.canAdd.value"
        :can-edit="detail.canEdit.value"
        :tree-line-items="detail.treeLineItems.value"
        :column-defs="detail.columnDefs"
        :column-visibility="detail.columnVisibility"
        :selected-item-ids="detail.selectedItemIds.value"
        :part-status-label="detail.partStatusLabel"
        :part-status-tag-type="detail.partStatusTagType"
        :delivery-line-row-class-name="detail.deliveryLineRowClassName"
        @add="openAddDialog"
        @remove-selected="() => actions.onRemoveSelected()"
        @update:selected-item-ids="(ids: string[]) => detail.setSelectedItemIds(ids)"
        @sort-change="detail.onLineItemSort"
      />

      <DeliveryNoteDispatchControls
        :note="detail.note.value"
        :role="detail.role.value"
        @submit="onSubmit"
        @recall="() => actions.onRecall()"
        @print="onPrint"
        @print-labels="onPrintLabels"
        @soft-delete="() => actions.onSoftDelete()"
      />

      <el-card shadow="never" class="events-card">
        <template #header><span>事件流</span></template>
        <el-timeline>
          <el-timeline-item
            v-for="e in detail.events.value"
            :key="e.id"
            :timestamp="e.created_at ? new Date(e.created_at).toLocaleString() : ''"
          >
            <strong>{{ formatNoteEventLabel(e.event_type) }}</strong>
            <span v-if="e.from_status && e.to_status">
              ({{ e.from_status }} → {{ e.to_status }})
            </span>
            <div v-if="e.note" class="event-note">{{ e.note }}</div>
          </el-timeline-item>
        </el-timeline>
      </el-card>
    </template>

    <!-- 添加零件对话框（2026-07-23 改 PartPickerDialog 勾选 UI） -->
    <PartPickerDialog
      v-model="addDialogOpen"
      :customer-id="String(detail.note.value?.customer_id ?? '')"
      :existing-batch-ids="detail.existingBatchIdsForPicker.value"
      title="选择零件添加到本单"
      @submit="onPickerSubmit"
    />

    <!-- 2026-08-02：打印预览对话框（拖动行可调整顺序，确认后导出 XLSX）
         2026-08-07：mode 决定「只导送货单」/「只导标签（可勾选）」 -->
    <PrintPreviewDialog
      v-if="detail.note.value"
      v-model="previewVisible"
      :note="detail.note.value"
      :mode="previewMode"
    />

    <!-- 2026-08-23：未送检 / 阻塞确认对话框（提交前的前置弹窗）。
         一键过检后由父组件继续调 submitNote。 -->
    <BatchInspectionConfirmDialog
      v-if="detail.note.value"
      v-model="submitDialogVisible"
      :uninspected-items="detail.uninspectedItems.value"
      :note-id="detail.note.value.id"
      :note-version="detail.note.value.version"
      source="submit"
      @pass-success="onSubmitDialogPassSuccess"
      @pass-partial="onSubmitDialogPassPartial"
      @cancel="submitDialogVisible = false"
    />

    <!-- 2026-08-29：submit 后 CANDIDATES_AVAILABLE 候选弹窗。
         submit 返回 outcome=CANDIDATES_AVAILABLE 时弹出（草稿仍有 INSPECTION 未过检批次）。
         确认过检后由 actions.onSubmitCandidateDone fetchDetail + 重 submit。 -->
    <DeliverySubmitCandidateDialog
      v-if="detail.note.value"
      v-model="actions.submitCandidateDialogVisible.value"
      :targets="actions.submitCandidateTargets.value"
      @done="actions.onSubmitCandidateDone"
      @cancel="actions.onSubmitCandidateCancel"
    />
  </div>
</template>

<style lang="scss" scoped>
.delivery-note-detail { padding: 16px; }
.line-items-card,
.actions-card,
.events-card { margin-bottom: 16px; }
.event-note {
  font-size: 13px;
  color: #666;
  margin-top: 4px;
}
</style>
