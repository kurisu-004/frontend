// 2026-09-11 新增：工序制定页 mock seed。
// 5 个零件（PartListItem 子集，足以展示列表 + 摘要角标）+ 6 个工序（INHOUSE / OUTSOURCE 各 3），
// 其中 2 个零件已预填流程（P-1 法兰盘 3 步含外协；P-3 阀体 2 步全自产）。
//
// 仅供 stage 1（composable + localStorage）使用；阶段二切真接口后此 fixture 即可删除。

import type { PartListItem } from '@/types/parts'
import type { Process } from '@/types/process'
import type { PartProcessFlow, ProcessStep } from '@/types/partProcess'

/** 5 个零件的最小可用子集（仅 PartListItem 必需字段；其它 null/0 占位）。 */
export const FIXTURE_PARTS: PartListItem[] = [
  {
    id: '5000000000001',
    version: 0,
    serial_no: 'P-1',
    name: '法兰盘',
    drawing_no: 'DWG-A-001',
    applicant_name: '张三',
    quantity: 10,
    unit_price: 0,
    total_price: 0,
    request_date: '2026-08-01',
    planned_delivery_date: '2026-09-30',
    actual_delivery_date: null,
    is_urgent: false,
    status: 'PENDING',
    order_no: 'ORD-001',
    system_delivery_date: '2026-09-25',
    delivered_quantity: null,
    note: null,
    customer_name: '杭州汽轮机厂',
    parent_customer_name: null,
    customer_path: null,
    delivery_note_id: null,
    location: 'OFFICE',
    shelf_code: null,
    worker_name: null,
    outsource_company_name: null,
    current_holder_display: '文员持有',
    next_process_id: null,
    next_process_name: null,
  },
  {
    id: '5000000000002',
    version: 0,
    serial_no: 'P-2',
    name: '齿轮',
    drawing_no: 'DWG-A-002',
    applicant_name: '张三',
    quantity: 5,
    unit_price: 0,
    total_price: 0,
    request_date: '2026-08-05',
    planned_delivery_date: '2026-09-30',
    actual_delivery_date: null,
    is_urgent: true,
    status: 'PENDING',
    order_no: 'ORD-002',
    system_delivery_date: null,
    delivered_quantity: null,
    note: null,
    customer_name: '杭州汽轮机厂',
    parent_customer_name: null,
    customer_path: null,
    delivery_note_id: null,
    location: 'OFFICE',
    shelf_code: null,
    worker_name: null,
    outsource_company_name: null,
    current_holder_display: '文员持有',
    next_process_id: null,
    next_process_name: null,
  },
  {
    id: '5000000000003',
    version: 0,
    serial_no: 'P-3',
    name: '阀体',
    drawing_no: 'DWG-B-001',
    applicant_name: '李四',
    quantity: 20,
    unit_price: 0,
    total_price: 0,
    request_date: '2026-08-10',
    planned_delivery_date: '2026-10-15',
    actual_delivery_date: null,
    is_urgent: false,
    status: 'PENDING',
    order_no: 'ORD-003',
    system_delivery_date: '2026-10-10',
    delivered_quantity: null,
    note: null,
    customer_name: '上海电机厂',
    parent_customer_name: null,
    customer_path: null,
    delivery_note_id: null,
    location: 'OFFICE',
    shelf_code: null,
    worker_name: null,
    outsource_company_name: null,
    current_holder_display: '文员持有',
    next_process_id: null,
    next_process_name: null,
  },
  {
    id: '5000000000004',
    version: 0,
    serial_no: 'P-4',
    name: '连接轴',
    drawing_no: 'DWG-C-001',
    applicant_name: '王五',
    quantity: 8,
    unit_price: 0,
    total_price: 0,
    request_date: '2026-08-15',
    planned_delivery_date: '2026-10-30',
    actual_delivery_date: null,
    is_urgent: false,
    status: 'PENDING',
    order_no: null,
    system_delivery_date: null,
    delivered_quantity: null,
    note: null,
    customer_name: '上海电机厂',
    parent_customer_name: null,
    customer_path: null,
    delivery_note_id: null,
    location: 'OFFICE',
    shelf_code: null,
    worker_name: null,
    outsource_company_name: null,
    current_holder_display: '文员持有',
    next_process_id: null,
    next_process_name: null,
  },
  {
    id: '5000000000005',
    version: 0,
    serial_no: 'P-5',
    name: '外壳',
    drawing_no: 'DWG-D-001',
    applicant_name: '赵六',
    quantity: 12,
    unit_price: 0,
    total_price: 0,
    request_date: '2026-08-20',
    planned_delivery_date: '2026-11-05',
    actual_delivery_date: null,
    is_urgent: false,
    status: 'PENDING',
    order_no: 'ORD-005',
    system_delivery_date: '2026-11-01',
    delivered_quantity: null,
    note: null,
    customer_name: '南京机床厂',
    parent_customer_name: null,
    customer_path: null,
    delivery_note_id: null,
    location: 'OFFICE',
    shelf_code: null,
    worker_name: null,
    outsource_company_name: null,
    current_holder_display: '文员持有',
    next_process_id: null,
    next_process_name: null,
  },
]

