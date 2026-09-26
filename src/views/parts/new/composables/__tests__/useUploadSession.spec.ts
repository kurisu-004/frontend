// useUploadSession 单元测试（2026-09-18 frontend-upload-session-pool）。
//
// 验证 backend-rust `/api/v2/upload-sessions/*` session pool composable：
// - init：调用 get-or-create 一次；重复 init 不重复调（命中复用）
// - renew：到期前 5min 自动续期（fake timers）；续期失败 30s 退避
// - allocate：响应回填到 session.files（按 client_ref 匹配 / 未命中 push）
// - markComplete：原子替换 session.files 中对应条目
// - removeFiles / consumeFiles：按后端响应同步本地 state
// - discard：清理 state + 取消定时器 + 从 Map 删除
// - computed credentials / bucket / region / tmpPrefix / files 跟随 session 变化
//
// 注意：模块级 Map 缓存「scope → state」，不同测试间必须用不同 scope 隔离
// 状态（否则上一个测试的 state 会泄漏到下一个）。本 spec 用 `test_${name}`
// 形式生成 scope 字符串。
//
// vi.mock 替换 api/files/uploadSession 整个模块：直接控制每个 endpoint 的
// 返回值 / 拒绝路径；不依赖真实 axios / happy-dom。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionFile, UploadSession } from '@/types/upload_session';

// ============ mock api/files/uploadSession ============
const getOrCreateUploadSession = vi.fn();
const allocateUploadSessionFiles = vi.fn();
const completeUploadSessionFile = vi.fn();
const removeUploadSessionFiles = vi.fn();
const renewUploadSessionCredentials = vi.fn();
const consumeUploadSessionFiles = vi.fn();
const discardUploadSession = vi.fn();

vi.mock('@/api/files/uploadSession', () => ({
  getOrCreateUploadSession: (payload: unknown) => getOrCreateUploadSession(payload),
  allocateUploadSessionFiles: (sid: string, payload: unknown) =>
    allocateUploadSessionFiles(sid, payload),
  completeUploadSessionFile: (sid: string, ref: string, payload: unknown) =>
    completeUploadSessionFile(sid, ref, payload),
  removeUploadSessionFiles: (sid: string, payload: unknown) =>
    removeUploadSessionFiles(sid, payload),
  renewUploadSessionCredentials: (sid: string, payload: unknown) =>
    renewUploadSessionCredentials(sid, payload),
  consumeUploadSessionFiles: (sid: string, payload: unknown) =>
    consumeUploadSessionFiles(sid, payload),
  discardUploadSession: (sid: string, payload: unknown) => discardUploadSession(sid, payload),
}));

// 必须 vi.mock 之后才能 import（避免 ESM hoist 后拿到未 mock 的版本）
const { getUploadSession } = await import('../useUploadSession');

// ============ helpers ============

/** 在当前时间基础上加 N 秒的 expired_time。 */
function expIn(seconds: number): number {
  return Math.floor(Date.now() / 1000) + seconds;
}

/** 构造一个 UploadSession（带 N 个空 files）。 */
function makeSession(overrides?: Partial<UploadSession>): UploadSession {
  return {
    session_id: 'sess-1',
    scope: 'parts_new',
    tmp_prefix: 'tmp/parts_new/',
    bucket: 'bucket-1250000000',
    region: 'ap-shanghai',
    credentials: {
      tmp_secret_id: 'AKID',
      tmp_secret_key: 'SECRET',
      session_token: 'TOKEN',
      start_time: Math.floor(Date.now() / 1000),
      expired_time: expIn(3600),
    },
    expires_in: 3600,
    files: [],
    ...overrides,
  };
}

/** 构造一个 SessionFile。 */
function makeFile(overrides?: Partial<SessionFile>): SessionFile {
  return {
    client_ref: 'ref-default',
    kind: 'drawing' as const,
    original_filename: 'a.pdf',
    file_size: 1024,
    content_type: 'application/pdf',
    content_sha256: 'a'.repeat(64),
    tmp_key: 'tmp/parts_new/ref-default',
    status: 'pending',
    etag: null,
    uploaded_at: null,
    ...overrides,
  };
}

let testCounter = 0;
function uniqueScope(): 'parts_new' {
  // 所有测试都用 'parts_new'（与生产一致），但通过 discard + unique session_id
  // 隔离不同测试；getUploadSession 用 Map key=scope，重复 init 同 scope 会
  // 复用旧 state（除非已 discard），所以本测试在 setup 中调 discard 清场。
  return 'parts_new';
}

