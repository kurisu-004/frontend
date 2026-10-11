// @vitest-environment happy-dom
// src/views/iam/roles/__tests__/RolesPage.spec.ts
//
// 2026-10-14 新增：RBAC 面板的**行为**单测（守门 schema 的用例见同目录 rbacSchema.spec.ts，
// api 层的负向守卫见 src/api/__tests__/rbac.spec.ts）。
//
// 覆盖下列回归点：
//
//   1. **ADMIN 只读（双端兜底的前端那一半）**：选中 ADMIN 元角色时右区不渲染提交按钮，
//      且 store 的 `submitGrants` 直接早退不发请求。后端对 ADMIN 的 POST grants 返 400，
//      前端不给入口 = 用户不会点到一个注定失败的保存。
//   2. **整包替换语义**：提交的是「当前勾上的全集 + OCC version」，不是增量。误做成
//      增量（只发新增的 code）会让后端把该角色的其它授权**全部清空** —— 一次误操作
//      抹掉一个角色已有的全部权限，且看起来「保存成功了」。
//   3. **切角色清勾选态**：沿用上一角色的勾选会让管理员把 A 的选择误提交到 B。
//      反向的「同 id 重发 current-change」不清勾选（表格数据替换，见 G6）。
//   4. **菜单树回填（check-strictly + setCheckedKeys）**：grants 到位后必须驱动 el-tree
//      的勾选态；不回填则「角色已授 5 项、树显示 0 勾」，管理员勾一项保存即清空其余。
//   5. **停用 / 删除链路接通**：按钮 → 二次确认 → deactivate 端点 → 成功提示带
//      affected_user_count；取消分支不发请求；在途 loading 逐行收口，状态 tag 反映
//      内置角色的停用态。
//   6. **表单校验错误展示**：code 非法 / 新建态留空时弹窗内必须出错误文案，不能只是
//      保持打开而零提示。
//
// mock 策略：
//   - `vi.mock('element-plus')`：桩掉 ElMessage / ElMessageBox（node/happy-dom 下真实
//     ElMessage 会因 `document is not defined` 污染输出 —— 仓内既有 spec 统一口径）；
//   - `vi.mock('@/api/rbac')`：8 个端点；
//   - 组件级用例 mount 真实 `RoleGrantsPanel.vue` / `RolesPage.vue` 并桩掉 Element Plus
//     展示组件（只验证接线与 DOM 语义，不断言 Element Plus 的内部行为）；el-tree 的桩
//     暴露 setCheckedKeys / getCheckedKeys 以便断言回填参数；
//   - `app.use(createPinia())` / `global.plugins` 顺序必须早于 VueQueryPlugin：
//     store setup 第一行 `useQueryClient()`，缺插件直接抛 "No QueryClient set"。
//
// ⚠️ 「停用/删除」与「改名」的按钮文案是断言入口（`findButton`），改文案要同步改这里。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import {
  createApp,
  computed,
  defineComponent,
  h,
  nextTick,
  watchEffect,
  type Component,
} from 'vue';
import { flushPromises, mount, type DOMWrapper, type Stubs } from '@vue/test-utils';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';
import { ElMessage, ElMessageBox } from 'element-plus';

vi.mock('element-plus', () => ({
  ElMessage: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
  ElMessageBox: { confirm: vi.fn(async () => undefined), alert: vi.fn(async () => undefined) },
}));

/** 组件级用例的 Element Plus 展示组件桩（`global.stubs` 用 —— `vi.mock` 的 factory
 *  只替换模块导出，模板里的 `<el-button>` 等仍走全局注册，这里显式桩掉）。
 *  只断言「渲不渲染 / 点不点得到 / disabled 传递」，不断言 Element Plus 自身的内部行为。 */
