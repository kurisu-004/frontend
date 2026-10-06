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
//   - S15c（partSchema 系列）：has_cnc_program = false 也能 parse。
//   - S15d~S15f（2026-10-05 新增，partSchema 系列）：assembly_id 接受 null（独立
//     零件行）/ 父装配件 id 字符串（装配件子件行）/ 缺键也 parse 得过（GET /parts 家族
//     不填该列 ⇒ 该键 optional 而非必填）—— 该键在 union-list 的 wire 上恒在，
//     漏声明会被 zod strip 静默丢弃。
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
//   - S20（2026-09-30 新增，2026-10-03 随改名跟进）：repairBatchListItemSchema 接受
//     backend-rust `InspectionBatchListItemOut` 完整 28 字段结构（批次 9 + holder 4 +
//     delivery_note 2 + 工单 10 + 客户 3，含 l1_customer_name 与 holder_name），
//     不抛错。**服务对象已收窄为仅** `GET /prod/batches/repair` / `/repairing`
//     两条返修端点（待品检端点换成 13 字段精简 VO，其守门用例在
//     `views/inspection/composables/__tests__/inspectionSchema.spec.ts` 的 I 系列）。
//   - S21：repairBatchListResultSchema 接受分页结构（items / total / limit /
//     offset）。
//   - S22：repairBatchListItemSchema 多出 `id` 字段 → 抛 ZodError（`.strict()`
//     守门：regression guard — 后端若误把 id 字段加进返修响应，schema
//     立刻抛错而非默认 strip 静默丢）。
//   - S23：repairBatchListItemSchema 缺 part_id → 抛 ZodError（M-1 同形态
//     guard：缺核心字段静默 strip = 校验形同虚设）。
//   - S23b（2026-10-02 新增 regression guard）：is_repairing = true 也能 parse
//     （不得被人「先写 z.literal(false) 消警告」把真实返修数据挡掉），且缺
//     is_repairing 必抛错（后端恒输出该键）。
//   - S-SP1（2026-10-04 新增，报工台）：scanPartRowSchema 接受后端 `PartListItem`
//     完整 34 字段（含 `location` / `holder_name` 等恒 null 的派生键与
//     `batch_id` / `batch_version` 批次锚点），不抛错。
//   - S-SP2：`planned_delivery_date` / `request_date` 的后端占位符 `'1970-01-01'`
//     被 transform 归一成 `null`（否则报工台三页会显示「已逾期 2 万多天」红字），
//     其它日期字符串原样透传。
//   - S-SP3：缺 `batch_id` / `batch_version` / `location` 任一 → 抛 ZodError
//     （M-1 guard 的核心：这三个键被 strip 掉的后果分别是取件报「批次锚点缺失」、
//     报工台卡片少一行 holder 信息，且都不报错）。
//   - S-SP4：scanPartListResultSchema 是**分页信封** —— 接受 items / total / limit /
//     offset；把裸数组喂进去抛错（这正是本次线上故障的形态）。
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
  repairBatchListItemSchema,
  repairBatchListResultSchema,
  shelfSchema,
  shelfListResultSchema,
  scanPartRowSchema,
  scanPartListResultSchema,
  outsourcePoolCountsSchema,
  outsourcePoolCountsResultSchema,
  outsourcePoolCompanySchema,
  outsourcePoolByProcessSchema,
  outsourcePoolByProcessResultSchema,
  outsourcePoolStateSchema,
  outsourcePoolStateResultSchema,
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

    // 2026-10-05 新增：assembly_id 守门用例。wire 上 union-list 的 PART / PART_FLAT
    // 段恒返该键（独立零件为 null、子件为父装配件 id 字符串），zod 默认 strip 漏列它
    // 时 parse 不报错、后续消费者以为「所有行都没有父装配件」—— 故必须显式声明。
    it('S15d：assembly_id = null 是合法值（独立零件行）', () => {
      const parsed = partSchema.parse({ ...makeBasePart(), assembly_id: null });
      expect(parsed.assembly_id).toBeNull();
    });

    it('S15e：assembly_id = 父装配件 id 字符串是合法值（装配件子件行）', () => {
      const parsed = partSchema.parse({ ...makeBasePart(), assembly_id: '190000000000001' });
      expect(parsed.assembly_id).toBe('190000000000001');
    });

    it('S15f：输入缺 assembly_id 时仍 parse 成功（该键是 optional 而非必填）', () => {
      // 复用同一 VO 的 GET /parts 家族不填该列，声明成必填会让那一族接口在前端
      // parse 阶段全炸。故本条只钉「缺键不抛」。这里**不**写
      // expect(parsed.assembly_id).toBeUndefined() —— 键未声明时 zod strip 同样给出
      // undefined，两种实现都会过，是伪守卫。「键确实被声明」由 S15d / S15e 负责
      // （给了值就原样往返，未声明会被 strip 丢成 undefined，那两条会红）。
      expect(makeBasePart()).not.toHaveProperty('assembly_id');
      expect(() => partSchema.parse(makeBasePart())).not.toThrow();
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
      // 守门到位。WorkerQueueBoard 的 held 列与 pool 列共用 BatchCard 渲染
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
      // 后端若漏返 boolean 字段，Zod parse 立刻抛错，BatchCard 的「已编程」tag
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
      // backend-rust `MoveResult`（vo/worker_pool.rs）
      // 2026-10-03 补齐：POOL→WORKER 方向后端**也会**填 shelf_id（值 = 请求里的
      // from.shelf_id），且必须是字符串（雪花 ID 走字符串序列化器）；本 fixture 与
      // 断言把它锁成契约 —— 缺字段或序列化成 number 都会让本用例红。
      const parsed = moveResultSchema.parse({
        batch_id: '3000000000001',
        from_kind: 'POOL',
        to_kind: 'WORKER',
        new_holder_id: '1900000000001',
        new_location: 'WORKER',
        version: 2,
        current_held: 2,
        max_held: 3,
        shelf_id: '5000000000001',
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
      expect(parsed.shelf_id).toBe('5000000000001');
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

    it('S-MV10：moveResultSchema shelf_id 为 number → 抛 ZodError（ID 契约只走字符串序列化器）', () => {
      // 2026-10-03 锁死「shelf_id 只接受字符串」这个决定，防止日后有人为了「兼容」
      // 把 schema 放宽成同时接受 number：
      //   1. 货架雪花 ID 是 18~19 位，远超 Number.MAX_SAFE_INTEGER（2^53-1）；
      //   2. 后端一旦序列化成 JSON number，浏览器 JSON.parse 在读到它的那一刻精度就
      //      永久丢了 —— 前端拿到的是四舍五入后的错值，不是原 ID（下面这个字面量在
      //      JS 里就已经是丢过精度的值，说的就是这件事）；
      //   3. 所以放宽成 union 只会把一个静默损坏的 ID 焊进类型系统，比直接抛错更危险
      //      —— 抛错至少让契约漂移立刻可见。
      // 正确做法是后端把 ID 序列化成字符串。
      expect(() =>
        moveResultSchema.parse({
          batch_id: '3000000000001',
          from_kind: 'POOL',
          to_kind: 'WORKER',
          new_holder_id: '1900000000001',
          new_location: 'WORKER',
          version: 2,
          current_held: 2,
          max_held: 3,
          // eslint-disable-next-line @typescript-eslint/no-loss-of-precision -- 故意写超 MAX_SAFE_INTEGER 的字面量，演示 number 形态必然丢精度
          shelf_id: 1590000000000000001,
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
        }),
      ).toThrow(/shelf_id/);
    });

    it('S-MV11：takenItemSchema 缺 has_cnc_program → 抛 ZodError（M-1 guard）', () => {
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

  // 2026-09-30 新增（2026-10-03 随 VO 分家改名）：返修集合读行 / 列表 schema
  // 守门（与 assemblyDetailFlatSchema S15-S17 strict() guard 同形态）。
  describe('repairBatchListItemSchema（2026-09-30 新增 / 2026-10-03 改名）', () => {
    const validItem = {
      // 批次字段段
      batch_id: '3000000000001',
      batch_no: 1,
      quantity: 5,
      status: 'DELIVERED',
      // 后端恒输出该键（REPAIRING 状态已降级为 boolean 标记列）
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
      const parsed = repairBatchListItemSchema.parse(validItem);
      expect(parsed.batch_id).toBe('3000000000001');
      expect(parsed.part_id).toBe('4000000000001');
      expect(parsed.holder_name).toBe('品检A-01');
      expect(parsed.l1_customer_name).toBe('客户A');
      expect(parsed.customer_name).toBe('客户A-子');
      // 显式无 `id` 字段
      expect((parsed as Record<string, unknown>).id).toBeUndefined();
    });

    it('S21：repairBatchListResultSchema 接受分页结构（items/total/limit/offset）', () => {
      // 2026-09-30 review 第 1 轮修复：后端 total / limit / offset 用
      // serialize_i64 序列化为 JSON string（与雪花 ID 一致的设计），前端
      // schema 必须按 wire-format 用 z.string() 接收；用 number 会被 Zod
      // 拒绝。本测试用 string case 守门防止 schema 退回到 z.number()。
      const parsed = repairBatchListResultSchema.parse({
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

    it('S22：repairBatchListItemSchema 多出 id 字段 → 抛 ZodError（.strict() 守门）', () => {
      // backend-rust InspectionBatchListItemOut 不带 id；前端旧实现误用 PartItem 类型
      // 以为有 id 是 2026-09-30 `/parts/undefined` bug 的根因。.strict() 锁死
      // 「后端若误把 id 加进响应立刻抛错」，防止回归。
      expect(() =>
        repairBatchListItemSchema.parse({ ...validItem, id: '4000000000001' }),
      ).toThrow();
    });

    it('S23：repairBatchListItemSchema 缺 part_id → 抛 ZodError（M-1 guard）', () => {
      // part_id 是详情跳转（`/parts/${part_id}`）与 onConfirm API 入参的锚字段，
      // 缺它说明契约漂移，必须立刻炸（与 partSchema S12 缺 unit_price 同形态）。
      const { part_id: _omit, ...rest } = validItem;
      void _omit;
      expect(() => repairBatchListItemSchema.parse(rest)).toThrow();
    });

    it('S23b（2026-10-02 regression guard）：is_repairing = true 也能 parse（不得锁成字面量 false）', () => {
      // 「返修中」判据漂移的守卫：2026-10-01 后端（migration 005）把 `REPAIRING`
      // 降级为 `t_part_batch.is_repairing` 标记列，VO **恒定**输出该
      // 键。schema 漏声明 ⇒ .strict() 抛 unrecognized_keys ⇒ 一页里只要有一行是
      // 返修批次就整页 parse 失败（zod 把数组内所有失败项汇成单个 ZodError）。
      // 本用例锁死两件事：
      //   ① true 必须能过 —— 防止有人「先写 z.literal(false) 消警告」把真实数据挡掉；
      //   ② 字段被显式保留在 parse 结果里（Zod 默认 strip 会让**已声明**字段也只在
      //      schema 声明后才留下，删声明 ⇒ 下面两行断言同时变 undefined 而变红）。
      const parsed = repairBatchListItemSchema.parse({ ...validItem, is_repairing: true });
      expect(parsed.is_repairing).toBe(true);
      // 标记与 status **正交**：`/prod/batches/repairing` 的判据是 is_repairing=true，
      // 此时 status 恒为 IN_PROCESS；schema 不得把两者绑在一起。
      expect(parsed.status).toBe('DELIVERED');
      // 缺 is_repairing 同样必须抛错：后端恒输出，缺失即契约漂移。
      const { is_repairing: _omit, ...rest } = validItem;
      void _omit;
      expect(() => repairBatchListItemSchema.parse(rest)).toThrow();
    });
  });
});

// ============================================================
// 货架（shelves）schema 契约断言。
//
// 数据来源：
//   - @/types/shelf.ts::Shelf 10 字段（货架列表 GET /api/v2/shelves，
//     共享基础数据层 useProductionShelvesQuery 守门；2026-10-02 起
//     account_count 随「用户决定货架列表页不再展示账号数」一并摘除，
//     后端 ShelfOut 在同 PR 也已删该字段，属另一次独立决策）。
//
// 覆盖：
//   - S29：shelfSchema 接受完整 10 字段（zone=PRODUCTION / location=null）。
//   - S30：shelfSchema 缺 zone → 抛 ZodError（M-1 同形态 guard；2026-10-02 起
//     guard 字段从 account_count 换成 zone —— 前者随「用户决定不再展示账号数」
//     摘除，但「必填字段缺失必须报错」这个设计意图不变，不能跟着删用例）；
//     shelfListResultSchema 缺 items → 抛 ZodError。
// ============================================================
describe('货架（shelves）schema 契约断言', () => {
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

// ============================================================
// 2026-10-03 新增：外协看板 pool 域 3 个只读端点的 schema 守门断言。
//
// 数据来源：后端 outsource-pool 域的端点契约（`GET /outsource-pool/counts` /
// `GET /outsource-pool/{process_id}` / `GET /outsource-pool/state`）—— 3 个端点响应
// 都是**裸对象**（无分页信封），与上面 4 个 outsource list 端点不同构，故独立成组。
// 该域后端代码属并行任务、尚未合入本仓，故本组断言只能证明「fixture ↔ schema」自洽，
// 不能证明「schema ↔ 后端实现」已核验；后者待后端合入后逐字重核一次。
//
// 覆盖：
//   - S-OP1~4：counts（5 字段行 + 4 字段顶层）。
//   - S-OP5~10：by-process（22 字段行 + 6 字段顶层 + 公司列 3 字段）。
//   - S-OP11~17：state（21 字段行 + 5 字段顶层）。
//   - S-OP18：两个恒定字面量字段（status_label / location）锁死。
//   - S-OP19~21：三个**顶层** result schema 的键集断言（与 S-OP2 / S-OP6 / S-OP12 同款）。
//   - S-OP22：公司列行（`outsourcePoolCompanySchema`，3 字段）的键集断言（同款）。
//
// 本组的三条硬约定（每条都有专门的「反例必须抛错」用例锁住）：
//   ① 雪花 i64 全字段 `z.string()`（裸数字必被拒）—— JS Number 会丢精度；
//   ② Decimal / datetime 全字段 `z.string()`（数字必被拒）；
//   ③ `receive_next_process_id` **非 nullable**，`null` 必被拒（后端 `.unwrap_or(0)`
//      兜底成 `"0"`，写成 `.nullable()` 会把合法响应当契约漂移整列炸掉）。
//
// 守门有效性的核心断言在 S-OP2 / S-OP6 / S-OP12 / S-OP22（4 个行 schema）与 S-OP19 /
// S-OP20 / S-OP21（3 个顶层）：「parse 后键集 == fixture 键集」+「fixture 字段数 ==
// 后端 VO 字段数」。
// Zod 默认 strip 会把 schema 没声明的键静默吞掉、parse 照过不误 —— 漏声明一个字段除了
// 那一个键消失没有任何症状，只有键集断言能发现；反向（schema 多声明一个带 `.default()`
// 的字段，键被补进 parse 结果）同样只有键集断言能发现。
// ============================================================
describe('2026-10-03 新增：外协看板 pool 域 schema 契约断言', () => {
  /** `GET /outsource-pool/counts` 单行（5 字段）。 */
  const poolCountFixture = {
    process_id: '2000000000001',
    process_code: 'OUT-01',
    process_name: '外协粗加工',
    sendable_count: 4,
    in_flight_count: 2,
  };

  /** `GET /outsource-pool/{process_id}` 的候选批次行（22 字段，APPROVAL 形态）。 */
  const poolItemFixture = {
    version: 3,
    send_mode: 'APPROVAL',
    source_status: 'IN_PROCESS',
    part_id: '4000000000001',
    part_serial_no: 'SN-001',
    part_drawing_no: 'DWG-A001',
    part_name: '法兰盘',
    quantity: 10,
    batch_id: '3000000000001',
    batch_no: 1,
    batch_quantity: 10,
    planned_delivery_date: '2026-10-20',
    is_urgent: true,
    customer_path: '一级客户 / 二级客户',
    shelf_code: 'C2',
    outsource_company_id: '9000000000001',
    outsource_company_name: '外协厂甲',
    quote_id: '8000000000001',
    company_options: [],
    price: '30.00',
    can_send: true,
    status_label: 'sendable',
  };

  /** `GET /outsource-pool/{process_id}` 的公司列行（3 字段，在途 2 批）。 */
  const poolCompanyFixture = {
    company_id: '9000000000001',
    name: '外协厂甲',
    held_count: 2,
  };

  /** `GET /outsource-pool/state` 单行（21 字段）。 */
  const poolStateItemFixture = {
    batch_id: '3000000000001',
    part_id: '4000000000001',
    batch_no: 2,
    quantity: 8,
    serial_no: 'SN-001',
    drawing_no: 'DWG-A001',
    name: '法兰盘',
    system_delivery_date: '2026-10-08',
    planned_delivery_date: '2026-10-20',
    is_urgent: false,
    customer_name: '二级客户',
    parent_customer_name: '一级客户',
    applicant_name: '张三',
    location: 'OUTSOURCE_COMPANY',
    note: '加急',
    version: 5,
    sent_at: '2026-10-01 08:00:00',
    price: '12.50',
    receive_next_process_id: '2000000000002',
    receive_next_process_name: '半成品检验',
    chain_resolvable: true,
  };

  /** `GET /outsource-pool/counts` 顶层（4 字段裸对象，无分页信封）。 */
  const poolCountsResultFixture = {
    counts: [poolCountFixture],
    sendable_total: 4,
    in_flight_total: 2,
    total: 6,
  };

  /** `GET /outsource-pool/{process_id}` 顶层（6 字段裸对象，无分页信封）。 */
  const poolByProcessResultFixture = {
    process_id: '2000000000001',
    process_code: 'OUT-01',
    process_name: '外协粗加工',
    companies: [poolCompanyFixture],
    total: 1,
    items: [poolItemFixture],
  };

  /** `GET /outsource-pool/state` 顶层（5 字段裸对象，无分页信封）。 */
  const poolStateResultFixture = {
    outsource_company_id: '9000000000001',
    outsource_company_name: '外协厂甲',
    process_id: '2000000000001',
    current_held: 1,
    items: [poolStateItemFixture],
  };

  it('S-OP1：counts 顶层 4 字段裸对象（无分页信封）parse 通过', () => {
    const parsed = outsourcePoolCountsResultSchema.parse({
      counts: [poolCountFixture],
      sendable_total: 4,
      in_flight_total: 2,
      total: 6,
    });
    expect(parsed.counts).toHaveLength(1);
    expect(parsed.sendable_total).toBe(4);
    expect(parsed.in_flight_total).toBe(2);
    expect(parsed.total).toBe(6);
    // 无货工序（counts 空数组）同样是合法响应
    expect(
      outsourcePoolCountsResultSchema.parse({
        counts: [],
        sendable_total: 0,
        in_flight_total: 0,
        total: 0,
      }).counts,
    ).toEqual([]);
  });

  it('S-OP2：counts 行 5 字段全声明，键集与 fixture 逐字段相等（漏声明即红）', () => {
    const parsed = outsourcePoolCountsSchema.parse(poolCountFixture);
    expect(Object.keys(poolCountFixture)).toHaveLength(5);
    expect(Object.keys(parsed).sort()).toEqual(Object.keys(poolCountFixture).sort());
    expect(parsed.process_id).toBe('2000000000001');
    expect(parsed.sendable_count).toBe(4);
    expect(parsed.in_flight_count).toBe(2);
  });

  it('S-OP3：counts 缺 sendable_count / in_flight_count / 任一 total → 抛 ZodError', () => {
    for (const key of ['sendable_count', 'in_flight_count'] as const) {
      const { [key]: _omit, ...rest } = poolCountFixture;
      void _omit;
      expect(() => outsourcePoolCountsSchema.parse(rest)).toThrow();
    }
    for (const key of ['sendable_total', 'in_flight_total', 'total'] as const) {
      // counts 键必须留在对象里：顶层 schema 的 4 个字段各自独立缺一即红，少了 counts
      // 会让本组三条断言全部因同一个缺键而抛 —— 把某个 total 改成 .optional() /
      // .default(0) 也照样绿，属空断言。
      const { [key]: _omit, ...rest } = {
        counts: [],
        sendable_total: 0,
        in_flight_total: 0,
        total: 0,
      };
      void _omit;
      expect(() => outsourcePoolCountsResultSchema.parse(rest)).toThrow();
    }
  });

  it('S-OP4：counts 的 process_id 传裸数字 → 抛 ZodError（雪花 ID 必须 string）', () => {
    // 后端 `#[serde(serialize_with = "serialize_i64")]`；前端用 z.coerce.string() /
    // z.number() 掩盖漂移会让 > 2^53 的 id 静默丢精度，故方向锁死。
    expect(() =>
      outsourcePoolCountsSchema.parse({ ...poolCountFixture, process_id: 2000000000001 }),
    ).toThrow();
  });

  it('S-OP5：by-process 顶层 6 字段（companies 空 / items 空）parse 通过', () => {
    const parsed = outsourcePoolByProcessResultSchema.parse({
      process_id: '2000000000001',
      process_code: 'OUT-01',
      process_name: '外协粗加工',
      companies: [],
      total: 0,
      items: [],
    });
    expect(parsed.companies).toEqual([]);
    expect(parsed.items).toEqual([]);
    // 公司列：无在途批次的活跃公司也在列（held_count = 0）
    expect(
      outsourcePoolCompanySchema.parse({
        company_id: '9000000000001',
        name: '外协厂甲',
        held_count: 0,
      }).held_count,
    ).toBe(0);
  });

  it('S-OP6：by-process 行 22 字段全声明，键集与 fixture 逐字段相等（漏声明即红）', () => {
    const parsed = outsourcePoolByProcessSchema.parse(poolItemFixture);
    expect(Object.keys(poolItemFixture)).toHaveLength(22);
    expect(Object.keys(parsed).sort()).toEqual(Object.keys(poolItemFixture).sort());
    expect(parsed.can_send).toBe(true);
    expect(parsed.quote_id).toBe('8000000000001');
    expect(parsed.price).toBe('30.00');
  });

  it('S-OP7：by-process 行缺 version / can_send / quote_id → 抛 ZodError（M-1 guard）', () => {
    // version 是发送端点的 OCC 锚、can_send 是后端派生的可发送判据、quote_id 是
    // APPROVAL 模式发送必传二选一的判据 —— 任一漏声明都会让看板行为静默走歪。
    for (const key of ['version', 'can_send', 'quote_id', 'status_label'] as const) {
      const { [key]: _omit, ...rest } = poolItemFixture;
      void _omit;
      expect(() => outsourcePoolByProcessSchema.parse(rest)).toThrow();
    }
  });

  it('S-OP8：by-process 行的 Decimal / 雪花 ID 传数字 → 抛 ZodError', () => {
    // price 是 Decimal 字符串
    expect(() => outsourcePoolByProcessSchema.parse({ ...poolItemFixture, price: 30 })).toThrow();
    // 雪花 ID（part_id / batch_id / outsource_company_id）传裸数字
    for (const key of ['part_id', 'batch_id', 'outsource_company_id'] as const) {
      expect(() =>
        outsourcePoolByProcessSchema.parse({ ...poolItemFixture, [key]: 123 }),
      ).toThrow();
    }
    // company_options[].id 同样是雪花 ID 字符串
    expect(() =>
      outsourcePoolByProcessSchema.parse({
        ...poolItemFixture,
        company_options: [{ id: 9000000000001, name: '外协厂甲' }],
      }),
    ).toThrow();
  });

  it('S-OP9：DIRECT 行（company_options 有值 / quote_id 与 price 为 null）parse 通过', () => {
    const parsed = outsourcePoolByProcessSchema.parse({
      ...poolItemFixture,
      send_mode: 'DIRECT',
      source_status: 'PENDING',
      outsource_company_id: null,
      outsource_company_name: null,
      quote_id: null,
      company_options: [{ id: '9000000000001', name: '外协厂甲' }],
      price: null,
      can_send: true,
    });
    expect(parsed.company_options).toEqual([{ id: '9000000000001', name: '外协厂甲' }]);
    expect(parsed.quote_id).toBeNull();
    expect(parsed.price).toBeNull();
  });

  it('S-OP10：by-process 顶层传裸数组 → 抛 ZodError（防「信封退化成数组」）', () => {
    expect(() => outsourcePoolByProcessResultSchema.parse([poolItemFixture])).toThrow();
    // 空对象（后端 VO 换字段 / 字段名漂移的形态）同样必须被拒
    expect(() =>
      outsourcePoolByProcessResultSchema.parse({ process_id: '2000000000001' }),
    ).toThrow();
  });

  it('S-OP11：state 顶层 5 字段（items 空）parse 通过', () => {
    const parsed = outsourcePoolStateResultSchema.parse({
      outsource_company_id: '9000000000001',
      outsource_company_name: '外协厂甲',
      process_id: '2000000000001',
      current_held: 0,
      items: [],
    });
    expect(parsed.current_held).toBe(0);
    expect(parsed.outsource_company_name).toBe('外协厂甲');
  });

  it('S-OP12：state 行 21 字段全声明，键集与 fixture 逐字段相等（漏声明即红）', () => {
    const parsed = outsourcePoolStateSchema.parse(poolStateItemFixture);
    expect(Object.keys(poolStateItemFixture)).toHaveLength(21);
    expect(Object.keys(parsed).sort()).toEqual(Object.keys(poolStateItemFixture).sort());
    expect(parsed.sent_at).toBe('2026-10-01 08:00:00');
    expect(parsed.price).toBe('12.50');
    expect(parsed.chain_resolvable).toBe(true);
    expect(parsed.receive_next_process_id).toBe('2000000000002');
  });

  // ⚠️ 本域最易写错的一处：receive_next_process_id 非 nullable。后端沿
  // `PendingBatchItemOut::current_process_step_id` 的 `.unwrap_or(0)` 口径把 NULL
  // 兜成 "0"；写成 z.string().nullable() 会让「无下一道工序」的合法行整列 parse 失败。
  it('S-OP13：receive_next_process_id = null → 抛 ZodError（"0" 兜底口径守卫）', () => {
    expect(() =>
      outsourcePoolStateSchema.parse({ ...poolStateItemFixture, receive_next_process_id: null }),
    ).toThrow();
    // 顶层同理：outsource_company_id / process_id 由查询参数确定，非空
    expect(() =>
      outsourcePoolStateResultSchema.parse({
        outsource_company_id: null,
        outsource_company_name: '外协厂甲',
        process_id: '2000000000001',
        current_held: 0,
        items: [],
      }),
    ).toThrow();
  });

  it('S-OP14：「无下一道工序」形态（"0" + 工序名为 null + chain_resolvable=false）parse 通过', () => {
    // 与 S-OP13 配对的正向用例：兜底值 "0" 是**合法**响应，必须放行。
    const parsed = outsourcePoolStateSchema.parse({
      ...poolStateItemFixture,
      receive_next_process_id: '0',
      receive_next_process_name: null,
      chain_resolvable: false,
    });
    expect(parsed.receive_next_process_id).toBe('0');
    expect(parsed.receive_next_process_name).toBeNull();
    expect(parsed.chain_resolvable).toBe(false);
  });

  it('S-OP15：state 行缺 chain_resolvable / sent_at / receive_next_process_id → 抛 ZodError', () => {
    // chain_resolvable 是「能否免填工序」的判据、sent_at 是对账锚、receive_next_*
    // 是接收入参来源 —— 任一漏声明都会让接收对话框行为走歪且无报错。
    for (const key of [
      'chain_resolvable',
      'sent_at',
      'receive_next_process_id',
      'price',
    ] as const) {
      const { [key]: _omit, ...rest } = poolStateItemFixture;
      void _omit;
      expect(() => outsourcePoolStateSchema.parse(rest)).toThrow();
    }
  });

  it('S-OP16：state 行的 price 传数字 / sent_at 传 Date 对象 → 抛 ZodError', () => {
    // price 是 Decimal 字符串（DIRECT 直发的占位报价为 "0"）
    expect(() =>
      outsourcePoolStateSchema.parse({ ...poolStateItemFixture, price: 12.5 }),
    ).toThrow();
    // datetime 一律 naive 字符串（后端 NaiveDateTime）
    expect(() =>
      outsourcePoolStateSchema.parse({
        ...poolStateItemFixture,
        sent_at: new Date('2026-10-01T08:00:00Z'),
      }),
    ).toThrow();
    // 雪花 ID（batch_id / part_id）传裸数字
    expect(() =>
      outsourcePoolStateSchema.parse({ ...poolStateItemFixture, batch_id: 1 }),
    ).toThrow();
  });

  it('S-OP17：state 顶层传裸数组 / 空对象 → 抛 ZodError', () => {
    expect(() => outsourcePoolStateResultSchema.parse([poolStateItemFixture])).toThrow();
    expect(() => outsourcePoolStateResultSchema.parse({})).toThrow();
    // current_held 漏声明必须被拒（= items.length 是前端渲染列头计数的依据）
    expect(() =>
      outsourcePoolStateResultSchema.parse({
        outsource_company_id: '9000000000001',
        outsource_company_name: '外协厂甲',
        process_id: '2000000000001',
        items: [],
      }),
    ).toThrow();
  });

  it('S-OP18：两个恒定字面量字段锁死（status_label / location）', () => {
    expect(() =>
      outsourcePoolByProcessSchema.parse({ ...poolItemFixture, status_label: 'pending' }),
    ).toThrow();
    expect(() =>
      outsourcePoolStateSchema.parse({
        ...poolStateItemFixture,
        location: 'PRODUCTION_SHELF',
      }),
    ).toThrow();
  });

  // 2026-10-03 review 第 2 轮补：顶层 result schema 原先只断言值、不断言键集 ——
  // 顶层 schema 的键集漂移可以无声地混过去（api 层的 `as XxxResult` 不校验宽窄）。
  // 下面三条与 S-OP2 / S-OP6 / S-OP12 同款，把「parse 后键集 == fixture 键集」补齐到
  // 三个顶层 schema。实测能拦的方向（对 `outsourcePoolCountsResultSchema` 变异验证）：
  //   - 漏声明 fixture 有的字段（键从 parse 结果消失）→ 红；
  //   - 多声明一个 `.default()` 字段（键被补进 parse 结果）→ 红。
  // 拦不到的方向：多声明一个**裸 `.optional()`** 字段 —— Zod 的 optional 不在输出里
  // 补键，键集不变。这是键集断言的固有上限，4 个行 schema 的键集断言（S-OP2 / S-OP6 /
  // S-OP12 / S-OP22）同样拦不到，两者强度一致。
  it('S-OP19：counts 顶层 4 字段全声明，键集与 fixture 逐字段相等（漏声明即红）', () => {
    const parsed = outsourcePoolCountsResultSchema.parse(poolCountsResultFixture);
    expect(Object.keys(poolCountsResultFixture)).toHaveLength(4);
    expect(Object.keys(parsed).sort()).toEqual(Object.keys(poolCountsResultFixture).sort());
  });

  it('S-OP20：by-process 顶层 6 字段全声明，键集与 fixture 逐字段相等（漏声明即红）', () => {
    const parsed = outsourcePoolByProcessResultSchema.parse(poolByProcessResultFixture);
    expect(Object.keys(poolByProcessResultFixture)).toHaveLength(6);
    expect(Object.keys(parsed).sort()).toEqual(Object.keys(poolByProcessResultFixture).sort());
  });

  it('S-OP21：state 顶层 5 字段全声明，键集与 fixture 逐字段相等（漏声明即红）', () => {
    const parsed = outsourcePoolStateResultSchema.parse(poolStateResultFixture);
    expect(Object.keys(poolStateResultFixture)).toHaveLength(5);
    expect(Object.keys(parsed).sort()).toEqual(Object.keys(poolStateResultFixture).sort());
  });

  // 2026-10-03 review 第 3 轮补：outsourcePoolCompanySchema 原先只在 S-OP5 里做了一次
  // 正向 parse + 取 held_count，是本域唯一没有键集断言的行 schema —— 从它删掉 `name` /
  // `held_count` 的必填声明时 parse 照过不误、UI 静默拿 undefined。补齐到与 S-OP2 /
  // S-OP6 / S-OP12 同款。方向说明见上方 S-OP19~21 的注释：键集断言拦得住「漏声明」与
  // 「多声明带 .default()」，拦不住「多声明裸 .optional()」，与既有各组强度一致。
  it('S-OP22：公司列行 3 字段全声明，键集与 fixture 逐字段相等（漏声明即红）', () => {
    const parsed = outsourcePoolCompanySchema.parse(poolCompanyFixture);
    expect(Object.keys(poolCompanyFixture)).toHaveLength(3);
    expect(Object.keys(parsed).sort()).toEqual(Object.keys(poolCompanyFixture).sort());
    expect(parsed.company_id).toBe('9000000000001');
    expect(parsed.name).toBe('外协厂甲');
    expect(parsed.held_count).toBe(2);
  });
});

// 2026-10-04 新增：报工台三页（取件 / 放回 / 送检）列表行 schema 契约断言。
//
// 服务对象：`GET /api/v2/parts/pickable-by-work-type/{work_type_id}` 与
// `GET /api/v2/parts/by-worker/{worker_id}`，行 VO = backend-rust
// `src/modules/part/vo/part.rs` 的 `PartListItem`（38 字段），外层是 `PartListOut`
// 分页信封。fixture 按两个 service 构造行的真实口径填（占位值 1970-01-01 /
// is_urgent=false / applicant_name="" / customer_id="0" / status="IN_PROCESS" /
// version=0 / location=null）。
describe('2026-10-04 新增：报工台 scanPartRowSchema / scanPartListResultSchema 契约断言', () => {
  const validScanRow = {
    id: '190000000000001',
    serial_no: 'SN-001',
    name: 'DWG-A001',
    drawing_no: 'DWG-A001',
    applicant_name: '',
    quantity: 5,
    request_date: '1970-01-01',
    planned_delivery_date: '1970-01-01',
    customer_id: '0',
    assembly_id: null,
    status: 'IN_PROCESS',
    is_urgent: false,
    order_no: null,
    system_delivery_date: null,
    note: null,
    unit_price: '0',
    total_price: '0',
    version: 0,
    created_at: '1970-01-01T00:00:00',
    created_by: null,
    updated_at: '1970-01-01T00:00:00',
    updated_by: null,
    deleted_at: null,
    process_chain_id: null,
    chain_state: 'NEXT',
    chain_next_process_id: '190000000000021',
    chain_next_process_name: 'CUT-01 下料',
    chain_current_process_name: 'SAW-02 锯切',
    customer_name: null,
    l1_customer_name: null,
    location: null,
    holder_name: null,
    row_type: 'PART',
    has_children: false,
    child_count: null,
    has_cnc_program: false,
    batch_id: '190000000000009',
    batch_version: 4,
  };

  it('S-SP1：接受 PartListItem 完整 38 字段（派生键恒 null、批次锚点与链四件套有值）', () => {
    const parsed = scanPartRowSchema.parse(validScanRow);
    expect(parsed.id).toBe('190000000000001');
    expect(parsed.batch_id).toBe('190000000000009');
    expect(parsed.batch_version).toBe(4);
    expect(parsed.chain_state).toBe('NEXT');
    // 后端刻意不返的键不在 schema 里 ⇒ parse 后不应凭空出现
    expect('next_process_id' in parsed).toBe(false);
    expect('shelf_code' in parsed).toBe(false);
  });

  it('S-SP2：占位符 1970-01-01 归一成 null；真实日期原样透传', () => {
    const parsed = scanPartRowSchema.parse(validScanRow);
    expect(parsed.planned_delivery_date).toBeNull();
    expect(parsed.request_date).toBeNull();
    const real = scanPartRowSchema.parse({
      ...validScanRow,
      planned_delivery_date: '2026-10-20',
      request_date: '2026-09-01',
    });
    expect(real.planned_delivery_date).toBe('2026-10-20');
    expect(real.request_date).toBe('2026-09-01');
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

  it('S-SP4：外层是分页信封 —— 裸数组被拒（本次线上故障的形态）', () => {
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
  });

  // 2026-10-04 工序链四件套按「带默认值的必输出键」声明（取舍理由见 schemas.ts
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

    // 另三个键的默认值对齐后端兜底口径：id 落 '0'（消费侧见到 '0' 必须短路，不发
    // for-return 请求）、两个 name 落 null。
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