beforeEach(() => {
  vi.clearAllMocks();
  testCounter += 1;
  // 用 fake timers 控制 renew 定时器（注意：fake timers 会让 Date.now() 也走
  // 假时间，必须在 setSystemTime 之后再计算 expIn）。
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-18T12:00:00Z'));
});

afterEach(async () => {
  vi.useRealTimers();
  // 清理残留 state（防止泄漏到下一个测试）
  try {
    const u = getUploadSession('parts_new');
    await u.discard().catch(() => {
      /* 兜底 */
    });
  } catch {
    /* 没初始化过也无妨 */
  }
});

// ============ tests ============

describe('useUploadSession / init', () => {
  it('init 调一次 get-or-create；session 顶层字段全部可读', async () => {
    const sess = makeSession();
    getOrCreateUploadSession.mockResolvedValueOnce(sess);

    const u = getUploadSession(uniqueScope());
    expect(u.isReady.value).toBe(false);

    const out = await u.init('parts_new');
    expect(out.session_id).toBe('sess-1');
    expect(getOrCreateUploadSession).toHaveBeenCalledTimes(1);
    expect(getOrCreateUploadSession).toHaveBeenCalledWith({ scope: 'parts_new' });
    expect(u.isReady.value).toBe(true);
    expect(u.session.value?.bucket).toBe('bucket-1250000000');
    expect(u.bucket.value).toBe('bucket-1250000000');
    expect(u.region.value).toBe('ap-shanghai');
    expect(u.tmpPrefix.value).toBe('tmp/parts_new/');
    expect(u.credentials.value?.tmp_secret_id).toBe('AKID');
    expect(u.files.value).toEqual([]);
    expect(u.scope.value).toBe('parts_new');
  });

  it('重复 init 同 scope：第二次不调 get-or-create（命中复用）', async () => {
    const sess = makeSession({
      credentials: { ...makeSession().credentials, expired_time: expIn(3600) },
    });
    getOrCreateUploadSession.mockResolvedValueOnce(sess);

    const u = getUploadSession(uniqueScope());
    await u.init('parts_new');
    await u.init('parts_new');
    await u.init('parts_new');

    expect(getOrCreateUploadSession).toHaveBeenCalledTimes(1);
  });

  it('init 时凭证已临期（< 5min）→ 立即触发 renew', async () => {
    const sess = makeSession({
      credentials: { ...makeSession().credentials, expired_time: expIn(60) }, // 1min 后过期
    });
    getOrCreateUploadSession.mockResolvedValueOnce(sess);
    const freshExp = expIn(7200);
    renewUploadSessionCredentials.mockResolvedValueOnce({
      credentials: { ...sess.credentials, expired_time: freshExp },
      expires_in: 7200,
    });

    const u = getUploadSession(uniqueScope());
    // init 内部 scheduleRenew(delay<0) 触发 doRenew；fire-and-forget 微任务在
    // await init 期间就会被 await flush 掉，renew 已被调用 1 次。
    await u.init('parts_new');
    expect(renewUploadSessionCredentials).toHaveBeenCalledTimes(1);
    expect(u.credentials.value?.expired_time).toBe(freshExp);
  });
});

