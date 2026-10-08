// 2026-10-10 新增：dashboard 装配件子件列表 query（交期面板点装配件行 → 子件弹窗取数）。
//
// 形态严格照 `src/composables/queries/usePartBatchesQuery.ts`（owner-keyed 列表 +
// 二次守卫 + 失效 helper 双形态）：
//   - reactive params：入参是装配件 id 的 MaybeRefOrGetter，null/空 → enabled=false +
//     queryFn 二次守卫返回空数组，零网络请求。闸门只认 id、**不认弹窗开关**：父组件在
//     弹窗关闭时把 assemblyId 置 null，闸门才跟着关；
//   - queryKey 走 computed(toValue(id) ?? '')，queryFn 从 queryKey[2] 读最新 id，
//     不 snapshot 闭包；
//   - staleTime 20min / gcTime 30min（与 usePartBatchesQuery / usePartFilesListQuery
//     同值 —— 子件是可变更的派生数据，不挂 Infinity）。staleTime 只决定「下次取数放不
//     放行」、**不产生定时器**，所以开着弹窗期间的新鲜度靠消费方注册的
//     `useDashboardInvalidation(qk.assemblyPrefix)`（AssemblyChildrenDialog 里已注册），
//     本 hook 自身不订阅 WS。
//
// 数据源：**零新增后端端点** —— `getAssembly(id)`（`GET /api/v2/assemblies/{id}`）已
// 返回该装配件的全部子件，本 hook 只从 `detail.children` 裁出表格与预览需要的 6 个字段。
// 后端该端点的角色闸门是 Manager / Clerk / Inspector / CncProgrammer，与 dashboard 行
// 点击的 `canOpenPartDetail` 一致 ⇒ 前端不必再判一次权限。
//
// ⚠️ **api 层 parse 的既有例外（不动它）**：`api/assembly.ts::getAssembly` 内部已经走
// `parseAssemblyDetail`（`assemblyDetailFlatSchema.strict`）做了一次 Zod 守门，与
// CLAUDE.md「api 层只发请求、queryFn 守门」的口径不符。该 mapper 修的是后端
// `#[serde(flatten)]` 平铺 → 前端嵌套契约的形态转换，且被 assemblies 域详情页与
// `useAssemblyDetail` 共用 —— 改它会外溢到 assemblies 域，不属本次范围。故本 hook 沿用
// 既有形态，只在自己这层再守一次裁剪后的最小结构（成本可忽略：子件数十行量级），
// 类型来源仍是 `assemblyChildRowSchema` 的 z.infer，不手写 interface 双轨。

import { useQuery, type QueryClient } from '@tanstack/vue-query';
import { computed, toValue, watch, type MaybeRefOrGetter } from 'vue';
import { ElMessage } from 'element-plus';
import { getAssembly } from '@/api/assembly';
import { qk } from '@/composables/queries/keys';
import { assemblyChildRowSchema, type AssemblyChildRowData } from './assemblyChildrenSchema';

/**
 * 2026-10-10 新增：装配件子件列表 query。
 *
 * 用法：
 *   ```ts
 *   const q = useAssemblyChildrenQuery(() => props.assemblyId);
 *   const children = computed(() => q.data.value ?? []);
 *   ```
 *
 * 参数：
 *   - assemblyId：MaybeRefOrGetter<string | null | undefined>，null/undefined/空串
 *     → enabled=false，queryFn 二次守卫返回空数组，零网络请求。
 *
 * 返回：{ query, children, isFetching, error } —— children 已剔掉未声明字段。
 * 不写 retry：信任 main.ts 全局 queries.retry: 0。
 */
export function useAssemblyChildrenQuery(assemblyId: MaybeRefOrGetter<string | null | undefined>) {
  const key = computed(() => qk.assemblyDetail(toValue(assemblyId) ?? ''));

  const query = useQuery<AssemblyChildRowData[], Error>({
    queryKey: key,
    queryFn: async ({ queryKey }) => {
      const id = queryKey[2];
      // enabled=false 已挡住 queryFn 调用，留二次守卫防显式 refetch 时拿空路径参数发请求。
      if (!id) return [];
      const detail = await getAssembly(String(id));
      return assemblyChildRowSchema.array().parse(
        (detail.children ?? []).map((c) => ({
          id: c.id,
          serial_no: c.serial_no,
          name: c.name,
          quantity: c.quantity,
          status: c.status,
          system_delivery_date: c.system_delivery_date,
        })),
      );
    },
    enabled: computed(() => !!toValue(assemblyId)),
    staleTime: 20 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
  });

  const children = computed<AssemblyChildRowData[]>(() => query.data.value ?? []);
  const isFetching = computed(() => query.isFetching.value);

  // 错误桥接：useQuery 的 error 不在 setup 抛错。
  watch(query.error, (e) => {
    if (e) ElMessage.error(e.message ?? '装配件子件加载失败');
  });

  return { query, children, isFetching, error: query.error };
}

/** 2026-10-10 新增：失效指定装配件的子件列表（写操作成功后由调用方调）。
 *  **当前无调用方**：装配件写操作在 assemblies 域自己的 composable 里走局部 fetch，
 *  那边要失效时改调本 helper（沿 usePartBatchesQuery 的同名 helper 形态预置）。 */
export function invalidateAssemblyDetailQuery(qc: QueryClient, id: string): Promise<void> {
  return qc.invalidateQueries({ queryKey: qk.assemblyDetail(id) }).then(() => undefined);
}

/** 2026-10-10 新增：失效整个 assembly 域（任意装配件 id 形态都命中）。
 *  **当前无调用方**：同上，与 invalidateAssemblyDetailQuery 成对预置。 */
export function invalidateAssemblyDetailAll(qc: QueryClient): Promise<void> {
  return qc.invalidateQueries({ queryKey: qk.assemblyPrefix }).then(() => undefined);
}
