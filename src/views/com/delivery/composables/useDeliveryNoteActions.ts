// views/com/delivery/composables/useDeliveryNoteActions.ts
//
// 详情页的所有 page-level 业务操作（状态机 transition / 移除批次）：
// - onDeliveryDateChange：改送货日期（含 21403 BIZ_VERSION_CONFLICT 识别）
// - onSubmit：confirmDangerous + submitNote（带 version 冲突兜底）
// - onRecall：撤回
// - onSoftDelete：软删并跳列表
// - onRemoveSelected：移除选中批次
//
// 设计要点：
// - composable 只持有「业务函数」；不持有 UI 状态（dialog 可见性由 shell 自管）。
// - 所有破坏性操作走 confirmDangerous（T8 模式）。
// - fetchDetail 由 detail composable 传入，操作完成后调一次 refresh。
// - 错误处理：40403 / 21403 / 40901 → ElMessage.warning 并 fetchDetail 同步本地；
//   其它 → ElMessage.error(e.message)（让 fetch 自然抛、不在 composable 内吞）。
// - 返回值 Promise<boolean> 由 shell 决定后续（是否关对话框 / 跳转）。
//
// 2026-10-08 的连带删除（端点下线）：
// - `onSubmitDialogPassSuccess` / `onSubmitDialogPassPartial`：批量过检前置弹窗
//   （BatchInspectionConfirmDialog）整条链路下线 —— 入单只在扫码时做 READY_TO_SHIP
//   闸门，草稿不再有「先挂 INSPECTION 件、提交时再一键过检」的路径。
// - `submitCandidate*` / `onSubmitCandidate*`：submit 的 CANDIDATES_AVAILABLE 候选分流
//   随 `POST /{id}/submit` 改回「只回单据 id」而下线（闸门收敛在服务端）。
// - `onAddParts`：手动加件入口下线（`POST /{id}/add-parts` 删除）。

import { ElMessage } from 'element-plus';
import { ref, type Ref } from 'vue';
import { useRouter } from 'vue-router';
import {
  recallNote,
  removeBatches,
  softDeleteNote,
  submitNote,
  updateNote,
} from '@/api/com/deliveryNote';
import type { ApiError } from '@/api/http';
import { useConfirm } from '@/composables/useConfirm';

/**
 * 详情 composable 暴露给 actions 的最小接口（避免 actions 依赖整个 detail composable）。
 */
export interface DeliveryNoteDetailBindings {
  note: Ref<{
    id: string;
    version: number;
    part_count: number;
    delivery_note_no: string;
    delivery_date: string | null;
  } | null>;
  selectedItemIds: Ref<string[]>;
  editDeliveryDate: Ref<string>;
  fetchDetail: () => Promise<void>;
  setSelectedItemIds: (ids: string[]) => void;
}

export interface UseDeliveryNoteActionsReturn {
  // mutate local state
  setEditDeliveryDate: (date: string) => void;
  // actions
  onDeliveryDateChange: (newDate: string | null) => Promise<boolean>;
  onSubmit: () => Promise<boolean>;
  onRecall: () => Promise<boolean>;
  onSoftDelete: () => Promise<boolean>;
  onRemoveSelected: () => Promise<boolean>;
  /** 正在提交 / 撤回 / 删除的行内 loading 锚（单据 id） */
  pendingNoteId: Ref<string | null>;
}

