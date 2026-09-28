// 2026-09-28 新增：dashboard 域大屏快照共享 useQuery。
//
// 数据流（与 frontend/CLAUDE.md 2026-09-28 新增的「dashboard 域 HTTP 全量 +
// WS 事件 invalidate」架构对齐）：
//   1. setup 顶层 useQuery 拉一次 GET /api/v2/dashboard/snapshot 全量数据，
//      queryFn 走 dashboardSnapshotSchema.parse(...) 守门；
//   2. 业务事件通过 onDashboardEvent() 回调 → AFFECTS_DASHBOARD 集合过滤 →
//      useDebounceFn 500ms 防扫码雪崩 → qc.invalidateQueries 触发重取；
//   3. error 走 watch + ElMessage.error 桥接（沿 2026-09-26 约定 #9）。
//
// AFFECTS_DASHBOARD 事件集说明（2026-09-28 决策）：
//   dashboard 大屏渲染 3 个切片（生产区货架 / 检验区货架 / 在制工人）——
//   DELIVERY_NOTE_* 6 个事件不影响大屏任何切片（前者在 dashboard 是只读大屏，
//   送货单写入是大屏外的独立流），过滤掉避免不必要 invalidate。
//   ASSEMBLY_* 4 个事件进 AFFECTS_DASHBOARD（前端 dashboard 视图会展示装配体
//   状态，参考 2026-08-25 NotificationBanner 接入 ASSEMBLY_* 经验）。
//
// 设计要点：
//   - staleTime / gcTime: POSITIVE_INFINITY：会话级缓存，不再主动失效；失效责任
//     完全在 WS 事件侧（每个事件命中 AFFECTS_DASHBOARD 即 invalidate）；
//   - 不写 retry：信任 main.ts 全局 queries.retry: 0；
//   - 单域 composable 下沉到 views/dashboard/composables/（沿 2026-09-27
//     composable 归属判别约定），spec 文件同 __tests__/ 子目录。

import { tryOnScopeDispose, useDebounceFn } from '@vueuse/core';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { watch } from 'vue';
import { ElMessage } from 'element-plus';
import { onDashboardEvent } from '@/api/dashboard';
import { fetchDashboardSnapshot } from '@/api/dashboard';
import type { DashboardEventType } from '@/types/dashboard';
import { qk } from '@/composables/queries/keys';
import { dashboardSnapshotSchema } from './dashboardSnapshotSchema';

/** 2026-09-28 新增：影响 dashboard 大屏数据的 WS 事件集。
 *  排除 DELIVERY_NOTE_* 等不影响大屏 3 切片（生产区 / 检验区 / 在制）的写入事件，
 *  避免不必要 invalidate 触发额外 HTTP 全量拉取（400-500KB 响应）。 */
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

export function useDashboardSnapshot() {
  const qc = useQueryClient();

  const query = useQuery({
    queryKey: qk.dashboardSnapshot,
    queryFn: async () => dashboardSnapshotSchema.parse(await fetchDashboardSnapshot()),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
  });

  // WS 事件 → debounce 500ms → invalidate（防扫码雪崩：单次扫码可能连续触发
  // PART_SCAN_INSPECT_PASSED + WORKER_POOL_REFILL_DONE + WORKER_SCAN_INSPECTED
  // 三个事件，500ms 内合并为 1 次 invalidate 重取）。
  const debouncedInvalidate = useDebounceFn(
    () => {
      void qc.invalidateQueries({ queryKey: qk.dashboardSnapshot });
    },
    500,
    // maxWait 1500ms：连续扫码场景下超过 1500ms 必须强制 flush 一次，避免
    // 用户看完一轮再切第二轮时第一轮事件还没重取到数据（默认仅 leading+trailing，
    // 长间隔会卡住）。
    { maxWait: 1500 },
  );

  // 2026-09-28 review 第 1 轮修复：捕获 off + tryOnScopeDispose，确保组件卸载时
  // 订阅从 eventSubs Set 移除（原 DashboardView.vue onBeforeUnmount offSnap?.() 行为
  // 在重构中漏掉，会导致每次进入 /dashboard 都累加一个永不清理的 handler，
  // 闭包持有的 debouncedInvalidate / qc / query 无法 GC）。
  const offDashboardEvent = onDashboardEvent((ev) => {
    // 【B1 预留】switch (ev.event_type) { ... } 真增量分支预留。
    if (AFFECTS_DASHBOARD.has(ev.event_type)) debouncedInvalidate();
  });
  tryOnScopeDispose(offDashboardEvent);

  // 错误桥接：useQuery 的 error 不在 setup 抛错（沿 2026-09-26 约定 #9）。
  watch(query.error, (e) => {
    if (e) ElMessage.error(e.message ?? '大屏数据加载失败');
  });

  return query;
}
