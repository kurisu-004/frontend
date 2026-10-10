// @vitest-environment happy-dom
// src/views/iam/roles/__tests__/RolesPage.spec.ts
//
// 2026-10-14 新增：RBAC 面板的**行为**单测（守门 schema 的用例见同目录 rbacSchema.spec.ts，
// api 层的负向守卫见 src/api/__tests__/rbac.spec.ts）。
//
// 覆盖四类回归点：
//
//   1. **ADMIN 只读（双端兜底的前端那一半）**：选中 ADMIN 元角色时右区不渲染提交按钮，
//      且 store 的 `submitGrants` 直接早退不发请求。后端对 ADMIN 的 POST grants 返 400，
//      前端不给入口 = 用户不会点到一个注定失败的保存。
//   2. **整包替换语义**：提交的是「当前勾上的全集 + OCC version」，不是增量。误做成
//      增量（只发新增的 code）会让后端把该角色的其它授权**全部清空** —— 一次误操作
//      抹掉一个角色已有的全部权限，且看起来「保存成功了」。
//   3. **切角色清勾选态**：沿用上一角色的勾选会让管理员把 A 的选择误提交到 B。
//   4. **store 4 不变量**：enabled 闸门在 restoreState() 之前不发请求；对外状态是
//      plain object slice（不平铺 ref）；$dispose 后再进是全新状态。
//
// mock 策略：
//   - `vi.mock('element-plus')`：桩掉 ElMessage / ElMessageBox（node/happy-dom 下真实
//     ElMessage 会因 `document is not defined` 污染输出 —— 仓内既有 spec 统一口径）；
//   - `vi.mock('@/api/rbac')`：8 个端点；
//   - 组件级用例 mount `RoleGrantsPanel.vue` 并把 Element Plus 的展示组件桩掉
//     （只验证「按钮渲不渲染」这一条 DOM 语义，不断言 Element Plus 的内部行为）。
//   - `app.use(createPinia())` 必须早于 `app.use(VueQueryPlugin, { queryClient })`：
//     store setup 第一行 `useQueryClient()`，缺插件直接抛 "No QueryClient set"。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { createApp, nextTick } from 'vue';
import { mount } from '@vue/test-utils';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';

vi.mock('element-plus', () => ({
  ElMessage: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
  ElMessageBox: { confirm: vi.fn(async () => undefined), alert: vi.fn(async () => undefined) },
}));

/** 组件级用例的 Element Plus 展示组件桩（`global.stubs` 用 —— `vi.mock` 的 factory
 *  只替换模块导出，模板里的 `<el-button>` 等仍走全局注册，这里显式桩掉）。
 *  只断言「渲不渲染 / 点不点得到」，不断言 Element Plus 自身的内部行为。 */
const EP_STUBS = {
  // title / description 是**props**（不是 slot），桩里要显式渲染出来，
  // 否则「只读提示是否可见」这条断言恒为假。
  'el-alert': {
    props: ['title', 'description'],
    template: '<div class="alert-stub">{{ title }}{{ description }}</div>',
  },
  'el-empty': { template: '<div class="empty-stub" />' },
  'el-tree': { template: '<div class="tree-stub" />' },
  'el-button': { template: '<button @click="$emit(\'click\')"><slot /></button>' },
  'el-checkbox-group': { template: '<div><slot /></div>' },
  'el-checkbox': { template: '<label><slot /></label>' },
  'v-loading': {},
};

const listRolesMock = vi.fn();
const getRoleGrantsMock = vi.fn();
const listPermissionsMock = vi.fn();
const listMenusMock = vi.fn();
const saveRoleGrantsMock = vi.fn();
const createRoleMock = vi.fn();
const updateRoleMock = vi.fn();
const deactivateRoleMock = vi.fn();

vi.mock('@/api/rbac', () => ({
  listRoles: (...a: unknown[]) => listRolesMock(...a),
  getRoleGrants: (...a: unknown[]) => getRoleGrantsMock(...a),
  listPermissions: (...a: unknown[]) => listPermissionsMock(...a),
  listMenus: (...a: unknown[]) => listMenusMock(...a),
  saveRoleGrants: (...a: unknown[]) => saveRoleGrantsMock(...a),
  createRole: (...a: unknown[]) => createRoleMock(...a),
  updateRole: (...a: unknown[]) => updateRoleMock(...a),
  deactivateRole: (...a: unknown[]) => deactivateRoleMock(...a),
}));

import RoleGrantsPanel from '../components/RoleGrantsPanel.vue';
import { useRolesStore } from '../composables/useRolesStore';
import type { RoleDefData } from '../composables/rbacSchema';

const ADMIN: RoleDefData = {
  id: '1900000000000000001',
  code: 'ADMIN',
  name: '系统管理员',
  description: '元角色',
  is_system: true,
  is_active: true,
  version: 1,
  user_count: 2,
};

