// src/views/com/delivery/deliveryNotePrintColumnDefs.ts
//
// 打印送货单对话框的 6 列 ColumnDef 工厂（deps 注入形态，同
// src/views/com/delivery/deliveryNoteColumnDefs.ts）。
//
// 列可见性 / 列顺序快照 key = `print_preview_dialog`（既有值，**不许改** —— 改名义务
// 登记见 deliveryNoteColumnDefs.ts 顶部的 `//` 块）。
//
// **数量列与「拆分」操作列不进 defs**：两者的渲染都带行内交互（拆分态展开多个数字
// 输入、装配件父行的只读套数 + tooltip），走 cellRender 表达不了；同时它们不进列可见性
// map（用户不能把「数量」关掉）。

import { h, type VNode } from 'vue';
import { ElTag } from 'element-plus';
import { Rank } from '@element-plus/icons-vue';
import type { ColumnDef } from '@/composables/useColumnVisibility';
import type { PrintRow } from './utils/deliveryNotePrintRows';

export type PrintPreviewRow = PrintRow;

/** 列可见性 / 列顺序的 localStorage key（既有值，**不许改**）。 */
export const PRINT_PREVIEW_LIST_KEY = 'print_preview_dialog';

export function buildDeliveryNotePrintColumnDefs(): ColumnDef[] {
  /** ColumnDef 注入的 slot scope 里 row 是 unknown（EP 契约），统一在函数内收窄。 */
  function row(r: unknown): PrintRow {
    return r as PrintRow;
  }

  /** 序号列：行拖手柄 `.drag-handle`（vue-draggable-plus 行拖的 handle 选择器）
   *  + 行序号。cellRender 必须返回单个 VNode，行内多根包 <div>。 */
  function renderIndex({ row: r, $index }: { row: unknown; $index: number }): VNode {
    void r;

    return h('div', null, [
      h('span', { class: 'drag-handle', title: '拖动排序' }, h(Rank)),
      h('span', { class: 'row-index' }, $index + 1),
    ]);
  }

  function renderName({ row: r }: { row: unknown }): VNode {
    const p = row(r);
    if (p.is_asm_row) {
      return h('div', null, [
        h(ElTag, { type: 'warning', size: 'small', class: 'asm-tag' }, () => '装配件'),
        h('span', null, p.name),
      ]);
    }
    return h('span', null, p.name);
  }

  // 字段顺序 = 初始渲染顺序，**顺序与 key 一行未改**（见改名义务登记）。
  return [
    { key: 'index', label: '序号', width: 72, align: 'center', cellRender: renderIndex },
    {
      key: 'order_no',
      label: '订单号',
      prop: 'order_no',
      minWidth: 120,
      sortable: true,
      showOverflowTooltip: true,
      align: 'center',
      cellRender: ({ row: r }) => h('span', null, row(r).order_no || '—'),
    },
    {
      key: 'l2_customer',
      label: '分厂',
      prop: 'l2_customer',
      minWidth: 140,
      sortable: true,
      showOverflowTooltip: true,
      align: 'center',
      cellRender: ({ row: r }) => h('span', null, row(r).l2_customer || '—'),
    },
    {
      key: 'applicant_name',
      label: '申请人',
      prop: 'applicant_name',
      minWidth: 100,
      sortable: true,
      align: 'center',
      cellRender: ({ row: r }) => h('span', null, row(r).applicant_name || '—'),
    },
    {
      key: 'drawing_no',
      label: '编码',
      prop: 'drawing_no',
      minWidth: 130,
      sortable: true,
      align: 'center',
      cellRender: ({ row: r }) => h('span', null, row(r).drawing_no || '—'),
    },
    { key: 'name', label: '名称', minWidth: 180, sortable: true, align: 'center', cellRender: renderName },
    {
      key: 'system_delivery_date',
      label: '预估交期',
      prop: 'system_delivery_date',
      minWidth: 110,
      sortable: true,
      align: 'center',
      cellRender: ({ row: r }) => h('span', null, row(r).system_delivery_date || '—'),
    },
    {
      key: 'note',
      label: '备注',
      prop: 'note',
      minWidth: 140,
      align: 'center',
      cellRender: ({ row: r }) => h('span', null, row(r).note || '—'),
    },
  ];
}