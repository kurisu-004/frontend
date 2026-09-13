// 2026-09-11 新增：工序制定页模块级单例 composable。
// 镜像 src/composables/useWorkerQueue.ts 的模式（CLAUDE.md #1：无 Pinia store，模块级 ref 单例）。
//
// 状态：parts / processes / flows（partId → PartProcessFlow）+ loading flags + error。
// 持久化：每次 upsertSteps / deleteStep / reorderSteps 后同步写 localStorage。
// 阶段二：把每个写函数体替换为 apiV2.post(...) 调用，失败时回滚到操作前快照（CLAUDE.md #2）。

import { computed, ref, type Ref } from 'vue';
import type { PartListItem } from '@/types/parts';
import type { Process } from '@/types/process';
import type { PartProcessFlow, PartProcessSummary, ProcessStep } from '@/types/partProcess';
import {
  FIXTURE_PARTS,
  FIXTURE_PROCESSES,
  FIXTURE_FLOWS,
} from '../__fixtures__/partProcess.fixtures';

const STORAGE_KEY = 'part_process_flows';

// ============ 模块级单例 state ============
const parts = ref<PartListItem[]>([]);
const processes = ref<Process[]>([]);
/** partId → PartProcessFlow；只保存已配置过的零件，未配置的零件不占位。 */
const flows = ref<Record<string, PartProcessFlow>>({});
const loadingParts = ref(false);
const loadingProc = ref(false);
const error = ref<string | null>(null);

// ============ localStorage 加载/保存 ============
function loadFromStorage(): Record<string, PartProcessFlow> {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, PartProcessFlow>;
    // 简单校验：必须有 part_id / steps[]，否则丢弃
    const safe: Record<string, PartProcessFlow> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (v && typeof v.part_id === 'string' && Array.isArray(v.steps)) {
        safe[k] = v;
      }
    }
    return safe;
  } catch {
    return {};
  }
}

function saveToStorage(state: Record<string, PartProcessFlow>): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* quota / disabled — 静默忽略 */
  }
}

/** 把 INITIAL_FLOWS 写进 flows（含 sort_order 重写），并叠加 localStorage。 */
function buildInitialFlows(): Record<string, PartProcessFlow> {
  const fromFixtures: Record<string, PartProcessFlow> = {};
  for (const f of FIXTURE_FLOWS) {
    // 重写 sort_order = 当前 index（fixture 里都写 0）
    const steps = f.steps.map((s, i) => ({ ...s, sort_order: i }));
    fromFixtures[f.part_id] = { ...f, steps };
  }
  // localStorage 覆盖 fixtures（用户编辑优先）
  return { ...fromFixtures, ...loadFromStorage() };
}

// 第一次模块初始化时执行一次（保持 fixtures 在内存里也可用，
// localStorage 加载逻辑独立给单元测试在 setup 里清空重置）
let initialized = false;
function ensureInitialized(): void {
  if (!initialized) {
    flows.value = buildInitialFlows();
    initialized = true;
  }
}

