// src/views/inspection/composables/__tests__/inspectionSchema.spec.ts
//
// 「待品检一览」域 schema（待品检队列 13 字段 VO + 品检扫码树）的契约断言。
//
// 覆盖：
//   - I1：待品检行完整 13 字段通过解析，且解析结果键集合与 fixture 逐键对齐；
//   - I2：`.strict()` 守门 —— 多一个键（返修 VO 独有的 status / holder_name，或历史
//     误用键 id）立刻抛错。这是「待品检 VO 与返修 VO 已分家」的核心 guard：一旦有人
//     图省事把 28 字段返修 VO 的键拷回来，这条会红；
//   - I3：缺任一必填键都抛 ZodError（逐字段 strip 陷阱 guard）；
//   - I4：分页信封的 total / limit / offset 是 JSON **string**（后端
//     `serialize_i64`）—— 传 number 必须抛错，方向与待编程列表（裸 i64 ⇒ number）
//     相反，别照抄；
//   - I5：system_delivery_date = null 也能 parse（DB NULL ⇒ JSON null，列表页
//     渲染 '—'；不能因为「多数行有值」就锁成非空）；
//   - I6：扫码树三层结构（assembly 节点 + part 节点 + children 批次节点）能解析，
//     hit_kind 用 enum 守门；
//   - I6f：扫码树的两个节点（part / assembly）的 `customer_path` 必填非 null ——
//     parse 后拿得到值、缺键与给 null 都抛（与待品检队列行那条 `.nullable()` 声明
//     方向相反，见 `inspectionSchema.ts` 的同名注释）。

import { describe, expect, it } from 'vitest';
import {
  inspectionQueueListItemSchema,
  inspectionQueueListResultSchema,
  inspectionScanAssemblySchema,
  inspectionScanBatchSchema,
  inspectionScanPartSchema,
  inspectionScanTreeSchema,
} from '../inspectionSchema';

function makeQueueRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    batch_id: '3000000000001',
    batch_no: 1,
    quantity: 5,
    version: 2,
    part_id: '4000000000001',
    serial_no: 'SN-2026-001',
    drawing_no: 'DWG-A001',
    name: '零件A',
    system_delivery_date: '2026-10-08',
    is_urgent: false,
    customer_id: '9000000000001',
    customer_name: '手机部',
    l1_customer_name: '客户A',
    // 2026-10-17 客户无限层级：新增 customer_path（第 2 层到叶子、不含 L1）。
    customer_path: '终端BG / 手机部',
    ...overrides,
  };
}

function makeBatch(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '3000000000001',
    batch_no: 1,
    quantity: 5,
    status: 'INSPECTION',
    version: 2,
    is_repairing: false,
    location: 'INSPECTION_SHELF',
    current_holder_display: '品检架A-01',
    process_name: null,
    is_scanned: true,
    ...overrides,
  };
}

function makePart(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '4000000000001',
    serial_no: 'SN-2026-001',
    name: '零件A',
    drawing_no: 'DWG-A001',
    status: 'INSPECTION',
    quantity: 5,
    is_urgent: false,
    system_delivery_date: '2026-10-08',
    customer_name: '客户A-子',
    customer_path: '终端BG / 手机部 / 影像组',
    version: 3,
    children: [makeBatch()],
    ...overrides,
  };
}

describe('inspectionQueueListItemSchema — 待品检行（14 字段 .strict()）', () => {
  it('I1：完整 14 字段通过解析，解析结果键集合与 fixture 一一对应', () => {
    const row = makeQueueRow();
    expect(Object.keys(row)).toHaveLength(14);
    const parsed = inspectionQueueListItemSchema.parse(row);
    expect(Object.keys(parsed).sort()).toEqual(Object.keys(row).sort());
    expect(parsed.batch_id).toBe('3000000000001');
    expect(parsed.part_id).toBe('4000000000001');
    expect(parsed.version).toBe(2);
    expect(parsed.l1_customer_name).toBe('客户A');
    expect(parsed.customer_path).toBe('终端BG / 手机部');
  });

  it('I2：多一个键立刻抛错（.strict() 守门：两个 VO 已分家）', () => {
    expect(() =>
      inspectionQueueListItemSchema.parse(makeQueueRow({ status: 'INSPECTION' })),
    ).toThrow();
    expect(() =>
      inspectionQueueListItemSchema.parse(makeQueueRow({ holder_name: '品检A-01' })),
    ).toThrow();
    // id 不是本 VO 的键（行标识是 batch_id / part_id），多出来即抛
    expect(() => inspectionQueueListItemSchema.parse(makeQueueRow({ id: '1' }))).toThrow();
  });

  it('I3：缺任一必填键都抛 ZodError（逐字段 strip 陷阱 guard）', () => {
    for (const key of Object.keys(makeQueueRow())) {
      const row = makeQueueRow();
      delete row[key];
      expect(() => inspectionQueueListItemSchema.parse(row), `缺 ${key} 应当抛错`).toThrow();
    }
  });

  it('I5：system_delivery_date = null 也能解析（DB NULL ⇒ JSON null）', () => {
    const parsed = inspectionQueueListItemSchema.parse(
      makeQueueRow({ system_delivery_date: null }),
    );
    expect(parsed.system_delivery_date).toBeNull();
  });
});

