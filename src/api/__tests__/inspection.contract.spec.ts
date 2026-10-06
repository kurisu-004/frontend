// src/api/__tests__/inspection.contract.spec.ts
//
// 2026-10-07 新增：prod::inspection 域（`src/api/inspection.ts`）两条只读端点的
// **逐条 URL + Query 参数契约守卫**。
//
// 为什么必须逐字钉死 URL：prod::inspection 域的读端点一旦改路径就是硬切换（无 alias），
// 前端不打准就是 404，而这类失败在开发期「点一下才发现」，仓内其它 URL 断言
// （`src/api/parts/__tests__/routes.spec.ts`）只守 parts 域，管不到这里。
// 契约必须在前端侧被钉死，不能靠后端自测 + 类型系统兜底。
//
// 覆盖：
//   - Q1：队列读打 `/prod/inspection/queue`。
//   - Q2：Query 入参集（三个 ILIKE 子串 + 客户 + 系统交期区间 + 排序 + 分页）
//     逐个落到 axios params。
//   - Q3：筛选键为 undefined 时不出现在 axios params 上（cleanParams 的 strip 层）。
//   - Q4：扫码查树打 `/prod/inspection/scan/{serial_no}`，序列号经 encodeURIComponent
//     （条码里可能带 `/` 与空格）。
//
// 守门分工：队列读的 Zod 守门在 queryFn
// （`views/inspection/composables/useInspectionQueueQuery`），扫码树的守门在 api
// 边界（用户触发的单次拉取，走 useMutation 没有承载它的 queryFn）—— 两者都不在
// 本文件的守门范围内，本文件只钉「打出去的东西」。
//
// mock 手法沿 src/api/parts/__tests__/routes.spec.ts 同款：整模块桩掉 `@/api/http`
// （不 importOriginal），只留可断言的 api.get / api.post 入口。`cleanParams` 的桩**照抄**
// 真实现的剥离语义（undefined / null / 空串 / 空数组一律不上 wire），否则 Q3 会退化成
// 空断言（identity 桩 + `toEqual` 会因 `toEqual` 忽略 undefined 属性而恒真）。
// 要断的是 `listInspectionBatches` 有没有把 `cleanParams(params)` 交给 axios，
// 而非 cleanParams 自身的实现 —— 后者由真实现的单测负责。

import { beforeEach, describe, expect, it, vi } from 'vitest';

const httpGetMock = vi.fn();

vi.mock('@/api/http', () => ({
  api: {
    get: (...args: unknown[]) => httpGetMock(...args),
    post: (...args: unknown[]) => httpGetMock(...args),
  },
  cleanParams: (obj?: Record<string, unknown>) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj ?? {})) {
      if (v === undefined || v === null) continue;
      if (typeof v === 'string' && v === '') continue;
      if (Array.isArray(v) && v.length === 0) continue;
      out[k] = v;
    }
    return out;
  },
}));

import { listInspectionBatches, scanInspection } from '../inspection';

/** 打一次读请求并返回实际使用的 URL。 */
async function fetchedPath(run: () => Promise<unknown>): Promise<string> {
  httpGetMock.mockReset();
  httpGetMock.mockResolvedValue({ data: { items: [], total: '0', limit: '200', offset: '0' } });
  await run();
  expect(httpGetMock).toHaveBeenCalledTimes(1);
  return httpGetMock.mock.calls[0]![0] as string;
}

/** 打一次队列读并返回实际打到 axios 的 params。 */
async function queueQueryParams(run: () => Promise<unknown>): Promise<Record<string, unknown>> {
  httpGetMock.mockReset();
  httpGetMock.mockResolvedValue({ data: { items: [], total: '0', limit: '200', offset: '0' } });
  await run();
  const config = httpGetMock.mock.calls[0]![1] as { params: Record<string, unknown> };
  return config.params;
}

beforeEach(() => {
  httpGetMock.mockReset();
});

describe('prod::inspection 域 URL 契约', () => {
  it('Q1：队列读打 /prod/inspection/queue', async () => {
    expect(await fetchedPath(() => listInspectionBatches())).toBe('/prod/inspection/queue');
  });

  it('Q4：扫码查树打 /prod/inspection/scan/{serial_no}，序列号经 encodeURIComponent', async () => {
    // 序列号带 `/` 与空格：不编码会被拼成多段路径（打到错的路由）。
    httpGetMock.mockReset();
    // 扫码读的响应走 Zod 守门，喂一个最简合法空树即可。
    httpGetMock.mockResolvedValue({
      data: { hit_kind: 'PART', scanned_serial_no: 'SN/A B', assembly: null, children: [] },
    });
    await scanInspection('SN/A B');
    expect(httpGetMock).toHaveBeenCalledTimes(1);
    expect(httpGetMock.mock.calls[0]![0]).toBe('/prod/inspection/scan/SN%2FA%20B');
  });
});

describe('队列读的 Query 参数集', () => {
  it('Q2：新参数集（三个 ILIKE + 客户 + 系统交期 + 排序 + 分页）逐个落到 axios params', async () => {
    const params = await queueQueryParams(() =>
      listInspectionBatches({
        drawing_no: 'A',
        name: 'B',
        serial_no: 'C',
        customer_id: '9000000000001',
        system_delivery_date_from: '2026-10-01',
        system_delivery_date_to: '2026-10-31',
        sort_by: 'NAME',
        sort_dir: 'ASC',
        limit: 20,
        offset: 40,
      }),
    );
    expect(params).toEqual({
      drawing_no: 'A',
      name: 'B',
      serial_no: 'C',
      customer_id: '9000000000001',
      system_delivery_date_from: '2026-10-01',
      system_delivery_date_to: '2026-10-31',
      sort_by: 'NAME',
      sort_dir: 'ASC',
      limit: 20,
      offset: 40,
    });
  });

  // 「空筛选 → undefined → 不上 wire」这一层的真 wire 形态守卫：store spec 里
  // buildParams 那半（params.xxx === undefined）因 `@/api/inspection` 被 mock 掉而验不到
  // wire。入参刻意把 6 个筛选键显式写成 undefined —— 那正是 buildParams 空筛选下的产出，
  // 走的是 cleanParams 真正要 strip 的那条路径（不写这几个键则该层根本没被触发）。
  // 断 **键集合**（`Object.keys`）而不是 `toEqual`：vitest 的 `toEqual` 忽略值为
  // undefined 的属性，用它断言「这些键没上 wire」恒真。
  it('Q3：筛选键为 undefined 时不出现在 axios params 上', async () => {
    const params = await queueQueryParams(() =>
      listInspectionBatches({
        drawing_no: undefined,
        name: undefined,
        serial_no: undefined,
        customer_id: undefined,
        system_delivery_date_from: undefined,
        system_delivery_date_to: undefined,
        sort_by: 'SYSTEM_DELIVERY_DATE',
        sort_dir: 'ASC',
        limit: 20,
        offset: 0,
      }),
    );
    expect(Object.keys(params).sort()).toEqual(['limit', 'offset', 'sort_by', 'sort_dir']);
    expect(params).not.toHaveProperty('drawing_no');
    expect(params).not.toHaveProperty('system_delivery_date_from');
  });
});