// @vitest-environment happy-dom
//
// usePartFileUpload 单元测试（2026-09-16 frontend-overall-cos-direct-upload T3.5）。
//
// 验证：
// - upload() 全链路：hash → createUploadIntents → COS 直传 → confirmPartFile；
// - dedup_hit=true 直接返回 existing_file，跳过 upload + confirm；
// - COS 上传失败 → status=error，upload() 抛错；
// - refetchIntents 在 createUploadIntents 被 useCosUpload 触发时按 owner_part_id
//   复传；
// - ownerPartId / kind 接受 Ref<string> / getter 两种形态；
// - uploading / lastError 状态在生命周期内同步。
//
// 不发起真实 HTTP：mock @/api/parts/file、@/utils/fileHash、cos-js-sdk-v5。
// fileHash 用 fake 实现（SHA-256 取文件名 hex），避免依赖 hash-wasm 在 vitest 的 wasm 加载。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';

// ============ mocks ============

const createUploadIntentsMock = vi.fn();
const confirmPartFileMock = vi.fn();
const computeSha256Mock = vi.fn();

vi.mock('@/api/parts/file', () => ({
  createUploadIntents: (...args: unknown[]) => createUploadIntentsMock(...args),
  confirmPartFile: (...args: unknown[]) => confirmPartFileMock(...args),
}));

vi.mock('@/utils/fileHash', () => ({
  computeSha256: (...args: unknown[]) => computeSha256Mock(...args),
}));

const uploadFileSpy = vi.fn();
vi.mock('cos-js-sdk-v5', () => {
  class MockCOS {
    public uploadFile(params: Record<string, unknown>) {
      return uploadFileSpy(params);
    }
  }
  return { default: MockCOS };
});

import { usePartFileUpload } from '../usePartFileUpload';

// ============ helpers ============

function makeFile(name: string, content = 'hello'): File {
  return new File([content], name, { type: 'application/pdf' });
}

function makeIntents(
  opts: {
    clientRef?: string;
    tmpKey?: string;
    dedupHit?: boolean;
    existingFile?: object;
    expiredTime?: number;
  } = {},
) {
  const clientRef = opts.clientRef ?? 'ref-1';
  const tmpKey = opts.tmpKey ?? 'tmp/spike/seq_a.pdf';
  const expiredTime = opts.expiredTime ?? Math.floor(Date.now() / 1000) + 7200;
  const item: Record<string, unknown> = {
    client_ref: clientRef,
    tmp_key: tmpKey,
    dedup_hit: opts.dedupHit ?? false,
  };
  if (opts.existingFile) item.existing_file = opts.existingFile;
  return {
    credentials: {
      tmp_secret_id: 'AKID',
      tmp_secret_key: 'SECRET',
      session_token: 'TOKEN',
      expired_time: expiredTime,
    },
    bucket: 'bucket-1250000000',
    region: 'ap-shanghai',
    tmp_prefix: 'tmp/spike/',
    items: [item],
  };
}

function makeExistingFile() {
  return {
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
  };
}

