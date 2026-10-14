// Tab 2「PDF 批量上传」的**提交段**（2026-10-20 从 usePartBatchPdf.ts 拆出）。
//
// 这一段是唯一会发写请求的地方：建工单（`POST /parts/batch` / `POST /api/v2/assemblies`）
// → 逐目标实体后置上传（`POST /api/v2/files/objects`）→ 汇总收口。它独立成模块的判据是
// **它是全仓唯一带「不可回滚」语义的段落**：工单一落库就撤不回来，所以这一段的每一条
// 分支都在回答同一个问题「这次提交还能不能安全地再来一次」。这段的代码一旦与解析 /
// 回填混在一个文件里，那条「绝不重复建单」的约束就要靠通读全文才能验证。
//
// 三段状态机（`idle → creating → uploading → done`）及其全部派生（按钮文案、失败清单、
// 重试集合）都在这里；草稿持久化也在这一段 —— 它监听 `commitStage`，且由 `onSubmit` 在
// 建单前 flush、由收口在成功后 clear。
//
// 依赖：共享状态层 + 行段（`effectiveChildren` / `totalAssemblyChildren`）+ 上传 job 子系统
// （`usePartBatchPdfUploads`）。解析段与回填段的状态（源、行、Excel 快照）都只经状态层
// 读入，本段不再 import 那两个工厂。
//
// 「一批上传作业」的登记 / 调度 / 状态格 / 失败清单在上传 job 子系统里（2026-10-21 拆出，
// 见 `usePartBatchPdfUploads.ts` 文件头）。本段保留的是**阶段机与收口**：三段状态迁移、
// 建单两路、草稿落库 / 清场、以及收口后的清场与跳页。本段没有一个纯上传的派生被留在外面
// 复述 —— `getRowPdfCell` / `getRowThreeDCell` 是转发，不是实现。

import { computed, watch, type ComputedRef } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useRouter } from 'vue-router';
import { batchCreateParts } from '@/api/parts';
import type { PartBatchCreatePayload, PartBatchResult } from '@/api/parts';
import { createAssembly } from '@/api/assembly';
import type { AssemblyCreatePayload } from '@/types/assembly';
import { runWithConcurrency, toMoneyString } from './usePartBatchShared';
import { usePartsNewDraft } from './usePartsNewDraft';
import type {
  SerializedAssemblyChildRow,
  SerializedAssemblyRow,
  SerializedPdfTab,
  SerializedStandalonePartRow,
} from './usePartsNewDraft';
import type { PdfBatchState } from './usePartBatchPdfState';
import type { UsePartBatchPdfRows } from './usePartBatchPdfRows';
import { usePartBatchPdfUploads } from './usePartBatchPdfUploads';
import type {
  AssemblyChildRow,
  AssemblyGroupFailure,
  AssemblyRow,
  StandalonePartRow,
  UploadJob,
  UploadStatusCell,
} from './usePartBatchPdfTypes';

export interface UsePartBatchPdfSubmit {
  createdCounts: ComputedRef<{ parts: number; assemblies: number; total: number }>;
  canSubmit: ComputedRef<boolean>;
  submitLabel: ComputedRef<string>;
  cellRetryDisabled: ComputedRef<boolean>;
  getRowPdfCell: (row: { pdfSourceUid: string | null }) => UploadStatusCell | undefined;
  getRowThreeDCell: (row: { three_d_index: number | null }) => UploadStatusCell | undefined;
  retryUploadByCell: (jobKey: string) => Promise<void>;
  onSubmit: () => Promise<void>;
  retryFailedUploads: () => Promise<void>;
  /** 组件卸载前收尾：刷新草稿快照 + 撤掉 pending saver（避免 debounce 写 stale state）。 */
  flushDraftOnUnmount: () => void;
}

