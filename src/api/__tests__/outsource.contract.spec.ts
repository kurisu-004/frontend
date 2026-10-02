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
  outsourceInFlightListResultSchema,
  outsourceQuotablePartListResultSchema,
  outsourceSendableListResultSchema,
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

import {
  listCompanySentParts,
  listOutsourceInFlight,
  listOutsourceSendable,
  listQuotableParts,
} from '../outsource';
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

describe('A 组：4 个 list 端点 URL 逐字钉死', () => {
  it('A1：对账列表 = /outsource-companies/{id}/sent-parts（companyId 走 encodeURIComponent）', async () => {
    expect(await fetchedPath(() => listCompanySentParts(COMPANY))).toBe(
      `/outsource-companies/${COMPANY}/sent-parts`,
    );
  });

  it('A2：可报价零件 = /outsource-quotes/quotable-parts', async () => {
    expect(await fetchedPath(() => listQuotableParts())).toBe('/outsource-quotes/quotable-parts');
  });

  // ⚠️ 故障 ③ 的直接修复点：URL 已从 part 域迁到 outsource 域。
  // 旧路径 `/parts/outsource-in-flight` 的 handler 返的是通用零件列表 PartListItem，
  // 与前端要的外协专用 VO 完全不同构 —— 写回去就等于把「两 tab 全空白」请回来。
  it('A3：待接收 = /outsource-shipments/in-flight', async () => {
    expect(await fetchedPath(() => listOutsourceInFlight())).toBe('/outsource-shipments/in-flight');
  });

  it('A4：可发送 = /outsource-sendable（且已从 @/api/parts 迁到 @/api/outsource）', async () => {
    expect(await fetchedPath(() => listOutsourceSendable())).toBe('/outsource-sendable');
  });

  it('A5：反断言 —— 已下线的两条旧 URL 不得复活', async () => {
    expect(await fetchedPath(() => listOutsourceInFlight())).not.toContain('/parts/');
    expect(await fetchedPath(() => listOutsourceSendable())).not.toContain('/parts/');
    // 引号级别的硬钉：谁把字面量改回去，这里直接红。
    expect(await fetchedPath(() => listOutsourceInFlight())).not.toBe('/parts/outsource-in-flight');
    expect(await fetchedPath(() => listOutsourceSendable())).not.toBe('/parts/outsource-sendable');
  });

  it('A6：分页参数照传（limit / offset 进 query）', async () => {
    httpGetMock.mockReset();
    httpGetMock.mockResolvedValue({ data: { items: [], total: 0, limit: 20, offset: 40 } });
    await listOutsourceInFlight({ keyword: 'k', limit: 20, offset: 40 });
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
// parse 不报错 —— 守门形同虚设（CLAUDE.md §M-4）。所以每条 item schema 都必须
// 「一份合法 fixture parse 通过」+「缺必填字段 / 类型错时 parse 抛错」双向锁死。
// 下面 4 份 fixture 是各后端 VO 的完整字段集，**故意写全**：少写一个字段，
// 对应的「缺必填字段应抛错」用例就会红。
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
  shelf_id: 'SH1',
  shelf_code: 'C2',
  next_process_id: 'PR1',
  next_process_name: '外协工序',
};

const inFlightFixture = {
  part_id: 'P1',
  batch_id: 'BA1',
  batch_no: 1,
  quantity: 8,
  serial_no: 'SN-1',
  drawing_no: 'DWG-1',
  name: '零件甲',
  is_urgent: true,
  customer_path: '一级客户/二级客户',
  next_process_id: 'PR1',
  next_process_name: '外协工序',
  outsource_company_id: 'C1',
  outsource_company_name: '外协厂',
  sent_at: '2026-10-01T08:00:00',
  version: 4,
};

const sendableFixture = {
  version: 2,
  send_mode: 'APPROVAL',
  source_status: 'IN_PROCESS',
  part_id: 'P1',
  part_serial_no: 'SN-1',
  part_drawing_no: 'DWG-1',
  part_name: '零件甲',
  quantity: 10,
  batch_id: 'BA1',
  batch_no: 1,
  batch_quantity: 10,
  planned_delivery_date: '2026-10-20',
  is_urgent: false,
  customer_path: '一级客户/二级客户',
  next_process_id: 'PR1',
  next_process_name: '外协工序',
  shelf_code: 'C2',
  outsource_company_id: 'C1',
  outsource_company_name: '外协厂',
  company_options: [],
  price: '30.00',
  quote_id: 'Q1',
  status_label: 'sendable',
};

/** 从 fixture 浅拷并删掉一个键。 */
function omit<T extends object>(obj: T, key: keyof T): Omit<T, keyof T> {
  const { [key]: _dropped, ...rest } = obj;
  void _dropped;
  return rest as Omit<T, keyof T>;
}

describe('E 组：4 个 item schema 的守门有效性', () => {
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
      }).items[0]!.next_process_id,
    ).toBe('PR1');
    expect(
      outsourceInFlightListResultSchema.parse({
        items: [inFlightFixture],
        total: 1,
        limit: 20,
        offset: 0,
      }).items[0]!.version,
    ).toBe(4);
    expect(
      outsourceSendableListResultSchema.parse({
        items: [sendableFixture],
        total: 1,
        limit: 20,
        offset: 0,
      }).items[0]!.quote_id,
    ).toBe('Q1');
  });

  // 逐条锁「漏声明 ⇒ 静默 strip」这个坑：每个 schema 抽 2 个代表性必填字段
  // （含新加的 total_price / is_urgent / quote_id / next_process_id）。
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
        items: [omit(quotablePartFixture, 'next_process_id')],
        total: 1,
        limit: 50,
        offset: 0,
      }),
    ).toThrow();
    expect(() =>
      outsourceInFlightListResultSchema.parse({
        items: [omit(inFlightFixture, 'sent_at')],
        total: 1,
        limit: 50,
        offset: 0,
      }),
    ).toThrow();
    expect(() =>
      outsourceSendableListResultSchema.parse({
        items: [omit(sendableFixture, 'quote_id')],
        total: 1,
        limit: 50,
        offset: 0,
      }),
    ).toThrow();
  });

  it('E3：字段类型错 → parse 抛错（雪花 id 必须是 string，Decimal 必须是 string）', () => {
    // 雪花 id 退化成 number（后端某天漏了 serialize_i64）必须被抓出来，不能 coerce 掩盖。
    expect(() =>
      outsourceInFlightListResultSchema.parse({
        items: [{ ...inFlightFixture, batch_id: 123 }],
        total: 1,
        limit: 50,
        offset: 0,
      }),
    ).toThrow();
    // Decimal 退化成 number
    expect(() =>
      outsourceSentPartListResultSchema.parse({
        items: [{ ...sentPartFixture, unit_price: 12.5 }],
        total: 1,
        limit: 50,
        offset: 0,
      }),
    ).toThrow();
    // is_urgent 退化成字符串
    expect(() =>
      outsourceSendableListResultSchema.parse({
        items: [{ ...sendableFixture, is_urgent: 'true' }],
        total: 1,
        limit: 50,
        offset: 0,
      }),
    ).toThrow();
  });

  it('E4：枚举字段锁死（send_mode / source_status / status_label / shipment status）', () => {
    expect(() =>
      outsourceSendableListResultSchema.parse({
        items: [{ ...sendableFixture, send_mode: 'AUTO' }],
        total: 1,
        limit: 50,
        offset: 0,
      }),
    ).toThrow();
    expect(() =>
      outsourceSendableListResultSchema.parse({
        items: [{ ...sendableFixture, status_label: 'pending' }],
        total: 1,
        limit: 50,
        offset: 0,
      }),
    ).toThrow();
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

  // DIRECT 行：company_options 有值、quote_id 为 null、price 为 null。
  // 这条锁的是「DIRECT 模式真的能 parse」—— 旧 VO 没有 quote_id，DIRECT 行的
  // 三个 null 字段组合是最容易在 schema 里写歪的地方。
  it('E5：DIRECT 行 fixture parse 通过（company_options 有值、quote_id / price 为 null）', () => {
    const direct = {
      ...sendableFixture,
      send_mode: 'DIRECT',
      source_status: 'PENDING',
      outsource_company_id: null,
      company_options: [{ id: 'C1', name: '外协厂' }],
      price: null,
      quote_id: null,
    };
    const parsed = outsourceSendableListResultSchema.parse({
      items: [direct],
      total: 1,
      limit: 50,
      offset: 0,
    });
    expect(parsed.items[0]!.company_options).toEqual([{ id: 'C1', name: '外协厂' }]);
    expect(parsed.items[0]!.quote_id).toBeNull();
  });

  it('E6：top-level 裸数组 → parse 抛错（防「信封退化成数组」的历史形态复发）', () => {
    // 这正是故障 ③ 的形态：把分页信封当数组用。守门必须在 API 边界就拒绝。
    expect(() => outsourceInFlightListResultSchema.parse([inFlightFixture])).toThrow();
    expect(() => outsourceQuotablePartListResultSchema.parse([quotablePartFixture])).toThrow();
  });
});
