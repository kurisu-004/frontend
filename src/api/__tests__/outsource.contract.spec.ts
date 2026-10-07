// src/api/__tests__/outsource.contract.spec.ts
//
// 2026-10-03 新增：外协域的**逐条 URL + body 契约守卫**。
//
// 为什么必须有这个文件（3 个线上故障的共同根因）：
//   外协域此前是全仓少数**没有 Zod 守门、也没有任何 URL 断言**的模块 —— api helper
//   把 `api.get` 的结果原样喂给 el-table，形状不符时收不到数组就**静默空白**而不是报错。
//   三个故障因此都能悄悄上线：
//     ① `GET /outsource-companies/{id}/sent-parts` 路由没注册 ⇒ 对账页 404；
//     ② `GET /outsource-quotes/quotable-parts` 后端无此路由，请求被 quote_router 的
//        `/{id}`（`Path<i64>`）吞成 400 ⇒ 报价页每次进都报错 + picker 恒空；
//     ③ `GET /parts/outsource-in-flight` / `/parts/outsource-sendable` 后端存在但返的是
//        通用零件列表 `PartListItem` ⇒ 收发两 tab 全空白。
//   2026-10-09：③ 的两个端点随外协看板取代那对表格页而删除，本文件守的 list 端点从
//   4 个减为 2 个（对账 / 可报价零件）；A3 留了一条存在性反断言钉住「不得复活」。
//   契约必须在前端侧被逐字钉死，不能靠「后端自测 + 类型系统」兜底。
//
// 本文件负责「路径与形态」，守门有效性（漏声明字段会被 strip）由 §E 组用例保证。
//
// mock 手法沿 src/api/parts/__tests__/routes.spec.ts 同款：整模块桩掉 `@/api/http`
// （不 importOriginal），只留可断言的 api.get / api.post 入口。
//
// ⚠️ 这里**刻意不桩掉** `@/composables/queries/schemas`（与 routes.spec.ts 不同）：
// URL 组用的响应是合法的空信封 `{items: [], total: 0, limit: 50, offset: 0}`，真 schema
// 能 parse 通过，于是同一个文件里 E 组可以直接 import **真 schema** 验证守门本身 —
// 桩掉它会让「parse 抛错」这批断言全部变成空断言（对着 no-op 桩 parse 永远不抛）。

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  outsourceQuotablePartListResultSchema,
  outsourceSentPartListResultSchema,
} from '@/composables/queries/schemas';

const httpGetMock = vi.fn();
const httpPostMock = vi.fn();

vi.mock('@/api/http', () => ({
  api: {
    get: (...args: unknown[]) => httpGetMock(...args),
    post: (...args: unknown[]) => httpPostMock(...args),
  },
  cleanParams: (obj?: Record<string, unknown>) => obj ?? {},
  normalizeListResult: (v: unknown) => v,
}));

import { listCompanySentParts, listQuotableParts } from '../outsource';
import { receiveFromOutsource, sendToOutsource } from '@/api/parts';

const COMPANY = '190000000000900';

/** 打一次读请求并返回实际使用的 URL。 */
async function fetchedPath(run: () => Promise<unknown>): Promise<string> {
  httpGetMock.mockReset();
  httpGetMock.mockResolvedValue({ data: { items: [], total: 0, limit: 50, offset: 0 } });
  await run();
  expect(httpGetMock).toHaveBeenCalledTimes(1);
  return httpGetMock.mock.calls[0]![0] as string;
}

/** 打一次写请求并返回 { path, body }。 */
async function posted(
  run: () => Promise<unknown>,
): Promise<{ path: string; body: Record<string, unknown> }> {
  httpPostMock.mockReset();
  httpPostMock.mockResolvedValue({ data: {} });
  await run();
  expect(httpPostMock).toHaveBeenCalledTimes(1);
  const [path, body] = httpPostMock.mock.calls[0] as [string, Record<string, unknown>];
  return { path, body };
}

beforeEach(() => {
  httpGetMock.mockReset();
  httpPostMock.mockReset();
});

