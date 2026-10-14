// src/api/__tests__/applicant.contract.spec.ts
//
// 2026-10-17 新增（review 第 1 轮 MINOR-4）：`src/api/applicant.ts` 全部 6 个端点的
// **method + URL + body/query 契约守卫**。
//
// 为什么必须有（缺陷的讽刺之处就在这里）：本次修复的根因**是上一版 URL 拼错了** ——
// 前端调 `/com/applicants/bulk-get-or-create`，而后端 applicant 域压根没有这条路由
// （`handler.rs` 只挂 `/` / `/{id}` / `/{id}/update` / `/{id}/soft-delete`，模块 doc
// 明确把 `/search` 与 `/bulk-get-or-create` 列为「不在范围」）。请求落进 `/{id}` 被
// `Path<i64>` 捕获后失败 ⇒ 405/400。
// 而当时的两份新增 spec（`usePartBatchManual.spec.ts`）是**把 `@/api/applicant` 整个
// 模块 mock 掉**来断言「它被调了、参数对」—— **URL 字面量一次都没进过断言**，于是把 URL
// 拼错时它们全绿。故「打出去的东西」这一维必须有独立守门：mock 掉的是被测对象，
// mock 掉被测对象就永远验不了它自己。
//
// 后端对照（本次 pin 的依据，**不是 master**）：后端同分支 worktree 的
// `feat/fix-cancel-applicant-force-inspection`（`fix(applicant): 补幂等 get-or-create 端点`
// 那个 commit）的 `src/modules/com/applicant/handler.rs::router()` 逐条为：
//   `/`（GET list / POST create）、`/get-or-create`（POST）、`/{id}`（GET）、
//   `/{id}/update`（POST）、`/{id}/soft-delete`（POST）
// 挂载点 `/api/v2/com/applicants`，`api` 实例已带 `/api/v2` 前缀，故 URL 不含该段。
// ⚠️ 该端点在 master 上**还不存在**（`main` 的 applicant 域没有 `/get-or-create`），
// 部署顺序：**后端先上**，否则新增订单页的申请人自动补全 405。
//
// mock 手法沿 `productionScan.contract.spec.ts` / `customer.spec.ts` 同款：整模块桩掉
// `@/api/http`（不 importOriginal），只留 api.get / api.post / cleanParams。

import { beforeEach, describe, expect, it, vi } from 'vitest';

const httpGetMock = vi.fn();
const httpPostMock = vi.fn();

vi.mock('@/api/http', () => ({
  api: {
    get: (...args: unknown[]) => httpGetMock(...args),
    post: (...args: unknown[]) => httpPostMock(...args),
  },
  // 逐条复刻 `src/api/http.ts::cleanParams`：只丢 undefined / null / 空串 / 空数组。
  cleanParams: (obj?: Record<string, unknown>) => {
    if (!obj) return {};
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined || v === null) continue;
      if (typeof v === 'string' && v === '') continue;
      if (Array.isArray(v) && v.length === 0) continue;
      out[k] = v;
    }
    return out;
  },
}));

import {
  createApplicant,
  getOrCreateApplicant,
  listApplicants,
  softDeleteApplicant,
  updateApplicant,
} from '../applicant';

const APPLICANT_ID = '190000000000301';
const L1_CUSTOMER_ID = '190000000000201';

/** 打一次读请求并返回 axios 实际收到的 URL 与 query。 */
async function fetchedRequest(
  run: () => Promise<unknown>,
): Promise<{ path: string; params: Record<string, unknown> }> {
  httpGetMock.mockReset();
  httpGetMock.mockResolvedValue({ data: { items: [], total: 0, limit: 20, offset: 0 } });
  await run();
  expect(httpGetMock).toHaveBeenCalledTimes(1);
  const [path, cfg] = httpGetMock.mock.calls[0] as [
    string,
    { params?: Record<string, unknown> } | undefined,
  ];
  // cfg 在本文件里恒为对象（唯一的读端点 `listApplicants` 必传 params），`?? {}`
  // 只是不让类型收窄失败。
  return { path, params: cfg?.params ?? {} };
}

/** 打一次写请求并返回 axios 实际收到的 URL 与 body。 */
async function postedRequest(
  run: () => Promise<unknown>,
): Promise<{ path: string; body: Record<string, unknown> }> {
  httpPostMock.mockReset();
  httpPostMock.mockResolvedValue({ data: { id: APPLICANT_ID } });
  await run();
  expect(httpPostMock).toHaveBeenCalledTimes(1);
  const [path, body] = httpPostMock.mock.calls[0] as [string, Record<string, unknown>];
  return { path, body };
}

