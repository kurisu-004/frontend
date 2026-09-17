// useCosUploader 单元测试（2026-09-17 frontend-overall-cos-direct-upload）。
//
// 验证通用版 composable 的状态机 / 并发 / 凭证过期 / tmp_key 变化兜底：
// - startUpload 走通：所有 item.status=done，progress=100，etag 写入；
// - computeHash=true 时先 hashing 再 uploading（mock @/utils/fileHash）；
// - 单文件 error → retryItem 重试后变 done；
// - 凭证过期触发 refetchSession（fake timers + mock api）；
// - tmp_key 变化 → applyFreshSession 强制 reset pending；
// - 并发上限（concurrency=2 时同时 in-flight 的 uploadOne 不超过 2）；
// - allDone / allOk 计算属性语义正确；
// - buildCosUploadItems 把 session.items 顺序对齐到 files。
//
// 与 useCosUpload.spec.ts 的差异：
// - 通用版 item 不携带 credentials / bucket / region / tmp_prefix，这些"批级
//   元数据"存在 session 顶层；测试构造 session 时一并塞；
// - 通用版支持 computeHash 开关（useCosUpload 不支持）；
// - 通用版 buildCosUploadItems 不复用 session.items[i].client_ref，composable
//   自己生成（测试需验证 client_ref 是 uuid-like）；
// - 通用版凭证在 session 顶层、不在 item 上，测试统一用 `initialSession` 把
//   已拿到的 session 传给 useCosUploader，避免 composable 首次主动
//   refetchSession（caller 模式：先拿 session → buildCosUploadItems →
//   useCosUploader({initialSession})）。
//
// 2026-09-17：刻意不写 happy-dom 环境指令 —— 本 spec 只用到 `File` 全局与
// `crypto.randomUUID`，Node 24+ 已内置 File / Blob / Web Crypto；vitest 默认
// node 环境即可跑。节省 happy-dom peerDeps（项目 package.json 未声明
// happy-dom，避免新增 devDep）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ref, type Ref } from 'vue';
import {
  buildCosUploadItems,
  useCosUploader,
  type CosUploadSession,
  type CosUploaderItem,
} from '../useCosUploader';
import type { CosCredentials } from '@/types/cos_upload';

// ============ mock cos-js-sdk-v5 ============
const uploadFileSpy = vi.fn();
const cosConstructSpy = vi.fn();

vi.mock('cos-js-sdk-v5', () => {
  class MockCOS {
    public constructor(opts: Record<string, unknown>) {
      cosConstructSpy(opts);
    }
    public uploadFile(params: Record<string, unknown>) {
      return uploadFileSpy(params);
    }
  }
  return { default: MockCOS };
});

// ============ mock @/utils/fileHash ============
//
// useCosUploader 在 computeHash=true 时调用 computeSha256；单测里我们用 vi.mock
// 替换成可控 stub，避开 happy-dom 没 stream API / 没 hash-wasm 加载的问题。
const computeSha256Spy = vi.fn();

vi.mock('@/utils/fileHash', () => ({
  computeSha256: (
    file: File,
    onProgress?: (p: { bytesHashed: number; totalBytes: number }) => void,
  ) => computeSha256Spy(file, onProgress),
}));

// ============ helpers ============
function makeCredentials(expiredTime: number): CosCredentials {
  return {
    tmp_secret_id: 'AKID',
    tmp_secret_key: 'SECRET',
    session_token: 'TOKEN',
    expired_time: expiredTime,
  };
}

function makeSession(
  tmpKeys: string[],
  expiredTime = Math.floor(Date.now() / 1000) + 7200,
): CosUploadSession {
  return {
    credentials: makeCredentials(expiredTime),
    bucket: 'bucket-1250000000',
    region: 'ap-shanghai',
    items: tmpKeys.map((k) => ({ client_ref: `srv-${k}`, tmp_key: k })),
  };
}

/** 模拟 cos.uploadFile 的「成功 + onProgress 走一遍」输出。 */
function mockSuccess(): { ETag: string; Location: string } {
  return { ETag: '"abc123"', Location: 'bucket-1250000000.cos.ap-shanghai.myqcloud.com/x' };
}

