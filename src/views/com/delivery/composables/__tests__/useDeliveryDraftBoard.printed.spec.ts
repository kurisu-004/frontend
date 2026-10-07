// @vitest-environment happy-dom
// src/views/com/delivery/composables/__tests__/useDeliveryDraftBoard.printed.spec.ts
//
// 草稿看板「已打印标签」绿底的接线守卫（2026-10-08 恢复打印标签时新增）。
//
// 守的是三件事，任一断掉绿底就永远不亮，且**没有任何报错**（纯 localStorage + 纯函数）：
//   1. `foldedRows` 的折叠回调读的是 `usePrintedLabels` 的记录（接回数据源）；
//   2. 折叠 computed 会随 store 重算 —— `isPrintedBatch` 在求值**期间**同步读 `_store`，
//      Vue 按「求值期间发生的 ref 读」收集依赖，因此不需要再显式读一次 store；
//   3. `rowClassName` 把 `label_printed` 映射成 el-table 的行 class。
//
// 另外第一条用例钉住**批量详情的数据源形状**：`batchGetNotes` 在 api 层已解信封，
// 桩必须返回**数组**（信封形状的桩会让守门抛，把整块看板罩成绿的）。

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createApp, nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';

const { listNotesMock, batchGetNotesMock } = vi.hoisted(() => ({
  listNotesMock: vi.fn(),
  batchGetNotesMock: vi.fn(),
}));

vi.mock('@/api/com/deliveryNote', () => ({
  listNotes: listNotesMock,
  batchGetNotes: batchGetNotesMock,
  getNote: vi.fn(),
  removeBatches: vi.fn(),
  softDeleteNote: vi.fn(),
  setNoteDriver: vi.fn(),
}));

vi.mock('element-plus', () => ({
  ElMessage: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
  ElMessageBox: { confirm: vi.fn() },
}));

const app = createApp({ render: () => null });
app.use(createPinia());
/** 每个用例前 clear：同名 queryKey 的缓存跨用例残留会让「本次拿到的到底是哪次请求」
 *  变得不可判（下面那条反向对照用例就靠「空缓存起步」才有意义）。 */
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
app.use(VueQueryPlugin, { queryClient });
setActivePinia(app.config.globalProperties.$pinia);

const { ElMessage } = await import('element-plus');

const { useDeliveryDraftBoard } = await import('../useDeliveryDraftBoard');
const { usePrintedLabels } = await import('../usePrintedLabels');

const NOTE_ID = 'N1';

function lineItem(over: Record<string, unknown> = {}) {
  return {
    id: '911000000000000001',
    part_id: 'P1',
    batch_no: 1,
    batch_label: 'B1',
    serial_no: 'S-1',
    drawing_no: 'D-1',
    name: '铝电解电容',
    quantity: 5,
    status: 'READY_TO_SHIP',
    applicant_name: '张三',
    request_date: null,
    planned_delivery_date: null,
    system_delivery_date: '2026-11-01',
    order_no: 'SO-1',
    note: null,
    customer_name: '法拉',
    customer_id: 'L2A',
    parent_customer_name: '法拉电子',
    customer_path: '法拉电子 / 法拉',
    assembly_id: null,
    assembly_serial_no: null,
    assembly_drawing_no: null,
    assembly_name: null,
    assembly_order_no: null,
    assembly_quantity: null,
    shippable_sets: null,
    ...over,
  };
}

const DRAFT_HEAD = {
  id: NOTE_ID,
  version: 3,
  delivery_note_no: 'DN-001',
  customer_id: 'C1',
  customer_name: '法拉电子',
  customer_path: '法拉电子 / 法拉',
  status: 'DRAFT',
  submitted_at: null,
  picked_up_at: null,
  driver_worker_name: null,
  part_count: 1,
  note: null,
  delivery_date: '2026-10-08',
};

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i += 1) {
    await nextTick();
    await new Promise((r) => setTimeout(r, 0));
  }
}

beforeEach(() => {
  queryClient.clear();
  localStorage.clear();
  usePrintedLabels().store.value = {};
  listNotesMock.mockReset();
  batchGetNotesMock.mockReset();
  (ElMessage.error as unknown as { mock: { calls: unknown[] } }).mock.calls.length = 0;
  listNotesMock.mockResolvedValue({ items: [DRAFT_HEAD], total: 1, limit: 200, offset: 0 });
  // ⚠️ 必须返回**数组**：`batchGetNotes` 在 api 层末尾 `return resp.data.items`，
  // queryFn 拿到的是数组。返回信封的桩是**与真实契约相反的假契约** —— 它能让
  // 「queryFn 直接 parse 返回值」的写法也变绿，从而把整块看板罩成绿的（2026-10-08 修）。
  batchGetNotesMock.mockResolvedValue([{ ...DRAFT_HEAD, line_items: [lineItem()] }]);
});

