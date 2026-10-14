// src/utils/naiveDateTime.ts
//
// 2026-10-21 新建：naive timestamp 字符串的**墙钟切片**，全仓唯一一份。消费方四个，分属三个域：
// 账号管理「最后登录」列（`views/users/usersColumnDefs.ts`）、交期汇总邮件「发送历史」表的
// 「时间」列（`views/mail/digest/components/MailLogTable.vue`）、企业微信每日总结的「发送历史」
// 表与「Webhook 配置」表的「更新时间」列（`views/wecom/daily/components/WeComLogTable.vue` +
// `views/wecom/webhooks/WeComWebhooksTab.vue`）。
//
// **为什么共用一份**：四处渲染的是同一种后端字段，格式必须逐字相同。一处 `2026-10-17 08:30:00`、
// 另一处 `2026-10-17 08:30`，用户没法一眼判断两处是不是同一次操作。
//
// ⚠️ **不能走 `utils/date.ts::formatDateTime`，两者不是一个东西**：那个函数 `new Date()` 后按
// UTC 输出，会把 Asia/Shanghai 的墙钟整体平移 8 小时（`2026-10-17 08:30` → `2026-10-17 00:30`）。
// 后端这些列下发的是**不带时区后缀**的 naive 字符串（`YYYY-MM-DD HH:MM:SS`），语义就是墙钟 ——
// 要显示什么就切什么，不要过一遍 Date。两者另有一处可见差异：空值本函数给 `-`、`formatDateTime`
// 给 `—`。**两条都别合并**。

/** naive timestamp 字符串 → `YYYY-MM-DD HH:MM`（把 `T` 换成空格、截掉秒及以下）。
 *
 *  短于 16 位的输入（缺分位、脏数据）原样返回，不补零也不抛 —— 这一列是排查线索不是校验闸门，
 *  宁可显示原值让用户看出来「后端这一格不太对」，也不要把它悄悄显示成一个编出来的时刻。 */
export function formatNaiveDateTime(raw: string | null | undefined): string {
  if (!raw) return '-';
  const normalized = raw.replace('T', ' ');
  return normalized.length >= 16 ? normalized.slice(0, 16) : normalized;
}
