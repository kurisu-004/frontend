// src/composables/__tests__/useShelfProcessFilter.spec.ts
//
// 2026-10-02 新增：BUG-3 的直接回归守卫。
//
// 背景：`GET /prod/shelf-processes`（全集）返回**扁平行**（一行一个 (货架, 工序) 对，
// 同一 shelf_id 多行），而旧实现按 v1(Python) 的「一架子集一行」读
// `item.process_ids` —— 该字段恒 undefined → `new Set(undefined)` = 空集 →
// 同一 shelf 的多行互相覆盖成空集 → `loaded=true` 之后 filteredProcesses /
// filteredShelves 把候选池**全过滤**掉，8 个调用点（inspection 待办 / outsource
// 收货 / 待编程一览 / 零件下发 / 零件详情 2 处 / 返修启动）的货架 / 工序下拉
// 全被静默清空，且不报任何错。
//
// 为什么这个 bug 能活这么久：唯一同域测试 usePendingProgrammingStore.spec.ts 把
// **前端的错误形态**复刻进了 mock（`{items: []}`），bug 对测试完全隐形。本文件的
// mock 逐字复刻后端 `AllShelfProcessMappingOut`，专门用来钉死「多行同 shelf 必须
// regroup 成一个 process 集合」。
//
// 断言策略：每个用例都写成「BUG 存在时必失败」的形态 —— 旧实现下
// processesForShelf 返回空 Set、filteredProcesses / filteredShelves 返回空数组。
//
// element-plus：CLAUDE.md 架构条目 §9 —— ElMessage 在 vitest node env 会因内部
// normalizeAppendTo 触发 `ReferenceError: document is not defined`，必须桩成 no-op。

import { describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';

vi.mock('element-plus', () => ({
  ElMessage: {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
}));

/** 逐字复刻后端 `AllShelfProcessMappingItem`（注意：**没有** process_ids 子集，
 *  也**没有** sort_order —— 全集接口不返排序字段）。 */
const FLAT_MAPPINGS = [
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

const getAllShelfProcessMappingsMock = vi.fn(async () => ({ items: FLAT_MAPPINGS }));

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

/** 造一个已选好货架 / 工序的 filter 实例（对外 API 与 8 个调用方看到的一致）。 */
function makeFilter(shelfId: string | null, processId: string | null) {
  return useShelfProcessFilter<Row, Row>(
    ref(SHELVES),
    ref(PROCESSES),
    ref(shelfId),
    ref(processId),
  );
}

describe('2026-10-02：useShelfProcessFilter 读扁平行映射（BUG-3 守卫）', () => {
  it('F1：load() 后 processesForShelf 返回正确的 process 集合（不是空集）', async () => {
    const f = makeFilter(null, null);

    await f.load();

    expect(f.loaded.value).toBe(true);
    // 同一 shelf 的两行必须 regroup 成一个含 2 个 process_id 的 Set。
    // 旧实现下这里是空 Set ⇒ 断言失败。
    expect(f.processesForShelf('8800000000001')).toEqual(
      new Set(['190000000000001', '190000000000002']),
    );
    // 另一架只有一个映射。
    expect(f.processesForShelf('8800000000002')).toEqual(new Set(['190000000000002']));
    // 空映射的货架没有条目 → null（沿既有语义，不进 mapping）。
    expect(f.processesForShelf('8800000000003')).toBeNull();
    expect(f.processesForShelf(null)).toBeNull();
  });

  it('F2：选了货架 → filteredProcesses 非空且只含该架映射的工序（BUG-3 直接 guard）', async () => {
    const f = makeFilter('8800000000001', null);

    await f.load();

    // 旧实现：空集 ⇒ [] ⇒ 8 个页面的工序下拉被静默清空。
    expect(f.filteredProcesses.value.map((p) => p.id)).toEqual([
      '190000000000001',
      '190000000000002',
    ]);
  });

  it('F3：选了工序 → filteredShelves 非空且只含映射了该工序的货架（BUG-3 直接 guard）', async () => {
    const f = makeFilter(null, '190000000000002');

    await f.load();

    // 旧实现：mapping 全空集 ⇒ [] ⇒ 货架下拉被静默清空。
    expect(f.filteredShelves.value.map((s) => s.id)).toEqual(['8800000000001', '8800000000002']);
  });

  it('F4：load 之前不过滤（loaded=false → 返回全量兜底）', () => {
    const f = makeFilter('8800000000001', '190000000000002');

    expect(f.loaded.value).toBe(false);
    expect(f.filteredProcesses.value).toHaveLength(PROCESSES.length);
    expect(f.filteredShelves.value).toHaveLength(SHELVES.length);
  });

  it('F5：后端失败 → loaded 保持 false，兜底返回全量（不做半截过滤）', async () => {
    const f = makeFilter('8800000000001', null);
    getAllShelfProcessMappingsMock.mockRejectedValueOnce(new Error('boom'));

    await f.load();

    expect(f.loaded.value).toBe(false);
    expect(f.loading.value).toBe(false);
    expect(f.filteredProcesses.value).toHaveLength(PROCESSES.length);
    expect(f.processesForShelf('8800000000001')).toBeNull();
  });

  it('F6：双向 watch 仍生效 —— 选了该架不支持的工序会清空货架 + warning', async () => {
    const { ElMessage } = await import('element-plus');
    const shelfId = ref<string | null>('8800000000002');
    const processId = ref<string | null>(null);
    const f = useShelfProcessFilter<Row, Row>(ref(SHELVES), ref(PROCESSES), shelfId, processId);
    await f.load();

    // SH-P02 只映射 WELD（190000000000002），选 CUT 应触发清空货架 + warning。
    // watch 默认 flush: 'pre'，回调排进 scheduler 队列 → nextTick 后才跑。
    processId.value = '190000000000001';
    await nextTick();

    expect(shelfId.value).toBeNull();
    expect(ElMessage.warning).toHaveBeenCalledWith('已清空货架选择：当前货架不支持该工序');
  });

  it('F7：反选兼容的工序对 —— 两个方向都不清空', async () => {
    const shelfId = ref<string | null>('8800000000001');
    const processId = ref<string | null>(null);
    const f = useShelfProcessFilter<Row, Row>(ref(SHELVES), ref(PROCESSES), shelfId, processId);
    await f.load();

    // SH-P01 映射 CUT + WELD，选 CUT 兼容。
    processId.value = '190000000000001';
    await nextTick();

    expect(shelfId.value).toBe('8800000000001');
    expect(processId.value).toBe('190000000000001');
    expect(f.filteredShelves.value.map((s) => s.id)).toEqual(['8800000000001']);
  });
});
