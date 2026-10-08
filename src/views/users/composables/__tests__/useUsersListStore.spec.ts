// @vitest-environment happy-dom
// src/views/users/composables/__tests__/useUsersListStore.spec.ts
//
// 2026-10-10 新增：账号管理页 store 单测。覆盖 6 类回归点：
//
//  1. 4 不变量：首调一次（消费侧全走 store.切片.字段、不解构）、enabled 闸门在
//     `restoreState()` 之前不触发自动 fetch、`$dispose` 重建后状态全新；
//  2. `buildParams()` 的 4 维映射（username_like / is_active / limit / offset）与
//     「空筛选 → undefined 不发参数」；
//  3. 表头筛选状态机：用户名走 draft → confirm（不点确定不写 search）；状态走 EP 原生
//     `:filters` 的 `@filter-change` 翻译（空 = 不筛 / 两值都勾 = 不筛）；
//  4. **OCC 硬约束**：update / deactivate / removeRole / unbindWx 的 payload 必须带
//     `version`，且 `removeRole` 传的是 `UserRoleOut.version`（不是 t_user.version）；
//  5. **错误码分支表**：40901 走 warning + 重拉列表（不是通用 error）；企微三个撞车码
//     （40108 / 40109 / 40110）各有专门文案；20602 把焦点送回 username 字段，且该标志
//     在每次提交入口复位（弹窗开着重试时红字与焦点仍会出现）。
//  6. **错误桥接**：列表主查询与企微绑定查询两条 query 的 error 都走 watch → ElMessage
//     （企微那条少了就会静默渲染成「未绑态」），且绑定查询有 `reload` 重试入口。
//
// mock 策略：
//   - `vi.mock('element-plus')`：桩掉 ElMessage / ElMessageBox（node env 下真实
//     ElMessage 会因 `document is not defined` 污染输出），并给列定义用到的
//     ElButton / ElInput / ElTag / ElPopconfirm 最简桩（import 本身要能解析）。
//   - `vi.mock('@/api/iam')`：8 条写端点 + 列表读 + 角色读 + 企微读。
//   - `vi.mock('@/api/shelves')`：store setup 里会拉货架候选（角色对话框），不桩会走
//     真实 axios 触发未处理 rejection。
//   - `vi.mock('@/components/ColumnFilterPopover.vue')`：factory stub。
//   - `app.use(createPinia())` 必须早于 `app.use(VueQueryPlugin, { queryClient })`：
//     store setup 第一行 `useQueryClient()`，缺插件直接抛 "No QueryClient set"。
//
// 环境：happy-dom（文件头 pragma）—— restoreState 的持久化恢复要读写真实 localStorage。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { createApp } from 'vue';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';
import type { UserOutData } from '../../usersSchema';

vi.mock('element-plus', () => ({
  ElMessage: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
  ElMessageBox: { alert: vi.fn(async () => undefined), confirm: vi.fn(async () => undefined) },
  ElButton: { name: 'ElButtonStub', template: '<button><slot /></button>' },
  ElInput: { name: 'ElInputStub', template: '<input />' },
  ElTag: { name: 'ElTagStub', template: '<span><slot /></span>' },
  ElPopconfirm: { name: 'ElPopconfirmStub', template: '<div><slot name="reference" /></div>' },
}));

vi.mock('@/components/ColumnFilterPopover.vue', () => ({
  default: { name: 'ColumnFilterPopoverStub', template: '<span><slot /></span>' },
}));

// ---------------------------------------------------------------- iam api 桩
const listUsersMock = vi.fn();
const createUserMock = vi.fn();
const updateUserMock = vi.fn();
const deactivateUserMock = vi.fn();
const resetUserPasswordMock = vi.fn();
const listUserRolesMock = vi.fn();
const addUserRoleMock = vi.fn();
const removeUserRoleMock = vi.fn();
const getWxIdentityMock = vi.fn();
const bindWxIdentityMock = vi.fn();
const unbindWxIdentityMock = vi.fn();

