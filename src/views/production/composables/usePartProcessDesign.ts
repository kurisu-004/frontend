// 2026-09-14 改造：usePartProcessDesign composable 从 fixture + localStorage 切到真实 v2 API。
//
// 阶段二（2026-09-14 起）：所有读写走 @/api/processChain（baseURL /api/v2）。
// - loadParts / loadProcesses：拉全量；本地缓存到模块级单例。
//   2026-09-16 修复：loadParts 固定传 status='PENDING'，已下发编程/车间的工件不再进入工序制定。
// - flows（PartProcessFlow 字典）：懒加载 — 用户选 part 时按需拉取；
//   2026-09-16 起加载路径由 part.process_chain_id 驱动（见下方第 4 段）；
//   20701 BIZ_PROCESS_CHAIN_NOT_FOUND → 视为空链，不报错。
// - upsertSteps / deleteStep / reorderSteps：纯本地 mutation，不自动 PUT。
// - saveFlow：手动触发的 PUT 整组 upsert（由 ProcessStepCardList 保存按钮触发）。
//
// 2026-09-16 process_chain_id FK 翻转（后端 PR 并行）：
// - 后端 /parts 列表/详情出参新增 process_chain_id（null = 未制定工序）；
//   左栏「待制定 / 已制定」分组改由该字段驱动（见 PartPickerList.vue）。
// - loadFlow 不再走 by-part 端点：part.process_chain_id 非空 → GET /process-chains/{chain_id}；
//   为空 → 未制定过工序，不发请求，直接缓存空链。
// - save 成功后把 upsert 响应的链 id 回写到本地零件的 process_chain_id（首次保存建链场景），
//   该零件立刻从「待制定」移入「已制定」分组（响应式，无需整表刷新）。
//
// 2026-09-16 改造：删除 scheduleSave 防抖链路。原先「steps 变更 → 800ms 后自动 PUT」的设计
// 让保存按钮形同虚设（永远 disabled 因为 dirty 在 PUT 后立刻被清零），改成显式手动保存。
// 持久化入口唯一化为公开方法 save(partId, steps)（由 UI 保存按钮调用）：
//   ① 本地 upsertSteps mutate
//   ② 调内部 saveFlow PUT 整组
//   ③ 成功：清 dirty；失败：保留 steps 与 dirty=true 让用户重试
// saveFlow 改为 internal（不 export），不再承担「调用前已 upsertSteps」的不成文 invariant。
//
// 2026-09-16 第 1 轮 review 修复：旧 saveFlow catch 块注释写「回滚：把 server 返回的快照放回」
// 是错的——snapshot 在 try 第一行捕获，但此时 upsertSteps 已在 onSave 入口跑过，
// snapshot 实际是 post-mutation 状态，回滚等于 no-op。新语义「失败保留编辑以便重试」，
// 直接删掉 snapshot 回滚路径（mutate 已在 try 外做，catch 只重置 saving + 弹错即可）。
//
// 整组 upsert 约束（2026-09-14 写入注释，CLAUDE.md 习惯）：
//   rust PUT /process-chains/by-part/{part_id} 是整组替换语义——前端必须发完整 steps 数组
//   （包括 service-side 已有的 step），否则会被覆盖。所以本地流程编辑后 PUT 时，本地
//   PartProcessFlow.steps 已是「完整数组 + 用户变更」，直接序列化发走即可。
//   若本地发现缺 step（如 race：用户编辑期间另一 tab GET 后 PUT 覆盖了本地 cache），
//   先 GET 一次拿完整 list 再 merge 用户变更（mergeToFullSteps 函数）。