describe('A 组：2 个 list 端点 URL 逐字钉死', () => {
  it('A1：对账列表 = /outsource-companies/{id}/sent-parts（companyId 走 encodeURIComponent）', async () => {
    expect(await fetchedPath(() => listCompanySentParts(COMPANY))).toBe(
      `/outsource-companies/${COMPANY}/sent-parts`,
    );
  });

  it('A2：可报价零件 = /outsource-quotes/quotable-parts', async () => {
    expect(await fetchedPath(() => listQuotableParts())).toBe('/outsource-quotes/quotable-parts');
  });

  // 2026-10-09：`/outsource-shipments/in-flight` 与 `/outsource-sendable` 两个 helper
  // 随外协看板（`/outsource-queue/*` 三件套）取代「可发送 / 待接收」双表格页一并删除
  // （后端已硬切）。这里留一条**存在性反断言**：模块上不得再有这两个导出 —— 留着会让
  // 后来人以为还能调，而它们的出参 VO（`OutsourceInFlightItem` /
  // `OutsourceSendableItem`）与看板的 `OutsourceQueueHeldBatch` /
  // `OutsourceQueueCandidate` 完全不同构。
  it('A3：已下线的两个 list helper 不再是本模块的导出（外协看板取代双表格页）', async () => {
    const mod = (await import('../outsource')) as Record<string, unknown>;
    expect(mod.listOutsourceInFlight).toBeUndefined();
    expect(mod.listOutsourceSendable).toBeUndefined();
  });

  it('A4：分页参数照传（limit / offset 进 query）', async () => {
    httpGetMock.mockReset();
    httpGetMock.mockResolvedValue({ data: { items: [], total: 0, limit: 20, offset: 40 } });
    await listCompanySentParts(COMPANY, { keyword: 'k', limit: 20, offset: 40 });
    const [, cfg] = httpGetMock.mock.calls[0] as [string, { params: Record<string, unknown> }];
    expect(cfg.params).toEqual({ keyword: 'k', limit: 20, offset: 40 });
  });
});

describe('B 组：3 个写端点的 body 键契约', () => {
  it('B1：APPROVAL 行 → quote_id 有值、direct 为 null', async () => {
    // payload 形态与 useOutsourceSendableList::buildSendPayload 的 APPROVAL 分支一致
    // （那里恒显式写 direct: null；api 层是纯透传，不注入也不改名）。
    const { path, body } = await posted(() =>
      sendToOutsource('B1', {
        outsource_company_id: 'C1',
        process_id: 'P1',
        version: 7,
        quote_id: 'Q1',
        direct: null,
        quantity: null,
      }),
    );
    expect(path).toBe('/prod/batches/B1/send-to-outsource');
    expect(body.process_id).toBe('P1');
    expect(body).not.toHaveProperty('next_process_id');
    expect(body.quote_id).toBe('Q1');
    expect(body.direct).toBeNull();
  });

  // api 层是纯透传：调用方漏传的键不会被补上（后端要求 quote_id / direct 必传其一，
  // 两者都不传返 400）。这条锁住「api 层不会偷偷兜一个默认 direct / quote_id」——
  // 那种兜底会把 DIRECT 行的语义弄丢。
  it('B1b：api 层纯透传，漏传的键不补默认', async () => {
    const { body } = await posted(() =>
      sendToOutsource('B1', {
        outsource_company_id: 'C1',
        process_id: 'P1',
        version: 7,
        quote_id: 'Q1',
      }),
    );
    expect(body).not.toHaveProperty('direct');
    expect(body).not.toHaveProperty('quantity');
    expect(Object.keys(body).sort()).toEqual([
      'outsource_company_id',
      'process_id',
      'quote_id',
      'version',
    ]);
  });

  it('B2：DIRECT 行 → direct: true、quote_id 为 null', async () => {
    const { body } = await posted(() =>
      sendToOutsource('B2', {
        outsource_company_id: 'C1',
        process_id: 'P1',
        version: 7,
        quote_id: null,
        direct: true,
      }),
    );
    expect(body.direct).toBe(true);
    expect(body.quote_id).toBeNull();
  });

  // 后端要求 quote_id / direct 必传其一，两者都不传返 400。前端两条路径都由
  // buildSendPayload 统一组装，这条断言锁的是「组装函数不会退化」。
  it('B3：quantity 语义 —— 部分发送带值、整批为 null', async () => {
    const partial = await posted(() =>
      sendToOutsource('B3', {
        outsource_company_id: 'C',
        process_id: 'P',
        version: 1,
        quote_id: 'Q',
        quantity: 2,
      }),
    );
    expect(partial.body.quantity).toBe(2);

    const whole = await posted(() =>
      sendToOutsource('B3', {
        outsource_company_id: 'C',
        process_id: 'P',
        version: 1,
        quote_id: 'Q',
        quantity: null,
      }),
    );
    expect(whole.body.quantity).toBeNull();
  });

  // 部分接收：键名仍是 next_process_id（后端没跟着 send 改），且 quantity 现在真被认。
  it('B4：receive-from-outsource 键名未改 + quantity 透传', async () => {
    const { path, body } = await posted(() =>
      receiveFromOutsource('B4', {
        shelf_id: 'S',
        next_process_id: 'P',
        version: 3,
        quantity: 5,
      }),
    );
    expect(path).toBe('/prod/batches/B4/receive-from-outsource');
    expect(body.next_process_id).toBe('P');
    expect(body).not.toHaveProperty('process_id');
    expect(body.quantity).toBe(5);
  });
});