const EP_STUBS = {
  // title / description 是**props**（不是 slot），桩里要显式渲染出来，
  // 否则「只读提示是否可见」这条断言恒为假。
  'el-alert': {
    props: ['title', 'description'],
    template: '<div class="alert-stub">{{ title }}{{ description }}</div>',
  },
  'el-empty': { template: '<div class="empty-stub" />' },
  'el-tree': { template: '<div class="tree-stub" />' },
  'el-button': defineComponent({
    name: 'ElButtonStub',
    props: { disabled: Boolean, loading: Boolean },
    emits: ['click'],
    template:
      '<button class="mock-button" :disabled="disabled" :data-loading="loading ? \'1\' : \'0\'" @click="$emit(\'click\')"><slot /></button>',
  }),
  'el-checkbox-group': { template: '<div><slot /></div>' },
  'el-checkbox': { template: '<label><slot /></label>' },
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
import RolesPage from '../RolesPage.vue';
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

/** 内置的**非 ADMIN** 角色（后端允许改名 / 停用，不允许删除）。 */
const SYSTEM_MANAGER: RoleDefData = {
  id: '1900000000000000002',
  code: 'MANAGER',
  name: '生产经理',
  description: null,
  is_system: true,
  is_active: true,
  version: 1,
  user_count: 1,
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

/** 自定义角色、无人持有 ⇒ code 可编辑。 */
const EMPTY_CUSTOM: RoleDefData = {
  id: '1900000000000000102',
  code: 'QC_LEAD_NEW',
  name: '品检组',
  description: null,
  is_system: false,
  is_active: true,
  version: 1,
  user_count: 0,
};

/** 后端排序：is_system DESC 置顶、其余 code ASC（store 用例的最小集）。 */
const ROLE_ROWS: RoleDefData[] = [ADMIN, QC_LEAD];

function makeGrants(roleId: string, roleCode: string, version: number) {
  return {
    role_id: roleId,
    role_code: roleCode,
    is_system: roleCode === 'ADMIN',
    version,
    menu_codes: roleCode === 'ADMIN' ? ['users_list', 'shelves_list'] : ['users_list'],
    permission_codes:
      roleCode === 'ADMIN' ? ['queue.dispatch', 'part.drawing.print'] : ['queue.dispatch'],
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
      items: [{ code: 'queue.dispatch', name: '队列派发', description: null, is_active: true }],
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
        id: 'u1',
        version: 0,
        parent_id: 'g1',
        code: 'users_list',
        title: '账号管理',
        path: '/users',
        icon: 'List',
        sort_order: 10,
        children: [],
      },
      {
        id: 's1',
        version: 0,
        parent_id: 'g1',
        code: 'shelves_list',
        title: '货架管理',
        path: '/shelves',
        icon: 'Platform',
        sort_order: 30,
        children: [],
      },
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

// ============================================================================
// el-tree 桩：暴露 setCheckedKeys / getCheckedKeys 并记录调用参数
// ============================================================================

interface TreeStubBag {
  TreeStub: Component;
  state: { calls: string[][]; checked: string[]; checkStrictly: boolean };
}

/** 桩的核心是「像真实 el-tree 一样持有勾选集合」：
 *  - setCheckedKeys(keys) 记录参数并替换内部集合；
 *  - getCheckedKeys() 返回内部集合 —— 保存按钮读它，断言提交的就是树当下的勾选态；
 *  - checkStrictly 记录收到的 prop（expose 之后 vm 上取不到 $props）。
 *  「回填 → setCheckedKeys(交集)」与「保存 → getCheckedKeys()」两条如果被回退，本文件的
 *  T 组用例会同时变红。 */
function makeTreeStub(): TreeStubBag {
  const state = { calls: [] as string[][], checked: [] as string[], checkStrictly: false };
  const TreeStub = defineComponent({
    name: 'ElTreeStub',
    props: {
      data: { type: Array, default: () => [] },
      checkStrictly: Boolean,
      showCheckbox: Boolean,
      nodeKey: String,
    },
    emits: ['check'],
    setup(props, { expose }) {
      // watchEffect 而非直接取 props.checkStrictly：setup 根作用域解构 props 会触发
      // vue/no-setup-props-destructure（丢掉响应性）。
      watchEffect(() => {
        state.checkStrictly = props.checkStrictly;
      });
      const setCheckedKeys = (keys: string[]): void => {
        state.calls.push([...keys]);
        state.checked = [...keys];
      };
      const getCheckedKeys = (): Array<string | number> => [...state.checked];
      expose({ setCheckedKeys, getCheckedKeys });
      return () => h('div', { class: 'tree-stub' });
    },
  });
  return { TreeStub, state };
}

// ============================================================================
// 页面级 mount 的 Element Plus 桩：真实 el-table 会把 data 的每一行喂给每个 column 的
// 默认插槽 —— 桩里用 provide / inject 把 rows 传给列，列逐行渲染 slot（操作列的按钮
// 才拿得到 row）。表格桩额外渲染每行的 `.row-select` 按钮模拟 current-change。
// ============================================================================

const PAGE_STUBS = {
  ...EP_STUBS,
  'el-table': defineComponent({
    name: 'ElTableStub',
    // computed 而非直接给数组：data 初始为空、列表加载后才填上，直接给值会把空数组固化。
    provide() {
      return { rows: computed(() => this.data) };
    },
    props: { data: { type: Array, default: () => [] } },
    emits: ['current-change'],
    template:
      '<div class="table-stub">' +
      '<button v-for="r in data" :key="r.id" class="row-select" :data-code="r.code" @click="$emit(\'current-change\', r)" />' +
      '<slot />' +
      '</div>',
  }),
  'el-table-column': defineComponent({
    name: 'ElTableColumnStub',
    inject: { rows: { default: () => [] } },
    props: ['prop', 'label', 'width', 'minWidth', 'align', 'fixed'],
    template:
      '<div class="col-stub" :data-label="label">' +
      '<div class="cell-stub" v-for="(r, i) in rows" :key="i" :data-row-code="r.code">' +
      '<slot :row="r" :$index="i" />' +
      '</div>' +
      '</div>',
  }),
  'el-dialog': {
    props: ['modelValue', 'title', 'width'],
    emits: ['closed', 'update:modelValue'],
    template:
      '<div class="dialog-stub" v-if="modelValue"><slot /><div class="dialog-footer"><slot name="footer" /></div></div>',
  },
  'el-form': { template: '<form class="form-stub"><slot /></form>' },
  'el-form-item': { template: '<div class="form-item-stub"><slot /></div>' },
  'el-input': defineComponent({
    name: 'ElInputStub',
    props: { modelValue: String, disabled: Boolean },
    emits: ['update:modelValue'],
    template:
      '<input class="mock-input" :value="modelValue" :disabled="disabled" @input="$emit(\'update:modelValue\', $event.target.value)" />',
  }),
  'el-tag': { template: '<span class="tag-stub"><slot /></span>' },
};

/** 挂载整页（真实 store + 真实 RoleGrantsPanel）。每个用例独立 pinia / QueryClient，
 *  避免跨用例缓存串味。 */
function mountRolesPage(stubs: Stubs = {}) {
  const pinia = createPinia();
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: 0 }, queries: { retry: 0 } },
  });
  return mount(RolesPage, {
    global: {
      plugins: [
        pinia,
        [VueQueryPlugin, { queryClient }] as [typeof VueQueryPlugin, { queryClient: QueryClient }],
      ],
      stubs: { ...PAGE_STUBS, ...stubs },
      directives: { loading: {} },
    },
  });
}

