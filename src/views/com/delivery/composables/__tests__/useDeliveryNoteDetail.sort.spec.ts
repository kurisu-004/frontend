// @vitest-environment happy-dom
// src/views/com/delivery/composables/__tests__/useDeliveryNoteDetail.sort.spec.ts
//
// 2026-10-10 新增：详情页零件列表**客户端排序**（`onLineItemSort` → `sortedLineItems`
// → `treeLineItems`）的守卫。此前 `sortedLineItems` / `onLineItemSort` 零覆盖。
//
// 三条要钉住的行为：
//   - **三态点击**：点第三下（`order = null`）回到默认序 —— 后端详情 SQL 已按
//     `delivery_seq`（本单内挂单先后）返回，所以「默认序」= 加入送货单的先后顺序；
//   - **排序在折叠之前发生**，所以排序走的是**批次字段**、折叠行的展示字段才跟着变
//     （行序不变：折叠保输入序，见 utils/deliveryNotePartRows.ts 文件头）；
//   - 与「序号」列的交互：序号由 `min_seq` 稠密排名写在**行**上，`seq` 也不是后端字段 ⇒
//     折叠行上按 seq 排会全落在同一个值（比较器恒 0、稳定排序保原序），实际排序由 EP 自己
//     的 `sortData` 承担。本用例钉住「两层排序同向、不互相打架」的前一半。
//
// mock 方式沿用同目录 `useDeliveryNoteDetail.assemblyQty.spec.ts`：api 层 mock 下移到 axios
// 层（`@/api/http` 的 `api.get`），**不**整个 mock 掉 `@/api/com/deliveryNote` —— 守门 parse
// 在 queryFn 里，整个 mock 掉等于把守门一起短路。

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createApp, ref } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import type * as HttpModule from '@/api/http';
import type {
  DeliveryNoteDetailData,
  DeliveryNoteLineItemData,
} from '../deliveryNoteSchema';

// node/happy-dom 下真实 ElMessage 会碰 `document is not defined` 一类输出，桩成 no-op。
vi.mock('element-plus', () => ({
  ElMessage: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
  ElMessageBox: { confirm: vi.fn() },
  // columnDefs 的 cellRender 里用到 ElTag（装配件父行 / 状态列）
  ElTag: {},
  ElButton: {},
  ElTooltip: {},
  ElTable: {},
}));

const { apiGetMock } = vi.hoisted(() => ({
  apiGetMock: vi.fn<(url: string, config?: unknown) => Promise<{ data: unknown }>>(async () => ({
    data: null,
  })),
}));

vi.mock('@/api/http', async (importOriginal) => {
  const actual = await importOriginal<typeof HttpModule>();
  return { ...actual, api: { ...actual.api, get: apiGetMock } };
});

vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({ user: { id: 1 }, hasRole: () => true }),
}));

const { useDeliveryNoteDetail } = await import('../useDeliveryNoteDetail');

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const app = createApp({ render: () => null });
app.use(createPinia());
app.use(VueQueryPlugin, { queryClient });
setActivePinia(app.config.globalProperties.$pinia);

/** 普通 composable 必须显式 `runWithContext` 才有注入上下文（不是 Pinia store 的差别）。 */
function inSetup<T>(fn: () => T): T {
  return app.runWithContext(fn);
}

beforeEach(() => {
  queryClient.clear();
  apiGetMock.mockReset();
  localStorage.clear();
});

function mkItem(p: Partial<DeliveryNoteLineItemData> & { id: string; part_id: string }) {
  return {
    batch_no: null,
    batch_label: null,
    serial_no: `S-${p.id}`,
    drawing_no: 'D-1',
    name: 'N1',
    quantity: 1,
    status: 'READY_TO_SHIP',
    applicant_name: null,
    request_date: null,
    planned_delivery_date: null,
    system_delivery_date: null,
    order_no: null,
    note: null,
    customer_name: null,
    parent_customer_name: null,
    customer_path: null,
    assembly_id: null,
    assembly_serial_no: null,
    assembly_drawing_no: null,
    assembly_name: null,
    assembly_order_no: null,
    ...p,
  } satisfies DeliveryNoteLineItemData;
}

