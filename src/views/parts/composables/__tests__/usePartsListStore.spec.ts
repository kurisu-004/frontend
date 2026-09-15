// src/views/parts/composables/__tests__/usePartsListStore.spec.ts
//
// 2026-09-15 新增：usePartsListStore Pinia setup store 单测（vitest node 环境）。
//
// 测试策略：
// - mock @/api/parts：listParts 返 2 行 + 调 vi.fn 充当 spy；其余函数 stub。
// - mock @/components/ColumnFilterPopover.vue：.vue 文件不进 transform 链，需 stub。
// - 每个用例前 setActivePinia(createPinia()) —— store 必须在 pinia active 时调用。
// - 未登录态（user=null）下 canEdit === false，price 列被 gate，columnDefs.length === 16。
//   登录 mock 通过 useAuthSession.user.value 注入；本 spec 默认跑未登录态，断言 columnDefs.length === 16。
// - spy table getter：vi.fn 注册 clearSelection / toggleRowSelection，用以验证批量选择流。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

// 2026-09-15：mock 必须在 import store 之前；vi.mock 顶层 hoist。
vi.mock('@/api/parts', () => ({
  listParts: vi.fn(async () => ({
    items: [
      {
        id: '1',
        row_type: 'PART',
        status: 'IN_PROCESS',
        serial_no: 'SN1',
        drawing_no: 'D1',
        name: '零件 1',
        quantity: 1,
        unit_price: 10,
        is_urgent: false,
      },
      {
        id: '2',
        row_type: 'PART',
        status: 'PENDING',
        serial_no: 'SN2',
        drawing_no: 'D2',
        name: '零件 2',
        quantity: 2,
        unit_price: 20,
        is_urgent: false,
      },
    ],
    total: 2,
  })),
  updatePart: vi.fn(),
  placeOnShelf: vi.fn(),
  recallToPending: vi.fn(),
  recallToProgramming: vi.fn(),
  sendToProgramming: vi.fn(),
  printPartDrawingBatch: vi.fn(async () => new Blob()),
  getPartLocationTree: vi.fn(async () => ({ items: [] })),
}));

// vitest 无 vue 插件，.vue 文件不能进 transform 链 —— factory stub 后该文件不会被加载。
vi.mock('@/components/ColumnFilterPopover.vue', () => ({
  default: { name: 'ColumnFilterPopoverStub' },
}));

import { usePartsListStore } from '../usePartsListStore';
import type { PartListItem } from '@/types/parts';

function makeRow(id: string, status = 'IN_PROCESS'): PartListItem {
  const row = {
    id,
    row_type: 'PART',
    status,
    serial_no: `SN${id}`,
    drawing_no: `D${id}`,
    name: `零件 ${id}`,
    quantity: 1,
    unit_price: 10,
    is_urgent: false,
  };
  return row as PartListItem;
}

