// 2026-09-14 改造：原 mock seed 拆分。
// FIXTURE_PARTS / FIXTURE_PROCESSES / FIXTURE_FLOWS（composable 阶段一用）已切真接口，删除。
// 保留 FIXTURE_FILES（DrawingPreviewPane.vue 用），保留 mock seed 数据直到后端 /files 接入。
//
// 历史：2026-09-11 新增 partProcess.fixtures.ts（含 5 零件 / 6 工序 / 2 预填流程）；
// 2026-09-14 usePartProcessDesign 切到 @/api/processChain 后，零件 / 工序 / 流程
// 三组 fixture 不再被 composable 引用，仅保留 files 部分（图纸占位）。
//
// 2026-09-16 新增：STUB_PARTS / STUB_PROCESSES / STUB_CHAINS —— usePartProcessDesign
// 单测 stub 数据（从 spec 迁入本文件统一管理），对齐后端 2026-09-16 契约：
// part 出参带 process_chain_id（null = 未制定工序）；工艺链改按 chain_id 索引
// （GET /process-chains/{chain_id}），链出参不再含 part_id。

// 2026-09-12 新增：通过 Vite ?url 引入 dev 模式测试 PDF，避免 about:blank 占位无内容。
// 生成脚本：scripts/generate-test-pdf.mjs（npm run fixture:pdf）
import sampleDrawing from './sample-drawing.pdf?url';

/** 单测 stub 零件（2026-09-16 新增）：字段对齐 v2 PartListItem 子集 +
 *  后端新增的 process_chain_id（null = 未制定工序 →「待制定」分组）。
 *  - 0001 法兰盘 / 0003 阀体：已制定（process_chain_id 指向 STUB_CHAINS 对应链）
 *  - 0002 齿轮 / 0005 外壳：未制定（null）
 *  - 0004 连接轴：process_chain_id 非空但链在 STUB_CHAINS 不存在（脏数据/链已删），
 *    用于覆盖「by-id 拉取 20701 → 视为空链」分支 */
export const STUB_PARTS = [
  {
    id: '5000000000001',
    name: '法兰盘',
    drawing_no: 'DWG-A-001',
    process_chain_id: '7000000000001',
  },
  { id: '5000000000002', name: '齿轮', drawing_no: 'DWG-A-002', process_chain_id: null },
  { id: '5000000000003', name: '阀体', drawing_no: 'DWG-B-001', process_chain_id: '7000000000003' },
  {
    id: '5000000000004',
    name: '连接轴',
    drawing_no: 'DWG-C-001',
    process_chain_id: '7000000000099',
  },
  { id: '5000000000005', name: '外壳', drawing_no: 'DWG-D-001', process_chain_id: null },
];

/** 单测 stub 工序（2026-09-16 新增，自 spec 迁入）：3 自产 + 3 外协（均需审批）。 */
export const STUB_PROCESSES = [
  {
    id: '2000000000001',
    code: 'CNC-01',
    name: '粗加工',
    category: 'INHOUSE',
    requires_approval: false,
    color: '#409EFF',
  },
  {
    id: '2000000000002',
    code: 'CNC-02',
    name: '精加工',
    category: 'INHOUSE',
    requires_approval: false,
    color: '#67C23A',
  },
  {
    id: '2000000000003',
    code: 'QC-01',
    name: '质检',
    category: 'INHOUSE',
    requires_approval: false,
    color: '#9B59B6',
  },
  {
    id: '2000000000004',
    code: 'OUT-01',
    name: '热处理',
    category: 'OUTSOURCE',
    requires_approval: true,
    color: '#E6A23C',
  },
  {
    id: '2000000000005',
    code: 'OUT-02',
    name: '表面喷涂',
    category: 'OUTSOURCE',
    requires_approval: true,
    color: '#F56C6C',
  },
  {
    id: '2000000000006',
    code: 'OUT-03',
    name: '电镀',
    category: 'OUTSOURCE',
    requires_approval: true,
    color: '#1ABC9C',
  },
];

/** 单测 stub 工艺链（2026-09-16 新增，自 spec 迁入）：chain_id → steps 数组。
 *  2026-09-16 起按 chain_id 索引（对齐新端点 GET /process-chains/{chain_id}），
 *  替代原 part_id 索引（by-part 端点）。
 *  7000000000001 = 法兰盘的链（3 步含外协）；7000000000003 = 阀体的链（2 步全自产）。
 *  注意：连接轴（5000000000004）的 process_chain_id='7000000000099' 故意不在本表，
 *  用于 stub 抛 20701 验证「链已删 → 空链」分支。 */
export const STUB_CHAINS: Record<
  string,
  {
    steps: Array<{
      id?: string;
      sort_order: number;
      process_id: string;
      estimated_minutes: number;
      note: string | null;
    }>;
  }
> = {
  '7000000000001': {
    // 法兰盘：3 步含外协
    steps: [
      {
        id: '6000000000001',
        sort_order: 0,
        process_id: '2000000000001',
        estimated_minutes: 45,
        note: '注意装夹方向',
      },
      {
        id: '6000000000002',
        sort_order: 1,
        process_id: '2000000000004',
        estimated_minutes: 90,
        note: null,
      },
      {
        id: '6000000000003',
        sort_order: 2,
        process_id: '2000000000003',
        estimated_minutes: 15,
        note: null,
      },
    ],
  },
  '7000000000003': {
    // 阀体：2 步全自产
    steps: [
      {
        id: '6000000000010',
        sort_order: 0,
        process_id: '2000000000001',
        estimated_minutes: 60,
        note: null,
      },
      {
        id: '6000000000011',
        sort_order: 1,
        process_id: '2000000000002',
        estimated_minutes: 80,
        note: '精加工公差 ±0.01',
      },
    ],
  },
};

/** PartFileItem mock（极简字段，仅展示用；不参与业务流程）。 */
export interface MockPartFile {
  id: string;
  file_type: string;
  original_filename: string;
  file_size: number;
  /** 内嵌预览用的占位 blob url；后端真接入后改 `api.get(/part-files/{id}/content, blob)`
      （2026-09-16 更新：v2 无 /files/* 路由） */
  preview_url: string;
}

export const FIXTURE_FILES: Record<string, MockPartFile[]> = {
  '5000000000001': [
    // 法兰盘
    // 2026-09-12 新增：preview_url 用 Vite ?url 引入真实 PDF fixture（npm run fixture:pdf 生成），
    // 替代之前的 'about:blank' 占位，dev:dummy 模式选中即可看到测试 PDF。
    {
      id: 'f-1-1',
      file_type: 'PDF',
      original_filename: 'sample-drawing.pdf',
      file_size: 234567,
      preview_url: sampleDrawing,
    },
    {
      id: 'f-1-2',
      file_type: 'STEP',
      original_filename: '法兰盘.stp',
      file_size: 123456,
      preview_url: '',
    },
    {
      id: 'f-1-3',
      file_type: 'DWG',
      original_filename: '法兰盘-CAD.dwg',
      file_size: 89012,
      preview_url: '',
    },
  ],
  '5000000000002': [
    // 齿轮：暂无 PDF fixture，仍走 about:blank 占位（图 tab 会显示空态）
    {
      id: 'f-2-1',
      file_type: 'PNG',
      original_filename: '齿轮.png',
      file_size: 56789,
      preview_url: '',
    },
  ],
  '5000000000003': [], // 阀体：无图纸
  '5000000000004': [], // 连接轴：无图纸
  '5000000000005': [], // 外壳：无图纸
};
