// src/views/wecom/daily/composables/useWeComDailyQuery.ts
//
// 2026-10-17 新建：每日总结域三条读端点的 useQuery hook，形态照
// `views/mail/digest/composables/useMailDigestQuery.ts`（无自有状态、入参
// `MaybeRefOrGetter`、queryFn 里 Zod 守门、`watch(error) → ElMessage` 桥接、`fetchXxx` 是
// refetch 的 async 包装）。
//
// 三条 hook 的差异与为什么这么切：
//   - `useWeComDailyConfigQuery`：**常量键**（端点返回全局单行配置，没有可变量进键）。它还多
//     承担一件页面态之外的事 —— 返回 `data` 供 store 做「服务端配置 → 表单态」的 hydrate，
//     **hydrate 逻辑在 store、不在这里**（hook 保持无状态）。
//   - `useWeComDailyMetaQuery`：**常量键**（频率选项 / 条形图指标选项 / 缺省值 / 三段取值
//     范围，后端不接受任何入参）。meta 到达后 store 用它覆盖表单校验的兜底判据 —— ⚠️ 三段
//     range 与三个 `needs_*` **前端一律不硬编码**，见 `weComDailySchema.ts` 的说明。
//   - `useWeComDailyLogsQuery`：**参数键**（端点接 limit / offset，翻页换键）。`params` 允许
//     `null` ⇒ 占位键 + `enabled` 闸门 + queryFn 二次守卫。这三层在本域是**防御性**的、没有
//     CLAUDE.md 里那两处 `⇒` 带的那种理由（报工台 / 统计域的过滤键后端必填、漏传是 400 纯
//     文本；本域 `ListWeComDailyLogsParams` 的 `limit?` / `offset?` 都可选，唯一调用方 store
//     的 `logsParams` 也恒返回对象）⇒ 这三层在生产上无触发点，**但它可测**（`params` 传
//     `null` 在测试里构造得出来），别当成死代码清掉，也别被误判成「不可测」而删掉 `??` / 闸门
//     时无人补断言。
//
// 三条都**不设** `refetchInterval` / `staleTime` / `gcTime`：本域不是看板，没有任何「自己会变
// 的读数」。⚠️ **跨进程 cron 推送不进前端** —— 每天准点发出去的那几条消息只落在后端的
// `t_wecom_daily_log`，前端没有任何推送通道能第一时间知道（日志页面**不**接 WS）。所以新鲜度
// 只能靠「每次挂载重取 + 写后失效 + 显式刷新」，这也正是**不设 staleTime** 的理由：TanStack
// v5 默认 staleTime = 0 ⇒ 每次进页面都后台重取，定时任务新落的那行当场就能看到；设一个有限
// staleTime 只会把「刚发完的那条流水」推迟到下次进页面才可见。
// ⚠️ `gcTime` 走全局默认（5min，有限值，禁 `POSITIVE_INFINITY` —— 那是 dashboard 域靠 WS
//   事件失效才成立的例外，本域零失效通道）。
// 不写 `retry`：信任 `main.ts` 全局 `queries.retry: 0`。

import { computed, toValue, watch, type MaybeRefOrGetter } from 'vue';
import { keepPreviousData, useQuery } from '@tanstack/vue-query';
import { ElMessage } from 'element-plus';
import {
  fetchWeComDailyConfig,
  fetchWeComDailyMeta,
  listWeComDailyLogs,
} from '@/api/wecomDaily';
import { qk } from '@/composables/queries/keys';
import type { ListWeComDailyLogsParams } from '@/types/wecom';
import {
  weComDailyConfigSchema,
  weComDailyLogListSchema,
  weComDailyMetaSchema,
} from '../weComDailySchema';
import { weComDailyErrorText } from '../weComDailyErrorText';

/** 两条常量键 hook 共用的闸门入参。 */
export interface WeComDailyQueryGate {
  /** 闸门：false 时不发请求（store 的 `openGate()` 在 onMounted 末尾开闸）。 */
  enabled: MaybeRefOrGetter<boolean>;
}

/** 读推送配置（`GET /cron/wecom-daily/config`）。 */
export function useWeComDailyConfigQuery(options: WeComDailyQueryGate) {
  const query = useQuery({
    queryKey: computed(() => qk.wecomDailyConfig()),
    queryFn: async () => weComDailyConfigSchema.parse(await fetchWeComDailyConfig()),
    enabled: computed(() => toValue(options.enabled)),
  });

  /** fetchConfig 别名 = refetch 的 async 包装（store 的 40901 重拉 / 「刷新」按钮）。 */
  async function fetchConfig(): Promise<void> {
    await query.refetch();
  }

  // 错误桥接：不在 setup 抛错（CLAUDE.md 硬约束）。走本域文案收口：Zod 守门失败时
  // `e.message` 是 issues 的 JSON 数组，弹给管理员只是一坨噪音。
  watch(query.error, (e) => {
    if (e) ElMessage.error(weComDailyErrorText(e, '每日总结配置加载失败'));
  });

  return { query, data: query.data, isFetching: query.isFetching, error: query.error, fetchConfig };
}

/** 读本域元数据（`GET /cron/wecom-daily/meta`）。 */
export function useWeComDailyMetaQuery(options: WeComDailyQueryGate) {
  const query = useQuery({
    queryKey: computed(() => qk.wecomDailyMeta()),
    queryFn: async () => weComDailyMetaSchema.parse(await fetchWeComDailyMeta()),
    enabled: computed(() => toValue(options.enabled)),
  });

  /** fetchMeta 别名 = refetch 的 async 包装。 */
  async function fetchMeta(): Promise<void> {
    await query.refetch();
  }

  watch(query.error, (e) => {
    if (e) ElMessage.error(weComDailyErrorText(e, '每日总结元数据加载失败'));
  });

  return { query, data: query.data, isFetching: query.isFetching, error: query.error, fetchMeta };
}

/** 发送流水分页（`GET /cron/wecom-daily/logs`）。 */
export function useWeComDailyLogsQuery(options: {
  params: MaybeRefOrGetter<ListWeComDailyLogsParams | null>;
  enabled: MaybeRefOrGetter<boolean>;
}) {
  const queryKey = computed(() =>
    qk.wecomDailyLogs(toValue(options.params) ?? { limit: 20, offset: 0 }),
  );

  const query = useQuery({
    queryKey,
    queryFn: async ({ queryKey }) => {
      // params 从 queryKey 读（reactive params 范式），不闭包捕获 stale 值。
      const params = queryKey[2] as ListWeComDailyLogsParams | undefined;
      if (!params) throw new Error('缺少流水分页参数');
      return weComDailyLogListSchema.parse(await listWeComDailyLogs(params));
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
    if (e) ElMessage.error(weComDailyErrorText(e, '发送历史加载失败'));
  });

  return { query, data: query.data, isFetching: query.isFetching, error: query.error, fetchLogs };
}
