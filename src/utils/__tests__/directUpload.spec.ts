// src/utils/__tests__/directUpload.spec.ts —— 单文件直传引擎（2026-10-15 新增）
//
// 六个上传场景全部收敛到 `directUpload` 一个实现，所以这份 spec 守的是**全仓上传
// 行为的共同底座**：
//   1. 四步顺序：算 SHA-256 → 签发 intent → PUT → confirm；
//   2. intent 入参逐字段正确（content_type 按扩展名归一、file_size、64 hex 的 sha、
//      client_ref 稳定且重签时复用）；
//   3. 秒传短路：already_exists=true 时既不发 PUT 也不发 confirm；
//   4. URL 过期：重签**一次**、重试一次；非签名类错误不重签；
//   5. confirm 入参：object_key 来自响应、pair_with_file_id 只在 CNC 配对时带。
//
// 传输层（xhrPut）与 http 层（grantUploadIntents / confirmFileObject）都 mock 掉：
// 前者的行为由 presignedPut.spec.ts 守，后者由 api/files/__tests__/intents.spec.ts 守。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { XLSX_MIME } from '@/constants/mime';
import type * as PresignedPutModule from '../presignedPut';
import { directUpload, newClientRef } from '../directUpload';

const xhrPutSpy = vi.fn();
vi.mock('@/utils/presignedPut', async () => {
  const actual = await vi.importActual<typeof PresignedPutModule>('@/utils/presignedPut');
  return { ...actual, xhrPut: (...args: unknown[]) => xhrPutSpy(...args) };
});

const grantSpy = vi.fn();
vi.mock('@/api/files/intents', () => ({
  grantUploadIntents: (...args: unknown[]) => grantSpy(...args),
}));

const confirmSpy = vi.fn();
vi.mock('@/api/files/objects', () => ({
  confirmFileObject: (...args: unknown[]) => confirmSpy(...args),
}));

// hash-wasm 在 node 环境下能跑，但 8MB 分块的真算没有价值；这里桩成常量，
// 只验「它被算过、且结果被原样送进 intent」。
const shaSpy = vi.fn(async () => 'a'.repeat(64));
vi.mock('@/utils/fileHash', () => ({
  computeSha256: (...args: unknown[]) => shaSpy(...(args as [])),
}));

function fileOf(name: string, size = 16): File {
  return new File([new Uint8Array(size)], name, { type: '' });
}

/** 非秒传形态的 intent。 */
function intent(over?: Record<string, unknown>) {
  return {
    client_ref: 'IGNORED',
    already_exists: false,
    object_key: 'obj/k1.pdf',
    upload_url: 'https://b.cos.example/obj/k1.pdf?sig=1',
    content_type: 'application/pdf',
    expires_in: 900,
    ...over,
  };
}

beforeEach(() => {
  xhrPutSpy.mockReset();
  xhrPutSpy.mockImplementation(async (_o: unknown, _f: File, onProgress?: (p: number) => void) => {
    onProgress?.(100);
    return undefined;
  });
  grantSpy.mockReset();
  grantSpy.mockImplementation(async (payload: { items: Array<{ client_ref: string }> }) => ({
    items: [intent()].map((i) => ({ ...i, client_ref: payload.items[0]!.client_ref })),
  }));
  confirmSpy.mockReset();
  confirmSpy.mockResolvedValue({ id: 'file-1', kind: 'DRAWING' });
  shaSpy.mockClear();
});

describe('newClientRef', () => {
  it('每次生成不同的非空标识', () => {
    const a = newClientRef();
    const b = newClientRef();
    expect(a).toBeTruthy();
    expect(a).not.toBe(b);
  });
});

