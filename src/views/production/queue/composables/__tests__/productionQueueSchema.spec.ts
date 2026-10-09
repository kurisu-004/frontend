// @vitest-environment node
// src/views/production/queue/composables/__tests__/productionQueueSchema.spec.ts
//
// 2026-10-08 新建：生产队列域（queue）Zod schema 契约断言。
//
// 本文件是 queue 域 schema 的**唯一**守门点（原先这些用例寄生在
// `composables/queries/__tests__/schemas.spec.ts` 里，随 schema 归位一起搬来）。
// 守的是两类失败模式，两类都在本仓造成过线上事故：
//   - **漏声明必填字段**（M-1 regression guard）：zod 默认 strip 会把未声明的键
//     静默丢弃、parse 仍成功 ⇒ 「守门」形同虚设。表现是模板里出现 undefined、
//     徽标恒 0、请求体少字段。断言一律落在「缺该键 → 抛 ZodError」。
//   - **声明了后端没有的字段**（反向）：parse 在真实响应上 100% 失败 ⇒ 页面永久
//     「加载失败」。断言落在「后端真实形态（含 null / 缺省键）能 parse」。
//
// 覆盖：
//   - Q-S1/Q-S2：queueSnapshotSchema 接受真实快照；缺 pending_count → 抛错。
//   - Q-P1：queueProcessSchema 接受 color = null（工序未设色）与两种 category。
//   - Q-B1：queueBoardSchema 接受完整看板（工人内联持有批次 + 候选池）。
//   - Q-B2：worker 缺 held_batches → 抛错（内联持有批次是消 N+1 的承重字段）。
//   - Q-B3：worker 缺容量三字段任一 → 抛错（漏声明会让进度条恒 0）。
//   - Q-B4：board 缺 items → 抛错。
//   - Q-H1：queueHeldBatchSchema 接受完整行；缺 has_cnc_program → 抛错。
//   - Q-H3：held / 候选池行缺 has_process_chain → 抛错（卡片左边框唯一语义源）。
//   - Q-H2：held 缺 version → 抛错（召回 / move 的 OCC 锚）。
//   - Q-I1：queuePoolItemSchema 缺 shelf_id → 抛错（move `from.shelf_id` 唯一来源）。
//   - Q-PB1：queuePendingBatchSchema 的 planned_delivery_date 是**非 null 字符串**
//           （后端对 NULL 兜底 `1970-01-01`）；给 null 必须抛错，否则前端会把
//           「无计划交期」与兜底值混为一谈。
//   - Q-PB2：列表信封 items / total / limit / offset。
//   - Q-PB3：待下发行缺 process_chain_id → 抛错（「是否已挂工艺链」要靠它）。
//   - Q-PB4：待下发行缺 current_process_step_id → 抛错；「未设 step」是 "0" 非 null。
//   - Q-M1：moveRequestSchema 解析 POOL→WORKER 与 WORKER→WORKER 两个方向。
//   - Q-M2：moveResultSchema 接受 `skip_serializing_if` 四字段**整体省略**的
//           WORKER→WORKER 响应（用 `.nullish()` 而非 `.nullable()` 的理由）。
//   - Q-R1：refillResultSchema + takenItemSchema；taken 缺 has_cnc_program → 抛错。
//   - Q-D1：dispatchRequestSchema 空 targets → 抛错（后端 40001 同形态）。
//   - Q-D2：dispatchResultSchema 接受 `failed` 被整体省略（`.default([])`）。
//   - Q-D3：succeeded[] 缺 current_process_id → 抛错；Option 字段的 null 也收。
//   - Q-D4：有链工单的 current_process_step_id 是**非空字符串**（链首 step 的雪花 id），
//           且出参的 current_process_id 与 target_process_id **同为链首工序**（请求里的
//           target_process_id 已被后端覆盖，不是回声）。
//   - Q-D5：current_process_step_id 传 number → 抛 ZodError（钉住「后端不得退回 number
//           形态」；样本取 19 位雪花 id，超 MAX_SAFE_INTEGER，值本身也是错的）。
//   - Q-AD1：autoDispatchRequestSchema 空 batch_ids → 抛错。
//   - Q-AD2：autoDispatchResultSchema 缺 items → 抛错。
//   - Q-RC1：recallRequestSchema 的 batch_id 必须是字符串（后端 deserialize_i64
//           只收字符串，发数字必 40001）；recallOutSchema 三字段全声明。

