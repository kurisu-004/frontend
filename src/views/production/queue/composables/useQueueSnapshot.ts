// 生产队列快照 useQuery composable（队列页两个 tab 标题徽标 + 右栏工序卡徽标的
// **唯一**数据源，`GET /api/v2/prod/queue/snapshot`）。
//
// 设计要点：
//   - **常量键**：后端端点不接 Query extractor（无分页 / 无筛选 / 无货架维度，按
//     process_id GROUP BY 跨所有货架聚合）⇒ 键里没有任何可变量。包一层 computed
//     只为与 useQueueBoard 的键形态一致（TanStack 的 queryKey 允许 computed）。
//   - queryFn 走 `queueSnapshotSchema.parse(...)` 守门：出参字段驱动两处徽标，
//     漏声明字段会被 zod strip 静默丢掉且 parse 不报错（「守门」形同虚设）。
//   - error 桥接：useQuery 的 error 不在 setup 抛错，走 watch + ElMessage.error。
//   - 不写 retry：信任 main.ts 全局 queries.retry: 0。
//
// ⚠️ **本轮零 WS 订阅**（刻意）：后端已有 30+ 个 `ws_hub.broadcast` 生产方，其中
// `WORKER_POOL_MOVE_DONE` / `BATCH_PLACED_ON_SHELF` / `PART_RECALLED` 都直接改
// 队列页关心的计数与候选池成员资格，接上订阅能让「别人操作 → 本页徽标」实时更新。
// 本轮不接的原因与代价：队列页的三条写操作（move / dispatch / recall）**都在本页**，
// 自己写完走 `invalidateQueueSnapshot(qc)` 立即可见；缺的是「**别的页面**改了队列
// 数据」的实时性，这类改动由 30s staleTime 兜底（操作间隔通常 > 30s，切回即
// refetch）。后续接 WS 时应新增 `useProductionQueueInvalidation.ts`，复用 dashboard
// 域 `useDashboardInvalidation` 的 `onDashboardEvent` 事件订阅 + debounce 合并，
// 不要在每个 composable 里各挂一份 handler。
//
// **gcTime 保持有限值（5 分钟），不得改成 POSITIVE_INFINITY**：后者是 dashboard 域
// 的例外，成立的前提是该域有 WS 事件 invalidate、不靠 GC。本域没有失效通道，GC 设成
// 无限会让「切走 5 分钟后回来」仍命中一份无限陈旧的快照。
//
// staleTime 30_000（30s 短时去重窗口）+ gcTime 5 * 60 * 1000 是 CLAUDE.md
// 「TanStack Query 降级为 30s 短时请求去重层」的取值：切 tab / 刷新按钮在窗口内不
// 重拉，超窗口自动 refetch。

import { computed, watch } from 'vue';
import { useQuery, type QueryClient } from '@tanstack/vue-query';
import { ElMessage } from 'element-plus';
import { fetchQueueSnapshot } from '@/api/productionQueue';
import { qk } from '@/composables/queries/keys';
import { queueSnapshotSchema } from './productionQueueSchema';
import { queueListErrorText } from './queueListErrorMessage';

/** 队列快照 query（`GET /api/v2/prod/queue/snapshot`）。
 *
 *  用法：
 *  ```ts
 *  const snapshot = useQueueSnapshot();
 *  const countOf = (pid: string) =>
 *    snapshot.data.value?.processes.find((p) => p.process_id === pid)?.pool_count ?? 0;
 *  const pendingTotal = computed(() => snapshot.data.value?.pending_count ?? 0);
 *  ```
 *
 *  无参数。常量键，30s staleTime / 5min gcTime。
 */
export function useQueueSnapshot() {
  const query = useQuery({
    queryKey: computed(() => qk.productionQueueSnapshot()),
    queryFn: async () => queueSnapshotSchema.parse(await fetchQueueSnapshot()),
    staleTime: 30_000,
    gcTime: 5 * 60 * 1000,
  });

  // 错误桥接：useQuery 的 error 不在 setup 抛错（抛错会让整个页面 setup 失败）。
  // ZodError 经本域收口成一句人话（细节只进 console），其余异常沿用原始 message。
  watch(query.error, (e) => {
    if (e) ElMessage.error(queueListErrorText(e, '队列快照加载失败'));
  });

  return query;
}

/** 失效整个快照域（写操作完成后调）。
 *  返回 Promise<void> 让调用方可以 await 失效完成再弹 toast。
 *  调用点：useQueueMove（move / auto-allocate）、useQueueDispatch（dispatch）、
 *  useQueueRecall（recall）、QueueBoard.onRefresh（手动刷新）。 */
export function invalidateQueueSnapshot(qc: QueryClient): Promise<void> {
  return qc
    .invalidateQueries({ queryKey: qk.productionQueueSnapshotPrefix })
    .then(() => undefined);
}