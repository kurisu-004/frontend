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
//   - S18 / S19（held 批次）与 S-WP* / S-WS* / S-MV* / S-DP*（pool 域计数、
//     单工序看板、单工人 state、move / refill / dispatch / auto-dispatch）
//     已随 2026-10-08 的生产队列域重构迁到
//     `views/production/queue/composables/__tests__/productionQueueSchema.spec.ts`
//     （Q 系列）—— queue 域的 schema 随视图目录走，不再寄居本文件。
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
  repairBatchListItemSchema,
  repairBatchListResultSchema,
  shelfSchema,
  shelfListResultSchema,
  scanPartRowSchema,
  scanPartListResultSchema,
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

// 2026-10-04 新增：报工台三页（取件 / 放回 / 送检）列表行 schema 契约断言。
//
// 服务对象：`GET /api/v2/parts/pickable-by-work-type/{work_type_id}` 与
// `GET /api/v2/parts/by-worker/{worker_id}`，行 VO = backend-rust
// `src/modules/part/vo/part.rs` 的 `PartListItem`（2026-10-09 起 39 字段），外层是
// `PartListOut`
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
    has_process_chain: true,
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

  it('S-SP1：接受 PartListItem 完整 39 字段（派生键恒 null、批次锚点与链四件套有值）', () => {
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
