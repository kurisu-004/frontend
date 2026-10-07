// src/views/com/delivery/deliveryNotePrintColumnDefs.ts
//
// 打印送货单对话框的 8 列 ColumnDef 工厂（deps 注入形态，同
// src/views/com/delivery/deliveryNoteColumnDefs.ts）。
//
// 列可见性快照 key = `print_preview_dialog`（既有值，**不许改** —— 改名义务登记见
// deliveryNoteColumnDefs.ts 顶部的 `//` 块）。「分厂」列的 key 是 `customer_name`
// （**不是** 行数据字段 `l2_customer`）：该 key 是老版本对话框写进快照的老名字，
// 改名等于让所有老用户「分厂」列的显隐设置作废。渲染不依赖 key —— cellRender 从
// `PrintRow.l2_customer` 取值，`prop` 也给的是 `l2_customer`（EP 排序按它）。
//
// 列**顺序**快照按分组分片：`print_preview_dialog__<groupKey>`（每张分组表一条序列，
// 见 `printColumnOrderListKey`）。老版本的单序列 `print_preview_dialog_columnOrder`
// 就此作废、不可迁移（一个序列表达不了 N 张表的列顺序）。
//
// **数量列与「拆分」操作列不进 defs**：两者的渲染都带行内交互（拆分态展开多个数字
// 输入、装配件父行的只读套数 + tooltip），走 cellRender 表达不了；同时它们不进列可见性
// map（用户不能把「数量」关掉）。

import { h, type VNode } from 'vue';
import { ElTag } from 'element-plus';
import { Rank } from '@element-plus/icons-vue';
import type { ColumnDef } from '@/composables/useColumnVisibility';
import type { PrintRow } from './utils/deliveryNotePrintRows';
import { formatDeliveryMonthDay } from '@/utils/deliveryDate';

export type PrintPreviewRow = PrintRow;

/** 列可见性的 localStorage key（既有值，**不许改**）。 */
export const PRINT_PREVIEW_LIST_KEY = 'print_preview_dialog';

/** 列顺序快照 key：按分组分片（每张分组表一条独立序列）。
 *
 *  ⚠️ groupKey 里含分组 id（`g_<gid>` / `c_<l2id>` / 兜底 `c_cid_<id>` / `c_named_<名>`）
 *  ⇒ 分组规则一改，快照 key 就换新（顺序回默认）。这是有意的：把旧分组的列顺序套到新分组上
 *  没有意义，而 localStorage 里的孤儿键体积只有几十字节。 */
export function printColumnOrderListKey(groupKey: string): string {
  return `${PRINT_PREVIEW_LIST_KEY}__${groupKey}`;
}

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

  // 字段顺序 = 初始渲染顺序。**key 与顺序都是快照契约**（见文件头）：
  // 「分厂」列的 key 是老快照里的 `customer_name`，渲染值取 `l2_customer`。
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
      key: 'customer_name',
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
      // 展示走 `M月D日`（与导出的送货单一致），排序仍读 `prop` 的 ISO 原值 ——
      // 排序若也按格式化后的串走会跨月错序（`12月1日` 排在 `2月1日` 前）。
      cellRender: ({ row: r }) => h('span', null, formatDeliveryMonthDay(row(r).system_delivery_date) || '—'),
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