function mkNote(lineItems: DeliveryNoteLineItemData[]): DeliveryNoteDetailData {
  return {
    id: 'NOTE-1',
    version: 1,
    delivery_note_no: 'DN-001',
    customer_id: 'C1',
    customer_name: null,
    customer_path: null,
    status: 'DRAFT',
    submitted_at: null,
    picked_up_at: null,
    driver_worker_name: null,
    part_count: lineItems.length,
    note: null,
    delivery_date: null,
    line_items: lineItems,
  } satisfies DeliveryNoteDetailData;
}

/** 拉一次详情并返回该 detail 实例。 */
async function detailOf(lineItems: DeliveryNoteLineItemData[]) {
  apiGetMock.mockResolvedValue({ data: mkNote(lineItems) });
  const detail = inSetup(() => useDeliveryNoteDetail(ref('NOTE-1')));
  await detail.fetchDetail();
  return detail;
}

/** 默认序的三个零件（后端已按 delivery_seq 排好）：入单序 P1 → P2 → P3。名称用 ASCII，
 *  免得「中文名按码位比」的方向与直觉相反（甲 > 乙 > 丙），用例里读起来容易看错。 */
const ITEMS: DeliveryNoteLineItemData[] = [
  mkItem({ id: '10', part_id: 'P1', name: 'N-C', delivery_seq: 1, status: 'BLOCKED' }),
  mkItem({ id: '11', part_id: 'P2', name: 'N-A', delivery_seq: 2, status: 'READY_TO_SHIP' }),
  mkItem({ id: '12', part_id: 'P3', name: 'N-B', delivery_seq: 3, status: 'READY_TO_SHIP' }),
];

describe('详情页零件列表排序：三态点击', () => {
  it('默认序 = 后端返回序（后端已按加入送货单的先后顺序排）', async () => {
    const detail = await detailOf(ITEMS);
    expect(detail.treeLineItems.value.map((r) => r.part_id)).toEqual(['P1', 'P2', 'P3']);
    // 「序号」列显示值同样是入单序
    expect(detail.treeLineItems.value.map((r) => r.seq)).toEqual([1, 2, 3]);
  });

  it('点第三下（order = null）回到默认序', async () => {
    const detail = await detailOf(ITEMS);

    detail.onLineItemSort({ prop: 'name', order: 'descending' });
    expect(detail.treeLineItems.value.map((r) => r.name)).toEqual(['N-C', 'N-B', 'N-A']);

    // 三态的第三下：清排序 ⇒ 回到后端返回顺序
    detail.onLineItemSort({ prop: 'name', order: null });
    expect(detail.treeLineItems.value.map((r) => r.part_id)).toEqual(['P1', 'P2', 'P3']);
  });

  it('prop 为 null（EP 清排序时的载荷）也回默认序', async () => {
    const detail = await detailOf(ITEMS);
    detail.onLineItemSort({ prop: 'name', order: 'ascending' });
    expect(detail.treeLineItems.value.map((r) => r.name)).toEqual(['N-A', 'N-B', 'N-C']);

    detail.onLineItemSort({ prop: null, order: 'ascending' });
    expect(detail.treeLineItems.value.map((r) => r.part_id)).toEqual(['P1', 'P2', 'P3']);
  });
});

