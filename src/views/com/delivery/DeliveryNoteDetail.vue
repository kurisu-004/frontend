<!--
  送货单详情（形态对齐 frontend/src/views/parts/PartDetail.vue）。

  拆分后结构：
  - <DeliveryNoteHeaderCard>     — page-header + info card + 送货日期 picker
  - <DeliveryNoteLineItemsTable> — 列显隐 + 树形 line items 表
  - <DeliveryNoteDispatchControls>— 状态机操作按钮
  - composable useDeliveryNoteDetail — 数据 + 派生 + 列显隐
  - composable useDeliveryNoteActions — 业务操作（confirmDangerous + 业务 API）

  Shell 责任：
  - route id 监听 + 首屏拉取
  - 打印对话框可见性 + 目标 note
  - 把 actions composable 与 detail composable 桥接（bindings）
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';

import PrintPreviewDialog from './components/PrintPreviewDialog.vue';
import DeliveryNoteHeaderCard from './components/DeliveryNoteHeaderCard.vue';
import DeliveryNoteLineItemsTable from './components/DeliveryNoteLineItemsTable.vue';
import DeliveryNoteDispatchControls from './components/DeliveryNoteDispatchControls.vue';
import { useDeliveryNoteDetail } from './composables/useDeliveryNoteDetail';
import { useDeliveryNoteActions } from './composables/useDeliveryNoteActions';

const route = useRoute();
const router = useRouter();

const noteId = computed<string>(() => String(route.params.id ?? ''));

const detail = useDeliveryNoteDetail(noteId);

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
  selectedItemIds: detail.selectedItemIds,
  editDeliveryDate: detail.editDeliveryDate,
  fetchDetail: detail.fetchDetail,
  setSelectedItemIds: detail.setSelectedItemIds,
});

// ============ UI state（dialog 可见性由 shell 持有）============
const previewVisible = ref(false);
/** 2026-10-08 过渡态：打印对话框切本地渲染（送货单 XLSX）后，「标签」模式一并下线，
 *  本 ref 与 onPrintLabels 一起删。后端的 `/print-labels` 端点已下线。 */
const previewMode = ref<'note' | 'label'>('note');

// ============ 事件处理 ============
function onBack(): void {
  void router.push('/delivery-notes');
}

function onPrint(): void {
  previewMode.value = 'note';
  previewVisible.value = true;
}

function onPrintLabels(): void {
  previewMode.value = 'label';
  previewVisible.value = true;
}

// ============ 生命周期 ============
// 首屏 + 切路由 id 都触发 refetch（queryKey 带 noteId，切 id 自动换缓存身份）。
watch(noteId, () => {
  void detail.fetchDetail().catch((e: Error) => {
    ElMessage.error(e.message ?? '加载失败');
  });
});
onBeforeUnmount(() => {
  detail.$dispose();
});
</script>

<template>
  <div v-loading="detail.loading.value" class="delivery-note-detail">
    <template v-if="detail.note.value">
      <DeliveryNoteHeaderCard
        :note="detail.note.value"
        :edit-delivery-date="detail.editDeliveryDate.value"
        @back="onBack"
        @update:edit-delivery-date="actions.setEditDeliveryDate"
        @deliveryDateChange="(v: string | null) => actions.onDeliveryDateChange(v)"
      />

      <DeliveryNoteLineItemsTable
        :note="detail.note.value"
        :can-edit="detail.canEdit.value"
        :tree-line-items="detail.treeLineItems.value"
        :column-defs="detail.columnDefs"
        :column-visibility="detail.columnVisibility"
        :selected-item-ids="detail.selectedItemIds.value"
        :part-status-label="detail.partStatusLabel"
        :part-status-tag-type="detail.partStatusTagType"
        :delivery-line-row-class-name="detail.deliveryLineRowClassName"
        @removeSelected="() => actions.onRemoveSelected()"
        @update:selected-item-ids="(ids: string[]) => detail.setSelectedItemIds(ids)"
        @sort-change="detail.onLineItemSort"
      />

      <DeliveryNoteDispatchControls
        :note="detail.note.value"
        :role="detail.role.value"
        @submit="actions.onSubmit"
        @recall="() => actions.onRecall()"
        @print="onPrint"
        @printLabels="onPrintLabels"
        @softDelete="() => actions.onSoftDelete()"
      />
    </template>

    <!-- 打印送货单对话框（模板上传 + 分厂分组 + 拖拽 + hucre 本地渲染） -->
    <PrintPreviewDialog
      v-if="detail.note.value"
      v-model="previewVisible"
      :note="detail.note.value"
      :mode="previewMode"
    />
  </div>
</template>

<style lang="scss" scoped>
.delivery-note-detail {
  padding: 16px;
}
.line-items-card,
.actions-card {
  margin-bottom: 16px;
}
</style>