import { computed, ref, type ComputedRef, type Ref } from 'vue';
import { ElMessage } from 'element-plus';
import { ApiError } from '@/api/http';
import type { PartListItem } from '@/types/parts';
import type { Process } from '@/types/process';
import type { PartProcessFlow, PartProcessSummary, ProcessStep } from '@/types/partProcess';
import type { ProcessChainStepDto } from '@/api/processChain.contract';
import {
  getProcessChainById,
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
 *  2026-09-16 改造：加载路径由 part.process_chain_id 驱动（替代原 by-part 端点直查）——
 *  - 已缓存 → 直接返回
 *  - part.process_chain_id 为空 → 未制定过工序，不发请求，直接缓存空链
 *  - part.process_chain_id 非空 → GET /process-chains/{chain_id}
 *  - 20701 BIZ_PROCESS_CHAIN_NOT_FOUND（HTTP 404，链已删/脏数据） → 视为空链，缓存空 flow
 *  - 其它错误 → 抛给 caller */
async function loadFlow(partId: string): Promise<PartProcessFlow> {
  const cached = flows.value[partId];
  if (cached) return cached;

  // 2026-09-16 新增：链 id 取自本地零件列表（loadParts 已带出 process_chain_id）。
  // 零件不在本地列表（异常路径，如列表尚未加载）时按「无链」处理 —— 不发请求；
  // UI 正常路径下点击的零件必在 parts.value 里。
  const chainId = parts.value.find((p) => p.id === partId)?.process_chain_id ?? null;
  if (!chainId) {
    const empty: PartProcessFlow = {
      part_id: partId,
      version: 0,
      steps: [],
      updated_at: new Date().toISOString(),
    };
    flows.value = { ...flows.value, [partId]: empty };
    return empty;
  }

  try {
    const dto = await getProcessChainById(chainId);
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
    // 2026-09-14 follow-up：用 instanceof ApiError 替代 `(e as { code?: number }).code`，
    // 避免 TS 「Object is possibly 'unknown'」误报，且对未来非 ApiError 异常路径
    // （如网络层抛裸 Error）更安全。
    if (e instanceof ApiError && e.code === 20701) {
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
/** 2026-09-21 显式返回类型。 */
export interface UsePartProcessDesignReturn {
  parts: Ref<PartListItem[]>;
  processes: Ref<Process[]>;
  flows: Ref<Record<string, PartProcessFlow>>;
  loadingParts: Ref<boolean>;
  loadingProc: Ref<boolean>;
  saving: Ref<Record<string, boolean>>;
  error: Ref<string | null>;
  allSummaries: ComputedRef<Record<string, PartProcessSummary>>;
  loadParts: () => Promise<void>;
  loadProcesses: () => Promise<void>;
  loadFlowForPart: (partId: string) => Promise<PartProcessFlow | null>;
  getFlowByPartId: (partId: string) => PartProcessFlow | null;
  upsertSteps: (partId: string, steps: ProcessStep[]) => PartProcessFlow;
  deleteStep: (partId: string, uid: string) => PartProcessFlow | null;
  reorderSteps: (partId: string, newSteps: ProcessStep[]) => PartProcessFlow;
  save: (partId: string, steps: ProcessStep[]) => Promise<void>;
  clearFlow: (partId: string) => void;
  newStep: () => ProcessStep;
  summaries: (partId: string) => PartProcessSummary;
}

export function usePartProcessDesign(): UsePartProcessDesignReturn {
  async function loadParts(): Promise<void> {
    loadingParts.value = true;
    error.value = null;
    try {
      // 2026-09-16 修复：固定 status='PENDING'。
      // 工序制定仅针对未下发的工件；已下发编程（PROGRAMMING）/车间（IN_PROCESS 等）
      // 的工件不应在此页面展示，否则会让用户重复制定或误操作。
      // 后端 PartListQuery.status 单值过滤（与 src/api/parts/crud.ts 的 statuses 多值
      // 数组语义不同，此处走单值；statuses 留给其它列表页多选场景）。
      // 2026-09-16 第 1 轮 review：listParts 默认 keyword 入参是 undefined，
      // cleanParams 会 strip undefined，传空串是语义冗余，这里直接不传 keyword。
      const items = await listParts({ status: 'PENDING' });
      // 2026-09-25 修正：listParts 已返回 PartListItem[]，无需再就地强转。
      parts.value = items;
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
      // 2026-09-25 修正：listProcesses 已返回 Process[]，无需再就地强转。
      processes.value = items;
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

  /** 用一个新 steps[] 覆盖某零件的工序列表；本地立刻更新（不自动 PUT）。
   *  2026-09-16 改造：去掉 scheduleSave 调用。原先每次 upsertSteps 都会触发
   *  800ms 防抖自动保存，导致 ProcessStepCardList 的「保存」按钮永远 disabled。
   *  现在 upsertSteps 是纯本地 mutation，持久化由 saveFlow(partId, steps) 显式触发。 */
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

  /** 显式持久化（internal）：把本地 steps 序列化成 UpsertProcessChainRequest 发到后端。
   *  2026-09-16 改造：由 ProcessStepCardList 的「保存」按钮触发（替代原先的
   *  scheduleSave 防抖自动保存）。
   *  2026-09-16 第 1 轮 review 修复：旧版本 catch 块注释写「回滚：把 server 返回的快照放回」
   *  是错的——snapshot 在 try 第一行捕获，但此时 upsertSteps 已在调用方（公开 save）
   *  跑过，snapshot 实际是 post-mutation 状态，回滚等于 no-op。新语义「失败保留编辑以便
   *  重试」，不再做 snapshot 回滚；mutate 在调用方 upsertSteps 完成，本函数只负责 PUT
   *  与错误反馈（error.value + ElMessage.error）。
   *  internal：不 export。外部唯一入口是下方公开方法 save(partId, steps)。 */
  async function saveFlow(partId: string, steps: ProcessStep[]): Promise<void> {
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
      // 2026-09-16 新增：无链 part 首次保存时后端建链并回写 part.process_chain_id
      // （upsert 响应的 `id` 即链 id；既有链保存时 id 不变，赋值幂等）。
      // 前端同步更新本地零件列表，让该零件立刻从「待制定」移入「已制定」分组
      // （响应式驱动 PartPickerList 的 splitPartsByProcessDesign，无需整表刷新）。
      const idx = parts.value.findIndex((p) => p.id === partId);
      if (idx !== -1 && parts.value[idx]!.process_chain_id !== dto.id) {
        const next = parts.value.slice();
        next[idx] = { ...next[idx]!, process_chain_id: dto.id };
        parts.value = next;
      }
    } catch (e) {
      // 失败：保留本地 steps 与 dirty=true（mutate 在调用方 save 入口已完成），
      // 让用户编辑不丢、可重试。
      const msg = e instanceof Error ? e.message : 'save flow failed';
      error.value = msg;
      // 2026-09-14 follow-up：除 error.value 内部状态外，弹 ElMessage.error
      // 提升 UX 反馈（之前只在 saving=true 时 UI 无感，失败仅 error.value 静默变化）。
      ElMessage.error(`保存工艺链失败：${msg}`);
      // 重新抛给调用方公开 save，让上层 UI 不要再清 dirty（保持 dirty=true 让用户重试）
      throw e;
    } finally {
      saving.value = { ...saving.value, [partId]: false };
    }
  }

  /** 公开持久化入口：本地 mutate → PUT → 成功清 dirty / 失败保留 dirty 让用户重试。
   *  2026-09-16 第 1 轮 review 修复：旧版 UI 直接调 upsertSteps + saveFlow 两步，
   *  saveFlow 内部又隐式依赖「调用前已 upsertSteps」这个不成文 invariant，是静默错乱
   *  的根源。改成本方法对外只暴露一个语义清晰的入口：save(partId, steps) 一句话完成
   *  「编辑 → 持久化」全流程。
   *  顺序固定为：
   *   ① upsertSteps(partId, steps) 本地 mutate（更新 sort_order 与 flows 单例）
   *   ② 调 internal saveFlow PUT 整组
   *   ③ 成功：返回；失败：把 saveFlow 抛出的原 error 重抛，dirty 由 UI 维持 true
   *  注意：dirty 重置由 UI（ProcessStepCardList.onSave）控制，不在本 composable 内
   *  触碰脏标记 —— composable 不直接持组件级 ref（dirty 在组件内），UI 拿到的成功
   *  信号是「没抛错」即可清 dirty。 */
  async function save(partId: string, steps: ProcessStep[]): Promise<void> {
    // 步骤 1：本地 mutation（更新 flows.value[partId].steps + sort_order）
    upsertSteps(partId, steps);
    // 步骤 2：PUT 整组 upsert 到后端（失败时 saveFlow 已弹 ElMessage.error + 设 error.value，
    // 这里把原 error 重抛给 UI，由 UI 决定是否再清 dirty —— 失败时不清，保留以便重试）
    await saveFlow(partId, steps);
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
    save,
    clearFlow,
    newStep,
    summaries,
  };
}
