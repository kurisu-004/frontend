<!--
  PartListShell.vue — 共用「过滤卡 + 列可见性 + 表格 + 分页 + 加急红底」壳（T14，
  T14p5 修复 fetch 错误回传，T15 接入列顺序拖动）

  复用对象：
    - InspectionPending.vue（src/views/inspection/）
    - PendingProgrammingList.vue（src/views/cnc/）

  设计要点（2026-08-25 T14）：
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
      - safeFetcher 包装 props.fetcher：catch 写 errorMsg ref 后返回空结果，
                    成功清空 errorMsg；computed emptyText 优先渲染 errorMsg。
                    「后端抛错」与「队列本就空」在 el-table 空态一目了然。
  - 列可见性 popover 按 T2 模板提到 .table-toolbar 顶层 div；
    el-pagination 走 <PagedTable> 子组件收口；
    加急红底 #fde2e2 通过 :deep(.row-urgent) 注入，rowClassName 由视图传。

  设计要点（2026-08-27 T15 列顺序拖动接入）：
  - 列渲染改 v-for：drag.orderedDefs 提供持久化顺序，
    isVisible + isDraggable 在模板里控制列是否渲染 / 是否带拖动手柄。
  - useColumnDrag 与 useColumnVisibility 平行，二者共用 columnDefs。
  - columnDefs 字段扩展（useColumnVisibility 已扩展）：draggable / columnKey / type / fixed，
    沿用 useColumnDrag.resolveDraggable 推导。
  - onMounted 调 findElTableThead(tableRef.$el) + drag.applyDrag 把 useDraggable 挂到 <thead>。
  - 「重置列顺序」按钮在 ColumnVisibilityPopover footer；popover emit 'reset-order'
    透传到 shell 调 drag.reset()。
  - 列顺序持久化 key: myerp.list.<userId>.<listKey>_columnOrder
    （与 _columns / _paged 并列，零冲突）。
  - 兼容旧视图：default slot 仍可注入额外 el-table-column，shell 的 v-for 列 + slot 列
    共存。Task 3 会逐视图把 inline 列迁到 columnDefs.cellRender / columnDefs.headerRender。
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
        @reset-order="drag.reset"
      />
    </div>

    <PagedTable :fetcher="safeFetcher" :default-page-size="defaultPageSize">
      <template #default="{ items, loading }">
        <el-table
          ref="tableRef"
          :data="items"
          v-loading="loading"
          row-key="id"
          :empty-text="emptyText"
          stripe
          border
          size="small"
          :row-class-name="rowClassName"
        >
          <!--
            2026-08-27 接入：v-for 列渲染。drag.orderedDefs.value 提供持久化顺序；
            v-if 由 columnVisibility 控制是否展示。
            用 <template v-for> 包裹以兼容 Vue 3 同元素 v-for + v-if 优先级问题。
          -->
          <template v-for="d in drag.orderedDefs.value" :key="columnIdentifier(d)">
            <el-table-column
              v-if="columnVisibility.isVisible(d.key)"
              :prop="d.prop ?? d.key"
              :label="d.label"
              :type="d.type"
              :width="d.width"
              :min-width="d.minWidth"
              :fixed="d.fixed"
              :sortable="d.sortable"
              :align="d.align"
              :header-align="d.headerAlign"
              :show-overflow-tooltip="d.showOverflowTooltip"
              :formatter="d.formatter"
              :index="d.index"
              :selectable="d.selectable"
              :filters="d.filters"
              :filter-multiple="d.filterMultiple"
              :filter-method="d.filterMethod"
              :filtered-value="d.filteredValue"
              :sort-method="d.sortMethod"
              :sort-by="d.sortBy"
              :sort-orders="d.sortOrders"
              :resizable="d.resizable"
              :class-name="d.className"
              :label-class-name="
                resolveDraggable(d) ? d.labelClassName : `col-no-drag ${d.labelClassName ?? ''}`.trim()
              "
              :column-key="d.columnKey ?? d.key"
            >
              <!--
                2026-08-27 T15：自定义单元格渲染。d.cellRender(scope) 返回 VNode，
                <component :is> 在 Vue 3 中会克隆传入的 VNode 并渲染。
                仅当列定义里声明 cellRender 时启用，未声明则走 EP 默认（formatter / prop 透传）。
              -->
              <template v-if="d.cellRender" #default="scope">
                <component :is="d.cellRender(scope)" />
              </template>
              <!--
                可拖列（非 type / 非 fixed）的表头追加拖动手柄。
                selection/index/expand/fixed 列不挂 handle → sortablejs 不会把它们当 source。
              -->
              <template v-if="resolveDraggable(d) && !d.type && !d.fixed" #header>
                <span>{{ d.label }}</span>
                <ColumnDragHandle :title="`拖动 ${d.label} 列`" />
              </template>
            </el-table-column>
          </template>
          <!--
            兼容旧视图：default slot 仍可注入额外 el-table-column（视图中部分历史遗留）。
            优先方案：把列定义（含自定义单元格）放在 columnDefs.cellRender 里，本 slot 通常为空。
          -->
          <slot
            :items="items"
            :loading="loading"
            :is-visible="columnVisibility.isVisible"
            :is-draggable="resolveDraggable"
            :ordered-defs="drag.orderedDefs.value"
          />
        </el-table>
      </template>
    </PagedTable>
  </div>
