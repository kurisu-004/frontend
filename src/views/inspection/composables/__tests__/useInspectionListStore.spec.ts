// @vitest-environment happy-dom
// src/views/inspection/composables/__tests__/useInspectionListStore.spec.ts
//
// 2026-10-03 新增：待品检一览页 store 单测。覆盖 4 类回归点：
//
//  1. 4 不变量（首调 / 禁解构的解包访问 / $dispose 重建 / 不 import vue-router）
//     —— 后两条是可观测行为，前两条由「测试本身就是 setup 外首调 + 全部走
//     store.切片.字段 访问」保证；
//  2. `buildParams()` 的 7 维映射（三个 ILIKE 子串 + 客户 + 系统交期区间 + 排序 +
//     limit/offset），以及「空值 → undefined 不发参数」「雪花 ID 不 Number()」；
//  3. `onSortChange` 的 prop → InspectionSortKey 映射（含取消排序不改状态、
//     未知 prop 退化为 SYSTEM_DELIVERY_DATE）；
//  4. **enabled 闸门**：store 实例化不自动 fetch，`restoreState()` 之后才 fetch ——
//     「默认参数首屏 + 持久化参数再屏」双 fetch 的 regression guard。
//
// mock 策略：
//   - `vi.mock('element-plus')` 只桩 ElMessage（node env 下真实 ElMessage 走
//     normalizeAppendTo 会撞 `document is not defined`）；列定义用的 ElButton /
//     ElInput / ElDatePicker / ElTreeSelect 在本 spec 里**不被调用**（只读 columnDefs
//     的元数据），但 import 本身要能解析，故一并给最简桩。
//   - `vi.mock('@/api/parts')`：主查询 + 3 个写端点。
//   - `vi.mock('@/api/customer')` / `@/api/shelves` / `@/api/process`：共享基础数据层
//     （useCustomerTree → useCustomersQuery、useProductionShelvesQuery、useProcessesQuery）
//     在 store setup 里就会 fetch，不桩会走真实 axios 触发未处理 rejection。
//   - `.vue` 文件（ColumnFilterPopover）不进 vitest transform 链（vitest.config.ts 只
//     挂了 @vitejs/plugin-vue，但本仓 spec 惯例仍显式 stub），故 factory stub。
//   - 注册 VueQueryPlugin + QueryClient：store setup 首行 useQueryClient()，缺插件直接抛
//     "No QueryClient set"。
//
// 环境：happy-dom（文件头 pragma）—— restoreState 的持久化恢复用例要读写真实
// localStorage，node 环境没有该全局（仓内其它 node spec 只能把 localStorage 调用包在
// try/catch 里跳过断言）。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { createApp } from 'vue';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';

vi.mock('element-plus', () => ({
  ElMessage: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
  ElButton: { name: 'ElButtonStub', template: '<button><slot /></button>' },
  ElInput: { name: 'ElInputStub', template: '<input />' },
  ElDatePicker: { name: 'ElDatePickerStub', template: '<div />' },
  ElTreeSelect: { name: 'ElTreeSelectStub', template: '<div />' },
}));

vi.mock('@/components/ColumnFilterPopover.vue', () => ({
  default: { name: 'ColumnFilterPopoverStub', template: '<span><slot /></span>' },
}));

// ---------------------------------------------------------------- 待品检列表 api 桩
const listInspectionBatchesMock = vi.fn();
const toShipMock = vi.fn();
const toProcessMock = vi.fn();
const scanInspectMock = vi.fn();
const getPartBySerialMock = vi.fn();

vi.mock('@/api/parts', () => ({
  listInspectionBatches: (...args: unknown[]) => listInspectionBatchesMock(...args),
  toShip: (...args: unknown[]) => toShipMock(...args),
  toProcess: (...args: unknown[]) => toProcessMock(...args),
  scanInspect: (...args: unknown[]) => scanInspectMock(...args),
  getPartBySerial: (...args: unknown[]) => getPartBySerialMock(...args),
}));

