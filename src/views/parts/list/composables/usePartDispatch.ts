// views/parts/list/composables/usePartDispatch.ts
//
// 2026-10-10 **大幅收缩**：单件下发 / 批量下发（都走 `place-on-shelf`）整块删除 ——
// 用户决定「下发按钮和对应的功能都移除，功能已经被扫码台的工人放回 / 送检接管」。
// 目标货架由后端按负载自动选，`place-on-shelf` 的 `shelf_id` 后端一并删除，
// 前端连「下发到哪个架」这个输入都没有了。
//
// 随之删除的东西（本文件曾经的全部内容）：`shelves` / `processes` / `reloadShelves`
// 两个候选源、两处货架↔工序双向收窄、`dispatchVisible` / `batchDispatchVisible`
// 两组对话框态与两条 mutation、`PLACE_ON_SHELF_NO_BATCH_HINT` 与
// `handleProcessChainRequired` 兜底。
//
// 留下的只有**强制完成**（MANAGER 专属）：它不走 place-on-shelf、不涉及货架，
// 与本次「不再指定货架」的口径无关。
// 两处刻意不动的命名（都是「改了要牵一串、收益为零」）：
//   · 函数名保持 `usePartDispatch` —— store 的 `dispatch` 切片名与
//     `usePartsListStore` 的装配处都按它注册，改切片名要动 `usePartsListStore`
//     + 两个视图组件的 `store.dispatch.*` 访问；
//   · 不再接收 deps —— 原先传 selectedIds / selectedRows / selectedRowTypes /
//     getTable 四个（批量下发成功后要把成功的行从三个状态源里摘掉），批量下发下线后
//     四个都不再被读，留着会让调用点以为它们有用。
//
// 2026-10-11 接装配件强制完成。**残留**：常驻在另一个标签页的生产队列看板会残留已完成
// 工单 —— 候选池判据是 `status='IN_PROCESS' AND location='PRODUCTION_SHELF'`
// （backend-rust docs/api/queue.md），批次被强推成 COMPLETED 后应当离池，但队列域
// 没有订阅 PART_FORCE_COMPLETED / ASSEMBLY_FORCE_COMPLETED，看板与徽标计数都要等
// 用户手动刷新或重新挂载才更新。本页的 `invalidateQueries` 到不了那个 tab（QueryClient
// 是每 JS context 一份），补前缀也没用。真通道是给队列域接 WS 订阅，本轮不在范围内。

import { reactive } from 'vue';
import { ElMessage } from 'element-plus';
import { useQueryClient, useMutation } from '@tanstack/vue-query';
import { forceCompletePart } from '@/api/parts';
import { forceCompleteAssembly } from '@/api/assembly';
import type { PartListItem } from '@/types/parts';
import { qk } from '@/composables/queries/keys';
import { useConfirm } from '@/composables/useConfirm';
import { usePermissions } from '@/composables/usePermissions';

export interface UsePartDispatchReturn {
  /** 2026-09-30 新增：MANAGER 专属「完成」按钮（强制完成工单+所有非取消批次为 COMPLETED）。 */
  forceCompletingMap: Record<string, boolean>;
  canForceComplete: (row: PartListItem) => boolean;
  onForceComplete: (row: PartListItem) => Promise<void>;
}

