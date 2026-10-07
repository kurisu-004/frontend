// composables/useDeliveryDraftBoard.ts
//
// 扫码建单页「草稿卡片列表」的业务状态 + 业务函数。
//
// 数据来源是同域 query hook（`useDeliveryDraftsQuery` = DRAFT 列表头 +
// `useDeliveryDraftsDetailQuery` = 批量详情），本 composable 负责把 query 结果
// **写穿**进本地 Map，并叠加卡片级状态（每张卡的 loading / el-table 实例 /
// 折叠缓存 / localStorage 已打印标签记录）。写穿而不是纯派生，是因为卡片有大量
// 本地增量更新（入单后就地替换、移除批次后就地覆盖、提交 / 删除后清 key），
// 这些更新要走 mutation + 失效，让 query 自己回流。
//
// 持有：
//   - drafts / draftDetails / draftsLoading / draftsCount
//     —— 草稿 header + line_items + 加载态 + 计数
//   - deletingByNote —— 每张草稿卡片各自的删除中 loading
//   - foldedComputeds —— per-note 的 foldBySerial 缓存（保 el-table 的 :data 引用稳定）
//   - tableRefs —— 每张卡片的 el-table 实例（子组件注册 / 反注册；当前只注册不读取，
//     见 setTableRef 处注释）
//
// 不持有：
//   - submittingByNote（属于 useDeliveryScanSubmission，与 doSubmit 配对）
//   - 扫码相关状态（lastScanCode / scanning 等）
//   - 提交 / 打印预览相关弹窗状态
//
// 子组件约定：
//   - DeliveryDraftCard 通过 props 读 drafts / rows / 各 loading 标志，
//     通过 emits 把 user action（goto-detail / remove / print-note / print-labels /
//     delete-draft / submit-draft / set-table-ref）回给 shell。
//
// 2026-10-08 的连带变更：
// - `scope` / `scope_label` / `recent_items` 三字段消失（后端不发、前端原来还在编
//   `'L1_WIDE'` / `'按一级客户'`）；同 L1 同时只允许一张 DRAFT，scope 概念整体下线。
// - 详情缓存由 query 承担；原手搓的 `useDeliveryNoteDetailCache`（TTL Map +
//   in-flight Map）随该文件一起删除。

