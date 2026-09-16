// 2026-09-14 改造：usePartProcessDesign 测试 fixture → mock API。
//
// 原 fixture 驱动测试（5 零件 / 6 工序 / 2 预填流程）改为 vi.mock('@/api/processChain') 注入
// 稳定 stub 数据，断言 composable 的本地 state / save / 懒加载行为。
//
// 覆盖：
//   1. loadParts / loadProcesses：模块级单例 state 填充
//   2. upsertSteps：本地立刻更新（不自动 PUT，需手动 save）
//   3. loadFlowForPart：懒加载并缓存到 flows；二次访问走缓存
//   4. reorderSteps → sort_order 重写为新 index
//   5. deleteStep 按 uid 删除
//   6. summaries 聚合正确（含 OUTSOURCE 时 has_outsource_approval === true）
//   7. newStep 返回默认空白工序
//   8. clearFlow 把 steps 置空
//   9. save 走本地 mutate + PUT 整组 + 成功后用 dto.version 覆盖本地
//  10. save 失败时 ElMessage.error 被调 + error.value 同步 + dirty 由 UI 维持（不变 composable 内部状态）
//
// 2026-09-14 follow-up：
// - 20701 路径改用 ApiError 实例（替代原 `(e as { code?: number }).code` 字面量挂码），
//   对应 usePartProcessDesign.ts 里 `e instanceof ApiError && e.code === 20701` 的新分支。
// - 新增 save 失败 it 用例：mock upsertProcessChainByPart 抛 ApiError(500)，
//   断言 catch 块 ElMessage.error 被调（mock element-plus stub）。
//
// 2026-09-16 改造：删除防抖自动保存（scheduleSave）的相关 it 用例；
// upsertSteps 不再触发 PUT，持久化由公开 save(partId, steps) 显式调用。
// 同时更新 loadParts → listParts 调用，确保 status='PENDING' 透传（不传 keyword，
// 走 processChain.listParts 默认 undefined 入参）。
//
// 2026-09-16 第 1 轮 review 修复：saveFlow 改为 internal（不 export），外部唯一入口
// 是公开 save(partId, steps)。两个 it 用例（原 upsertSteps 「显式 saveFlow 才 PUT」
// 与「save 失败时 ElMessage.error」）改为断言公开 save；公开 save 内部串行做
// upsertSteps + saveFlow，行为契约：成功 → mutate + PUT；失败 → mutate + PUT 抛错 +
// ElMessage.error + error.value。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ApiError } from '@/api/http';

// stub 数据：5 零件 + 6 工序 + 2 预填流程（与原 fixture 字段对齐，便于测试断言）
const STUB_PARTS = [
  { id: '5000000000001', name: '法兰盘', drawing_no: 'DWG-A-001' },
  { id: '5000000000002', name: '齿轮', drawing_no: 'DWG-A-002' },
  { id: '5000000000003', name: '阀体', drawing_no: 'DWG-B-001' },
  { id: '5000000000004', name: '连接轴', drawing_no: 'DWG-C-001' },
  { id: '5000000000005', name: '外壳', drawing_no: 'DWG-D-001' },
];