vi.mock('@/api/iam', () => ({
  listUsers: (...args: unknown[]) => listUsersMock(...args),
  createUser: (...args: unknown[]) => createUserMock(...args),
  updateUser: (...args: unknown[]) => updateUserMock(...args),
  deactivateUser: (...args: unknown[]) => deactivateUserMock(...args),
  resetUserPassword: (...args: unknown[]) => resetUserPasswordMock(...args),
  listUserRoles: (...args: unknown[]) => listUserRolesMock(...args),
  addUserRole: (...args: unknown[]) => addUserRoleMock(...args),
  removeUserRole: (...args: unknown[]) => removeUserRoleMock(...args),
  getWxIdentity: (...args: unknown[]) => getWxIdentityMock(...args),
  bindWxIdentity: (...args: unknown[]) => bindWxIdentityMock(...args),
  unbindWxIdentity: (...args: unknown[]) => unbindWxIdentityMock(...args),
}));

vi.mock('@/api/shelves', () => ({
  listShelves: vi.fn(async () => ({ items: [], total: 0, limit: 200, offset: 0 })),
}));

import { useUsersListStore } from '../useUsersListStore';
import { qk } from '@/composables/queries/keys';
import { DEFAULT_PASSWORD } from '../../usersConstants';

/** 后端真实 wire 形态：雪花 ID 是 JSON **string**（`serialize_i64`），行内计数/version
 *  是 number；分页信封的 `total` / `limit` / `offset` 也是 number（后端 `UserListOut`
 *  三个计数是**裸 `i64`**，归一在 `api/iam.ts::listUsers` 的 `normalizeListResult`）。 */
const ROW: UserOutData = {
  id: '1900000000000000001',
  version: 3,
  username: 'zhangsan',
  full_name: '张三',
  phone: null,
  is_active: true,
  last_login_at: '2026-10-10T08:30:00',
  created_at: '2026-01-01T00:00:00',
  updated_at: '2026-10-01T00:00:00',
  roles: [],
};

const LIST_RESULT = { items: [ROW], total: 1, limit: 20, offset: 0 };

const WX_IDENTITY = {
  id: '1900000000000000010',
  corp_id: 'ww1234567890',
  wx_user_id: 'zhangsan',
  user_id: ROW.id,
  version: 2,
  created_at: '2026-10-01T09:00:00',
};

const ROLE_ROW = {
  id: '1900000000000000002',
  version: 5,
  role: 'SHELF_ACCOUNT',
  scope_type: 'shelf',
  scope_id: '1900000000000000003',
  shelf_code: 'SH-A01',
  shelf_name: '生产架 A01',
};

/** 返回本用例用的 QueryClient —— 失效调用点要 spy 它的 invalidateQueries。 */
function setupApp(): QueryClient {
  const app = createApp({});
  // ⚠️ 顺序硬约束：pinia 先、VueQueryPlugin 后（store setup 首行 useQueryClient()）。
  app.use(createPinia());
  const queryClient = new QueryClient({
    // retry: 0 与 src/main.ts 的全局默认对齐（否则失败会重试 3 次，错误态几秒后才可见）。
    defaultOptions: { queries: { retry: 0 }, mutations: { retry: 0 } },
  });
  app.use(VueQueryPlugin, { queryClient });
  setActivePinia(app.config.globalProperties.$pinia);
  return queryClient;
}

/** 等 useQuery 的 scheduler 跑过一轮（与待品检那份 spec 同款：20ms 微任务窗口）。 */
function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 20));
}

