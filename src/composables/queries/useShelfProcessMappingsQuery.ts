// src/composables/queries/useShelfProcessMappingsQuery.ts
//
// 2026-10-02 新增：货架↔工序映射全集共享 query，共享基础数据层。
//
// 背景：`GET /api/v2/prod/shelf-processes`（一次返全部 active 映射，避免 N+1）此前
// 只被 `src/composables/useShelfProcessFilter.ts` 当**裸 async** 用 —— 每次 `load()`
// 各发一次请求，无 queryKey、无 staleTime、**无任何 Zod 守门**。10 处调用实例意味着
// 「一次映射、最多 10 次请求」；更要命的是零守门：BUG-3（把后端扁平行当 v1(Python)
// 的「一架子集一行」读 `item.process_ids` → `new Set(undefined)` = 空集 → 8 个页面的
// 货架/工序下拉被静默清空）之所以能长期存在且测试全绿，根因就是没有任何一层会在
// 契约漂移时喊一声。本次迁移的首要交付物就是这层 Zod 守门。
//
// 设计要点（沿 useProductionShelvesQuery / useWorkerPoolCountsQuery 同源范本）：
//   - useQuery + **常量 queryKey**（qk.shelfProcessMappings，无 params 维度）——
//     后端 handler 不接 Query extractor，一次全量；10 处实例共用同一 cache identity，
//     30s 窗口内进不同页面 / 弹不同对话框都命中缓存，不再重复发请求；
//   - queryFn 走 shelfProcessMappingsResultSchema.parse 守门（4 字段全声明，理由见
//     schemas.ts 同名 schema 顶部注释；守门只在这一处，别在 api 层也 parse ——
//     Zod parse 是深拷贝，两处都做等于白拷一次）；
//   - staleTime / gcTime: 30_000 / 5 * 60 * 1000 —— 沿 CLAUDE.md「TanStack Query 缓存
//     时长策略」：共享基础数据层一律有限缓存，TanStack Query 是「短时请求去重层」
//     而非新鲜度保证。映射表本身几乎不变（只随「货架管理 → 工序映射」配置变更），
//     30s 足以把同一次操作流程里的重复拉取全部去掉；
//   - 不写 retry：信任 main.ts 全局 queries.retry: 0；
//   - `enabled` 形如 getter（`() => toValue(enabled)`）：@tanstack/vue-query 的
//     useBaseQuery 在 `defaultedOptions` computed 内**主动调用**函数形态的 enabled
//     （build/modern/useBaseQuery.js：`if (typeof clonedOptions.enabled === "function")
//     clonedOptions.enabled = clonedOptions.enabled()`），所以 getter 内部读的 ref 会
//     被 computed 收集成依赖 + watch(defaultedOptions) → observer.setOptions → 闸门
//     真能随候选源就绪自动开合。传裸 ref 也支持，但 getter 形态在调用点更直白。
//
// 失效：映射表的写点全仓**只有 1 个** —— 「货架管理 → 工序映射」
// （ShelfList.vue 的 setShelfProcesses），读点则只剩 1 处（2026-10-10 删掉其余 9 处
// 之后，只剩零件详情的外协回收弹窗那一个 useShelfProcessFilter），与写侧无一在
// 写侧同屏。这**不适用** CLAUDE.md「跨页面写
// 操作不做穷举失效」策略 —— 该策略针对的是「写点散落多域、补齐等于穷举全仓」的情形
// （送检 / worker-scan / 品检流转 / outsource 收发），本域不存在这个问题，成本近乎为零
// （2026-10-02 review 第 1 轮 M-3）。故保存成功后调本文件底部的薄封装，把「改了映射
//  后重开对话框即可见」升级成「下一次读即见」。30s 有限 staleTime 仍是兜底，不变。

import { useQuery, type QueryClient } from '@tanstack/vue-query';
import { toValue, type MaybeRefOrGetter } from 'vue';
import { getAllShelfProcessMappings } from '@/api/shelves';
import { shelfProcessMappingsResultSchema, type ShelfProcessMappingsResultSchema } from './schemas';
import { qk } from './keys';

/**
 * 2026-10-02 新增：货架↔工序映射全集共享 query。
 *
 * 用法：
 *   ```ts
 *   const q = useShelfProcessMappingsQuery();
 *   const items = computed(() => q.data.value?.items ?? []);
 *   ```
 *
 * `enabled`（默认恒 true）用于**推迟到候选源就绪再发请求**：唯一的生产消费方
 * `useShelfProcessFilter` 自己会派生闸门（两个下拉源都非空才发），它内部再把
 * getter 透传给本函数。
 *
 * 返回：标准 TanStack Vue Query UseQueryReturnType<ShelfProcessMappingsResultSchema, Error>。
 */
export function useShelfProcessMappingsQuery(enabled: MaybeRefOrGetter<boolean> = true) {
  return useQuery<ShelfProcessMappingsResultSchema, Error>({
    // 常量 queryKey（无 params 维度 —— 端点一次返全量，见文件头）
    queryKey: qk.shelfProcessMappings,
    queryFn: async () => shelfProcessMappingsResultSchema.parse(await getAllShelfProcessMappings()),
    // getter 形态：vue-query 会在 defaultedOptions computed 内调用它，依赖可被收集
    enabled: () => toValue(enabled),
    staleTime: 30_000,
    gcTime: 5 * 60 * 1000,
  });
}

/** 2026-10-02 新增：失效货架↔工序映射域（唯一写点 setShelfProcesses 成功后调）。
 *  键一律走 qk.shelfProcessMappingsPrefix，禁止调用点拼字面量数组。 */
export function invalidateShelfProcessMappingsQuery(qc: QueryClient): Promise<void> {
  return qc.invalidateQueries({ queryKey: qk.shelfProcessMappingsPrefix }).then(() => undefined);
}
