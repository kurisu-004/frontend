// src/utils/__tests__/presignedPut.spec.ts —— 预签 PUT 执行器（2026-10-15 新增）
//
// 守四件会「让一次几百 MB 的上传全部白跑」的事：
//   1. 方法恒为 PUT、URL 原样使用（改一个字节就是 403 SignatureDoesNotMatch）；
//   2. Content-Type **原样回填**（它签在 SigV4 的 SignedHeaders 里）；
//   3. 进度回抛 0-100 整数百分比；
//   4. 错误分类：403 + 签名措辞 ⇒ presignExpired（上层据此重签）；body 为空的 403 /
//      status 0 ⇒ 不是签名问题（重签多少次都不会好，要人去查 CORS）。
//
// 用一个假的 XMLHttpRequest 替身驱动，不发真实网络请求。

import { beforeEach, describe, expect, it } from 'vitest';
import { isPresignExpiredError, xhrPut, type PresignedPutError } from '../presignedPut';

/** 记录调用并可手动触发回调的 XHR 替身。 */
class FakeXhr {
  public static last: FakeXhr | null = null;
  public method = '';
  public url = '';
  public headers: Record<string, string> = {};
  public sent: File | null = null;
  public status = 0;
  public responseText = '';
  public upload: { onprogress: ((e: unknown) => void) | null } = { onprogress: null };
  public onload: (() => void) | null = null;
  public onerror: (() => void) | null = null;
  public ontimeout: (() => void) | null = null;
  public onabort: (() => void) | null = null;

  public constructor() {
    FakeXhr.last = this;
  }
  public open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }
  public setRequestHeader(k: string, v: string): void {
    this.headers[k] = v;
  }
  public send(body: File): void {
    this.sent = body;
  }
  /** 模拟「上传中」：派发一次 progress 事件。 */
  public progress(loaded: number, total: number): void {
    this.upload.onprogress?.({ lengthComputable: total > 0, loaded, total });
  }
  /** 模拟「服务端回了状态码」。 */
  public respond(status: number, body = ''): void {
    this.status = status;
    this.responseText = body;
    this.onload?.();
  }
}

