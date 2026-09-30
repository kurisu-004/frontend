// src/composables/queries/usePendingBatchesQuery.ts
//
// 2026-09-29 新增：待下发批次共享 query（生产队列「待下发」Tab 共享基础数据层）。
//
// 设计要点（沿 2026-09-26 TanStack Query 共享基础数据层约定 #5/#6/#7）：
//   - useQuery + reactive params（MaybeRefOrGetter<ListPendingBatchesParams>）；
//   - queryKey 走 computed(toValue(params)) → params 变化自动 refetch；
//   - queryFn 从 queryKey[2] 读最新 params（避免闭包捕获 stale —— 与 useProcessesQuery
//     / usePartsListQuery 同源范本）；
//   - queryFn 走 pendingBatchListResultSchema.parse 守门（M-1 regression guard：缺字段
//     静默 strip = 校验形同虚设）；
//   - staleTime / gcTime: 30_000 / 5 * 60 * 1000 —— 短时请求去重层（2026-09-30 起
//     不再用 POSITIVE_INFINITY 会话级缓存，理由见 CLAUDE.md「TanStack Query 缓存时长
//     策略」）：切回「待下发」Tab 超 30s 自动 refetch；已显式挂失效的写点为
//     usePendingDispatch 的 dispatch 成功后 invalidateAll()（pendingBatchesPrefix +
//     跨域 partsPrefix + worker-pool 三域 by-process / counts / state，共 5 个前缀键；
//     2026-09-30 修复已去掉 processesPrefix —— 下发批次不改变工序列表）；
//   - 不写 retry：信任 main.ts 全局 queries.retry: 0。
//
// 写点（2026-09-30 订正端点名）：pending-batches 域的**写**端点只剩
// `dispatchBatches`（bulk-only，单条即 targets.length === 1），前端唯一调用点在
// usePendingDispatch.ts，成功后调 invalidatePendingBatchesQuery(qc)。
// 旧注释里的 `bulkDispatchBatches`（端点已删除，router 不再挂载 ⇒ 404）与
// `autoDispatchBatches`（2026-09-30 已降级为**只读** `previewAutoDispatch`，不写库、
// 不需要失效）均已不是写点。新鲜度不依赖穷举写点：30s 窗口 + 跨页面写操作后
// 切回页面自动 refetch 兜底。

import { useQuery, type QueryClient } from '@tanstack/vue-query';
import { computed, toValue, type MaybeRefOrGetter } from 'vue';
import { fetchPendingBatches, type ListPendingBatchesParams } from '@/api/pendingBatches';
import { pendingBatchListResultSchema, type PendingBatchListResultSchema } from './schemas';
import { qk } from './keys';

/**
 * 2026-09-29 新增：待下发批次共享 query。
 *
 * 用法：
 *   ```ts
 *   const paramsRef = ref<ListPendingBatchesParams>({ limit: 200 });
 *   const q = usePendingBatchesQuery(paramsRef);
 *   const items = computed(() => q.data.value?.items ?? []);
 *   ```
 *
 * 参数：
 *   - params：MaybeRefOrGetter<ListPendingBatchesParams>，默认 { limit: 200 }。
 *     显式传 undefined / 空 → queryKey 第二项为 {}（与其他 query 工厂同源语义）。
 *
 * 返回：标准 TanStack Vue Query UseQueryReturnType<PendingBatchListResultSchema, Error>。
 */
export function usePendingBatchesQuery(
  params?: MaybeRefOrGetter<ListPendingBatchesParams>,
) {
  // 2026-09-29：queryKey 走 computed(toValue(params) ?? {})，params 可以是 Ref /
  // ComputedRef / getter；queryFn 从 queryKey[2] 读最新 params（不 snapshot），保证
  // reactive params 变化时 fetchPendingBatches 拿到的是新值（沿 useProcessesQuery /
  // usePartsListQuery 范本 #5）。
  const paramsKey = computed(() => qk.pendingBatchesList(toValue(params) ?? {}));
  return useQuery<PendingBatchListResultSchema, Error>({
    queryKey: paramsKey,
    queryFn: async ({ queryKey }) => {
      const raw = queryKey[2];
      const p: ListPendingBatchesParams =
        raw && typeof raw === 'object' && !Array.isArray(raw)
          ? (raw as ListPendingBatchesParams)
          : {};
      return pendingBatchListResultSchema.parse(await fetchPendingBatches(p));
    },
    staleTime: 30_000,
    gcTime: 5 * 60 * 1000,
  });
}

/** 2026-09-29 新增：失效整个 pending-batches 域（写操作完成后调）。
 *  返回 Promise<void> 让 caller 可以 await 失效完成再走后续逻辑。 */
export function invalidatePendingBatchesQuery(qc: QueryClient): Promise<void> {
  return qc.invalidateQueries({ queryKey: qk.pendingBatchesPrefix }).then(() => undefined);
}