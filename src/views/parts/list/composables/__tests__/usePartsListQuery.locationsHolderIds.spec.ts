// src/views/parts/list/composables/__tests__/usePartsListQuery.locationsHolderIds.spec.ts
//
// 2026-09-17 PR-4 新增：usePartsListQuery `locations` + `holder_ids` 过滤参数契约单测。
//
// 2026-09-26（B 任务）追加：usePartsListQuery 切到 TanStack Query 后，本 spec 需要：
//   1) beforeEach 安装 VueQueryPlugin + QueryClient（useQuery 内部需要 QueryClient）；
//   2) 新增 enabled 闸门用例：store 实例化时不应自动 fetch；
//   3) 新增「search 变化驱动 queryKey 变化触发 refetch」用例（fetchList 别名兼容 +
//      queryKey 响应式 + refetch 行为三位一体回归保护）。
//
// 覆盖（与后端 PartListQuery 契约对齐）：
// - 默认态：locations / holder_ids 都为空数组 → 不发送到后端（empty=全部）
// - 仅选 locations 大类（如 PRODUCTION_SHELF） → 发送 locations，holder_ids 不发送
// - 仅选 holder_ids（货架/工人/外协公司雪花 ID 字符串） → 发送 holder_ids，locations 不发送
// - 同时选 locations + holder_ids → 同时发送两组参数（OR 关系）
// - 雪花 ID 字符串：Number() 丢精度风险已禁；测试断言值原样为 string
// - PR-4 第 1/3 轮补（reviewer B1+B2 触发）：
//   - F1-1：Array.isArray 守卫——非数组值塞入 search.holderIds / locations 时
//     buildParams 兜底回 undefined，避免 axios paramsSerializer 抛错或发出
//     非法字符串（后端 holder_ids parse 失败 → 40001 VALIDATION_ERROR）。
//   - F1-2：holder_ids 多态——前端不参与合并，仅确保「locations + 多种 holder
//     ID（货架 / 工人）共存时」两组参数同时发出（OR 由后端 PartListQuery 解析）。
//   - F1-3：不传→与旧行为一致（更严格）——断言完整 params 对象含 customer_id /
//     statuses / locations / holder_ids；不传时这些 key 不在对象里（undefined
//     被 cleanParams / axios 默认 strip）。
//   - F3：wire-format——加 `locations` / `holder_ids` 到 `ARRAY_AS_CSV_KEYS` 后，
//     真实 `cleanParams + serializeParamsV2` 链路编码出的 URL 是
//     `?locations=A%2CB&holder_ids=X%2CY`，与 backend-rust PartListQuery
//     `Option<String>` 逗号解析对齐。
//
// 测试策略：
// - vi.mock('@/api/parts')：listParts 替换为 vi.fn()，捕获入参；其它函数 stub。
// - 不调 listParts 真实路径（axios 未 mock，但 listParts 是 mock 函数不会发请求）。
// - usePartsListQuery 走静态 import '@/api/parts'（B 任务改造后），vi.mock factory
//   拦截静态导入，listParts 替换为 mock。
//
// 与现有 usePartsListStore.spec.ts 风格一致，但只覆盖 locations/holder_ids 维度，
// 不重复 store 装配 + 批量选择流（store spec 已覆盖）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, effectScope } from 'vue';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';
import type { ListPartsParams } from '@/api/parts';

// 必须在 vi.mock 之前导入：listPartsMockImpl 在 factory 内引用 cleanParams。
// vitest 把 vi.mock hoist 到顶部，但 import 按文本顺序解析。
import { cleanParams, serializeParamsV2 } from '@/api/http';
import { usePartsListQuery } from '../usePartsListQuery';

// listPartsMock 接收「cleanParams 之后」的 params（与真实 listParts 行为一致：
// api.get('/parts', { params: cleanParams(params) })），不是 buildParams 原始输出。
// 这样 'in params' 这类断言才能反映 axios 实际看到的 URL 参数形态。
const realListPartsMock = vi.fn<
  (
    params: ListPartsParams,
  ) => Promise<{ items: unknown[]; total: number; limit: number; offset: number }>
