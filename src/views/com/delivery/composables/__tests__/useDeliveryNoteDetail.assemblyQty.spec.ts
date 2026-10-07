// @vitest-environment happy-dom
// src/views/com/delivery/composables/__tests__/useDeliveryNoteDetail.assemblyQty.spec.ts
//
// 2026-10-04 新增：详情页装配件父行「数量」列口径的守卫。
//
// 父行数量必须与打印对话框的「合并一套」父行同源同值（后端算的 shippable_sets）；
// 后端整体没给这个字段时是 null，表格渲染「—」。兜成 0 会被读成「凑不齐整套、
// 打不了」，恒 1 则与打印预览显示的数字对不上。口径实现见 utils/assemblySets.ts。
//
// 2026-10-08：详情数据改由 `useDeliveryNoteDetailQuery`（useQuery + Zod 守门）承载，
// 本用例按 vue-query 的注入要求补 pinia + VueQueryPlugin 上下文；api 层 mock 下移到
// axios 层（`@/api/http` 的 `api.get`），**不**整个 mock 掉 `@/api/com/deliveryNote`
// —— 守门 parse 在 queryFn 里，整个 mock 掉等于把守门一起短路。

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createApp, ref } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import type * as HttpModule from '@/api/http';
import type {
  DeliveryNoteDetailData,
  DeliveryNoteLineItemData,
} from '../../composables/deliveryNoteSchema';

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

// vue-query hook 需要注入上下文（node 单测无组件）：造一个 app 装 pinia + 插件。
// 本用例实例化的是**普通 composable**（不是 Pinia store），所以必须用
// `app.runWithContext` 显式提供注入上下文 —— store 之所以不需要，是 Pinia 在
// createSetupStore 里已经包了一层 runWithContext。
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const app = createApp({ render: () => null });
app.use(createPinia());
app.use(VueQueryPlugin, { queryClient });
setActivePinia(app.config.globalProperties.$pinia);

/** 在 app 注入上下文里跑一段 setup 体（vue-query hook 的硬要求）。 */
function inSetup<T>(fn: () => T): T {
  return app.runWithContext(fn);
}

beforeEach(() => {
  queryClient.clear();
  apiGetMock.mockReset();
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

/** 拉一次详情并返回 treeLineItems。 */
async function treeOf(lineItems: DeliveryNoteLineItemData[]) {
  apiGetMock.mockResolvedValue({ data: mkNote(lineItems) });
  const detail = inSetup(() => useDeliveryNoteDetail(ref('NOTE-1')));
  await detail.fetchDetail();
  return detail.treeLineItems.value;
}

const ASM = 'ASM-1';

describe('详情页装配件父行数量 = 本单可出货套数', () => {
  it('取组内有值的 shippable_sets 最小值', async () => {
    const rows = await treeOf([
      mkItem({ id: '400', part_id: 'PA', assembly_id: ASM, shippable_sets: 7 }),
      mkItem({ id: '300', part_id: 'PB', assembly_id: ASM, shippable_sets: 4 }),
    ]);
    const parent = rows.find((r) => r.is_asm_row)!;
    expect(parent.quantity).toBe(4);
    expect(parent.unit).toBe('套');
  });

  it('后端没给 shippable_sets → null（不是 0 也不是 1）', async () => {
    const rows = await treeOf([
      mkItem({ id: '400', part_id: 'PA', assembly_id: ASM }),
      mkItem({ id: '300', part_id: 'PB', assembly_id: ASM }),
    ]);
    expect(rows.find((r) => r.is_asm_row)!.quantity).toBeNull();
  });

  it('子件在本单凑不齐整套（0 套）→ 照实透传 0', async () => {
    const rows = await treeOf([
      mkItem({ id: '400', part_id: 'PA', assembly_id: ASM, shippable_sets: 0 }),
      mkItem({ id: '300', part_id: 'PB', assembly_id: ASM, shippable_sets: 0 }),
    ]);
    expect(rows.find((r) => r.is_asm_row)!.quantity).toBe(0);
  });

  it('散件行数量原样透传批次数量，不受装配件字段影响', async () => {
    const rows = await treeOf([mkItem({ id: '999', part_id: 'PLOOSE', quantity: 6 })]);
    expect(rows[0]!.is_asm_row).toBeUndefined();
    expect(rows[0]!.quantity).toBe(6);
  });
});