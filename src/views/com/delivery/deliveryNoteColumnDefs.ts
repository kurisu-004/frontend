// src/views/com/delivery/deliveryNoteColumnDefs.ts
//
// 送货单一览的 8 列 ColumnDef 工厂（照 src/views/cnc/pendingProgrammingColumnDefs.ts 的
// deps 注入 factory 形态：闭包不直接持有 store，便于单测与复用）。
//
// 行类型 = `deliveryNoteItemSchema` 的 z.infer（`DeliveryNoteItemData`），与 api 层
// 返回的列表行同源。
//
// ⚠️ **操作列（详情 / 送货 / 删除）不进 defs**：它不进列可见性 map（用户不能把它关掉），
// 列 key 集合因此与 2026-10-08 之前的快照完全一致 —— 见下方改名义务登记。

import { h } from 'vue';
import { ElTag } from 'element-plus';
import type { ColumnDef } from '@/composables/useColumnVisibility';
import type { DeliveryNoteStatus } from '@/types/deliveryNote';
import { DELIVERY_NOTE_STATUS_LABEL, DELIVERY_NOTE_STATUS_TAG } from '@/types/deliveryNote';
import type { DeliveryNoteItemData } from './composables/deliveryNoteSchema';

/** 行类型 = 送货单列表行。 */
export type DeliveryNoteRow = DeliveryNoteItemData;

// ============================================================================
// 列 key / 顺序的**改名义务**登记（2026-10-08）
// 本文件（与 deliveryNoteLineItemsColumnDefs.ts、deliveryNotePrintColumnDefs.ts）的
// 列可见性 / 列顺序快照 key 是 `delivery_note_list` /
// `delivery_note_detail_line_items` / `print_preview_dialog` 三个**既有** localStorage
// key（见 CLAUDE.md 列表页列设置约定）。快照里存的是「列 key 数组」：
// 改 key 会让老用户已配好的列可见性 / 列顺序整体失效（新增列无害，删列 / 改 key 有害）。
// 因此这三个文件的**列 key 与列顺序一行不许改**；真要改必须同批写 localStorage key
// 迁移（读旧 key → 按新 key 数组过滤 → 写新 key）。
//
// ⚠️ **两条例外（2026-10-08 review 第 1 轮登记，别当成漏登记）**：
//   1. `print_preview_dialog` 的列**可见性**快照沿用原 key，但**列顺序**快照改成按分组
//      分片（`print_preview_dialog__<groupKey>`，每张分组表一条序列；见
//      deliveryNotePrintColumnDefs::printColumnOrderListKey）。老版本那条单序列
//      `print_preview_dialog_columnOrder` 就此作废、**不可迁移** —— 一个序列表达不了
//      N 张表的列顺序。
//   2. 「分厂」列的 key 是老快照里的 `customer_name`（行数据字段叫 `l2_customer`，
//      渲染 / prop 取后者）。曾一度改成 `l2_customer`，等于让所有老用户这列的显隐设置
//      作废，已回滚；key ≠ prop 是这里的刻意形态。
// （2026-10-08：用 `//` 块而非 JSDoc —— 这段登记是模块级约定，不宿主于任何单个导出物；
//  写成 `/** */` 会在 IDE 里成为悬空的孤立注释。）
//
// ⚠️ **本域组件搬家的遗留注释债（2026-10-08 登记；不随本次重构清理）**：
// 本域从 `views/delivery` 搬到 `views/com/delivery`（并删掉了送货台一整套组件）之后，
// 别的域有 3 处注释仍指向**本域已删的组件**，且都只是拿它当「写法参照」引用：
//   · `src/views/inspection/__tests__/InspectionPending.spec.ts` 与
//     `src/views/inspection/InspectionPending.vue` —— 引用
//     `views/delivery/components/BatchInspectionConfirmDialog.vue`（旧目录 + 已删）
//     的「嵌套弹窗 append-to-body 范式」；
//   · `src/views/scan/components/BatchPickerDialog.vue` —— 引用
//     `views/com/delivery/PartPickerDialog`（目录对、文件已删）作为「另一种行 DTO 形态」。
// 三处都不影响行为（纯注释），而它们分属 **inspection / scan 两个域**（本域不越界改别人
// 域的注释）⇒ **随那两个域各自的下次改动一并清理**，届时改引用或删掉整句。
// ============================================================================

export function buildDeliveryNoteColumnDefs(): ColumnDef[] {
  /** 列定义注入的 slot scope 里 row 是 unknown（EP 契约），统一在函数内收窄。 */
  function row(ctx: { row: unknown }): DeliveryNoteRow {
    return ctx.row as DeliveryNoteRow;
  }

  return [
    {
      key: 'delivery_note_no',
      label: '单号',
      prop: 'delivery_note_no',
      minWidth: 180,
      align: 'center',
    },
    {
      key: 'delivery_date',
      label: '送货日期',
      minWidth: 120,
      align: 'center',
      cellRender: (ctx) => h('span', null, row(ctx).delivery_date ?? '—'),
    },
    {
      key: 'customer',
      label: '客户',
      minWidth: 130,
      align: 'center',
      cellRender: (ctx) => {
        const r = row(ctx);
        return h('span', null, r.customer_path ?? r.customer_name ?? '—');
      },
    },
    {
      key: 'status',
      label: '状态',
      minWidth: 80,
      align: 'center',
      // `status` 是 wire 上的 string（schema 不锁字面量），收窄一次再查文案表；
      // 后端新增枚举时落到 `?? r.status` 而不是渲染空白。
      cellRender: (ctx) => {
        const r = row(ctx);
        const st = r.status as DeliveryNoteStatus;
        return h(
          ElTag,
          { type: DELIVERY_NOTE_STATUS_TAG[st] || 'info', size: 'small', effect: 'plain' },
          () => DELIVERY_NOTE_STATUS_LABEL[st] ?? r.status,
        );
      },
    },
    { key: 'part_count', label: '零件数', prop: 'part_count', minWidth: 70, align: 'center' },
    {
      key: 'submitted_at',
      label: '提交时间',
      minWidth: 170,
      align: 'center',
      cellRender: (ctx) => {
        const v = row(ctx).submitted_at;
        return h('span', null, v ? new Date(v).toLocaleString() : '—');
      },
    },
    {
      key: 'picked_up_at',
      label: '领取时间',
      minWidth: 170,
      align: 'center',
      cellRender: (ctx) => {
        const v = row(ctx).picked_up_at;
        return h('span', null, v ? new Date(v).toLocaleString() : '—');
      },
    },
    {
      key: 'driver_worker_name',
      label: '司机',
      prop: 'driver_worker_name',
      minWidth: 80,
      align: 'center',
      cellRender: (ctx) => h('span', null, row(ctx).driver_worker_name ?? '—'),
    },
  ];
}

/** 列可见性 / 列顺序的 localStorage key（沿用 2026-10-08 之前的既有值，**不许改**）。 */
export const DELIVERY_NOTE_LIST_KEY = 'delivery_note_list';