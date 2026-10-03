// views/scan/composables/useScanPartsSort.ts
//
// 报工台三页（ScanPickParts / ScanReturnParts / ScanInspectParts）共用客户端排序。
// 引入「系统交期」硬优先级：含 system_delivery_date 的工件整体提到无
// system_delivery_date 的工件之前。
//
// 排序键（依次）：
//   1. is_urgent DESC                              — 保留原优先级
//   2. system_delivery_date IS NOT NULL DESC       — 硬优先级：有系统交期的排前面
//   3. 同组内：日期 ASC NULLS LAST                  — 有 system 用 system，没用 planned
//   4. id 字符串 DESC（雪花 ID 单调递增，字典序等价于数值序）— 稳定 tie-break
//
// ⚠️ 2026-10-04 现状登记：报工台这三页的数据源只有两个后端端点
// （`GET /parts/pickable-by-work-type/{work_type_id}` 与
// `GET /parts/by-worker/{worker_id}`），两个 service 构造行时把排序键 1 / 2 / 3
// 涉及的字段**全部写死或置空**：`is_urgent` 写死 false、`system_delivery_date` 恒 null、
// `planned_delivery_date` 写死占位符 `1970-01-01`（已在 `scanPartRowSchema` 的 transform
// 里归一成 null）。⇒ 键 1 / 2 / 3 在本数据上**不产生任何差异**，实际排序退化成键 4
// （id 字符串降序）。
//
// 保留这四个键而不是删到只剩 id：它们是本 composable 的通用契约（入参是
// `ScanSortablePart`，不限于报工台两个端点），后端一旦给这两个端点补上真实投影即自动
// 生效，无需改这里。但要知道：**在当前数据上它只等于按 id 降序**，看到「加急件排前面」
// 的效果不是本排序给的。

import { computed, toValue, type ComputedRef, type MaybeRefOrGetter } from 'vue';

/** 排序所需的最小字段契约。PartItem / PartListItem 等都满足。 */
export interface ScanSortablePart {
  id: string;
  is_urgent: boolean;
  planned_delivery_date: string | null;
  system_delivery_date: string | null;
}

export function useScanPartsSort<T extends ScanSortablePart>(
  parts: MaybeRefOrGetter<T[]>,
): ComputedRef<T[]> {
  return computed(() => {
    const list = toValue(parts);
    // 复制后排序，避免原地变更 ref 持有的数组触发循环响应
    return [...list].sort(compareScanParts);
  });
}

function compareScanParts<T extends ScanSortablePart>(a: T, b: T): number {
  // 1. is_urgent DESC
  const urgent = Number(!!b.is_urgent) - Number(!!a.is_urgent);
  if (urgent !== 0) return urgent;

  // 2. has system_delivery_date DESC（硬优先级）
  const aHasSys = a.system_delivery_date != null;
  const bHasSys = b.system_delivery_date != null;
  const sys = Number(bHasSys) - Number(aHasSys);
  if (sys !== 0) return sys;

  // 3. 同组内日期 ASC NULLS LAST（用 group 各自的日期字段）
  const ad = aHasSys ? a.system_delivery_date : a.planned_delivery_date;
  const bd = bHasSys ? b.system_delivery_date : b.planned_delivery_date;
  if (ad == null && bd == null) return idDesc(a.id, b.id);
  if (ad == null) return 1;
  if (bd == null) return -1;
  const diff = new Date(ad).getTime() - new Date(bd).getTime();
  if (diff !== 0) return diff;
  return idDesc(a.id, b.id);
}

/**
 * 雪花 ID 字符串降序。雪花 ID 单调递增，字符串字典序等价于数值序，
 * 用字符串比较可避免 `Number()` 转换时的精度丢失（Number.MAX_SAFE_INTEGER ≈ 9e15）。
 */
function idDesc(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? 1 : -1;
}
