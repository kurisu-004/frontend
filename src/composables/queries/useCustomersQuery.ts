// 2026-09-26 新增：客户列表共享 query（list 域）。
//
// 设计要点：
//   - 基础数据精确失效策略：staleTime: POSITIVE_INFINITY + gcTime: POSITIVE_INFINITY，
//     数据量 KB 级（10 个一级 + N 个二级），会话级缓存足够。写操作后调用方手动
//     invalidateCustomersQuery(qc) 失效整个 customers 域（createCustomer /
//     updateCustomer / softDeleteCustomer 全仓仅 CustomerList.vue 一处，2026-09-26
//     grep 确认：3 处调用点都在 src/views/customers/CustomerList.vue）。
//   - 不写 retry：信任 main.ts 全局 queries.retry: 0。
//   - 不写 refetchOnWindowFocus：信任 main.ts 全局 false。

import { useQuery, type QueryClient } from '@tanstack/vue-query';
import { listCustomers } from '@/api/customer';
import { customerListResultSchema, type CustomerListResultSchema } from './schemas';
import { qk } from './keys';

export function useCustomersQuery() {
  return useQuery<CustomerListResultSchema, Error>({
    queryKey: qk.customersList,
    queryFn: async () => customerListResultSchema.parse(await listCustomers()),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
  });
}

/** 2026-09-26 新增：失效整个 customers 域（写操作完成后调）。
 *  包装 invalidateQueries 返回值让调用方拿到稳定的 Promise<void>。 */
export function invalidateCustomersQuery(qc: QueryClient): Promise<void> {
  return qc.invalidateQueries({ queryKey: qk.customersPrefix }).then(() => undefined);
}