// Tab 2「PDF 批量上传」的**上传 job 子系统**（2026-10-21 从 usePartBatchPdfSubmit.ts 拆出）。
//
// 这一层管「一批上传作业」的全部生命周期：登记（`registerUploadJobs`）→ 调度
// （`runUploadJobs`）→ 落成 UI 上的状态格（`syncCells`）→ 失败清单（`failedJobLines`）
// → 收场（`clearAllJobs`）。它独立成模块的判据是**它的失败面与建单完全正交**：建单失败
// 意味着「这一行没建出来」（可以原样重提），上传失败意味着「工单已落库、只差图纸」
// （重提就是重复建单）—— 两套提示、两套重试语义，两段混在一个文件里时，"这一条失败该
// 走哪个分支" 就得靠通读全文才能回答。
//
// 依赖方向是**单向**的：`状态层 → 本段 → 提交段`（本段不 import 提交段，提交段不反过来
// 调本段的私有实现）。本段只经 `state` 读写共享状态、只经入参拿 `effectiveChildren`，
// 两个入口（`onSubmit` / `retryFailedUploads`）的**阶段机**仍在提交段 —— 本段没有一个
// 函数会写 `commitStage` 或 `pdfSubmitting`。

import { computed, ref, watch, type ComputedRef } from 'vue';
import { uploadFileObject } from '@/api/files/objects';
import { isPartFileDuplicateError, type PartFileKind } from '@/types/part_file';
import { runWithConcurrency } from './usePartBatchShared';
import type { PdfBatchState } from './usePartBatchPdfState';
import type { UsePartBatchPdfRows } from './usePartBatchPdfRows';
import type {
  CreatedTargetRef,
  FileUploadEntry,
  PdfSource,
  RowRef,
  UploadJob,
  UploadJobState,
  UploadStatusCell,
} from './usePartBatchPdfTypes';

export interface UsePartBatchPdfUploads {
  getRowPdfCell: (row: { pdfSourceUid: string | null }) => UploadStatusCell | undefined;
  getRowThreeDCell: (row: { three_d_index: number | null }) => UploadStatusCell | undefined;
  hasUploadErrors: ComputedRef<boolean>;
  failedJobCount: ComputedRef<number>;
  needsUploadRebuild: ComputedRef<boolean>;
  buildUploadJobs: (refs: CreatedTargetRef[]) => UploadJob[];
  /** 由 `createdTargets` 现场还原「目标实体 ↔ 本地行」（buildUploadJobs 抛错后的重试路径）。 */
  rebuildCreatedTargets: () => CreatedTargetRef[];
  registerUploadJobs: (jobs: UploadJob[]) => void;
  runUploadJobs: (jobs: UploadJob[]) => Promise<void>;
  settleUnfinishedJobs: () => void;
  failedJobLines: () => string[];
  beginUploadEpoch: () => void;
  rowsUnchangedSinceEpoch: () => boolean;
  clearAllJobs: () => void;
}

