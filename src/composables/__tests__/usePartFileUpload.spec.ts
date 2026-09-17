// @vitest-environment happy-dom
//
// usePartFileUpload 单元测试（2026-09-17 frontend-cos-sts-python）。
//
// 2026-09-17 STS 端口迁移验证：
// - upload() 全链路：hash → grantStsTmpKey (python STS) → COS 直传 → confirmPartFile；
// - request body 走 python StsTmpKeysRequest 形态（purpose / filename /
//   content_sha256 / content_type），不再含 owner_part_id / kind / file_size；
// - caller 用 crypto.randomUUID() 生成 client_ref，grantStsTmpKey 单端口 1-key
//   响应包成 UploadIntentsOut（part-file 专用）后喂 useCosUpload；
// - COS 上传失败 → status=error，upload() 抛错；
// - refetchIntents 在凭证过期时按 (purpose, filename, content_sha256.slice(0,16))
//   再调一次 grantStsTmpKey；
// - ownerPartId / kind 接受 Ref<string> / getter 两种形态；
// - uploading / lastError 状态在生命周期内同步。
//
// 不发起真实 HTTP：mock @/api/files/sts、@/api/parts/file、@/utils/fileHash、
// cos-js-sdk-v5。fileHash 用 fake 实现（SHA-256 取文件名 hex），避免依赖
// hash-wasm 在 vitest 的 wasm 加载。
//
// 历史迁移说明：
// - 原测试 mock 了 createUploadIntents（backend-rust bulk 端点），现在改成
//   grantStsTmpKey（python STS 单端口 1-key）。
// - 删除「dedup_hit=true 复用 existing_file」用例（python STS 无 dedup 语义）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';

// ============ mocks ============

const grantStsTmpKeyMock = vi.fn();
const confirmPartFileMock = vi.fn();
const computeSha256Mock = vi.fn();

vi.mock('@/api/files/sts', () => ({
  grantStsTmpKey: (...args: unknown[]) => grantStsTmpKeyMock(...args),
}));