export function usePartDispatch(): UsePartDispatchReturn {
  const qc = useQueryClient();

  // ============ 强制完成（2026-09-30）============
  // 系统管理员专属：绕过状态机把工单 + 所有非取消批次置为 COMPLETED。
  // 零件走 `POST /parts/{id}/force-complete`，装配件走
  // `POST /prod/assemblies/{id}/force-complete`（后端只把这条写端点挂在 prod 前缀下）。
  // 守卫 canForceComplete 收口三个维度：
  //   - isManager：仅 MANAGER 可见 / 可点；
  //   - 非子件行（__is_child）：装配件整体完成走父行的入口，子件行不再提供第二个
  //     按钮 —— 否则同一批子件能从父 / 子两条路各点一次；
  //   - 非 COMPLETED / 非 CANCELLED：终态不可二次强制完成，避免日志噪声 + 避免
  //     与既有 cancelPart / cancelAssembly 路径冲突（取消件不强制回到已完成）。
  const confirm = useConfirm();
  const { isManager } = usePermissions();

  /**
   * 2026-10-11：子件行判定。
   *
   * `__is_child` 只声明在 `AssemblyChildItem`（literal `true`），`PartListItem`
   * 顶层没有该字段 —— 树表把子件行塞进同一个 `PartListItem[]`（PartsTable 的
   * `loadChildren`），故这里必须从宽取值。刻意**不给 `PartListItem` 补该字段**：
   * 顶层行永远拿不到它，补了只会把「只有子件才有」的标记写成全员可空字段。
   */
  function isChildRow(row: PartListItem): boolean {
    return (row as { __is_child?: unknown }).__is_child === true;
  }

  function canForceComplete(row: PartListItem): boolean {
    if (!isManager.value) return false;
    if (isChildRow(row)) return false;
    if (row.status === 'COMPLETED') return false;
    if (row.status === 'CANCELLED') return false;
    return true;
  }

  // per-row loading map（沿 DeliveryNoteList.deliveringMap 同款
  // reactive<Record<string, boolean>> 模式）：强制完成需要按行挂 spinner。
  // 命名 forceCompletingMap 与按钮文案「完成」对齐。用 delete 而非 = false，
  // 避免 map 累积 stale key（沿 DeliveryNoteList.vue 的清理范本）。
  const forceCompletingMap = reactive<Record<string, boolean>>({});

  interface ForceCompleteVars {
    /** 端点锚点 id：零件 id 或装配件 id（雪花 ID 字符串，全程 string，不经 Number()）。 */
    id: string;
    /** 行类型，决定打哪个 force-complete 端点。 */
    rowType: 'PART' | 'ASSEMBLY';
    note: string | null;
  }

  // 零件 / 装配件共用一个 mutation（per-row loading map、成功 / 失败文案、失效范围
  // 全部共用），只在 mutationFn 内按 rowType 分发 —— 不新开第二个 mutation。
  const forceCompleteMutation = useMutation<unknown, Error, ForceCompleteVars>({
    mutationKey: ['parts', 'dispatch', 'force-complete'],
    mutationFn: ({ id, rowType, note }) =>
      rowType === 'ASSEMBLY'
        ? forceCompleteAssembly(id, { note })
        : forceCompletePart(id, { note }),
    onMutate: ({ id }) => {
      forceCompletingMap[id] = true;
    },
    onSettled: (_d, _e, { id }) => {
      delete forceCompletingMap[id];
    },
    onSuccess: (_d, { rowType }) => {
      ElMessage.success(
        rowType === 'ASSEMBLY' ? '已强制完成装配件及其全部非取消批次' : '已强制完成',
      );
      void qc.invalidateQueries({ queryKey: qk.partsPrefix });
      // 2026-10-11：装配件完成同时改 t_part（子件）状态，需失效装配件域（详情 / 列表缓存）。
      void qc.invalidateQueries({ queryKey: qk.assemblyPrefix });
      // 2026-10-11：dashboard 三 query 的 gcTime 是 POSITIVE_INFINITY 且无 refetchInterval，
      // 常驻大屏（另一个标签页）收不到本 mutation 的成功回调 —— 只有这条 WS 失效是共屏
      // 的兜底通道。
      // 不补 qk.productionQueueSnapshotPrefix：`invalidateQueries` 只作用于本标签页的
      // QueryClient，而生产队列看板永远不与零件一览页挂在同一个 tab，补进来是死代码。
      // 跨屏的真通道是 WS（见 useDashboardInvalidation）。
      void qc.invalidateQueries({ queryKey: qk.dashboardPrefix });
    },
    onError: (e: Error) => ElMessage.error(e.message ?? '强制完成失败'),
  });

  async function onForceComplete(row: PartListItem): Promise<void> {
    // label fallback 用 serial_no || drawing_no || row.id，不引入 order_no ——
    // order_no 是「送货单号」，非工单号，不应出现在工单级确认文案里。
    const label = row.serial_no || row.drawing_no || row.id;
    const isAssembly = row.row_type === 'ASSEMBLY';
    // 2026-10-11：装配件额外提示子件会被一并完成。child_count 只在装配件行填且可能为
    // null（复用同一 VO 的其余端点恒不填）—— 缺省时退成不带数字的整句，
    // 既不显示数字也不会出现 NaN。零件路径不带这一句（文案逐字沿用旧形态）。
    const childHint = isAssembly
      ? typeof row.child_count === 'number' && row.child_count > 0
        ? `该装配件的 ${row.child_count} 个子件将一并完成。\n`
        : '该装配件的全部子件将一并完成。\n'
      : '';
    const ok = await confirm.dangerous(
      isAssembly ? '强制完成装配件' : '强制完成工单',
      `将强制把${isAssembly ? '装配件' : '工单'}「${label}」及其所有非取消批次置为已完成。\n` +
        childHint +
        `此操作绕过状态机（仅排除已取消批次），要求非 COMPLETED / 非 CANCELLED 状态。\n` +
        `仅系统管理员可执行，且不可撤销。是否继续？`,
      { confirmText: '确认完成', cancelText: '取消', type: 'warning' },
    );
    if (!ok) return;
    forceCompleteMutation.mutate({
      id: row.id,
      rowType: isAssembly ? 'ASSEMBLY' : 'PART',
      note: null,
    });
  }

  return {
    forceCompletingMap,
    canForceComplete,
    onForceComplete,
  };
}
