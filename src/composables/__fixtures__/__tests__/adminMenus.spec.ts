import { describe, it, expect } from 'vitest';
import { ADMIN_MENUS } from '../adminMenus';
import { ICON_MAP } from '@/layouts/components/menuIcons';
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
 *   - 2026-10-14（RBAC 控制面板）：auth_group 新增 roles_list（path /iam/roles）。
 *   - 2026-10-16（定时任务域改名）：上面那两个 code 改掉了 —— `mail_group` →
 *     `scheduled_task`（分组管的是定时任务这一整类后台作业，邮件只是它的第一个子域）、
 *     `mail_digest` → `mail`（邮件类型改用页内 tab 区分，不再占菜单层级，path 随之
 *     /mail/digest → /mail）。**改了 code 就必须改这里**：漏改的症状是用例红在
 *     `covers all menuCodes exactly` 上。
 *   - 2026-10-17（企业微信推送子模块）：`scheduled_task` 分组下**新增** `wecom`
 *     （path /wecom、icon ChatDotRound、sort_order 20）。**新增 code 也必须改这里**：
 *     漏改的症状同上（fixture 里多一个 code、清单里没有 → 红）。
 *   - 2026-10-16（review 第 1 轮 MAJOR-1）：`template_management` + `print_templates_designer`
 *     **复活**（2026-10-14 首次落地 → 09-24 随 x-data-spreadsheet 弃用从 fixture 删除 →
 *     10-16 送货单打印模板上传页重新占用同一个 URL 与菜单节点）。
 *     ⚠️ 这对 code 的删除与复活**两侧都没漏**（fixture 删了、这里也删了）⇒ 那一轮
 *     `covers all menuCodes exactly` 依然全绿：本用例只能守住「fixture 与本清单一致」，
 *     **守不住「fixture 与后端 seeds/menu.sql 一致」** —— 后者靠文件头「每次后端菜单树变更
 *     必须同步」的纪律 + 本文件下方那组定位断言（它们把 id / path / sort_order / icon 逐字
 *     钉死，缺节点时「定位断言整个 describe 找不到节点即红」）。
 *   - 2026-10-19（人事排班日历）：新增 `hr_group`（一级分组「人事管理」、path NULL）与
 *     `hr_schedule_calendar`（子菜单「排班日历」、path /hr/schedule）。**新增 code 也必须改
 *     这里**：漏改的症状同上（fixture 里多两个 code、清单里没有 → 红）。
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
  // 2026-10-13 补回 / 2026-09-11 复查：router /production/worker-queue 无 allowRoles
  // 短路 ⇒ dummy 模式必须保留此 code（少它会让该路由在 dummy 下进不去）。
  'worker_queue',
  'workers_list',
  'inspection_pending',
  // 2026-10-16（review 第 1 轮 MAJOR-1）：模板管理分组 + 模板编辑子菜单**复活**。
  // ⚠️ 后端 seeds/rbac.sql 只把它授给 MANAGER（CLERK / INSPECTOR / CNC_PROGRAMMER /
  // SHELF_ACCOUNT 四段都没有），而 ADMIN_MENUS 是 ADMIN 的菜单树 —— 守卫第 3 条
  // `treeContainsCode(auth.menus, 'print_templates_designer')` 为 false 时会把用户踢回
  // 首个有 path 的菜单，所以**少这两个 code 不是「少两项侧栏」而是「页面在 dummy 下不可达」**。
  'template_management',
  'print_templates_designer',
  'auth_group',
  'users_list',
  'shelves_list',
  // 2026-10-14（RBAC 控制面板）：auth_group 新增 roles_list。
  'roles_list',
  'outsource_list',
  'outsource_companies_list',
  'outsource_quotes_list',
  'outsource_send_receive_list',
  'floor_group',
  'scheduled_task',
  'mail',
  // 2026-10-17（企业微信推送子模块）：scheduled_task 分组下新增 wecom（path /wecom）。
  'wecom',
  // 2026-10-19（人事排班日历）：新增一级分组 hr_group「人事管理」（path NULL）及其子菜单
  // hr_schedule_calendar「排班日历」（path /hr/schedule）。⚠️ 少这两个 code 的症状不是
  // 「侧栏少两项」而是「dummy 模式下直接敲 /hr/schedule 也进不去」（守卫第 3 条）。
  'hr_group',
  'hr_schedule_calendar',
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

  // 2026-10-14（RBAC 控制面板）：roles_list 的四条定位断言。它们是「新增一个菜单
  // 节点」要满足的完整清单 —— 上面那条穷尽比较只管「code 集合」，管不到下面这些。
  describe('roles_list 节点（RBAC 控制面板）', () => {
    const authGroup = () => flatten(ADMIN_MENUS).find((n) => n.code === 'auth_group')!;

    it('挂在 auth_group 下，path /iam/roles（与 router 的 path 逐字一致）', () => {
      const node = authGroup().children.find((c) => c.code === 'roles_list');
      expect(node).toBeDefined();
      expect(node!.path).toBe('/iam/roles');
      expect(node!.title).toBe('角色权限');
    });

    it('icon 在 MenuTreeItem 的 ICON_MAP 白名单内（查不到会静默不显示）', () => {
      const node = authGroup().children.find((c) => c.code === 'roles_list')!;
      // 直接查**真实**白名单（`layouts/components/menuIcons.ts`，MenuTreeItem.vue 消费
      // 同一份）。之前这里抄了一份 ICON_MAP 副本，把组件里的 Lock 删掉用例照绿 ——
      // 断言在验副本而不是在验实现。
      expect(ICON_MAP[node.icon!]).toBeDefined();
    });

    it('icon 是权威值 `Lock`（跨仓对齐：后端 seeds/menu.sql 的 t_menu.icon）', () => {
      // 上面那条只保证「图标在白名单里、渲染得出来」；`Key` 也在白名单里，所以把它改回
      // `Key` 或换成任意其它白名单图标都不会红。这条单独钉住**权威值**，让「dummy 模式
      // 与生产图标不一致」这类漂移有测试信号。
      const node = authGroup().children.find((c) => c.code === 'roles_list')!;
      expect(node.icon).toBe('Lock');
      // 父节点 auth_group 仍是 Key —— 两者刻意区分，别顺手改成一致。
      expect(authGroup().icon).toBe('Key');
    });

    it('**数组物理位置**接在 shelves_list 之后（侧栏按数组顺序渲染、不排 sort_order）', () => {
      const codes = authGroup().children.map((c) => c.code);
      expect(codes.indexOf('roles_list')).toBe(codes.indexOf('shelves_list') + 1);
    });

    it('sort_order 落在 shelves_list(30) 之后', () => {
      const children = authGroup().children;
      const roles = children.find((c) => c.code === 'roles_list')!;
      const shelves = children.find((c) => c.code === 'shelves_list')!;
      expect(roles.sort_order).toBeGreaterThan(shelves.sort_order);
    });
  });

  // 2026-10-16 新增：`scheduled_task` / `mail` 两个节点的定位断言。改名的这一轮最容易
  // 漏的是「fixture 改了、router 没改」（或反过来）—— code 与 path 两边各写一份字面量，
  // 对不上时运行时症状是「点菜单闪一下又回到别的页」（守卫第 3 条），不是编译错误。
  describe('scheduled_task / mail / wecom 节点（定时任务 → 邮件 + 企业微信）', () => {
    const all = () => flatten(ADMIN_MENUS);
    const group = () => all().find((n) => n.code === 'scheduled_task')!;
    const leaf = () => all().find((n) => n.code === 'mail')!;
    const wecom = () => all().find((n) => n.code === 'wecom')!;

    it('一级分组 scheduled_task「定时任务」path 为 null（渲染成 el-sub-menu）', () => {
      expect(group().title).toBe('定时任务');
      expect(group().path).toBeNull();
      // 2026-10-17：children 由 1 个变 2 个（mail + wecom），**顺序即渲染顺序**。
      expect(group().children.map((c) => c.code)).toEqual(['mail', 'wecom']);
    });

    it("二级 mail「邮件」path 为 /mail（与 router 的 `path: 'mail'` 逐字一致）", () => {
      expect(leaf().title).toBe('邮件');
      expect(leaf().path).toBe('/mail');
      expect(leaf().parent_id).toBe(group().id);
    });

    it('两个 icon 都在 MenuTreeItem 的 ICON_MAP 白名单内（查不到会静默不显示）', () => {
      expect(ICON_MAP[group().icon!]).toBeDefined();
      expect(ICON_MAP[leaf().icon!]).toBeDefined();
      expect(ICON_MAP[wecom().icon!]).toBeDefined();
    });

    it('id 用后端 seed 的新 id、不复用软删的旧 id（9000000000000014 / …902 / …903）', () => {
      // 旧的两行已被后端软删；id 是唯一能把「软删 + 改名」与「原地改名」区分开的标识。
      expect(group().id).toBe('9000000000000014');
      expect(leaf().id).toBe('9000000000000902');
      expect(wecom().id).toBe('9000000000000903');
    });

    it('**数组物理位置**落在 floor_group(40) 与 settings_root(50) 之间', () => {
      const codes = ADMIN_MENUS.map((n) => n.code);
      // 紧贴 floor_group(40) 之后：45 槽位紧邻上一个顶级节点，这一点不变。
      expect(codes.indexOf('scheduled_task')).toBe(codes.indexOf('floor_group') + 1);
      // ⚠️ 右邻**刻意只断先后不断相邻**（2026-10-19 起）：hr_group(48) 插进了
      // scheduled_task(45) 与 settings_root(50) 之间，「紧邻 settings_root」已不成立，而本组
      // 用例守的是本节点的插入位。hr_group 自己的物理位置由下方 `hr_group /
      // hr_schedule_calendar 节点` 那组的两条相邻断言守（scheduled_task + 1 === hr_group
      // 且 hr_group + 1 === settings_root），两头合起来仍把整段序列钉死。
      expect(codes.indexOf('scheduled_task')).toBeLessThan(codes.indexOf('settings_root'));
    });

    it('旧 code 已彻底下线（fixture 里不得残留 mail_group / mail_digest）', () => {
      const codes = all().map((n) => n.code);
      expect(codes).not.toContain('mail_group');
      expect(codes).not.toContain('mail_digest');
    });

    // ── 2026-10-17 企业微信推送子模块新增的四条 ──────────────────────────────
    // 这一组与上面那组同源：code 与 path 两边（fixture ↔ router `meta.menuCode`）各写一份
    // 字面量，对不上时的运行时症状是「点菜单闪一下又回到别的页」，不是编译错误。
    it("wecom「企业微信」path 为 /wecom（与 router 的 `path: 'wecom'` 逐字一致）", () => {
      expect(wecom().title).toBe('企业微信');
      // ⚠️ path 与后端 API 前缀（/api/v2/cron/wecom/*）**无关**：它是浏览器书签 URL +
      // 后端菜单表 t_menu.path 的值。将来改 API 前缀时不要连带改这里。
      expect(wecom().path).toBe('/wecom');
      expect(wecom().parent_id).toBe(group().id);
    });

    it('icon 是权威值 ChatDotRound（与 backend-rust seeds/menu.sql 的 t_menu.icon 对齐）', () => {
      // 上面那条只保证「图标在白名单里、渲染得出来」；`Message` 也在白名单里，所以换掉它
      // 不会红。这条单独钉住权威值，让「dummy 模式与生产图标不一致」这类漂移有测试信号。
      expect(wecom().icon).toBe('ChatDotRound');
    });

    it('**数组物理位置**接在 mail 之后（侧栏按数组顺序渲染、不排 sort_order）', () => {
      const codes = group().children.map((c) => c.code);
      expect(codes.indexOf('wecom')).toBe(codes.indexOf('mail') + 1);
    });

    it('sort_order 落在 mail(10) 之后', () => {
      const children = group().children;
      const w = children.find((c) => c.code === 'wecom')!;
      const m = children.find((c) => c.code === 'mail')!;
      expect(w.sort_order).toBeGreaterThan(m.sort_order);
    });
  });

  // 2026-10-16（review 第 1 轮 MAJOR-1）：`template_management` / `print_templates_designer`
  // 两个节点的定位断言。照 `roles_list` 那组的形态写 —— 上面那条穷尽比较只管「code 集合」，
  // 管不到「挂在哪个分组下 / path 逐字对不对 / icon 渲染得出来吗 / 数组物理位置对不对」，
  // 而这四件事里任何一件错位在 dummy 模式下的症状都是同一个：页面进不去或侧栏顺序错。
  // 缺节点时下面 `group()` / `leaf()` 的 `!` 会抛 TypeError（而不是静默通过），这是刻意的：
  // 「节点被删了」必须红，不能变成一组恒真断言。
  describe('template_management / print_templates_designer 节点（送货单打印模板）', () => {
    const all = () => flatten(ADMIN_MENUS);
    const group = () => all().find((n) => n.code === 'template_management')!;
    const leaf = () => all().find((n) => n.code === 'print_templates_designer')!;

    it('一级分组 template_management「模板管理」path 为 null（渲染成 el-sub-menu）', () => {
      expect(group().title).toBe('模板管理');
      expect(group().path).toBeNull();
      expect(group().children.map((c) => c.code)).toEqual(['print_templates_designer']);
    });

    it("二级 print_templates_designer「模板编辑」path 为 /print-templates（与 router 的 `path: 'print-templates'` 逐字一致）", () => {
      // ⚠️ path 与 router 逐字一致是**硬约束**：不一致时守卫第 3 条把用户踢走，
      // 现象是「点菜单闪一下又回到别的页」，不是编译错误（router 侧没有反向测试）。
      expect(leaf().title).toBe('模板编辑');
      expect(leaf().path).toBe('/print-templates');
      expect(leaf().parent_id).toBe(group().id);
    });

    it('两个 icon 都在 MenuTreeItem 的 ICON_MAP 白名单内（查不到会静默不显示）', () => {
      expect(ICON_MAP[group().icon!]).toBeDefined();
      expect(ICON_MAP[leaf().icon!]).toBeDefined();
    });

    it('id 与 backend-rust seeds/menu.sql 逐字一致（9000000000000008 / …701）', () => {
      // 后端从未软删这两行（2026-09-24 只是前端 fixture 删了），id 是唯一能把
      // 「后端仍是同一行」与「后端换了新行」区分开的标识。
      expect(group().id).toBe('9000000000000008');
      expect(leaf().id).toBe('9000000000000701');
    });

    it('**数组物理位置**落在 production_group 与 auth_group 之间（侧栏按数组顺序渲染）', () => {
      const codes = ADMIN_MENUS.map((n) => n.code);
      expect(codes.indexOf('template_management')).toBe(codes.indexOf('production_group') + 1);
      expect(codes.indexOf('template_management') + 1).toBe(codes.indexOf('auth_group'));
    });

    // ⚠️ **用例名里刻意不写死 sort_order 的数值**（2026-10-16 review 第 2 轮 M-2）：原先叫
    // 「sort_order 落在 production_group(26) 与 auth_group(30) 之间」，那个 `26` 是 fixture
    // 自身与后端 `seeds/menu.sql` 的**已知漂移**（后端是 27），断言比的是 fixture 内部值、
    // 自洽能过，但用例名把漂移值当权威传播了。断言保持读 fixture 值不变。
    it('sort_order 落在 production_group 与 auth_group 之间', () => {
      expect(group().sort_order).toBeGreaterThan(
        all().find((n) => n.code === 'production_group')!.sort_order,
      );
      expect(group().sort_order).toBeLessThan(
        all().find((n) => n.code === 'auth_group')!.sort_order,
      );
    });
  });

  // 2026-10-19 新增：`hr_group` / `hr_schedule_calendar` 两个节点的定位断言。照
  // `scheduled_task` / `template_management` 那两组的形态写 —— 上面那条穷尽比较只管
  // 「code 集合」，管不到「path 与 router 逐字一致吗 / icon 渲染得出来吗 / 数组物理位置
  // 对吗」，而这几件里任何一件错位在 dummy 模式下的症状都是同一个：页面进不去或侧栏顺序错。
  // 缺节点时下面 `group()` / `leaf()` 的 `!` 会抛 TypeError（而不是静默通过），这是刻意的：
  // 「节点被删了」必须红，不能变成一组恒真断言。
  describe('hr_group / hr_schedule_calendar 节点（人事排班日历）', () => {
    const all = () => flatten(ADMIN_MENUS);
    const group = () => all().find((n) => n.code === 'hr_group')!;
    const leaf = () => all().find((n) => n.code === 'hr_schedule_calendar')!;

    it('一级分组 hr_group「人事管理」path 为 null、icon 为 Avatar、sort_order 48', () => {
      expect(group().title).toBe('人事管理');
      // path=null 是「分组」的判定口径：MenuTreeItem 渲染成 el-sub-menu，不需要前端路由。
      expect(group().path).toBeNull();
      expect(group().icon).toBe('Avatar');
      expect(group().sort_order).toBe(48);
    });

    it('**数组物理位置**落在 scheduled_task(45) 与 settings_root(50) 之间（侧栏按数组顺序渲染）', () => {
      const codes = ADMIN_MENUS.map((n) => n.code);
      expect(codes.indexOf('hr_group')).toBe(codes.indexOf('scheduled_task') + 1);
      expect(codes.indexOf('hr_group') + 1).toBe(codes.indexOf('settings_root'));
    });

    it("二级 hr_schedule_calendar「排班日历」path 为 /hr/schedule（与 router 的 `path: 'hr/schedule'` 逐字一致）", () => {
      // ⚠️ path 与 router 逐字一致是**硬约束**：不一致时守卫第 3 条把用户踢走，现象是
      // 「点菜单闪一下又回到别的页」，不是编译错误（router 侧没有反向测试）。
      // ⚠️ path 与后端 API URL（/api/v2/hr/*）**无关**：它是浏览器书签 URL + 后端菜单表
      // t_menu.path 的值。
      expect(leaf().title).toBe('排班日历');
      expect(leaf().path).toBe('/hr/schedule');
      expect(leaf().parent_id).toBe(group().id);
    });

    it('子菜单物理位置是 children[0]、sort_order 为 10（分组内首项）', () => {
      expect(group().children.map((c) => c.code)).toEqual(['hr_schedule_calendar']);
      expect(group().children[0].sort_order).toBe(10);
    });

    it('两个 icon 都在 MenuTreeItem 的 ICON_MAP 白名单内（查不到会静默不显示）', () => {
      // 直接查**真实**白名单（`layouts/components/menuIcons.ts`），不抄副本。
      expect(ICON_MAP[group().icon!]).toBeDefined();
      expect(ICON_MAP[leaf().icon!]).toBeDefined();
      // 权威值单独钉住：`Avatar` / `Calendar` 都在白名单里，换成任意另一个白名单图标不会
      // 让上一条红，这条才有「dummy 模式与生产图标不一致」的测试信号。
      expect(group().icon).toBe('Avatar');
      expect(leaf().icon).toBe('Calendar');
    });

    it('id 与 backend-rust seeds/menu.sql 逐字一致（9000000000000015 / …910）', () => {
      expect(group().id).toBe('9000000000000015');
      expect(leaf().id).toBe('9000000000000910');
    });
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
