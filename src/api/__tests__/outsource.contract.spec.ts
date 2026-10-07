// src/api/__tests__/outsource.contract.spec.ts
//
// 外协域的**逐条 URL + body 契约守卫**。
//
// 为什么必须有这个文件（3 个线上故障的共同根因）：
//   外协域此前是全仓少数**没有 Zod 守门、也没有任何 URL 断言**的模块 —— api helper
//   把 `api.get` 的结果原样喂给 el-table，形状不符时收不到数组就**静默空白**而不是报错。
//   三个故障因此都能悄悄上线：
//     ① `GET /outsource-companies/{id}/sent-parts` 路由没注册 ⇒ 对账页 404；
//     ② `GET /outsource-quotes/quotable-parts` 后端无此路由，请求被 quote_router 的
//        `/{id}`（`Path<i64>`）吞成 400 ⇒ 报价页每次进都报错 + picker 恒空；
//     ③ `GET /parts/outsource-in-flight` / `/outsource-sendable` 后端存在但返的是
//        通用零件列表 `PartListItem` ⇒ 收发两 tab 全空白。
//   2026-10-09（第一轮）：③ 的两个端点随外协看板取代那对表格页而删除，A3 留了一条
//   存在性反断言钉住「不得复活」。
//   2026-10-09（第二轮契约收敛，18 端点）：D 组钉住本轮的**必填 version** 与
//   **已删除端点的存在性反断言**，E 组钉住两个已删字段与一个收窄枚举。
//   契约必须在前端侧被逐字钉死，不能靠「后端自测 + 类型系统」兜底。
//
// 本文件负责「路径与形态」。守门有效性（漏声明字段会被 strip）由
// `views/outsource/composables/__tests__/outsourceListSchema.spec.ts` 保证 —— 对账列表
// 的守门已随主查询迁到 queryFn（域 schema），api 层不再 parse。
//
// mock 手法沿 src/api/parts/__tests__/routes.spec.ts 同款：整模块桩掉 `@/api/http`
// （不 importOriginal），只留可断言的 api.get / api.post 入口。
//
// ⚠️ 这里**刻意不桩掉** `@/composables/queries/schemas`（与 routes.spec.ts 不同）：
// `listQuotableParts` 的响应是合法空信封，真 schema 能 parse 通过，于是同一个文件里
// 可以直接 import **真 schema** 验证守门本身 —— 桩掉它会让「parse 抛错」这批断言
// 全部变成空断言（对着 no-op 桩 parse 永远不抛）。`listQuotableParts` 是本域**唯一**
// 守门留在 api 层的 helper：它由 shell 的 `loadLookups()` 裸调，没有 queryFn 承载。

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { outsourceQuotablePartListResultSchema } from '@/composables/queries/schemas';
import { outsourceSentPartListResultSchema } from '@/views/outsource/composables/outsourceListSchema';

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

import {
  approveOutsourceQuote,
  createOutsourceCompany,
  getOutsourceCompany,
  listCompaniesByProcess,
  listCompanySentParts,
  listOutsourceCompanies,
  listOutsourceQuotes,
  listQuotableParts,
  rejectOutsourceQuote,
  softDeleteOutsourceCompany,
  softDeleteOutsourceQuote,
  submitOutsourceQuote,
  updateOutsourceCompany,
} from '../outsource';
import { receiveFromOutsource, sendToOutsource } from '@/api/parts';

const COMPANY = '190000000000900';

