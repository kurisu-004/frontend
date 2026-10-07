// @vitest-environment node
// src/views/outsource/composables/__tests__/outsourceQueueSchema.spec.ts
//
// 2026-10-08 新建：外协看板（queue）域 Zod schema 契约断言。随 schema 归位从
// `composables/queries/__tests__/schemas.spec.ts` 的 outsource-pool 段（S-OP 系列）
// 搬来并按新契约重写。
//
// 守的是两类失败模式，两类都在本仓造成过线上事故：
//   - **漏声明必填字段**：zod 默认 strip 会把未声明的键静默丢弃、parse 仍成功 ⇒
//     「守门」形同虚设（模板里出现 undefined、徽标恒 0）。断言落在「缺该键 →
//     抛 ZodError」+「parse 后键集 == fixture 键集」两条上；
//   - **声明了后端已删的字段**：parse 在真实响应上 100% 失败 ⇒ 页面永久「加载失败」。
//     断言落在「后端真实形态能 parse」+「后端删掉的键（status_label / source_status /
//     batch_quantity / customer_path）不被要求」。
//
// 覆盖（键集与字段数断言用 `Object.keys(fixture)` 双向比对，见每组末尾）：
//   - OQ-C*：候选行（outsourceQueueCandidateSchema，25 字段）：APPROVAL / DIRECT 两形态、
//     必填字段缺失必抛、雪花 ID 必须是字符串、已删的 4 个字段不再出现。
//   - OQ-H*：在途批次行（outsourceQueueHeldBatchSchema，22 字段）：**sent_at / price 必须
//     接受 null**（后端 Option + LEFT JOIN）、`receive_next_process_id` 非 nullable
//     （"0" = 无下一道工序）、location 字面量锁死。
//   - OQ-CO*：公司列（outsourceQueueCompanySchema，4 字段）：held_batches 内联。
//   - OQ-S*：快照（outsourceQueueSnapshotSchema / outsourceQueueProcessSchema）：**无
//     total**、color 接受 null、两种 category。
//   - OQ-PD*：单工序详情（outsourceQueueProcessDetailSchema）：process 对象 / companies /
//     items / total / ts 五字段，顶层信封键集钉死。

import { describe, expect, it } from 'vitest';
import {
  outsourceQueueCandidateSchema,
  outsourceQueueCompanySchema,
  outsourceQueueHeldBatchSchema,
  outsourceQueueProcessDetailSchema,
  outsourceQueueSnapshotSchema,
} from '../outsourceQueueSchema';

/** 候选行 fixture：APPROVAL 形态（已批准报价、单一公司）。
 *  ⚠️ 后端已删的 4 个字段（`status_label` / `source_status` / `batch_quantity` /
 *  `customer_path`）**故意不给** —— fixture 就是响应形态。 */
const candidateFixture = {
  version: 3,
  send_mode: 'APPROVAL',
  part_id: '4000000000001',
  part_serial_no: 'SN-0001',
  part_drawing_no: 'DRW-1',
  part_name: '连杆',
  quantity: 12,
  batch_id: '3000000000001',
  batch_no: 1024,
  planned_delivery_date: '2026-10-20',
  is_urgent: false,
  customer_name: '某某零件厂',
  parent_customer_name: '某某集团',
  shelf_code: 'A-01',
  shelf_id: '5000000000001',
  outsource_company_id: '9000000000001',
  outsource_company_name: '外协厂甲',
  quote_id: '7000000000001',
  company_options: [],
  price: '12.50',
  has_cnc_program: true,
  applicant_name: '张三',
  note: null,
  system_delivery_date: '2026-10-18',
  can_send: true,
};

/** 在途批次行 fixture：sent_at / price 有值形态。 */
const heldBatchFixture = {
  batch_id: '3000000000002',
  part_id: '4000000000002',
  batch_no: 1025,
  quantity: 8,
  serial_no: null,
  drawing_no: 'DRW-2',
  name: '齿轮',
  system_delivery_date: null,
  planned_delivery_date: '2026-10-25',
  is_urgent: true,
  customer_name: '某某零件厂',
  parent_customer_name: null,
  applicant_name: null,
  location: 'OUTSOURCE_COMPANY',
  note: null,
  version: 5,
  sent_at: '2026-10-01T09:00:00',
  price: '8.00',
  receive_next_process_id: '2000000000002',
  receive_next_process_name: '外协热处理',
  chain_resolvable: true,
  has_cnc_program: false,
};

