// src/views/cnc/composables/__tests__/pendingProgrammingSchema.spec.ts
//
// 「待编程一览」主查询 schema（守门 `GET /api/v2/prod/programming/pending`）的契约
// 断言。
//
// 覆盖：
//   - P1：完整 15 字段行通过解析，且解析结果的键集合与 fixture 逐键对齐
//     （Zod 默认 strip 会静默丢未声明字段，正向断言键集合才能发现「后端加了列、
//     前端没声明」）；
//   - P1b：批次锚点（batch_id / batch_version）**有值**时解析出来；**缺键**时抛错 ——
//     两者声明成「必填 + 可空」而不是 `.optional()`，一旦有人为省事退回 `.optional()`，
//     这条会红（静默通过的后患是全表下发按钮恒 disabled 且无任何报错）；
//   - P2：逐字段必填 guard —— 缺任一必填键都抛 ZodError（strip 陷阱的反向 guard：
//     「误删必填声明」必须立刻炸，否则整份校验形同虚设）；
//   - P3：雪花 ID 传 number → 抛错（19 位 ID 在 JS Number 下丢精度）；
//   - P4：分页信封 total / limit / offset 是 JSON number（与待品检队列的 string
//     计数方向相反），缺 items → 抛错。

import { describe, expect, it } from 'vitest';
import {
  pendingProgrammingItemSchema,
  pendingProgrammingListResultSchema,
} from '../pendingProgrammingSchema';

function makeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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
    // 后端 ProgrammingItemOut 的批次锚点两字段**无** `skip_serializing_if` ⇒ 恒返
    // （无 PROGRAMMING 批次时为 null），schema 因此声明成「必填 + 可空」。fixture 必须
    // 显式给 null，否则 parse 直接抛 invalid_type（这正是要守的强度）。
    batch_id: null,
    batch_version: null,
    ...overrides,
  };
}

describe('pendingProgrammingItemSchema — 待编程行（15 字段）', () => {
  it('P1：完整行通过解析，且解析结果键集合与 fixture 一一对应', () => {
    const row = makeRow();
    expect(Object.keys(row)).toHaveLength(15);
    const parsed = pendingProgrammingItemSchema.parse(row);
    expect(Object.keys(parsed).sort()).toEqual(Object.keys(row).sort());
    expect(parsed.id).toBe('190000000000099');
    expect(parsed.version).toBe(3);
    expect(parsed.has_cnc_program).toBe(false);
    // 客户：L1 = parent_customer_name / L2 = customer_name（**不是** part 域的
    // l1_customer_name）—— 两个端点的 rows 不可互相 cast。
    expect(parsed.parent_customer_name).toBe('客户A');
    expect(parsed.customer_name).toBe('客户A-子');
    expect((parsed as Record<string, unknown>).l1_customer_name).toBeUndefined();
  });

  it('P1b：批次锚点有值时解析出来；缺键时抛 ZodError（防退回 .optional()）', () => {
    const withAnchor = pendingProgrammingItemSchema.parse(
      makeRow({ batch_id: '190000000000123', batch_version: 7 }),
    );
    expect(withAnchor.batch_id).toBe('190000000000123');
    expect(withAnchor.batch_version).toBe(7);

    for (const key of ['batch_id', 'batch_version'] as const) {
      const row = makeRow();
      delete row[key];
      expect(() => pendingProgrammingItemSchema.parse(row)).toThrow();
    }
  });

  it('P2：缺任一必填键都抛 ZodError（逐字段 strip 陷阱 guard）', () => {
    // 全量逐字段跑一遍：漏声明的字段会让整份校验对契约漂移失守，而这种失守在
    // 正向用例上完全看不出来（缺声明时「完整行」照样 parse 通过）。
    const requiredKeys = Object.keys(makeRow());
    for (const key of requiredKeys) {
      const row = makeRow();
      delete row[key];
      expect(() => pendingProgrammingItemSchema.parse(row), `缺 ${key} 应当抛错`).toThrow();
    }
  });

  it('P3：雪花 id 传 number → 抛 ZodError（禁 Number()，会丢精度）', () => {
    expect(() => pendingProgrammingItemSchema.parse(makeRow({ id: 190000000000099 }))).toThrow();
  });

  it('P3b：可空列置 null 仍可解析（DB NULL ⇒ JSON null，列表页渲染占位破折号）', () => {
    const parsed = pendingProgrammingItemSchema.parse(
      makeRow({ serial_no: null, system_delivery_date: null, parent_customer_name: null }),
    );
    expect(parsed.serial_no).toBeNull();
    expect(parsed.system_delivery_date).toBeNull();
    expect(parsed.parent_customer_name).toBeNull();
  });
});

describe('pendingProgrammingListResultSchema — 分页信封（计数是 number）', () => {
  it('P4：接受 items / total / limit / offset 四字段', () => {
    const parsed = pendingProgrammingListResultSchema.parse({
      items: [makeRow()],
      total: 1,
      limit: 20,
      offset: 0,
    });
    expect(parsed.items).toHaveLength(1);
    expect(parsed.total).toBe(1);
    expect(parsed.limit).toBe(20);
    expect(parsed.offset).toBe(0);
  });

  it('P4b：计数传 JSON string → 抛错（后端这里是裸 i64，方向与待品检队列相反）', () => {
    expect(() =>
      pendingProgrammingListResultSchema.parse({
        items: [makeRow()],
        total: '1',
        limit: '20',
        offset: '0',
      }),
    ).toThrow();
  });

  it('P4c：缺 items → 抛 ZodError', () => {
    expect(() =>
      pendingProgrammingListResultSchema.parse({ total: 1, limit: 20, offset: 0 }),
    ).toThrow();
  });
});