describe('useUsersListStore', () => {
  let qc: QueryClient;
  beforeEach(() => {
    vi.clearAllMocks();
    qc = setupApp();
    listUsersMock.mockResolvedValue(LIST_RESULT);
    getWxIdentityMock.mockResolvedValue(null);
    listUserRolesMock.mockResolvedValue([ROLE_ROW]);
    try {
      localStorage.clear();
    } catch {
      /* node 环境不可用时忽略 */
    }
  });

  // ============ 切片装配 + 消费侧解包（不变量 #1 / #3）============
  it('装配 query / filters / ui / dialogs / wxIdentity / mutations 六个切片，嵌套 ref 自动解包', () => {
    const store = useUsersListStore();
    expect(store.query.page).toBe(1);
    expect(store.query.pageSize).toBe(20);
    expect(store.query.total).toBe(0);
    expect(store.query.emptyText).toBe('暂无账号');
    expect(store.ui.autoRefresh).toBe(false);
    // 对话框态：三段都是「关 + 无选中账号」的初值。
    expect(store.dialogs.form.visible).toBe(false);
    expect(store.dialogs.form.editingId).toBeNull();
    expect(store.dialogs.roles.visible).toBe(false);
    expect(store.dialogs.roles.list).toEqual([]);
    expect(store.dialogs.wxBind.visible).toBe(false);
    expect(store.dialogs.wxBind.userId).toBeNull();
    // 表头筛选状态机也走解包访问（不写 .value）。
    expect(store.filters.usernameFilter.visible).toBe(false);
    expect(store.filters.usernameFilter.active).toBe(false);
    expect(store.filters.activeFilter.filteredValue).toEqual([]);
    // 代理 set 写回 ref.value。
    store.query.page = 3;
    expect(store.query.page).toBe(3);
  });

  // ============ 列定义契约 ============
  it('columnDefs = 5 数据列 + 1 操作列；操作列 fixed=right 且不可拖', () => {
    const store = useUsersListStore();
    const defs = store.columnDefs;
    expect(defs.map((d) => d.key)).toEqual([
      'username',
      'full_name',
      'roles',
      'is_active',
      'last_login_at',
      'actions',
    ]);
    expect(defs.map((d) => d.label)).toEqual([
      '用户名',
      '姓名',
      '角色',
      '状态',
      '最后登录',
      '操作',
    ]);
    const actionsCol = defs[5];
    expect(actionsCol?.fixed).toBe('right');
    expect(actionsCol?.draggable).toBe(false);
    // 用户名列挂表头 popover；状态列走 EP 原生 :filters。
    expect(defs[0]?.headerRender).toBeTruthy();
    expect(defs[3]?.filters).toEqual([
      { text: '启用', value: 'true' },
      { text: '停用', value: 'false' },
    ]);
    // 本后端端点不支持排序 ⇒ 不给任何列挂 sortable（挂了只会白给一个不生效的箭头）。
    expect(defs.every((d) => d.sortable === undefined)).toBe(true);
  });

  // ============ buildParams 4 维映射 ============
  it('buildParams 把筛选 + 分页映射成 4 维请求参数', async () => {
    const store = useUsersListStore();
    store.query.search.usernameLike = '  zhang  ';
    store.query.search.isActive = false;
    store.query.page = 3;
    store.query.pageSize = 50;

    await store.query.fetchList();
    const params = listUsersMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params.username_like).toBe('zhang');
    expect(params.is_active).toBe(false);
    expect(params.limit).toBe(50);
    expect(params.offset).toBe(100);
  });

  it('buildParams 空筛选发 undefined（cleanParams 那层不上 wire），改 search 自动 refetch', async () => {
    const store = useUsersListStore();
    store.query.restoreState();
    await tick();
    listUsersMock.mockClear();

    store.query.search.usernameLike = '   ';
    await store.query.fetchList();
    let params = listUsersMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params.username_like).toBeUndefined();
    expect(params.is_active).toBeUndefined();
    expect(params.offset).toBe(0);

    listUsersMock.mockClear();
    store.query.search.usernameLike = 'li';
    await tick();
    expect(listUsersMock).toHaveBeenCalledTimes(1);
    params = listUsersMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params.username_like).toBe('li');
  });

  // ============ enabled 闸门（不变量：避免双 fetch）============
  it('store 实例化**不**自动 fetch；restoreState() 之后才 fetch', async () => {
    const store = useUsersListStore();
    // 不调 restoreState ⇒ restored 保持 false ⇒ enabled 闸门关闭。
    await tick();
    expect(listUsersMock).not.toHaveBeenCalled();

    // restoreState 末尾开闸 ⇒ 自动首屏 fetch。
    store.query.restoreState();
    await tick();
    expect(listUsersMock).toHaveBeenCalledTimes(1);
  });

  // ============ 数据派生 ============
  it('items / total 派生自 query 数据（计数是 number，直接透传不做二次归一）', async () => {
    const store = useUsersListStore();
    await store.query.fetchList();
    expect(store.query.items).toHaveLength(1);
    expect(store.query.items[0]?.username).toBe('zhangsan');
    expect(store.query.total).toBe(1);
  });

  // ============ 表头筛选状态机 ============
  it('用户名筛选走 draft → confirm：填草稿不写 search，点确定才写并回第 1 页', () => {
    const store = useUsersListStore();
    store.query.page = 3;

    store.filters.usernameFilter.draft = '  zhang  ';
    // 只写草稿：search 不动（直写会每敲一个字符发一次请求）。
    expect(store.query.search.usernameLike).toBe('');
    expect(store.filters.usernameFilter.active).toBe(false);

    store.filters.usernameFilter.confirm();
    expect(store.query.search.usernameLike).toBe('zhang');
    expect(store.query.page).toBe(1);
    expect(store.filters.usernameFilter.active).toBe(true);
    expect(store.filters.usernameFilter.visible).toBe(false);

    // sync 把已确认值回写草稿（二次打开 popover 看到原状）。
    store.filters.usernameFilter.sync();
    expect(store.filters.usernameFilter.draft).toBe('zhang');

    store.filters.usernameFilter.reset();
    expect(store.query.search.usernameLike).toBe('');
    expect(store.filters.usernameFilter.active).toBe(false);
    expect(store.filters.usernameFilter.draft).toBe('');
  });

  it('状态列走 EP 原生 filter-change：空 = 不筛 / 单选 = 精确筛 / 两值都勾 = 不筛', () => {
    const store = useUsersListStore();
    expect(store.query.search.isActive).toBeUndefined();
    expect(store.filters.activeFilter.filteredValue).toEqual([]);

    store.query.onNativeFilterChange({ is_active: ['false'] });
    expect(store.query.search.isActive).toBe(false);
    expect(store.filters.activeFilter.filteredValue).toEqual(['false']);
    expect(store.filters.activeFilter.count).toBe(1);

    // 两个都勾 = 用户表达「都要」⇒ 归一成不过滤（后端没有 OR 谓词可映射）。
    store.query.onNativeFilterChange({ is_active: ['true', 'false'] });
    expect(store.query.search.isActive).toBeUndefined();

    // 别的列的变更不碰本域（EP 只上报本次变更的那一列）。
    store.query.onNativeFilterChange({ username: ['x'] });
    expect(store.query.search.isActive).toBeUndefined();

    store.query.onNativeFilterChange({ is_active: ['true'] });
    expect(store.query.search.isActive).toBe(true);
    store.query.onNativeFilterChange({ is_active: [] });
    expect(store.query.search.isActive).toBeUndefined();
  });

  it('resetAllFilters 清已确认值 + 草稿 + popover 打开态，保留每页条数', () => {
    const store = useUsersListStore();
    store.query.pageSize = 50;
    store.query.search.usernameLike = 'zhang';
    store.query.search.isActive = true;
    store.filters.usernameFilter.draft = '半截草稿';
    store.filters.usernameFilter.visible = true;
    store.query.page = 4;

    store.query.resetAllFilters();

    expect(store.query.search.usernameLike).toBe('');
    expect(store.query.search.isActive).toBeUndefined();
    expect(store.query.page).toBe(1);
    expect(store.query.pageSize).toBe(50);
    // 半截草稿与打开态也要清，否则用户下次点「确定」会把旧值写回去。
    expect(store.filters.usernameFilter.draft).toBe('');
    expect(store.filters.usernameFilter.visible).toBe(false);
  });

  // ============ 列可见性（listKey 复用旧页面）============
  it('列可见性走 localStorage 的 user_list 快照（换 key 会让用户丢一次列配置）', () => {
    localStorage.setItem('myerp.list.anon.user_list_columns', JSON.stringify({ full_name: false }));
    const store = useUsersListStore();
    expect(store.columnVisibility.isVisible('full_name')).toBe(false);
    expect(store.columnVisibility.isVisible('username')).toBe(true);
    store.columnVisibility.showAll();
    expect(store.columnVisibility.isVisible('full_name')).toBe(true);
  });

  // ============ 新增 / 编辑（OCC 硬约束）============
  it('新增：密码留空回落默认口令，成功后失效 users 域 + 成功提示', async () => {
    const { ElMessage } = await import('element-plus');
    const store = useUsersListStore();
    createUserMock.mockResolvedValue(ROW);
    const spy = vi.spyOn(qc, 'invalidateQueries');

    await store.submitForm({ username: 'lisi', full_name: '李四', password: '' });

    expect(createUserMock).toHaveBeenCalledWith({
      username: 'lisi',
      full_name: '李四',
      password: DEFAULT_PASSWORD,
    });
    expect(ElMessage.success).toHaveBeenCalledWith('已新增账号');
    expect(spy).toHaveBeenCalledWith({ queryKey: qk.usersPrefix });
    // 成功后弹窗关闭。
    expect(store.dialogs.form.visible).toBe(false);
  });

  it('编辑：payload 必带 version；密码留空则压根不传该键（不是传空串）', async () => {
    const store = useUsersListStore();
    updateUserMock.mockResolvedValue(ROW);
    store.dialogs.form.openEdit(ROW);
    expect(store.dialogs.form.editingId).toBe(ROW.id);
    expect(store.dialogs.form.editingVersion).toBe(3);
    expect(store.dialogs.form.form.username).toBe('zhangsan');
    expect(store.dialogs.form.form.password).toBe('');

    await store.submitForm({ username: 'zhangsan', full_name: '张三改', password: '' });
    expect(updateUserMock).toHaveBeenCalledWith(ROW.id, {
      version: 3,
      full_name: '张三改',
    });
    expect(updateUserMock.mock.calls[0]?.[1]).not.toHaveProperty('password');

    // 填了密码才带上。
    store.dialogs.form.openEdit(ROW);
    await store.submitForm({ username: 'zhangsan', full_name: '张三', password: 'newpwd' });
    expect(updateUserMock).toHaveBeenLastCalledWith(ROW.id, {
      version: 3,
      full_name: '张三',
      password: 'newpwd',
    });
  });

  it('重置密码：无 body、无 version，成功提示带默认口令', async () => {
    const { ElMessage } = await import('element-plus');
    const store = useUsersListStore();
    resetUserPasswordMock.mockResolvedValue(ROW);

    store.actions.resetPassword(ROW);
    await tick();

    expect(resetUserPasswordMock).toHaveBeenCalledWith(ROW.id);
    expect(ElMessage.success).toHaveBeenCalledWith('已重置为默认密码 changeme');
  });

  it('停用：payload 带 version（2026-10-10 起该端点必收 version）', async () => {
    const store = useUsersListStore();
    deactivateUserMock.mockResolvedValue(ROW);

    store.actions.deactivate(ROW);
    await tick();

    expect(deactivateUserMock).toHaveBeenCalledWith(ROW.id, { version: 3 });
  });

  // ============ 角色管理 ============
  it('打开角色对话框会拉该账号的角色，并算出已绑货架集合（多选下拉据此禁用）', async () => {
    const store = useUsersListStore();
    store.dialogs.roles.openRoles(ROW);
    await tick();

    expect(listUserRolesMock).toHaveBeenCalledWith(ROW.id);
    expect(store.dialogs.roles.username).toBe('zhangsan');
    expect(store.dialogs.roles.list).toHaveLength(1);
    expect(store.dialogs.roles.boundShelfIds.has('1900000000000000003')).toBe(true);
  });

  it('加 SHELF_ACCOUNT：多货架循环 addUserRole；留空 = scope_id 为 null 的通配', async () => {
    const store = useUsersListStore();
    store.dialogs.roles.openRoles(ROW);
    await tick();
    addUserRoleMock.mockResolvedValue(ROLE_ROW);
    const { ElMessageBox } = await import('element-plus');

    // 多选两个货架 ⇒ 循环两次 addUserRole（纯 INSERT、无 version）。
    store.dialogs.roles.selectedRole = 'SHELF_ACCOUNT';
    store.dialogs.roles.shelfIds = ['9001', '9002'];
    await store.submitAddRole();

    expect(addUserRoleMock).toHaveBeenCalledTimes(2);
    expect(addUserRoleMock).toHaveBeenNthCalledWith(1, ROW.id, {
      role: 'SHELF_ACCOUNT',
      scope_type: 'shelf',
      scope_id: '9001',
    });
    expect(addUserRoleMock).toHaveBeenNthCalledWith(2, ROW.id, {
      role: 'SHELF_ACCOUNT',
      scope_type: 'shelf',
      scope_id: '9002',
    });
    // 加完货架范围要提示「要重新登录 / 等 token 刷新才生效」。
    expect(ElMessageBox.alert).toHaveBeenCalled();
    expect(store.dialogs.roles.shelfIds).toEqual([]);

    // 留空 ⇒ 一次 addUserRole，scope_id 为 null（共享 HMI 通行）。
    addUserRoleMock.mockClear();
    await store.submitAddRole();
    expect(addUserRoleMock).toHaveBeenCalledWith(ROW.id, {
      role: 'SHELF_ACCOUNT',
      scope_type: 'shelf',
      scope_id: null,
    });
  });

  it('加非货架角色：scope 必须为 null', async () => {
    const store = useUsersListStore();
    store.dialogs.roles.openRoles(ROW);
    await tick();
    addUserRoleMock.mockResolvedValue(ROLE_ROW);

    store.dialogs.roles.selectedRole = 'MANAGER';
    await store.submitAddRole();

    expect(addUserRoleMock).toHaveBeenCalledWith(ROW.id, {
      role: 'MANAGER',
      scope_type: null,
      scope_id: null,
    });
  });

  it('移除角色：version 取 UserRoleOut.version（t_user_role 的计数器，不是 t_user.version）', async () => {
    const store = useUsersListStore();
    store.dialogs.roles.openRoles(ROW);
    await tick();
    removeUserRoleMock.mockResolvedValue(undefined);

    await store.submitRemoveRole(ROLE_ROW);

    expect(removeUserRoleMock).toHaveBeenCalledWith(ROW.id, ROLE_ROW.id, { version: 5 });
  });

  // ============ 企业微信绑定 ============
  it('企微绑定查询的闸门 = 弹窗开着且有账号 id；未绑态返回 null 不炸', async () => {
    const store = useUsersListStore();
    await tick();
    // 未开弹窗 ⇒ 一次请求都不该发。
    expect(getWxIdentityMock).not.toHaveBeenCalled();

    getWxIdentityMock.mockResolvedValue(null);
    store.dialogs.wxBind.openWxBind(ROW);
    await tick();

    expect(getWxIdentityMock).toHaveBeenCalledWith(ROW.id);
    expect(store.wxIdentity.data).toBeNull();
  });

  it('已绑态：绑定行进缓存；解绑带 version，成功后失效本域前缀（含该账号的绑定键）', async () => {
    const { ElMessage } = await import('element-plus');
    const store = useUsersListStore();
    getWxIdentityMock.mockResolvedValue(WX_IDENTITY);
    store.dialogs.wxBind.openWxBind(ROW);
    await tick();
    expect(store.wxIdentity.data?.wx_user_id).toBe('zhangsan');
    expect(store.wxIdentity.data?.version).toBe(2);

    unbindWxIdentityMock.mockResolvedValue(undefined);
    getWxIdentityMock.mockResolvedValue(null);
    const spy = vi.spyOn(qc, 'invalidateQueries');

    await store.submitUnbindWx(store.wxIdentity.data?.version ?? 0);

    expect(unbindWxIdentityMock).toHaveBeenCalledWith(ROW.id, { version: 2 });
    expect(ElMessage.success).toHaveBeenCalledWith('已解绑企业微信账号');
    // 只失效一次，且是 users 前缀（`qk.userWxIdentity` 同在 `users` 前缀下，前缀一把覆盖）。
    const prefixCalls = spy.mock.calls.filter((c) => {
      const arg = c[0] as { queryKey?: unknown } | (() => unknown);
      return typeof arg === 'object' && arg !== null && arg.queryKey === qk.usersPrefix;
    });
    expect(prefixCalls).toHaveLength(1);
  });

  it('绑定：payload 只有 wx_user_id（不传 corp_id）', async () => {
    const store = useUsersListStore();
    store.dialogs.wxBind.openWxBind(ROW);
    bindWxIdentityMock.mockResolvedValue(WX_IDENTITY);

    await store.submitBindWx('zhangsan');

    expect(bindWxIdentityMock).toHaveBeenCalledWith(ROW.id, { wx_user_id: 'zhangsan' });
  });

  // ============ 错误码分支表 ============
  it('40901 走 warning + 重拉列表，不弹通用 error', async () => {
    const { ElMessage } = await import('element-plus');
    const store = useUsersListStore();
    store.query.restoreState();
    await tick();
    listUsersMock.mockClear();
    deactivateUserMock.mockRejectedValue(Object.assign(new Error('版本冲突'), { code: 40901 }));

    await expect(
      store.mutations.deactivateMutation.mutateAsync({ id: ROW.id, version: 3 }),
    ).rejects.toThrow('版本冲突');

    expect(ElMessage.warning).toHaveBeenCalledWith('数据已被他人修改，请刷新后重试');
    expect(ElMessage.error).not.toHaveBeenCalled();
    await tick();
    expect(listUsersMock).toHaveBeenCalled();
  });

  it('企微三个撞车码各有专门文案（不用后端 message，也不落到通用「绑定失败」）', async () => {
    const { ElMessage } = await import('element-plus');
    const store = useUsersListStore();
    const cases: Array<[number, string]> = [
      [40108, '该企业微信账号已被其他账号绑定'],
      [40109, '服务端未配置企业微信，无法绑定，请联系管理员'],
      [40110, '该账号已绑定其它企业微信账号，请先解绑'],
    ];
    for (const [code, text] of cases) {
      // vi.mock 的桩是普通 vi.fn()，但 element-plus 的类型声明把 ElMessage.error 标成
      // MessageTypedFn（没有 mockClear）⇒ 断言走 toHaveBeenLastCalledWith 之前先清空。
      (ElMessage.error as unknown as ReturnType<typeof vi.fn>).mockClear();
      bindWxIdentityMock.mockRejectedValueOnce(Object.assign(new Error('后端 message'), { code }));
      await expect(
        store.mutations.bindWxMutation.mutateAsync({ userId: ROW.id, wxUserId: 'x' }),
      ).rejects.toThrow();
      expect(ElMessage.error).toHaveBeenCalledWith(text);
    }
  });

  it('20602 用户名重复：把焦点送回 username 字段', async () => {
    const { ElMessage } = await import('element-plus');
    const store = useUsersListStore();
    createUserMock.mockRejectedValue(Object.assign(new Error('用户名已存在'), { code: 20602 }));

    await expect(
      store.mutations.createMutation.mutateAsync({
        username: 'zhangsan',
        full_name: '张三',
        password: 'x',
      }),
    ).rejects.toThrow();
    await tick();

    expect(store.dialogs.form.focusUsername).toBe(true);
    expect(ElMessage.error).toHaveBeenCalledWith('用户名已存在');
  });

  it('提交入口复位 focusUsername：改完用户名二次提交又撞 20602 时标志仍会重新置位', async () => {
    const store = useUsersListStore();
    createUserMock.mockRejectedValue(Object.assign(new Error('用户名已存在'), { code: 20602 }));
    store.dialogs.form.openCreate();

    const p1 = store
      .submitForm({ username: 'zhangsan', full_name: '张三', password: '' })
      .catch(() => undefined);
    // 同步段：`submitForm` 开头已复位（mutation 的 onError 要等微任务）。
    expect(store.dialogs.form.focusUsername).toBe(false);
    await p1;
    await tick();
    expect(store.dialogs.form.focusUsername).toBe(true);

    // 二次提交：标志重新翻 true ⇒ 组件的 watch 这次会触发，字段红字与焦点重新出现。
    const p2 = store
      .submitForm({ username: 'zhangsan2', full_name: '张三', password: '' })
      .catch(() => undefined);
    expect(store.dialogs.form.focusUsername).toBe(false);
    await p2;
    expect(store.dialogs.form.focusUsername).toBe(true);
    // 提交失败时弹窗保持开着，用户改完直接重试。
    expect(store.dialogs.form.visible).toBe(true);
  });

  it('其它业务码走通用 error：后端 message 进 UI', async () => {
    const { ElMessage } = await import('element-plus');
    const store = useUsersListStore();
    addUserRoleMock.mockRejectedValue(Object.assign(new Error('角色已存在'), { code: 20604 }));

    await expect(
      store.mutations.addRoleMutation.mutateAsync({
        userId: ROW.id,
        payload: { role: 'MANAGER', scope_type: null, scope_id: null },
      }),
    ).rejects.toThrow();
    await tick();

    expect(ElMessage.error).toHaveBeenCalledWith('角色已存在');
  });

  // ============ 错误桥接（useQuery 的 error 不在 setup 抛错）============
  it('主查询失败走 watch → ElMessage.error，不在 setup 抛错', async () => {
    const { ElMessage } = await import('element-plus');
    listUsersMock.mockRejectedValue(new Error('后端 500'));
    const store = useUsersListStore();
    expect(() => store.query.restoreState()).not.toThrow();
    await tick();
    expect(store.query.errorMsg).toBe('后端 500');
    expect(store.query.emptyText).toBe('后端 500');
    expect(ElMessage.error).toHaveBeenCalledWith('后端 500');
  });

  it('企微绑定查询失败走 watch → ElMessage.error（否则弹窗静默渲染成「未绑态」）', async () => {
    const { ElMessage } = await import('element-plus');
    getWxIdentityMock.mockRejectedValue(new Error('后端 20601'));
    const store = useUsersListStore();
    store.dialogs.wxBind.openWxBind(ROW);
    await tick();

    expect(store.wxIdentity.error?.message).toBe('后端 20601');
    expect(ElMessage.error).toHaveBeenCalledWith('后端 20601');
  });

  it('wxIdentity.reload 重试：重开后拿到绑定数据', async () => {
    const store = useUsersListStore();
    getWxIdentityMock.mockRejectedValue(new Error('后端 20601'));
    store.dialogs.wxBind.openWxBind(ROW);
    await tick();
    expect(store.wxIdentity.data).toBeUndefined();

    getWxIdentityMock.mockResolvedValue(WX_IDENTITY);
    await store.wxIdentity.reload();
    await tick();
    expect(store.wxIdentity.data?.wx_user_id).toBe('zhangsan');
  });

  // ============ 持久化恢复 ============
  it('restoreState 恢复筛选 / 每页条数；非法 isActive 收敛回不过滤', async () => {
    const store = useUsersListStore();
    store.query.search.usernameLike = 'zhang';
    store.query.search.isActive = false;
    store.query.pageSize = 50;
    // useListStatePersist 是 300ms 节流 + onBeforeUnmount 强制落盘；这里手动等一拍。
    await new Promise((r) => setTimeout(r, 350));

    const store2 = useUsersListStore();
    store2.$dispose();

    const raw = localStorage.getItem('myerp.list.anon.user_list_filter');
    expect(raw).toBeTruthy();
    const snap = JSON.parse(raw as string) as Record<string, unknown>;
    snap.search = { usernameLike: 'zhang', isActive: 'yes' };
    snap.pageSize = -1;
    localStorage.setItem('myerp.list.anon.user_list_filter', JSON.stringify(snap));

    const store3 = useUsersListStore();
    store3.query.restoreState();
    expect(store3.query.search.usernameLike).toBe('zhang');
    // 非法值（既不是 true 也不是 false）⇒ 收敛成不过滤，而不是把脏值塞进请求。
    expect(store3.query.search.isActive).toBeUndefined();
    // pageSize 越界 ⇒ 保持默认 20。
    expect(store3.query.pageSize).toBe(20);
    // **不**恢复 page：避免停在一个不存在的页。
    expect(store3.query.page).toBe(1);
  });

  // ============ 不变量 #2：$dispose 重建 ============
  it('$dispose 重建 store 后状态是全新的（不泄漏上一次的筛选 / 对话框态）', () => {
    const store1 = useUsersListStore();
    store1.query.search.usernameLike = 'zhang';
    store1.query.page = 3;
    store1.dialogs.form.openCreate();
    expect(store1.query.search.usernameLike).toBe('zhang');

    store1.$dispose();

    const store2 = useUsersListStore();
    expect(store2.query.search.usernameLike).toBe('');
    expect(store2.query.page).toBe(1);
    expect(store2.dialogs.form.visible).toBe(false);
  });
});
