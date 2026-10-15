// composables/usePostSubmitUploads.ts —— 「提交后逐 job 上传」的通用编排（2026-10-15 新增）
//
// ## 它解决什么
//
// 有一类业务动作的形状是：**先把主体建出来，再把一批文件补传上去**。零件 Tab1 手工
// 录入（建零件 → 传图纸）、装配件批量建单（建装配件 → 传总装图 / 子件图纸）都是它。
// 这类流程的失败语义与「建单失败」**正交** —— 建单失败意味着「这一行没建出来」（可以
// 原样重提），上传失败意味着「主体已落库、只差文件」（重提就是重复建单）。两套提示、
// 两套重试语义混在一个文件里时，「这条失败该走哪个分支」就得靠通读全文才能回答。
//
// 本 composable 只管**上传这一半**的状态机：登记 job → 调度 → 进度 → 失败清单 →
// 重试 / 清场。它不知道零件长什么样、不知道建单端点是什么，state 由调用方注入。
//
// ## 与 usePartBatchPdfUploads 的关系
//
// Tab2「PDF 批量上传」早就有同一形状的一套状态机（`views/parts/new/composables/
// usePartBatchPdfUploads.ts`），它额外还管 cell 聚合、世代号校验、行标签这些**只有它
// 需要**的东西。本 composable 是它的**参数化提纯版**（脱钩 `PdfBatchState`、脱钩行标签
// 与 cell 聚合），给不共享那套行状态的使用方（如 Tab1 手工录入）用。
//
// ⚠️ **两套并存是有意的，不是遗漏**：Tab2 的状态与「行集合世代号」深度耦合（提交期间
// 用户改行就必须拒绝收口），把那些搬进共享层会把「Tab2 的表格语义」泄漏给只需要
// 「传一批文件」的调用方。共享的是**传输**（`utils/directUpload.ts`），不是编排。
//
// ## 失败与重试
//
// `isPartFileDuplicateError`（21108：该 owner 的该 kind 已有文件）按**成功**收 ——
// 后端说已经有文件，说明那份文件确实在服务端，此刻记成失败会让每次重试都稳定再拿
// 同一个码，UI 永远停在假错误里。

import { computed, ref, type ComputedRef, type Ref } from 'vue';
import { directUpload } from '@/utils/directUpload';
import { isPartFileDuplicateError, type FileOwnerKind, type PartFileKind } from '@/types/part_file';

/**
 * 一个待传 job = 一个目标实体 × 一份文件。
 *
 * `id` 是稳定身份（`${entryKey}:${ownerId}` 这类），失败清单 / 重试集合全按它寻址 ——
 * 粒度必须是 job 而不是「这份文件」，因为同一份原件可能被多个目标实体共用（一份 PDF
 * 切成多页给多行，每行各传一次），只失败其中一个时按文件重试会把已成功的也重跑一遍。
 */
export interface PostSubmitUploadJob {
  id: string;
  /** 展示用文件名（失败清单用）。 */
  filename: string;
  file: File;
  ownerKind: FileOwnerKind;
  ownerId: string;
  kind: PartFileKind;
  /**
   * 展示用的人类可读标签（如「图号 LT39822」），失败清单里显示在文件名之前。
   *
   * ⚠️ **调用方的行数据可能在上传期间被清掉**（建单成功后清 staged 是常规收场动作），
   * 所以标签必须**在登记 job 时就存进来**，不能等失败了再回头去查那份行数据 ——
   * 那时已经查不到了，失败清单会退化成一串没有上下文的文件名。
   */
  label?: string;
}

/** job 的运行时状态。`error` 存在 `failedJobs` 里，不在状态里。 */
export type PostSubmitUploadState = 'pending' | 'uploading' | 'done' | 'error';

/** 一条失败记录。 */
export interface PostSubmitUploadFailure {
  job: PostSubmitUploadJob;
  error: string;
}

export interface UsePostSubmitUploadsReturn {
  /** 登记一批 job（整批替换之前的现场）。 */
  registerJobs: (jobs: PostSubmitUploadJob[]) => void;
  /** 跑一批 job（受控并发）。跳过已在途的。全部进入终态后 resolve。 */
  runJobs: (jobs: PostSubmitUploadJob[]) => Promise<void>;
  /** 失败清单（job → 原因）。响应式。 */
  failedJobs: ComputedRef<PostSubmitUploadFailure[]>;
  /** 重跑当前失败清单里的全部 job。 */
  retryFailed: () => Promise<void>;
  /** 清掉整个上传现场（成功收场时调用）。 */
  clear: () => void;
  /** 是否还有 job 在途（按钮 loading / disabled）。 */
  running: ComputedRef<boolean>;
  /** 是否已登记过 job 且全部进入终态（成功收场的判据之一）。 */
  allDone: ComputedRef<boolean>;
  /** 每个 job 的状态（供 UI 渲染状态格）。 */
  jobStates: Readonly<Ref<Map<string, PostSubmitUploadState>>>;
  /** 每个 job 的进度 0-100（供 UI 渲染进度条）。 */
  jobProgress: Readonly<Ref<Map<string, number>>>;
}

