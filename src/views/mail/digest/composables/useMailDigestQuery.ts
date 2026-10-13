// src/views/mail/digest/composables/useMailDigestQuery.ts
//
// 2026-10-13 新建：交期汇总邮件页三条读端点的 useQuery hook，形态照
// `views/users/composables/useUsersQuery.ts`（无自有状态、入参 `MaybeRefOrGetter`、
// queryFn 里 Zod 守门、`watch(error) → ElMessage` 桥接、`fetchXxx` 是 refetch 的 async
// 包装）。
//
// 三条 hook 的差异与为什么这么切：
//   - `useMailDigestConfigQuery`：**常量键**（端点返回全局单行配置，没有可变量进键）。
//     它还多承担一件页面态之外的事 —— 返回 `data` 供 store 做「服务端配置 → 表单态」的
//     hydrate，**hydrate 逻辑在 store、不在这里**（hook 保持无状态）。
//   - `useMailDigestMetaQuery`：**常量键**（频率选项 / 列候选 / 默认值 / 天数范围 /
//     SMTP 状态，后端不接受任何入参）。meta 到达后 store 用它覆盖表单校验的兜底判据。
//   - `useMailDigestLogsQuery`：**参数键**（端点接 limit / offset，翻页换键）。
//     `params` 允许 `null` ⇒ 占位键 + `enabled` 闸门 + queryFn 二次守卫。这三层在本域是
//     **防御性**的、没有 CLAUDE.md 里那两处 `⇒` 带的那种理由（报工台 / 统计域的过滤键后端
//     必填、漏传是 400 纯文本；本域 `ListMailDigestLogsParams` 的 `limit?` / `offset?` 都
//     可选，唯一调用方 store 的 `logsParams` 也恒返回对象）⇒ 这三层在生产上无触发点，**但
//     它可测**（`params` 传 `null` 在测试里构造得出来），别当成死代码清掉，也别被误判成
//     「不可测」而删掉 `??` / 闸门时无人补断言。
//
// 三条都不设 `refetchInterval`：本域不是看板，没有任何「自己会变的读数」——配置与 meta
// 只在有人写时变（日志例外，但那由后端 cron 触发，见 keys.ts 的说明，靠页面自带的
// 「刷新」按钮与写后失效）。
// ⚠️ **也不设 `staleTime` / `gcTime`**，走 `main.ts` 的全局默认（`queries: { retry: 0,
// refetchOnWindowFocus: false }`）—— 没有 staleTime ⇒ TanStack v5 默认 0 ⇒ 每次挂载都
// 后台重取；`gcTime` 是 v5 默认 5min。「staleTime 30s / gcTime 5min，与仓内其它域一致」
// 那句是错的（本域一个都没设；同 `views/com/delivery/composables/useDeliveryDriversQuery.ts`）。
// 新鲜度靠「每次挂载重取 + 写后 invalidate + 显式刷新」，不靠有限 staleTime。
// 不写 `retry`：信任 `main.ts` 全局 `queries.retry: 0`。

import { computed, toValue, watch, type MaybeRefOrGetter } from 'vue';
import { keepPreviousData, useQuery } from '@tanstack/vue-query';
import { ElMessage } from 'element-plus';
import { fetchMailDigestConfig, fetchMailDigestMeta, listMailDigestLogs } from '@/api/mailDigest';
import { qk } from '@/composables/queries/keys';
import type { ListMailDigestLogsParams } from '@/types/mailDigest';
import {
  mailDigestConfigSchema,
  mailDigestLogListSchema,
  mailDigestMetaSchema,
} from '../mailDigestSchema';
import { mailDigestErrorText } from '../mailDigestErrorText';

/** 三条 hook 共用的闸门入参。 */
export interface MailDigestQueryGate {
  /** 闸门：false 时不发请求（store 的 `openGate()` 在 onMounted 末尾开闸，
   *  避免「页面 setup 期就发请求、组件还没挂载」的抢跑）。 */
  enabled: MaybeRefOrGetter<boolean>;
}

/** 读定时配置（`GET /mail-digest/config`）。 */
export function useMailDigestConfigQuery(options: MailDigestQueryGate) {
  const query = useQuery({
    queryKey: computed(() => qk.mailDigestConfig()),
    queryFn: async () => mailDigestConfigSchema.parse(await fetchMailDigestConfig()),
    enabled: computed(() => toValue(options.enabled)),
  });

  /** fetchConfig 别名 = refetch 的 async 包装（store 的 40901 重拉 / 「刷新」按钮）。 */
  async function fetchConfig(): Promise<void> {
    await query.refetch();
  }

  // 错误桥接：不在 setup 抛错（CLAUDE.md 硬约束）。走本域文案收口：Zod 守门失败时
  // `e.message` 是 issues 的 JSON 数组，弹给管理员只是一坨噪音。
  watch(query.error, (e) => {
    if (e) ElMessage.error(mailDigestErrorText(e, '定时配置加载失败'));
  });

  return { query, data: query.data, isFetching: query.isFetching, error: query.error, fetchConfig };
}

/** 读本域元数据（`GET /mail-digest/meta`）。 */
export function useMailDigestMetaQuery(options: MailDigestQueryGate) {
  const query = useQuery({
    queryKey: computed(() => qk.mailDigestMeta()),
    queryFn: async () => mailDigestMetaSchema.parse(await fetchMailDigestMeta()),
    enabled: computed(() => toValue(options.enabled)),
  });

  /** fetchMeta 别名 = refetch 的 async 包装。 */
  async function fetchMeta(): Promise<void> {
    await query.refetch();
  }

  watch(query.error, (e) => {
    if (e) ElMessage.error(mailDigestErrorText(e, '邮件配置元数据加载失败'));
  });

  return { query, data: query.data, isFetching: query.isFetching, error: query.error, fetchMeta };
}

/** 发送日志分页（`GET /mail-digest/logs`）。 */
export function useMailDigestLogsQuery(options: {
  params: MaybeRefOrGetter<ListMailDigestLogsParams | null>;
  enabled: MaybeRefOrGetter<boolean>;
}) {
  const queryKey = computed(() =>
    qk.mailDigestLogs(toValue(options.params) ?? { limit: 20, offset: 0 }),
  );

  const query = useQuery({
    queryKey,
    queryFn: async ({ queryKey }) => {
      // params 从 queryKey 读（reactive params 范式），不闭包捕获 stale 值。
      const params = queryKey[2] as ListMailDigestLogsParams;
      if (!params) throw new Error('缺少日志分页参数');
      return mailDigestLogListSchema.parse(await listMailDigestLogs(params));
    },
    enabled: computed(() => toValue(options.enabled) && !!toValue(options.params)),
    // 翻页换的是 queryKey ⇒ 不设它的话新键在响应到达前 data 为 undefined，整表清空。
    placeholderData: keepPreviousData,
  });

  /** fetchLogs 别名 = refetch 的 async 包装。 */
  async function fetchLogs(): Promise<void> {
    await query.refetch();
  }

  watch(query.error, (e) => {
    if (e) ElMessage.error(mailDigestErrorText(e, '发送历史加载失败'));
  });

  return { query, data: query.data, isFetching: query.isFetching, error: query.error, fetchLogs };
}
