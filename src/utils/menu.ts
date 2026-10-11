// src/utils/menu.ts
//
// 2026-10-14 新增：菜单树遍历的跨域通用工具。零域内依赖（只依赖 `@/types/menu` 的
// `MenuNode`），两个消费方：路由守卫的 `menuCode` 校验降级、登录页的角色落点回退。

import type { MenuNode } from '@/types/menu';

/** DFS 在菜单树中找一个有 path 的节点；找不到返回 null。
 *
 *  用作「当前路由不可达时的降级目标」的判据（避免再次陷入相同的菜单校验循环）：
 *  - 路由守卫：`menuCode` 不在用户菜单树中时跳到它；
 *  - 登录页：角色枚举全落空（管理员自建的自定义角色）时，账号的可用面就是它的
 *    菜单树，取它作为落地页。 */
export function findFirstMenuPath(tree: MenuNode[]): string | null {
  const stack: MenuNode[] = [...tree];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (n.path) return n.path;
    if (n.children.length > 0) stack.push(...n.children);
  }
  return null;
}
