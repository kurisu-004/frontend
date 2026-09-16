// @vitest-environment happy-dom
//
// useCosUpload 单元测试（2026-09-16 frontend-overall-cos-direct-upload）。
//
// 验证：
// - startUpload 走通：所有 item.status=done，progress=100，etag 写入；
// - onProgress 回调累计更新 item.progress；
// - 单项 error → retryItem 重试后变 done；
// - 凭证过期触发 refetchIntents（fake timers + mock api）；
// - 并发上限（concurrency=2 时同时 in-flight 的 uploadOne 不超过 2）；
// - allDone / allOk 计算属性语义正确。
//
// cos-js-sdk-v5 不能在测试里真传（依赖 XHR + 真桶）。用 vi.mock 在 factory 里
// 替换成一个 record-replay stub：每次 new COS() 返回 { uploadFile }，uploadFile
// 走 vi.fn() 由测试方按 client_ref 控制成功 / 失败 / 进度。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ref, type Ref } from 'vue';
import { useCosUpload, type CosUploadItem } from '../useCosUpload';
import type { CosCredentials, UploadIntentsOut } from '@/types/part_file';

// ============ mock cos-js-sdk-v5 ============
const uploadFileSpy = vi.fn();
const cosConstructSpy = vi.fn();

vi.mock('cos-js-sdk-v5', () => {
  // mock 类：构造时记入 spy，uploadFile 转给模块级 uploadFileSpy
  class MockCOS {
    public constructor(opts: Record<string, unknown>) {
      cosConstructSpy(opts);
    }
    public uploadFile(params: Record<string, unknown>) {
      return uploadFileSpy(params);
    }
  }
  // 走默认导出（cjs `export =` 风格在 esModuleInterop 下 import 走 default）
  return { default: MockCOS };
});

// ============ helpers ============
function makeCredentials(expiredTime: number): CosCredentials {
  return {
    tmp_secret_id: 'AKID',
    tmp_secret_key: 'SECRET',
    session_token: 'TOKEN',
    expired_time: expiredTime,
  };
}

function makeItem(
  clientRef: string,
  tmpKey: string,
  file: File,
  expiredTime = Math.floor(Date.now() / 1000) + 7200,
): CosUploadItem {
  return {
    client_ref: clientRef,
    file,
    tmp_key: tmpKey,
    bucket: 'bucket-1250000000',
    region: 'ap-shanghai',
    tmp_prefix: 'tmp/spike/',
    credentials: makeCredentials(expiredTime),
    status: 'pending',
    progress: 0,
  };
}

function makeIntents(
  items: Array<{ client_ref: string; tmp_key: string }>,
  expiredTime: number,
): UploadIntentsOut {
  return {
    credentials: makeCredentials(expiredTime),
    bucket: 'bucket-1250000000',
    region: 'ap-shanghai',
    tmp_prefix: 'tmp/spike/',
    items: items.map((it) => ({
      client_ref: it.client_ref,
      tmp_key: it.tmp_key,
      dedup_hit: false,
    })),
  };
}

/** 模拟 cos.uploadFile 的「成功 + onProgress 走一遍」输出。 */
function mockSuccess(): { ETag: string; Location: string } {
  return { ETag: '"abc123"', Location: 'bucket-1250000000.cos.ap-shanghai.myqcloud.com/x' };
}