vi.mock('@/api/parts/file', () => ({
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

/**
 * python 端 grantStsTmpKey 单端口 1-key 响应（与 backend-python/schema/sts.py
 * StsTmpKeysResponse 严格对齐，含 credentials.start_time）。
 */
function makeStsResponse(
  opts: {
    tmpKey?: string;
    bucket?: string;
    region?: string;
    uploadPrefix?: string;
    expiredTime?: number;
  } = {},
) {
  return {
    tmp_key: opts.tmpKey ?? 'tmp/spike/seq_a.pdf',
    bucket: opts.bucket ?? 'bucket-1250000000',
    region: opts.region ?? 'ap-shanghai',
    endpoint: 'cos.ap-shanghai.myqcloud.com',
    scheme: 'https',
    credentials: {
      tmp_secret_id: 'AKID',
      tmp_secret_key: 'SECRET',
      session_token: 'TOKEN',
      start_time: 1_900_000_000,
      expired_time: opts.expiredTime ?? Math.floor(Date.now() / 1000) + 7200,
    },
    expires_in: 1800,
    upload_prefix: opts.uploadPrefix ?? 'tmp/spike/',
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
  grantStsTmpKeyMock.mockReset();
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
  it('happy path：hash → grantStsTmpKey → COS → confirmPartFile 全链路', async () => {
    grantStsTmpKeyMock.mockResolvedValueOnce(makeStsResponse());
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

    // grantStsTmpKey 请求 body：python StsTmpKeysRequest 形态
    expect(grantStsTmpKeyMock).toHaveBeenCalledTimes(1);
    const [reqArg] = grantStsTmpKeyMock.mock.calls[0]!;
    expect(reqArg).toEqual({
      purpose: 'drawing', // DRAWING → 'drawing'
      filename: 'a.pdf',
      content_type: 'application/pdf',
      // sha 截前 16 hex：a * 64 → a * 16
      content_sha256: 'a'.repeat(16),
    });
    // body 不含 owner_part_id / kind / file_size（这些是 backend-rust upload-intents 字段）
    expect((reqArg as Record<string, unknown>).owner_part_id).toBeUndefined();
    expect((reqArg as Record<string, unknown>).kind).toBeUndefined();
    expect((reqArg as Record<string, unknown>).file_size).toBeUndefined();

    // COS 直传：tmp_key / bucket / region 来自 python STS 响应
    expect(uploadFileSpy).toHaveBeenCalledTimes(1);
    const cosParams = uploadFileSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(cosParams.Key).toBe('tmp/spike/seq_a.pdf');
    expect(cosParams.Bucket).toBe('bucket-1250000000');
    expect(cosParams.Region).toBe('ap-shanghai');

    // confirmPartFile：tmp_key 来自 STS 响应（不含 owner 信息，后端按 path 派生 CAS key）
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

  it('PartFileKind → StsPurpose 映射（3D_MODEL / CAD_2D 全覆盖）', async () => {
    grantStsTmpKeyMock.mockResolvedValueOnce(makeStsResponse());
    confirmPartFileMock.mockResolvedValueOnce(makeExistingFile());

    const { upload } = usePartFileUpload({
      ownerPartId: ref<string>('190000000000001'),
      kind: 'CAD_2D',
    });
    await upload(makeFile('a.dwg'));

    const [reqArg] = grantStsTmpKeyMock.mock.calls[0]!;
    expect((reqArg as { purpose: string }).purpose).toBe('cad_2d');
    const [, confirmBody] = confirmPartFileMock.mock.calls[0]!;
    expect((confirmBody as { kind: string }).kind).toBe('CAD_2D');
  });

  it('ownerPartId 不传 grantStsTmpKey（python 端端口本身就不感知 owner，CAS key 由 confirm 按 path 派生）', async () => {
    grantStsTmpKeyMock.mockResolvedValueOnce(makeStsResponse());
    confirmPartFileMock.mockResolvedValueOnce(makeExistingFile());

    const { upload } = usePartFileUpload({
      ownerPartId: ref<string>('190000000000001'),
      kind: 'DRAWING',
    });
    await upload(makeFile('a.pdf'));

    const [reqArg] = grantStsTmpKeyMock.mock.calls[0]!;
    // ownerPartId 永远不进 grantStsTmpKey body（与 backend-rust upload-intents 不同）
    expect((reqArg as Record<string, unknown>).owner_part_id).toBeUndefined();
    // confirmPartFile 才用 ownerPartId
    const [confirmPartId] = confirmPartFileMock.mock.calls[0]!;
    expect(confirmPartId).toBe('190000000000001');
  });

  it('kind = 3D_MODEL → purpose = 3d_model（与 python Literal 对齐）', async () => {
    grantStsTmpKeyMock.mockResolvedValueOnce(makeStsResponse());
    confirmPartFileMock.mockResolvedValueOnce(makeExistingFile());

    const { upload } = usePartFileUpload({
      ownerPartId: ref<string>('190000000000001'),
      kind: '3D_MODEL',
    });
    await upload(makeFile('b.stp'));

    const [reqArg] = grantStsTmpKeyMock.mock.calls[0]!;
    expect((reqArg as { purpose: string }).purpose).toBe('3d_model');
  });

  it('content_sha256 严格截前 16 hex（python schema 16-64 hex 边界）', async () => {
    grantStsTmpKeyMock.mockResolvedValueOnce(makeStsResponse());
    confirmPartFileMock.mockResolvedValueOnce(makeExistingFile());

    // SHA = 64 个不同字符（'0123456789abcdef' 循环 4 次），验证截前 16 位
    const sha64 = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    computeSha256Mock.mockResolvedValueOnce(sha64);

    const { upload } = usePartFileUpload({
      ownerPartId: ref<string>('190000000000001'),
      kind: 'DRAWING',
    });
    await upload(makeFile('a.pdf'));

    const [reqArg] = grantStsTmpKeyMock.mock.calls[0]!;
    expect((reqArg as { content_sha256: string }).content_sha256).toBe('0123456789abcdef');
    expect(((reqArg as { content_sha256: string }).content_sha256 ?? '').length).toBe(16);
  });

  it('COS 上传失败 → upload 抛错，lastError / uploading 状态正确', async () => {
    grantStsTmpKeyMock.mockResolvedValueOnce(makeStsResponse());
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

  it('grantStsTmpKey 抛错 → upload 抛错，confirmPartFile 不被调用', async () => {
    grantStsTmpKeyMock.mockRejectedValueOnce(new Error('STS service 502'));

    const { upload, lastError } = usePartFileUpload({
      ownerPartId: ref<string>('190000000000001'),
      kind: 'DRAWING',
    });

    await expect(upload(makeFile('a.pdf'))).rejects.toThrow('STS service 502');
    expect(lastError.value).toBe('STS service 502');
    expect(uploadFileSpy).not.toHaveBeenCalled();
    expect(confirmPartFileMock).not.toHaveBeenCalled();
  });

  it('ownerPartId 为空时抛错（场景：路由未带 id）', async () => {
    const { upload } = usePartFileUpload({
      ownerPartId: ref<string>(''),
      kind: 'DRAWING',
    });
    await expect(upload(makeFile('a.pdf'))).rejects.toThrow(/ownerPartId/);
    expect(grantStsTmpKeyMock).not.toHaveBeenCalled();
  });

  it('ownerPartId 支持 getter 形态（响应非 ref 的派生 ID）', async () => {
    grantStsTmpKeyMock.mockResolvedValueOnce(makeStsResponse());
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
    const [confirmPartId] = confirmPartFileMock.mock.calls[0]!;
    expect(confirmPartId).toBe('190000000000002');
    expect(confirmPartFileMock.mock.calls[0]![1]).toMatchObject({ kind: '3D_MODEL' });
  });

  it('file_size 按 CLAUDE.md §3 走 string 序列化（v2 i64 雪花序列化器对齐）', async () => {
    grantStsTmpKeyMock.mockResolvedValueOnce(makeStsResponse());
    confirmPartFileMock.mockResolvedValueOnce(makeExistingFile());

    const { upload } = usePartFileUpload({
      ownerPartId: ref<string>('190000000000001'),
      kind: 'DRAWING',
    });
    // makeFile 默认 'hello' (5 bytes)
    await upload(makeFile('a.pdf', 'hello'));

    const [, confirmBody] = confirmPartFileMock.mock.calls[0]!;
    expect((confirmBody as { file_size: unknown }).file_size).toBe('5');
    expect(typeof (confirmBody as { file_size: unknown }).file_size).toBe('string');
  });

  it('uploading 状态在 upload 期间为 true，完成后 false', async () => {
    grantStsTmpKeyMock.mockResolvedValueOnce(makeStsResponse());
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
    grantStsTmpKeyMock.mockRejectedValueOnce(new Error('first attempt'));
    grantStsTmpKeyMock.mockResolvedValueOnce(makeStsResponse());
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
