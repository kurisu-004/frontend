// 2026-09-11 新增：usePartProcessDesign composable 单测。
// 覆盖：
//   1. 初始 state 包含 INITIAL_FLOWS 的种子数据
//   2. upsertSteps 写本地 + 落 localStorage
//   3. 重新 import 模块 → 从 localStorage 恢复
//   4. reorderSteps → sort_order 重写为新 index
//   5. deleteStep 按 uid 删除
//   6. summaries 聚合正确（含 OUTSOURCE 时 has_outsource_approval === true）

import { describe, it, expect, beforeEach, vi } from 'vitest';

// 极简 localStorage polyfill（项目 vitest 用 environment: 'node'，无 jsdom）。
// 写入真实字符串；JSON.parse/stringify 走原生。
function makeLocalStorage(): Storage {
  let store: Record<string, string> = {};
  return {
    get length() {
      return Object.keys(store).length;
    },
    clear() {
      store = {};
    },
    getItem(key: string) {
      return Object.prototype.hasOwnProperty.call(store, key) ? store[key]! : null;
    },
    key(i: number) {
      return Object.keys(store)[i] ?? null;
    },
    removeItem(key: string) {
      delete store[key];
    },
    setItem(key: string, value: string) {
      store[key] = value;
    },
  } as Storage;
}

beforeEach(() => {
  // 每次测试前重置 localStorage + 模块缓存，让 INITIAL_FLOWS 重新生效
  (globalThis as unknown as { localStorage: Storage }).localStorage = makeLocalStorage();
  vi.resetModules();
});

