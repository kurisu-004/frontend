// src/views/com/delivery/utils/deliveryNotePartRows.ts
//
// 2026-10-09 新增：**零件 / 装配件行的唯一事实源**。
//
// 后端 `line_items[]` 每一项 = 一个**批次**（26 字段）；同一张送货单上同一个零件常被拆成
// 多个批次，同一个零件也可能同时是某个装配件的子件。三处消费方（草稿卡片预览表、详情页
// 零件列表、标签导出行）都要「按零件而不是按批次」看这张单，于是行形（折叠 + 装配件树 +
// 打印映射）只在这里实现一次，三处共用。
//
// 纯函数，不 import Vue / EP（便于单测，也避免打印链路的交互态渗进行形计算）。
//
// 三个口径决策：
// - **折叠键 = (assembly_id, part_id)**：同一零件既作散件、又作装配件子件时是两条不同的
//   行（业务上确实是两笔货），所以键必须带装配件维度。
// - **顺序保输入序**：详情页传入的是**已按客户端排序列**的数组（排序在 `sortedLineItems`
//   做），折叠不得自行重排，否则表头排序会被静默还原。
// - **代表批次取首个**：展示字段（序列号 / 名称 / 图号 / 订单号 / 申请人 / 客户 / 日期 /
//   状态）沿用草稿卡片折叠的既有口径取首个批次，只有系统交期取首个非空。

import { shippableSetsOfGroup } from './assemblySets';
import type { DeliveryNoteLineItemData } from '../composables/deliveryNoteSchema';
import type { PrintRow } from './deliveryNotePrintRows';

/** 零件 / 装配件表格的一行（el-table tree-props 数据源）。 */
export interface PartTreeRow {
  /**
   * 稳定 row-key：装配件父行 `ASM_<assembly_id>`，零件行 `P:<assembly_id|->:<part_id>`。
   *
   * 零件行 id **不能是批次 id**：`reserve-selection` 按 row-key 记保留集，同一零件被拆成
   * 多个批次时只有「按零件的稳定 key」才是一行；批次 id 前缀是裸数字，`P:` 前缀保证两类
   * key 永不相撞。
   */
  id: string;
  /** 装配件父行（纯展示行，单位「套」）。 */
  is_asm_row?: boolean;
  /** 零件行（散件与装配件子件都是它，单位「件」）。 */
  is_part_row?: boolean;
  /** 仅装配件父行：有 children，EP 用它决定是否渲染展开箭头。 */
  has_children?: boolean;
  /** 装配件父行的子件行。 */
  children?: PartTreeRow[];
  /**
   * 零件行 = 该零件在本单各批次数量之和；装配件父行 = 本单可出货套数。
   *
   * ⚠️ **null 不兜 0**：「后端没给可出货套数」与「真的凑不齐整套」业务含义相反（口径见
   * utils/assemblySets），兜 0 会让用户以为这单打不了整套。
   */
  quantity: number | null;
  /** 装配件父行「套」，零件行「件」（后端行项无单位字段，只能前端按行性质推导）。 */
  unit: string;
  /** 该行代表的全部批次 id（移除 / 已打印标签标记 / 标签行成员都用它）。 */
  batch_ids: string[];
  /** 任一批次已在 usePrintedLabels 登记为已打印（绿底判据）。 */
  label_printed: boolean;
  // —— 代表批次（装配件父行取 assembly_*，缺失时回落首个子件）的展示字段 ——
  serial_no: string;
  drawing_no: string;
  name: string;
  order_no: string;
  applicant_name: string;
  note: string;
  customer_name: string;
  customer_path: string;
  request_date: string | null;
  planned_delivery_date: string | null;
  system_delivery_date: string | null;
  status: string;
  part_id: string;
  assembly_id: string | null;
  assembly_serial_no: string | null;
  assembly_drawing_no: string | null;
  assembly_name: string | null;
  assembly_order_no: string | null;
  /** 装配件工单总套数（与本单无关的对照值）。 */
  assembly_quantity: number | null;
  /** 本单可出货套数（note 级聚合值，组内各行同值）。 */
  shippable_sets: number | null;
}

