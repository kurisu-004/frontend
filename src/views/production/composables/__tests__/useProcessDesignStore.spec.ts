// src/views/production/composables/__tests__/useProcessDesignStore.spec.ts
//
// 2026-10-05 新增：「制定工序」页 store（Pinia setup store）单测。
//
// 覆盖（14 例，与任务书 A8 清单逐条对齐；断言多从已删除的
// usePartProcessDesign.spec.ts 平移，**驱动方式全变**：
// `loadParts()` → `store.query.restoreState()` + `store.query.fetchList()`，
// `q.parts.value` → `store.query.parts`）：
//   T1  列表加载 + process_chain_id / assembly_id 透传
//   T2  子件可见（assembly_id 非空的行不被过滤掉）
//   T3  enabled 闸门：store 构造后不发请求，restoreState 后才发
//   T4  Zod 守门：响应缺 assembly_id → query 进 error 态
//   T5  sort_dir 切换 ASC → DESC → null(落回 ASC) 的 refetch
//   T6  分组：process_chain_id null → 待制定 / 非 null → 已制定
//   T7  选中无链零件不发请求，直接判空链
//   T8  链 20701（BIZ_PROCESS_CHAIN_NOT_FOUND）视为空链
//   T9  本地编辑立刻生效（sort_order 拍平为 0,1,…；不自动 POST）
//   T10 连续两次 addStep() 后 save() 发的是拍平后的 [0,1]（旧回归用例，必须保留）
//   T11 save 成功后 process_chain_id 回写 → 分组迁移到「已制定」（setQueryData 零闪烁）
//   T12 save 失败：ElMessage.error 被调 + 保留本地 steps 不回滚
//   T13 $dispose 后重建 store，状态归零（Pinia hydrate 泄漏 guard）
//   T14 el-table rowKey 与 current-row-key 的匹配契约 ——
//       ⚠️ 放在 PartPickerList.spec.ts（happy-dom 真挂 el-table），本文件 node 环境不碰 DOM。
//
// mock 策略（照 usePendingProgrammingStore.spec.ts 骨架，理由同样成立）：
//   - vi.mock('@/api/http')：**只**替换 `api.get` / `api.post`（importOriginal 保留
//     cleanParams / ApiError 等真实导出）。**不** mock 掉 '@/api/processChain' 整个
//     模块 —— Zod 守门已收敛进 api 层（listProcessDesignParts 内部 parse），
//     mock 整个 api 模块会把守门链短路，T4 就变成在测 mock 自己。
//   - 因为 api 层是真的，本文件能顺带守到**真实的 `ApiError` instanceof 分支**
//     （20701 归一化 / save 失败），不必像旧 spec 那样 vi.resetModules() +
//     vi.doMock 重建 class 身份。
//   - vi.mock('element-plus', () => ({ ElMessage: {...} }))：node 环境无 document，
//     真实 ElMessage 会抛 ReferenceError 污染输出。
//   - createApp({}) + app.use(createPinia()) + app.use(VueQueryPlugin) +
//     setActivePinia：store 内 useQueryClient() / useQuery / useMutation 要求
//     pinia + queryClient 就位（useQueryClient 必须在 setup 第一行，不能惰性取）。
//   - 每例重建 QueryClient（含 mutations.retry: 0，与 main.ts 全局一致），
//     afterEach 里 unmount() —— 否则 query 缓存跨例串味。

import { ElMessage } from 'element-plus';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from 'vue';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';
// 供 vi.mock 的 importOriginal 泛型使用（@typescript-eslint/consistent-type-imports
// 禁止内联 `typeof import('...')` 写法；沿 usePendingProgrammingStore.spec.ts 同款）
import type * as HttpModule from '@/api/http';
import type { ProcessDesignPartSchema } from '@/composables/queries/schemas';
import type { ProcessChainByPartDto, UpsertProcessChainRequest } from '@/api/processChain.contract';

