// src/views/cnc/__tests__/pendingProgrammingColumnDefs.spec.ts
//
// 2026-10-03 新增：操作列「下发」按钮的缺口可见性守卫。
//
// 为什么要有：release-from-programming 迁 prod 域后以批次为锚，而待编程列表
// （`GET /prod/programming/pending`）的行不携带 batch_id ⇒ 端点拿不到锚点。
// 按钮此前仍可点，用户要填完整对话框才发现这条路走不通。现在缺 batch_id 时按钮
// disabled + tooltip 说明，把缺口摆在点击前。
//
// 断言手法：不 mount，直接读 cellRender 产出的 VNode ——
//   actions 列的 cellRender 返回 h('div', null, [详情按钮, 下发节点|null])，
//   元素 1 就是要断言的节点。不 mock element-plus（h(ElButton, props) 的
//   vnode.props 可直接读，不需要真渲染；mock 掉反而拿不到 vnode.type 的身份比对）。

import { describe, expect, it, vi } from 'vitest';
import { ElButton, ElTooltip } from 'element-plus';
import type { VNode } from 'vue';
import {
  buildPendingProgrammingColumnDefs,
  RELEASE_NO_BATCH_HINT,
  type PendingProgrammingRow,
} from '../pendingProgrammingColumnDefs';

function makeRow(over: Partial<PendingProgrammingRow> = {}): PendingProgrammingRow {
  return {
    id: '190000000000099',
    version: 1,
    serial_no: 'SN-001',
    name: '法兰盘',
    drawing_no: 'DWG-A001',
    quantity: 5,
    status: 'PROGRAMMING',
    is_urgent: false,
    planned_delivery_date: '2026-10-10',
    system_delivery_date: null,
    customer_name: '客户A-子',
    parent_customer_name: '客户A',
    has_cnc_program: false,
    // 2026-10-03 m1：批次锚点在 schema 里是「必填 + 可空」，手工构造行必须显式给值。
    // 默认 null = 后端「无 PROGRAMMING 批次」的诚实形态（A1 断的就是这个形态）。
    batch_id: null,
    batch_version: null,
    ...over,
  };
}

function renderActions(row: PendingProgrammingRow): VNode {
  const deps = {
    openReleaseDialog: vi.fn(),
    navigateToPart: vi.fn(),
    isReleasing: () => false,
  };
  const actions = buildPendingProgrammingColumnDefs(deps).find((c) => c.key === 'actions');
  if (!actions?.cellRender) throw new Error('actions 列缺 cellRender');
  return actions.cellRender({ row, column: {}, $index: 0 }) as VNode;
}

/** 取 vnode 的子节点数组（actions 列的 children 是 h('div', null, [详情, 下发])）。 */
function childAt(vnode: VNode, i: number): VNode {
  return (vnode.children as VNode[])[i]!;
}

/** 取组件 vnode 默认插槽的第一个子节点（h(Comp, props, () => vnode) 的 children
 *  是 `{ default, _ctx }` 形态的函数式插槽，不是数组）。 */
function defaultSlotChild(vnode: VNode): VNode {
  const slots = vnode.children as unknown as { default?: () => VNode | VNode[] };
  const out = slots.default?.();
  return (Array.isArray(out) ? out[0]! : out)!;
}

describe('pendingProgrammingColumnDefs 操作列「下发」按钮', () => {
  it('A1：行缺 batch_id → 按钮 disabled，且被 tooltip 包住说明原因', () => {
    const node = renderActions(makeRow());
    const releaseNode = childAt(node, 1);

    expect(releaseNode.type).toBe(ElTooltip);
    expect(releaseNode.props?.content).toBe(RELEASE_NO_BATCH_HINT);
    // ElTooltip 不能直接以 disabled 元素作触发器 ⇒ 外层必须是 span
    const span = defaultSlotChild(releaseNode);
    expect(span.type).toBe('span');
    const button = childAt(span, 0);
    expect(button.type).toBe(ElButton);
    expect(button.props?.disabled).toBe(true);
  });

  // 2026-10-03 m4：A1 上面那条 `toBe(RELEASE_NO_BATCH_HINT)` 是**自反断言**（常量对
  // 常量）—— 改错文案它照样绿，而 2026-10-03 的 V3 恰好改了这句文案。故补一条断
  // **字面量**的用例把文案钉死：tooltip 面向用户，它一旦又开始归因「接口未返回
  // 批次」就与后端现状（`ProgrammingItemOut` 恒返 batch_id / batch_version）矛盾。
  it('A1b：tooltip 文案说「没有编程中的批次」而非归因接口（防 V3 文案回退）', () => {
    expect(RELEASE_NO_BATCH_HINT).toBe('该行没有处于「编程中」的批次，无法下发');
    const node = renderActions(makeRow());
    const content = childAt(node, 1).props?.content as string;
    expect(content).not.toContain('接口未返回');
    expect(content).not.toContain('未返回批次');
  });

  it('A2：行带 batch_id → 按钮可用，不套 tooltip', () => {
    const node = renderActions(makeRow({ batch_id: '190000000000123' }));
    const button = childAt(node, 1);

    expect(button.type).toBe(ElButton);
    expect(button.props?.disabled).toBe(false);
  });

  it('A3：非 PROGRAMMING 状态行不出「下发」按钮（既有语义不变）', () => {
    const node = renderActions(makeRow({ status: 'IN_PROCESS', batch_id: '190000000000123' }));
    expect(childAt(node, 1)).toBeNull();
  });
});
