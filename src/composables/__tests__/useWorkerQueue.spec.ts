// 2026-09-14 改造：useWorkerQueue 测试 fixture → mock API。
//
// 原 fixture 驱动（3 worker / 2 process pool）改为 vi.mock('@/api/workerPool' | '@/api/process')
// 注入稳定 stub 数据。断言 composable 的 loadBoard 聚合逻辑 + moveBatchToWorker/Pool 的
// 乐观更新 + 错误回滚。
//
// 2026-09-14 follow-up：
// - STUB_STATES 加 held_batches 字段（WorkerStateDto 新增）；loadBoard 后 workerHeld 非空。
// - mock 矩阵把 refillWorkerPool 替换为 assignWorkerPool（assign 端点，单 batch 分配语义）。
// - moveBatchToWorker 成功路径改断言「已分配批次 X 到 Y」；删除 ElMessage.info 路径
//   （assign 端点不会 0 个返回：容量满 / 池外走 ApiError code 路径）。
// - 新增 moveBatchToWorker 失败（assign 端点 20204 WORKER_CAPACITY_EXCEEDED）用例，
//   断言 catch 路径：error.value 含语义、ElMessage.error 被调。
//
// 2026-09-14 follow-up round-2：
// - STUB_HELD_BY_W001 升级为 HeldBatchItemDto 全字段（含 name / customer_name /
//   applicant_name / location / shelf_code / note / parent_customer_name），对应
//   后端 HeldBatchItem 与 HeldBatchItemDto 对齐；消除 heldToCard 字段降级。
// - STUB_HELD_BY_W003 简化为空（任务规约：W002/W003 held_batches = []）。
// - 新增「loadBoard 后 workerHeld 非空且字段完整」用例，断言 W001 持有的 batch
//   字段全部正确（part_name='零件甲' / customer_name='法拉电子' / applicant_name='张三'
//   / location='WORKER'，W002 仍空）。

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ApiError } from '@/api/http';
import type { HeldBatchItemDto, WorkerPoolDto, WorkerStateDto } from '@/api/workerPool.contract';

// stub processes
const STUB_PROCESSES = [
  { id: '2000000000001', code: 'CNC-01', name: '粗加工' },
  { id: '2000000000002', code: 'QC-01', name: '质检' },
];

// 2026-09-14 follow-up round-2：held_batches 元素升级为 HeldBatchItemDto 全字段。
const STUB_HELD_BY_W001: HeldBatchItemDto[] = [
  {
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
    version: 3,
  },
];
// W003 按 task 规约 held_batches = []（不再用旧的 STUB_HELD_BY_W003 双 item 矩阵）；
// 单 item 覆盖已由 W001 提供。

// stub WorkerPoolDto（每 process 一个）
// 2026-09-16 PR-3：PoolBatchItemDto 删 placed_at（t_part_batch 列下线），改用
// current_process_step_id（可选 nullable）。fixture 同步精简。
const STUB_POOL_2000000000001: WorkerPoolDto = {
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
    {
      worker_id: '1900000000002',
      name: '李四',
      work_type_id: '3000000000001',
      work_type_code: 'CNC',
    },
  ],
  work_types: [],
  total: 2,
  items: [
    {
      batch_id: '3000000000001',
      part_id: '4000000000001',
      batch_no: 1,
      quantity: 5,
      serial_no: null,
      name: '法兰盘',
      drawing_no: 'DWG-A001',
      system_delivery_date: '2026-09-05',
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
      current_process_step_id: '5000000000010',
      version: 1,
    },
    {
      batch_id: '3000000000002',
      part_id: '4000000000002',
      batch_no: 1,
      quantity: 3,
      serial_no: null,
      name: '齿轮',
      drawing_no: 'DWG-A002',
      system_delivery_date: '2026-09-10',
      customer_name: null,
      parent_customer_name: null,
      customer_path: null,
      applicant_name: null,
      location: 'PRODUCTION_SHELF',
      shelf_id: '5000000000001',
      shelf_code: 'A-01',
      shelf_name: 'A 区货架 1',
      is_urgent: false,
      note: null,
      current_process_step_id: '5000000000011',
      version: 1,
    },
  ],
};

