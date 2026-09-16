// src/api/parts/file.spec.ts（2026-09-16 frontend-overall-cos-direct-upload）
//
// 验证：
// - createUploadIntents POST /api/v2/part-files/upload-intents，body 与响应类型一致；
// - confirmPartFile POST /api/v2/parts/{id}/files/confirm；
// - getPartFileDownloadUrl GET /api/v2/part-files/{id}/url，返回 download_url 字段；
// - deletePartFile POST /api/v2/part-files/{id}/delete，body 强制 { version }（OCC）；
// - getPartFileContentUrl 返回相对 URL `/part-files/{id}/content`（不含鉴权头，让
//   调用方 axios 走拦截器注入 Bearer token）；
// - printPartDrawing / printPartDrawingBatch 走 v1（baseURL /api/v1）保持不变。
//
// 用 vi.mock 拦截 @/api/http 的 api / apiPrint，断言 method / url / body 形态，
// 不发起真实 HTTP。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const postCalls = vi.fn();
const getCalls = vi.fn();

vi.mock('@/api/http', () => ({
  api: {
    post: (...args: unknown[]) => postCalls(...args),
    get: (...args: unknown[]) => getCalls(...args),
  },
  apiPrint: {
    post: (...args: unknown[]) => postCalls(...args),
    get: (...args: unknown[]) => getCalls(...args),
  },
  // 其它导出（cleanParams / refreshClient / ApiError 等）本测试不用，存根占位
  cleanParams: (obj?: Record<string, unknown>) => obj ?? {},
}));

import {
  confirmPartFile,
  createUploadIntents,
  deletePartFile,
  fetchPartFileContent,
  getPartFileContentUrl,
  getPartFileDownloadUrl,
  printPartDrawing,
  printPartDrawingBatch,
} from './file';
import type { ConfirmFileIn, UploadIntentItemIn, UploadIntentsOut } from '@/types/part_file';

beforeEach(() => {
  postCalls.mockReset();
  getCalls.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createUploadIntents', () => {
  it('POST /api/v2/part-files/upload-intents，body 与响应类型对齐', async () => {
    const out: UploadIntentsOut = {
      credentials: {
        tmp_secret_id: 'AKIDxxx',
        tmp_secret_key: 'SECRETxxx',
        session_token: 'TOKENxxx',
        expired_time: 1_900_000_000,
      },
      bucket: 'examplebucket-1250000000',
      region: 'ap-shanghai',
      tmp_prefix: 'tmp/spike/',
      items: [
        {
          client_ref: 'ref-1',
          tmp_key: 'tmp/spike/seq_a.pdf',
          dedup_hit: false,
        },
        {
          client_ref: 'ref-2',
          tmp_key: 'tmp/spike/seq_b.stp',
          dedup_hit: true,
          // existing_file 命中时后端会填；这里 stub 字段省略，TS 允许 undefined
        },
      ],
    };
    postCalls.mockResolvedValueOnce({ data: out });

    const files: UploadIntentItemIn[] = [
      {
        kind: 'DRAWING',
        filename: 'a.pdf',
        file_size: '12345',
        content_sha256: 'a'.repeat(64),
        content_type: 'application/pdf',
      },
    ];
    const resp = await createUploadIntents({
      owner_part_id: '190000000000001',
      files,
    });

    // 调用形态：POST /part-files/upload-intents（baseURL /api/v2 由 api 实例自带）
    expect(postCalls).toHaveBeenCalledTimes(1);
    const [url, body] = postCalls.mock.calls[0]!;
    expect(url).toBe('/part-files/upload-intents');
    expect(body).toEqual({
      owner_part_id: '190000000000001',
      files: [
        {
          kind: 'DRAWING',
          filename: 'a.pdf',
          file_size: '12345',
          content_sha256: 'a'.repeat(64),
          content_type: 'application/pdf',
        },
      ],
    });

    // 响应：保持类型一致（credentials / bucket / region / tmp_prefix / items）
    expect(resp.credentials.tmp_secret_id).toBe('AKIDxxx');
    expect(resp.bucket).toBe('examplebucket-1250000000');
    expect(resp.items).toHaveLength(2);
    expect(resp.items[0]!.dedup_hit).toBe(false);
    expect(resp.items[1]!.dedup_hit).toBe(true);
  });

  it('owner_part_id 可选：场景 A 不传 owner_part_id', async () => {
    postCalls.mockResolvedValueOnce({
      data: {
        credentials: {
          tmp_secret_id: 'x',
          tmp_secret_key: 'y',
          session_token: 'z',
          expired_time: 0,
        },
        bucket: 'b',
        region: 'r',
        tmp_prefix: 'p',
        items: [],
      } satisfies UploadIntentsOut,
    });

    await createUploadIntents({
      files: [
        {
          kind: '3D_MODEL',
          filename: 'b.stp',
          file_size: '999',
          content_sha256: 'b'.repeat(64),
          content_type: 'application/step',
        },
      ],
    });

    const [, body] = postCalls.mock.calls[0]!;
    // owner_part_id 不传时 body 里也不出现（cleanParams 由调用方决定；本测试
    // 验证 createUploadIntents 不主动塞 undefined 字段——axios 会自动剥离）
    expect((body as Record<string, unknown>).owner_part_id).toBeUndefined();
    expect((body as Record<string, unknown>).files).toHaveLength(1);
  });
});

