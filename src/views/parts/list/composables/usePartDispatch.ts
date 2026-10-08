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

import { reactive } from 'vue';
import { ElMessage } from 'element-plus';
import { useQueryClient, useMutation } from '@tanstack/vue-query';
import { forceCompletePart } from '@/api/parts';
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
  // 系统管理员专属：绕过状态机把工单+所有非取消批次置为 COMPLETED。
  // 守卫 canForceComplete 收口角色 + row_type + status 三个维度：
  //   - isManager：仅 MANAGER 可见 / 可点；
  //   - row.row_type !== 'ASSEMBLY'：装配件无独立批次完成语义（待与后端契约确认）；
  //   - 非 COMPLETED / 非 CANCELLED：终态不可二次强制完成，避免日志噪声 + 避免
  //     与既有 cancelPart 路径冲突（取消件不强制回到已完成）。
  const confirm = useConfirm();
  const { isManager } = usePermissions();

  function canForceComplete(row: PartListItem): boolean {
    if (!isManager.value) return false;
    if (row.row_type === 'ASSEMBLY') return false;
    if (row.status === 'COMPLETED') return false;
    if (row.status === 'CANCELLED') return false;
    return true;
  }

  // per-row loading map（沿 DeliveryNoteList.deliveringMap 同款
  // reactive<Record<string, boolean>> 模式）：强制完成需要按行挂 spinner。
  // 命名 forceCompletingMap 与按钮文案「完成」对齐。用 delete 而非 = false，
  // 避免 map 累积 stale key（沿 DeliveryNoteList.vue 的清理范本）。
  const forceCompletingMap = reactive<Record<string, boolean>>({});

  const forceCompleteMutation = useMutation<
    unknown,
    Error,
    { partId: string; note: string | null }
  >({
    mutationKey: ['parts', 'dispatch', 'force-complete'],
    mutationFn: ({ partId, note }) => forceCompletePart(partId, { note }),
    onMutate: ({ partId }) => {
      forceCompletingMap[partId] = true;
    },
    onSettled: (_d, _e, { partId }) => {
      delete forceCompletingMap[partId];
    },
    onSuccess: () => {
      ElMessage.success('已强制完成');
      void qc.invalidateQueries({ queryKey: qk.partsPrefix });
    },
    onError: (e: Error) => ElMessage.error(e.message ?? '强制完成失败'),
  });

  async function onForceComplete(row: PartListItem): Promise<void> {
    // label fallback 用 serial_no || drawing_no || row.id，不引入 order_no ——
    // order_no 是「送货单号」，非工单号，不应出现在工单级确认文案里。
    const label = row.serial_no || row.drawing_no || row.id;
    const ok = await confirm.dangerous(
      '强制完成工单',
      `将强制把工单「${label}」及其所有非取消批次置为已完成。\n` +
        `此操作绕过状态机（仅排除已取消批次），要求非 COMPLETED / 非 CANCELLED 状态。\n` +
        `仅系统管理员可执行，且不可撤销。是否继续？`,
      { confirmText: '确认完成', cancelText: '取消', type: 'warning' },
    );
    if (!ok) return;
    forceCompleteMutation.mutate({ partId: row.id, note: null });
  }

  return {
    forceCompletingMap,
    canForceComplete,
    onForceComplete,
  };
}
