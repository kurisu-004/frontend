// useCustomerTree.ts
//
// 2026-09-26 改造：内部状态改为共享 query useCustomersQuery() 驱动，缓存命中会话级。
// 对外 API 完全兼容：3 个调用点（RepairReceive.vue / OutsourceQuoteList.vue /
// usePartsColumnFilters.ts）零改动即可工作。
//
// 注意：
//   - 树形转换 + resolveRootCustomerId 逻辑原样保留（拆 L1 root + L2 children）；
//   - 2026-09-26 二改：删除 dead API `load()`（grep 确认零 caller；写操作刷新走
//     invalidateCustomersQuery，常规读取走 useQuery 自动 fetch），对齐同仓
//     usePartDispatch 暴露 `processesLoading: processQuery.isFetching` 的形态，
//     loading 直接暴露 query.isFetching（Readonly<Ref<boolean>>），不再二次包 computed；
//   - customers 类型由 Ref<Customer[]> 收紧为 ComputedRef<Customer[]>（只读），
//     所有现存 consumer 只读不写，无破坏；其它返回字段类型不变；
//   - 错误 UX：useQuery 把失败暴露在 query.error，保留原 useCustomerTree 在
//     加载失败时弹 ElMessage 的行为——通过 watch 同步触发，避免静默失败。

import { computed, watch, type ComputedRef } from 'vue';
import { ElMessage } from 'element-plus';
import type { Customer } from '@/api/customer';
import { useCustomersQuery } from './queries/useCustomersQuery';

export interface CustomerCascaderNode {
  id: string;
  name: string;
  children?: CustomerCascaderNode[];
  [key: string]: unknown;
}

/** 2026-09-21 显式返回类型。 */
export interface UseCustomerTreeReturn {
  customers: ComputedRef<Customer[]>;
  tree: ComputedRef<CustomerCascaderNode[]>;
  loading: ReturnType<typeof useCustomersQuery>['isFetching'];
  resolveRootCustomerId: (pickedId: string | null) => string | null;
}

export function useCustomerTree(): UseCustomerTreeReturn {
  const query = useCustomersQuery();

  // 2026-09-26：useQuery 自动 fetch，无需 onMounted 手动 load。
  const customers = computed<Customer[]>(() => query.data.value?.items ?? []);

  // 2026-09-26 二改：loading 直接暴露 query.isFetching（Readonly<Ref<boolean>>），
  // 对齐同仓 usePartDispatch 暴露 `processesLoading: processQuery.isFetching` 形态。
  const loading = query.isFetching;

  // 2026-09-26：保留原 ElMessage 错误提示行为。useQuery 不在 setup 抛错，错误态
  // 在 query.error 暴露，watch 一次触发 → 与旧 load() catch 路径等价。
  watch(
    () => query.error.value,
    (err) => {
      if (err) ElMessage.error(err.message ?? '客户列表加载失败');
    },
  );

  const tree = computed<CustomerCascaderNode[]>(() => {
    const all = customers.value;
    const roots = all.filter((c) => c.parent_id === null);
    return roots.map((r) => ({
      id: r.id,
      name: r.name,
      children: all.filter((c) => c.parent_id === r.id).map((c) => ({ id: c.id, name: c.name })),
    }));
  });

  /** Resolve picked cascader node id back to its root customer id (L1 group)。 */
  function resolveRootCustomerId(pickedId: string | null): string | null {
    if (!pickedId) return null;
    const found = customers.value.find((c) => c.id === pickedId);
    if (!found) return null;
    return found.parent_id ?? found.id;
  }

  return { customers, tree, loading, resolveRootCustomerId };
}
