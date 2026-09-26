// src/composables/queries/__tests__/schemas.spec.ts
//
// 2026-09-26（M-1 回归保护）新增：customerSchema / processSchema 与 backend-rust
// 真实返回结构对齐断言（防止 zod 默认 strip 模式静默丢弃未声明字段，导致
// 「Zod 校验守门失效」）。
//
// 覆盖：
//   - S1：customerSchema.parse 接受 backend-rust CustomerOut 8 字段结构（id /
//     name / parent_id / parent_name / serial_prefix / version / created_at /
//     updated_at），不抛错。
//   - S2：customerSchema 对一级客户（parent_id = null, parent_name = null,
//     serial_prefix = 'A'）也接受。
//   - S3：customerSchema 对二级客户（parent_id / parent_name 非 null,
//     serial_prefix = null）也接受。
//   - S4：customerSchema 缺 version → 抛 ZodError（核心 regression guard：
//     首轮漏列 version 字段会导致 backend-rust 真返回被 strip 掉，仍 parse 成功）。
//   - S5：customerListResultSchema 接受分页结构（items / total / limit / offset）。
//   - S6：processSchema.parse 接受 backend-rust ProcessOut 11 字段结构。
//   - S7：processSchema 对 INHOUSE / OUTSOURCE 两种 category 都接受。
//   - S8：processSchema 对 description = null / color = null 接受（OUTSOURCE
//     允许 null）。
//   - S9：processSchema 对未声明字段严格拒绝（防止字段漂移漏检）—— backend-rust
//     新加字段如果前端 schema 不更新，customerListResultSchema.parse 不应该
//     静默 strip（这是 zod 默认行为，但本 schema 用 z.object 不带 .passthrough()，
//     默认 strip 后 parse 不抛；本用例断言「strip 后多出的字段消失但 parse 不
//     报错」是 zod 默认契约 —— 这本身是 M-1 修复的核心动机，所以用 case 标记
//     这个默认行为并提示 reviewer 升级方向）。
//   - S10：customerListResultSchema 对 overall shape 拒绝（如 total 缺）→ 抛
//     ZodError。
//   - S11（2026-09-27 前后端字段对齐）：partSchema.parse 接受 backend-rust
//     PartListOut 真实形态（含 unit_price / total_price / l1_customer_name
//     string 类型字段，不含 customer_path / next_process_id / next_process_name）。
//   - S12：partSchema 缺 unit_price → 抛 ZodError。
//   - S13：partSchema 缺 total_price → 抛 ZodError。
//   - S14：partSchema 缺 l1_customer_name → 抛 ZodError（nullable 但必填字段，
//     与 customerSchema S4 同形态的 regression guard）。
//
// 数据来源：
//   - backend-rust/docs/api/customers.md:142-153（CustomerOut 8 字段）
//   - backend-rust/docs/api/production/processes.md:159-173（ProcessOut 11 字段）
//   - backend-rust/docs/api/parts.md（PartListOut / PartListItem 字段）

import { describe, expect, it } from 'vitest';
import {
  customerSchema,
  customerListResultSchema,
  processSchema,
  processListResultSchema,
  partSchema,
  partListResultSchema,
} from '../schemas';