// ============================================================
// E 组：schema 守门有效性回归锁。
//
// ⚠️ Zod 默认 `z.object()` 是 **strip** 模式：schema 里没声明的字段会被**静默丢弃**、
// parse 不报错 —— 守门形同虚设。所以每条 item schema 都必须
// 「一份合法 fixture parse 通过」+「缺必填字段 / 类型错时 parse 抛错」双向锁死。
//
// 下面 4 份 fixture 是各后端 VO 的**完整字段集**（sent-parts 18 / quotable 14 /
// in-flight 15 / sendable 23，合计 70 字段），逐字照抄 VO 结构。
// 「fixture 写全」本身不构成守卫 —— 多出来的键会被 strip 静默吞掉、parse 不报错；
// 真正把「schema 声明的字段集 == fixture 字段集」钉死的是 E7 的键集断言。
// 漏声明字段的「缺必填应抛错」用例只抽了每个 schema 的代表字段，覆盖面靠 E7。
// ============================================================

const sentPartFixture = {
  shipment_id: 'S1',
  version: 3,
  quote_id: 'Q1',
  part_id: 'P1',
  part_drawing_no: 'DWG-1',
  part_name: '零件甲',
  customer_path: 'L1/L2',
  batch_no: 2,
  process_id: 'PR1',
  process_name: '外协工序',
  quantity: 10,
  unit_price: '12.50',
  total_price: '125.00',
  sent_at: '2026-10-01T08:00:00',
  received_at: null,
  status: 'OUTSOURCING',
  is_billed: false,
  is_urgent: true,
};

const quotablePartFixture = {
  id: 'P1',
  serial_no: 'SN-1',
  drawing_no: 'DWG-1',
  name: '零件甲',
  is_urgent: false,
  unit_price: '100.00',
  customer_id: 'CU1',
  customer_name: '二级客户',
  l1_customer_name: '一级客户',
  customer_path: '一级客户/二级客户',
};

/** 从 fixture 浅拷并删掉一个键。 */
function omit<T extends object>(obj: T, key: keyof T): Omit<T, keyof T> {
  const { [key]: _dropped, ...rest } = obj;
  void _dropped;
  return rest as Omit<T, keyof T>;
}

