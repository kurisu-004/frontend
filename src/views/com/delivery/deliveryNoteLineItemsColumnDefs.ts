// src/views/com/delivery/deliveryNoteLineItemsColumnDefs.ts
//
// 详情页「零件列表」的 12 列 ColumnDef 工厂（deps 注入形态，同
// src/views/com/delivery/deliveryNoteColumnDefs.ts）。
//
// 列可见性 / 列顺序快照 key = `delivery_note_detail_line_items`（既有值，**不许改** ——
// 改名义务登记见 deliveryNoteColumnDefs.ts 顶部的 `//` 块）。
//
// 行的形态是 `PartTreeRow`（装配件父行 + 零件行摊平成一行一形态），由
// `useDeliveryNoteDetail.treeLineItems` 派生。父行的 `is_asm_row` 标记让「名称 / 数量 /
// 状态」三列走两套渲染。
//
// 2026-10-09 列集合变化：
// - 删 `batch_label`（批次号不再单列）：行是零件级折叠，一行可能代表同零件的多个批次，
//   单列批次号对不上「这一行的量」，展示成 N 个批次号反而误导。
// - 图号 / 名称补 `showOverflowTooltip`（长图号按 `overflow-wrap: break-word` 折行，
//   排版被拉成两段）；EP 只在该列开了 `show-overflow-tooltip` 时才给 `.cell` 加
//   `el-tooltip` 类，那个类才是 `white-space: nowrap` + ellipsis。
// - 申请人 / 数量 / 计划交期 / 系统交期四列加宽：表头「列名 + 列拖动手柄(18px) +
//   排序箭头(24px) + .cell 左右 padding(24px)」在原宽度下超过可用宽度，而 EP 的 `.cell`
//   是 `white-space: normal` ⇒ 排序箭头折行。`src/styles/index.scss` 另有 `nowrap` 兜底，
//   两处一起改：加宽让文案不挤，nowrap 兜住更窄的窗口。

import { h, type VNode } from 'vue';
import { ElTag } from 'element-plus';
import { RouterLink } from 'vue-router';
import type { ColumnDef } from '@/composables/useColumnVisibility';
import type { OrderStatus } from '@/types/parts';
import { ORDER_STATUS_LABEL, ORDER_STATUS_TAG_TYPE } from '@/types/parts';
import type { PartTreeRow } from './utils/deliveryNotePartRows';

/** 行类型 = 详情页树形行（装配件父行 + 零件行）。 */
export type DeliveryNoteLineItemRow = PartTreeRow;

/** 列可见性 / 列顺序的 localStorage key（既有值，**不许改**）。 */
export const DELIVERY_NOTE_LINE_ITEMS_LIST_KEY = 'delivery_note_detail_line_items';

export function buildDeliveryNoteLineItemsColumnDefs(): ColumnDef[] {
  function row(ctx: { row: unknown }): PartTreeRow {
    return ctx.row as PartTreeRow;
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
    // 单位随数走：没数就没有单位（渲染成「— 套」会被读成「凑不齐整套、打不了」）。
    // 装配件「套」/ 零件「件」，两个出口都与标签导出的单位一致。
    return h('div', null, [
      h('strong', null, r.quantity ?? '—'),
      r.quantity !== null ? h('span', { class: 'muted' }, r.unit) : null,
    ]);
  }

  function renderStatus(ctx: { row: unknown }): VNode {
    const r = row(ctx);
    if (r.is_asm_row) return h('span', null, '—');
    const st = r.status as OrderStatus;
    return h(ElTag, { type: ORDER_STATUS_TAG_TYPE[st] ?? 'info', effect: 'plain', size: 'small' }, () =>
      ORDER_STATUS_LABEL[st] ?? String(r.status),
    );
  }

  // 字段顺序 = 初始渲染顺序（顺序快照的变更登记见 deliveryNoteColumnDefs.ts 顶部）。
  return [
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
    {
      key: 'drawing_no',
      label: '图号',
      prop: 'drawing_no',
      minWidth: 160,
      showOverflowTooltip: true,
      sortable: true,
      align: 'center',
    },
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
    { key: 'name', label: '名称', minWidth: 200, showOverflowTooltip: true, sortable: true, align: 'center', cellRender: renderName },
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
      minWidth: 140,
      sortable: true,
      align: 'center',
      cellRender: (ctx) => h('span', null, row(ctx).applicant_name || '—'),
    },
    { key: 'quantity', label: '数量', minWidth: 110, sortable: true, align: 'center', cellRender: renderQuantity },
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
      minWidth: 140,
      sortable: true,
      align: 'center',
      cellRender: (ctx) => h('span', null, row(ctx).planned_delivery_date || '—'),
    },
    {
      key: 'system_delivery_date',
      label: '系统交期',
      prop: 'system_delivery_date',
      minWidth: 140,
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