const companyFixture = {
  company_id: '9000000000001',
  name: '外协厂甲',
  held_count: 1,
  held_batches: [heldBatchFixture],
};

const processFixture = {
  process_id: '2000000000001',
  process_code: 'OUT-01',
  process_name: '外协粗加工',
  color: '#2c6cb8ff',
  category: 'OUTSOURCE',
  sendable_count: 4,
  in_flight_count: 2,
};

const snapshotFixture = {
  processes: [processFixture],
  sendable_total: 4,
  in_flight_total: 2,
  ts: '2026-10-08T09:12:33+08:00',
};

const detailFixture = {
  process: {
    process_id: '2000000000001',
    process_code: 'OUT-01',
    process_name: '外协粗加工',
    color: null,
  },
  companies: [companyFixture],
  items: [candidateFixture],
  total: 1,
  ts: '2026-10-08T09:12:33+08:00',
};

describe('outsourceQueueSchema —— 外协看板候选行', () => {
  it('OQ-C1：APPROVAL 形态逐字段解析通过，键集与 fixture 逐字段相等（25 字段）', () => {
    const parsed = outsourceQueueCandidateSchema.parse(candidateFixture);
    expect(Object.keys(candidateFixture)).toHaveLength(25);
    expect(Object.keys(parsed).sort()).toEqual(Object.keys(candidateFixture).sort());
    expect(parsed.can_send).toBe(true);
    expect(parsed.version).toBe(3);
  });

  it('OQ-C2：DIRECT 形态（公司走 company_options、price / quote_id 为 null）也放行', () => {
    const direct = {
      ...candidateFixture,
      send_mode: 'DIRECT',
      outsource_company_id: null,
      outsource_company_name: null,
      quote_id: null,
      price: null,
      company_options: [{ id: '9000000000002', name: '外协厂乙' }],
      shelf_id: null,
      shelf_code: null,
    };
    const parsed = outsourceQueueCandidateSchema.parse(direct);
    expect(parsed.send_mode).toBe('DIRECT');
    expect(parsed.price).toBeNull();
    expect(parsed.company_options).toHaveLength(1);
  });

  // 漏声明类：逐个必填字段抽掉都必须抛错（漏声明 ⇒ strip ⇒ parse 照过 ⇒ 守门失效）
  it.each([
    ['version', '发送的 OCC 锚'],
    ['can_send', '可发送判据'],
    ['has_cnc_program', '卡片「已编程」tag'],
    ['shelf_id', '批次真实所在货架'],
    ['company_options', 'DIRECT 的公司下拉源'],
  ])('OQ-C3：缺 %s（%s）→ 抛 ZodError', (key) => {
    const rest: Record<string, unknown> = { ...candidateFixture };
    delete rest[key];
    expect(() => outsourceQueueCandidateSchema.parse(rest)).toThrow();
  });

  it('OQ-C4：雪花 ID 必须是字符串（发 / 收成数字 → 抛错）', () => {
    // JS Number 会丢精度，方向必须锁死在 z.string()：用 coerce / number 掩盖会让漂移
    // 静默通过，而按错误值发的 OCC / 定位锚全部对不上。
    expect(() =>
      outsourceQueueCandidateSchema.parse({ ...candidateFixture, batch_id: 3000000000001 }),
    ).toThrow();
  });

  it('OQ-C5：后端已删的 4 个字段不在契约里（多出来也要能 parse，不被要求）', () => {
    const parsed = outsourceQueueCandidateSchema.parse({
      ...candidateFixture,
      status_label: 'sendable',
      source_status: 'PENDING',
      batch_quantity: 12,
      customer_path: '某某集团 / 某某零件厂',
    });
    // strip 后这 4 个键不应出现在结果里 —— 它们已不是本 VO 的字段
    expect(Object.keys(parsed)).not.toContain('status_label');
    expect(Object.keys(parsed)).not.toContain('source_status');
    expect(Object.keys(parsed)).not.toContain('batch_quantity');
    expect(Object.keys(parsed)).not.toContain('customer_path');
  });

  it('OQ-C6：send_mode 只认 APPROVAL / DIRECT 两个字面量', () => {
    expect(() =>
      outsourceQueueCandidateSchema.parse({ ...candidateFixture, send_mode: 'PENDING' }),
    ).toThrow();
  });
});