const QC_LEAD: RoleDefData = {
  id: '1900000000000000101',
  code: 'QC_LEAD',
  name: '品检组长',
  description: null,
  is_system: false,
  is_active: true,
  version: 3,
  user_count: 2,
};

/** 后端排序：is_system DESC 置顶、其余 code ASC。 */
const ROLE_ROWS: RoleDefData[] = [ADMIN, QC_LEAD];

function makeGrants(roleId: string, roleCode: string, version: number) {
  return {
    role_id: roleId,
    role_code: roleCode,
    is_system: roleCode === 'ADMIN',
    version,
    menu_codes: roleCode === 'ADMIN' ? ['users_list', 'shelves_list'] : ['users_list'],
    permission_codes: roleCode === 'ADMIN' ? ['queue.dispatch', 'part.drawing.print'] : ['queue.dispatch'],
  };
}

function makeCatalog() {
  return [
    {
      domain: 'part',
      items: [
        { code: 'part.drawing.print', name: '零件图纸打印', description: null, is_active: true },
      ],
    },
    {
      domain: 'queue',
      items: [
        { code: 'queue.dispatch', name: '队列派发', description: null, is_active: true },
      ],
    },
  ];
}

const MENU_TREE = [
  {
    id: 'g1',
    version: 0,
    parent_id: null,
    code: 'auth_group',
    title: '权限管理',
    path: null,
    icon: 'Key',
    sort_order: 30,
    children: [
      {
        id: 'r1',
        version: 0,
        parent_id: 'g1',
        code: 'roles_list',
        title: '角色权限',
        path: '/iam/roles',
        // 2026-10-14：与生产 t_menu.icon 对齐（权威值 Lock）。
        icon: 'Lock',
        sort_order: 40,
        children: [],
      },
    ],
  },
];

let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  listRolesMock.mockReset();
  getRoleGrantsMock.mockReset();
  listPermissionsMock.mockReset();
  listMenusMock.mockReset();
  saveRoleGrantsMock.mockReset();
  createRoleMock.mockReset();
  updateRoleMock.mockReset();
  deactivateRoleMock.mockReset();

  listRolesMock.mockResolvedValue(ROLE_ROWS);
  getRoleGrantsMock.mockImplementation((id: string) => {
    const role = ROLE_ROWS.find((r) => r.id === id);
    return Promise.resolve(makeGrants(id, role?.code ?? 'X', role?.version ?? 1));
  });
  listPermissionsMock.mockResolvedValue(makeCatalog());
  listMenusMock.mockResolvedValue(MENU_TREE);
  saveRoleGrantsMock.mockImplementation((id: string) =>
    Promise.resolve(makeGrants(id, 'QC_LEAD', 5)),
  );

  app = createApp({});
  app.use(createPinia());
  app.use(VueQueryPlugin, {
    queryClient: new QueryClient({ defaultOptions: { mutations: { retry: 0 }, queries: { retry: 0 } } }),
  });
  setActivePinia(app.config.globalProperties.$pinia);
  await nextTick();
});

describe('store 4 不变量 + enabled 闸门', () => {
  it('S1：restoreState() 之前不发角色列表请求；之后发一次', async () => {
    const store = useRolesStore();
    await nextTick();
    expect(listRolesMock).not.toHaveBeenCalled();

    store.query.restoreState();
    await nextTick();
    await new Promise((r) => setTimeout(r, 0));
    expect(listRolesMock).toHaveBeenCalledTimes(1);
  });

  it('S2：角色列表顺序直接沿用后端（不二次排序）', async () => {
    const store = useRolesStore();
    store.query.restoreState();
    await new Promise((r) => setTimeout(r, 0));
    await nextTick();
    expect(store.query.roles.map((r) => r.code)).toEqual(['ADMIN', 'QC_LEAD']);
  });

  it('S3：$dispose 后重新进入是全新状态（选中角色不泄漏）', async () => {
    const store = useRolesStore();
    store.query.restoreState();
    await new Promise((r) => setTimeout(r, 0));
    await nextTick();
    store.query.selectRole(QC_LEAD.id);
    expect(store.query.selectedRole?.code).toBe('QC_LEAD');

    store.$dispose();
    const fresh = useRolesStore();
    expect(fresh.query.selectedRole).toBeNull();
    expect(fresh.grants.checkedMenuCodes).toEqual([]);
  });
});