/** 并发上限 6（与 Tab2 的 `PART_UPLOAD_CONCURRENCY` 同款：几路并发不至于把上行带宽打散）。 */
const UPLOAD_CONCURRENCY = 6;

/**
 * 「提交后逐 job 上传」的通用状态机。
 *
 * 调用方在拿到主体 id **之后**才 registerJobs + runJobs —— 主体在上传发生时必须已经
 * 存在，这是本编排与「选文件即传」那种形态的根本差别。
 */
export function usePostSubmitUploads(): UsePostSubmitUploadsReturn {
  const jobs = ref<PostSubmitUploadJob[]>([]);
  const jobStates = ref(new Map<string, PostSubmitUploadState>());
  const jobProgress = ref(new Map<string, number>());
  const failed = ref(new Map<string, PostSubmitUploadFailure>());
  const runningIds = new Set<string>();
  const runningCount = ref(0);

  function registerJobs(next: PostSubmitUploadJob[]): void {
    jobs.value = next;
    jobStates.value = new Map(next.map((j) => [j.id, 'pending' as const]));
    jobProgress.value = new Map();
    failed.value = new Map();
    runningIds.clear();
    runningCount.value = 0;
  }

  /** 简易信号量：任意时刻同时在跑的 `fn` 不超过 `limit` 个。异常不在这里兜。 */
  async function runWithConcurrency<T>(
    items: T[],
    limit: number,
    fn: (it: T) => Promise<void>,
  ): Promise<void> {
    if (items.length === 0) return;
    let cursor = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const i = cursor++;
        await fn(items[i]!);
      }
    });
    await Promise.all(workers);
  }

  async function runOne(job: PostSubmitUploadJob): Promise<void> {
    runningIds.add(job.id);
    runningCount.value += 1;
    jobStates.value.set(job.id, 'uploading');
    jobProgress.value.set(job.id, 0);
    try {
      await directUpload({
        ownerKind: job.ownerKind,
        ownerId: job.ownerId,
        kind: job.kind,
        file: job.file,
        onProgress: (percent) => jobProgress.value.set(job.id, percent),
      });
      jobStates.value.set(job.id, 'done');
      jobProgress.value.set(job.id, 100);
      failed.value.delete(job.id);
    } catch (e) {
      if (isPartFileDuplicateError(e)) {
        jobStates.value.set(job.id, 'done');
        jobProgress.value.set(job.id, 100);
        failed.value.delete(job.id);
      } else {
        jobStates.value.set(job.id, 'error');
        jobProgress.value.set(job.id, 0);
        failed.value.set(job.id, { job, error: (e as Error).message ?? '上传失败' });
      }
    } finally {
      runningIds.delete(job.id);
      runningCount.value -= 1;
    }
  }

  async function runJobs(next: PostSubmitUploadJob[]): Promise<void> {
    const runnable = next.filter((j) => !runningIds.has(j.id));
    if (runnable.length === 0) return;
    await runWithConcurrency(runnable, UPLOAD_CONCURRENCY, runOne);
  }

  async function retryFailed(): Promise<void> {
    await runJobs(Array.from(failed.value.values()).map((f) => f.job));
  }

  function clear(): void {
    jobs.value = [];
    jobStates.value = new Map();
    jobProgress.value = new Map();
    failed.value = new Map();
    runningIds.clear();
    runningCount.value = 0;
  }

  const failedJobs = computed<PostSubmitUploadFailure[]>(() =>
    Array.from(failed.value.values()),
  );
  const running = computed<boolean>(() => runningCount.value > 0);
  const allDone = computed<boolean>(
    () =>
      jobs.value.length > 0 &&
      jobs.value.every((j) => {
        const st = jobStates.value.get(j.id);
        return st === 'done' || st === 'error';
      }),
  );

  return {
    registerJobs,
    runJobs,
    failedJobs,
    retryFailed,
    clear,
    running,
    allDone,
    jobStates,
    jobProgress,
  };
}