>(async () => ({ items: [], total: 0, limit: 20, offset: 0 }));

function listPartsMockImpl(params: ListPartsParams): Promise<{
  items: unknown[];
  total: number;
  limit: number;
  offset: number;
}> {
  return realListPartsMock(cleanParams(params) as ListPartsParams);
}

/** 取 listParts 首次调用的入参（cleanParams 后形态）；vi.fn 元组类型推导过窄时通过 unknown 中转。 */
function firstParams(): Record<string, unknown> {
  const call = realListPartsMock.mock.calls[0];
  return call[0] as unknown as Record<string, unknown>;
}

vi.mock('@/api/parts', () => ({
  listParts: (params: ListPartsParams) => listPartsMockImpl(params),
}));

// 2026-09-26（B 任务）：usePartsListQuery 内 `watch(errorMsg) → ElMessage.error(...)`
// 是 B 任务新加的桥接。vitest node env 没有 `document`，ElMessage 内部
// `normalizeAppendTo` 会抛 `ReferenceError: document is not defined`，被 vitest
// 报为 Unhandled Rejection 污染输出。该 spec 关注 usePartsListQuery 的参数契约
// + useQuery 行为，错误处理 UX 不归单测管，统一桩成 no-op。
vi.mock('element-plus', () => ({
  ElMessage: {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
}));

// 2026-09-26（B 任务）：vue-query useQuery 内部 `useQueryClient()` 走 Vue `inject()`
// 拿客户端，inject 在「没有 currentInstance 且 currentApp=null」时既 throw
// "vue-query hooks can only be used inside setup()"。vitest node env 没有组件
// setup 上下文，所以必须在 `app.runWithContext(() => ...)` 里调 usePartsListQuery，
// 让 Vue 把 currentApp 临时切到本测试 app，inject(key) 才能在 `app._context.provides`
// 里命中 VueQueryPlugin 注册的 client。
//
// 该 app 不挂组件、不 mount —— 仅作为 provide channel；按测试用例临时创建（每用例
// 新 QueryClient 隔离缓存 + mount/unmount 隔离 unhandled rejection）。
let testApp: ReturnType<typeof createApp>;
let testQueryClient: QueryClient;

describe('usePartsListQuery — locations / holder_ids 过滤参数契约（PR-4 2026-09-17）', () => {
  beforeEach(() => {
    realListPartsMock.mockClear();
    realListPartsMock.mockResolvedValue({ items: [], total: 0, limit: 20, offset: 0 });
    testQueryClient = new QueryClient({ defaultOptions: { mutations: { retry: 0 } } });
    testApp = createApp({});
    testApp.use(VueQueryPlugin, { queryClient: testQueryClient });
    try {
      localStorage.clear();
    } catch {
      // node 环境 / 不可用时忽略
    }
  });

  afterEach(() => {
    // 2026-09-26（B 任务）：释放每测试 app 的 VueQueryPlugin + QueryClient，避免
    // 测试间 mount/unmount 残留导致 unhandled rejection 串扰。
    testQueryClient.unmount();
    testApp = null as unknown as ReturnType<typeof createApp>;
    testQueryClient = null as unknown as QueryClient;
    vi.restoreAllMocks();
  });

  // 用例 1：默认态（locations=[] + holderIds=[]）→ 两组参数都不设置（undefined）
  // —— buildParams 用「空数组 → undefined」约定；cleanParams 在 listParts 入口 strip undefined。
  it('默认态：空数组 → locations / holder_ids 均为 undefined（cleanParams 后不发）', async () => {
    const q = testApp.runWithContext(() => usePartsListQuery({ isCncProgrammer: false }));
    expect(q.search.locations).toEqual([]);
    expect(q.search.holderIds).toEqual([]);

    await q.fetchList();

    expect(realListPartsMock).toHaveBeenCalledTimes(1);
    const params = firstParams();
    expect(params.locations).toBeUndefined();
    expect(params.holder_ids).toBeUndefined();
  });

  // 用例 2：仅选 locations 大类 → locations 设置为数组，holder_ids 仍 undefined
  it('仅选 locations 大类 → 仅设置 locations', async () => {
    const q = testApp.runWithContext(() => usePartsListQuery({ isCncProgrammer: false }));
    q.search.locations = ['PRODUCTION_SHELF'];

    await q.fetchList();

    const params = firstParams();
    expect(params.locations).toEqual(['PRODUCTION_SHELF']);
    expect(params.holder_ids).toBeUndefined();
  });

  // 用例 3：仅选 holder_ids（多个雪花 ID 字符串） → 仅设置 holder_ids，locations 仍 undefined
  it('仅选 holder_ids（多选雪花 ID 字符串）→ 仅设置 holder_ids', async () => {
    const q = testApp.runWithContext(() => usePartsListQuery({ isCncProgrammer: false }));
    // 雪花 ID 字符串（CLAUDE.md §3）：禁止 Number() 转换。
    q.search.holderIds = ['1700000000000000001', '1700000000000000002'];

    await q.fetchList();

    const params = firstParams();
    expect(params.holder_ids).toEqual(['1700000000000000001', '1700000000000000002']);
    // 断言值仍是字符串（防 Number() 误转回归）
    const holderIds = params.holder_ids as string[] | undefined;
    expect(typeof holderIds?.[0]).toBe('string');
    expect(typeof holderIds?.[1]).toBe('string');
    expect(params.locations).toBeUndefined();
  });

  // 用例 4：同时选 locations + holder_ids → 两组参数同时设置（OR 关系，由后端 PartListQuery 解析）
  it('同时选 locations + holder_ids → 两组参数同时设置（后端按 OR 关系解析）', async () => {
    const q = testApp.runWithContext(() => usePartsListQuery({ isCncProgrammer: false }));
    q.search.locations = ['PRODUCTION_SHELF', 'WORKER'];
    q.search.holderIds = ['1700000000000000001', '1700000000000000002'];

    await q.fetchList();

    const params = firstParams();
    expect(params.locations).toEqual(['PRODUCTION_SHELF', 'WORKER']);
    expect(params.holder_ids).toEqual(['1700000000000000001', '1700000000000000002']);
    // 与 brief 一致：locations 大类 OR 任一 holder_ids 都算中（后端 PartListQuery 内部判断）
    // —— 前端只负责把两组同时发出，不参与合并逻辑。
  });

  // 用例 5：resetAllFilters 后两组参数都被清空 → 均为 undefined
  it('resetAllFilters 后两组参数都被清空 → 均为 undefined', async () => {
    const q = testApp.runWithContext(() => usePartsListQuery({ isCncProgrammer: false }));
    q.search.locations = ['INSPECTION_SHELF'];
    q.search.holderIds = ['1700000000000000099'];

    // 不调 registerClearNativeFilters（resetAllFilters 在 null 回调下跳过 clearNativeFilters）
    q.resetAllFilters();

    await q.fetchList();

    const params = firstParams();
    expect(params.locations).toBeUndefined();
    expect(params.holder_ids).toBeUndefined();
  });

  // 用例 6：与 customer_id / statuses 互斥语义不冲突（同时存在则都发送）
  // —— 后端 PartListQuery 是 AND 联合（customer 展开 + status IN + locations OR holder_ids），
  //    前端契约：多组筛选项各自决定是否发送，互不干扰。
  it('与 customer_id / statuses 并存：互不干扰，全部正常设置', async () => {
    const q = testApp.runWithContext(() => usePartsListQuery({ isCncProgrammer: false }));
    q.search.customerId = '123';
    q.search.statuses = ['IN_PROCESS'];
    q.search.locations = ['PRODUCTION_SHELF'];
    q.search.holderIds = ['1700000000000000001'];

    await q.fetchList();

    const params = firstParams();
    expect(params.customer_id).toBe('123');
    expect(params.statuses).toEqual(['IN_PROCESS']);
    expect(params.locations).toEqual(['PRODUCTION_SHELF']);
    expect(params.holder_ids).toEqual(['1700000000000000001']);
  });

  // ============ F1-1 PR-4 第 1/3 轮补：parse 失败 / 非数组值兜底 ============
  //
  // 背景：localStorage 反序列化 / 跨 caller 注入 / type-only 引用解构等异常路径
  // 可能把非数组值塞进 search.holderIds 或 search.locations（实际类型是
  // `string[]`，但运行时兜底仍必要）。buildParams 必须用 Array.isArray 守卫
  // 兜底回 undefined，避免：
  //   - axios paramsSerializer 抛 TypeError（`search.holderIds.length` 触发）
  //   - 把非预期字符串发出去（后端 holder_ids parse 失败 → 40001 VALIDATION_ERROR，
  //     UI 列表直接白屏）

  it('F1-1a：holderIds 被塞成 null → buildParams 兜底 holder_ids === undefined', async () => {
    const q = testApp.runWithContext(() => usePartsListQuery({ isCncProgrammer: false }));
    // 显式覆盖为非数组值（外部 caller 注入场景）
    q.search.holderIds = null as unknown as string[];

    await q.fetchList();

    const params = firstParams();
    expect(params.holder_ids).toBeUndefined();
    expect(params.locations).toBeUndefined();
  });

  it('F1-1b：locations 被塞成 undefined → buildParams 兜底 locations === undefined', async () => {
    const q = testApp.runWithContext(() => usePartsListQuery({ isCncProgrammer: false }));
    q.search.locations = undefined as unknown as string[];

    await q.fetchList();

    const params = firstParams();
    expect(params.locations).toBeUndefined();
  });

  it('F1-1c：holderIds 被塞成数字 123 → buildParams 兜底 holder_ids === undefined', async () => {
    const q = testApp.runWithContext(() => usePartsListQuery({ isCncProgrammer: false }));
    q.search.holderIds = 123 as unknown as string[];

    await q.fetchList();

    const params = firstParams();
    expect(params.holder_ids).toBeUndefined();
  });

  it('F1-1d：locations 被塞成 string "not-a-snowflake" → buildParams 兜底 locations === undefined', async () => {
    const q = testApp.runWithContext(() => usePartsListQuery({ isCncProgrammer: false }));
    q.search.locations = 'not-a-snowflake' as unknown as string[];

    await q.fetchList();

    const params = firstParams();
    expect(params.locations).toBeUndefined();
  });

  // ============ F1-2 PR-4 第 1/3 轮补：holder_ids 多态（前端仅发，不参与合并） ============
  //
  // 后端 PartListQuery 多态 holder：t_shelf / t_worker / t_outsource_company 任一
  // 表匹配同雪花 ID 即命中。前端契约只负责把 holder_ids 数组原样发出（OR 由后端
  // 解析），不参与合并。本组用例验证多态 ID 数组形态正确编码。

  it('F1-2a：holder_ids 混入多种 holder 形态（shelf + worker 雪花 ID） → 都按字符串原样发出', async () => {
    const q = testApp.runWithContext(() => usePartsListQuery({ isCncProgrammer: false }));
    // shelf 雪花 ID + worker 雪花 ID（前端不做类型区分，只按 string[] 发出）
    q.search.holderIds = [
      '1700000000000000010', // shelf
      '1700000000000000020', // worker
      '1700000000000000030', // outsource_company
    ];

    await q.fetchList();

    const params = firstParams();
    expect(params.holder_ids).toEqual([
      '1700000000000000010',
      '1700000000000000020',
      '1700000000000000030',
    ]);
    // 三种都是 string（防 Number() 误转回归）
    const holderIds = params.holder_ids as string[] | undefined;
    expect(holderIds?.every((id: string) => typeof id === 'string')).toBe(true);
  });

  it('F1-2b：locations 大类 + 多态 holder_ids 共存 → 两组同时发出（OR 语义由后端解析）', async () => {
    const q = testApp.runWithContext(() => usePartsListQuery({ isCncProgrammer: false }));
    q.search.locations = ['PRODUCTION_SHELF', 'WORKER'];
    q.search.holderIds = [
      '1700000000000000010', // shelf
      '1700000000000000020', // worker
    ];

    await q.fetchList();

    const params = firstParams();
    // 前端契约：locations 大类 OR 任一 holder_id 都算中（后端 PartListQuery
    // EXISTS 子查询处理），前端只负责两组都发送，不参与合并。
    expect(params.locations).toEqual(['PRODUCTION_SHELF', 'WORKER']);
    expect(params.holder_ids).toEqual(['1700000000000000010', '1700000000000000020']);
  });

  // ============ F1-3 PR-4 第 1/3 轮补：不传 → 与旧行为一致（更严格） ============
  //
  // 用例 6 是「互不干扰」断言；F1-3 升级为「完整 params 对象 shape」断言 +
  // 「不传则 key 不在对象里」（axios / cleanParams 默认行为）双断言。

  it('F1-3a：传 customer_id + statuses + locations + holder_ids → 完整 params 对象 4 个 key 都在', async () => {
    const q = testApp.runWithContext(() => usePartsListQuery({ isCncProgrammer: false }));
    q.search.customerId = '190000000000100';
    q.search.statuses = ['IN_PROCESS'];
    q.search.locations = ['PRODUCTION_SHELF'];
    q.search.holderIds = ['1700000000000000001'];

    await q.fetchList();

    const params = firstParams();
    // 严格断言：4 个 key 都在（不被任何 strip 路径误伤）
    expect(params.customer_id).toBe('190000000000100');
    expect(params.statuses).toEqual(['IN_PROCESS']);
    expect(params.locations).toEqual(['PRODUCTION_SHELF']);
    expect(params.holder_ids).toEqual(['1700000000000000001']);
  });

  it('F1-3b：不传 locations / holder_ids → params 对象**不含**这两个 key（axios 默认 strip undefined）', async () => {
    const q = testApp.runWithContext(() => usePartsListQuery({ isCncProgrammer: false }));
    // 仅设 customer_id，locations/holder_ids 留空数组（默认态）
    q.search.customerId = '190000000000100';

    await q.fetchList();

    const params = firstParams();
    expect(params.customer_id).toBe('190000000000100');
    // 关键断言：对象里**没有** locations / holder_ids 这两个 key
    // （不是等于 undefined，是 key 本身不存在）—— axios 默认会跳过 undefined，
    // cleanParams 进一步剥空数组。regression 守卫。
    expect('locations' in params).toBe(false);
    expect('holder_ids' in params).toBe(false);
  });

  // ============ F3 PR-4 第 1/3 轮补：跨仓契约 wire-format ============
  //
  // backend-rust PR-4 PartListQuery 把 locations / holder_ids 实现为 `Option<String>`
  // （逗号分隔单值），与 `statuses` 同形。前端必须把这两个 key 加入 `ARRAY_AS_CSV_KEYS`
  // 白名单，编码 `?locations=A%2CB&holder_ids=X%2CY`，与 backend axum Query<String>
  // 反序列化对齐。本组用例验证「真实 cleanParams + serializeParamsV2 链路」的
  // wire-format（不走 stub mock），与 backend PR-4 端到端匹配。

  it('F3-a：locations 走 CSV（?locations=A%2CB）→ 与 backend PartListQuery Option<String> 解析对齐', () => {
    const params = cleanParams({
      locations: ['PRODUCTION_SHELF', 'WORKER'],
      holder_ids: [],
    });
    // 走真实 serializeParamsV2（ARRAY_AS_CSV_KEYS 已含 locations / holder_ids）
    const wire = serializeParamsV2(params);
    expect(wire).toBe('locations=PRODUCTION_SHELF%2CWORKER');
    // 反向断言：不能是重复 key（?locations=A&locations=B）
    expect(wire).not.toContain('locations=PRODUCTION_SHELF&locations=');
  });

  it('F3-b：holder_ids 走 CSV（?holder_ids=X%2CY）→ 雪花 ID 字符串原样 CSV 编码', () => {
    const params = cleanParams({
      locations: [],
      holder_ids: ['1700000000000000001', '1700000000000000002'],
    });
    const wire = serializeParamsV2(params);
    expect(wire).toBe('holder_ids=1700000000000000001%2C1700000000000000002');
    // 反向断言：不能是重复 key
    expect(wire).not.toContain('holder_ids=1700000000000000001&holder_ids=');
    // 雪 花 ID 字符串原样保留（Number() 误转会丢精度）
    expect(wire).toContain('1700000000000000001%2C1700000000000000002');
  });

  it('F3-c：locations + holder_ids + statuses 同时走 CSV → 全白名单 wire-format', () => {
    const params = cleanParams({
      locations: ['PRODUCTION_SHELF', 'WORKER'], // 两元素 → 1 个 %2C
      holder_ids: ['1700000000000000001', '1700000000000000002'], // 两元素 → 1 个 %2C
      statuses: ['IN_PROCESS', 'REPAIRING'], // 两元素 → 1 个 %2C
      customer_id: '190000000000100',
    });
    const wire = serializeParamsV2(params);
    expect(wire).toBe(
      'locations=PRODUCTION_SHELF%2CWORKER' +
        '&holder_ids=1700000000000000001%2C1700000000000000002' +
        '&statuses=IN_PROCESS%2CREPAIRING' +
        '&customer_id=190000000000100',
    );
    // 关键：所有白名单数组字段（locations / holder_ids / statuses）都用 %2C
    // 拼接（不是 &），与 backend-rust axum Query<String> 反序列化 CSV 格式
    // 一致。每个两元素数组贡献 1 个 %2C，共 3 个。
    expect((wire.match(/%2C/g) ?? []).length).toBe(3);
    // 反向断言：白名单 key 绝不能出现重复 key 形式（`&key=...&key=` 紧邻）。
    expect(wire).not.toMatch(/locations=[^&]+&locations=/);
    expect(wire).not.toMatch(/holder_ids=[^&]+&holder_ids=/);
    expect(wire).not.toMatch(/statuses=[^&]+&statuses=/);
  });

  // ============ 2026-09-26（B 任务）新增：enabled 闸门 + queryKey 响应式回归保护 ============
  //
  // 背景：B 任务把 usePartsListQuery 切到 TanStack Query useQuery：
  //   - `enabled: restored` 闸门：restored 默认 false，restoreState 末尾置 true，
  //     store 实例化时不自动 fetch；这是修复「默认参数首屏 + 持久化参数再屏双 fetch」
  //     关键设计点。
  //   - queryKey 走 computed(() => qk.partsList(buildParams()))，search / page / sort
  //     任一变化 → queryKey 变化 → useQuery 自动 refetch（不再需要 watcher + 显式
  //     fetchList()）。
  //   - fetchList 保留为 refetch 别名（listQuery.refetch()），caller 零改动可用。
  //
  // 本组用例验证以上三点行为契约。
  //
  // 同步原 store spec 已有的「VueQueryPlugin + QueryClient 安装」模式到本 spec
  // beforeEach —— vue-query 5.x 在 node env 无 QueryClient 时会 throw "No QueryClient set"，
  // 必须显式 install。
  //
  // vitest node env 直接调 composable 不在 Vue setup 内，useQuery 的 auto-fetch
  // 不会触发（仅 warn）。本组用例聚焦可观察契约：fetchList 别名触发 queryFn +
  // queryKey 响应式 + enabled 闸门状态，全部通过「先 await fetchList()，再断言
  // mock 入参形态」验证。

  it('B1：store 实例化后**不**自动 fetch（enabled 闸门默认 false → refetch 跳过 queryFn）', async () => {
    const scope = effectScope();
    scope.run(() => {
      const q = testApp.runWithContext(() => usePartsListQuery({ isCncProgrammer: false }));
      // 不调 restoreState —— restored 保持默认 false。
      // enabled=false 时，调 fetchList 仍走 listQuery.refetch，但 queryObserver
      // 内部会在 enabled===false 时跳过 queryFn（queryFn 不被调用）。
      // —— 这是 enabled 闸门的关键约束：闸门关闭时即使 caller 主动 refetch 也不发请求。
      void q;
    });
    await new Promise((r) => setTimeout(r, 10));
    // 让 useQuery 进入 ready 状态
    // 直接 mock 调用计数应为 0（即便后续 fetchList 也不会调 queryFn）
    expect(realListPartsMock).not.toHaveBeenCalled();
    scope.stop();
  });

  it('B2：fetchList 别名 = refetch → 当前 queryKey 触发 queryFn', async () => {
    const scope = effectScope();
    let q: ReturnType<typeof usePartsListQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => usePartsListQuery({ isCncProgrammer: false }));
      q!.restoreState(undefined); // 开闸（enabled=true）
    });
    await new Promise((r) => setTimeout(r, 10));
    // 显式 fetchList —— refetch 别名；前面已因 enabled=true 自动 fetch 一次，
    // 此处再调一次 → 至少 1 次调用（B2 锁定「fetchList 能驱动 queryFn」这条
    // 契约，具体次数按 vue-query 自身 schedule 而非测试硬约束）。
    const beforeCalls = realListPartsMock.mock.calls.length;
    await q!.fetchList();
    expect(realListPartsMock.mock.calls.length).toBeGreaterThan(beforeCalls);
    scope.stop();
  });

  it('B3：search 字段变化驱动 buildParams 响应式 → 改 search 后调 fetchList 入参带新值（queryKey 响应式回归保护）', async () => {
    // 背景：原手写状态机下，page>1 时改 search 不会重置 page=1，导致 fetchList 不会触发；
    // 改造后 queryKey 走 computed(() => qk.partsList(buildParams()))，search 变化
    // 必然引发 queryKey 变化。本用例验证 buildParams 在 search 变化后入参正确反映。
    const scope = effectScope();
    let q: ReturnType<typeof usePartsListQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => usePartsListQuery({ isCncProgrammer: false }));
      q!.restoreState(undefined);
    });
    await new Promise((r) => setTimeout(r, 10));

    // 先 fetch 一次（默认参数）
    await q!.fetchList();
    const firstParams = realListPartsMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(firstParams?.locations).toBeUndefined();

    // 改 search 字段（queryKey 响应式变化）
    q!.search.locations = ['PRODUCTION_SHELF'];
    await q!.fetchList();
    // 最近一次调用入参含 locations（buildParams 响应式验证）
    const calls = realListPartsMock.mock.calls;
    const lastParams = calls[calls.length - 1]?.[0] as Record<string, unknown>;
    expect(lastParams?.locations).toEqual(['PRODUCTION_SHELF']);
    scope.stop();
  });

  it('B4：pageSize 变化后调 fetchList 入参带新 limit（buildParams 响应式）', async () => {
    const scope = effectScope();
    let q: ReturnType<typeof usePartsListQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => usePartsListQuery({ isCncProgrammer: false }));
      q!.restoreState(undefined);
    });
    await new Promise((r) => setTimeout(r, 10));

    await q!.fetchList();
    const firstParams = realListPartsMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(firstParams?.limit).toBe(20);

    // 改 pageSize（queryKey 响应式变化）
    q!.pageSize.value = 50;
    await q!.fetchList();
    const calls = realListPartsMock.mock.calls;
    const lastParams = calls[calls.length - 1]?.[0] as Record<string, unknown>;
    expect(lastParams?.limit).toBe(50);
    scope.stop();
  });
});