</template>

<script setup lang="ts" generic="T extends { id: string | number }">
import { computed, onMounted, ref } from 'vue'
import { RefreshLeft } from '@element-plus/icons-vue'
import ColumnVisibilityPopover from '@/components/ColumnVisibilityPopover.vue'
import ColumnDragHandle from '@/components/ColumnDragHandle.vue'
import PagedTable from '@/components/PagedTable.vue'
import {
  useColumnVisibility,
  resolveDraggable,
  type ColumnDef,
} from '@/composables/useColumnVisibility'
import {
  useColumnDrag,
  columnIdentifier,
} from '@/composables/useColumnDrag'
import {
  usePagedListQuery,
  type PageQueryParams,
  type PageResult,
} from '@/composables/usePagedListQuery'
import { useListStatePersist } from '@/composables/useListFilterPersist'
import { findElTableThead } from '@/utils/elTable'

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

// 2026-08-25 T14p5：fetch 错误回传
// 旧 monolith 视图在 computed emptyText 里渲染 fetch 错误，方便用户区分
// 「队列空」与「后端挂了」。T14 PartListShell 静态 emptyText 把这个反馈丢了，
// 这里在 shell 内包装 fetcher：catch → 写 errorMsg，success → 清空；
// computed emptyText 优先用 errorMsg，否则用 prop。
const errorMsg = ref<string | null>(null)
const emptyText = computed(() => errorMsg.value ?? props.emptyText)

async function safeFetcher(params: PageQueryParams): Promise<PageResult<T>> {
  errorMsg.value = null
  try {
    return await props.fetcher(params)
  } catch (e) {
    errorMsg.value = (e as Error).message ?? '查询失败'
    return { items: [], total: 0 }
  }
}

// 列可见性（视图在 default slot 内通过 isVisible(key) 决定每列是否渲染）
const columnVisibility = useColumnVisibility(props.columnDefs, { listKey: props.listKey })

// 2026-08-27 T15：列顺序拖动（与 visibility 平行，共享 columnDefs）。
// orderedDefs 提供持久化的当前顺序，applyDrag 在 onMounted 挂到 <thead>。
const drag = useColumnDrag(props.columnDefs, { listKey: props.listKey })

// 分页状态 + 拉取（闭包由视图 fetcher 提供；safeFetcher 在 shell 里包一层 catch，
// PagedTable / usePagedListQuery 看到的 fetcher 是吞了错的，loading 才能稳定落地）
const {
  items,
  total,
  loading,
  pageSize,
  fetch,
  reset,
} = usePagedListQuery<T>(safeFetcher)

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

// 2026-08-27 T15：挂 useColumnDrag 到 el-table 的 <thead>。
// tableRef.value 是 EP el-table 组件实例，$el 是其根容器（外层 .el-table）。
// findElTableThead 走固定 selector 取真正的 <thead>。
const tableRef = ref()
onMounted(() => {
  const root = tableRef.value?.$el as HTMLElement | undefined
  if (!root) return
  const thead = findElTableThead(root)
  if (thead) drag.applyDrag(thead)
})

// 类型化 slot prop，便于 IDE 在视图侧取 scope 字段时能拿到推断
defineSlots<{
  filter(): unknown
  default(props: {
    items: T[]
    loading: boolean
    isVisible: (key: string) => boolean
    isDraggable: (def: ColumnDef) => boolean
    orderedDefs: ColumnDef[]
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
// 2026-08-27 T15：EP thead th 上的 col-no-drag 类让 sortablejs filter 跳过；
// 同时禁用默认 cursor（不可拖列不放 handle，应显示普通箭头）
:deep(.col-no-drag) { cursor: default !important; }
// sortablejs 拖动时的视觉反馈（与 EP 主题色协调，藏青/蓝/浅蓝系）
:deep(.sortable-ghost) { opacity: 0.5; background: #eaf2fb !important; }
:deep(.sortable-chosen) { background: #cce0f4 !important; }
:deep(.sortable-drag) { background: #fff !important; }
</style>
