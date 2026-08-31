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
      - 列可见性 / 列顺序拖动 仍在 PartListShell 自管（持久化 key 与视图 filter 互不冲突）
      - 分页 + 拉取 全部下放到子组件 <PagedTable>（其内部 usePagedListQuery 持状态）；
        PartListShell 不再单独维护一份 usePagedListQuery，避免「两份实例 A/B」撕裂
        el-table 数据源与「共 N 条」展示。
      - safeFetcher 包装 props.fetcher：catch 写 errorMsg ref 后返回空结果，
                    成功清空 errorMsg 并把 total 落到本地 totalRef；
                    computed emptyText 优先渲染 errorMsg。
                    「后端抛错」与「队列本就空」在 el-table 空态一目了然。

  设计要点（2026-08-28 列顺序拖动接入）：
  - 列渲染改 v-for：drag.orderedDefs 提供持久化顺序，
    isVisible + isDraggable 在模板里控制列是否渲染 / 是否带拖动手柄。
  - useColumnDrag 与 useColumnVisibility 平行，二者共用 columnDefs。
  - columnDefs 字段扩展（useColumnVisibility 已扩展）：draggable / columnKey / type / fixed，
    沿用 useColumnDrag.resolveDraggable 推导。
  - 传 el-table 实例 ref 给 drag.applyDrag(tableRef)，composable 内部解析表头 +
    MutationObserver 自愈（覆盖 EP 重建表头 / 数据到达后表头首次渲染）。
  - 「重置列顺序」按钮在 ColumnVisibilityPopover footer；popover emit 'reset-order'
    透传到 shell 调 drag.reset()。
  - 列顺序持久化 key: myerp.list.<userId>.<listKey>_columnOrder
    （与 _columns / _paged 并列，零冲突）。
  - 兼容旧视图：default slot 仍可注入额外 el-table-column，shell 的 v-for 列 + slot 列
    共存。Task 3 会逐视图把 inline 列迁到 columnDefs.cellRender / columnDefs.headerRender。

  设计要点（2026-08-31 双实例修复）：
  - 旧实现 PartListShell 自己 usePagedListQuery（实例 A），PagedTable 又自己
    usePagedListQuery（实例 B）。el-table :data 绑 PagedTable slot 的 items（实例 B），
    但父视图 fetchList() 调 listRef.fetch() 实际更新的是 A。结果 B 永远空，
    表内「当前无待品检零件」，而 filter 卡「共 N 条」（A.total）显示正确 →
    撕裂的诊断特征。
  - 新实现：去掉 PartListShell 的 usePagedListQuery，统一从 PagedTable 实例拿 refs。
  - PagedTable 已 defineExpose({ items, loading, page, pageSize, fetch, reset })，
    不暴露 total。template 的「共 N 条」靠 safeFetcher 截留 total 到本地 totalRef
    （避免再改 PagedTable.vue / 视图侧代码）。
  - pageSize 持久化已彻底删除（2026-08-31）：Vue 3.5 在 `ref="pagedTableRef"` 上
    拿到的 component proxy 会自动 unwrap 暴露的 Ref，原 `pagedTableRef.value.pageSize.value = N`
    在 number 上写 .value 直接抛 TypeError（崩溃而非静默失败）。直接动 PagedTable.vue
    （新增 prop / setPageSize）被本任务约束禁止；改用「不写 .value」的 fragile
    写法不靠谱。最终选择放弃 pageSize 跨会话恢复，进入视图时一律 defaultPageSize。
    列可见性 / 列顺序的持久化不受影响（仍各自走自己的 localStorage key）。
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

    <!--
      关键修复：ref="pagedTableRef" 让 PartListShell 拿到 PagedTable 实例；
      其 defineExpose 的 items / loading / fetch / reset 是 el-table 真正绑定的数据源。
    -->
    <PagedTable
      ref="pagedTableRef"
      :fetcher="safeFetcher"
      :default-page-size="defaultPageSize"
    >
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
              :label-class-name="drag.dragLabelClass(d)"
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
import { computed, onMounted, ref, shallowRef, type Ref } from 'vue'
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
  // 2026-08-31：usePagedListQuery 不再由 PartListShell 直接持有（避免双实例撕裂），
  // 但 PageQueryParams / PageResult 仍用作 fetcher 签名类型。
  usePagedListQuery,
  type PageQueryParams,
  type PageResult,
} from '@/composables/usePagedListQuery'

// 2026-08-31：PagedTable.vue 的 defineExpose({ items, loading, page, pageSize, fetch, reset })
// 不会被 Vue 的 InstanceType<typeof PagedTable> 透传到 CreateComponentPublicInstance 上，
// 手动定义一份暴露类型让 PartListShell 透传时类型正确（与 PagedTable 保持同步）。
interface PagedTableExposed<T> {
  items: Ref<T[]>
  loading: Ref<boolean>
  page: Ref<number>
  pageSize: Ref<number>
  fetch: () => Promise<void>
  reset: () => Promise<void>
}

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
//
// 2026-08-31：safeFetcher 同步把 result.total 落到本地 totalRef。
// 原因：PagedTable 不暴露 total（按本任务约束不修改 PagedTable.vue），
// 但 template 的「共 N 条」需要展示真实 total；safeFetcher 是唯一被 PagedTable
// 真正调用的 fetcher 包装点，在此处截留 total 是最小侵入的做法。
const errorMsg = ref<string | null>(null)
// template 里 `v-if="total > 0"` / `共 {{ total }} 条` 直接读 total，所以 total
// 必须是同 setup 作用域的顶层 ref（不能只藏在 defineExpose 的 getter 里）。
const total = ref(0)
const emptyText = computed(() => errorMsg.value ?? props.emptyText)