describe('useUploadSession / renew 定时器', () => {
  it('init 健康凭证 → 在 expired_time - 5min 触发 renew', async () => {
    const sess = makeSession({
      credentials: { ...makeSession().credentials, expired_time: expIn(600) }, // 10min 后过期
    });
    getOrCreateUploadSession.mockResolvedValueOnce(sess);
    // 用 hardcoded expired_time（不要 expIn，否则 fake timer 推进后断言对不上）
    const freshExp = expIn(7200);
    renewUploadSessionCredentials.mockResolvedValueOnce({
      credentials: { ...sess.credentials, expired_time: freshExp },
      expires_in: 7200,
    });

    const u = getUploadSession(uniqueScope());
    await u.init('parts_new');
    expect(renewUploadSessionCredentials).not.toHaveBeenCalled();

    // 快进 5 分钟（到 expired_time - 5min）→ 触发 renew
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(renewUploadSessionCredentials).toHaveBeenCalledTimes(1);
    // 续期成功后凭证已被刷新（用 mock 设置的 freshExp，不是当前 Date.now()）
    expect(u.credentials.value?.expired_time).toBe(freshExp);
  });

  it('renew 失败 → 30s 退避重试', async () => {
    const sess = makeSession({
      credentials: { ...makeSession().credentials, expired_time: expIn(600) },
    });
    getOrCreateUploadSession.mockResolvedValueOnce(sess);
    // 第一次 renew 拒绝，第二次成功（hardcoded freshExp，避免 fake timer 推进后断言对不上）
    const freshExp = expIn(7200);
    renewUploadSessionCredentials
      .mockRejectedValueOnce(new Error('network blip'))
      .mockResolvedValueOnce({
        credentials: { ...sess.credentials, expired_time: freshExp },
        expires_in: 7200,
      });

    const u = getUploadSession(uniqueScope());
    await u.init('parts_new');

    // 快进 5min → 第一次 renew（失败）
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(renewUploadSessionCredentials).toHaveBeenCalledTimes(1);

    // 快进 30s → 退避后第二次 renew（成功）
    await vi.advanceTimersByTimeAsync(30_000);
    expect(renewUploadSessionCredentials).toHaveBeenCalledTimes(2);
    expect(u.credentials.value?.expired_time).toBe(freshExp);
  });

  it('discard 后取消定时器', async () => {
    const sess = makeSession({
      credentials: { ...makeSession().credentials, expired_time: expIn(600) },
    });
    getOrCreateUploadSession.mockResolvedValueOnce(sess);
    discardUploadSession.mockResolvedValueOnce({ session_id: 'sess-1' });

    const u = getUploadSession(uniqueScope());
    await u.init('parts_new');
    await u.discard();

    // discard 后快进时间：renew 不应被调用
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(renewUploadSessionCredentials).not.toHaveBeenCalled();
    expect(u.session.value).toBeNull();
    expect(u.scope.value).toBeNull();
  });
});

describe('useUploadSession / allocate', () => {
  it('响应回填到 session.files（按 client_ref 匹配 + 未命中 push）', async () => {
    const sess = makeSession();
    getOrCreateUploadSession.mockResolvedValueOnce(sess);
    allocateUploadSessionFiles.mockResolvedValueOnce({
      items: [
        { client_ref: 'ref-a', tmp_key: 'tmp/parts_new/ref-a.pdf' },
        { client_ref: 'ref-b', tmp_key: 'tmp/parts_new/ref-b.pdf' },
      ],
    });

    const u = getUploadSession(uniqueScope());
    await u.init('parts_new');

    const out = await u.allocate([
      {
        client_ref: 'ref-a',
        kind: 'drawing' as const,
        original_filename: 'a.pdf',
        file_size: 1024,
        content_type: 'application/pdf',
        content_sha256: 'a'.repeat(64),
      },
      {
        client_ref: 'ref-b',
        kind: '3d_model' as const,
        original_filename: 'b.stp',
        file_size: 2048,
        content_type: 'application/octet-stream',
        content_sha256: 'b'.repeat(64),
      },
    ]);

    expect(out).toHaveLength(2);
    expect(u.files.value).toHaveLength(2);
    const files = u.files.value;
    expect(files[0]?.client_ref).toBe('ref-a');
    expect(files[0]?.tmp_key).toBe('tmp/parts_new/ref-a.pdf');
    expect(files[0]?.status).toBe('pending');
    expect(files[0]?.etag).toBeNull();
    expect(files[0]?.original_filename).toBe('a.pdf');
    expect(files[0]?.file_size).toBe(1024);
    expect(files[1]?.kind).toBe('3d_model');
  });

  it('未初始化时调 allocate → 抛错', async () => {
    const u = getUploadSession(uniqueScope());
    await expect(u.allocate([])).rejects.toThrow(/未初始化/);
  });
});

describe('useUploadSession / markComplete', () => {
  it('原子替换 session.files 中对应 client_ref 条目', async () => {
    const sess = makeSession({
      files: [makeFile({ client_ref: 'ref-a', status: 'pending' })],
    });
    getOrCreateUploadSession.mockResolvedValueOnce(sess);
    completeUploadSessionFile.mockResolvedValueOnce({
      ...sess.files[0]!,
      status: 'done',
      etag: '"abc123"',
      uploaded_at: '2026-09-18T12:00:00Z',
    });

    const u = getUploadSession(uniqueScope());
    await u.init('parts_new');

    const updated = await u.markComplete('ref-a', '"abc123"');
    expect(updated.status).toBe('done');
    expect(updated.etag).toBe('"abc123"');
    expect(u.files.value[0]?.status).toBe('done');
    expect(u.files.value[0]?.etag).toBe('"abc123"');
    expect(u.files.value[0]?.uploaded_at).toBe('2026-09-18T12:00:00Z');
  });
});

