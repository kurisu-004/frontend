// src/views/parts/list/composables/__tests__/usePartsListStore.spec.ts
//
// 2026-09-15 新增：usePartsListStore Pinia setup store 单测（vitest node 环境）。
//
// 测试策略：
// - mock @/api/parts：listParts 返 2 行 + 调 vi.fn 充当 spy；其余函数 stub。
// - mock @/components/ColumnFilterPopover.vue：.vue 文件不进 transform 链，需 stub。
// - 每个用例前 setActivePinia(createPinia()) —— store 必须在 pinia active 时调用。
// - 未登录态（user=null）下 canEdit === false，price 列被 gate，columnDefs.length === 15。
//   （2026-09-27 前后端字段对齐：移除「下一道工序」列 → 17 - 1 = 16；未登录态再
//   减去 2 个 price 列 = 14 → 实际再扣 columnVisibility gate 后稳态是 15。断言按
//   columnDefs.length === 15 验证）。
// - 登录 mock 通过 useAuthStore().$patch({ user: ... }) 注入（2026-09-26：从 useAuthSession
//   切到 useAuthStore）；本 spec 默认跑未登录态，断言 columnDefs.length === 15。
// - spy table getter：vi.fn 注册 clearSelection / toggleRowSelection，用以验证批量选择流。
// - 2026-09-26：usePartsListStore 现在依赖 useAuthStore，后者内含 useMutation。需要注册
//   VueQueryPlugin + QueryClient（mutation observer 需要）；否则会抛 "No QueryClient set"。
//
// 2026-09-27 前后端字段对齐：mock 数据改为后端 PartListOut 真实形态 ——
//   - parent_customer_name → l1_customer_name（重命名）；
//   - 删 customer_path / next_process_id / next_process_name（list 响应不返）；
//   - unit_price / total_price：number → string（rust_decimal 序列化对齐）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';

// 2026-09-15：mock 必须在 import store 之前；vi.mock 顶层 hoist。
// 2026-09-26（B 任务）：返回 schema 合规 PartListResult（含 limit/offset），让
// partListResultSchema.parse 通过，避免 ZodError 触发 watch(errorMsg) →
// ElMessage.error → document is not defined。
vi.mock('@/api/parts', () => ({
  listParts: vi.fn(async () => ({
    items: [
      {
        id: '1',
        version: 1,
        row_type: 'PART',
        status: 'IN_PROCESS',
        serial_no: 'SN1',
        drawing_no: 'D1',
        name: '零件 1',
        applicant_name: null,
        quantity: 1,
        unit_price: '10.00',
        total_price: '10.00',
        request_date: '2026-01-01',
        planned_delivery_date: '2026-02-01',
        order_no: null,
        system_delivery_date: null,
        note: null,
        customer_name: null,
        l1_customer_name: null,
        location: null,
        is_urgent: false,
        // 2026-09-29：partSchema 新增 has_cnc_program 必填字段，mock 必须带
        has_cnc_program: false,
      },
      {
        id: '2',
        version: 1,
        row_type: 'PART',
        status: 'PENDING',
        serial_no: 'SN2',
        drawing_no: 'D2',
        name: '零件 2',
        applicant_name: null,
        quantity: 2,
        unit_price: '20.00',
        total_price: '40.00',
        request_date: '2026-01-02',
        planned_delivery_date: '2026-02-02',
        order_no: null,
        system_delivery_date: null,
        note: null,
        customer_name: null,
        l1_customer_name: null,
        location: null,
        is_urgent: false,
        // 2026-09-29：partSchema 新增 has_cnc_program 必填字段
        has_cnc_program: false,
      },
    ],
    total: 2,
    limit: 20,
    offset: 0,
  })),
  updatePart: vi.fn(),
  placeOnShelf: vi.fn(),
  recallToPending: vi.fn(),
  printPartDrawingBatch: vi.fn(async () => new Blob()),
  getPartLocationTree: vi.fn(async () => ({ items: [] })),
}));

// 2026-09-26：mock @/api/iam 让 useAuthStore.loginMutation 在测试里跑得通。
// 该 spec 只断言 parts 切片能力，不调 login mutation，所以 mock 简单返回即可。
vi.mock('@/api/iam', () => ({
  login: vi.fn(),
  logout: vi.fn(),
  me: vi.fn(),
}));

// 2026-09-26：mock @/api/customer 让 useCustomersQuery（useCustomerTree 内部）
// 走成功路径，避免 axios 在 node env 网络请求失败触发 watch → ElMessage.error
// → document is not defined 的 Unhandled Rejection（vitest 不算 fail 但污染
// 输出，且未来 strict 模式可能 fail）。该 spec 只断言 parts 切片能力，不依赖
// customer 数据，mock 返回空数组够用。
vi.mock('@/api/customer', () => ({
  listCustomers: vi.fn(async () => ({ items: [], total: 0, limit: 20, offset: 0 })),
  getCustomer: vi.fn(),
  createCustomer: vi.fn(),
  updateCustomer: vi.fn(),
  softDeleteCustomer: vi.fn(),
}));

