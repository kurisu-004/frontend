// 外协看板快照 useQuery composable（看板各工序 tab 标题双徽标「可发 / 在途」的**唯一**
// 数据源，`GET /api/v2/outsource-queue/snapshot`）。
//
// 设计要点：
//   - **常量键**：后端端点不接 Query extractor（无分页 / 无筛选 / 无货架维度）⇒ 键里没有
//     任何可变量。包一层 computed 只为与 `useOutsourceQueueProcessQuery` 的键形态一致
//     （TanStack 的 queryKey 允许 computed）。
//   - queryFn 走 `outsourceQueueSnapshotSchema.parse(...)` 守门：出参字段驱动 tab 徽标，
//     漏声明字段会被 zod strip 静默丢掉且 parse 不报错（「守门」形同虚设）。
//   - error 桥接：useQuery 的 error 不在 setup 抛错，走 watch + ElMessage.error。
//   - 不写 retry：信任 main.ts 全局 queries.retry: 0。
//
// ⚠️ **gcTime 保持有限值（5 分钟），不得改成 POSITIVE_INFINITY**：后者是 dashboard 域
// 的例外，成立的前提是该域有 WS 事件 invalidate、不靠 GC。本域**零 WS 订阅**
// （dashboard WS 只推 dashboard 大屏域的事件），GC 设成无限会让「切走 5 分钟后回来」
// 仍命中一份无限陈旧的徽标。
//
// staleTime 30_000（30s 短时去重窗口）+ gcTime 5 * 60 * 1000 是 CLAUDE.md
// 「TanStack Query 降级为 30s 短时请求去重层」的取值：切 tab / 刷新按钮在窗口内不
// 重拉，超窗口自动 refetch。
//
// ⚠️ `processes[]` **只含 `sendable + in_flight > 0` 的工序**：本 query 是徽标数据源、
// **不是工序全集**。消费方渲染 tab 集合时必须与全量 OUTSOURCE 工序列表 join —— 直接拿
// 本数组当 tab 列表会让「收发清零的工序」凭空消失，操作到一半 tab 跳走。

import { computed, watch } from 'vue';
import { useQuery, type QueryClient } from '@tanstack/vue-query';
import { ElMessage } from 'element-plus';
import { fetchOutsourceQueueSnapshot } from '@/api/outsource';
import { qk } from '@/composables/queries/keys';
import { outsourceQueueSnapshotSchema } from './outsourceQueueSchema';

/** 外协看板快照 query（`GET /api/v2/outsource-queue/snapshot`）。
 *
 *  用法：
 *  ```ts
 *  const snapshot = useOutsourceQueueSnapshotQuery();
 *  const badgeOf = (pid: string) =>
 *    snapshot.data.value?.processes.find((p) => p.process_id === pid);
 *  const sendableTotal = computed(() => snapshot.data.value?.sendable_total ?? 0);
 *  ```
 *
 *  无参数。常量键，30s staleTime / 5min gcTime。 */
export function useOutsourceQueueSnapshotQuery() {
  const query = useQuery({
    queryKey: computed(() => qk.outsourceQueueSnapshot()),
    queryFn: async () => outsourceQueueSnapshotSchema.parse(await fetchOutsourceQueueSnapshot()),
    staleTime: 30_000,
    gcTime: 5 * 60 * 1000,
  });

  // 错误桥接：useQuery 的 error 不在 setup 抛错（抛错会让整个页面 setup 失败）。
  watch(query.error, (e) => {
    if (e) ElMessage.error(e.message ?? '外协看板徽标加载失败');
  });

  return query;
}

/** 失效整个快照域（写操作完成后调）。
 *
 *  返回 Promise<void> 让调用方可以 await 失效完成再弹 toast。
 *  调用点：`useOutsourceQueueMove`（发送 / 回收后）、看板的手动刷新。 */
export function invalidateOutsourceQueueSnapshotAll(qc: QueryClient): Promise<void> {
  return qc
    .invalidateQueries({ queryKey: qk.outsourceQueueSnapshotPrefix })
    .then(() => undefined);
}