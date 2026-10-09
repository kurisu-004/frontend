// src/views/statistics/composables/__tests__/statisticsSchema.spec.ts
//
// 2026-10-12 新增：statistics 域三条只读端点的 Zod 守门 schema 单测（该域此前零测试）。
//
// 守两类回归：
//
//  1. **正向**：三份响应按后端 VO 的完整字段逐条对齐（雪花 ID 是 JSON string、
//     effective_minutes / step_count 等计数与工时是 JSON number、delivered_value 是
//     Decimal string）都能 parse，且 parse 后类型不被悄悄改写。
//  2. **负向（核心）**：**逐个删掉一个必填字段都必须抛 ZodError**。Zod 默认 strip
//     会把后端漏发的键静默丢掉且不报错 ⇒ 漏声明一个键 = 该字段在界面上恒为 undefined
//     而没人发现。逐键删除是比「挑几个键手写断言」更强的守卫：以后往 schema 里加键而
//     忘了显式声明（写成 optional / 干脆漏掉），本条立刻红。
//
// ⚠️ 本域两个易错点各有专项断言：
//   - `effective_minutes` 是**分钟整数**（JSON number），不是 string —— 它不是雪花 ID，
//     声明成 z.string() 会让整个列表恒空；
//   - `process_id === null` 与 `process_name === '(已删除)'` 是**两种不同的「无名」**，
//     schema 里如实分开声明，UI 占位文案不得混用（见 WorkerDetailTab 的 cellRender）。

import { describe, expect, it } from 'vitest';
import { ZodError, type ZodType } from 'zod';
import {
  overviewOutSchema,
  workerDetailOutSchema,
  workerStatsItemSchema,
  workerStatsListOutSchema,
} from '../statisticsSchema';

/** 逐键删除，每个被删的键都必须让 parse 抛错。 */
function expectEveryKeyRequired(schema: ZodType, obj: Record<string, unknown>): void {
  for (const key of Object.keys(obj)) {
    const clone: Record<string, unknown> = { ...obj };
    delete clone[key];
    expect(() => schema.parse(clone), `删掉「${key}」后必须抛 ZodError`).toThrow(ZodError);
  }
}

// ---------------------------------------------------------------
// fixtures（逐字对齐后端 statistics 域 VO）
// ---------------------------------------------------------------

const OVERVIEW = {
  date_from: '2026-10-01',
  date_to: '2026-10-12',
  created_count: 120,
  completed_count: 96,
  in_process_count: 24,
  delivered_count: 80,
  delivered_value: '153800.50',
  late_orange_count: 3,
  late_red_count: 1,
  overdue_undelivered_count: 2,
  repair_part_count: 4,
  daily_created: [{ date: '2026-10-01', count: 12 }],
  daily_completed: [{ date: '2026-10-01', count: 9 }],
  delivery_performance: { on_time: 70, orange: 8, red: 2 },
  status_distribution: [{ status_value: 'IN_PROCESS', count: 24 }],
};

const WORKER = {
  worker_id: '1900000000000000001',
  worker_name: '张三',
  badge_code: 'A001',
  work_type_id: '1900000000000000010',
  work_type_name: '铣工',
  is_active: true,
  pickup_count: 37,
  pickup_quantity: 41,
  participated_part_count: 18,
  contribution_pct: 23.5,
  effective_minutes: 150,
  worked_process_count: 4,
  worked_batch_count: 22,
};

const DETAIL = {
  worker: {
    id: '1900000000000000001',
    name: '张三',
    badge_code: 'A001',
    work_type_name: '铣工',
    is_active: true,
  },
  pickup_count: 37,
  pickup_quantity: 41,
  participated_part_count: 18,
  return_count: 30,
  daily_pickups: [{ date: '2026-10-01', count: 5 }],
  parts: [
    {
      part_id: '1900000000000000100',
      serial_no: 'SN-0001',
      name: '法兰盘',
      drawing_no: 'DWG-001',
      status: 'IN_PROCESS',
      pickup_count: 3,
      last_pickup_at: '2026-10-10T09:12:00',
    },
  ],
  effective_minutes: 150,
  process_breakdown: [
    {
      process_id: '1900000000000000010',
      process_name: '粗铣',
      step_count: 12,
      effective_minutes: 150,
    },
  ],
};

// ---------------------------------------------------------------

describe('overviewOutSchema', () => {
  it('正向：15 个键齐全即 parse 通过，Decimal 仍是 string', () => {
    const parsed = overviewOutSchema.parse(OVERVIEW);
    expect(parsed.delivered_value).toBe('153800.50');
    expect(parsed.daily_created[0]?.count).toBe(12);
    expect(parsed.delivery_performance.on_time).toBe(70);
    expect(parsed.status_distribution[0]?.status_value).toBe('IN_PROCESS');
  });

  it('负向：逐个删掉任一必填键都必须抛 ZodError', () => {
    expectEveryKeyRequired(overviewOutSchema, OVERVIEW);
  });

  it('delivered_value 传 number 即失败（Decimal 走 JSON string，禁 number 化丢精度）', () => {
    expect(() => overviewOutSchema.parse({ ...OVERVIEW, delivered_value: 153800.5 })).toThrow(
      ZodError,
    );
  });
});