import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import {
  autoDispatchRequestSchema,
  autoDispatchResultSchema,
  dispatchRequestSchema,
  dispatchResultSchema,
  moveRequestSchema,
  moveResultSchema,
  queueBoardSchema,
  queueHeldBatchSchema,
  queuePendingBatchListSchema,
  queuePendingBatchSchema,
  queuePoolItemSchema,
  queueProcessSchema,
  queueSnapshotSchema,
  queueWorkerSchema,
  recallOutSchema,
  recallRequestSchema,
  refillResultSchema,
  takenItemSchema,
} from '../productionQueueSchema';

/** QueueHeldBatch 真实形态（18 字段全给齐）。 */
function makeHeld(over: Record<string, unknown> = {}): Record<string, unknown> {
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
    has_process_chain: true,
    has_cnc_program: true,
    customer_name: '法拉电子',
    parent_customer_name: null,
    applicant_name: '张三',
    location: 'WORKER',
    note: '加急',
    version: 3,
    ...over,
  };
}

/** QueueWorker 真实形态（8 字段，持有批次与容量三字段全部内联）。 */
function makeWorker(held: Record<string, unknown>[] = [makeHeld()]): Record<string, unknown> {
  return {
    worker_id: '1900000000001',
    name: '李四',
    work_type_code: 'CNC',
    badge_code: 'G002',
    max_held: 3,
    current_held: held.length,
    capacity_remaining: 3 - held.length,
    held_batches: held,
  };
}

/** QueuePoolItem 真实形态（19 字段全给齐）。 */
function makePoolItem(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    batch_id: '3000000000001',
    part_id: '4000000000001',
    batch_no: 3,
    quantity: 1,
    serial_no: 'SN-0001',
    name: '连杆',
    drawing_no: 'DRW-1',
    system_delivery_date: '2026-10-20',
    customer_name: '某某零件厂',
    parent_customer_name: '某某集团',
    applicant_name: '张三',
    shelf_id: '5000000000001',
    shelf_code: 'A-01',
    shelf_name: '生产架 A',
    is_urgent: false,
    has_process_chain: true,
    has_cnc_program: true,
    note: null,
    version: 2,
    ...over,
  };
}

/** QueuePendingBatch 真实形态（15 字段，planned_delivery_date 非 null）。 */
function makePendingBatch(): Record<string, unknown> {
  return {
    batch_id: '3000000000009',
    part_id: '4000000000009',
    batch_no: 2,
    quantity: 1,
    serial_no: null,
    name: '齿轮',
    drawing_no: 'DRW-9',
    planned_delivery_date: '2026-11-01',
    system_delivery_date: null,
    customer_name: null,
    parent_customer_name: null,
    applicant_name: null,
    is_urgent: false,
    note: null,
    version: 0,
    // 后端非 Option i64 + unwrap_or(0) ⇒ 「未挂」是字符串 "0"，不是 null / 缺省
    current_process_step_id: '0',
    process_chain_id: '0',
  };
}

