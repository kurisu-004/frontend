// src/views/cnc/composables/usePendingProgrammingStore.ts
//
// 2026-10-01 新增：「待编程一览」页 Pinia setup store —— 替代原
// usePendingProgrammingList.ts（ListShell + fetcher 手写状态机，2026-10-01 删除）。
//
// 范本：src/views/parts/list/composables/usePartsListStore.ts（页面级 store）
//   + usePartsListQuery.ts（useQuery 部分）。
//
// 数据源迁移：本页 2026-10-01 起读 prod 域 `GET /api/v2/prod/programming/pending`
// （旧 part 域 /parts/pending-programming 恒返空，前端 wrapper 已删）。行类型从
// PartListItem 换成 ProgrammingItem（pendingProgrammingItemSchema 的 z.infer）。
//
// 不变量（改动前必读）：
//   1. 必须在组件 setup 内首次调用 usePendingProgrammingStore()；
//   2. 视图 onBeforeUnmount 必须 store.$dispose()（Pinia 单例，泄漏分页 / Tab 勾选
//    到下次进入 —— 注意 $dispose 只 reset 本 store 自建的 ref，故对外状态必须走
//    query 这个 plain object slice，见 return 处的说明）；
//   3. 消费侧禁止解构 store —— 一律 store.query.xxx（深代理自动解包嵌套 ref）；
//   4. 不 import vue-router：路由跳转能力由视图通过 registerRouter 注入
//    （沿 src/stores/auth.ts::refreshOrLogout(router) 与
//    usePartsListStore::registerTableGetter 的先例）—— store 需在 node 单测里
//    无 router 实例化。
//
// 沿 CLAUDE.md 硬约束：
//   - 两层数据获取架构：本文件是**页面级 store**（私有状态 + 列定义 + 列可见性），
//     主查询的 useQuery 段外提成同域 hook（usePendingProgrammingQuery）；
//   - 本文件**不含 queryKey / queryFn**：queryKey 走工厂、queryFn 从 queryKey 读
//     最新 params（不闭包捕获 stale）、Zod 守门 parse、error → ElMessage 桥接，
//     四件事都在 usePendingProgrammingQuery 内；
//   - 2026-10-10：「下发到 CNC 货架」整块删除（下发改由扫码台的工人放回 / 送检接管）
//     ⇒ 本 store 现在**没有任何写操作**，也不再需要 qc（QueryClient）、写后失效的
//     域前缀、以及工序 / 货架两个基础数据 query。
//   - enabled 闸门（restored）避免「默认参数首屏 + 持久化参数再屏」双 fetch；
//   - 不写 retry：信任 main.ts 全局 queries.retry: 0 / mutations.retry: 0；
//   - 缓存时长：本页是页面级列表，走 main.ts 全局默认（不在共享层有限缓存
//     staleTime/gcTime 约束范围内）。

import { computed, reactive, ref } from 'vue';
import { defineStore } from 'pinia';

import type { ListPendingProgrammingParams } from '@/api/programming';
import { useColumnVisibility } from '@/composables/useColumnVisibility';
import { useColumnDrag } from '@/composables/useColumnDrag';
import { useListStatePersist } from '@/composables/useListFilterPersist';
import {
  buildPendingProgrammingColumnDefs,
  type PendingProgrammingRow,
} from '../pendingProgrammingColumnDefs';
import { usePendingProgrammingQuery } from './usePendingProgrammingQuery';
import type { PendingProgrammingItemData } from './pendingProgrammingSchema';

export type PendingProgrammingTab = 'pending' | 'programmed';

/** 下发失败兜底所需的最小 router 形态（只用 push 跳「工序制定」页）。
 *  结构化注入而非 `import type { Router }`：沿 src/stores/auth.ts::refreshOrLogout
 *  的先例 —— store 不 import vue-router（不变量 #4，node 单测无 router 实例），
 *  视图传真实 Router 实例即可（结构化子类型，天然可赋值）。 */
export interface PendingProgrammingRouter {
  push: (path: string) => Promise<unknown> | unknown;
}

/** 列可见性 / 列顺序的 localStorage key —— 沿用 2026-09-29 的老值。
 *  ⚠️ 不要改：改 key 会让老用户已配好的列可见性 / 列顺序快照全丢。 */