/** 操作列里某一行（`data-row-code`）的单元格。 */
function opCell(wrapper: ReturnType<typeof mount>, code: string): DOMWrapper<Element> {
  return wrapper.find(`.col-stub[data-label="操作"] .cell-stub[data-row-code="${code}"]`);
}

/** 在给定容器内按文案找按钮（文案即断言入口，见文件头）。 */
function findButton<T extends { findAll: (s: string) => DOMWrapper<Element>[] }>(
  root: T,
  text: string,
): DOMWrapper<Element> | undefined {
  return root.findAll('button').find((b) => b.text().includes(text));
}

/** 某行操作列的按钮文案序列。 */
function opButtonTexts(wrapper: ReturnType<typeof mount>, code: string): string[] {
  return opCell(wrapper, code)
    .findAll('button')
    .map((b) => b.text());
}

let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  vi.clearAllMocks();
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
  deactivateRoleMock.mockResolvedValue({ affected_user_count: 2 });

  app = createApp({});
  app.use(createPinia());
  app.use(VueQueryPlugin, {
    queryClient: new QueryClient({
      defaultOptions: { mutations: { retry: 0 }, queries: { retry: 0 } },
    }),
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
        ready: true,
      },
      global: { stubs: EP_STUBS, directives: { loading: {} } },
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
        ready: true,
      },
      global: { stubs: EP_STUBS, directives: { loading: {} } },
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
    await new Promise((r) => setTimeout(r, 0));
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
    await new Promise((r) => setTimeout(r, 0));
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

  // B3 回归锁：grants 未就绪时提交空集 = 用合法 OCC 版本清空整角色授权。
  it('G4：grants 未到达 ⇒ ready=false，submitGrants 早退不发请求且给出提示', async () => {
    getRoleGrantsMock.mockImplementation(() => new Promise(() => undefined));
    const store = useRolesStore();
    store.query.restoreState();
    await new Promise((r) => setTimeout(r, 0));
    await nextTick();

    store.query.selectRole(QC_LEAD.id);
    await nextTick();
    expect(store.grants.ready).toBe(false);

    await store.grants.submitGrants();
    expect(saveRoleGrantsMock).not.toHaveBeenCalled();
    expect(ElMessage.warning).toHaveBeenCalledWith('授权加载中，请稍候');
  });

  // M3 回归锁：hydratedFor 不随 selectRole 重置 ⇒ 切走再切回同一角色永远不再灌勾选。
  it('G5：切走再切回同一角色，勾选态会重新灌回', async () => {
    const store = useRolesStore();
    store.query.restoreState();
    await new Promise((r) => setTimeout(r, 0));
    await nextTick();

    store.query.selectRole(QC_LEAD.id);
    await nextTick();
    await new Promise((r) => setTimeout(r, 0));
    expect(store.grants.checkedMenuCodes).toEqual(['users_list']);

    store.query.selectRole(ADMIN.id);
    await nextTick();
    await new Promise((r) => setTimeout(r, 0));

    store.query.selectRole(QC_LEAD.id);
    await nextTick();
    await new Promise((r) => setTimeout(r, 0));
    expect(store.grants.checkedMenuCodes).toEqual(['users_list']);
  });

  // B-1 回归锁（review 第 2 轮）：el-table 的 `:data` 被替换（写后失效重拉 / staleTime
  // 到期刷新）时会对同 id 的行重发 current-change（Element Plus setData →
  // setCurrentRowByKey 无条件 emit）。selectRole 必须同 id 早退 —— 否则勾选态被清空 +
  // hydratedFor 打回 ''，而 grants 的对象引用没变 ⇒ 永远不再灌回，停在「空勾选 +
  // ready=true」，此时点保存就是整包清空该角色授权。
  it('G6：同 id 重发 current-change（表格数据替换）⇒ 勾选态保持而非清空', async () => {
    const store = useRolesStore();
    store.query.restoreState();
    await new Promise((r) => setTimeout(r, 0));
    await nextTick();

    store.query.selectRole(QC_LEAD.id);
    await nextTick();
    await new Promise((r) => setTimeout(r, 0));
    expect(store.grants.checkedMenuCodes).toEqual(['users_list']);
    expect(store.grants.ready).toBe(true);

    // 直接复现表格的重发：同 id 新对象在视图层最终也走 selectRole(id)。
    store.query.selectRole(QC_LEAD.id);
    await nextTick();
    expect(store.grants.checkedMenuCodes).toEqual(['users_list']);
    expect(store.grants.checkedPermissionCodes).toEqual(['queue.dispatch']);
  });
});

