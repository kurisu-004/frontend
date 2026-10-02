// src/composables/queries/useWorkTypesQuery.ts
//
// 2026-10-02 新增：工种 + 工种↔工序映射共享 query，共享基础数据层。
//
// 背景：本域此前**零 queryKey、零 Zod 守门、零失效编排** —— 「工序管理 → 工序映射」
// Tab（src/views/production/components/ProcessWorkTypeMappingTab.vue）直接裸调
// `listWorkTypes` / `getWorkTypeProcesses` / `setWorkTypeProcesses`，自己管三个
// `loadingXxx` ref + 一份 `initialProcessIds` 基线。三个线上症状全从这里长出来：
//   BUG-1（undefined.map）：读 v1 影子形态 `detail.processes.map(...)`，后端返
//          `{items:[...]}` ⇒ `processes` 恒 undefined ⇒ TypeError 被裸 catch 吞掉
//          后原样弹 toast。零 schema 守门 ⇒ 编译期不拦、运行期也不喊。
//   BUG-2（静默清空整组映射）：保存发 `{process_ids: [...]}`，后端要
//          `items: [{process_id, sort_order}]`（整组替换语义）；而「加载失败时
//          initialProcessIds 残留上一个工种的 id」让 dirty watcher 立刻置 true，
//          保存按钮直接可点。
//   BUG-3（改完不刷新）：本域没有「保存后失效」这条链。
//
// 设计要点（沿 useProcessesQuery / useShelfProcessMappingsQuery 同源范本）：
//   - reactive params：params 接受 MaybeRefOrGetter，queryKey 走
//     computed(toValue(params))，queryFn **从 queryKey[2] 读 params**（不闭包
//     捕获 stale —— CLAUDE.md 范本 #5 / useProcessesQuery:37-45）；
//   - queryFn 走 workTypeListResultSchema.parse 守门（M-1 strip 陷阱：本域 10 个
//     字段全显式声明，含此前 @/types/workType.ts 漏掉的 process_ids）；
//   - staleTime / gcTime: 30_000 / 5 * 60 * 1000（CLAUDE.md「缓存时长策略」：
//     共享基础数据层一律有限缓存；工种/映射表几乎不变，30s 足以去掉同一次操作
//     流程里的重复拉取）；
//   - 不写 retry：信任 src/main.ts 全局 queries.retry: 0；
//   - useWorkTypeProcessesQuery 的 workTypeId 用**空字符串占位 + enabled 闸门 +
//     queryFn 二次守卫**（照 useWorkerPoolByProcessQuery:75-89）：未选中工种时零请求。
//
// 失效编排：映射的写点全仓**只有 1 个**（setWorkTypeProcesses，就在同一个 Tab 里），
// 不适用 CLAUDE.md「跨页面写操作不做穷举失效」策略（那针对写点散落多域、补齐等于
// 穷举全仓的情形）。保存成功后失效**两个域**：
//   - workTypeProcessesPrefix：让右表勾选态立即反映服务端（这一条是**当前可见**的
//     修复 —— 不失效则保存后勾选区与基线对不上）；
//   - workTypesPrefix：**缓存一致性维护位**，不是当前可见 bug 的修复。后端
//     `WorkTypeOut.process_ids` 由 list 端点批量补全（vo/work_type.rs:20），所以
//     映射一改，缓存里那份工种列表的该字段确实过期了；但唯一的消费者
//     （ProcessWorkTypeMappingTab）左表**只渲染 code / name**，画面不会有任何变化。
//     保留它是为了不让失效链依赖「左表恰好不读 process_ids」这个脆弱前提 ——
//     将来左表加列（典型如「已映射 N 道工序」）时不会立刻暴出「左表旧 + 右表新」
//     的分裂。成本是每次保存多一次 invalidate（30s staleTime 下通常不真发请求）。
//   30s 有限 staleTime 仍是兜底，不变。

import { useQuery, type QueryClient } from '@tanstack/vue-query';
import { computed, toValue, type MaybeRefOrGetter } from 'vue';
import { getWorkTypeProcesses, listWorkTypes, type WorkTypeListParams } from '@/api/workType';
import {
  workTypeListResultSchema,
  workTypeProcessesResultSchema,
  type WorkTypeListResultSchema,
  type WorkTypeProcessesResultSchema,
} from './schemas';
import { qk } from './keys';