// ============ 工具函数 ============
function makeStepFromProcess(p: Process): ProcessStep {
  return {
    uid: `step-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    process_id: p.id,
    process_code: p.code,
    process_name: p.name,
    category: p.category,
    estimated_minutes: 30,
    note: null,
    sort_order: 0,
    color: p.color ?? null, // 2026-09-12 新增：透传工序颜色
  };
}

function rewriteSortOrder(steps: ProcessStep[]): ProcessStep[] {
  return steps.map((s, i) => ({ ...s, sort_order: i }));
}

// ============ 暴露给组件的 composable ============
export function usePartProcessDesign() {
  ensureInitialized();

  async function loadParts(): Promise<void> {
    loadingParts.value = true;
    error.value = null;
    try {
      // 模拟网络延迟，让 UI loading 状态可见
      await new Promise<void>((r) => setTimeout(r, 200));
      // 阶段一直接用 fixture；阶段二改 listParts({ drawing_no, name, limit: 200, include_assemblies: false })
      parts.value = [...FIXTURE_PARTS];
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'load parts failed';
    } finally {
      loadingParts.value = false;
    }
  }

  async function loadProcesses(): Promise<void> {
    loadingProc.value = true;
    error.value = null;
    try {
      await new Promise<void>((r) => setTimeout(r, 150));
      // 阶段一直接用 fixture；阶段二改 listProcesses({ limit: 500 })
      processes.value = [...FIXTURE_PROCESSES];
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'load processes failed';
    } finally {
      loadingProc.value = false;
    }
  }

  function getFlowByPartId(partId: string): PartProcessFlow | null {
    return flows.value[partId] ?? null;
  }

  /** 用一个新 steps[] 覆盖某零件的工序列表；同步写 localStorage。 */
  function upsertSteps(partId: string, steps: ProcessStep[]): PartProcessFlow {
    const reordered = rewriteSortOrder(steps);
    const updated: PartProcessFlow = {
      part_id: partId,
      version: 0,
      steps: reordered,
      updated_at: new Date().toISOString(),
    };
    flows.value = { ...flows.value, [partId]: updated };
    saveToStorage(flows.value);
    return updated;
  }

  /** 按 uid 删除一道工序。 */
  function deleteStep(partId: string, uid: string): PartProcessFlow | null {
    const f = flows.value[partId];
    if (!f) return null;
    const next = f.steps.filter((s) => s.uid !== uid);
    return upsertSteps(partId, next);
  }

  /**
   * 拖拽排序后调用：传入新顺序的 uid 数组。
   * 若仅传 steps（带相同 uid），用 sort_order 重写；否则按 uid 数组重排。
   */
  function reorderSteps(partId: string, newSteps: ProcessStep[]): PartProcessFlow {
    return upsertSteps(partId, newSteps);
  }

  /** 清空某零件的工序（不是删除零件，仅清空流程）。 */
  function clearFlow(partId: string): void {
    if (!flows.value[partId]) return;
    const next = { ...flows.value };
    delete next[partId];
    flows.value = next;
    saveToStorage(flows.value);
  }

  /** 新建一道空白工序（追加到末尾）。 */
  function newStep(): ProcessStep {
    return makeStepFromProcess(FIXTURE_PROCESSES[0]!);
  }

  /** 派生：某零件工序摘要（总耗时 / 含外协）。 */
  function summaries(partId: string): PartProcessSummary {
    const f = flows.value[partId];
    if (!f) return { step_count: 0, total_minutes: 0, has_outsource_approval: false };
    const total_minutes = f.steps.reduce((acc, s) => acc + (s.estimated_minutes || 0), 0);
    // 含 OUTSOURCE + requires_approval=true 时显示警示（与 Process 类型对齐）
    const has_outsource_approval = f.steps.some((s) => {
      if (s.category !== 'OUTSOURCE') return false;
      const p = processes.value.find((pp) => pp.id === s.process_id);
      return p?.requires_approval ?? false;
    });
    return {
      step_count: f.steps.length,
      total_minutes,
      has_outsource_approval,
    };
  }

  /** 派生：所有零件的摘要（用于左栏角标）。 */
  const allSummaries = computed<Record<string, PartProcessSummary>>(() => {
    const out: Record<string, PartProcessSummary> = {};
    for (const pid of Object.keys(flows.value)) {
      const f = flows.value[pid]!;
      const total_minutes = f.steps.reduce((acc, s) => acc + (s.estimated_minutes || 0), 0);
      const has_outsource_approval = f.steps.some((s) => {
        if (s.category !== 'OUTSOURCE') return false;
        const p = processes.value.find((pp) => pp.id === s.process_id);
        return p?.requires_approval ?? false;
      });
      out[pid] = {
        step_count: f.steps.length,
        total_minutes,
        has_outsource_approval,
      };
    }
    return out;
  });

  return {
    parts: parts as Ref<PartListItem[]>,
    processes: processes as Ref<Process[]>,
    flows: flows as Ref<Record<string, PartProcessFlow>>,
    loadingParts: loadingParts as Ref<boolean>,
    loadingProc: loadingProc as Ref<boolean>,
    error: error as Ref<string | null>,
    allSummaries,
    loadParts,
    loadProcesses,
    getFlowByPartId,
    upsertSteps,
    deleteStep,
    reorderSteps,
    clearFlow,
    newStep,
    summaries,
  };
}