describe('productionQueueSchema — 队列快照（GET /queue/snapshot）', () => {
  it('Q-S1：接受真实快照（processes 只含 pool_count>0 的工序）', () => {
    const parsed = queueSnapshotSchema.parse({
      processes: [
        {
          process_id: '2000000000001',
          process_code: 'CNC-01',
          process_name: '粗加工',
          color: '#409EFF88',
          category: 'INHOUSE',
          pool_count: 3,
        },
      ],
      pending_count: 12,
      ts: '2026-10-08T09:12:33+08:00',
    });
    expect(parsed.processes[0]?.pool_count).toBe(3);
    expect(parsed.pending_count).toBe(12);
  });

  it('Q-S2：缺 pending_count → 抛 ZodError（tab 标题徽标的唯一数据源）', () => {
    expect(() => queueSnapshotSchema.parse({ processes: [], ts: 'x' })).toThrow();
  });

  it('Q-P1：queueProcessSchema 接受 color = null 与两种 category', () => {
    const base = {
      process_id: '2000000000002',
      process_code: 'OUT-01',
      process_name: '外协',
      color: null,
      pool_count: 0,
    };
    expect(queueProcessSchema.parse({ ...base, category: 'OUTSOURCE' }).color).toBeNull();
    expect(queueProcessSchema.parse({ ...base, category: 'INHOUSE' }).color).toBeNull();
    // category 锁 enum：非法值不可能通过守门（它只会在请求构造阶段就出错）
    expect(() => queueProcessSchema.parse({ ...base, category: 'OTHER' })).toThrow();
  });
});

describe('productionQueueSchema — 单工序看板（GET /queue/processes/{id}）', () => {
  function makeBoard(): Record<string, unknown> {
    return {
      process: {
        process_id: '2000000000001',
        process_code: 'CNC-01',
        process_name: '粗加工',
        color: '#409EFF88',
      },
      workers: [makeWorker()],
      items: [makePoolItem()],
      total: 1,
      ts: '2026-10-08T09:12:33+08:00',
    };
  }

  it('Q-B1：接受完整看板（工人内联持有批次 + 容量，候选池跨所有货架）', () => {
    const parsed = queueBoardSchema.parse(makeBoard());
    expect(parsed.workers[0]?.capacity_remaining).toBe(2);
    expect(parsed.workers[0]?.held_batches).toHaveLength(1);
    expect(parsed.items[0]?.shelf_id).toBe('5000000000001');
    expect(parsed.total).toBe(1);
  });

  it('Q-B2：worker 缺 held_batches → 抛 ZodError（消 N+1 的承重字段）', () => {
    const { held_batches: _dropped, ...worker } = makeWorker();
    void _dropped;
    expect(() => queueWorkerSchema.parse(worker)).toThrow();
  });

  it('Q-B3：worker 缺容量三字段任一 → 抛 ZodError（漏声明会让进度条恒 0）', () => {
    for (const key of ['max_held', 'current_held', 'capacity_remaining'] as const) {
      const worker: Record<string, unknown> = { ...makeWorker() };
      delete worker[key];
      expect(() => queueWorkerSchema.parse(worker)).toThrow();
    }
  });

  it('Q-B4：board 缺 items → 抛 ZodError', () => {
    const { items: _dropped, ...board } = makeBoard();
    void _dropped;
    expect(() => queueBoardSchema.parse(board)).toThrow();
  });
});

describe('productionQueueSchema — 持有批次 / 候选池行', () => {
  it('Q-H1：queueHeldBatchSchema 接受完整行；缺 has_cnc_program → 抛 ZodError', () => {
    expect(queueHeldBatchSchema.parse(makeHeld()).has_cnc_program).toBe(true);
    const { has_cnc_program: _dropped, ...rest } = makeHeld();
    void _dropped;
    expect(() => queueHeldBatchSchema.parse(rest)).toThrow();
  });

  it('Q-H2：held 缺 version → 抛 ZodError（召回 / move 的 OCC 锚）', () => {
    const { version: _dropped, ...rest } = makeHeld();
    void _dropped;
    expect(() => queueHeldBatchSchema.parse(rest)).toThrow();
  });

  // 2026-10-09 后端派生列：批次卡片左边框的唯一语义源。漏声明 ⇒ strip ⇒ 卡片恒灰边框，
  // 而「这批有没有链」正是工人判读卡片的第一诉求（静默错色而不是报错）。
  it('Q-H3：held / 候选池行缺 has_process_chain → 抛 ZodError（真值两态都收）', () => {
    expect(queueHeldBatchSchema.parse(makeHeld()).has_process_chain).toBe(true);
    expect(
      queueHeldBatchSchema.parse(makeHeld({ has_process_chain: false })).has_process_chain,
    ).toBe(false);
    const noHeld: Record<string, unknown> = { ...makeHeld() };
    delete noHeld.has_process_chain;
    expect(() => queueHeldBatchSchema.parse(noHeld)).toThrow();

    const noPool: Record<string, unknown> = { ...makePoolItem() };
    delete noPool.has_process_chain;
    expect(() => queuePoolItemSchema.parse(noPool)).toThrow();
    expect(queuePoolItemSchema.parse(makePoolItem({ has_process_chain: false })).has_process_chain)
      .toBe(false);
    // 非布尔形态（后端漏 serialize 成 0 / 1 或字符串）必须被拒
    expect(() =>
      queuePoolItemSchema.parse({ ...makePoolItem(), has_process_chain: 'true' }),
    ).toThrow();
  });

  it('Q-I1：queuePoolItemSchema 缺 shelf_id → 抛 ZodError（move from.shelf_id 唯一来源）', () => {
    const { shelf_id: _dropped, ...rest } = makePoolItem();
    void _dropped;
    expect(() => queuePoolItemSchema.parse(rest)).toThrow();
  });
});

