// src/composables/queries/useOutsourcePoolByProcessQuery.ts
//
// 2026-10-03 新增：外协看板单工序详情共享 query（每个外协工序一个 tab，tab body
// **懒加载**唯一数据源：左「可发送候选批次」+ 右「外协公司列」）。形态照抄 pool 域的
// useWorkerPoolByProcessQuery。
//
// 设计要点（沿 CLAUDE.md「TanStack Query 数据获取架构」约定）：
//   - useQuery + 单 reactive params（MaybeRefOrGetter<string | null | undefined>）；
//   - queryKey 走 computed(toValue(processId) ?? '') → processId 变化触发 refetch；
//   - **queryFn 从 queryKey[2] 读最新 processId**，不闭包捕获 `toValue(processId)`
//     （避免 stale：闭包捕获的是挂载那一刻的快照，reactive 变化后会拿着旧 id 打请求）。
//     `queryKey[2]` 这个下标来自 `qk.outsourcePoolByProcess` 的返回值
//     `['outsource-pool', 'by-process', processId]`：[0] 根命名空间 / [1] 端点名 /
//     [2] 唯一入参；键工厂是全仓唯一来源，调用点不拼字面量数组；
//   - 守门走 outsourcePoolByProcessResultSchema.parse；api 层
//     `listOutsourcePoolByProcess` 已 parse 过一次，这里**再一次**：api 层那一次是沿
//     本仓既有 outsource helper 做法在边界挡漂移，queryFn 那一次是 CLAUDE.md §4
//     「共享 useQuery 的 queryFn 必须 parse(await api())」的硬要求（worker-pool 三个
//     query 同款）。`listOutsourcePoolByProcess` 目前只被本 query 消费，故两次 parse
//     在运行路径上重叠；api 层保留是为了与 `api/outsource.ts` 另外 4 个 list helper 同形。
//   - enabled: computed(() => !!toValue(processId)) —— 无工序时零网络请求（tab 未激活
//     / 加载中）；
//   - queryFn 内二次守卫：enabled 只挡自动触发，显式 `refetch()` 会绕过它，不留守卫
//     就会打出 `/outsource-pool/` 空路径（后端 404）；
//   - staleTime / gcTime: 30_000 / 5 * 60 * 1000 —— 短时请求去重层（同页内切 tab 是
//     秒级，30s 足以去重；超 30s 切回自动 refetch，收发完成后候选列表不会停在旧值）；
//   - 不写 retry：信任 src/main.ts 全局 queries.retry: 0。
//
// 失效编排点与**前缀全失效**的理由：invalidateOutsourcePoolByProcessAll(qc) 由看板侧
// 的外协收发 mutation（useOutsourceBoardMove，并行任务，本仓尚无调用方）onSuccess 调。
// **前缀全刷是唯一正确策略** —— 发送的目标工序由当前 tab 决定、后端不自推，mutation
// 回调里可能拿不到受影响的 processId；且一次发送会让「候选批次列表」和「公司列持有数」
// 同时变。
// ⚠️ 编排点 ≠ 全部写点：除看板自身的收发外没有其它写端点能改「可发送候选」这个集合
// （接收是往公司列加行、不产生新候选），但按 CLAUDE.md「跨页面写操作不做穷举失效」
// 策略，这里只保证「写完立即看到自己那笔」。

import { useQuery, type QueryClient } from '@tanstack/vue-query';
import { computed, toValue, type MaybeRefOrGetter } from 'vue';
import { listOutsourcePoolByProcess } from '@/api/outsource';
import {
  outsourcePoolByProcessResultSchema,
  type OutsourcePoolByProcessResultSchema,
} from './schemas';
import { qk } from './keys';

/**
 * 2026-10-03 新增：外协看板单工序详情共享 query。
 *
 * 用法：
 *   ```ts
 *   const q = useOutsourcePoolByProcessQuery(() => props.activeProcessId);
 *   const items = computed(() => q.data.value?.items ?? []);
 *   const companies = computed(() => q.data.value?.companies ?? []);
 *   ```
 *
 * 参数：
 *   - processId：MaybeRefOrGetter<string | null | undefined>。null / undefined / 空串
 *     → enabled=false，零网络请求。
 *
 * 返回：标准 TanStack Vue Query
 * UseQueryReturnType<OutsourcePoolByProcessResultSchema, Error>。
 */
export function useOutsourcePoolByProcessQuery(
  processId: MaybeRefOrGetter<string | null | undefined>,
) {
  // queryKey 走 computed(toValue(processId) ?? '')：processId 可以是 Ref /
  // ComputedRef / getter；queryFn 从 queryKey[2] 读最新 processId（不 snapshot）。
  const processKey = computed(() => qk.outsourcePoolByProcess(toValue(processId) ?? ''));
  return useQuery<OutsourcePoolByProcessResultSchema, Error>({
    queryKey: processKey,
    queryFn: async ({ queryKey }) => {
      const pid = queryKey[2];
      // enabled=false 已挡，但留二次守卫防 queryFn 被显式 refetch() 触发时仍打出
      // `/outsource-pool/` 空路径（后端 404）。
      if (!pid) throw new Error('processId required');
      return outsourcePoolByProcessResultSchema.parse(
        await listOutsourcePoolByProcess(String(pid)),
      );
    },
    // processId 空 → 不发请求（沿 useWorkerPoolByProcessQuery 范本）。
    enabled: computed(() => !!toValue(processId)),
    staleTime: 30_000,
    gcTime: 5 * 60 * 1000,
  });
}

/** 2026-10-03 新增：失效整个 outsource-pool by-process 域（任意 processId 形态）。
 *  **前缀全失效是唯一正确策略** —— 发送的目标工序由当前 tab 决定、后端不自推，
 *  mutation 回调里可能拿不到受影响 processId，故无法精刷。
 *  调用方：看板侧 useOutsourceBoardMove（并行任务，待落地）的收发 mutation onSuccess。 */
export function invalidateOutsourcePoolByProcessAll(qc: QueryClient): Promise<void> {
  return qc.invalidateQueries({ queryKey: qk.outsourcePoolByProcessPrefix }).then(() => undefined);
}
