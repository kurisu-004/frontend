// src/views/mail/accounts/composables/useMailAccountsQuery.ts
//
// 2026-10-16 新建：邮箱账号域两条读端点的 useQuery hook，形态照
// `views/mail/digest/composables/useMailDigestQuery.ts`（无自有状态、入参
// `MaybeRefOrGetter`、queryFn 里 Zod 守门、`watch(error) → ElMessage` 桥接、
// `fetchXxx` 是 refetch 的 async 包装）。
//
// 两条 hook 都是**常量键**（端点不接 Query extractor）：
//   - `useMailAccountsQuery` —— GET /mail/accounts，列表页 + 交期汇总页那个邮箱选择器
//     **共用这一条**（同屏去重靠的就是它；切 tab 不重新打）。带 `enabled` 闸门，由 store
//     的 `openGate()` 在 onMounted 末尾开闸，避免「页面 setup 期就发请求」。
//   - `useMailMetaQuery` —— GET /mail/meta，SMTP 预设选项（label / host / port / tls_mode）。
//     **前端不存这份映射**，弹窗里那条只读的 `host:port:tls_mode` 描述行全从这里取。
//
// 两条都**不**设 `refetchInterval`：本域是配置数据，没有任何「自己会变」的读数，写完由
// store 失效。不写 `retry`：信任 `main.ts` 全局 `queries.retry: 0`。

import { computed, toValue, watch, type MaybeRefOrGetter } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { ElMessage } from 'element-plus';
import { fetchMailMeta, listMailAccounts } from '@/api/mailAccounts';
import { qk } from '@/composables/queries/keys';
import { mailAccountListSchema, mailMetaSchema } from '../mailAccountSchema';
import { mailAccountErrorText } from '../mailAccountErrorText';

/** 两条 hook 共用的闸门入参。 */
export interface MailAccountsQueryGate {
  /** 闸门：false 时不发请求（store 的 `openGate()` 在 onMounted 末尾开闸）。 */
  enabled: MaybeRefOrGetter<boolean>;
}

/** 读邮箱账号列表（`GET /mail/accounts`）。 */
export function useMailAccountsQuery(options: MailAccountsQueryGate) {
  const query = useQuery({
    queryKey: computed(() => qk.mailAccounts()),
    queryFn: async () => mailAccountListSchema.parse(await listMailAccounts()),
    enabled: computed(() => toValue(options.enabled)),
  });

  /** fetchList 别名 = refetch 的 async 包装（store 的「刷新」按钮）。 */
  async function fetchList(): Promise<void> {
    await query.refetch();
  }

  // 错误桥接：不在 setup 抛错（CLAUDE.md 硬约束）。走本域文案收口：Zod 守门失败时
  // `e.message` 是 issues 的 JSON 数组，弹给管理员只是一坨噪音。
  watch(query.error, (e) => {
    if (e) ElMessage.error(mailAccountErrorText(e, '邮箱列表加载失败'));
  });

  return { query, data: query.data, isFetching: query.isFetching, error: query.error, fetchList };
}

/** 读 SMTP 预设选项（`GET /mail/meta`）。 */
export function useMailMetaQuery(options: MailAccountsQueryGate) {
  const query = useQuery({
    queryKey: computed(() => qk.mailMeta()),
    queryFn: async () => mailMetaSchema.parse(await fetchMailMeta()),
    enabled: computed(() => toValue(options.enabled)),
    // ⚠️ 这条**显式**设 `staleTime` / `gcTime`，与同页 `useMailDigestQuery.ts` 的「一个都
    // 不设」**刻意不同**：meta 是**准静态**的共享基础数据（两家服务商常量），而 digest 的
    // 三条读端点是「每次挂载重取」口径（配置会被人改、cron 会写日志）。拿同一条判据套在
    // 两者上会让 meta 在切 tab 时被无谓重打。`gcTime` 用**有限值**（5min，禁
    // `POSITIVE_INFINITY`）—— 那是为 dashboard 域「靠 WS 事件失效」准备的例外，本域没有
    // 失效通道，设无限会让「切走 5 分钟回来」命中陈旧预设。
    staleTime: 30_000,
    gcTime: 5 * 60 * 1000,
  });

  /** fetchMeta 别名 = refetch 的 async 包装。 */
  async function fetchMeta(): Promise<void> {
    await query.refetch();
  }

  watch(query.error, (e) => {
    if (e) ElMessage.error(mailAccountErrorText(e, '邮箱预设元数据加载失败'));
  });

  return { query, data: query.data, isFetching: query.isFetching, error: query.error, fetchMeta };
}
