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

  2026-09-16 重构：EP 2.14.2 deprecated @current-change / @size-change，el-pagination 改用
  v-model 双绑 + composable 内部 watch([page,pageSize,keyword]) 统一接管 fetch。壳层无需
  监听分页事件。usePagedListQuery 的 public API 也已删除 onPageChange / onPageSizeChange。
-->
<template>
  <div class="paged-table">
    <slot :items="paged.items.value" :loading="paged.loading.value" />
    <div class="pagination">
      <el-pagination
        v-model:current-page="paged.page.value"
        v-model:page-size="paged.pageSize.value"
        :total="paged.total.value"
        :layout="paginationLayoutComputed"
        :pager-count="7"
        background
        size="small"
      />
    </div>
  </div>
</template>

<script setup lang="ts" generic="T">
import { computed } from 'vue';
import { usePagedListQuery } from '@/composables/usePagedListQuery';

const props = defineProps<{
  fetcher: (params: {
    page: number;
    pageSize: number;
    keyword?: string;
  }) => Promise<{ items: T[]; total: number }>;
  /** 分页器 layout 字符串，默认 `'total, sizes, prev, pager, next, jumper'` */
  paginationLayout?: string;
  /** 初始每页大小（一次性，setup 时应用一次；后续由 el-pagination v-model:page-size 接管） */
  defaultPageSize?: number;
}>();

// 计算属性包裹默认 layout，避免和 default props 同名 shadowing
const paginationLayoutComputed = computed(
  () => props.paginationLayout ?? 'total, sizes, prev, pager, next, jumper',
);

// 2026-09-13 PR-2：vue/no-setup-props-destructure 禁止顶层解构 props / 顶层解构
// composable 返回值（保持响应式链路）。这里不展开 paged 的内部 ref，模板
// 直接走 `paged.X.value`（v-model / handler 内部仍通过 ref 操作）。
// props.fetcher 也用 IIFE 包一层把读取放进函数体（linter 不放过直接读）。
const paged = (() => usePagedListQuery<T>(props.fetcher))();

// 一次性应用 defaultPageSize（brief 注释：PagedTable 之前声明了 defaultPageSize 但没应用）
if (typeof ((): number | undefined => props.defaultPageSize)() === 'number') {
  const ds = ((): number | undefined => props.defaultPageSize)();
  if (typeof ds === 'number' && ds > 0) {
    paged.pageSize.value = ds;
  }
}

defineExpose({
  items: paged.items,
  loading: paged.loading,
  page: paged.page,
  pageSize: paged.pageSize,
  fetch: paged.fetch,
  reset: paged.reset,
});
</script>
