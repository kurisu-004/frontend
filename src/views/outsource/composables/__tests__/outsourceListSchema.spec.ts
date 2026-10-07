// src/views/outsource/composables/__tests__/outsourceListSchema.spec.ts
//
// 2026-10-09 新增：外协三页域 schema 的**逐字段键集**断言。
//
// 为什么要有这个文件：Zod 默认 `z.object()` 是 **strip** 模式 —— schema 里没声明的字段
// 会被**静默丢弃**、parse 照过不报错。所以「schema 声明齐了」这件事本身不可执行，必须
// 变成断言：parse 结果的键集必须与后端 VO 字段集逐字段相等。
//   - schema 少声明 → parse 结果少键 → 键集不等 → 红；
//   - schema 多声明一个**必填**字段 → 输入缺该键即 parse 抛错；
//   - fixture 少写一个字段 → 键数断言红。
//
// 逐字段断言的另一半（类型错 / 枚举值被拒 / 可空字段确实能收 null）在
// `src/api/__tests__/outsource.contract.spec.ts` 的 E 组，本文件只管「字段齐不齐」与
// 「可空 / 必填的边界」，两份合起来把域 schema 的守门有效性钉死。

import { describe, expect, it } from 'vitest';

import {
  outsourceCompanyListResultSchema,
  outsourceCompanyOptionSchema,
  outsourceCompanyProcessLinkSchema,
  outsourceCompanySchema,
  outsourceCompanyWithProcessesSchema,
  outsourceQuoteListResultSchema,
  outsourceQuoteSchema,
  outsourceSentPartItemSchema,
  outsourceSentPartListResultSchema,
} from '../outsourceListSchema';

/** 后端 `OutsourceCompanyOut` 全字段（7）。 */
const companyFixture = {
  id: '190000000000900',
  name: '福州精工外协',
  contact_name: '张三',
  contact_phone: '0591-8888',
  address: '福州市仓山区',
  is_active: true,
  version: 3,
};

/** 后端 `OutsourceCompanyProcessLinkOut` 全字段（3）。 */
const processLinkFixture = {
  process_id: '200000000000001',
  process_code: 'PPSEND',
  process_name: '外协-切割',
};

/** 后端 `OutsourceCompanyWithProcessesOut` 全字段（8）。 */
const companyWithProcessesFixture = { ...companyFixture, processes: [processLinkFixture] };

/** 后端 `OutsourceCompanyOptionOut` 全字段（2）。 */
const companyOptionFixture = { id: '190000000000900', name: '福州精工外协' };

/** 后端 `OutsourceSentPartOut` 全字段（16）。 */
const sentPartFixture = {
  shipment_id: '800000000000001',
  version: 2,
  part_drawing_no: 'DWG-1',
  part_name: '连杆',
  customer_path: '一级/二级',
  batch_no: 7,
  process_id: '200000000000001',
  process_name: '外协-切割',
  quantity: 10,
  unit_price: '12.50',
  total_price: '125.00',
  sent_at: '2026-10-01T08:00:00',
  received_at: null,
  status: 'OUTSOURCING' as const,
  is_billed: false,
  is_urgent: true,
};

/** 后端 `OutsourceSentPartListOut` 全字段（6）。 */
const sentPartEnvelopeFixture = {
  outsource_company_id: '190000000000900',
  outsource_company_name: '福州精工外协',
  items: [sentPartFixture],
  total: 1,
  limit: 50,
  offset: 0,
};

/** 后端 `OutsourceQuoteOut` 全字段（22）。 */
const quoteFixture = {
  id: '700000000000001',
  version: 1,
  part_id: '400000000000001',
  outsource_company_id: '190000000000900',
  process_id: '200000000000001',
  price: '12.50',
  note: null,
  status: 'DRAFT',
  submitted_at: null,
  reviewed_at: null,
  review_note: null,
  created_at: '2026-10-01T08:00:00',
  updated_at: '2026-10-01T08:00:00',
  part_serial_no: 'SN-1',
  part_drawing_no: 'DWG-1',
  part_name: '连杆',
  outsource_company_name: '福州精工外协',
  process_code: 'PPSEND',
  process_name: '外协-切割',
  customer_path: '一级/二级',
  part_unit_price: '100.00',
  is_urgent: false,
};