vi.mock('element-plus', () => ({
  ElMessage: {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
}));

const { apiGetMock, apiPostMock } = vi.hoisted(() => ({
  apiGetMock:
    vi.fn<
      (url: string, config?: { params?: Record<string, unknown> }) => Promise<{ data: unknown }>
    >(),
  apiPostMock: vi.fn<(url: string, body?: unknown) => Promise<{ data: unknown }>>(),
}));

vi.mock('@/api/http', async (importOriginal) => {
  const actual = await importOriginal<typeof HttpModule>();
  return { ...actual, api: { ...actual.api, get: apiGetMock, post: apiPostMock } };
});

import { ApiError } from '@/api/http';
import { useProcessDesignStore, PROCESS_DESIGN_LIMIT } from '../useProcessDesignStore';
import { splitPartsByProcessDesign } from '../../utils/partDesignGrouping';
import { STUB_PARTS, STUB_PROCESSES, STUB_CHAINS } from '../../__fixtures__/partProcess.fixtures';

const PARTS_URL = '/prod/process-design/parts';
const PROCESSES_URL = '/prod/processes';
const CHAIN_BY_ID_PREFIX = '/prod/process-chains/';
const CHAIN_BY_PART_PREFIX = '/prod/process-chains/by-part/';

// 旧 spec 里那几个零件的身份（STUB_PARTS 已换成 7 字段 VO）：
const FLANGE = '5000000000001'; // 法兰盘：已制定（chain 7000000000001，3 步含外协）
const SHELL = '5000000000005'; // 外壳：未制定
const SHAFT = '5000000000004'; // 连接轴：挂着已删链 7000000000099
const CHILD = '5000000000006'; // 轴承座：**装配件子件**（assembly_id 非空）

/** 可手动 resolve 的 promise —— T11 用它把失效 refetch 挂起，验证「零闪烁回写」。 */
interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** 等条件成立（比固定 sleep 稳：query 内部有多层 microtask + 定时器）。 */
async function waitUntil(pred: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil 超时');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** 让 vue-query 的 watcher / 定时器跑一轮（用于「不该发请求」这类负向断言）。 */
function settle(): Promise<void> {
  return new Promise((r) => setTimeout(r, 30));
}

/** 服务端态（可变）：列表 + 链。POST 成功后按后端语义同步回写 process_chain_id。 */
let partsState: ProcessDesignPartSchema[];
let chainState: Record<string, UpsertProcessChainRequest['steps']>;
/** T11 用：非 null 时下一次列表请求挂起，模拟 refetch 网络延迟。 */
let listGate: Deferred<{ data: unknown }> | null;
/** T4 用：非 null 时列表响应改用它（喂非法 payload）。 */
let partsOverride: unknown | null;

function listEnvelope(): {
  items: ProcessDesignPartSchema[];
  total: number;
  limit: number;
  offset: number;
} {
  return {
    items: partsState,
    total: partsState.length,
    limit: PROCESS_DESIGN_LIMIT,
    offset: 0,
  };
}

function chainEnvelope(
  chainId: string,
  steps: UpsertProcessChainRequest['steps'],
): ProcessChainByPartDto {
  return {
    id: chainId,
    name: '默认工艺',
    note: null,
    version: 1,
    created_at: '2026-09-10T08:00:00Z',
    updated_at: '2026-09-10T08:00:00Z',
    steps,
  };
}

/** 按 URL 分发 GET：列表 / 工序下拉（共享层）/ 工艺链。 */
async function respondGet(url: string): Promise<{ data: unknown }> {
  if (url === PARTS_URL) {
    if (listGate) return listGate.promise;
    return { data: partsOverride ?? listEnvelope() };
  }
  if (url === PROCESSES_URL) {
    return {
      data: {
        items: STUB_PROCESSES,
        total: STUB_PROCESSES.length,
        limit: 500,
        offset: 0,
      },
    };
  }
  const chainId = decodeURIComponent(url.slice(CHAIN_BY_ID_PREFIX.length));
  const steps = chainState[chainId];
  if (!steps) {
    // 链已删 / 脏数据：后端回 20701 BIZ_PROCESS_CHAIN_NOT_FOUND（store 按空链归一）
    throw new ApiError(20701, 'BIZ_PROCESS_CHAIN_NOT_FOUND');
  }
  return { data: chainEnvelope(chainId, steps) };
}
/** POST 整组 upsert：后端建链 / 覆盖链，并把 part.process_chain_id 回写（供 refetch）。 */
async function respondPost(url: string, body?: unknown): Promise<{ data: unknown }> {
  const partId = decodeURIComponent(url.slice(CHAIN_BY_PART_PREFIX.length));
  // 稳定派生新链 id（与旧 spec 同款：`7000000000` + partId 后 3 位）
  const chainId = `7000000000${partId.slice(-3)}`;
  const steps = (body as UpsertProcessChainRequest).steps;
  chainState[chainId] = steps;
  partsState = partsState.map((p) =>
    p.id === partId && p.process_chain_id !== chainId ? { ...p, process_chain_id: chainId } : p,
  );
  return {
    data: chainEnvelope(chainId, steps),
  };
}

let testQueryClient: QueryClient;
let testPinia: Pinia;

describe('useProcessDesignStore', () => {
  beforeEach(() => {
    apiGetMock.mockReset();
    apiPostMock.mockReset();
    apiGetMock.mockImplementation(respondGet);
    apiPostMock.mockImplementation(respondPost);
    // ElMessage 的 mock 建在 vi.mock 工厂里（不是 spy），vi.restoreAllMocks() 不会清
    // 它的调用记录 ⇒ 每例显式 clear，避免上一例的弹错串到下一例的断言。
    vi.mocked(ElMessage.error).mockClear();
    vi.mocked(ElMessage.success).mockClear();
    partsState = STUB_PARTS.map((p) => ({ ...p }));
    chainState = Object.fromEntries(
      Object.entries(STUB_CHAINS).map(([id, c]) => [id, c.steps.map((s) => ({ ...s }))]),
    );
    listGate = null;
    partsOverride = null;

    testQueryClient = new QueryClient({
      defaultOptions: { mutations: { retry: 0 }, queries: { retry: 0 } },
    });
    const app = createApp({});
    testPinia = createPinia();
    app.use(testPinia);
    app.use(VueQueryPlugin, { queryClient: testQueryClient });
    setActivePinia(app.config.globalProperties.$pinia);
  });

  afterEach(() => {
    testQueryClient.unmount();
    testQueryClient = null as unknown as QueryClient;
    vi.restoreAllMocks();
  });

  /** 列表端点（`/prod/process-design/parts`）已发出的请求次数。 */
  function listCalls(): number {
    return apiGetMock.mock.calls.filter((c) => c[0] === PARTS_URL).length;
  }

  /** 工艺链端点已发出的请求次数（列表 / 工序下拉不计）。 */
  function chainCalls(): number {
    return apiGetMock.mock.calls.filter(
      (c) =>
        typeof c[0] === 'string' && c[0].startsWith(CHAIN_BY_ID_PREFIX) && c[0] !== PROCESSES_URL,
    ).length;
  }

  /** 最近一次列表请求的 params（已过 cleanParams）。 */
  function lastListParams(): Record<string, unknown> {
    const calls = apiGetMock.mock.calls.filter((c) => c[0] === PARTS_URL);
    return (calls[calls.length - 1]?.[1]?.params ?? {}) as Record<string, unknown>;
  }

  /** 常规装配：构造 store → 开闸 → 拉一次列表。 */
  async function bootedStore() {
    const store = useProcessDesignStore();
    store.query.restoreState();
    await store.query.fetchList();
    return store;
  }

  // ============ T1：列表加载 + 透传 ============
  it('T1：列表加载后 process_chain_id / assembly_id 原样透传，7 字段齐全', async () => {
    const store = useProcessDesignStore();
    store.query.restoreState();
    await store.query.fetchList();

    expect(store.query.errorMsg).toBeNull();
    expect(store.query.parts).toHaveLength(6);
    expect(store.query.total).toBe(6);

    const flange = store.query.parts.find((p) => p.id === FLANGE);
    expect(flange?.process_chain_id).toBe('7000000000001');
    expect(flange?.assembly_id).toBeNull();
    const shell = store.query.parts.find((p) => p.id === SHELL);
    expect(shell?.process_chain_id).toBeNull();

    // 端点只认 3 个入参：sort_dir / limit / offset，**没有** status / keyword /
    // include_assemblies（PENDING 写死在后端 SQL 常量里，子件不做开关）
    expect(lastListParams()).toEqual({
      sort_dir: 'ASC',
      limit: PROCESS_DESIGN_LIMIT,
      offset: 0,
    });

    // 7 字段一个不少（缺字段会被 Zod 守门拦掉，这里逐个确认）
    expect(Object.keys(store.query.parts[0] ?? {}).sort()).toEqual([
      'assembly_id',
      'drawing_no',
      'id',
      'name',
      'process_chain_id',
      'serial_no',
      'version',
    ]);

    // 工序下拉走共享基础数据层（useProcessesQuery → GET /prod/processes，limit 500）
    await waitUntil(() => store.query.processes.length > 0);
    expect(store.query.processes).toHaveLength(6);
    expect(store.query.loading).toBe(false);
  });

  // ============ T2：子件可见 ============
  it('T2：装配件子件（assembly_id 非空）出现在列表里，不被过滤', async () => {
    const store = await bootedStore();
    const child = store.query.parts.find((p) => p.id === CHILD);
    expect(child).toBeDefined();
    expect(child?.assembly_id).toBe('8000000000001');
    // 请求侧没有 include_assemblies 之类的旋钮 —— 子件出现是端点口径，不是开关
    expect(lastListParams().include_assemblies).toBeUndefined();
    expect(lastListParams().status).toBeUndefined();
  });

  // ============ T3：enabled 闸门 ============
  it('T3：store 构造后不发列表请求，restoreState 后才发（避免双 fetch）', async () => {
    const store = useProcessDesignStore();
    await settle();
    expect(listCalls()).toBe(0);

    store.query.restoreState();
    await waitUntil(() => listCalls() === 1);
    expect(lastListParams().sort_dir).toBe('ASC');
  });

  // ============ T4：Zod 守门 ============
  it('T4：响应缺 assembly_id → query 进 error 态（errorMsg 非空、items 空）', async () => {
    // 后端漏返 assembly_id 时必须被 Zod 拦住 —— 默认 strip 会静默吞掉缺失键，
    // UI 的子件标记就会整列失效（这正是显式声明 7 字段的原因）。
    const { assembly_id: _omit, ...invalid } = STUB_PARTS[0];
    void _omit;
    partsOverride = { items: [invalid], total: 1, limit: PROCESS_DESIGN_LIMIT, offset: 0 };

    const store = useProcessDesignStore();
    store.query.restoreState();
    await store.query.fetchList();

    expect(store.query.errorMsg).toBeTruthy();
    expect(store.query.parts).toHaveLength(0);
    expect(store.query.total).toBe(0);
    expect(ElMessage.error).toHaveBeenCalled();
  });

  // ============ T5：sort_dir 切换 ============
  it('T5：sort_dir ASC → DESC → 取消排序（落回 ASC）逐次触发 refetch', async () => {
    const store = await bootedStore();
    expect(lastListParams().sort_dir).toBe('ASC');
    const beforeSwitch = listCalls();

    store.query.onSortChange('descending');
    await store.query.fetchList();
    expect(lastListParams().sort_dir).toBe('DESC');
    expect(listCalls()).toBeGreaterThan(beforeSwitch);
    const beforeReset = listCalls();

    // EP 的 order 三态第三态是 null（取消排序）；后端只认 DESC / 非 DESC ⇒ 落回 ASC
    store.query.onSortChange(null);
    await store.query.fetchList();
    expect(lastListParams().sort_dir).toBe('ASC');
    expect(listCalls()).toBeGreaterThan(beforeReset);
  });

  // ============ T6：分组 ============
  it('T6：process_chain_id null → 待制定 / 非 null → 已制定（子件同规则）', async () => {
    const store = await bootedStore();
    const { pending, designed } = splitPartsByProcessDesign(store.query.parts);
    // 5000000000004 连接轴的 process_chain_id 非空（指向已删链 7000000000099），
    // 纯函数只看「非 null」⇒ 仍落「已制定」（是否链已删由 T8 的 20701 分支管）
    expect(pending.map((p) => p.id)).toEqual(['5000000000002', '5000000000005', '5000000000006']);
    expect(designed.map((p) => p.id)).toEqual(['5000000000001', '5000000000003', '5000000000004']);
  });

  // ============ T7：无链零件不发请求 ============
  it('T7：选中 process_chain_id 为空的零件不发链请求，直接判空链', async () => {
    const store = await bootedStore();
    store.query.selectPart(SHELL);
    await settle();

    expect(store.query.selectedPartId).toBe(SHELL);
    expect(chainCalls()).toBe(0); // 省一次必 404 的往返
    expect(store.editor.steps).toHaveLength(0);
    expect(store.query.errorMsg).toBeNull();
  });

  // ============ T8：20701 视为空链 ============
  it('T8：链拉取返回 20701（链已删 / 脏数据）按空链归一，不进错误态', async () => {
    const store = await bootedStore();
    store.query.selectPart(SHAFT); // process_chain_id = 7000000000099，链不存在
    await waitUntil(() => chainCalls() === 1);
    await waitUntil(() => store.query.chainPending === false);

    expect(
      apiGetMock.mock.calls.filter((c) => c[0] === `${CHAIN_BY_ID_PREFIX}7000000000099`),
    ).toHaveLength(1);
    expect(store.editor.steps).toHaveLength(0);
    expect(store.query.errorMsg).toBeNull();
    expect(ElMessage.error).not.toHaveBeenCalled();
  });

  // ============ T9：本地编辑立刻生效（不自动 POST）============
  it('T9：addStep 本地立刻生效并按数组下标拍平 sort_order，且不自动 POST', async () => {
    const store = await bootedStore();
    store.query.selectPart(SHELL);
    await settle();

    store.editor.addStep();
    store.editor.addStep();

    expect(store.editor.steps).toHaveLength(2);
    expect(store.editor.steps.map((s) => s.sort_order)).toEqual([0, 1]);
    // 默认带第一道工序 + estimated_minutes=30
    expect(store.editor.steps[0]?.process_id).toBe(STUB_PROCESSES[0]?.id);
    expect(store.editor.steps[0]?.estimated_minutes).toBe(30);
    expect(store.editor.totalMinutes).toBe(60);
    // dirty = 与服务端链的业务签名不符
    expect(store.editor.dirty).toBe(true);
    // 持久化入口唯一化：编辑本身绝不发 POST
    expect(apiPostMock).not.toHaveBeenCalled();
  });

  // ============ T10：拍平回归（旧 spec 的 2026-09-29 回归用例）============
  it('T10：连续两次 addStep() 后 save() 发拍平后的 [0, 1]（不是 [0, 0] 撞 20104）', async () => {
    const store = await bootedStore();
    store.query.selectPart(SHELL);
    await settle();
    store.editor.addStep();
    store.editor.addStep();

    await store.editor.save();

    expect(apiPostMock).toHaveBeenCalledTimes(1);
    const [url, body] = apiPostMock.mock.calls[0] as [string, UpsertProcessChainRequest];
    expect(url).toBe(`${CHAIN_BY_PART_PREFIX}${SHELL}`);
    expect(body.steps.map((s) => s.sort_order)).toEqual([0, 1]);
  });

  // ============ T11：保存后回写 process_chain_id（零闪烁）============
  it('T11：save 成功后 process_chain_id 回写 → 分组迁移到「已制定」（refetch 未回前即生效）', async () => {
    const store = await bootedStore();
    store.query.selectPart(SHELL);
    await settle();
    store.editor.addStep();

    // 把 save 成功触发的列表 refetch 挂起：此刻 setQueryData 的零闪烁回写必须已经落地
    // （只失效不 setQueryData 的话，这一行会留在「待制定」直到下一个往返）。
    listGate = deferred<{ data: unknown }>();
    const savePromise = store.editor.save();

    await waitUntil(
      () => store.query.parts.find((p) => p.id === SHELL)?.process_chain_id === '7000000000005',
    );
    expect(splitPartsByProcessDesign(store.query.parts).designed.map((p) => p.id)).toContain(SHELL);
    expect(splitPartsByProcessDesign(store.query.parts).pending.map((p) => p.id)).not.toContain(
      SHELL,
    );

    listGate.resolve({ data: listEnvelope() });
    await savePromise;

    expect(ElMessage.success).toHaveBeenCalledWith('已保存');
    // 链缓存直接落服务端响应 ⇒ dirty 自动归零（草稿与新链内容一致）
    await waitUntil(() => store.editor.dirty === false);
    expect(store.editor.saving).toBe(false);
  });

  // ============ T12：保存失败 ============
  it('T12：save 失败 → ElMessage.error 被调 + 保留本地 steps 与 dirty，不回写 process_chain_id', async () => {
    const store = await bootedStore();
    store.query.selectPart(SHELL);
    await settle();
    store.editor.addStep();
    store.editor.patchStep(store.editor.steps[0]?.uid ?? '', { estimated_minutes: 55 });

    apiPostMock.mockRejectedValueOnce(new ApiError(500, 'save fail'));
    await expect(store.editor.save()).rejects.toBeInstanceOf(ApiError);

    expect(ElMessage.error).toHaveBeenCalledWith('保存工艺链失败：save fail');
    // 草稿与 dirty 保持不变（用户编辑不丢，可再点保存重试）
    expect(store.editor.steps).toHaveLength(1);
    expect(store.editor.steps[0]?.estimated_minutes).toBe(55);
    expect(store.editor.dirty).toBe(true);
    // 失败不得回写 process_chain_id（零件仍属「待制定」）
    expect(store.query.parts.find((p) => p.id === SHELL)?.process_chain_id).toBeNull();
    expect(listCalls()).toBe(1); // 失败不触发失效 refetch
  });

  // ============ T13：$dispose 重建 ============
  it('T13：$dispose 后重建 store → 选中零件 / 未保存草稿归零（Pinia hydrate 泄漏 guard）', async () => {
    const store1 = await bootedStore();
    store1.query.selectPart(SHELL);
    await settle();
    store1.editor.addStep();
    expect(store1.editor.steps).toHaveLength(1);

    store1.$dispose();

    // 机制：对外状态走 query / editor 两个 plain object slice ⇒ Pinia 不把其中的 ref
    // 写进 pinia.state，$dispose 后不会 hydrate 回来（平铺顶层 ref 就会泄漏）。
    const persisted =
      (testPinia.state.value as Record<string, Record<string, unknown>>)['process-design'] ?? {};
    expect(Object.keys(persisted)).toEqual([]);

    const store2 = useProcessDesignStore();
    expect(store2.query.selectedPartId).toBeNull();
    expect(store2.editor.steps).toHaveLength(0);
    expect(store2.editor.dirty).toBe(false);
    expect(store2.query.sortDir).toBe('ASC');
  });
});
