// composables/usePendingProgrammingList.ts
//
// PendingProgrammingList 视图的列表状态 + fetcher（T14，T14p5 修正 fetch 错误回传）。
// 持有「业务状态」（search / autoRefresh / activeTab）+ fetcher + restoreFilter；
// 分页状态（items / total / loading / pageSize）由 <ListShell> 内部
// usePagedListQuery 持有，视图通过 listRef 拿到。
//
// 设计要点（2026-08-25）：
// - fetcher 闭包 self.search，固定 sort_by='PLANNED_DELIVERY_DATE' /
//   sort_dir='ASC'（与旧 PendingProgrammingList 行为一致）。
// - fetch 抛出后由 ListShell.safeFetcher 捕获并写到内部 errorMsg ref，
//   computed emptyText 显示给用户（T14p5）。早期版本 try/catch 内吞了 e
//   再 return { items: [], total: 0 }，errorMsg 只写回自己的 ref，shell 看不到，
//   用户只能看到静态 "当前无待编程零件"，分不清队列空 vs 后端挂了。
// - pageSize 持久化由 ListShell 内部 useListStatePersist 收口（key =
//   `pending_programming_paged`）。
// - 本 composable 仅持久化 search / autoRefresh / activeTab（key =
//   `pending_programming_filter`）。
// - autoRefresh 布尔持久化：onMounted 时视图读 autoRefresh 后再创建 timer。
//
// 2026-09-29 改造：
// - Tab 化：activeTab = 'pending' | 'programmed'（默认 'pending'），持久化 key
//   `pending_programming_tab`（与 search/autoRefresh 分 key 单独存，方便后续扩展）；
// - fetcher 据 activeTab 拼 has_cnc_program：pending=false / programmed=true /
//   不传=全部（视图只暴露两 tab，不传分支暂未使用）。

import { reactive, ref, watch, type Ref } from 'vue';
import { listPendingProgramming } from '@/api/parts';
import type { PartListItem } from '@/types/parts';
import { useListStatePersist } from '@/composables/useListFilterPersist';
import type { PageQueryParams, PageResult } from '@/composables/usePagedListQuery';

export type PendingProgrammingTab = 'pending' | 'programmed';

export interface UsePendingProgrammingListReturn {
  /** 视图 filter 输入（关键字 / 序列号） */
  search: { keyword: string; serialNo: string };
  /** 自动刷新开关（持久化）；timer 由视图自管 */
  autoRefresh: Ref<boolean>;
  /** 2026-09-29 新增：当前激活的 tab（默认 'pending'）。变化即触发 fetcher 重新发请求 */
  activeTab: Ref<PendingProgrammingTab>;
  /** 传给 <ListShell :fetcher="fetcher">；fetch 失败抛错，由 shell.safeFetcher 接住 */
  fetcher: (params: PageQueryParams) => Promise<PageResult<PartListItem>>;
  /** onMounted 调用一次：从 localStorage 恢复 search / autoRefresh / activeTab */
  restoreFilter: () => void;
}

export function usePendingProgrammingList(): UsePendingProgrammingListReturn {
  const search = reactive({ keyword: '', serialNo: '' });
  const autoRefresh = ref(false);
  // 2026-09-29：默认 'pending'；持久化 key 单独存（key 见 restoreFilter）。
  const activeTab = ref<PendingProgrammingTab>('pending');

  async function fetcher(params: PageQueryParams): Promise<PageResult<PartListItem>> {
    // fetch 抛错 → ListShell.safeFetcher 接住并写到内部 errorMsg，
    // 用户在 el-table 空态能看到原始错误信息（区分「队列空」/「后端挂了」）。
    // 2026-09-29：tab 派生 has_cnc_program（pending=false / programmed=true）。
    const has_cnc_program = activeTab.value === 'pending' ? false : true;
    const resp = await listPendingProgramming({
      keyword: search.keyword.trim() || undefined,
      serial_no: search.serialNo.trim() || undefined,
      has_cnc_program,
      sort_by: 'PLANNED_DELIVERY_DATE',
      sort_dir: 'ASC',
      limit: params.pageSize,
      offset: (params.page - 1) * params.pageSize,
    });
    return { items: resp.items, total: resp.total };
  }

  // 持久化 search / autoRefresh / activeTab（pageSize 由 ListShell 单独持久化）
  const { restore } = useListStatePersist(
    'pending_programming_filter',
    { search, autoRefresh, activeTab },
    { exclude: new Set(['page']) },
  );

  // 2026-09-29：activeTab 切换 → 重置到第 1 页 + 触发重新拉取。
  // ListShell 暴露的 onRefresh 会同时做这两件事，调用方（视图）直接 watch 即可。
  // 这里 watch 拿到 activeTab 变化，仅负责更新内部 fetcher 闭包捕获的 activeTab.value
  // （fetcher 内部读 activeTab.value 是 reactive 自动响应，但显式 watch 便于将来扩展）。
  // 注意：实际数据重拉由 ListShell 的 key 变化机制或视图显式调 listRef.onRefresh() 触发；
  // 本 composable 仅负责 fetcher 入参正确。
  watch(activeTab, () => {
    // no-op：fetcher 内部读 activeTab.value 是 reactive 自动响应；保留 watch
    // 是便于未来挂旁路埋点或缓存失效。
  });

  function restoreFilter(): void {
    const s = restore() as
      | {
          search?: Partial<typeof search>;
          autoRefresh?: boolean;
          activeTab?: PendingProgrammingTab;
        }
      | null;
    if (!s) return;
    if (s.search) Object.assign(search, s.search);
    if (typeof s.autoRefresh === 'boolean') {
      autoRefresh.value = s.autoRefresh;
    }
    if (s.activeTab === 'pending' || s.activeTab === 'programmed') {
      activeTab.value = s.activeTab;
    }
  }

  return {
    search,
    autoRefresh,
    activeTab,
    fetcher,
    restoreFilter,
  };
}