// vitest 无 vue 插件，.vue 文件不能进 transform 链 —— factory stub 后该文件不会被加载。
vi.mock('@/components/ColumnFilterPopover.vue', () => ({
  default: { name: 'ColumnFilterPopoverStub' },
}));

// 2026-09-26（B 任务）：usePartsListQuery 内 `watch(errorMsg) → ElMessage.error(...)`
// 是 B 任务新加的桥接（B 任务改 useQuery 后把 ElMessage 从原 fetchList catch 迁移过来）。
// vitest node env 没有 `document`，ElMessage 内部 `normalizeAppendTo` 会抛
// `ReferenceError: document is not defined`，被 vitest 报为 Unhandled Rejection
// 污染输出。该 spec 关注 store 切片装配 + 批量选择 + 列定义，单测不验证 ElMessage
// 行为（那是组件层职责），统一桩成 no-op。错误链路的语义覆盖走各用例内 spy +
// assert，未被掩盖。
vi.mock('element-plus', () => ({
  ElMessage: {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
}));

import { createApp } from 'vue';
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
    unit_price: '10.00',
    is_urgent: false,
  };
  return row as PartListItem;
}

describe('usePartsListStore', () => {
  beforeEach(() => {
    // 2026-09-26：usePartsListStore 现在调 useAuthStore() 拿角色；auth store 内
    // useMutation 需要 QueryClient。这里用 createApp 注册 Pinia + VueQueryPlugin，
    // 然后 setActivePinia 到该 app 的 pinia，确保后续 useAuthStore() 命中这里。
    const app = createApp({});
    app.use(createPinia());
    app.use(VueQueryPlugin, {
      queryClient: new QueryClient({ defaultOptions: { mutations: { retry: 0 } } }),
    });
    setActivePinia(app.config.globalProperties.$pinia);
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

  // 用例 1：装配完整性 + 未登录态 columnDefs.length === 15
  //（2026-09-27 前后端字段对齐：移除「下一道工序」列 → 17 - 1 = 16；
  // 未登录态 canEdit=false 减去 2 个 price 列 = 14 → 但 baseColumnDefs 9 + tailColumnDefs
  // 7（删 next_process 后剩 6），故 9 + 0 + 6 = 15）。
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
    // 未登录态：canEdit === false → price 列 gate → 15 列（9 base + 6 tail）
    expect(store.canEdit).toBe(false);
    expect(store.columnDefs.length).toBe(15);
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

  // 2026-09-26（B 任务）新增：enabled 闸门 —— store 实例化时不应自动 fetch。
  // 这是修复「默认参数首屏 + 持久化参数再屏双 fetch」关键设计点的回归保护。
  it('store 实例化后**不**自动 fetch（enabled 闸门），调 fetchList 后才 fetch', async () => {
    // 重置 listPartsMock —— beforeEach 已经 setup 但 spec 内 listParts 是 import mock
    const { listParts } = await import('@/api/parts');
    const listPartsMock = listParts as unknown as { mock: { calls: unknown[] } };
    const beforeCalls = listPartsMock.mock.calls.length;

    const store = usePartsListStore();
    // 不调 restoreState —— restored 保持默认 false。
    // 等几个微任务循环（确保 useQuery scheduler 跑过 mount + enabled check）
    await new Promise((r) => setTimeout(r, 20));
    // store 实例化后 listParts 未被自动调（enabled 闸门关闭）
    expect(listPartsMock.mock.calls.length).toBe(beforeCalls);

    // 显式 fetchList —— 走 refetch 别名，会调 queryFn
    await store.query.fetchList();
    expect(listPartsMock.mock.calls.length).toBe(beforeCalls + 1);
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

  // ============ 2026-09-28 行类型合并：buildParams 契约 + Zod parse 守门 ============
  //
  // 背景：后端 modules/part/service/crud.rs::list_parts 真正合并后，GET /parts
  // 接受 `row_type` 与 `include_assemblies` 两参数，三模式合并返回 PartListItem[]，
  // total = parts_count + assemblies_count，不再携带 matched_children。前端 dropdown
  // (PartsList.vue:33-49) 切换 rowType 即生效，本组用例验证：
  //   - buildParams 在 ALL / PART / ASSEMBLY 三态下都正确发出两个新参数；
  //   - partSchema 能解析带 row_type='ASSEMBLY' 的装配件行（has_children / child_count
  //     等装配件专属字段合法；part 专属字段可空）；
  //   - partSchema 在缺失 row_type 时回退默认 'PART'（兼容 pending-programming 等
  //     旧端点）。

  // 复用 spec 顶部 vi.mock('@/api/parts') 的 listParts 实例；通过 import 拿到 mock。
  // mock listParts 不会真实走 axios（api/parts/crud.ts listParts 内部的
  // api.get → axios 才是真实网络出口），所以抓到的 mock.calls 是 buildParams 原始输出。
  // 注意：mock 不走 cleanParams，所以 row_type=undefined 会在 mock.calls 里看到；
  // 真实链路 axios 会 strip 它（最终 URL 不含 row_type）。

  it('buildParams emits row_type=undefined + include_assemblies=true when rowType="ALL"', async () => {
    const { listParts } = await import('@/api/parts');
    const listPartsMock = listParts as unknown as {
      mock: { calls: unknown[][] };
      mockClear: () => void;
    };
    listPartsMock.mockClear();

    const store = usePartsListStore();
    // 默认态 search.rowType === 'ALL'（initialPartsSearch）
    expect(store.query.search.rowType).toBe('ALL');

    await store.query.fetchList();

    expect(listPartsMock.mock.calls).toHaveLength(1);
    const params = listPartsMock.mock.calls[0]?.[0] as Record<string, unknown>;
    // buildParams 在 ALL 时把 row_type 显式置 undefined（cleanParams 后会被 strip，
    // 表示「后端默认 ALL 行为：合并装配件」）。
    expect(params.row_type).toBeUndefined();
    expect(params.include_assemblies).toBe(true);
  });

  it('buildParams sets row_type when rowType="PART" / "ASSEMBLY"', async () => {
    const { listParts } = await import('@/api/parts');
    const listPartsMock = listParts as unknown as {
      mock: { calls: unknown[][] };
      mockClear: () => void;
    };
    listPartsMock.mockClear();

    const store = usePartsListStore();

    // PART
    store.query.search.rowType = 'PART';
    await store.query.fetchList();
    let params = listPartsMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params.row_type).toBe('PART');
    expect(params.include_assemblies).toBe(true);

    // ASSEMBLY
    listPartsMock.mockClear();
    store.query.search.rowType = 'ASSEMBLY';
    await store.query.fetchList();
    params = listPartsMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params.row_type).toBe('ASSEMBLY');
    expect(params.include_assemblies).toBe(true);
  });

  it('partSchema.parse accepts assembly row (row_type="ASSEMBLY", part-specific fields null)', async () => {
    // 装配件行：row_type=ASSEMBLY + has_children=true + child_count=3；part 专属字段
    // （location / holder_name / process_chain_id 等）全部 null —— 后端 modules/part/service/
    // crud.rs::list_parts 真正合并后，assembly 行就是这种稀疏形态（见 backend-rust
    // docs/api/parts.md）。
    const { partSchema } = await import('@/composables/queries/schemas');
    const row = {
      id: '190000000000099',
      version: 1,
      serial_no: null,
      name: '装配件甲',
      drawing_no: 'ASM-DWG-001',
      applicant_name: null,
      quantity: 1,
      unit_price: '0',
      total_price: '0',
      request_date: '2026-09-01',
      planned_delivery_date: '2026-09-30',
      is_urgent: false,
      status: 'PENDING',
      order_no: null,
      system_delivery_date: null,
      note: null,
      customer_name: null,
      l1_customer_name: null,
      location: null,
      holder_name: null,
      process_chain_id: null,
      row_type: 'ASSEMBLY',
      has_children: true,
      child_count: 3,
      created_at: '2026-09-28 10:00:00',
      // 2026-09-29 新增：partSchema 必填 has_cnc_program；装配件行同理（沿 chain 派生）
      has_cnc_program: false,
    };
    const parsed = partSchema.parse(row);
    expect(parsed.row_type).toBe('ASSEMBLY');
    expect(parsed.has_children).toBe(true);
    expect(parsed.child_count).toBe(3);
    // part 专属字段保持 null（schema 已声明为 nullable）
    expect(parsed.location).toBeNull();
    expect(parsed.holder_name).toBeNull();
    expect(parsed.process_chain_id).toBeNull();
  });

  it('partSchema.parse defaults row_type="PART" when field missing (legacy /parts/pending-programming shape)', async () => {
    // 兼容 2026-09-28 之前 GET /parts/pending-programming 等不返 row_type 的旧端点。
    // 后端真正合并后，list_parts 始终返 row_type='PART' | 'ASSEMBLY'；但 pending-programming
    // 等保留端点不返。schema 用 .default('PART') 兜底。
    const { partSchema } = await import('@/composables/queries/schemas');
    // 注意：故意不传 row_type；location 等 nullable 字段以 null 显式声明（zod
    // 默认 strip 模式 + nullable 字段必须显式带 key，参见 schemas.spec.ts S14）。
    const parsed = partSchema.parse({
      id: '190000000000100',
      version: 1,
      serial_no: 'SN-X',
      name: 'X',
      drawing_no: 'D-X',
      applicant_name: null,
      quantity: 1,
      unit_price: '0',
      total_price: '0',
      request_date: '2026-09-01',
      planned_delivery_date: '2026-09-30',
      is_urgent: false,
      status: 'PENDING',
      order_no: null,
      system_delivery_date: null,
      note: null,
      customer_name: null,
      l1_customer_name: null,
      location: null,
      // 2026-09-29 新增：has_cnc_program 是必填字段，mock 必须带；旧 fixtures 仍可写 false（未编程状态）
      has_cnc_program: false,
      // row_type: 故意缺
    });
    expect(parsed.row_type).toBe('PART');
  });
});
