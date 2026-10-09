// src/views/parts/detail/partBatchColumnDefs.ts
//
// 零件详情「批次监控」表 5 列 ColumnDef 工厂（批次 / 数量 / 状态 / 所在位置 / 送货单）。
// 单域专用文件，与页面主组件（`PartDetail.vue`）同层放**域根** —— `src/utils/` 只放
// 「零个域内依赖 + 多域复用」的通用工具，把本文件放进去会让 `utils/` 反向依赖
// `views/`（层次倒挂），且它只有一个消费方（`PartBatchMonitorCard.vue`）。
// 形态照 `src/views/parts/list/partsListColumnDefs.ts`（零件一览 18 列那份）与
// `src/views/inspection/inspectionColumnDefs.ts`：工厂函数接依赖、返回 `ColumnDef[]`，
// `cellRender` 闭包持传入的 helper（**函数形态**，不是值快照）。
//
// ⚠️ 「操作」列**不在**本工厂里：它受 `canManageBatches` 控制，且必须 `fixed="right"`，
// 两种形态都不进 defs（见 `PartBatchMonitorBody.vue` 里的字面量 `<el-table-column>`）。
//
// ⚠️ `useColumnVisibility` / `useColumnDrag` 两侧的持久化键是 `part_batch_monitor`，
// 列 `key` 集合不能随意改名 —— 两个 composable 都是 lenient 策略（未知 key 视为可见、
// 恢复时只覆盖 defs 里存在的 key），所以改名的后果是「用户本地存的列可见性 / 列序
// 快照失配」，而不是白屏。

import { h } from 'vue';
import { ElTag } from 'element-plus';
import type { PartBatch } from '@/api/parts';
import type { ColumnDef } from '@/composables/useColumnVisibility';
import type { OrderStatus } from '@/types/parts';

/** 工厂入参：状态标签的两个 helper，来自 `usePartDetail` 的投影。 */
export interface PartBatchColumnDefsDeps {
  /** 批次状态 → el-tag 类型（`usePartDetail.statusTagType`）。 */
  statusTagType: (s: OrderStatus) => 'primary' | 'success' | 'warning' | 'info' | 'danger';
  /** 批次状态 → 中文文案（`usePartDetail.statusLabelOf`，签名接受可空字符串）。 */
  statusLabelOf: (s: string | null | undefined) => string;
}

export function buildPartBatchColumnDefs(deps: PartBatchColumnDefsDeps): ColumnDef[] {
  const { statusTagType, statusLabelOf } = deps;

  return [
    {
      key: 'batch_label',
      label: '批次',
      minWidth: 110,
      align: 'center',
      cellRender: ({ row }) =>
        h('span', { class: 'batch-label' }, (row as PartBatch).batch_label ?? ''),
    },
    {
      key: 'quantity',
      label: '数量',
      width: 80,
      align: 'right',
      cellRender: ({ row }) => h('span', null, (row as PartBatch).quantity),
    },
    {
      key: 'status',
      label: '状态',
      minWidth: 110,
      align: 'center',
      cellRender: ({ row }) => {
        const r = row as PartBatch;
        return h(
          ElTag,
          { type: statusTagType(r.status as OrderStatus), size: 'small', effect: 'plain' },
          () => statusLabelOf(r.status),
        );
      },
    },
    {
      key: 'current_holder_display',
      label: '所在位置',
      minWidth: 130,
      align: 'center',
      showOverflowTooltip: true,
      cellRender: ({ row }) => h('span', null, (row as PartBatch).current_holder_display || '—'),
    },
    {
      key: 'delivery_note_no',
      label: '送货单',
      minWidth: 150,
      align: 'center',
      showOverflowTooltip: true,
      cellRender: ({ row }) => h('span', null, (row as PartBatch).delivery_note_no || '—'),
    },
  ];
}