/** 打一次读请求并返回实际使用的 URL。 */
async function fetchedPath(run: () => Promise<unknown>): Promise<string> {
  httpGetMock.mockReset();
  httpGetMock.mockResolvedValue({
    data: {
      outsource_company_id: COMPANY,
      outsource_company_name: null,
      items: [],
      total: 0,
      limit: 50,
      offset: 0,
    },
  });
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

/** 取一次读请求实际发出的 query 参数。 */
async function fetchedParams(run: () => Promise<unknown>): Promise<Record<string, unknown>> {
  httpGetMock.mockReset();
  httpGetMock.mockResolvedValue({
    data: {
      outsource_company_id: COMPANY,
      outsource_company_name: null,
      items: [],
      total: 0,
      limit: 50,
      offset: 0,
    },
  });
  await run();
  const [, cfg] = httpGetMock.mock.calls[0] as [string, { params: Record<string, unknown> }];
  return cfg.params;
}

beforeEach(() => {
  httpGetMock.mockReset();
  httpPostMock.mockReset();
});

describe('A 组：list 端点 URL 逐字钉死', () => {
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
    expect(
      await fetchedParams(() => listCompanySentParts(COMPANY, { limit: 20, offset: 40 })),
    ).toEqual({ limit: 20, offset: 40 });
  });

  it('A5：其余三个 list 端点 URL', async () => {
    expect(await fetchedPath(() => listOutsourceCompanies())).toBe('/outsource-companies');
    expect(await fetchedPath(() => getOutsourceCompany(COMPANY))).toBe(
      `/outsource-companies/${COMPANY}`,
    );
    expect(await fetchedPath(() => listCompaniesByProcess('PR1'))).toBe(
      '/outsource-companies/by-process/PR1',
    );
    expect(await fetchedPath(() => listOutsourceQuotes())).toBe('/outsource-quotes');
  });
});

