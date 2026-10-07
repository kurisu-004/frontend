// 单工序外协看板 useQuery composable（`GET /api/v2/outsource-queue/processes/{process_id}`）。
//
// 本 composable 是单工序看板数据的**唯一**数据源，消费方是工序 tab 的 body。一次请求拿全：
// 工序元数据 + 右列公司（**内联 held_batches**）+ 左列候选批次。公司列组件零请求 ——
// 原先「每列一个公司请求」的 N+1 在这里是结构性地不存在，不是靠调优消掉的。
//
// 设计要点：
//   - reactive params 范式：`processId: MaybeRefOrGetter<string | null | undefined>`，
//     `queryKey = computed(() => qk.outsourceQueueProcess(toValue(processId) ?? ''))`；
//   - queryFn **从 queryKey 读** processId（键是唯一真相源），不闭包捕获 stale 值；
//   - `enabled: computed(() => !!toValue(processId))` 闸门 + queryFn 内二次守卫
//     （防显式 refetch 绕过闸门时发出 `/processes/` 空路径请求）；
//   - queryFn 走 `outsourceQueueProcessDetailSchema.parse(...)` 守门；
//   - staleTime 30_000 / gcTime 5 * 60 * 1000（同域快照：30s 短时去重 + 5min 缓存）。
//     **不用 POSITIVE_INFINITY**（dashboard 域的例外，前提是该域有 WS 事件失效；本域
//     零 WS 订阅，理由见 useOutsourceQueueSnapshotQuery.ts 文件头）；
//   - 不写 retry：信任 main.ts 全局 queries.retry: 0。
//
// 懒加载：`el-tab-pane :lazy="true"` ⇒ tab body 首次激活才 mount，本 query 才发请求。

import { computed, toValue, watch, type MaybeRefOrGetter } from 'vue';
import { useQuery, type QueryClient } from '@tanstack/vue-query';
import { ElMessage } from 'element-plus';
import { fetchOutsourceQueueProcess } from '@/api/outsource';
import { qk } from '@/composables/queries/keys';
import { outsourceQueueProcessDetailSchema } from './outsourceQueueSchema';

/** 单工序外协看板 query（`GET /api/v2/outsource-queue/processes/{process_id}`）。
 *
 *  参数：
 *   - processId：MaybeRefOrGetter<string | null | undefined>。null / undefined /
 *     空字符串 → `enabled=false`，零网络请求。
 *
 *  返回：标准 TanStack Vue Query `UseQueryReturnType`（出参是单工序详情，不分页）。 */
export function useOutsourceQueueProcessQuery(
  processId: MaybeRefOrGetter<string | null | undefined>,
) {
  const processKey = computed(() => qk.outsourceQueueProcess(toValue(processId) ?? ''));
  const query = useQuery({
    queryKey: processKey,
    queryFn: async ({ queryKey }) => {
      const pid = queryKey[2];
      // enabled=false 已挡；留二次守卫防 queryFn 被显式 refetch 时仍打空路径请求。
      if (!pid) throw new Error('processId required');
      return outsourceQueueProcessDetailSchema.parse(await fetchOutsourceQueueProcess(String(pid)));
    },
    enabled: computed(() => !!toValue(processId)),
    staleTime: 30_000,
    gcTime: 5 * 60 * 1000,
  });

  // 错误桥接：useQuery 的 error 不在 setup 抛错。
  watch(query.error, (e) => {
    if (e) ElMessage.error(e.message ?? '外协看板加载失败');
  });

  return query;
}

/** 失效整个单工序看板域（**前缀全失效**，任意 processId 形态都命中）。
 *
 *  前缀而非精确键：发送的目标公司列、回收的来源工序都可能不在当前 tab —— 一次移动会
 *  同时改左列候选池与右列在途集合，精确失效必然漏刷（漏刷的表现是「徽标更新了、卡片
 *  没动」）。
 *
 *  返回 Promise<void> 让调用方 await 完整失效链。调用点：`useOutsourceQueueMove` 的
 *  mutation 回调 + 看板的手动刷新。 */
export function invalidateOutsourceQueueProcessAll(qc: QueryClient): Promise<void> {
  return qc
    .invalidateQueries({ queryKey: qk.outsourceQueueProcessPrefix })
    .then(() => undefined);
}