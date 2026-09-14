// 2026-09-14 改造：useWorkerQueue 测试 fixture → mock API。
//
// 原 fixture 驱动（3 worker / 2 process pool）改为 vi.mock('@/api/workerPool' | '@/api/process')
// 注入稳定 stub 数据。断言 composable 的 loadBoard 聚合逻辑 + moveBatchToWorker/Pool 的
// 乐观更新 + 错误回滚。

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { WorkerPoolDto, WorkerStateDto } from '@/api/workerPool.contract';

// stub processes
const STUB_PROCESSES = [
  { id: '2000000000001', code: 'CNC-01', name: '粗加工' },
  { id: '2000000000002', code: 'QC-01', name: '质检' },
];

// stub WorkerPoolDto（每 process 一个）
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
      placed_at: '2026-09-01T08:00:00Z',
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
      placed_at: '2026-09-01T08:00:00Z',
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
      placed_at: '2026-09-01T08:00:00Z',
      version: 2,
    },
  ],
};

// stub WorkerStateDto（每个 worker 一条；shelf_id='0' 触发 40001 时 catch 兜底）
const STUB_STATES: Record<string, WorkerStateDto> = {
  '1900000000001': {
    worker_id: '1900000000001',
    worker_name: '张三',
    work_type_code: 'CNC',
    max_held: 3,
    current_held: 1,
    capacity_remaining: 2,
    pool_count_by_process: [{ process_id: '2000000000001', pool_count: 2 }],
  },
  '1900000000002': {
    worker_id: '1900000000002',
    worker_name: '李四',
    work_type_code: 'CNC',
    max_held: 3,
    current_held: 0,
    capacity_remaining: 3,
    pool_count_by_process: [{ process_id: '2000000000001', pool_count: 2 }],
  },
  '1900000000003': {
    worker_id: '1900000000003',
    worker_name: '王五',
    work_type_code: 'QC',
    max_held: 2,
    current_held: 2,
    capacity_remaining: 0,
    pool_count_by_process: [{ process_id: '2000000000002', pool_count: 1 }],
  },
};

// mock api/workerPool + api/process（必须在 import composable 之前 hoist）
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
  refillWorkerPool: vi.fn(async () => ({
    worker_id: '1900000000002',
    shelf_id: '5000000000001',
    taken: [],
    pool_empty: true,
  })),
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

vi.mock('@/api/process', () => ({
  listProcesses: vi.fn(async () => ({
    items: STUB_PROCESSES,
    total: STUB_PROCESSES.length,
    limit: 500,
    offset: 0,
  })),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

describe('useWorkerQueue', () => {
  it('loadBoard populates workers / processPools / workerHeld', async () => {
    const { useWorkerQueue } = await import('../useWorkerQueue');
    const q = useWorkerQueue();
    await q.loadBoard();
    expect(q.workers.value).toHaveLength(3);
    expect(q.processPools.value).toHaveLength(2);
    expect(q.processPools.value[0]!.batches).toHaveLength(2);
    expect(q.processPools.value[1]!.batches).toHaveLength(1);
    // 2026-09-14：workerHeld 恒为空（WorkerPoolState 不含 batch 列表）
    expect(q.workerHeld.value).toEqual({});
    expect(q.loading.value).toBe(false);
  });

  it('filteredWorkers：activeTab=2000000000001 命中 W001/W002（不命中 W003）', async () => {
    const { useWorkerQueue } = await import('../useWorkerQueue');
    const q = useWorkerQueue();
    await q.loadBoard();
    const activeTab = '2000000000001';
    const filtered = q.workers.value.filter((w) => w.process_ids.includes(activeTab));
    expect(filtered.map((w) => w.id).sort()).toEqual(['1900000000001', '1900000000002']);
  });

  it('filteredWorkers：activeTab=2000000000002 只命中 W003', async () => {
    const { useWorkerQueue } = await import('../useWorkerQueue');
    const q = useWorkerQueue();
    await q.loadBoard();
    const activeTab = '2000000000002';
    const filtered = q.workers.value.filter((w) => w.process_ids.includes(activeTab));
    expect(filtered.map((w) => w.id)).toEqual(['1900000000003']);
  });

  it('filteredWorkers：activeTab=未知 process_id 返回空', async () => {
    const { useWorkerQueue } = await import('../useWorkerQueue');
    const q = useWorkerQueue();
    await q.loadBoard();
    const activeTab = '9999999999999';
    const filtered = q.workers.value.filter((w) => w.process_ids.includes(activeTab));
    expect(filtered).toEqual([]);
  });

  it('WorkerState 合并：W001 max_held=3 / current_held=1 / capacity_remaining=2', async () => {
    const { useWorkerQueue } = await import('../useWorkerQueue');
    const q = useWorkerQueue();
    await q.loadBoard();
    const w1 = q.workers.value.find((w) => w.id === '1900000000001');
    expect(w1?.max_held).toBe(3);
    expect(w1?.current_held).toBe(1);
    expect(w1?.capacity_remaining).toBe(2);
  });

  it('moveBatchToWorker 调 refillWorkerPool：乐观把 batch 从 pool 移到 workerHeld', async () => {
    const { useWorkerQueue } = await import('../useWorkerQueue');
    const { refillWorkerPool } = await import('@/api/workerPool');
    const q = useWorkerQueue();
    await q.loadBoard();

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
    // 2026-09-14：乐观更新写入 workerHeld
    expect(q.workerHeld.value['1900000000002']).toHaveLength(1);
    expect(q.workerHeld.value['1900000000002']![0]!.batch_id).toBe('3000000000001');
    expect(targetWorker.current_held).toBe(beforeHeld + 1);
    expect(targetWorker.capacity_remaining).toBe(targetWorker.max_held - targetWorker.current_held);
    expect(refillWorkerPool).toHaveBeenCalledWith({
      worker_id: '1900000000002',
      shelf_id: '5000000000001',
    });
  });

  it('moveBatchToWorker 拒绝：目标 worker capacity 已满', async () => {
    const { useWorkerQueue } = await import('../useWorkerQueue');
    const q = useWorkerQueue();
    await q.loadBoard();
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
    await q.loadBoard();
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
