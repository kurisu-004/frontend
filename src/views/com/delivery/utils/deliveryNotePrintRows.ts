// src/views/com/delivery/utils/deliveryNotePrintRows.ts
//
// 打印行整形的**全部纯函数**（2026-10-08 新增）：同 part 折叠 / 装配件折叠 /
// 客户端排序 / 拆分 / 分组 pack / sheet 名清洗。放在独立文件是为了单测不必挂载组件。
//
// 口径来源全部是后端 VO（`DeliveryNoteLineItemData`）与分组查询结果
// （`DeliveryGroupListResultData`），不 import 任何 Vue / EP —— 便于单测，也避免
// 打印对话框的交互态渗进行形计算。
//
// ⚠️ `PrintRow` 是「行项的打印投影」：它**保留**折叠所需的装配件父级字段
// （assembly_* 与两个套数字段），否则「先按 part 折叠、再按 assembly 折叠」的第二步
// 就没有依据了。字段增删只影响本文件与渲染层。

import type { DeliveryNoteLineItemData } from '../composables/deliveryNoteSchema';
import type { DeliveryGroupListResultData } from '../composables/deliveryGroupSchema';
import { DELIVERY_NOTE_TEMPLATE_CONTRACT } from './deliveryNoteTemplateContract';
import { shippableSetsOfGroup } from './assemblySets';
import type { PrintSheetSpec } from './deliveryNoteWorkbook';

/** 打印表的一行（与模板 10 列一一对应）。 */
export interface PrintRow {
  /** 行身份：装配件父行是 `ASM_<assembly_id>`，其余是代表批次 id（字符串）。 */
  id: string;
  order_no: string;
  l2_customer: string;
  applicant_name: string;
  drawing_no: string;
  name: string;
  /** 散件行 = 折叠后的件数；装配件父行 = 可出货套数，**全为 null 时是 null 不兜 0**
   *  （「后端没给数」与「凑不齐整套」业务含义相反，兜 0 会让用户以为这单打不了）。 */
  quantity: number | null;
  unit: string;
  system_delivery_date: string | null;
  note: string;
  /** 装配件父行标记（决定数量列渲染与折叠口径）。 */
  is_asm_row?: boolean;
  /** 装配件组内每个 part 的代表批次 id 集合（预览 / 拆分都靠它回溯）。 */
  member_ids?: string[];
  // —— 折叠所需的装配件父级字段（散件行全 null）——
  assembly_id?: string | null;
  assembly_order_no?: string | null;
  assembly_drawing_no?: string | null;
  assembly_name?: string | null;
  /** 装配件工单总套数（数量列 tooltip 的对照值）。 */
  assembly_quantity?: number | null;
  /** 本单可出货套数（note 级聚合值，组内各行同值）。 */
  shippable_sets?: number | null;
}

// ============================================================
// 分组：L2 客户 → sheet
// ============================================================

/** 分组键 + 组名的解析结果。key 是**语义字符串**（不是数组下标），tab / sheet 都用它。 */
export interface PrintGroupRef {
  groupKey: string;
  groupName: string;
}

/**
 * 分组查询结果 → `customer_id → 分组引用` 映射。
 *
 *   · `groups[].members[].customer_id` → `{ groupKey: 'g_<gid>', groupName: 组名 }`
 *   · `ungrouped_customers[].id`      → `{ groupKey: 'c_<l2id>', groupName: L2 客户名 }`
 *     （**每个未分组 L2 各自一 sheet** —— 按 L2 拆单是收货习惯，合成一张会让收货人
 *     找不到自己那批）
 *
 * ⚠️ **每个成员写两条键**（`customer_id` 与 `customer_name` 各一条，指向同一个 ref）。
 * 起因：`DeliveryNoteLineItem` **没有 `customer_id`**（后端 VO 的 26 个字段里只有
 * `customer_name` / `parent_customer_name` / `customer_path` 三个客户相关字段）⇒
 * 打印分组时手里只有 L2 **客户名**。id 键保留是为了将来某处拿到 id 时不必改本函数。
 *
 * ⚠️ 后端的 `ungrouped_customers` 是差集（理论上与 groups[].members 不重叠）；真重叠
 * 时后写的未分组覆盖分组，语义是「保守不丢客户」。
 */