describe('workerStatsItemSchema / workerStatsListOutSchema', () => {
  it('正向：13 个键齐全即 parse 通过，雪花 ID 全链路保持 string', () => {
    const parsed = workerStatsItemSchema.parse(WORKER);
    expect(typeof parsed.worker_id).toBe('string');
    expect(typeof parsed.work_type_id).toBe('string');
    expect(parsed.effective_minutes).toBe(150);
    expect(parsed.worked_process_count).toBe(4);
    expect(parsed.worked_batch_count).toBe(22);
  });

  it('正向：零事件工人（三个工时字段全 0、工种与贡献度为 null）合法 —— 零填充不是缺行', () => {
    const parsed = workerStatsItemSchema.parse({
      ...WORKER,
      work_type_id: null,
      work_type_name: null,
      contribution_pct: null,
      effective_minutes: 0,
      worked_process_count: 0,
      worked_batch_count: 0,
    });
    expect(parsed.contribution_pct).toBeNull();
    expect(parsed.effective_minutes).toBe(0);
  });

  it('正向：信封只有 items 一个键（端点一次性返全部，无分页信封）', () => {
    const parsed = workerStatsListOutSchema.parse({ items: [WORKER] });
    expect(parsed.items).toHaveLength(1);
  });

  it('负向：逐个删掉任一必填键都必须抛 ZodError（含三个工时字段与 contribution_pct）', () => {
    expectEveryKeyRequired(workerStatsItemSchema, WORKER);
    expect(() => workerStatsListOutSchema.parse({})).toThrow(ZodError);
  });

  it('effective_minutes / worked_process_count 传 string 即失败（是 number 不是 string）', () => {
    expect(() => workerStatsItemSchema.parse({ ...WORKER, effective_minutes: '150' })).toThrow(
      ZodError,
    );
    expect(() => workerStatsItemSchema.parse({ ...WORKER, worked_process_count: '4' })).toThrow(
      ZodError,
    );
  });

  it('worker_id 传 number 即失败（wire 上必须是 JSON string，19 位雪花 ID 用 number 会丢精度）', () => {
    // 这里用一个小数字只验「类型」这一层：真正的风险是线上那枚 19 位 ID 被声明成 number
    // 后在 JS 里被静默舍入，而不是这个字面量本身。
    expect(() => workerStatsItemSchema.parse({ ...WORKER, worker_id: 1901 })).toThrow(ZodError);
  });
});

describe('workerDetailOutSchema', () => {
  it('正向：完整响应 parse 通过，工时与工序拆分都拿到', () => {
    const parsed = workerDetailOutSchema.parse(DETAIL);
    expect(parsed.effective_minutes).toBe(150);
    expect(parsed.process_breakdown[0]?.step_count).toBe(12);
    expect(parsed.parts[0]?.serial_no).toBe('SN-0001');
  });

  it('负向：逐个删掉任一必填键都必须抛 ZodError（含 effective_minutes / process_breakdown）', () => {
    expectEveryKeyRequired(workerDetailOutSchema, DETAIL);
  });

  it('负向：worker 子对象逐键也都必填（漏一个键详情页的姓名/工牌就整块空）', () => {
    expectEveryKeyRequired(
      workerDetailOutSchema.shape.worker as ZodType,
      DETAIL.worker as unknown as Record<string, unknown>,
    );
  });

  it('process_breakdown 两种「无名」各自合法且可区分（process_id null vs 工序行缺失）', () => {
    const parsed = workerDetailOutSchema.parse({
      ...DETAIL,
      process_breakdown: [
        // 无工序组：process_id 为 NULL。后端对它也退 '(已删除)' 作名字（LEFT JOIN 取不到名），
        // **区分二者的唯一信号是 process_id**，所以 UI 必须先看 process_id 再谈名字。
        { process_id: null, process_name: '(已删除)', step_count: 5, effective_minutes: 0 },
        // 记了工序 id 但工序行取不到 ⇒ process_id 非空、名字是后端兜底串 '(已删除)'。
        {
          process_id: '1900000000000000011',
          process_name: '(已删除)',
          step_count: 2,
          effective_minutes: 0,
        },
      ],
    });
    expect(parsed.process_breakdown[0]?.process_id).toBeNull();
    expect(parsed.process_breakdown[1]?.process_id).toBe('1900000000000000011');
    expect(parsed.process_breakdown[1]?.process_name).toBe('(已删除)');
  });

  it('process_id 传数字 / process_name 传 null 都失败（前者是雪花 ID，后者恒为 string）', () => {
    const row = {
      process_id: 1901,
      process_name: '粗铣',
      step_count: 1,
      effective_minutes: 30,
    };
    const schema = workerDetailOutSchema.shape.process_breakdown;
    expect(() => schema.parse([row])).toThrow(ZodError);
    expect(() => schema.parse([{ ...row, process_name: null }])).toThrow(ZodError);
  });

  it('负向：空数组合法（零完成记录不是错误态），但缺键不是', () => {
    expect(
      workerDetailOutSchema.parse({ ...DETAIL, process_breakdown: [] }).process_breakdown,
    ).toEqual([]);
    expect(
      workerDetailOutSchema.safeParse({ ...DETAIL, process_breakdown: undefined }).success,
    ).toBe(false);
  });
});
