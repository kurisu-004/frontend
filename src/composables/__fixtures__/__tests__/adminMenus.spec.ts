import { describe, it, expect } from 'vitest';
import { ADMIN_MENUS } from '../adminMenus';
import type { MenuNode } from '@/types/menu';

function flatten(nodes: MenuNode[]): MenuNode[] {
  const out: MenuNode[] = [];
  for (const n of nodes) {
    out.push(n);
    if (n.children.length > 0) out.push(...flatten(n.children));
  }
  return out;
}

describe('ADMIN_MENUS', () => {
  // 2026-09-14：新增 template_management + print_templates_designer（模板管理分组 + 模板编辑子菜单）
  // + part_process_chain（2026-09-14 menuCode 改名）。code 总数 27 → 30。
  // 2026-09-16：scan_badge 升顶级（floor_group → auth_group 货架移入 + 扫码台升级 + 车间软删）。
  // code 总数 27 → 30 → 33。
  // 2026-09-24：template_management + print_templates_designer 随 x-data-spreadsheet 弃用而下线（用户决策
  // 不再做模板编辑器，路由 /print-templates 与 view PrintTemplateDesigner 一并删除）。code 总数 33 → 31。
  it('covers all 31 menuCodes', () => {
    const all = flatten(ADMIN_MENUS);
    const codes = all.map((n) => n.code);
    expect(codes).toContain('home');
    expect(codes).toContain('parts_list');
    expect(codes).toContain('parts_new');
    expect(codes).toContain('inspection_pending');
    expect(codes).toContain('repair_receive');
    expect(codes).toContain('pending_programming');
    expect(codes).toContain('outsource_companies_list');
    expect(codes).toContain('outsource_quotes_list');
    expect(codes).toContain('outsource_send_receive_list');
    expect(codes).toContain('delivery_notes_manage');
    expect(codes).toContain('workers_list');
    expect(codes).toContain('users_list');
    // 2026-08-26 补回：router /production/worker-queue 无 allowRoles 短路，dummy 模式必须有此 code
    expect(codes).toContain('worker_queue');
    // 2026-09-11：worker_queue 仍必须在菜单树中（router /production/worker-queue 无 allowRoles 短路）
    expect(codes).toContain('shelves_list');
    expect(codes).toContain('customers_list');
    expect(codes).toContain('applicants_list');
    expect(codes).toContain('work_types_list');
    expect(codes).toContain('processes_list');
    expect(codes).toContain('work_type_processes_list');
    expect(codes).toContain('delivery_dispatch');
    expect(codes).toContain('production_stats');
    // 2026-08-26 新增：6 个分组 code 断言（生产 DB 暴露给 MANAGER 的分组节点）
    expect(codes).toContain('customer_management');
    expect(codes).toContain('order_group');
    expect(codes).toContain('auth_group');
    expect(codes).toContain('outsource_list');
    expect(codes).toContain('floor_group');
    expect(codes).toContain('settings_root');
    // 2026-09-11 新增：生产管理分组 + 工序制定菜单 code
    expect(codes).toContain('production_group');
    // 2026-09-14 改名：process_design_list → part_process_chain（对齐后端 t_menu）
    expect(codes).toContain('part_process_chain');
    // 2026-09-16 新增：扫码台从 floor_group 升级为顶级菜单（sort_order=13）
    expect(codes).toContain('scan_badge');
  });

  it('has unique codes (no dup)', () => {
    const all = flatten(ADMIN_MENUS);
    const codes = all.map((n) => n.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('all leaf nodes have path', () => {
    const all = flatten(ADMIN_MENUS);
    // 2026-09-16：leaf 定义收紧为「无 children 且 path 非 null」，排除空分组节点
    // （如 floor_group 软删后 children=[] / path=null——它不是 leaf，是「已停用」的分组，
    // 路径缺失是正确的）。原 filter `n.children.length === 0` 会把空分组误判为 leaf。
    const leaves = all.filter((n) => n.children.length === 0 && n.path !== null);
    for (const leaf of leaves) {
      expect(leaf.path).toBeTruthy();
    }
  });

  it('all ids are strings (snowflake format)', () => {
    const all = flatten(ADMIN_MENUS);
    for (const n of all) {
      expect(typeof n.id).toBe('string');
      expect(n.id.length).toBeGreaterThanOrEqual(15);
    }
  });

  // 2026-10-04 新增：菜单树的**数组物理顺序**必须与 sort_order 升序一致，两层都查 ——
  // ① 顶层 ADMIN_MENUS；② 每个分组的 children。
  // 为什么这是硬约束：MenuTreeItem 与 MainLayout 都是直接 `v-for` 数组、渲染链路上
  // 没有任何排序 ⇒ 渲染顺序 == 数组顺序；真实模式的菜单由后端 `ORDER BY m.sort_order,
  // m.code` 出（backend-rust src/modules/iam/repo/sql/menu.rs）。两层任一处失序，
  // dummy 模式的侧栏顺序就 ≠ 生产。
  // 本条守的就是这个不变量：改任一节点的 sort_order 时若忘了重排数组，本用例会红。
  // 两层都带「收集到非空集合」的兜底 —— 否则过滤条件写错会让 for 循环空转、用例永真。
  it('menu tree is in ascending sort_order (top level + group children)', () => {
    // ① 顶层
    expect(ADMIN_MENUS.length).toBeGreaterThan(0);
    const topSorts = ADMIN_MENUS.map((n) => n.sort_order);
    expect(topSorts, `顶层未按 sort_order 升序：${topSorts.join(',')}`).toEqual(
      [...topSorts].sort((a, b) => a - b),
    );

    // ② 各分组 children（软删空分组 children=[]，无顺序可言，天然被 for 跳过）
    const groups = flatten(ADMIN_MENUS).filter((n) => n.children.length > 0);
    expect(groups.length).toBeGreaterThan(0);
    for (const g of groups) {
      const sorts = g.children.map((c) => c.sort_order);
      expect(sorts, `${g.code} 的 children 未按 sort_order 升序：${sorts.join(',')}`).toEqual(
        [...sorts].sort((a, b) => a - b),
      );
    }
  });
});