describe('菜单树回填（B1：check-strictly + setCheckedKeys / getCheckedKeys）', () => {
  const baseProps = {
    readonly: false,
    permissionGroups: makeCatalog(),
    checkedPermissionCodes: [] as string[],
    loading: false,
    saving: false,
    ready: true,
  };

  it('T1：grants 到位 ⇒ setCheckedKeys 收到精确授权集合；树里没有的 code 被过滤', () => {
    const { TreeStub, state } = makeTreeStub();
    mount(RoleGrantsPanel, {
      props: {
        ...baseProps,
        role: QC_LEAD,
        menuTree: MENU_TREE,
        checkedMenuCodes: ['users_list', 'roles_list', 'ghost_menu'],
      },
      global: { stubs: { ...EP_STUBS, 'el-tree': TreeStub }, directives: { loading: {} } },
    });

    // 树里不存在的 ghost_menu 不回填（勾不出来）；其余逐字传入。
    expect(state.calls.at(-1)).toEqual(['users_list', 'roles_list']);
  });

  it('T2：el-tree 带 check-strictly（父子不联动，勾选集合即精确集合）', () => {
    const { TreeStub, state } = makeTreeStub();
    mount(RoleGrantsPanel, {
      props: {
        ...baseProps,
        role: QC_LEAD,
        menuTree: MENU_TREE,
        checkedMenuCodes: [],
      },
      global: { stubs: { ...EP_STUBS, 'el-tree': TreeStub }, directives: { loading: {} } },
    });

    expect(state.checkStrictly).toBe(true);
  });

  it('T3：切换角色（勾选态清空）⇒ setCheckedKeys([]) 清掉上一角色的勾选', async () => {
    const { TreeStub, state } = makeTreeStub();
    const wrapper = mount(RoleGrantsPanel, {
      props: {
        ...baseProps,
        role: QC_LEAD,
        menuTree: MENU_TREE,
        checkedMenuCodes: ['users_list'],
      },
      global: { stubs: { ...EP_STUBS, 'el-tree': TreeStub }, directives: { loading: {} } },
    });
    expect(state.calls.at(-1)).toEqual(['users_list']);

    // store.selectRole 的行为：换角色同时把勾选态清空（见 useRolesStore）。
    await wrapper.setProps({ role: ADMIN, checkedMenuCodes: [] });
    await nextTick();
    expect(state.calls.at(-1)).toEqual([]);
  });

  it('T4：点保存提交的是 getCheckedKeys()（树当下的精确集合），不是 props 快照', async () => {
    const { TreeStub } = makeTreeStub();
    const wrapper = mount(RoleGrantsPanel, {
      props: {
        ...baseProps,
        role: QC_LEAD,
        menuTree: MENU_TREE,
        checkedMenuCodes: ['users_list'],
      },
      global: { stubs: { ...EP_STUBS, 'el-tree': TreeStub }, directives: { loading: {} } },
    });

    // 模拟用户在树里把勾选改成 roles_list（不走 @check，只改树内部集合）。
    const treeVm = wrapper.findComponent(TreeStub).vm as unknown as {
      setCheckedKeys: (keys: string[]) => void;
    };
    treeVm.setCheckedKeys(['roles_list']);

    const save = findButton(wrapper, '保存授权')!;
    await save.trigger('click');
    await nextTick();

    const updates = wrapper.emitted('update:menuCodes') as unknown as string[][][];
    // emitted 的每一项是「一次 emit 的全部实参」，取最后一项的第一个实参。
    expect(updates.at(-1)![0]).toEqual(['roles_list']);
    expect(wrapper.emitted('submit')).toBeTruthy();
  });
});

