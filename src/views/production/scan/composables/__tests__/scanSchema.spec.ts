// src/views/production/scan/composables/__tests__/scanSchema.spec.ts
//
// 报工台两条 list 的守门 schema 契约断言。
//
// 2026-10-10 从 `src/composables/queries/__tests__/schemas.spec.ts` 的 S-SP 组搬来
// （schema 本身同期从那个文件搬进 `scanSchema.ts`）。搬的理由与 schema 相同：它只服务
// 报工台一个域，放在跨域共用的基础数据层 spec 里既不归属，也让「域内契约的回归保护」
// 散在全仓最长的那个 spec 里找不到。
//
// api 层的 URL / query / body 契约守卫在
// `src/api/__tests__/productionScan.contract.spec.ts`；本文件只钉 schema 自身的行为。
//
import { describe, expect, it } from 'vitest';
import {
  scanPartListResultSchema,
  scanPartRowSchema,
} from '@/views/production/scan/composables/scanSchema';

// 报工台三页（取件 / 放回 / 送检）列表行 schema 契约断言。
//
// 服务对象：`GET /api/v2/prod/scan/pickable` 与 `GET /api/v2/prod/scan/held`，行 VO =
// 后端 `prod::scan` 域的 `ScanListItem`（17 字段），外层是分页信封。
describe('scanPartRowSchema / scanPartListResultSchema 契约断言', () => {
  const validScanRow = {
    id: '190000000000001',
    serial_no: 'SN-001',
    name: '零件甲',
    drawing_no: 'DWG-A001',
    quantity: 5,
    is_urgent: false,
    // 2026-10-10 起是真实投影值，不再是 1970-01-01 占位符
    planned_delivery_date: '2026-10-20',
    system_delivery_date: null,
    process_chain_id: null,
    has_process_chain: true,
    chain_state: 'NEXT',
    chain_next_process_id: '190000000000021',
    chain_next_process_name: 'CUT-01 下料',
    chain_current_process_name: 'SAW-02 锯切',
    batch_id: '190000000000009',
    batch_version: 4,
    location: null,
  };

  it('S-SP1：接受 ScanListItem 完整 17 字段（批次锚点与链四件套有值）', () => {
    const parsed = scanPartRowSchema.parse(validScanRow);
    expect(parsed.id).toBe('190000000000001');
    expect(parsed.batch_id).toBe('190000000000009');
    expect(parsed.batch_version).toBe(4);
    expect(parsed.chain_state).toBe('NEXT');
    // 2026-10-09 后端派生列：三页列表卡左边框只看它（真 / 假两态都收）
    expect(parsed.has_process_chain).toBe(true);
    expect(
      scanPartRowSchema.parse({ ...validScanRow, has_process_chain: false }).has_process_chain,
    ).toBe(false);
    // 后端刻意不返的键不在 schema 里 ⇒ parse 后不应凭空出现
    expect('next_process_id' in parsed).toBe(false);
    expect('shelf_code' in parsed).toBe(false);
    // 键集恰为 17（多一个少一个都是契约漂移）
    expect(Object.keys(validScanRow)).toHaveLength(17);
    expect(Object.keys(parsed).sort()).toEqual(Object.keys(validScanRow).sort());
  });

  // 2026-10-10：`request_date` 整键被后端删除，随之**必须**删掉
  // `planned_delivery_date` 上那个把 '1970-01-01' 归一成 null 的字段级 transform ——
  // 键不再下发后，transform 留着只会把真实日期误判成占位符。
  it('S-SP2：planned_delivery_date 是真实值原样透传；request_date 已随行 VO 收敛删除', () => {
    const parsed = scanPartRowSchema.parse(validScanRow);
    expect(parsed.planned_delivery_date).toBe('2026-10-20');
    // 占位符不再被归一（transform 已删）
    expect(
      scanPartRowSchema.parse({ ...validScanRow, planned_delivery_date: '1970-01-01' })
        .planned_delivery_date,
    ).toBe('1970-01-01');
    // request_date 不再下发 ⇒ 不作为保留键存在（后端若灰度期仍发，也被 strip）
    expect('request_date' in parsed).toBe(false);
    expect(
      scanPartRowSchema.parse({ ...validScanRow, request_date: '2026-09-01' }),
    ).not.toHaveProperty('request_date');
    // planned_delivery_date 非 null 是必填：缺键 / null 都要抛
    const { planned_delivery_date: _dropped, ...rest } = validScanRow;
    void _dropped;
    expect(() => scanPartRowSchema.parse(rest)).toThrow();
    expect(() =>
      scanPartRowSchema.parse({ ...validScanRow, planned_delivery_date: null }),
    ).toThrow();
  });

  // ⚠️ 2026-10-10：被砍掉的 23 个恒占位值键在 schema 上彻底消失。后端灰度期若仍下发，
  // Zod strip 掉、**不抛错**（否则新旧后端并存时报工台三页全空）。
  it('S-SP2b：被砍的 23 个键被 strip 且不抛错', () => {
    const legacyExtraKeys = {
      applicant_name: '',
      request_date: '1970-01-01',
      customer_id: '0',
      assembly_id: null,
      status: 'IN_PROCESS',
      order_no: null,
      note: null,
      unit_price: '0',
      total_price: '0',
      version: 0,
      created_at: '1970-01-01T00:00:00',
      created_by: null,
      updated_at: '1970-01-01T00:00:00',
      updated_by: null,
      deleted_at: null,
      customer_name: null,
      l1_customer_name: null,
      holder_name: null,
      row_type: 'PART',
      has_children: false,
      child_count: null,
      has_cnc_program: false,
      delivered_quantity: null,
    };
    expect(Object.keys(legacyExtraKeys)).toHaveLength(23);
    const parsed = scanPartRowSchema.parse({ ...validScanRow, ...legacyExtraKeys });
    for (const key of Object.keys(legacyExtraKeys)) {
      expect(parsed, `${key} 不得成为保留键`).not.toHaveProperty(key);
    }
    expect(Object.keys(parsed).sort()).toEqual(Object.keys(validScanRow).sort());
  });

  it('S-SP3：缺 batch_id / batch_version / location 各自抛 ZodError（M-1 guard）', () => {
    const { batch_id: _b, batch_version: _bv, location: _loc, ...rest } = validScanRow;
    void _b;
    void _bv;
    void _loc;
    expect(() => scanPartRowSchema.parse(rest)).toThrow();
    const { batch_id: _b2, ...rest2 } = validScanRow;
    void _b2;
    expect(() => scanPartRowSchema.parse(rest2)).toThrow();
    const { location: _loc3, ...rest3 } = validScanRow;
    void _loc3;
    expect(() => scanPartRowSchema.parse(rest3)).toThrow();
  });

  // ⚠️ `location` 的值恒为 null，但**键必须声明**：`BatchPickerDialog.holderText` 用
  // `'location' in p` 判「这个 VO 带不带 holder 信息」，strip 掉会让卡片静默少
  // 「未知位置」那一行，且仓内没有测试能提前发现（fixture 自己带上了该键）。
  it('S-SP3a：location 键恒在、值可 null（S-SP3 只守「缺键抛」，这条守「null 也保留」）', () => {
    const parsed = scanPartRowSchema.parse(validScanRow);
    expect('location' in parsed).toBe(true);
    expect(parsed.location).toBeNull();
    expect(scanPartRowSchema.parse({ ...validScanRow, location: '货架 A-01' }).location).toBe(
      '货架 A-01',
    );
  });

  // 2026-10-09：has_process_chain 必填且**无默认值**（与同组 chain_state 四件套的
  // 「带默认值降级」相反）。它直接决定卡片左边框色，缺键降级成灰色与「真无链」不可区分，
  // 不如在 API 边界炸出来。
  it('S-SP3b：缺 has_process_chain → 抛 ZodError（不给默认值降级）', () => {
    const { has_process_chain: _dropped, ...rest } = validScanRow;
    void _dropped;
    expect(() => scanPartRowSchema.parse(rest)).toThrow();
    // 形态错同样抛（布尔退化成 0 / 1 / 'true' 都是契约漂移）
    for (const bad of [0, 1, 'true', null]) {
      expect(() => scanPartRowSchema.parse({ ...validScanRow, has_process_chain: bad })).toThrow();
    }
  });

  it('S-SP4：外层是分页信封 —— 裸数组被拒（历史线上故障的形态）', () => {
    const envelope = scanPartListResultSchema.parse({
      items: [validScanRow],
      total: 1,
      limit: 200,
      offset: 0,
    });
    expect(envelope.items).toHaveLength(1);
    expect(envelope.total).toBe(1);
    expect(() => scanPartListResultSchema.parse([validScanRow])).toThrow();
    expect(() => scanPartListResultSchema.parse({ items: [validScanRow], total: 1 })).toThrow();
    // 计数是裸 i64 → JSON number；字符串形态被拒（漂移可见，不被静默强转掩盖）
    expect(() =>
      scanPartListResultSchema.parse({
        items: [validScanRow],
        total: '1',
        limit: 200,
        offset: 0,
      }),
    ).toThrow();
  });

  // 工序链四件套按「带默认值的必输出键」声明（取舍理由见 schemas.ts
  // scanPartRowSchema.chain_state 的注释）：**缺键降级、不抛**。这条断言守的就是那个
  // 降级承诺 —— 后端没上线 / 漏发这四个键时，parse 必须通过（否则取件 / 放回 / 送检
  // 三页列表全空，报工台停工），且落到的默认值必须正好是「没有下一道」的语义。
  it('S-SP5：工序链四件套缺键 → 降级到「无链」语义而不是抛错', () => {
    const { chain_state: _s, ...noState } = validScanRow;
    void _s;
    // chain_state 用 nullish（不是 .default('NONE')）：保留「键缺失 ⇒ undefined」这个
    // 信号，消费侧据此 warn 一次；不锁枚举：后端加第四个取值也只是降级。
    const noStateParsed = scanPartRowSchema.parse(noState);
    expect(noStateParsed.chain_state).toBeUndefined();
    // 后端将来新增第四个取值（纯后端单方面改动）不得让 parse 抛错
    const unknownState = scanPartRowSchema.parse({ ...validScanRow, chain_state: 'SKIP' });
    expect(unknownState.chain_state).toBe('SKIP');

    // 另三个键的默认值对齐后端兜底口径：id 落 '0'（消费侧见到 '0' 必须短路，不提交
    // worker-scan）、两个 name 落 null。
    const bare: Record<string, unknown> = { ...validScanRow };
    for (const key of [
      'chain_state',
      'chain_next_process_id',
      'chain_next_process_name',
      'chain_current_process_name',
    ]) {
      delete bare[key];
    }
    const bareParsed = scanPartRowSchema.parse(bare);
    expect(bareParsed.chain_state).toBeUndefined();
    expect(bareParsed.chain_next_process_id).toBe('0');
    expect(bareParsed.chain_next_process_name).toBeNull();
    expect(bareParsed.chain_current_process_name).toBeNull();

    // 但键在、值形态错（雪花 id 退化成 number）仍要抛 —— 默认值只兜「缺键」，不兜「坏形态」
    expect(() =>
      scanPartRowSchema.parse({ ...validScanRow, chain_next_process_id: 190000000000021 }),
    ).toThrow();
    expect(() =>
      scanPartRowSchema.parse({ ...validScanRow, chain_next_process_id: null }),
    ).toThrow();
  });
});
