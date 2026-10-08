<!--
  UserTable.vue — 账号管理页的表格

  2026-10-10 新建：状态全部来自 `useUsersListStore`（Pinia setup store），本组件只持有
  el-table 的 DOM 逻辑：列可见性 / 列顺序拖动 / 表头筛选 popover 落点。
  形态照 `views/outsource/OutsourceList.vue` 里的表格段与
  `views/inspection/components/InspectionTable.vue`。

  为什么不再用 `PagedTable`：那个组件自管分页的本地状态机（fetcher 闭包，无缓存、无失效
  点），而本页的主查询已迁到域内 query hook（`composables/useUsersQuery.ts`）。

  两个表头筛选（后端早就支持、旧页面从未用过）：用户名（`username_like`，popover 文本）
  与状态（`is_active`，EP 原生 `:filters`）。`@filter-change` 只上报本次变更的那一列，
  由 store 翻译回 search。

  ⚠️ 传给 `ColumnVisibilityPopover` 的 defs **过滤掉了操作列**：操作列在 defs 里（行内按钮
  由注入的 actions 渲染），但它必须永远可见（沿旧版把它写成字面量 `<el-table-column>` 的
  行为）。`useColumnVisibility.update()` 会剪掉不在新 map 里的键，而 `isVisible()` 对未知键
  返回 true ⇒ 不把它列进开关就等于恒可见。
-->
<template>
  <div class="user-table-wrap">
    <div class="user-table-toolbar">
      <el-button link @click="store.query.resetAllFilters()">重置筛选</el-button>
      <ColumnVisibilityPopover
        :defs="visibilityDefs"
        :model-value="store.columnVisibility.currentMap"
        @update:model-value="store.columnVisibility.update"
        @reset="store.columnVisibility.showAll"
        @resetOrder="drag.reset"
      />
    </div>

    <el-table
      ref="tableRef"
      v-loading="store.query.loading"
      :data="store.query.items"
      row-key="id"
      stripe
      border
      size="small"
      style="width: 100%"
      @filter-change="store.query.onNativeFilterChange"
    >
      <template #empty>
        <el-empty :description="store.query.emptyText" />
      </template>

      <!-- 数据列 + 操作列全部由 store.columnDefs 驱动（顺序走 drag.orderedDefs，可见性走
           store.columnVisibility；#header 插槽 = headerRender（表头 popover）或
           label + ColumnDragHandle，#default 插槽 = cellRender）。 -->
      <template v-for="d in drag.orderedDefs.value" :key="columnIdentifier(d)">
        <el-table-column
          v-if="store.columnVisibility.isVisible(d.key)"
          :prop="d.prop ?? d.key"
          :label="d.label"
          :width="d.width"
          :min-width="d.minWidth"
          :fixed="d.fixed"
          :sortable="d.sortable"
          :align="d.align"
          :header-align="d.headerAlign"
          :show-overflow-tooltip="d.showOverflowTooltip"
          :filters="d.filters"
          :filter-multiple="d.filterMultiple"
          :filtered-value="d.filteredValue"
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
  </div>
</template>

<script setup lang="ts">
// views/users/components/UserTable.vue
//
// 2026-10-10 新建：见文件头。本组件 0 业务状态 —— 所有数据 / 筛选 / 列可见性都来自 store。

import { computed, onMounted, ref } from 'vue';
import ColumnDragHandle from '@/components/ColumnDragHandle.vue';
import ColumnVisibilityPopover from '@/components/ColumnVisibilityPopover.vue';
import { columnIdentifier, useColumnDrag } from '@/composables/useColumnDrag';
import { resolveDraggable } from '@/composables/useColumnVisibility';
import { useUsersListStore } from '../composables/useUsersListStore';

// 不变量 #1：表格组件内首调 store（与壳 UserList.vue 是同一个 Pinia 单例）。
const store = useUsersListStore();

/** 列可见性开关的候选：**剔除操作列**，让它恒可见（见文件头说明）。 */
const visibilityDefs = computed(() => store.columnDefs.filter((d) => d.key !== 'actions'));

// ============ 列顺序拖动 ============
// 与 store.columnVisibility 共享同一 columnDefs 数组；各自读自己的 localStorage key
// （`user_list_columnOrder` / `user_list_columns`），互不污染。拖动实例必须在组件里
// （列定义在 store，DOM 在组件）—— 与 PartsTable / InspectionTable 同款分工。
const drag = useColumnDrag(store.columnDefs, { listKey: 'user_list' });

const tableRef = ref(null);
defineExpose({ tableRef });

onMounted(() => {
  // 传 el-table 实例 ref 即可，composable 内部解析表头 <tr> + MutationObserver 自愈
  // （表头首次出现 / EP 重建都能覆盖）。
  drag.applyDrag(tableRef);
});
</script>

<style lang="scss" scoped>
.user-table-wrap {
  background: #fff;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  padding: 4px;
  overflow-x: auto;
}

.user-table-toolbar {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
  padding: 4px 6px 8px;
  min-height: 32px;
}

// 操作列五个按钮挤在一格：左对齐 + 小间距。
:deep(.row-actions) {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
}

:deep(.role-tags) {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 4px;
}

// 列定义在 usersColumnDefs.ts 里用 h() 造的单元格节点（灰字占位 / 状态 tag / 角色 tag 组）
// 不在本组件模板的渲染输出里 ⇒ scoped 选择器带不上 scopeId，必须用 :deep() 才能命中
// （scoped 写法会静默失效）。
:deep(.muted) {
  color: var(--text-secondary);
}

:deep(.status-count) {
  color: var(--el-color-primary);
}

// 列顺序拖动视觉反馈（与 InspectionTable / OutsourceList 同款藏青/蓝/浅蓝系）。
:deep(.col-no-drag) {
  cursor: default !important;
}
:deep(.sortable-ghost) {
  opacity: 0.5;
  background: #eaf2fb !important;
}
:deep(.sortable-chosen) {
  background: #cce0f4 !important;
}
:deep(.sortable-drag) {
  background: #fff !important;
}
</style>
