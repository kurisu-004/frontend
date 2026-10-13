// src/utils/elTableCell.ts
//
// el-table **单元格**的跨域共享渲染辅助（2026-10-17 新增，客户无限层级改造）。
//
// **为什么不并进 `elTable.ts`**：那个文件的职责写死在文件头 —— 「集中 selector 在这里：
// 避免 spread 到各 composable 内部；改 EP 版本时只动一处」，三个导出全是
// `el.querySelector(EP 内部结构约定)` 的 DOM 解析函数。本文件产的是 **VNode**（渲染层，
// 不是 DOM 查询层），混进去会让那个文件头变成假描述。`elTable.ts` 顶部留了指针注释。
//
// **判据（为什么放 `src/utils/` 而不是各列定义各写各的、也不是 `views/customers/`）**：
// CLAUDE.md 对 `utils/` 的要求是「零个域内依赖 + 多域复用」。本文件恰好两条都满足：
//   - **零域内依赖**：入参是三个裸字段（`path` / `name` / `l1`），**不接受任何 wire DTO、
//     不 import 任何 `views/` 或 `api/` 的类型**。客户域的字段名映射（`l1_customer_name`
//     vs `parent_customer_name` vs 送货单的 L1 挂在 `customer_name` 上）由各列定义在自己
//     那边做 —— 那些映射是真的逐域不同，硬塞进本函数反而会造出 `utils/ → views/` 反向依赖；
//   - **多域复用**：零件一览 / 待品检（队列 + 扫码树）/ 待编程 / 外协报价一览 /
//     外协发出零件 / 送货单一览 / 送货单详情行项，**跨 5 个域**（cnc / inspection /
//     outsource / parts / com-delivery），渲染规则逐字同一份。调用点数会随新列定义增长，
//     这里刻意不写数字（写了就一定会在某次加列定义后过期）。
//     ⚠️ **送货单打印预览不在其中**：那张表是「打印成品长什么样」的预览，必须与导出到
//     xlsx 的单格文本逐字一致，所以刻意保持单行并自己渲染 `PrintRow.l2_customer`
//     （见 `deliveryNotePrintColumnDefs.ts`），不共用本渲染器。
//
// **为什么值得抽**：被收敛掉的不只是模板，还有三条各列定义各写一遍、彼此已经漂移过的
// 兜底规则 ——
//   1. 空 `customer_path` 退回单段名（客户软删 / 父链成环时后端必填字段落空串）；
//   2. L1 与主行相同时不重复渲染（**根节点自身作为客户**时 L1 == 主行）；
//   3. 只有 L1 时把 L1 顶到主行，而不是渲染成「主行空 + 次行有值」。
// 抽之前 inspection 是四分支、partsList 是三分支、deliveryNote 是两个 `??`、cnc 又是
// 两分支 —— 同一件事四种写法。第 3 条在旧代码里只有 inspection 域有。
//
// **行高代价（2026-10-17 实测结论）**：EP 的 `.el-table .cell.el-tooltip`（由
// `showOverflowTooltip: true` 触发，本仓所有客户列都开着）是 `white-space: nowrap;
// overflow: hidden`，行高**没有**任何固定约束（EP 默认 `.cell` 只给 `line-height: 23px`
// + `padding: 8px 0`，td 高度由内容撑开；全仓唯一的 `row-style` 只设 cursor，见
// `views/parts/list/components/PartsTable.vue`）⇒ 次行会让该行变高约一行。补偿手段是
// 次行 12px 字号（见 `styles/index.scss` 的 `.customer-cell__sub`）。不想让行变高的页面
// 只需不传 `l1`，退化成单行（主行省略号截断，长路径 hover 走 showOverflowTooltip）。
//
// ⚠️ **原生 hover tooltip 会把两行拼成一坨**：`showOverflowTooltip` 的内容由 EP 从
// `.cell` 的 `textContent` 取（`table-body/render-helper.mjs::handleCellMouseEnter`），
// 次行与主行之间没有分隔符。列宽够用时根本不触发 tooltip，实际很少被看到，故不额外处理。

import { h, type VNode } from 'vue';

/** 空值占位（全仓表格统一的灰色破折号）。 */
export const CUSTOMER_CELL_EMPTY = '—';

/** 客户单元格的三个入参。**刻意收裸字段而不是 DTO** —— 见文件头的判据。 */
export interface CustomerCellInput {
  /**
   * 后端下发的 `customer_path`：第 2 层到叶子的名称用 ` / ` 拼接、**不含 L1**；
   * 根节点（自身即 L1）等于它自己的名字。
   *
   * 允许空串 / null：客户被软删或父链成环时，后端必填字段落的就是空串。
   */
  path?: string | null;
  /** 本节点单段名；`path` 空时的主行兜底（根节点 / 老后端只发单段名时用得上）。 */
  name?: string | null;
  /** L1（根）客户名，渲染成次行。与主行相同时不重复渲染。 */
  l1?: string | null;
}

/** 拆分结果：`main` 为空串表示「这一格没有任何可显示的客户名」。 */
export interface CustomerCellText {
  main: string;
  /** 次行（L1）；空串 = 不渲染次行。 */
  sub: string;
}

function trimmed(v: string | null | undefined): string {
  return (v ?? '').trim();
}

/**
 * 把三个字段拆成「主行 / 次行」两段文案（纯函数，不产 VNode，便于单测）。
 *
 * 规则（与文件头「三条兜底」逐条对应）：
 *  1. `main = path || name`：空串 / 空白串的 `customer_path` 退回单段名；
 *  2. `sub = l1 && l1 !== main ? l1 : ''`：L1 与主行相同时不重复渲染
 *     —— 客户自身是 L1 时后端两个字段返的是同一个名字（根节点 `customer_path` == `l1`）；
 *  3. `main` 与 `sub` 都空、`sub` 非空时把 L1 顶成主行（挂靠工单 / 老数据只有根名）。
 */
export function customerCellText(input: CustomerCellInput): CustomerCellText {
  const pathOrName = trimmed(input.path) || trimmed(input.name);
  const rawL1 = trimmed(input.l1);
  let main = pathOrName;
  let sub = rawL1 && rawL1 !== main ? rawL1 : '';
  if (!main && sub) {
    main = sub;
    sub = '';
  }
  return { main, sub };
}

/**
 * 渲染客户单元格：**主行 `customer_path`（空串退回单段名）+ 次行 muted 小字 L1**。
 *
 * 三种产物：
 *   - 什么名字都没有 → 单个 `<span class="customer-cell--empty">—</span>`；
 *   - 有 L1 且与主行不同 → `<span class="customer-cell">` 里上下两行（flex 列 ⇒ 撑高一行）；
 *   - 其余（无 L1 / L1 与主行相同）→ 单行，行高与改造前一致。
 */
export function renderCustomerCell(input: CustomerCellInput): VNode {
  const { main, sub } = customerCellText(input);
  if (!main) return h('span', { class: 'customer-cell--empty' }, CUSTOMER_CELL_EMPTY);
  if (!sub) return h('span', { class: 'customer-cell__main' }, main);
  return h('span', { class: 'customer-cell' }, [
    h('span', { class: 'customer-cell__main' }, main),
    h('span', { class: 'customer-cell__sub' }, sub),
  ]);
}
