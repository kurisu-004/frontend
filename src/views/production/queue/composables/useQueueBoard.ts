// 单工序看板 useQuery composable（`GET /api/v2/prod/queue/processes/{process_id}`）。
//
// 本 composable 是工序看板数据的**唯一**数据源，消费方 ProcessBoardTab（工序 tab 的
// body）。一次请求拿全：工序元数据 + 工人列（**内联持有批次 + 容量三字段**）+ 该工序
// 候选池。工人列（WorkerColumn）因此零请求 —— 原先「每列一个工人 state 请求」的 N+1
// 在这里是结构性地不存在，不是靠调优消掉的。
//
// 设计要点：
//   - reactive params 范式：`processId: MaybeRefOrGetter<string | null | undefined>`，
//     `queryKey = computed(() => qk.productionQueueBoard(toValue(processId) ?? ''))`；
//   - queryFn **从 queryKey 读** processId（键是唯一真相源），不闭包捕获 stale 值；
//   - `enabled: computed(() => !!toValue(processId))` 闸门 + queryFn 内二次守卫
//     （防显式 refetch 绕过闸门时发出 `/processes/` 空路径请求）；
//   - queryFn 走 `queueBoardSchema.parse(...)` 守门；
//   - staleTime 30_000 / gcTime 5 * 60 * 1000（同域快照：30s 短时去重 + 5min 缓存）。
//     **不用 POSITIVE_INFINITY**（dashboard 域的例外，前提是该域有 WS 事件失效；
//     本轮队列页零 WS 订阅，理由见 useQueueSnapshot.ts 文件头）；
//   - 不写 retry：信任 main.ts 全局 queries.retry: 0；
//   - 错误文案经本域 `queueListErrorText` 收口：ZodError（契约漂移）只给现场一句人话，
//     细节进 console。
//
// 懒加载：`el-tab-pane :lazy="true"` ⇒ ProcessBoardTab 首次激活才 mount，本 query 才
// 发请求；「待下发」首屏不发。

import { computed, toValue, watch, type MaybeRefOrGetter } from 'vue';
import { useQuery, type QueryClient } from '@tanstack/vue-query';
import { ElMessage } from 'element-plus';
import { fetchQueueBoard } from '@/api/productionQueue';
import { qk } from '@/composables/queries/keys';
import { queueBoardSchema } from './productionQueueSchema';
import { queueListErrorText } from './queueListErrorMessage';

/** 单工序看板 query（`GET /api/v2/prod/queue/processes/{process_id}`）。
 *
 *  参数：
 *   - processId：MaybeRefOrGetter<string | null | undefined>。null / undefined /
 *     空字符串 → `enabled=false`，零网络请求。
 *
 *  返回：标准 TanStack Vue Query `UseQueryReturnType<QueueBoardSchema, Error>`。 */
export function useQueueBoard(processId: MaybeRefOrGetter<string | null | undefined>) {
  const boardKey = computed(() => qk.productionQueueBoard(toValue(processId) ?? ''));
  const query = useQuery({
    queryKey: boardKey,
    queryFn: async ({ queryKey }) => {
      const pid = queryKey[2];
      // enabled=false 已挡；留二次守卫防 queryFn 被显式 refetch 时仍打空路径请求。
      if (!pid) throw new Error('processId required');
      return queueBoardSchema.parse(await fetchQueueBoard(String(pid)));
    },
    enabled: computed(() => !!toValue(processId)),
    staleTime: 30_000,
    gcTime: 5 * 60 * 1000,
  });

  // 错误桥接：useQuery 的 error 不在 setup 抛错。ZodError 经本域收口成一句人话
  // （细节只进 console），其余异常沿用原始 message。
  watch(query.error, (e) => {
    if (e) ElMessage.error(queueListErrorText(e, '工序看板加载失败'));
  });

  return query;
}

/** 失效整个工序看板域（**前缀全失效**，任意 processId 形态都命中）。
 *
 *  前缀而非精确键是唯一正确策略：`POST /queue/move` 的目标工序由后端从批次当前
 *  step 推导（前端不再传 process_id），一次 auto-allocate 还能同时动多名工人、
 *  一次 dispatch 可能同时改多个工序池 ⇒ 调用 onSuccess 时都拿不到受影响的
 *  processId，精确失效必然漏刷（漏刷的表现是「徽标更新了、另一侧候选池没更新」）。
 *
 *  返回 Promise<void> 让调用方 await 完整失效链。调用点：useQueueMove /
 *  useQueueDispatch / useQueueRecall 的 mutation 回调 + QueueBoard.onRefresh。 */
export function invalidateQueueBoardAll(qc: QueryClient): Promise<void> {
  return qc
    .invalidateQueries({ queryKey: qk.productionQueueBoardPrefix })
    .then(() => undefined);
}