// src/api/__tests__/part.forceComplete.spec.ts
//
// 2026-10-13 新增：零件「强制完成」端点（`POST /api/v2/prod/parts/{id}/force-complete`）
// 的请求形状守卫。与装配件侧的 assembly.forceComplete.spec.ts 同款、同因。
//
// 为什么必须有这个文件：**路径前缀写错不会有任何前端报错信号** —— 零件域其余写端点
// （cancel / soft-delete / 批次流转…）全在 `/api/v2/parts/*` 下，只有 force-complete
// 与装配件那条挂在 prod 命名空间里，于是「照着同文件邻居抄一条
// `/parts/{id}/force-complete`」是一个极易犯、且只有到现场点按钮看 404 才能发现的错。
// 本次零件侧从 `/parts/{id}/force-complete` 硬切到 `/prod/parts/{id}/force-complete`
// （无 alias）后，这层前缀守卫对两侧都成立。
//
// 两条防抄错的负向钉：既不许漏掉 `prod` 前缀，也不许抄成装配件那条
// `/prod/assemblies/...` —— 后者路径段数量与格式完全同形，只差资源名。
//
// 第二条钉死的是雪花 id：超过 `Number.MAX_SAFE_INTEGER`，URL 拼接一旦经过
// `Number()` 就会静默丢精度 → 打到后端是「工单不存在」而不是「id 格式错」。
//
// mock 手法沿 assembly.forceComplete.spec.ts / parts/routes.spec.ts：整模块桩掉
// `@/api/http`（不 importOriginal），只留可断言的 api.get / api.post 入口。

import { beforeEach, describe, expect, it, vi } from 'vitest';

const httpPostMock = vi.fn();

vi.mock('@/api/http', () => ({
  api: {
    get: vi.fn(),
    post: (...args: unknown[]) => httpPostMock(...args),
  },
  cleanParams: (obj?: Record<string, unknown>) => obj ?? {},
  // crud.ts 的 listParts 会用，本文件不覆盖它；给出实现避免 vitest 报
  // 「No normalizeListResult export is defined on the mock」。
  normalizeListResult: (v: unknown) => v,
}));

vi.mock('@/composables/queries/schemas', () => ({
  // crud.ts 模块顶层 import 了返修 VO 的守门 schema，URL 守卫不需要真实 schema。
  repairBatchListResultSchema: { parse: (v: unknown) => v },
}));

import { forceCompletePart } from '@/api/parts/crud';

/** 超出 Number.MAX_SAFE_INTEGER 的雪花 id（必须全程按 string 处理）。 */
const HUGE_SNOWFLAKE_ID = '213102505968533504';

beforeEach(() => {
  httpPostMock.mockReset();
  httpPostMock.mockResolvedValue({ data: null });
});

describe('forceCompletePart：请求形状', () => {
  it('打 /prod/parts/{id}/force-complete（带 prod 前缀，不是 /parts/...）', async () => {
    await forceCompletePart('1900000000009001');

    expect(httpPostMock).toHaveBeenCalledTimes(1);
    const [url] = httpPostMock.mock.calls[0]! as [string, unknown];
    expect(url).toBe('/prod/parts/1900000000009001/force-complete');
    // 反向钉死：漏掉 prod 前缀就是错的（后端 404）
    expect(url.startsWith('/parts/')).toBe(false);
    // 反向钉死：与装配件那条同形（只差资源名），抄错资源名同样 404
    expect(url.startsWith('/prod/assemblies/')).toBe(false);
  });

  it('不传 payload 时 body 为 {}（避免 undefined body）', async () => {
    await forceCompletePart('1900000000009001');

    const [, body] = httpPostMock.mock.calls[0]! as [string, unknown];
    expect(body).toEqual({});
  });

  it('透传 note 字段，且不带 version（后端 OCC 豁免端点）', async () => {
    await forceCompletePart('1900000000009001', { note: '客户已电话确认收货' });

    const [, body] = httpPostMock.mock.calls[0]! as [string, unknown];
    expect(body).toEqual({ note: '客户已电话确认收货' });
    expect(body).not.toHaveProperty('version');
  });

  it('雪花 id 不被数字化（超出 MAX_SAFE_INTEGER，拼 URL 时不经 Number()）', async () => {
    // 若实现里写了 `Number(id)`，`213102505968533504` 会变成 213102505968533500
    await forceCompletePart(HUGE_SNOWFLAKE_ID);

    const [url] = httpPostMock.mock.calls[0]! as [string, unknown];
    expect(url).toBe(`/prod/parts/${HUGE_SNOWFLAKE_ID}/force-complete`);
    expect(url).toContain(HUGE_SNOWFLAKE_ID);
    expect(url).not.toContain('213102505968533500');
    // 该 id 的数字形态与字符串形态本就不同 ⇒ 只要 URL 里还是原串即证明没数字化
    expect(String(Number(HUGE_SNOWFLAKE_ID))).not.toBe(HUGE_SNOWFLAKE_ID);
  });
});