/** 行项上的 assembly_id 后端是 `Option` + skip_serializing_if ⇒ 可能 undefined。 */
function asmIdOf(li: DeliveryNoteLineItemData): string | null {
  return li.assembly_id ?? null;
}

/** 零件行 id：装配件 id 用 `-` 占位（散件），保证 key 全表唯一且不与批次 id 相撞。 */
function partRowId(assemblyId: string | null, partId: string): string {
  return `P:${assemblyId ?? '-'}:${partId}`;
}

/** 同一 (assembly_id, part_id) 的多批次折叠为一条零件行。 */
function foldPartRows(
  items: readonly DeliveryNoteLineItemData[],
  isPrinted: (batchId: string) => boolean,
): PartTreeRow[] {
  const folded = new Map<string, PartTreeRow>();
  const order: string[] = [];
  for (const li of items) {
    const assemblyId = asmIdOf(li);
    const key = `${assemblyId ?? '-'}::${li.part_id}`;
    const batchId = String(li.id);
    const printed = isPrinted(batchId);
    const cur = folded.get(key);
    if (cur) {
      // 数量必填 number（schema 的 z.number()），累加不会遇到 null。
      cur.quantity = (cur.quantity as number) + li.quantity;
      cur.batch_ids.push(batchId);
      // 绿底取 any 口径：同零件拆出的批次里只要有一个打过标签，整行就该提示「打过」。
      if (!cur.label_printed && printed) cur.label_printed = true;
      if (!cur.system_delivery_date && li.system_delivery_date) {
        cur.system_delivery_date = li.system_delivery_date;
      }
      continue;
    }
    folded.set(key, {
      id: partRowId(assemblyId, li.part_id),
      is_part_row: true,
      quantity: li.quantity,
      unit: '件',
      batch_ids: [batchId],
      label_printed: printed,
      serial_no: li.serial_no,
      drawing_no: li.drawing_no,
      name: li.name,
      order_no: li.order_no ?? '',
      applicant_name: li.applicant_name ?? '',
      customer_name: li.customer_name ?? '',
      customer_path: li.customer_path ?? '',
      request_date: li.request_date,
      planned_delivery_date: li.planned_delivery_date,
      system_delivery_date: li.system_delivery_date,
      status: li.status,
      part_id: li.part_id,
      assembly_id: assemblyId,
      assembly_serial_no: li.assembly_serial_no,
      assembly_drawing_no: li.assembly_drawing_no,
      assembly_name: li.assembly_name,
      assembly_order_no: li.assembly_order_no,
      assembly_quantity: li.assembly_quantity ?? null,
      shippable_sets: li.shippable_sets ?? null,
      note: li.note ?? '',
    });
    order.push(key);
  }
  return order.map((k) => folded.get(k)!);
}

/**
 * 装配件父行：展示值取 `assembly_*`（缺失时回落首个子件），数量取本单可出货套数
 * （`shippableSetsOfGroup`），批次 / 绿底由子件行汇总。
 *
 * `request_date` 恒 null：父行是聚合展示，没有「这张单什么时候请购」这一个事实
 * （子件各自有各自的请购日期）。
 */
