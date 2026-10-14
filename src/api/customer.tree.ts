// src/api/customer.tree.ts —— 客户树工具（2026-10-17 新增，客户无限层级改造）。
//
// **为什么放 api 层而不是 `src/utils/`**：CLAUDE.md「目录归位」对 `utils/` 的判据是
// 「零个域内依赖 + 多域复用」，而这三个函数是 wire DTO（`Customer`）的纯派生 ——
// 依赖 `api/customer` 的出参类型，与 `api/productionQueue.contract.ts` /
// `productionScan.contract.ts` 的两级切分同款，放进 `utils/` 会造出一条
// `utils/ → api/` 的反向依赖。
//
// 2026-10-17 之前的形态：`useCustomerTree.ts` 内联一个**硬编码两层**的拼树
// （`roots = parent_id === null`，每个 root 的 children 只取一层），且节点只透
// `id` + `name`。后端改成任意深度（对齐客户的部门架构：集团 / 分厂 / 车间 / 班组…）
// 之后两层拼法必然缺层 —— 第 3 层往下的节点会**从树上消失**（既不在 roots 也不在
// 任何 root 的 children 里），表现为「按某个车间筛客户时筛选器里选不到它」。
//
// 四个函数都是纯函数、无状态、可单测；脏数据（孤儿 / 环 / 重复 id）一律
// **不静默丢弃**：能挂上树的挂虚拟根，挂了两次的按首条去重。

import type { Customer } from './customer';

export interface CustomerTreeNode {
  id: string;
  name: string;
  parent_id: string | null;
  parent_name: string | null;
  serial_prefix: string | null;
  customer_path: string;
  /** 根节点 id（L1）。孤儿 / 环上的节点自身即虚拟根，root_id = 自身 id。 */
  root_id: string;
  /** 1 = L1（根），2 = 第二层 …；虚拟根上的节点按自身所在层起算。 */
  depth: number;
  children: CustomerTreeNode[];
}

/** 按 id 去重，保留**首条**（脏数据里同一个 id 出现两次时后条被丢弃）。
 *  为什么不保留后条：wire 顺序即后端 SQL 顺序，首条是稳定的快照。 */
function dedupeById(items: readonly Customer[]): Customer[] {
  const seen = new Set<string>();
  const out: Customer[] = [];
  for (const c of items) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    out.push(c);
  }
  return out;
}

/** 该节点在拼出来的树里是不是顶层（挂在虚拟根上）。
 *
 *  判据只有一条：**异常属于「检测到异常的那个节点」，只有它自己算顶层**——
 *   - `parent_id === null`（真根）⇒ 自己就是顶层；
 *   - 父 id 不在集合里（孤儿）⇒ 这个孤儿自己顶层，**它下面的子树照常挂在它下面**
 *     （不能让「找不到父」传染成「整棵子树被拍平成顶层」）；
 *   - 沿 parent_id 上溯会绕回某一环 ⇒ 环上的**每个**节点都顶层，否则整条环谁都不
 *     顶层、结果全树消失；而挂在环下的正常子树仍留在它父节点下面（环口断开即可）。
 *  反过来，走到「真实根祖先」说明本节点的父链完整可解 ⇒ 自己**不是**顶层。 */
function isTopLevel(byId: Map<string, Customer>, id: string): boolean {
  const seen = new Set<string>([id]);
  let cur = byId.get(id);
  while (cur) {
    const parentId = cur.parent_id;
    if (parentId === null) return cur.id === id;
    // 父缺失 ⇒ 检测到异常的节点是 cur
    if (!byId.has(parentId)) return cur.id === id;
    // 回到走过的节点 ⇒ 成环；parentId === id 即「自己也在这条环上」
    if (seen.has(parentId)) return parentId === id;
    seen.add(parentId);
    cur = byId.get(parentId);
  }
  // 兜底：入参 id 不在 byId 里（只有外部直接调本函数才会发生，两个导出都先判过
  // 存在性）。当作顶层处理 = 挂虚拟根，与「不静默丢弃」同向。
  return true;
}

/** 沿 parent_id 链上溯到**它在树上的顶层祖先**（通常是 L1），返回其 id。
 *  孤儿与环上节点返回**自身** id（与 `buildCustomerTree` 给它们的 root_id 同口径：
 *  它们在树上是顶层，虚拟根就是自己）。刻意不自己重写一遍上溯：两处对「顶层」的
 *  判定必须逐字一致，直接复用 `isTopLevel`，免得脏数据分支上两套定义悄悄分叉。 */
function resolveRootId(byId: Map<string, Customer>, id: string): string {
  let cur = byId.get(id);
  if (!cur) return id;
  const seen = new Set<string>([id]);
  while (cur && !isTopLevel(byId, cur.id)) {
    const parentId = cur.parent_id;
    if (parentId === null || !byId.has(parentId) || seen.has(parentId)) break;
    seen.add(parentId);
    cur = byId.get(parentId);
  }
  return cur ? cur.id : id;
}

/** 把扁平客户列表拼成任意深度的树。
 *
 *  返回的数组只含**顶层节点**（真根 + 孤儿 + 环上节点），每个节点的 children 恒为
 *  数组（无子节点时是空数组，不是 undefined —— 递归遍历不必写 `?? []`）。
 *
 *  复杂度：每个节点判一次顶层（最坏 O(深度)），再自顶向下 BFS 一次 ⇒ O(n × 深度)。
 *  客户量级（几百到几千）下无关紧要；不去 memo 是为了避免「顶层判定」与
 *  「root_id 上溯」两套缓存再各写一遍。 */
