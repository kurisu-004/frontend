// src/api/files/__tests__/sts.spec.ts（2026-09-17 frontend-cos-sts-python）
//
// 验证 grantStsTmpKey caller：
// - POST 走 apiPrint（baseURL /api/v1），路径 /files/sts-tmp-keys；
// - 请求字段映射（purpose / filename / content_sha256 / content_type / expire_seconds）；
// - 响应字段映射（tmp_key / credentials / bucket / region / endpoint / scheme /
//   expires_in / upload_prefix + credentials.start_time）；
// - 端点路径不含 /v1 前缀（baseURL 已自带）；
// - 默认 Content-Type 由 axios 自动选 application/json（不显式覆盖）。
//
// 用 vi.mock 拦截 @/api/http 的 apiPrint，断言 method / url / body / 响应形态，
// 不发起真实 HTTP。api 模块本测试不用，但 mock 模块仍暴露同名导出以避免
// 其他无关 caller 被 vi.mock('api/http') 静默替换时类型报错。

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
  cleanParams: (obj?: Record<string, unknown>) => obj ?? {},
}));

import { grantStsTmpKey } from '../sts';
import type { StsTmpKeysRequest, StsTmpKeysResponse } from '@/types/sts';

beforeEach(() => {
  postCalls.mockReset();
  getCalls.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeResponse(overrides: Partial<StsTmpKeysResponse> = {}): StsTmpKeysResponse {
  return {
    tmp_key: 'tmp/spike/seq_a.pdf',
    bucket: 'examplebucket-1250000000',
    region: 'ap-shanghai',
    endpoint: 'cos.ap-shanghai.myqcloud.com',
    scheme: 'https',
    credentials: {
      tmp_secret_id: 'AKIDxxx',
      tmp_secret_key: 'SECRETxxx',
      session_token: 'TOKENxxx',
      start_time: 1_900_000_000,
      expired_time: 1_900_001_800,
    },
    expires_in: 1800,
    upload_prefix: 'tmp/spike/',
    ...overrides,
  };
}

describe('grantStsTmpKey', () => {
  // (a) POST 走 apiPrint + 路径对齐
  it('POST /files/sts-tmp-keys（走 apiPrint，baseURL /api/v1 自带）', async () => {
    postCalls.mockResolvedValueOnce({ data: makeResponse() });

    await grantStsTmpKey({
      purpose: 'drawing',
      filename: 'a.pdf',
    });

    expect(postCalls).toHaveBeenCalledTimes(1);
    const [url] = postCalls.mock.calls[0]!;
    // 不带 /v1 前缀：baseURL /api/v1 由 apiPrint 实例自带。
    expect(url).toBe('/files/sts-tmp-keys');
  });

  // (b) 请求字段映射（含 content_sha256 / content_type / expire_seconds）
  it('请求 body 字段映射严格对齐 python StsTmpKeysRequest', async () => {
    postCalls.mockResolvedValueOnce({ data: makeResponse() });

    const req: StsTmpKeysRequest = {
      purpose: '3d_model',
      filename: 'part.step',
      content_type: 'application/step',
      content_sha256: 'a'.repeat(16),
      expire_seconds: 3600,
    };
    await grantStsTmpKey(req);

    const [, body] = postCalls.mock.calls[0]!;
    expect(body).toEqual(req);
  });

  // expire_seconds 缺省：axios / python 都给 default，caller 不主动塞值即可
  it('expire_seconds 缺省时 body 不主动塞 undefined 字段', async () => {
    postCalls.mockResolvedValueOnce({ data: makeResponse() });

    await grantStsTmpKey({
      purpose: 'drawing',
      filename: 'a.pdf',
    });

    const [, body] = postCalls.mock.calls[0]!;
    const bodyObj = body as Record<string, unknown>;
    expect(bodyObj.expire_seconds).toBeUndefined();
    expect(bodyObj.content_sha256).toBeUndefined();
    expect(bodyObj.content_type).toBeUndefined();
  });

  // (c) 响应字段映射（含 credentials.start_time / expired_time）
  it('响应字段映射严格对齐 python StsTmpKeysResponse（含 start_time）', async () => {
    const resp = makeResponse({
      tmp_key: 'tmp/ownerid/seq_b.stp',
      bucket: 'bucket-123',
      region: 'ap-beijing',
      upload_prefix: 'tmp/ownerid/',
      credentials: {
        tmp_secret_id: 'AKID2',
        tmp_secret_key: 'SECRET2',
        session_token: 'TOKEN2',
        start_time: 1_900_000_000,
        expired_time: 1_900_001_800,
      },
      expires_in: 1800,
      endpoint: 'cos.ap-beijing.myqcloud.com',
      scheme: 'https',
    });
    postCalls.mockResolvedValueOnce({ data: resp });

    const out = await grantStsTmpKey({
      purpose: '3d_model',
      filename: 'b.stp',
      content_sha256: 'b'.repeat(16),
    });

    // 全部字段一一对照
    expect(out.tmp_key).toBe('tmp/ownerid/seq_b.stp');
    expect(out.bucket).toBe('bucket-123');
    expect(out.region).toBe('ap-beijing');
    expect(out.endpoint).toBe('cos.ap-beijing.myqcloud.com');
    expect(out.scheme).toBe('https');
    expect(out.upload_prefix).toBe('tmp/ownerid/');
    expect(out.expires_in).toBe(1800);
    // credentials 四元组 + start_time + expired_time 全部透传
    expect(out.credentials.tmp_secret_id).toBe('AKID2');
    expect(out.credentials.tmp_secret_key).toBe('SECRET2');
    expect(out.credentials.session_token).toBe('TOKEN2');
    expect(out.credentials.start_time).toBe(1_900_000_000);
    expect(out.credentials.expired_time).toBe(1_900_001_800);
  });

  // (d) 全 7 个 purpose 枚举值都能正常透传（python `Purpose` Literal 边界守卫）
  it.each([
    'drawing',
    '3d_model',
    'cad_2d',
    'g_code',
    'setup_sheet',
    'assembly_master',
    'tmp',
  ] as const)('purpose = %s 时正常发送', async (purpose) => {
    postCalls.mockResolvedValueOnce({ data: makeResponse() });

    await grantStsTmpKey({ purpose, filename: `${purpose}.bin` });

    const [, body] = postCalls.mock.calls[0]!;
    expect((body as { purpose: string }).purpose).toBe(purpose);
  });
});
