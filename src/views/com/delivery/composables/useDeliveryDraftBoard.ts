// composables/useDeliveryDraftBoard.ts
//
// 扫码建单页「草稿卡片列表」的业务状态 + 业务函数。
//
// 持有：
//   - drafts / draftDetails / draftsLoading / draftsCount
//     —— 草稿 header + line_items + 加载态 + 计数
//   - selectedByNote / printingByNote / deletingByNote
//     —— 每张草稿卡片各自的运行时状态（勾选 / 各种 loading）
//   - tableRefs / foldedComputeds
//     —— 每张卡片的 el-table 实例（clearSelection 用）+ foldBySerial 缓存
//
// 不持有：
//   - submittingByNote（属于 useDeliveryScanSubmission，与 doSubmit 配对）
//   - 扫码相关状态（lastScanCode / scanning 等）
//   - 提交 / 打印预览相关弹窗状态
//
// 子组件约定：
//   - DeliveryDraftCard 通过 props 读 drafts / rows / selectedRows / 各 loading 标志，
//     通过 emits 把 user action（goto-detail / selection-change / remove / print-labels /
//     print-note / delete-draft / submit-draft / set-table-ref）回给 shell。
//
// 2026-10-08 的连带变更：
// - `scope` / `scope_label` / `recent_items` 三字段消失（后端不发、前端原来还在编
//   `'L1_WIDE'` / `'按一级客户'`）；同 L1 同时只允许一张 DRAFT，scope 概念整体下线。
// - 详情缓存由 `useQuery` 天然去重承担，原手搓的 `useDeliveryNoteDetailCache`
//   （TTL Map + in-flight Map）随该文件一起删除，这里直接调 getNote。

import { computed, reactive, ref, type ComputedRef, type Ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  batchGetNotes,
  getNote,
  listNotes,
  printNoteLabels,
  removeBatches,
  softDeleteNote,
} from '@/api/com/deliveryNote';
import { usePrintedLabels } from './usePrintedLabels';
import { triggerBrowserDownload } from '@/utils/download';
import type {
  DeliveryNoteDetailData,
  DeliveryNoteItemData,
  DeliveryNoteLineItemData,
} from './deliveryNoteSchema';

/**
 * el-table 一行 = 同 serial_no 折叠后的若干 batch；serial 为 null 时按 id 各占一行。
 */
export interface MergedDraftRow {
  /** 同 serial_no 折叠后的代表 serial；为 null 时按各自一行（key = `__null_<id>`）。 */
  serial_no: string | null;
  drawing_no: string;
  name: string;
  /** 折叠各 batch 之和。 */
  quantity: number;
  /** 系统交期；同 serial 多 batch 取首个非空。 */
  system_delivery_date: string | null;
  /** 折叠行背后的所有 batch id（移除用）。 */
  batch_ids: string[];
  /** 任一 batch 在 localStorage 里登记为已打印标签 = true；用于绿底渲染。 */
  label_printed: boolean;
}

/**
 * el-table 实例 ref（只用到 clearSelection；不绑 FormInstance 等更复杂类型）。
 */
export interface DraftTableInstance {
  clearSelection: () => void;
}

/** 同 serial_no 的多 batch 折叠为一行（分组 key = serial_no）。 */
function foldBySerial(
  items: readonly DeliveryNoteLineItemData[],
  isPrinted: (batchId: string) => boolean,
): MergedDraftRow[] {
  const groups = new Map<string, MergedDraftRow>();
  const order: string[] = [];
  for (const li of items) {
    const key = li.serial_no ?? `__null_${li.id}`;
    const existing = groups.get(key);
    const printed = isPrinted(String(li.id));
    if (existing) {
      existing.quantity += li.quantity;
      existing.batch_ids.push(String(li.id));
      if (!existing.label_printed && printed) existing.label_printed = true;
      if (!existing.system_delivery_date && li.system_delivery_date) {
        existing.system_delivery_date = li.system_delivery_date;
      }
    } else {
      const row: MergedDraftRow = {
        serial_no: li.serial_no,
        drawing_no: li.drawing_no,
        name: li.name,
        quantity: li.quantity,
        system_delivery_date: li.system_delivery_date,
        batch_ids: [String(li.id)],
        label_printed: printed,
      };
      groups.set(key, row);
      order.push(key);
    }
  }
  return order.map((k) => groups.get(k)!);
}

