// src/api/files/__tests__/objects.spec.ts —— 文件对象域（`/api/v2/files/objects/*`）
// 的实现文件契约。
//
// 验证：
// - confirmFileObject POST /api/v2/files/objects/confirm（owner 在 body，不在 URL）；
// - listPartFilesByOwner GET /api/v2/files/objects，owner_id 多态 + limit 上限 500；
// - getPartFileDownloadUrl GET /api/v2/files/objects/{id}/url，返回 download_url 字段；
// - deletePartFile POST /api/v2/files/objects/{id}/delete，body 强制 { version }（OCC）；
// - fetchPartFileContent GET /api/v2/files/objects/{id}/content，URL 必须是**相对**
//   路径（拼 URL 的 partFileContentPath 未导出，只由本文件内部消费）。
//
// multipart 直传（uploadFileObject）另见同目录 fileUploadEndpoints.spec.ts；
// 零件打印 BFF（/parts/*）另见 src/api/parts/__tests__/print.spec.ts。
//
// 用 vi.mock 拦截 @/api/http 的 api，断言 method / url / body 形态，
// 不发起真实 HTTP。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const postCalls = vi.fn();
const getCalls = vi.fn();

vi.mock('@/api/http', () => ({
  api: {
    post: (...args: unknown[]) => postCalls(...args),
    get: (...args: unknown[]) => getCalls(...args),
  },
  // 其它导出（cleanParams / refreshClient / ApiError 等）本测试不用，存根占位
  cleanParams: (obj?: Record<string, unknown>) => obj ?? {},
}));

import {
  confirmFileObject,
  deletePartFile,
  fetchPartFileContent,
  getPartFileDownloadUrl,
  listPartFilesByOwner,
} from '../objects';
import type { ConfirmFileIn } from '@/types/part_file';

