// src/views/wecom/webhooks/composables/useWeComWebhooksQuery.ts
//
// 2026-10-17 新建：企业微信 webhook 通道域唯一一条读端点的 useQuery hook，形态照
// `views/mail/accounts/composables/useMailAccountsQuery.ts`（无自有状态、入参
// `MaybeRefOrGetter`、queryFn 里 Zod 守门、`watch(error) → ElMessage` 桥接、`fetchList` 是
// refetch 的 async 包装）。
//
// **常量键**（端点不接 Query extractor、一次性返全部，没有分页 / 筛选 / 维度可言）。
// 带 `enabled` 闸门，由 store 的 `openGate()` 在 onMounted 末尾开闸，避免「页面 setup 期就发
// 请求」。
//
// ⚠️ **`qk.wecomWebhooks()` 被两个 tab 共用**：「Webhook 配置」列表与「每日总结」的推送通道
//   选择器读的是同一条 key（后者从本文件 import 这个 hook，理由见
//   `views/wecom/daily/composables/useWeComDailyStore.ts` 的跨域复用注释）⇒ 同屏去重靠的
//   就是它，切 tab 不重新打列表。
//
// 不设 `refetchInterval`：本域是配置数据，没有任何「自己会变」的读数，写完由 store 失效。
// ⚠️ **也不设 `staleTime` / `gcTime`**，走 `main.ts` 的全局默认（`queries: { retry: 0,
//   refetchOnWindowFocus: false }`）—— 没有 staleTime ⇒ TanStack v5 默认 0 ⇒ 每次挂载都后台
//   重取；`gcTime` 是 v5 默认 5min。新鲜度靠「每次挂载重取 + 写后 invalidate + 显式刷新」，
//   不靠有限 staleTime。⚠️ **不写 `retry`**：信任全局 `queries.retry: 0`。

import { computed, toValue, watch, type MaybeRefOrGetter } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { ElMessage } from 'element-plus';
import { listWeComWebhooks } from '@/api/wecomWebhooks';
import { qk } from '@/composables/queries/keys';
import { weComWebhookListSchema } from '../weComWebhookSchema';
import { weComWebhookErrorText } from '../weComWebhookErrorText';

/** 本 hook 的闸门入参。 */
export interface WeComWebhooksQueryGate {
  /** 闸门：false 时不发请求（store 的 `openGate()` 在 onMounted 末尾开闸）。 */
  enabled: MaybeRefOrGetter<boolean>;
}

/**
 * 读 webhook 通道列表（`GET /cron/wecom/webhooks`）。
 *
 * ⚠️ 出参是**信封对象**（`{items: [...]}`），所以这里 parse 完**再取 `.items`**：直接把 parse
 * 结果当数组用（`data.value.map(...)`）会在守门通过后拿到一个对象，表现是「列表恒空 +
 * 控制台一条 `.map is not a function`」；反过来把 schema 写成 `z.array` 则是在**每一屏**抛
 * ZodError（症状同样是空白页，但连报错线索都没有）。两条守卫见 `__tests__/weComWebhookSchema
 * .spec.ts` 的「信封形状」一组与 `useWeComWebhooksQuery.spec.ts` 的 W3d。
 */
export function useWeComWebhooksQuery(options: WeComWebhooksQueryGate) {
  const query = useQuery({
    queryKey: computed(() => qk.wecomWebhooks()),
    queryFn: async () => weComWebhookListSchema.parse(await listWeComWebhooks()).items,
    enabled: computed(() => toValue(options.enabled)),
  });

  /** fetchList 别名 = refetch 的 async 包装（store 的「刷新」按钮）。
   *
   * ⚠️ `data` 是**已剥掉信封的数组**（不是 `{items:[]}`）：本 hook 的两个消费方（Webhook 配置
   * 列表页与每日总结的推送通道下拉）都只想要那一个数组，把信封留在 hook 内部就不会让每个
   * 消费方各写一次 `.items` —— 而漏一次的表现是「`.map is not a function`」。 */
  async function fetchList(): Promise<void> {
    await query.refetch();
  }

  // 错误桥接：不在 setup 抛错（CLAUDE.md 硬约束）。走本域文案收口：Zod 守门失败时
  // `e.message` 是 issues 的 JSON 数组，弹给管理员只是一坨噪音。
  watch(query.error, (e) => {
    if (e) ElMessage.error(weComWebhookErrorText(e, 'Webhook 列表加载失败'));
  });

  return { query, data: query.data, isFetching: query.isFetching, error: query.error, fetchList };
}