export function usePartBatchPdfUploads(
  state: PdfBatchState,
  rowSeg: Pick<UsePartBatchPdfRows, 'effectiveChildren'>,
): UsePartBatchPdfUploads {
  const {
    allPdfs,
    standaloneParts,
    assemblies,
    threeDModelFiles,
    createdTargets,
    pdfUploadCells,
    threeDUploadCells,
    uploadJobs,
    failedJobs,
    runningJobIds,
  } = state;
  const { effectiveChildren } = rowSeg;

  /**
   * 2026-10-04 定：并发上限。瓶颈在后端内存 —— `upload_part_file` 把整份 multipart
   * 读进内存（`&[u8]`）再转存对象存储，单文件上限 300MB（`cos.max_file_size`），
   * 所以 6 是「几路并发不至于把后端内存打爆」的保守值，不是吞吐最优值。
   * 不取更小的 3：文件字节现在全过后端，限制在服务端一侧（对象存储直传链路才是
   * 浏览器侧受限），按浏览器侧的余量取值对后端没有意义。
   */
  const PART_UPLOAD_CONCURRENCY = 6;

  /**
   * 任意 Blob → File。PdfSource.raw 在合成路径（pdf-lib save()）下是 Blob 而非 File。
   * 这里统一包成 File 以简化下游类型。
   */
  function ensureFile(blob: Blob, filename: string): File {
    if (blob instanceof File) return blob;
    return new File([blob], filename, { type: blob.type || 'application/octet-stream' });
  }

  /**
   * 决定某个 row 的 PDF 单元（用于 UI 显示上传状态）。
   * `pdfSourceUid` 允许为 null = 该实体没有要传的 PDF（装配件无总装图时顶层就是这种
   * 情况），此时不占状态格。
   */
  function getRowPdfCell(row: { pdfSourceUid: string | null }): UploadStatusCell | undefined {
    if (!row.pdfSourceUid) return undefined;
    return pdfUploadCells[`pdf:${row.pdfSourceUid}`];
  }
  /** 决定某个 row 的 3D 单元。 */
  function getRowThreeDCell(row: { three_d_index: number | null }): UploadStatusCell | undefined {
    if (row.three_d_index === null) return undefined;
    const f = threeDModelFiles.value[row.three_d_index];
    if (!f) return undefined;
    return threeDUploadCells[`3d:${f.uid}`];
  }

  /** 收集本批次所有待上传文件（PDF + 3D），按 (kind, srcUid/fileUid) 去重。 */
  function collectFilesToUpload(): FileUploadEntry[] {
    const map = new Map<string, FileUploadEntry>();
    const ensure = (key: string, make: () => FileUploadEntry): FileUploadEntry => {
      const existing = map.get(key);
      if (existing) return existing;
      const created = make();
      map.set(key, created);
      return created;
    };
    /**
     * 装一个 PDF 条目并把 row 挂上去（每个实体一个独立切片 ⇒ key 天然唯一）。
     *
     * `kind: 'DRAWING'` 对**所有** PDF 一视同仁 —— 它描述的是「原件是一份 PDF 图纸」，
     * 与这条原件挂到 `t_part` 还是 `t_assembly` 无关。落库时装配件顶层会被换成
     * `ASSEMBLY_MASTER`（转换点在 `runUploadJobs`），所以这里**不要**按 ref 分流。
     */
    const attachPdf = (src: PdfSource, ref: RowRef): void => {
      const key = `pdf:${src.uid}`;
      ensure(key, () => ({
        key,
        kind: 'DRAWING',
        filename: src.filename,
        file: ensureFile(src.raw, src.filename),
        size: src.raw.size,
        contentType: src.raw.type || 'application/pdf',
        rowRefs: [],
      })).rowRefs.push(ref);
    };

    // 1) PDF：独立零件行
    for (const r of standaloneParts.value) {
      const src = allPdfs.value.find((s) => s.uid === r.pdfSourceUid);
      if (!src) continue;
      attachPdf(src, { rowKind: 'standalone', rowUid: r.uid });
    }
    // 2) PDF：装配件 —— 每个子件一份单页切片；总装图可选（也是独立的那一页的切片）
    for (const a of assemblies.value) {
      for (const c of effectiveChildren(a)) {
        const src = allPdfs.value.find((s) => s.uid === c.pdfSourceUid);
        if (!src) continue;
        attachPdf(src, { rowKind: 'asmChild', rowUid: c.uid, asmUid: a.uid });
      }
      // 「无总装图」⇒ 顶层一个 job 都不产生（库里就不会有 ASSEMBLY_MASTER 行）
      if (!a.masterPdfSourceUid) continue;
      const master = allPdfs.value.find((s) => s.uid === a.masterPdfSourceUid);
      if (!master) continue;
      attachPdf(master, { rowKind: 'asmMaster', rowUid: a.uid });
    }
    // 3) 3D 模型：被 row 引用的（three_d_index 指向的文件）
    const attachThreeD = (ref: RowRef, idx: number): void => {
      const f = threeDModelFiles.value[idx];
      const raw = f?.raw as File | undefined;
      if (!f || !raw) return;
      const key = `3d:${f.uid}`;
      ensure(key, () => ({
        key,
        kind: '3D_MODEL',
        filename: f.name,
        file: raw,
        size: raw.size,
        contentType: raw.type || 'application/octet-stream',
        rowRefs: [],
      })).rowRefs.push(ref);
    };
    for (const r of standaloneParts.value) {
      if (r.three_d_index !== null)
        attachThreeD({ rowKind: 'standalone', rowUid: r.uid }, r.three_d_index);
    }
    // 装配件子件走 effectiveChildren，与建单口径（buildAssemblyPayload）对齐：被指定为
    // 总装图的那一页不建出子件，遍历它只会挂出一个没有 job 的 entry。
    // 2026-10-05：这一处**对外不可观测** —— 不建 job 就不进 jobsByCellKey，syncCells 也不
    // 会凭空造 cell，composable 的返回面上看不出差别。保留这个写法是为了不给「一个
    // PdfSource 同时挂 asmChild + asmMaster 两种 ref」留下悬空引用；配套用例锁的是
    // 用户可见的那条不变式：被排除那一行不占 3D 状态格。
    for (const a of assemblies.value) {
      for (const c of effectiveChildren(a)) {
        if (c.three_d_index !== null) {
          attachThreeD({ rowKind: 'asmChild', rowUid: c.uid, asmUid: a.uid }, c.three_d_index);
        }
      }
    }
    return Array.from(map.values());
  }

  /**
   * 2026-10-04：行集合世代号，**只在行的增删换时 +1**（新 uid 进表 / 行被移除 / 整表
   * 被替换）；行内字段编辑不动它，所以用户改个数量不会误触发。
   *
   * `flush: 'sync'` 让它在改动发生的那一刻同步递增，于是「谁改的行集合」这件事
   * 不必逐个入口打点 —— 重新解析 / 手动新增 / 合并 / 拆分 / 删除，以及将来新增的入口，
   * 全部被这一个收口覆盖。世代号是收口的**前提**而非收口的一部分，唯一的读点是提交段的
   * `rowsUnchangedSinceEpoch()`（收口的计数 / 清场 / 跳页全以「当前表格 == 建单时那张表」
   * 为前提）。
   */
  const rowEpoch = ref(0);
  watch(
    () =>
      `${standaloneParts.value.map((r) => r.uid).join('|')}#${assemblies.value
        .map((a) => a.uid)
        .join('|')}`,
    () => {
      rowEpoch.value += 1;
    },
    { flush: 'sync' },
  );

  /**
   * 本次提交 / 补传开始时的世代号快照。收口时与 `rowEpoch` 比对：不等说明用户在这期间
   * 换过行集合，本次收口的计数、清场、跳页已经对不上当前表格。
   */
  let submitRowEpoch = 0;

  /** 记下「本次提交 / 补传开始」时的世代号（提交段两个重试入口在起跑前各调一次）。 */
  function beginUploadEpoch(): void {
    submitRowEpoch = rowEpoch.value;
  }

  /** 行集合自 `beginUploadEpoch()` 以来没被改过 —— 收口动作成立的前提。 */
  function rowsUnchangedSinceEpoch(): boolean {
    return rowEpoch.value === submitRowEpoch;
  }

  /** 当前是否有任何 job 上传失败（主按钮 disabled + 重试分支的判据）。 */
  const hasUploadErrors = computed<boolean>(() => failedJobs.size > 0);

  /** 失败 job 数（按钮文案用，口径与失败清单的行一一对应）。 */
  const failedJobCount = computed<number>(() => failedJobs.size);

  /** cell key → 对应的响应式 cell（PDF / 3D 分表存）。 */
  function cellOf(jobKey: string, kind: PartFileKind): UploadStatusCell | undefined {
    return kind === 'DRAWING' ? pdfUploadCells[jobKey] : threeDUploadCells[jobKey];
  }

  /**
   * 由 jobStates / failedJobs 重新推导每个 cell 的状态，**不就地覆盖**。
   *
   * 同一份文件可能被多个 job 共用一个 cell（多行共享原件时）：任一 job 失败即 error
   * （该文件确实没传全），但重试时只重跑失败的那个 job，成功过的不会再动。error 文案
   * 取第一个失败 job 的错误（同一份文件、同一批请求，错误基本一致）。
   */
  function syncCells(): void {
    for (const [jobKey, jobs] of state.jobsByCellKey) {
      const cell = cellOf(jobKey, jobs[0]!.kind);
      if (!cell) continue;
      const firstFailed = jobs.find((j) => failedJobs.has(j.id));
      if (firstFailed) {
        cell.status = 'error';
        cell.progress = 0;
        cell.error = failedJobs.get(firstFailed.id)!.error;
        continue;
      }
      delete cell.error;
      if (jobs.every((j) => state.jobStates.get(j.id) === 'done')) {
        cell.status = 'done';
        cell.progress = 100;
      } else if (jobs.some((j) => state.jobStates.get(j.id) === 'uploading')) {
        cell.status = 'uploading';
        cell.progress = 0;
      } else {
        cell.status = 'pending';
        cell.progress = 0;
      }
    }
  }

  /**
   * 2026-10-21：记一个 job 的**瞬时**状态并立刻把 cell 同步过来。
   *
   * `jobStates` 是非响应式的普通 `Map`（与 `failedJobs` / `createdTargets` 不同）⇒ cell
   * 状态 100% 靠**命令式** `syncCells()` 推导，没有任何响应式兜底：改了 `jobStates`
   * 却没同步，UI 会静默停在旧状态（不报错、单测也可能侥幸通过）。把「写状态 + 同步」
   * 收进本函数，就是为了让「忘了同步」在代码形状上不可表达 —— 需要写 `jobStates` 的地方
   * 一律经它。
   */
  function markJobState(jobId: string, next: UploadJobState): void {
    state.jobStates.set(jobId, next);
    syncCells();
  }

  /**
   * 2026-10-21：记一个 job 的**终局**（成功清错 / 失败记原因）并立刻把 cell 同步过来。
   *
   * `error` 省略即判成功（清掉该 job 的失败记录），给出即记进失败清单。
   */
  function settleJob(job: UploadJob, next: UploadJobState, error?: string): void {
    state.jobStates.set(job.id, next);
    if (error === undefined) failedJobs.delete(job.id);
    else failedJobs.set(job.id, { job, error });
    syncCells();
  }

  /** 登记一次提交的全部 job（并按 jobKey 建 cell）。重试不重跑这里。 */
  function registerUploadJobs(jobs: UploadJob[]): void {
    uploadJobs.value = jobs;
    // ⚠️ **全量替换**，不是 `clear()` + `set()`：`jobsByCellKey` 在状态层是 getter/setter
    // 对，局部改会写进一个临时的 Map 而不落到真正的持有者上（症状：syncCells 永远读空、
    // cell 状态整块不更新）。`registerUploadJobs` / `clearAllJobs` 两处都按全量替换写。
    state.jobsByCellKey = new Map();
    state.jobStates.clear();
    failedJobs.clear();
    Object.keys(pdfUploadCells).forEach((k) => delete pdfUploadCells[k]);
    Object.keys(threeDUploadCells).forEach((k) => delete threeDUploadCells[k]);
    for (const job of jobs) {
      const list = state.jobsByCellKey.get(job.jobKey) ?? [];
      list.push(job);
      state.jobsByCellKey.set(job.jobKey, list);
      state.jobStates.set(job.id, 'pending');
      const bucket = job.kind === 'DRAWING' ? pdfUploadCells : threeDUploadCells;
      if (!bucket[job.jobKey]) bucket[job.jobKey] = { status: 'pending', progress: 0 };
    }
    syncCells();
  }

  /**
   * 失败 job 的目标实体标签（失败清单 / 汇总标题用）。
   * 装配件子件与独立零件都是 `t_part` 行，标「第 X 号零件」；装配件顶层是 `t_assembly`
   * 行，标「装配件 X」—— 两者的 id 是两套雪花，混标会让用户拿着装配件 id 去零件列表里找。
   */
  function jobOwnerLabel(job: UploadJob): string {
    return job.target === 'assembly' ? `装配件 ${job.ownerId}` : `第 ${job.ownerId} 号零件`;
  }

  /** 失败 job 清单（每行 = 一个目标实体 × 一份原件），汇总时弹给用户看。 */
  function failedJobLines(): string[] {
    return Array.from(failedJobs.values()).map(
      (f) => `${jobOwnerLabel(f.job)} · ${f.job.entry.filename}：${f.error}`,
    );
  }

  /**
   * 把「已登记但没跑到 done」的 job 补记进失败清单。
   *
   * 收口的成功判据是「**全部已登记 job 都判成功**」，不是「failedJobs 为空」：登记 /
   * 调度被打断时，未被调度的 job 停在 `pending` 且不在 `failedJobs` 里，只看 failedJobs
   * 会把「一个文件都没传上去」当成功收口（清空现场 + 跳页）。已失败的 job 不重复覆盖，
   * 保住它自己的错误文案。
   */
  function settleUnfinishedJobs(): void {
    const unfinished = uploadJobs.value.filter((j) => state.jobStates.get(j.id) !== 'done');
    for (const job of unfinished) {
      if (!failedJobs.has(job.id)) {
        failedJobs.set(job.id, { job, error: '未完成（上传过程被中断）' });
      }
    }
  }

  /**
   * 跑一批 job（受控并发）。成败记在 job 上（jobStates / failedJobs）再由 syncCells
   * 推导 cell 状态；单个 job 抛错只记失败、不影响其它 job，也不外抛。
   *
   * 三条链路（装配件顶层总装图 / 子件与独立零件的图纸 / 3D 模型）同打
   * `POST /api/v2/files/objects`；owner 与 kind 是**两个独立维度**，都按
   * `job.target` 分流（装配件顶层 `target='assembly'` ↔ `owner_kind='ASSEMBLY'` +
   * `kind='ASSEMBLY_MASTER'`；独立零件与装配件子件都是 `t_part` 行，`target='part'`
   * ↔ `owner_kind='PART'`，kind 取 `job.kind`）。
   *
   * ⚠️ **owner_kind='ASSEMBLY' 时 kind 必须由 `'DRAWING'` 转成 `'ASSEMBLY_MASTER'`**，
   * 不能原样传 `job.kind`（PDF 条目的 `entry.kind` 恒为 `'DRAWING'`，因为它描述的是
   * 「原件是什么」而不是「落到 t_part_file 的哪一格」）。后端 `upload_file_for_owner`
   * 把请求里的 `kind` **原样**写进 `t_part_file.kind`，不做 owner/kind 一致性改写 ⇒
   * 传 `'DRAWING'` 会静默落成一张「装配件的零件图纸」行：读侧
   * （`useAssemblyDetail`）按 `kind === 'ASSEMBLY_MASTER'` 挑总装图，挑不到；唯一索引
   * `uk_t_part_file_single (part_id, kind)` 的 kind 维度也跟着错位。
   *
   * 已在途的 job 直接跳过（`runningJobIds`）：同一次上传请求重复发出去既浪费带宽，
   * 又会撞后端唯一索引。
   *
   * 命中 `isPartFileDuplicateError`（后端说这个 owner 的这个 kind 已有文件）按**成功**
   * 收：该 kind 下已有文件就说明那份文件已经在服务端，此刻把它记成失败会让每次重试
   * 都稳定再拿一次同一个码，UI 永远停在假错误里（成因是上一次上传「已落库但响应
   * 丢失」）。装配件总装图与零件图纸同落 `t_part_file`（`owner_kind` 不同、kind 各是
   * 自己那一个），所以复用同一个 21108 归一。
   */
  async function runUploadJobs(jobs: UploadJob[]): Promise<void> {
    const runnable = jobs.filter((j) => !runningJobIds.has(j.id));
    if (runnable.length === 0) return;
    await runWithConcurrency(runnable, PART_UPLOAD_CONCURRENCY, async (job) => {
      runningJobIds.add(job.id);
      markJobState(job.id, 'uploading');
      try {
        const isAssembly = job.target === 'assembly';
        await uploadFileObject(
          isAssembly ? 'ASSEMBLY' : 'PART',
          job.ownerId,
          isAssembly ? 'ASSEMBLY_MASTER' : job.kind,
          job.entry.file,
        );
        settleJob(job, 'done');
      } catch (e) {
        if (isPartFileDuplicateError(e)) {
          settleJob(job, 'done');
        } else {
          settleJob(job, 'error', (e as Error).message ?? '上传失败');
        }
      } finally {
        runningJobIds.delete(job.id);
      }
    });
  }

  /**
   * 2026-10-04：工单已建、但上传 job 列表没登记上（构造 job 抛错 / 登记被打断）。
   *
   * 这时 `failedJobs` 是空的，只按「有失败 job」判可点会让主按钮显示「提交创建（N 个
   * 零件）」却永久 disabled —— UI 在邀请一个点不动的动作，而用户看到自己填好的行唯一
   * 合理的动作就是再点一次，那会把工单再建一遍。出路是现成的：`createdTargets` 与
   * `itemRowUids` 还在手上，现场重建 job 列表即可（不碰建单）。
   */
  const needsUploadRebuild = computed<boolean>(
    () => createdTargets.size > 0 && uploadJobs.value.length === 0,
  );

  /**
   * 本次提交要上传的「目标实体 × 原件」对应关系（建单成功后调用一次）。
   *
   * 分流分两层，两层的依据不同，别混：
   *  - **owner 维度**在这里分流（`ref.target` 决定上传目标是 `t_assembly` 还是
   *    `t_part` 行）：同一份原件被多个 row 引用时（共享一个 UI cell），顶层传
   *    `ASSEMBLY`、子件传 `PART`；
   *  - **kind 维度**不在这里改写：job 的 `kind` 取 `entry.kind`，描述的是「这份原件是
   *    PDF 图纸还是 3D 模型」，`registerUploadJobs` / `syncCells` 要靠它把 job 分派到
   *    PDF / 3D 两张 cell 表（改成 `ASSEMBLY_MASTER` 会让总装图的 cell 落进 3D 表）。
   *    落库用的 kind 由 `runUploadJobs` 在发请求前按 target 定：装配件顶层
   *    `'DRAWING'` → `'ASSEMBLY_MASTER'`。
   */
  function buildUploadJobs(refs: CreatedTargetRef[]): UploadJob[] {
    const entries = collectFilesToUpload();
    const byRow = new Map<string, FileUploadEntry[]>();
    for (const e of entries) {
      for (const ref of e.rowRefs) {
        const list = byRow.get(ref.rowUid) ?? [];
        list.push(e);
        byRow.set(ref.rowUid, list);
      }
    }
    const jobs: UploadJob[] = [];
    for (const ref of refs) {
      for (const entry of byRow.get(ref.rowUid) ?? []) {
        // 总装图槽位只收 PDF：`attachPdf` 对所有 PDF 统一记 `kind='DRAWING'`（它描述
        // 原件类型，与 owner 无关），顶层本来就不挂 3D（`collectFilesToUpload` 只给
        // asmChild / standalone 挂）。这一句是防线：万一将来给顶层挂了 3D，绝不能把
        // 3D 文件发到总装图槽位上去 —— 那里只接 PDF（后端 `allowed_exts("ASSEMBLY_MASTER")`
        // 与 `allowed_exts("DRAWING")` 同为 `["pdf"]`）。
        if (ref.target === 'assembly' && entry.kind !== 'DRAWING') continue;
        jobs.push({
          id: `${entry.key}:${ref.target}:${ref.id}`,
          jobKey: entry.key,
          target: ref.target,
          ownerId: ref.id,
          kind: entry.kind,
          entry,
        });
      }
    }
    // 同一份原件被多个 row 共享时（合成的多页独立零件等），这里会为每个实体各产出
    // 一个 job。这是建单与文件上传彻底解耦的已知代价：请求数比「建单时各带一份绑定」高，
    // 但上传失败不再需要回滚工单。
    return jobs;
  }

  /**
   * 由 `createdTargets` 现场还原「目标实体 ↔ 本地行」。
   *
   * `buildUploadJobs` 抛错时 job 列表没登记上，但记账还在，所以重建不需要重新建单、
   * 也不需要后端再返回一次 `created`。
   */
  function rebuildCreatedTargets(): CreatedTargetRef[] {
    return Array.from(createdTargets.entries()).map(([rowUid, v]) => ({
      rowUid,
      target: v.target,
      id: v.id,
    }));
  }

  /**
   * 清掉全部 job 现场（成功收口时调用，提交段在草稿 clear 之后调）。
   *
   * `jobsByCellKey` 同样是**全量替换**（理由见 `registerUploadJobs` 的注释）。
   */
  function clearAllJobs(): void {
    Object.keys(pdfUploadCells).forEach((k) => delete pdfUploadCells[k]);
    Object.keys(threeDUploadCells).forEach((k) => delete threeDUploadCells[k]);
    uploadJobs.value = [];
    state.jobsByCellKey = new Map();
    state.jobStates.clear();
    failedJobs.clear();
    runningJobIds.clear();
  }

  return {
    getRowPdfCell,
    getRowThreeDCell,
    hasUploadErrors,
    failedJobCount,
    needsUploadRebuild,
    // `registerUploadJobs` 与 `runUploadJobs` 刻意分开导出、不合成一个 `startUploads`：
    // 提交段的语义是「构造 job 抛错 ⇒ 工单已落库但一条都没发 ⇒ 转 done 并保留现场让
    // 重试能重建」，合成一个函数后这个分支再也表达不出来。
    buildUploadJobs,
    rebuildCreatedTargets,
    registerUploadJobs,
    runUploadJobs,
    settleUnfinishedJobs,
    failedJobLines,
    beginUploadEpoch,
    rowsUnchangedSinceEpoch,
    clearAllJobs,
  };
}
