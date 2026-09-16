// composables/usePagedListQuery.ts
//
// 通用分页 + 可选关键字 列表查询 composable（Task 7）。
// 把 el-pagination v-model + 搜索 keyword + fetch + loading 状态机收成一个 ref 组，
// 给 <PagedTable> 内部使用；view 侧不直接 import（brief 明确：usePagedListQuery
// 走 PagedTable 包装这一条路，不直接套到 view 上）。
//
// 设计要点（2026-08-25）：
// - fetcher 签名与 el-table / el-pagination 解耦：view 自己把 view 本地 search.* 揉进去，
//   返回 { items, total } 即可。view 仍维护自己的 search reactive（含 keyword 以外的
//   过滤项：statuses / customer_id / date range 等），keyword 参数为可选（view 不用就忽略）。
// - keyword 改变时 onSearch() 同时把 page 重置 1，pageSize 改变时同样；这是「搜了就要看第一页」
//   的标准语义。
// - reset() 把 page 回到 1 并清空 keyword；保留 async 签名以兼容 view 端 `await pagedRef.value?.reset()`。
// - fetch 失败时不抛（view 自行 try/catch），但 loading 永远会清掉。
//
// 2026-09-16 重构：删 onPageChange / onPageSizeChange（EP 2.14.2 弃用 @current-change /
// @size-change，改 v-model + watch）；watcher 内部统一接管 [page, pageSize, keyword]
// 任意变化触发 fetch。onSearch / reset 只改 ref（不再显式 fetch），watcher 入队后
// 在 nextTick 触发 fetch。
//
// suppressSetupChange 处理 PagedTable.vue 在 setup 内应用 defaultPageSize 触发的首次 watcher：
// - 当 pageSize 从 initialPageSize 变为其它值、且 page/keyword 没变时 → 是 setup 内的
//   defaultPageSize 同步赋值（Vue 把变化入队到 watcher），需要忽略这一次回调。
// - 用户后续任何交互都会让 oldSize !== initialPageSize 或 page/keyword 改变，自然落入 fetch 分支。
// 不能简单用 boolean ignoreFirst 旗标：因为 defaultPageSize=20 与 initialPageSize=20 相同时，
//   Vue 不会触发 watcher（值未变），ignoreFirst 仍为 true，会误吞第一次用户交互。

import { ref, watch, type Ref } from 'vue';

export interface PageResult<T> {
  items: T[];
  total: number;
}

export interface PageQueryParams {
  page: number;
  pageSize: number;
  keyword?: string;
}

export interface UsePagedListQueryReturn<T> {
  items: Ref<T[]>;
  total: Ref<number>;
  loading: Ref<boolean>;
  page: Ref<number>;
  pageSize: Ref<number>;
  keyword: Ref<string>;
  fetch: () => Promise<void>;
  onSearch: (k: string) => void;
  reset: () => Promise<void>;
}

/**
 * 通用分页查询 composable。
 *
 * @param fetcher 接收 { page, pageSize, keyword? }，返回 { items, total }。
 *                keyword 是可选的——view 没有独立搜索框就可以忽略。
 */
export function usePagedListQuery<T>(
  fetcher: (params: PageQueryParams) => Promise<PageResult<T>>,
): UsePagedListQueryReturn<T> {
  const items = ref<T[]>([]) as Ref<T[]>;
  const total = ref(0);
  const loading = ref(false);
  const page = ref(1);
  const pageSize = ref(20);
  const keyword = ref('');

  // 2026-09-16 重构：捕获初始 pageSize 值，用于识别 PagedTable.vue 在 setup 内应用
  // defaultPageSize 触发的 watcher。用 IIFE 把 .value 读取挪到独立作用域，规避
  // vue/no-ref-object-destructure（误报：这里就是要捕获一次快照，不希望响应式更新）。
  const initialPageSize = (() => pageSize.value)();

  async function fetch(): Promise<void> {
    loading.value = true;
    try {
      const result = await fetcher({
        page: page.value,
        pageSize: pageSize.value,
        keyword: keyword.value || undefined,
      });
      items.value = result.items;
      total.value = result.total;
    } finally {
      loading.value = false;
    }
  }

  // 2026-09-16 重构：watch [page, pageSize, keyword] 统一接管 fetch，替代事件钩子
  //（EP 2.14.2 deprecated @current-change / @size-change）。
  watch(
    () => [page.value, pageSize.value, keyword.value] as const,
    ([newPage, newSize, newKeyword], [oldPage, oldSize, oldKeyword]) => {
      // 跳过 PagedTable.vue setup 内应用 defaultPageSize 触发的首次 watcher：
      // pageSize 从 initialPageSize 变为其它、其它维度未变 → 这是 setup 内的同步赋值，
      // consumer 的 onMounted 显式 fetch() 是真正的首屏拉取入口。
      if (
        oldSize === initialPageSize &&
        newSize !== initialPageSize &&
        newPage === 1 &&
        oldPage === 1 &&
        newKeyword === '' &&
        oldKeyword === ''
      ) {
        return;
      }
      // pageSize 变化但当前不在第 1 页：先复位 page=1（链式再触发 watcher 落入 fetch 分支）
      if (newSize !== oldSize && newPage !== 1) {
        page.value = 1;
        return;
      }
      void fetch();
    },
  );

  function onSearch(k: string): void {
    // 2026-09-16 重构：watcher 接管 fetch，仅写 ref。
    page.value = 1;
    keyword.value = k;
  }

  async function reset(): Promise<void> {
    // 2026-09-16 重构：watcher 接管 fetch，仅写 ref；保留 async/Promise<void> 签名
    // 以兼容 view 端 `await pagedRef.value?.reset()`。
    page.value = 1;
    keyword.value = '';
    return Promise.resolve();
  }

  return {
    items,
    total,
    loading,
    page,
    pageSize,
    keyword,
    fetch,
    onSearch,
    reset,
  };
}
