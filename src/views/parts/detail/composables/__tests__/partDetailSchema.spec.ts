// src/views/parts/detail/composables/__tests__/partDetailSchema.spec.ts
//
// 零件详情域 schema 的契约断言（`GET /parts/{id}` / `GET /parts/{id}/events` /
// `GET /prod/process-chains/{id}` 三个出参）。
//
// 这些断言存在的原因：前端旧 `PartItem` 曾把三个后端 VO 合成一个 30 字段联合类型，
// 声明了十几个后端一个都不返的字段（customer_path / current_holder_display /
// location / batch_no / has_process_chain …），渲染出的「客户」「所在位置」「批次」
// 等格子在现场恒为空。以 VO 为准的 `.strict()` schema 是唯一能当场炸出来的守门。
//
// 覆盖：
//   - D1：28 字段全量对象能 parse，且解析结果键集合与 fixture 逐键对齐（不多不少）；
//   - D2：`.strict()` 守门 —— 多一个键立刻抛（幽灵字段回流即红）；
//   - D3：缺任一必填键都抛（Zod strip 陷阱 guard）；
//   - D4：`unit_price` / `total_price` 是 JSON **string**（后端 Decimal + serde-with-str），
//     发 number 必须抛；
//   - D5：`serial_no` / `assembly_id` / `note` 等可空键可为 null；
//   - D6：雪花 ID 一律 string —— 发 number 必须抛（19 位 ID 在 JS Number 下丢精度）；
//   - D7：`status` 用 enum 守门（10 态），未知字面量抛；
//   - E1：`partEventSchema` 的 `batch_no` 是**裸 JSON number**（发 string 抛），
//     三个新增人名字段可为 null；
//   - E1b / E1c：不加 `.strict()` 时未知键被 strip、三个新增人名为 null；
//   - E3：**缺那 4 个键（后端未上 `feat/part-detail-contract` 分支）仍能 parse 通过** ——
//     这是两仓能独立上线的关键，声明必填时后端未先上会让历史卡整块空白 + 假错误；
//   - E4：键存在时仍守类型（batch_no 发 string 抛、核心 id / batch_id 缺仍抛）；
//   - E2：`created_at` / `event_type` / `id` 必填；
//   - F1：工序链 header + steps 能 parse；step 的 `note` **键可以整个不存在**
//     （后端 `skip_serializing_if = "Option::is_none"`），声明成 `.nullable()` 会炸。

import { describe, expect, it } from 'vitest';
import {
  partDetailSchema,
  partEventSchema,
  processChainSchema,
  processChainStepSchema,
} from '../partDetailSchema';

function makeDetail(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '219276974948876288',
    serial_no: 'F1889-01',
    name: '子零件',
    drawing_no: 'DWG-1889',
    applicant_name: '张工',
    quantity: 5,
    request_date: '2026-10-01',
    planned_delivery_date: '2026-10-20',
    customer_id: '9000000000001',
    assembly_id: '219276974734966784',
    status: 'IN_PROCESS',
    is_urgent: true,
    next_process_id: null,
    order_no: 'SO-6200037950',
    system_delivery_date: null,
    note: null,
    unit_price: '12.50',
    total_price: '62.50',
    version: 3,
    created_at: '2026-10-01 09:00:00',
    created_by: null,
    updated_at: '2026-10-02 10:00:00',
    updated_by: '9000000000002',
    deleted_at: null,
    process_chain_id: '9000000000010',
    customer_name: '二级客户',
    l1_customer_name: '一级客户',
    current_batch_id: null,
    ...overrides,
  };
}

function makeEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '3000000000001',
    event_type: 'INSPECTED',
    from_status: 'INSPECTION',
    to_status: 'READY_TO_SHIP',
    batch_id: '3000000000002',
    batch_no: 3,
    quantity: 5,
    drawing_code: null,
    badge_code: 'B-001',
    note: null,
    created_at: '2026-10-03 11:00:00',
    created_by: '9000000000002',
    worker_name: '李四',
    operator_name: '王五',
    operator_username: 'wangwu',
    ...overrides,
  };
}