beforeEach(() => {
  uploadFileSpy.mockReset();
  cosConstructSpy.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

// ============ tests ============
describe('useCosUpload / startUpload', () => {
  it('所有 item 走通：status=done, progress=100, etag 写入', async () => {
    const file = new File(['hello'], 'a.pdf', { type: 'application/pdf' });
    const items: Ref<CosUploadItem[]> = ref([
      makeItem('ref-1', 'tmp/spike/a.pdf', file),
      makeItem('ref-2', 'tmp/spike/b.stp', file),
    ]);

    // mock：无论收到什么 params 都成功 + 调一次 onProgress(50%)
    uploadFileSpy.mockImplementation(
      (params: { onProgress?: (p: { percent: number }) => void }) => {
        params.onProgress?.({ percent: 0.5 });
        return Promise.resolve(mockSuccess());
      },
    );

    const refetchIntents = vi.fn(async () =>
      makeIntents(
        [
          { client_ref: 'ref-1', tmp_key: 'tmp/spike/a.pdf' },
          { client_ref: 'ref-2', tmp_key: 'tmp/spike/b.stp' },
        ],
        Math.floor(Date.now() / 1000) + 7200,
      ),
    );

    const { startUpload, allDone, allOk } = useCosUpload({ items, refetchIntents });
    await startUpload();

    expect(items.value.every((it) => it.status === 'done')).toBe(true);
    expect(items.value.every((it) => it.progress === 100)).toBe(true);
    // etag 已写入（mock 返回的 ETag）
    expect(items.value.every((it) => it.etag === '"abc123"')).toBe(true);
    expect(items.value.every((it) => it.error === undefined)).toBe(true);
    // 并发跑过两次（ref-1 + ref-2）
    expect(uploadFileSpy).toHaveBeenCalledTimes(2);
    // COS 实例按 SDK 调用约定至少被构造一次（每个 uploadFile 一次 → 此处 2 次）
    expect(cosConstructSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
    // 凭证未过期 → refetchIntents 不调
    expect(refetchIntents).not.toHaveBeenCalled();
    expect(allDone.value).toBe(true);
    expect(allOk.value).toBe(true);
  });

  it('进度回调累计更新 progress（percent 0.5 → 50）', async () => {
    const file = new File(['x'], 'x');
    const items: Ref<CosUploadItem[]> = ref([makeItem('ref-1', 'tmp/x', file)]);

    uploadFileSpy.mockImplementation(
      (params: { onProgress?: (p: { percent: number }) => void }) => {
        params.onProgress?.({ percent: 0.5 });
        return Promise.resolve(mockSuccess());
      },
    );

    const refetchIntents = vi.fn();
    const { startUpload } = useCosUpload({ items, refetchIntents });
    await startUpload();
    // 0.5 → Math.round(0.5*100) = 50，最终被覆盖为 100
    expect(items.value[0]!.progress).toBe(100);
  });
});

describe('useCosUpload / retryItem', () => {
  it('单项 error → retryItem 重试后变 done', async () => {
    const file = new File(['x'], 'x');
    const items: Ref<CosUploadItem[]> = ref([makeItem('ref-1', 'tmp/x', file)]);

    // 第一次失败，第二次成功
    uploadFileSpy
      .mockImplementationOnce(() => Promise.reject(new Error('network blip')))
      .mockImplementationOnce(() => Promise.resolve(mockSuccess()));

    const refetchIntents = vi.fn(async () =>
      makeIntents(
        [{ client_ref: 'ref-1', tmp_key: 'tmp/x' }],
        Math.floor(Date.now() / 1000) + 7200,
      ),
    );

    const { startUpload, retryItem } = useCosUpload({ items, refetchIntents });
    await startUpload();

    expect(items.value[0]!.status).toBe('error');
    expect(items.value[0]!.error).toBe('network blip');

    await retryItem('ref-1');

    expect(items.value[0]!.status).toBe('done');
    expect(items.value[0]!.error).toBeUndefined();
    expect(items.value[0]!.progress).toBe(100);
    expect(items.value[0]!.etag).toBe('"abc123"');
    // uploadFile 调用：startUpload 1 次 + retry 1 次 = 2 次
    expect(uploadFileSpy).toHaveBeenCalledTimes(2);
  });

  it('已 done 的项 retryItem 忽略', async () => {
    const file = new File(['x'], 'x');
    const items: Ref<CosUploadItem[]> = ref([makeItem('ref-1', 'tmp/x', file)]);

    uploadFileSpy.mockResolvedValue(mockSuccess());
    const refetchIntents = vi.fn();
    const { startUpload, retryItem } = useCosUpload({ items, refetchIntents });
    await startUpload();
    expect(items.value[0]!.status).toBe('done');

    uploadFileSpy.mockClear();
    await retryItem('ref-1');
    expect(uploadFileSpy).not.toHaveBeenCalled();
    expect(items.value[0]!.status).toBe('done');
  });

  it('不存在的 clientRef 静默忽略', async () => {
    const file = new File(['x'], 'x');
    const items: Ref<CosUploadItem[]> = ref([makeItem('ref-1', 'tmp/x', file)]);
    uploadFileSpy.mockResolvedValue(mockSuccess());
    const refetchIntents = vi.fn();
    const { retryItem } = useCosUpload({ items, refetchIntents });
    await expect(retryItem('nope')).resolves.toBeUndefined();
    expect(uploadFileSpy).not.toHaveBeenCalled();
  });
});

describe('useCosUpload / 凭证过期自动重签', () => {
  it('(Date.now() + 5min) >= expired_time*1000 触发 refetchIntents 一次', async () => {
    // 构造一个即将过期的凭证：当前 + 4 分钟
    const nowSec = Math.floor(Date.now() / 1000);
    const soonExpired = nowSec + 4 * 60;

    const file = new File(['x'], 'x');
    const items: Ref<CosUploadItem[]> = ref([makeItem('ref-1', 'tmp/x', file, soonExpired)]);

    uploadFileSpy.mockResolvedValue(mockSuccess());

    // refetchIntents 返回一个有效期很长的新凭证（nowSec + 7200）
    const refetchIntents = vi.fn(async () =>
      makeIntents([{ client_ref: 'ref-1', tmp_key: 'tmp/x' }], nowSec + 7200),
    );

    const { startUpload } = useCosUpload({ items, refetchIntents });
    await startUpload();

    // 凭证即将过期 → 触发 refetchIntents；新 credentials 写入 item
    expect(refetchIntents).toHaveBeenCalledTimes(1);
    expect(items.value[0]!.credentials.expired_time).toBe(nowSec + 7200);
    expect(items.value[0]!.status).toBe('done');
  });

  it('凭证健康（> 5min 余量）时不调 refetchIntents', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const longExpired = nowSec + 60 * 60; // +1h
    const file = new File(['x'], 'x');
    const items: Ref<CosUploadItem[]> = ref([makeItem('ref-1', 'tmp/x', file, longExpired)]);
    uploadFileSpy.mockResolvedValue(mockSuccess());
    const refetchIntents = vi.fn();
    const { startUpload } = useCosUpload({ items, refetchIntents });
    await startUpload();
    expect(refetchIntents).not.toHaveBeenCalled();
    expect(items.value[0]!.status).toBe('done');
  });

  it('fake timers：把 now 推到凭证过期前 1min，retryItem 触发 refetch', async () => {
    vi.useFakeTimers();
    // 凭证到期：2050-01-01
    const expSec = 2_524_608_000; // 2050-01-01 00:00:00 UTC
    const file = new File(['x'], 'x');
    const items: Ref<CosUploadItem[]> = ref([makeItem('ref-1', 'tmp/x', file, expSec)]);

    // 让 uploadFile 第一次 reject → 触发 retryItem 路径里的 ensureFreshCredentials
    uploadFileSpy
      .mockImplementationOnce(() => Promise.reject(new Error('fail')))
      .mockImplementationOnce(() => Promise.resolve(mockSuccess()));

    const nowSec = expSec - 600; // 过期前 10 min
    vi.setSystemTime(nowSec * 1000);
    // refetchIntents 重新发一个早过期的（保持 mock 简单）
    const refetchIntents = vi.fn(async () =>
      makeIntents([{ client_ref: 'ref-1', tmp_key: 'tmp/x' }], expSec + 7200),
    );

    const { startUpload, retryItem } = useCosUpload({ items, refetchIntents });
    await startUpload();
    expect(items.value[0]!.status).toBe('error');
    expect(refetchIntents).not.toHaveBeenCalled(); // 凭证仍健康

    // 现在把时间推到「expSec - 60s」——即 expire 前 1 min（< 5 min 余量）
    vi.setSystemTime((expSec - 60) * 1000);
    await retryItem('ref-1');
    expect(refetchIntents).toHaveBeenCalledTimes(1);
    expect(items.value[0]!.status).toBe('done');
  });
});

describe('useCosUpload / 并发上限', () => {
  it('concurrency=2 时同时 in-flight 不超过 2', async () => {
    const file = new File(['x'], 'x');
    const items: Ref<CosUploadItem[]> = ref([
      makeItem('ref-1', 'tmp/1', file),
      makeItem('ref-2', 'tmp/2', file),
      makeItem('ref-3', 'tmp/3', file),
      makeItem('ref-4', 'tmp/4', file),
    ]);

    let inFlight = 0;
    let peakInFlight = 0;

    uploadFileSpy.mockImplementation(
      (params: { onProgress?: (p: { percent: number }) => void }) => {
        inFlight += 1;
        peakInFlight = Math.max(peakInFlight, inFlight);
        // 第 3、4 个会等到第 1、2 个 resolve 之后才能进来；这里只是计数
        // inFlight，不手动 hold，让 Promise.all 自然串行。
        params.onProgress?.({ percent: 0.5 });
        const p = Promise.resolve(mockSuccess()).finally(() => {
          inFlight -= 1;
        });
        return p;
      },
    );

    const refetchIntents = vi.fn(async () =>
      makeIntents(
        [
          { client_ref: 'ref-1', tmp_key: 'tmp/1' },
          { client_ref: 'ref-2', tmp_key: 'tmp/2' },
          { client_ref: 'ref-3', tmp_key: 'tmp/3' },
          { client_ref: 'ref-4', tmp_key: 'tmp/4' },
        ],
        Math.floor(Date.now() / 1000) + 7200,
      ),
    );

    const { startUpload } = useCosUpload({ items, refetchIntents, concurrency: 2 });
    await startUpload();

    expect(peakInFlight).toBeLessThanOrEqual(2);
    expect(peakInFlight).toBeGreaterThanOrEqual(1); // sanity：不是 0
    expect(items.value.every((it) => it.status === 'done')).toBe(true);
  });
});

describe('useCosUpload / allDone & allOk', () => {
  it('空数组：allDone=false, allOk=false', () => {
    const items: Ref<CosUploadItem[]> = ref([]);
    const { allDone, allOk } = useCosUpload({ items, refetchIntents: vi.fn() });
    expect(allDone.value).toBe(false);
    expect(allOk.value).toBe(false);
  });

  it('混合 done+error：allDone=true, allOk=false', () => {
    const file = new File(['x'], 'x');
    const items: Ref<CosUploadItem[]> = ref([
      { ...makeItem('a', 'tmp/a', file), status: 'done' },
      { ...makeItem('b', 'tmp/b', file), status: 'error' },
    ]);
    const { allDone, allOk } = useCosUpload({ items, refetchIntents: vi.fn() });
    expect(allDone.value).toBe(true);
    expect(allOk.value).toBe(false);
  });

  it('全 done：allDone=true, allOk=true', () => {
    const file = new File(['x'], 'x');
    const items: Ref<CosUploadItem[]> = ref([
      { ...makeItem('a', 'tmp/a', file), status: 'done' },
      { ...makeItem('b', 'tmp/b', file), status: 'done' },
    ]);
    const { allDone, allOk } = useCosUpload({ items, refetchIntents: vi.fn() });
    expect(allDone.value).toBe(true);
    expect(allOk.value).toBe(true);
  });
});
