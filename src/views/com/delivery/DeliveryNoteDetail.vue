<!--
  送货单详情（形态对齐 frontend/src/views/parts/PartDetail.vue）。

  拆分后结构：
  - <DeliveryNoteHeaderCard>     — page-header + info card + 送货日期 picker
  - <DeliveryNoteLineItemsTable> — 列显隐 + 树形零件列表表（零件 / 装配件行）
  - <DeliveryNoteDispatchControls>— 状态机操作按钮
  - composable useDeliveryNoteDetail — 数据 + 派生 + 列显隐
  - composable useDeliveryNoteActions — 业务操作（confirmDangerous + 业务 API）

  Shell 责任：
  - route id 监听 + 首屏拉取
  - 打印送货单的对话框可见性 + 目标 note（打印标签不走对话框）
  - 把 actions composable 与 detail composable 桥接（bindings），并把表格实例的
    clearSelection 转给 actions（移除勾选行后清 EP 的保留集）
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import PrintPreviewDialog from './components/PrintPreviewDialog.vue';
import DeliveryNoteHeaderCard from './components/DeliveryNoteHeaderCard.vue';
import DeliveryNoteLineItemsTable from './components/DeliveryNoteLineItemsTable.vue';
import DeliveryNoteDispatchControls from './components/DeliveryNoteDispatchControls.vue';
import { useDeliveryNoteDetail } from './composables/useDeliveryNoteDetail';
import { useDeliveryNoteActions } from './composables/useDeliveryNoteActions';
import { exportPartRowsLabels } from './utils/deliveryNoteLabelExport';
import type { PartTreeRow } from './utils/deliveryNotePartRows';

const route = useRoute();
const router = useRouter();

const noteId = computed<string>(() => String(route.params.id ?? ''));

/**
 * 2026-10-10：keep-alive 下「切走就换页」的守卫。
 *
 * `useRoute()` 注入的是 vue-router 的**全局**响应式 currentRoute，不是本组件挂载那
 * 一刻的地址快照；本页被 MainLayout 的 `<keep-alive :include="tags.cachedViewNames">`
 * 缓存后（路由名 `DeliveryNoteDetail` = 组件文件名，匹配得上），切到任何别的页面时
 * `route.params.id` 照样变 ⇒ 喂给 `useDeliveryNoteDetailQuery` 的 reactive queryKey
 * 跟着变 ⇒ 自动去请求 `GET /delivery-notes/{别的页面的 id}`。
 *
 * 后果不止 404：那个 id 恰好是另一张有效送货单时，本页会**静默渲染成另一张单**，
 * 用户看着一份完整的详情页，根本不会意识到自己看错了。
 *
 * 这条数据流是 computed → queryKey，挂不上 watcher，所以守卫收在 query 的 enabled
 * 侧：`isActive` 为 false 时本页不取数（`useDeliveryNoteDetail` 只是把参数透传下去）。
 */
const isThisPage = computed(() => route.name === 'DeliveryNoteDetail');

const detail = useDeliveryNoteDetail(noteId, isThisPage);

/** 零件列表表的实例（移除勾选行后要调它的 clearSelection）。 */
const lineItemsTableRef = ref<InstanceType<typeof DeliveryNoteLineItemsTable> | null>(null);

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
  selectedRows: detail.selectedRows,
  rowIdToBatchIds: detail.rowIdToBatchIds,
  editDeliveryDate: detail.editDeliveryDate,
  fetchDetail: detail.fetchDetail,
  setSelectedRows: detail.setSelectedRows,
  clearSelection: () => lineItemsTableRef.value?.clearSelection(),
});

// ============ UI state（打印送货单对话框可见性由 shell 持有）============
const previewVisible = ref(false);

// ============ 事件处理 ============
function onBack(): void {
  void router.push('/delivery-notes');
}

function onPrint(): void {
  previewVisible.value = true;
}

/** 打印标签：直接导出表格里勾选的零件 / 装配件行（空选由导出实现给 warning）。
 *  与扫码建单页的卡片「打印标签」是同一份实现（域内 utils/deliveryNoteLabelExport），
 *  文件名 / toast / 绿底标记三处行为必须一致。 */
function onPrintLabels(): void {
  const n = detail.note.value;
  if (!n) return;
  void exportPartRowsLabels(n, detail.selectedRows.value);
}

/** 表格勾选变化 → 回写 detail（勾选集合由 composable 持有，行 = 零件 / 装配件）。 */
function onSelectionChange(rows: PartTreeRow[]): void {
  detail.setSelectedRows(rows);
}

// ============ 生命周期 ============
// 首屏与切路由 id 都由 query 自动覆盖（queryKey 带 noteId，切 id 即换缓存身份），
// 视图不再显式调 fetchDetail；错误由 query hook 的 watch → ElMessage 桥接。
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
        ref="lineItemsTableRef"
        :note="detail.note.value"
        :can-edit="detail.canEdit.value"
        :role="detail.role.value"
        :tree-line-items="detail.treeLineItems.value"
        :column-defs="detail.columnDefs"
        :column-visibility="detail.columnVisibility"
        :selected-rows="detail.selectedRows.value"
        :delivery-line-row-class-name="detail.deliveryLineRowClassName"
        @removeSelected="() => actions.onRemoveSelected()"
        @selectionChange="onSelectionChange"
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

    <!-- 打印送货单预览（模板上传 + 分厂分组 + 拖拽；打印标签不经过它） -->
    <PrintPreviewDialog
      v-if="detail.note.value"
      v-model="previewVisible"
      :note="detail.note.value"
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