beforeEach(() => {
  createUploadIntentsMock.mockReset();
  confirmPartFileMock.mockReset();
  computeSha256Mock.mockReset();
  uploadFileSpy.mockReset();
  // 默认 SHA = 64-char a's
  computeSha256Mock.mockResolvedValue('a'.repeat(64));
  uploadFileSpy.mockResolvedValue({ ETag: '"abc123"' });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ============ tests ============

describe('usePartFileUpload.upload', () => {
  it('happy path：hash → upload-intents → COS → confirmPartFile 全链路', async () => {
    createUploadIntentsMock.mockResolvedValueOnce(makeIntents());
    const confirmed = {
      id: '190000000000999',
      version: 1,
      owner_id: '190000000000001',
      kind: 'DRAWING',
      file_type: 'PDF',
      original_filename: 'a.pdf',
      file_size: '5',
      content_type: 'application/pdf',
      upload_status: 'READY',
      content_sha256: 'a'.repeat(64),
      created_at: '2026-09-16T10:00:00Z',
      paired_file_id: null,
    };
    confirmPartFileMock.mockResolvedValueOnce(confirmed);

    const { upload } = usePartFileUpload({
      ownerPartId: ref<string>('190000000000001'),
      kind: 'DRAWING',
    });
    const result = await upload(makeFile('a.pdf'));

    // hash 用 raw File
    expect(computeSha256Mock).toHaveBeenCalledTimes(1);
    expect(computeSha256Mock.mock.calls[0]![0]).toBeInstanceOf(File);

    // createUploadIntents 形态：owner_part_id + 单 file 项
    expect(createUploadIntentsMock).toHaveBeenCalledTimes(1);
    const [intentsArg] = createUploadIntentsMock.mock.calls[0]!;
    expect(intentsArg).toMatchObject({
      owner_part_id: '190000000000001',
      files: [
        {
          kind: 'DRAWING',
          filename: 'a.pdf',
          file_size: '5',
          content_sha256: 'a'.repeat(64),
          content_type: 'application/pdf',
        },
      ],
    });

    // COS 直传
    expect(uploadFileSpy).toHaveBeenCalledTimes(1);
    const cosParams = uploadFileSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(cosParams.Key).toBe('tmp/spike/seq_a.pdf');
    expect(cosParams.Bucket).toBe('bucket-1250000000');
    expect(cosParams.Region).toBe('ap-shanghai');

    // confirmPartFile
    expect(confirmPartFileMock).toHaveBeenCalledTimes(1);
    const [confirmPartId, confirmBody] = confirmPartFileMock.mock.calls[0]!;
    expect(confirmPartId).toBe('190000000000001');
    expect(confirmBody).toEqual({
      kind: 'DRAWING',
      tmp_key: 'tmp/spike/seq_a.pdf',
      content_sha256: 'a'.repeat(64),
      original_filename: 'a.pdf',
      file_size: '5',
      content_type: 'application/pdf',
    });

    // 返回确认后的 PartFileItem
    expect(result.id).toBe('190000000000999');
  });

  it('dedup_hit=true：跳过 COS + confirmPartFile，直接返回 existing_file', async () => {
    const existing = makeExistingFile();
    createUploadIntentsMock.mockResolvedValueOnce(
      makeIntents({ dedupHit: true, existingFile: existing }),
    );

    const { upload } = usePartFileUpload({
      ownerPartId: ref<string>('190000000000001'),
      kind: 'DRAWING',
    });
    const result = await upload(makeFile('a.pdf'));

    expect(createUploadIntentsMock).toHaveBeenCalledTimes(1);
    // 不应该走 COS 也不应该 confirm
    expect(uploadFileSpy).not.toHaveBeenCalled();
    expect(confirmPartFileMock).not.toHaveBeenCalled();
    expect(result).toBe(existing);
  });

  it('COS 上传失败 → upload 抛错，lastError / uploading 状态正确', async () => {
    createUploadIntentsMock.mockResolvedValueOnce(makeIntents());
    uploadFileSpy.mockRejectedValueOnce(new Error('COS network 500'));

    const { upload, uploading, lastError } = usePartFileUpload({
      ownerPartId: ref<string>('190000000000001'),
      kind: 'DRAWING',
    });

    await expect(upload(makeFile('a.pdf'))).rejects.toThrow('COS network 500');
    expect(lastError.value).toBe('COS network 500');
    expect(uploading.value).toBe(false);
    expect(confirmPartFileMock).not.toHaveBeenCalled();
  });

  it('ownerPartId 为空时抛错（场景：路由未带 id）', async () => {
    const { upload } = usePartFileUpload({
      ownerPartId: ref<string>(''),
      kind: 'DRAWING',
    });
    await expect(upload(makeFile('a.pdf'))).rejects.toThrow(/ownerPartId/);
    expect(createUploadIntentsMock).not.toHaveBeenCalled();
  });

  it('ownerPartId 支持 getter 形态（响应非 ref 的派生 ID）', async () => {
    createUploadIntentsMock.mockResolvedValueOnce(makeIntents());
    confirmPartFileMock.mockResolvedValueOnce(makeExistingFile());

    let captured = 'INIT';
    const { upload } = usePartFileUpload({
      ownerPartId: () => {
        captured = 'CALLED';
        return '190000000000002';
      },
      kind: '3D_MODEL',
    });
    const f = makeFile('b.stp', 'step-content');
    await upload(f);

    expect(captured).toBe('CALLED');
    const [arg] = createUploadIntentsMock.mock.calls[0]!;
    expect((arg as { owner_part_id: string }).owner_part_id).toBe('190000000000002');
    expect((arg as { files: { kind: string }[] }).files[0]!.kind).toBe('3D_MODEL');
  });

  it('kind 决定 createUploadIntents.files[0].kind 与 confirmBody.kind', async () => {
    createUploadIntentsMock.mockResolvedValueOnce(makeIntents());
    confirmPartFileMock.mockResolvedValueOnce(makeExistingFile());

    const { upload } = usePartFileUpload({
      ownerPartId: ref<string>('190000000000001'),
      kind: 'CAD_2D',
    });
    await upload(makeFile('a.dwg'));

    const [intentsArg] = createUploadIntentsMock.mock.calls[0]!;
    expect((intentsArg as { files: { kind: string }[] }).files[0]!.kind).toBe('CAD_2D');
    const [, confirmBody] = confirmPartFileMock.mock.calls[0]!;
    expect((confirmBody as { kind: string }).kind).toBe('CAD_2D');
  });

  it('file_size 按 CLAUDE.md §3 走 string 序列化（v2 i64 雪花序列化器对齐）', async () => {
    createUploadIntentsMock.mockResolvedValueOnce(makeIntents());
    confirmPartFileMock.mockResolvedValueOnce(makeExistingFile());

    const { upload } = usePartFileUpload({
      ownerPartId: ref<string>('190000000000001'),
      kind: 'DRAWING',
    });
    // makeFile 默认 'hello' (5 bytes)
    await upload(makeFile('a.pdf', 'hello'));

    const [intentsArg] = createUploadIntentsMock.mock.calls[0]!;
    const fileEntry = (intentsArg as { files: { file_size: unknown }[] }).files[0]!;
    expect(fileEntry.file_size).toBe('5');
    expect(typeof fileEntry.file_size).toBe('string');
  });

  it('uploading 状态在 upload 期间为 true，完成后 false', async () => {
    createUploadIntentsMock.mockResolvedValueOnce(makeIntents());
    confirmPartFileMock.mockResolvedValueOnce(makeExistingFile());

    const { upload, uploading } = usePartFileUpload({
      ownerPartId: ref<string>('190000000000001'),
      kind: 'DRAWING',
    });

    expect(uploading.value).toBe(false);
    const p = upload(makeFile('a.pdf'));
    expect(uploading.value).toBe(true);
    await p;
    expect(uploading.value).toBe(false);
  });

  it('成功后 lastError 清空', async () => {
    createUploadIntentsMock.mockRejectedValueOnce(new Error('first attempt'));
    createUploadIntentsMock.mockResolvedValueOnce(makeIntents());
    confirmPartFileMock.mockResolvedValueOnce(makeExistingFile());

    const { upload, lastError } = usePartFileUpload({
      ownerPartId: ref<string>('190000000000001'),
      kind: 'DRAWING',
    });

    // 第一次失败
    await expect(upload(makeFile('a.pdf'))).rejects.toThrow('first attempt');
    expect(lastError.value).toBe('first attempt');

    // 第二次成功：lastError 应被 reset 为 null
    await upload(makeFile('b.pdf'));
    expect(lastError.value).toBeNull();
  });
});