/** 断言「parse 结果的键集 == fixture 键集」且「fixture 字段数 == 声明的字段数」。 */
function expectSameKeys(
  parsed: Record<string, unknown>,
  fixture: Record<string, unknown>,
  voFields: number,
  label: string,
): void {
  expect(Object.keys(fixture).length, `${label}：fixture 字段数`).toBe(voFields);
  expect(Object.keys(parsed).sort(), `${label}：键集`).toEqual(Object.keys(fixture).sort());
}

describe('公司域 schema（7 / 8 / 3 / 2 字段）', () => {
  it('S1：OutsourceCompanyOut 7 字段，逐字段相等', () => {
    expectSameKeys(
      outsourceCompanySchema.parse(companyFixture) as Record<string, unknown>,
      companyFixture,
      7,
      'OutsourceCompanyOut',
    );
  });

  it('S2：2026-10-09 删掉的时间字段不在键集里', () => {
    const parsed = outsourceCompanySchema.parse({
      ...companyFixture,
      created_at: '2026-10-01T08:00:00',
      updated_at: '2026-10-01T08:00:00',
    }) as Record<string, unknown>;
    // strip 会把未声明的两个键丢掉 —— 这正是「删字段」的期望结果（不是异常）。
    expect(Object.keys(parsed)).not.toContain('created_at');
    expect(Object.keys(parsed)).not.toContain('updated_at');
  });

  it('S3：工序映射 3 字段（category / sort_order 已删）', () => {
    const parsed = outsourceCompanyProcessLinkSchema.parse({
      ...processLinkFixture,
      category: 'OUTSOURCE',
      sort_order: 1,
    }) as Record<string, unknown>;
    expectSameKeys(parsed, processLinkFixture, 3, 'OutsourceCompanyProcessLinkOut');
  });

  it('S4：公司详情 8 字段', () => {
    expectSameKeys(
      outsourceCompanyWithProcessesSchema.parse(companyWithProcessesFixture) as Record<
        string,
        unknown
      >,
      companyWithProcessesFixture,
      8,
      'OutsourceCompanyWithProcessesOut',
    );
  });

  it('S5：by-process 选项 2 字段（is_active 是结构性冗余，已收窄）', () => {
    expectSameKeys(
      outsourceCompanyOptionSchema.parse({
        ...companyOptionFixture,
        is_active: true,
      }) as Record<string, unknown>,
      companyOptionFixture,
      2,
      'OutsourceCompanyOptionOut',
    );
  });

  it('S6：公司列表信封 4 字段', () => {
    const envelope = { items: [companyFixture], total: 1, limit: 100, offset: 0 };
    expectSameKeys(
      outsourceCompanyListResultSchema.parse(envelope) as Record<string, unknown>,
      envelope,
      4,
      'OutsourceCompanyListOut',
    );
  });

  it('S7：version 是必填 number（漏声明 OCC 锚 ⇒ 编辑 / 删除恒 422）', () => {
    const { version: _dropped, ...noVersion } = companyFixture;
    void _dropped;
    expect(() => outsourceCompanySchema.parse(noVersion)).toThrow();
    // 雪花 ID 退化成 number 也要拒（Number() 会丢 19 位精度）
    expect(() =>
      outsourceCompanySchema.parse({ ...companyFixture, id: 190000000000900 }),
    ).toThrow();
  });

  it('S8：可空字段确实收 null（不靠字段缺失表达「无值」）', () => {
    const parsed = outsourceCompanySchema.parse({
      ...companyFixture,
      contact_name: null,
      contact_phone: null,
      address: null,
    });
    expect(parsed.contact_name).toBeNull();
    expect(parsed.contact_phone).toBeNull();
    expect(parsed.address).toBeNull();
    // 但「字段缺失」必须被拒 —— 两种状态不能混
    const { address: _dropped, ...noAddress } = companyFixture;
    void _dropped;
    expect(() => outsourceCompanySchema.parse(noAddress)).toThrow();
  });
});

