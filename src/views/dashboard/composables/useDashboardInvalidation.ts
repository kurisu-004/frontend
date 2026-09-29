// 2026-09-29 新增：dashboard 域 WS 事件 → invalidate 共享 composable。
//
// 重构动机（与方案 §「WS 失效联动」对齐）：
//   原 useDashboardSnapshot.ts:38-108 的 AFFECTS_DASHBOARD 事件集 + debounce 500ms +
//   maxWait 1500ms + qc.invalidateQueries 逻辑被本 composable 抽出。原文件实现只
//   失效 qk.dashboardSnapshot 一个 key；dashboard 重做后新增 useDashboardUrgentList
//   / useDashboardOverdue 两个 useQuery 同样需要同套 AFFECTS_DASHBOARD 失效联动，
//   通过 useDashboardInvalidation 复用同一份事件订阅 + 防抖闭包，避免双订阅
//   handler 各自跑 debounce、合并失效成本翻倍。
//
// 设计要点（沿 2026-09-26 TanStack Query 共享基础数据层约定 #5/#6 + 原
// useDashboardSnapshot 实现）：
//   - AFFECTS_DASHBOARD 集合维护 dashboard 域「需要重取数据」的事件白名单；
//     DELIVERY_NOTE_* 6 个事件不进集合（dashboard 重做后仅显示紧急工单 / 7 天
//     分桶 / 工厂实时态三类切片，送货单写入不影响这些视图）。
//   - useDebounceFn 500ms 防扫码雪崩；maxWait 1500ms 保证长间隔下也能 flush，
//     避免用户连续操作多轮时第一轮事件迟迟不重取（与 useDashboardSnapshot 原
//     实现行为完全等价）。
//   - 接收单个 queryKey 或 queryKey 数组，统一在 debouncedInvalidate 内遍历
//     qc.invalidateQueries；支持多 key（dashboardUrgentList + dashboardSnapshot）
//     与单 key（dashboardOverdue 仅 Manager 启用，但 invalidate 仍走同一套）。
//   - tryOnScopeDispose 捕获 off 函数（onDashboardEvent 返回），组件卸载时
//     释放 eventSubs 订阅，避免「多次 mount / unmount 累加永不清理的 handler」
//     （沿 2026-09-28 review N1 regression guard）。

import { tryOnScopeDispose, useDebounceFn } from '@vueuse/core';
import { useQueryClient, type QueryKey } from '@tanstack/vue-query';
import { onDashboardEvent } from '@/api/dashboard';
import type { DashboardEventType } from '@/types/dashboard';

/** 2026-09-29 新增：影响 dashboard 域数据的 WS 事件集合。
 *
 * 沿用 useDashboardSnapshot.ts 原 22 个事件（AFFECTS_DASHBOARD）全集。
 * dashboard 重做后三类核心切片（紧急工单 / 7 天分桶 / 工厂实时态）的写入事件
 * 都收敛到这个白名单：零件状态翻转 / 批次事件 / 扫码事件 / 批量创建 / worker
 * pool 状态 / 装配体事件。
 *
 * DELIVERY_NOTE_*（送货单写入）不进集合 —— dashboard 视图不展示送货单，送货单
 * 写完后只让「送货单列表页」自己失效即可，与 dashboard 域解耦。 */
