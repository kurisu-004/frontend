// src/views/printTemplates/composables/usePrintTemplateListQuery.ts
//
// 2026-10-16 新建：模板列表的 useQuery 段（无自有状态，入参全 reactive）。形态照
// `views/com/delivery/composables/useDeliveryNotesQuery.ts` 与
// `views/mail/accounts/composables/useMailAccountsQuery.ts`。
//
// 数据流：
//   1. 调用方（页面级 store `usePrintTemplatesStore`）持有筛选（当前选中的一级客户）与
//      enabled 闸门，把它们经 `buildParams()` 汇成 params 传进来；
//   2. 本 hook 只负责「params → queryKey → 请求 → 守门 → 数据」这一段，**不持有私有状态**；
//   3. queryFn 走 `printTemplateListResultSchema.parse(...)` 守门（Zod strip 陷阱：漏声明的
//      字段被静默丢弃，表格那一列整列失效且无人发现）。
//
// 设计要点：
//   - reactive params 范式：queryKey = computed(() => qk.printTemplatesList(toValue(params)))，
//     queryFn **从 queryKey[2] 读 params**（键是唯一真相源），不闭包捕获 stale 值。
//   - enabled 闸门由调用方控制：store 实例化时传 false、壳的 onMounted 末尾开闸，避免
//     「页面 setup 期就发请求」。
//   - placeholderData: keepPreviousData —— 切 L1 换的是 queryKey，不设它新键在响应到达前
//     data 为 undefined，整表清空一瞬。
//   - 缓存时长：页面级列表，不设 staleTime / gcTime，走 main.ts 全局默认。
//   - 不写 retry：信任 main.ts 全局 queries.retry: 0。
//   - ⚠️ **不设 `refetchInterval`**：模板是低频配置数据，没有任何「自己会变」的读数，写完由
//     store 失效；轮询只会让管理页每 5 分钟白打一趟。
//
// ⚠️ **该端点 MANAGER 独占**：本 hook 只被模板管理页消费，送货员打送货单走的是
// `api/printTemplates.ts::resolvePrintTemplate`（打印对话框里的一次性拉取，不进缓存）。

import { computed, toValue, watch, type MaybeRefOrGetter } from 'vue';
import { keepPreviousData, useQuery } from '@tanstack/vue-query';
import { ElMessage } from 'element-plus';
import { listPrintTemplates, type ListPrintTemplatesParams } from '@/api/printTemplates';
import { qk } from '@/composables/queries/keys';
import { printTemplateListResultSchema } from '../printTemplateSchema';

export interface PrintTemplateListQueryOptions {
  /** 请求参数（筛选汇成的那一份），直接进 queryKey。 */
  params: MaybeRefOrGetter<ListPrintTemplatesParams>;
  /** 闸门：false 时不发请求（store 在 `openGate()` 里开闸，避免双 fetch）。 */
  enabled: MaybeRefOrGetter<boolean>;
}

export function usePrintTemplateListQuery(options: PrintTemplateListQueryOptions) {
  const queryKey = computed(() => qk.printTemplatesList(toValue(options.params)));

  const query = useQuery({
    queryKey,
    queryFn: async ({ queryKey }) => {
      // params 从 queryKey 读（reactive params 范式），不闭包捕获 stale 值。
      const params = queryKey[2] as ListPrintTemplatesParams;
      return printTemplateListResultSchema.parse(await listPrintTemplates(params));
    },
    enabled: computed(() => toValue(options.enabled)),
    placeholderData: keepPreviousData,
  });

  /** fetchList 别名 = refetch 的 async 包装（视图「刷新」按钮 / 测试零改动驱动）。 */
  async function fetchList(): Promise<void> {
    await query.refetch();
  }

  // 错误桥接：useQuery 的 error 不在 setup 抛错（CLAUDE.md 硬约束）。
  watch(query.error, (e) => {
    if (e) ElMessage.error(e.message ?? '模板列表加载失败');
  });

  return {
    query,
    data: query.data,
    isFetching: query.isFetching,
    error: query.error,
    fetchList,
  };
}