describe('inspectionQueueListResultSchema — 分页信封（计数是 JSON string）', () => {
  it('I4：计数是 string；传 number → 抛错（方向与待编程列表相反）', () => {
    const parsed = inspectionQueueListResultSchema.parse({
      items: [makeQueueRow()],
      total: '1',
      limit: '200',
      offset: '0',
    });
    expect(parsed.items).toHaveLength(1);
    expect(parsed.total).toBe('1');
    expect(parsed.limit).toBe('200');
    expect(parsed.offset).toBe('0');

    expect(() =>
      inspectionQueueListResultSchema.parse({
        items: [makeQueueRow()],
        total: 1,
        limit: 200,
        offset: 0,
      }),
    ).toThrow();
  });

  it('I4b：缺 items → 抛 ZodError', () => {
    expect(() =>
      inspectionQueueListResultSchema.parse({ total: '1', limit: '20', offset: '0' }),
    ).toThrow();
  });
});

describe('扫码树三层 schema', () => {
  it('I6：独立件树（assembly=null + 单个 part + 其 children 批次）能解析', () => {
    const parsed = inspectionScanTreeSchema.parse({
      hit_kind: 'PART',
      scanned_serial_no: 'SN-2026-001',
      assembly: null,
      children: [makePart()],
    });
    expect(parsed.hit_kind).toBe('PART');
    expect(parsed.assembly).toBeNull();
    expect(parsed.children).toHaveLength(1);
    // 两个 version 是互不相关的计数器：part 级只作展示，批次级是写端点 OCC 锚
    expect(parsed.children[0]?.version).toBe(3);
    expect(parsed.children[0]?.children[0]?.version).toBe(2);
  });

  it('I6b：装配件树（assembly 非空 + children 是子件）能解析', () => {
    const assembly: Record<string, unknown> = {
      id: '5000000000001',
      serial_no: 'ASM-001',
      name: '装配件A',
      drawing_no: 'DWG-ASM',
      status: 'INSPECTION',
      quantity: 5,
      is_urgent: false,
      system_delivery_date: null,
      customer_name: '客户A-子',
      customer_path: '终端BG / 手机部 / 影像组',
    };
    const parsed = inspectionScanTreeSchema.parse({
      hit_kind: 'ASSEMBLY',
      scanned_serial_no: 'ASM-001',
      assembly,
      children: [makePart()],
    });
    expect(parsed.assembly?.id).toBe('5000000000001');
    // 装配件节点本身**没有批次**：键集合与零件节点不同，少 children
    expect(Object.keys(parsed.assembly ?? {}).sort()).toEqual(Object.keys(assembly).sort());
  });

  it('I6c：hit_kind 用 enum 守门（后端只有 ASSEMBLY / PART 两个字面量）', () => {
    expect(() =>
      inspectionScanTreeSchema.parse({
        hit_kind: 'BATCH',
        scanned_serial_no: 'SN-2026-001',
        assembly: null,
        children: [makePart()],
      }),
    ).toThrow();
  });

  it('I6d：雪花 id 传 number → 抛错（禁 Number()，19 位 ID 丢精度）', () => {
    expect(() => inspectionScanBatchSchema.parse(makeBatch({ id: 3000000000001 }))).toThrow();
    expect(() => inspectionScanPartSchema.parse(makePart({ id: 4000000000001 }))).toThrow();
    expect(() =>
      inspectionScanAssemblySchema.parse({
        id: 5000000000001,
        serial_no: null,
        name: '装配件A',
        drawing_no: 'DWG-ASM',
        status: 'INSPECTION',
        quantity: 5,
        is_urgent: false,
        system_delivery_date: null,
        customer_name: null,
        customer_path: '终端BG / 手机部',
      }),
    ).toThrow();
  });

  it('I6e：批次节点缺 OCC 锚 version / 返修标记 is_repairing → 抛错', () => {
    for (const key of ['version', 'is_repairing', 'status', 'location'] as const) {
      const batch = makeBatch();
      delete batch[key];
      expect(() => inspectionScanBatchSchema.parse(batch), `缺 ${key} 应当抛错`).toThrow();
    }
  });

  // 2026-10-17 客户无限层级：后端给扫码树的两个节点都补了 `customer_path`（必填
  // `String`）。漏声明 ⇒ zod strip 静默丢掉 ⇒ `ScanTreeDialog.vue` 的「客户」列
  // 恒退回单段名且零报错；这条与 I6d 一起把「声明」与「值不被 strip」都钉住。
  it('I6f：两个节点的 customer_path 必填非 null（parse 后拿得到值）', () => {
    expect(inspectionScanPartSchema.parse(makePart()).customer_path).toBe(
      '终端BG / 手机部 / 影像组',
    );
    const assembly = {
      id: '5000000000001',
      serial_no: null,
      name: '装配件A',
      drawing_no: 'DWG-ASM',
      status: 'INSPECTION',
      quantity: 5,
      is_urgent: false,
      system_delivery_date: null,
      customer_name: null,
      customer_path: '终端BG / 手机部',
    };
    expect(inspectionScanAssemblySchema.parse(assembly).customer_path).toBe('终端BG / 手机部');
    // 空串是合法值（客户行软删 / 父链成环时后端落空串，展示层兜底退回单段名）
    expect(inspectionScanPartSchema.parse(makePart({ customer_path: '' })).customer_path).toBe('');
    for (const schema of [inspectionScanPartSchema, inspectionScanAssemblySchema]) {
      const base = schema === inspectionScanPartSchema ? makePart() : assembly;
      const noPath: Record<string, unknown> = { ...base };
      delete noPath.customer_path;
      expect(() => schema.parse(noPath)).toThrow();
      expect(() => schema.parse({ ...base, customer_path: null })).toThrow();
    }
  });
});
