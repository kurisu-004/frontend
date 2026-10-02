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
//   - S6：processSchema.parse 接受 backend-rust ProcessOut 12 字段结构。
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
//   - S15（2026-09-29 修复）：assemblyDetailFlatSchema 接受 backend-rust
//     `AssemblyDetail` 实际 wire 形态（19 字段平铺 + children + files，
//     来自 `#[serde(flatten)]` quirk），不抛错。
//   - S16：assemblyDetailFlatSchema 缺 children → 抛 ZodError（M-1 同形态
//     regression guard：缺必填字段静默 strip = 校验形同虚设）。
//   - S17：assemblyDetailFlatSchema 多出 `assembly` 嵌套键 → 抛 ZodError。
//     （`assemblyDetailFlatSchema` 用 `.strict()` 而非默认 strip —— 若后端
//     意外把 assembly 改回嵌套键（regression），parse 立刻抛错；与 M-1
//     「缺字段静默 strip」同源问题。）assembly 嵌套键是 detail 端点的旧 bug
//     形态，锁死 strict 防回归。
//   - S18（2026-09-29 review 第 1 轮新增）：heldBatchItemSchema 接受 backend-rust
//     `HeldBatchItem` 完整 18 字段（含 review 第 1 轮新增 has_cnc_program 必填
//     字段），不抛错。
//   - S19：heldBatchItemSchema 缺 has_cnc_program → 抛 ZodError（与 partSchema
//     S15a 同源 regression guard：zod 默认 strip 模式漏列 boolean 字段会让后端
//     真返回的 has_cnc_program 在前端拿不到且 parse 不报错）。
//   - S20（2026-09-30 新增）：inspectionBatchListItemSchema 接受 backend-rust
//     `InspectionBatchListItemOut` 完整 28 字段结构（批次 9 + holder 4 +
//     delivery_note 2 + 工单 10 + 客户 3，含 l1_customer_name 与 holder_name），
//     不抛错。
//   - S21：inspectionBatchListResultSchema 接受分页结构（items / total / limit /
//     offset）。
//   - S22：inspectionBatchListItemSchema 多出 `id` 字段 → 抛 ZodError（`.strict()`
//     守门：regression guard — 后端若误把 id 字段加进 inspection 响应，schema
//     立刻抛错而非默认 strip 静默丢）。
//   - S23：inspectionBatchListItemSchema 缺 part_id → 抛 ZodError（M-1 同形态
//     guard：缺核心字段静默 strip = 校验形同虚设）。
//   - S23b（2026-10-02 新增 regression guard）：is_repairing = true 也能 parse
//     （不得被人「先写 z.literal(false) 消警告」把真实返修数据挡掉），且缺
//     is_repairing 必抛错（后端 vo/inspection.rs:44 恒输出该键）。
//     编号说明：本用例原编 S24，与下面「2026-10-01 新增：programming / shelves」
//     describe 块里既有的 S24（pendingProgrammingItemSchema 13 字段）撞号，
//     2026-10-02 review 第 1 轮改为 S23b（沿本文件 S11b / S12b / S19b 等后缀惯例）。
//
// 数据来源：
//   - backend-rust/docs/api/customers.md:142-153（CustomerOut 8 字段）
//   - backend-rust/docs/api/production/processes.md:159-173（ProcessOut 12 字段）
//   - backend-rust/docs/api/parts.md（PartListOut / PartListItem 字段）
//   - backend-rust/src/modules/assembly/vo/assembly.rs:17-119
//     （AssemblyOut 19 字段 / AssemblyChildOut 13 字段 / AssemblyFileRef 3 字段 /
//     AssemblyDetail 用 #[serde(flatten)]）