import { computed, reactive, ref, watch, type ComputedRef, type Ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { getNote, removeBatches, softDeleteNote } from '@/api/com/deliveryNote';
import { useQueryClient } from '@tanstack/vue-query';
import { invalidateDeliveryNotesQuery } from './useDeliveryNoteListStore';
import { useDeliveryDraftsDetailQuery, useDeliveryDraftsQuery } from './useDeliveryDraftsQuery';
import { usePrintedLabels } from './usePrintedLabels';
import type {
  DeliveryNoteDetailData,
  DeliveryNoteItemData,
  DeliveryNoteLineItemData,
} from './deliveryNoteSchema';

/**
 * el-table 一行 = 同 serial_no 折叠后的若干 batch；serial 为 null 时按 id 各占一行。
 *
 * `label_printed` 读 `usePrintedLabels` 的 localStorage 记录：打印对话框里
 * `mode='label'` 导出成功后写入（走 `member_ids`，即该行代表的批次 id 集合）。
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
 * el-table 实例 ref（不绑 FormInstance 等更复杂类型）。
 *
 * ⚠️ 只作**窄接口的形状锚点**：全仓没有任何读取方（见 `tableRefs` 的注释），
 * 之所以还留一个方法签名，是空接口过不了 lint。
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

export interface UseDeliveryDraftBoardReturn {
  drafts: Ref<Record<string, DeliveryNoteItemData>>;
  draftDetails: Record<string, DeliveryNoteLineItemData[]>;
  draftsLoading: Ref<boolean>;
  draftsCount: ComputedRef<number>;
  deletingByNote: Record<string, boolean>;
  setTableRef: (noteId: string, el: DraftTableInstance | null) => void;
  foldedRows: (noteId: string) => MergedDraftRow[];
  rowClassName: (ctx: { row: MergedDraftRow }) => string;
  /** 切 L1（写穿到两个 query 的闸门）。空串 = 清空看板。 */
  setL1Id: (l1Id: string) => void;
  refreshDraftDetail: (noteId: string) => Promise<DeliveryNoteDetailData | null>;
  writeDraftFromScan: (note: DeliveryNoteItemData) => void;
  onRemove: (d: DeliveryNoteItemData, row: MergedDraftRow) => Promise<void>;
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
   * ⚠️ **只写不读**：卡片表格没有 selection 列，全仓没有任何读取方。详情页那张带
   * selection 的零件列表表（DeliveryNoteLineItemsTable）自己管自己的勾选态，不经这条
   * 注册链。注册链本身留着（DeliveryDraftCard → shell 的接线真实存在），但别在注释里
   * 给它编消费者。
   */
  const tableRefs = new Map<string, DraftTableInstance>();

  // ============ 折叠数据缓存（per-note computed；保 data 引用稳定）============
  /**
   * `foldedRows` 在模板里被调用，裸调 `foldBySerial(...)` 每次重渲染都产生新数组
   * ⇒ el-table 的 `:data` 每次都换引用，EP 当成数据源变了、整表重算。
   *
   * 按 note_id 缓存 computed：`draftDetails[noteId]` 与 printedLabelStore 均未变时复用
   * 同一引用，视图重渲染不再换 `:data`；数据真正变化（扫码刷新 / markPrinted / 移除）
   * 时正常重算。
   */
  const foldedComputeds = new Map<string, ComputedRef<MergedDraftRow[]>>();

  /** 「已打印标签」的 localStorage 记录（模块级单例，见 usePrintedLabels）。 */
  const printedLabelStore = usePrintedLabels();
  /** 跨 note 查某个 batch 是否打过标签（foldBySerial 的 isPrinted 回调）。 */
  const isPrintedBatch = printedLabelStore.isPrintedBatch;

  /** 子组件用：注册 / 反注册 el-table 实例。当前只注册，无读取方（见 tableRefs 注释）。 */
  function setTableRef(noteId: string, el: DraftTableInstance | null): void {
    if (el) tableRefs.set(noteId, el);
    else tableRefs.delete(noteId);
  }

  /** 按 note_id 取 foldBySerial 结果（命中 cache 时复用同一 ref）。 */
  function foldedRows(noteId: string): MergedDraftRow[] {
    let c = foldedComputeds.get(noteId);
    if (!c) {
      // 绿底会随标记重算：`isPrintedBatch` 在本 computed 求值**期间**同步读
      // `usePrintedLabels` 的 `_store`，Vue 按「求值期间发生的 ref 读」收集依赖 ——
      // 不需要在这里显式再读一次 store。（行项目录为空时不会调 isPrinted，那种情况下
      // 结果本就是空数组，重算与否无差别。）
      c = computed(() => foldBySerial(draftDetails[noteId] ?? [], isPrintedBatch));
      foldedComputeds.set(noteId, c);
    }
    return ((): MergedDraftRow[] => c!.value)();
  }

  /** el-table 行已打印标签绿底。 */
  function rowClassName({ row }: { row: MergedDraftRow }): string {
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
      await invalidateDeliveryNotesQuery(qc);
      // 批次已从单据上摘掉 → 清掉「已打印标签」记录，否则行再被加回来时会带着脏绿底。
      printedLabelStore.unmark(noteId, row.batch_ids);
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
    foldedComputeds.delete(noteId);
    tableRefs.delete(noteId);
  }

  return {
    drafts: drafts as Ref<Record<string, DeliveryNoteItemData>>,
    draftDetails,
    draftsLoading,
    draftsCount,
    deletingByNote,

    setTableRef,
    foldedRows,
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