beforeEach(() => {
  uploadFileSpy.mockReset();
  cosConstructSpy.mockReset();
  computeSha256Spy.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

// ============ tests: buildCosUploadItems ============
describe('buildCosUploadItems', () => {
  it('把 session.items 顺序对齐到 files，每个 item 初始 status=pending, progress=0', () => {
    const f1 = new File(['hello'], 'a.pdf', { type: 'application/pdf' });
    const f2 = new File(['world'], 'b.stp', { type: 'application/octet-stream' });
    const session = makeSession(['tmp/a.pdf', 'tmp/b.stp']);
    const items = buildCosUploadItems([f1, f2], session);

    expect(items.length).toBe(2);
    expect(items[0]!.tmp_key).toBe('tmp/a.pdf');
    expect(items[0]!.file).toBe(f1);
    expect(items[0]!.status).toBe('pending');
    expect(items[0]!.progress).toBe(0);
    expect(items[0]!.error).toBeUndefined();
    expect(items[0]!.etag).toBeUndefined();
    expect(items[1]!.tmp_key).toBe('tmp/b.stp');
    expect(items[1]!.file).toBe(f2);

    // client_ref 是 composable 生成的（uuid-like 或 fallback），不沿用 session.client_ref
    expect(typeof items[0]!.client_ref).toBe('string');
    expect(items[0]!.client_ref.length).toBeGreaterThan(0);
    // 多个 item 的 client_ref 必须不同（除非极小概率碰撞，但生成器是 uuid）
    expect(items[0]!.client_ref).not.toBe(items[1]!.client_ref);
  });

  it('files.length !== session.items.length 时按短端截断', () => {
    const session = makeSession(['tmp/a', 'tmp/b', 'tmp/c']);
    const items = buildCosUploadItems([new File(['x'], 'x')], session);
    expect(items.length).toBe(1);
    expect(items[0]!.tmp_key).toBe('tmp/a');
  });
});

// ============ tests: startUpload ============
describe('useCosUploader / startUpload', () => {
  it('所有 item 走通：status=done, progress=100, etag 写入', async () => {
    const f1 = new File(['hello'], 'a.pdf', { type: 'application/pdf' });
    const f2 = new File(['world'], 'b.stp', { type: 'application/octet-stream' });
    const session = makeSession(['tmp/a.pdf', 'tmp/b.stp']);
    const items = buildCosUploadItems([f1, f2], session);
    const itemsRef: Ref<CosUploaderItem[]> = ref(items);

    uploadFileSpy.mockImplementation(
      (params: { onProgress?: (p: { percent: number }) => void }) => {
        params.onProgress?.({ percent: 0.5 });
        return Promise.resolve(mockSuccess());
      },
    );

    const refetchSession = vi.fn(async () => session);

    const { startUpload, allDone, allOk } = useCosUploader({
      items: itemsRef,
      refetchSession,
      initialSession: session,
    });
    await startUpload();

    expect(itemsRef.value.every((it) => it.status === 'done')).toBe(true);
    expect(itemsRef.value.every((it) => it.progress === 100)).toBe(true);
    expect(itemsRef.value.every((it) => it.etag === '"abc123"')).toBe(true);
    expect(itemsRef.value.every((it) => it.error === undefined)).toBe(true);
    expect(uploadFileSpy).toHaveBeenCalledTimes(2);
    expect(cosConstructSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(allDone.value).toBe(true);
    expect(allOk.value).toBe(true);
  });

  it('computeHash=true 时先 hashing 再 uploading，hash 失败 → status=error', async () => {
    const f1 = new File(['hello'], 'a.pdf');
    const session = makeSession(['tmp/a.pdf']);
    const items = buildCosUploadItems([f1], session);
    const itemsRef: Ref<CosUploaderItem[]> = ref(items);

    const phaseSeen: string[] = [];
    computeSha256Spy.mockImplementation(
      (_file: File, onProgress?: (p: { bytesHashed: number; totalBytes: number }) => void) => {
        phaseSeen.push('hash-start');
        onProgress?.({ bytesHashed: 5, totalBytes: 10 });
        return Promise.resolve('deadbeef'.repeat(8));
      },
    );
    uploadFileSpy.mockImplementation(
      (params: { onProgress?: (p: { percent: number }) => void }) => {
        phaseSeen.push('upload-start');
        params.onProgress?.({ percent: 0.5 });
        return Promise.resolve(mockSuccess());
      },
    );

    const refetchSession = vi.fn(async () => session);
    const { startUpload } = useCosUploader({
      items: itemsRef,
      refetchSession,
      initialSession: session,
      computeHash: true,
    });
    await startUpload();

    // 调用顺序：hash 必须在 upload 之前
    expect(phaseSeen[0]).toBe('hash-start');
    expect(phaseSeen).toContain('upload-start');
    expect(phaseSeen.indexOf('hash-start')).toBeLessThan(phaseSeen.indexOf('upload-start'));
    // hash 阶段进度在前 30%
    expect(itemsRef.value[0]!.progress).toBe(100); // 最终被 done 覆盖
    expect(itemsRef.value[0]!.sha256).toBe('deadbeef'.repeat(8));
    expect(itemsRef.value[0]!.status).toBe('done');
  });

  it('computeHash=true 但 hash 抛错 → status=error 且 uploadFile 不被调用', async () => {
    const f1 = new File(['x'], 'x');
    const session = makeSession(['tmp/x']);
    const items = buildCosUploadItems([f1], session);
    const itemsRef: Ref<CosUploaderItem[]> = ref(items);

    computeSha256Spy.mockRejectedValue(new Error('hash oom'));
    uploadFileSpy.mockResolvedValue(mockSuccess());

    const refetchSession = vi.fn(async () => session);
    const { startUpload } = useCosUploader({
      items: itemsRef,
      refetchSession,
      initialSession: session,
      computeHash: true,
    });
    await startUpload();

    expect(itemsRef.value[0]!.status).toBe('error');
    expect(itemsRef.value[0]!.error).toBe('hash oom');
    expect(itemsRef.value[0]!.progress).toBe(0);
    expect(uploadFileSpy).not.toHaveBeenCalled();
  });
});

// ============ tests: retryItem ============
describe('useCosUploader / retryItem', () => {
  it('单项 error → retryItem 重试后变 done', async () => {
    const session = makeSession(['tmp/x']);
    const items = buildCosUploadItems([new File(['x'], 'x')], session);
    const itemsRef: Ref<CosUploaderItem[]> = ref(items);

    uploadFileSpy
      .mockImplementationOnce(() => Promise.reject(new Error('network blip')))
      .mockImplementationOnce(() => Promise.resolve(mockSuccess()));

    const refetchSession = vi.fn(async () => session);
    const { startUpload, retryItem } = useCosUploader({
      items: itemsRef,
      refetchSession,
      initialSession: session,
    });
    await startUpload();
    expect(itemsRef.value[0]!.status).toBe('error');
    expect(itemsRef.value[0]!.error).toBe('network blip');

    await retryItem(itemsRef.value[0]!.client_ref);

    expect(itemsRef.value[0]!.status).toBe('done');
    expect(itemsRef.value[0]!.error).toBeUndefined();
    expect(itemsRef.value[0]!.progress).toBe(100);
    expect(itemsRef.value[0]!.etag).toBe('"abc123"');
    expect(uploadFileSpy).toHaveBeenCalledTimes(2);
  });

  it('已 done 的项 retryItem 忽略', async () => {
    const session = makeSession(['tmp/x']);
    const items = buildCosUploadItems([new File(['x'], 'x')], session);
    const itemsRef: Ref<CosUploaderItem[]> = ref(items);
    uploadFileSpy.mockResolvedValue(mockSuccess());
    const refetchSession = vi.fn(async () => session);
    const { startUpload, retryItem } = useCosUploader({
      items: itemsRef,
      refetchSession,
      initialSession: session,
    });
    await startUpload();
    expect(itemsRef.value[0]!.status).toBe('done');

    uploadFileSpy.mockClear();
    await retryItem(itemsRef.value[0]!.client_ref);
    expect(uploadFileSpy).not.toHaveBeenCalled();
    expect(itemsRef.value[0]!.status).toBe('done');
  });

  it('不存在的 clientRef 静默忽略', async () => {
    const session = makeSession(['tmp/x']);
    const items = buildCosUploadItems([new File(['x'], 'x')], session);
    const itemsRef: Ref<CosUploaderItem[]> = ref(items);
    uploadFileSpy.mockResolvedValue(mockSuccess());
    const refetchSession = vi.fn(async () => session);
    const { retryItem } = useCosUploader({
      items: itemsRef,
      refetchSession,
      initialSession: session,
    });
    await expect(retryItem('nope')).resolves.toBeUndefined();
    expect(uploadFileSpy).not.toHaveBeenCalled();
  });
});

// ============ tests: 凭证过期自动重签 ============
describe('useCosUploader / 凭证过期自动重签', () => {
  it('(Date.now() + 5min) >= expired_time*1000 触发 refetchSession 一次', async () => {
    // 即将过期的凭证：当前 + 4 分钟
    const nowSec = Math.floor(Date.now() / 1000);
    const soonExpired = nowSec + 4 * 60;
    const session = makeSession(['tmp/x'], soonExpired);
    const items = buildCosUploadItems([new File(['x'], 'x')], session);
    const itemsRef: Ref<CosUploaderItem[]> = ref(items);
    uploadFileSpy.mockResolvedValue(mockSuccess());

    const refetchSession = vi.fn(async () => makeSession(['tmp/x'], nowSec + 7200));

    const { startUpload } = useCosUploader({
      items: itemsRef,
      refetchSession,
      initialSession: session,
    });
    await startUpload();

    // 凭证即将过期 → 触发 refetchSession；新 session 已写入 sessionCache
    expect(refetchSession).toHaveBeenCalledTimes(1);
    expect(itemsRef.value[0]!.status).toBe('done');
  });

  it('凭证健康（> 5min 余量）时不调 refetchSession', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const longExpired = nowSec + 60 * 60; // +1h
    const session = makeSession(['tmp/x'], longExpired);
    const items = buildCosUploadItems([new File(['x'], 'x')], session);
    const itemsRef: Ref<CosUploaderItem[]> = ref(items);
    uploadFileSpy.mockResolvedValue(mockSuccess());
    const refetchSession = vi.fn(async () => session);
    const { startUpload } = useCosUploader({
      items: itemsRef,
      refetchSession,
      initialSession: session,
    });
    await startUpload();
    expect(refetchSession).not.toHaveBeenCalled();
    expect(itemsRef.value[0]!.status).toBe('done');
  });

  it('fake timers：把 now 推到凭证过期前 1min，retryItem 触发 refetch', async () => {
    vi.useFakeTimers();
    const expSec = 2_524_608_000; // 2050-01-01
    const session = makeSession(['tmp/x'], expSec);
    const items = buildCosUploadItems([new File(['x'], 'x')], session);
    const itemsRef: Ref<CosUploaderItem[]> = ref(items);

    uploadFileSpy
      .mockImplementationOnce(() => Promise.reject(new Error('fail')))
      .mockImplementationOnce(() => Promise.resolve(mockSuccess()));

    const nowSec = expSec - 600; // 过期前 10 min
    vi.setSystemTime(nowSec * 1000);
    const refetchSession = vi.fn(async () => makeSession(['tmp/x'], expSec + 7200));

    const { startUpload, retryItem } = useCosUploader({
      items: itemsRef,
      refetchSession,
      initialSession: session,
    });
    await startUpload();
    expect(itemsRef.value[0]!.status).toBe('error');
    expect(refetchSession).not.toHaveBeenCalled();

    // 推到「expSec - 60s」——即 expire 前 1 min（< 5 min 余量）
    vi.setSystemTime((expSec - 60) * 1000);
    await retryItem(itemsRef.value[0]!.client_ref);
    expect(refetchSession).toHaveBeenCalledTimes(1);
    expect(itemsRef.value[0]!.status).toBe('done');
  });
});

// ============ tests: applyFreshSession（tmp_key 变化兜底）============
describe('useCosUploader / applyFreshSession (tmp_key 变化兜底)', () => {
  /** 让 makeCredentials 的 expired_time 落在「即将过期」区间（< 5 min 余量）。 */
  function expiringExpiredTime(): number {
    return Math.floor(Date.now() / 1000) + 60;
  }

  it('tmp_key 不变 + 之前 done → 仅刷 sessionCache，status/progress/etag 不动', async () => {
    const expSec = expiringExpiredTime();
    const session = makeSession(['tmp/x.pdf'], expSec);
    const items = buildCosUploadItems([new File(['x'], 'x.pdf')], session);
    const itemsRef: Ref<CosUploaderItem[]> = ref(items);
    // 预置为 done（先跑一次成功）
    itemsRef.value[0]!.status = 'done';
    itemsRef.value[0]!.progress = 100;
    itemsRef.value[0]!.etag = '"old-etag"';

    uploadFileSpy.mockResolvedValue(mockSuccess());
    const refetchSession = vi.fn(async () => makeSession(['tmp/x.pdf'], expSec + 7200));
    const { startUpload } = useCosUploader({
      items: itemsRef,
      refetchSession,
      initialSession: session,
    });
    await startUpload();

    // tmp_key 一致 → status 保持 done
    expect(refetchSession).toHaveBeenCalledTimes(1);
    expect(itemsRef.value[0]!.status).toBe('done');
    expect(itemsRef.value[0]!.progress).toBe(100);
    expect(itemsRef.value[0]!.etag).toBe('"old-etag"');
    expect(itemsRef.value[0]!.tmp_key).toBe('tmp/x.pdf');
    // done 不进 targets → uploadFile 不被调用
    expect(uploadFileSpy).not.toHaveBeenCalled();
  });

  it('tmp_key 变化 + 之前 done → 强制 reset pending + 用新 tmp_key 重传', async () => {
    const expSec = expiringExpiredTime();
    const session = makeSession(['tmp/old.pdf'], expSec);
    const items = buildCosUploadItems([new File(['x'], 'x.pdf')], session);
    const itemsRef: Ref<CosUploaderItem[]> = ref(items);
    itemsRef.value[0]!.status = 'done';
    itemsRef.value[0]!.progress = 100;
    itemsRef.value[0]!.etag = '"old-etag"';

    uploadFileSpy.mockRejectedValue(new Error('mock upload fail'));
    const refetchSession = vi.fn(async () => makeSession(['tmp/new.pdf'], expSec + 7200));
    const { startUpload } = useCosUploader({
      items: itemsRef,
      refetchSession,
      initialSession: session,
    });
    await startUpload();

    expect(itemsRef.value[0]!.tmp_key).toBe('tmp/new.pdf');
    expect(uploadFileSpy).toHaveBeenCalledTimes(1);
    expect(uploadFileSpy.mock.calls[0]![0]).toEqual(
      expect.objectContaining({ Key: 'tmp/new.pdf' }),
    );
    expect(itemsRef.value[0]!.status).toBe('error');
    expect(itemsRef.value[0]!.error).toBe('mock upload fail');
  });

  it('tmp_key 变化 + 之前 error → 强制 reset pending + 清 error', async () => {
    const expSec = expiringExpiredTime();
    const session = makeSession(['tmp/old.pdf'], expSec);
    const items = buildCosUploadItems([new File(['x'], 'x.pdf')], session);
    const itemsRef: Ref<CosUploaderItem[]> = ref(items);
    itemsRef.value[0]!.status = 'error';
    itemsRef.value[0]!.progress = 0;
    itemsRef.value[0]!.error = '先前失败';

    uploadFileSpy.mockRejectedValue(new Error('still fail'));
    const refetchSession = vi.fn(async () => makeSession(['tmp/new.pdf'], expSec + 7200));
    const { startUpload } = useCosUploader({
      items: itemsRef,
      refetchSession,
      initialSession: session,
    });
    await startUpload();

    expect(itemsRef.value[0]!.tmp_key).toBe('tmp/new.pdf');
    expect(uploadFileSpy.mock.calls[0]![0]).toEqual(
      expect.objectContaining({ Key: 'tmp/new.pdf' }),
    );
    expect(itemsRef.value[0]!.status).toBe('error');
    expect(itemsRef.value[0]!.error).toBe('still fail'); // 被新 error 覆盖，证明 reset 清空旧 error 后才被覆盖
  });

  it('tmp_key 变化 + 之前 uploading → 强制 mark error，避免 in-flight 写到旧 key', async () => {
    const expSec = expiringExpiredTime();
    const session = makeSession(['tmp/old.pdf'], expSec);
    const items = buildCosUploadItems([new File(['x'], 'x.pdf')], session);
    const itemsRef: Ref<CosUploaderItem[]> = ref(items);
    itemsRef.value[0]!.status = 'uploading';
    itemsRef.value[0]!.progress = 50;

    uploadFileSpy.mockResolvedValue(mockSuccess()); // 不应被调用
    const refetchSession = vi.fn(async () => makeSession(['tmp/new.pdf'], expSec + 7200));
    const { startUpload } = useCosUploader({
      items: itemsRef,
      refetchSession,
      initialSession: session,
    });
    await startUpload();

    expect(itemsRef.value[0]!.tmp_key).toBe('tmp/new.pdf');
    expect(itemsRef.value[0]!.status).toBe('error');
    expect(itemsRef.value[0]!.progress).toBe(0);
    expect(itemsRef.value[0]!.error).toMatch(/重签时上传进行中/);
    expect(uploadFileSpy).not.toHaveBeenCalled();
  });

  it('旧 tmp_key 存在 + 新 tmp_key 为空 → 强制 mark error（极端兜底）', async () => {
    const expSec = expiringExpiredTime();
    const session = makeSession(['tmp/old.pdf'], expSec);
    const items = buildCosUploadItems([new File(['x'], 'x.pdf')], session);
    const itemsRef: Ref<CosUploaderItem[]> = ref(items);
    itemsRef.value[0]!.status = 'done';
    itemsRef.value[0]!.progress = 100;
    itemsRef.value[0]!.etag = '"old"';

    uploadFileSpy.mockResolvedValue(mockSuccess());
    const refetchSession = vi.fn(async () => makeSession([''], expSec + 7200));
    const { startUpload } = useCosUploader({
      items: itemsRef,
      refetchSession,
      initialSession: session,
    });
    await startUpload();

    expect(itemsRef.value[0]!.status).toBe('error');
    expect(itemsRef.value[0]!.error).toMatch(/tmp_key 缺失/);
    expect(uploadFileSpy).not.toHaveBeenCalled();
  });
});

// ============ tests: 并发上限 ============
describe('useCosUploader / 并发上限', () => {
  it('concurrency=2 时同时 in-flight 不超过 2', async () => {
    const files = [
      new File(['1'], '1'),
      new File(['2'], '2'),
      new File(['3'], '3'),
      new File(['4'], '4'),
    ];
    const session = makeSession(['tmp/1', 'tmp/2', 'tmp/3', 'tmp/4']);
    const items = buildCosUploadItems(files, session);
    const itemsRef: Ref<CosUploaderItem[]> = ref(items);

    let inFlight = 0;
    let peakInFlight = 0;
    uploadFileSpy.mockImplementation(
      (params: { onProgress?: (p: { percent: number }) => void }) => {
        inFlight += 1;
        peakInFlight = Math.max(peakInFlight, inFlight);
        params.onProgress?.({ percent: 0.5 });
        const p = Promise.resolve(mockSuccess()).finally(() => {
          inFlight -= 1;
        });
        return p;
      },
    );

    const refetchSession = vi.fn(async () => session);
    const { startUpload } = useCosUploader({
      items: itemsRef,
      refetchSession,
      initialSession: session,
      concurrency: 2,
    });
    await startUpload();

    expect(peakInFlight).toBeLessThanOrEqual(2);
    expect(peakInFlight).toBeGreaterThanOrEqual(1);
    expect(itemsRef.value.every((it) => it.status === 'done')).toBe(true);
  });
});

// ============ tests: allDone / allOk ============
describe('useCosUploader / allDone & allOk', () => {
  it('空数组：allDone=false, allOk=false', () => {
    const itemsRef: Ref<CosUploaderItem[]> = ref([]);
    const { allDone, allOk } = useCosUploader({
      items: itemsRef,
      refetchSession: vi.fn(),
    });
    expect(allDone.value).toBe(false);
    expect(allOk.value).toBe(false);
  });

  it('混合 done+error：allDone=true, allOk=false', () => {
    const session = makeSession(['tmp/a', 'tmp/b']);
    const items = buildCosUploadItems([new File(['x'], 'a'), new File(['y'], 'b')], session);
    items[0]!.status = 'done';
    items[1]!.status = 'error';
    const itemsRef: Ref<CosUploaderItem[]> = ref(items);
    const { allDone, allOk } = useCosUploader({
      items: itemsRef,
      refetchSession: vi.fn(),
      initialSession: session,
    });
    expect(allDone.value).toBe(true);
    expect(allOk.value).toBe(false);
  });

  it('全 done：allDone=true, allOk=true', () => {
    const session = makeSession(['tmp/a', 'tmp/b']);
    const items = buildCosUploadItems([new File(['x'], 'a'), new File(['y'], 'b')], session);
    items[0]!.status = 'done';
    items[1]!.status = 'done';
    const itemsRef: Ref<CosUploaderItem[]> = ref(items);
    const { allDone, allOk } = useCosUploader({
      items: itemsRef,
      refetchSession: vi.fn(),
      initialSession: session,
    });
    expect(allDone.value).toBe(true);
    expect(allOk.value).toBe(true);
  });

  it('包含 hashing：allDone=false（hashing 不算终态）', () => {
    const session = makeSession(['tmp/a']);
    const items = buildCosUploadItems([new File(['x'], 'a')], session);
    items[0]!.status = 'hashing';
    const itemsRef: Ref<CosUploaderItem[]> = ref(items);
    const { allDone } = useCosUploader({
      items: itemsRef,
      refetchSession: vi.fn(),
      initialSession: session,
    });
    expect(allDone.value).toBe(false);
  });
});
