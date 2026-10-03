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
// - reset() 把 page 回到 1 并清空 keyword，并在 page / keyword 本已是目标值时靠内部
//   reloadToken 补出一次触发（前提：同一 tick 内 pageSize 也不变，否则会被 suppressSetupChange
//   守卫整条吞掉，边界见文件头 2026-10-04 段）；保留 async 签名以兼容
//   view 端 `await pagedRef.value?.reset()`。
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
//
// 2026-10-04 新增 reloadToken：让 reset() 在「同值赋值」场景下也能重新拉一次。
// 背景：view 的真实筛选条件（customer_id / status / date range 等）放在 **view 本地
// reactive** 里，只在 fetcher 闭包中读（PagedTable 的既定设计），本 composable 的 watcher
// 看不见它们 —— 所以 reset() 的「重新拉」唯一可依赖的信号就是自己手里这三个 ref。
// 而 Vue 只在值真的变化时才触发 watcher：当 page 已是 1 且 keyword 已是 '' 时，
// `page.value = 1` / `keyword.value = ''` 都是同值赋值，一次回调都不入队 ⇒ 点「重置」
// 零请求、列表永远停在旧结果（全仓所有 reset() 调用点的语义都是「要重新拉」，
// 无一依赖「reset 不发请求」）。reloadToken 是模块内私有的单调递增计数器，
// 拼进 watch 的 getter 数组末尾当第 4 个信号：它变 → watcher 必被触发 → 恰好一次 fetch。
// 回调里仍只解构前 3 项（守卫逻辑按 page / pageSize / keyword 三元组判定，与 token 无关）。
//
// ⚠️ 生效前提，勿当无条件保证：上面这条兜底只在「page / keyword / pageSize 三者在这次
// reset 里都没变」时兑现。suppressSetupChange 守卫对 reloadToken 完全无感知 —— 它只比对
// page / pageSize / keyword 的新旧值，而 Vue 的 oldValue 取自上一次**回调**的入参，同一 tick
// 内的中间态不会成为 oldValue。于是只要 reset() 与 pageSize 变更落在同一 tick、且守卫的 6 个
// 条件恰好全中（典型组合：reset() 与 PagedTable setup 期写 defaultPageSize 同 tick；或先
// page=2 / pageSize=50 再 reset() 同 tick），回调就会 return ⇒ 那一次零请求。
// 当前全仓 reset() 调用点都是交互 handler（@click / @keyup.enter / @clear / ListShell 自带
// 「刷新」），构造不出该组合，故维持现状不改守卫。若将来有人在 setup / onMounted /
// restoreState 里调 reset()（例如想拿 reset 兜首屏拉取），必须先把守卫改成能感知 token
// （回调解构第 4 项并比较新旧 token，或补一条 oldToken === newToken 才不抑制），
// 否则那次 reset 不会发请求。

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

  // 2026-10-04 新增：reset() 的「强制重新拉」信号。只拼进 watch 的 getter 数组末尾，
  // 回调不解构它 —— 存在意义就是让「同值赋值」也能触发一次 watcher。
  const reloadToken = ref(0);

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
  // 2026-10-04：getter 末尾追加 reloadToken，让 reset() 在 page/keyword 已是目标值时
  // 也能触发（详见文件头说明）。回调只解构前 3 项，下面守卫的判定口径不受影响。
  watch(
    () => [page.value, pageSize.value, keyword.value, reloadToken.value] as const,
    ([newPage, newSize, newKeyword], [oldPage, oldSize, oldKeyword]) => {
      // 跳过 PagedTable.vue setup 内应用 defaultPageSize 触发的首次 watcher：
      // pageSize 从 initialPageSize 变为其它、其它维度未变 → 这是 setup 内的同步赋值，
      // consumer 的 onMounted 显式 fetch() 是真正的首屏拉取入口。
      // 守卫对 reloadToken 无感知：同 tick 内若还有 reset()，会被这一条一起吞掉（边界见文件头）。
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
    // 2026-10-04 新增：page / keyword 可能本已是目标值（同值赋值不触发 watcher），
    // 用 token 兜底让「reset 要重新拉」在这两个值未变时仍能成立（同 tick 内 pageSize 也变
    // 时会被 suppressSetupChange 守卫吞掉，边界见文件头 2026-10-04 段）。同一 tick 内多次
    // reset 会被 Vue 批处理合并成一次 watcher 回调 ⇒ 仍然只发一次 fetch。
    reloadToken.value++;
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