describe('directUpload happy path', () => {
  it('四步按序发生；intent 入参逐字段正确；confirm 带 object_key 与归一后的 ext', async () => {
    const res = await directUpload({
      ownerKind: 'PART',
      ownerId: 'p1',
      kind: 'DRAWING',
      file: fileOf('主轴装配图.PDF', 32),
    });

    expect(shaSpy).toHaveBeenCalledTimes(1);
    const payload = grantSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.owner_kind).toBe('PART');
    expect(payload.owner_id).toBe('p1');
    const item = (payload.items as Array<Record<string, unknown>>)[0]!;
    expect(item.kind).toBe('DRAWING');
    expect(item.original_filename).toBe('主轴装配图.PDF');
    // 大写 .PDF 也归一成 application/pdf（它会被签进签名，不能照抄 file.type）
    expect(item.content_type).toBe('application/pdf');
    // ⚠️ 字符串：后端 upload-intents / confirm 的 file_size 都挂 deserialize_i64，只收字符串。
    expect(item.file_size).toBe('32');
    expect(item.content_sha256).toBe('a'.repeat(64));
    expect(typeof item.client_ref).toBe('string');

    // PUT 用的是 intent 返回的 URL 与 content_type
    expect(xhrPutSpy.mock.calls[0]![0]).toMatchObject({
      url: 'https://b.cos.example/obj/k1.pdf?sig=1',
      contentType: 'application/pdf',
    });

    const confirmPayload = confirmSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(confirmPayload.owner_kind).toBe('PART');
    expect(confirmPayload.object_key).toBe('obj/k1.pdf');
    expect(confirmPayload.ext).toBe('pdf');
    expect(confirmPayload.content_type).toBe('application/pdf');
    // confirm 侧同一个 file_size 口径（同样是字符串）
    expect(confirmPayload.file_size).toBe('32');
    // 普通补传不带 pair_with_file_id 这个键
    expect('pair_with_file_id' in confirmPayload).toBe(false);

    expect(res.alreadyExists).toBe(false);
    expect(res.item).toMatchObject({ id: 'file-1' });
  });

  it('非 PDF（.step）content_type 归一成 octet-stream', async () => {
    await directUpload({ ownerKind: 'PART', ownerId: 'p1', kind: '3D_MODEL', file: fileOf('a.step') });
    const payload = grantSpy.mock.calls[0]![0] as { items: Array<{ content_type: string }> };
    expect(payload.items[0]!.content_type).toBe('application/octet-stream');
  });

  it('.xlsx content_type 归一成规范 MIME（不是 octet-stream —— 后端 policy 对 xlsx 无兜底）', async () => {
    await directUpload({
      ownerKind: 'CUSTOMER',
      ownerId: 'c1',
      kind: 'DELIVERY_TEMPLATE',
      file: fileOf('送货单模板.xlsx'),
    });
    const payload = grantSpy.mock.calls[0]![0] as { items: Array<{ content_type: string }> };
    expect(payload.items[0]!.content_type).toBe(XLSX_MIME);
    expect(payload.items[0]!.content_type).not.toBe('application/octet-stream');
  });

  it('进度：至少回抛 30（hash 结束）与 100（confirm 完成）', async () => {
    const seen: number[] = [];
    await directUpload({
      ownerKind: 'PART',
      ownerId: 'p1',
      kind: 'DRAWING',
      file: fileOf('a.pdf'),
      onProgress: (p) => seen.push(p),
    });
    expect(seen).toContain(30);
    expect(seen.at(-1)).toBe(100);
  });

  it('CNC 配对：confirm 带 pair_with_file_id', async () => {
    await directUpload({
      ownerKind: 'PART',
      ownerId: 'p1',
      kind: 'SETUP_SHEET',
      file: fileOf('setup.pdf'),
      pairWithFileId: 'g-file-9',
    });
    const confirmPayload = confirmSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(confirmPayload.pair_with_file_id).toBe('g-file-9');
  });
});

describe('directUpload 秒传短路', () => {
  it('already_exists=true ⇒ 不发 PUT、不发 confirm，直接返回 existing_file', async () => {
    const existing = { id: 'file-old' };
    grantSpy.mockResolvedValueOnce({ items: [intent({ already_exists: true, existing_file: existing })] });
    const res = await directUpload({
      ownerKind: 'PART',
      ownerId: 'p1',
      kind: 'DRAWING',
      file: fileOf('a.pdf'),
    });
    expect(xhrPutSpy).not.toHaveBeenCalled();
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(res.alreadyExists).toBe(true);
    expect(res.item).toBe(existing);
  });

  it('秒传命中但响应缺 existing_file ⇒ 抛错（不容许静默当失败）', async () => {
    grantSpy.mockResolvedValueOnce({ items: [intent({ already_exists: true })] });
    await expect(
      directUpload({ ownerKind: 'PART', ownerId: 'p1', kind: 'DRAWING', file: fileOf('a.pdf') }),
    ).rejects.toThrow(/existing_file/);
    expect(confirmSpy).not.toHaveBeenCalled();
  });
});