// template 的 `!loading` 也要在 setup 作用域内；PagedTable 暴露的 loading
// 是 instance B 的真值（el-table v-loading 也用这个）。computed 透传，
// mount 前 pagedTableRef 为 null → fallback false（与原代码默认一致）。
const loading = computed<boolean>(
  () => pagedTableRef.value?.loading?.value ?? false,
)

async function safeFetcher(params: PageQueryParams): Promise<PageResult<T>> {
  errorMsg.value = null
  try {
    const result = await props.fetcher(params)
    total.value = result.total
    return result
  } catch (e) {
    errorMsg.value = (e as Error).message ?? '查询失败'
    total.value = 0
    return { items: [], total: 0 }
  }
}

// 列可见性（视图在 default slot 内通过 isVisible(key) 决定每列是否渲染）
const columnVisibility = useColumnVisibility(props.columnDefs, { listKey: props.listKey })

// 2026-08-27 T15：列顺序拖动（与 visibility 平行，共享 columnDefs）。
// orderedDefs 提供持久化的当前顺序，applyDrag 在 onMounted 挂到表头 <tr>（列换序；
// 绑 thead 会变成拖整行，2026-08-27 修正）。
const drag = useColumnDrag(props.columnDefs, { listKey: props.listKey })

// ============ 2026-08-31 双实例修复：让 PagedTable 成为状态唯一来源 ============
//
// 原实现：PartListShell 自己 usePagedListQuery<T>(safeFetcher)（实例 A），又通过
// <PagedTable> 间接 new 了一份（实例 B）。el-table :data 绑的是 PagedTable slot-scope
// 的 items（实例 B），但父视图调 listRef.fetch() 实际更新的是 A。结果 B 永远空，
// 表内「当前无待品检零件」，filter 卡的「共 N 条」（A.total）反而是对的 → 撕裂。
//
// 新实现：去掉 PartListShell 的 usePagedListQuery；通过 ref 拿 PagedTable 实例，
// 把 PagedTable 已 defineExpose 的 refs 透传出去。usePagedListQuery 仍 import 是因为
// 其 PageQueryParams / PageResult 类型仍被 fetcher 签名引用（且为未来 shell 内
// 调试 / 测试需要保留符号入口，不删除 import 减少 cleanup 风险）。
// 2026-08-31：用 shallowRef 防止 Vue 的 UnwrapRef 把 PagedTableExposed 内部的
// Ref<...> 嵌套全部解包成裸值（ref<T> 会让类型层面展开 .value，与运行时
// reactive 包裹 + 自动解包表现一致）。shallowRef 不做深度响应化，保留
// Ref 包装的类型形态，让 getter / computed 能拿到 .value 访问权。
const pagedTableRef = shallowRef<PagedTableExposed<T> | null>(null)

async function onRefresh(): Promise<void> {
  // 刷新按钮 = 「重置到第 1 页 + 重新拉取」，与 T7 之前 InspectionPending 的 onSearch 语义一致
  await pagedTableRef.value?.reset()
}

// 2026-08-28 改造：传 el-table 实例 ref，composable 内部解析表头 + MutationObserver
// 自愈（覆盖 EP 重建表头 / 数据到达后表头首次渲染）。consumer 0 行 query 代码。
//
// 2026-08-31 双实例修复：去掉 pageSize 持久化（详见顶部「2026-08-31 双实例修复」
// 注释块）。pageSize 在每次进入视图时都从 props.defaultPageSize 起算，
// 不再跨会话恢复。取舍依据：PagedTable 已 defineExpose({ items, loading, page,
// pageSize, fetch, reset })，其中 pageSize 是 Ref<number>。Vue 3.5 在
// `ref="pagedTableRef"` 上赋值的是组件 proxy，proxy 的 getter 会自动 unwrap
// 暴露的 ref —— 因此 `pagedTableRef.value.pageSize` 直接拿到 number 而非 Ref。
// 原代码 `pagedTableRef.value.pageSize.value = N` 在 number 上赋值 .value 抛
// "Cannot create property 'value' on number '20'"（TypeError）。改用 `pageSize.value`
// 形式不靠谱：Vue 3.5 的 component proxy setter 在 ref 类型暴露时**不能保证**写回
// 暴露的 ref；直接修改 PagedTable.vue 暴露 setPageSize 又被约束禁止。
// 最终选择：彻底放弃 pageSize 持久化，避免跨组件 ref 写权博弈。
const tableRef = ref()
onMounted(() => {
  drag.applyDrag(tableRef)
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

// ============ 转发 PagedTable 的 refs（el-table 真正绑定的数据源）============
//
// items / pageSize 用 getter：pagedTableRef 在 mount 前为 null，fallback 返回
// computed 让消费者 `listRef.value.items.value` 始终可用。
// total / loading 是 setup 作用域内已有的顶层变量，直接 ref 暴露（保持 ref 类型）。
// fetch / reset / onRefresh 是函数，直接透传。
defineExpose({
  get items() {
    return pagedTableRef.value?.items ?? computed(() => [] as T[])
  },
  total,
  loading,
  get pageSize() {
    return pagedTableRef.value?.pageSize ?? computed(() => props.defaultPageSize)
  },
  fetch: () => pagedTableRef.value?.fetch(),
  reset: () => pagedTableRef.value?.reset(),
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