export function buildCustomerTree(items: readonly Customer[]): CustomerTreeNode[] {
  const unique = dedupeById(items);
  const byId = new Map(unique.map((c) => [c.id, c]));
  const topLevelIds = unique.filter((c) => isTopLevel(byId, c.id)).map((c) => c.id);
  const topLevel = new Set(topLevelIds);
  // 一次性索引「谁的子节点」：避免每个节点都对全表 filter（那是 O(n²)）
  const childIds = new Map<string, string[]>();
  for (const c of unique) {
    if (c.parent_id === null || topLevel.has(c.id)) continue;
    // parent_id 指向不存在的 id ⇒ 该节点自身已是顶层，不会走到这里
    const bucket = childIds.get(c.parent_id);
    if (bucket) bucket.push(c.id);
    else childIds.set(c.parent_id, [c.id]);
  }

  const roots: CustomerTreeNode[] = [];
  const makeNode = (c: Customer, rootId: string, depth: number): CustomerTreeNode => ({
    id: c.id,
    name: c.name,
    parent_id: c.parent_id,
    parent_name: c.parent_name,
    serial_prefix: c.serial_prefix,
    customer_path: c.customer_path,
    root_id: rootId,
    depth,
    children: [],
  });

  // 显式栈 BFS（不用递归）：脏数据里深度不可控，递归写法在「环 + 孤儿」组合下
  // 更容易写出无出口的分支。
  const stack: CustomerTreeNode[] = [];
  for (const id of topLevelIds) {
    const c = byId.get(id);
    if (!c) continue;
    const node = makeNode(c, c.id, 1);
    roots.push(node);
    stack.push(node);
  }
  while (stack.length > 0) {
    const parent = stack.pop() as CustomerTreeNode;
    for (const childId of childIds.get(parent.id) ?? []) {
      const c = byId.get(childId);
      if (!c) continue;
      const node = makeNode(c, parent.root_id, parent.depth + 1);
      parent.children.push(node);
      stack.push(node);
    }
  }
  return roots;
}

/** 沿 parent_id 链上溯到根（L1）id；入参 id 为 null 或集合里查无此 id → null。 */
export function rootCustomerIdOf(items: readonly Customer[], id: string | null): string | null {
  if (!id) return null;
  const byId = new Map(dedupeById(items).map((c) => [c.id, c]));
  if (!byId.has(id)) return null;
  return resolveRootId(byId, id);
}

/** 没有子节点的节点（业务单据只能挂叶子 ⇒ 各筛选器 / 下拉的数据源）。
 *  「有子节点」按 `parent_id` 反查判定；孤儿 / 环上节点若无人引用即算叶子
 *  （它们在树上是顶层，真实层级无从判断）。 */
export function leafCustomersOf(items: readonly Customer[]): Customer[] {
  const unique = dedupeById(items);
  const parentIds = new Set(unique.map((c) => c.parent_id).filter((p): p is string => p !== null));
  return unique.filter((c) => !parentIds.has(c.id));
}

/** `rootId` 这一支子树内的**叶子**节点（`leafCustomersOf` 的作用域收窄版）。
 *
 *  与 `leafCustomersOf` 的区别只有一条：后者给的是**全树**的叶子，本函数只给
 *  「所选根往下」那一支。两个消费方的作用域都天生是这一支 ——
 *  零件 PDF 批量上传的行内客户列（`views/parts/new/composables/usePartBatchPdf.ts`
 *  的 `leafCustomerOptions`）、送货单扫码台的分组编辑器候选
 *  （`views/com/delivery/DeliveryNoteScan.vue` 的 `leafCustomerOptions`）。套
 *  `leafCustomersOf` 再按 `root_id` 过滤要先把整棵树拼出来（`buildCustomerTree`），
 *  比直接走一遍栈贵一个量级；而**两处各写一份遍历**更糟 —— 脏数据口径（重复 id、
 *  `parent_id` 成环）迟早分叉，所以统一收口在这里。
 *
 *  「叶子」= 没有子节点的节点；**所选根自己**若是叶子同样算（该 L1 下没建任何下级时，
 *  单据挂它合法）。遍历是「parent_id → children」索引 + 显式栈，与 `buildCustomerTree`
 *  同一份脏数据口径：先按 id 去重（`dedupeById`，保留首条）、成环靠 `seen` 断开、
 *  不静默丢节点。**孤儿**（父 id 不在集合里）不会出现在输出里 —— 它不是所选根的后代，
 *  这与「按子树筛」的口径一致（`buildCustomerTree` 里它是虚拟根下的另一棵树）。
 *
 *  输出**顺序**是显式栈的出栈序（同分支配 LIFO），不是 wire 顺序 —— 调用方要么按 id
 *  排序、要么只当「候选集合」用，别拿它当稳定排序的契约。 */
export function leafCustomersUnder(items: readonly Customer[], rootId: string | null): Customer[] {
  if (!rootId) return [];
  const unique = dedupeById(items);
  const byId = new Map(unique.map((c) => [c.id, c]));
  // rootId 不在集合里（未选客户 / 客户已软删）⇒ 没有子树可言，返回空候选
  if (!byId.has(rootId)) return [];
  const childrenByParent = new Map<string, Customer[]>();
  for (const c of unique) {
    if (c.parent_id === null) continue;
    const bucket = childrenByParent.get(c.parent_id);
    if (bucket) bucket.push(c);
    else childrenByParent.set(c.parent_id, [c]);
  }
  const out: Customer[] = [];
  const stack: string[] = [rootId];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    const kids = childrenByParent.get(id);
    if (!kids || kids.length === 0) {
      const leaf = byId.get(id);
      if (leaf) out.push(leaf);
      continue;
    }
    for (const kid of kids) stack.push(kid.id);
  }
  return out;
}
