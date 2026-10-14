// dashboard 域 WS 事件 → invalidate 共享 composable。
//
// 存在理由：dashboard 域有 3 个 useQuery（snapshot / upcoming / deliveryOrders），
// 它们需要同一份 AFFECTS_DASHBOARD 事件订阅 + 同一份防抖闭包。拆成共享 composable
// 而不是各 query 自带 handler，避免同一批 WS 事件触发多次 debounce 定时器、
// 合并失效成本翻倍。
//
// 设计要点：
//   - AFFECTS_DASHBOARD 集合维护 dashboard 域「需要重取数据」的事件白名单。
//   - useDebounceFn 500ms 防扫码雪崩；maxWait 1500ms 保证长间隔下也能 flush，
//     避免用户连续操作多轮时第一轮事件迟迟不重取。
//   - 接收单个 queryKey 或 queryKey 数组，统一在 debouncedInvalidate 内遍历
//     qc.invalidateQueries；支持多 key（如同时失效 snapshot 与 upcoming）与单 key
//     （deliveryOrders 只在抽屉打开时才有观察者，但 invalidate 仍走同一套）。
//   - tryOnScopeDispose 捕获 off 函数（onDashboardEvent 返回），组件卸载时
//     释放 eventSubs 订阅，避免「多次 mount / unmount 累加永不清理的 handler」。
//   - 第二条失效触发源：window 事件 'dashboard:full-refetch'（WS 层派发，走**不防抖**
//     的立即 invalidate，与事件路径的 500ms debounce 分开）。该信号有**两个派发源**：
//     后端关闭码 4003（慢消费方丢了 n 条事件）与**重连后的首帧 snapshot**（断线期丢的
//     增量事件）—— 缺口性质相同：服务端不重发，只能靠 HTTP 重取。派发点见
//     `api/dashboard.ts` 的 `dispatchFullRefetch`。

import { tryOnScopeDispose, useDebounceFn } from '@vueuse/core';
import { useQueryClient, type QueryKey } from '@tanstack/vue-query';
import { onDashboardEvent } from '@/api/dashboard';
import type { DashboardEventType } from '@/types/dashboard';

/** 影响 dashboard 域数据的 WS 事件集合。
 *  dashboard 三类核心切片（交期工单面板 / 交期分桶 / 工厂实时态）的写入事件都
 *  收敛到这个白名单：零件状态翻转 / 批次事件 / 扫码事件 / 批量创建 / worker pool
 *  状态 / 装配体事件。
 *
 *  DELIVERY_NOTE_*（送货单入单 / 提交 / 打印）不进集合 —— 交付事实由
 *  PART_DELIVERED 承载（每交一个批次发一次），入单 / 提交 / 打印都不改交付事实，
 *  故不影响 dashboard 任何切片。 */
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
  // 2026-10-15：扫码接管（`POST /prod/scan/take-over`）—— 批次从一个工人转到另一个，
  // 大屏「工人持有」格子据此重取。（外协收回端点发的是既有的 `PART_PICKED_UP`，本轮
  // 无需新增事件名。）
  'PART_TRANSFERRED',
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
  // 强制完成（2026-10-11）：零件 / 装配件各自的 force-complete 端点绕过状态机直写
  // COMPLETED，常驻大屏收不到写操作方的 invalidate，只能靠这两个事件。
  'PART_FORCE_COMPLETED',
  'ASSEMBLY_FORCE_COMPLETED',
  // 2026-10-19：终态序列号一键释放（`POST /serials/release-terminal`）的汇总事件。
  // **这是一条纯汇总事件**（payload 只有 assembly_count / part_count 两个计数，不带任何
  // 展示字段、也没有被释放行的 id 列表），所以它不像 PART_FORCE_COMPLETED 那样能
  // 「让某一行消失」，但它同样改了 dashboard 关心的数据：工单列表里终态工单的
  // serial_no 会变成空。不进白名单的话，常驻大屏（另一个标签页，且三 query 都是
  // `gcTime: POSITIVE_INFINITY` + 无 refetchInterval）会**静默停在释放前的状态** ——
  // 界面上还显示着一个实际已回池、随时会被新工单复用的号。
  'TERMINAL_SERIALS_RELEASED',
]);

