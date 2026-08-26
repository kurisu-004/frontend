// 2026-08-26 新增：worker-pool 域前端 mock 数据。3 个 endpoint 后端未实现前用这份驱动 UI。
// 真实切换点在 src/api/workerPool.ts，每个函数头部有 TODO 标注。

import type { Worker, ProcessPoolView, WorkOrderCard } from '@/types/workerPool'

export const FIXTURE_WORKERS: Worker[] = [
  { id: '1900000000001', name: '张三', badge_code: 'W001', work_type_code: 'CNC', max_held: 3, current_held: 1, capacity_remaining: 2, is_online: true },
  { id: '1900000000002', name: '李四', badge_code: 'W002', work_type_code: 'CNC', max_held: 3, current_held: 0, capacity_remaining: 3, is_online: true },
  { id: '1900000000003', name: '王五', badge_code: 'W003', work_type_code: 'QC',  max_held: 2, current_held: 2, capacity_remaining: 0, is_online: true },
]

export const FIXTURE_PROCESS_POOLS: ProcessPoolView[] = [
  {
    process_id: '2000000000001',
    process_code: 'CNC-01',
    process_name: '粗加工',
    batches: [
      { batch_id: '3000000000001', batch_no: 'B2026-08-001', part_id: '4000000000001', drawing_no: 'DWG-A001', part_name: '法兰盘', quantity: 5, serial_no: null, system_delivery_date: '2026-09-05', planned_delivery_date: '2026-09-03', is_urgent: true,  version: 1 },
      { batch_id: '3000000000002', batch_no: 'B2026-08-002', part_id: '4000000000002', drawing_no: 'DWG-A002', part_name: '齿轮',   quantity: 3, serial_no: null, system_delivery_date: '2026-09-10', planned_delivery_date: '2026-09-10', is_urgent: false, version: 1 },
    ],
  },
  {
    process_id: '2000000000002',
    process_code: 'QC-01',
    process_name: '质检',
    batches: [
      { batch_id: '3000000000003', batch_no: 'B2026-08-003', part_id: '4000000000003', drawing_no: 'DWG-B001', part_name: '轴套', quantity: 8, serial_no: 'SN-001', system_delivery_date: '2026-09-01', planned_delivery_date: '2026-09-01', is_urgent: true, version: 2 },
    ],
  },
]

export const FIXTURE_HELD_BY_WORKER: Record<string, WorkOrderCard[]> = {
  '1900000000001': [
    { batch_id: '3000000000010', batch_no: 'B2026-08-010', part_id: '4000000000010', drawing_no: 'DWG-A010', part_name: '外壳', quantity: 2, serial_no: null, system_delivery_date: '2026-09-08', planned_delivery_date: '2026-09-08', is_urgent: false, version: 1 },
  ],
  '1900000000002': [],
  '1900000000003': [
    { batch_id: '3000000000020', batch_no: 'B2026-08-020', part_id: '4000000000020', drawing_no: 'DWG-C001', part_name: '垫片', quantity: 10, serial_no: 'SN-100', system_delivery_date: '2026-09-02', planned_delivery_date: '2026-09-02', is_urgent: true, version: 4 },
    { batch_id: '3000000000021', batch_no: 'B2026-08-021', part_id: '4000000000021', drawing_no: 'DWG-C002', part_name: '螺栓', quantity: 50, serial_no: null, system_delivery_date: '2026-09-15', planned_delivery_date: '2026-09-15', is_urgent: false, version: 2 },
  ],
}
