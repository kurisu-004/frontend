<!--
  PagedTable.vue — 通用「分页 + 表格」壳（Task 7）

  目的：把每个 list view 都重复写的：
    <el-table :data="items" v-loading="loading">...</el-table>
    <el-pagination v-model:current-page="page" v-model:page-size="pageSize" .../>
  收成一个组件。

  用法（brief 模板）：
    <PagedTable :fetcher="fetchList" :default-page-size="20">
      <template #default="{ items, loading }">
        <el-table :data="items" v-loading="loading">...</el-table>
      </template>
    </PagedTable>

  - fetcher：必填，签名 (params: { page, pageSize, keyword? }) => Promise<{ items, total }>
  - view 本地的搜索 reactive（keyword 之外的过滤项）由 view 自己揉进 fetcher 闭包。
  - view 需要触发刷新（onSearch / onReset / 自动刷新）→ 通过 ref="pagedRef" 拿 fetch / reset。

  设计要点（2026-08-25）：
  - 内部用 usePagedListQuery<T> 持有所有分页状态；view 不直接导入 composable。
  - 不加 <style>：brief 明确「不加 style block」（T1 已经删了 breakpoints additionalData，
    任何 @include from/until 会坏；保持组件完全样式中立，让外层 .pagination 仍由 view 控制）。
  - defineExpose 暴露 items / loading / page / pageSize / fetch / reset 方便 view 触发刷新。
-->
<template>
  <div class="paged-table">
    <slot :items="items" :loading="loading" />
    <div class="pagination">
      <el-pagination
        v-model:current-page="page"
        v-model:page-size="pageSize"
        :total="total"
        :layout="paginationLayoutComputed"
        :pager-count="7"
        background
        size="small"
        @current-change="onPageChange"
        @size-change="onPageSizeChange"
      />
    </div>
  </div>
</template>

<script setup lang="ts" generic="T">
import { computed } from 'vue'
import { usePagedListQuery } from '@/composables/usePagedListQuery'

const props = defineProps<{
  fetcher: (params: { page: number; pageSize: number; keyword?: string }) => Promise<{ items: T[]; total: number }>
  /** 分页器 layout 字符串，默认 `'total, sizes, prev, pager, next, jumper'` */
  paginationLayout?: string
  /** 初始每页大小（一次性，setup 时应用一次；后续由 el-pagination v-model:page-size 接管） */
  defaultPageSize?: number
}>()

// 计算属性包裹默认 layout，避免和 default props 同名 shadowing
const paginationLayoutComputed = computed(
  () => props.paginationLayout ?? 'total, sizes, prev, pager, next, jumper',
)

const {
  items,
  total,
  loading,
  page,
  pageSize,
  fetch,
  reset,
  onPageChange,
  onPageSizeChange,
} = usePagedListQuery<T>(props.fetcher)

// 一次性应用 defaultPageSize（brief 注释：PagedTable 之前声明了 defaultPageSize 但没应用）
if (typeof props.defaultPageSize === 'number' && props.defaultPageSize > 0) {
  pageSize.value = props.defaultPageSize
}

defineExpose({ items, loading, page, pageSize, fetch, reset })
</script>
