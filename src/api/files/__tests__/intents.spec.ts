// src/api/files/__tests__/intents.spec.ts —— 上传意图端口（`POST /api/v2/files/objects/upload-intents`）
// 与登记端口（`POST /api/v2/files/objects/confirm`）的实现契约。
//
// 2026-10-15：这份 spec 取代原先守 multipart 代理上传的 `fileUploadEndpoints.spec.ts`
// —— 被它守的 `POST /files/objects`（**multipart 代理上传端点**，无尾斜杠；与下面
// 两条 `/files/objects/*` 端点不是同一个东西，勿混）已随代理上传一起下线。守的三条：
//   1. upload-intents 的 URL / body 形状（owner 在 body、不在 URL；items 逐字段透传）；
//   2. confirm 的 URL 与 body 逐字透传（object_key / pair_with_file_id 都在里面）；
//   3. 响应原样解包（`api` 拦截器已剥信封，本函数只取 `.data`），后端错误不吞不包装。
//
// 用 vi.mock 拦截 `@/api/http` 的 api，不发起真实 HTTP。

import { beforeEach, describe, expect, it, vi } from 'vitest';

const post = vi.fn();
vi.mock('@/api/http', () => ({
  api: { post: (...args: unknown[]) => post(...args), get: vi.fn() },
  cleanParams: (p: unknown) => p,
}));

import { grantUploadIntents } from '../intents';
import { confirmFileObject } from '../objects';
import type { ConfirmFileIn, GrantUploadIntentsIn } from '@/types/file_intent';
import { XLSX_MIME } from '@/constants/mime';

beforeEach(() => post.mockReset());

describe('grantUploadIntents（POST /files/objects/upload-intents）', () => {
  /**
   * 守卫：签发 URL **必须**落在 `/files/objects/` 子命名空间下。
   *
   * 为什么这条独立于上面那条 `toBe` 逐字断言 —— 后端是三层 nest：
   * `mod.rs` `.nest("/files")` → `files/handler.rs` `.nest("/objects")` →
   * `part_file/handler.rs` `.route("/upload-intents")`，少写一段 `/objects` 就是一条
   * **不存在**的路由 ⇒ 404，且现场只看到一句 axios 错误。这条断言把「少一层」单独钉住：
   * 将来有人照着某个旧注释把 URL 改回 `/files/upload-intents`，这里当场红。
   */
  it('URL 必须落在 /files/objects/ 下（少一层 `/objects` 就是 404）', async () => {
    post.mockResolvedValueOnce({ data: { items: [] } });
    await grantUploadIntents({
      owner_kind: 'PART',
      owner_id: 'p1',
      items: [
        {
          client_ref: 'r',
          kind: 'DRAWING',
          original_filename: 'a.pdf',
          content_type: 'application/pdf',
          file_size: '1',
          content_sha256: 'e'.repeat(64),
        },
      ],
    });
    const url = String(post.mock.calls[0]![0]);
    expect(url.startsWith('/files/objects/')).toBe(true);
    expect(url).not.toBe('/files/upload-intents');
  });

  it('URL 无尾斜杠（后端 nest 把内层的 `/` 折叠成 prefix 本身），body 原样透传', async () => {
    post.mockResolvedValueOnce({ data: { items: [] } });
    const payload: GrantUploadIntentsIn = {
      owner_kind: 'PART',
      owner_id: '190000000000001',
      items: [
        {
          client_ref: 'ref-1',
          kind: 'DRAWING',
          original_filename: '主轴装配图.pdf',
          content_type: 'application/pdf',
          file_size: '1048576',
          content_sha256: 'a'.repeat(64),
        },
      ],
    };
    await grantUploadIntents(payload);
    const [url, body] = post.mock.calls[0]!;
    expect(url).toBe('/files/objects/upload-intents');
    expect(body).toEqual(payload);
  });

  it('owner 走 CUSTOMER（打印模板）时同一端点、同一 URL', async () => {
    post.mockResolvedValueOnce({ data: { items: [] } });
    await grantUploadIntents({
      owner_kind: 'CUSTOMER',
      owner_id: '190000000000009',
      items: [
        {
          client_ref: 'r',
          kind: 'DELIVERY_TEMPLATE',
          original_filename: 't.xlsx',
          content_type: XLSX_MIME,
          file_size: '10',
          content_sha256: 'b'.repeat(64),
        },
      ],
    });
    expect(post.mock.calls[0]![0]).toBe('/files/objects/upload-intents');
  });

  it('秒传形态：already_exists=true 且带 existing_file 时原样返回', async () => {
    const existing = { id: 'f1', kind: 'DRAWING' };
    post.mockResolvedValueOnce({
      data: { items: [{ client_ref: 'ref-1', already_exists: true, expires_in: 900, existing_file: existing }] },
    });
    const resp = await grantUploadIntents({
      owner_kind: 'PART',
      owner_id: 'p1',
      items: [
        {
          client_ref: 'ref-1',
          kind: 'DRAWING',
          original_filename: 'a.pdf',
          content_type: 'application/pdf',
          file_size: '1',
          content_sha256: 'c'.repeat(64),
        },
      ],
    });
    expect(resp.items[0]!.already_exists).toBe(true);
    expect(resp.items[0]!.existing_file).toBe(existing);
    // 秒传形态下不带 URL / object_key —— 上层据此跳过 PUT 与 confirm。
    expect(resp.items[0]!.upload_url).toBeUndefined();
  });

  it('后端错误原样上抛（不吞不包装）', async () => {
    post.mockRejectedValueOnce(Object.assign(new Error('校验失败'), { code: 40001 }));
    await expect(
      grantUploadIntents({
        owner_kind: 'PART',
        owner_id: 'p1',
        items: [
          {
            client_ref: 'r',
            kind: 'DRAWING',
            original_filename: 'a.pdf',
            content_type: 'application/pdf',
            file_size: '1',
            content_sha256: 'd'.repeat(64),
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 40001 });
  });
});

describe('confirmFileObject（POST /files/objects/confirm）', () => {
  it('owner 在 body；object_key / pair_with_file_id 逐字透传', async () => {
    const item = { id: '190000000000777', version: 1, kind: 'SETUP_SHEET' };
    post.mockResolvedValueOnce({ data: item });
    const payload: ConfirmFileIn = {
      owner_kind: 'PART',
      owner_id: '190000000000001',
      kind: 'SETUP_SHEET',
      object_key: 'obj/a1b2c3d4e5f60718_setup.pdf',
      content_sha256: 'e'.repeat(64),
      original_filename: 'setup.pdf',
      file_size: '2048',
      content_type: 'application/pdf',
      ext: 'pdf',
      pair_with_file_id: '190000000000555',
    };
    await expect(confirmFileObject(payload)).resolves.toBe(item);
    const [url, body] = post.mock.calls[0]!;
    expect(url).toBe('/files/objects/confirm');
    expect(body).toEqual(payload);
  });

  it('不带 pair_with_file_id 时该键根本不出现在 body 里（不是 undefined 值）', async () => {
    post.mockResolvedValueOnce({ data: { id: 'f1' } });
    await confirmFileObject({
      owner_kind: 'PART',
      owner_id: 'p1',
      kind: 'DRAWING',
      object_key: 'obj/x.pdf',
      content_sha256: 'f'.repeat(64),
      original_filename: 'a.pdf',
      file_size: '1',
      content_type: 'application/pdf',
    });
    const body = post.mock.calls[0]![1] as Record<string, unknown>;
    expect('pair_with_file_id' in body).toBe(false);
  });
});