describe('outsourceQueueSchema —— 外协看板在途批次行', () => {
  it('OQ-H1：逐字段解析通过，键集与 fixture 逐字段相等（22 字段）', () => {
    const parsed = outsourceQueueHeldBatchSchema.parse(heldBatchFixture);
    expect(Object.keys(heldBatchFixture)).toHaveLength(22);
    expect(Object.keys(parsed).sort()).toEqual(Object.keys(heldBatchFixture).sort());
    expect(parsed.location).toBe('OUTSOURCE_COMPANY');
  });

  // 契约漂移点：后端是 Option（旧 schema 声明成非 nullable 会在真实响应上抛错）
  it('OQ-H2：sent_at / price 接受 null（后端 Option + LEFT JOIN 的诚实映射）', () => {
    const parsed = outsourceQueueHeldBatchSchema.parse({
      ...heldBatchFixture,
      sent_at: null,
      price: null,
    });
    expect(parsed.sent_at).toBeNull();
    expect(parsed.price).toBeNull();
  });

  it('OQ-H3：缺 sent_at / price **键**仍抛错（null 与缺键是两种状态，不能混）', () => {
    const noSentAt: Record<string, unknown> = { ...heldBatchFixture };
    delete noSentAt.sent_at;
    expect(() => outsourceQueueHeldBatchSchema.parse(noSentAt)).toThrow();
    const noPrice: Record<string, unknown> = { ...heldBatchFixture };
    delete noPrice.price;
    expect(() => outsourceQueueHeldBatchSchema.parse(noPrice)).toThrow();
  });

  it('OQ-H4：receive_next_process_id 非 nullable —— "0" 放行、null 抛错', () => {
    // 后端投影层已把 NULL 吃成 0（`.unwrap_or(0)`）且序列化为字符串 ⇒「无下一道工序」
    // 在 JSON 上是 "0" 而不是 null。写成 .nullable() 会把合法响应当漂移整列炸掉。
    expect(
      outsourceQueueHeldBatchSchema.parse({
        ...heldBatchFixture,
        receive_next_process_id: '0',
        chain_resolvable: false,
      }).receive_next_process_id,
    ).toBe('0');
    expect(() =>
      outsourceQueueHeldBatchSchema.parse({
        ...heldBatchFixture,
        receive_next_process_id: null,
      }),
    ).toThrow();
  });

  it('OQ-H5：location 字面量锁死（非 OUTSOURCE_COMPANY 抛错）', () => {
    expect(() =>
      outsourceQueueHeldBatchSchema.parse({ ...heldBatchFixture, location: 'WORKER' }),
    ).toThrow();
  });

  it('OQ-H6：缺 version / chain_resolvable / has_cnc_program 任一 → 抛错', () => {
    for (const key of ['version', 'chain_resolvable', 'has_cnc_program']) {
      const rest: Record<string, unknown> = { ...heldBatchFixture };
      delete rest[key];
      expect(() => outsourceQueueHeldBatchSchema.parse(rest)).toThrow();
    }
  });
});

describe('outsourceQueueSchema —— 外协看板公司列', () => {
  it('OQ-CO1：4 字段 + 内联 held_batches 解析通过，键集与 fixture 逐字段相等', () => {
    const parsed = outsourceQueueCompanySchema.parse(companyFixture);
    expect(Object.keys(companyFixture)).toHaveLength(4);
    expect(Object.keys(parsed).sort()).toEqual(Object.keys(companyFixture).sort());
    expect(parsed.held_batches).toHaveLength(1);
  });

  it('OQ-CO2：空公司列（在途为 0）也放行 —— 空列是拖拽目标，不能被守门滤掉', () => {
    const empty = { ...companyFixture, held_count: 0, held_batches: [] };
    expect(outsourceQueueCompanySchema.parse(empty).held_count).toBe(0);
  });

  it('OQ-CO3：held_count 必须与 held_batches.length 一致（漏声明会让徽标与卡片数对不上）', () => {
    // 徽标只读 held_count、卡片走 held_batches —— 两者不一致时用户看到「3 张卡 · 徽标 5」。
    // schema 守形状（两键都在），口径一致性由后端保证，前端只断言**两键都必填**。
    const rest: Record<string, unknown> = { ...companyFixture };
    delete rest.held_count;
    expect(() => outsourceQueueCompanySchema.parse(rest)).toThrow();
  });
});

