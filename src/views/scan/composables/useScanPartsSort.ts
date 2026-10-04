// views/scan/composables/useScanPartsSort.ts
//
// 报工台三页（ScanPickParts / ScanReturnParts / ScanInspectParts）共用客户端排序。
// 引入「系统交期」硬优先级：含 system_delivery_date 的工件整体提到无
// system_delivery_date 的工件之前。
//
// 排序键（依次）：
//   1. is_urgent DESC                              — 加急件排最前
//   2. system_delivery_date IS NOT NULL DESC       — 无系统交期的整体排在有系统交期的后面
//   3. 同组内：日期 ASC NULLS LAST                  — 有 system 用 system，无 system
//                                                      按 planned 排（纯排序键，不上屏）
//   4. id 字符串 DESC（雪花 ID 单调递增，字典序等价于数值序）— 稳定 tie-break
//
// 入参是 `ScanSortablePart` 这个最小字段契约，不限于报工台的两个端点；四个键都按
// `ScanSortablePart` 上的字段判，字段为占位值时不产生差异（键 4 兜底）而不是报错。
//
// ⚠️ **客户端排序覆盖服务端顺序，且读的不是同一批值**。两个取行 SQL 各自带 ORDER BY，
// 但服务端排的列与本 composable 读的值对不上：
//   - `pickable-by-work-type`：`ORDER BY p.is_urgent DESC, p.planned_delivery_date ASC,
//     b.id ASC`。前两个键排的是 **DB 真实列**（`t_part` 的加急标记与计划交期），是有意义
//     的；而本 composable 的键 1 / 3 读的是**响应里的值** —— 后端补上真实投影后两者
//     才对得上，补上之前服务端排出来的那份顺序会被客户端**洗掉**，只剩键 4 生效。
//   - `by-worker`：`ORDER BY b.id DESC`，只有批次 id 一个键（**降序**），没有加急 / 交期键。
// 键 4 排的 `ScanSortablePart.id` 在报工台三页里是 `PartListItem.id` = **part id**
// （`p.id`），与服务端末位的 `b.id`（批次 id）既不是同一列、方向也不同。
// ⇒ 「新批次在前」是当前数据下的副产物，不是写下来的前端意图；且洗牌只发生在**已加载的
//   这一页内**（三页与徽章都是一次 `limit: 200`）。
// 要让服务端顺序说了算：删掉本 composable 的调用，再评估两个端点 SQL 的排序键是否已生效。

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