describe('queries schemas — 后端契约对齐断言（M-1 2026-09-26）', () => {
  describe('customerSchema', () => {
    it('S1：解析 backend-rust CustomerOut 完整 8 字段不抛错', () => {
      const customer = customerSchema.parse({
        id: '190000000000001',
        name: '客户A',
        parent_id: null,
        parent_name: null,
        serial_prefix: 'A',
        version: 3,
        created_at: '2026-09-26 10:00:00',
        updated_at: '2026-09-26 11:00:00',
      });
      expect(customer.id).toBe('190000000000001');
      expect(customer.version).toBe(3);
    });

    it('S2：一级客户（serial_prefix 非空 + parent_* 为 null） → 解析通过', () => {
      const customer = customerSchema.parse({
        id: '190000000000001',
        name: 'L1-客户',
        parent_id: null,
        parent_name: null,
        serial_prefix: 'B',
        version: 1,
        created_at: '2026-01-01 00:00:00',
        updated_at: '2026-01-01 00:00:00',
      });
      expect(customer.serial_prefix).toBe('B');
      expect(customer.parent_id).toBeNull();
    });

    it('S3：二级客户（parent_* 非空 + serial_prefix 为 null） → 解析通过', () => {
      const customer = customerSchema.parse({
        id: '190000000000002',
        name: 'L2-叶子客户',
        parent_id: '190000000000001',
        parent_name: 'L1-客户',
        serial_prefix: null,
        version: 1,
        created_at: '2026-01-01 00:00:00',
        updated_at: '2026-01-01 00:00:00',
      });
      expect(customer.parent_id).toBe('190000000000001');
      expect(customer.parent_name).toBe('L1-客户');
      expect(customer.serial_prefix).toBeNull();
    });

    it('S4：缺 version → 抛 ZodError（M-1 修复的核心 regression guard）', () => {
      // 背景：首轮漏列 version 字段，zod 默认 strip 模式会静默丢弃，导致 parse
      // 不报错但 backend-rust 返回的 version 在前端拿不到。本 spec 通过「故意
      // 缺 version 必须抛错」锁死该字段必填。
      expect(() =>
        customerSchema.parse({
          id: '190000000000001',
          name: 'X',
          parent_id: null,
          parent_name: null,
          serial_prefix: 'A',
          // version: 故意缺
          created_at: '',
          updated_at: '',
        }),
      ).toThrow();
    });

    it('S4b：缺 created_at → 抛 ZodError', () => {
      expect(() =>
        customerSchema.parse({
          id: '190000000000001',
          name: 'X',
          parent_id: null,
          parent_name: null,
          serial_prefix: 'A',
          version: 1,
          // created_at: 故意缺
          updated_at: '',
        }),
      ).toThrow();
    });

    it('S4c：缺 updated_at → 抛 ZodError', () => {
      expect(() =>
        customerSchema.parse({
          id: '190000000000001',
          name: 'X',
          parent_id: null,
          parent_name: null,
          serial_prefix: 'A',
          version: 1,
          created_at: '',
          // updated_at: 故意缺
        }),
      ).toThrow();
    });

    it('S9：未声明字段（extra: "ignored"）→ parse 成功但 extra 被 strip 掉（zod 默认行为）', () => {
      // 记录 zod 默认 .object() strip 行为，提醒 reviewer：若 backend-rust 后续
      // 新增字段，前端必须同步更新 schema 才能让 Zod parse 出错 —— 本用例本身
      // 不抛错，文档化默认契约。
      const parsed = customerSchema.parse({
        id: '190000000000001',
        name: 'X',
        parent_id: null,
        parent_name: null,
        serial_prefix: 'A',
        version: 1,
        created_at: '',
        updated_at: '',
        extra_field: 'should-be-stripped',
      });
      expect((parsed as unknown as Record<string, unknown>).extra_field).toBeUndefined();
    });
  });

  describe('customerListResultSchema', () => {
    it('S5：解析分页结构（items / total / limit / offset）', () => {
      const result = customerListResultSchema.parse({
        items: [
          {
            id: '190000000000001',
            name: 'A',
            parent_id: null,
            parent_name: null,
            serial_prefix: 'A',
            version: 1,
            created_at: '',
            updated_at: '',
          },
        ],
        total: 1,
        limit: 50,
        offset: 0,
      });
      expect(result.items).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(result.items[0]?.version).toBe(1);
    });

    it('S10：缺 total → 抛 ZodError', () => {
      expect(() =>
        customerListResultSchema.parse({
          items: [],
          // total: 故意缺
          limit: 50,
          offset: 0,
        }),
      ).toThrow();
    });
  });

  describe('processSchema', () => {
    it('S6：解析 backend-rust ProcessOut 完整 11 字段不抛错', () => {
      const process = processSchema.parse({
        id: '170000000000001',
        version: 2,
        code: 'CNC',
        name: '数控加工',
        category: 'INHOUSE',
        sort_order: 1,
        description: '默认描述',
        requires_approval: false,
        color: '#E74C3CFF',
        created_at: '2026-09-26 10:00:00',
        updated_at: '2026-09-26 11:00:00',
      });
      expect(process.id).toBe('170000000000001');
      expect(process.version).toBe(2);
      expect(process.category).toBe('INHOUSE');
      expect(process.color).toBe('#E74C3CFF');
    });

    it('S7：INHOUSE / OUTSOURCE 两种 category 都接受', () => {
      const inhouse = processSchema.parse({
        id: '1',
        version: 1,
        code: 'X',
        name: 'X',
        category: 'INHOUSE',
        sort_order: 0,
        description: null,
        requires_approval: false,
        color: null,
        created_at: '',
        updated_at: '',
      });
      expect(inhouse.category).toBe('INHOUSE');

      const outsource = processSchema.parse({
        id: '2',
        version: 1,
        code: 'Y',
        name: 'Y',
        category: 'OUTSOURCE',
        sort_order: 0,
        description: null,
        requires_approval: true,
        color: null,
        created_at: '',
        updated_at: '',
      });
      expect(outsource.category).toBe('OUTSOURCE');
    });

    it('S8：description = null / color = null 接受（nullable 字段边界）', () => {
      const p = processSchema.parse({
        id: '3',
        version: 1,
        code: 'Z',
        name: 'Z',
        category: 'OUTSOURCE',
        sort_order: 0,
        description: null,
        requires_approval: true,
        color: null,
        created_at: '',
        updated_at: '',
      });
      expect(p.description).toBeNull();
      expect(p.color).toBeNull();
    });

    it('S8b：非法 category（如 "OTHER"） → 抛 ZodError（enum 锁死）', () => {
      expect(() =>
        processSchema.parse({
          id: '4',
          version: 1,
          code: 'W',
          name: 'W',
          category: 'OTHER',
          sort_order: 0,
          description: null,
          requires_approval: false,
          color: null,
          created_at: '',
          updated_at: '',
        }),
      ).toThrow();
    });
  });

  describe('processListResultSchema', () => {
    it('解析完整 list 结构', () => {
      const result = processListResultSchema.parse({
        items: [
          {
            id: '170000000000001',
            version: 2,
            code: 'CNC',
            name: '数控加工',
            category: 'INHOUSE',
            sort_order: 1,
            description: null,
            requires_approval: false,
            color: null,
            created_at: '',
            updated_at: '',
          },
        ],
        total: 1,
        limit: 200,
        offset: 0,
      });
      expect(result.items).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(result.items[0]?.version).toBe(2);
    });
  });

  describe('partSchema（2026-09-27 前后端字段对齐）', () => {
    // 完整 PartListItem 形态：与后端 backend-rust PartListOut 真实返回结构对齐
    // （TPart 22 列 flatten + unit_price / total_price string + l1_customer_name，
    // 不含已下线的 parent_customer_name / customer_path / next_process_id /
    // next_process_name）。
    function makeBasePart(): Record<string, unknown> {
      return {
        id: '180000000000001',
        version: 5,
        serial_no: 'SN-001',
        name: '零件甲',
        drawing_no: 'DWG-001',
        applicant_name: '张三',
        quantity: 10,
        unit_price: '100.50',
        total_price: '1005.00',
        request_date: '2026-09-01',
        planned_delivery_date: '2026-09-30',
        is_urgent: true,
        status: 'IN_PROCESS',
        order_no: 'PO-2026-001',
        system_delivery_date: '2026-10-15',
        note: '首件',
        customer_name: '客户乙',
        l1_customer_name: '客户甲',
        location: 'PRODUCTION_SHELF',
        holder_name: 'A-01',
        process_chain_id: '160000000000001',
      };
    }

    it('S11：解析 backend-rust PartListItem 完整形态（unit_price / total_price 为 string）', () => {
      const parsed = partSchema.parse(makeBasePart());
      expect(parsed.id).toBe('180000000000001');
      expect(parsed.unit_price).toBe('100.50');
      expect(parsed.total_price).toBe('1005.00');
      expect(parsed.l1_customer_name).toBe('客户甲');
      expect(parsed.customer_name).toBe('客户乙');
      // status enum 锁死
      expect(parsed.status).toBe('IN_PROCESS');
      // zod 默认 strip 模式：未声明字段（customer_path / next_process_id /
      // next_process_name）即使存在也会被丢弃
      const asRecord = parsed as unknown as Record<string, unknown>;
      expect(asRecord.customer_path).toBeUndefined();
      expect(asRecord.next_process_id).toBeUndefined();
      expect(asRecord.next_process_name).toBeUndefined();
      expect(asRecord.parent_customer_name).toBeUndefined();
    });

    it('S11b：unit_price 接受 rust_decimal 序列化的任意 string 形态（含 "0" / "100.50"）', () => {
      // 后端 rust_decimal::Decimal + serde-with-str 序列化产生任意精度字符串
      expect(partSchema.parse({ ...makeBasePart(), unit_price: '0' }).unit_price).toBe('0');
      expect(partSchema.parse({ ...makeBasePart(), unit_price: '0.00' }).unit_price).toBe('0.00');
      expect(
        partSchema.parse({ ...makeBasePart(), unit_price: '9999999.9999' }).unit_price,
      ).toBe('9999999.9999');
    });

    it('S12：缺 unit_price → 抛 ZodError（regression guard）', () => {
      // 背景：2026-09-27 把 unit_price 从 z.number() 改 z.string()，如果 schema
      // 漏列或类型写错会静默 strip —— 本用例锁死「必须声明为必填 string」。
      const { unit_price: _, ...rest } = makeBasePart();
      void _;
      expect(() => partSchema.parse(rest)).toThrow();
    });

    it('S12b：unit_price 传 number（与旧 schema 形态） → 抛 ZodError', () => {
      // 防止有人不小心把 schema 改回 z.number() —— 必须是 string。
      expect(() => partSchema.parse({ ...makeBasePart(), unit_price: 100 })).toThrow();
    });

    it('S13：缺 total_price → 抛 ZodError（regression guard）', () => {
      const { total_price: _, ...rest } = makeBasePart();
      void _;
      expect(() => partSchema.parse(rest)).toThrow();
    });

    it('S13b：total_price 传 number → 抛 ZodError', () => {
      expect(() => partSchema.parse({ ...makeBasePart(), total_price: 1005 })).toThrow();
    });

    it('S14：缺 l1_customer_name → 抛 ZodError（nullable 但必填字段）', () => {
      // 背景：与 customerSchema S4 同形态 —— nullable 不代表 optional，必填
      // 字段必须显式声明（即使是 null 也得带 key）。zod 默认 strip 模式下
      // 漏列会让 backend-rust 真返回的 l1_customer_name 在前端拿不到。
      const { l1_customer_name: _, ...rest } = makeBasePart();
      void _;
      expect(() => partSchema.parse(rest)).toThrow();
    });

    it('S14b：l1_customer_name = null 是合法值（一级客户）', () => {
      const parsed = partSchema.parse({ ...makeBasePart(), l1_customer_name: null });
      expect(parsed.l1_customer_name).toBeNull();
    });

    it('S14c：l1_customer_name = "客户甲" 是合法值（二级客户）', () => {
      const parsed = partSchema.parse({ ...makeBasePart(), l1_customer_name: '客户甲' });
      expect(parsed.l1_customer_name).toBe('客户甲');
    });

    it('partListResultSchema 接受 PartListOut 分页结构（items + 数字分页字段）', () => {
      // normalizeListResult 在 listParts caller 层把 total/limit/offset 兜底成
      // number；partListResultSchema.parse 期望 number 形态（与 schemas 4 个
      // 其它 list 结果 schema 一致）。
      const result = partListResultSchema.parse({
        items: [makeBasePart()],
        total: 1,
        limit: 20,
        offset: 0,
      });
      expect(result.items).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(result.items[0]?.unit_price).toBe('100.50');
    });
  });
});