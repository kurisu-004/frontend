// src/views/users/composables/useUsersQuery.ts
//
// 2026-10-10 新增：「账号管理」页主查询的 useQuery 段从页面级 store 外提成同域独立
// hook（无自有状态），守门 schema 与它同居域根（`views/users/usersSchema.ts`）。
// 形态照 `views/inspection/composables/useInspectionQueueQuery.ts`。
// 数据源：`GET /api/v2/iam/users`（api/iam.ts::listUsers）。
//
// 数据流：
//   1. 调用方（页面级 store useUsersListStore）持有私有状态：表头筛选 / 分页 / 每页
//      条数 / 自动刷新开关，把它们经 buildParams() 汇成一份 params 传进来；
//   2. 本 hook 只负责「params → queryKey → 请求 → 守门 → 数据」，**不持有任何私有状态**：
//      两个开关（enabled / autoRefresh）由调用方以 MaybeRefOrGetter 传入；
//   3. queryFn 走 `userListResultSchema.parse(...)` 守门。分页信封的三个计数在 wire 上是
//      **number**（后端 `UserListOut` 是裸 `i64`，归一在 `api/iam.ts::listUsers` 的
//      `normalizeListResult`），schema 与 store 都不再二次归一。
//
// 设计要点：
//   - reactive params 范式：queryKey = computed(() => qk.usersList(toValue(params)))，
//     queryFn **从 queryKey[2] 读 params**（键是唯一真相源），不闭包捕获 stale 值；
//   - enabled 闸门由调用方控制：store 实例化时传 false（restoreState() 末尾开闸），
//     避免「默认参数首屏 + 持久化参数再屏」双 fetch；
//   - placeholderData: keepPreviousData —— 改筛选 / 翻页换的是 queryKey，不设它新键在
//     响应到达前 data 为 undefined，整表清空；
//   - 自动刷新：`refetchInterval` 用 **computed** 而非裸函数（勿改回函数形态：vue-query
//     的 defaultedOptions 只在 queryKey 那一层把 function 求值，裸函数体内的
//     `autoRefresh` 不进依赖收集 ⇒ 勾选开关不触发 `observer.setOptions` ⇒ 轮询永远
//     不启动）；
//   - refetchIntervalInBackground 必须显式 true（默认 false，窗口失焦会暂停轮询）；
//   - 缓存时长：页面级列表，不设 staleTime / gcTime，走 main.ts 全局默认；
//   - 不写 retry：信任 main.ts 全局 queries.retry: 0。

import { computed, toValue, watch, type MaybeRefOrGetter } from 'vue';
import { keepPreviousData, useQuery } from '@tanstack/vue-query';
import { ElMessage } from 'element-plus';
import { listUsers, type ListUsersParams } from '@/api/iam';
import { qk } from '@/composables/queries/keys';
import { userListResultSchema } from '../usersSchema';

/** 入参：全部 reactive（Ref / ComputedRef / getter 都可）。 */
export interface UsersQueryOptions {
  /** 请求参数（筛选 + 分页汇成的那一份），直接进 queryKey。 */
  params: MaybeRefOrGetter<ListUsersParams>;
  /** 闸门：false 时不发请求（store 在 restoreState() 末尾开闸，避免双 fetch）。 */
  enabled: MaybeRefOrGetter<boolean>;
  /** 自动刷新开关（true ⇒ 每 5min refetch 一次当前 queryKey）。 */
  autoRefresh: MaybeRefOrGetter<boolean>;
}

export function useUsersQuery(options: UsersQueryOptions) {
  const queryKey = computed(() => qk.usersList(toValue(options.params)));

  const query = useQuery({
    queryKey,
    queryFn: async ({ queryKey }) => {
      // params 从 queryKey 读（reactive params 范式），不闭包捕获 stale 值。
      const params = queryKey[2] as ListUsersParams;
      return userListResultSchema.parse(await listUsers(params));
    },
    enabled: computed(() => toValue(options.enabled)),
    placeholderData: keepPreviousData,
    refetchInterval: computed(() => (toValue(options.autoRefresh) ? 300_000 : false)),
    refetchIntervalInBackground: true,
  });

  /** fetchList 别名 = refetch 的 async 包装（视图「刷新」按钮 / 写后刷新 / 测试驱动）。 */
  async function fetchList(): Promise<void> {
    await query.refetch();
  }

  // 错误桥接：useQuery 的 error 不在 setup 抛错（CLAUDE.md 硬约束）。
  watch(query.error, (e) => {
    if (e) ElMessage.error(e.message ?? '账号列表加载失败');
  });

  return {
    query,
    data: query.data,
    isFetching: query.isFetching,
    error: query.error,
    fetchList,
  };
}
