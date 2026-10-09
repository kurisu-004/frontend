// views/parts/detail/composables/usePartDetailQuery.ts
//
// 零件详情页主查询（`GET /api/v2/parts/{part_id}` 的 `PartDetailOut`，28 字段）。
//
// 与送货单详情 `useDeliveryNoteDetailQuery.ts` 同形（该文件是本 hook 的范本）：
//   - 入参就是一个 partId，本身就是 queryKey 的一段，仍走 reactive params 范式
//     （`queryKey = computed(...)` + queryFn 从 queryKey 读），这样切路由 id 时
//     queryKey 变化自动 refetch，不需要额外的 watch；
//   - **不设 `placeholderData: keepPreviousData`**：详情一次返回单个工单的全部列，
//     保留上一个零件的详情会让用户在切换瞬间看到错的流水号 + 错的数量，比清空更危险；
//   - 字段集以**后端 VO** 为准（`backend-rust/src/modules/part/vo/part.rs` 的
//     `PartDetailOut` = `TPart` 25 列 flatten + customer_name / l1_customer_name /
//     current_batch_id 三注入字段），守门 schema 是 `.strict()` 的 28 字段版本 ——
//     后端加字段 / 前端字段名写错都在 queryFn 当场炸，而不是 Zod strip 把多出来的键
//     静默丢掉、页面照常渲染、只是某一列永远是空的。
//
// 2026-10-10 新增 `isActive` 入参（可选，默认恒真），它同时解决两件事：
//   ① **双 fetch 闸门**：详情页的 shell 在 `onMounted` 与切路由 `id` 的 watcher 里各
//      调一次刷新；有了 reactive params 后 queryKey 变化本身就驱动 refetch，shell 的
//      显式刷新必须走 `fetchDetail` 打在同一条 observer 上，否则是两次独立请求。
//   ② **keep-alive 下切走不再打请求**：本页被 keep-alive 缓存后（路由名 `PartDetail`
//      = 组件文件名，MainLayout 的 `<keep-alive :include>` 按名字匹配），`useRoute()`
//      注入的是 vue-router 的**全局** currentRoute 而不是本组件挂载那一刻的地址快照 ⇒
//      用户切到别的页面时 `route.params.id` 照样变 ⇒ reactive queryKey 跟着变 ⇒ 自动
//      去 `GET /parts/{别的页面的 id}`。后果比 404 更坏：若那个 id 恰好是另一个有效工单，
//      本页会**静默渲染成另一个零件**。这条数据流是 computed → queryKey，没有 watcher
//      可挂守卫，只能在 `enabled` 侧收；入口（`PartDetail.vue`）按 `route.name` 判定
//      本页是否活跃传进来，与 route watcher 里的守卫共用同一个判据函数
//      （`./partDetailActive.ts` 的 `isPartDetailActive`），不写两遍。
//
// staleTime / gcTime 取共享基础数据层的有限值（30s / 5min）：**gcTime 不设
// POSITIVE_INFINITY** —— 那是 dashboard 域靠 WS 事件失效才成立的例外，本页没有失效
// 通道，设无限会让「切走 5 分钟回来」命中陈旧副本，而写后的失效链又只覆盖本页自己的
// 7 个写端点，别的域改了工单只能靠 staleTime 到期。
//
// ⚠️ **`enabled` 只挡「自动」取数，挡不住 `refetch()`**：query-core 的
// `QueryObserver.fetch()` / `Query.fetch()` 都不查 `enabled`（实测 query-core 5.x），
// `query.refetch()` 会无视 enabled 直接发请求。所以两层守卫分工是：
//   - `enabled` 治「queryKey 变了 → 自动 refetch」那条路（keep-alive 切走后唯一的来路）；
//   - queryFn 里的 `if (!id) throw` 治「显式 refetch 撞上空 id」那条路。
// 生产代码里切走后没人会调 `fetchDetail()`（按钮都在不可见的视图上），第二层是纯保险；
// 但少了它，一次误调用就是 `/parts/undefined` 的 404 + 一句看不懂的错误。

import { computed, toValue, watch, type MaybeRefOrGetter } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { ElMessage } from 'element-plus';
import { getPart } from '@/api/parts';
import { qk } from '@/composables/queries/keys';
import { partDetailSchema } from './partDetailSchema';

export function usePartDetailQuery(
  partId: MaybeRefOrGetter<string | null | undefined>,
  /** 本页是否仍是当前路由（keep-alive 缓存页必需，见文件头注释）。省略 = 恒真。 */
  isActive: MaybeRefOrGetter<boolean> = true,
) {
  const queryKey = computed(() => qk.partDetail(toValue(partId) ?? ''));

  const query = useQuery({
    queryKey,
    queryFn: async ({ queryKey }) => {
      // id 从 queryKey 读（reactive params 范式），不闭包捕获 stale 值。
      const id = queryKey[1] as string;
      // 闸门外的二次守卫：enabled=false 时 queryFn 不会跑，但 refetch /
      // invalidateQueries 等路径仍可能进来，缺 id 时直接短路而不是打一个
      // `/parts/undefined` 请求（404 + 一句看不懂的错误）。
      if (!id) throw new Error('缺少零件 id');
      return partDetailSchema.parse(await getPart(id));
    },
    enabled: computed(() => Boolean(toValue(partId)) && Boolean(toValue(isActive))),
    staleTime: 30_000,
    gcTime: 5 * 60 * 1000,
  });

  /** fetchDetail 别名 = refetch 的 async 包装（详情页「刷新」与测试驱动）。 */
  async function fetchDetail(): Promise<void> {
    await query.refetch();
  }

  watch(query.error, (e) => {
    if (e) ElMessage.error(e.message ?? '加载零件失败');
  });

  return {
    query,
    data: query.data,
    isFetching: query.isFetching,
    error: query.error,
    fetchDetail,
  };
}