/** 2026-09-21 显式返回类型。 */
export interface UseDeliveryDraftBoardReturn {
  drafts: Ref<Record<string, DeliveryNoteItemData>>;
  draftDetails: Record<string, DeliveryNoteLineItemData[]>;
  draftsLoading: Ref<boolean>;
  draftsCount: ComputedRef<number>;
  selectedByNote: Record<string, MergedDraftRow[]>;
  printingByNote: Record<string, boolean>;
  deletingByNote: Record<string, boolean>;
  setTableRef: (noteId: string, el: DraftTableInstance | null) => void;
  foldedRows: (noteId: string) => MergedDraftRow[];
  rowClassName: (ctx: { row: MergedDraftRow }) => string;
  onSelectionChange: (noteId: string, rows: MergedDraftRow[]) => void;
  getSelectionSize: (noteId: string) => number;
  reloadDrafts: (l1Id: string) => Promise<void>;
  refreshDraftDetail: (noteId: string) => Promise<DeliveryNoteDetailData | null>;
  writeDraftFromScan: (note: DeliveryNoteItemData) => void;
  onRemove: (d: DeliveryNoteItemData, row: MergedDraftRow) => Promise<void>;
  onPrintLabels: (d: DeliveryNoteItemData) => Promise<void>;
  onDeleteDraft: (d: DeliveryNoteItemData) => Promise<void>;
  clearNoteLocalState: (noteId: string) => void;
}