/** 起一个看板实例并等两条 query 回流。 */
async function bootBoard() {
  const board = app.runWithContext(() => useDeliveryDraftBoard());
  board.setL1Id('C1');
  await flush();
  expect(board.drafts.value[NOTE_ID]).toBeTruthy();
  return board;
}

describe('草稿看板批量详情的数据源形状（B1 回归锁）', () => {
  it('api 层已解信封 → queryFn 拿到的是数组：行项表出行，且零 error toast', async () => {
    const board = await bootBoard();

    // 桩给的确实是数组（真实 api 的返回形状），不是 `{ items }`。
    const raw = await batchGetNotesMock.mock.results[0]!.value;
    expect(Array.isArray(raw)).toBe(true);

    expect(board.draftDetails[NOTE_ID]).toHaveLength(1);
    expect(board.foldedRows(NOTE_ID).map((r) => r.name)).toEqual(['铝电解电容']);
    // 守门抛过一次就是这条：query 恒 error ⇒ detail watch 走兜底把行项写成 []，
    // 同时每次查询弹一条「加载草稿详情失败」。
    expect(ElMessage.error).not.toHaveBeenCalled();
  });

  it('批量详情返回信封（api 层忘了解信封）→ 守门抛 ⇒ 行项表空（这是**不该**发生的形状）', async () => {
    // 反向对照：把桩改回信封，守门必须抛、看板必须空。
    // 说明本文件第一组用例靠的是「数组形状」而不是任何巧合。
    batchGetNotesMock.mockResolvedValue({ items: [{ ...DRAFT_HEAD, line_items: [lineItem()] }] });
    const board = await bootBoard();
    expect(board.foldedRows(NOTE_ID)).toEqual([]);
    expect(ElMessage.error).toHaveBeenCalled();
  });
});

describe('useDeliveryDraftBoard 已打印标签绿底', () => {
  it('没有打印记录 → 行不带绿底', async () => {
    const board = await bootBoard();
    const rows = board.foldedRows(NOTE_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.label_printed).toBe(false);
    expect(board.rowClassName({ row: rows[0]! })).toBe('');
  });

  it('markPrinted 之后同一行变绿（绿底随标记重算，不等重新拉详情）', async () => {
    const board = await bootBoard();
    expect(board.rowClassName({ row: board.foldedRows(NOTE_ID)[0]! })).toBe('');

    usePrintedLabels().markPrinted(NOTE_ID, ['911000000000000001']);

    const rows = board.foldedRows(NOTE_ID);
    expect(rows[0]!.label_printed).toBe(true);
    expect(board.rowClassName({ row: rows[0]! })).toBe('row-printed');
  });

  it('unmark 之后绿底消失（移除批次时不会被脏标记永久染绿）', async () => {
    const board = await bootBoard();
    const printed = usePrintedLabels();
    printed.markPrinted(NOTE_ID, ['911000000000000001']);
    expect(board.rowClassName({ row: board.foldedRows(NOTE_ID)[0]! })).toBe('row-printed');

    printed.unmark(NOTE_ID, ['911000000000000001']);

    expect(board.rowClassName({ row: board.foldedRows(NOTE_ID)[0]! })).toBe('');
  });

  it('同 serial_no 的多个批次折叠成一行：任一批次打过标签即整行绿', async () => {
    batchGetNotesMock.mockResolvedValue([
      {
        ...DRAFT_HEAD,
        part_count: 2,
        line_items: [
          lineItem({ id: '911000000000000002', serial_no: 'S-9' }),
          lineItem({ id: '911000000000000001', serial_no: 'S-9' }),
        ],
      },
    ]);
    const board = await bootBoard();
    expect(board.foldedRows(NOTE_ID)).toHaveLength(1);

    usePrintedLabels().markPrinted(NOTE_ID, ['911000000000000001']);

    const row = board.foldedRows(NOTE_ID)[0]!;
    expect(row.quantity).toBe(10);
    expect(row.batch_ids).toHaveLength(2);
    expect(board.rowClassName({ row })).toBe('row-printed');
  });

  it('标记记在别的单据下也生效（isPrintedBatch 跨 note 查，看板不依赖 note id 对齐）', async () => {
    const board = await bootBoard();
    usePrintedLabels().markPrinted('OTHER_NOTE', ['911000000000000001']);
    expect(board.rowClassName({ row: board.foldedRows(NOTE_ID)[0]! })).toBe('row-printed');
  });
});