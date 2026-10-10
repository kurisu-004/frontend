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

/**
 * 菜单 code 的**穷尽登记清单**（2026-10-14 review 第 2 轮 B-2 由 31 条 `toContain` 收拢而成）。
 *
 * 为什么从 `toContain`（子集断言）改成「两数组排序后逐字相等」（穷尽断言）：
 *   - `expect(codes).toContain('x')` 只断「x 在里面」。fixture 加了节点而清单没登记时，
 *     **一个都不红** —— 而本用例存在的全部价值就是「新增菜单必须在这里登记」。
 *     上一轮新增的「总数恰好 32」只是数节点、不校验登记，补不上这个洞（review 第 2 轮
 *     实测：`process_work_type` 节点在 fixture 里、31 条 `toContain` 里没有，用例照样绿）。
 *   - 穷尽比较同时盖住两个方向：**fixture 多出的 code** 与 **清单多写的 code** 都会红，
 *     且重复项也盖住（重复会让排序后的长度对不上）。⇒ 下面那条 `has unique codes` 变成
 *     纯「错误信息更清楚」的冗余守卫，不再是唯一防线。
 *
 * ⚠️ **新增 / 删除任何菜单节点时，必须同步维护这一份数组**（fixture 与数组逐字对应）。
 * 漏维护的症状是用例红在 `covers all menuCodes exactly` 上 —— 那是本用例在正常工作。
 *
 * 数组顺序 = `flatten(ADMIN_MENUS)` 的 DFS 遍历序（父节点先于其 children，同层按数组
 * 物理顺序），只为 diff 好读；比较前两侧都排序，故这里写错顺序不影响判定。
 *
 * 沿革（原用例头注释的计数史，保留只为读懂「为什么是这些 code」）：
 *   - 2026-09-14：新增 template_management + print_templates_designer（模板管理分组 +
 *     模板编辑子菜单）+ part_process_chain（menuCode 改名）。
 *   - 2026-09-16：scan_badge 升顶级（floor_group → auth_group 货架移入 + 扫码台升级 +
 *     车间软删）。
 *   - 2026-09-24：template_management + print_templates_designer 随 x-data-spreadsheet
 *     弃用而下线（用户决策不再做模板编辑器，路由 /print-templates 与 view
 *     PrintTemplateDesigner 一并删除）。
 *   - 2026-10-08：delivery_dispatch（送货司机扫码台 /delivery-dispatch）随送货单域重构
 *     下线 —— 送货入口收进送货单列表页的「送货」按钮（见
 *     views/com/delivery/DeliveryNoteList.vue），路由与 fixture 节点同步删除。
 *   - 2026-10-13：mail_group（定时任务/邮件分组）+ mail_digest（交期汇总邮件，
 *     path /mail/digest）随交期汇总邮件定时任务页新增。
 *   - 2026-10-14（review 第 1 轮 N-2）：上面两个新 code 此前**只进了 fixture、没进本
 *     用例**的登记。
 *
 * ⚠️ **不再维护「总数 N」这个数字**：自本轮起数量已由穷尽比较隐含（清单多一个、少一个
 * 都会红），原先的 `has exactly 32 codes` 与注释里的 `30 → 32` 箭头一并删除 —— 再维护
 * 一个会过期的数字只是多一处漏改的入口。
 */
const COVERED_CODES: readonly string[] = [
  // 顶级
  'home',
  'production_stats',
  'scan_badge',
  // 分组 + 其子菜单
  'customer_management',
  'customers_list',
  'applicants_list',
  'order_group',
  'parts_list',
  'parts_new',
  'delivery_notes_manage',
  'repair_receive',
  'production_group',
  'process_work_type',
  'part_process_chain',
  'pending_programming',
  // 2026-08-26 补回 / 2026-09-11 复查：router /production/worker-queue 无 allowRoles
  // 短路 ⇒ dummy 模式必须保留此 code（少它会让该路由在 dummy 下进不去）。
  'worker_queue',
  'workers_list',
  'inspection_pending',
  'auth_group',
  'users_list',
  'shelves_list',
  'outsource_list',
  'outsource_companies_list',
  'outsource_quotes_list',
  'outsource_send_receive_list',
  'floor_group',
  'mail_group',
  'mail_digest',
  'settings_root',
  'work_types_list',
  'processes_list',
  'work_type_processes_list',
];

describe('ADMIN_MENUS', () => {
  // 2026-10-14（review 第 2 轮 B-2）：穷尽登记闸门，见 COVERED_CODES 的 doc。
  // 排序只为消除遍历顺序差异；两边都排 ⇒ fixture 侧顺序写错也不影响判定。
  it('covers all menuCodes exactly (fixture 的 code 集合与登记清单逐字相等)', () => {
    const codes = flatten(ADMIN_MENUS).map((n) => n.code);
    // 非空兜底：过滤器写错会让比较空转。
    expect(codes.length).toBeGreaterThan(0);
    expect([...codes].sort()).toEqual([...COVERED_CODES].sort());
  });

  // ⚠️ 2026-10-14（review 第 2 轮 B-2）：自上面那条改成穷尽比较后，本条在逻辑上**已被
  // 覆盖**（重复会让排序后长度对不上）—— 保留只为失败信息更直白（这里直接报「哪几个重复」
  // 而不是抛一坨数组 diff），不是唯一防线。
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