const AFFECTS_DASHBOARD: ReadonlySet<DashboardEventType> = new Set<DashboardEventType>([
  // 零件状态翻转（pull/process step / batch 流）
  'PART_TO_SHIP',
  'PART_TO_INSPECTION',
  'PART_TO_PROCESS',
  'BATCH_TO_SHIP',
  'BATCH_TO_INSPECTION',
  // 零件生命周期事件
  'PART_SOFT_DELETED',
  'PART_DELIVERED',
  // 批次事件
  'PART_BATCH_SPLIT',
  'PART_BATCH_CANCELLED',
  // 扫码事件
  'PART_SCAN_INSPECT_PASSED',
  'PART_SCAN_INSPECT_FAILED',
  // 批量创建
  'PART_BATCH_WITH_PDFS_CREATED',
  // B 方案手动 pick-up
  'PART_PICKED_UP',
  // worker-scan 双向流
  'WORKER_SCAN_RETURNED',
  'WORKER_SCAN_INSPECTED',
  // worker pool 状态
  'WORKER_POOL_REFILL_DONE',
  'WORKER_POOL_EMPTY',
  'WORKER_POOL_ADMIN_REMOVED',
  'WORKER_POOL_AUTO_ALLOCATE_DONE',
  // 装配体（dashboard 视图会展示装配体状态）
  'ASSEMBLY_CREATED',
  'ASSEMBLY_DELETED',
  'ASSEMBLY_CANCELLED',
  'ASSEMBLY_UPDATED',
]);

/** 2026-09-29 新增：dashboard 域失效事件数量（与 useDashboardInvalidation.spec.ts
 *  的 T1 用例对齐；保持单一来源） */
export const AFFECTS_DASHBOARD_SIZE = AFFECTS_DASHBOARD.size;

/** 2026-09-29 新增：dashboard 域 WS 事件 → invalidate 共享 composable。
 *
 * 用法：组件 setup 顶层调用一次即可，把需要失效的 queryKey / queryKey[] 传进来。
 * 多个 useQuery 共享同一份 AFFECTS_DASHBOARD 集合 + debounce 闭包（避免 handler
 * 各跑各的 500ms 防抖、合并成本翻倍）。
 *
 * 参数：
 *   - keys：单个 QueryKey（readonly tuple）或数组（多 key 同时失效）。
 *
 * 返回：useQueryClient 实例（方便 caller 顺手做其他 invalidate 操作）。 */
export function useDashboardInvalidation(
  keys: QueryKey | readonly QueryKey[],
): ReturnType<typeof useQueryClient> {
  const qc = useQueryClient();

  // 归一化 keys 为 QueryKey[] 形式：QueryKey 是 readonly unknown[]；
  // 形态判定：keys[0] 是数组 → 整体为 QueryKey[]（多 key），否则为单 QueryKey。
  // 例：
  //   ['dashboard','snapshot']            → keys[0]='dashboard' (string) → 单 key
  //   [['dashboard','snapshot'], [...]]   → keys[0]=['dashboard','snapshot'] (array) → 多 key
  const keyList: readonly QueryKey[] = Array.isArray(keys[0])
    ? (keys as readonly QueryKey[])
    : [keys as QueryKey];

  // WS 事件 → debounce 500ms → invalidate（防扫码雪崩：单次扫码可能连续触发
  // PART_SCAN_INSPECT_PASSED + WORKER_POOL_REFILL_DONE + WORKER_SCAN_INSPECTED
  // 三个事件，500ms 内合并为 1 次 invalidate 重取）。
  const debouncedInvalidate = useDebounceFn(
    () => {
      for (const k of keyList) {
        void qc.invalidateQueries({ queryKey: k });
      }
    },
    500,
    // maxWait 1500ms：连续扫码场景下超过 1500ms 必须强制 flush 一次，避免
    // 用户看完一轮再切第二轮时第一轮事件还没重取到数据。
    { maxWait: 1500 },
  );

  // 2026-09-28 review N1 regression：捕获 off + tryOnScopeDispose，确保组件卸载时
  // 订阅从 eventSubs Set 移除（否则每次进入 /dashboard 都累加一个永不清理的
  // handler，闭包持有的 debouncedInvalidate / qc 无法 GC）。
  const offDashboardEvent = onDashboardEvent((ev) => {
    if (AFFECTS_DASHBOARD.has(ev.event_type)) debouncedInvalidate();
  });
  tryOnScopeDispose(offDashboardEvent);

  return qc;
}