export function buildL2GroupMap(
  groupRes: DeliveryGroupListResultData,
): Map<string, PrintGroupRef> {
  const map = new Map<string, PrintGroupRef>();
  for (const g of groupRes.groups) {
    const ref: PrintGroupRef = { groupKey: `g_${g.id}`, groupName: g.name };
    for (const m of g.members) {
      map.set(String(m.customer_id), ref);
      if (m.customer_name) map.set(m.customer_name, ref);
    }
  }
  for (const u of groupRes.ungrouped_customers) {
    const ref: PrintGroupRef = { groupKey: `c_${u.id}`, groupName: u.name };
    map.set(String(u.id), ref);
    if (u.name) map.set(u.name, ref);
  }
  return map;
}

/** 行项所属的分组引用：先按 L2 客户名查（行项 VO 只有名字），再兜底成「自身一个组」。 */
export function groupRefOf(
  li: DeliveryNoteLineItemData,
  map: Map<string, PrintGroupRef>,
): PrintGroupRef {
  const name = li.customer_name ?? li.customer_path?.split(' / ').pop() ?? '';
  return (
    map.get(name) ?? {
      groupKey: `c_named_${name || 'unknown'}`,
      groupName: name || '未分组',
    }
  );
}

// ============================================================
// 折叠
// ============================================================

/** 雪花 id 比较（BigInt；非纯数字串降级字典序，保证不抛）。
 *
 *  ⚠️ **不可退化成 `Number(a) < Number(b)`**：两个仅在 2^53 之后才有差别的 19 位 id
 *  转成 number 后相等，会让代表批次永远不换、静默选错批次。 */
function idLessThan(a: string, b: string): boolean {
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) return BigInt(a) < BigInt(b);
  return a < b;
}

/**
 * 同 part 多批次折叠为一行：quantity 求和，代表行取**最小 batch id**（后端
 * custom_order 的代表口径 = min；显式取 min 让前端不依赖 line_items 的返回顺序）。
 */
export function foldSamePart(lineItems: readonly DeliveryNoteLineItemData[]): PrintRow[] {
  const qty = new Map<string, number>();
  const rep = new Map<string, DeliveryNoteLineItemData>();
  const order: string[] = [];
  for (const li of lineItems) {
    const pid = String(li.part_id);
    const cur = rep.get(pid);
    if (cur === undefined) {
      rep.set(pid, li);
      order.push(pid);
      qty.set(pid, li.quantity);
      continue;
    }
    qty.set(pid, qty.get(pid)! + li.quantity);
    if (idLessThan(String(li.id), String(cur.id))) rep.set(pid, li);
  }
  return order.map((pid) => toPrintRow(rep.get(pid)!, qty.get(pid)!));
}

/** 行项 → 打印行（保留折叠所需的装配件字段）。 */
function toPrintRow(li: DeliveryNoteLineItemData, quantity: number): PrintRow {
  return {
    id: String(li.id),
    order_no: li.order_no ?? '',
    l2_customer: li.customer_name ?? '',
    applicant_name: li.applicant_name ?? '',
    drawing_no: li.drawing_no,
    name: li.name,
    quantity,
    unit: '',
    system_delivery_date: li.system_delivery_date,
    note: '',
    member_ids: [String(li.id)],
    assembly_id: li.assembly_id,
    assembly_order_no: li.assembly_order_no,
    assembly_drawing_no: li.assembly_drawing_no,
    assembly_name: li.assembly_name,
    assembly_quantity: li.assembly_quantity,
    shippable_sets: li.shippable_sets,
  };
}

/**
 * 装配件折叠（`merge` = 每个 assembly_id 折成 1 行；`separate` = 原样）。
 *
 * merge 模式的数量 = `min(shippable_sets)`，**全为 null 时是 null 不兜 0**（口径同
 * utils/assemblySets）。订单号 / 申请人 / 编码 / 名称取自装配件父级字段，交期与客户
 * 取组内首行。
 */
