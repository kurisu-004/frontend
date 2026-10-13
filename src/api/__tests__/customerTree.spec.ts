// src/api/__tests__/customerTree.spec.ts
//
// 2026-10-17 新增：客户树工具（`src/api/customer.tree.ts`）守门。
//
// 为什么要有这一组：`useCustomerTree` 改成调 `buildCustomerTree` 后，全站 12 个客户
// 筛选器的 `ElTreeSelect` data 都来自它，而**脏数据分支不会有任何人主动去构造**
// —— 孤儿节点、parent_id 成环、同一个 id 出现两次都只可能在生产数据里现身。这三个
// 分支的错误形态是「静默少一层 / 整页空白 / 渲染爆栈」，正是最该用测试钉住的那类。
//
// 覆盖：
//   - C1：空数组 → []
//   - C2：两层（现状口径）结构正确，children 恒为数组
//   - C3：五层嵌套（无限层级改造的主场景）—— depth / root_id 逐层正确，
//     且**第 3 层往下的节点不再消失**（两层旧实现在这里就丢）
//   - C4：孤儿节点（parent_id 指向不存在的 id）挂虚拟根当顶层，不静默丢弃；
//     孤儿自己的子树照常挂在它下面
//   - C5：环（A→B→A）不死循环、爆栈；环上两个节点都是顶层
//   - C6：同一个 id 出现两次 → 去重（保留首条），且不产生重复子节点
//   - C7：rootCustomerIdOf 多级上溯 / 未知 id / null 入参
//   - C8：leafCustomersOf —— 没有子节点的节点；孤儿若无人引用即算叶子
//   - C9：customer_path 逐字透传（工具不改写 wire 字段）

import { describe, expect, it } from 'vitest';
import {
  buildCustomerTree,
  leafCustomersOf,
  rootCustomerIdOf,
  type CustomerTreeNode,
} from '../customer.tree';
import type { Customer } from '../customer';

/** 构造一条客户 wire 记录。customer_path 按后端口径给出默认值（L1 = 自己名字，
 *  有父 = `父 / … / 自己`），个别用例会显式覆盖。 */
function c(
  id: string,
  name: string,
  parentId: string | null,
  extra: Partial<Customer> = {},
): Customer {
  return {
    id,
    name,
    parent_id: parentId,
    parent_name: parentId,
    serial_prefix: parentId === null ? 'A' : null,
    customer_path: parentId === null ? name : `${parentId} / ${name}`,
    version: 1,
    created_at: '',
    updated_at: '',
    ...extra,
  };
}

/** 在树上按 id 找节点（找不到抛错，让用例失败信息直指「节点不见了」）。 */
function find(nodes: CustomerTreeNode[], id: string): CustomerTreeNode {
  const search = (list: CustomerTreeNode[]): CustomerTreeNode | null => {
    for (const n of list) {
      if (n.id === id) return n;
      const hit = search(n.children);
      if (hit) return hit;
    }
    return null;
  };
  const hit = search(nodes);
  if (!hit) throw new Error(`树上找不到节点 ${id}`);
  return hit;
}