describe('productionQueueSchema — 待下发（GET /queue/pending）', () => {
  it('Q-PB1：planned_delivery_date 是非 null 字符串（后端对 NULL 兜底 1970-01-01）', () => {
    expect(queuePendingBatchSchema.parse(makePendingBatch()).planned_delivery_date).toBe(
      '2026-11-01',
    );
    const { planned_delivery_date: _dropped, ...rest } = makePendingBatch();
    void _dropped;
    expect(() => queuePendingBatchSchema.parse(rest)).toThrow();
    expect(() =>
      queuePendingBatchSchema.parse({ ...makePendingBatch(), planned_delivery_date: null }),
    ).toThrow();
  });

  it('Q-PB2：列表信封 items / total / limit / offset', () => {
    const parsed = queuePendingBatchListSchema.parse({
      items: [makePendingBatch()],
      total: 1,
      limit: 200,
      offset: 0,
    });
    expect(parsed.items).toHaveLength(1);
    expect(parsed.total).toBe(1);
    expect(() => queuePendingBatchListSchema.parse({ items: [], total: 1 })).toThrow();
  });

  it('Q-PB3：缺 process_chain_id → 抛错（漏声明会被 strip 静默丢掉，值恒 undefined）', () => {
    // 漏声明这条键，parse 照样成功而值被 zod strip 掉 ⇒ 将来做「未制定工序链」提示时
    // 读到的永远是 undefined，且没有任何报错可查。断言落在「缺键必须抛」。
    const { process_chain_id: _dropped, ...rest } = makePendingBatch();
    void _dropped;
    expect(() => queuePendingBatchSchema.parse(rest)).toThrow();
    expect(queuePendingBatchSchema.parse(makePendingBatch()).process_chain_id).toBe('0');
  });

  it('Q-PB4：current_process_step_id 同样必声明，且「未设 step」是 "0" 而非 null', () => {
    const { current_process_step_id: _dropped, ...rest } = makePendingBatch();
    void _dropped;
    expect(() => queuePendingBatchSchema.parse(rest)).toThrow();
    // 后端是 i64 + unwrap_or(0)，DB NULL 投影成 "0"；收 null 会让真响应 parse 失败。
    expect(queuePendingBatchSchema.parse(makePendingBatch()).current_process_step_id).toBe('0');
    expect(() =>
      queuePendingBatchSchema.parse({ ...makePendingBatch(), current_process_step_id: null }),
    ).toThrow();
  });
});

