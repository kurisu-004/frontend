// src/api/parts/__tests__/print.spec.ts —— 零件打印 BFF（`/api/v2/parts/*` 的打印分支）。
//
// 两个端点由 rust 鉴权后转发 python 生成 PDF，响应是 blob（不是 R 信封）：
// - GET  /parts/{id}/print-drawing          单件双面 PDF
// - POST /parts/print-drawing-batch         N 件双面 PDF 顺序拼接成一个
//
// 归属：端点在 part 域（打印语义属零件图纸，不是文件对象域），故测试随实现文件
// `api/parts/print.ts` 而置。

import { beforeEach, describe, expect, it, vi } from 'vitest';

const postCalls = vi.fn();
const getCalls = vi.fn();

vi.mock('@/api/http', () => ({
  api: {
    post: (...args: unknown[]) => postCalls(...args),
    get: (...args: unknown[]) => getCalls(...args),
  },
  cleanParams: (obj?: Record<string, unknown>) => obj ?? {},
}));

import { printPartDrawing, printPartDrawingBatch } from '../print';

beforeEach(() => {
  postCalls.mockReset();
  getCalls.mockReset();
});

describe('printPartDrawing', () => {
  it('GET /api/v2/parts/{id}/print-drawing（rust 转发 python），responseType: blob', async () => {
    const fakeBlob = new Blob(['pdf-bytes'], { type: 'application/pdf' });
    getCalls.mockResolvedValueOnce({ data: fakeBlob });

    const blob = await printPartDrawing('190000000000001');

    expect(getCalls).toHaveBeenCalledTimes(1);
    const [url, config] = getCalls.mock.calls[0]!;
    expect(url).toBe('/parts/190000000000001/print-drawing');
    expect((config as Record<string, unknown>).responseType).toBe('blob');
    expect(blob).toBe(fakeBlob);
  });

  it('partId 走 encodeURIComponent', async () => {
    getCalls.mockResolvedValueOnce({ data: new Blob() });
    await printPartDrawing('id/with/slash');
    const [url] = getCalls.mock.calls[0]!;
    expect(url).toBe('/parts/id%2Fwith%2Fslash/print-drawing');
  });
});

describe('printPartDrawingBatch', () => {
  it('POST /api/v2/parts/print-drawing-batch，timeout 12min（须大于 rust 660s）', async () => {
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
    // timeout 必须严格大于 rust 打印档的 660s，否则浏览器先超时会吃掉服务端的真实
    // 原因（python 502 / rust 自己的 408）。
    expect((config as Record<string, unknown>).timeout).toBe(12 * 60 * 1000);
    expect((config as Record<string, unknown>).timeout as number).toBeGreaterThan(660 * 1000);
    expect(blob).toBe(fakeBlob);
  });

  it('assemblyIds 缺省时显式传 undefined（后端据此只打零件页）', async () => {
    postCalls.mockResolvedValueOnce({ data: new Blob() });
    await printPartDrawingBatch(['190000000000001']);
    const [, body] = postCalls.mock.calls[0]!;
    expect(body).toEqual({ part_ids: ['190000000000001'], assembly_ids: undefined });
  });
});