const STUB_POOL_2000000000002: WorkerPoolDto = {
  process_id: '2000000000002',
  process_code: 'QC-01',
  process_name: '质检',
  workers: [
    {
      worker_id: '1900000000003',
      name: '王五',
      work_type_id: '3000000000002',
      work_type_code: 'QC',
    },
  ],
  work_types: [],
  total: 1,
  items: [
    {
      batch_id: '3000000000003',
      part_id: '4000000000003',
      batch_no: 1,
      quantity: 8,
      serial_no: 'SN-001',
      name: '轴套',
      drawing_no: 'DWG-B001',
      system_delivery_date: '2026-09-01',
      customer_name: null,
      parent_customer_name: null,
      customer_path: null,
      applicant_name: null,
      location: 'PRODUCTION_SHELF',
      shelf_id: '5000000000001',
      shelf_code: 'A-01',
      shelf_name: 'A 区货架 1',
      is_urgent: true,
      note: null,
      current_process_step_id: '5000000000012',
      version: 2,
    },
  ],
};

// stub WorkerStateDto（每个 worker 一条；shelf_id='0' 触发 40001 时 catch 兜底）
// 2026-09-14 follow-up round-2：仅 W001 含 held_batches（W002/W003 按任务规约为空）；
// held_batches 元素类型为 HeldBatchItemDto（含全展示字段，对应 HeldBatchItemDto 16+ 字段）。
const STUB_STATES: Record<string, WorkerStateDto> = {
  '1900000000001': {
    worker_id: '1900000000001',
    worker_name: '张三',
    work_type_code: 'CNC',
    max_held: 3,
    current_held: 1,
    capacity_remaining: 2,
    pool_count_by_process: [{ process_id: '2000000000001', pool_count: 2 }],
    held_batches: STUB_HELD_BY_W001,
  },
  '1900000000002': {
    worker_id: '1900000000002',
    worker_name: '李四',
    work_type_code: 'CNC',
    max_held: 3,
    current_held: 0,
    capacity_remaining: 3,
    pool_count_by_process: [{ process_id: '2000000000001', pool_count: 2 }],
    held_batches: [],
  },
  '1900000000003': {
    worker_id: '1900000000003',
    worker_name: '王五',
    work_type_code: 'QC',
    max_held: 2,
    current_held: 2,
    capacity_remaining: 0,
    pool_count_by_process: [{ process_id: '2000000000002', pool_count: 1 }],
    held_batches: [],
  },
};

// mock api/workerPool + api/processChain（必须在 import composable 之前 hoist）
// 2026-09-14 review 第 1 轮：listProcesses 改 mock 在 @/api/processChain（v2），
// 不再 mock @/api/process（v1）；返回形状从 { items: [...] } 简化为裸数组
// （processChain.ts:49 的封装已剥 envelope）。
// 2026-09-14 follow-up：refillWorkerPool mock 删除，替换为 assignWorkerPool。
vi.mock('@/api/workerPool', () => ({
  getWorkerPoolByProcess: vi.fn(async (processId: string) => {
    if (processId === '2000000000001') return STUB_POOL_2000000000001;
    if (processId === '2000000000002') return STUB_POOL_2000000000002;
    throw new Error('unknown process');
  }),
  getWorkerState: vi.fn(async (params: { worker_id: string }) => {
    const s = STUB_STATES[params.worker_id];
    if (!s) throw new Error('unknown worker');
    return s;
  }),
  assignWorkerPool: vi.fn(async (req: { worker_id: string; batch_id: string }) => {
    // 默认 mock：模拟「分配成功」回执
    const state = STUB_STATES[req.worker_id];
    return {
      worker_id: req.worker_id,
      batch_id: req.batch_id,
      shelf_id: '5000000000001',
      taken: {
        batch_id: req.batch_id,
        part_id: '4000000000001',
        batch_no: 1,
        quantity: 5,
        serial_no: null,
        drawing_no: 'DWG-A001',
        system_delivery_date: '2026-09-05',
        planned_delivery_date: null,
        is_urgent: true,
        version: 2,
      },
      current_held: (state?.current_held ?? 0) + 1,
      max_held: state?.max_held ?? 3,
    };
  }),
  removeFromWorkerPool: vi.fn(async () => ({
    batch_id: '3000000000010',
    part_id: '4000000000010',
    batch_no: 10,
    quantity: 2,
    serial_no: null,
    drawing_no: 'DWG-A010',
    system_delivery_date: '2026-09-08',
    planned_delivery_date: null,
    is_urgent: false,
    version: 2,
  })),
  autoAllocate: vi.fn(async () => ({
    process_id: '2000000000001',
    shelf_id: '5000000000001',
    mode: 'COUNT' as const,
    fill_ratio: 0.5,
    filled: [],
    pool_empty: false,
  })),
}));

