// composables/useDeliveryScanSubmission.ts
//
// 扫码主流程 + 提交草稿 + 打印送货单预览的业务状态 + 函数。
//
// 持有：
//   - 扫码防抖态（lastScanCode / lastScanAt / scanning）
//   - 三层树对话框态（scanTreeDialogVisible / scannedSerialNo）
//   - 打印送货单预览（PrintPreviewDialog）状态
//   - submittingByNote —— 每张草稿卡片提交中 loading
//
// 不持有：
//   - drafts / draftDetails / selectedByNote / printingByNote / deletingByNote
//     —— useDeliveryDraftBoard 持有；本 composable 通过 options 注入回调访问
//
// 与 useDeliveryDraftBoard 的协调：
//   - writeDraftFromScan(note) → board 写入 drafts Map
//   - refreshDraftDetail(noteId) → board 重新拉详情
//   - clearNoteLocalState(noteId) → board 在提交成功后清掉全部 ref
//
// 2026-10-08 的连带删除（端点下线）：
// - 候选弹窗（DeliveryScanCandidateDialog）与其 4 个状态：扫码响应不再是
//   outcome 包装，`CANDIDATES_AVAILABLE` / `PARTIAL_ADDED` 两个分支整体消失；
// - 提交前未送检确认（BatchInspectionConfirmDialog）：入单只在扫码时做
//   READY_TO_SHIP 闸门，草稿不再有「先挂 INSPECTION 件、提交时再一键过检」的路径；
// - submit 的 CANDIDATES_AVAILABLE 候选分流：`POST /{id}/submit` 改回只回单据 id，
//   闸门收敛在服务端。
// - 手搓的 useDeliveryNoteDetailCache：并发去重改由 useQuery 承担，本文件直接调 getNote。

import { computed, nextTick, reactive, ref, type Ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useMutation } from '@tanstack/vue-query';
import { getNote, submitDeliveryEntries, submitNote } from '@/api/com/deliveryNote';
import { ApiError } from '@/api/http';
import { BLOCK_SCAN_CODES } from '@/types/deliveryNote';
import type { DeliveryScanEntry } from './deliveryNoteSchema';
import type { DeliveryScanTreeData } from './deliveryScanTreeSchema';
import type { DeliveryNoteDetailData, DeliveryNoteItemData } from './deliveryNoteSchema';
import { useDeliveryScanTreeMutation } from './useDeliveryScanTreeQuery';
import { invalidateDeliveryNotesQuery } from './useDeliveryNoteListStore';
import { useQueryClient } from '@tanstack/vue-query';

export interface UseDeliveryScanSubmissionOptions {
  /** 入单成功后写入 drafts Map 的回调（由 useDeliveryDraftBoard 注入）。 */
  writeDraftFromScan: (note: DeliveryNoteItemData) => void;
  /** 重新拉单个 note 的 line_items（由 useDeliveryDraftBoard 注入）；
   *  拉取失败（warning 已 toast）时返回 null，caller 静默降级。 */
  refreshDraftDetail: (noteId: string) => Promise<DeliveryNoteDetailData | null>;
  /**
   * 提交成功后清掉 note 全部本地 ref（由 useDeliveryDraftBoard 注入）；
   * useDeliveryScanSubmission 不直接知道 draftDetails / selectedByNote / tableRefs 的存在。
   */
  onDraftRemoved: (noteId: string) => void;
}

/** 2026-09-21 显式返回类型。 */
export interface UseDeliveryScanSubmissionReturn {
  scanning: Ref<boolean>;
  lastScanCode: Ref<string>;
  lastScanAt: Ref<number>;
  /** 三层树对话框可见性（扫一下弹一次）。 */
  scanTreeDialogVisible: Ref<boolean>;
  /** 当前三层树数据（对话框的数据源）。 */
  scanTree: Ref<DeliveryScanTreeData | null>;
  /** 取树请求在途（对话框的 loading）。 */
  scanTreeLoading: Ref<boolean>;
  printNotePreviewVisible: Ref<boolean>;
  printNoteTarget: Ref<DeliveryNoteDetailData | null>;
  printNoteLoading: Ref<boolean>;
  submittingByNote: Record<string, boolean>;
  handleScan: (rawCode: string) => Promise<void>;
  /** 扫码取树（纯读；用户已在扫码枪上扫过一次，这里是弹树时的容错重取）。 */
  loadScanTree: (serialNo: string) => Promise<void>;
  closeScanTree: () => void;
  /** 入单提交（三层树对话框里选好数量后调）。 */
  onSubmitEntries: (entries: DeliveryScanEntry[]) => Promise<void>;
  scanSubmitting: Ref<boolean>;
  openPrintNote: (d: DeliveryNoteItemData) => Promise<void>;
  onSubmitDraft: (d: DeliveryNoteItemData) => Promise<void>;
}

