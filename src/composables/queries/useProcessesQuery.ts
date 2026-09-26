// 2026-09-26 新增：工序下拉选项共享 query（options 域，limit=200 全量拉取
// 供 filter dropdown 使用）。
//
// 设计要点：
//   - 基础数据精确失效策略：与 customers 同 staleTime / gcTime: POSITIVE_INFINITY。
//   - 入参清洗：cleanParams 剥掉 '' / null / [] / undefined 后再进 queryKey，保证
//     cache identity 仅由「实际有值的字段」决定（listProcesses 默认参数 {} 经
//     cleanParams 后仍是 {}，但带 code_like='A' 与不带的 cache 应区分）。
//   - reactive params：params 接受 MaybeRefOrGetter，queryKey 走 computed → useQuery
//     自动响应 ref/computed 变化触发 refetch（无需外部 watcher；与 usePartsListQuery
//     queryKey computed pattern 一致）。queryFn 从 queryKey[2] 读 params，避免
//     setup 一次性 snapshot 把 reactive 锁死。
//   - 写点：processes 写操作全仓仅 ProcessTab.vue 一处（createProcess /
//     updateProcess / softDeleteProcess，2026-09-26 grep 确认：3 处调用点都在
//     src/views/production/components/ProcessTab.vue），后续 C 任务在写成功后挂
//     invalidateProcessesQuery(qc)。
//   - 不写 retry：信任 main.ts 全局 queries.retry: 0。

import { useQuery, type QueryClient } from '@tanstack/vue-query';
import { computed, toValue, type MaybeRefOrGetter } from 'vue';
import { listProcesses } from '@/api/process';
import { processListResultSchema, type ProcessListResultSchema } from './schemas';
import { qk, type ProcessListParams } from './keys';

export function useProcessesQuery(params?: MaybeRefOrGetter<ProcessListParams>) {
  // 2026-09-26：queryKey 走 computed(toValue(params))，params 可以是 Ref / ComputedRef /
  // getter；queryFn 从 queryKey[2] 读最新 params（不 snapshot），保证 reactive params
  // 变化时 listProcesses 拿到的是新值（避免首轮 review B-1 提到的「setup 一次性
  // snapshot 把 cleaned 锁死，后端永远收到空 filter」问题）。
  // 2026-09-26 二改：queryKey[2] 加运行时守卫（非对象回退空对象），避免未来误用
  // 时 cast 类型与 runtime 不一致导致 listProcesses 收到非法入参。
  const paramsKey = computed(() => qk.processesOptions(toValue(params)));
  return useQuery<ProcessListResultSchema, Error>({
    queryKey: paramsKey,
    queryFn: async ({ queryKey }) => {
      const raw = queryKey[2];
      const p: ProcessListParams =
        raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as ProcessListParams) : {};
      return processListResultSchema.parse(await listProcesses(p));
    },
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
  });
}

/** 2026-09-26 新增：失效整个 processes 域（写操作完成后调）。 */
export function invalidateProcessesQuery(qc: QueryClient): Promise<void> {
  return qc.invalidateQueries({ queryKey: qk.processesPrefix }).then(() => undefined);
}