// utils/date.ts
//
// 统一日期格式化入口（2026-08-25 frontend-overall-refactor 抽取）。
// 之前 NotificationBanner / ApplicantList / PartDetail / AssemblyDetail / PickupSkipTab
// 都各自实现了一个仅在 .slice(0,10)/.slice(0,19) 上略有差异的 formatDate/formatDateTime，
// 这里把签名 + 输出格式统一到 YYYY-MM-DD / YYYY-MM-DD HH:mm[:ss]。
//
// 注意：所有输出都是 **UTC**（toISOString），调用方如果需要本地时间需要自行 .toLocaleString()。
// 历史本地函数多数也只是 slice ISO 字符串（不转时区），所以对原行为基本是无感的，
// 唯一例外是后端发本地时间字符串（无 'Z' 后缀）的极少数场景——可对照 task-6 报告中的逐文件差异。

const DEFAULT_DATE = '—'

/** 把 ISO 字符串或 Date 安全地格式化为 YYYY-MM-DD；空值返回 '—'。 */
export function formatDate(input: string | Date | null | undefined): string {
  if (!input) return DEFAULT_DATE
  const d = input instanceof Date ? input : new Date(input)
  if (Number.isNaN(d.getTime())) return DEFAULT_DATE
  return d.toISOString().slice(0, 10)
}

/** 把 ISO 字符串或 Date 安全地格式化为 YYYY-MM-DD HH:mm[:ss]；空值返回 '—'。 */
export function formatDateTime(
  input: string | Date | null | undefined,
  opts: { withSeconds?: boolean } = {},
): string {
  if (!input) return DEFAULT_DATE
  const d = input instanceof Date ? input : new Date(input)
  if (Number.isNaN(d.getTime())) return DEFAULT_DATE
  const base = d.toISOString().slice(0, 16).replace('T', ' ')
  if (opts.withSeconds) return `${base}:${d.toISOString().slice(17, 19)}`
  return base
}
