// 2026-09-26 新增：客户列表共享 query（list 域）。
//
// 设计要点：
//   - staleTime: 30_000 / gcTime: 5 * 60 * 1000 —— TanStack Query 在本仓定位是
//     「短时请求去重层」，**不承担数据新鲜度保证**（2026-09-30 起不再用
//     POSITIVE_INFINITY 会话级缓存，详见 CLAUDE.md「TanStack Query 缓存时长策略」）：
//     30s 内的重复访问（来回切页面 / 反复进详情）命中缓存不重发；超过 30s 视为
//     可能已过期，下次访问自动 refetch。gcTime 5min > staleTime —— 切走再切回
//     （≤5min）先渲染缓存再后台刷新，不闪 loading；空闲超 5min 才丢弃条目。
//   - 显式失效保留：CustomerList.vue 的 createCustomer / updateCustomer /
//     softDeleteCustomer 完成后仍调 invalidateCustomersQuery(qc) 失效整个
//     customers 域（2026-09-26 grep 确认 3 处调用点都在该文件）—— 但这是
//     「写完立即看到自己那笔」的优化，**不是**一致性保证：客户数据是低频基准数据，
//     30s 窗口本身足以兜住绝大多数改动。
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
    staleTime: 30_000,
    gcTime: 5 * 60 * 1000,
  });
}

/** 2026-09-26 新增：失效整个 customers 域（写操作完成后调）。
 *  包装 invalidateQueries 返回值让调用方拿到稳定的 Promise<void>。 */
export function invalidateCustomersQuery(qc: QueryClient): Promise<void> {
  return qc.invalidateQueries({ queryKey: qk.customersPrefix }).then(() => undefined);
}