// ---------------------------------------------------------------- 共享基础数据层桩
vi.mock('@/api/customer', () => ({
  listCustomers: vi.fn(async () => ({ items: [], total: 0, limit: 20, offset: 0 })),
  getCustomer: vi.fn(),
  createCustomer: vi.fn(),
  updateCustomer: vi.fn(),
  softDeleteCustomer: vi.fn(),
}));

const listShelvesMock = vi.fn(async (_params?: unknown) => ({
  items: [],
  total: 0,
  limit: 200,
  offset: 0,
}));
vi.mock('@/api/shelves', () => ({
  listShelves: (params: unknown) => listShelvesMock(params),
}));

const listProcessesMock = vi.fn(async (_params?: unknown) => ({
  items: [],
  total: 0,
  limit: 200,
  offset: 0,
}));
vi.mock('@/api/process', () => ({
  listProcesses: (params: unknown) => listProcessesMock(params),
}));

import { useInspectionListStore } from '../useInspectionListStore';
import { qk } from '@/composables/queries/keys';
import { INSPECTION_SORT_KEY_TO_PROP } from '@/types/inspection';
import type { InspectionQueueItem } from '@/api/parts';

/** 后端真实 wire 形态：total / limit / offset 是 serialize_i64 的 JSON **string**，
 *  item 恰 13 字段（inspectionQueueListItemSchema 是 .strict()，多一个键就抛）。 */
const ROW_A: InspectionQueueItem = {
  batch_id: '190000000000001',
  batch_no: 3,
  quantity: 10,
  version: 7,
  part_id: '190000000000101',
  serial_no: 'SN-A',
  drawing_no: 'DWG-A',
  name: '零件 A',
  system_delivery_date: '2026-10-20',
  is_urgent: true,
  customer_id: '9000000000001',
  customer_name: '二级客户',
  l1_customer_name: '一级客户',
};

const LIST_RESULT = {
  items: [ROW_A],
  total: '1',
  limit: '20',
  offset: '0',
};

/** 返回本用例用的 QueryClient —— 失效调用点要 spy 它的 invalidateQueries。 */
function setupApp(): QueryClient {
  const app = createApp({});
  app.use(createPinia());
  const queryClient = new QueryClient({
    // retry: 0 与 src/main.ts 的全局默认对齐 —— 不对齐的话查询失败会按 v5 默认重试 3 次
    // （指数退避），错误态几秒后才可见，「watch → ElMessage.error」用例就测不到。
    defaultOptions: { queries: { retry: 0 }, mutations: { retry: 0 } },
  });
  app.use(VueQueryPlugin, { queryClient });
  setActivePinia(app.config.globalProperties.$pinia);
  return queryClient;
}

/** 等 useQuery 的 scheduler 跑过一轮（与零件一览那份 spec 同款：20ms 微任务窗口）。 */
function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 20));
}