/**
 * 2026-10-02 新增：工种列表共享 query。
 *
 * 用法：
 *   ```ts
 *   const q = useWorkTypesQuery({ limit: 200 });
 *   const workTypes = computed(() => q.data.value?.items ?? []);
 *   ```
 *
 * params 可为静态对象 / Ref / ComputedRef / getter（MaybeRefOrGetter）；依赖变化时
 * queryKey 自动重算 → refetch，queryFn 读到的是 queryKey 里的最新值。
 *
 * 返回：标准 TanStack Vue Query UseQueryReturnType<WorkTypeListResultSchema, Error>。
 */
export function useWorkTypesQuery(params?: MaybeRefOrGetter<WorkTypeListParams>) {
  const paramsKey = computed(() => qk.workTypesList(toValue(params) ?? {}));
  return useQuery<WorkTypeListResultSchema, Error>({
    queryKey: paramsKey,
    queryFn: async ({ queryKey }) => {
      // 2026-10-02：从 queryKey[2] 读 params 而非闭包捕获（CLAUDE.md 范本 #5），
      // 否则 setup 期 snapshot 会把 reactive params 锁死（useProcessesQuery 首轮
      // review B-1 即此问题）。非对象回退空对象作运行时守卫，避免 cast 类型与
      // runtime 不一致让 listWorkTypes 收到非法入参。
      const raw = queryKey[2];
      const p: WorkTypeListParams =
        raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as WorkTypeListParams) : {};
      return workTypeListResultSchema.parse(await listWorkTypes(p));
    },
    staleTime: 30_000,
    gcTime: 5 * 60 * 1000,
  });
}

/**
 * 2026-10-02 新增：单个工种已映射工序列表共享 query。
 *
 * 用法：
 *   ```ts
 *   const q = useWorkTypeProcessesQuery(selectedWorkTypeId);
 *   const ids = computed(() => (q.data.value ? toWorkTypeProcessIds(q.data.value) : []));
 *   ```
 *
 * 参数：MaybeRefOrGetter<string>。**空字符串 → enabled=false，零网络请求**
 * （未选中工种时右侧是「请选择工种」，不该发请求）。
 *
 * 返回：标准 TanStack Vue Query UseQueryReturnType<WorkTypeProcessesResultSchema, Error>。
 * `isError` 是视图层「加载失败硬闸」的唯一依据 —— 该端点一旦失败，用户看到的
 * 勾选态就是**不完整快照**，此时保存 = 整组覆盖真实映射（BUG-2 的致命路径）。
 */
export function useWorkTypeProcessesQuery(workTypeId: MaybeRefOrGetter<string>) {
  const processKey = computed(() => qk.workTypeProcesses(toValue(workTypeId) ?? ''));
  return useQuery<WorkTypeProcessesResultSchema, Error>({
    queryKey: processKey,
    queryFn: async ({ queryKey }) => {
      const id = queryKey[2];
      // enabled=false 已挡，但留二次守卫防 queryFn 被显式 refetch 时仍发请求
      // （避免打到 /prod/work-types//processes 让后端 400/422）。
      if (!id) throw new Error('workTypeId required');
      return workTypeProcessesResultSchema.parse(await getWorkTypeProcesses(String(id)));
    },
    enabled: () => !!toValue(workTypeId),
    staleTime: 30_000,
    gcTime: 5 * 60 * 1000,
  });
}

/** 2026-10-02 新增：失效工种列表域。
 *  唯一消费方是保存映射后的 onSuccess（映射一改 `WorkTypeOut.process_ids` 就变）。
 *  键一律走 qk.workTypesPrefix，禁止调用点拼字面量数组。 */
export function invalidateWorkTypesQuery(qc: QueryClient): Promise<void> {
  return qc.invalidateQueries({ queryKey: qk.workTypesPrefix }).then(() => undefined);
}

/** 2026-10-02 新增：失效工种↔工序映射域（任意 work_type_id 形态）。
 *  键一律走 qk.workTypeProcessesPrefix。 */
export function invalidateWorkTypeProcessesQuery(qc: QueryClient): Promise<void> {
  return qc.invalidateQueries({ queryKey: qk.workTypeProcessesPrefix }).then(() => undefined);
}
