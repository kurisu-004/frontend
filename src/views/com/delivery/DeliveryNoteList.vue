<!--
  送货单一览。

  - 文员 / MANAGER：filter (statuses × customer_id × keyword) → table → 操作
    (详情 / 送货 / 删除)
  - 顶部「扫码建单」按钮：入单的唯一入口是扫码（`/delivery-notes/scan`），
    手动新建草稿已下线（`POST /delivery-notes` 端点删除）
  - 配送日期列、送货日期列

  数据层：本页的全部筛选 / 分页 / 行操作态在页面级 store
  `useDeliveryNoteListStore` 里（TanStack Query 主查询 + 列可见性 + 列拖动），
  壳只做渲染与事件转发。
-->
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Promotion } from '@element-plus/icons-vue';

import { resolveDraggable } from '@/composables/useColumnVisibility';
import { columnIdentifier } from '@/composables/useColumnDrag';
import ColumnVisibilityPopover from '@/components/ColumnVisibilityPopover.vue';
import ColumnDragHandle from '@/components/ColumnDragHandle.vue';
import { DELIVERY_NOTE_STATUS_LABEL } from '@/types/deliveryNote';
import { useDeliveryNoteListStore } from './composables/useDeliveryNoteListStore';
import type { DeliveryNoteRow } from './deliveryNoteColumnDefs';

const route = useRoute();
const router = useRouter();

const store = useDeliveryNoteListStore();
// store 不 import vue-router（页面级 store 不变量 #4）：导航能力由视图注入。
store.registerRouter(() => router);

const tableRef = ref();

onMounted(() => {
  store.query.setRouteStatuses(route.query.statuses);
  store.query.restoreState();
  // 列顺序拖动需要 el-table 实例（composable 内部解析表头 + MutationObserver 自愈）。
  store.drag.applyDrag(tableRef);
});

onBeforeUnmount(() => {
  store.$dispose();
});
</script>

<template>
  <div class="delivery-note-list">
    <el-card shadow="never" class="filter-card">
      <el-form inline class="filter-form">
        <div class="filter-row">
          <el-form-item label="状态">
            <el-select
              v-model="store.query.statuses"
              multiple
              clearable
              placeholder="全部"
              style="width: 380px"
            >
              <el-option
                v-for="s in store.query.allStatuses"
                :key="s"
                :label="DELIVERY_NOTE_STATUS_LABEL[s]"
                :value="s"
              />
            </el-select>
          </el-form-item>
          <el-form-item label="客户">
            <el-select
              v-model="store.query.customerId"
              clearable
              filterable
              placeholder="全部"
              style="width: 200px"
            >
              <el-option
                v-for="c in store.query.customers"
                :key="c.id"
                :label="c.path"
                :value="c.id"
              />
            </el-select>
          </el-form-item>
        </div>

        <div class="filter-row filter-row--split">
          <div>
            <el-form-item label="单号">
              <el-input
                v-model="store.query.searchInput"
                placeholder="DN-20260723-…"
                clearable
                style="width: 200px"
                @keyup.enter="store.query.onSearch()"
                @clear="store.query.onSearch()"
              />
            </el-form-item>
            <el-form-item>
              <el-button type="primary" @click="store.query.onSearch()">查询</el-button>
              <el-button @click="store.query.resetFilter">重置</el-button>
            </el-form-item>
          </div>

          <div class="delivery-list-actions">
            <el-button type="primary" @click="router.push('/delivery-notes/scan')">
              <el-icon><Promotion /></el-icon>
              <span>扫码建单</span>
            </el-button>
          </div>
        </div>
      </el-form>
    </el-card>

    <el-card shadow="never" style="margin-top: 16px">
      <template #header>
        <div class="dnl-card-header">
          <ColumnVisibilityPopover
            :defs="store.columnDefs"
            :model-value="store.columnVisibility.currentMap"
            @update:model-value="store.columnVisibility.update"
            @reset="store.columnVisibility.showAll"
            @resetOrder="store.drag.reset"
          />
        </div>
      </template>
      <el-table
        ref="tableRef"
        v-loading="store.query.loading"
        :data="store.query.items"
        :row-key="(r: DeliveryNoteRow) => r.id"
        max-height="calc(100vh - 360px)"
        highlight-current-row
        stripe
        border
        :empty-text="store.query.loading ? '加载中' : store.query.emptyText"
      >
        <template v-for="d in store.drag.orderedDefs" :key="columnIdentifier(d)">
          <el-table-column
            v-if="store.columnVisibility.isVisible(d.key)"
            :prop="d.prop ?? d.key"
            :label="d.label"
            :width="d.width"
            :min-width="d.minWidth"
            :sortable="d.sortable"
            :align="d.align"
            :show-overflow-tooltip="d.showOverflowTooltip"
            :column-key="d.columnKey ?? d.key"
            :label-class-name="store.drag.dragLabelClass(d)"
          >
            <template v-if="d.cellRender" #default="scope">
              <component :is="d.cellRender(scope)" />
            </template>
            <template v-if="resolveDraggable(d) && !d.type && !d.fixed" #header>
              <span>{{ d.label }}</span>
              <ColumnDragHandle :title="`拖动 ${d.label} 列`" />
            </template>
          </el-table-column>
        </template>
        <!-- 操作列不进 defs（不进列可见性 map ⇒ 用户关不掉） -->
        <el-table-column label="操作" min-width="180" fixed="right" align="center">
          <!-- el-table-column 的插槽行类型是 EP 的 `DefaultRow`（索引签名），业务函数
               收窄到 DeliveryNoteRow，模板里断言一次而不是整行 as。 -->
          <template #default="{ row }">
            <div class="row-actions">
              <el-button
                link
                type="primary"
                @click="store.actions.navigateToDetail((row as DeliveryNoteRow).id)"
              >
                详情
              </el-button>
              <el-button
                v-if="store.actions.canDeliverRow(row as DeliveryNoteRow)"
                link
                type="success"
                :loading="store.actions.isDelivering((row as DeliveryNoteRow).id)"
                @click="store.actions.onDeliver(row as DeliveryNoteRow)"
              >
                送货
              </el-button>
              <el-button
                v-if="store.actions.canSoftDeleteRow(row as DeliveryNoteRow)"
                link
                type="danger"
                @click="store.actions.onSoftDelete(row as DeliveryNoteRow)"
              >
                删除
              </el-button>
            </div>
          </template>
        </el-table-column>
      </el-table>

      <el-pagination
        class="pager"
        layout="total, sizes, prev, pager, next"
        :total="store.query.total"
        :current-page="store.query.page"
        :page-size="store.query.pageSize"
        :page-sizes="[20, 50, 100, 200]"
        @current-change="store.query.onPageChange"
        @size-change="store.query.onPageSizeChange"
      />
    </el-card>
  </div>
</template>

<style scoped>
.delivery-note-list {
  padding: 16px;
}
.filter-card :deep(.el-form-item) {
  margin-bottom: 0;
}
.filter-row {
  display: flex;
  margin-bottom: 15px;
}
.filter-row--split {
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0;
}
.pager {
  margin-top: 16px;
  justify-content: flex-end;
}
.dnl-card-header {
  display: flex;
  justify-content: flex-end;
  align-items: center;
}
.row-actions {
  display: flex;
  align-items: center;
}
.delivery-list-actions {
  display: inline-flex;
  gap: 8px;
}
</style>