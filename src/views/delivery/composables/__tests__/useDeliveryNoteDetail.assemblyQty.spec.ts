// @vitest-environment happy-dom
// src/views/delivery/composables/__tests__/useDeliveryNoteDetail.assemblyQty.spec.ts
//
// 2026-10-04 新增：详情页装配件父行「数量」列口径的守卫。
//
// 父行数量必须与打印预览的「合并一套」父行同源同值（后端算的 shippable_sets）；
// 后端整体没给这个字段时是 null，表格渲染「—」。兜成 0 会被读成「凑不齐整套、
// 打不了」，恒 1 则与预览页显示的数字对不上。口径实现见 utils/assemblySets.ts。

import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import type { DeliveryNoteDetailOut, DeliveryNoteLineItem } from '@/types/deliveryNote';

vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({ user: { id: 1 }, hasRole: () => true }),
}));

const getNoteMock = vi.fn();
const listNoteEventsMock = vi.fn(async (_id: string) => []);
vi.mock('@/api/deliveryNote', () => ({
  getNote: (id: string) => getNoteMock(id),
  listNoteEvents: (id: string) => listNoteEventsMock(id),
}));

const { useDeliveryNoteDetail } = await import('../useDeliveryNoteDetail');

function mkItem(p: Partial<DeliveryNoteLineItem> & { id: string; part_id: string }) {
  return {
    version: 1,
    batch_no: null,
    batch_label: null,
    serial_no: `S-${p.id}`,
    drawing_no: 'D-1',
    name: 'N1',
    quantity: 1,
    is_urgent: false,
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
    is_scanned: false,
    scanned: false,
    assembly_id: null,
    assembly_serial_no: null,
    assembly_drawing_no: null,
    assembly_name: null,
    assembly_order_no: null,
    ...p,
  } satisfies DeliveryNoteLineItem;
}

function mkNote(lineItems: DeliveryNoteLineItem[]): DeliveryNoteDetailOut {
  return {
    id: 'NOTE-1',
    version: 1,
    delivery_note_no: 'DN-001',
    customer_id: 'C1',
    customer_name: null,
    parent_customer_name: null,
    customer_path: null,
    status: 'DRAFT',
    submitted_at: null,
    picked_up_at: null,
    submitted_by: null,
    picked_up_by: null,
    driver_worker_id: null,
    driver_worker_name: null,
    part_count: lineItems.length,
    note: null,
    delivery_date: null,
    created_at: '2026-10-04',
    updated_at: '2026-10-04',
    line_items: lineItems,
    scanned_serials: [],
  } satisfies DeliveryNoteDetailOut;
}

/** 拉一次详情并返回 treeLineItems。 */
async function treeOf(lineItems: DeliveryNoteLineItem[]) {
  getNoteMock.mockResolvedValue(mkNote(lineItems));
  const detail = useDeliveryNoteDetail(ref('NOTE-1'));
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