describe('confirmPartFile', () => {
  it('POST /api/v2/parts/{id}/files/confirm，body 字段名与 rust ConfirmFileIn 对齐', async () => {
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
      kind: 'DRAWING',
      tmp_key: 'tmp/spike/seq_a.pdf',
      content_sha256: 'a'.repeat(64),
      original_filename: 'a.pdf',
      file_size: '12345',
      content_type: 'application/pdf',
    };
    const resp = await confirmPartFile('190000000000001', payload);

    expect(postCalls).toHaveBeenCalledTimes(1);
    const [url, body] = postCalls.mock.calls[0]!;
    expect(url).toBe('/parts/190000000000001/files/confirm');
    expect(body).toEqual(payload);

    // 响应：返回 PartFileItem
    expect(resp.id).toBe('190000000000777');
    expect(resp.upload_status).toBe('READY');
    expect(resp.kind).toBe('DRAWING');
  });
});

describe('printPartDrawing (v1 legacy)', () => {
  // 2026-09-15 Phase 5：保留 v1 走 apiPrint；M3 范围不动。
  it('GET /api/v1/parts/{id}/print-drawing，responseType: blob', async () => {
    const fakeBlob = new Blob(['pdf-bytes'], { type: 'application/pdf' });
    getCalls.mockResolvedValueOnce({ data: fakeBlob });

    const blob = await printPartDrawing('190000000000001');

    expect(getCalls).toHaveBeenCalledTimes(1);
    const [url, config] = getCalls.mock.calls[0]!;
    expect(url).toBe('/parts/190000000000001/print-drawing');
    expect((config as Record<string, unknown>).responseType).toBe('blob');
    expect(blob).toBe(fakeBlob);
  });
});

describe('printPartDrawingBatch (v1 legacy)', () => {
  it('POST /api/v1/parts/print-drawing-batch，timeout 10min', async () => {
    const fakeBlob = new Blob(['merged'], { type: 'application/pdf' });
    postCalls.mockResolvedValueOnce({ data: fakeBlob });

    const blob = await printPartDrawingBatch(['190000000000001'], ['190000000000002']);

    expect(postCalls).toHaveBeenCalledTimes(1);
    const [url, body, config] = postCalls.mock.calls[0]!;
    expect(url).toBe('/parts/print-drawing-batch');
    expect(body).toEqual({
      part_ids: ['190000000000001'],
      assembly_ids: ['190000000000002'],
    });
    expect((config as Record<string, unknown>).responseType).toBe('blob');
    expect((config as Record<string, unknown>).timeout).toBe(10 * 60 * 1000);
    expect(blob).toBe(fakeBlob);
  });
});

// ============================================================
// 2026-09-16 T3.5：part-file 域辅助端点（删除 / 下载 / 内容预览）
// ============================================================
describe('getPartFileDownloadUrl', () => {
  it('GET /api/v2/part-files/{id}/url，返回 download_url 字段（注意非 url）', async () => {
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
    expect(calledUrl).toBe('/part-files/190000000000777/url');
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
    expect(calledUrl).toBe('/part-files/id%2Fwith%2Fslash/url');
  });
});

describe('deletePartFile', () => {
  it('POST /api/v2/part-files/{id}/delete，body 强制 { version }（OCC）', async () => {
    postCalls.mockResolvedValueOnce({ data: null });

    await deletePartFile('190000000000777', 7);

    expect(postCalls).toHaveBeenCalledTimes(1);
    const [calledUrl, body] = postCalls.mock.calls[0]!;
    expect(calledUrl).toBe('/part-files/190000000000777/delete');
    expect(body).toEqual({ version: 7 });
  });

  it('version 为 0 时仍能正确发送（OCC 必须严格按 number 传，axios 不该 strip）', async () => {
    postCalls.mockResolvedValueOnce({ data: null });

    await deletePartFile('190000000000777', 0);

    const [, body] = postCalls.mock.calls[0]!;
    expect(body).toEqual({ version: 0 });
  });
});

describe('getPartFileContentUrl', () => {
  it('返回相对路径 `/part-files/{id}/content`（不含 baseURL，由调用方 axios 拼接）', () => {
    const url = getPartFileContentUrl('190000000000777');
    expect(url).toBe('/part-files/190000000000777/content');
    // 不能是绝对 URL —— 否则 `<img src>` / `<iframe src>` 会绕开 axios 拦截器丢 Bearer
    expect(url.startsWith('http')).toBe(false);
  });

  it('雪花 ID 走 encodeURIComponent', () => {
    expect(getPartFileContentUrl('id/with/slash')).toBe('/part-files/id%2Fwith%2Fslash/content');
  });
});

describe('fetchPartFileContent', () => {
  it('GET /api/v2/part-files/{id}/content，responseType=blob', async () => {
    const fakeBlob = new Blob(['pdf-bytes'], { type: 'application/pdf' });
    getCalls.mockResolvedValueOnce({ data: fakeBlob });

    const blob = await fetchPartFileContent('190000000000777');

    expect(getCalls).toHaveBeenCalledTimes(1);
    const [calledUrl, config] = getCalls.mock.calls[0]!;
    expect(calledUrl).toBe('/part-files/190000000000777/content');
    expect((config as Record<string, unknown>).responseType).toBe('blob');
    expect(blob).toBe(fakeBlob);
  });
});