/** dashboard 域失效事件数量（与 useDashboardInvalidation.spec.ts 的 T1 用例对齐；
 *  保持单一来源） */
export const AFFECTS_DASHBOARD_SIZE = AFFECTS_DASHBOARD.size;

/** dashboard 域 WS 事件 → invalidate 共享 composable。
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

  // 捕获 off + tryOnScopeDispose，确保组件卸载时订阅从 eventSubs Set 移除（否则每次
  // 进入 /dashboard 都累加一个永不清理的 handler，闭包持有的 debouncedInvalidate /
  // qc 无法 GC）。
  const offDashboardEvent = onDashboardEvent((ev) => {
    if (AFFECTS_DASHBOARD.has(ev.event_type)) debouncedInvalidate();
  });
  tryOnScopeDispose(offDashboardEvent);

  // 第二条失效触发源：接收 WS 层派发的 'dashboard:full-refetch'。**两个派发源共用这一个
  // 信号与这一个接收方**（派发点见 api/dashboard.ts 的 dispatchFullRefetch）：
  //   - 后端关闭码 4003：慢消费方，广播队列溢出**永久**丢了 n 条事件 ⇒ 关闭那一刻就派，
  //     不等重连完成，免得这段时间一直展示已知过期的数据；
  //   - 重连后的首帧 snapshot：断线期间丢的增量事件 ⇒ 补偿点在重连完成、首帧到达时
  //     （首次连接那一帧在 dispatch() 里被显式排除，它与首屏 HTTP 全量首取重复）。
  //
  // 为什么必须由本 composable 接：两个源都是**服务端不会重发**的缺口 —— 慢消费方丢的
  // n 条事件与断连期丢的增量事件都不在重连后的推送里（新连接的订阅集合从那一刻起算）。
  // 而本仓 dashboard 域是「HTTP 全量首取 + WS 事件 invalidate 重取」，TanStack Query
  // 也没有轮询（staleTime 30s 只管「下次取数是否放行」）⇒ 不补这一次 invalidate，
  // 「丢 1 个事件 = 对应区块永不刷新」且页面静默无提示。
  //
  // 走**不防抖**的立即路径（与上面的 debouncedInvalidate 并存）：防抖是为「单次扫码
  // 连续触发 3 个事件」防雪崩，而这两个源都意味着「已经确定丢了数据」，每多等 500ms
  // 都是在展示已知过期的数据。
  //
  // 与 'auth:session-lost' 的区别：那个是「会话已死，终止会话」（接收方在 router
  // 模块），本事件是「会话没死、数据可能缺了，补一次全量重取」（接收方在本文件）。
  //
  // 本 composable 有 4 个注册点（dashboard 域 3 个 query + `PartPreviewDialog`）。其中
  // `PartPreviewDialog` 传的是 `qk.partBatchesPrefix`（不是 dashboard 域键）。全量重取
  // 信号到达时弹窗若开着，`partBatchesPrefix` 也会被立即 invalidate —— **这是有意的、
  // 不是误伤**：该弹窗本就复用了同一套 WS 失效管道，其数据同样暴露在「后端宣告丢
  // 事件」与「断线期丢事件」的丢数风险下。
  if (typeof window !== 'undefined') {
    const onFullRefetch = () => {
      for (const k of keyList) {
        void qc.invalidateQueries({ queryKey: k });
      }
    };
    window.addEventListener('dashboard:full-refetch', onFullRefetch);
    tryOnScopeDispose(() => {
      window.removeEventListener('dashboard:full-refetch', onFullRefetch);
    });
  }

  return qc;
}