describe('对账域 schema（行 16 / 信封 6 字段）', () => {
  it('S9：sent-parts 行 16 字段，逐字段相等', () => {
    expectSameKeys(
      outsourceSentPartItemSchema.parse(sentPartFixture) as Record<string, unknown>,
      sentPartFixture,
      16,
      'OutsourceSentPartOut',
    );
  });

  it('S10：2026-10-09 删掉的 quote_id / part_id 不在键集里', () => {
    const parsed = outsourceSentPartItemSchema.parse({
      ...sentPartFixture,
      quote_id: '700000000000001',
      part_id: '400000000000001',
    }) as Record<string, unknown>;
    expect(Object.keys(parsed)).not.toContain('quote_id');
    expect(Object.keys(parsed)).not.toContain('part_id');
  });

  it('S11：信封 6 字段（含新增的两个公司字段）', () => {
    expectSameKeys(
      outsourceSentPartListResultSchema.parse(sentPartEnvelopeFixture) as Record<string, unknown>,
      sentPartEnvelopeFixture,
      6,
      'OutsourceSentPartListOut',
    );
  });

  it('S12：status 收两值枚举（DB CHECK 里的 CANCELLED 无代码路径写入，是死代码）', () => {
    expect(outsourceSentPartItemSchema.parse({ ...sentPartFixture, status: 'RECEIVED' }).status).toBe(
      'RECEIVED',
    );
    expect(() =>
      outsourceSentPartItemSchema.parse({ ...sentPartFixture, status: 'CANCELLED' }),
    ).toThrow();
  });

  it('S13：Decimal 列（unit_price / total_price）必须是 string', () => {
    expect(() =>
      outsourceSentPartItemSchema.parse({ ...sentPartFixture, unit_price: 12.5 }),
    ).toThrow();
  });

  it('S14：company_name = null 仍 parse 通过（公司不存在 / 已软删，端点不 404）', () => {
    const parsed = outsourceSentPartListResultSchema.parse({
      ...sentPartEnvelopeFixture,
      outsource_company_name: null,
    });
    expect(parsed.outsource_company_name).toBeNull();
  });
});

describe('报价域 schema（行 22 / 信封 4 字段）', () => {
  it('S15：OutsourceQuoteOut 22 字段，逐字段相等', () => {
    expectSameKeys(
      outsourceQuoteSchema.parse(quoteFixture) as Record<string, unknown>,
      quoteFixture,
      22,
      'OutsourceQuoteOut',
    );
  });

  it('S16：status 按 string 收（DB 里有 legacy 值，锁字面量会让历史行整页 parse 失败）', () => {
    for (const legacy of ['OUTSOURCING', 'RECEIVED', 'BILLED', 'USED']) {
      expect(outsourceQuoteSchema.parse({ ...quoteFixture, status: legacy }).status).toBe(legacy);
    }
  });

  it('S17：报价列表信封 4 字段', () => {
    const envelope = { items: [quoteFixture], total: 1, limit: 20, offset: 0 };
    expectSameKeys(
      outsourceQuoteListResultSchema.parse(envelope) as Record<string, unknown>,
      envelope,
      4,
      'OutsourceQuoteListOut',
    );
  });

  it('S18：展示用补全字段（process_name / part_unit_price 等）漏声明会让对应列恒空', () => {
    const { process_name: _p, part_unit_price: _u, ...slim } = quoteFixture;
    void _p;
    void _u;
    expect(() => outsourceQuoteSchema.parse(slim)).toThrow();
  });
});