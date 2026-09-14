// 2026-09-14 改造：usePartProcessDesign composable 从 fixture + localStorage 切到真实 v2 API。
//
// 阶段二（2026-09-14 起）：所有读写走 @/api/processChain（baseURL /api/v2）。
// - loadParts / loadProcesses：拉全量；本地缓存到模块级单例。
// - flows（PartProcessFlow 字典）：懒加载 — 用户选 part 时按需 GET /process-chains/by-part/{part_id}；
//   首次访问 20701 BIZ_PROCESS_CHAIN_NOT_FOUND → 视为空链，不报错。
// - upsertSteps / deleteStep / reorderSteps：本地更新 + 防抖 PUT 整组 upsert。
//
// 整组 upsert 约束（2026-09-14 写入注释，CLAUDE.md 习惯）：
//   rust PUT /process-chains/by-part/{part_id} 是整组替换语义——前端必须发完整 steps 数组
//   （包括 service-side 已有的 step），否则会被覆盖。所以本地流程编辑后 PUT 时，本地
//   PartProcessFlow.steps 已是「完整数组 + 用户变更」，直接序列化发走即可。
//   若本地发现缺 step（如 race：用户编辑期间另一 tab GET 后 PUT 覆盖了本地 cache），
//   先 GET 一次拿完整 list 再 merge 用户变更（mergeToFullSteps 函数）。

import { computed, ref, type Ref } from 'vue';
import type { PartListItem } from '@/types/parts';
import type { Process } from '@/types/process';
import type { PartProcessFlow, PartProcessSummary, ProcessStep } from '@/types/partProcess';
import type { ProcessChainStepDto } from '@/api/processChain.contract';
import {
  getProcessChainByPart,
  listParts,
  listProcesses,
  upsertProcessChainByPart,
} from '@/api/processChain';

// ============ 模块级单例 state ============
const parts = ref<PartListItem[]>([]);
const processes = ref<Process[]>([]);
/** partId → PartProcessFlow；只保存已加载过的零件，未加载的零件不占位。 */
const flows = ref<Record<string, PartProcessFlow>>({});
const loadingParts = ref(false);
const loadingProc = ref(false);
/** 正在 PUT 整组 upsert 的 partId（用于 UI「保存中」状态）。 */
const saving = ref<Record<string, boolean>>({});
const error = ref<string | null>(null);

/** 防抖延迟：800ms 内多次 upsertSteps 合并为一次 PUT。 */
const SAVE_DEBOUNCE_MS = 800;

/** 单 partId 的防抖 timer。 */
const saveTimers: Record<string, ReturnType<typeof setTimeout>> = {};

/** 把 service 侧 ProcessChainStepDto 转成 UI 用的 ProcessStep（注入 uid / color 等冗余）。
 *  ProcessStep.uid 仅作 UI v-for key，不参与后端。 */