describe('E 组：2 个 item schema 的守门有效性', () => {
  it('E1：合法 fixture 全部 parse 通过（items/total/limit/offset 信封）', () => {
    expect(
      outsourceSentPartListResultSchema.parse({
        items: [sentPartFixture],
        total: 1,
        limit: 50,
        offset: 0,
      }).items[0]!.total_price,
    ).toBe('125.00');
    expect(
      outsourceQuotablePartListResultSchema.parse({
        items: [quotablePartFixture],
        total: 1,
        limit: 500,
        offset: 0,
      }).items[0]!.customer_path,
    ).toBe('一级客户/二级客户');
  });

  // 逐条锁「漏声明 ⇒ 静默 strip」这个坑：每个 schema 抽 2 个代表性必填字段
  // （含新加的 total_price / is_urgent / quote_id / customer_id）。
  it('E2：缺必填字段 → parse 抛错（不会静默放过）', () => {
    expect(() =>
      outsourceSentPartListResultSchema.parse({
        items: [omit(sentPartFixture, 'total_price')],
        total: 1,
        limit: 50,
        offset: 0,
      }),
    ).toThrow();
    expect(() =>
      outsourceSentPartListResultSchema.parse({
        items: [omit(sentPartFixture, 'is_urgent')],
        total: 1,
        limit: 50,
        offset: 0,
      }),
    ).toThrow();
    expect(() =>
      outsourceQuotablePartListResultSchema.parse({
        items: [omit(quotablePartFixture, 'customer_id')],
        total: 1,
        limit: 50,
        offset: 0,
      }),
    ).toThrow();
  });

  it('E3：字段类型错 → parse 抛错（雪花 id 必须是 string，Decimal 必须是 string）', () => {
    // Decimal 退化成 number
    expect(() =>
      outsourceSentPartListResultSchema.parse({
        items: [{ ...sentPartFixture, unit_price: 12.5 }],
        total: 1,
        limit: 50,
        offset: 0,
      }),
    ).toThrow();
  });

  it('E4：枚举字段锁死（shipment status）', () => {
    expect(() =>
      outsourceSentPartListResultSchema.parse({
        items: [{ ...sentPartFixture, status: 'SHIPPED' }],
        total: 1,
        limit: 50,
        offset: 0,
      }),
    ).toThrow();
  });

  // 对账页会出现「已取消」的 shipment（DB CHECK 约束
  // ck_t_outsource_shipment_status 允许 OUTSOURCING / RECEIVED / CANCELLED 三值，
  // 后端 VO 只是声明成 String）。这条锁住 CANCELLED 不被守门打掉 —— 少一个值
  // 就等于「有已取消发货记录的公司整页对账表 parse 失败」。
  it('E4b：shipment status 三个合法值（含 CANCELLED）都 parse 通过', () => {
    for (const status of ['OUTSOURCING', 'RECEIVED', 'CANCELLED'] as const) {
      expect(
        outsourceSentPartListResultSchema.parse({
          items: [{ ...sentPartFixture, status }],
          total: 1,
          limit: 50,
          offset: 0,
        }).items[0]!.status,
      ).toBe(status);
    }
  });

  it('E6：top-level 裸数组 → parse 抛错（防「信封退化成数组」的历史形态复发）', () => {
    // 这正是故障 ③ 的形态：把分页信封当数组用。守门必须在 API 边界就拒绝。
    expect(() => outsourceQuotablePartListResultSchema.parse([quotablePartFixture])).toThrow();
  });

  // 「fixture 写全」本身不构成守卫：Zod strip 会把 schema 没声明的键静默吞掉，
  // parse 照过不误 —— 漏声明一个字段，除了多出来的那个键消失，没有任何症状。
  // 这条把「schema 声明的字段集 == 后端 VO 字段集」变成可执行断言：
  //   · schema 少声明 → parse 结果少键 → 与 fixture 键集不等 → 红
  //   · schema 多声明一个**必填**字段 → 输入缺该键即 parse 抛错，键集断言也红
  //   · schema 多声明一个 **optional** 字段 → 键集断言**看不见**（Zod 对输入中缺省的
  //     optional 键不写入输出，parse 结果与 fixture 键集仍相等）。该失败模式本身无害
  //     —— 多一个 optional 声明不会误拒任何响应，也不会有字段被静默吞掉。
  // 28 个字段（18 + 10）一次性锁住。
  it('E7：parse 后的行键集与后端 VO 字段集逐字段相等（少声明 / 多声明必填字段都红）', () => {
    const cases = [
      {
        name: 'sent-parts（18 字段）',
        schema: outsourceSentPartListResultSchema,
        fixture: sentPartFixture,
        vo: 18,
      },
      {
        name: 'quotable（10 字段）',
        schema: outsourceQuotablePartListResultSchema,
        fixture: quotablePartFixture,
        vo: 10,
      },
    ];
    for (const { name, schema, fixture, vo } of cases) {
      const parsed = schema.parse({ items: [fixture], total: 1, limit: 50, offset: 0 }).items[0]!;
      // 键数与 fixture 注释里声明的 VO 字段数一致（fixture 自身漂移也会红）。
      expect(Object.keys(fixture).length, `${name} fixture 字段数`).toBe(vo);
      expect(Object.keys(parsed).sort(), `${name} 键集`).toEqual(Object.keys(fixture).sort());
    }
  });
});