export function usePartBatchPdfSubmit(
  state: PdfBatchState,
  rowSeg: UsePartBatchPdfRows,
): UsePartBatchPdfSubmit {
  const router = useRouter();
  const {
    successNextTab,
    pdfForm,
    allPdfs,
    selectedPages,
    standaloneParts,
    assemblies,
    threeDModelFiles,
    excelByDrawingNo,
    excelFiles,
    pdfFiles,
    pdfSubmitting,
    commitStage,
    createdTargets,
    itemRowUids,
    uploadJobs,
    failedJobs,
  } = state;
  const { effectiveChildren, totalAssemblyChildren } = rowSeg;

  /**
   * 上传 job 子系统（登记 / 调度 / 状态格 / 失败清单 / 清场 / 世代号）。它与本段之间
   * 只有「阶段机」这一个耦合点：本段转 `commitStage`，子系统的任何一个函数都不碰它。
   */
  const uploads = usePartBatchPdfUploads(state, rowSeg);

  /**
   * 2026-10-05 定：装配件建单的并发上限（`POST /assemblies`，每组一次请求）。
   *
   * 不沿用上传侧的并发上限（图纸 / 3D 上传是 6，见 `usePartBatchPdfUploads`）：那个值的
   * 瓶颈是**字节流**（整份 multipart 进后端内存），装配件建单一个请求只发几 KB JSON，
   * 字节维度根本不是约束。装配件建单的真实约束在服务端写事务：每组要派 1 个装配件流水号
   * （`t_serial_counter` 上一次 UPSERT）+ 1 条 `t_assembly` + N 条 `t_part` INSERT，
   * 组数一多请求就在同一张计数表上排队。
   *
   * 取 3 而不是串行：一次批量导入的装配件组数是个位数（合并多页 PDF 才能凑出一组），
   * 串行会把每组的往返时间线性叠加；3 路足够把等待摊薄，又把同一 L1 客户计数表上的
   * 并发写压到很低。也不取更高：组数本就少，再高只增加计数表争用，收益为零。
   */
  const ASSEMBLY_CREATE_CONCURRENCY = 3;

  /** 转发：某行的 PDF 状态格由 job 子系统按 cell 表推导（无原件的实体不占格）。 */
  function getRowPdfCell(row: { pdfSourceUid: string | null }): UploadStatusCell | undefined {
    return uploads.getRowPdfCell(row);
  }
  /** 转发：某行的 3D 状态格，同上。 */
  function getRowThreeDCell(row: { three_d_index: number | null }): UploadStatusCell | undefined {
    return uploads.getRowThreeDCell(row);
  }

  /** 已建出实体按表计数（提示文案 / 主按钮文案用；装配件子件计入 `parts`）。 */
  const createdCounts = computed<{ parts: number; assemblies: number; total: number }>(() => {
    let parts = 0;
    let assemblies = 0;
    for (const v of createdTargets.values()) {
      if (v.target === 'assembly') assemblies += 1;
      else parts += 1;
    }
    return { parts, assemblies, total: parts + assemblies };
  });

  /** 转发：是否有 job 上传失败（主按钮 disabled + 重试分支的判据）。 */
  const hasUploadErrors = uploads.hasUploadErrors;

  /** 转发：失败 job 数（按钮文案用，口径与失败清单的行一一对应）。 */
  const failedJobCount = uploads.failedJobCount;

  /** 转发：工单已建但 job 列表没登记上（可现场重建补传）。 */
  const needsUploadRebuild = uploads.needsUploadRebuild;

  /**
   * 汇总上传结果：无失败 → 提示 + 清空跳页；有失败 → 弹清单 + 保留现场供重试。
   *
   * **前提**：行集合自本轮上传起跑时的世代快照以来没被改过（见开头的世代校验）。收口的
   * 计数 / 清场 / 跳页全部以「当前表格 == 建单时那张表」为前提，不成立就只能如实告知。
   *
   * 计数口径统一为 **job**（一个目标实体 × 一份原件 = 一项），与下面清单的行一一对应：
   * 同一份文件被多个实体引用时是多项，标题若按「文件数」算就会出现「1 个文件失败」
   * 底下列两行实体号的矛盾。涉及的目标实体数 / 文件数作为补充信息一并给出。
   *
   * 成功判据是「**全部已登记 job 都判成功**」，不是「failedJobs 为空」：登记 / 调度
   * 被打断时，未被调度的 job 停在 `pending` 且不在 `failedJobs` 里，只看 failedJobs 会
   * 把「一个文件都没传上去」当成功收口（清空现场 + 跳页）。未完成的先补记进
   * `failedJobs` 再弹清单。`uploadJobs` 为空但工单已建（job 构造抛错）同样不算成功。
   */
  function summarizeUploads(): void {
    // 2026-10-04 世代校验，必须**先于**任何收口动作。行集合在提交期间被换过（重新解析
    // 会把 `createdTargets` 一并清空、行 uid 全部换新）时，下面的计数 / 清场 / 跳页
    // 都对不上当前表格：走成功收口会把用户刚建好的行静默清掉、跳到零件列表、再弹一条
    // 「成功创建 0 条零件」的假提示，而工单其实已经落库了。
    if (!uploads.rowsUnchangedSinceEpoch()) {
      const lost = failedJobs.size > 0 ? `其中 ${failedJobs.size} 项文件未上传成功。\n` : '';
      ElMessageBox.alert(
        `工单已经创建，但提交期间本地表格被改过，本次结果已无法与当前表格对应。\n` +
          `${lost}\n已创建的工单请到零件列表 / 装配件列表查看，图纸可在详情页补传。`,
        '提交结果请到列表核对',
        { type: 'warning' },
      );
      return;
    }
    uploads.settleUnfinishedJobs();
    if (uploadJobs.value.length === 0 && createdTargets.size > 0) {
      ElMessageBox.alert(
        `工单已创建 ${createdCountText()}，但文件一个都没上传（上传任务没能登记）。\n\n可在本页点「重试上传」补传（不会重复建单）。`,
        '文件上传未开始',
        { type: 'error' },
      );
      return;
    }
    if (failedJobs.size > 0) {
      const lines = uploads.failedJobLines();
      const ownerCount = new Set(Array.from(failedJobs.values(), (f) => f.job.ownerId)).size;
      const fileCount = new Set(Array.from(failedJobs.values(), (f) => f.job.jobKey)).size;
      const sample = lines.slice(0, 5).join('\n');
      const more = lines.length > 5 ? `\n…还有 ${lines.length - 5} 项失败` : '';
      ElMessageBox.alert(
        `工单已创建，但 ${failedJobs.size} 项上传失败（涉及 ${ownerCount} 个工单 / ${fileCount} 个文件）：\n${sample}${more}\n\n可在本页重试上传（不会重复建单）。`,
        '文件上传失败',
        { type: 'warning' },
      );
      return;
    }
    // 2026-10-05：装配件子件挂上 assembly_id 后**不会**出现在零件一览（列表的 part 段是
    // `WHERE assembly_id IS NULL`），只有装配件父行进列表 ⇒ 成功提示里必须说清子件去哪看。
    // 装配件子件本身就是 t_part 行、已经含在 `parts` 里，所以显式点明其中几条是子件，
    // 免得读成「零件和子件是两批」。
    const c = createdCounts.value;
    const childCount = createdChildCount();
    const segs: string[] = [];
    if (c.parts > 0) {
      segs.push(
        c.assemblies > 0
          ? `${c.parts} 条零件（其中 ${childCount} 个为装配件子件）`
          : `${c.parts} 条零件`,
      );
    }
    if (c.assemblies > 0) segs.push(`${c.assemblies} 个装配件`);
    const hint = c.assemblies > 0 ? '\n子件不在零件一览里，请到装配件详情页查看。' : '';
    ElMessage.success(`成功创建 ${segs.join(' + ') || '0 条'}${hint}`);
    // 2026-10-04：草稿在这里才清 —— 还有上传失败就必须留着（工单已落库，图样要靠本页
    // 的 job 现场补传）。注意草稿对 Tab 2 是**只写**的（`pdf_tab` 段没有回读路径，
    // 刷新后表格本来就是空的），清掉它不代表行可恢复。⚠️ **顺序承重**：`saver.cancel()`
    // 必须在 `draft.clear()` 之前 —— 反过来就是「先清空、再让一个已排期的 saver 把清空
    // 前的现场写回盘上」。
    draft.saver.cancel();
    draft.clear();
    allPdfs.value = [];
    standaloneParts.value = [];
    assemblies.value = [];
    selectedPages.value = new Set();
    pdfFiles.value = [];
    excelFiles.value = [];
    // 2026-10-03：Excel 文件已清空 → 解析结果同步作废（下一批是新数据）。
    excelByDrawingNo.value = null;
    threeDModelFiles.value = [];
    uploads.clearAllJobs();
    createdTargets.clear();
    itemRowUids.value = [];
    successNextTab.value = 'manual';
    router.push('/parts?status=PENDING');
  }

  const draft = usePartsNewDraft();

  // ============================================================
  // draft 持久化：监听 rows / assemblies 变更 → debounce 500ms 写 localStorage
  // ============================================================
  //
  // 写时机：rows / assemblies 任意字段变化 → schedule saver（debounce 500ms 合并）；
  // 建单前 → saver.flush()（把当前现场固化进 localStorage）；全部上传成功 → clearDraft。
  //
  // 2026-09-18 B1 修复：cross-tab clobber。原来 PDF Tab saver 写整个 payload 时
  // 把 manual_tab 覆盖为 `{ staged: [] }`（PDF Tab 不写 manual 段），Manual Tab
  // saver 同样覆盖 pdf_tab 为空。两 Tab 共享同 key 时 debounce 竞争，后者覆盖
  // 前者。本次改为：schedule 前先读旧 payload（draft.load()），仅覆盖本 Tab 段，
  // 另一 Tab 段保留。代价：每次 schedule 多一次 localStorage 读（仍在 500ms
  // debounce 窗口内合并，开销可接受）。
  if (draft.userId) {
    watch(
      () =>
        [
          pdfForm.customerL1Id,
          pdfForm.requestDate,
          commitStage.value,
          JSON.stringify(serializePdfTab()),
        ] as const,
      () => {
        const prev = draft.load();
        const basePayload = {
          active_tab: prev?.active_tab ?? 'pdf',
          saved_at: new Date().toISOString(),
          pdf_tab: serializePdfTab(),
          // 保留 manual_tab 旧值；只有 Manual Tab 自己的 saver 会更新 manual_tab 段
          manual_tab: prev?.manual_tab ?? { staged: [] },
        };
        draft.saver.schedule(basePayload);
      },
    );
  }

  /**
   * 把当前 PDF Tab state 序列化成 SerializedPdfTab 形态（不含 File / Blob）。
   * 详见 usePartsNewDraft.SerializedPdfTab。
   */
  function serializePdfTab(): SerializedPdfTab {
    return {
      customerL1Id: pdfForm.customerL1Id,
      requestDate: pdfForm.requestDate,
      rows: standaloneParts.value.map(serializeStandalonePartRow),
      assemblies: assemblies.value.map(serializeAssemblyRow),
      selectedPages: Array.from(selectedPages.value),
    };
  }

  /** 单个 standalone part row → SerializedStandalonePartRow。 */
  function serializeStandalonePartRow(r: StandalonePartRow): SerializedStandalonePartRow {
    return {
      uid: r.uid,
      pdfSourceUid: r.pdfSourceUid,
      pageCount: r.pageCount,
      ...(r.mergedFrom ? { mergedFrom: r.mergedFrom } : {}),
      drawing_no: r.drawing_no,
      name: r.name,
      applicant_name: r.applicant_name,
      customer_id: r.customer_id,
      customer_name: r.customer_name,
      request_date: r.request_date,
      planned_delivery_date: r.planned_delivery_date,
      system_delivery_date: r.system_delivery_date,
      order_no: r.order_no,
      note: r.note,
      is_urgent: r.is_urgent,
      quantity: r.quantity,
      unit_price: r.unit_price,
      total_price: r.total_price,
      three_d_index: r.three_d_index,
    };
  }

  /** 单个 assembly row → SerializedAssemblyRow（含 children 递归）。 */
  function serializeAssemblyRow(a: AssemblyRow): SerializedAssemblyRow {
    return {
      uid: a.uid,
      pdfSourceUid: a.pdfSourceUid,
      drawing_no: a.drawing_no,
      name: a.name,
      applicant_name: a.applicant_name,
      customer_id: a.customer_id,
      customer_name: a.customer_name,
      request_date: a.request_date,
      planned_delivery_date: a.planned_delivery_date,
      system_delivery_date: a.system_delivery_date,
      order_no: a.order_no,
      note: a.note,
      is_urgent: a.is_urgent,
      masterPageIndex: a.masterPageIndex,
      quantity: a.quantity,
      unit_price: a.unit_price,
      total_price: a.total_price,
      children: a.children.map(serializeAssemblyChildRow),
    };
  }

  function serializeAssemblyChildRow(c: AssemblyChildRow): SerializedAssemblyChildRow {
    return {
      uid: c.uid,
      pdfSourceUid: c.pdfSourceUid,
      page_index: c.page_index,
      drawing_no: c.drawing_no,
      name: c.name,
      quantity: c.quantity,
      is_urgent: c.is_urgent,
      request_date: c.request_date,
      planned_delivery_date: c.planned_delivery_date,
      system_delivery_date: c.system_delivery_date,
      order_no: c.order_no,
      note: c.note,
      unit_price: c.unit_price,
      total_price: c.total_price,
      three_d_index: c.three_d_index,
    };
  }

  /** 是否可以点主按钮：idle 态有内容可提交；done 态还有失败 job 或待重建的 job 列表。 */
  const canSubmit = computed<boolean>(() => {
    if (commitStage.value === 'done') return hasUploadErrors.value || needsUploadRebuild.value;
    if (commitStage.value !== 'idle') return false;
    return standaloneParts.value.length > 0 || assemblies.value.length > 0;
  });

  /**
   * 主按钮文案（提交 / 进行中 / 重试三态）。
   *
   * done 态统一是「重试上传（N 项）」：N 取失败 job 数；job 列表没登记上时取已建工单
   * 数（每条工单至少要补一份图纸），点下去是「现场重建 job 再补传」，同样不建单。
   */
  const submitLabel = computed<string>(() => {
    if (commitStage.value === 'creating') return '正在创建工单…';
    if (commitStage.value === 'uploading') return '正在上传图纸…';
    if (commitStage.value === 'done') {
      const n = hasUploadErrors.value ? failedJobCount.value : createdCounts.value.total;
      if (n > 0) return `重试上传（${n} 项）`;
    }
    const partCount =
      standaloneParts.value.length + assemblies.value.length + totalAssemblyChildren.value;
    return `提交创建（${partCount} 个零件）`;
  });

  /** 行内「重试」按钮的 disabled 判据：补传在途时置灰。 */
  const cellRetryDisabled = computed<boolean>(
    () => pdfSubmitting.value || commitStage.value !== 'done',
  );

  /**
   * UI 调用：行内单文件重试。`jobKey` 取该 cell 自身的 key，**只重跑该 key 下仍在
   * 失败的 job**（同一份文件被多个 part 共享时，已成功的那些不会重传）。
   * 收尾与 retryFailedUploads 对称：跑完必须 summarizeUploads —— 否则最后一个错误
   * 修好后页面停在「无失败但按钮禁用」的态，既不提示也不跳页。
   *
   * 开头的 `pdfSubmitting` 闸门挡住连点：同一批 job 重入会稳定撞后端唯一索引 21108。
   */
  async function retryUploadByCell(jobKey: string): Promise<void> {
    if (pdfSubmitting.value) return;
    const jobs = uploadJobs.value.filter((j) => j.jobKey === jobKey && failedJobs.has(j.id));
    if (jobs.length === 0) {
      ElMessage.warning('该文件没有待重试的记录，请重新提交');
      return;
    }
    uploads.beginUploadEpoch();
    pdfSubmitting.value = true;
    try {
      await uploads.runUploadJobs(jobs);
    } finally {
      pdfSubmitting.value = false;
    }
    summarizeUploads();
  }

  /** 前端兜底：所有 row 的 customer_id 必须已指定客户（后端强校验「必须是叶子」，20104）。
   *  返回 true 表示通过，false 表示阻塞；阻塞时已通过 ElMessage.warning 提示。 */
  function validateLeafCustomers(): boolean {
    const missing: string[] = [];
    for (const r of standaloneParts.value) {
      if (!r.customer_id) missing.push(`独立零件 ${r.drawing_no || r.uid}`);
    }
    for (const a of assemblies.value) {
      if (!a.customer_id) missing.push(`装配件 ${a.drawing_no || a.uid}`);
    }
    if (missing.length > 0) {
      ElMessage.warning(
        `以下 ${missing.length} 行未指定客户（单据只能挂在末级部门），请补全后再提交：\n` +
          missing.slice(0, 5).join('\n') +
          (missing.length > 5 ? '\n…' : ''),
      );
      return false;
    }
    return true;
  }

  /** 独立零件行 → `POST /parts/batch` 的 item（不含文件：文件走后置上传）。
   *
   * 2026-10-05：**只含独立零件**。装配件不再展平成 N+1 个独立 part —— `POST /parts/batch`
   * 端点内没有 assembly 概念，展平的结果是 `t_assembly` 一行不涨、子件的 `assembly_id`
   * 全 NULL。装配件改走树形端点 `POST /api/v2/assemblies`（见 `buildAssemblyPayload`）。
   *
   * 顺序必须与 `res.created[].sourceIndex` 的坐标系一致（`rowUids[i]` ↔ `items[i]`）。
   * 金额经 `toMoneyString` 带上（2 位小数字符串，缺价时为 undefined → 键不生效，
   * 后端落 0），与独立零件 / 装配件 / 子件三层保持同一口径。 */
  function buildCommitItems(): { items: PartBatchCreatePayload[]; rowUids: string[] } {
    const items: PartBatchCreatePayload[] = [];
    const rowUids: string[] = [];
    for (const r of standaloneParts.value) {
      rowUids.push(r.uid);
      items.push({
        name: r.name || r.drawing_no,
        drawing_no: r.drawing_no,
        applicant_name: r.applicant_name,
        applicant_id: null,
        quantity: r.quantity,
        request_date: r.request_date,
        planned_delivery_date: r.planned_delivery_date || r.request_date,
        is_urgent: r.is_urgent,
        order_no: r.order_no,
        system_delivery_date: r.system_delivery_date,
        note: r.note,
        customer_id: r.customer_id,
        // 2026-10-05：含税单价 / 总价随建单一起发（此前三层同时丢弃，表格里填的价
        // 永远落不了库）。`toMoneyString` 保证 2 位小数标度，缺价时给 undefined
        // 而不是 null / '0' —— 让「没填价」与「填了 0 元」在请求体里可区分。
        unit_price: toMoneyString(r.unit_price),
        total_price: toMoneyString(r.total_price),
      });
    }
    return { items, rowUids };
  }

  /**
   * 装配件行 → `POST /api/v2/assemblies` 的 `data` JSON（**不传 PDF**）。
   *
   * 一次请求建出 `t_assembly` 顶层 + 全部 `t_part` 子件（子件的 `assembly_id` 指向顶层）。
   * 后端该端点现在**无条件**派序列号、**无条件**建子件（2026-10-05 放开），所以不传
   * PDF 也能建出完整的装配件；总装图走 `POST /api/v2/files/objects` 单独上传
   * （那个端点才真入库，存 kind=ASSEMBLY_MASTER）。
   *
   * 金额一律过 `toMoneyString`：`unit_price` / `total_price` 是 rust `rust_decimal` +
   * `serde-with-str`，只认 JSON 字符串。
   */
  function buildAssemblyPayload(a: AssemblyRow): AssemblyCreatePayload {
    return {
      name: a.name || a.drawing_no || `装配件-${a.uid}`,
      drawing_no: a.drawing_no,
      // 必须是叶子客户，后端强校验（20104）；空值由 validateLeafCustomers 挡在前头。
      customer_id: a.customer_id,
      applicant_name: a.applicant_name,
      request_date: a.request_date,
      planned_delivery_date: a.planned_delivery_date || a.request_date,
      is_urgent: a.is_urgent,
      /** 顶层是**套数**。 */
      quantity: a.quantity,
      unit_price: toMoneyString(a.unit_price),
      total_price: toMoneyString(a.total_price),
      order_no: a.order_no,
      system_delivery_date: a.system_delivery_date,
      note: a.note,
      children: effectiveChildren(a).map((c, i) => ({
        name: c.name || `子件${i + 1}`,
        drawing_no: c.drawing_no,
        quantity: c.quantity,
        planned_delivery_date: c.planned_delivery_date || c.request_date,
        // 子件单价不从 Excel 继承（Excel 是整套口径，摊到 N 个子件会重复计价 N 倍），
        // 只有用户在子件行手填过才会发出去。
        unit_price: toMoneyString(c.unit_price),
        total_price: toMoneyString(c.total_price),
      })),
    };
  }

  /**
   * 后端业务错误码是 5 位（`1xxxx`–`5xxxx`）；`api/http.ts` 在拿不到 `{code,message,data}`
   * 信封时用 HTTP 状态码（网络错误是 0）兜底 ⇒ `code >= 10000` 才代表「后端处理过这次
   * 请求」。事务内的 DB / 内部错误（50001 / 50000）同样是 5 位、同样已回滚 ⇒ 归
   * `rejected`（该组一定没建出，重提安全）；它们不是「客户数据不合法」意义上的拒绝，
   * 但对「会不会重复建单」这个问题答案一样。
   */
  function isDefinitiveApiRejection(e: unknown): boolean {
    const code = (e as { code?: unknown } | null)?.code;
    return typeof code === 'number' && code >= 10000;
  }

  /**
   * 逐个装配件发 `POST /api/v2/assemblies`（受控并发 `ASSEMBLY_CREATE_CONCURRENCY`），
   * **逐组 try/catch、不整体 reject**，并把建出的实体写进 `createdTargets`。
   *
   * 心智模型与 `batchCreateParts` 一致：该端点无幂等键，一个组装配件 400（比如 20308
   * L1 客户没有 `serial_prefix`）绝不能让其它已建好的组在 UI 上消失。
   *
   * **记账的不变量（双向）**：
   *  1. 记了账的必真实存在（`createdTargets` 里每条都对应服务端的一行）；
   *  2. 建出来的必都记上账（否则那行的图纸永不上传，且本页再也够不着它 —— 行会被
   *     `dropCreatedRows` 整行摘掉）。
   * ⇒ 响应只要对不上请求（子件数不一致 / 某个子件缺 id / 子件顺序错位），**整组不记账**，
   * 落进 `unknown` 分支：行留在表里、如实告诉用户「先到装配件列表核对」。宁可让用户
   * 多核对一次，也不能出现「顶层已建、子件没建全/挂错行」的状态。
   */
  async function createAssemblyGroups(rows: AssemblyRow[]): Promise<AssemblyGroupFailure[]> {
    const failures: AssemblyGroupFailure[] = [];
    if (rows.length === 0) return failures;
    await runWithConcurrency(rows, ASSEMBLY_CREATE_CONCURRENCY, async (a) => {
      const label = a.drawing_no || a.name || `装配件-${a.uid}`;
      // 2026-10-05：请求里的子件 = effectiveChildren（被指定为总装图的那一页不算子件）。
      // 算一次存局部变量：下面的长度校验与按下标逐个对账必须用**同一份**数组。
      const effChildren = effectiveChildren(a);
      try {
        const res = await createAssembly(buildAssemblyPayload(a));
        const children = res?.created_children;
        if (!res?.assembly?.id || !Array.isArray(children)) {
          throw new Error('响应缺少 assembly / created_children（可能被网关拦截）');
        }
        if (children.length !== effChildren.length) {
          throw new Error(
            `子件数量与请求不一致（请求 ${effChildren.length} 个，响应 ${children.length} 个）`,
          );
        }
        // 2026-10-05：`created_children[i]` 要按下标对回本地子件行（后端按入参顺序建子件，
        // 序列号 `{asm_serial}-{i:02d}` 1-based）。**同长度但错序是静默数据损坏**：子件 A
        // 的图纸会挂到子件 B 上（part id 只是 id，后端不校验）⇒ 不报错、不进失败清单、
        // 最后弹「成功」。所以用后端回显的 drawing_no 逐个对账，不符即整组不记账。
        // 只容忍 null / 空白差异（空图号在库里是 NULL、回显也就 null），真实值不一致一律
        // 当错序处理。
        //
        // 2026-10-11 能力收窄：子件图号不再拼后缀，全部与装配件一致 ⇒ 本对账**只能查出
        // 图号真的不同**（回显了别的装配件的子件、被截断、被转义），查不出「N 个子件之间
        // 纯错序」—— 那 N 个子件在建单请求里除 page_index 外逐字段相同，而后端不回显
        // page_index，前端手上没有任何可区分的锚点。这是「子件图号与装配件一致」这一产品
        // 取意的必然结果，不是漏做。
        children.forEach((child, i) => {
          if (!child?.id) throw new Error(`响应第 ${i + 1} 个子件缺 id`);
          if ((child.drawing_no ?? '').trim() !== effChildren[i]!.drawing_no.trim()) {
            throw new Error(
              `子件顺序与请求不一致（请求第 ${i + 1} 个是 ${effChildren[i]!.drawing_no || '（空图号）'}，` +
                `响应是 ${child.drawing_no || '（空图号）'}）`,
            );
          }
        });
        // 顶层 + 子件同进同出（一次请求一个事务）
        createdTargets.set(a.uid, { target: 'assembly', id: String(res.assembly.id) });
        children.forEach((child, i) => {
          createdTargets.set(effChildren[i]!.uid, { target: 'part', id: String(child!.id) });
        });
      } catch (e) {
        failures.push({
          rowUid: a.uid,
          label,
          error: (e as Error).message ?? '创建失败',
          // 只有带 5 位业务码的 ApiError 才是「后端明确拒了」；本文件自造的响应形状错误
          // 与网络错误都没有 code，一律按「可能已落库」的 unknown 上报。
          outcome: isDefinitiveApiRejection(e) ? 'rejected' : 'unknown',
        });
      }
    });
    // 失败清单按表格顺序展示（并发下完成顺序不定）
    const order = new Map(rows.map((a, i) => [a.uid, i]));
    failures.sort((x, y) => (order.get(x.rowUid) ?? 0) - (order.get(y.rowUid) ?? 0));
    return failures;
  }

  /**
   * 把 `createdTargets` 里的那些行从本地表格移走。
   *
   * 这些行对应的工单已经是服务端里的真实记录了，留在表内只会诱导「再点一次提交」
   * ⇒ 重复建单。`itemRowUids` 保持原样（补传 job 仍要靠它把 id 对回 PDF）。
   *
   * 独立零件按行摘。装配件按**组**摘：一次 `POST /assemblies` 建出顶层 + 全部子件，
   * 记账也是整组记的（`createAssemblyGroups` 保证 map 里每条记录都真实存在），所以
   * 顶层建出即整行完成、整行摘掉；没记账的组（明确被拒 / 成败未知）整行留在表里。
   * `allPdfs` 里的原件一律留着（源文件区仍可预览，也不参与提交）。
   */
  function dropCreatedRows(): void {
    standaloneParts.value = standaloneParts.value.filter(
      (r) => createdTargets.get(r.uid)?.target !== 'part',
    );
    assemblies.value = assemblies.value.filter(
      (a) => createdTargets.get(a.uid)?.target !== 'assembly',
    );
  }

  /** 已建出实体的一句话计数（「N 条零件 + M 个装配件」，无则给 0 条）。 */
  function createdCountText(): string {
    const c = createdCounts.value;
    const segs: string[] = [];
    if (c.parts > 0) segs.push(`${c.parts} 条零件`);
    if (c.assemblies > 0) segs.push(`${c.assemblies} 个装配件`);
    return segs.join(' + ') || '0 条';
  }

  /**
   * 已记账的装配件子件数。子件是 `t_part` 行、已经含在 `createdCounts().parts` 里，
   * 这里单独数出来只为文案说清「零件那 N 条里有几条是子件」。
   * 从 `createdTargets` 数而不是 `totalAssemblyChildren`（那是表内行数，与「建出了几个」
   * 不是一回事），保证文案里的两个数字永远自洽。
   */
  function createdChildCount(): number {
    let n = 0;
    for (const a of assemblies.value) {
      for (const c of effectiveChildren(a)) {
        if (createdTargets.get(c.uid)?.target === 'part') n += 1;
      }
    }
    return n;
  }

  /**
   * 建单「有行没建出来」的清单文案。四个来源各自成段：
   * 独立零件逐行被拒 / 独立零件整组请求失败（成败未知）/ 装配件组被拒 / 装配件组成败未知。
   */
  function buildCreateFailureText(
    res: PartBatchResult | null,
    asmFailures: AssemblyGroupFailure[],
  ): string {
    const parts: string[] = [];
    if (res) {
      const sample = res.failed
        .slice(0, 5)
        .map((f) => `第 ${f.index + 1} 行：${f.message}`)
        .join('\n');
      const more = res.failed.length > 5 ? `\n…还有 ${res.failed.length - 5} 行被拒绝` : '';
      if (res.failed.length > 0)
        parts.push(`${res.failed.length} 行被服务端拒绝：\n${sample}${more}`);
      const groupLines = (res.groupErrors ?? []).map(
        (g) => `第 ${g.startIndex + 1}-${g.endIndex + 1} 行（客户 ${g.customer_id}）：${g.message}`,
      );
      if (groupLines.length > 0) {
        parts.push(
          `${groupLines.length} 个客户组请求失败，成功与否未知（响应丢失时后端可能已落库）：\n${groupLines
            .slice(0, 3)
            .join('\n')}`,
        );
      }
    }
    const rejected = asmFailures.filter((f) => f.outcome === 'rejected');
    const unknown = asmFailures.filter((f) => f.outcome === 'unknown');
    if (rejected.length > 0) {
      parts.push(
        `${rejected.length} 个装配件服务端拒绝：\n${rejected
          .slice(0, 5)
          .map((f) => `装配件 ${f.label}：${f.error}`)
          .join('\n')}`,
      );
    }
    if (unknown.length > 0) {
      parts.push(
        `${unknown.length} 个装配件成功与否未知（网络失败 / 响应形状异常时后端可能已落库）：\n${unknown
          .slice(0, 5)
          .map((f) => `装配件 ${f.label}：${f.error}`)
          .join('\n')}`,
      );
    }
    if (parts.length === 0) return '没有任何一行建出。';
    const c = createdCounts.value;
    const head = c.total > 0 ? `已创建 ${createdCountText()}；` : '';
    const hint = c.assemblies > 0 ? '\n装配件子件不在零件一览里，请到装配件详情页查看。' : '';
    // 「先核对再重提」这句是**承重**的，不是客套：`t_assembly.drawing_no` 与
    // `t_part.drawing_no` 都没有唯一索引（只有 serial_no 唯一）⇒ 重提一个已建出的组会
    // **完全静默**地建出第二份，没有任何 DB 报错能兜住。前端对 `unknown` 组拿不到定论，
    // 那句提示就是用户唯一的防重复建单防线。
    return (
      `${head}${parts.join('\n\n')}\n` +
      `已创建的工单尚未上传图纸，可在详情页补传。\n建成的行已从表格移除，` +
      `直接重新提交只会发出剩下的行。` +
      (parts.some((p) => p.includes('成功与否未知'))
        ? '\n重新提交前请先到零件 / 装配件列表核对，避免重复建单。'
        : '') +
      hint
    );
  }

  /**
   * 主按钮：创建工单 + 逐实体后置上传图纸 / 3D（单入口，2026-10-04）。
   *
   * creating 阶段分两路（2026-10-05）：
   *  1. 独立零件行 → `batchCreateParts`（一次请求，`batchCreateParts` 内部按客户分组、
   *     逐组 try/catch 聚合，从不整体 reject）；
   *  2. 装配件行 → `createAssemblyGroups`（逐组一次 `POST /assemblies`，受控并发，
   *     逐组 try/catch）。
   *
   * **先独立零件后装配件**：装配件那路自己吞掉所有错误，零件这路抛错只可能来自
   * `batchCreateParts` 自身（它不整体 reject）⇒ 万一抛错时装配件还没建，回 idle 让用户
   * 重来不会碰到已落库的工单；反过来（先装配件）就会落进「已建出但一条上传都没发」的
   * done 态分支。
   *
   * 两路的失败**合并**成一次 `ElMessageBox.alert` 汇总：任一路有行没建出就整轮不上传
   * （与既有口径一致：已建出的行移出表格、剩下的留在表里等下一次提交，图纸可到详情页
   * 补传）。装配件子件挂上 `assembly_id` 后不进入零件一览，只有装配件父行进列表 ⇒
   * 成功提示与失败提示都会告诉用户「子件在装配件详情页看」。
   */
  async function onSubmit(): Promise<void> {
    if (commitStage.value !== 'idle') {
      ElMessage.warning(
        commitStage.value === 'done' ? '工单已创建，请使用「重试上传」' : '正在提交中',
      );
      return;
    }
    if (standaloneParts.value.length === 0 && assemblies.value.length === 0) {
      ElMessage.warning('请先解析上传');
      return;
    }
    if (!validateLeafCustomers()) return;

    // 建单前固化快照：上传途中刷新 / 切走时，行数据（含用户已填的客户、交期）还在
    draft.saver.flush();

    const { items, rowUids } = buildCommitItems();
    itemRowUids.value = rowUids;
    // 2026-10-05：记账只覆盖**本轮**。上一轮「部分失败」时建成的行已被 dropCreatedRows
    // 移出表格，但它们在 map 里的记录还在；不清的话本轮成功提示会把上一批一并数进去
    // （文案形如「成功创建 7 条零件 + 2 个装配件」，而本轮只建了 3 条）—— 在一个专门防
    // 重复建单的流程里给出自相矛盾的计数。
    // 清在这里而不是 `resetCommitState`：重试上传（done 态）**绝不能**碰它，否则已落库
    // 工单的 id 就丢了，job 现场重建与「重试只重传不重建」两个不变量同时失效。
    createdTargets.clear();

    uploads.beginUploadEpoch();
    pdfSubmitting.value = true;
    commitStage.value = 'creating';
    try {
      // applicant dedupe 在本 Tab 不需要：JSON 端点不接受 applicant_id，
      // applicant_name 走字符串直存，同名只会在 t_part.applicant_name 出现重复字符串。
      // 没有独立零件行时压根不调（整批都是装配件）：`POST /parts/batch` 与装配件无关，
      // 调一个空数组虽然也会早返回，但「装配件不经过批量端点」这件事值得在代码里直白。
      const res: PartBatchResult =
        items.length > 0
          ? await batchCreateParts(items)
          : { created: [], failed: [], groupErrors: [] };

      // 记下「建出来的 part ↔ 本地哪一行」，这是后置上传的锚
      res.created.forEach((c) => {
        const rowUid = itemRowUids.value[c.sourceIndex];
        if (rowUid) createdTargets.set(rowUid, { target: 'part', id: String(c.id) });
      });

      // 装配件：整组一次请求（顶层 + 全部子件），逐组失败不影响其它组
      const asmFailures = await createAssemblyGroups(assemblies.value);

      const partFailed = res.failed.length > 0 || (res.groupErrors?.length ?? 0) > 0;
      if (partFailed || asmFailures.length > 0) {
        const text = buildCreateFailureText(partFailed ? res : null, asmFailures);
        if (createdTargets.size === 0) {
          // 一行都没建出来 ⇒ 本地表格原样保留，回 idle 让用户改完再提交。
          ElMessageBox.alert(text, '部分行未通过', { type: 'warning' });
          commitStage.value = 'idle';
          return;
        }
        // 部分成功：建成的行移出表格（它们已经是真实工单），剩下的失败行留在表里。
        // 此时回 idle 是安全的 —— 下一次提交只会发出剩下的行，不可能重复建已建成的行。
        dropCreatedRows();
        ElMessageBox.alert(text, '部分行未通过', { type: 'warning' });
        commitStage.value = 'idle';
        return;
      }

      commitStage.value = 'uploading';
      let jobs: UploadJob[];
      try {
        jobs = uploads.buildUploadJobs(uploads.rebuildCreatedTargets());
      } catch (e) {
        // 工单已落库，但一条上传都还没发出去（job 登记前就抛了）⇒ 封住「再提交一次
        // 就多建一批工单」的口子：转 done（canSubmit 只剩「重建 job 补传」这一条出路），
        // 并保留 createdTargets / itemRowUids —— 用户点「重试上传」时靠它们现场重建
        // job 列表，仍然不建单。
        commitStage.value = 'done';
        ElMessageBox.alert(
          `工单已创建 ${createdCountText()}，但文件未能开始上传：\n${(e as Error).message ?? '上传失败'}\n\n请点「重试上传」在本页补传（不会重复建单）；若一直失败，可到详情页补传。`,
          '文件上传未开始',
          { type: 'error' },
        );
        return;
      }
      uploads.registerUploadJobs(jobs);
      await uploads.runUploadJobs(jobs);

      commitStage.value = 'done';
      summarizeUploads();
    } catch (e) {
      const msg = (e as Error).message ?? '提交失败';
      if (commitStage.value === 'uploading') {
        // 工单已建、补传阶段整体抛错：转 done 走失败清单 / 重试语义（已登记的 job
        // 各自成败照实汇总）。绝不能回 idle —— 那会让主按钮重新可点，用户再按一次
        // 就是同一批工单建第二遍。
        commitStage.value = 'done';
        summarizeUploads();
      } else if (commitStage.value === 'creating') {
        // creating 阶段的兜底。走到这里的**前提**是 `createdTargets` 为空：建单结果
        // 一拿到就已写进 createdTargets（见上方 forEach / createAssemblyGroups），
        // 非空说明已有工单落库。非空时**绝不能**回 idle —— 主按钮会重新可点，用户再按
        // 一次就是已建出的那批工单建第二遍（两个建单端点都无幂等键）；改走 done 态补传
        // 语义，工单已落库的事实如实转达。
        if (createdTargets.size > 0) {
          commitStage.value = 'done';
          ElMessageBox.alert(
            `工单已创建 ${createdCountText()}，但提交过程中出错：\n${msg}\n\n请点「重试上传」在本页补传（不会重复建单）；若一直失败，可到详情页补传。`,
            '提交中断',
            { type: 'error' },
          );
        } else {
          commitStage.value = 'idle';
        }
      }
      ElMessage.error(msg);
    } finally {
      pdfSubmitting.value = false;
    }
  }

  /**
   * 重试上传（**不重复建工单**）。done 态的两种出路：
   *  - 有失败 job → 只重跑 `failedJobs` 里的那些；
   *  - job 列表压根没登记上 → 用 `createdTargets` 现场重建再全跑。
   */
  async function retryFailedUploads(): Promise<void> {
    if (commitStage.value !== 'done' || pdfSubmitting.value) {
      ElMessage.warning('当前没有可重试的上传');
      return;
    }
    const failed = uploadJobs.value.filter((j) => failedJobs.has(j.id));
    const rebuild = needsUploadRebuild.value;
    if (failed.length === 0 && !rebuild) {
      ElMessage.warning('当前没有可重试的上传');
      return;
    }
    uploads.beginUploadEpoch();
    pdfSubmitting.value = true;
    try {
      if (failed.length > 0) {
        await uploads.runUploadJobs(failed);
      } else {
        let jobs: UploadJob[];
        try {
          jobs = uploads.buildUploadJobs(uploads.rebuildCreatedTargets());
        } catch (e) {
          ElMessageBox.alert(
            `补传仍未能开始：\n${(e as Error).message ?? '上传失败'}\n\n工单已创建，可到零件 / 装配件详情页补传。`,
            '文件上传未开始',
            { type: 'error' },
          );
          return;
        }
        if (jobs.length === 0) {
          // 建单时还在的文件此刻已经不在了（行被删 / 重新解析过）⇒ 再点也补不上，
          // 如实说清出路，不要让用户反复点一个不可能成功的动作。
          ElMessageBox.alert(
            `工单已创建 ${createdCountText()}，但本页已找不到对应的文件（行数据被清空或重新解析过）。\n\n图纸请到零件 / 装配件详情页补传。`,
            '文件上传未开始',
            { type: 'error' },
          );
          return;
        }
        uploads.registerUploadJobs(jobs);
        await uploads.runUploadJobs(jobs);
      }
    } finally {
      pdfSubmitting.value = false;
    }
    summarizeUploads();
  }

  return {
    createdCounts,
    canSubmit,
    submitLabel,
    cellRetryDisabled,
    getRowPdfCell,
    getRowThreeDCell,
    retryUploadByCell,
    onSubmit,
    retryFailedUploads,
    flushDraftOnUnmount: () => {
      draft.saver.flush();
      draft.saver.cancel();
    },
  };
}