export function collapseAssemblies(
  rows: readonly PrintRow[],
  mergeMode: 'merge' | 'separate',
): PrintRow[] {
  if (mergeMode !== 'merge') return [...rows];
  const byAsm = new Map<string, PrintRow[]>();
  rows.forEach((r) => {
    const asmId = r.assembly_id;
    if (!asmId) return;
    const arr = byAsm.get(asmId) ?? [];
    arr.push(r);
    byAsm.set(asmId, arr);
  });
  const inserted = new Set<string>();
  const result: PrintRow[] = [];
  rows.forEach((r) => {
    const asmId = r.assembly_id;
    if (!asmId) {
      result.push(r);
      return;
    }
    if (inserted.has(asmId)) return;
    const siblings = byAsm.get(asmId) ?? [];
    const first = siblings[0] ?? r;
    result.push({
      id: `ASM_${asmId}`,
      order_no: r.assembly_order_no ?? '',
      l2_customer: first.l2_customer,
      applicant_name: first.applicant_name,
      drawing_no: r.assembly_drawing_no ?? '',
      name: r.assembly_name ?? '',
      quantity: shippableSetsOfGroup(
        // shippableSetsOfGroup 只读 shippable_sets 一个字段，给它最小窄结构即可
        // （不必造整行 DeliveryNoteLineItemData —— 那 26 个字段这里一个都用不到）。
        siblings.map((s) => ({ shippable_sets: s.shippable_sets })),
      ),
      unit: '套',
      system_delivery_date: first.system_delivery_date,
      note: '',
      is_asm_row: true,
      assembly_quantity: r.assembly_quantity ?? null,
      member_ids: siblings.flatMap((s) => s.member_ids ?? []),
    });
    inserted.add(asmId);
  });
  return result;
}

// ============================================================
// 排序 / 拆分
// ============================================================

/**
 * 客户端排序。`prop` 是 snake_case 字段名**本身**（不映射、不上传后端），
 * 字段缺失 / null 强制末尾。
 */
export function sortPrintRows(
  rows: readonly PrintRow[],
  prop: string,
  dir: 'asc' | 'desc',
): PrintRow[] {
  const sign = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = (a as unknown as Record<string, unknown>)[prop];
    const bv = (b as unknown as Record<string, unknown>)[prop];
    const an = av === null || av === undefined;
    const bn = bv === null || bv === undefined;
    if (an && bn) return 0;
    if (an) return 1;
    if (bn) return -1;
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * sign;
    const as = String(av);
    const bs = String(bv);
    return as < bs ? -1 * sign : as > bs ? 1 * sign : 0;
  });
}

/**
 * 把一行按给定数量拆成 N 行。
 *
 * **数量守恒**：`Σ quantities === row.quantity` 否则返回错误文案（调用方把它显示在
 * 拆分编辑器里并禁掉「确定」）。拆分行继承其余字段；`note` **每行独立、默认空** ——
 * 备注是逐行的事实（某一行临时加急 / 换料），继承会让同一句话重复 N 遍。
 */
export function splitRow(row: PrintRow, quantities: number[]): PrintRow[] | string {
  const sum = quantities.reduce((a, b) => a + b, 0);
  if (row.quantity === null || sum !== row.quantity) {
    return `数量不守恒：拆分后合计 ${sum}，原行是 ${row.quantity ?? '未知'}`;
  }
  return quantities.map((q, i) => ({
    ...row,
    id: `${row.id}#${i + 1}`,
    quantity: q,
    note: '',
  }));
}

// ============================================================
// 分组 → sheet
// ============================================================

/** 分组结果：键 = groupKey，值 = 该组的行（首次出现顺序即 tab 顺序）。 */
export type PrintRowsByGroup = Map<string, { ref: PrintGroupRef; rows: PrintRow[] }>;

/**
 * 按行项所属分组归堆（**首次出现顺序**即 tab / sheet 顺序）。
 *
 * 先按组切开再各自折叠：装配件组必须整体落在同一 sheet 里，跨 sheet 拆套会让收货人
 * 拿到半套货。
 */