beforeEach(() => {
  postCalls.mockReset();
  getCalls.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('confirmFileObject', () => {
  it('POST /api/v2/files/objects/confirm：owner 在 body，body 字段名与 rust ConfirmFileIn 对齐', async () => {
    postCalls.mockResolvedValueOnce({
      data: {
        id: '190000000000777',
        version: 1,
        owner_id: '190000000000001',
        kind: 'DRAWING',
        file_type: 'PDF',
        original_filename: 'a.pdf',
        file_size: '12345',
        content_type: 'application/pdf',
        upload_status: 'READY',
        content_sha256: 'a'.repeat(64),
        created_at: '2026-09-16T10:00:00Z',
        paired_file_id: null,
      },
    });

    const payload: ConfirmFileIn = {
      owner_kind: 'PART',
      owner_id: '190000000000001',
      kind: 'DRAWING',
      tmp_key: 'tmp/spike/seq_a.pdf',
      content_sha256: 'a'.repeat(64),
      original_filename: 'a.pdf',
      file_size: '12345',
      content_type: 'application/pdf',
      ext: 'pdf',
    };
    const resp = await confirmFileObject(payload);

    expect(postCalls).toHaveBeenCalledTimes(1);
    const [url, body] = postCalls.mock.calls[0]!;
    expect(url).toBe('/files/objects/confirm');
    expect(body).toEqual(payload);

    // 响应：返回 PartFileItem
    expect(resp.id).toBe('190000000000777');
    expect(resp.upload_status).toBe('READY');
    expect(resp.kind).toBe('DRAWING');
  });
});

describe('listPartFilesByOwner', () => {
  it('GET /api/v2/files/objects：owner_id + limit=500（后端默认 50 会静默截断）', async () => {
    getCalls.mockResolvedValueOnce({ data: { items: [], total: 0 } });
    await listPartFilesByOwner('190000000000001');
    const [url, config] = getCalls.mock.calls[0]!;
    expect(url).toBe('/files/objects');
    expect((config as { params: unknown }).params).toEqual({
      owner_id: '190000000000001',
      limit: 500,
    });
  });

  it('带 kind 时按 kind 过滤（owner 多态：零件 id 与装配件 id 同参数位）', async () => {
    getCalls.mockResolvedValueOnce({ data: { items: [], total: 0 } });
    await listPartFilesByOwner('190000000000002', 'DRAWING');
    const [, config] = getCalls.mock.calls[0]!;
    expect((config as { params: unknown }).params).toEqual({
      owner_id: '190000000000002',
      kind: 'DRAWING',
      limit: 500,
    });
  });
});

// ============================================================
// 辅助端点（删除 / 下载 / 内容预览）
// ============================================================
describe('getPartFileDownloadUrl', () => {
  it('GET /api/v2/files/objects/{id}/url，返回 download_url 字段（注意非 url）', async () => {
    getCalls.mockResolvedValueOnce({
      data: {
        id: '190000000000777',
        kind: 'DRAWING',
        file_type: 'PDF',
        original_filename: 'a.pdf',
        file_size: 12345,
        content_type: 'application/pdf',
        content_sha256: 'a'.repeat(64),
        upload_status: 'READY',
        download_url: 'https://bucket.cos.ap-shanghai.myqcloud.com/a.pdf?sign=xxx',
        url_expires_in_seconds: 3600,
      },
    });

    const url = await getPartFileDownloadUrl('190000000000777');

    expect(getCalls).toHaveBeenCalledTimes(1);
    const [calledUrl] = getCalls.mock.calls[0]!;
    expect(calledUrl).toBe('/files/objects/190000000000777/url');
    expect(url).toBe('https://bucket.cos.ap-shanghai.myqcloud.com/a.pdf?sign=xxx');
  });

  it('雪花 ID 走 encodeURIComponent（带字符的安全序列化）', async () => {
    getCalls.mockResolvedValueOnce({
      data: {
        id: 'x',
        kind: 'DRAWING',
        file_type: 'PDF',
        original_filename: 'a.pdf',
        file_size: 0,
        content_type: 'application/pdf',
        content_sha256: null,
        upload_status: 'READY',
        download_url: 'about:blank',
        url_expires_in_seconds: 1,
      },
    });

    await getPartFileDownloadUrl('id/with/slash');

    const [calledUrl] = getCalls.mock.calls[0]!;
    expect(calledUrl).toBe('/files/objects/id%2Fwith%2Fslash/url');
  });
});

describe('deletePartFile', () => {
  it('POST /api/v2/files/objects/{id}/delete，body 强制 { version }（OCC）', async () => {
    postCalls.mockResolvedValueOnce({ data: null });

    await deletePartFile('190000000000777', 7);

    expect(postCalls).toHaveBeenCalledTimes(1);
    const [calledUrl, body] = postCalls.mock.calls[0]!;
    expect(calledUrl).toBe('/files/objects/190000000000777/delete');
    expect(body).toEqual({ version: 7 });
  });

  it('version 为 0 时仍能正确发送（OCC 必须严格按 number 传，axios 不该 strip）', async () => {
    postCalls.mockResolvedValueOnce({ data: null });

    await deletePartFile('190000000000777', 0);

    const [, body] = postCalls.mock.calls[0]!;
    expect(body).toEqual({ version: 0 });
  });
});

describe('fetchPartFileContent', () => {
  it('GET /api/v2/files/objects/{id}/content，responseType=blob', async () => {
    const fakeBlob = new Blob(['pdf-bytes'], { type: 'application/pdf' });
    getCalls.mockResolvedValueOnce({ data: fakeBlob });

    const blob = await fetchPartFileContent('190000000000777');

    expect(getCalls).toHaveBeenCalledTimes(1);
    const [calledUrl, config] = getCalls.mock.calls[0]!;
    expect(calledUrl).toBe('/files/objects/190000000000777/content');
    expect((config as Record<string, unknown>).responseType).toBe('blob');
    expect(blob).toBe(fakeBlob);
  });

  it('URL 恒为相对路径且 id 走 encodeURIComponent（裸 URL 会绕开 axios 拦截器丢 Bearer）', async () => {
    getCalls.mockResolvedValue({ data: new Blob([]) });

    await fetchPartFileContent('id/with/slash');

    const [calledUrl] = getCalls.mock.calls[0]!;
    expect(calledUrl).toBe('/files/objects/id%2Fwith%2Fslash/content');
    // 不能是绝对 URL —— 那样 `<img src>` / `<iframe src>` 会绕开鉴权拦截器
    expect((calledUrl as string).startsWith('http')).toBe(false);
  });
});
