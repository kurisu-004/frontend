// src/views/wecom/utils/naiveDateTime.ts
//
// 2026-10-17 新建：企业微信域两个列表共用的 **naive timestamp 切片**（`WeComLogTable.vue` 的
// 「时间」列 + `WeComWebhooksTab.vue` 的「更新时间」列）。
//
// **为什么必须共用一份**：日志表在「每日总结」tab、Webhook 表在「Webhook 配置」tab —— 是
// `WeComCenter` 的**两个 tab**（任一时刻只可见其一，不是同一页并排的两张表），两者渲染的却是同一种
// 后端字段。切 tab 时时间格式跟着跳变就是纯粹的割裂感：一处 `2026-10-17 08:30:00`、另一处
// `2026-10-17 08:30`，用户没法一眼判断两处是不是同一次操作。
//
// **为什么放域内 `utils/` 而不是 `src/utils/`**：`src/utils/` 的准入门槛是「零个域内依赖 +
// 多域复用」（CLAUDE.md「目录归位」）。邮件域的 `MailLogTable.vue` 有一份**逐字相同**的切片，
// 但把它提到 `src/utils/` 之前得先回答「它到底该按 naive 还是按本地时区渲染」—— 那不是
// 「一个通用工具」，是两个域各自的展示契约。将来两个域的口径真的收敛了，再一起上提。
//
// ⚠️ **不能走 `src/utils/date.ts::formatDateTime`**：那个函数 `new Date()` 后按 UTC 输出，会把
// Asia/Shanghai 的墙钟整体平移 8 小时（`2026-10-17 08:30` → `2026-10-17 00:30`）。后端这些列
// 下发的是**不带时区后缀**的 naive 字符串（`YYYY-MM-DD HH:MM:SS`），语义就是墙钟 ——
// 要显示什么就切什么，不要过一遍 Date。

/** naive timestamp 字符串 → `YYYY-MM-DD HH:MM`（把 `T` 换成空格、截掉秒及以下）。
 *
 *  短于 16 位的输入（缺分位、脏数据）原样返回，不补零也不抛 —— 这一列是排查线索不是校验闸门，
 *  宁可显示原值让用户看出来「后端这一格不太对」，也不要把它悄悄显示成一个编出来的时刻。 */
export function formatNaiveDateTime(raw: string | null | undefined): string {
  if (!raw) return '-';
  const normalized = raw.replace('T', ' ');
  return normalized.length >= 16 ? normalized.slice(0, 16) : normalized;
}