/** 6 个工序：3 自产 + 3 外协，code/name 模拟真实业务场景。 */
export const FIXTURE_PROCESSES: Process[] = [
  {
    id: '2000000000001', version: 0, code: 'CNC-01', name: '粗加工', category: 'INHOUSE',
    sort_order: 10, description: null, requires_approval: false,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  },
  {
    id: '2000000000002', version: 0, code: 'CNC-02', name: '精加工', category: 'INHOUSE',
    sort_order: 20, description: null, requires_approval: false,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  },
  {
    id: '2000000000003', version: 0, code: 'QC-01', name: '质检', category: 'INHOUSE',
    sort_order: 30, description: null, requires_approval: false,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  },
  {
    id: '2000000000004', version: 0, code: 'OUT-01', name: '热处理', category: 'OUTSOURCE',
    sort_order: 40, description: '外协热处理', requires_approval: true,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  },
  {
    id: '2000000000005', version: 0, code: 'OUT-02', name: '表面喷涂', category: 'OUTSOURCE',
    sort_order: 50, description: '外协喷涂', requires_approval: true,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  },
  {
    id: '2000000000006', version: 0, code: 'OUT-03', name: '电镀', category: 'OUTSOURCE',
    sort_order: 60, description: '外协电镀', requires_approval: true,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  },
]

/** 预填 2 个零件的工序流程：法兰盘 3 步含外协；阀体 2 步全自产。 */
function makeStep(uid: string, process: Process, minutes: number, note: string | null): ProcessStep {
  return {
    uid,
    process_id: process.id,
    process_code: process.code,
    process_name: process.name,
    category: process.category,
    estimated_minutes: minutes,
    note,
    sort_order: 0, // 写入 INITIAL_FLOWS 时由 composable 重写
  }
}

export const FIXTURE_FLOWS: PartProcessFlow[] = [
  {
    part_id: '5000000000001', // 法兰盘
    version: 0,
    steps: [
      makeStep('seed-1-1', FIXTURE_PROCESSES[0]!, 45, '注意装夹方向'),
      makeStep('seed-1-2', FIXTURE_PROCESSES[3]!, 90, null), // 外协热处理
      makeStep('seed-1-3', FIXTURE_PROCESSES[2]!, 15, null), // 质检
    ],
    updated_at: '2026-09-10T08:00:00Z',
  },
  {
    part_id: '5000000000003', // 阀体
    version: 0,
    steps: [
      makeStep('seed-3-1', FIXTURE_PROCESSES[0]!, 60, null),
      makeStep('seed-3-2', FIXTURE_PROCESSES[1]!, 80, '精加工公差 ±0.01'),
    ],
    updated_at: '2026-09-10T08:00:00Z',
  },
]

/** PartFileItem mock（极简字段，仅展示用；不参与业务流程）。 */
export interface MockPartFile {
  id: string
  file_type: string
  original_filename: string
  file_size: number
  /** 内嵌预览用的占位 blob url；后端真接入后改 `api.get(/files/{id}/content, blob)` */
  preview_url: string
}

export const FIXTURE_FILES: Record<string, MockPartFile[]> = {
  '5000000000001': [ // 法兰盘
    { id: 'f-1-1', file_type: 'PDF', original_filename: '法兰盘-总图.pdf', file_size: 234567, preview_url: 'about:blank' },
    { id: 'f-1-2', file_type: 'STEP', original_filename: '法兰盘.stp', file_size: 123456, preview_url: '' },
    { id: 'f-1-3', file_type: 'DWG', original_filename: '法兰盘-CAD.dwg', file_size: 89012, preview_url: '' },
  ],
  '5000000000002': [ // 齿轮
    { id: 'f-2-1', file_type: 'PNG', original_filename: '齿轮.png', file_size: 56789, preview_url: 'about:blank' },
  ],
  '5000000000003': [], // 阀体：无图纸
  '5000000000004': [], // 连接轴：无图纸
  '5000000000005': [], // 外壳：无图纸
}
