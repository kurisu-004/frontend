<template>
  <div class="outsource-billing">
    <!--
      2026-10-09：顶部 filter 卡收缩为纯标题栏（公司名 + 返回 + 重置 + 共 N 条）——
      关键字输入框与发送时间双 picker 全部搬进表头（照零件一览 / 待品检的范式）。
      公司名改读 `sent-parts` 信封的 `outsource_company_name`（原先要额外发一次
      `GET /outsource-companies/{id}`，那个调用本轮删除）。
    -->
    <el-card shadow="never" class="filter-card">
      <div class="header-row">
        <h2 class="header-title">外协对账：{{ page.query.companyName.value }}</h2>
        <div class="header-actions">
          <el-button size="small" @click="onResetFilters">重置筛选</el-button>
          <el-button size="small" @click="onBack">返回公司列表</el-button>
          <span v-if="page.query.total.value > 0" class="total-hint">共 {{ page.query.total.value }} 条</span>
        </div>
      </div>
    </el-card>

    <el-card shadow="never">
      <div class="table-toolbar">
        <ColumnVisibilityPopover
          :defs="page.columnDefs"
          :model-value="page.columnVisibility.currentMap"
          @update:model-value="page.columnVisibility.update"
          @reset="page.columnVisibility.showAll"
          @resetOrder="drag.reset"
        />
      </div>
      <el-table
        ref="tableRef"
        v-loading="page.query.loading.value"
        :data="page.query.items.value"
        row-key="shipment_id"
        :empty-text="page.query.emptyText.value"
        :row-class-name="page.rowClassName"
        :default-sort="page.query.defaultSort.value"
        stripe
        border
        size="small"
        show-summary
        :summary-method="page.summaryMethod"
        @row-dblclick="onRowDblClick"
        @sort-change="page.query.onSortChange"
        @filter-change="page.query.onNativeFilterChange"
      >
        <template #empty>
          <el-empty :description="page.query.emptyText.value" />
        </template>
        <template v-for="d in drag.orderedDefs.value" :key="columnIdentifier(d)">
          <el-table-column
            v-if="page.columnVisibility.isVisible(d.key)"
            :prop="d.prop ?? d.key"
            :label="d.label"
            :width="d.width"
            :min-width="d.minWidth"
            :sortable="d.sortable"
            :align="d.align"
            :filters="d.filters"
            :filter-multiple="d.filterMultiple"
            :filtered-value="d.filteredValue"
            :show-overflow-tooltip="d.showOverflowTooltip"
            :column-key="d.columnKey ?? d.key"
            :label-class-name="drag.dragLabelClass(d)"
          >
            <template
              v-if="d.headerRender || (resolveDraggable(d) && !d.type && !d.fixed)"
              #header="scope"
            >
              <component :is="d.headerRender(scope)" v-if="d.headerRender" />
              <span v-else>{{ d.label }}</span>
              <ColumnDragHandle
                v-if="resolveDraggable(d) && !d.type && !d.fixed"
                :title="`拖动 ${d.label} 列`"
              />
            </template>
            <template v-if="d.cellRender" #default="scope">
              <component :is="d.cellRender(scope)" />
            </template>
          </el-table-column>
        </template>
      </el-table>

      <!--
        2026-10-09 接真分页：原先裸 `el-table` + 硬编码 `limit: 50, offset: 0`，
        超过 50 行**静默丢数据**（无报错、无提示）。现在 page / pageSize 进 queryKey。
        不用 `<PagedTable>` 的理由见 useOutsourceSentPartsPage 文件头。
      -->
      <div class="pagination">
        <el-pagination
          v-model:current-page="page.query.page.value"
          v-model:page-size="page.query.pageSize.value"
          :page-sizes="[20, 50, 100, 200]"
          :total="page.query.total.value"
          layout="total, sizes, prev, pager, next, jumper"
          :pager-count="7"
          background
          size="small"
        />
      </div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