export const PENDING_PROGRAMMING_LIST_KEY = 'pending_programming';

export const usePendingProgrammingStore = defineStore('pending-programming', () => {
  // ============ 私有状态 ============
  /** 搜索**生效态**（进 queryKey ⇒ 进请求）。持久化到 `pending_programming_filter`。
   *  ⚠️ 只由 onSearch() / restoreState() 写，**不要**直接绑到视图输入框。 */
  const search = reactive({ keyword: '', serialNo: '' });
  /** 搜索**输入态**（只被视图 v-model 写，**不进 queryKey**）。
   *  拆开的原因：生效态直接绑 v-model 时，每敲一个字符就换一个 queryKey ⇒ 每个
   *  字符一次 GET；且 onSearch 只绑 @keyup.enter / @clear，打字途中页码不重置 ⇒
   *  在第 3 页打字会拉到「第 3 页的筛选结果」（大概率空表）。拆成输入态 / 生效态
   *  后：打字 0 请求，Enter / 清空才 onSearch 提交一次。 */
  const searchInput = reactive({ keyword: '', serialNo: '' });
  const activeTab = ref<PendingProgrammingTab>('pending');
  /** 自动刷新开关（5min 轮询，持久化）。原视图用裸 setInterval 维护，2026-10-01
   *  改由 useQuery 的 refetchInterval 承担（见下），这里只保留开关状态。 */
  const autoRefresh = ref(false);
  const page = ref(1);
  const pageSize = ref(20);
  // 2026-10-01：enabled 闸门。store 实例化时 useQuery 不发请求，
  // restoreState() 末尾置 true 才开闸（避免默认参数 + 持久化参数双 fetch）。
  const restored = ref(false);

  // ============ buildParams ============
  function buildParams(): ListPendingProgrammingParams {
    return {
      // Tab 三态映射：pending = 仅未编程 / programmed = 仅已编程
      // （省略 = 全部，本页两个 Tab 不暴露「全部」分支）。
      // ⚠️ 恒为真 boolean：后端 deserialize_bool_opt 把空串当「不过滤」而不是 400
      // （详见 api/programming.ts::ListPendingProgrammingParams 的注释）——
      // 前端仍不发空串，不依赖后端那条兜底。
      has_cnc_program: activeTab.value === 'pending' ? false : true,
      // ⚠️ 读的是**生效态** search（不是 searchInput）：自动刷新 tick / 刷新按钮
      // 触发的 refetch 走的是当前 queryKey，输入框里没提交的半截字不该进请求。
      // 空串 / 纯空格 → undefined（cleanParams 只兜 undefined，空串会原样发出）
      keyword: search.keyword.trim() || undefined,
      serial_no: search.serialNo.trim() || undefined,
      sort_by: 'PLANNED_DELIVERY_DATE',
      sort_dir: 'ASC',
      limit: pageSize.value,
      offset: (page.value - 1) * pageSize.value,
    };
  }

  // ============ 主查询 ============
  // useQuery 段外提成同域 hook（usePendingProgrammingQuery）：私有状态留在这里，
  // queryKey / queryFn / Zod 守门 / 轮询 / 错误桥接归 hook。本 store 只把 restored 与
  // autoRefresh 两个开关递给它。
  const listQuery = usePendingProgrammingQuery({
    params: computed(() => buildParams()),
    enabled: restored,
    autoRefresh,
  });
  const { fetchList } = listQuery;

  // ============ 派生 ============
  const items = computed<PendingProgrammingRow[]>(() => listQuery.data.value?.items ?? []);
  const total = computed<number>(() => listQuery.data.value?.total ?? 0);
  const loading = listQuery.isFetching;
  const errorMsg = computed<string | null>(() => {
    const e = listQuery.error.value;
    return e ? e.message : null;
  });
  const emptyText = computed<string>(() => errorMsg.value ?? '当前无待编程零件');

  // ============ 事件处理 ============
  // ⚠️ 只做 page=1；queryKey 变化自动 refetch。**不要**再加 watch(activeTab) ——
  // 2026-09-29 review 已修过「@tab-change + watch 串行触发两次刷新」的 bug
  // （点一下 Tab 拉两次接口），本页只保留 @tab-change 一条路径。
  function onTabChange(): void {
    page.value = 1;
  }

  /** 提交搜索：输入态 → 生效态 + 页码归 1（queryKey 变化自动 refetch）。
   *  ⚠️ 视图只在 `@keyup.enter` / `@clear` 调它，**不要**绑到输入框的
   *  `update:modelValue`（那只是打字，会每字一请求，见上方 searchInput 注）。
   *  - el-input `clearable` 的 ✕ 会先发 `update:modelValue('')` 再发 `@clear`：
   *    前者只改输入态（0 请求），后者走本函数提交一次 ⇒ **净 1 次请求**，不双发。
   *  - Object.assign 与 page=1 是同一同步块内完成，`watch(defaultedOptions)` 是
   *    pre-flush ⇒ computed 只在块末求值一次 ⇒ 单次 setOptions ⇒ 单次 fetch。
   *
   * 提交边界（把语义钉死，避免后人当 bug 改）：**只有**
   * Enter 与清空会提交输入态。切 Tab（onTabChange 只做 page=1）、翻页 / 改每页条数、
   * 点「刷新」（fetchList = refetch 当前 queryKey）、自动刷新 tick（query-core
   * #executeFetch 复用当前 queryKey，压根不重跑 buildParams）**都不提交**草稿 ——
   * 它们只重拉「已生效」的条件。这是有意的：草稿未提交前不该被其它动作顺带生效。
   * 副作用（已知取舍）：草稿不持久化，打字未按 Enter 就离开页面会丢失；恢复出来的
   * 是上次真正生效过的条件，与列表内容自洽。 */
  function onSearch(): void {
    Object.assign(search, searchInput);
    page.value = 1;
  }

  // ============ 持久化 ============
  // ⚠️ key 沿用 `pending_programming_filter`（与 2026-09-29 版一致，不要改：
  // 改 key 老用户的搜索条件 / 自动刷新 / Tab 记忆全丢）。
  // 用泛型 useListStatePersist 而非 useListFilterPersist：后者的 deps 形状固定为
  // { search, sortBy, sortDir, pageSize }（零件一览遗留），本页持久化的是
  // { search, autoRefresh, activeTab } 三字段（无排序交互 / 排序固定）。
  //
  // deps 只放**生效态** search，**不放** searchInput：
  //   1) useListStatePersist.restore() 会校验「每个 dep key 都必须存在于快照里」，
  //      少一个就整份返回 null。往 deps 里加 searchInput 会让 2026-10-01 之前
  //      落盘的快照（只有 search / autoRefresh / activeTab）整体失效 ⇒ 老用户
  //      搜索条件 + 自动刷新 + Tab 记忆全丢。
  //   2) 语义上也只该存生效态：存草稿会让下次进页面时输入框显示一个从未生效过的条件。
  // 副作用（有意为之）：用户打了字没按 Enter 就离开，草稿不保留 —— 恢复出来的是
  // 上次真正生效过的条件，与列表内容一致。
  //
  // 本页**不持久化分页 / 每页条数**（沿 ListShell.vue 记录的 2026-08-31 决策：放弃
  // pageSize 跨会话恢复，进入页面一律默认 20），但**要**持久化 autoRefresh 与 activeTab。
  const { restore: restorePersisted } = useListStatePersist('pending_programming_filter', {
    search,
    autoRefresh,
    activeTab,
  });

  function restoreState(): void {
    const s = restorePersisted() as {
      search?: Partial<{ keyword: string; serialNo: string }>;
      autoRefresh?: boolean;
      activeTab?: PendingProgrammingTab;
    } | null;
    if (s) {
      if (s.search) Object.assign(search, s.search);
      if (typeof s.autoRefresh === 'boolean') autoRefresh.value = s.autoRefresh;
      if (s.activeTab === 'pending' || s.activeTab === 'programmed') {
        activeTab.value = s.activeTab;
      }
    }
    // 把生效态**同步回输入态**，否则输入框空白而列表已按恢复出的条件过滤 —— 用户看到的框与表不一致，按回车还会把条件清空。
    Object.assign(searchInput, search);
    // 开闸 → useQuery 触发首屏 fetch（视图不再显式调 fetchList）
    restored.value = true;
  }

  // ============ 列可见性 + 列顺序拖动 ============
  // 2026-10-01：列定义搬到独立文件（src/views/cnc/pendingProgrammingColumnDefs.ts），
  // deps 注入本 store 的跳转函数。2026-10-10：「下发」相关的两个 deps 随功能下线删除。
  const columnDefs = buildPendingProgrammingColumnDefs({
    navigateToPart: (id) => navigateToPart(id),
  });
  const columnVisibility = useColumnVisibility(columnDefs, {
    listKey: PENDING_PROGRAMMING_LIST_KEY,
  });
  const drag = useColumnDrag(columnDefs, { listKey: PENDING_PROGRAMMING_LIST_KEY });

  // ============ 路由注入（不变量 #4：store 不 import vue-router）============
  // 用 holder 对象装 getter（而不是裸 let 变量）：TS 对闭包捕获的 let 变量做控制流
  // 收窄会把调用点判成「恒为 null」。holder 的属性访问不参与收窄。
  const routerHolder: { get: (() => { push: (path: string) => unknown } | null) | null } = {
    get: null,
  };
  function registerRouter(fn: () => { push: (path: string) => unknown } | null): void {
    routerHolder.get = fn;
  }
  function navigateToPart(id: string): void {
    void routerHolder.get?.()?.push(`/parts/${id}`);
  }

  // ============ 对外切片 ============
  // ⚠️ 为什么切 query 这一个 slice，而不是把全部 ref 平铺在 store 顶层：
  // Pinia setup store 的 `$dispose()` 只做 `scope.stop()` + 清订阅 + 从 `pinia._s`
  // 摘除，**不删** `pinia.state.value[$id]`；下次 `useStore()` 时 Pinia 会把
  // 上次残留的 state **hydrate 回新建的 ref**（pinia.mjs createSetupStore 的
  // `if (initialState && shouldHydrate(prop)) prop.value = initialState[key]`）。
  //   - 平铺的顶层 ref（如 releaseDialogVisible / page）会被序列化进 state ⇒
  //     $dispose 后「对话框还开着 / 停在第 3 页」泄漏到下次进入，直接违反
  //     不变量 #2；
  //   - 切成 plain object slice 后，slice 既不是 ref 也不是 reactive，Pinia
  //     不会把它写进 state ⇒ $dispose 后真 fresh。
  //     ⚠️ 前提是 slice 确实是 **plain object**：写成 reactive() 会通过 Pinia 的 state
  //     登记闸门（isRef || isReactive）进 state，重建时由 mergeReactiveObjects 递归
  //     回填、内层 ref 一样复活 ⇒ 本护栏失效。
  // 这也是 usePartsListStore 切成 query / filters / batch / dispatch 切片的
  // 同源原因（那里靠 batchMode 泄漏的回归用例守住）。
  return {
    // 主查询切片：筛选 / Tab / 分页 + items / total / loading / 错误
    query: {
      /** 生效态（进 queryKey ⇒ 进请求）。视图不直接绑 v-model，只经 onSearch 写。 */
      search,
      /** 输入态（视图 el-input 的 v-model 绑这里）；打字 0 请求，提交走 onSearch */
      searchInput,
      activeTab,
      autoRefresh,
      page,
      pageSize,
      items,
      total,
      loading,
      errorMsg,
      emptyText,
      /** fetchList 别名（视图「刷新」按钮 / 测试驱动） */
      fetchList,
      onTabChange,
      /** 提交搜索：searchInput → search + page=1（Enter / @clear 触发） */
      onSearch,
      restoreState,
    },
    // 列切片（列定义在 pendingProgrammingColumnDefs.ts，deps 注入 navigateToPart）
    columnDefs,
    columnVisibility,
    drag,
    /** 视图注入真实 router（不变量 #4：store 不 import vue-router） */
    registerRouter,
  };
});

/** 行类型再导出（视图 cellRender / 测试用；与 domain schema 的 z.infer 同源）。 */
export type { PendingProgrammingItemData, PendingProgrammingRow };
