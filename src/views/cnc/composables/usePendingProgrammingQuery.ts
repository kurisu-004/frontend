// src/views/cnc/composables/usePendingProgrammingQuery.ts
//
// 「待编程一览」页主查询的 useQuery composable（无自有状态，入参全 reactive）。
// 数据源：`GET /api/v2/prod/programming/pending`（api/programming.ts）。
//
// 数据流：
//   1. 调用方（页面级 store usePendingProgrammingStore）持有私有状态：生效态搜索 /
//      Tab / 分页 / 每页条数 / 自动刷新开关，并把状态经 buildParams() 汇成一个
//      params 对象传进来；
//   2. 本 hook 只负责「params → queryKey → 请求 → 守门 → 数据」这一段，**不持有任何
//      私有状态**：两个开关（enabled / autoRefresh）由调用方持有并以 MaybeRefOrGetter
//      传入；
//   3. queryFn 走 pendingProgrammingListResultSchema.parse(...) 守门（Zod strip 陷阱：
//      漏声明的字段会被静默丢弃，必填字段因此逐个显式声明，见 pendingProgrammingSchema）。
//
// 设计要点：
//   - reactive params 范式：queryKey = computed(() => qk.programmingList(toValue(params)))，
//     queryFn **从 queryKey[2] 读 params**（键是唯一真相源），不闭包捕获 stale 值 ——
//     否则生效态搜索 / Tab / 分页变化后 queryFn 仍发旧参数。
//   - enabled 闸门由调用方控制：store 实例化时传 false（restoreState() 末尾开闸），
//     避免「默认参数首屏 + 持久化参数再屏」双 fetch。
//   - placeholderData: keepPreviousData —— 切 Tab / 提交搜索换的是 queryKey，不设它新键
//     在响应到达前 data 为 undefined，整表清空；代价是新参数数据到达前表上仍是旧内容。
//   - 自动刷新：refetchInterval 用 **computed** 而非裸函数 `() => autoRefresh ? … : false`
//     （勿改回函数形态）：vue-query 的 defaultedOptions 是对 options 的 computed，经
//     `cloneDeepUnref` 逐层 unref —— 只在 queryKey 那一层会把 function 求值
//     （`unrefGetters` 仅 queryKey 为 true），其余层 function 原样保留。裸函数体内的
//     `autoRefresh` 因此**不进入** defaultedOptions 的依赖收集，勾选「自动刷新」不触发
//     `watch(defaultedOptions) → observer.setOptions(...)` ⇒ query-core 的
//     `#updateRefetchInterval` 不会被重新求值（setOptions 里只有
//     `nextRefetchInterval !== #currentRefetchInterval` 时才重建定时器）⇒ 轮询永远
//     不启动，必须再改一次筛选 / 手动刷新才「歪打正着」。computed 让开关进入依赖，
//     勾选与取消勾选都会重建定时器。
//   - refetchIntervalInBackground 必须显式 true —— TanStack Query 默认 false，窗口
//     失焦时暂停轮询（轮询类刷新要的就是「后台也照跑」）。
//   - 缓存时长：页面级列表，不设 staleTime / gcTime，走 main.ts 全局默认（共享基础
//     数据层的 30s / 5min 有限缓存约束不适用于页面级列表）。
//   - 不写 retry：信任 main.ts 全局 queries.retry: 0。
//   - 注：轮询本身无法在 vitest node 环境断言 —— query-core 的 `#shouldScheduleTimer`
//     有 `!isServer()` 闸门（node 下 window 未定义 ⇒ 永不排定时器），单测只覆盖到
//     「开关进 queryFn 参数 + 定时器不排」这一层。

import { computed, toValue, watch, type MaybeRefOrGetter } from 'vue';
import { keepPreviousData, useQuery } from '@tanstack/vue-query';
import { ElMessage } from 'element-plus';
import { fetchPendingProgramming, type ListPendingProgrammingParams } from '@/api/programming';
import { qk } from '@/composables/queries/keys';
import { pendingProgrammingListResultSchema } from './pendingProgrammingSchema';

/** 入参：全部 reactive（Ref / ComputedRef / getter 都可）。 */
export interface PendingProgrammingQueryOptions {
  /** 请求参数（生效态搜索 / Tab / 排序 / 分页汇成的那一份），直接进 queryKey。 */
  params: MaybeRefOrGetter<ListPendingProgrammingParams>;
  /** 闸门：false 时不发请求（store 在 restoreState() 末尾开闸，避免双 fetch）。 */
  enabled: MaybeRefOrGetter<boolean>;
  /** 自动刷新开关（true ⇒ 每 5min refetch 一次当前 queryKey）。 */
  autoRefresh: MaybeRefOrGetter<boolean>;
}

export function usePendingProgrammingQuery(options: PendingProgrammingQueryOptions) {
  const queryKey = computed(() => qk.programmingList(toValue(options.params)));

  const query = useQuery({
    queryKey,
    queryFn: async ({ queryKey }) => {
      // params 从 queryKey 读（reactive params 范式），不闭包捕获 stale 值。
      const params = queryKey[2] as ListPendingProgrammingParams;
      return pendingProgrammingListResultSchema.parse(await fetchPendingProgramming(params));
    },
    enabled: computed(() => toValue(options.enabled)),
    placeholderData: keepPreviousData,
    refetchInterval: computed(() => (toValue(options.autoRefresh) ? 300_000 : false)),
    refetchIntervalInBackground: true,
  });

  /** fetchList 别名 = refetch 的 async 包装（视图「刷新」按钮 / 测试零改动驱动）。 */
  async function fetchList(): Promise<void> {
    await query.refetch();
  }

  // 错误桥接：useQuery 的 error 不在 setup 抛错（CLAUDE.md 硬约束）。
  watch(query.error, (e) => {
    if (e) ElMessage.error(e.message ?? '待编程列表加载失败');
  });

  return {
    query,
    data: query.data,
    isFetching: query.isFetching,
    error: query.error,
    fetchList,
  };
}
