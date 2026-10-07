// @vitest-environment happy-dom
// src/views/com/delivery/components/__tests__/DeliveryNoteLineItemsTable.asmQty.spec.ts
//
// 2026-10-04 新增：详情页「零件列表」数量列的装配件父行渲染契约（打印预览侧已有
// 同款守卫，详见 PrintPreviewDialog.customOrder.spec.ts）。
//
// 断的是「单位随数走」这条口径：后端没给 shippable_sets 时输出「—」而**不是**
// 「— 套」。后端没给数 = 这张单照常能打（照常打整套），带上单位会被读成「凑不齐
// 一套、打不了」；反过来 0 套是真凑不齐，必须照实显示「0 套」，不能因为 falsy
// 一起把单位吞掉。两种态相反 ⇒ 用例各钉一条。
//
// 为什么用 EP 模板桩而不是真 el-table：被测的是本组件自己的 cellRender 逻辑，
// el-table ↔ el-table-column 的插槽作用域协议不该由本用例复刻（理由同
// src/views/inspection/__tests__/InspectionTable.spec.ts）。桩 el-table 把**真实**
// 的 :data（treeLineItems）逐行喂给列桩，断言按 [data-col="数量"][data-row-id]
// 定位单元格，所以断的是真渲染输出而不是手摆的行对象。

import { describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { defineComponent, h, type PropType } from 'vue';
import { createRouter, createMemoryHistory } from 'vue-router';
import type { DeliveryNoteDetailData } from '../../composables/deliveryNoteSchema';
import type { AssemblyTreeRow } from '../../composables/useDeliveryNoteDetail';
import DeliveryNoteLineItemsTable from '../DeliveryNoteLineItemsTable.vue';

vi.mock('@/components/ColumnDragHandle.vue', () => ({
  default: { name: 'ColumnDragHandleStub', template: '<i class="mock-drag-handle" />' },
}));
vi.mock('@/components/ColumnVisibilityPopover.vue', () => ({
  default: { name: 'ColumnVisibilityPopoverStub', template: '<div class="mock-cvp" />' },
}));
vi.mock('element-plus', () => ({
  ElTag: { name: 'ElTagStub', template: '<span class="mock-el-tag"><slot /></span>' },
}));

/** el-table 桩把自己的 :data 摊到这里，列桩按行渲染单元格（桩拿不到 EP 的 table 上下文）。 */
let scopeRows: Record<string, unknown>[] = [];

const ElTableStub = defineComponent({
  name: 'ElTableStub',
  props: {
    data: { type: Array as PropType<Record<string, unknown>[]>, default: () => [] },
  },
  setup(props, { slots }) {
    return () => {
      // 父组件 render 一定先于子组件 render，此处同步后列桩立即读到最新行
      scopeRows = props.data;
      return h('div', { class: 'mock-el-table' }, slots.default?.());
    };
  },
});

const stubs = {
  ElCard: { template: '<section class="mock-el-card"><slot name="header" /><slot /></section>' },
  ElButton: {
    name: 'ElButtonStub',
    props: ['type', 'size', 'loading', 'disabled'],
    emits: ['click'],
    template: '<button :disabled="disabled" @click="$emit(\'click\')"><slot /></button>',
  },
  ElTable: ElTableStub,
  ElTableColumn: defineComponent({
    name: 'ElTableColumnStub',
    props: { label: { type: String, default: '' } },
    setup(props, { slots }) {
      return () =>
        h(
          'div',
          { class: 'mock-el-table-column', 'data-col': props.label },
          scopeRows.map((row) =>
            h(
              'div',
              { class: 'mock-cell', 'data-row-id': String(row.id ?? '') },
              slots.default ? slots.default({ row }) : [],
            ),
          ),
        );
    },
  }),
};

function mkRow(p: Partial<AssemblyTreeRow> & { id: string }): AssemblyTreeRow {
  return {
    version: 1,
    part_id: '',
    batch_no: null,
    batch_label: null,
    serial_no: '',
    drawing_no: '',
    name: '',
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
  };
}

/** 装配件父行（与 useDeliveryNoteDetail 构造的一致）：数量 = 本单可出货套数，缺失时 null。 */
function asmRow(quantity: number | null): AssemblyTreeRow {
  return mkRow({
    id: 'ASM_ASM-1',
    is_asm_row: true,
    has_children: true,
    assembly_id: 'ASM-1',
    assembly_name: '总装',
    name: '总装',
    quantity,
    unit: '套',
  });
}

function mkNote(): DeliveryNoteDetailData {
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
    part_count: 0,
    note: null,
    delivery_date: null,
    line_items: [],
  };
}

function mountTable(rows: AssemblyTreeRow[]): VueWrapper {
  scopeRows = [];
  return mount(DeliveryNoteLineItemsTable, {
    props: {
      note: mkNote(),
      canEdit: true,
      treeLineItems: rows,
      columnDefs: [],
      columnVisibility: {
        isVisible: () => true,
        update: () => {},
        showAll: () => {},
        currentMap: {},
      },
      selectedItemIds: [],
      partStatusLabel: (s: string) => s,
      partStatusTagType: () => 'info' as const,
      deliveryLineRowClassName: () => '',
    },
    global: {
      stubs,
      // 装配件父行的名称列渲染 RouterLink（跳 /assemblies/:id），必须有 router 上下文
      plugins: [createRouter({ history: createMemoryHistory(), routes: [] })],
    },
  });
}

/** 「数量」列某行的单元格。 */
function qtyCell(wrapper: VueWrapper, rowId: string) {
  return wrapper.find(`[data-col="数量"] [data-row-id="${rowId}"]`);
}

describe('详情页装配件父行数量列', () => {
  it('后端没给 shippable_sets → 「—」且不带单位（不是「— 套」）', () => {
    const wrapper = mountTable([asmRow(null)]);
    const cell = qtyCell(wrapper, 'ASM_ASM-1');
    expect(cell.text()).toBe('—');
    // 「— 套」会被读成「凑不齐一套、打不了」，与「后端没给数」含义相反
    expect(cell.find('.muted').exists()).toBe(false);
  });

  it('真的凑不齐整套（shippable_sets = 0）→ 照实显示「0 套」（单位不因 falsy 丢失）', () => {
    const wrapper = mountTable([asmRow(0)]);
    const cell = qtyCell(wrapper, 'ASM_ASM-1');
    expect(cell.text()).toBe('0套');
    expect(cell.find('.muted').text()).toBe('套');
  });

  it('有可出货套数 → 「N 套」', () => {
    const wrapper = mountTable([asmRow(4)]);
    const cell = qtyCell(wrapper, 'ASM_ASM-1');
    expect(cell.text()).toBe('4套');
    expect(cell.find('.muted').text()).toBe('套');
  });

  it('散件行渲染批次数量（无单位，不受装配件口径影响）', () => {
    const wrapper = mountTable([mkRow({ id: '999', part_id: 'PLOOSE', quantity: 5 })]);
    const cell = qtyCell(wrapper, '999');
    expect(cell.text()).toBe('5');
    expect(cell.find('.muted').exists()).toBe(false);
  });
});