describe('usePartProcessDesign', () => {
  // 注：beforeEach 提升到顶层（vi.resetModules 需要在 describe 内 import 之前就位）

  it('initial state contains seeded flows (法兰盘 3 步 / 阀体 2 步)', async () => {
    const { usePartProcessDesign } = await import('../composables/usePartProcessDesign');
    const q = usePartProcessDesign();
    await q.loadParts();
    await q.loadProcesses();
    expect(q.parts.value).toHaveLength(5);
    expect(q.processes.value).toHaveLength(6);
    // 法兰盘 (5000000000001) 已预填
    const f1 = q.getFlowByPartId('5000000000001');
    expect(f1).not.toBeNull();
    expect(f1!.steps).toHaveLength(3);
    expect(f1!.steps[0]!.process_code).toBe('CNC-01');
    expect(f1!.steps[1]!.process_code).toBe('OUT-01');
    // 阀体 (5000000000003) 已预填
    const f3 = q.getFlowByPartId('5000000000003');
    expect(f3).not.toBeNull();
    expect(f3!.steps).toHaveLength(2);
    // sort_order 应被重写为 0/1/2
    expect(f1!.steps.map((s) => s.sort_order)).toEqual([0, 1, 2]);
    expect(f3!.steps.map((s) => s.sort_order)).toEqual([0, 1]);
  });

  it('upsertSteps 写本地 state + 落 localStorage', async () => {
    const { usePartProcessDesign } = await import('../composables/usePartProcessDesign');
    const q = usePartProcessDesign();
    await q.loadParts();
    await q.loadProcesses();

    const newSteps = [
      { ...q.newStep(), estimated_minutes: 50, note: '备注A' },
      { ...q.newStep(), estimated_minutes: 60, note: null },
    ];
    const updated = q.upsertSteps('5000000000005', newSteps);
    expect(updated.steps).toHaveLength(2);
    expect(updated.steps[0]!.estimated_minutes).toBe(50);
    expect(updated.steps[1]!.estimated_minutes).toBe(60);
    expect(updated.steps[0]!.sort_order).toBe(0);
    expect(updated.steps[1]!.sort_order).toBe(1);

    // localStorage 同步落盘
    const raw = localStorage.getItem('part_process_flows');
    expect(raw).not.toBeNull();
    const stored = JSON.parse(raw!) as Record<string, { steps: unknown[] }>;
    expect(stored['5000000000005'].steps).toHaveLength(2);

    // 内存中也能读到
    const memory = q.getFlowByPartId('5000000000005');
    expect(memory).not.toBeNull();
    expect(memory!.steps).toHaveLength(2);
  });

  it('新 import 模块后：从 localStorage 恢复（覆盖 fixtures）', async () => {
    // 第一次会话：写入 localStorage
    {
      const { usePartProcessDesign } = await import('../composables/usePartProcessDesign');
      const q = usePartProcessDesign();
      await q.loadParts();
      await q.loadProcesses();
      const customSteps = [{ ...q.newStep(), process_code: 'CUSTOM-1', estimated_minutes: 99 }];
      q.upsertSteps('5000000000001', customSteps);
      expect(q.getFlowByPartId('5000000000001')!.steps).toHaveLength(1);
    }

    // 第二次会话：reset modules → 重新 import → 应从 localStorage 恢复
    vi.resetModules();
    {
      const { usePartProcessDesign } = await import('../composables/usePartProcessDesign');
      const q = usePartProcessDesign();
      const restored = q.getFlowByPartId('5000000000001');
      expect(restored).not.toBeNull();
      // 第一次会话把它覆盖为 1 步；不应该再是 fixture 的 3 步
      expect(restored!.steps).toHaveLength(1);
      expect(restored!.steps[0]!.process_code).toBe('CUSTOM-1');
      expect(restored!.steps[0]!.estimated_minutes).toBe(99);
    }
  });

  it('reorderSteps → sort_order 重写为新 index', async () => {
    const { usePartProcessDesign } = await import('../composables/usePartProcessDesign');
    const q = usePartProcessDesign();
    await q.loadParts();
    await q.loadProcesses();

    // 拿法兰盘 3 步，倒序
    const f1 = q.getFlowByPartId('5000000000001')!;
    const reversed = [...f1.steps].reverse();
    const updated = q.reorderSteps('5000000000001', reversed);
    expect(updated.steps.map((s) => s.process_code)).toEqual([
      'QC-01', // 原 index 2
      'OUT-01', // 原 index 1
      'CNC-01', // 原 index 0
    ]);
    expect(updated.steps.map((s) => s.sort_order)).toEqual([0, 1, 2]);
  });

  it('deleteStep 按 uid 删除', async () => {
    const { usePartProcessDesign } = await import('../composables/usePartProcessDesign');
    const q = usePartProcessDesign();
    await q.loadParts();
    await q.loadProcesses();

    const f1 = q.getFlowByPartId('5000000000001')!;
    expect(f1.steps).toHaveLength(3);
    const targetUid = f1.steps[1]!.uid; // 删除中间那一步（外协热处理）

    const updated = q.deleteStep('5000000000001', targetUid);
    expect(updated).not.toBeNull();
    expect(updated!.steps).toHaveLength(2);
    expect(updated!.steps.find((s) => s.uid === targetUid)).toBeUndefined();
    // sort_order 仍然连续
    expect(updated!.steps.map((s) => s.sort_order)).toEqual([0, 1]);

    // localStorage 也同步
    const raw = JSON.parse(localStorage.getItem('part_process_flows')!) as Record<
      string,
      { steps: { uid: string }[] }
    >;
    expect(raw['5000000000001'].steps).toHaveLength(2);
  });

  it('summaries 聚合正确：含 OUTSOURCE 时 has_outsource_approval=true', async () => {
    const { usePartProcessDesign } = await import('../composables/usePartProcessDesign');
    const q = usePartProcessDesign();
    await q.loadParts();
    await q.loadProcesses();

    // 法兰盘：含 OUT-01（OUTSOURCE + requires_approval=true）
    const s1 = q.summaries('5000000000001');
    expect(s1.step_count).toBe(3);
    expect(s1.total_minutes).toBe(45 + 90 + 15);
    expect(s1.has_outsource_approval).toBe(true);

    // 阀体：全自产
    const s3 = q.summaries('5000000000003');
    expect(s3.step_count).toBe(2);
    expect(s3.total_minutes).toBe(60 + 80);
    expect(s3.has_outsource_approval).toBe(false);

    // 齿轮 (5000000000002) 无流程：全零
    const s2 = q.summaries('5000000000002');
    expect(s2.step_count).toBe(0);
    expect(s2.total_minutes).toBe(0);
    expect(s2.has_outsource_approval).toBe(false);

    // allSummaries 应覆盖已有流程的零件
    expect(q.allSummaries.value['5000000000001'].step_count).toBe(3);
    expect(q.allSummaries.value['5000000000003'].has_outsource_approval).toBe(false);
    expect(q.allSummaries.value['5000000000002']).toBeUndefined();
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

  it('clearFlow 移除某零件的流程（不删零件）', async () => {
    const { usePartProcessDesign } = await import('../composables/usePartProcessDesign');
    const q = usePartProcessDesign();
    await q.loadParts();
    await q.loadProcesses();

    expect(q.getFlowByPartId('5000000000001')).not.toBeNull();
    q.clearFlow('5000000000001');
    expect(q.getFlowByPartId('5000000000001')).toBeNull();
  });
});