describe('buildCustomerTree（2026-10-17 客户无限层级）', () => {
  it('C1：空数组 → []', () => {
    expect(buildCustomerTree([])).toEqual([]);
  });

  it('C2：两层（改造前的老口径）结构正确，children 恒为数组（无 undefined）', () => {
    const tree = buildCustomerTree([c('r', '华强', null), c('l2', '终端BG', 'r')]);
    expect(tree).toHaveLength(1);
    expect(tree[0]?.id).toBe('r');
    expect(tree[0]?.depth).toBe(1);
    expect(tree[0]?.root_id).toBe('r');
    expect(tree[0]?.children).toHaveLength(1);
    expect(tree[0]?.children[0]?.id).toBe('l2');
    expect(tree[0]?.children[0]?.depth).toBe(2);
    expect(tree[0]?.children[0]?.root_id).toBe('r');
    // 叶子节点的 children 是空数组而不是 undefined —— 递归遍历不必写 `?? []`
    expect(tree[0]?.children[0]?.children).toEqual([]);
  });

  it('C3：五层嵌套 —— 第 3 层往下的节点不再从树上消失', () => {
    // 这是本次改造的核心 regression guard：旧的硬编码两层拼法
    // （roots = parent_id === null，每层只取一层 children）会把 L3/L4/L5
    // 整片丢掉，表现为「按某个车间筛客户时筛选器里选不到它」。
    const tree = buildCustomerTree([
      c('l1', '华强', null),
      c('l2', '终端BG', 'l1'),
      c('l3', '手机部', 'l2'),
      c('l4', '影像组', 'l3'),
      c('l5', '光学组', 'l4'),
    ]);
    expect(tree).toHaveLength(1);
    const l2 = find(tree, 'l2');
    const l3 = find(tree, 'l3');
    const l4 = find(tree, 'l4');
    const l5 = find(tree, 'l5');
    expect(l2.depth).toBe(2);
    expect(l3.depth).toBe(3);
    expect(l4.depth).toBe(4);
    expect(l5.depth).toBe(5);
    // root_id 一路指回 L1
    for (const n of [l2, l3, l4, l5]) expect(n.root_id).toBe('l1');
    // 顶层客户之外的每一条都在树上恰好出现一次
    const flat: string[] = [];
    const walk = (nodes: CustomerTreeNode[]): void => {
      for (const n of nodes) {
        flat.push(n.id);
        walk(n.children);
      }
    };
    walk(tree);
    expect(flat.sort()).toEqual(['l1', 'l2', 'l3', 'l4', 'l5']);
  });

  it('C4：孤儿节点（父 id 不存在）挂虚拟根当顶层，不静默丢弃', () => {
    const tree = buildCustomerTree([
      c('r', '华强', null),
      c('orphan', '野节点', '不存在的父'),
      c('underOrphan', '野节点的孩子', 'orphan'),
    ]);
    const ids = tree.map((n) => n.id);
    expect(ids).toContain('orphan');
    expect(ids).toContain('r');
    // 孤儿自身即虚拟根下的顶层：depth 从 1 起算、root_id 是自己
    const orphan = tree.find((n) => n.id === 'orphan');
    expect(orphan?.depth).toBe(1);
    expect(orphan?.root_id).toBe('orphan');
    // 它的子树照常挂在它下面（别把「找不到父」传染成「整棵子树丢失」）
    expect(orphan?.children.map((n) => n.id)).toEqual(['underOrphan']);
    expect(orphan?.children[0]?.depth).toBe(2);
    expect(orphan?.children[0]?.root_id).toBe('orphan');
    // 真根那一支不受影响
    expect(tree.find((n) => n.id === 'r')?.children).toEqual([]);
  });

  it('C5：环（A→B→A）不死循环、不爆栈，环上节点挂虚拟根', () => {
    // 自环（A 的父是自己）与二元环各测一次：前者是最容易写出死循环的退化形态。
    const tree = buildCustomerTree([c('a', 'A', 'b'), c('b', 'B', 'a'), c('self', '自环', 'self')]);
    const ids = tree.map((n) => n.id).sort();
    expect(ids).toEqual(['a', 'b', 'self']);
    for (const n of tree) {
      // 环上节点若是还被当成别人的 child，就会同时出现在两处（且其中一处成环）
      expect(n.children).toEqual([]);
      expect(n.depth).toBe(1);
      expect(n.root_id).toBe(n.id);
    }
  });

  it('C5b：环上挂着正常子树时，子树仍挂在环下（只在环口断开，不整支丢弃）', () => {
    const tree = buildCustomerTree([c('a', 'A', 'b'), c('b', 'B', 'a'), c('kid', 'C', 'b')]);
    const b = tree.find((n) => n.id === 'b');
    expect(b?.children.map((n) => n.id)).toEqual(['kid']);
    expect(b?.children[0]?.depth).toBe(2);
    // kid 的 root 是它在树上的顶层祖先 b（不是环上的另一端 a）—— 与
    // rootCustomerIdOf 的口径必须一致
    expect(b?.children[0]?.root_id).toBe('b');
    const a = tree.find((n) => n.id === 'a');
    expect(a?.children).toEqual([]);
  });

  it('C6：同一个 id 出现两次 → 去重（保留首条），不产生重复子节点', () => {
    const tree = buildCustomerTree([
      c('r', '华强', null),
      c('dup', '第一个名字', 'r'),
      c('dup', '第二个名字', 'r'),
    ]);
    expect(tree).toHaveLength(1);
    expect(tree[0]?.children).toHaveLength(1);
    expect(tree[0]?.children[0]?.name).toBe('第一个名字');
  });

  it('C9：wire 字段逐字透传，工具不改写 customer_path / parent_name', () => {
    const tree = buildCustomerTree([
      c('l1', '华强', null, { serial_prefix: 'H' }),
      c('l4', '影像组', 'l3', { parent_name: '手机部', customer_path: '终端BG / 手机部 / 影像组' }),
      c('l3', '手机部', 'l2'),
    ]);
    const l4 = find(tree, 'l4');
    expect(l4.customer_path).toBe('终端BG / 手机部 / 影像组');
    expect(l4.parent_name).toBe('手机部');
    expect(l4.serial_prefix).toBeNull();
    expect(find(tree, 'l1').serial_prefix).toBe('H');
  });
});

