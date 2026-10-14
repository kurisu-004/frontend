// 2026-09-26 新增：工序下拉选项共享 query（options 域，limit=200 全量拉取
// 供 filter dropdown 使用）。
//
// 设计要点：
//   - staleTime / gcTime: 30_000 / 5 * 60 * 1000 —— 与 customers 同值（同属「短时
//     去重窗口 + 空闲保留」策略，2026-09-30 起不再用 POSITIVE_INFINITY 会话级缓存；
//     理由见 CLAUDE.md「TanStack Query 缓存时长策略」）：30s 内同一 params 形态命中
//     缓存不重发，切回页面超 30s 自动 refetch。
//   - 入参清洗：cleanParams 剥掉 '' / null / [] / undefined 后再进 queryKey，保证
//     cache identity 仅由「实际有值的字段」决定（listProcesses 默认参数 {} 经
//     cleanParams 后仍是 {}，但带 code_like='A' 与不带的 cache 应区分）。
//   - reactive params：params 接受 MaybeRefOrGetter，queryKey 走 computed → useQuery
//     自动响应 ref/computed 变化触发 refetch（无需外部 watcher；与 usePartsListQuery
//     queryKey computed pattern 一致）。queryFn 从 queryKey[2] 读 params，避免
//     setup 一次性 snapshot 把 reactive 锁死。
//   - 写点：已知的工序写点全仓仅 ProcessTab.vue 一处（createProcess /
//     updateProcess / softDeleteProcess，2026-09-26 grep 确认：3 处调用点都在
//     src/views/production/components/ProcessTab.vue），写成功后由该组件调
//     invalidateProcessesQuery(qc)。2026-09-30 更正：这只是「已显式挂失效的写点」
//     清单，**不是**「全部写点」—— 缓存时长已改为有限值（30s / 5min）兜底新鲜度，
//     不再依赖穷举写点。
//   - 不写 retry：信任 main.ts 全局 queries.retry: 0。
//   - 2026-10-20 新增可选第二参 `options.enabled`（enabled 闸门）：见
//     UseProcessesQueryOptions 的注释。不传时行为与此前逐字一致。

import { useQuery, type QueryClient } from '@tanstack/vue-query';
import { computed, toValue, type MaybeRefOrGetter } from 'vue';
import { listProcesses } from '@/api/process';
import { processListResultSchema, type ProcessListResultSchema } from './schemas';
import { qk, type ProcessListParams } from './keys';

export interface UseProcessesQueryOptions {
  /**
   * 2026-10-20 新增：enabled 闸门（`MaybeRefOrGetter<boolean | undefined>`，可传 getter）。
   * 不传 = 恒启用，与 2026-09-26 起的行为逐字一致。
   *
   * 消费方：报工台的工序选择弹窗（`views/production/scan/components/ProcessPickerDialog.vue`），
   * 它只在弹窗可见时才需要工序字典，闸门取 `() => props.modelValue` ⇒ 弹窗关着时零请求、
   * 开着时与生产队列看板（`QueueBoard.vue`，恒启用）共享同一条 queryKey ⇒ 同屏两处只发
   * 一次往返。闸门只挡**发起请求**，不挡读缓存：缓存新鲜时打开弹窗直接命中，零往返。
   */
  enabled?: MaybeRefOrGetter<boolean | undefined>;
}

export function useProcessesQuery(
  params?: MaybeRefOrGetter<ProcessListParams>,
  options?: UseProcessesQueryOptions,
) {
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
    // 2026-10-20：undefined 时等价于「恒启用」，vue-query 内部按缺省 true 处理。
    enabled: options?.enabled,
    staleTime: 30_000,
    gcTime: 5 * 60 * 1000,
  });
}

/** 2026-09-26 新增：失效整个 processes 域（写操作完成后调）。 */
export function invalidateProcessesQuery(qc: QueryClient): Promise<void> {
  return qc.invalidateQueries({ queryKey: qk.processesPrefix }).then(() => undefined);
}
