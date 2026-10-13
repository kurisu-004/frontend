// src/utils/__tests__/elTableCell.spec.ts
//
// 客户单元格共享渲染器（`src/utils/elTableCell.ts`，2026-10-17 客户无限层级改造新增）的
// 契约守卫。**被测的是三条兜底规则 + 三种 DOM 形态**，不是「某页渲染成什么样」——
// 8 个列定义跨 6 个域共用这一个函数，所以规则只有这一份、也只有这一处该被钉住。
//
// C 组（纯函数 `customerCellText`）守规则本身：空串退回单段名 / L1 与主行相同不重复 /
// 只有 L1 时顶主行。
// R 组（`renderCustomerCell`）守产物形态：单行 / 两行 / 空占位三种，且两行时行高会涨
// （断言 class 结构，不依赖具体 CSS —— CSS 在 styles/index.scss，无头环境量不到）。
//
// **非零信号核对**（改实现后本文件必须变红）：
//   - 删掉 `path || name` 的 fallback（C1 变红）；
//   - 删掉 `sub === main` 的去重（C2 变红）；
//   - 删掉「只有 L1 时顶主行」（C3 变红）；
//   - 把两行容器从 `.customer-cell` 换成别的 class（R2 变红）。

import { describe, expect, it } from 'vitest';
import type { VNode } from 'vue';
import {
  CUSTOMER_CELL_EMPTY,
  customerCellText,
  renderCustomerCell,
  type CustomerCellInput,
} from '../elTableCell';

/** VNode → 它渲染出的纯文本（递归，含数组形态的 children）。 */
function textOf(v: VNode): string {
  const children = v.children;
  if (typeof children === 'string') return children;
  if (Array.isArray(children)) {
    return children
      .map((c) => (typeof c === 'object' && c !== null && 'children' in c ? textOf(c) : ''))
      .join('');
  }
  return '';
}

/** VNode 的根 class（单 class 或数组形态都归一）。 */
function classesOf(v: VNode): string[] {
  const cls = (v.props?.class ?? null) as string | string[] | null;
  if (cls == null) return [];
  return Array.isArray(cls) ? cls : [cls];
}

/** 递归取出所有 class 名（两行容器要拿到子节点的 class）。 */
function allClasses(v: VNode): string[] {
  const out = classesOf(v);
  const children = v.children;
  if (Array.isArray(children)) {
    for (const c of children) {
      if (typeof c === 'object' && c !== null && 'children' in c) out.push(...allClasses(c));
    }
  }
  return out;
}

describe('C 组：customerCellText 三条兜底规则', () => {
  it('C1：customer_path 为空串 / 空白 / null 时退回 customer_name', () => {
    // 后端必填字段在「客户已软删 / 父链成环」时落的就是空串，不是 null —— 所以
    // `??` 不够，必须按「空串也算没有」处理。
    for (const path of ['', '   ', null, undefined]) {
      const r = customerCellText({ path, name: '影像组' });
      expect(r.main, `path=${JSON.stringify(path)}`).toBe('影像组');
    }
    // 两边都没有 ⇒ main 空串（渲染器据此落占位破折号）
    expect(customerCellText({ path: '', name: null })).toEqual({ main: '', sub: '' });
  });

  it('C2：l1 与主行相同时不产出次行（客户自身即 L1 —— 根节点两个字段返同一个名）', () => {
    const r = customerCellText({ path: '华强', name: '华强', l1: '华强' });
    expect(r).toEqual({ main: '华强', sub: '' });
    // 根节点的 customer_path 恰等于自己的 name，也走同一条去重
    const root = customerCellText({ path: '华强', name: '华强', l1: '华强' });
    expect(root.sub).toBe('');
  });

  it('C3：主行为空时把 L1 顶成主行（挂靠工单 / 老数据只有根名）', () => {
    expect(customerCellText({ path: '', name: null, l1: '华强' })).toEqual({
      main: '华强',
      sub: '',
    });
    expect(customerCellText({ path: null, name: null, l1: '华强' }).main).toBe('华强');
  });

  it('C4：任意深度时主行取 customer_path、L1 独立成次行', () => {
    // 树：华强 / 终端BG / 手机部 / 影像组 ⇒ L4 叶子的 customer_path 不含 L1。
    expect(
      customerCellText({ path: '终端BG / 手机部 / 影像组', name: '影像组', l1: '华强' }),
    ).toEqual({ main: '终端BG / 手机部 / 影像组', sub: '华强' });
    // customer_path 优先于单段名（两者不一致时也不能拿单段名当主行）
    expect(customerCellText({ path: 'A / B / C', name: 'C', l1: 'A' }).main).toBe('A / B / C');
  });

  it('C5：入参全缺字段不抛（各列定义的字段名逐域不同，漏传必须是降级而不是异常）', () => {
    expect(customerCellText({})).toEqual({ main: '', sub: '' });
  });
});

