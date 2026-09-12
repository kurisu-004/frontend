// 2026-09-11 新增：工序制定页 mock seed。
// 5 个零件（PartListItem 子集，足以展示列表 + 摘要角标）+ 6 个工序（INHOUSE / OUTSOURCE 各 3），
// 其中 2 个零件已预填流程（P-1 法兰盘 3 步含外协；P-3 阀体 2 步全自产）。
//
// 仅供 stage 1（composable + localStorage）使用；阶段二切真接口后此 fixture 即可删除。

import type { PartListItem } from '@/types/parts'
import type { Process } from '@/types/process'
import type { PartProcessFlow, ProcessStep } from '@/types/partProcess'
// 2026-09-12 新增：通过 Vite ?url 引入 dev 模式测试 PDF，避免 about:blank 占位无内容。
// 生成脚本：scripts/generate-test-pdf.mjs（npm run fixture:pdf）
import sampleDrawing from './sample-drawing.pdf?url'

/** 5 个零件的最小可用子集（仅 PartListItem 必需字段；其它 null/0 占位）。 */
export const FIXTURE_PARTS: PartListItem[] = [
  {
    // 2026-09-12 改造：法兰盘改为装配件（row_type='ASSEMBLY'），带 2 个子件，
    // 用于左栏 PartPickerList 演示装配件展开 + 子件点击切换到子件。
    id: '5000000000001',
    version: 0,
    serial_no: null,
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
    row_type: 'ASSEMBLY',
    has_children: true,
    child_count: 2,
    matched_children: [
      {
        id: '5000000000101',
        version: 0,
        serial_no: 'P-1-A',
        name: '法兰盘-主体',
        drawing_no: 'DWG-A-001-A',
        applicant_name: '张三',
        quantity: 5,
        unit_price: 0,
        total_price: 0,
        request_date: '2026-08-01',
        planned_delivery_date: '2026-09-30',
        actual_delivery_date: null,
        is_urgent: false,
        status: 'PENDING',
        order_no: 'ORD-001',
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
        id: '5000000000102',
        version: 0,
        serial_no: 'P-1-B',
        name: '法兰盘-盖板',
        drawing_no: 'DWG-A-001-B',
        applicant_name: '张三',
        quantity: 5,
        unit_price: 0,
        total_price: 0,
        request_date: '2026-08-01',
        planned_delivery_date: '2026-09-30',
        actual_delivery_date: null,
        is_urgent: false,
        status: 'PENDING',
        order_no: 'ORD-001',
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
    ],
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
    color: '#409EFF', // 2026-09-12 新增：Element Primary 蓝
  },
  {
    id: '2000000000002', version: 0, code: 'CNC-02', name: '精加工', category: 'INHOUSE',
    sort_order: 20, description: null, requires_approval: false,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    color: '#67C23A', // 2026-09-12 新增：Element Success 绿
  },
  {
    id: '2000000000003', version: 0, code: 'QC-01', name: '质检', category: 'INHOUSE',
    sort_order: 30, description: null, requires_approval: false,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    color: '#9B59B6', // 2026-09-12 新增：紫（质检独立色，便于与加工区分）
  },
  {
    id: '2000000000004', version: 0, code: 'OUT-01', name: '热处理', category: 'OUTSOURCE',
    sort_order: 40, description: '外协热处理', requires_approval: true,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    color: '#E6A23C', // 2026-09-12 新增：Element Warning 橙（外协）
  },
  {
    id: '2000000000005', version: 0, code: 'OUT-02', name: '表面喷涂', category: 'OUTSOURCE',
    sort_order: 50, description: '外协喷涂', requires_approval: true,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    color: '#F56C6C', // 2026-09-12 新增：Element Danger 红（外协）
  },
  {
    id: '2000000000006', version: 0, code: 'OUT-03', name: '电镀', category: 'OUTSOURCE',
    sort_order: 60, description: '外协电镀', requires_approval: true,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    color: '#1ABC9C', // 2026-09-12 新增：青（外协，与橙/红区分）
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
    color: process.color ?? null, // 2026-09-12 新增：透传工序颜色
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
    // 2026-09-12 新增：preview_url 用 Vite ?url 引入真实 PDF fixture（npm run fixture:pdf 生成），
    // 替代之前的 'about:blank' 占位，dev:dummy 模式选中即可看到测试 PDF。
    { id: 'f-1-1', file_type: 'PDF', original_filename: 'sample-drawing.pdf', file_size: 234567, preview_url: sampleDrawing },
    { id: 'f-1-2', file_type: 'STEP', original_filename: '法兰盘.stp', file_size: 123456, preview_url: '' },
    { id: 'f-1-3', file_type: 'DWG', original_filename: '法兰盘-CAD.dwg', file_size: 89012, preview_url: '' },
  ],
  '5000000000002': [ // 齿轮：暂无 PDF fixture，仍走 about:blank 占位（图 tab 会显示空态）
    { id: 'f-2-1', file_type: 'PNG', original_filename: '齿轮.png', file_size: 56789, preview_url: '' },
  ],
  '5000000000003': [], // 阀体：无图纸
  '5000000000004': [], // 连接轴：无图纸
  '5000000000005': [], // 外壳：无图纸
}
