// src/views/com/delivery/deliveryNoteLineItemsColumnDefs.ts
//
// 详情页「零件列表」的 13 列 ColumnDef 工厂（deps 注入形态，同
// src/views/com/delivery/deliveryNoteColumnDefs.ts）。
//
// 列可见性 / 列顺序快照 key = `delivery_note_detail_line_items`（既有值，**不许改** ——
// 改名义务登记见 deliveryNoteColumnDefs.ts 顶部的 `//` 块）。
//
// 行的形态是 `AssemblyTreeRow`（装配件父行 + 散件行摊平成一行一形态），由
// `useDeliveryNoteDetail.treeLineItems` 派生。父行的 `is_asm_row` 标记让「批次 /
// 名称 / 数量 / 状态」四列走两套渲染。

import { h, type VNode } from 'vue';
import { ElTag } from 'element-plus';
import { RouterLink } from 'vue-router';
import type { ColumnDef } from '@/composables/useColumnVisibility';
import type { OrderStatus } from '@/types/parts';
import { ORDER_STATUS_LABEL, ORDER_STATUS_TAG_TYPE } from '@/types/parts';
import type { DeliveryNoteLineItemData } from './composables/deliveryNoteSchema';
import type { AssemblyTreeRow } from './composables/useDeliveryNoteDetail';

/** 行类型 = 详情页树形行（装配件父行 + 行项）。 */
export type DeliveryNoteLineItemRow = AssemblyTreeRow;

/** 列可见性 / 列顺序的 localStorage key（既有值，**不许改**）。 */
export const DELIVERY_NOTE_LINE_ITEMS_LIST_KEY = 'delivery_note_detail_line_items';

export function buildDeliveryNoteLineItemsColumnDefs(): ColumnDef[] {
  function row(ctx: { row: unknown }): AssemblyTreeRow {
    return ctx.row as AssemblyTreeRow;
  }

  function renderBatchLabel(ctx: { row: unknown }): VNode {
    const r = row(ctx);
    return h('span', null, r.is_asm_row ? '—' : (r.batch_label ?? '—'));
  }

  function renderName(ctx: { row: unknown }): VNode {
    const r = row(ctx);
    if (r.is_asm_row) {
      return h('div', null, [
        h(ElTag, { type: 'warning', size: 'small', class: 'asm-tag' }, () => '装配件'),
        // h() 传字符串 type 不做组件解析（会渲染成字面 <router-link> 自定义元素，
        // 函数 children 也被当 slots 丢掉 → 空白）——必须传导入的 RouterLink 组件。
        h(RouterLink, { to: `/assemblies/${r.assembly_id}`, class: 'assembly-link' }, () => r.name),
      ]);
    }
    return h('span', null, r.name);
  }

  function renderQuantity(ctx: { row: unknown }): VNode {
    const r = row(ctx);
    if (r.is_asm_row) {
      // 父行数量 = 本单可出货套数（后端算，与打印对话框同源同值）；后端没给数时
      // null → 渲染「—」。**不可兜成 0**（「没给数」与「凑不齐整套」业务含义相反）。
      // 单位随数走：没数就没有单位，否则渲染成「— 套」。
      return h('div', null, [
        h('strong', null, r.quantity ?? '—'),
        r.quantity !== null ? h('span', { class: 'muted' }, '套') : null,
      ]);
    }
    // 散件行的 quantity 必填 number，没有缺失态，所以不写 `?? '—'`。
    return h('span', null, (ctx.row as DeliveryNoteLineItemData).quantity);
  }

  function renderStatus(ctx: { row: unknown }): VNode {
    const r = row(ctx);
    if (r.is_asm_row) return h('span', null, '—');
    const st = r.status as OrderStatus;
    return h(ElTag, { type: ORDER_STATUS_TAG_TYPE[st] ?? 'info', effect: 'plain', size: 'small' }, () =>
      ORDER_STATUS_LABEL[st] ?? String(r.status),
    );
  }

  // 字段顺序 = 初始渲染顺序，**顺序与 key 一行未改**（见改名义务登记）。
  return [
    { key: 'batch_label', label: '批次', minWidth: 100, sortable: true, align: 'center', cellRender: renderBatchLabel },
    {
      key: 'serial_no',
      label: '序列号',
      prop: 'serial_no',
      minWidth: 120,
      sortable: true,
      align: 'center',
      cellRender: (ctx) =>
        h('span', { class: { muted: !row(ctx).serial_no } }, row(ctx).serial_no || '—'),
    },
    { key: 'drawing_no', label: '图号', prop: 'drawing_no', minWidth: 140, sortable: true, align: 'center' },
    {
      key: 'order_no',
      label: '订单号',
      prop: 'order_no',
      minWidth: 120,
      showOverflowTooltip: true,
      sortable: true,
      align: 'center',
      cellRender: (ctx) => h('span', null, row(ctx).order_no || '—'),
    },
    { key: 'name', label: '名称', minWidth: 200, sortable: true, align: 'center', cellRender: renderName },
    {
      key: 'customer',
      label: '客户（二级）',
      prop: 'customer_name',
      minWidth: 160,
      showOverflowTooltip: true,
      sortable: true,
      align: 'center',
      cellRender: (ctx) => {
        const r = row(ctx);
        return h('span', null, r.customer_path ?? r.customer_name ?? '—');
      },
    },
    {
      key: 'applicant_name',
      label: '申请人',
      prop: 'applicant_name',
      minWidth: 100,
      sortable: true,
      align: 'center',
      cellRender: (ctx) => h('span', null, row(ctx).applicant_name || '—'),
    },
    { key: 'quantity', label: '数量', minWidth: 80, sortable: true, align: 'center', cellRender: renderQuantity },
    {
      key: 'request_date',
      label: '请购日期',
      minWidth: 120,
      align: 'center',
      cellRender: (ctx) => h('span', null, row(ctx).request_date || '—'),
    },
    {
      key: 'planned_delivery_date',
      label: '计划交期',
      prop: 'planned_delivery_date',
      minWidth: 120,
      sortable: true,
      align: 'center',
      cellRender: (ctx) => h('span', null, row(ctx).planned_delivery_date || '—'),
    },
    {
      key: 'system_delivery_date',
      label: '系统交期',
      prop: 'system_delivery_date',
      minWidth: 120,
      sortable: true,
      align: 'center',
      cellRender: (ctx) => h('span', null, row(ctx).system_delivery_date || '—'),
    },
    {
      key: 'note',
      label: '备注',
      minWidth: 120,
      showOverflowTooltip: true,
      align: 'center',
      cellRender: (ctx) => h('span', null, row(ctx).note || '—'),
    },
    { key: 'status', label: '状态', minWidth: 120, align: 'center', cellRender: renderStatus },
  ];
}