describe('停用 / 删除链路（页面接线）', () => {
  it('P1：点「停用」→ 二次确认 → 提交 deactivate（delete=false），提示带影响账号数', async () => {
    const wrapper = mountRolesPage();
    await flushPromises();
    const stop = findButton(opCell(wrapper, 'QC_LEAD'), '停用')!;
    await stop.trigger('click');
    await flushPromises();

    expect(ElMessageBox.confirm).toHaveBeenCalledTimes(1);
    // 文案里带持有账号数（QC_LEAD.user_count = 2）。
    expect(vi.mocked(ElMessageBox.confirm).mock.calls[0]![0]).toContain('2 个持有该角色的账号');
    expect(deactivateRoleMock).toHaveBeenCalledWith(QC_LEAD.id, {
      version: QC_LEAD.version,
      delete: false,
    });
    expect(ElMessage.success).toHaveBeenCalledWith(expect.stringContaining('已停用'));
    expect(ElMessage.success).toHaveBeenCalledWith(expect.stringContaining('2 个账号'));
  });

  it('P2：确认框取消 ⇒ 不发请求、无成功提示', async () => {
    vi.mocked(ElMessageBox.confirm).mockRejectedValueOnce(new Error('cancel'));
    const wrapper = mountRolesPage();
    await flushPromises();

    await findButton(opCell(wrapper, 'QC_LEAD'), '停用')!.trigger('click');
    await flushPromises();

    expect(deactivateRoleMock).not.toHaveBeenCalled();
    expect(ElMessage.success).not.toHaveBeenCalled();
  });

  it('P3：行选中 → 拉该角色 grants，授权码回填到树（check-strictly 的 setCheckedKeys）', async () => {
    const { TreeStub, state } = makeTreeStub();
    const wrapper = mountRolesPage({ 'el-tree': TreeStub });
    await flushPromises();
    await nextTick();

    await wrapper.find('.row-select[data-code="QC_LEAD"]').trigger('click');
    await flushPromises();
    await nextTick();

    expect(getRoleGrantsMock).toHaveBeenCalledWith(QC_LEAD.id);
    // QC_LEAD 的 grants.menu_codes = ['users_list']，树里有该节点。
    expect(state.calls.at(-1)).toEqual(['users_list']);
  });

  it('P4：grants 未就绪 ⇒ 保存按钮 disabled；到位后解除', async () => {
    let resolveGrants: ((v: unknown) => void) | undefined;
    getRoleGrantsMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveGrants = resolve;
        }),
    );
    const wrapper = mountRolesPage();
    await flushPromises();
    await nextTick();

    await wrapper.find('.row-select[data-code="QC_LEAD"]').trigger('click');
    await flushPromises();
    await nextTick();

    const pending = findButton(wrapper, '保存授权')!;
    expect(pending.attributes('disabled')).toBeDefined();

    resolveGrants!(makeGrants(QC_LEAD.id, 'QC_LEAD', QC_LEAD.version));
    await flushPromises();
    await nextTick();

    expect(findButton(wrapper, '保存授权')!.attributes('disabled')).toBeUndefined();
  });

  it('P5：操作列逐行口径（ADMIN 无按钮；内置非 ADMIN 可改名/停用无删除；自定义全开）', async () => {
    listRolesMock.mockResolvedValue([ADMIN, SYSTEM_MANAGER, QC_LEAD, EMPTY_CUSTOM]);
    const wrapper = mountRolesPage();
    await flushPromises();

    // ADMIN 行整行只读。
    expect(opCell(wrapper, 'ADMIN').findAll('button')).toHaveLength(0);
    expect(opCell(wrapper, 'ADMIN').text()).toContain('—');
    // 内置非 ADMIN：改名 + 停用，无删除（后端删除仅限自定义）。
    expect(opButtonTexts(wrapper, 'MANAGER')).toEqual(['改名', '停用']);
    // 自定义：三项全开。
    expect(opButtonTexts(wrapper, 'QC_LEAD')).toEqual(['改名', '停用', '删除']);
    expect(opButtonTexts(wrapper, 'QC_LEAD_NEW')).toEqual(['改名', '停用', '删除']);
  });

  it('P6：改名弹窗的 code 可编辑性（内置角色禁用；无持有者的自定义角色可改）', async () => {
    listRolesMock.mockResolvedValue([ADMIN, SYSTEM_MANAGER, QC_LEAD, EMPTY_CUSTOM]);
    const wrapper = mountRolesPage();
    await flushPromises();

    // 内置非 ADMIN：可改名，但 code 固定（名字 / 备注可改）。
    await findButton(opCell(wrapper, 'MANAGER'), '改名')!.trigger('click');
    await nextTick();
    expect(wrapper.find('.mock-input').attributes('disabled')).toBeDefined();
    expect(wrapper.text()).toContain('内置角色的代码固定，不可修改。');

    // 关掉再开另一个。
    await findButton(wrapper, '取消')!.trigger('click');
    await nextTick();

    await findButton(opCell(wrapper, 'QC_LEAD_NEW'), '改名')!.trigger('click');
    await nextTick();
    expect(wrapper.find('.mock-input').attributes('disabled')).toBeUndefined();
  });

  // review 第 2 轮：code 表单项原来只有 hint、没有错误展示位 —— 校验失败时弹窗保持
  // 打开但零提示（用户只会以为「点保存没反应」）。错误位与 name 同款。
  it('P7：新建角色 code 校验失败 ⇒ 弹窗内展示错误，不发请求', async () => {
    const wrapper = mountRolesPage();
    await flushPromises();

    await findButton(wrapper, '新建角色')!.trigger('click');
    await nextTick();
    // 三个输入框按模板顺序：代码 / 名称 / 备注。
    const inputs = wrapper.findAll('.mock-input');
    expect(inputs.length).toBeGreaterThanOrEqual(3);

    // 名称填好、code 留空：schema 通过，触发「新建态 code 必填」分支。
    await inputs[1]!.setValue('品检组长');
    await findButton(wrapper, '保存')!.trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('请输入角色代码');
    expect(createRoleMock).not.toHaveBeenCalled();
    // 弹窗保持打开，改完可直接重试。
    expect(wrapper.find('.dialog-stub').exists()).toBe(true);

    // 非法字符：Zod refine 的错误落到同一个展示位。
    await inputs[0]!.setValue('bad-code');
    await findButton(wrapper, '保存')!.trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('角色代码只能包含大写字母、数字和下划线');
    expect(createRoleMock).not.toHaveBeenCalled();
  });

  // review 第 2 轮：停用 / 删除的在途 loading 原先是全表共享一个标志，任一行操作时
  // 所有行的按钮一起转圈。改为「在途标志 + 目标行 id」逐行判。
  it('P8：停用 / 删除的在途 loading 只落在被点的那一行', async () => {
    listRolesMock.mockResolvedValue([ADMIN, SYSTEM_MANAGER, QC_LEAD]);
    let resolveDeactivate: ((v: unknown) => void) | undefined;
    deactivateRoleMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveDeactivate = resolve;
        }),
    );
    const wrapper = mountRolesPage();
    await flushPromises();

    // 确认框是 mock 直过；请求挂起 ⇒ 此刻处于在途态。
    await findButton(opCell(wrapper, 'QC_LEAD'), '停用')!.trigger('click');
    await flushPromises();

    const loadingOf = (code: string): string | undefined =>
      opCell(wrapper, code)
        .findAll('button')
        .find((b) => b.text().includes('停用'))
        ?.attributes('data-loading');
    expect(loadingOf('QC_LEAD')).toBe('1');
    expect(loadingOf('MANAGER')).toBe('0');

    resolveDeactivate!({ affected_user_count: 2 });
    await flushPromises();
    await nextTick();
    expect(loadingOf('QC_LEAD')).toBe('0');
  });

  // review 第 2 轮：被停用的内置角色原来仍只显示「内置」，看不出已停用。
  it('P9：停用的内置角色 tag 显示「内置·已停用」，启用中的仍显示「内置」', async () => {
    listRolesMock.mockResolvedValue([ADMIN, { ...SYSTEM_MANAGER, is_active: false }]);
    const wrapper = mountRolesPage();
    await flushPromises();

    const tagText = (code: string): string =>
      wrapper.find(`.col-stub[data-label="状态"] .cell-stub[data-row-code="${code}"]`).text();
    expect(tagText('ADMIN')).toBe('内置');
    expect(tagText('MANAGER')).toBe('内置·已停用');
  });
});

describe('坏响应守门（queryFn 真接在返回路径上）', () => {
  it('Z1：角色列表缺必填字段 ⇒ 不进 data（守门在 queryFn）', async () => {
    listRolesMock.mockResolvedValue([{ id: 'x', code: 'Y' }]);
    const store = useRolesStore();
    store.query.restoreState();
    await new Promise((r) => setTimeout(r, 0));
    await nextTick();
    // 数据恒空（而不是渲染出一个缺字段的行）
    expect(store.query.roles).toEqual([]);
  });
});
