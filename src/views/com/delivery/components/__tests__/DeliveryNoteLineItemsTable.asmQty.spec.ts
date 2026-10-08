// @vitest-environment happy-dom
// src/views/com/delivery/components/__tests__/DeliveryNoteLineItemsTable.asmQty.spec.ts
//
// 详情页「零件列表」数量列的渲染契约（打印预览侧已有同款守卫，详见
// PrintPreviewDialog.spec.ts）。2026-10-09 起列定义只有域根一份（组件内那份副本已删），
// 本用例通过传真实的 `buildDeliveryNoteLineItemsColumnDefs()` 驱动渲染 —— 顺带守住
// 「组件真的吃父注入的 defs，没有另建副本」。
//
// 断的是「单位随数走」这条口径：后端没给 shippable_sets 时输出「—」而**不是**
// 「— 套」。后端没给数 = 这张单照常能打（照常打整套），带上单位会被读成「凑不齐
// 一套、打不了」；反过来 0 套是真凑不齐，必须照实显示「0 套」，不能因为 falsy
// 一起把单位吞掉。两种态相反 ⇒ 用例各钉一条。
//
// 为什么用 EP 模板桩而不是真 el-table：被测的是列定义里的 cellRender 逻辑，
// el-table ↔ el-table-column 的插槽作用域协议不该由本用例复刻（理由同
// src/views/inspection/__tests__/InspectionTable.spec.ts）。桩 el-table 把**真实**
// 的 :data（treeLineItems）逐行喂给列桩，断言按 [data-col="数量"][data-row-id]
// 定位单元格，所以断的是真渲染输出而不是手摆的行对象。

import { describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { defineComponent, h, type PropType } from 'vue';
import { createRouter, createMemoryHistory } from 'vue-router';
import type { DeliveryNoteDetailData } from '../../composables/deliveryNoteSchema';
import type { PartTreeRow } from '../../utils/deliveryNotePartRows';
import { buildDeliveryNoteLineItemsColumnDefs } from '../../deliveryNoteLineItemsColumnDefs';
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

function mkRow(p: Partial<PartTreeRow> & { id: string }): PartTreeRow {
  return {
    is_part_row: true,
    serial_no: '',
    drawing_no: '',
    name: '',
    order_no: '',
    applicant_name: '',
    customer_name: '',
    customer_path: '',
    note: '',
    quantity: 1,
    unit: '件',
    batch_ids: ['1'],
    label_printed: false,
    request_date: null,
    planned_delivery_date: null,
    system_delivery_date: null,
    status: 'READY_TO_SHIP',
    part_id: '',
    assembly_id: null,
    assembly_serial_no: null,
    assembly_drawing_no: null,
    assembly_name: null,
    assembly_order_no: null,
    assembly_quantity: null,
    shippable_sets: null,
    seq: 1,
    min_seq: null,
    ...p,
  };
}

/** 装配件父行（与 buildPartTreeRows 构造的一致）：数量 = 本单可出货套数，缺失时 null。 */
function asmRow(quantity: number | null): PartTreeRow {
  return mkRow({
    id: 'ASM_ASM-1',
    is_part_row: undefined,
    is_asm_row: true,
    has_children: true,
    assembly_id: 'ASM-1',
    assembly_name: '总装',
    name: '总装',
    quantity,
    unit: '套',
    batch_ids: ['1', '2'],
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

function mountTable(rows: PartTreeRow[]): VueWrapper {
  scopeRows = [];
  const defs = buildDeliveryNoteLineItemsColumnDefs();
  return mount(DeliveryNoteLineItemsTable, {
    props: {
      note: mkNote(),
      canEdit: true,
      role: { MANAGER: true, CLERK: false, INSPECTOR: false },
      treeLineItems: rows,
      // 传真实的列定义（域根那份）——组件内不再有副本
      columnDefs: defs,
      columnVisibility: {
        isVisible: () => true,
        update: () => {},
        showAll: () => {},
        currentMap: {},
      },
      selectedRows: [],
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

describe('详情页列定义只有一份（组件吃父注入的 defs）', () => {
  it('列集合 = 域根那份 12 列，且不含批次列', () => {
    const w = mountTable([]);
    const labels = w.findAll('.mock-el-table-column').map((e) => e.attributes('data-col'));
    // 组件内固定列：selection + 序号（2026-10-10 由 `type="index"` 的「#」列换来的，
    // 两者都硬编码在 defs 的 v-for 之外，不进列定义）
    expect(labels.slice(0, 2)).toEqual(['', '序号']);
    expect(labels.slice(2)).toEqual([
      '序列号',
      '图号',
      '订单号',
      '名称',
      '客户（二级）',
      '申请人',
      '数量',
      '请购日期',
      '计划交期',
      '系统交期',
      '备注',
      '状态',
    ]);
    expect(labels).not.toContain('批次');
  });
});

describe('详情页「序号」列（加入送货单的先后顺序）', () => {
  /** 「序号」列某行的单元格。 */
  function seqCell(wrapper: VueWrapper, rowId: string) {
    return wrapper.find(`[data-col="序号"] [data-row-id="${rowId}"]`);
  }

  it('顶层行渲染行上的 seq（散件行与装配件父行都显示）', () => {
    const parent = asmRow(3);
    const wrapper = mountTable([mkRow({ id: '999', seq: 2 }), { ...parent, seq: 1 }]);
    expect(seqCell(wrapper, 'ASM_ASM-1').text()).toBe('1');
    expect(seqCell(wrapper, '999').text()).toBe('2');
  });

  it('装配件子件行留空（编号由父行代表，不重复显示）', () => {
    // 桩 el-table 只铺顶层行，所以直接把「子件行」的形状（零件行 + 带 assembly_id）作为
    // 一行喂进去 —— 断的正是 `seqCell` 对它的判据（组件侧 deliveryNotePartRows 的排名的另一半）。
    const child = mkRow({ id: 'P:ASM-1:PA', assembly_id: 'ASM-1', seq: 0 });
    const wrapper = mountTable([child]);
    expect(seqCell(wrapper, 'P:ASM-1:PA').text()).toBe('');
  });
});

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

  it('零件行渲染「N 件」（折叠后的件数，与标签导出的单位一致）', () => {
    const wrapper = mountTable([mkRow({ id: '999', quantity: 5 })]);
    const cell = qtyCell(wrapper, '999');
    expect(cell.text()).toBe('5件');
    expect(cell.find('.muted').text()).toBe('件');
  });
});