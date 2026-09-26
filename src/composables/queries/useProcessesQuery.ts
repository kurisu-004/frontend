// 2026-09-26 新增：工序下拉选项共享 query（options 域，limit=200 全量拉取
// 供 filter dropdown 使用）。
//
// 设计要点：
//   - 基础数据精确失效策略：与 customers 同 staleTime / gcTime: POSITIVE_INFINITY。
//   - 入参清洗：cleanParams 剥掉 '' / null / [] / undefined 后再进 queryKey，保证
//     cache identity 仅由「实际有值的字段」决定（listProcesses 默认参数 {} 经
//     cleanParams 后仍是 {}，但带 code_like='A' 与不带的 cache 应区分）。
//   - 写点：processes 写操作全仓仅 ProcessTab.vue 一处（createProcess /
//     updateProcess / softDeleteProcess，2026-09-26 grep 确认：3 处调用点都在
//     src/views/production/components/ProcessTab.vue），后续 C 任务在写成功后挂
//     invalidateProcessesQuery(qc)。
//   - 不写 retry：信任 main.ts 全局 queries.retry: 0。

import { useQuery, type QueryClient } from '@tanstack/vue-query';
import { cleanParams } from '@/api/http';
import { listProcesses } from '@/api/process';
import { processListResultSchema, type ProcessListResultSchema } from './schemas';
import { qk, type ProcessListParams } from './keys';

export function useProcessesQuery(params?: ProcessListParams) {
  // 2026-09-26：cleanParams 出口是 Record<string, unknown>，按 schema 形态断言回
  // ProcessListParams（仅做形状恢复，cleanParams 仅剥 undefined / null / '' / []，
  // 字段名与类型不变，断言安全）。
  const cleaned = cleanParams(params ?? {}) as ProcessListParams;
  return useQuery<ProcessListResultSchema, Error>({
    queryKey: qk.processesOptions(cleaned),
    queryFn: async () => processListResultSchema.parse(await listProcesses(cleaned)),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
  });
}

/** 2026-09-26 新增：失效整个 processes 域（写操作完成后调）。 */
export function invalidateProcessesQuery(qc: QueryClient): Promise<void> {
  return qc.invalidateQueries({ queryKey: qk.processesPrefix }).then(() => undefined);
}