describe('partDetailSchema — 零件详情（28 字段 .strict()）', () => {
  it('D1：完整 28 字段通过解析，解析结果键集合与 fixture 逐键对齐', () => {
    const detail = makeDetail();
    expect(Object.keys(detail)).toHaveLength(28);
    const parsed = partDetailSchema.parse(detail);
    expect(Object.keys(parsed).sort()).toEqual(Object.keys(detail).sort());
    expect(parsed.id).toBe('219276974948876288');
    expect(parsed.l1_customer_name).toBe('一级客户');
    expect(parsed.customer_name).toBe('二级客户');
    expect(parsed.version).toBe(3);
  });

  it('D2：多一个键立刻抛错（.strict() 守门：幽灵字段回流即红）', () => {
    // 这 9 个键正是旧 `PartItem` 声明而后端从不返的字段。任何一条被加回 schema /
    // 被误当作「后端会返」写进消费侧时，这条会红。
    for (const key of [
      'customer_path',
      'parent_customer_name',
      'current_holder_kind',
      'shelf_code',
      'worker_name',
      'outsource_company_name',
      'current_holder_display',
      'location',
      'next_process_name',
      'batch_no',
      'batch_id',
      'batch_label',
      'batch_version',
      'last_inspection_fail_note',
      'has_process_chain',
    ]) {
      expect(
        () => partDetailSchema.parse(makeDetail({ [key]: null })),
        `多出 ${key} 应当抛错`,
      ).toThrow();
    }
  });

  it('D3：缺任一必填键都抛 ZodError（逐字段 strip 陷阱 guard）', () => {
    for (const key of Object.keys(makeDetail())) {
      if (
        [
          'serial_no',
          'assembly_id',
          'next_process_id',
          'system_delivery_date',
          'note',
          'created_by',
          'updated_by',
          'deleted_at',
          'process_chain_id',
          'customer_name',
          'l1_customer_name',
          'current_batch_id',
        ].includes(key)
      ) {
        continue;
      }
      const detail = makeDetail();
      delete detail[key];
      expect(() => partDetailSchema.parse(detail), `缺 ${key} 应当抛错`).toThrow();
    }
  });

  it('D4：unit_price / total_price 是 JSON string，发 number 抛错', () => {
    const ok = partDetailSchema.parse(makeDetail());
    expect(ok.unit_price).toBe('12.50');
    expect(ok.total_price).toBe('62.50');
    expect(() => partDetailSchema.parse(makeDetail({ unit_price: 12.5 }))).toThrow();
    expect(() => partDetailSchema.parse(makeDetail({ total_price: 62.5 }))).toThrow();
  });

  it('D5：可空键传 null 也能解析（DB NULL ⇒ JSON null）', () => {
    const parsed = partDetailSchema.parse(
      makeDetail({
        serial_no: null,
        assembly_id: null,
        next_process_id: null,
        order_no: null,
        system_delivery_date: null,
        note: null,
        created_by: null,
        updated_by: null,
        deleted_at: null,
        process_chain_id: null,
        customer_name: null,
        l1_customer_name: null,
        current_batch_id: null,
      }),
    );
    expect(parsed.serial_no).toBeNull();
    expect(parsed.l1_customer_name).toBeNull();
  });

  it('D6：雪花 ID 一律 string —— 发 number 抛错（禁 Number()，19 位 ID 丢精度）', () => {
    for (const key of [
      'id',
      'customer_id',
      'assembly_id',
      'next_process_id',
      'current_batch_id',
      'process_chain_id',
      'created_by',
      'updated_by',
    ]) {
      expect(
        () => partDetailSchema.parse(makeDetail({ [key]: 219276974948876288 })),
        `${key} 发 number 应当抛错`,
      ).toThrow();
    }
  });

  it('D7：status 用 10 态 enum 守门，未知字面量抛错', () => {
    expect(partDetailSchema.parse(makeDetail({ status: 'CANCELLED' })).status).toBe('CANCELLED');
    expect(() => partDetailSchema.parse(makeDetail({ status: 'SHIPPED' }))).toThrow();
  });
});

