// composables/useDeliveryDraftBoard.ts
//
// 扫码建单页「草稿卡片列表」的业务状态 + 业务函数。
//
// 数据来源是同域 query hook（`useDeliveryDraftsQuery` = DRAFT 列表头 +
// `useDeliveryDraftsDetailQuery` = 批量详情），本 composable 负责把 query 结果
// **写穿**进本地 Map，并叠加卡片级状态（每张卡的 loading / el-table 实例 /
// 行形缓存 / 每张卡的勾选 / localStorage 已打印标签记录）。写穿而不是纯派生，是因为
// 卡片有大量本地增量更新（入单后就地替换、移除批次后就地覆盖、提交 / 删除后清 key），
// 这些更新要走 mutation + 失效，让 query 自己回流。
//
// 持有：
//   - drafts / draftDetails / draftsLoading / draftsCount
//     —— 草稿 header + line_items + 加载态 + 计数
//   - deletingByNote —— 每张草稿卡片各自的删除中 loading
//   - foldedComputeds —— per-note 的 buildPartTreeRows 缓存（保 el-table 的 :data 引用稳定）
//   - selectedRowsByNote —— 每张卡片勾选的零件 / 装配件行（「打印标签」的入参）
//   - tableRefs —— 每张卡片的 el-table 实例（子组件注册 / 反注册；移除行后清勾选用，
//     见 setTableRef 处注释）
//
// 不持有：
//   - submittingByNote（属于 useDeliveryScanSubmission，与 doSubmit 配对）
//   - 扫码相关状态（lastScanCode / scanning 等）
//   - 提交 / 打印送货单预览相关弹窗状态
//
// 子组件约定：
//   - DeliveryDraftCard 通过 props 读 drafts / rows / 各 loading 标志，
//     通过 emits 把 user action（goto-detail / remove / print-note / print-labels /
//     delete-draft / submit-draft / selection-change / set-table-ref）回给 shell。
//
// 2026-10-08 的连带变更：
// - `scope` / `scope_label` / `recent_items` 三字段消失（后端不发、前端原来还在编
//   `'L1_WIDE'` / `'按一级客户'`）；同 L1 同时只允许一张 DRAFT，scope 概念整体下线。
// - 详情缓存由 query 承担；原手搓的 `useDeliveryNoteDetailCache`（TTL Map +
//   in-flight Map）随该文件一起删除。
//
// 2026-10-09 的连带变更：
// - 卡片行形态由「同 serial_no 折叠的批次行」改为**零件 / 装配件树行**，折叠实现搬进
//   `utils/deliveryNotePartRows`（与详情页共用）；本文件的 `MergedDraftRow` /
//   `foldBySerial` 随之删除。
// - 新增 `selectedRowsByNote`：卡片加了勾选列，「打印标签」直接导出勾选行，不再经对话框。