// ============================================================
// F 组：守门**挂在 API 边界** —— 从 api helper 走进去，喂坏响应，期待 reject。
//
// 为什么必须走 helper 而不是直接测 schema：E 组全是在隔离环境里 import 真 schema
// 直接 parse，锁的是「schema 自身行为」；它证明不了 `.parse()` 真的接在
// `listCompanySentParts` 的返回路径上。把 helper 里的 `.parse()` 整段删掉
// （只留 `normalizeListResult(...)`）时 E 组仍全绿 —— 守门被拆掉而测试无感。
// F 组每条都从 helper 进、期待 rejected promise，把「守门在 API 边界」钉成可执行断言。
//
// 坏响应取两种最有代表性的形态：
//   ① 裸数组（把分页信封当数组用的历史形态）
//   ② 信封在但行是空对象（后端 VO 换字段 / 字段名漂移的形态）
//
// ⚠️ 覆盖边界：F 组锁的是「schema 挂上了没」。`normalizeListResult` 的 i64 → number
// 强转**在覆盖范围外** —— 它在本文件被 `@/api/http` 的整模块 mock 桩成恒等函数，
// 把 2 个 helper 里的 `normalizeListResult(...)` 包装整个删掉，F 组仍全绿。该 helper
// 是全仓共享的、有独立的测试缺口；且删掉后是「响亮失败」（schema 的 `total: z.number()`
// 会拒收字符串 total 抛 ZodError），不会退化成静默空白，故不纳入本组。
// ============================================================

/** 让下一次读请求返回指定的响应体。 */
function respondWith(data: unknown): void {
  httpGetMock.mockReset();
  httpGetMock.mockResolvedValue({ data });
}

describe('F 组：2 个 list helper 真的在 API 边界 reject 坏响应', () => {
  it('F1：裸数组响应 → 2 个 helper 全部 reject（不把数组当信封吐出去）', async () => {
    respondWith([quotablePartFixture]);
    await expect(listQuotableParts()).rejects.toThrow();
    respondWith([sentPartFixture]);
    await expect(listCompanySentParts(COMPANY)).rejects.toThrow();
  });

  it('F2：信封在但行是空对象 → 2 个 helper 全部 reject（漏声明字段不会被静默放过）', async () => {
    respondWith({ items: [{}], total: 1, limit: 50, offset: 0 });
    await expect(listQuotableParts()).rejects.toThrow();
    await expect(listCompanySentParts(COMPANY)).rejects.toThrow();
  });

  // 正向对照：合法信封必须**放行**。没有这条，F 组可能整体因为桩坏掉而恒绿。
  it('F3：合法分页信封 → 2 个 helper 全部 resolve 且透传 items/total', async () => {
    respondWith({ items: [quotablePartFixture], total: 1, limit: 500, offset: 0 });
    await expect(listQuotableParts()).resolves.toMatchObject({ total: 1 });
    respondWith({ items: [sentPartFixture], total: 1, limit: 50, offset: 0 });
    await expect(listCompanySentParts(COMPANY)).resolves.toMatchObject({ total: 1 });
  });
});
