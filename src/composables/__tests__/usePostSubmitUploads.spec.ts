// usePostSubmitUploads 单元测试（2026-10-15 新增）
//
// 守的是「**提交后逐 job 上传**」这条通用编排的失败语义 —— 它与建单失败正交，
// 所以这几条断言是这个 composable 存在的全部理由：
//   1. 单个 job 失败**不外抛、不牵连其它 job**；
//   2. 失败项进清单、状态可重试、成功的不会被重跑；
//   3. `isPartFileDuplicateError`（21108）按成功收；
//   4. 在途 job 不被重复调度（连点重试）；
//   5. 并发上限 6。
//
// 传输层（directUpload）整份 mock：它的行为由 utils/__tests__/directUpload.spec.ts 守。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { usePostSubmitUploads, type PostSubmitUploadJob } from '../usePostSubmitUploads';

const directUploadSpy = vi.fn();
vi.mock('@/utils/directUpload', () => ({
  directUpload: (...args: unknown[]) => directUploadSpy(...args),
}));

function jobOf(id: string, name = `${id}.pdf`): PostSubmitUploadJob {
  return {
    id,
    filename: name,
    file: new File([new Uint8Array(4)], name, { type: 'application/pdf' }),
    ownerKind: 'PART',
    ownerId: `owner-${id}`,
    kind: 'DRAWING',
  };
}

beforeEach(() => {
  directUploadSpy.mockReset();
  directUploadSpy.mockImplementation(async () => ({ item: { id: 'x' }, alreadyExists: false }));
});

describe('usePostSubmitUploads happy path', () => {
  it('登记 + 跑完：全部 done、无失败、progress=100、allDone=true', async () => {
    const u = usePostSubmitUploads();
    const jobs = [jobOf('a'), jobOf('b')];
    u.registerJobs(jobs);
    await u.runJobs(jobs);
    expect(u.jobStates.value.get('a')).toBe('done');
    expect(u.jobStates.value.get('b')).toBe('done');
    expect(u.jobProgress.value.get('a')).toBe(100);
    expect(u.failedJobs.value).toHaveLength(0);
    expect(u.allDone.value).toBe(true);
    expect(u.running.value).toBe(false);
  });

  it('owner / kind / file 逐项透传给引擎（不串门）', async () => {
    const u = usePostSubmitUploads();
    const jobs = [
      { ...jobOf('a'), ownerKind: 'ASSEMBLY' as const, kind: 'ASSEMBLY_MASTER' as const },
      jobOf('b'),
    ];
    u.registerJobs(jobs);
    await u.runJobs(jobs);
    expect(directUploadSpy).toHaveBeenCalledTimes(2);
    const opts = directUploadSpy.mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(opts.some((o) => o.ownerKind === 'ASSEMBLY' && o.kind === 'ASSEMBLY_MASTER')).toBe(true);
    expect(opts.some((o) => o.ownerKind === 'PART' && o.kind === 'DRAWING')).toBe(true);
  });

  it('进度回调回写到 jobProgress（UI 状态格直接读它）', async () => {
    directUploadSpy.mockImplementationOnce(
      async (o: { onProgress?: (p: number) => void }) => {
        o.onProgress?.(42);
        return { item: { id: 'x' }, alreadyExists: false };
      },
    );
    const u = usePostSubmitUploads();
    const jobs = [jobOf('a')];
    u.registerJobs(jobs);
    const p = u.runJobs(jobs);
    expect(u.jobProgress.value.get('a')).toBe(42);
    await p;
    expect(u.jobProgress.value.get('a')).toBe(100);
  });
});

