// 2026-09-14 改造：原 mock seed 拆分。
// FIXTURE_PARTS / FIXTURE_PROCESSES / FIXTURE_FLOWS（composable 阶段一用）已切真接口，删除。
//
// 历史：2026-09-11 新增 partProcess.fixtures.ts（含 5 零件 / 6 工序 / 2 预填流程）；
// 2026-09-14 usePartProcessDesign 切到 @/api/processChain 后，零件 / 工序 / 流程
// 三组 fixture 不再被 composable 引用。
//
// 2026-09-16 新增：STUB_PARTS / STUB_PROCESSES / STUB_CHAINS —— 工序制定页单测 stub 数据
// （从 spec 迁入本文件统一管理），对齐后端 2026-09-16 契约：part 出参带
// process_chain_id（null = 未制定工序）；工艺链改按 chain_id 索引
// （GET /process-chains/{chain_id}），链出参不再含 part_id。
//
// 2026-09-29 删除：FIXTURE_FILES / MockPartFile / sample-drawing.pdf 引用。
// DrawingPreviewPane.vue 已切 usePartFilesListQuery 单调用接真实后端，
// fixture mock 不再被任何代码引用。
//
// 2026-10-05：STUB_PARTS 换成本页新端点 `GET /prod/process-design/parts` 的
// ProcessDesignPartItemOut（**7 字段**：id / version / serial_no / name / drawing_no /
// process_chain_id / assembly_id），并新增一行**装配件子件**（assembly_id 非空）——
// 新端点刻意不加 `AND assembly_id IS NULL`，子件是本页的正常成员，必须有稳定 stub 守住
// 「子件可见」这条回归。消费方：composables/__tests__/useProcessDesignStore.spec.ts。

/** 单测 stub 零件（7 字段，对齐后端 ProcessDesignPartItemOut）：
 *  - 0001 法兰盘 / 0003 阀体：已制定（process_chain_id 指向 STUB_CHAINS 对应链）
 *  - 0002 齿轮 / 0005 外壳：未制定（process_chain_id = null）
 *  - 0004 连接轴：process_chain_id 非空但链在 STUB_CHAINS 不存在（脏数据/链已删），
 *    用于覆盖「by-id 拉取 20701 → 视为空链」分支
 *  - 0006 轴承座：**装配件子件**（assembly_id 非空）且未制定工序 ——
 *    覆盖「子件与独立零件同表出现」的回归（part 域旧端点看不到它） */
export const STUB_PARTS = [
  {
    id: '5000000000001',
    version: 3,
    serial_no: 'F1001-01',
    name: '法兰盘',
    drawing_no: 'DWG-A-001',
    process_chain_id: '7000000000001',
    assembly_id: null,
  },
  {
    id: '5000000000002',
    version: 0,
    serial_no: 'F1001-02',
    name: '齿轮',
    drawing_no: 'DWG-A-002',
    process_chain_id: null,
    assembly_id: null,
  },
  {
    id: '5000000000003',
    version: 1,
    serial_no: 'F1002-01',
    name: '阀体',
    drawing_no: 'DWG-B-001',
    process_chain_id: '7000000000003',
    assembly_id: null,
  },
  {
    id: '5000000000004',
    version: 0,
    serial_no: null,
    name: '连接轴',
    drawing_no: 'DWG-C-001',
    process_chain_id: '7000000000099',
    assembly_id: null,
  },
  {
    id: '5000000000005',
    version: 0,
    serial_no: 'F1003-02',
    name: '外壳',
    drawing_no: 'DWG-D-001',
    process_chain_id: null,
    assembly_id: null,
  },
  {
    id: '5000000000006',
    version: 0,
    serial_no: 'F1003-01',
    name: '轴承座',
    drawing_no: 'DWG-D-002',
    process_chain_id: null,
    // 装配件子件：父装配件 8000000000001
    assembly_id: '8000000000001',
  },
];