describe('usePartsListStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    // 2026-09-15：清掉 localStorage 残留，避免 useListFilterPersist 拿到旧快照污染用例。
    try {
      localStorage.clear();
    } catch {
      // node 环境 / 不可用时忽略
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // 用例 1：装配完整性 + 未登录态 columnDefs.length === 16（9 base + 7 tail，price gate）
  it('assembles six slices + canEdit/isCncProgrammer/columnVisibility/columnDefs', () => {
    const store = usePartsListStore();
    // 六切片
    expect(store.query).toBeDefined();
    expect(store.filters).toBeDefined();
    expect(store.edit).toBeDefined();
    expect(store.batch).toBeDefined();
    expect(store.print).toBeDefined();
    expect(store.dispatch).toBeDefined();
    // 视图级权限 / 配置
    expect(typeof store.canEdit).toBe('boolean');
    expect(typeof store.isCncProgrammer).toBe('boolean');
    expect(store.columnVisibility).toBeDefined();
    expect(Array.isArray(store.columnDefs)).toBe(true);
    // 未登录态：canEdit === false → price 列 gate → 16 列（9 base + 7 tail）
    expect(store.canEdit).toBe(false);
    expect(store.columnDefs.length).toBe(16);
    // registerTableGetter 存在（getTable 是 store 内部闭包，不导出）
    expect(typeof store.registerTableGetter).toBe('function');
  });

  // 用例 2：嵌套解包 —— store.batch.batchMode 直接是 boolean（不是 Ref）
  it('unwraps nested refs: batchMode is a plain boolean under store proxy', () => {
    const store = usePartsListStore();
    expect(store.batch.batchMode).toBe(false);
    store.batch.onEnterBatchMode();
    expect(store.batch.batchMode).toBe(true);
    // 代理 set 写回 ref.value
    store.batch.batchMode = false;
    expect(store.batch.batchMode).toBe(false);
  });

  // 用例 3：批量选择流 —— registerTableGetter spy → onEnterBatchMode clearSelection 被调
  //         → onSelectionChange 加 1 行 → selectedIds.size === 1 / batchSelectedPartCount === 1
  //         → onExitBatchMode 清空
  it('batch selection flow with spy table getter', () => {
    const store = usePartsListStore();
    const clearSelection = vi.fn();
    const toggleRowSelection = vi.fn();
    store.registerTableGetter(() => ({
      clearSelection,
      toggleRowSelection,
    }));

    store.batch.onEnterBatchMode();
    expect(clearSelection).toHaveBeenCalledTimes(1);
    expect(store.batch.batchMode).toBe(true);
    expect(store.batch.selectedIds.size).toBe(0);

    const row = makeRow('1', 'PENDING');
    // PENDING + PART 才能在 dispatch 模式可勾选；这里 batchAction=print，走全可选路径。
    store.batch.onSelectionChange([row]);
    expect(store.batch.selectedIds.size).toBe(1);
    expect(store.batch.batchSelectedPartCount).toBe(1);
    expect(toggleRowSelection).not.toHaveBeenCalled(); // selection-change 不直接调 toggle

    store.batch.onExitBatchMode();
    expect(clearSelection).toHaveBeenCalledTimes(2); // onEnter + onExit 各一次
    expect(store.batch.batchMode).toBe(false);
    expect(store.batch.selectedIds.size).toBe(0);
  });

  // 用例 4：未注册 table 时空值守卫 —— onClearSelection 不抛错
  it('does not throw when table getter is not registered', () => {
    const store = usePartsListStore();
    // 不调 registerTableGetter，直接调 onClearSelection —— getTable() 返 null 应安全降级
    expect(() => store.batch.onClearSelection()).not.toThrow();
    expect(() => store.dispatch.onDispatch(makeRow('1'))).not.toThrow();
  });

  // 用例 5：fetchList 联动 —— items.length === 2 / total === 2；batchMode 下不炸
  it('fetchList updates items and total; batch mode restore path does not throw', async () => {
    const store = usePartsListStore();
    const clearSelection = vi.fn();
    const toggleRowSelection = vi.fn();
    store.registerTableGetter(() => ({ clearSelection, toggleRowSelection }));

    await store.query.fetchList();
    expect(store.query.items.length).toBe(2);
    expect(store.query.total).toBe(2);

    // 进入批量模式再 fetch —— 走 registerAfterFetch → restoreTableSelection 不应炸
    store.batch.onEnterBatchMode();
    await store.query.fetchList();
    expect(store.query.items.length).toBe(2);
    // restoreTableSelection nextTick 后调 clearSelection（store 同步路径上至少 1 次）
    expect(clearSelection).toHaveBeenCalled();
  });

  // 用例 6：$dispose 重建 —— 改 batchMode + 加选中 → $dispose → 重新 usePartsListStore → fresh 状态
  it('$dispose rebuilds store with fresh state', async () => {
    const store1 = usePartsListStore();
    store1.batch.onEnterBatchMode();
    const row = makeRow('1', 'PENDING');
    store1.batch.onSelectionChange([row]);
    expect(store1.batch.batchMode).toBe(true);
    expect(store1.batch.selectedIds.size).toBe(1);

    store1.$dispose();

    const store2 = usePartsListStore();
    expect(store2.batch.batchMode).toBe(false);
    expect(store2.batch.selectedIds.size).toBe(0);
  });
});