describe('ADMIN 元角色只读（双端兜底的前端那一半）', () => {
  it('A1：选中 ADMIN ⇒ isSelectedReadonly 为 true，submitGrants 早退不发请求', async () => {
    const store = useRolesStore();
    store.query.restoreState();
    await new Promise((r) => setTimeout(r, 0));
    await nextTick();

    store.query.selectRole(ADMIN.id);
    await nextTick();
    expect(store.query.isSelectedReadonly).toBe(true);

    await store.grants.submitGrants();
    expect(saveRoleGrantsMock).not.toHaveBeenCalled();
  });

  it('A2：选中 ADMIN 时 RoleGrantsPanel 不渲染「保存授权」按钮', () => {
    const wrapper = mount(RoleGrantsPanel, {
      props: {
        role: ADMIN,
        readonly: true,
        menuTree: MENU_TREE,
        permissionGroups: makeCatalog(),
        checkedMenuCodes: ['users_list'],
        checkedPermissionCodes: ['queue.dispatch'],
        loading: false,
        saving: false,
      },
      global: { stubs: EP_STUBS },
    });

    expect(wrapper.find('.grants-footer').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('保存授权');
    // 只读时仍能看到「不可修改」的说明，避免用户以为面板坏了。
    expect(wrapper.text()).toContain('系统内置角色不可修改');
  });

  it('A3：非 ADMIN 角色 ⇒ 渲染保存按钮且点击会 emit submit', async () => {
    const wrapper = mount(RoleGrantsPanel, {
      props: {
        role: QC_LEAD,
        readonly: false,
        menuTree: MENU_TREE,
        permissionGroups: makeCatalog(),
        checkedMenuCodes: ['users_list'],
        checkedPermissionCodes: ['queue.dispatch'],
        loading: false,
        saving: false,
      },
      global: { stubs: EP_STUBS },
    });

    expect(wrapper.find('.grants-footer').exists()).toBe(true);
    await wrapper.find('button').trigger('click');
    expect(wrapper.emitted('submit')).toBeTruthy();
  });

  it('A4：自定义角色（QC_LEAD）可写 —— 非内置 ⇒ 非只读', async () => {
    const store = useRolesStore();
    store.query.restoreState();
    await new Promise((r) => setTimeout(r, 0));
    await nextTick();

    store.query.selectRole(QC_LEAD.id);
    await nextTick();
    expect(store.query.isSelectedReadonly).toBe(false);
  });
});

describe('授权保存：整包替换 + OCC version', () => {
  it('G1：提交 body 含 version，且两个数组是**当前勾上的全集**', async () => {
    const store = useRolesStore();
    store.query.restoreState();
    await new Promise((r) => setTimeout(r, 0));
    await nextTick();

    store.query.selectRole(QC_LEAD.id);
    await nextTick();
    // 灌入勾选态（模拟 el-tree / checkbox 的变更）
    store.grants.setCheckedMenus(['users_list', 'roles_list']);
    store.grants.setCheckedPermissions(['queue.dispatch', 'part.drawing.print']);

    await store.grants.submitGrants();

    expect(saveRoleGrantsMock).toHaveBeenCalledTimes(1);
    const [id, payload] = saveRoleGrantsMock.mock.calls[0]!;
    expect(id).toBe(QC_LEAD.id);
    // version 取 RoleGrants.version（授权包的 OCC 锚）
    expect(payload.version).toBe(QC_LEAD.version);
    // 整包替换：**全量**而不是增量 —— 少传一个 code 后端就把该角色的这一项清空。
    expect(payload.menu_codes.sort()).toEqual(['roles_list', 'users_list']);
    expect(payload.permission_codes.sort()).toEqual(['part.drawing.print', 'queue.dispatch']);
  });

  it('G2：取消勾选某项后提交，body 里**不含**该项（证明不是增量追加）', async () => {
    const store = useRolesStore();
    store.query.restoreState();
    await new Promise((r) => setTimeout(r, 0));
    await nextTick();

    store.query.selectRole(QC_LEAD.id);
    await nextTick();
    // grants 到位时灌的是 ['users_list']，这里去掉它 —— 若实现是「增量」，
    // body 里仍会带着 users_list，真实后端则会把这一项抹掉。
    store.grants.setCheckedMenus([]);

    await store.grants.submitGrants();
    const [, payload] = saveRoleGrantsMock.mock.calls[0]!;
    expect(payload.menu_codes).toEqual([]);
  });

  it('G3：切角色会把勾选态整体重置（不把 A 的选择提交到 B）', async () => {
    const store = useRolesStore();
    store.query.restoreState();
    await new Promise((r) => setTimeout(r, 0));
    await nextTick();

    store.query.selectRole(QC_LEAD.id);
    await nextTick();
    store.grants.setCheckedMenus(['users_list', 'roles_list']);

    store.query.selectRole(ADMIN.id);
    expect(store.grants.checkedMenuCodes).toEqual([]);
  });
});

describe('坏响应守门（queryFn 真接在返回路径上）', () => {
  it('B1：角色列表缺必填字段 ⇒ 不进 data（守门在 queryFn）', async () => {
    listRolesMock.mockResolvedValue([{ id: 'x', code: 'Y' }]);
    const store = useRolesStore();
    store.query.restoreState();
    await new Promise((r) => setTimeout(r, 0));
    await nextTick();
    // 数据恒空（而不是渲染出一个缺字段的行）
    expect(store.query.roles).toEqual([]);
  });
});