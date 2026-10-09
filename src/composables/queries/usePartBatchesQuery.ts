// src/composables/queries/usePartBatchesQuery.ts
//
// 2026-09-30 新增：零件 owner 维度批次列表共享 query。供 dashboard
// PartPreviewDialog「该工单批次」列表用，与 usePartFilesListQuery 范式严格对齐
//（owner-keyed 列表 + 二次守卫 + 失效 helper 双形态）。
//
// 设计要点（沿 2026-09-26 TanStack Query 共享基础数据层约定 #5/#6/#7 +
// usePartFilesListQuery 范本）：
//   - 单调用 listPartBatches(partId) 拉 owner 全量，computed 内直接消费。
//   - staleTime 20min / gcTime 30min（与 usePartFilesListQuery 同值 —— part-batches
//     与 part-files 都是可高频变更的派生视图域；用 20min 折中体验与性能，而非
//     Infinity 让用户长时间看不到拆分 / 取消的批次变更）。写操作（拆分 / 取消）
//     由 caller 调 invalidatePartBatchesListQuery 立即失效本 owner 的缓存，跳
//     staleTime 等待。**消费方可以把 staleTime 降到自己那一档**（见 `staleTimeMs`
//     形参，零件详情页传 30s 并说明理由），默认值不变。
//   - reactive params：ownerPartId 是 MaybeRefOrGetter<string | null | undefined>。
//     null/空 → enabled=false + queryFn 二次守卫返回空结果，避免发 ?partId= 请求
//     （listPartBatches(partId) 是路径参数，所以空 ownerId 时 queryFn 也要拦截）。
//   - 不写 retry：信任 main.ts 全局 queries.retry: 0。
//   - api wrapper（src/api/parts/batch.ts::listPartBatches）保留 raw PartBatch[] 返回
//     类型不变（避免改 desktop 消费侧），queryFn 内手动 map 成 { items, total } 后
//     走 schema 守门。schema 形态与 api 形态解耦：若后端后续改为 list out（带
//     limit/offset），queryFn 仅需去掉 map。

import { useQuery, type QueryClient } from '@tanstack/vue-query';
import { computed, toValue, type MaybeRefOrGetter } from 'vue';
import { listPartBatches } from '@/api/parts/batch';
import { partBatchListResultSchema, type PartBatchListResultSchema } from './schemas';
import { qk } from './keys';

/** 2026-09-30 新增：usePartBatchesQuery 空结果常量 —— queryFn 二次守卫用。
 *  与 backend-rust PartBatchListOut 真契约对齐（items + total 必填，limit/offset
 *  optional），避免 listPartBatches 收到空 ownerId 时发请求让后端 422。 */
const EMPTY_RESULT: PartBatchListResultSchema = {
  items: [],
  total: 0,
};

/**
 * 2026-09-30 新增：零件 owner 维度批次列表共享 query。
 *
 * 用法：
 *   ```ts
 *   const q = usePartBatchesQuery(() => props.part?.id ?? null);
 *   const batches = computed(() => q.data.value?.items ?? []);
 *   ```
 *
 * 参数：
 *   - ownerPartId：MaybeRefOrGetter<string | null | undefined>，null/undefined/空
 *     字符串 → enabled=false，queryFn 二次守卫返回空结果，零网络请求。
 *
 * 返回：标准 TanStack Vue Query UseQueryReturnType。
 *
 * 失效：
 *   - 拆分 / 取消批次成功后 caller 调 `invalidatePartBatchesListQuery(qc, partId)`
 *     立即让本 owner 列表变 stale，下次访问 refetch；
 *   - 跨 owner 兜底用 `invalidatePartBatchesListAll(qc)`（prefix 失效）。
 */