describe('productionQueueSchema — move / refill', () => {
  it('Q-M1：moveRequestSchema 解析 POOL→WORKER 与 WORKER→WORKER 两个方向', () => {
    expect(
      moveRequestSchema.parse({
        batch_id: '3000000000001',
        from: { kind: 'POOL', shelf_id: '5000000000001' },
        to: { kind: 'WORKER', worker_id: '1900000000001' },
      }).from.kind,
    ).toBe('POOL');
    const ww = moveRequestSchema.parse({
      batch_id: '3000000000001',
      from: { kind: 'WORKER', worker_id: '1900000000001' },
      to: { kind: 'WORKER', worker_id: '1900000000002' },
      note: '转交',
    });
    expect(ww.to).toMatchObject({ kind: 'WORKER', worker_id: '1900000000002' });
  });

  it('Q-M2：moveResultSchema 接受 skip_serializing_if 四字段整体省略的响应', () => {
    // WORKER→WORKER 响应里 current_held / max_held / shelf_id / taken 四个字段
    // **不存在**（不是 null）⇒ schema 必须用 .nullish()；用 .nullable() 会在
    // 真实响应上直接抛错。
    const parsed = moveResultSchema.parse({
      batch_id: '3000000000001',
      from_kind: 'WORKER',
      to_kind: 'WORKER',
      new_holder_id: '1900000000002',
      new_location: 'WORKER',
      version: 4,
    });
    expect(parsed.current_held).toBeUndefined();
    expect(parsed.taken).toBeUndefined();
  });

  it('Q-R1：refillResultSchema + takenItemSchema；taken 缺 has_cnc_program → 抛 ZodError', () => {
    const parsed = refillResultSchema.parse({
      worker_id: '1900000000001',
      shelf_id: '5000000000001',
      taken: [
        {
          batch_id: '3000000000001',
          part_id: '4000000000001',
          batch_no: 3,
          quantity: 1,
          serial_no: null,
          drawing_no: 'DRW-1',
          system_delivery_date: null,
          planned_delivery_date: null,
          is_urgent: false,
          version: 2,
          has_cnc_program: false,
        },
      ],
      pool_empty: false,
    });
    expect(parsed.taken).toHaveLength(1);
    const { has_cnc_program: _dropped, ...rest } = parsed.taken[0]!;
    void _dropped;
    expect(() => takenItemSchema.parse(rest)).toThrow();
  });
});