describe('usePostSubmitUploads 失败语义', () => {
  it('一个 job 失败不外抛、不牵连其它 job', async () => {
    directUploadSpy.mockImplementation(async (o: { file: File }) => {
      if (o.file.name === 'bad.pdf') throw new Error('坏了');
      return { item: { id: 'x' }, alreadyExists: false };
    });
    const u = usePostSubmitUploads();
    const jobs = [jobOf('a'), jobOf('b', 'bad.pdf')];
    u.registerJobs(jobs);
    await expect(u.runJobs(jobs)).resolves.toBeUndefined();
    expect(u.jobStates.value.get('a')).toBe('done');
    expect(u.jobStates.value.get('b')).toBe('error');
    expect(u.failedJobs.value).toHaveLength(1);
    expect(u.failedJobs.value[0]!.error).toContain('坏了');
    expect(u.allDone.value).toBe(true);
  });

  it('21108「文件已存在」按成功收：理由是服务端确实已有那份文件', async () => {
    directUploadSpy.mockRejectedValueOnce(
      Object.assign(new Error('相同文件已存在'), { code: 21108 }),
    );
    const u = usePostSubmitUploads();
    const jobs = [jobOf('a')];
    u.registerJobs(jobs);
    await u.runJobs(jobs);
    expect(u.jobStates.value.get('a')).toBe('done');
    expect(u.failedJobs.value).toHaveLength(0);
  });

  it('retryFailed 只重跑失败项：已成功的不会被重传', async () => {
    directUploadSpy.mockImplementation(async (o: { file: File }) => {
      if (o.file.name === 'bad.pdf') throw new Error('坏了');
      return { item: { id: 'x' }, alreadyExists: false };
    });
    const u = usePostSubmitUploads();
    const jobs = [jobOf('a'), jobOf('b', 'bad.pdf')];
    u.registerJobs(jobs);
    await u.runJobs(jobs);
    directUploadSpy.mockClear();
    directUploadSpy.mockImplementation(async () => ({ item: { id: 'x' }, alreadyExists: false }));
    await u.retryFailed();
    expect(directUploadSpy).toHaveBeenCalledTimes(1);
    expect(u.failedJobs.value).toHaveLength(0);
    expect(u.jobStates.value.get('a')).toBe('done');
    expect(u.jobStates.value.get('b')).toBe('done');
  });

  it('在途 job 不被重复调度（连点两次 runJobs 只发一次）', async () => {
    let resolveIt: (() => void) | null = null;
    directUploadSpy.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveIt = () => resolve({ item: { id: 'x' }, alreadyExists: false });
        }),
    );
    const u = usePostSubmitUploads();
    const jobs = [jobOf('a')];
    u.registerJobs(jobs);
    const p1 = u.runJobs(jobs);
    await u.runJobs(jobs);
    expect(directUploadSpy).toHaveBeenCalledTimes(1);
    resolveIt!();
    await p1;
  });

  it('并发上限 6：同时在飞不超过 6', async () => {
    let inFlight = 0;
    let peak = 0;
    directUploadSpy.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
      return { item: { id: 'x' }, alreadyExists: false };
    });
    const u = usePostSubmitUploads();
    const jobs = Array.from({ length: 10 }, (_, i) => jobOf(`j${i}`));
    u.registerJobs(jobs);
    await u.runJobs(jobs);
    expect(peak).toBeLessThanOrEqual(6);
    expect(u.failedJobs.value).toHaveLength(0);
  });
});

describe('usePostSubmitUploads 现场管理', () => {
  it('clear 清掉全部现场', async () => {
    const u = usePostSubmitUploads();
    const jobs = [jobOf('a')];
    u.registerJobs(jobs);
    await u.runJobs(jobs);
    u.clear();
    expect(u.failedJobs.value).toHaveLength(0);
    expect(u.allDone.value).toBe(false);
  });

  it('registerJobs 是整批替换：上一批的失败记录不残留', async () => {
    directUploadSpy.mockRejectedValueOnce(new Error('炸了'));
    const u = usePostSubmitUploads();
    const first = [jobOf('a')];
    u.registerJobs(first);
    await u.runJobs(first);
    expect(u.failedJobs.value).toHaveLength(1);
    const second = [jobOf('b')];
    u.registerJobs(second);
    expect(u.failedJobs.value).toHaveLength(0);
  });
});