vi.mock('@/api/processChain', () => ({
  // listProcesses 在 useWorkerQueue.ts 顶部被 import；返回形状是裸数组
  // （processChain.ts:49 的封装已剥 envelope），不是 { items, total, ... }。
  listProcesses: vi.fn(async () => STUB_PROCESSES),
}));

// 2026-09-14 review 第 2 轮：mock element-plus ElMessage，断言 moveBatchToWorker
// 内部 ElMessage.success / info 调用（替代原 lastTakenCount ref 的 view 层消费）。
// 不导入整个 element-plus（避免拖入 EP 注册副作用），只 stub 用到的命令式 API。
vi.mock('element-plus', () => ({
  ElMessage: {
    success: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

describe('useWorkerQueue', () => {
  it('loadBoard populates workers / processPools / workerHeld（2026-09-14 follow-up round-2：W001 含 1 item / W002/W003 空）', async () => {
    const { useWorkerQueue } = await import('../useWorkerQueue');
    const q = useWorkerQueue();
    await q.loadBoard('5000000000001');
    expect(q.workers.value).toHaveLength(3);
    expect(q.processPools.value).toHaveLength(2);
    expect(q.processPools.value[0]!.batches).toHaveLength(2);
    expect(q.processPools.value[1]!.batches).toHaveLength(1);
    // 2026-09-14 follow-up round-2：workerHeld 不再恒为空，从 WorkerStateDto.held_batches
    // 派生；W001 含 1 个 HeldBatchItemDto 全字段 item，W002/W003 按规约为空。
    expect(q.workerHeld.value['1900000000001']).toHaveLength(1);
    expect(q.workerHeld.value['1900000000001']![0]!.batch_id).toBe('2100000000001');
    expect(q.workerHeld.value['1900000000002']).toEqual([]);
    expect(q.workerHeld.value['1900000000003']).toEqual([]);
    expect(q.loading.value).toBe(false);
  });

  it('loadBoard 后 workerHeld 非空且字段完整（2026-09-14 follow-up round-2：消除字段降级）', async () => {
    const { useWorkerQueue } = await import('../useWorkerQueue');
    const q = useWorkerQueue();
    await q.loadBoard('5000000000001');
    // W001 含 1 个 HeldBatchItemDto 全字段 item
    expect(q.workerHeld.value['1900000000001']).toHaveLength(1);
    const card = q.workerHeld.value['1900000000001']![0]!;
    // 2026-09-14 follow-up round-2：之前降级为 null/空串的字段现在为真值
    expect(card.part_name).toBe('零件甲');
    expect(card.customer).toBe('法拉电子');
    expect(card.applicant).toBe('张三');
    expect(card.location).toBe('WORKER');
    // 其余字段也完整保留（drawing_no / batch_no / quantity / serial_no /
    // system_delivery_date / planned_delivery_date / is_urgent / version）
    expect(card.drawing_no).toBe('DWG-001');
    expect(card.batch_no).toBe('B1');
    expect(card.quantity).toBe(5);
    expect(card.serial_no).toBe('F001-001');
    expect(card.system_delivery_date).toBe('2026-09-30');
    expect(card.planned_delivery_date).toBe('2026-10-15');
    expect(card.is_urgent).toBe(true);
    expect(card.version).toBe(3);
    // W002 仍空
    expect(q.workerHeld.value['1900000000002']).toHaveLength(0);
  });

  it('filteredWorkers：activeTab=2000000000001 命中 W001/W002（不命中 W003）', async () => {
    const { useWorkerQueue } = await import('../useWorkerQueue');
    const q = useWorkerQueue();
    await q.loadBoard('5000000000001');
    const activeTab = '2000000000001';
    const filtered = q.workers.value.filter((w) => w.process_ids.includes(activeTab));
    expect(filtered.map((w) => w.id).sort()).toEqual(['1900000000001', '1900000000002']);
  });

  it('filteredWorkers：activeTab=2000000000002 只命中 W003', async () => {
    const { useWorkerQueue } = await import('../useWorkerQueue');
    const q = useWorkerQueue();
    await q.loadBoard('5000000000001');
    const activeTab = '2000000000002';
    const filtered = q.workers.value.filter((w) => w.process_ids.includes(activeTab));
    expect(filtered.map((w) => w.id)).toEqual(['1900000000003']);
  });

  it('filteredWorkers：activeTab=未知 process_id 返回空', async () => {
    const { useWorkerQueue } = await import('../useWorkerQueue');
    const q = useWorkerQueue();
    await q.loadBoard('5000000000001');
    const activeTab = '9999999999999';
    const filtered = q.workers.value.filter((w) => w.process_ids.includes(activeTab));
    expect(filtered).toEqual([]);
  });

  it('WorkerState 合并：W001 max_held=3 / current_held=1 / capacity_remaining=2', async () => {
    const { useWorkerQueue } = await import('../useWorkerQueue');
    const q = useWorkerQueue();
    await q.loadBoard('5000000000001');
    const w1 = q.workers.value.find((w) => w.id === '1900000000001');
    expect(w1?.max_held).toBe(3);
    expect(w1?.current_held).toBe(1);
    expect(w1?.capacity_remaining).toBe(2);
  });

  it('moveBatchToWorker 调 assignWorkerPool：乐观把 batch 从 pool 移到 workerHeld（2026-09-14 follow-up）', async () => {
    const { useWorkerQueue } = await import('../useWorkerQueue');
    const { assignWorkerPool } = await import('@/api/workerPool');
    const { ElMessage } = await import('element-plus');
    const q = useWorkerQueue();
    await q.loadBoard('5000000000001');

    const pool = q.processPools.value[0]!;
    const beforePool = pool.batches.length;
    const targetWorker = q.workers.value.find((w) => w.id === '1900000000002')!;
    const beforeHeld = targetWorker.current_held;

    const ok = await q.moveBatchToWorker(
      '3000000000001',
      '1900000000002',
      '5000000000001',
      '2000000000001',
    );

    expect(ok).toBe(true);
    expect(pool.batches).toHaveLength(beforePool - 1);
    // 2026-09-14 follow-up：loadBoard 已填 W002 的 STUB_HELD_BY_W002=[]，乐观更新后多 1 条
    expect(q.workerHeld.value['1900000000002']).toHaveLength(1);
    expect(q.workerHeld.value['1900000000002']![0]!.batch_id).toBe('3000000000001');
    expect(targetWorker.current_held).toBe(beforeHeld + 1);
    expect(targetWorker.capacity_remaining).toBe(targetWorker.max_held - targetWorker.current_held);
    // 2026-09-14 follow-up：assignWorkerPool 入参含 batch_id / shelf_id / process_id
    expect(assignWorkerPool).toHaveBeenCalledWith({
      worker_id: '1900000000002',
      batch_id: '3000000000001',
      shelf_id: '5000000000001',
      process_id: '2000000000001',
    });
    // 2026-09-14 follow-up：assign 端点只会成功或抛 ApiError，ElMessage.success 用新文案
    expect(ElMessage.success).toHaveBeenCalledWith('已分配批次 1 到 李四');
    expect(ElMessage.info).not.toHaveBeenCalled();
  });

  it('moveBatchToWorker assign 端点抛 ApiError(20204)：回滚 + ElMessage.error', async () => {
    const { useWorkerQueue } = await import('../useWorkerQueue');
    const { assignWorkerPool } = await import('@/api/workerPool');
    const { ElMessage } = await import('element-plus');
    // 单测隔离：模拟服务端 20204 WORKER_CAPACITY_EXCEEDED（容量触顶，race 场景：
    // 前端乐观更新时 capacity_remaining=1，服务端实际已 0/0 触顶）
    vi.mocked(assignWorkerPool).mockRejectedValueOnce(
      new ApiError(20204, 'WORKER_CAPACITY_EXCEEDED'),
    );
    const q = useWorkerQueue();
    await q.loadBoard('5000000000001');

    const pool = q.processPools.value[0]!;
    const beforePool = pool.batches.length;
    const targetWorker = q.workers.value.find((w) => w.id === '1900000000002')!;
    const beforeHeld = targetWorker.current_held;
    const beforeCap = targetWorker.capacity_remaining;

    const ok = await q.moveBatchToWorker(
      '3000000000001',
      '1900000000002',
      '5000000000001',
      '2000000000001',
    );

    expect(ok).toBe(false);
    expect(q.error.value).toContain('WORKER_CAPACITY_EXCEEDED');
    // 回滚：pool 恢复原 batches；workerHeld 撤销；计数回到原值
    expect(q.processPools.value[0]!.batches).toHaveLength(beforePool);
    expect(q.workerHeld.value['1900000000002']).toEqual([]);
    expect(targetWorker.current_held).toBe(beforeHeld);
    expect(targetWorker.capacity_remaining).toBe(beforeCap);
    // 2026-09-14 follow-up：catch 分支必须弹 ElMessage.error（替代原仅 error.value 静默）
    expect(ElMessage.error).toHaveBeenCalledWith('WORKER_CAPACITY_EXCEEDED');
    expect(ElMessage.success).not.toHaveBeenCalled();
  });

  it('moveBatchToWorker 拒绝：目标 worker capacity 已满（前端预检，2026-09-14 follow-up 保留）', async () => {
    const { useWorkerQueue } = await import('../useWorkerQueue');
    const q = useWorkerQueue();
    await q.loadBoard('5000000000001');
    // W003 王五 capacity_remaining = 0
    const ok = await q.moveBatchToWorker(
      '3000000000001',
      '1900000000003',
      '5000000000001',
      '2000000000001',
    );
    expect(ok).toBe(false);
    expect(q.error.value).toContain('持有已满');
    expect(q.processPools.value[0]!.batches).toHaveLength(2);
  });

  it('moveBatchToPool 调 removeFromWorkerPool：从 workerHeld 移到 pool', async () => {
    const { useWorkerQueue } = await import('../useWorkerQueue');
    const { removeFromWorkerPool } = await import('@/api/workerPool');
    const q = useWorkerQueue();
    await q.loadBoard('5000000000001');
    // 先放一个 batch 到 workerHeld（模拟之前 moveBatchToWorker）
    await q.moveBatchToWorker('3000000000001', '1900000000002', '5000000000001', '2000000000001');
    expect(q.workerHeld.value['1900000000002']).toHaveLength(1);

    const beforePool = q.processPools.value[1]!.batches.length;
    const ok = await q.moveBatchToPool(
      '3000000000001',
      '1900000000002',
      '5000000000001',
      '2000000000002',
    );
    expect(ok).toBe(true);
    expect(q.workerHeld.value['1900000000002']).toHaveLength(0);
    expect(q.processPools.value[1]!.batches.length).toBe(beforePool + 1);
    expect(removeFromWorkerPool).toHaveBeenCalledWith({
      worker_id: '1900000000002',
      batch_id: '3000000000001',
      shelf_id: '5000000000001',
      next_process_id: '2000000000002',
    });
  });
});
