// src/composables/queries/usePartFilesListQuery.ts
//
// 2026-09-29 新增：零件 owner 维度文件列表共享 query。替代 usePartFiles 三并发请求
//（fetchDrawings + fetch3DModels + fetchCadFiles 各发一次 listPartFilesByOwner，
// 共 3 个 RTT 浪费）。
//
// 设计要点（沿 2026-09-26 TanStack Query 共享基础数据层约定 #5/#6/#7）：
//   - 单调用 listPartFilesByOwner(partId) 拉 owner 全量，computed 按 kind 桶。
//   - staleTime 20min（图纸/3D 几乎不变业务特性），gcTime 30min（切回不重复拉）。
//     比 2026-09-26 的 Infinity 短 —— part-files 域可能频繁新增/删除文件，
//     旧值长期不失效会导致用户上传新文件后 20min 内看不到；20min 是体验与性能
//     的折中。写操作（上传 / 删除）由 caller 调 invalidatePartFilesListQuery
//     立即失效本 owner 的缓存，跳过 staleTime 等待。
//   - reactive params：ownerPartId 是 MaybeRefOrGetter<string | null | undefined>。
//     null/空 → enabled=false + queryFn 二次守卫返回空结果，避免发 ?owner_id= 请求。
//   - 不写 retry：信任 main.ts 全局 queries.retry: 0。

import { useQuery, type QueryClient } from '@tanstack/vue-query';
import { computed, toValue, type MaybeRefOrGetter } from 'vue';
import { listPartFilesByOwner } from '@/api/assembly';
import { partFileListResultSchema, type PartFileListResultSchema } from './schemas';
import { qk } from './keys';

/** 2026-09-29 新增：usePartFilesListQuery 空结果常量 —— queryFn 二次守卫用。
 *  与 backend-rust PartFileListOut 真契约对齐（items + total 必填，limit/offset
 *  optional），避免 listPartFilesByOwner 收到空 ownerId 时发 ?owner_id= 请求让
 *  后端 422。 */
const EMPTY_RESULT: PartFileListResultSchema = {
  items: [],
  total: 0,
};

/**
 * 2026-09-29 新增：零件 owner 维度文件列表共享 query。
 *
 * 用法：
 *   ```ts
 *   const q = usePartFilesListQuery(() => props.part?.id ?? null);
 *   const files = computed(() => q.data.value?.items ?? []);
 *   const drawings = computed(() => files.value.filter(f => f.kind === 'DRAWING'));
 *   ```
 *
 * 参数：
 *   - ownerPartId：MaybeRefOrGetter<string | null | undefined>，null/undefined/空
 *     字符串 → enabled=false，queryFn 二次守卫返回空结果，零网络请求。
 *
 * 返回：标准 TanStack Vue Query UseQueryReturnType。
 *
 * 失效：
 *   - 上传 / 删除成功后 caller 调 `invalidatePartFilesListQuery(qc, ownerId)`
 *     立即让本 owner 列表变 stale，下次访问 refetch。
 */
export function usePartFilesListQuery(
  ownerPartId: MaybeRefOrGetter<string | null | undefined>,
) {
  // 2026-09-29：queryKey 走 computed(toValue(ownerPartId) ?? '')，ownerPartId 可以是
  // Ref / ComputedRef / getter；queryFn 从 queryKey[2] 读最新 ownerId（不 snapshot），
  // 保证 reactive 变化时 listPartFilesByOwner 拿到的是新值（沿 useProcessesQuery
  // / usePartsListQuery 范本）。
  const ownerKey = computed(() => qk.partFilesList(toValue(ownerPartId) ?? ''));
  return useQuery<PartFileListResultSchema, Error>({
    queryKey: ownerKey,
    queryFn: async ({ queryKey }) => {
      const ownerId = queryKey[2];
      // 2026-09-29：enabled=false 已挡住 queryFn 调用，但留二次守卫防 queryFn 被
      // 显式调 refetch 时仍走 ?owner_id= 请求（避免后端 422）。
      if (!ownerId) return EMPTY_RESULT;
      return partFileListResultSchema.parse(await listPartFilesByOwner(String(ownerId)));
    },
    enabled: computed(() => !!toValue(ownerPartId)),
    staleTime: 20 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
  });
}

/** 2026-09-29 新增：失效指定 owner 的 part-files 列表。
 *  调用方：PartDetail.vue onFileTabRefresh / 上传 / 删除成功后。
 *  返回 Promise<void> 让 caller 可以 await 失效完成再走后续逻辑。 */
export function invalidatePartFilesListQuery(
  qc: QueryClient,
  ownerId: string,
): Promise<void> {
  return qc.invalidateQueries({ queryKey: qk.partFilesList(ownerId) }).then(() => undefined);
}

/** 2026-09-29 新增：失效整个 part-files 域（任意 ownerId 形态）。
 *  留作未来多 owner / 跨页面失效场景的兜底；当前调用点都按 owner 维度失效。 */
export function invalidatePartFilesListAll(qc: QueryClient): Promise<void> {
  return qc.invalidateQueries({ queryKey: qk.partFilesPrefix }).then(() => undefined);
}
