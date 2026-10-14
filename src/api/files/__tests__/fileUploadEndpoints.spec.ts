// 2026-10-04 新增：multipart 直传 wrapper 的契约。
//
// ⚠️ **端点归属**：本 spec 测的是文件对象域的 `POST /api/v2/files/objects`
// （零件图纸 / 零件 3D 模型 / 装配件总装图三合一），实现文件 `api/files/objects.ts`。
//
// 端点对 body 有三条硬约束，任一违反都是 40001：
//   1. 恰好两个字段：`data`（JSON：owner_kind / owner_id / kind）+ `file`（二进制）；
//   2. `content_type` 必须匹配扩展名白名单 —— `.pdf` 只收 application/pdf，
//      3D / CAD 扩展名统一收 application/octet-stream。浏览器给的 `File.type`
//      对 .igs 之类常是空串或怪值，直接用会被后端 policy 挡回；
//   3. URL 无尾斜杠（后端 nest 把内层 `/` 折叠成 prefix 本身，带尾斜杠会 404）。
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('@/api/http', () => ({
  api: { post: mocks.post, get: vi.fn() },
  cleanParams: (p: unknown) => p,
}));
import { uploadFileObject } from '../objects';

beforeEach(() => mocks.post.mockReset());

describe('uploadFileObject（POST /files/objects）', () => {
  it('零件图纸：URL 无尾斜杠 + data/file 两字段 + content_type 归一', async () => {
    mocks.post.mockResolvedValueOnce({ data: { id: 'f1' } });
    const raw = new File([new Uint8Array([1])], 'A-1.pdf', { type: '' });
    await uploadFileObject('PART', 'p 1/2', 'DRAWING', raw);
    const [url, form] = mocks.post.mock.calls[0]!;
    expect(url).toBe('/files/objects');
    expect([...form.keys()].sort()).toEqual(['data', 'file']);
    expect(JSON.parse(form.get('data') as string)).toEqual({
      owner_kind: 'PART',
      owner_id: 'p 1/2',
      kind: 'DRAWING',
    });
    expect((form.get('file') as File).type).toBe('application/pdf');
    expect((form.get('file') as File).name).toBe('A-1.pdf');
  });

  it('3D：浏览器给的怪 content_type 被归一成 octet-stream', async () => {
    mocks.post.mockResolvedValueOnce({ data: { id: 'f2' } });
    const raw = new File([new Uint8Array([1])], 'A-1.igs', { type: 'text/plain' });
    await uploadFileObject('PART', 'p1', '3D_MODEL', raw);
    const [url, form] = mocks.post.mock.calls[0]!;
    expect(url).toBe('/files/objects');
    expect([...form.keys()].sort()).toEqual(['data', 'file']);
    expect(JSON.parse(form.get('data') as string)).toEqual({
      owner_kind: 'PART',
      owner_id: 'p1',
      kind: '3D_MODEL',
    });
    expect((form.get('file') as File).type).toBe('application/octet-stream');
  });

  it('装配件总装图：owner_kind=ASSEMBLY + kind=ASSEMBLY_MASTER 走同一个 URL', async () => {
    mocks.post.mockResolvedValueOnce({ data: { id: 'f3' } });
    const raw = new File([new Uint8Array([1])], 'ASM-1.pdf', { type: '' });
    await uploadFileObject('ASSEMBLY', 'a1', 'ASSEMBLY_MASTER', raw);
    const [url, form] = mocks.post.mock.calls[0]!;
    expect(url).toBe('/files/objects');
    expect(JSON.parse(form.get('data') as string)).toEqual({
      owner_kind: 'ASSEMBLY',
      owner_id: 'a1',
      kind: 'ASSEMBLY_MASTER',
    });
    expect((form.get('file') as File).type).toBe('application/pdf');
  });

  it('大写 .PDF 扩展名同样归一成 application/pdf', async () => {
    mocks.post.mockResolvedValueOnce({ data: { id: 'f4' } });
    const raw = new File([new Uint8Array([1])], 'A-1.PDF', { type: '' });
    await uploadFileObject('PART', 'p1', 'DRAWING', raw);
    const [, form] = mocks.post.mock.calls[0]!;
    expect((form.get('file') as File).type).toBe('application/pdf');
  });

  it('返回后端的 PartFileItem 原样透传', async () => {
    const item = { id: 'f5', owner_id: 'p1', kind: 'DRAWING', file_size: '1' };
    mocks.post.mockResolvedValueOnce({ data: item });
    const raw = new File([new Uint8Array([1])], 'A-1.pdf', { type: '' });
    await expect(uploadFileObject('PART', 'p1', 'DRAWING', raw)).resolves.toBe(item);
  });

  it('后端错误原样上抛（不吞不包装）', async () => {
    mocks.post.mockRejectedValueOnce(Object.assign(new Error('相同文件已存在'), { code: 21108 }));
    const raw = new File([new Uint8Array([1])], 'A-1.pdf', { type: '' });
    await expect(uploadFileObject('PART', 'p1', 'DRAWING', raw)).rejects.toMatchObject({
      code: 21108,
    });
  });
});