describe('partEventSchema — 零件事件（11 + 4 字段）', () => {
  it('E1：完整 15 字段通过；batch_no 是裸 JSON number（发 string 抛错）', () => {
    const evt = makeEvent();
    expect(Object.keys(evt)).toHaveLength(15);
    const parsed = partEventSchema.parse(evt);
    expect(Object.keys(parsed).sort()).toEqual(Object.keys(evt).sort());
    expect(parsed.batch_no).toBe(3);
    // 工单内批次序号是 i32 ⇒ number；**不是**雪花 ID 字符串，也不是字符串化数字
    expect(() => partEventSchema.parse(makeEvent({ batch_no: '3' }))).toThrow();
    // 批次号可空（工单级事件）
    expect(partEventSchema.parse(makeEvent({ batch_no: null })).batch_no).toBeNull();
  });

  it('E1b：后端不返的键（part_id / worker_id）被 strip 掉，消费侧读到的是 undefined', () => {
    // 本 schema **不加** `.strict()`（与 `partDetailSchema` 不同）：事件行没有「两个后端
    // VO 共用同一形状」的混淆风险，Zod 默认的 strip 语义在这里更好 —— 后端将来加一个
    // 展示用字段不会让零件详情页整页白屏。代价是未知键被静默丢掉，所以这里把它钉成
    // 断言：消费侧若又去读 `evt.part_id` / `evt.worker_id`，拿到的是 undefined 而不是值。
    const parsed = partEventSchema.parse(makeEvent({ part_id: '1', worker_id: '2' }));
    expect('part_id' in parsed).toBe(false);
    expect('worker_id' in parsed).toBe(false);
    expect(Object.keys(parsed).sort()).toEqual(Object.keys(makeEvent()).sort());
  });

  it('E1c：三个人名字段可空（后端 LEFT JOIN 未命中时为 null）', () => {
    const parsed = partEventSchema.parse(
      makeEvent({ worker_name: null, operator_name: null, operator_username: null }),
    );
    expect(parsed.worker_name).toBeNull();
    expect(parsed.operator_name).toBeNull();
    expect(parsed.operator_username).toBeNull();
  });

  it('E2：created_at / event_type / id 必填，缺任一抛错', () => {
    for (const key of ['id', 'event_type', 'created_at'] as const) {
      const evt = makeEvent();
      delete evt[key];
      expect(() => partEventSchema.parse(evt), `缺 ${key} 应当抛错`).toThrow();
    }
    expect(() => partEventSchema.parse(makeEvent({ id: 3 }))).toThrow();
  });

  // 这四个键只存在于后端 `feat/part-detail-contract` 分支（未进 master）的
  // `PartEventOut` 上。声明成必填时，后端未先行上线 ⇒ 整条 events 响应 100% parse
  // 失败 ⇒ 历史卡整块空白 + 每次进页一条假错误，而详情 query 正常（排障易误查
  // 权限 / 网络）。`.nullish()` 让两仓能各自独立上线与回滚。
  it('E3：后端未上那四个字段时（键整个不存在）仍能 parse 通过（两仓可独立上线）', () => {
    const evt = makeEvent();
    for (const key of ['batch_no', 'worker_name', 'operator_name', 'operator_username']) {
      delete evt[key];
    }
    const parsed = partEventSchema.parse(evt);
    expect(parsed.batch_no).toBeUndefined();
    expect(parsed.worker_name).toBeUndefined();
    expect(parsed.operator_name).toBeUndefined();
    expect(parsed.operator_username).toBeUndefined();
    // 展示位降级是「不渲染」而不是「报错」：PartHistoryCard 三处都是 v-if
    expect(Boolean(parsed.batch_no)).toBe(false);
    // 核心 11 字段一个都不能少（守住「nullish 只降级那四个展示键」这条边界）
    expect(parsed.id).toBe('3000000000001');
    expect(parsed.batch_id).toBe('3000000000002');
    expect(parsed.created_at).toBe('2026-10-03 11:00:00');
  });

  it('E4：键存在时仍守类型 —— batch_no 发字符串抛、id 缺仍抛（没有一起降级成 any）', () => {
    expect(() => partEventSchema.parse(makeEvent({ batch_no: '3' }))).toThrow();
    expect(() => partEventSchema.parse(makeEvent({ worker_name: 4 }))).toThrow();
    const noId = makeEvent();
    delete noId.id;
    expect(() => partEventSchema.parse(noId)).toThrow();
    const noBatchId = makeEvent();
    delete noBatchId.batch_id;
    expect(() => partEventSchema.parse(noBatchId)).toThrow();
  });
});

describe('processChainSchema — 工序链', () => {
  const chain = {
    id: '9000000000010',
    name: '默认工艺',
    note: null,
    version: 2,
    created_at: '2026-09-20 08:00:00',
    updated_at: '2026-09-21 08:00:00',
    steps: [
      {
        id: '9100000000001',
        sort_order: 0,
        process_id: '9200000000001',
        estimated_minutes: 30,
        note: null,
        version: 1,
      },
      {
        id: '9100000000002',
        sort_order: 1,
        process_id: '9200000000002',
        estimated_minutes: 45,
        note: '首检',
        version: 1,
      },
    ],
  };

  it('F1：header + steps 能解析', () => {
    const parsed = processChainSchema.parse(chain);
    expect(parsed.id).toBe('9000000000010');
    expect(parsed.steps).toHaveLength(2);
    expect(parsed.steps[1]?.note).toBe('首检');
  });

  it('F2：step 的 note 键整个不存在也能解析（后端 skip_serializing_if = Option::is_none）', () => {
    // 后端 `ProcessChainStepOut.note` 挂了 skip_serializing_if：空备注时键**不出现在
    // JSON 里**（不是 null）。声明成 `.nullable()` 会让「某一步没写备注」整条响应炸掉，
    // 故本字段是 `.nullish()`。
    const parsed = processChainSchema.parse({
      ...chain,
      steps: [
        {
          id: '9100000000003',
          sort_order: 0,
          process_id: '9200000000003',
          estimated_minutes: 10,
          version: 1,
        },
      ],
    });
    expect(parsed.steps[0]?.note).toBeUndefined();
    // 对照：note 显式传 null 也接受
    expect(
      processChainStepSchema.parse({
        id: '9100000000004',
        sort_order: 0,
        process_id: '9200000000004',
        estimated_minutes: 10,
        note: null,
        version: 1,
      }).note,
    ).toBeNull();
  });

  it('F3：step 的 id / process_id 是雪花 ID 字符串，发 number 抛错', () => {
    expect(() =>
      processChainStepSchema.parse({
        id: 9100000000003,
        sort_order: 0,
        process_id: 9200000000003,
        estimated_minutes: 10,
        version: 1,
      }),
    ).toThrow();
  });

  it('F4：缺 steps / version 抛错', () => {
    const noSteps: Record<string, unknown> = { ...chain };
    delete noSteps.steps;
    expect(() => processChainSchema.parse(noSteps)).toThrow();
    const noVersion: Record<string, unknown> = { ...chain };
    delete noVersion.version;
    expect(() => processChainSchema.parse(noVersion)).toThrow();
  });
});
