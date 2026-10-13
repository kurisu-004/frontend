// useCustomerTree.ts
//
// 2026-09-26 改造：内部状态改为共享 query useCustomersQuery() 驱动，缓存命中即
// 直接复用（30s staleTime 去重窗口内切走再切回不重发请求；2026-09-30 起不再用
// POSITIVE_INFINITY 会话级缓存，见 CLAUDE.md「TanStack Query 缓存时长策略」）。
// 对外 API 完全兼容：3 个调用点（RepairReceive.vue / OutsourceQuoteList.vue /
// usePartsColumnFilters.ts）零改动即可工作。
//
// 注意：
//   - 2026-10-17（客户无限层级改造）：树形转换从「内联硬编码两层」改成调
//     `api/customer.tree` 的 `buildCustomerTree` / `rootCustomerIdOf`（任意深度 + 环 /
//     孤儿 / 重复 id 兜底），本文件不再持有拼树逻辑；旧的两层拼法在 3 层以上会把
//     节点整片丢掉。节点类型由宽松的 `CustomerCascaderNode`（`{id,name,children?}`
//     + 任意索引签名）收紧成 `CustomerTreeNode`（多 `parent_name` / `serial_prefix` /
//     `customer_path` / `root_id` / `depth`，children 恒为数组）；
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
import { buildCustomerTree, rootCustomerIdOf, type CustomerTreeNode } from '@/api/customer.tree';
import { useCustomersQuery } from './queries/useCustomersQuery';

/** 2026-09-21 显式返回类型。 */
export interface UseCustomerTreeReturn {
  customers: ComputedRef<Customer[]>;
  /** ElTreeSelect 的 data；节点形状见 `@/api/customer.tree` 的 `CustomerTreeNode`。 */
  tree: ComputedRef<CustomerTreeNode[]>;
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

  const tree = computed<CustomerTreeNode[]>(() => buildCustomerTree(customers.value));

  /** 选中任意层级节点 → 回溯到它的 L1 根 id（跨任意深度）。 */
  function resolveRootCustomerId(pickedId: string | null): string | null {
    return rootCustomerIdOf(customers.value, pickedId);
  }

  return { customers, tree, loading, resolveRootCustomerId };
}