beforeEach(() => {
  httpGetMock.mockReset();
  httpPostMock.mockReset();
});

describe('api/applicant — 5 个端点的 method + URL 逐字钉死', () => {
  it('A1：列表 = GET /com/applicants（过滤键走 query，不是 path 分段）', async () => {
    const { path, params } = await fetchedRequest(() =>
      listApplicants({ customer_id: L1_CUSTOMER_ID, limit: 200, offset: 20 }),
    );
    expect(path).toBe('/com/applicants');
    expect(params).toEqual({ customer_id: L1_CUSTOMER_ID, limit: 200, offset: 20 });
    // 反断言：客户 id 绝不能拼进 path（后端是 Query extractor，path 上再带会 404）
    expect(path).not.toContain(L1_CUSTOMER_ID);
  });

  it('A2：列表缺省参数时不凭空出现任何 query 键', async () => {
    const { params } = await fetchedRequest(() => listApplicants());
    expect(params).toEqual({});
  });

  // ⚠️ **本文件存在的主要理由**：URL 拼错时下面每一条都会红。
  // 后端这条路由是本分支后端 worktree 新增的（master 上还没有），落进 `/{id}` 捕获 ⇒ 405。
  it('A3：幂等新增 = POST /com/applicants/get-or-create（不是已下线的 bulk-get-or-create）', async () => {
    const { path, body } = await postedRequest(() =>
      getOrCreateApplicant({ name: '张三', customer_id: L1_CUSTOMER_ID }),
    );
    expect(path).toBe('/com/applicants/get-or-create');
    // 后端 handler doc 明确列为「不在范围」的那条路由：一旦复活，这条与 A3 一起变红。
    expect(path).not.toContain('bulk-get-or-create');
    expect(path).not.toContain('/search');
    // body 与 ApplicantCreateRequest 逐字同形：两个键都必填、都是字符串
    expect(body).toEqual({ name: '张三', customer_id: L1_CUSTOMER_ID });
    expect(typeof body.customer_id, '雪花 id 发数字会被 serde 拒成 422').toBe('string');
  });

  it('A4：改 = POST /com/applicants/{id}/update', async () => {
    const { path, body } = await postedRequest(() =>
      updateApplicant(APPLICANT_ID, { name: '李四', customer_id: L1_CUSTOMER_ID }),
    );
    expect(path).toBe(`/com/applicants/${APPLICANT_ID}/update`);
    expect(body).toEqual({ name: '李四', customer_id: L1_CUSTOMER_ID });
  });

  it('A5：新建 = POST /com/applicants；软删 = POST /com/applicants/{id}/soft-delete', async () => {
    const created = await postedRequest(() =>
      createApplicant({ name: '王五', customer_id: L1_CUSTOMER_ID }),
    );
    expect(created.path).toBe('/com/applicants');

    httpPostMock.mockReset();
    httpPostMock.mockResolvedValue({ data: null });
    await softDeleteApplicant(APPLICANT_ID);
    expect(httpPostMock).toHaveBeenCalledTimes(1);
    expect(httpPostMock.mock.calls[0]![0]).toBe(`/com/applicants/${APPLICANT_ID}/soft-delete`);
  });

  // 后端三条写端点全是 POST（仓内零 PUT / PATCH / DELETE）。软删尤其不能写成 DELETE：
  // `/com/applicants/{id}` 只注册了 GET，落 DELETE 会拿到 405。
  it('A6：全仓只用 GET / POST（软删不是 DELETE —— `/{id}` 只注册 GET，DELETE 会 405）', async () => {
    await softDeleteApplicant(APPLICANT_ID);
    expect(httpPostMock).toHaveBeenCalledTimes(1);
    expect(httpGetMock).not.toHaveBeenCalled();
  });

  // api 层不做 Zod 校验（分层取舍）：坏响应原样透传，守门在消费侧的 queryFn /
  // mutationFn。这里钉的是「别把 parse 搬回 api 层」这个方向。
  it('A7：api 层原样透传出参，不在边界 parse', async () => {
    httpPostMock.mockReset();
    const wire = { id: APPLICANT_ID };
    httpPostMock.mockResolvedValue({ data: wire });
    await expect(
      getOrCreateApplicant({ name: '张三', customer_id: L1_CUSTOMER_ID }),
    ).resolves.toEqual(wire);

    httpGetMock.mockReset();
    const badList = { items: [{ id: APPLICANT_ID }], total: 1, limit: 20, offset: 0 };
    httpGetMock.mockResolvedValue({ data: badList });
    await expect(listApplicants()).resolves.toEqual(badList);
  });
});
