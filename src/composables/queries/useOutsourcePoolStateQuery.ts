// src/composables/queries/useOutsourcePoolStateQuery.ts
//
// 2026-10-03 新增：外协看板「单公司 × 单工序在途批次」共享 query（右侧外协公司列的
// 展开内容 —— 看板形态照抄生产队列 /workers/queue 的 WorkerColumn）。
//
// 设计要点（沿 CLAUDE.md「TanStack Query 数据获取架构」约定）：
//   - useQuery + **双** reactive params（outsourceCompanyId + processId）：公司列是
//     (公司 × 工序) 的笛卡尔格，两个维度各自独立变化；
//   - queryKey 走 computed(toValue(companyId) ?? '', toValue(processId) ?? '') → 任一
//     变化触发 refetch；
//   - **queryFn 从 queryKey[2..3] 读最新参数**，不闭包捕获 `toValue(...)`：闭包捕获的
//     是挂载那一刻的快照，reactive 变化后会拿着旧 id 打卡。公司列正是最依赖
//     reactive 的场景（看板列会随收发重排 / 增删）。
//     下标来源：`qk.outsourcePoolState` 返回
//     `['outsource-pool', 'state', outsourceCompanyId, processId]` —— [0] 根命名空间
//     / [1] 端点名 / [2] 外协公司 id / [3] 工序 id。键工厂是全仓唯一来源，调用点不
//     拼字面量数组；
//   - 守门走 outsourcePoolStateResultSchema.parse；api 层
//     `listOutsourcePoolState` 已 parse 过一次，这里**再一次** —— 是刻意的双重
//     parse：api 层沿本仓既有 outsource helper 做法挡边界漂移，queryFn 那次是
//     CLAUDE.md §4「共享 useQuery 的 queryFn 必须 parse(await api())」的硬要求
//     （worker-pool 三个 query 同款），两层都不可省。
//   - enabled: computed(() => !!(toValue(companyId) && toValue(processId))) ——
//     **两个 query 参数都必填**，缺任一个零网络请求（否则后端直接拒，且会打出
//     空参数请求）；
//   - queryFn 内二次守卫：enabled 只挡自动触发，显式 `refetch()` 会绕过它；
//   - staleTime / gcTime: 30_000 / 5 * 60 * 1000 —— 短时请求去重层（同页内切 tab /
//     点开不同公司列是秒级，30s 足以去重；超 30s 自动 refetch，接收完成后另一列的
//     持有数不会停在旧值）；
//   - 不写 retry：信任 src/main.ts 全局 queries.retry: 0。
//
// 失效编排点与**前缀全失效**的理由：invalidateOutsourcePoolStateAll(qc) 由看板侧的
// 外协收发 mutation（useOutsourceBoardMove，并行任务，本仓尚无调用方）onSuccess 调。
// **前缀全刷是唯一正确策略** —— 一次发送/接收会同时改多个公司列的 `current_held`
// （发送释放源公司的持有、接收把批次落到目标公司），无法定位到 (公司, 工序) 这一对。
// ⚠️ 编排点 ≠ 全部写点：与 CLAUDE.md「跨页面写操作不做穷举失效」策略一致，这里只
// 保证「写完立即看到自己那笔」。

import { useQuery, type QueryClient } from '@tanstack/vue-query';
import { computed, toValue, type MaybeRefOrGetter } from 'vue';
import { listOutsourcePoolState } from '@/api/outsource';
import { outsourcePoolStateResultSchema, type OutsourcePoolStateResultSchema } from './schemas';
import { qk } from './keys';

/**
 * 2026-10-03 新增：外协看板单公司 × 单工序在途批次共享 query。
 *
 * 用法：
 *   ```ts
 *   const q = useOutsourcePoolStateQuery(
 *     () => props.activeCompanyId,
 *     () => props.activeProcessId,
 *   );
 *   const held = computed(() => q.data.value?.items ?? []);
 *   ```
 *
 * 参数：
 *   - outsourceCompanyId：MaybeRefOrGetter<string | null | undefined>；
 *   - processId：MaybeRefOrGetter<string | null | undefined>。
 *     两个参数任一为空 → enabled=false，零网络请求。
 *
 * 返回：标准 TanStack Vue Query
 * UseQueryReturnType<OutsourcePoolStateResultSchema, Error>。
 */
export function useOutsourcePoolStateQuery(
  outsourceCompanyId: MaybeRefOrGetter<string | null | undefined>,
  processId: MaybeRefOrGetter<string | null | undefined>,
) {
  // queryKey 走 computed(toValue(companyId) ?? '', toValue(processId) ?? '')：双
  // reactive 参数各自独立触发 refetch；queryFn 从 queryKey[2..3] 读最新值（不 snapshot）。
  const stateKey = computed(() =>
    qk.outsourcePoolState(toValue(outsourceCompanyId) ?? '', toValue(processId) ?? ''),
  );
  return useQuery<OutsourcePoolStateResultSchema, Error>({
    queryKey: stateKey,
    queryFn: async ({ queryKey }) => {
      const companyId = queryKey[2];
      const pid = queryKey[3];
      // enabled=false 已挡，但留二次守卫防 queryFn 被显式 refetch() 触发时仍打出
      // 空参数请求（后端两个参数都必填）。
      if (!companyId || !pid) throw new Error('outsource_company_id + process_id required');
      return outsourcePoolStateResultSchema.parse(
        await listOutsourcePoolState({
          outsource_company_id: String(companyId),
          process_id: String(pid),
        }),
      );
    },
    // 双参数都必填才发请求（沿 useWorkerStateByWorkerQuery 范本）。
    enabled: computed(() => !!(toValue(outsourceCompanyId) && toValue(processId))),
    staleTime: 30_000,
    gcTime: 5 * 60 * 1000,
  });
}

/** 2026-10-03 新增：失效整个 outsource-pool state 域（任意 (公司, 工序) 形态）。
 *  **前缀全失效是唯一正确策略** —— 一次发送/接收会同时改多个公司列的持有集合
 *  （发送释放源公司、接收写入目标公司），无法精刷到某一对参数。
 *  调用方：看板侧 useOutsourceBoardMove（并行任务，待落地）的收发 mutation onSuccess。 */
export function invalidateOutsourcePoolStateAll(qc: QueryClient): Promise<void> {
  return qc.invalidateQueries({ queryKey: qk.outsourcePoolStatePrefix }).then(() => undefined);
}
