<!--
  PartListShell.vue — 共用「过滤卡 + 列可见性 + 表格 + 分页 + 加急红底」壳（T14）

  复用对象：
    - InspectionPending.vue（src/views/inspection/）
    - PendingProgrammingList.vue（src/views/cnc/）

  设计要点（2026-08-25）：
  - 视图提供：fetcher、columnDefs、listKey、emptyText、rowClassName
  - 视图提供两个 slot：
      #filter                  filter 行输入控件（视图自管 search.* 绑定）
      #default(scope)          el-table-column 定义，scope 暴露
                               { items, loading, isVisible }
  - 视图通过 ref="listRef" 拿到：
      items / total / loading / pageSize / fetch / reset / onRefresh
  - Shell 内部：
      - usePagedListQuery  持有分页状态（items/total/loading/page/pageSize）
      - useColumnVisibility 持有列可见性 map（listKey 维度持久化）
      - useListStatePersist 持久化 pageSize（key = `${listKey}_paged`，
                           与视图自管的 filter 持久化互不冲突）
  - 列可见性 popover 按 T2 模板提到 .table-toolbar 顶层 div；
    el-pagination 走 <PagedTable> 子组件收口；
    加急红底 #fde2e2 通过 :deep(.row-urgent) 注入，rowClassName 由视图传。
-->
<template>
  <div class="part-list-shell">
    <el-card shadow="never" class="filter-card">
      <div class="filter-row">
        <slot name="filter" />
        <el-button @click="onRefresh">
          <el-icon><RefreshLeft /></el-icon>
          <span>刷新</span>
        </el-button>
        <span v-if="total > 0" class="total-hint">共 {{ total }} 条</span>
        <el-tag v-else-if="!loading" type="info" effect="plain" size="small">
          {{ emptyText }}
        </el-tag>
      </div>
    </el-card>

    <div class="table-toolbar">
      <ColumnVisibilityPopover
        :defs="columnDefs"
        :model-value="columnVisibility.currentMap"
        @update:model-value="columnVisibility.update"
        @reset="columnVisibility.showAll"
      />
    </div>

    <PagedTable :fetcher="fetcher" :default-page-size="defaultPageSize">
      <template #default="{ items, loading }">
        <el-table
          :data="items"
          v-loading="loading"
          row-key="id"
          :empty-text="emptyText"
          stripe
          border
          size="small"
          :row-class-name="rowClassName"
        >
          <slot
            :items="items"
            :loading="loading"
            :is-visible="columnVisibility.isVisible"
          />
        </el-table>
      </template>
    </PagedTable>
  </div>
</template>

<script setup lang="ts" generic="T extends { id: string | number }">
import { RefreshLeft } from '@element-plus/icons-vue'
import ColumnVisibilityPopover from '@/components/ColumnVisibilityPopover.vue'
import PagedTable from '@/components/PagedTable.vue'
import { useColumnVisibility, type ColumnDef } from '@/composables/useColumnVisibility'
import {
  usePagedListQuery,
  type PageQueryParams,
  type PageResult,
} from '@/composables/usePagedListQuery'
import { useListStatePersist } from '@/composables/useListFilterPersist'

const props = withDefaults(defineProps<{
  columnDefs: readonly ColumnDef[]
  fetcher: (params: PageQueryParams) => Promise<PageResult<T>>
  listKey: string
  defaultPageSize?: number
  emptyText?: string
  rowClassName?: (ctx: { row: T; rowIndex: number }) => string
}>(), {
  defaultPageSize: 20,
  emptyText: '暂无数据',
  rowClassName: () => '',
})

// 列可见性（视图在 default slot 内通过 isVisible(key) 决定每列是否渲染）
const columnVisibility = useColumnVisibility(props.columnDefs, { listKey: props.listKey })

// 分页状态 + 拉取（闭包由视图 fetcher 提供，filter 状态由视图自管）
const {
  items,
  total,
  loading,
  pageSize,
  fetch,
  reset,
} = usePagedListQuery<T>(props.fetcher)

// 持久化 pageSize（视图不再操心；与视图的 filter 持久化 key 互不冲突）
const { restore: restorePageSize } = useListStatePersist(
  `${props.listKey}_paged`,
  { pageSize },
  { exclude: new Set(['page']) },
)
const restored = restorePageSize() as { pageSize?: number } | null
if (restored && typeof restored.pageSize === 'number' && restored.pageSize > 0) {
  pageSize.value = restored.pageSize
}

async function onRefresh(): Promise<void> {
  // 刷新按钮 = 「重置到第 1 页 + 重新拉取」，与 T7 之前 InspectionPending 的 onSearch 语义一致
  await reset()
}

// 类型化 slot prop，便于 IDE 在视图侧取 scope 字段时能拿到推断
defineSlots<{
  filter(): unknown
  default(props: {
    items: T[]
    loading: boolean
    isVisible: (key: string) => boolean
  }): unknown
}>()

defineExpose({
  items,
  total,
  loading,
  pageSize,
  fetch,
  reset,
  onRefresh,
})
</script>

<style lang="scss" scoped>
.part-list-shell {
  padding: 0;
}
.filter-card {
  margin-bottom: 12px;
}
.filter-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.total-hint {
  margin-left: auto;
  color: var(--text-secondary);
  font-size: 13px;
}
.table-toolbar {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 8px;
}
// 加急红底（与 PartsList / InspectionPending 旧实现 同款 #fde2e2）
:deep(.row-urgent) {
  background: #fde2e2 !important;
}
:deep(.row-urgent td) {
  background: #fde2e2 !important;
}
</style>