export function groupRows(
  lineItems: readonly DeliveryNoteLineItemData[],
  groupMap: Map<string, PrintGroupRef>,
  mergeMode: 'merge' | 'separate',
): PrintRowsByGroup {
  const byGroup = new Map<string, { ref: PrintGroupRef; rows: DeliveryNoteLineItemData[] }>();
  for (const li of lineItems) {
    const ref = groupRefOf(li, groupMap);
    const bucket = byGroup.get(ref.groupKey) ?? { ref, rows: [] };
    bucket.rows.push(li);
    byGroup.set(ref.groupKey, bucket);
  }
  const out: PrintRowsByGroup = new Map();
  for (const [key, bucket] of byGroup) {
    out.set(key, { ref: bucket.ref, rows: collapseAssemblies(foldSamePart(bucket.rows), mergeMode) });
  }
  return out;
}

/**
 * 每组独立 pack 成 `≤ capacity` 条 / sheet。**跨组不混** —— 一张送货单一个收货单位。
 * 同一组超过容量时 sheet 名加序号后缀（`组名-2`、`组名-3`…），直到 31 字符上限内。
 */
export function groupIntoSheets(
  byGroup: PrintRowsByGroup,
  capacity = DELIVERY_NOTE_TEMPLATE_CONTRACT.dataRowCount,
): PrintSheetSpec[] {
  const used = new Set<string>();
  const specs: PrintSheetSpec[] = [];
  for (const [, { ref, rows }] of byGroup) {
    const chunks: PrintRow[][] = [];
    for (let i = 0; i < rows.length; i += capacity) {
      chunks.push(rows.slice(i, i + capacity));
    }
    // 空组也要出一张空表：模板自带表头与页脚，导出来是一张可手填的送货单。
    if (chunks.length === 0) chunks.push([]);
    chunks.forEach((chunk, i) => {
      // 分块序号只在该组**装不下**时才加（chunks.length > 1；注意不是 chunk.length）。
      const base = safeSheetName(chunks.length > 1 ? `${ref.groupName}-${i + 1}` : ref.groupName);
      specs.push({ sheetName: uniqueSheetName(base, used), rows: toSheetRows(chunk) });
    });
  }
  return specs;
}

/** PrintRow → 模板行（去打印侧不用的字段）。
 *
 * ⚠️ `quantity: null`（装配件「后端没给可出货套数」）在模板里写**空**而不是 0 ——
 * 0 会被读成「这套打不了」。 */
function toSheetRows(rows: readonly PrintRow[]): PrintSheetSpec['rows'] {
  return rows.map((r) => ({
    orderNo: r.order_no,
    l2Customer: r.l2_customer,
    applicant: r.applicant_name,
    drawingNo: r.drawing_no,
    name: r.name,
    quantity: r.quantity,
    unit: r.unit,
    etd: r.system_delivery_date,
    note: r.note,
  }));
}

// ============================================================
// Sheet 名清洗
// ============================================================

/** Excel 的 sheet 名非法字符（`: \ / ? * [ ]`）。 */
const ILLEGAL_SHEET_CHARS = /[:\\/?*[\]]/g;

/**
 * sheet 名清洗（Excel 硬限制，写成纯函数便于单测）：
 *   1. 剔除 `: \ / ? * [ ]`；
 *   2. 折叠连续空白（含剔除后产生的连续空格）为单个空格；
 *   3. 去首尾空白；
 *   4. 截断到 31 字符；
 *   5. 清空后回落到带 index 的兜底名。
 */
export function safeSheetName(name: string, index = 0): string {
  const base = (name ?? '')
    .replace(ILLEGAL_SHEET_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 31);
  return base === '' ? `送货单-${index + 1}` : base;
}

/** 同一个 workbook 里 sheet 名必须唯一 —— 撞名时加序号后缀直到不撞（仍守住 31 字符）。
 *
 *  ⚠️ 判重的 key 是**最终 sheet 名**而不是分组键：两个不同的分组可能显示同名（同名
 *  L2 客户、不同 L1），按分组键去重会让它们在同一个 workbook 里撞名。 */
function uniqueSheetName(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  for (let n = 2; n < 1000; n += 1) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, 31 - suffix.length)}${suffix}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
  const fallback = `送货单-${used.size + 1}`;
  used.add(fallback);
  return fallback;
}