import { computed, reactive, ref, watch, type ComputedRef, type Ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { getNote, removeBatches, softDeleteNote } from '@/api/com/deliveryNote';
import { useQueryClient } from '@tanstack/vue-query';
import { invalidateDeliveryNotesQuery } from './useDeliveryNoteListStore';
import { useDeliveryDraftsDetailQuery, useDeliveryDraftsQuery } from './useDeliveryDraftsQuery';
import { usePrintedLabels } from './usePrintedLabels';
import { buildPartTreeRows, type PartTreeRow } from '../utils/deliveryNotePartRows';
import type {
  DeliveryNoteDetailData,
  DeliveryNoteItemData,
  DeliveryNoteLineItemData,
} from './deliveryNoteSchema';

/**
 * el-table 实例 ref（不绑 FormInstance 等更复杂类型）。
 *
 * 卡片表格开了 `reserve-selection`，EP 的保留集按 row-key 记；移除一行后不清保留集，
 * 该零件被重新扫码入单时会带着上一次没出纸的勾选态回来，所以 onRemove 要拿实例调
 * `clearSelection()`。
 */
export interface DraftTableInstance {
  clearSelection: () => void;
}

export interface UseDeliveryDraftBoardReturn {
  drafts: Ref<Record<string, DeliveryNoteItemData>>;
  draftDetails: Record<string, DeliveryNoteLineItemData[]>;
  draftsLoading: Ref<boolean>;
  draftsCount: ComputedRef<number>;
  deletingByNote: Record<string, boolean>;
  setTableRef: (noteId: string, el: DraftTableInstance | null) => void;
  foldedRows: (noteId: string) => PartTreeRow[];
  /** 每张卡片勾选的零件 / 装配件行（打印标签的入参）。 */
  selectedRowsByNote: Record<string, PartTreeRow[]>;
  setSelectedRows: (noteId: string, rows: PartTreeRow[]) => void;
  rowClassName: (ctx: { row: PartTreeRow }) => string;
  /** 切 L1（写穿到两个 query 的闸门）。空串 = 清空看板。 */
  setL1Id: (l1Id: string) => void;
  refreshDraftDetail: (noteId: string) => Promise<DeliveryNoteDetailData | null>;
  writeDraftFromScan: (note: DeliveryNoteItemData) => void;
  onRemove: (d: DeliveryNoteItemData, row: PartTreeRow) => Promise<void>;
  onDeleteDraft: (d: DeliveryNoteItemData) => Promise<void>;
  clearNoteLocalState: (noteId: string) => void;
  clearAll: () => void;
}

export function useDeliveryDraftBoard(): UseDeliveryDraftBoardReturn {
  const qc = useQueryClient();

  // ============ 数据源（query）============
  const l1Id = ref<string>('');
  const draftsQuery = useDeliveryDraftsQuery(l1Id);
  /** 批量详情的入参 = 列表头里的 DRAFT 单 id（后端按 ids 顺序装配）。 */
  const draftIds = computed<string[]>(() =>
    (draftsQuery.data.value?.items ?? [])
      .filter((n) => n.status === 'DRAFT')
      .map((n) => String(n.id)),
  );
  const detailQuery = useDeliveryDraftsDetailQuery(draftIds);

  // ============ 写穿层 ============
  /** 当前 L1 下所有 DRAFT 草稿（key = note_id）—— header 摘要。 */
  const drafts = ref<Record<string, DeliveryNoteItemData>>({});
  /** 每个草稿的完整 line_items（按 note_id 存），el-table 数据源。 */
  const draftDetails = reactive<Record<string, DeliveryNoteLineItemData[]>>({});
  const draftsLoading = computed<boolean>(() => draftsQuery.isFetching.value || detailQuery.isFetching.value);
  const draftsCount: ComputedRef<number> = computed(() => Object.keys(drafts.value).length);

  // 列表头回流 → drafts Map（含「后端未严格按 status 过滤」的防御性本地过滤）。
  watch(
    () => draftsQuery.data.value,
    (data) => {
      const next: Record<string, DeliveryNoteItemData> = {};
      for (const n of data?.items ?? []) {
        if (n.status !== 'DRAFT') continue;
        next[String(n.id)] = n;
      }
      drafts.value = next;
      pruneStaleKeys(next);
    },
  );

  // 批量详情回流 → draftDetails（详情是 version 的更新源）。
  // ⚠️ data 是数组（api 层已解信封），不是 `{ items }`。
  watch(
    () => detailQuery.data.value,
    (data) => {
      for (const det of data ?? []) {
        const id = String(det.id);
        draftDetails[id] = det.line_items;
        if (drafts.value[id]) drafts.value[id] = { ...drafts.value[id], version: det.version };
      }
      for (const id of draftIds.value) {
        if (!(id in draftDetails)) draftDetails[id] = [];
      }
    },
  );

  /** 清掉「不再出现在当前结果集里」的 note 的全部本地 key。 */
  function pruneStaleKeys(next: Record<string, DeliveryNoteItemData>): void {
    for (const k of Object.keys(draftDetails)) {
      if (!(k in next)) delete draftDetails[k];
    }
    for (const k of Object.keys(deletingByNote)) {
      if (!(k in next)) delete deletingByNote[k];
    }
    for (const k of Object.keys(selectedRowsByNote)) {
      if (!(k in next)) delete selectedRowsByNote[k];
    }
    for (const k of Array.from(foldedComputeds.keys())) {
      if (!(k in next)) foldedComputeds.delete(k);
    }
    tableRefs.clear();
  }

  // ============ 每张草稿卡片各自的运行时状态 ============
  /** 每张草稿卡片各自的删除中 loading 态。 */
  const deletingByNote = reactive<Record<string, boolean>>({});

  /**
   * 每张草稿卡片各自的 el-table 实例 ref，由子组件通过 setTableRef 注册。
   *
   * 唯一读取方是 `onRemove`：卡片表格开了 `reserve-selection`，EP 的保留集按 row-key 记，
   * 移除一行后不清掉保留集，同一零件被重新扫码入单时会带着上一次没出纸的勾选态回来
   * ⇒ 移除成功后必须调实例的 `clearSelection()`。详情页那张表不经过这条注册链
   * （它自己 expose clearSelection，由 shell 接到行内 composable 的移除回调上）。
   */
  const tableRefs = new Map<string, DraftTableInstance>();

  /** 每张卡片勾选的零件 / 装配件行（「打印标签」的入参；由卡片 selection-change 写入）。 */
  const selectedRowsByNote = reactive<Record<string, PartTreeRow[]>>({});

  // ============ 行形数据缓存（per-note computed；保 data 引用稳定）============
  /**
   * `foldedRows` 在模板里被调用，裸调 `buildPartTreeRows(...)` 每次重渲染都产生新数组
   * ⇒ el-table 的 `:data` 每次都换引用，EP 当成数据源变了、整表重算（勾选态也会被
   * 无谓地重算一遍）。
   *
   * 按 note_id 缓存 computed：`draftDetails[noteId]` 与 printedLabelStore 均未变时复用
   * 同一引用，视图重渲染不再换 `:data`；数据真正变化（扫码刷新 / markPrinted / 移除）
   * 时正常重算。
   */
  const foldedComputeds = new Map<string, ComputedRef<PartTreeRow[]>>();

  /** 「已打印标签」的 localStorage 记录（模块级单例，见 usePrintedLabels）。 */
  const printedLabelStore = usePrintedLabels();
  /** 跨 note 查某个 batch 是否打过标签（buildPartTreeRows 的 isPrinted 回调）。 */
  const isPrintedBatch = printedLabelStore.isPrintedBatch;

  /** 子组件用：注册 / 反注册 el-table 实例（移除行后由 onRemove 反注册前清勾选）。 */
  function setTableRef(noteId: string, el: DraftTableInstance | null): void {
    if (el) tableRefs.set(noteId, el);
    else tableRefs.delete(noteId);
  }

  /** 按 note_id 取行形结果（命中 cache 时复用同一 ref）。 */
  function foldedRows(noteId: string): PartTreeRow[] {
    let c = foldedComputeds.get(noteId);
    if (!c) {
      // 绿底会随标记重算：`isPrintedBatch` 在本 computed 求值**期间**同步读
      // `usePrintedLabels` 的 `_store`，Vue 按「求值期间发生的 ref 读」收集依赖 ——
      // 不需要在这里显式再读一次 store。（行项目录为空时不会调 isPrinted，那种情况下
      // 结果本就是空数组，重算与否无差别。）
      c = computed(() => buildPartTreeRows(draftDetails[noteId] ?? [], isPrintedBatch));
      foldedComputeds.set(noteId, c);
    }
    return ((): PartTreeRow[] => c!.value)();
  }

  /** 卡片勾选变化：整份替换（reactive 记录要换引用才会重渲 shell）。 */
  function setSelectedRows(noteId: string, rows: PartTreeRow[]): void {
    selectedRowsByNote[noteId] = rows;
  }

  /** el-table 行已打印标签绿底。 */
  function rowClassName({ row }: { row: PartTreeRow }): string {
    return row.label_printed ? 'row-printed' : '';
  }

  // ============ L1 闸门 ============

  /** 切 L1：两个 query 的闸门都由 l1Id 驱动，写不写只决定何时开始拉。
   *  L1 未选（空串）时两个 query 的 enabled 都是 false，且看板被清空。 */
  function setL1Id(next: string): void {
    l1Id.value = next;
    if (!next) clearAll();
  }

  function clearAll(): void {
    l1Id.value = '';
    drafts.value = {};
    for (const k of Object.keys(draftDetails)) delete draftDetails[k];
    for (const k of Object.keys(deletingByNote)) delete deletingByNote[k];
    for (const k of Object.keys(selectedRowsByNote)) delete selectedRowsByNote[k];
    foldedComputeds.clear();
    tableRefs.clear();
  }

  /**
   * 拉单个 note 的 line_items 并写回 draftDetails（扫码命中 / 打印 / 提交前都走它）。
   * 失败 toast warning 但不阻塞主流程。失败时返回 null，让 caller 静默降级。
   */
  async function refreshDraftDetail(noteId: string): Promise<DeliveryNoteDetailData | null> {
    try {
      const detail = await getNote(noteId);
      draftDetails[noteId] = detail.line_items;
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

  /** 移除某行对应的全部批次；成功后本地剔除、清掉该行的勾选，并 unmark localStorage 记录。 */
  async function onRemove(d: DeliveryNoteItemData, row: PartTreeRow): Promise<void> {
    const noteId = d.id;
    try {
      const updated = await removeBatches(noteId, {
        batch_ids: row.batch_ids,
        version: d.version,
      });
      draftDetails[noteId] = updated.line_items;
      drafts.value[noteId] = { ...drafts.value[noteId], version: updated.version };
      await invalidateDeliveryNotesQuery(qc);
      // 批次已从单据上摘掉 → 清掉「已打印标签」记录，否则行再被加回来时会带着脏绿底。
      printedLabelStore.unmark(noteId, row.batch_ids);
      // `reserve-selection` 的保留集按 row-key 记，不显式清的话同一零件重新扫码入单会
      // 带着没出纸的勾选态回来。`clearSelection()` 会**同步** emit 一次
      // `selection-change: []`（EP 的 `clearSelection` 在旧选中集非空时立刻 emit），
      // shell 那份 `update:selectedRows` 随即被覆盖成空 —— 也就是**清空该卡的全部勾选**，
      // 不只是刚移除的那一行。
      tableRefs.get(noteId)?.clearSelection();
      ElMessage.success('已移除');
    } catch (e) {
      ElMessage.error((e as Error).message ?? '移除失败');
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
      // 整张草稿已删 ⇒ localStorage 里它那个「已打印标签」bucket 永远不会再被读到，
      // 不清就是无界增长（onRemove 只清被移除的那几个批次 id）。
      printedLabelStore.unmark(noteId, Object.keys(printedLabelStore.store.value[noteId] ?? {}));
      await invalidateDeliveryNotesQuery(qc);
      ElMessage.success('草稿已删除');
    } catch (e) {
      ElMessage.error((e as Error).message ?? '删除草稿失败');
    } finally {
      deletingByNote[noteId] = false;
    }
  }

  /** 清掉某 note 的全部本地 ref / table ref / foldedComputed（不动 localStorage 标记）。
   *
   *  ⚠️ 2026-10-08 补：本函数有两个调用方，只有 `onDeleteDraft` 会顺手 `unmark` 整个
   *  bucket（整单没了，那个 bucket 才真的永不被读、不清就是无界增长）。提交成功经
   *  `onDraftRemoved` 走这里时标记留着是对的 —— **recall 会把 status 退回 `DRAFT`
   *  （`line_items` 原样不动）**，撤回后同一批批次要继续显示绿底；标签已经出纸，
   *  这里清掉就是诱导重复打印。 */
  function clearNoteLocalState(noteId: string): void {
    delete drafts.value[noteId];
    delete draftDetails[noteId];
    delete deletingByNote[noteId];
    delete selectedRowsByNote[noteId];
    foldedComputeds.delete(noteId);
    tableRefs.delete(noteId);
  }

  return {
    drafts: drafts as Ref<Record<string, DeliveryNoteItemData>>,
    draftDetails,
    draftsLoading,
    draftsCount,
    deletingByNote,
    selectedRowsByNote,

    setTableRef,
    foldedRows,
    setSelectedRows,
    rowClassName,
    setL1Id,
    refreshDraftDetail,
    writeDraftFromScan,
    onRemove,
    onDeleteDraft,
    clearNoteLocalState,
    clearAll,
  };
}