describe('rootCustomerIdOf（2026-10-17）', () => {
  const items = [
    c('l1', '华强', null),
    c('l2', '终端BG', 'l1'),
    c('l3', '手机部', 'l2'),
    c('l4', '影像组', 'l3'),
  ];

  it('C7：多级上溯 —— 任意深度都回到 L1', () => {
    expect(rootCustomerIdOf(items, 'l1')).toBe('l1');
    expect(rootCustomerIdOf(items, 'l2')).toBe('l1');
    expect(rootCustomerIdOf(items, 'l3')).toBe('l1');
    expect(rootCustomerIdOf(items, 'l4')).toBe('l1');
  });

  it('C7b：未知 id / null 入参 → null（与 buildCustomerTree 给的 root_id 同口径）', () => {
    expect(rootCustomerIdOf(items, null)).toBeNull();
    expect(rootCustomerIdOf(items, 'nope')).toBeNull();
    expect(rootCustomerIdOf([], 'l1')).toBeNull();
  });

  it('C7c：孤儿 / 环上节点 → 返回自身 id（它在树上是顶层）', () => {
    expect(rootCustomerIdOf([c('orphan', '野节点', '不存在的父')], 'orphan')).toBe('orphan');
    expect(rootCustomerIdOf([c('a', 'A', 'b'), c('b', 'B', 'a')], 'a')).toBe('a');
    expect(rootCustomerIdOf([c('a', 'A', 'b'), c('b', 'B', 'a')], 'b')).toBe('b');
  });
});

describe('leafCustomersOf（2026-10-17）', () => {
  it('C8：只返回没有子节点的节点（业务单据只能挂叶子）', () => {
    const leaves = leafCustomersOf([
      c('l1', '华强', null),
      c('l2', '终端BG', 'l1'),
      c('l3', '手机部', 'l2'),
      c('l4', '影像组', 'l3'),
    ]);
    expect(leaves.map((x) => x.id)).toEqual(['l4']);
  });

  it('C8b：孤儿若无人引用即算叶子；重复 id 去重后判定', () => {
    const leaves = leafCustomersOf([
      c('orphan', '野节点', '不存在的父'),
      c('dup', '第一个名字', null),
      c('dup', '第二个名字', null),
    ]);
    expect(leaves.map((x) => x.id).sort()).toEqual(['dup', 'orphan']);
    // 去重保留首条
    expect(leaves.find((x) => x.id === 'dup')?.name).toBe('第一个名字');
  });

  it('C8c：空数组 → []', () => {
    expect(leafCustomersOf([])).toEqual([]);
  });
});