describe('useInspectionListStore', () => {
  let qc: QueryClient;
  beforeEach(() => {
    vi.clearAllMocks();
    qc = setupApp();
    listInspectionBatchesMock.mockResolvedValue(LIST_RESULT);
    try {
      localStorage.clear();
    } catch {
      // node 环境不可用时忽略
    }
  });

  // ============ 切片装配 + 消费侧解包（不变量 #1 / #3）============
  it('assembles 6 slices; nested refs unwrap through the store proxy (不变量 #3)', () => {
    const store = useInspectionListStore();
    expect(store.query).toBeDefined();
    expect(store.filters).toBeDefined();
    expect(store.mutations).toBeDefined();
    expect(store.options).toBeDefined();
    expect(store.columnDefs).toBeDefined();
    expect(store.columnVisibility).toBeDefined();
    // 深代理解包：page / pageSize / sortBy 是 number / 联合，不是 Ref。
    expect(store.query.page).toBe(1);
    expect(store.query.pageSize).toBe(20);
    expect(store.query.sortBy).toBe('SYSTEM_DELIVERY_DATE');
    expect(store.query.sortDir).toBe('ASC');
    expect(store.ui.autoRefresh).toBe(false);
    expect(store.mutations.passingBatchId).toBeNull();
    // 代理 set 写回 ref.value
    store.query.page = 3;
    expect(store.query.page).toBe(3);
    // 表头筛选的 draft / active 也走解包访问（不写 .value）
    expect(store.filters.serialNoFilter.visible).toBe(false);
    expect(store.filters.serialNoFilter.active).toBe(false);
  });

  // ============ 列定义契约：7 数据列 + 操作列 ============
  it('columnDefs = 7 数据列 + 1 操作列，label / sortable 与规格逐条对齐', () => {
    const store = useInspectionListStore();
    const defs = store.columnDefs;
    expect(defs.map((d) => d.key)).toEqual([
      'serial_no',
      'drawing_no',
      'name',
      'batch_no',
      'quantity',
      'system_delivery_date',
      'customer',
      'actions',
    ]);
    expect(defs.map((d) => d.label)).toEqual([
      '序列号',
      '图号',
      '名称',
      '批次',
      '数量',
      '系统交期',
      '客户',
      '操作',
    ]);
    // 7 个数据列全部服务端排序；操作列不参与排序且不可拖。
    for (const d of defs.slice(0, 7)) {
      expect(d.sortable).toBe('custom');
    }
    expect(defs[7]?.sortable).toBeUndefined();
    expect(defs[7]?.draggable).toBe(false);
    // 客户列的 prop 是 'customer'（不是数据字段），排序请求靠映射表换成 CUSTOMER_NAME。
    expect(defs[6]?.prop).toBe('customer');
    // 5 个表头筛选 popover：序列号 / 图号 / 名称 / 系统交期 / 客户。
    const withFilter = defs.filter((d) => d.headerRender).map((d) => d.key);
    expect(withFilter).toEqual([
      'serial_no',
      'drawing_no',
      'name',
      'system_delivery_date',
      'customer',
    ]);
    // 批次 / 数量两列 prop 直出（key 与数据字段对上）。
    expect(defs[3]?.prop).toBe('batch_no');
    expect(defs[4]?.prop).toBe('quantity');
  });

  // ============ buildParams 7 维映射 ============
  it('buildParams 把 search / 排序 / 分页映射成 7 维请求参数', async () => {
    const store = useInspectionListStore();
    store.query.search.drawingNo = '  DWG-1  ';
    store.query.search.name = '  零件  ';
    store.query.search.serialNo = '  SN-1  ';
    store.query.search.customerId = '9000000000001';
    store.query.search.systemDeliveryDateFrom = '2026-10-01';
    store.query.search.systemDeliveryDateTo = '2026-10-31';
    store.query.sortBy = 'NAME';
    store.query.sortDir = 'DESC';
    store.query.page = 3;
    store.query.pageSize = 50;

    await store.query.fetchList();
    const params = listInspectionBatchesMock.mock.calls[0]?.[0] as Record<string, unknown>;
    // 三个 ILIKE 子串各自 trim；互相独立（后端 AND 联合）。
    expect(params.drawing_no).toBe('DWG-1');
    expect(params.name).toBe('零件');
    expect(params.serial_no).toBe('SN-1');
    // 雪花 ID 字符串直传（禁 Number()：19 位 ID 在 JS Number 丢精度）。
    expect(params.customer_id).toBe('9000000000001');
    expect(params.system_delivery_date_from).toBe('2026-10-01');
    expect(params.system_delivery_date_to).toBe('2026-10-31');
    expect(params.sort_by).toBe('NAME');
    expect(params.sort_dir).toBe('DESC');
    expect(params.limit).toBe(50);
    expect(params.offset).toBe(100);
  });

  it('buildParams 空筛选不发参数；queryKey 变化自动 refetch', async () => {
    const store = useInspectionListStore();
    store.query.restoreState();
    await tick();
    listInspectionBatchesMock.mockClear();

    // 默认态：只发排序 + 分页，不带 5 个筛选键。
    // ⚠️ 本用例只断到 **buildParams 层**：本 spec `vi.mock('@/api/parts')`，
    // `listInspectionBatches` 是被 mock 掉的，`cleanParams` 那层「undefined 键不上
    // wire」根本不会执行 —— `params.xxx === undefined` ≠ 「axios 没发这个键」。
    // 真 wire 形态（`toEqual` 逐键比对 axios 收到的 params）在
    // `src/api/parts/__tests__/routes.spec.ts` 的 R7 用例里验。
    store.query.search.drawingNo = '   ';
    store.query.pageSize = 20;
    await store.query.fetchList();
    let params = listInspectionBatchesMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params.drawing_no).toBeUndefined();
    expect(params.name).toBeUndefined();
    expect(params.serial_no).toBeUndefined();
    expect(params.customer_id).toBeUndefined();
    expect(params.system_delivery_date_from).toBeUndefined();
    expect(params.system_delivery_date_to).toBeUndefined();
    expect(params.sort_by).toBe('SYSTEM_DELIVERY_DATE');
    expect(params.offset).toBe(0);

    // 改 search ⇒ queryKey 变 ⇒ useQuery 自动 refetch（不需手动 fetchList）。
    listInspectionBatchesMock.mockClear();
    store.query.search.drawingNo = 'DWG-9';
    await tick();
    expect(listInspectionBatchesMock).toHaveBeenCalledTimes(1);
    params = listInspectionBatchesMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params.drawing_no).toBe('DWG-9');
  });

  // ============ onSortChange 映射 ============
  it('onSortChange 把列 prop 映射成后端 sort_by；取消排序不改状态', async () => {
    const store = useInspectionListStore();
    store.query.restoreState();
    await tick();
    listInspectionBatchesMock.mockClear();

    // 客户列：prop 'customer' → CUSTOMER_NAME（渲染是 L1/L2 两段文本，排序按 c.name）。
    store.query.onSortChange({ prop: 'customer', order: 'descending' });
    expect(store.query.sortBy).toBe('CUSTOMER_NAME');
    expect(store.query.sortDir).toBe('DESC');
    // default-sort 反向映射回列 prop（el-table 恢复排序箭头用）。
    expect(store.query.defaultSort).toEqual({ prop: 'customer', order: 'descending' });
    // 排序变化 → queryKey 变 → 自动 refetch（不手动 fetchList），wire 上是新 sort_by。
    await tick();
    expect(listInspectionBatchesMock).toHaveBeenCalledTimes(1);
    const afterSort = listInspectionBatchesMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(afterSort.sort_by).toBe('CUSTOMER_NAME');
    expect(afterSort.sort_dir).toBe('DESC');

    // 取消排序（第三次点击）不改状态。
    store.query.onSortChange({ prop: 'customer', order: null });
    expect(store.query.sortBy).toBe('CUSTOMER_NAME');
    expect(store.query.sortDir).toBe('DESC');
    store.query.onSortChange({ prop: null, order: 'ascending' });
    expect(store.query.sortBy).toBe('CUSTOMER_NAME');

    // 未知 prop 退化为 SYSTEM_DELIVERY_DATE（与后端非法值退化一致）。
    store.query.onSortChange({ prop: 'holder_name', order: 'ascending' });
    expect(store.query.sortBy).toBe('SYSTEM_DELIVERY_DATE');
    expect(store.query.sortDir).toBe('ASC');
    await store.query.fetchList();
    const last = listInspectionBatchesMock.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(last.sort_by).toBe('SYSTEM_DELIVERY_DATE');
    expect(last.sort_dir).toBe('ASC');
    // 反向映射表自洽（每个排序键都能落回一个列 prop）。
    expect(INSPECTION_SORT_KEY_TO_PROP.CUSTOMER_NAME).toBe('customer');
    expect(INSPECTION_SORT_KEY_TO_PROP.BATCH_NO).toBe('batch_no');
  });

  // ============ enabled 闸门 ============
  it('store 实例化**不**自动 fetch；restoreState() 之后才 fetch', async () => {
    const store = useInspectionListStore();
    // 不调 restoreState ⇒ restored 保持 false ⇒ enabled 闸门关闭。
    await tick();
    expect(listInspectionBatchesMock).not.toHaveBeenCalled();

    // 显式 fetchList 仍可用（refetch 别名，不重写 queryKey）。
    // ⚠️ 前提：refetch **绕过 enabled**（TanStack 的既有语义），所以这一步发请求
    // 并不意味着闸门漏了 —— 闸门管的是「queryKey 变化触发的自动 fetch」。
    // 这正是 fetchList 存在的意义：视图 / 测试要能在闸门关着时手动取一次数据。
    await store.query.fetchList();
    expect(listInspectionBatchesMock).toHaveBeenCalledTimes(1);

    // restoreState 末尾开闸 ⇒ 自动首屏 fetch。
    listInspectionBatchesMock.mockClear();
    store.query.restoreState();
    await tick();
    expect(listInspectionBatchesMock).toHaveBeenCalledTimes(1);
  });

  // ============ 数据派生 ============
  it('items / total 派生自 query 数据（total 是 JSON string ⇒ 边界 Number）', async () => {
    const store = useInspectionListStore();
    await store.query.fetchList();
    expect(store.query.items).toHaveLength(1);
    expect(store.query.items[0]?.batch_id).toBe('190000000000001');
    // '1' → 1；不是字符串。
    expect(store.query.total).toBe(1);
    expect(store.query.emptyText).toBe('当前无待品检零件');
  });

  // ============ 错误桥接 ============
  it('query 失败走 watch → ElMessage.error，不在 setup 抛错', async () => {
    const { ElMessage } = await import('element-plus');
    listInspectionBatchesMock.mockRejectedValue(new Error('后端 500'));
    const store = useInspectionListStore();
    expect(() => store.query.restoreState()).not.toThrow();
    await tick();
    expect(store.query.errorMsg).toBe('后端 500');
    expect(store.query.emptyText).toBe('后端 500');
    expect(ElMessage.error).toHaveBeenCalledWith('后端 500');
  });

  // ============ 持久化 + 收敛 ============
  it('restoreState 恢复筛选 / 排序 / 分页大小，非法排序键收敛回默认值', async () => {
    const store = useInspectionListStore();
    store.query.search.drawingNo = 'DWG-1';
    store.query.sortBy = 'NAME';
    store.query.sortDir = 'DESC';
    store.query.pageSize = 50;
    // useListFilterPersist 是 300ms 节流 + onBeforeUnmount 强制落盘；这里手动等一拍。
    await new Promise((r) => setTimeout(r, 350));

    const store2 = useInspectionListStore();
    store2.$dispose();

    // 写一份「非法排序键 + 越界 pageSize」快照，验证收敛而不是整份丢弃。
    const raw = localStorage.getItem('myerp.list.anon.inspection_pending_filter');
    expect(raw).toBeTruthy();
    const snap = JSON.parse(raw as string) as Record<string, unknown>;
    snap.sortBy = 'HOLDER_NAME';
    snap.pageSize = -1;
    localStorage.setItem('myerp.list.anon.inspection_pending_filter', JSON.stringify(snap));

    const store3 = useInspectionListStore();
    store3.query.restoreState();
    expect(store3.query.search.drawingNo).toBe('DWG-1');
    expect(store3.query.sortBy).toBe('SYSTEM_DELIVERY_DATE');
    expect(store3.query.sortDir).toBe('DESC');
    // pageSize 越界 ⇒ 保持默认 20（不采纳非法值）
    expect(store3.query.pageSize).toBe(20);
    // **不**恢复 page：避免停在一个不存在的页。
    expect(store3.query.page).toBe(1);
  });

  // ============ resetAllFilters ============
  it('resetAllFilters 清已确认筛选 + 未确认草稿 + popover 打开态，回第 1 页，保留排序与分页大小', async () => {
    const store = useInspectionListStore();
    // 先各 confirm 一遍（把 search 写成非空），再手动制造「未确认草稿 + 弹窗开着」。
    store.filters.serialNoFilter.draft = 'C';
    store.filters.serialNoFilter.confirm();
    store.filters.drawingNoFilter.draft = 'A';
    store.filters.drawingNoFilter.confirm();
    store.filters.nameFilter.draft = 'B';
    store.filters.nameFilter.confirm();
    store.filters.customerFilter.draft = '9000000000001';
    store.filters.customerFilter.confirm();
    store.filters.systemDateFilter.range = ['2026-10-01', '2026-10-31'];
    store.filters.systemDateFilter.confirm();
    store.query.sortBy = 'QUANTITY';
    store.query.page = 4;
    store.query.pageSize = 50;
    // 三个「未确认」现场：草稿有值、弹窗开着（用户正在输、还没点确定）。
    store.filters.drawingNoFilter.draft = 'DRAFT-DWG';
    store.filters.drawingNoFilter.visible = true;
    store.filters.customerFilter.draft = '9999999999999';
    store.filters.customerFilter.visible = true;
    store.filters.systemDateFilter.range = ['2026-12-01', '2026-12-31'];
    store.filters.systemDateFilter.visible = true;

    store.query.resetAllFilters();

    expect(store.query.search.drawingNo).toBe('');
    expect(store.query.search.name).toBe('');
    expect(store.query.search.serialNo).toBe('');
    expect(store.query.search.customerId).toBe('');
    expect(store.query.search.systemDeliveryDateFrom).toBe('');
    expect(store.query.search.systemDeliveryDateTo).toBe('');
    expect(store.query.page).toBe(1);
    // 排序与分页大小保留（排序是「视图」不是「筛选」）。
    expect(store.query.sortBy).toBe('QUANTITY');
    expect(store.query.pageSize).toBe(50);
    // 半截草稿与 popover 打开态也要清 —— 否则用户下次在弹窗里点「确定」
    // 会把重置前的旧草稿又写回 search。
    expect(store.filters.drawingNoFilter.draft).toBe('');
    expect(store.filters.drawingNoFilter.visible).toBe(false);
    expect(store.filters.customerFilter.draft).toBeNull();
    expect(store.filters.customerFilter.visible).toBe(false);
    expect(store.filters.systemDateFilter.range).toBeNull();
    expect(store.filters.systemDateFilter.visible).toBe(false);
  });

  // ============ 列可见性（lenient 恢复）============
  it('列可见性 lenient 恢复：只有旧快照的 batch_label 时，批次列（现 key=batch_no）仍默认可见', () => {
    // 批次列的 key 由 batch_label 改成 batch_no（VO 收口），旧 localStorage 快照里
    // 存的是 batch_label。useColumnVisibility 的 lenient 策略只覆盖 defs 里存在的
    // key ⇒ 旧快照中不存在的 batch_no 落回 defaultVisible（true）。
    localStorage.setItem(
      'myerp.list.anon.inspection_pending_columns',
      JSON.stringify({ batch_label: false, name: false }),
    );
    const store = useInspectionListStore();
    // 旧快照里存在的 key 被采纳（name 被隐藏）。
    expect(store.columnVisibility.isVisible('name')).toBe(false);
    // 旧快照里不存在的 key 回到默认可见 —— 这条是「改 key 不丢列」的回归守卫。
    expect(store.columnVisibility.isVisible('batch_no')).toBe(true);
    // showAll / update 联动：showAll 后旧 key 也一并可见。
    store.columnVisibility.showAll();
    expect(store.columnVisibility.isVisible('name')).toBe(true);
    store.columnVisibility.update({ batch_no: false, name: true });
    expect(store.columnVisibility.isVisible('batch_no')).toBe(false);
    expect(store.columnVisibility.isVisible('name')).toBe(true);
  });

  // ============ 表头筛选状态机（全部 draft → confirm）============
  it('5 个表头筛选都走 draft → confirm：选值不写 search，点确定才写并回第 1 页', () => {
    const store = useInspectionListStore();
    store.query.page = 3;

    store.filters.serialNoFilter.draft = '  SN-7  ';
    store.filters.serialNoFilter.confirm();
    expect(store.query.search.serialNo).toBe('SN-7');
    expect(store.query.page).toBe(1);
    expect(store.filters.serialNoFilter.active).toBe(true);
    expect(store.filters.serialNoFilter.visible).toBe(false);

    store.filters.serialNoFilter.reset();
    expect(store.query.search.serialNo).toBe('');
    expect(store.filters.serialNoFilter.active).toBe(false);

    // 系统交期区间同样是 draft → confirm（2026-10-03 从「computed 直写 search」改过来）：
    // 关键断言是「写 range 不写 search」—— 直写形态会在用户还停在第 3 页时就用
    // 「旧 page=3 + 新筛选」发一次（多半 0 行、闪空态），点确定后又发第二次。
    store.filters.systemDateFilter.range = ['2026-10-01', '2026-10-31'];
    expect(store.query.search.systemDeliveryDateFrom).toBe('');
    expect(store.query.search.systemDeliveryDateTo).toBe('');
    expect(store.filters.systemDateFilter.active).toBe(false);

    store.query.page = 3;
    store.filters.systemDateFilter.confirm();
    expect(store.query.search.systemDeliveryDateFrom).toBe('2026-10-01');
    expect(store.query.search.systemDeliveryDateTo).toBe('2026-10-31');
    expect(store.filters.systemDateFilter.active).toBe(true);
    expect(store.query.page).toBe(1);
    // sync 把已确认值回写草稿（二次打开 popover 看到原状）。
    store.filters.systemDateFilter.sync();
    expect(store.filters.systemDateFilter.range).toEqual(['2026-10-01', '2026-10-31']);
    store.filters.systemDateFilter.reset();
    expect(store.query.search.systemDeliveryDateFrom).toBe('');
    expect(store.filters.systemDateFilter.active).toBe(false);
    expect(store.filters.systemDateFilter.range).toBeNull();

    // 客户：draft → confirm，且雪花 ID 保持字符串。
    store.filters.customerFilter.draft = '9000000000001';
    store.filters.customerFilter.confirm();
    expect(store.query.search.customerId).toBe('9000000000001');
    store.filters.customerFilter.reset();
    expect(store.query.search.customerId).toBe('');
  });

  // ============ mutations ============
  it('品检通过 mutation：调 toShip + 失效 inspection 域 + 成功提示', async () => {
    const { ElMessage } = await import('element-plus');
    const store = useInspectionListStore();
    store.registerActions({ onPass: vi.fn(), onOpenFail: vi.fn(), onDetail: vi.fn() });
    toShipMock.mockResolvedValue({ part: {}, new_batch_id: null });
    // 写完要失效本域。断的是「invalidateQueries 被以 qk 工厂的域前缀调过」——
    // 断言一个永远非空的 computed（items）什么也证明不了。
    // 之所以可断：queryKey 前缀是 qk 工厂的产物（不在调用点拼字面量），spy 拿到的
    // 第一个参数就是它本身。
    const spy = vi.spyOn(qc, 'invalidateQueries');

    await store.mutations.toShipMutation.mutateAsync({
      batchId: '190000000000001',
      version: 7,
      quantity: 4,
      label: 'SN-A',
    });

    expect(toShipMock).toHaveBeenCalledWith('190000000000001', { version: 7, quantity: 4 });
    expect(ElMessage.success).toHaveBeenCalledWith('零件 SN-A 品检通过 × 4');
    expect(spy).toHaveBeenCalledWith({ queryKey: qk.inspectionPrefix });
  });

  it('品检通过遇到 40901 走 warning + 重拉，不弹通用 error', async () => {
    const { ElMessage } = await import('element-plus');
    const store = useInspectionListStore();
    listInspectionBatchesMock.mockClear();
    const conflict = Object.assign(new Error('版本冲突'), { code: 40901 });
    toShipMock.mockRejectedValue(conflict);

    await expect(
      store.mutations.toShipMutation.mutateAsync({
        batchId: '190000000000001',
        version: 7,
        quantity: 4,
        label: 'SN-A',
      }),
    ).rejects.toThrow('版本冲突');

    expect(ElMessage.warning).toHaveBeenCalledWith('该批次已被他人修改，请刷新后重试');
    expect(ElMessage.error).not.toHaveBeenCalled();
    // 冲突后重拉一次列表。
    await tick();
    expect(listInspectionBatchesMock).toHaveBeenCalled();
  });

  it('指定工序 / 扫码快捷品检 mutation 的 payload 逐字对齐后端字段名', async () => {
    const store = useInspectionListStore();
    toProcessMock.mockResolvedValue({ part: {}, new_batch_id: null });
    scanInspectMock.mockResolvedValue({});

    await store.mutations.toProcessMutation.mutateAsync({
      batchId: 'B1',
      shelfId: 'S1',
      nextProcessId: 'P1',
      version: 7,
      note: '不合格',
      quantity: 2,
      label: 'SN-A',
      processCode: 'CUT',
      shelfCode: 'SH-A',
    });
    expect(toProcessMock).toHaveBeenCalledWith('B1', {
      shelf_id: 'S1',
      next_process_id: 'P1',
      version: 7,
      note: '不合格',
      quantity: 2,
    });

    await store.mutations.scanInspectMutation.mutateAsync({
      batchId: 'B1',
      targetInspectionShelfId: 'IS1',
      pass: true,
      version: 7,
      shelfId: null,
      nextProcessId: null,
      note: null,
      quantity: null,
      label: 'SN-A',
    });
    expect(scanInspectMock).toHaveBeenCalledWith('B1', {
      target_inspection_shelf_id: 'IS1',
      pass: true,
      version: 7,
      shelf_id: undefined,
      next_process_id: undefined,
      note: null,
      quantity: null,
    });
  });

  it('扫码快捷品检遇到 40901 同样走 warning + 重拉（与 toShip / toProcess 同款）', async () => {
    const { ElMessage } = await import('element-plus');
    const store = useInspectionListStore();
    listInspectionBatchesMock.mockClear();
    scanInspectMock.mockRejectedValue(Object.assign(new Error('版本冲突'), { code: 40901 }));

    await expect(
      store.mutations.scanInspectMutation.mutateAsync({
        batchId: 'B1',
        targetInspectionShelfId: 'IS1',
        pass: true,
        version: 7,
        shelfId: null,
        nextProcessId: null,
        note: null,
        quantity: null,
        label: 'SN-A',
      }),
    ).rejects.toThrow('版本冲突');

    // 40901 的文案必须比通用「快捷品检失败：版本冲突」有指导性，且重拉列表。
    expect(ElMessage.warning).toHaveBeenCalledWith('该批次已被他人修改，请刷新后重试');
    expect(ElMessage.error).not.toHaveBeenCalled();
    await tick();
    expect(listInspectionBatchesMock).toHaveBeenCalled();
  });

  // ============ 不变量 #2：$dispose 重建 ============
  it('$dispose 重建 store 后状态是全新的（不泄漏上一次的筛选）', () => {
    const store1 = useInspectionListStore();
    store1.query.search.drawingNo = 'DWG-1';
    store1.query.sortBy = 'NAME';
    store1.ui.autoRefresh = true;
    expect(store1.query.search.drawingNo).toBe('DWG-1');

    store1.$dispose();

    const store2 = useInspectionListStore();
    expect(store2.query.search.drawingNo).toBe('');
    expect(store2.query.sortBy).toBe('SYSTEM_DELIVERY_DATE');
    expect(store2.ui.autoRefresh).toBe(false);
  });
});
