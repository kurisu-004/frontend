// src/views/parts/composables/__tests__/usePartsListQuery.locationsHolderIds.spec.ts
//
// 2026-09-17 PR-4 新增：usePartsListQuery `locations` + `holder_ids` 过滤参数契约单测。
//
// 覆盖（与后端 PartListQuery 契约对齐）：
// - 默认态：locations / holder_ids 都为空数组 → 不发送到后端（empty=全部）
// - 仅选 locations 大类（如 PRODUCTION_SHELF） → 发送 locations，holder_ids 不发送
// - 仅选 holder_ids（货架/工人/外协公司雪花 ID 字符串） → 发送 holder_ids，locations 不发送
// - 同时选 locations + holder_ids → 同时发送两组参数（OR 关系）
// - 雪花 ID 字符串：Number() 丢精度风险已禁；测试断言值原样为 string
//
// 测试策略：
// - vi.mock('@/api/parts')：listParts 替换为 vi.fn()，捕获入参；其它函数 stub。
// - 不调 listParts 真实路径（axios 未 mock，但 listParts 是 mock 函数不会发请求）。
// - usePartsListQuery 内部通过 dynamic import '@/api/parts' 拉 listParts，vi.mock
//   factory 注册时只导出 listParts；dynamic import 走 vi.mock 解析。
//
// 与现有 usePartsListStore.spec.ts 风格一致，但只覆盖 locations/holder_ids 维度，
// 不重复 store 装配 + 批量选择流（store spec 已覆盖）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ListPartsParams } from '@/api/parts';

const listPartsMock = vi.fn<
  (
    params: ListPartsParams,
  ) => Promise<{ items: unknown[]; total: number; limit: number; offset: number }>
>(async () => ({ items: [], total: 0, limit: 20, offset: 0 }));

/** 取 listParts 首次调用的入参；vi.fn 元组类型推导过窄时通过 unknown 中转。 */
function firstParams(): ListPartsParams {
  const call = listPartsMock.mock.calls[0];
  return call[0] as unknown as ListPartsParams;
}

vi.mock('@/api/parts', () => ({
  listParts: (params: ListPartsParams) => listPartsMock(params),
}));

// 避免 useListFilterPersist 在 node 环境访问不到 localStorage 时炸（jest 环境无 window）。
// 兜底为 noop。
vi.mock('@/composables/useListFilterPersist', () => ({
  useListFilterPersist: () => ({
    restore: () => null,
    snapshot: () => undefined,
    clear: () => undefined,
  }),
}));

// ElMessage stub：usePartsListQuery 的 fetchList catch 走 ElMessage.error。
vi.mock('element-plus', () => ({
  ElMessage: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

import { usePartsListQuery } from '../usePartsListQuery';

describe('usePartsListQuery — locations / holder_ids 过滤参数契约（PR-4 2026-09-17）', () => {
  beforeEach(() => {
    listPartsMock.mockClear();
    listPartsMock.mockResolvedValue({ items: [], total: 0, limit: 20, offset: 0 });
    try {
      localStorage.clear();
    } catch {
      // node 环境 / 不可用时忽略
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // 用例 1：默认态（locations=[] + holderIds=[]）→ 两组参数都不设置（undefined）
  // —— buildParams 用「空数组 → undefined」约定；cleanParams 在 listParts 入口 strip undefined。
  it('默认态：空数组 → locations / holder_ids 均为 undefined（cleanParams 后不发）', async () => {
    const q = usePartsListQuery({ isCncProgrammer: false });
    expect(q.search.locations).toEqual([]);
    expect(q.search.holderIds).toEqual([]);

    await q.fetchList();

    expect(listPartsMock).toHaveBeenCalledTimes(1);
    const params = firstParams();
    expect(params.locations).toBeUndefined();
    expect(params.holder_ids).toBeUndefined();
  });

  // 用例 2：仅选 locations 大类 → locations 设置为数组，holder_ids 仍 undefined
  it('仅选 locations 大类 → 仅设置 locations', async () => {
    const q = usePartsListQuery({ isCncProgrammer: false });
    q.search.locations = ['PRODUCTION_SHELF'];

    await q.fetchList();

    const params = firstParams();
    expect(params.locations).toEqual(['PRODUCTION_SHELF']);
    expect(params.holder_ids).toBeUndefined();
  });

  // 用例 3：仅选 holder_ids（多个雪花 ID 字符串） → 仅设置 holder_ids，locations 仍 undefined
  it('仅选 holder_ids（多选雪花 ID 字符串）→ 仅设置 holder_ids', async () => {
    const q = usePartsListQuery({ isCncProgrammer: false });
    // 雪花 ID 字符串（CLAUDE.md §3）：禁止 Number() 转换。
    q.search.holderIds = ['1700000000000000001', '1700000000000000002'];

    await q.fetchList();

    const params = firstParams();
    expect(params.holder_ids).toEqual(['1700000000000000001', '1700000000000000002']);
    // 断言值仍是字符串（防 Number() 误转回归）
    expect(typeof params.holder_ids?.[0]).toBe('string');
    expect(typeof params.holder_ids?.[1]).toBe('string');
    expect(params.locations).toBeUndefined();
  });

  // 用例 4：同时选 locations + holder_ids → 两组参数同时设置（OR 关系，由后端 PartListQuery 解析）
  it('同时选 locations + holder_ids → 两组参数同时设置（后端按 OR 关系解析）', async () => {
    const q = usePartsListQuery({ isCncProgrammer: false });
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
    const q = usePartsListQuery({ isCncProgrammer: false });
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
    const q = usePartsListQuery({ isCncProgrammer: false });
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
});
