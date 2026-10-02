// src/views/outsource/composables/__tests__/useOutsourceReceivingList.spec.ts
//
// 2026-10-03 新增：「待接收」tab 的 receivingFetcher 契约守卫。
//
// 这条 fetcher 曾经是线上故障 ③（外协发送/接收两 tab 全空白）的**直接原因**：
// 后端把 `GET /outsource-shipments/in-flight` 的出参从裸数组改成分页信封
// `{items, total, limit, offset}`（旧 `/parts/outsource-in-flight` 返的通用零件列表
// `PartListItem` 与外协专用 VO 完全不同构），而 fetcher 仍写
// `const items = await listOutsourceInFlight(...); return { items, total: items.length }`
// —— `items.length` 是 undefined ⇒ el-table 收到非数组 ⇒ **静默空白**（不报错），
// 分页 total 也恒 undefined。
//
// 本文件锁两件事：① 分页信封被正确拆开（items / total 各归各位）；② 空列表不炸。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';

// node env 下真实 ElMessage 会因 `document is not defined` 污染输出（CLAUDE.md 约定）。
vi.mock('element-plus', () => ({
  ElMessage: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

const listOutsourceInFlightMock = vi.fn();

vi.mock('@/api/outsource', () => ({
  listOutsourceInFlight: (...args: unknown[]) => listOutsourceInFlightMock(...args),
}));

vi.mock('@/api/parts', () => ({
  receiveFromOutsource: vi.fn(),
  receiveFromOutsourceToInspection: vi.fn(),
}));

// useConfirm 走 ElMessageBox（要真 DOM）；useListStatePersist 走 pinia（useAuthStore）；
// useShelfProcessFilter 走 TanStack Query。都与本文件断言的 fetcher 无关，整模块桩掉，
// 让用例只跑「fetcher + API」这一条线。
vi.mock('@/composables/useConfirm', () => ({
  useConfirm: () => ({ dangerous: vi.fn(async () => true) }),
}));

vi.mock('@/composables/useListFilterPersist', () => ({
  useListStatePersist: () => ({ restore: () => null, snapshot: vi.fn(), clear: vi.fn() }),
}));

vi.mock('@/composables/useShelfProcessFilter', () => ({
  useShelfProcessFilter: (
    _shelves: unknown,
    _processes: unknown,
    shelf: unknown,
    process: unknown,
  ) => ({
    filteredShelves: shelf,
    filteredProcesses: process,
  }),
}));

import { useOutsourceReceivingList } from '../useOutsourceReceivingList';

/** 造一个最小可用的 composable 实例（只关心 fetcher，不关心 dialog / 派生量）。 */
function makeInstance() {
  return useOutsourceReceivingList({
    shelves: ref([]),
    processes: ref([]),
  });
}

/** 一条合法的 OutsourceInFlightItem。 */
function inFlightRow(overrides: Record<string, unknown> = {}) {
  return {
    part_id: 'P1',
    batch_id: 'BA1',
    batch_no: 1,
    quantity: 8,
    serial_no: 'SN-1',
    drawing_no: 'DWG-1',
    name: '零件甲',
    is_urgent: false,
    customer_path: '一级/二级',
    next_process_id: 'PR1',
    next_process_name: '外协工序',
    outsource_company_id: 'C1',
    outsource_company_name: '外协厂',
    sent_at: '2026-10-01T08:00:00',
    version: 4,
    ...overrides,
  };
}

beforeEach(() => {
  listOutsourceInFlightMock.mockReset();
});

describe('receivingFetcher：分页信封被正确拆开', () => {
  it('R1：返回 { items, total }，而不是把整个信封当 items', async () => {
    const rows = [inFlightRow(), inFlightRow({ batch_id: 'BA2', batch_no: 2 })];
    // 后端 total 是**全量**命中数（≠ 当前页长度）—— 这正是旧实现
    // `total: items.length` 把分页打坏的地方。
    listOutsourceInFlightMock.mockResolvedValue({ items: rows, total: 137, limit: 20, offset: 0 });

    const inst = makeInstance();
    const r = await inst.receivingFetcher({ page: 1, pageSize: 20 });

    expect(r.items).toHaveLength(2);
    expect(r.total).toBe(137);
    // 反断言：信封键不得泄漏成「行」
    expect(r.items[0]).not.toHaveProperty('total');
    expect(r.items[0]).not.toHaveProperty('limit');
    expect(r.items[0]).not.toHaveProperty('offset');
  });

  it('R2：后端返回空列表 → { items: [], total: 0 }（不炸、不返回 undefined）', async () => {
    listOutsourceInFlightMock.mockResolvedValue({ items: [], total: 0, limit: 20, offset: 0 });

    const inst = makeInstance();
    const r = await inst.receivingFetcher({ page: 1, pageSize: 20 });

    expect(r.items).toEqual([]);
    expect(r.total).toBe(0);
    expect(Array.isArray(r.items)).toBe(true);
    expect(inst.receivingError.value).toBeNull();
  });

  it('R3：分页参数按 page / pageSize 换算成 limit / offset', async () => {
    listOutsourceInFlightMock.mockResolvedValue({ items: [], total: 0, limit: 10, offset: 30 });

    const inst = makeInstance();
    await inst.receivingFetcher({ page: 4, pageSize: 10 });

    expect(listOutsourceInFlightMock).toHaveBeenCalledWith({
      keyword: undefined,
      limit: 10,
      offset: 30,
    });
  });

  // 后端 5xx / 契约漂移时：表格退化成空表 + 记错误文案，**不**把异常抛给
  // PagedTable（否则整页 unmount 报错，且用户看不到「加载失败」）。
  it('R4：API 抛错 → { items: [], total: 0 } + receivingError 被写入', async () => {
    listOutsourceInFlightMock.mockRejectedValue(new Error('boom'));

    const inst = makeInstance();
    const r = await inst.receivingFetcher({ page: 1, pageSize: 20 });

    expect(r).toEqual({ items: [], total: 0 });
    expect(inst.receivingError.value).toBe('boom');
  });
});