export function useDeliveryNoteActions(
  bindings: DeliveryNoteDetailBindings,
): UseDeliveryNoteActionsReturn {
  const router = useRouter();
  const { dangerous: confirmDangerous } = useConfirm();
  const pendingNoteId = ref<string | null>(null);

  // ============ 辅助 ============
  /** submitNote 统一错误处理：识别 21403 note 版本冲突 / 40901 批次 version 不匹配
   *  → 刷新详情；其它原样展示。 */
  function onSubmitError(e: unknown): void {
    const err = e as ApiError;
    // ApiError 已在 http.ts 信封拦截器中把 backend code 提到顶层 err.code
    if (err?.code === 21403) {
      ElMessage.warning('版本已过期，正在刷新...');
      void bindings.fetchDetail();
      return;
    }
    // 40901 = 批次 version 不匹配（扫码入单的 DP 分配撞上并发改动时可能附带返回）。
    if (err?.code === 40901) {
      ElMessage.warning('该批次已被他人修改，请刷新后重试');
      void bindings.fetchDetail();
      return;
    }
    ElMessage.error(err?.message ?? '提交失败');
  }

  function setEditDeliveryDate(date: string): void {
    bindings.editDeliveryDate.value = date;
  }

  // ============ 改送货日期 ============
  async function onDeliveryDateChange(newDate: string | null): Promise<boolean> {
    const n = bindings.note.value;
    if (!n) return false;
    const normalized = newDate ?? '';
    if (normalized === (n.delivery_date ?? '')) return false; // 没变 → 不发请求
    try {
      await updateNote(n.id, {
        version: n.version,
        delivery_date: normalized,
      });
      ElMessage.success('已更新送货日期');
      await bindings.fetchDetail();
      return true;
    } catch (e: unknown) {
      const err = e as ApiError;
      if (err?.code === 21403 /* BIZ_VERSION_CONFLICT */) {
        ElMessage.warning('该记录已被其他用户修改，请刷新后重试');
      } else {
        ElMessage.error(err?.message ?? '更新送货日期失败');
      }
      await bindings.fetchDetail();
      return false;
    }
  }

  // ============ 提交 ============
  /**
   * 提交草稿：确认 → submitNote → 刷新详情。
   * 响应只回单据 id：拿到 2xx 就是成功，批次状态 / OCC 问题一律由服务端抛错
   * （21405 / 21406 / 21416 / 21403 / 40901），走 onSubmitError 分流。
   */
  async function onSubmit(): Promise<boolean> {
    const n = bindings.note.value;
    if (!n) return false;
    if (
      !(await confirmDangerous('提交送货单', `确认提交 ${n.delivery_note_no}？`, {
        type: 'warning',
        confirmText: '提交',
        cancelText: '取消',
      }))
    )
      return false;
    pendingNoteId.value = n.id;
    try {
      await submitNote(n.id, { version: n.version });
      ElMessage.success('已提交');
      await bindings.fetchDetail();
      return true;
    } catch (e) {
      onSubmitError(e);
      return false;
    } finally {
      pendingNoteId.value = null;
    }
  }

  // ============ 撤回 ============
  async function onRecall(): Promise<boolean> {
    const n = bindings.note.value;
    if (!n) return false;
    if (
      !(await confirmDangerous('撤回送货单', `确认撤回 ${n.delivery_note_no}？`, {
        type: 'warning',
      }))
    )
      return false;
    try {
      await recallNote(n.id, { version: n.version });
      ElMessage.success('已撤回');
      await bindings.fetchDetail();
      return true;
    } catch (e) {
      const err = e as ApiError;
      ElMessage.error(err?.message ?? '撤回失败');
      return false;
    }
  }

  // ============ 软删 ============
  async function onSoftDelete(): Promise<boolean> {
    const n = bindings.note.value;
    if (!n) return false;
    if (
      !(await confirmDangerous('删除送货单', `确认删除 ${n.delivery_note_no}？关联零件会解除。`, {
        type: 'warning',
      }))
    )
      return false;
    try {
      await softDeleteNote(n.id, { version: n.version });
      ElMessage.success('已删除');
      await router.push('/delivery-notes');
      return true;
    } catch (e) {
      const err = e as ApiError;
      ElMessage.error(err?.message ?? '删除失败');
      return false;
    }
  }

  // ============ 移除选中批次 ============
  async function onRemoveSelected(): Promise<boolean> {
    const n = bindings.note.value;
    if (!n) return false;
    if (bindings.selectedItemIds.value.length === 0) {
      ElMessage.warning('请勾选要移除的批次');
      return false;
    }
    if (
      !(await confirmDangerous(
        '移除批次',
        `确认移除选中的 ${bindings.selectedItemIds.value.length} 个批次？`,
        { type: 'warning' },
      ))
    )
      return false;
    try {
      await removeBatches(n.id, {
        batch_ids: bindings.selectedItemIds.value,
        version: n.version,
      });
      ElMessage.success('已移除');
      bindings.setSelectedItemIds([]);
      await bindings.fetchDetail();
      return true;
    } catch (e) {
      const err = e as ApiError;
      ElMessage.error(err?.message ?? '移除失败');
      return false;
    }
  }

  return {
    setEditDeliveryDate,
    onDeliveryDateChange,
    onSubmit,
    onRecall,
    onSoftDelete,
    onRemoveSelected,
    pendingNoteId,
  };
}