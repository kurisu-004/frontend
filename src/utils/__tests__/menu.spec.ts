// src/utils/__tests__/menu.spec.ts
//
// 2026-10-14 新增：菜单树降级目标工具的行为锁。两个消费方（路由守卫的 menuCode 校验
// 降级、登录页的自定义角色落点回退）都依赖「找有 path 的节点」这条口径 —— 抽取共享后
// 行为漂移会让两处的降级目标分叉。

import { describe, expect, it } from 'vitest';
import { findFirstMenuPath } from '../menu';
import type { MenuNode } from '@/types/menu';

function leaf(code: string, path: string | null): MenuNode {
  return {
    id: `id-${code}`,
    version: 0,
    parent_id: 'g1',
    code,
    title: code,
    path,
    icon: null,
    sort_order: 0,
    children: [],
  };
}

function group(code: string, children: MenuNode[]): MenuNode {
  return {
    id: `id-${code}`,
    version: 0,
    parent_id: null,
    code,
    title: code,
    path: null,
    icon: null,
    sort_order: 0,
    children,
  };
}

describe('findFirstMenuPath', () => {
  it('跳过无 path 的分组节点，返回叶子的 path', () => {
    expect(findFirstMenuPath([group('auth_group', [leaf('users_list', '/users')])])).toBe('/users');
  });

  it('空树 → null', () => {
    expect(findFirstMenuPath([])).toBeNull();
  });

  it('只有分组节点（全部 path=null）→ null', () => {
    expect(findFirstMenuPath([group('auth_group', [leaf('hidden', null)])])).toBeNull();
  });
});
