// src/composables/__tests__/useShelfProcessFilter.spec.ts
//
// 2026-10-02 重写（Phase C）：数据源从裸 async `load()` 迁到共享基础数据层 query
// （useShelfProcessMappingsQuery）之后，本文件全部重写 —— 旧 7 例都靠手动 `await
// f.load()` 驱动，而 `load` 已从对外 API 删除。
//
// 新驱动方式：**开闸即自动拉**。composable 自己从两个已存在的形参（allShelves /
// allProcesses）派生 `enabled = 两源都非空`，query 一开闸就发 GET /prod/shelf-processes，
// 用例改为「喂非空源 → 等 query settle → 断言」。
//
// 为什么 mock 仍是逐字复刻后端的**扁平行**（这是本文件存在的原因，2026-10-02 首轮）：
// `GET /prod/shelf-processes`（全集）返回一行一个 (货架, 工序) 对，同一 shelf_id 多行；
// 旧实现按 v1(Python) 的「一架子集一行」读 `item.process_ids`（恒 undefined）→
// `new Set(undefined)` = 空集 → loaded=true 后 filteredProcesses / filteredShelves 把
// 候选池**全过滤**掉，8 个调用点的货架 / 工序下拉被静默清空且不报任何错。而它之所以能
// 长期潜伏，是因为**零契约守门** —— 本轮迁移把 Zod 守门（shelfProcessMappingsResultSchema）
// 收进 queryFn，本文件的 F6 就是那道守门的回归守卫。
//
// mock 契约：逐字复刻 backend-rust `AllShelfProcessMappingOut`
// （src/modules/prod/shelf_process/vo.rs:44-56）—— 只有 items 一个顶层字段（**没有**
// total / limit / offset），元素 4 字段 shelf_id / shelf_code / process_id / process_code
// （全集接口**不返** sort_order，排序由 service 层 ORDER BY 保证）。
//
// element-plus：CLAUDE.md 架构条目 §9 —— ElMessage 在 vitest node env 会因内部
// normalizeAppendTo 触发 `ReferenceError: document is not defined`，必须桩成 no-op。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, effectScope, nextTick, ref, type EffectScope, type Ref } from 'vue';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';