function buildAsmParentRow(assemblyId: string, children: PartTreeRow[]): PartTreeRow {
  const first = children[0]!;
  return {
    id: `ASM_${assemblyId}`,
    is_asm_row: true,
    has_children: true,
    children,
    quantity: shippableSetsOfGroup(children),
    unit: '套',
    batch_ids: children.flatMap((c) => c.batch_ids),
    label_printed: children.some((c) => c.label_printed),
    serial_no: first.assembly_serial_no ?? '',
    drawing_no: first.assembly_drawing_no ?? first.drawing_no,
    name: first.assembly_name ?? first.name,
    order_no: first.assembly_order_no ?? first.order_no,
    applicant_name: first.applicant_name,
    customer_name: first.customer_name,
    customer_path: first.customer_path,
    request_date: null,
    planned_delivery_date: first.planned_delivery_date,
    // 子件行的系统交期已经是「组内首个非空」，父行直接沿用首个子件的值。
    system_delivery_date: first.system_delivery_date,
    status: first.status,
    part_id: '',
    assembly_id: assemblyId,
    assembly_serial_no: first.assembly_serial_no,
    assembly_drawing_no: first.assembly_drawing_no,
    assembly_name: first.assembly_name,
    assembly_order_no: first.assembly_order_no,
    assembly_quantity: first.assembly_quantity,
    shippable_sets: first.shippable_sets,
    note: '',
  };
}

/**
 * 行项数组 → 零件 / 装配件树行（散件与装配件父行摊平成顶层一行一形态）。
 *
 * @param items    行项数组；**顺序即最终行序**（详情页传的是已排序的数组）
 * @param isPrinted 批次 id → 是否已打印标签（绿底）
 */
export function buildPartTreeRows(
  items: readonly DeliveryNoteLineItemData[],
  isPrinted: (batchId: string) => boolean,
): PartTreeRow[] {
  const folded = foldPartRows(items, isPrinted);

  // 同一 assembly_id 的零件行归到一个装配件父行下。
  const asmGroups = new Map<string, PartTreeRow[]>();
  for (const row of folded) {
    if (!row.assembly_id) continue;
    const arr = asmGroups.get(row.assembly_id) ?? [];
    arr.push(row);
    asmGroups.set(row.assembly_id, arr);
  }

  // 父行插在它的首个子件所在位置（不重排），散件行原位透传。
  const result: PartTreeRow[] = [];
  const inserted = new Set<string>();
  for (const row of folded) {
    const assemblyId = row.assembly_id;
    if (!assemblyId) {
      result.push(row);
      continue;
    }
    if (inserted.has(assemblyId)) continue;
    inserted.add(assemblyId);
    result.push(buildAsmParentRow(assemblyId, asmGroups.get(assemblyId) ?? []));
  }
  return result;
}

/**
 * 零件 / 装配件行 → 标签打印行（`PrintRow`）。
 *
 * 字段映射对两类行**同形**：展示值都已在 `buildPartTreeRows` 里归一（父行展示的是
 * `assembly_*`，缺失回落首个子件），所以这里直接读行字段；两种单位与数量口径已在行上
 * 定死（零件「件」= 批次数量之和，装配件「套」= 本单可出货套数，null 不兜 0）。
 *
 * `member_ids` 给的是**整行 batch_ids**：折叠行代表同零件的多个批次，只登记代表批次
 * 会让该行其余批次永远不绿。`quantity === null` 的行**不在这里过滤** ——
 * `renderDeliveryNoteLabelWorkbook` 会整行跳过并回 `skipped` 计数，toast 据实说明跳过条数。
 */
export function partRowsToLabelRows(rows: readonly PartTreeRow[]): PrintRow[] {
  return rows.map((r) => ({
    id: r.id,
    order_no: r.order_no,
    l2_customer: r.customer_name,
    applicant_name: r.applicant_name,
    drawing_no: r.drawing_no,
    name: r.name,
    quantity: r.quantity,
    unit: r.unit,
    system_delivery_date: r.system_delivery_date,
    // 标签是贴到零件上的小纸条，没有「送货单备注」这层，逐行留空。
    note: '',
    member_ids: [...r.batch_ids],
    assembly_quantity: r.assembly_quantity,
    // 装配件父行才带这个标记（零件行不设，避免被下游按「是装配件」分支处理）。
    ...(r.is_asm_row ? { is_asm_row: true } : {}),
  }));
}