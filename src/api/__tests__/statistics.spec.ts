// src/api/__tests__/statistics.spec.ts
//
// 2026-10-12 新增：`src/api/statistics.ts` 的**负向守卫** —— 三个 api 函数
// **不允许**做 Zod 校验。
//
// 为什么是负向断言：本域的守门点在 queryFn（`views/statistics/composables/` 的三个
// hook），api 层只发请求 + 用 schema 的 `z.infer` 标注返回类型。Zod 的 parse 入口返回
// **深拷贝**，在 api 层再走一遍等于每屏数据被校验并克隆两遍；而且 api 层一旦 parse，
// queryFn 那次 parse 就变成纯浪费，两处校验点还会随字段增删各自漂移。
//
// ⚠️ 这条守卫与 `views/statistics/composables/__tests__/useStatisticsWorkersQuery.spec.ts`
// 的 W3 是一**对**：W3 守「parse 真的接在 queryFn 的返回路径上」，本文件守「parse 没有
// 被搬回 api 层」。少了本文件，把 parse 加回 api 层是零测试信号；少了 W3，把 parse 从
// queryFn 删掉也是零测试信号（api 层本来就该不 parse）。**两个方向都要有人在。**
//
// 同时钉死三个端点的 URL 与 Query 入参：这三个端点是后端 statistics 域的全部对外表面，
// URL 打错就是 404 / 405，而 404 只在「点一下才发现」时暴露。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

// 把 schema 模块整体桩掉，`parse` 用可断言的 spy：api 层今天用 `import type` 引类型，
// 模块根本不会被加载 ⇒ spy 恒 0 次调用；哪天有人把它改成运行时 import 并挂上 parse，
// 这些断言立刻红。
const schemaParse = vi.hoisted(() => ({
  overview: vi.fn(),
  workers: vi.fn(),
  detail: vi.fn(),
}));

vi.mock('@/views/statistics/composables/statisticsSchema', () => ({
  overviewOutSchema: { parse: schemaParse.overview },
  workerStatsListOutSchema: { parse: schemaParse.workers },
  workerDetailOutSchema: { parse: schemaParse.detail },
}));

const httpGetMock = vi.fn();

vi.mock('@/api/http', () => ({
  api: {
    get: (...args: unknown[]) => httpGetMock(...args),
  },
}));

import { fetchOverview, fetchWorkerDetail, fetchWorkerStats } from '../statistics';

const RANGE = { date_from: '2026-10-01', date_to: '2026-10-12' };

/** 打一次读并返回实际打到 axios 的 URL 与 params。 */
async function calledWith(run: () => Promise<unknown>): Promise<{
  url: string;
  params: Record<string, unknown>;
}> {
  httpGetMock.mockReset();
  httpGetMock.mockResolvedValue({ data: { items: [] } });
  await run();
  expect(httpGetMock).toHaveBeenCalledTimes(1);
  const config = httpGetMock.mock.calls[0]![1] as { params: Record<string, unknown> };
  return { url: httpGetMock.mock.calls[0]![0] as string, params: config.params };
}

beforeEach(() => {
  schemaParse.overview.mockReset();
  schemaParse.workers.mockReset();
  schemaParse.detail.mockReset();
  httpGetMock.mockReset();
});

describe('statistics api 层不做 Zod 校验（负向守卫）', () => {
  it('N1：三个 api 函数一律不调用 schema.parse', async () => {
    httpGetMock.mockResolvedValue({ data: { items: [] } });
    await fetchOverview(RANGE);
    await fetchWorkerStats(RANGE);
    await fetchWorkerDetail('1900000000000000001', RANGE);

    expect(schemaParse.overview).not.toHaveBeenCalled();
    expect(schemaParse.workers).not.toHaveBeenCalled();
    expect(schemaParse.detail).not.toHaveBeenCalled();
  });

  it('N2：坏响应原样透传（items 传字符串也照返，不 reject、不裁剪）', async () => {
    // 这条是 N1 的行为侧镜像：真在 api 层挂过 parse，这里必然抛 ZodError。
    httpGetMock.mockResolvedValue({ data: { items: '这不是数组' } });
    await expect(fetchWorkerStats(RANGE)).resolves.toEqual({ items: '这不是数组' });

    httpGetMock.mockResolvedValue({ data: { totally_wrong: true } });
    await expect(fetchOverview(RANGE)).resolves.toEqual({ totally_wrong: true });
  });
});

describe('statistics 三个端点的 URL 与 Query 契约', () => {
  it('U1：总览打 /statistics/overview，日期两个键都进 params', async () => {
    const { url, params } = await calledWith(() => fetchOverview(RANGE));
    expect(url).toBe('/statistics/overview');
    expect(params).toEqual({ date_from: '2026-10-01', date_to: '2026-10-12' });
  });

  it('U2：工人列表打 /statistics/workers（无分页键 —— 端点一次性返全部）', async () => {
    const { url, params } = await calledWith(() => fetchWorkerStats(RANGE));
    expect(url).toBe('/statistics/workers');
    expect(Object.keys(params).sort()).toEqual(['date_from', 'date_to']);
  });

  it('U3：单工人详情打 /statistics/workers/{id}，id 经 encodeURIComponent', async () => {
    const { url, params } = await calledWith(() => fetchWorkerDetail('SN/A B', RANGE));
    expect(url).toBe('/statistics/workers/SN%2FA%20B');
    expect(params).toEqual({ date_from: '2026-10-01', date_to: '2026-10-12' });
  });

  it('U4：域内 schema 的引用是 import type（编译期擦除，api → views 不留运行时边）', async () => {
    // 守 CLAUDE.md「api 层引域内 schema 默认用 import type」：改成值 import 会在运行时
    // 引入一条 api → views 的边，且没给本域带来任何收益（守门在 queryFn）。
    const src = readFileSync(new URL('../statistics.ts', import.meta.url), 'utf8');
    const match = src.match(
      /import\s+(type\s+)?\{[^}]*\}\s*from\s*'@\/views\/statistics\/composables\/statisticsSchema'/s,
    );
    expect(match).not.toBeNull();
    expect(match?.[1]).toBe('type ');
  });
});