export function useDeliveryScanSubmission(
  opts: UseDeliveryScanSubmissionOptions,
): UseDeliveryScanSubmissionReturn {
  // ============ 扫码防抖态 ============
  /** 1.5s 同码防抖：双击 Enter / 扫码枪连扫容错。 */
  const lastScanCode = ref('');
  const lastScanAt = ref(0);
  /** 当前扫码 inflight 标记（handleScan 重入保护）。 */
  const scanning = ref(false);

  // ============ 三层树对话框 ============
  const scanTreeDialogVisible = ref(false);
  // 树数据由 useMutation 承载（扫码是用户触发的单次拉取，不是页面持有的读数据；
  // 理由见 useDeliveryScanTreeQuery 文件头）。对外仍以 Ref 暴露，方便模板直接读。
  const treeState = useDeliveryScanTreeMutation();
  const scanTree = computed(() => treeState.tree.value);
  const scanTreeLoading = treeState.scanTreeMutation.isPending;

  // ============ 打印送货单预览 ============
  /** preview 弹窗显隐 + 当前打开的 note（getNote 拉回）。 */
  const printNotePreviewVisible = ref(false);
  const printNoteTarget = ref<DeliveryNoteDetailData | null>(null);
  const printNoteLoading = ref(false);

  /** 每张草稿卡片各自的提交中 loading 态。 */
  const submittingByNote = reactive<Record<string, boolean>>({});

  // ============ 入单 mutation（POST /scan）============
  const qc = useQueryClient();
  const submitEntriesMutation = useMutation({
    mutationKey: ['delivery', 'scan-entries'],
    mutationFn: submitDeliveryEntries,
    onSuccess: async (detail) => {
      // 响应含拆批后的完整详情 ⇒ 就地替换草稿看板那张卡 + 失效本域（列表 / 详情缓存）。
      opts.writeDraftFromScan(detail);
      await opts.refreshDraftDetail(detail.id);
      await invalidateDeliveryNotesQuery(qc);
      closeScanTree();
      ElMessage.success(`已加入 ${detail.delivery_note_no}`);
    },
    onError: (e: ApiError) => {
      if (e?.code === 40901) {
        ElMessage.warning('该送货单已被他人修改，请重新扫码');
      } else {
        ElMessage.error(e?.message ?? '入单失败');
      }
    },
  });
  const scanSubmitting = submitEntriesMutation.isPending;

  // ============ 扫码主流程 ============

  /**
   * 单次扫码处理全流程（v3 只来自扫码枪 onScan 回调）：
   *   1) trim + 长度校验
   *   2) inflight / 1.5s 同码 防抖
   *   3) await 扫码取树 → 打开三层树对话框（**建单发生在用户确认入单时**，
   *      扫码这一步是纯读）
   */
  async function handleScan(rawCode: string): Promise<void> {
    const code = rawCode.trim();

    // 1) 客户端格式校验
    if (code.length < 1 || code.length > 64) {
      ElMessage.warning('条码格式不正确');
      return;
    }

    // 2) inflight / 双击 Enter 守卫
    if (scanning.value) {
      ElMessage.warning('上一次扫码尚未完成，请稍候');
      return;
    }
    const now = Date.now();
    if (lastScanCode.value === code && now - lastScanAt.value < 1500) {
      return; // 同码 1.5s 内重复：吞掉
    }
    lastScanCode.value = code;
    lastScanAt.value = now;

    scanning.value = true;
    try {
      await treeState.scanTreeMutation.mutateAsync(code);
      scanTreeDialogVisible.value = true;
    } catch (e) {
      applyError(e);
    } finally {
      scanning.value = false;
      await nextTick();
    }
  }

  /** 对话框内的容错重取（正常路径上 handleScan 已经取过一次）。 */
  async function loadScanTree(serialNo: string): Promise<void> {
    scanning.value = true;
    try {
      await treeState.scanTreeMutation.mutateAsync(serialNo.trim());
    } catch (e) {
      applyError(e);
    } finally {
      scanning.value = false;
    }
  }

  function closeScanTree(): void {
    scanTreeDialogVisible.value = false;
    treeState.clearScanTree();
  }

  /**
   * 失败：按 ApiError.code 分流。
   *   - 21421（BIZ_DELIVERY_BATCH_STATE_INVALID：DELIVERED / OUTSOURCE / IN_PROCESS
   *     工人持有 / COMPLETED / CANCELLED）→ toast，无弹窗；
   *   - 21417（BIZ_DELIVERY_SCAN_UNKNOWN_CODE，条码未命中）→ toast；
   *   - 21405（BIZ_DELIVERY_NOTE_PART_NOT_READY：批次不是 READY_TO_SHIP / 凑不齐）
   *     与 21406（批次已挂在别的单上）→ 入单阶段的闸门，扫码阶段不会触发；
   *   - 其它 → 兜底 toast。
   */
  function applyError(e: unknown): void {
    const apiErr = e as ApiError | null | undefined;
    if (
      apiErr instanceof ApiError &&
      (BLOCK_SCAN_CODES as readonly number[]).includes(apiErr.code)
    ) {
      ElMessage.error(apiErr.message ?? '批次状态不允许入单');
      return;
    }
    if (apiErr instanceof ApiError && apiErr.code === 21417) {
      ElMessage.error(`无法识别扫码：${apiErr.message ?? '请检查条码'}`);
      return;
    }
    const fallback = (e as { message?: string } | null | undefined)?.message ?? '扫码失败';
    ElMessage.error(fallback);
  }

  /**
   * 入单提交：把三层树对话框里选好的条目一次性发给
   * `POST /com/delivery/note/scan`（服务端 find-or-create 该 L1 的唯一 DRAFT）。
   *
   * `note_version` 取扫码时读到的 draft.version 做 OCC，撞并发扫码返 40901。
   * 成功 / 失败处理都在 submitEntriesMutation 的 onSuccess / onError 里。
   */
  async function onSubmitEntries(entries: DeliveryScanEntry[]): Promise<void> {
    const tree = scanTree.value;
    if (!tree || entries.length === 0) return;
    try {
      await submitEntriesMutation.mutateAsync({
        serial_no: tree.scanned_serial_no,
        note_version: tree.draft?.version ?? null,
        entries,
      });
    } catch {
      // onError 已提示（40901 走 warning / 其它走 error），这里只吞掉 rejection：
      // 对话框保留在页面上让用户改数量或重扫，不该冒一个未处理的 promise rejection。
    }
  }

  // ============ 打印送货单 + 提交草稿 ============

  /**
   * 打开打印送货单预览：
   *   - 先 getNote 拉 detail（full line_items），期间 printNoteTarget=null
   *     且弹窗保持关闭（v-if 控制）
   *   - 拿到 detail 后才打开弹窗；失败 toast 并保持关闭
   */
  async function openPrintNote(d: DeliveryNoteItemData): Promise<void> {
    printNoteTarget.value = null;
    printNotePreviewVisible.value = false;
    printNoteLoading.value = true;
    try {
      const detail = await getNote(d.id);
      printNoteTarget.value = detail;
      printNotePreviewVisible.value = true;
    } catch (e) {
      ElMessage.error((e as Error).message ?? '加载详情失败');
    } finally {
      printNoteLoading.value = false;
    }
  }

  /**
   * 提交草稿：拉一次详情拿最新 version → 确认 → 提交。
   * 状态闸门在服务端：21405 / 21406 会以 toast 呈现（见 doSubmit 错误分支）。
   */
  async function onSubmitDraft(d: DeliveryNoteItemData): Promise<void> {
    let detail: DeliveryNoteDetailData;
    try {
      detail = await getNote(d.id);
    } catch (e) {
      ElMessage.error((e as Error).message ?? '加载详情失败');
      return;
    }
    // 同步最新 version（listNotes 的 version 可能落后一拍）
    opts.writeDraftFromScan({ ...d, version: detail.version });
    try {
      await ElMessageBox.confirm(
        `确认提交草稿 ${d.delivery_note_no}（${detail.part_count} 条）？`,
        '提交草稿',
        { type: 'warning', confirmButtonText: '提交', cancelButtonText: '取消' },
      );
    } catch {
      return;
    }
    await doSubmit({ ...d, version: detail.version });
  }

  async function doSubmit(d: DeliveryNoteItemData): Promise<void> {
    const noteId = d.id;
    submittingByNote[noteId] = true;
    try {
      await submitNote(noteId, { version: d.version });
      // 本地清掉全部 ref（drafts / draftDetails / selectedByNote / printingByNote /
      // deletingByNote / tableRefs / foldedComputeds / localStorage 标记）。
      opts.onDraftRemoved(noteId);
      ElMessage.success('已提交');
    } catch (e) {
      const err = e as ApiError;
      if (err?.code === 21403) {
        ElMessage.warning('版本已过期，正在刷新...');
        void opts.refreshDraftDetail(noteId).catch(() => {
          /* 已 toast */
        });
      } else {
        ElMessage.error(err?.message ?? '提交失败');
      }
      // 失败路径：让用户可以重试提交
      submittingByNote[noteId] = false;
    }
  }

  return {
    // state
    scanning,
    lastScanCode,
    lastScanAt,
    scanTreeDialogVisible,
    scanTree,
    scanTreeLoading,
    scanSubmitting,
    printNotePreviewVisible,
    printNoteTarget,
    printNoteLoading,
    submittingByNote,

    // functions
    handleScan,
    loadScanTree,
    closeScanTree,
    onSubmitEntries,
    openPrintNote,
    onSubmitDraft,
  };
}