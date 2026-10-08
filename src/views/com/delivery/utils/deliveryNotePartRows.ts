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
//
// —— 2026-10-10 新增「序号」：**唯一的例外字段，与「代表批次取首个」口径相反** ——
// `seq`（显示值）与 `min_seq`（排名依据）都取**组内最小**的 `delivery_seq`，不是首个批次：
//   · 折成一行的是**同一零件的多个批次**，它们各自的入单时刻不同，「这一行代表这个零件第几
//     个入单」的自然答案是**最早**那一笔，与当前数组顺序无关；
//   · 若沿用「代表批次取首个」，序号会随**当前的客户端排序**漂移（按状态排一次、按数量再排
//     一次，同一行上的序号就变了），而序号必须是「加入送货单的先后顺序」这一稳定事实；
//   · `min` 是**顺序无关**的聚合，用户怎么排序都不影响它。
// 排名（稠密名次）与降级口径见 `buildPartTreeRows` 末尾的 `assignSeq`。
//
// ⚠️ 折叠带来的两个展示副作用（2026-10-09 明确记录，勿当 bug 修）：
// - **客户端排序会改变同一折叠行的展示值**。折叠代表批次取**首个**，所以按状态 / 计划交期
//   / 申请人排序会重排批次序列，进而改掉折叠行上显示的那个值；只有「数量」与「序号」是两处
//   例外（数量 = 求和、序号 = 组内 min，都不随排序变）。
// - **按数量排序比较的是批次值，展示的是求和值**。折叠行的数量 = 同零件各批次数量之和，
//   而排序走的是单批次数量 ⇒ 排出来的名次与列上显示的数字不完全对应。

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
  /**
   * 绿底判据，**零件行取 any / 装配件父行取 all**（2026-10-09 统一，全仓两张表共用）：
   * - 零件行 = `batch_ids` 里**任一**批次已在 usePrintedLabels 登记为已打印；
   * - 装配件父行 = `batch_ids` **全部**批次都已打印。打印父行会把全部子件批次一起标记上，
   *   所以整套打完父行就该绿；只打了某一个子件时父行不该绿（子件行绿就够了）。
   *
   * ⚠️ **父行的 all 建立在子件行的 any 之上**（用户可见的自觉口径）：父行判据是
   * `children.every(c => c.label_printed)`，而子件行自身是 any ⇒ 同一子件零件被拆成多个
   * 批次时，只要其中一批打过标签，该子件行就算已打印；此时即使它还有另一批没打，父行也会绿。
   */
  label_printed: boolean;
  // —— 「序号」列（2026-10-10 新增，按加入送货单的先后顺序）——
  /**
   * 「序号」列的显示值：**按 `min_seq` 升序去重后的稠密名次** 1..N，同一 `min_seq` 的多行
   * 共享同一名次（装配件父行与它所属的散件 / 另一组零件都可能是同一个最早入单批次）。
   *
   * 写 `min_seq` 的原值是**不行的**：摘掉中间一行后原值会留下空洞（显示成 `1,2,4,5`），
   * 名次则是恒为 `1..N` 的连续编号。
   *
   * 由 `buildPartTreeRows` 末尾统一写入 —— 折叠 / 归组阶段该字段是占位值 0，不是有效值。
   */
  seq: number;
  /**
   * 排名依据 = **本行代表的全部批次里最小的 `delivery_seq`**（装配件父行取子件的最小值）。
   *
   * `null` = 该行全部批次都没有 `delivery_seq`（历史数据未回填 / 后端尚未上线该列）。它**只
   * 作为排名依据存在**，不直接显示；`seq` 由它在全体行里换算而来。
   */
  min_seq: number | null;
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

/**
 * 两值取小，**null 当「没有值」而不是「最小值」**：已有值为 null 而新批次有值时必须取新值
 * （混合态 = 部分批次已回填 / 后端刚上线）。
 */
function minSeq(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
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
      // 序号取组内**最小** delivery_seq（不是代表批次那个）—— 顺序无关，用户怎么排序都不漂移。
      cur.min_seq = minSeq(cur.min_seq, li.delivery_seq ?? null);
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
      min_seq: li.delivery_seq ?? null,
      // 占位：`seq` 要等全体行折叠 / 归组完成后才能排名（`buildPartTreeRows` 末尾的
      // `assignSeq` 覆写它）⇒ 行形内部在那一行之前**不得读** `seq`。
      seq: 0,
      note: li.note ?? '',
    });
    order.push(key);
  }
  return order.map((k) => folded.get(k)!);
}