import { describe, expect, it } from 'vitest';
import {
  customerSchema,
  customerListResultSchema,
  processSchema,
  processListResultSchema,
  partSchema,
  partListResultSchema,
  assemblyDetailFlatSchema,
  heldBatchItemSchema,
  workerBriefSchema,
  workTypeMaxHeldSchema,
  poolBatchItemSchema,
  workerPoolByProcessSchema,
  workerPoolCountsSchema,
  workerStateSchema,
  takenItemSchema,
  refillResultSchema,
  moveRequestSchema,
  moveResultSchema,
  dispatchRequestSchema,
  dispatchSuccessItemSchema,
  dispatchResultSchema,
  autoDispatchRequestSchema,
  autoDispatchResultSchema,
  inspectionBatchListItemSchema,
  inspectionBatchListResultSchema,
  pendingProgrammingItemSchema,
  pendingProgrammingListResultSchema,
  shelfSchema,
  shelfListResultSchema,
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
    it('S6：解析 backend-rust ProcessOut 完整 12 字段不抛错', () => {
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
        // 2026-09-29 新增：is_cnc 必填字段（processSchema 已升级为 12 字段）
        is_cnc: true,
        created_at: '2026-09-26 10:00:00',
        updated_at: '2026-09-26 11:00:00',
      });
      expect(process.id).toBe('170000000000001');
      expect(process.version).toBe(2);
      expect(process.category).toBe('INHOUSE');
      expect(process.color).toBe('#E74C3CFF');
      expect(process.is_cnc).toBe(true);
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
        is_cnc: false,
        created_at: '',
        updated_at: '',
      });
      expect(inhouse.category).toBe('INHOUSE');
      expect(inhouse.is_cnc).toBe(false);

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
        // 2026-09-29：OUTSOURCE 工序 is_cnc 强制 false（与业务语义对齐）
        is_cnc: false,
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
        is_cnc: false,
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
          is_cnc: false,
          created_at: '',
          updated_at: '',
        }),
      ).toThrow();
    });

    // 2026-09-29 新增：is_cnc 守门用例 —— 与 l1_customer_name / has_cnc_program 同源
    // regression guard（沿 CLAUDE.md §M-4 strip 陷阱）。
    it('S8c：缺 is_cnc → 抛 ZodError', () => {
      const { is_cnc: _, ...rest } = processSchema.parse({
        id: '5',
        version: 1,
        code: 'A',
        name: 'A',
        category: 'INHOUSE',
        sort_order: 0,
        description: null,
        requires_approval: false,
        color: null,
        is_cnc: false,
        created_at: '',
        updated_at: '',
      });
      void _;
      expect(() => processSchema.parse(rest)).toThrow();
    });

    it('S8d：is_cnc = true 是合法值（CNC 编程工序）', () => {
      const parsed = processSchema.parse({
        id: '6',
        version: 1,
        code: 'B',
        name: 'B',
        category: 'INHOUSE',
        sort_order: 0,
        description: null,
        requires_approval: false,
        color: null,
        is_cnc: true,
        created_at: '',
        updated_at: '',
      });
      expect(parsed.is_cnc).toBe(true);
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
            is_cnc: true,
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
      expect(result.items[0]?.is_cnc).toBe(true);
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
        // 2026-09-29 新增：partSchema 必填 has_cnc_program 字段（沿 CLAUDE.md §M-4
        // strip 陷阱守门）。
        has_cnc_program: false,
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
      expect(partSchema.parse({ ...makeBasePart(), unit_price: '9999999.9999' }).unit_price).toBe(
        '9999999.9999',
      );
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

    // 2026-09-29 新增：has_cnc_program 守门用例 —— 锁死该字段必填 boolean。
    // 后端 GET /api/v2/parts/pending-programming 出参与其它 parts list 共享同
    // PartListItem 形态，has_cnc_program 必须显式声明（与 l1_customer_name 同源
    // regression guard）。CLAUDE.md §M-4 strip 陷阱：zod 默认 strip 模式下漏列
    // 字段会让后端真返回的数据在前端拿不到，且 parse 不报错。
    it('S15a：缺 has_cnc_program → 抛 ZodError', () => {
      const { has_cnc_program: _, ...rest } = makeBasePart();
      void _;
      expect(() => partSchema.parse(rest)).toThrow();
    });

    it('S15b：has_cnc_program = true 是合法值（已编程状态）', () => {
      const parsed = partSchema.parse({ ...makeBasePart(), has_cnc_program: true });
      expect(parsed.has_cnc_program).toBe(true);
    });

    it('S15c：has_cnc_program = false 是合法值（未编程状态 / 默认）', () => {
      const parsed = partSchema.parse({ ...makeBasePart(), has_cnc_program: false });
      expect(parsed.has_cnc_program).toBe(false);
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

  describe('assemblyDetailFlatSchema（2026-09-29 修复：消化 #[serde(flatten)] quirk）', () => {
    // 后端 `AssemblyDetail` wire 形态（19 AssemblyOut 字段平铺 + children + files）：
    function makeBaseAssemblyDetail(): Record<string, unknown> {
      return {
        // —— AssemblyOut 19 字段（顺序对齐 backend-rust vo/assembly.rs:17-39）——
        id: '190000000000001',
        version: 1,
        serial_no: 'ASM-001',
        drawing_no: 'ASM-DWG-001',
        name: '总装测试件',
        applicant_name: '张三',
        customer_id: '180000000000001',
        request_date: '2026-09-01',
        planned_delivery_date: '2026-09-30',
        is_urgent: false,
        status: 'PENDING',
        quantity: 1,
        unit_price: '100.00',
        total_price: '100.00',
        order_no: null,
        system_delivery_date: null,
        note: null,
        created_at: '2026-09-29 10:00:00',
        updated_at: '2026-09-29 11:00:00',
        // —— 平铺之外的 children + files ——
        children: [],
        files: [],
      };
    }

    it('S15：解析 backend-rust AssemblyDetail 平铺形态（19 + children + files）不抛错', () => {
      const parsed = assemblyDetailFlatSchema.parse(makeBaseAssemblyDetail());
      // 19 字段平铺 + children + files 全部可见
      expect(parsed.id).toBe('190000000000001');
      expect(parsed.drawing_no).toBe('ASM-DWG-001');
      expect(parsed.children).toEqual([]);
      expect(parsed.files).toEqual([]);
      // 关键：parsed 上没有 `assembly` 嵌套键（后端平铺，无嵌套）
      const asRecord = parsed as unknown as Record<string, unknown>;
      expect(asRecord.assembly).toBeUndefined();
    });

    it('S16：缺 children → 抛 ZodError（M-1 同源 regression guard）', () => {
      // 背景：zod 默认 strip 模式下漏列 children 会让 backend-rust 真返回的 children
      // 数组在前端拿不到，但 parse 不报错（与 customerSchema S4 同形态）。本 schema
      // 把 children 显式声明为 z.array() 必填字段，缺字段必须抛错，守门到位。
      const { children: _omit, ...rest } = makeBaseAssemblyDetail();
      void _omit;
      expect(() => assemblyDetailFlatSchema.parse(rest)).toThrow();
    });

    it('S17：多出 `assembly` 嵌套键 → 抛 ZodError（strict 模式 regression guard）', () => {
      // 背景：assemblyDetailFlatSchema 用 `.strict()` 而非默认 strip。若后端意外把
      // assembly 改回嵌套键（regression，回退到旧 bug 形态），parse 立刻抛错；
      // 守门到位。本用例锁死：嵌套 `assembly` 键出现必须抛错。
      const wrapped = {
        ...makeBaseAssemblyDetail(),
        // 故意添加嵌套 assembly 键 —— 模拟后端 regression 把 19 字段塞进
        // assembly 嵌套对象（这正是我们要消化的 quirk 反向）。
        assembly: {
          id: '190000000000001',
          drawing_no: 'ASM-DWG-001',
        },
      };
      expect(() => assemblyDetailFlatSchema.parse(wrapped)).toThrow();
    });
  });

  describe('heldBatchItemSchema（2026-09-29 review 第 1 轮新增）', () => {
    // 后端 `HeldBatchItem` 完整 wire 形态：18 字段全声明
    // （与 HeldBatchItemDto 字段一一对齐；review 第 1 轮在 17 字段基础上
    // 新增 has_cnc_program 必填字段）。
    function makeBaseHeld(): Record<string, unknown> {
      return {
        batch_id: '2100000000001',
        part_id: '1800000000001',
        batch_no: 1,
        quantity: 5,
        serial_no: 'F001-001',
        drawing_no: 'DWG-001',
        name: '零件甲',
        system_delivery_date: '2026-09-30',
        planned_delivery_date: '2026-10-15',
        is_urgent: true,
        customer_name: '法拉电子',
        parent_customer_name: null,
        applicant_name: '张三',
        location: 'WORKER',
        shelf_code: 'A-01',
        note: '加急',
        // 2026-09-29 review 第 1 轮：新增 has_cnc_program 必填字段
        has_cnc_program: true,
        version: 3,
      };
    }

    it('S18：解析 backend-rust HeldBatchItem 完整 18 字段不抛错', () => {
      const parsed = heldBatchItemSchema.parse(makeBaseHeld());
      expect(parsed.batch_id).toBe('2100000000001');
      expect(parsed.part_id).toBe('1800000000001');
      expect(parsed.batch_no).toBe(1);
      expect(parsed.has_cnc_program).toBe(true);
      expect(parsed.location).toBe('WORKER');
      expect(parsed.customer_name).toBe('法拉电子');
      expect(parsed.applicant_name).toBe('张三');
    });

    it('S19：缺 has_cnc_program → 抛 ZodError（M-1 / S15a 同源 regression guard）', () => {
      // 背景：与 partSchema S15a 同形态 —— zod 默认 strip 模式漏列 has_cnc_program
      // 会让后端真返回的「已编程」标记在前端拿不到，且 parse 不报错。本 schema
      // 把 has_cnc_program 显式声明为 z.boolean() 必填字段，缺字段必须抛错，
      // 守门到位。WorkerQueueBoard 的 held 列与 pool 列共用 WorkOrderCard 渲染
      // 「已编程」tag，has_cnc_program 必须透传。
      const { has_cnc_program: _, ...rest } = makeBaseHeld();
      void _;
      expect(() => heldBatchItemSchema.parse(rest)).toThrow();
    });

    it('S19b：has_cnc_program = false 是合法值（非 CNC 链 / 未编程）', () => {
      const parsed = heldBatchItemSchema.parse({ ...makeBaseHeld(), has_cnc_program: false });
      expect(parsed.has_cnc_program).toBe(false);
    });

    it('S19c：缺 version → 抛 ZodError（与 partSchema S12 同形态 regression guard）', () => {
      // held 批次乐观锁 version 必填 —— 后端 WorkerTakenItem / HeldBatchItem 都返
      // t_part_batch.version（OCC 必填）。漏列会让 strip 静默丢。
      const { version: _, ...rest } = makeBaseHeld();
      void _;
      expect(() => heldBatchItemSchema.parse(rest)).toThrow();
    });
  });

  describe('pool 域 schema（2026-09-30 新增 + 契约漂移修复）', () => {
    // 2026-09-30 契约漂移修复（后端 worker-pool → pool 收敛，见
    // backend-rust/src/modules/prod/{worker_pool,batch}/）：
    //   - `poolBatchItemSchema` **删 `current_process_step_id`** —— 后端
    //     `PoolBatchItem`（vo/worker_pool.rs:14-50）无此字段，此前声明为必填
    //     nullable ⇒ parse 100% 失败 ⇒ WorkerPoolTab 永久「加载失败」。旧
    //     S-WP2c / S-WP2d 两条用例随之作废，由 S-WP2e 反向 guard 取代。
    //   - `workerPoolCountsSchema` **删 `shelf_id`** —— 后端
    //     `WorkerPoolCountsOut`（worker_pool/dto.rs）只有 counts + total。
    //   - `workerStateSchema.work_type_code` 由 nullable 收紧为 string —— 后端
    //     `WorkerPoolState.work_type_code` 是非 Option String（model.rs:122）。
    //   - 新增 move / refill / dispatch / auto-dispatch-preview 4 组 schema。
    //
    // 覆盖：
    //   - S-WP1：workerBriefSchema / workTypeMaxHeldSchema / poolBatchItemSchema
    //     / workerPoolByProcessSchema / workerPoolCountsSchema 解析后端真实形态；
    //   - S-WP2：poolBatchItemSchema 缺 has_cnc_program → 抛 ZodError
    //     （M-1 同源 regression guard —— 后端漏返 boolean 字段必须抛错）；
    //   - S-WP2e：多传 current_process_step_id / shelf_id 不报错（strip 不炸）；
    //   - S-WP3：workerPoolByProcessSchema 缺 items[] → 抛 ZodError；
    //   - S-WS1：workerStateSchema 解析 held_batches 嵌套；
    //   - S-WS1c：work_type_code = null → 抛 ZodError（非 Option 字段）；
    //   - S-WS2：workerStateSchema 缺 held_batches → 抛 ZodError；
    //   - S-MV：moveRequestSchema（tagged enum）/ moveResultSchema（skip_serializing_if
    //     四字段可缺省）/ takenItemSchema / refillResultSchema；
    //   - S-DP：dispatchRequestSchema（targets 非空）/ dispatchResultSchema
    //     （failed 缺省）/ autoDispatchRequestSchema（batch_ids 非空）/
    //     autoDispatchResultSchema（items[] + 三个 Option<i64> 字段 null 合法）。

    function makeBasePoolBatchItem(): Record<string, unknown> {
      return {
        batch_id: '3000000000001',
        part_id: '4000000000001',
        batch_no: 1,
        quantity: 5,
        serial_no: null,
        name: '法兰盘',
        drawing_no: 'DWG-A001',
        system_delivery_date: '2026-09-30',
        customer_name: '客户A',
        parent_customer_name: null,
        customer_path: null,
        applicant_name: '张三',
        location: 'PRODUCTION_SHELF',
        shelf_id: '5000000000001',
        shelf_code: 'A-01',
        shelf_name: 'A 区货架 1',
        is_urgent: true,
        note: null,
        // 2026-09-30 必填 boolean（沿 CLAUDE.md §M-4 strip 陷阱）
        has_cnc_program: true,
        version: 1,
      };
    }

    it('S-WP1：poolBatchItemSchema 解析 backend-rust PoolBatchItem 20 字段不抛错', () => {
      const item = poolBatchItemSchema.parse(makeBasePoolBatchItem());
      expect(item.batch_id).toBe('3000000000001');
      expect(item.has_cnc_program).toBe(true);
      // 嵌套字段全部存在
      expect(item.shelf_code).toBe('A-01');
      // 2026-09-30：shelf_id 是 move 的 `from.shelf_id` 唯一来源，必须透传
      expect(item.shelf_id).toBe('5000000000001');
      expect(item.is_urgent).toBe(true);
      expect(item.version).toBe(1);
    });

    it('S-WP1b：workerBriefSchema 解析 4 字段全声明不抛错', () => {
      const brief = workerBriefSchema.parse({
        worker_id: '1900000000001',
        name: '张三',
        work_type_id: '3000000000001',
        work_type_code: 'CNC',
      });
      expect(brief.worker_id).toBe('1900000000001');
      expect(brief.work_type_code).toBe('CNC');
    });

    it('S-WP1c：workerBriefSchema 缺 work_type_code → 抛 ZodError（regression guard）', () => {
      // worker 4 字段全声明 —— 缺 work_type_code 必须抛错。
      expect(() =>
        workerBriefSchema.parse({
          worker_id: '1900000000001',
          name: '张三',
          work_type_id: '3000000000001',
          // work_type_code 缺
        }),
      ).toThrow();
    });

    it('S-WP1d：workTypeMaxHeldSchema 接受 max_held_batches = null（未设置场景）', () => {
      // 后端 max_held_batches 是 Option<i32>；nullable 必填显式声明（zod 默认
      // strip 漏列会让 null 在前端拿不到，且 parse 不报错）。
      const wt = workTypeMaxHeldSchema.parse({
        work_type_id: '3000000000001',
        work_type_code: 'CNC',
        work_type_name: 'CNC 加工',
        max_held_batches: null,
      });
      expect(wt.max_held_batches).toBeNull();
    });

    it('S-WP1e：workerPoolCountsSchema 解析 counts[] + total（后端无 shelf_id 维度）', () => {
      const counts = workerPoolCountsSchema.parse({
        counts: [
          { process_id: '2000000000001', process_code: 'CNC-01', process_name: '粗加工', count: 5 },
          { process_id: '2000000000002', process_code: 'QC-01', process_name: '质检', count: 2 },
        ],
        total: 7,
      });
      expect(counts.counts).toHaveLength(2);
      expect(counts.total).toBe(7);
    });

    it('S-WP1f：多传 shelf_id → 被 strip 不抛 ZodError（回归 guard）', () => {
      // 修复前 schema 声明 `shelf_id: z.string().nullable()` 必填，而后端
      // WorkerPoolCountsOut 根本没有该字段 ⇒ parse 100% 失败 ⇒ 生产队列 tab
      // 徽标恒 0。本用例锁死「schema 不要求 shelf_id」。
      const counts = workerPoolCountsSchema.parse({
        shelf_id: '5000000000001',
        counts: [],
        total: 0,
      });
      expect(counts).toEqual({ counts: [], total: 0 });
      expect(counts).not.toHaveProperty('shelf_id');
    });

    it('S-WP2：poolBatchItemSchema 缺 has_cnc_program → 抛 ZodError（M-1 同源 guard）', () => {
      // 与 partSchema.has_cnc_program / heldBatchItemSchema.has_cnc_program 同源：
      // 后端若漏返 boolean 字段，Zod parse 立刻抛错，WorkOrderCard 的「已编程」tag
      // 渲染才不会静默退化。
      const { has_cnc_program: _, ...rest } = makeBasePoolBatchItem();
      void _;
      expect(() => poolBatchItemSchema.parse(rest)).toThrow();
    });

    it('S-WP2b：has_cnc_program = false 是合法值（非 CNC 链 / 未编程）', () => {
      const parsed = poolBatchItemSchema.parse({
        ...makeBasePoolBatchItem(),
        has_cnc_program: false,
      });
      expect(parsed.has_cnc_program).toBe(false);
    });

    it('S-WP2e：多传 current_process_step_id → 被 strip 不抛 ZodError（回归 guard）', () => {
      // 2026-09-30 契约漂移修复：后端 `PoolBatchItem`
      // （src/modules/prod/worker_pool/vo/worker_pool.rs:14-50）**没有**
      // `current_process_step_id` 字段。此前 contract + schema 都声明了它
      // （required nullable），导致 `workerPoolByProcessSchema.parse` 永远失败
      // ⇒ WorkerPoolTab 永久「加载失败」+ 拖拽 pool→worker 链路整体不可用。
      // 本用例是那次误修的核心反向 guard。
      const parsed = poolBatchItemSchema.parse({
        ...makeBasePoolBatchItem(),
        current_process_step_id: '5000000000010',
      });
      expect(parsed).not.toHaveProperty('current_process_step_id');
      expect(parsed.shelf_id).toBe('5000000000001');
    });

    it('S-WP2f：缺 shelf_id → 抛 ZodError（move 的 from.shelf_id 唯一来源，必须显式声明）', () => {
      const { shelf_id: _omit, ...rest } = makeBasePoolBatchItem();
      void _omit;
      expect(() => poolBatchItemSchema.parse(rest)).toThrow();
    });

    it('S-WP3：workerPoolByProcessSchema 缺 items → 抛 ZodError（M-1 guard）', () => {
      // items 数组是顶层 6 字段之一，必须显式声明。漏列会让后端真返回的 items
      // 在前端拿不到（候选池退化为空 + UI 不报错）。
      const { items: _omit, ...rest } = {
        process_id: '2000000000001',
        process_code: 'CNC-01',
        process_name: '粗加工',
        workers: [],
        work_types: [],
        total: 0,
        items: [] as unknown[],
      };
      void _omit;
      expect(() => workerPoolByProcessSchema.parse(rest)).toThrow();
    });

    it('S-WP3b：workerPoolByProcessSchema 完整 6 顶层字段 + 嵌套数组解析', () => {
      const parsed = workerPoolByProcessSchema.parse({
        process_id: '2000000000001',
        process_code: 'CNC-01',
        process_name: '粗加工',
        workers: [
          {
            worker_id: '1900000000001',
            name: '张三',
            work_type_id: '3000000000001',
            work_type_code: 'CNC',
          },
        ],
        work_types: [
          {
            work_type_id: '3000000000001',
            work_type_code: 'CNC',
            work_type_name: 'CNC 加工',
            max_held_batches: 3,
          },
        ],
        total: 1,
        items: [makeBasePoolBatchItem()],
      });
      expect(parsed.workers).toHaveLength(1);
      expect(parsed.items).toHaveLength(1);
      expect(parsed.total).toBe(1);
    });

    it('S-WS1：workerStateSchema 解析完整 8 字段（含 held_batches 嵌套）', () => {
      // 沿 heldBatchItemSchema 守门（与 backend-rust HeldBatchItem 18 字段对齐）。
      const parsed = workerStateSchema.parse({
        worker_id: '1900000000001',
        worker_name: '张三',
        work_type_code: 'CNC',
        max_held: 3,
        current_held: 1,
        capacity_remaining: 2,
        pool_count_by_process: [{ process_id: '2000000000001', pool_count: 5 }],
        held_batches: [
          {
            batch_id: '2100000000001',
            part_id: '1800000000001',
            batch_no: 1,
            quantity: 5,
            serial_no: null,
            drawing_no: 'DWG-001',
            name: '零件甲',
            system_delivery_date: '2026-09-30',
            planned_delivery_date: '2026-10-15',
            is_urgent: true,
            customer_name: '法拉电子',
            parent_customer_name: null,
            applicant_name: '张三',
            location: 'WORKER',
            shelf_code: 'A-01',
            note: null,
            has_cnc_program: true,
            version: 3,
          },
        ],
      });
      expect(parsed.held_batches).toHaveLength(1);
      expect(parsed.held_batches[0]?.has_cnc_program).toBe(true);
      expect(parsed.pool_count_by_process[0]?.pool_count).toBe(5);
    });

    it('S-WS1b：work_type_code = 空串是合法值（无工种场景）', () => {
      // 2026-09-30 契约校正：后端 `pub work_type_code: String`（**非** Option，
      // model.rs:122）—— 工人未指派工种时退化为空串而非 null
      // （worker-pool.md:52「前端应展示『工种未设置』占位」）。
      const parsed = workerStateSchema.parse({
        worker_id: '1900000000001',
        worker_name: '新员工',
        work_type_code: '',
        max_held: 0,
        current_held: 0,
        capacity_remaining: 0,
        pool_count_by_process: [],
        held_batches: [],
      });
      expect(parsed.work_type_code).toBe('');
      expect(parsed.max_held).toBe(0);
    });

    it('S-WS1c：work_type_code = null → 抛 ZodError（非 Option 字段，回归 guard）', () => {
      // 修复前 schema 写 `.nullable()` 是「恰好接受」而非「按契约接受」。后端若哪天真
      // 返 null，前端应立刻炸出来，而不是静默把 null 当成「无工种」处理。
      expect(() =>
        workerStateSchema.parse({
          worker_id: '1900000000001',
          worker_name: '新员工',
          work_type_code: null,
          max_held: 0,
          current_held: 0,
          capacity_remaining: 0,
          pool_count_by_process: [],
          held_batches: [],
        }),
      ).toThrow();
    });

    it('S-WS2：workerStateSchema 缺 held_batches → 抛 ZodError（M-1 guard）', () => {
      // held_batches 是顶层 8 字段之一，必须显式声明。漏列会让后端真返回的
      // held_batches 在前端拿不到（WorkerColumn 的 held 列表退化为空 + UI 不报错）。
      expect(() =>
        workerStateSchema.parse({
          worker_id: '1900000000001',
          worker_name: '张三',
          work_type_code: 'CNC',
          max_held: 3,
          current_held: 1,
          capacity_remaining: 2,
          pool_count_by_process: [],
          // held_batches 缺
        }),
      ).toThrow();
    });

    // ===== 2026-09-30：move / refill / dispatch / auto-dispatch-preview 新 schema =====

    it('S-MV1：moveRequestSchema 接受 POOL→WORKER（tagged enum from/to）', () => {
      const parsed = moveRequestSchema.parse({
        batch_id: '3000000000001',
        from: { kind: 'POOL', shelf_id: '5000000000001' },
        to: { kind: 'WORKER', worker_id: '1900000000001' },
      });
      expect(parsed.from.kind).toBe('POOL');
      expect(parsed.to.kind).toBe('WORKER');
    });

    it('S-MV2：moveRequestSchema 接受 WORKER→POOL（撤回方向）', () => {
      const parsed = moveRequestSchema.parse({
        batch_id: '3000000000001',
        from: { kind: 'WORKER', worker_id: '1900000000001' },
        to: { kind: 'POOL', shelf_id: '5000000000001' },
        note: '退换料',
      });
      expect(parsed.from.kind).toBe('WORKER');
      expect(parsed.note).toBe('退换料');
    });

    it('S-MV3：moveRequestSchema 缺 from.shelf_id → 抛 ZodError（POOL 分支必填）', () => {
      // 后端 MoveLocation::Pool { shelf_id } 是必填 i64（deserialize_i64）。
      // 缺它前端就构造不出合法请求 —— schema 提前炸出来。
      expect(() =>
        moveRequestSchema.parse({
          batch_id: '3000000000001',
          from: { kind: 'POOL' },
          to: { kind: 'WORKER', worker_id: '1900000000001' },
        }),
      ).toThrow();
    });

    it('S-MV4：moveRequestSchema kind 值非法 → 抛 ZodError（只认 POOL / WORKER）', () => {
      expect(() =>
        moveRequestSchema.parse({
          batch_id: '3000000000001',
          from: { kind: 'SHELF', shelf_id: '5000000000001' },
          to: { kind: 'WORKER', worker_id: '1900000000001' },
        }),
      ).toThrow();
    });

    it('S-MV5：moveResultSchema 解析 POOL→WORKER 完整响应', () => {
      // backend-rust MoveResult（vo/worker_pool.rs:126-152）
      const parsed = moveResultSchema.parse({
        batch_id: '3000000000001',
        from_kind: 'POOL',
        to_kind: 'WORKER',
        new_holder_id: '1900000000001',
        new_location: 'WORKER',
        version: 2,
        current_held: 2,
        max_held: 3,
        taken: {
          batch_id: '3000000000001',
          part_id: '4000000000001',
          batch_no: 1,
          quantity: 5,
          serial_no: null,
          drawing_no: 'DWG-A001',
          system_delivery_date: '2026-09-30',
          planned_delivery_date: null,
          is_urgent: false,
          version: 2,
          has_cnc_program: true,
        },
      });
      expect(parsed.to_kind).toBe('WORKER');
      expect(parsed.current_held).toBe(2);
      expect(parsed.taken?.batch_no).toBe(1);
    });

    it('S-MV6：moveResultSchema 四可选字段全部缺失 → 不抛 ZodError（skip_serializing_if）', () => {
      // backend-rust 对 current_held / max_held / shelf_id / taken 四个字段都加了
      // `#[serde(skip_serializing_if = "Option::is_none")]` ⇒ 条件不满足时**整个字段
      // 从 JSON 中省略**（不是 null）。schema 用 .nullish() 同时兜 undefined / null。
      const parsed = moveResultSchema.parse({
        batch_id: '3000000000001',
        from_kind: 'WORKER',
        to_kind: 'POOL',
        new_holder_id: '5000000000001',
        new_location: 'PRODUCTION_SHELF',
        version: 3,
      });
      expect(parsed.shelf_id).toBeUndefined();
      expect(parsed.taken).toBeUndefined();
      expect(parsed.current_held).toBeUndefined();
    });

    it('S-MV7：moveResultSchema 四可选字段显式为 null → 接受', () => {
      const parsed = moveResultSchema.parse({
        batch_id: '3000000000001',
        from_kind: 'WORKER',
        to_kind: 'POOL',
        new_holder_id: '5000000000001',
        new_location: 'PRODUCTION_SHELF',
        version: 3,
        current_held: null,
        max_held: null,
        shelf_id: '5000000000001',
        taken: null,
      });
      expect(parsed.shelf_id).toBe('5000000000001');
      expect(parsed.taken).toBeNull();
    });

    it('S-MV8：moveResultSchema 缺 new_holder_id → 抛 ZodError（M-1 guard）', () => {
      expect(() =>
        moveResultSchema.parse({
          batch_id: '3000000000001',
          from_kind: 'POOL',
          to_kind: 'WORKER',
          new_location: 'WORKER',
          version: 2,
        }),
      ).toThrow();
    });

    it('S-MV9：takenItemSchema / refillResultSchema 解析 refill 响应', () => {
      const r = refillResultSchema.parse({
        worker_id: '1900000000001',
        shelf_id: '5000000000001',
        taken: [
          {
            batch_id: '3000000000001',
            part_id: '4000000000001',
            batch_no: 1,
            quantity: 5,
            serial_no: null,
            drawing_no: 'DWG-A001',
            system_delivery_date: null,
            planned_delivery_date: null,
            is_urgent: false,
            version: 2,
            has_cnc_program: false,
          },
        ],
        pool_empty: false,
      });
      expect(r.taken).toHaveLength(1);
      expect(r.pool_empty).toBe(false);
    });

    it('S-MV10：takenItemSchema 缺 has_cnc_program → 抛 ZodError（M-1 guard）', () => {
      // 后端 TakenItem.has_cnc_program 带 `#[serde(default)]` 但仍会序列化，
      // 漏返说明契约漂移，必须炸。
      const base: Record<string, unknown> = {
        batch_id: '3000000000001',
        part_id: '4000000000001',
        batch_no: 1,
        quantity: 5,
        serial_no: null,
        drawing_no: 'DWG',
        system_delivery_date: null,
        planned_delivery_date: null,
        is_urgent: false,
        version: 1,
      };
      expect(() => takenItemSchema.parse(base)).toThrow();
    });

    it('S-DP1：dispatchRequestSchema 接受 targets 数组（bulk-only 形态）', () => {
      const parsed = dispatchRequestSchema.parse({
        targets: [
          { batch_id: '3000000000001', target_process_id: '2000000000001' },
          { batch_id: '3000000000002', target_process_id: '2000000000002' },
        ],
        note: '批量下发',
      });
      expect(parsed.targets).toHaveLength(2);
    });

    it('S-DP2：dispatchRequestSchema 空 targets → 抛 ZodError（后端返 40001 / 422）', () => {
      expect(() => dispatchRequestSchema.parse({ targets: [] })).toThrow();
    });

    it('S-DP3：dispatchResultSchema 解析 succeeded[] + failed[]', () => {
      const parsed = dispatchResultSchema.parse({
        succeeded: [
          {
            batch_id: '3000000000001',
            current_process_step_id: null,
            target_process_id: '2000000000001',
            shelf_id: '5000000000001',
            version: 2,
          },
        ],
        failed: [],
      });
      expect(parsed.succeeded).toHaveLength(1);
      // dispatch 路径不解析 step → current_process_step_id 恒 null
      expect(parsed.succeeded[0]?.current_process_step_id).toBeNull();
      expect(parsed.failed).toEqual([]);
    });

    it('S-DP4：dispatchResultSchema 缺 failed 字段 → 默认为 []（skip_serializing_if 兜底）', () => {
      // backend-rust DispatchResult.failed 带 `skip_serializing_if = "Vec::is_empty"`
      // ⇒ 成功时该字段从 JSON 中整体省略。前端 .default([]) 兜住，
      // 避免 `res.failed.length` 抛 undefined。
      const parsed = dispatchResultSchema.parse({
        succeeded: [
          {
            batch_id: '3000000000001',
            current_process_step_id: null,
            target_process_id: '2000000000001',
            shelf_id: '5000000000001',
            version: 2,
          },
        ],
      });
      expect(parsed.failed).toEqual([]);
    });

    it('S-DP5：dispatchSuccessItemSchema 缺 shelf_id → 抛 ZodError（M-1 guard）', () => {
      // shelf_id 由 service 按 target_process_id 在 t_shelf_process 解析
      // （sort_order ASC LIMIT 1）—— 缺它说明后端解析失败，应立刻炸出来。
      expect(() =>
        dispatchSuccessItemSchema.parse({
          batch_id: '3000000000001',
          current_process_step_id: null,
          target_process_id: '2000000000001',
          version: 2,
        }),
      ).toThrow();
    });

    it('S-DP6：autoDispatchRequestSchema 空 batch_ids → 抛 ZodError（后端 40001 / 422）', () => {
      expect(() => autoDispatchRequestSchema.parse({ batch_ids: [] })).toThrow();
    });

    it('S-DP7：autoDispatchResultSchema 解析只读 preview（items[] 全字段）', () => {
      const parsed = autoDispatchResultSchema.parse({
        items: [
          {
            batch_id: '3000000000001',
            part_id: '4000000000001',
            process_chain_id: '6000000000001',
            first_process_id: '2000000000001',
            first_process_code: 'P-AUTO-1',
            first_process_name: '首道工序',
            first_shelf_id: '5000000000001',
            skip_reason: null,
          },
        ],
      });
      expect(parsed.items).toHaveLength(1);
      expect(parsed.items[0]?.skip_reason).toBeNull();
      expect(parsed.items[0]?.first_process_id).toBe('2000000000001');
    });

    it('S-DP8：autoDispatchItemSchema skip 场景（三个 Option<i64> 字段为 null）', () => {
      // NO_PROCESS_CHAIN：process_chain_id / first_process_id / first_shelf_id
      // 三个字段全为 null；first_process_code / first_process_name 是非 Option
      // String，后端 unwrap_or_default() 兜空串（service.rs:289-290）。
      const parsed = autoDispatchResultSchema.parse({
        items: [
          {
            batch_id: '3000000000001',
            part_id: '4000000000001',
            process_chain_id: null,
            first_process_id: null,
            first_process_code: '',
            first_process_name: '',
            first_shelf_id: null,
            skip_reason: 'NO_PROCESS_CHAIN',
          },
        ],
      });
      expect(parsed.items[0]?.process_chain_id).toBeNull();
      expect(parsed.items[0]?.first_process_code).toBe('');
      expect(parsed.items[0]?.skip_reason).toBe('NO_PROCESS_CHAIN');
    });

    it('S-DP9：autoDispatchItemSchema NO_SHELF 场景（first_process_id 仍非 null）', () => {
      // backend-rust AutoDispatchItem 字段注释：NO_SHELF 时首道工序存在但未映射
      // 货架 ⇒ first_process_id 仍 Some，first_shelf_id 为 null。
      const parsed = autoDispatchResultSchema.parse({
        items: [
          {
            batch_id: '3000000000001',
            part_id: '4000000000001',
            process_chain_id: '6000000000001',
            first_process_id: '2000000000001',
            first_process_code: 'P-AUTO-1',
            first_process_name: '首道工序',
            first_shelf_id: null,
            skip_reason: 'NO_SHELF',
          },
        ],
      });
      expect(parsed.items[0]?.first_process_id).toBe('2000000000001');
      expect(parsed.items[0]?.first_shelf_id).toBeNull();
      expect(parsed.items[0]?.skip_reason).toBe('NO_SHELF');
    });

    it('S-DP10：autoDispatchResultSchema 缺 items → 抛 ZodError（M-1 guard）', () => {
      expect(() => autoDispatchResultSchema.parse({})).toThrow();
    });
  });

  // 2026-09-30 新增：品检待办 inspection 行 / 列表 schema 守门（与
  // assemblyDetailFlatSchema S15-S17 strict() guard 同形态）。
  describe('inspectionBatchListItemSchema（2026-09-30 新增）', () => {
    const validItem = {
      // 批次字段段
      batch_id: '3000000000001',
      batch_no: 1,
      quantity: 5,
      status: 'INSPECTION',
      // 2026-10-02 契约对齐：后端 vo/inspection.rs:44 恒输出该键
      is_repairing: false,
      location: 'INSPECTION_SHELF',
      version: 2,
      current_process_step_id: '7000000000001',
      parent_batch_id: null,
      // holder 解析段
      current_holder_id: '5000000000001',
      holder_name: '品检A-01',
      next_process_id: null,
      next_process_name: null,
      // delivery_note 解析段
      delivery_note_id: null,
      delivery_note_no: null,
      // 工单字段段（t_part）
      part_id: '4000000000001',
      serial_no: 'SN-2026-001',
      drawing_no: 'DWG-A001',
      name: '零件A',
      order_no: 'PO-2026-001',
      planned_delivery_date: '2026-10-01',
      is_urgent: false,
      part_version: 1,
      created_at: '2026-09-30 10:00:00',
      updated_at: '2026-09-30 11:00:00',
      // 客户解析段
      customer_id: '9000000000001',
      customer_name: '客户A-子',
      l1_customer_name: '客户A',
    };

    it('S20：解析 backend-rust InspectionBatchListItemOut 完整 28 字段不抛错', () => {
      const parsed = inspectionBatchListItemSchema.parse(validItem);
      expect(parsed.batch_id).toBe('3000000000001');
      expect(parsed.part_id).toBe('4000000000001');
      expect(parsed.holder_name).toBe('品检A-01');
      expect(parsed.l1_customer_name).toBe('客户A');
      expect(parsed.customer_name).toBe('客户A-子');
      // 显式无 `id` 字段
      expect((parsed as Record<string, unknown>).id).toBeUndefined();
    });

    it('S21：inspectionBatchListResultSchema 接受分页结构（items/total/limit/offset）', () => {
      // 2026-09-30 review 第 1 轮修复：后端 total / limit / offset 用
      // serialize_i64 序列化为 JSON string（与雪花 ID 一致的设计），前端
      // schema 必须按 wire-format 用 z.string() 接收；用 number 会被 Zod
      // 拒绝。本测试用 string case 守门防止 schema 退回到 z.number()。
      const parsed = inspectionBatchListResultSchema.parse({
        items: [validItem],
        total: '1',
        limit: '20',
        offset: '0',
      });
      expect(parsed.items).toHaveLength(1);
      expect(parsed.total).toBe('1');
      expect(parsed.limit).toBe('20');
      expect(parsed.offset).toBe('0');
    });

    it('S22：inspectionBatchListItemSchema 多出 id 字段 → 抛 ZodError（.strict() 守门）', () => {
      // backend-rust InspectionBatchListItemOut 不带 id；前端旧实现误用 PartItem 类型
      // 以为有 id 是 2026-09-30 `/parts/undefined` bug 的根因。.strict() 锁死
      // 「后端若误把 id 加进响应立刻抛错」，防止回归。
      expect(() =>
        inspectionBatchListItemSchema.parse({ ...validItem, id: '4000000000001' }),
      ).toThrow();
    });

    it('S23：inspectionBatchListItemSchema 缺 part_id → 抛 ZodError（M-1 guard）', () => {
      // part_id 是详情跳转（`/parts/${part_id}`）与 onConfirm API 入参的锚字段，
      // 缺它说明契约漂移，必须立刻炸（与 partSchema S12 缺 unit_price 同形态）。
      const { part_id: _omit, ...rest } = validItem;
      void _omit;
      expect(() => inspectionBatchListItemSchema.parse(rest)).toThrow();
    });

    it('S23b（2026-10-02 regression guard）：is_repairing = true 也能 parse（不得锁成字面量 false）', () => {
      // 「待品检」整页白屏的根因守卫：2026-10-01 后端 M5（migration 005）把 `REPAIRING`
      // 降级为 `t_part_batch.is_repairing` 标记列，vo/inspection.rs:44 **恒定**输出该
      // 键。schema 漏声明 ⇒ .strict() 抛 unrecognized_keys ⇒ 一页里只要有一行是
      // 返修批次就整页 parse 失败（zod 把数组内所有失败项汇成单个 ZodError）。
      // 本用例锁死两件事：
      //   ① true 必须能过 —— 防止有人「先写 z.literal(false) 消警告」把真实数据挡掉；
      //   ② 字段被显式保留在 parse 结果里（Zod 默认 strip 会让**已声明**字段也只在
      //      schema 声明后才留下，删声明 ⇒ 下面两行断言同时变 undefined 而变红）。
      const parsed = inspectionBatchListItemSchema.parse({ ...validItem, is_repairing: true });
      expect(parsed.is_repairing).toBe(true);
      expect(parsed.status).toBe('INSPECTION');
      // 缺 is_repairing 同样必须抛错：后端恒输出，缺失即契约漂移。
      const { is_repairing: _omit, ...rest } = validItem;
      void _omit;
      expect(() => inspectionBatchListItemSchema.parse(rest)).toThrow();
    });
  });
});

// ============================================================
// 2026-10-01 新增：待编程一览（prod 域 programming）+ 货架（shelves）schema 断言。
//
// 数据来源：
//   - backend-rust `src/modules/prod/programming/mod.rs` 的
//     `GET /api/v2/prod/programming/pending`（ProgrammingItem 13 字段 +
//     ProgrammingListOut 4 字段；「待编程一览」页数据源，替代恒返空的
//     part 域 /parts/pending-programming）。
//   - @/types/shelf.ts::Shelf 10 字段（货架列表 GET /api/v2/shelves，
//     共享基础数据层 useProductionShelvesQuery 守门；2026-10-02 起
//     account_count 随「用户决定货架列表页不再展示账号数」一并摘除，
//     后端 ShelfOut 在同 PR 也已删该字段，属另一次独立决策）。
//
// 覆盖：
//   - S24：pendingProgrammingItemSchema 接受完整 13 字段不抛错；客户字段是
//     parent_customer_name(L1) / customer_name(L2)，与 part 域 l1_customer_name
//     不同名（本用例把 parent_customer_name 写满并断言读出，防回归成 l1_*）。
//   - S25：pendingProgrammingItemSchema 缺 has_cnc_program → 抛 ZodError
//     （M-1 strip regression guard —— 该字段是本页 Tab 化的唯一依据，
//     静默 strip 会让「已编程 / 未编程」列恒显示错值且不报错）。
//   - S26：pendingProgrammingItemSchema 缺 version → 抛 ZodError（同源 guard）。
//   - S27：pendingProgrammingItemSchema 的 id 传 number → 抛 ZodError
//     （雪花 ID 一律 string，JS Number 会丢精度 —— CLAUDE.md §3）。
//   - S28：pendingProgrammingListResultSchema 接受分页 4 字段；缺 items → 抛错。
//   - S29：shelfSchema 接受完整 10 字段（zone=PRODUCTION / location=null）。
//   - S30：shelfSchema 缺 zone → 抛 ZodError（M-1 同形态 guard；2026-10-02 起
//     guard 字段从 account_count 换成 zone —— 前者随「用户决定不再展示账号数」
//     摘除，但「必填字段缺失必须报错」这个设计意图不变，不能跟着删用例）；
//     shelfListResultSchema 缺 items → 抛 ZodError。
// ============================================================
describe('2026-10-01 新增：programming / shelves schema 契约断言', () => {
  const validProgrammingItem = {
    id: '190000000000099',
    version: 3,
    serial_no: 'SN-001',
    name: '法兰盘',
    drawing_no: 'DWG-A001',
    quantity: 5,
    status: 'PROGRAMMING',
    is_urgent: true,
    planned_delivery_date: '2026-10-10',
    system_delivery_date: null,
    customer_name: '客户A-子',
    parent_customer_name: '客户A',
    has_cnc_program: false,
  };

  const validShelf = {
    id: '8800000000001',
    version: 2,
    code: 'SH-P01',
    name: '生产架 01',
    zone: 'PRODUCTION',
    location: null,
    is_active: true,
    // 2026-10-02 摘除 account_count（用户决定货架列表页不再展示账号数），本 fixture 已是 10 字段。
    display_order: 1,
    created_at: '2026-09-01 10:00:00',
    updated_at: '2026-09-30 11:00:00',
  };

  it('S24：pendingProgrammingItemSchema 接受完整 13 字段（客户字段是 parent_customer_name）', () => {
    const parsed = pendingProgrammingItemSchema.parse(validProgrammingItem);
    expect(parsed.id).toBe('190000000000099');
    expect(parsed.version).toBe(3);
    expect(parsed.has_cnc_program).toBe(false);
    // 客户：L1 = parent_customer_name / L2 = customer_name（不是 l1_customer_name）
    expect(parsed.parent_customer_name).toBe('客户A');
    expect(parsed.customer_name).toBe('客户A-子');
    expect((parsed as Record<string, unknown>).l1_customer_name).toBeUndefined();
  });

  it('S25：pendingProgrammingItemSchema 缺 has_cnc_program → 抛 ZodError（M-1 guard）', () => {
    const { has_cnc_program: _omit, ...rest } = validProgrammingItem;
    void _omit;
    expect(() => pendingProgrammingItemSchema.parse(rest)).toThrow();
  });

  it('S26：pendingProgrammingItemSchema 缺 version → 抛 ZodError（M-1 guard）', () => {
    const { version: _omit, ...rest } = validProgrammingItem;
    void _omit;
    expect(() => pendingProgrammingItemSchema.parse(rest)).toThrow();
  });

  it('S27：pendingProgrammingItemSchema 的 id 传 number → 抛 ZodError（雪花 ID 必须 string）', () => {
    expect(() =>
      pendingProgrammingItemSchema.parse({ ...validProgrammingItem, id: 190000000000099 }),
    ).toThrow();
  });

  it('S28：pendingProgrammingListResultSchema 接受分页 4 字段；缺 items → 抛 ZodError', () => {
    const parsed = pendingProgrammingListResultSchema.parse({
      items: [validProgrammingItem],
      total: 1,
      limit: 20,
      offset: 0,
    });
    expect(parsed.items).toHaveLength(1);
    expect(parsed.total).toBe(1);
    expect(() =>
      pendingProgrammingListResultSchema.parse({ total: 1, limit: 20, offset: 0 }),
    ).toThrow();
  });

  it('S29：shelfSchema 接受完整 10 字段（zone=PRODUCTION / location=null）', () => {
    const parsed = shelfSchema.parse(validShelf);
    expect(parsed.id).toBe('8800000000001');
    expect(parsed.zone).toBe('PRODUCTION');
    expect(parsed.location).toBeNull();
    expect(parsed.is_active).toBe(true);
    expect(parsed.display_order).toBe(1);
  });

  it('S30：shelfSchema 缺 zone → 抛 ZodError；shelfListResultSchema 缺 items → 抛 ZodError', () => {
    // 2026-10-02：原 guard 字段 account_count 随「用户决定不再展示账号数」摘除，
    // 换成同为必填的 zone 继续守「必填字段缺失必须抛 ZodError」这条设计意图
    // （CLAUDE.md 架构条目 §4「Zod 默认 strip 模式会让缺字段静默丢弃」的
    // regression guard）。
    const { zone: _omit, ...rest } = validShelf;
    void _omit;
    expect(() => shelfSchema.parse(rest)).toThrow();
    expect(() => shelfListResultSchema.parse({ total: 1, limit: 200, offset: 0 })).toThrow();
    const list = shelfListResultSchema.parse({
      items: [validShelf],
      total: 1,
      limit: 200,
      offset: 0,
    });
    expect(list.items[0]?.code).toBe('SH-P01');
  });
});