describe('B 组：prod/batches 外协收发端点的 body 键契约', () => {
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
// D 组（2026-10-09 第二轮契约收敛）：三条写端点的**必填 version** +
// 已删除端点的存在性反断言 + 入参形状变更。
//
// 为什么必须钉 version：三条端点（公司 soft-delete / 报价 submit / 报价 soft-delete）
// 此前**没有 body**，service 内部自读 version 再喂给 `UPDATE … WHERE version = ?`
// —— 恒命中 0 行也察觉不到，乐观锁形同虚设。后端本轮把 version 收成必填（缺省是
// axum 的 HTTP 422 **纯文本**，不是业务信封），前端漏传就恒失败。
//
// 其中「公司 update 漏传 version」是一个**已确认的线上缺陷**：OutsourceList.vue 的
// onSave 一直没传 version，此前后端也不要求，所以没人发现；后端收成必填后它会恒 422。
// D4 专门用「body 必须含 version」把这条钉死，防复发。
// ============================================================

describe('D 组：必填 version 与已删端点的存在性反断言', () => {
  // ⭐ 本次修掉的线上缺陷：update 的 body 必须带 version。
  it('D4：updateOutsourceCompany 的 body 必含 version（OCC 锚，缺省 = 后端 422）', async () => {
    const { path, body } = await posted(() =>
      updateOutsourceCompany(COMPANY, {
        version: 7,
        name: '福州精工外协',
        is_active: true,
      }),
    );
    expect(path).toBe(`/outsource-companies/${COMPANY}/update`);
    expect(body.version).toBe(7);
    expect(Object.keys(body)).toContain('version');
  });

  it('D1：公司 soft-delete 的 body 必含 version', async () => {
    const { path, body } = await posted(() =>
      softDeleteOutsourceCompany(COMPANY, { version: 3 }),
    );
    expect(path).toBe(`/outsource-companies/${COMPANY}/soft-delete`);
    expect(body).toEqual({ version: 3 });
  });

  it('D2：报价 submit 的 body 必含 version', async () => {
    const { path, body } = await posted(() => submitOutsourceQuote('Q1', { version: 5 }));
    expect(path).toBe('/outsource-quotes/Q1/submit');
    expect(body).toEqual({ version: 5 });
  });

  it('D3：报价 soft-delete 的 body 必含 version', async () => {
    const { path, body } = await posted(() => softDeleteOutsourceQuote('Q1', { version: 5 }));
    expect(path).toBe('/outsource-quotes/Q1/soft-delete');
    expect(body).toEqual({ version: 5 });
  });

  // approve / reject 本来就传 version，保持即可（回归锁）。
  it('D5：approve / reject 的 version 照传（本就必填，本轮不变）', async () => {
    const approve = await posted(() =>
      approveOutsourceQuote('Q1', { version: 2, review_note: '价格可谈' }),
    );
    expect(approve.path).toBe('/outsource-quotes/Q1/approve');
    expect(approve.body.version).toBe(2);

    const reject = await posted(() =>
      rejectOutsourceQuote('Q1', { version: 2, review_note: '单价太高' }),
    );
    expect(reject.path).toBe('/outsource-quotes/Q1/reject');
    expect(reject.body.version).toBe(2);
  });

  // 工序能力清单的「整体替换」已吸收进 update 的 process_ids（端点硬切删除）。
  it('D6：POST /{id}/processes 端点已删除 —— 模块上不得再有对应 helper', async () => {
    const mod = (await import('../outsource')) as Record<string, unknown>;
    expect(mod.setOutsourceCompanyProcesses).toBeUndefined();
  });

  // 报价的 GET /{id} 与 POST /{id}/update 后端硬切删除（前端零消费）。
  it('D7：GET /{id} 与 POST /{id}/update 已删除 —— 两个 helper 不再是导出', async () => {
    const mod = (await import('../outsource')) as Record<string, unknown>;
    expect(mod.getOutsourceQuote).toBeUndefined();
    expect(mod.updateOutsourceQuote).toBeUndefined();
  });

  // create 的出参已改 R<()>（前端建完一律重拉列表）。
  it('D8：createOutsourceCompany 只发一次 POST /outsource-companies（出参 R<()>）', async () => {
    const { path, body } = await posted(() =>
      createOutsourceCompany({ name: '福州精工外协', process_ids: ['PR1'] }),
    );
    expect(path).toBe('/outsource-companies');
    expect(body).toMatchObject({ name: '福州精工外协', process_ids: ['PR1'] });
  });

  // keyword 被拆成 drawing_no / name，并新增 customer_id / process_id / is_billed。
  it('D9：对账列表入参照传新维度（无 keyword）', async () => {
    expect(
      await fetchedParams(() =>
        listCompanySentParts(COMPANY, {
          drawing_no: 'DWG',
          name: '连杆',
          customer_id: 'CU1',
          process_id: 'PR1',
          is_billed: false,
        }),
      ),
    ).toEqual({ drawing_no: 'DWG', name: '连杆', customer_id: 'CU1', process_id: 'PR1', is_billed: false });
  });

  // 报价列表：statuses 数组照传（序列化成 CSV 单值由 http 层的 ARRAY_AS_CSV_KEYS 负责），
  // keyword 已删、新增 drawing_no / name / is_urgent。
  it('D10：报价列表入参照传 statuses 数组 + 新增维度（无 keyword）', async () => {
    expect(
      await fetchedParams(() =>
        listOutsourceQuotes({
          statuses: ['DRAFT', 'SUBMITTED'],
          drawing_no: 'DWG',
          name: '连杆',
          is_urgent: true,
          outsource_company_id: COMPANY,
        }),
      ),
    ).toEqual({
      statuses: ['DRAFT', 'SUBMITTED'],
      drawing_no: 'DWG',
      name: '连杆',
      is_urgent: true,
      outsource_company_id: COMPANY,
    });
  });
});

// ============================================================
// E 组：schema 守门有效性回归锁。
//
// ⚠️ Zod 默认 `z.object()` 是 **strip** 模式：schema 里没声明的字段会被**静默丢弃**、
// parse 不报错 —— 守门形同虚设。所以每条 item schema 都必须
// 「一份合法 fixture parse 通过」+「缺必填字段 / 类型错时 parse 抛错」双向锁死。
//
// 下面两份 fixture 是各后端 VO 的**完整字段集**（sent-parts 行 16 + quotable 10，
// 合计 26 字段），逐字照抄 VO 结构。「fixture 写全」本身不构成守卫 —— 多出来的键会被
// strip 静默吞掉、parse 不报错；真正把「schema 声明的字段集 == fixture 字段集」钉死的
// 是键集断言（与 `views/outsource/composables/__tests__/outsourceListSchema.spec.ts`
// 里的逐字段断言同款职责，两边各自守自己的 schema）。
// ============================================================

/** `OutsourceSentPartOut` 全字段（16）。2026-10-09 删 quote_id / part_id。 */
const sentPartFixture = {
  shipment_id: 'S1',
  version: 3,
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

/** `OutsourceSentPartListOut` 全字段（6）。 */
const sentPartEnvelopeFixture = {
  outsource_company_id: '190000000000900',
  outsource_company_name: '福州精工外协',
  items: [sentPartFixture],
  total: 1,
  limit: 50,
  offset: 0,
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

describe('E 组：item schema 的守门有效性', () => {
  it('E1：合法 fixture 全部 parse 通过（对账信封含两个公司字段）', () => {
    expect(
      outsourceSentPartListResultSchema.parse(sentPartEnvelopeFixture).items[0]!.total_price,
    ).toBe('125.00');
    expect(
      outsourceSentPartListResultSchema.parse(sentPartEnvelopeFixture).outsource_company_name,
    ).toBe('福州精工外协');
    expect(
      outsourceQuotablePartListResultSchema.parse({
        items: [quotablePartFixture],
        total: 1,
        limit: 500,
        offset: 0,
      }).items[0]!.customer_path,
    ).toBe('一级客户/二级客户');
  });

  // 公司不存在 / 已软删时 `outsource_company_name` 是 null（端点不 404）——必须是
  // 可解析的形态，而不是被 `.nullable()` 漏声明当成缺字段。
  it('E1b：公司缺失时 outsource_company_name = null 仍 parse 通过', () => {
    const parsed = outsourceSentPartListResultSchema.parse({
      ...sentPartEnvelopeFixture,
      outsource_company_name: null,
    });
    expect(parsed.outsource_company_name).toBeNull();
  });

  // 逐条锁「漏声明 ⇒ 静默 strip」这个坑：每个 schema 抽 2 个代表性必填字段。
  it('E2：缺必填字段 → parse 抛错（不会静默放过）', () => {
    expect(() =>
      outsourceSentPartListResultSchema.parse({
        ...sentPartEnvelopeFixture,
        items: [omit(sentPartFixture, 'total_price')],
      }),
    ).toThrow();
    expect(() =>
      outsourceSentPartListResultSchema.parse({
        ...sentPartEnvelopeFixture,
        items: [omit(sentPartFixture, 'is_urgent')],
      }),
    ).toThrow();
    expect(() =>
      outsourceSentPartListResultSchema.parse(omit(sentPartEnvelopeFixture, 'outsource_company_id')),
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
        ...sentPartEnvelopeFixture,
        items: [{ ...sentPartFixture, unit_price: 12.5 }],
      }),
    ).toThrow();
  });

  // `status` 收成两值枚举（后端 SQL 硬编码只返这两个；DB CHECK 里的第三值
  // CANCELLED 无任何代码路径写入，声明它是死代码）。
  it('E4：status 枚举锁死两个合法值，第三个值（CANCELLED）被守门拒绝', () => {
    for (const status of ['OUTSOURCING', 'RECEIVED'] as const) {
      expect(
        outsourceSentPartListResultSchema.parse({
          ...sentPartEnvelopeFixture,
          items: [{ ...sentPartFixture, status }],
        }).items[0]!.status,
      ).toBe(status);
    }
    expect(() =>
      outsourceSentPartListResultSchema.parse({
        ...sentPartEnvelopeFixture,
        items: [{ ...sentPartFixture, status: 'CANCELLED' }],
      }),
    ).toThrow();
  });

  it('E6：top-level 裸数组 → parse 抛错（防「信封退化成数组」的历史形态复发）', () => {
    // 这正是故障 ③ 的形态：把分页信封当数组用。守门必须在 API 边界就拒绝。
    expect(() => outsourceQuotablePartListResultSchema.parse([quotablePartFixture])).toThrow();
    expect(() => outsourceSentPartListResultSchema.parse([sentPartFixture])).toThrow();
  });

  // 「fixture 写全」本身不构成守卫：Zod strip 会把 schema 没声明的键静默吞掉，
  // parse 照过不误 —— 漏声明一个字段，除了多出来的那个键消失，没有任何症状。
  // 这条把「schema 声明的字段集 == 后端 VO 字段集」变成可执行断言。
  it('E7：parse 后的行键集与后端 VO 字段集逐字段相等（少声明 / 多声明必填字段都红）', () => {
    // sent-parts 行：16 字段
    expect(Object.keys(sentPartFixture).length).toBe(16);
    expect(
      Object.keys(outsourceSentPartListResultSchema.parse(sentPartEnvelopeFixture).items[0]!).sort(),
    ).toEqual(Object.keys(sentPartFixture).sort());

    // sent-parts 信封：6 字段
    expect(Object.keys(sentPartEnvelopeFixture).length).toBe(6);
    expect(
      Object.keys(outsourceSentPartListResultSchema.parse(sentPartEnvelopeFixture)).sort(),
    ).toEqual(Object.keys(sentPartEnvelopeFixture).sort());

    // quotable：10 字段
    expect(Object.keys(quotablePartFixture).length).toBe(10);
    expect(
      Object.keys(
        outsourceQuotablePartListResultSchema.parse({
          items: [quotablePartFixture],
          total: 1,
          limit: 500,
          offset: 0,
        }).items[0]!,
      ).sort(),
    ).toEqual(Object.keys(quotablePartFixture).sort());
  });
});

// ============================================================
// F 组：守门**挂在 API 边界** —— 从 api helper 走进去，喂坏响应，期待 reject。
//
// 为什么必须走 helper 而不是直接测 schema：E 组全是在隔离环境里 import 真 schema
// 直接 parse，锁的是「schema 自身行为」；它证明不了 `.parse()` 真的接在 helper 的
// 返回路径上。把 `listQuotableParts` 里的 `.parse()` 整段删掉时 E 组仍全绿 ——
// 守门被拆掉而测试无感。
//
// ⚠️ 覆盖边界：对账列表 `listCompanySentParts` 的守门**不在** api 层（它已随主查询
// 迁到 queryFn，由 `views/outsource/composables/__tests__/
// useOutsourceSentPartsQuery.spec.ts` 守），因此本组只覆盖 `listQuotableParts`。
// `normalizeListResult` 的 i64 → number 强转也在覆盖范围外 —— 它在本文件被
// `@/api/http` 的整模块 mock 桩成恒等函数。该 helper 是全仓共享的、有独立的测试缺口；
// 且删掉后是「响亮失败」（schema 的 `total: z.number()` 会拒收字符串 total 抛 ZodError），
// 不会退化成静默空白。
// ============================================================

/** 让下一次读请求返回指定的响应体。 */
function respondWith(data: unknown): void {
  httpGetMock.mockReset();
  httpGetMock.mockResolvedValue({ data });
}

describe('F 组：listQuotableParts 真的在 API 边界 reject 坏响应', () => {
  it('F1：裸数组响应 → helper reject（不把数组当信封吐出去）', async () => {
    respondWith([quotablePartFixture]);
    await expect(listQuotableParts()).rejects.toThrow();
  });

  it('F2：信封在但行是空对象 → helper reject（漏声明字段不会被静默放过）', async () => {
    respondWith({ items: [{}], total: 1, limit: 500, offset: 0 });
    await expect(listQuotableParts()).rejects.toThrow();
  });

  // 正向对照：合法信封必须**放行**。没有这条，F 组可能整体因为桩坏掉而恒绿。
  it('F3：合法分页信封 → helper resolve 且透传 items/total', async () => {
    respondWith({ items: [quotablePartFixture], total: 1, limit: 500, offset: 0 });
    await expect(listQuotableParts()).resolves.toMatchObject({ total: 1 });
  });
});