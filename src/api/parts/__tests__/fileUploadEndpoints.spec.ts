// 2026-10-04 新增：图纸 / 3D 后置上传 wrapper 的 multipart 契约。
//
// 端点对 body 有两条硬约束，任一违反都是 40001：
//   1. 只接受**一个**名为 `file` 的字段（多字段 / 缺字段 / 换字段名都拒）；
//   2. `content_type` 必须匹配扩展名白名单 —— PDF 只收 application/pdf，3D 扩展名
//      统一收 application/octet-stream。浏览器给的 `File.type` 对 .igs 之类常是空串
//      或怪值，直接用会被后端 policy 挡回。
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('@/api/http', () => ({
  api: { post: mocks.post, get: vi.fn() },
  cleanParams: (p: unknown) => p,
}));
import { uploadPart3DModel, uploadPartDrawing } from '../file';

beforeEach(() => mocks.post.mockReset());

describe('file.ts 后置上传 wrapper', () => {
  it('图纸：URL + 单一 file 字段 + content_type 归一', async () => {
    mocks.post.mockResolvedValueOnce({ data: { id: 'f1' } });
    const raw = new File([new Uint8Array([1])], 'A-1.pdf', { type: '' });
    await uploadPartDrawing('p 1/2', raw);
    const [url, form] = mocks.post.mock.calls[0]!;
    expect(url).toBe('/parts/p%201%2F2/upload-drawing');
    expect([...form.keys()]).toEqual(['file']);
    expect((form.get('file') as File).type).toBe('application/pdf');
    expect((form.get('file') as File).name).toBe('A-1.pdf');
  });

  it('3D：浏览器给的怪 content_type 被归一成 octet-stream', async () => {
    mocks.post.mockResolvedValueOnce({ data: { id: 'f2' } });
    const raw = new File([new Uint8Array([1])], 'A-1.igs', { type: 'text/plain' });
    await uploadPart3DModel('p1', raw);
    const [url, form] = mocks.post.mock.calls[0]!;
    expect(url).toBe('/parts/p1/upload-3d-model');
    expect([...form.keys()]).toEqual(['file']);
    expect((form.get('file') as File).type).toBe('application/octet-stream');
  });
});