export function usePartBatchesQuery(
  ownerPartId: MaybeRefOrGetter<string | null | undefined>,
  /**
   * 2026-10-10 新增（review 第 1 轮）：本 observer 的 `staleTime` 覆盖，默认仍是
   * 共享档 20min。
   *
   * 零件详情页传 30s：它的批次行**不是只读展示**，行状态决定 `inspectionBatch`，也就是
   * 「品检通过 / 指定工序」两个按钮的可点性 ⇒ 看到过期的 INSPECTION 会让人去点一个后端
   * 已经用 20103 拒掉的流转。而其它域（送检 / 工人放回 / 扫码送检 / 外协回收）改的是
   * 批次成员资格，那些写点只失效 `qk.partsPrefix`，**不会**碰 `qk.partBatchesPrefix`
   * （按 CLAUDE.md「缓存定位」，跨页面写不做精确失效补齐）⇒ 新鲜度只能靠 staleTime。
   * 共享档 20min 对详情页太长、对 dashboard 的 PartPreviewDialog（纯展示）无所谓。
   *
   * ⚠️ 与共享键的关系：query-core 的 `Query#isStaleByTime` 取**各 observer staleTime 的
   * 最小值**，所以详情页与预览弹窗同屏时该键按 30s 判新鲜度。这是**收敛到更严的一档**，
   * 与「共享一条 queryKey 换同屏去重」的目标同向，不是缺陷。
   */
  staleTimeMs?: number,
) {
  // 2026-09-30：queryKey 走 computed(toValue(ownerPartId) ?? '')，ownerPartId 可以是
  // Ref / ComputedRef / getter；queryFn 从 queryKey[2] 读最新 partId（不 snapshot），
  // 保证 reactive 变化时 listPartBatches 拿到的是新值（沿 usePartFilesListQuery
  // / useProcessesQuery / usePartsListQuery 范本）。
  const ownerKey = computed(() => qk.partBatchesList(toValue(ownerPartId) ?? ''));
  return useQuery<PartBatchListResultSchema, Error>({
    queryKey: ownerKey,
    queryFn: async ({ queryKey }) => {
      const ownerId = queryKey[2];
      // 2026-09-30：enabled=false 已挡住 queryFn 调用，但留二次守卫防 queryFn 被
      // 显式调 refetch 时仍走请求（避免后端 404 路径参数为空）。
      if (!ownerId) return EMPTY_RESULT;
      // 2026-09-30：listPartBatches(partId) 当前返 raw PartBatch[]；map 成
      // { items, total } → schema 守门。后续若后端切 list out，去掉 map 即可。
      const arr = await listPartBatches(String(ownerId));
      return partBatchListResultSchema.parse({ items: arr, total: arr.length });
    },
    enabled: computed(() => !!toValue(ownerPartId)),
    // 2026-09-30：与 usePartFilesListQuery 同值（20min / 30min）—— part-batches 与
    // part-files 同属「可高频变更的派生视图域」，不挂 Infinity。
    // 2026-10-10：允许调用方按消费侧形态覆盖（见 `staleTimeMs` 形参注释）。
    staleTime: staleTimeMs ?? 20 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
  });
}

/** 2026-09-30 新增：失效指定 owner 的 part-batches 列表。
 *  调用方：拆分 / 取消批次 mutation onSuccess；当前 dashboard PartPreviewDialog
 *  暂不触发（PartPreviewDialog 只展示），本 helper 留作未来 PartDetail.vue
 *  批次操作场景用。返回 Promise<void> 让 caller 可以 await 失效完成再走后续逻辑。 */
export function invalidatePartBatchesListQuery(
  qc: QueryClient,
  partId: string,
): Promise<void> {
  return qc.invalidateQueries({ queryKey: qk.partBatchesList(partId) }).then(() => undefined);
}

/** 2026-09-30 新增：失效整个 part-batches 域（任意 partId 形态）。 */
export function invalidatePartBatchesListAll(qc: QueryClient): Promise<void> {
  return qc.invalidateQueries({ queryKey: qk.partBatchesPrefix }).then(() => undefined);
}