// views/outsource/OutsourceCompanySentParts.vue — 外协对账一览
//
// 数据源：`GET /api/v2/outsource-companies/{id}/sent-parts`（行 = 一条 shipment，即
// 「某公司已发出的一个零件」）。行编辑（双击 → Enter 保存 / Esc 取消）改
// 单价 / 数量 / 对账标记，走 `POST /outsource-shipments/{shipment_id}/reconcile-update`
// （**必传 `version`**，那是 shipment 行的 OCC 锚）。
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { TableInstance } from 'element-plus';
import ColumnVisibilityPopover from '@/components/ColumnVisibilityPopover.vue';
import ColumnDragHandle from '@/components/ColumnDragHandle.vue';
import { columnIdentifier, useColumnDrag } from '@/composables/useColumnDrag';
import { resolveDraggable } from '@/composables/useColumnVisibility';
import { useOutsourceSentPartsPage } from './composables/useOutsourceSentPartsPage';
import type { OutsourceSentPartItemSchema } from './composables/outsourceListSchema';
// 2026-10-09：列定义搬进 `outsourceSentPartColumnDefs.ts` 后，本组件模板里不再出现这 7 个
// 标签，而它们是用 h() 在 .ts 里直挂的（unplugin-vue-components 只处理模板标签 ⇒ 拿不到
// 样式注入）。显式补副作用 import，理由同 OutsourceList.vue 的同名注释。
import 'element-plus/es/components/tag/style/css';
import 'element-plus/es/components/input/style/css';
import 'element-plus/es/components/input-number/style/css';
import 'element-plus/es/components/switch/style/css';
import 'element-plus/es/components/select/style/css';
import 'element-plus/es/components/tree-select/style/css';
import 'element-plus/es/components/date-picker/style/css';

const route = useRoute();
const router = useRouter();
const companyId = String(route.params.id ?? '');

const page = useOutsourceSentPartsPage(companyId);

const columnDefs = page.columnDefs;
const drag = useColumnDrag(columnDefs, { listKey: 'outsource_company_sent_parts' });
const tableRef = ref<TableInstance | null>(null);

function onRowDblClick(row: OutsourceSentPartItemSchema): void {
  page.edit.startEdit(row);
}

function onResetFilters(): void {
  page.query.resetAllFilters();
}

function onBack(): void {
  void router.push('/outsource/companies');
}

onMounted(() => {
  drag.applyDrag(tableRef);
  page.query.restoreState();
  if (typeof document !== 'undefined') {
    document.addEventListener('keydown', page.edit.onEditKeydown);
  }
});

// 换公司（同一路由不同 id）时整份状态重来：筛选 / 页码 / 编辑中行都不该带过去。
watch(
  () => route.params.id,
  (next) => {
    // 2026-10-10 加「本页是否活跃」守卫。本页**是被缓存的**（路由名
    // `OutsourceCompanySentParts` = 组件文件名，匹配上 MainLayout 的 keep-alive
    // include），而 `useRoute()` 注入的是全局响应式 currentRoute：用户在这个 tab 还
    // 开着时用侧栏切到任何别的页面，watcher 照样触发 ⇒ 「换公司就退回列表」这条规则
    // 会在用户根本没换公司的场景下执行，把他从正在看的页面弹回外协公司列表。
    //
    // 只有「本页仍是 active 路由」且「新 id 不是本页锚定的那个公司」才处理；两者是
    // 同一个语义：这不是本页的合法换页，是别的页面改了全局路由。
    if (route.name !== 'OutsourceCompanySentParts') return;
    if (String(next ?? '') !== companyId) void router.replace('/outsource/companies');
  },
);

onBeforeUnmount(() => {
  if (typeof document !== 'undefined') {
    document.removeEventListener('keydown', page.edit.onEditKeydown);
  }
});
</script>

<style lang="scss" scoped>
.outsource-billing {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.header-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.header-title {
  margin: 0;
  font-size: 16px;
}
.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.total-hint {
  color: var(--text-secondary);
  font-size: 13px;
}
.table-toolbar {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 8px;
}
.pagination {
  display: flex;
  justify-content: flex-end;
  margin-top: 12px;
}
// 加急行整行红底（与零件一览 / 看板同款）
:deep(.el-table__row.row-urgent) > td.el-table__cell {
  background-color: #fde2e2 !important;
}
:deep(.el-table__row.row-urgent:hover) > td.el-table__cell {
  background-color: #fbcaca !important;
}
</style>