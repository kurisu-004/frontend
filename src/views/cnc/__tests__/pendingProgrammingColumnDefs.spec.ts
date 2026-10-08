// src/views/cnc/__tests__/pendingProgrammingColumnDefs.spec.ts
//
// 操作列的回归守卫。2026-10-10 之前本文件守的是「下发」按钮的缺口可见性
// （缺 batch_id 时 disabled + tooltip），那个功能整体下线后用例随之删除；
// 留下来的是**详情按钮**本身：它是本页操作列唯一的入口，值得钉住「点它跳 /parts/{id}」。
//
// 断言手法：不 mount，直接读 cellRender 产出的 VNode ——
//   actions 列的 cellRender 返回单个 h(ElButton, …)。不 mock element-plus
//   （h(ElButton, props) 的 vnode.props 可直接读，不需要真渲染；mock 掉反而拿不到
//   vnode.type 的身份比对）。同目录的其它 spec（usePendingProgrammingStore.spec.ts）
//   覆盖 query / 列可见性 / 分页那一侧。

import { describe, expect, it, vi } from 'vitest';
import { ElButton } from 'element-plus';
import type { VNode } from 'vue';
import {
  buildPendingProgrammingColumnDefs,
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
    batch_id: null,
    batch_version: null,
    ...over,
  };
}

function renderActions(row: PendingProgrammingRow): {
  node: VNode;
  navigateToPart: ReturnType<typeof vi.fn>;
} {
  const navigateToPart = vi.fn();
  const actions = buildPendingProgrammingColumnDefs({ navigateToPart }).find(
    (c) => c.key === 'actions',
  );
  if (!actions?.cellRender) throw new Error('actions 列缺 cellRender');
  return { node: actions.cellRender({ row, column: {}, $index: 0 }) as VNode, navigateToPart };
}

/** 取组件 vnode 默认插槽的第一个子节点（点击时要拿到按钮文本）。
 *  ⚠️ `h(Comp, props, () => vnode)` 这种函数式插槽在未渲染时 children 是
 *  `{ default: fn }` 形态，`fn()` 的返回值本身就是那个文本 vnode（不是数组）。 */
function buttonLabel(vnode: VNode): string {
  const slots = vnode.children as unknown as { default?: () => VNode | VNode[] | string };
  const out = slots.default?.();
  if (typeof out === 'string') return out;
  const child = (Array.isArray(out) ? out[0]! : out)!;
  return typeof child === 'string' ? child : (child.children as string);
}

describe('pendingProgrammingColumnDefs 操作列', () => {
  it('D1：操作列只剩一个「详情」按钮（2026-10-10：下发功能下线）', () => {
    const { node } = renderActions(makeRow());
    expect(node.type).toBe(ElButton);
    expect(buttonLabel(node)).toBe('详情');
  });

  // 行状态无关：曾经「非 PROGRAMMING 不出下发按钮」的那条判据随功能一起没了，
  // 详情按钮对每一行都该在（否则某状态的行会变成「一个按钮都没有」的空格）。
  it('D2：不论行状态如何都出「详情」按钮', () => {
    for (const status of ['PROGRAMMING', 'IN_PROCESS', 'PENDING', 'COMPLETED'] as const) {
      const { node } = renderActions(makeRow({ status }));
      expect(node.type, `status=${status} 的行没有操作按钮`).toBe(ElButton);
      expect(buttonLabel(node), `status=${status}`).toBe('详情');
    }
  });

  // 批次锚点缺不缺也无所谓了：曾经它是「下发」按钮 disabled 的判据。现在 batch_id
  // 为 null 的行（后端「无 PROGRAMMING 批次」）也必须有点击入口，否则不可点。
  it('D3：行缺 batch_id 时详情按钮仍可点（锚点判据随下发一起下线）', () => {
    const { node, navigateToPart } = renderActions(makeRow({ batch_id: null }));
    expect(node.props?.disabled).toBeFalsy();
    (node.props?.onClick as () => void)();
    expect(navigateToPart).toHaveBeenCalledWith('190000000000099');
  });

  it('D4：点「详情」把行 id 交给 deps.navigateToPart', () => {
    const { node, navigateToPart } = renderActions(makeRow({ id: '190000000000777' }));
    (node.props?.onClick as () => void)();
    expect(navigateToPart).toHaveBeenCalledWith('190000000000777');
  });
});
