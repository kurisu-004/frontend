// src/composables/queries/useProductionShelvesQuery.ts
//
// 2026-10-01 新增：生产货架（PRODUCTION zone）下拉共享 query，共享基础数据层。
//
// 背景：「待编程一览」页（cnc/PendingProgrammingList.vue）的「下发到 CNC 货架」
// 对话框原先在视图里裸调 `listShelves({ zone: 'PRODUCTION', is_active: true,
// limit: 200 })` —— 违反 2026-09-30「查询一律 useQuery」硬约束。货架是典型的
// 基础数据（几乎不变、跨页面共用：零件一览下发 / CNC 下发 / 返修启动三处都拉
// PRODUCTION 货架），按 CLAUDE.md 两层数据获取架构归入共享层而非页面 store。
//
// 设计要点（沿 useProcessesQuery / usePendingBatchesQuery 同源范本）：
//   - useQuery + reactive params（MaybeRefOrGetter<ListShelvesParams>）；
//   - queryKey 走 computed(toValue(params) ?? {}) → params 变化自动 refetch；
//   - queryFn 从 queryKey[2] 读最新 params（不闭包捕获 stale —— CLAUDE.md
//     架构条目 #5）+ shelfListResultSchema.parse 守门（§M-4：10 字段全声明，
//     缺字段静默 strip = 校验形同虚设）。守门只在这一处：api/shelves.ts::listShelves
//     返 raw（与 programming 域「守门收敛在 api 层」的形态**不同**，见
//     2026-10-01 review 第 1 轮 M-2 —— 别在两处都 parse，Zod parse 是深拷贝）；
//   - staleTime / gcTime: 30_000 / 5 * 60 * 1000 —— 与 customers / processes /
//     pending-batches 同值（沿 CLAUDE.md「TanStack Query 缓存时长策略」：共享
//     基础数据层一律有限缓存，TanStack Query 是「短时请求去重层」而非新鲜度保证）。
//     30s 内三处下拉互相复用同一份缓存；超 30s 的访问自动 refetch。
//   - 不写 retry：信任 main.ts 全局 queries.retry: 0。
//
// 失效（写点）：2026-10-01 review 第 1 轮 M-3 删掉了本文件原先的
// `invalidateProductionShelvesQuery` + `qk.shelvesPrefix` —— 两者都零调用方
// （货架写点在 ShelfList.vue，2026-10-01 未挂失效；按 CLAUDE.md「跨页面写操作
// 不做穷举失效」策略，30s 有限 staleTime 兜新鲜度），留着只是没人用的死 API。
// 将来真要挂货架写点失效时，在 qk.shelvesPrefix 补键 + 在此补薄封装即可。

import { useQuery } from '@tanstack/vue-query';
import { computed, toValue, type MaybeRefOrGetter } from 'vue';
import { listShelves, type ListShelvesParams } from '@/api/shelves';
import { shelfListResultSchema, type ShelfListResultSchema } from './schemas';
import { qk } from './keys';

/**
 * 2026-10-01 新增：货架列表共享 query（默认不限 zone —— 调用方按需传
 * `{ zone: 'PRODUCTION', is_active: true, limit: 200 }` 等入参）。
 *
 * 用法：
 *   ```ts
 *   const q = useProductionShelvesQuery({ zone: 'PRODUCTION', is_active: true, limit: 200 });
 *   const shelves = computed(() => q.data.value?.items ?? []);
 *   ```
 *
 * 返回：标准 TanStack Vue Query UseQueryReturnType<ShelfListResultSchema, Error>。
 */
export function useProductionShelvesQuery(params?: MaybeRefOrGetter<ListShelvesParams>) {
  const paramsKey = computed(() => qk.shelvesList(toValue(params) ?? {}));
  return useQuery<ShelfListResultSchema, Error>({
    queryKey: paramsKey,
    queryFn: async ({ queryKey }) => {
      const raw = queryKey[2];
      const p: ListShelvesParams =
        raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as ListShelvesParams) : {};
      return shelfListResultSchema.parse(await listShelves(p));
    },
    staleTime: 30_000,
    gcTime: 5 * 60 * 1000,
  });
}