/**
 * 装配件父行：展示值取 `assembly_*`（缺失时回落首个子件），数量取本单可出货套数
 * （`shippableSetsOfGroup`），批次由子件行汇总、绿底取 **all**（见 `PartTreeRow`）。
 *
 * `children` 恒非空：父行只由 `buildPartTreeRows` 从已折叠的零件行归组建出来，一个都没有
 * 就不会产生父行 ⇒ `[].every(...) === true` 的空数组语义不会在这里被误当成「已打印」。
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
    label_printed: children.every((c) => c.label_printed),
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
    // 父行代表整套货 ⇒ 它的最早入单时刻 = 子件里最早的那笔（子件各自已 min 过）。
    min_seq: children.reduce<number | null>((acc, c) => minSeq(acc, c.min_seq), null),
    // 同上：占位，由 `assignSeq` 覆写。
    seq: 0,
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
  assignSeq(result);
  return result;
}

/**
 * 就地写每行的 `seq`（「序号」列显示值）：把 `min_seq` 升序去重后编成 **1..N 的稠密名次**。
 *
 * 为什么用**稠密名次**而不是直接显示原始 `delivery_seq`：`remove-batches` 摘掉中间一行后
 * `delivery_seq` 会留下空洞，用户看到的是 `1,2,4,5` —— 那个 4 不是「第 4 行」，只是「第 4 个
 * 入单的批次」。名次恒为 `1..N` 连续编号，与「这是本单第几行」这个用户认知一致。
 *
 * 排名依据是 `min_seq` 的**值**而不是行序，所以 `min_seq` 相同的两行（折叠掉的同批批次、
 * 或装配件父行与某个散件恰好同批入单）共享同一序号；用户按别的列排序也不会改动任何序号。
 *
 * `min_seq` 为 null 的行（历史数据 / 后端尚未上线该列）：**编号**排在所有有值行之后、按当前
 * 行序续号（⚠️ 行本身**不移动** —— 续号只影响显示值；用户按别的列排序后 null 行的号会落在
 * 中间，如 `[有值, null, 有值] → 1, 3, 2`，撞号不会发生，tail 从 `values.length` 起恒大于
 * 任一名次）；**全表皆 null 时这条规则退化成数组下标 + 1**，即那时的默认显示序（后端返回的顺序）。
 *
 * 只对**顶层行**排名（散件行 + 装配件父行）：装配件的子件行嵌在父行的 `children` 里，
 * 它们在树里不是独立的一行，序号由父行代表。
 */
function assignSeq(rows: readonly PartTreeRow[]): void {
  const values = [...new Set(rows.flatMap((r) => (r.min_seq === null ? [] : [r.min_seq])))].sort(
    (a, b) => a - b,
  );
  const rankByValue = new Map<number, number>();
  for (const v of values) rankByValue.set(v, rankByValue.size + 1);

  let tail = values.length;
  for (const row of rows) {
    const rank = row.min_seq === null ? undefined : rankByValue.get(row.min_seq);
    row.seq = rank ?? ++tail;
  }
}

/**
 * 「序号」列的单元格文本（**两张零件表共用的唯一出口**：详情页零件列表 / 草稿卡片预览表）。
 *
 * 只有**顶层行**（散件行 + 装配件父行）有编号 —— 装配件子件行嵌在父行的 `children` 里，
 * 是那个编号所指的那一行的一部分，自己再显示一个号会被读成「重复的一行」，故留空。
 *
 * 判据用**行结构**（子件行 = 零件行且带 `assembly_id`）而不是 `seq` 的值：折叠 / 归组阶段
 * `seq` 还是占位值 `0`，值判据在数据没排完时会把占位号当编号显示出去。
 */
export function seqCellText(row: PartTreeRow): string {
  return row.is_part_row && row.assembly_id ? '' : String(row.seq);
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
 *
 * 不带 `PrintRow.is_asm_row`：标签工作簿是 7 列（客户 / 订单号 / 申请人 / 名称 / 图号 /
 * 数量 / 单位），渲染层全程不读这个标记，两种行走的完全是同一套渲染路径。那个字段只服务
 * 「打印送货单」的预览表（`deliveryNotePrintColumnDefs` / `PrintGroupTable`），由
 * `deliveryNotePrintRows` 自己写。
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
  }));
}