describe('outsourceQueueSchema —— 外协看板快照', () => {
  it('OQ-S1：4 字段解析通过，**无 total**（后端不再给合计字段）', () => {
    const parsed = outsourceQueueSnapshotSchema.parse(snapshotFixture);
    expect(Object.keys(parsed).sort()).toEqual(Object.keys(snapshotFixture).sort());
    expect(parsed).not.toHaveProperty('total');
    expect(parsed).not.toHaveProperty('counts');
    expect(parsed.processes).toHaveLength(1);
  });

  it('OQ-S2：工序行接受 color = null 与两种 category', () => {
    expect(
      outsourceQueueSnapshotSchema.parse({
        ...snapshotFixture,
        processes: [{ ...processFixture, color: null }],
      }).processes[0]!.color,
    ).toBeNull();
    expect(
      outsourceQueueSnapshotSchema.parse({
        ...snapshotFixture,
        processes: [{ ...processFixture, category: 'INHOUSE' }],
      }).processes[0]!.category,
    ).toBe('INHOUSE');
  });

  it('OQ-S3：快照顶层缺任一字段 → 抛错', () => {
    for (const key of ['processes', 'sendable_total', 'in_flight_total', 'ts']) {
      const rest: Record<string, unknown> = { ...snapshotFixture };
      delete rest[key];
      expect(() => outsourceQueueSnapshotSchema.parse(rest)).toThrow();
    }
  });

  it('OQ-S3b：工序行缺任一字段 → 抛错（color 漏声明 ⇒ 工序色永远回落默认色）', () => {
    for (const key of ['color', 'category', 'sendable_count', 'in_flight_count']) {
      expect(() =>
        outsourceQueueSnapshotSchema.parse({
          ...snapshotFixture,
          processes: [{ ...processFixture, [key]: undefined }],
        }),
      ).toThrow();
    }
  });

  it('OQ-S4：裸数组响应 → 抛错（别把数组当裸对象吐出去）', () => {
    expect(() => outsourceQueueSnapshotSchema.parse([snapshotFixture])).toThrow();
  });
});

describe('outsourceQueueSchema —— 外协看板单工序详情', () => {
  it('OQ-PD1：5 字段（process 对象 / companies / items / total / ts）解析通过', () => {
    const parsed = outsourceQueueProcessDetailSchema.parse(detailFixture);
    expect(Object.keys(detailFixture)).toHaveLength(5);
    expect(Object.keys(parsed).sort()).toEqual(Object.keys(detailFixture).sort());
    expect(parsed.process.process_id).toBe('2000000000001');
    expect(parsed.companies).toHaveLength(1);
    expect(parsed.items).toHaveLength(1);
  });

  it('OQ-PD2：空 tab（companies / items 为空）放行（零候选 / 零公司的工序也要出现）', () => {
    const empty = { ...detailFixture, companies: [], items: [], total: 0 };
    expect(outsourceQueueProcessDetailSchema.parse(empty).total).toBe(0);
  });

  it('OQ-PD3：顶层必须是 process 对象形态 —— 平铺 process_id 抛错', () => {
    // 契约重排点：工序元数据从「顶层三个平铺字段」收成 process 对象。
    const flat = {
      ...detailFixture,
      process: undefined,
      process_id: '2000000000001',
      process_code: 'OUT-01',
      process_name: '外协粗加工',
    };
    expect(() => outsourceQueueProcessDetailSchema.parse(flat)).toThrow();
  });

  it('OQ-PD4：process 缺 color → 抛错（漏声明会让工序色永远回落到默认色）', () => {
    const noColor: Record<string, unknown> = { ...detailFixture };
    delete (noColor.process as Record<string, unknown>).color;
    expect(() => outsourceQueueProcessDetailSchema.parse(noColor)).toThrow();
  });

  it('OQ-PD5：items 里任一候选行契约漂移会带炸整页（嵌套守门不留缺口）', () => {
    expect(() =>
      outsourceQueueProcessDetailSchema.parse({
        ...detailFixture,
        items: [{ ...candidateFixture, can_send: 'yes' }],
      }),
    ).toThrow();
  });
});