const STUB_PROCESSES = [
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

/** stub chain：part_id → steps 数组（process_id / estimated_minutes / sort_order） */
const STUB_FLOWS: Record<
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
  '5000000000001': {
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
  '5000000000003': {
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

// mock @/api/processChain
// 2026-09-14 follow-up：20701 抛 ApiError 实例（替代原 Error + 挂字面量 .code），
// 对应 usePartProcessDesign.ts:loadFlow 用 `e instanceof ApiError && e.code === 20701` 分支。
//
// 注意：必须在 beforeEach 里用 vi.doMock 重建（而不是顶层 vi.mock），
// 因为 `vi.resetModules()` 会让模块缓存清空，但顶层 vi.mock 的 factory 只在
// 第一次模块加载时跑一次，捕获的 ApiError 实例与 composable 重新加载的 ApiError
// 不是同一个 class（class identity 不同 → instanceof 失效）。
// vi.doMock 在 beforeEach 内执行，每次都 fresh 解析 ApiError，确保与 composable 同源。
let __apiErrorForMock: typeof ApiError;
beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  // 重新 import @/api/http 获取 resetModules 之后的 ApiError 实例
  const httpMod = await import('@/api/http');
  __apiErrorForMock = httpMod.ApiError;
  vi.doMock('@/api/processChain', () => ({
    listParts: vi.fn(async () => STUB_PARTS),
    listProcesses: vi.fn(async () => STUB_PROCESSES),
    getProcessChainByPart: vi.fn(async (partId: string) => {
      const f = STUB_FLOWS[partId];
      if (!f) {
        // 20701 BIZ_PROCESS_CHAIN_NOT_FOUND — 走 usePartProcessDesign.loadFlow 的空链分支
        throw new __apiErrorForMock(20701, 'BIZ_PROCESS_CHAIN_NOT_FOUND');
      }
      return {
        id: `7000000000${partId.slice(-3)}`,
        part_id: partId,
        name: '默认工艺',
        note: null,
        version: 1,
        created_at: '2026-09-10T08:00:00Z',
        updated_at: '2026-09-10T08:00:00Z',
        steps: f.steps,
      };
    }),
    upsertProcessChainByPart: vi.fn(
      async (
        partId: string,
        body: {
          steps: Array<{
            process_id: string;
            estimated_minutes: number;
            sort_order: number;
            note: string | null;
          }>;
        },
      ) => ({
        id: `7000000000${partId.slice(-3)}`,
        part_id: partId,
        name: '默认工艺',
        note: null,
        version: 2,
        created_at: '2026-09-10T08:00:00Z',
        updated_at: new Date().toISOString(),
        steps: body.steps.map((s, i) => ({ ...s, id: `6${String(i).padStart(13, '0')}` })),
      }),
    ),
  }));
});

// 2026-09-14 follow-up：mock element-plus ElMessage，断言 usePartProcessDesign.doSave
// catch 块 ElMessage.error 调用（替代原仅 error.value 静默）。
// 不导入整个 element-plus（避免拖入 EP 注册副作用），只 stub 用到的命令式 API。
vi.mock('element-plus', () => ({
  ElMessage: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  },
}));

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('usePartProcessDesign', () => {
  it('loadParts / loadProcesses：模块级单例填充', async () => {
    const { usePartProcessDesign } = await import('../composables/usePartProcessDesign');
    const q = usePartProcessDesign();
    await q.loadParts();
    await q.loadProcesses();
    expect(q.parts.value).toHaveLength(5);
    expect(q.processes.value).toHaveLength(6);
    expect(q.loadingParts.value).toBe(false);
    expect(q.loadingProc.value).toBe(false);
  });

  it('loadFlowForPart 懒加载 + 缓存：首次 GET，二次走缓存', async () => {
    const { usePartProcessDesign } = await import('../composables/usePartProcessDesign');
    const { getProcessChainByPart } = await import('@/api/processChain');
    const q = usePartProcessDesign();
    await q.loadParts();
    await q.loadProcesses();

    expect(q.getFlowByPartId('5000000000001')).toBeNull();
    const f1 = await q.loadFlowForPart('5000000000001');
    expect(f1).not.toBeNull();
    expect(f1!.steps).toHaveLength(3);
    expect(getProcessChainByPart).toHaveBeenCalledTimes(1);

    // 二次访问走缓存（不再调 API）
    const f1b = q.getFlowByPartId('5000000000001');
    expect(f1b).toEqual(f1);
    expect(getProcessChainByPart).toHaveBeenCalledTimes(1);
  });

  it('upsertSteps：本地立刻更新（不自动 PUT，需手动 save）', async () => {
    // 2026-09-16 改造：upsertSteps 不再触发防抖 PUT，断言改为：
    //   - 本地立刻更新（同步）
    //   - 不调 upsertProcessChainByPart（即使用 vi.advanceTimersByTime 也无 PUT）
    //   - 公开 save 显式调用后才 PUT 整组
    // 2026-09-16 第 1 轮 review 修复：saveFlow 已 internal，外部唯一入口是 save；
    // save 内部串行做 upsertSteps + saveFlow（PUT），所以这里直接断言 save。
    const { usePartProcessDesign } = await import('../composables/usePartProcessDesign');
    const { upsertProcessChainByPart } = await import('@/api/processChain');
    const q = usePartProcessDesign();
    await q.loadParts();
    await q.loadProcesses();
    await q.loadFlowForPart('5000000000005'); // 空链 → 新建

    const newSteps = [
      { ...q.newStep(), estimated_minutes: 50, note: '备注A' },
      { ...q.newStep(), estimated_minutes: 60, note: null },
    ];
    const updated = q.upsertSteps('5000000000005', newSteps);
    expect(updated.steps).toHaveLength(2);
    expect(updated.steps[0]!.estimated_minutes).toBe(50);
    expect(updated.steps[1]!.estimated_minutes).toBe(60);
    expect(updated.steps.map((s) => s.sort_order)).toEqual([0, 1]);

    // 本地立刻更新（同步）
    expect(q.getFlowByPartId('5000000000005')!.steps).toHaveLength(2);

    // 2026-09-16：upsertSteps 不自动 PUT；跑 fake timer 也无 PUT
    expect(upsertProcessChainByPart).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(upsertProcessChainByPart).not.toHaveBeenCalled();

    // 2026-09-16 第 1 轮 review 修复：显式调公开 save 才 PUT（save 内部包了
    // upsertSteps + saveFlow，对外只暴露这一个入口）
    await q.save('5000000000005', newSteps);
    expect(upsertProcessChainByPart).toHaveBeenCalledTimes(1);
    const lastCall = (upsertProcessChainByPart as ReturnType<typeof vi.fn>).mock.calls.at(-1);
    expect(lastCall![1].steps).toHaveLength(2);
  });

  it('reorderSteps → sort_order 重写为新 index', async () => {
    const { usePartProcessDesign } = await import('../composables/usePartProcessDesign');
    const q = usePartProcessDesign();
    await q.loadParts();
    await q.loadProcesses();
    await q.loadFlowForPart('5000000000001');

    const f1 = q.getFlowByPartId('5000000000001')!;
    const reversed = [...f1.steps].reverse();
    const updated = q.reorderSteps('5000000000001', reversed);
    // 倒序：原 index 2 → sort_order 0，原 1 → 1，原 0 → 2
    expect(updated.steps.map((s) => s.process_id)).toEqual([
      '2000000000003', // 原 QC-01
      '2000000000004', // 原 OUT-01
      '2000000000001', // 原 CNC-01
    ]);
    expect(updated.steps.map((s) => s.sort_order)).toEqual([0, 1, 2]);
  });

  it('deleteStep 按 uid 删除', async () => {
    const { usePartProcessDesign } = await import('../composables/usePartProcessDesign');
    const q = usePartProcessDesign();
    await q.loadParts();
    await q.loadProcesses();
    await q.loadFlowForPart('5000000000001');

    const f1 = q.getFlowByPartId('5000000000001')!;
    expect(f1.steps).toHaveLength(3);
    const targetUid = f1.steps[1]!.uid; // 删除中间那一步（外协热处理）

    const updated = q.deleteStep('5000000000001', targetUid);
    expect(updated).not.toBeNull();
    expect(updated!.steps).toHaveLength(2);
    expect(updated!.steps.find((s) => s.uid === targetUid)).toBeUndefined();
    expect(updated!.steps.map((s) => s.sort_order)).toEqual([0, 1]);
  });

  it('summaries 聚合正确：含 OUTSOURCE 时 has_outsource_approval=true', async () => {
    const { usePartProcessDesign } = await import('../composables/usePartProcessDesign');
    const q = usePartProcessDesign();
    await q.loadParts();
    await q.loadProcesses();
    await q.loadFlowForPart('5000000000001');
    await q.loadFlowForPart('5000000000003');

    const s1 = q.summaries('5000000000001');
    expect(s1.step_count).toBe(3);
    expect(s1.total_minutes).toBe(45 + 90 + 15);
    expect(s1.has_outsource_approval).toBe(true);

    const s3 = q.summaries('5000000000003');
    expect(s3.step_count).toBe(2);
    expect(s3.total_minutes).toBe(60 + 80);
    expect(s3.has_outsource_approval).toBe(false);

    // 未加载的零件返回全零
    const s2 = q.summaries('5000000000002');
    expect(s2.step_count).toBe(0);
    expect(s2.total_minutes).toBe(0);
    expect(s2.has_outsource_approval).toBe(false);
  });

  it('newStep 返回默认空白工序（estimated_minutes=30）', async () => {
    const { usePartProcessDesign } = await import('../composables/usePartProcessDesign');
    const q = usePartProcessDesign();
    await q.loadParts();
    await q.loadProcesses();

    const s = q.newStep();
    expect(s.uid).toMatch(/^step-/);
    expect(s.estimated_minutes).toBe(30);
    expect(s.note).toBeNull();
  });

  it('clearFlow 把 steps 置空（不删零件）', async () => {
    const { usePartProcessDesign } = await import('../composables/usePartProcessDesign');
    const q = usePartProcessDesign();
    await q.loadParts();
    await q.loadProcesses();
    await q.loadFlowForPart('5000000000001');

    expect(q.getFlowByPartId('5000000000001')!.steps.length).toBeGreaterThan(0);
    q.clearFlow('5000000000001');
    expect(q.getFlowByPartId('5000000000001')!.steps).toHaveLength(0);
  });

  it('loadFlowForPart 20701 错误视为空链（不报错）', async () => {
    const { usePartProcessDesign } = await import('../composables/usePartProcessDesign');
    const q = usePartProcessDesign();
    await q.loadParts();
    await q.loadProcesses();

    // 5000000000004 在 stub 里没有 → 抛 ApiError(20701, ...)，
    // loadFlow 应走空链分支（不重抛，缓存空 PartProcessFlow）
    const f = await q.loadFlowForPart('5000000000004');
    expect(f).not.toBeNull();
    expect(f!.steps).toHaveLength(0);
    expect(q.error.value).toBeNull(); // 不应被设为 error
  });

  it('save 失败时 ElMessage.error 被调 + error.value 同步（2026-09-14 follow-up + 2026-09-16 改造 + 第 1 轮 review 修复）', async () => {
    // 2026-09-16 改造：原 it 走「upsertSteps → 防抖 → doSave → catch」路径；
    // scheduleSave 已删除，改为「saveFlow 显式调用 → catch」路径。
    // 2026-09-16 第 1 轮 review 修复：saveFlow 已 internal，外部唯一入口是公开
    // save(partId, steps)。save 内部串行做 upsertSteps + saveFlow，失败时
    // saveFlow 内部已弹 ElMessage.error + 设 error.value + 重抛。
    const { usePartProcessDesign } = await import('../composables/usePartProcessDesign');
    const { upsertProcessChainByPart } = await import('@/api/processChain');
    const { ElMessage } = await import('element-plus');
    // 单测隔离：让 upsertProcessChainByPart 抛 ApiError(500, 'save fail')
    vi.mocked(upsertProcessChainByPart).mockRejectedValueOnce(new ApiError(500, 'save fail'));
    const q = usePartProcessDesign();
    await q.loadParts();
    await q.loadProcesses();
    await q.loadFlowForPart('5000000000005');

    // 2026-09-16 第 1 轮 review 修复：直接 await save（公开入口）；save 内部
    // 已做 upsertSteps + saveFlow，失败时 saveFlow 会抛 → save 重抛 → 测试断言。
    // 行为契约：失败保留本地 steps（已 mutate）+ 不清 dirty（composable 不持
    // 组件级 dirty ref，由 UI 控制；本测试只断言 composable 侧可观察副作用）。
    const targetSteps = [q.newStep()];
    await expect(q.save('5000000000005', targetSteps)).rejects.toBeInstanceOf(ApiError);

    expect(upsertProcessChainByPart).toHaveBeenCalledTimes(1);
    // 2026-09-14 follow-up：catch 块必须同时设置 error.value 和弹 ElMessage.error
    expect(q.error.value).toBe('save fail');
    expect(ElMessage.error).toHaveBeenCalledWith('保存工艺链失败：save fail');
    // 2026-09-16 第 1 轮 review 修复：失败时 flows 单例保留 mutate 后状态
    // （新 steps 已在；composable 不回滚），dirty 由 UI 自行维持 true
    expect(q.getFlowByPartId('5000000000005')!.steps).toEqual(targetSteps);
  });
});