export function useDeliveryDraftBoard(): UseDeliveryDraftBoardReturn {
  const printedLabelStore = usePrintedLabels();

  // ============ 草稿 header + 详情行 ============
  /** 当前 L1 下所有 DRAFT 草稿（key = note_id）—— header 摘要。 */
  const drafts = ref<Record<string, DeliveryNoteItemData>>({});
  /** 每个草稿的完整 line_items（按 note_id 存），el-table 数据源。 */
  const draftDetails = reactive<Record<string, DeliveryNoteLineItemData[]>>({});
  const draftsLoading = ref(false);
  const draftsCount: ComputedRef<number> = computed(() => Object.keys(drafts.value).length);

  // ============ 每张草稿卡片各自的运行时状态 ============
  /** 每张草稿卡片各自的勾选行（「打印标签」按钮的成员来源）。 */
  const selectedByNote = reactive<Record<string, MergedDraftRow[]>>({});
  /** 每张草稿卡片各自的打印中 loading 态。 */
  const printingByNote = reactive<Record<string, boolean>>({});
  /** 每张草稿卡片各自的删除中 loading 态。 */
  const deletingByNote = reactive<Record<string, boolean>>({});

  /**
   * 每张草稿卡片各自的 el-table 实例 ref；打印成功后显式调 clearSelection()
   * 触发 EP 自身的 selection-change → onSelectionChange 顺势清空 selectedByNote，
   * 避免依赖 markPrinted → folded computed 重算这条隐式链路。
   */
  const tableRefs = new Map<string, DraftTableInstance>();

  // ============ 折叠数据缓存（per-note computed；保 data 引用稳定）============
  /**
   * EP el-table 在 :data 引用变化时会自动 clearSelection()（内部 setData 命中
   * dataInstanceChanged）。若在模板内联调 foldBySerial(...) → 每次重渲染都产生新数组
   * → 勾选立刻被清，与 selectedByNote 写入触发的重渲染形成死循环。
   *
   * 按 note_id 缓存 computed：当 draftDetails[noteId] 与 printedLabelStore
   * 均未变时复用同一引用，视图重渲染不再误清勾选；数据真正变化（扫码刷新 /
   * markPrinted / 移除）时正常重算（引用变了 → EP 自动清勾选，符合直觉）。
   */
  const foldedComputeds = new Map<string, ComputedRef<MergedDraftRow[]>>();

  /** 子组件用：注册 / 反注册 el-table 实例；给 onPrintLabels 的 clearSelection 用。 */
  function setTableRef(noteId: string, el: DraftTableInstance | null): void {
    if (el) tableRefs.set(noteId, el);
    else tableRefs.delete(noteId);
  }

  /** 按 note_id 取 foldBySerial 结果（命中 cache 时复用同一 ref）。 */
  function foldedRows(noteId: string): MergedDraftRow[] {
    let c = foldedComputeds.get(noteId);
    if (!c) {
      c = computed(() =>
        foldBySerial(draftDetails[noteId] ?? [], printedLabelStore.isPrintedBatch),
      );
      foldedComputeds.set(noteId, c);
    }
    return ((): MergedDraftRow[] => c!.value)();
  }

  /** el-table 行已打印标签绿底。 */
  function rowClassName({ row }: { row: MergedDraftRow }): string {
    return row.label_printed ? 'row-printed' : '';
  }

  function onSelectionChange(noteId: string, rows: MergedDraftRow[]): void {
    selectedByNote[noteId] = rows;
  }

  function getSelectionSize(noteId: string): number {
    return selectedByNote[noteId]?.length ?? 0;
  }

  // ============ 数据加载 ============

  /**
   * 拉当前 L1 下所有 DRAFT 草稿 + 各草稿的完整 line_items。
   *
   * 两步：
   *   1) listNotes 拿 header（statuses=DRAFT, customer_id=l1, limit=200）；
   *   2) 一次 batchGetNotes 拿全部详情（1 次往返，不是 N 次 getNote）。
   *
   * 任一失败 → 兜底空数组（不阻断其他草稿卡片渲染）。
   */
  async function reloadDrafts(l1Id: string): Promise<void> {
    if (!l1Id) {
      drafts.value = {};
      // 清空 draftDetails / selectedByNote / printingByNote / deletingByNote 残留 key。
      for (const k of Object.keys(draftDetails)) delete draftDetails[k];
      for (const k of Object.keys(selectedByNote)) delete selectedByNote[k];
      for (const k of Object.keys(printingByNote)) delete printingByNote[k];
      for (const k of Object.keys(deletingByNote)) delete deletingByNote[k];
      foldedComputeds.clear();
      return;
    }
    draftsLoading.value = true;
    try {
      const resp = await listNotes({ statuses: ['DRAFT'], customer_id: l1Id, limit: 200 });
      const next: Record<string, DeliveryNoteItemData> = {};
      for (const n of resp.items) {
        // 防御性前端过滤：listNotes 已带 statuses=['DRAFT'] 查询参数，但若后端未
        // 严格按 status 过滤，已提交件会跟着回来。本地再筛一次确保 UI 只显示草稿。
        if (n.status !== 'DRAFT') continue;
        next[n.id] = n;
      }
      drafts.value = next;

      // 清掉旧 key（残留可能因 listNotes 限 200 不再返回）
      for (const k of Object.keys(draftDetails)) {
        if (!(k in next)) delete draftDetails[k];
      }
      for (const k of Object.keys(selectedByNote)) {
        if (!(k in next)) delete selectedByNote[k];
      }
      for (const k of Object.keys(printingByNote)) {
        if (!(k in next)) delete printingByNote[k];
      }
      for (const k of Object.keys(deletingByNote)) {
        if (!(k in next)) delete deletingByNote[k];
      }
      for (const k of Array.from(foldedComputeds.keys())) {
        if (!(k in next)) foldedComputeds.delete(k);
      }

      const items = resp.items.filter((n) => n.status === 'DRAFT');
      const fetched = items.length > 0 ? await batchGetNotes(items.map((d) => d.id)) : [];
      // 后端按 ids 入参顺序装配；用 id 自索引对齐，不靠下标猜。
      const byId = new Map(fetched.map((d) => [String(d.id), d]));
      for (const header of items) {
        const detail = byId.get(String(header.id));
        if (detail) {
          draftDetails[header.id] = detail.line_items;
          // 详情是 version 的更新源（列表行的 version 可能落后一拍）
          drafts.value[header.id] = { ...drafts.value[header.id], version: detail.version };
        } else if (!(header.id in draftDetails)) {
          draftDetails[header.id] = []; // 失败兜底：空数组，el-table 渲染空态
        }
      }
    } catch (e) {
      ElMessage.error((e as Error).message ?? '加载草稿列表失败');
    } finally {
      draftsLoading.value = false;
    }
  }

  /**
   * 拉单个 note 的 line_items 并写回 draftDetails（扫码命中 / 打印 / 提交前都走它）。
   * 失败 toast warning 但不阻塞主流程。失败时返回 null，让 caller 静默降级。
   */
  async function refreshDraftDetail(noteId: string): Promise<DeliveryNoteDetailData | null> {
    try {
      const detail = await getNote(noteId);
      draftDetails[noteId] = detail.line_items;
      // 同步乐观锁 version 到 drafts
      if (drafts.value[noteId]) {
        drafts.value[noteId] = { ...drafts.value[noteId], version: detail.version };
      }
      return detail;
    } catch (e) {
      ElMessage.warning(`刷新 ${noteId} 详情失败：${(e as Error).message ?? '未知错误'}`);
      return null;
    }
  }

  /** 扫码命中 / 入单成功后：把最新的单据摘要写入 drafts Map（按 id 替换）。 */
  function writeDraftFromScan(note: DeliveryNoteItemData): void {
    drafts.value = {
      ...drafts.value,
      [note.id]: note,
    };
  }

  /** 移除某折叠行对应的全部批次；成功后本地剔除并 unmark localStorage 记录。 */
  async function onRemove(d: DeliveryNoteItemData, row: MergedDraftRow): Promise<void> {
    const noteId = d.id;
    try {
      const updated = await removeBatches(noteId, {
        batch_ids: row.batch_ids,
        version: d.version,
      });
      draftDetails[noteId] = updated.line_items;
      drafts.value[noteId] = { ...drafts.value[noteId], version: updated.version };
      printedLabelStore.unmark(noteId, row.batch_ids);
      // 该表可能折叠行被剔除 → 清掉选中
      if (selectedByNote[noteId]) {
        selectedByNote[noteId] = selectedByNote[noteId].filter(
          (r) => r.batch_ids.some((b) => row.batch_ids.includes(b)) === false,
        );
      }
      ElMessage.success('已移除');
    } catch (e) {
      ElMessage.error((e as Error).message ?? '移除失败');
    }
  }

  /** 打印标签：把 selectedByNote 展平为 line_item_ids → 下载 → 写 localStorage → 清空选中。
   *
   * ⚠️ **过渡态**：后端 `/print-labels` 端点已随送货单域重构下线，本函数连同
   * `usePrintedLabels` 的绿底标记在打印对话框改本地渲染时一并删除。 */
  async function onPrintLabels(d: DeliveryNoteItemData): Promise<void> {
    const noteId = d.id;
    const rows = selectedByNote[noteId] ?? [];
    if (rows.length === 0) return;
    const lineItemIds: string[] = [];
    for (const r of rows) lineItemIds.push(...r.batch_ids);
    if (lineItemIds.length === 0) return;

    printingByNote[noteId] = true;
    try {
      const { blob, filename } = await printNoteLabels(noteId, {
        line_item_ids: lineItemIds,
      });
      triggerBrowserDownload(blob, filename);
      printedLabelStore.markPrinted(noteId, lineItemIds);
      tableRefs.get(noteId)?.clearSelection();
      selectedByNote[noteId] = [];
      ElMessage.success('已导出标签');
    } catch (e) {
      ElMessage.error((e as Error).message ?? '打印标签失败');
    } finally {
      printingByNote[noteId] = false;
    }
  }

  /** 删除草稿：二次确认 → softDeleteNote → 本地清掉所有相关 ref + localStorage。 */
  async function onDeleteDraft(d: DeliveryNoteItemData): Promise<void> {
    try {
      await ElMessageBox.confirm(
        `确认删除草稿 ${d.delivery_note_no}？关联零件会解除。`,
        '删除草稿',
        { type: 'warning', confirmButtonText: '确认删除', cancelButtonText: '取消' },
      );
    } catch {
      return;
    }
    const noteId = d.id;
    deletingByNote[noteId] = true;
    try {
      await softDeleteNote(noteId, { version: d.version });
      clearNoteLocalState(noteId);
      printedLabelStore.unmark(noteId, Object.keys(printedLabelStore.store.value[noteId] ?? {}));
      ElMessage.success('草稿已删除');
    } catch (e) {
      ElMessage.error((e as Error).message ?? '删除草稿失败');
    } finally {
      deletingByNote[noteId] = false;
    }
  }

  /** 清掉某 note 的全部本地 ref / table ref / foldedComputed。 */
  function clearNoteLocalState(noteId: string): void {
    delete drafts.value[noteId];
    delete draftDetails[noteId];
    delete selectedByNote[noteId];
    delete printingByNote[noteId];
    delete deletingByNote[noteId];
    foldedComputeds.delete(noteId);
    tableRefs.delete(noteId);
  }

  return {
    drafts: drafts as Ref<Record<string, DeliveryNoteItemData>>,
    draftDetails,
    draftsLoading,
    draftsCount,
    selectedByNote,
    printingByNote,
    deletingByNote,

    setTableRef,
    foldedRows,
    rowClassName,
    onSelectionChange,
    getSelectionSize,
    reloadDrafts,
    refreshDraftDetail,
    writeDraftFromScan,
    onRemove,
    onPrintLabels,
    onDeleteDraft,
    clearNoteLocalState,
  };
}