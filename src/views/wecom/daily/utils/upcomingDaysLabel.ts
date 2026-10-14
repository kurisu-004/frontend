// src/views/wecom/daily/utils/upcomingDaysLabel.ts
//
// 2026-10-17 新建：「N 日内交期」这一列的**表头**文案。唯一消费方是
// `components/WeComLogTable.vue`，值由壳从 `store.query.form.upcoming_days` 传进来。
//
// 为什么要单独一个文件：这段逻辑带一条**契约**（非数字一律回落到后端默认的 3），把它内联在
// 组件里就成了「只有渲染时才会被发现」的一行三元表达式；而表头说谎恰好是那种「typecheck 与
// lint 全绿、截图上才看得见」的缺陷，值得一条独立断言守着。

/** 后端 `ConfigDefaultsOut::upcoming_days` 的默认值（与 `WEBCOM_DAILY_DEFAULTS` 同源）。
 *  只在**拿不到有效天数**时用作回落 —— 不是「前端认定的默认配置」。 */
export const WECOM_DAILY_DEFAULT_UPCOMING_DAYS = 3;

/** `「N 日内」` 表头。
 *
 *  ⚠️ **非数字一律回落到 3**：`el-input-number` 被清空时给的是 `undefined`，wire 上也可能拿到
 *  空串或脏值。表头宁可给一个合法值，也不能渲染出一个「日内」而前面没有数字的空标签。
 *  字符串数字（`'7'`）**照样采用** —— 输入组件与 v-model 之间的类型边界不该让表头说谎。 */
export function upcomingDaysLabel(days: number | string | null | undefined): string {
  const n = typeof days === 'string' ? Number(days.trim()) : days;
  return `${typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : WECOM_DAILY_DEFAULT_UPCOMING_DAYS}日内`;
}