describe('productionQueueSchema — dispatch / auto-dispatch', () => {
  it('Q-D1：dispatchRequestSchema 空 targets → 抛 ZodError（后端 40001 同形态）', () => {
    expect(() => dispatchRequestSchema.parse({ targets: [] })).toThrow();
    expect(
      dispatchRequestSchema.parse({
        targets: [{ batch_id: '3000000000001', target_process_id: '2000000000001' }],
      }).targets,
    ).toHaveLength(1);
  });

  it('Q-D2：dispatchResultSchema 接受 failed 被整体省略（.default([]) 兜底）', () => {
    const parsed = dispatchResultSchema.parse({
      succeeded: [
        {
          batch_id: '3000000000001',
          current_process_step_id: null,
          current_process_id: '2000000000001',
          target_process_id: '2000000000001',
          shelf_id: '5000000000001',
          version: 1,
        },
      ],
    });
    expect(parsed.failed).toEqual([]);
    expect(parsed.succeeded[0]?.current_process_step_id).toBeNull();
  });

  it('Q-D3：succeeded[] 的 current_process_id 必须声明（后端 Option，null 合法）', () => {
    // 后端 DispatchSuccessItem 第 3 个字段。漏声明时值被 strip 掉，而 succeeded 是
    // 「下发成功」的回报，消费方读它却拿到 undefined 且无报错。
    const base = {
      batch_id: '3000000000001',
      current_process_step_id: null,
      target_process_id: '2000000000001',
      shelf_id: '5000000000001',
      version: 1,
    };
    expect(() => dispatchResultSchema.parse({ succeeded: [base] })).toThrow();
    const ok = dispatchResultSchema.parse({
      succeeded: [{ ...base, current_process_id: '2000000000001' }],
    });
    expect(ok.succeeded[0]?.current_process_id).toBe('2000000000001');
    // Option 字段，None → JSON null 也要能收
    expect(
      dispatchResultSchema.parse({ succeeded: [{ ...base, current_process_id: null }] })
        .succeeded[0]?.current_process_id,
    ).toBeNull();
  });

  it('Q-D4：有链工单的 current_process_step_id 是非空字符串（链首 step 的雪花 id）', () => {
    // 有工序链的工单下发到**链首工序**、step 指针落**链首 step**，于是出参
    // current_process_step_id 有真值。出参的 current_process_id 与 target_process_id
    // 同为链首工序 —— 请求里的 target_process_id 已被后端用链首工序覆盖，出参不是它的
    // 回声（只有无链工单才相等）。本用例与 Q-D2 / Q-D3 的 null 形态互补 —— 两态都必
    // 须能 parse。
    const parsed = dispatchResultSchema.parse({
      succeeded: [
        {
          batch_id: '3000000000001',
          current_process_step_id: '1900000000000000001',
          current_process_id: '2000000000001',
          target_process_id: '2000000000001',
          shelf_id: '5000000000001',
          version: 1,
        },
      ],
    });
    expect(parsed.succeeded[0]?.current_process_step_id).toBe('1900000000000000001');
    expect(parsed.succeeded[0]?.current_process_id).toBe('2000000000001');
    expect(parsed.succeeded[0]?.target_process_id).toBe('2000000000001');
  });

  it('Q-D5：current_process_step_id 不得退回 number 形态（形态守卫）', () => {
    // 负向守卫：后端漏加字符串化器时该字段落成 JSON number，parse 抛在 HTTP 200 之后 ⇒
    // 线上表现为「批次确实下发下去了，界面却报下发失败」。样本取 19 位雪花 id 量级：
    // axios 侧解析即已丢精度（Number('1900000000000000001') === 1900000000000000000，
    // 超 MAX_SAFE_INTEGER），所以 number 形态不只是类型不符，值本身也是错的。写成
    // 字面量会被 no-loss-of-precision 拦下，故走 Number()。
    expect(() =>
      dispatchResultSchema.parse({
        succeeded: [
          {
            batch_id: '3000000000001',
            current_process_step_id: Number('1900000000000000001'),
            current_process_id: '2000000000001',
            target_process_id: '2000000000001',
            shelf_id: '5000000000001',
            version: 1,
          },
        ],
      }),
    ).toThrow(ZodError);
  });

  it('Q-AD1：autoDispatchRequestSchema 空 batch_ids → 抛 ZodError', () => {
    expect(() => autoDispatchRequestSchema.parse({ batch_ids: [] })).toThrow();
  });

  it('Q-AD2：autoDispatchResultSchema 缺 items → 抛 ZodError', () => {
    expect(() => autoDispatchResultSchema.parse({})).toThrow();
    expect(
      autoDispatchResultSchema.parse({
        items: [
          {
            batch_id: '3000000000001',
            part_id: '4000000000001',
            process_chain_id: '6000000000001',
            first_process_id: null,
            first_process_code: '',
            first_process_name: '',
            first_shelf_id: null,
            skip_reason: 'NO_PROCESS_CHAIN',
          },
        ],
      }).items[0]?.skip_reason,
    ).toBe('NO_PROCESS_CHAIN');
  });
});

describe('productionQueueSchema — recall', () => {
  it('Q-RC1：batch_id 必须是字符串（后端 deserialize_i64 只收字符串）', () => {
    expect(recallRequestSchema.parse({ batch_id: '3000000000001', version: 2 }).version).toBe(2);
    expect(() => recallRequestSchema.parse({ batch_id: 3000000000001, version: 2 })).toThrow();
    expect(() => recallRequestSchema.parse({ batch_id: '3000000000001' })).toThrow();
  });

  it('Q-RC2：recallOutSchema 三字段全声明（version 是 batch.version + 1）', () => {
    const parsed = recallOutSchema.parse({
      batch_id: '3000000000001',
      part_id: '4000000000001',
      version: 3,
    });
    expect(parsed.version).toBe(3);
    expect(() => recallOutSchema.parse({ batch_id: '3000000000001', part_id: 'x' })).toThrow();
  });
});