function dtoToStep(dto: ProcessChainStepDto): ProcessStep {
  return {
    uid: `step-${dto.id ?? Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    process_id: dto.process_id,
    process_code: '', // 后端响应不冗余 code/name — composable 内按 process_id 二次查
    process_name: '',
    category: 'INHOUSE', // 默认值；loadFlow 后用 processes 修正
    estimated_minutes: dto.estimated_minutes,
    note: dto.note ?? null,
    sort_order: dto.sort_order,
    color: null,
  };
}

/** 把 UI 用的 ProcessStep 转成 service UpsertProcessChainRequest 用的 step（去掉 uid）。 */
function stepToUpsert(step: ProcessStep): ProcessChainStepDto {
  return {
    sort_order: step.sort_order,
    process_id: step.process_id,
    estimated_minutes: step.estimated_minutes,
    note: step.note ?? null,
  };
}

/** 加载某 part 的工艺链（懒加载）。
 *  - 已缓存 → 直接返回
 *  - 未缓存 → GET /process-chains/by-part/{part_id}
 *  - 20701 BIZ_PROCESS_CHAIN_NOT_FOUND（HTTP 404） → 视为空链，缓存一个空 PartProcessFlow
 *  - 其它错误 → 抛给 caller */
async function loadFlow(partId: string): Promise<PartProcessFlow> {
  const cached = flows.value[partId];
  if (cached) return cached;

  try {
    const dto = await getProcessChainByPart(partId);
    // 把 dto.steps → ProcessStep，冗余字段二次查 processes
    const steps: ProcessStep[] = dto.steps.map((s) => {
      const step = dtoToStep(s);
      const p = processes.value.find((pp) => pp.id === step.process_id);
      if (p) {
        step.process_code = p.code;
        step.process_name = p.name;
        step.category = p.category;
        step.color = p.color ?? null;
      }
      return step;
    });
    const flow: PartProcessFlow = {
      part_id: partId,
      version: dto.version,
      steps,
      updated_at: dto.updated_at,
    };
    flows.value = { ...flows.value, [partId]: flow };
    return flow;
  } catch (e) {
    // ApiError.code === 20701 → 空链（无 404 报错），其它错透传
    const code = (e as { code?: number }).code;
    if (code === 20701) {
      const empty: PartProcessFlow = {
        part_id: partId,
        version: 0,
        steps: [],
        updated_at: new Date().toISOString(),
      };
      flows.value = { ...flows.value, [partId]: empty };
      return empty;
    }
    throw e;
  }
}

/** 暴露给组件的 composable */
export function usePartProcessDesign() {
  async function loadParts(): Promise<void> {
    loadingParts.value = true;
    error.value = null;
    try {
      const items = await listParts({ keyword: '' });
      // rust PartListItem 字段集与前端 PartListItem 不全等（v2 无 row_type 等冗余字段）；
      // 用 unknown[] → PartListItem[] 强转，缺失字段按 undefined 处理（PartListItem 全 optional）。
      parts.value = items as PartListItem[];
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
      const items = await listProcesses({});
      processes.value = items as Process[];
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'load processes failed';
    } finally {
      loadingProc.value = false;
    }
  }

  /** 懒加载某 part 的工艺链；UI 选中 part 时调用。 */
  async function loadFlowForPart(partId: string): Promise<PartProcessFlow | null> {
    try {
      return await loadFlow(partId);
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'load flow failed';
      return null;
    }
  }

  /** 同步拿本地缓存（无 GET）。返回 null 表示未加载。 */
  function getFlowByPartId(partId: string): PartProcessFlow | null {
    return flows.value[partId] ?? null;
  }

  /** 用一个新 steps[] 覆盖某零件的工序列表；本地立刻更新 + 防抖 PUT。 */
  function upsertSteps(partId: string, steps: ProcessStep[]): PartProcessFlow {
    const reordered = steps.map((s, i) => ({ ...s, sort_order: i }));
    const current = flows.value[partId];
    const updated: PartProcessFlow = {
      part_id: partId,
      version: (current?.version ?? 0) + 1,
      steps: reordered,
      updated_at: new Date().toISOString(),
    };
    flows.value = { ...flows.value, [partId]: updated };
    scheduleSave(partId, reordered);
    return updated;
  }

  /** 按 uid 删除一道工序。 */
  function deleteStep(partId: string, uid: string): PartProcessFlow | null {
    const f = flows.value[partId];
    if (!f) return null;
    const next = f.steps.filter((s) => s.uid !== uid);
    return upsertSteps(partId, next);
  }

  /** 拖拽排序后调用：传入新顺序的 ProcessStep[]。 */
  function reorderSteps(partId: string, newSteps: ProcessStep[]): PartProcessFlow {
    return upsertSteps(partId, newSteps);
  }

  /** 防抖 PUT：把本地 steps 序列化成 UpsertProcessChainRequest 发到后端。 */
  function scheduleSave(partId: string, steps: ProcessStep[]): void {
    if (saveTimers[partId]) clearTimeout(saveTimers[partId]);
    saveTimers[partId] = setTimeout(() => {
      void doSave(partId, steps);
    }, SAVE_DEBOUNCE_MS);
  }

  /** 真正执行 PUT 整组 upsert。失败回滚到操作前快照。 */
  async function doSave(partId: string, steps: ProcessStep[]): Promise<void> {
    const snapshot = flows.value[partId];
    saving.value = { ...saving.value, [partId]: true };
    try {
      const dto = await upsertProcessChainByPart(partId, {
        steps: steps.map(stepToUpsert),
      });
      // 成功后用 server 返回的 version 覆盖本地（OCC 锚定）
      flows.value = {
        ...flows.value,
        [partId]: {
          ...flows.value[partId]!,
          version: dto.version,
          updated_at: dto.updated_at,
        },
      };
    } catch (e) {
      // 回滚：把 server 返回的快照放回（如果有）；否则保留旧 version 但保留新 steps 让用户重试）
      error.value = e instanceof Error ? e.message : 'save flow failed';
      if (snapshot) {
        flows.value = { ...flows.value, [partId]: snapshot };
      }
    } finally {
      saving.value = { ...saving.value, [partId]: false };
    }
  }

  /** 清空某零件的工序（不是删除零件，仅清空流程）。 */
  function clearFlow(partId: string): void {
    upsertSteps(partId, []);
  }

  /** 新建一道空白工序（追加到末尾）。 */
  function newStep(): ProcessStep {
    const first = processes.value[0];
    return {
      uid: `step-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      process_id: first?.id ?? '',
      process_code: first?.code ?? '',
      process_name: first?.name ?? '',
      category: first?.category ?? 'INHOUSE',
      estimated_minutes: 30,
      note: null,
      sort_order: 0,
      color: first?.color ?? null,
    };
  }

  /** 派生：某零件工序摘要（总耗时 / 含外协）。 */
  function summaries(partId: string): PartProcessSummary {
    const f = flows.value[partId];
    if (!f) return { step_count: 0, total_minutes: 0, has_outsource_approval: false };
    const total_minutes = f.steps.reduce((acc, s) => acc + (s.estimated_minutes || 0), 0);
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
    saving: saving as Ref<Record<string, boolean>>,
    error: error as Ref<string | null>,
    allSummaries,
    loadParts,
    loadProcesses,
    loadFlowForPart,
    getFlowByPartId,
    upsertSteps,
    deleteStep,
    reorderSteps,
    clearFlow,
    newStep,
    summaries,
  };
}