describe('R 组：renderCustomerCell 的三种产物形态', () => {
  it('R1：空值落灰色占位破折号，单行、单 class', () => {
    const v = renderCustomerCell({ path: '', name: null, l1: null });
    expect(textOf(v)).toBe(CUSTOMER_CELL_EMPTY);
    expect(classesOf(v)).toEqual(['customer-cell--empty']);
    // 占位态不该带两行容器类（否则会白占一行高度）
    expect(allClasses(v)).not.toContain('customer-cell');
  });

  it('R2：有 L1 且与主行不同 ⇒ 两行容器，主行 + 次行各一个节点', () => {
    const v = renderCustomerCell({ path: '终端BG / 手机部', name: '手机部', l1: '华强' });
    expect(classesOf(v)).toEqual(['customer-cell']);
    const kids = v.children as VNode[];
    expect(kids).toHaveLength(2);
    expect(classesOf(kids[0]!)).toEqual(['customer-cell__main']);
    expect(textOf(kids[0]!)).toBe('终端BG / 手机部');
    expect(classesOf(kids[1]!)).toEqual(['customer-cell__sub']);
    expect(textOf(kids[1]!)).toBe('华强');
  });

  it('R3：无 L1 / L1 与主行相同 ⇒ 单行（行高与改造前一致，不占第二行）', () => {
    const noL1 = renderCustomerCell({ path: '终端BG / 手机部' });
    expect(classesOf(noL1)).toEqual(['customer-cell__main']);
    expect(textOf(noL1)).toBe('终端BG / 手机部');
    // 有 L1 但等于主行 ⇒ 同样退化成单行（根节点那一支）
    const same = renderCustomerCell({ path: '华强', name: '华强', l1: '华强' });
    expect(classesOf(same)).toEqual(['customer-cell__main']);
    expect(allClasses(same)).not.toContain('customer-cell__sub');
  });

  it('R4：空 customer_path 落到单段名，并保留 L1 次行（两级数据下的常态）', () => {
    const v = renderCustomerCell({ path: '', name: '手机部', l1: '华强' });
    expect(classesOf(v)).toEqual(['customer-cell']);
    const kids = v.children as VNode[];
    expect(textOf(kids[0]!)).toBe('手机部');
    expect(textOf(kids[1]!)).toBe('华强');
  });

  it('R5：渲染器不吃域内类型（入参是裸字段，各列定义各自点名自己的字段名）', () => {
    // cnc 域叫 parent_customer_name、part 域叫 l1_customer_name、送货单本体的 L1 挂在
    // customer_name 上 —— 渲染器对三者一视同仁，只看 l1 有没有值。
    const asParent = renderCustomerCell({ path: '手机部', name: '手机部', l1: '华强' });
    const asL1 = renderCustomerCell({ path: '手机部', name: '手机部', l1: '华强' });
    expect(textOf(asParent)).toBe(textOf(asL1));
    const input: CustomerCellInput = { path: '手机部', l1: '华强' };
    expect(textOf(renderCustomerCell(input))).toBe('手机部华强');
  });
});
