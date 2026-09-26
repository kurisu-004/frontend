// useCustomerTree.ts
//
// 2026-09-26 改造：内部状态改为共享 query useCustomersQuery() 驱动，缓存命中会话级。
// 对外 API 完全兼容：3 个调用点（RepairReceive.vue / OutsourceQuoteList.vue /
// usePartsColumnFilters.ts）零改动即可工作。
//
// 注意：
//   - 树形转换 + resolveRootCustomerId 逻辑原样保留（拆 L1 root + L2 children）；
//   - load() 保留为 query.refetch 的 async 包装，对外 API 兼容（虽然新设计下
//     useQuery 自动 fetch + 手动 invalidateCustomersQuery 才是常规路径）；
//   - customers 类型由 Ref<Customer[]> 收紧为 ComputedRef<Customer[]>（只读），
//     所有现存 consumer 只读不写，无破坏；其它返回字段类型不变；
//   - 错误 UX：useQuery 把失败暴露在 query.error，保留原 useCustomerTree 在 load
//     失败时弹 ElMessage 的行为——通过 watch 同步触发，避免静默失败。

import { computed, watch, type ComputedRef, type Ref } from 'vue';
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
  loading: Ref<boolean>;
  load: () => Promise<void>;
  resolveRootCustomerId: (pickedId: string | null) => string | null;
}

export function useCustomerTree(): UseCustomerTreeReturn {
  const query = useCustomersQuery();

  // 2026-09-26：useQuery 自动 fetch，无需 onMounted 手动 load。
  const customers = computed<Customer[]>(() => query.data.value?.items ?? []);
  const loading = computed<boolean>(() => query.isFetching.value);

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

  /** 2026-09-26：保留对外 API；底层走 query.refetch。
   *  写操作完成后失效域走 invalidateCustomersQuery(qc)，load() 主要给手动刷新留口。 */
  async function load(): Promise<void> {
    await query.refetch();
  }

  return { customers, tree, loading, load, resolveRootCustomerId };
}