beforeEach(() => {
  FakeXhr.last = null;
  (globalThis as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest = FakeXhr;
});

const URL_UNDER_TEST = 'https://bucket.cos.example/obj/a.pdf?X-Amz-Signature=abc&X-Amz-Expires=900';

describe('xhrPut', () => {
  it('PUT + URL 原样 + Content-Type 原样回填；2xx 时 resolve 并把进度补到 100', async () => {
    const seen: number[] = [];
    const file = new File([new Uint8Array(4)], 'a.pdf');
    const p = xhrPut({ url: URL_UNDER_TEST, contentType: 'application/pdf' }, file, (x) =>
      seen.push(x),
    );
    const xhr = FakeXhr.last!;
    expect(xhr.method).toBe('PUT');
    expect(xhr.url).toBe(URL_UNDER_TEST);
    expect(xhr.headers['Content-Type']).toBe('application/pdf');
    expect(xhr.sent).toBe(file);

    xhr.progress(50, 100);
    expect(seen).toEqual([50]);
    xhr.respond(200);
    await expect(p).resolves.toBeUndefined();
    expect(seen).toEqual([50, 100]);
  });

  it('总量不可读时进度仍单调推进、不越过 100', async () => {
    const seen: number[] = [];
    const p = xhrPut({ url: URL_UNDER_TEST, contentType: 'application/pdf' }, new File([new Uint8Array(1)], 'a.pdf'), (x) =>
      seen.push(x),
    );
    const xhr = FakeXhr.last!;
    xhr.progress(5 * 1024 * 1024, 0);
    expect(seen[0]).toBeGreaterThan(0);
    expect(seen[0]).toBeLessThanOrEqual(99);
    xhr.respond(200);
    await p;
    expect(seen.at(-1)).toBe(100);
  });

  it('403 + 签名措辞 ⇒ presignExpired=true（上层据此重签一次）', async () => {
    const p = xhrPut({ url: URL_UNDER_TEST, contentType: 'application/pdf' }, new File([new Uint8Array(1)], 'a.pdf'));
    FakeXhr.last!.respond(403, '<Error><Code>SignatureDoesNotMatch</Code></Error>');
    const err = (await p.catch((e) => e)) as PresignedPutError;
    expect(err.status).toBe(403);
    expect(err.presignExpired).toBe(true);
    expect(isPresignExpiredError(err)).toBe(true);
    // 报错文案要带上状态码与响应体片段，便于现场分辨「过期」与「签名算法不匹配」。
    expect(err.message).toContain('403');
    expect(err.message).toContain('SignatureDoesNotMatch');
  });

  it('403 但响应体为空（CORS 未配的典型形态）⇒ presignExpired=false', async () => {
    const p = xhrPut({ url: URL_UNDER_TEST, contentType: 'application/pdf' }, new File([new Uint8Array(1)], 'a.pdf'));
    FakeXhr.last!.respond(403, '');
    const err = (await p.catch((e) => e)) as PresignedPutError;
    expect(err.status).toBe(403);
    expect(err.presignExpired).toBe(false);
    expect(isPresignExpiredError(err)).toBe(false);
    expect(err.message).toContain('CORS');
  });

  it('onerror（浏览器根本没拿到响应）⇒ status 0 + networkOrCors，不算签名问题', async () => {
    const p = xhrPut({ url: URL_UNDER_TEST, contentType: 'application/pdf' }, new File([new Uint8Array(1)], 'a.pdf'));
    FakeXhr.last!.onerror?.();
    const err = (await p.catch((e) => e)) as PresignedPutError;
    expect(err.status).toBe(0);
    expect(err.networkOrCors).toBe(true);
    expect(err.presignExpired).toBe(false);
  });

  it('5xx：状态码与响应体片段进报错文案', async () => {
    const p = xhrPut({ url: URL_UNDER_TEST, contentType: 'application/pdf' }, new File([new Uint8Array(1)], 'a.pdf'));
    FakeXhr.last!.respond(502, '<html>Bad Gateway</html>');
    const err = (await p.catch((e) => e)) as PresignedPutError;
    expect(err.status).toBe(502);
    expect(err.message).toContain('502');
    expect(err.message).toContain('Bad Gateway');
  });

  it('expiresAt 只是文案信息，不参与任何拦截（时钟偏移下不误判）', async () => {
    const p = xhrPut(
      { url: URL_UNDER_TEST, contentType: 'application/pdf', expiresAt: Date.now() - 1000 },
      new File([new Uint8Array(1)], 'a.pdf'),
    );
    // 已经「过期」的时间戳不该导致本地提前拒绝 —— 真判定权交给服务端。
    expect(FakeXhr.last!.sent).not.toBeNull();
    FakeXhr.last!.respond(200);
    await expect(p).resolves.toBeUndefined();
  });

  it('abort：抛「上传已取消」，不计为网络问题', async () => {
    const p = xhrPut({ url: URL_UNDER_TEST, contentType: 'application/pdf' }, new File([new Uint8Array(1)], 'a.pdf'));
    FakeXhr.last!.onabort?.();
    const err = (await p.catch((e) => e)) as PresignedPutError;
    expect(err.message).toContain('取消');
    expect(err.networkOrCors).toBe(false);
  });
});

describe('isPresignExpiredError', () => {
  it('非上传错误（ApiError / 普通 Error）一律 false', () => {
    expect(isPresignExpiredError(new Error('业务码 40001'))).toBe(false);
    expect(isPresignExpiredError(Object.assign(new Error('x'), { code: 21108 }))).toBe(false);
    expect(isPresignExpiredError(null)).toBe(false);
    expect(isPresignExpiredError(undefined)).toBe(false);
  });

  it('presignExpired 显式为 true 才算（status 403 本身不够）', () => {
    expect(isPresignExpiredError({ status: 403, presignExpired: true })).toBe(true);
    expect(isPresignExpiredError({ status: 403, presignExpired: false })).toBe(false);
  });
});