describe('directUpload URL 过期重签', () => {
  it('403 + 签名标记 ⇒ 重签一次（client_ref 复用）+ 重试一次后成功', async () => {
    xhrPutSpy.mockRejectedValueOnce(
      Object.assign(new Error('expired'), { status: 403, presignExpired: true }),
    );
    xhrPutSpy.mockImplementationOnce(async (_o: unknown, _f: File, onProgress?: (p: number) => void) => {
      onProgress?.(100);
      return undefined;
    });
    const res = await directUpload({
      ownerKind: 'PART',
      ownerId: 'p1',
      kind: 'DRAWING',
      file: fileOf('a.pdf'),
    });
    expect(grantSpy).toHaveBeenCalledTimes(2);
    // 重签复用同一 client_ref（对齐回本地 File 的稳定键）
    const first = (grantSpy.mock.calls[0]![0] as { items: Array<{ client_ref: string }> }).items[0]!;
    const second = (grantSpy.mock.calls[1]![0] as { items: Array<{ client_ref: string }> }).items[0]!;
    expect(second.client_ref).toBe(first.client_ref);
    // confirm 用的是**重签后**那份 object_key
    expect(confirmSpy.mock.calls[0]![0]).toMatchObject({ object_key: 'obj/k1.pdf' });
    expect(res.alreadyExists).toBe(false);
  });

  it('重签后仍失败 ⇒ 抛错，绝不第三次', async () => {
    xhrPutSpy.mockRejectedValue(
      Object.assign(new Error('expired again'), { status: 403, presignExpired: true }),
    );
    await expect(
      directUpload({ ownerKind: 'PART', ownerId: 'p1', kind: 'DRAWING', file: fileOf('a.pdf') }),
    ).rejects.toThrow(/expired again/);
    expect(xhrPutSpy).toHaveBeenCalledTimes(2);
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('非签名类 403（CORS）⇒ 不重签，直接上抛', async () => {
    xhrPutSpy.mockRejectedValueOnce(
      Object.assign(new Error('CORS'), { status: 403, presignExpired: false }),
    );
    await expect(
      directUpload({ ownerKind: 'PART', ownerId: 'p1', kind: 'DRAWING', file: fileOf('a.pdf') }),
    ).rejects.toThrow(/CORS/);
    expect(grantSpy).toHaveBeenCalledTimes(1);
  });

  it('重签期间变成秒传命中 ⇒ 不发第二次 PUT', async () => {
    xhrPutSpy.mockRejectedValueOnce(
      Object.assign(new Error('expired'), { status: 403, presignExpired: true }),
    );
    // once 队列按注册顺序消费：第一次签发正常（走 PUT），第二次（重签）才秒传命中。
    grantSpy.mockResolvedValueOnce({ items: [intent()] });
    grantSpy.mockResolvedValueOnce({
      items: [intent({ already_exists: true, existing_file: { id: 'late' } })],
    });
    const res = await directUpload({
      ownerKind: 'PART',
      ownerId: 'p1',
      kind: 'DRAWING',
      file: fileOf('a.pdf'),
    });
    expect(xhrPutSpy).toHaveBeenCalledTimes(1);
    expect(res.alreadyExists).toBe(true);
    expect(res.item).toMatchObject({ id: 'late' });
  });
});

describe('directUpload 失败归因', () => {
  it('签名失败（缺 upload_url）⇒ 显式报错，不发 PUT', async () => {
    grantSpy.mockResolvedValueOnce({ items: [{ ...intent(), upload_url: undefined }] });
    await expect(
      directUpload({ ownerKind: 'PART', ownerId: 'p1', kind: 'DRAWING', file: fileOf('a.pdf') }),
    ).rejects.toThrow(/upload_url/);
    expect(xhrPutSpy).not.toHaveBeenCalled();
  });
});