/** 单测 stub 工序（自 spec 迁入）：3 自产 + 3 外协（均需审批）。
 *  2026-10-05：补齐 `processSchema` 的其余必填字段（version / sort_order /
 *  description / is_cnc / created_at / updated_at）—— store 的工序下拉改走共享层
 *  useProcessesQuery，响应会经 `processListResultSchema.parse` 守门，缺字段会被整条
 *  query 判错（description / color 是 optional，其余必填）。 */
export const STUB_PROCESSES = [
  {
    id: '2000000000001',
    version: 0,
    code: 'CNC-01',
    name: '粗加工',
    category: 'INHOUSE',
    sort_order: 0,
    description: null,
    requires_approval: false,
    color: '#409EFF',
    is_cnc: true,
    created_at: '2026-09-10T08:00:00Z',
    updated_at: '2026-09-10T08:00:00Z',
  },
  {
    id: '2000000000002',
    version: 0,
    code: 'CNC-02',
    name: '精加工',
    category: 'INHOUSE',
    sort_order: 1,
    description: null,
    requires_approval: false,
    color: '#67C23A',
    is_cnc: false,
    created_at: '2026-09-10T08:00:00Z',
    updated_at: '2026-09-10T08:00:00Z',
  },
  {
    id: '2000000000003',
    version: 0,
    code: 'QC-01',
    name: '质检',
    category: 'INHOUSE',
    sort_order: 2,
    description: null,
    requires_approval: false,
    color: '#9B59B6',
    is_cnc: false,
    created_at: '2026-09-10T08:00:00Z',
    updated_at: '2026-09-10T08:00:00Z',
  },
  {
    id: '2000000000004',
    version: 0,
    code: 'OUT-01',
    name: '热处理',
    category: 'OUTSOURCE',
    sort_order: 3,
    description: null,
    requires_approval: true,
    color: '#E6A23C',
    is_cnc: false,
    created_at: '2026-09-10T08:00:00Z',
    updated_at: '2026-09-10T08:00:00Z',
  },
  {
    id: '2000000000005',
    version: 0,
    code: 'OUT-02',
    name: '表面喷涂',
    category: 'OUTSOURCE',
    sort_order: 4,
    description: null,
    requires_approval: true,
    color: '#F56C6C',
    is_cnc: false,
    created_at: '2026-09-10T08:00:00Z',
    updated_at: '2026-09-10T08:00:00Z',
  },
  {
    id: '2000000000006',
    version: 0,
    code: 'OUT-03',
    name: '电镀',
    category: 'OUTSOURCE',
    sort_order: 5,
    description: null,
    requires_approval: true,
    color: '#1ABC9C',
    is_cnc: false,
    created_at: '2026-09-10T08:00:00Z',
    updated_at: '2026-09-10T08:00:00Z',
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
      /**
       * 2026-10-10 补：GET /prod/process-chains/{id} 的出参**恒带** step.version
       * （后端 `ProcessChainStepOut.version: i32`，无 skip_serializing_if），而
       * `POST /prod/process-chains/by-part/{part_id}` 的请求 DTO 里它是可选的 ——
       * 两者共用 `ProcessChainStepDto` 才让这个差异被 fixture 抹平。工序链读端点自
       * 2026-10-10 起在 api 层有 Zod 守门（`api/processChain.ts::getProcessChainById`
       * 内的 `processChainSchema.parse`），少这个键 ⇒ 整条响应 parse 失败 ⇒ 制定工序页
       * 的链加载失败、编辑器 steps 恒空。守门一上就当场炸出来的是 fixture，不是生产代码。
       */
      version: number;
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
        version: 1,
      },
      {
        id: '6000000000002',
        sort_order: 1,
        process_id: '2000000000004',
        estimated_minutes: 90,
        note: null,
        version: 1,
      },
      {
        id: '6000000000003',
        sort_order: 2,
        process_id: '2000000000003',
        estimated_minutes: 15,
        note: null,
        version: 1,
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
        version: 1,
      },
      {
        id: '6000000000011',
        sort_order: 1,
        process_id: '2000000000002',
        estimated_minutes: 80,
        note: '精加工公差 ±0.01',
        version: 1,
      },
    ],
  },
};
