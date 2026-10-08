// src/api/__tests__/assembly.forceComplete.spec.ts
//
// 2026-10-11 新增：装配件「强制完成」端点（`POST /api/v2/prod/assemblies/{id}/force-complete`）
// 的请求形状守卫。
//
// 为什么必须有这个文件：**路径前缀写错不会有任何前端报错信号** —— 后端只在 prod
// 命名空间下注册了这条写端点，其余 10 条装配件端点仍在 `/api/v2/assemblies/*`，
// 于是「照着同文件邻居抄一条 `/assemblies/{id}/force-complete`」是一个极易犯、
// 且只有到现场点按钮看 404 才能发现的错。这里把前缀钉死。
//
// 第二条钉死的是雪花 id：超过 `Number.MAX_SAFE_INTEGER`，URL 拼接一旦经过
// `Number()` 就会静默丢精度 → 打到后端是「批次不存在」而不是「id 格式错」。
//
// mock 手法沿 assembly.create.spec.ts：整模块桩掉 `@/api/http`（不 importOriginal）。

import { beforeEach, describe, expect, it, vi } from 'vitest';

const httpPostMock = vi.fn();

vi.mock('@/api/http', () => ({
  api: {
    get: vi.fn(),
    post: (...args: unknown[]) => httpPostMock(...args),
  },
  cleanParams: (obj?: Record<string, unknown>) => obj ?? {},
}));

import { forceCompleteAssembly } from '@/api/assembly';

/** 超出 Number.MAX_SAFE_INTEGER 的雪花 id（必须全程按 string 处理）。 */
const HUGE_SNOWFLAKE_ID = '213102505968533504';

beforeEach(() => {
  httpPostMock.mockReset();
  httpPostMock.mockResolvedValue({ data: null });
});

describe('forceCompleteAssembly：请求形状', () => {
  it('打 /prod/assemblies/{id}/force-complete（带 prod 前缀，不是 /assemblies/...）', async () => {
    await forceCompleteAssembly('1900000000009001');

    expect(httpPostMock).toHaveBeenCalledTimes(1);
    const [url] = httpPostMock.mock.calls[0]! as [string, unknown];
    expect(url).toBe('/prod/assemblies/1900000000009001/force-complete');
    // 反向钉死：拼成同文件其余端点的形状就是错的（后端 404）
    expect(url.startsWith('/assemblies/')).toBe(false);
  });

  it('不传 payload 时 body 为 {}（与 forceCompletePart 同款，避免 undefined body）', async () => {
    await forceCompleteAssembly('1900000000009001');

    const [, body] = httpPostMock.mock.calls[0]! as [string, unknown];
    expect(body).toEqual({});
  });

  it('透传 note 字段', async () => {
    await forceCompleteAssembly('1900000000009001', { note: '客户已电话确认收货' });

    const [, body] = httpPostMock.mock.calls[0]! as [string, unknown];
    expect(body).toEqual({ note: '客户已电话确认收货' });
  });

  it('雪花 id 不被数字化（超出 MAX_SAFE_INTEGER，拼 URL 时不经 Number()）', async () => {
    // 若实现里写了 `Number(id)`，`213102505968533504` 会变成 213102505968533500
    await forceCompleteAssembly(HUGE_SNOWFLAKE_ID);

    const [url] = httpPostMock.mock.calls[0]! as [string, unknown];
    expect(url).toBe(`/prod/assemblies/${HUGE_SNOWFLAKE_ID}/force-complete`);
    expect(url).toContain(HUGE_SNOWFLAKE_ID);
    expect(url).not.toContain('213102505968533500');
    // 该 id 的数字形态与字符串形态本就不同 ⇒ 只要 URL 里还是原串即证明没数字化
    expect(String(Number(HUGE_SNOWFLAKE_ID))).not.toBe(HUGE_SNOWFLAKE_ID);
  });
});