describe('详情页零件列表排序：升 / 降序', () => {
  it('按 name 升序 / 降序', async () => {
    const detail = await detailOf(ITEMS);
    detail.onLineItemSort({ prop: 'name', order: 'ascending' });
    expect(detail.treeLineItems.value.map((r) => r.name)).toEqual(['N-A', 'N-B', 'N-C']);

    detail.onLineItemSort({ prop: 'name', order: 'descending' });
    expect(detail.treeLineItems.value.map((r) => r.name)).toEqual(['N-C', 'N-B', 'N-A']);
  });

  it('null 值强制排末尾（升 / 降序都一样，dir 不参与 null 的判定）', async () => {
    const detail = await detailOf([
      mkItem({ id: '10', part_id: 'P1', order_no: null }),
      mkItem({ id: '11', part_id: 'P2', order_no: 'SO-1' }),
      mkItem({ id: '12', part_id: 'P3', order_no: 'SO-2' }),
    ]);
    detail.onLineItemSort({ prop: 'order_no', order: 'ascending' });
    expect(detail.treeLineItems.value.map((r) => r.order_no)).toEqual(['SO-1', 'SO-2', '']);

    detail.onLineItemSort({ prop: 'order_no', order: 'descending' });
    expect(detail.treeLineItems.value.map((r) => r.order_no)).toEqual(['SO-2', 'SO-1', '']);
  });

  it('排序列是批次字段、折叠后展示值跟着变（行序不变）', async () => {
    // 同零件两批，状态不同：按 status 升序排，第二批（READY_TO_SHIP）排前面 ⇒
    // 折叠行的「代表批次」展示值（状态 / 序列号）换成第二批那一笔，但行序仍是入单序。
    const detail = await detailOf([
      li({ id: '10', part_id: 'P1', status: 'BLOCKED', serial_no: 'S-10' }),
      li({ id: '11', part_id: 'P1', status: 'READY_TO_SHIP', serial_no: 'S-11' }),
    ]);
    detail.onLineItemSort({ prop: 'status', order: 'ascending' });
    const row = detail.treeLineItems.value[0]!;
    expect(detail.treeLineItems.value).toHaveLength(1);
    expect(row.status).toBe('BLOCKED');
    expect(row.serial_no).toBe('S-10');

    detail.onLineItemSort({ prop: 'status', order: 'descending' });
    const flipped = detail.treeLineItems.value[0]!;
    expect(flipped.status).toBe('READY_TO_SHIP');
    expect(flipped.serial_no).toBe('S-11');
    // 数量仍是两批之和，序号仍是组内最小 delivery_seq —— 两者都不随排序变
    expect(flipped.quantity).toBe(2);
    expect(flipped.seq).toBe(1);
  });
});

describe('详情页零件列表排序 × 折叠（序号列）', () => {
  it('折叠行上的 seq 不是后端字段 ⇒ 按它排不改变行序（EP 的 sortData 才真正生效）', async () => {
    const detail = await detailOf(ITEMS);
    const before = detail.treeLineItems.value.map((r) => [r.part_id, r.seq]);
    // 「序号」列的 sort-change 会带着 prop='seq' 上来：行项上没有该字段（它是行形上的），
    // 比较器恒 0 + sort 稳定 ⇒ 行序不变，序号也不会被改写。
    detail.onLineItemSort({ prop: 'seq', order: 'ascending' });
    expect(detail.treeLineItems.value.map((r) => [r.part_id, r.seq])).toEqual(before);
    detail.onLineItemSort({ prop: 'seq', order: 'descending' });
    expect(detail.treeLineItems.value.map((r) => [r.part_id, r.seq])).toEqual(before);
  });

  it('排序不重排缓存里的 line_items（派生副本）', async () => {
    const detail = await detailOf(ITEMS);
    detail.onLineItemSort({ prop: 'name', order: 'ascending' });
    expect(detail.treeLineItems.value.map((r) => r.part_id)).not.toEqual(['P1', 'P2', 'P3']);
    // query data 仍是后端那份
    expect(detail.note.value!.line_items.map((i) => i.part_id)).toEqual(['P1', 'P2', 'P3']);
  });

  it('$dispose 后排序态清空（下次默认序）', async () => {
    const detail = await detailOf(ITEMS);
    detail.onLineItemSort({ prop: 'name', order: 'descending' });
    expect(detail.treeLineItems.value.map((r) => r.name)).toEqual(['N-C', 'N-B', 'N-A']);

    detail.$dispose();
    expect(detail.treeLineItems.value.map((r) => r.part_id)).toEqual(['P1', 'P2', 'P3']);
  });
});

/** 局部行项工厂（同目录其它 spec 的同名 helper，形状逐字一致）。 */
function li(p: Partial<DeliveryNoteLineItemData> & { id: string; part_id: string }) {
  return mkItem(p);
}