describe('useUploadSession / removeFiles & consumeFiles', () => {
  it('removeFiles 按后端响应同步本地 state', async () => {
    const sess = makeSession({
      files: [makeFile({ client_ref: 'ref-a' }), makeFile({ client_ref: 'ref-b' })],
    });
    getOrCreateUploadSession.mockResolvedValueOnce(sess);
    removeUploadSessionFiles.mockResolvedValueOnce({ removed: ['ref-a'] });

    const u = getUploadSession(uniqueScope());
    await u.init('parts_new');

    const removed = await u.removeFiles(['ref-a', 'ref-b']);
    expect(removed).toEqual(['ref-a']);
    expect(u.files.value).toHaveLength(1);
    expect(u.files.value[0]?.client_ref).toBe('ref-b');
  });

  it('removeFiles 空数组 → 不调 API', async () => {
    const sess = makeSession();
    getOrCreateUploadSession.mockResolvedValueOnce(sess);
    const u = getUploadSession(uniqueScope());
    await u.init('parts_new');
    const removed = await u.removeFiles([]);
    expect(removed).toEqual([]);
    expect(removeUploadSessionFiles).not.toHaveBeenCalled();
  });

  it('consumeFiles 同步过滤本地 state（C3 修复）', async () => {
    const sess = makeSession({
      files: [
        makeFile({ client_ref: 'ref-a', status: 'done' }),
        makeFile({ client_ref: 'ref-b', status: 'done' }),
      ],
    });
    getOrCreateUploadSession.mockResolvedValueOnce(sess);
    consumeUploadSessionFiles.mockResolvedValueOnce({ consumed: ['ref-a'] });

    const u = getUploadSession(uniqueScope());
    await u.init('parts_new');

    const consumed = await u.consumeFiles(['ref-a']);
    expect(consumed).toEqual(['ref-a']);
    // 2026-09-18 C3：consume 后从 session.files 过滤掉被消费的条目
    // （避免后续 mount 时 mergeDraftWithSession 误把已消费文件当作孤儿）。
    expect(u.files.value).toHaveLength(1);
    expect(u.files.value[0]?.client_ref).toBe('ref-b');
  });

  it('consumeFiles 未初始化 → 静默返回 []，不抛错', async () => {
    const u = getUploadSession(uniqueScope());
    const out = await u.consumeFiles(['ref-a']);
    expect(out).toEqual([]);
  });
});

describe('useUploadSession / discard', () => {
  it('调 discardUploadSession + 清空 state + 从 Map 删除', async () => {
    const sess = makeSession();
    getOrCreateUploadSession.mockResolvedValueOnce(sess);
    discardUploadSession.mockResolvedValueOnce({ session_id: 'sess-1' });

    const u = getUploadSession(uniqueScope());
    await u.init('parts_new');
    expect(u.session.value).not.toBeNull();

    await u.discard();
    expect(discardUploadSession).toHaveBeenCalledWith('sess-1', { scope: 'parts_new' });
    expect(u.session.value).toBeNull();

    // discard 后再 init → 应该重新调 get-or-create（state 已从 Map 删除）
    getOrCreateUploadSession.mockResolvedValueOnce(sess);
    await u.init('parts_new');
    expect(getOrCreateUploadSession).toHaveBeenCalledTimes(2);
  });
});

describe('useUploadSession / renew 手动', () => {
  it('renew() 主动调一次 + 写回 session.credentials', async () => {
    const sess = makeSession();
    getOrCreateUploadSession.mockResolvedValueOnce(sess);
    const freshExp = expIn(7200);
    renewUploadSessionCredentials.mockResolvedValueOnce({
      credentials: { ...sess.credentials, expired_time: freshExp },
      expires_in: 7200,
    });

    const u = getUploadSession(uniqueScope());
    await u.init('parts_new');
    await u.renew();

    expect(renewUploadSessionCredentials).toHaveBeenCalledWith('sess-1', { scope: 'parts_new' });
    expect(u.credentials.value?.expired_time).toBe(freshExp);
  });
});

// 防止 testCounter 变量未被使用的 lint 警告
void testCounter;