vi.mock('element-plus', () => ({
  ElMessage: {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
}));

interface MappingItem {
  shelf_id: string;
  shelf_code: string;
  process_id: string;
  process_code: string;
}

/** 逐字复刻后端 `AllShelfProcessMappingItem`（注意：**没有** process_ids 子集，
 *  也**没有** sort_order —— 全集接口不返排序字段）。 */
const FLAT_MAPPINGS: MappingItem[] = [
  {
    shelf_id: '8800000000001',
    shelf_code: 'SH-P01',
    process_id: '190000000000001',
    process_code: 'CUT',
  },
  {
    shelf_id: '8800000000001',
    shelf_code: 'SH-P01',
    process_id: '190000000000002',
    process_code: 'WELD',
  },
  {
    shelf_id: '8800000000002',
    shelf_code: 'SH-P02',
    process_id: '190000000000002',
    process_code: 'WELD',
  },
];

// 元素声明成 Partial：让「故意缺字段」的 payload（守门用例 F6）无需 cast 就能喂进
// mock —— mock 的类型比真契约宽松，恰好模拟「后端漂移/漏返」这件事本身。
const getAllShelfProcessMappingsMock = vi.fn(
  async (): Promise<{ items: Array<Partial<MappingItem>> }> => ({ items: FLAT_MAPPINGS }),
);

vi.mock('@/api/shelves', () => ({
  getAllShelfProcessMappings: () => getAllShelfProcessMappingsMock(),
}));

import { useShelfProcessFilter } from '../useShelfProcessFilter';

interface Row {
  id: string;
  code: string;
}

const SHELVES: Row[] = [
  { id: '8800000000001', code: 'SH-P01' },
  { id: '8800000000002', code: 'SH-P02' },
  { id: '8800000000003', code: 'SH-P03' },
];
const PROCESSES: Row[] = [
  { id: '190000000000001', code: 'CUT' },
  { id: '190000000000002', code: 'WELD' },
  { id: '190000000000003', code: 'PAINT' },
];

type Filter = ReturnType<typeof useShelfProcessFilter<Row, Row>>;

let testApp: ReturnType<typeof createApp>;
let testQueryClient: QueryClient;
let scope: EffectScope;

/** 造一个 filter 实例（对外 API 与 10 个调用方看到的一致）。
 *  useQuery 内部 useQueryClient() 走 inject，必须在 app.runWithContext + effectScope
 *  内调（与 useProcessesQuery.spec.ts 同模式）。 */
function makeFilter(
  allShelves: Ref<Row[]>,
  allProcesses: Ref<Row[]>,
  shelfId: Ref<string | null>,
  processId: Ref<string | null>,
): Filter {
  let f!: Filter;
  scope.run(() => {
    f = testApp.runWithContext(() =>
      useShelfProcessFilter<Row, Row>(allShelves, allProcesses, shelfId, processId),
    );
  });
  return f;
}

/** 两个源都非空（闸门默认开）时的常规实例。 */
function makeFilterReady(shelfId: string | null, processId: string | null): Filter {
  return makeFilter(ref([...SHELVES]), ref([...PROCESSES]), ref(shelfId), ref(processId));
}

/** 等 query settle（闸门开着时必在几毫秒内成功）。 */
async function waitLoaded(f: Filter): Promise<void> {
  await vi.waitFor(() => {
    expect(f.loaded.value).toBe(true);
  });
}

beforeEach(() => {
  // clearAllMocks（含 vi.mock 工厂里造的 ElMessage 桩）—— 否则 F8 弹的 warning 会
  // 漏进 F10 的「不弹 toast」断言。clear 只清调用记录，implementation 保留，故下面
  // 紧跟一次 mockResolvedValue 重置默认响应。
  vi.clearAllMocks();
  getAllShelfProcessMappingsMock.mockResolvedValue({ items: FLAT_MAPPINGS });
  scope = effectScope();
  // queries.retry: 0 —— 与 src/main.ts 全局默认一致：守门抛错时不该被重试放大成
  // 多次请求 + 未处理 rejection。
  testQueryClient = new QueryClient({
    defaultOptions: { mutations: { retry: 0 }, queries: { retry: 0 } },
  });
  testApp = createApp({});
  testApp.use(VueQueryPlugin, { queryClient: testQueryClient });
});

afterEach(() => {
  scope.stop();
  testQueryClient.unmount();
  testApp = null as unknown as ReturnType<typeof createApp>;
  testQueryClient = null as unknown as QueryClient;
  vi.restoreAllMocks();
});

describe('useShelfProcessFilter — 扁平行 regroup（BUG-3 守卫，2026-10-02）', () => {
  it('F1：映射就绪后 processesForShelf 返回正确的 process 集合（不是空集）', async () => {
    const f = makeFilterReady(null, null);

    await waitLoaded(f);

    // 同一 shelf 的两行必须 regroup 成一个含 2 个 process_id 的 Set。
    // 读 item.process_ids 的旧实现下这里是空 Set ⇒ 断言失败。
    expect(f.processesForShelf('8800000000001')).toEqual(
      new Set(['190000000000001', '190000000000002']),
    );
    // 另一架只有一个映射。
    expect(f.processesForShelf('8800000000002')).toEqual(new Set(['190000000000002']));
    // 空映射的货架没有条目 → null（沿既有语义，不进 mapping）。
    expect(f.processesForShelf('8800000000003')).toBeNull();
    expect(f.processesForShelf(null)).toBeNull();
  });

  it('F2：选了货架 → filteredProcesses 非空且只含该架映射的工序', async () => {
    const f = makeFilterReady('8800000000001', null);

    await waitLoaded(f);

    // 旧实现：空集 ⇒ [] ⇒ 8 个页面的工序下拉被静默清空。
    expect(f.filteredProcesses.value.map((p) => p.id)).toEqual([
      '190000000000001',
      '190000000000002',
    ]);
  });

  it('F3：选了工序 → filteredShelves 非空且只含映射了该工序的货架', async () => {
    const f = makeFilterReady(null, '190000000000002');

    await waitLoaded(f);

    // 旧实现：mapping 全空集 ⇒ [] ⇒ 货架下拉被静默清空。
    expect(f.filteredShelves.value.map((s) => s.id)).toEqual(['8800000000001', '8800000000002']);
  });
});

describe('useShelfProcessFilter — enabled 闸门（2026-10-02 Phase C 新增行为）', () => {
  it('F4：两个下拉源都为空 → 一个请求都不发，兜底返回全量', async () => {
    const f = makeFilter(ref<Row[]>([]), ref<Row[]>([]), ref('8800000000001'), ref(null));

    // 闸门关着：等若干轮事件循环（够 query 若被误触发就会发出去）后仍应是 0 次
    await new Promise((r) => setTimeout(r, 20));
    await nextTick();

    expect(getAllShelfProcessMappingsMock).not.toHaveBeenCalled();
    expect(f.loaded.value).toBe(false);
    expect(f.loading.value).toBe(false);
    // 兜底语义不变：两个下拉都给全量
    expect(f.filteredProcesses.value).toHaveLength(0);
    expect(f.filteredShelves.value).toHaveLength(0);
  });

  it('F5：只有 shelves 非空（processes 还空）→ 仍不发；等 processes 就位后自动开闸拉取', async () => {
    const shelves = ref<Row[]>([...SHELVES]);
    const processes = ref<Row[]>([]);
    const f = makeFilter(shelves, processes, ref('8800000000001'), ref(null));

    // 半就绪态：闸门要求**两个**源都非空（各调用点旧代码都是在
    // Promise.all([listShelves, listProcesses]) 之后才 load()，见 composable 注释）
    await new Promise((r) => setTimeout(r, 20));
    expect(getAllShelfProcessMappingsMock).not.toHaveBeenCalled();
    expect(f.loaded.value).toBe(false);
    // 兜底：processes 还没到，全量就是空数组；不选 process 时货架也给全量
    expect(f.filteredShelves.value).toHaveLength(SHELVES.length);

    // processes 就位 → 闸门开 → 自动拉一次（不再需要任何显式 load() 调用）
    processes.value = [...PROCESSES];
    await waitLoaded(f);

    expect(getAllShelfProcessMappingsMock).toHaveBeenCalledTimes(1);
    expect(f.filteredProcesses.value.map((p) => p.id)).toEqual([
      '190000000000001',
      '190000000000002',
    ]);
  });
});

describe('useShelfProcessFilter — 失败 / 守门兜底', () => {
  it('F6（Zod 守门守卫）：响应缺 shelf_code → 映射整体不生效，走全量兜底', async () => {
    // 这是本轮迁移的核心交付物：此前裸 async load() 零守门，契约漂移（如 BUG-3 那样）
    // 只能靠人眼在 UI 上看到空白下拉才定位得到。现在 queryFn 里的
    // shelfProcessMappingsResultSchema.parse 会把漂移变成 query error 态 ⇒
    // loaded 保持 false ⇒ filteredXxx 全量兜底（**不会**拿半截数据去过滤）。
    getAllShelfProcessMappingsMock.mockResolvedValue({
      // 故意漏掉 shelf_code —— 后端若改名 / 漏返就长这样
      items: [{ shelf_id: '8800000000001', process_id: '190000000000001' }],
    });
    const f = makeFilterReady('8800000000001', null);

    // 等 query 落定（成功或失败都算落定）：这里必然是失败
    await vi.waitFor(() => {
      expect(getAllShelfProcessMappingsMock).toHaveBeenCalled();
    });
    await new Promise((r) => setTimeout(r, 20));

    expect(f.loaded.value).toBe(false);
    // 守门失败 ⇒ 不过滤（宁可全量也不半截）
    expect(f.filteredProcesses.value).toHaveLength(PROCESSES.length);
    expect(f.processesForShelf('8800000000001')).toBeNull();
  });

  it('F7：网络失败 → loaded 保持 false，兜底返回全量（不做半截过滤）', async () => {
    getAllShelfProcessMappingsMock.mockRejectedValue(new Error('boom'));
    const f = makeFilterReady('8800000000001', null);

    await vi.waitFor(() => {
      expect(getAllShelfProcessMappingsMock).toHaveBeenCalled();
    });
    await new Promise((r) => setTimeout(r, 20));

    expect(f.loaded.value).toBe(false);
    expect(f.loading.value).toBe(false);
    expect(f.filteredProcesses.value).toHaveLength(PROCESSES.length);
    expect(f.processesForShelf('8800000000001')).toBeNull();
  });
});

describe('useShelfProcessFilter — 双向 watch 行为不变', () => {
  it('F8：选了当前货架不支持的工序会清空货架 + warning', async () => {
    const { ElMessage } = await import('element-plus');
    const shelfId = ref<string | null>('8800000000002');
    const processId = ref<string | null>(null);
    const f = makeFilter(ref([...SHELVES]), ref([...PROCESSES]), shelfId, processId);
    await waitLoaded(f);

    // SH-P02 只映射 WELD（190000000000002），选 CUT 应触发清空货架 + warning。
    // watch 默认 flush: 'pre'，回调排进 scheduler 队列 → nextTick 后才跑。
    processId.value = '190000000000001';
    await nextTick();

    expect(shelfId.value).toBeNull();
    expect(ElMessage.warning).toHaveBeenCalledWith('已清空货架选择：当前货架不支持该工序');
    expect(f).toBeDefined();
  });

  it('F9：反选兼容的工序对 —— 两个方向都不清空', async () => {
    const shelfId = ref<string | null>('8800000000001');
    const processId = ref<string | null>(null);
    const f = makeFilter(ref([...SHELVES]), ref([...PROCESSES]), shelfId, processId);
    await waitLoaded(f);

    // SH-P01 映射 CUT + WELD，选 CUT 兼容。
    processId.value = '190000000000001';
    await nextTick();

    expect(shelfId.value).toBe('8800000000001');
    expect(processId.value).toBe('190000000000001');
    expect(f.filteredShelves.value.map((s) => s.id)).toEqual(['8800000000001']);
  });

  it('F10：选了新货架但当前工序不在它的映射里 → 静默清空工序（不弹 toast）', async () => {
    const { ElMessage } = await import('element-plus');
    const shelfId = ref<string | null>('8800000000001');
    const processId = ref<string | null>('190000000000001');
    makeFilter(ref([...SHELVES]), ref([...PROCESSES]), shelfId, processId);

    await vi.waitFor(() => {
      expect(getAllShelfProcessMappingsMock).toHaveBeenCalled();
    });
    await new Promise((r) => setTimeout(r, 20));

    // SH-P02 只映射 WELD，切过去后 CUT 必须被清掉，且**不**触发 warning
    shelfId.value = '8800000000002';
    await nextTick();

    expect(processId.value).toBeNull();
    expect(ElMessage.warning).not.toHaveBeenCalled();
  });
});
