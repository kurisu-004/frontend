// src/views/users/composables/useUsersListStore.ts
//
// 2026-10-10 新建：账号管理页的 Pinia setup store。替代 2026-08-25 版的
// `UserList.vue` 内联范式（裸调 api + fetcher 闭包 + 手写分页组件 + el-form 内联校验
// 规则 + 列定义内联在 SFC），改为 useQuery + queryKey 工厂 + Zod 守门 + 切片形态 +
// enabled 闸门（CLAUDE.md 硬约束）。形态照
// `views/outsource/composables/useOutsourceCompanyListStore.ts`（同样是「表头 popover
// 文本筛选 + EP 原生 :filters 两态布尔 + 合并的新建/编辑对话框」这一套）。
//
// 不变量（改动前必读，抄自 useInspectionListStore / useOutsourceCompanyListStore）：
// 1. 必须在 UserList.vue 的 setup 内首调 —— 切片链路上的 useColumnVisibility /
//    useColumnDrag / useProductionShelvesQuery 的 onBeforeUnmount 会绑到首个创建 store
//    的组件。组件外（路由守卫 / 其它 store）禁止首调。
// 2. UserList.vue 的 onBeforeUnmount 必须 `store.$dispose()`：Pinia 是单例，不 dispose
//    会把筛选 / 分页 / 三个对话框态泄漏到下次进入。
// 3. 消费侧禁止解构 store（reactive 解构丢响应式）；统一 `store.切片.字段` 访问，不写
//    .value（深代理自动解包）。store 内部闭包持 raw 切片，照写 .value。
// 4. 不 import vue-router（弹窗全在本页，不需要导航）。
//
// 三个对话框全在 store 里（表单 / 角色 / 企微绑定），列定义的动作回调由 store 持有 ——
// 视图只负责「顶部工具条 + 表格 + 三个 dialog 组件」这层壳。

import { computed, reactive, ref, watch } from 'vue';
import { defineStore } from 'pinia';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import {
  addUserRole,
  bindWxIdentity,
  createUser,
  deactivateUser,
  getWxIdentity,
  listUserRoles,
  removeUserRole,
  resetUserPassword,
  unbindWxIdentity,
  updateUser,
  type AddUserRolePayload,
} from '@/api/iam';
import { qk } from '@/composables/queries/keys';
import { useColumnVisibility } from '@/composables/useColumnVisibility';
import { useListStatePersist } from '@/composables/useListFilterPersist';
import { useProductionShelvesQuery } from '@/composables/queries/useProductionShelvesQuery';
import {
  buildUsersColumnDefs,
  type UsersColumnActions,
  type UsersTextFilter,
} from '../usersColumnDefs';
import { wxIdentityOrNullSchema, type UserOutData, type UserRoleOutData } from '../usersSchema';
import { DEFAULT_PASSWORD, SHELF_SCOPED_ROLE } from '../usersConstants';
import { useUsersQuery } from './useUsersQuery';

/** 本页的 search shape（表头筛选的唯一状态源）。 */
export interface UsersSearchState {
  /** 用户名 ILIKE 子串（后端 `username_like`）。空串 = 不筛。 */
  usernameLike: string;
  /** 启用 / 停用三态：undefined = 不过滤（后端 `is_active` 缺省即不过滤）。 */
  isActive: boolean | undefined;
}

function initialSearch(): UsersSearchState {
  return { usernameLike: '', isActive: undefined };
}

/** 账号表单（新增 / 编辑合一）的字段态。password 留空 = 编辑态不改密、新增态回落
 *  默认口令（沿用旧版行为）。 */
interface UserFormState {
  username: string;
  full_name: string;
  password: string;
}

function initialForm(): UserFormState {
  return { username: '', full_name: '', password: '' };
}

// ============================================================
// 错误码分支表（全部 mutation 的 onError 共用一份）
//
// 逐条对应后端 iam 域的业务码。为什么要专门表：企微绑定的三个撞车码（40108 / 40109 /
// 40110）各自的**用户动作**不同（换 userid / 联系管理员 / 先解绑），后端 message 是给
// 日志看的，统一「保存失败：xxx」对操作员没有指导性。
// ============================================================

/** 企微绑定专属文案（后端 message 不进 UI）。 */
const WX_BIND_ERROR_TEXT: Partial<Record<number, string>> = {
  // 该企微 userid 已被别的系统账号绑了 ⇒ 换 userid 或去那个账号上解绑
  40108: '该企业微信账号已被其他账号绑定',
  // 服务端没配 WECOM_CORPID ⇒ 前端无解，只能找管理员
  40109: '服务端未配置企业微信，无法绑定，请联系管理员',
  // 该系统账号已绑了别的 userid ⇒ 先解绑（解绑端点软删该账号全部绑定行）
  40110: '该账号已绑定其它企业微信账号，请先解绑',
};

/** 账号不存在 / 用户名重复 / 角色相关三个码的补充文案（后端 message 够用，这里只补
 *  「表单该聚焦哪个字段」这一层语义）。 */
const USER_NOT_FOUND_CODE = 20601;
const USERNAME_DUPLICATE_CODE = 20602;
/** OCC 版本冲突：只表达乐观锁冲突，UI 提示刷新后重试并重拉列表。 */
const VERSION_CONFLICT_CODE = 40901;

export const useUsersListStore = defineStore('users-list', () => {
  // ⚠️ 必须在 setup 第一行捕获（Pinia 不给 action wrapper / listener 注入上下文，
  // `useQueryClient()` 的守卫会抛）。
  const qc = useQueryClient();

  // ============ 切片：query（表头筛选 / 分页 / 主查询）============
  const search = reactive<UsersSearchState>(initialSearch());
  const page = ref(1);
  const pageSize = ref(20);
  // enabled 闸门：默认 false，restoreState() 末尾开闸，避免「默认筛选首屏 + 持久化筛选
  // 再屏」双 fetch。
  const restored = ref(false);
  // 自动刷新布尔（5min 轮询，定时器由 useUsersQuery 的 refetchInterval 承担）。
  // 放在 `ui` 切片里返回（普通对象，不是 reactive()）—— 见 useInspectionListStore
  // 顶部关于「Pinia 登记 state 的闸门」那段注释。
  const uiAutoRefresh = ref(false);

  /** search + 分页 → queryKey params 的**唯一**转换点。 */
  function buildParams() {
    return {
      username_like: search.usernameLike.trim() || undefined,
      is_active: search.isActive,
      limit: pageSize.value,
      offset: (page.value - 1) * pageSize.value,
    };
  }

  const listQuery = useUsersQuery({
    params: computed(() => buildParams()),
    enabled: restored,
    autoRefresh: uiAutoRefresh,
  });
  const { fetchList } = listQuery;

  const items = computed<UserOutData[]>(() => listQuery.data.value?.items ?? []);
  const total = computed<number>(() => listQuery.data.value?.total ?? 0);
  const loading = listQuery.isFetching;
  const errorMsg = computed<string | null>(() => {
    const e = listQuery.error.value;
    return e ? e.message : null;
  });
  const emptyText = computed<string>(() => errorMsg.value ?? '暂无账号');

  /** 表头筛选 confirm 的统一入口（页码拨回 1）。改 search 不动 page 会停在「第 5 页但
   *  只有 1 页结果」的空态。 */
  function onSearch(): void {
    page.value = 1;
  }

  // ============ 表头筛选状态机（两个维度）============
  // ⚠️ 状态机建在 store 里而不是独立 composable：本域只有这两个筛选维度，抽出去只会多
  //   一层间接；形态（draft → confirm / EP 原生两态）照 PartList / Inspection 一致。

  // 1) 用户名：文本列，draft → confirm 两段式（popover 里的输入是草稿，点确定才生效）。
  const usernamePopoverVisible = ref(false);
  const usernameDraft = ref('');
  const usernameActive = computed(() => search.usernameLike.trim() !== '');
  /** popover 打开时把已确认值回写草稿，保证二次打开看到原状。 */
  function syncUsernameDraft(): void {
    usernameDraft.value = search.usernameLike;
  }
  function confirmUsernameFilter(): void {
    search.usernameLike = usernameDraft.value.trim();
    usernamePopoverVisible.value = false;
    onSearch();
  }
  function resetUsernameFilter(): void {
    usernameDraft.value = '';
    search.usernameLike = '';
    usernamePopoverVisible.value = false;
    onSearch();
  }
  const usernameFilter: UsersTextFilter = {
    visible: usernamePopoverVisible,
    draft: usernameDraft,
    active: usernameActive,
    sync: syncUsernameDraft,
    confirm: confirmUsernameFilter,
    reset: resetUsernameFilter,
  };

  // 2) 状态：EP 原生 `:filters` 两态（启用 / 停用），search 里是三态 boolean。
  //    「两个都勾 / 都不勾」都归一成不过滤（见 usersColumnDefs.ts::UsersActiveFilter 注释）。
  const ACTIVE_OPTIONS = [
    { text: '启用', value: 'true' },
    { text: '停用', value: 'false' },
  ];
  const activeFilteredValue = computed<string[]>(() => {
    if (search.isActive === true) return ['true'];
    if (search.isActive === false) return ['false'];
    return [];
  });
  const activeFlag = computed(() => search.isActive !== undefined);
  const activeCount = computed(() => (activeFlag.value ? 1 : 0));
  const activeFilter = {
    options: ACTIVE_OPTIONS,
    filteredValue: activeFilteredValue,
    active: activeFlag,
    count: activeCount,
  };

  // ============ 切片：filters（对外暴露的筛选态）============
  const filters = { usernameFilter, activeFilter };

  /** EP 的 `filter-change` 只上报本次变更的那一列 ⇒ 按 column-key 判断命中哪条翻译器。 */
  function onNativeFilterChange(payload: Record<string, string[]>): void {
    if (!('is_active' in payload)) return;
    const picked = payload['is_active'] ?? [];
    if (picked.length === 0 || (picked.includes('true') && picked.includes('false'))) {
      search.isActive = undefined;
    } else {
      search.isActive = picked.includes('true');
    }
    onSearch();
  }

  /** 工具栏「重置筛选」：清「已确认值 + 未确认草稿 + popover 打开态」。
   *  只清 search 不够 —— popover 正开着时点重置，active 会转 false 但草稿还在，用户下次
   *  在弹层里点「确定」又把旧值写回去。**保留**每页条数（它是「视图」不是「筛选」）。 */
  function resetAllFilters(): void {
    resetUsernameFilter();
    search.isActive = undefined;
    page.value = 1;
  }

  // 持久化：筛选 + 每页条数（**不**持久化 page —— 恢复时可能停在一个不存在的页）。
  // key 与旧的「列可见性 / 列顺序」快照（`user_list_columns` / `user_list_columnOrder`）
  // 不同形态，不会互相污染；且 `restore()` 的全键存在性校验保证将来改名撞车只会退化成
  // 「不恢复」而不是把别的快照当筛选读进来。
  const { restore: restorePersist } = useListStatePersist('user_list_filter', {
    search,
    pageSize,
  });

  function restoreState(): void {
    const persisted = restorePersist() as
      { search?: Partial<UsersSearchState>; pageSize?: number } | null | undefined;
    if (persisted?.search) {
      // lenient 逐字段恢复：旧快照缺字段落回默认，而不是整份丢弃。
      search.usernameLike = persisted.search.usernameLike ?? search.usernameLike;
      const restoredActive = persisted.search.isActive;
      search.isActive =
        restoredActive === true || restoredActive === false ? restoredActive : undefined;
    }
    if (typeof persisted?.pageSize === 'number' && persisted.pageSize > 0) {
      pageSize.value = persisted.pageSize;
    }
    // 开闸放行首屏 fetch（两条分支都要走到这里）。
    restored.value = true;
  }

  const query = {
    search,
    page,
    pageSize,
    items,
    total,
    loading,
    errorMsg,
    emptyText,
    buildParams,
    fetchList,
    onSearch,
    onNativeFilterChange,
    resetAllFilters,
    restoreState,
  };

  // ============ 切片：ui（视图级开关）============
  const ui = {
    autoRefresh: uiAutoRefresh,
  };

  // ============ 切片：dialogs.form（新增 / 编辑合一）============
  const formVisible = ref(false);
  /** 正在编辑的账号 id；null = 新增模式。 */
  const formEditingId = ref<string | null>(null);
  /** OCC 锚：`POST /{id}/update` 必传（缺省是后端 422 纯文本）。 */
  const formEditingVersion = ref<number | null>(null);
  const formSaving = ref(false);
  /** 20602（用户名重复）时置 true，表单据此把焦点送回 username 字段。 */
  const formFocusUsername = ref(false);
  const form = reactive<UserFormState>(initialForm());

  function resetForm(): void {
    Object.assign(form, initialForm());
    formEditingId.value = null;
    formEditingVersion.value = null;
    formFocusUsername.value = false;
  }

  function openCreate(): void {
    resetForm();
    formVisible.value = true;
  }

  function openEdit(row: UserOutData): void {
    resetForm();
    formEditingId.value = row.id;
    formEditingVersion.value = row.version;
    form.username = row.username;
    form.full_name = row.full_name;
    // 密码留空 = 不改（编辑态不预填任何口令）。
    formVisible.value = true;
  }

  // ============ 切片：dialogs.roles（角色管理）============
  const rolesVisible = ref(false);
  const rolesUserId = ref<string | null>(null);
  const rolesUsername = ref('');
  const rolesList = ref<UserRoleOutData[]>([]);
  const rolesSaving = ref(false);
  /** 新增角色下拉的选中值（'' = 未选）。 */
  const rolesSelectedRole = ref('');
  /** SHELF_ACCOUNT 的货架多选（**保持字符串**：雪花 ID 长度 > 2^53，Number() 会丢精度）。 */
  const rolesShelfIds = ref<string[]>([]);

  /** 已绑的 SHELF_ACCOUNT 货架 id 集合 —— 多选下拉据此 `:disabled` 防重复绑。 */
  const boundShelfIds = computed<Set<string>>(
    () =>
      new Set(
        rolesList.value
          .filter((r) => r.role === SHELF_SCOPED_ROLE && r.scope_id)
          .map((r) => String(r.scope_id)),
      ),
  );

  function openRoles(row: UserOutData): void {
    rolesUserId.value = row.id;
    rolesUsername.value = row.username;
    rolesSelectedRole.value = '';
    rolesShelfIds.value = [];
    rolesVisible.value = true;
    void fetchRoles();
  }

  function closeRoles(): void {
    rolesVisible.value = false;
    rolesUserId.value = null;
    rolesList.value = [];
    rolesSelectedRole.value = '';
    rolesShelfIds.value = [];
  }

  // ============ 切片：dialogs.wxBind（企业微信绑定）============
  const wxBindVisible = ref(false);
  const wxBindUserId = ref<string | null>(null);
  const wxBindUsername = ref('');
  const wxBindSaving = ref(false);

  function openWxBind(row: UserOutData): void {
    wxBindUserId.value = row.id;
    wxBindUsername.value = row.username;
    wxBindVisible.value = true;
  }

  function closeWxBind(): void {
    wxBindVisible.value = false;
    wxBindUserId.value = null;
    wxBindUsername.value = '';
  }

  const dialogs = {
    form: {
      visible: formVisible,
      editingId: formEditingId,
      editingVersion: formEditingVersion,
      saving: formSaving,
      focusUsername: formFocusUsername,
      form,
      resetForm,
      openCreate,
      openEdit,
    },
    roles: {
      visible: rolesVisible,
      userId: rolesUserId,
      username: rolesUsername,
      list: rolesList,
      saving: rolesSaving,
      selectedRole: rolesSelectedRole,
      shelfIds: rolesShelfIds,
      boundShelfIds,
      openRoles,
      closeRoles,
    },
    wxBind: {
      visible: wxBindVisible,
      userId: wxBindUserId,
      username: wxBindUsername,
      saving: wxBindSaving,
      openWxBind,
      closeWxBind,
    },
  };

  // ============ 切片：wxIdentity（单账号的企微绑定读端点）============
  // 闸门 = 弹窗开着 **且** 有账号 id（没有 id 时键退化成占位键，请求会被 enabled 拦掉）。
  // 守门在 queryFn（wxIdentityOrNullSchema 一次覆盖「已绑 / 未绑返回 null」两态），
  // 不在 api 层 —— parse 是深拷贝，api 层再 parse 等于每屏数据校验并克隆两遍。
  const wxIdentityQuery = useQuery({
    queryKey: computed(() => qk.userWxIdentity(wxBindUserId.value ?? '')),
    queryFn: async ({ queryKey }) => {
      const userId = queryKey[2] as string;
      if (!userId) return null;
      return wxIdentityOrNullSchema.parse(await getWxIdentity(userId));
    },
    enabled: computed(() => wxBindVisible.value && !!wxBindUserId.value),
  });

  const wxIdentity = {
    /** null 有两义：未绑定 / 还没查回来。`loading` 用来区分（见 WxBindDialog）。 */
    data: wxIdentityQuery.data,
    loading: wxIdentityQuery.isFetching,
    error: wxIdentityQuery.error,
    /** 绑定查询失败后的重试入口（对话框错误态的「重试」按钮走它）。 */
    reload: async (): Promise<void> => {
      await wxIdentityQuery.refetch();
    },
  };

  // 错误桥接：与 `useUsersQuery` 的主查询同款，query 的 error 不在 setup 抛错
  // （CLAUDE.md 硬约束）。少了这条，`getWxIdentity` 真失败（20601 / 40101 / 网络）时弹窗会
  // 静默渲染成「未绑态」输入框，用户无从分辨。
  watch(wxIdentityQuery.error, (e) => {
    if (e) ElMessage.error(e.message ?? '企业微信绑定状态加载失败');
  });

  // ============ 切片：mutations（8 条写路径）============
  /** 写完立即失效本域（列表 + 企微绑定；「写完看到自己那笔」的优化，非一致性保证）。 */
  function invalidateUsersDomain(): Promise<void> {
    return qc.invalidateQueries({ queryKey: qk.usersPrefix }).then(() => undefined);
  }

  /**
   * 全部写 mutation 的 onError 统一入口。
   *
   * 40901 单独分支：它是 OCC 冲突（数据被他人改过），提示与动作都与业务失败不同 ——
   * warning 而非 error，并**顺带重拉列表**，否则用户拿着列表里的旧 version 再点一次
   * 必然再次冲突。
   */
  async function handleWriteError(e: Error & { code?: number }, fallback: string): Promise<void> {
    const code = e?.code;
    if (code === VERSION_CONFLICT_CODE) {
      ElMessage.warning('数据已被他人修改，请刷新后重试');
      await fetchList();
      return;
    }
    if (code === USERNAME_DUPLICATE_CODE) {
      // 用户名的唯一性冲突要把焦点送回字段，否则用户盯着一个没反应的弹窗。
      formFocusUsername.value = true;
    }
    if (code === USER_NOT_FOUND_CODE) {
      ElMessage.error(e.message ?? '账号不存在');
      return;
    }
    ElMessage.error(WX_BIND_ERROR_TEXT[code as number] ?? e?.message ?? fallback);
  }

  const createMutation = useMutation({
    mutationKey: ['users', 'create'],
    mutationFn: (payload: Parameters<typeof createUser>[0]) => createUser(payload),
    onSuccess: async () => {
      await invalidateUsersDomain();
      ElMessage.success('已新增账号');
    },
    onError: (e: Error & { code?: number }) => handleWriteError(e, '新增失败'),
  });

  const updateMutation = useMutation({
    mutationKey: ['users', 'update'],
    mutationFn: (vars: { id: string; payload: Parameters<typeof updateUser>[1] }) =>
      updateUser(vars.id, vars.payload),
    onSuccess: async () => {
      await invalidateUsersDomain();
      ElMessage.success('已保存');
    },
    onError: (e: Error & { code?: number }) => handleWriteError(e, '保存失败'),
  });

  const deactivateMutation = useMutation({
    mutationKey: ['users', 'deactivate'],
    mutationFn: (vars: { id: string; version: number }) =>
      deactivateUser(vars.id, { version: vars.version }),
    onSuccess: async () => {
      await invalidateUsersDomain();
      ElMessage.success('已停用');
    },
    onError: (e: Error & { code?: number }) => handleWriteError(e, '停用失败'),
  });

  const resetPasswordMutation = useMutation({
    mutationKey: ['users', 'reset-password'],
    // 无 body、无 OCC（见 api/iam.ts::resetUserPassword 的注释）。
    mutationFn: (id: string) => resetUserPassword(id),
    onSuccess: async () => {
      await invalidateUsersDomain();
      ElMessage.success('已重置为默认密码 changeme');
    },
    onError: (e: Error & { code?: number }) => handleWriteError(e, '重置失败'),
  });

  /**
   * 账号已授角色的单次拉取（`GET /iam/users/{id}/roles`）。
   *
   * 用 useMutation 而不是 useQuery：它跟着「加完 / 移完」这两个用户动作走，缓存留着只会
   * 给出上一份角色列表。`mutationKey` 写字面量（全仓写 mutation 一律如此，无一处从 `qk`
   * 工厂取）—— 它不进任何 query 缓存，登记 queryKey 只会留下一个零消费者的死键。
   */
  const rolesMutation = useMutation({
    mutationKey: ['users', 'list-roles'],
    mutationFn: (userId: string) => listUserRoles(userId),
    onSuccess: (data) => {
      rolesList.value = data;
    },
    onError: (e: Error & { code?: number }) => handleWriteError(e, '加载角色失败'),
  });

  function fetchRoles(): Promise<void> {
    const userId = rolesUserId.value;
    if (!userId) return Promise.resolve();
    return rolesMutation.mutateAsync(userId).then(() => undefined);
  }

  const addRoleMutation = useMutation({
    mutationKey: ['users', 'add-role'],
    mutationFn: (vars: { userId: string; payload: AddUserRolePayload }) =>
      addUserRole(vars.userId, vars.payload),
    onSuccess: async () => {
      await invalidateUsersDomain();
      ElMessage.success('已添加');
    },
    onError: (e: Error & { code?: number }) => handleWriteError(e, '添加失败'),
  });

  const removeRoleMutation = useMutation({
    mutationKey: ['users', 'remove-role'],
    // version 取 UserRoleOut.version（t_user_role 的计数器，不是 t_user.version）。
    mutationFn: (vars: { userId: string; roleId: string; version: number }) =>
      removeUserRole(vars.userId, vars.roleId, { version: vars.version }),
    onSuccess: async () => {
      await invalidateUsersDomain();
      ElMessage.success('已移除');
    },
    onError: (e: Error & { code?: number }) => handleWriteError(e, '移除失败'),
  });

  const bindWxMutation = useMutation({
    mutationKey: ['users', 'bind-wx'],
    mutationFn: (vars: { userId: string; wxUserId: string }) =>
      bindWxIdentity(vars.userId, { wx_user_id: vars.wxUserId }),
    onSuccess: async () => {
      // `qk.usersPrefix` 已覆盖 `qk.userWxIdentity`（后者同在 `users` 前缀下），不必再单独
      // 失效一次 —— 两次调用会让「失效了哪条键」这件事在代码里出现两个答案。
      await invalidateUsersDomain();
      ElMessage.success('已绑定企业微信账号');
    },
    onError: (e: Error & { code?: number }) => handleWriteError(e, '绑定失败'),
  });

  const unbindWxMutation = useMutation({
    mutationKey: ['users', 'unbind-wx'],
    mutationFn: (vars: { userId: string; version: number }) =>
      unbindWxIdentity(vars.userId, { version: vars.version }),
    onSuccess: async () => {
      await invalidateUsersDomain();
      ElMessage.success('已解绑企业微信账号');
    },
    onError: (e: Error & { code?: number }) => handleWriteError(e, '解绑失败'),
  });

  const mutations = {
    createMutation,
    updateMutation,
    deactivateMutation,
    resetPasswordMutation,
    addRoleMutation,
    removeRoleMutation,
    bindWxMutation,
    unbindWxMutation,
  };

  // ============ 动作编排（操作列的行内按钮）============
  /** 新增 / 编辑对话框的保存（Zod 校验在组件侧做 —— 它持有表单的输入态）。
   *  调用方（UserFormDialog）先 parse 过了，这里只做 payload 组装 + 分发。 */
  function submitForm(input: {
    username: string;
    full_name: string;
    password: string;
  }): Promise<void> {
    // 复位 20602 的焦点标志：`handleWriteError` 置它 true、只在 `resetForm()` 里复位，
    // 而提交失败时弹窗保持开着 ⇒ 不在这里复位的话，用户改完用户名二次提交又撞 20602，
    // 组件的 watch 看到「true → true」不触发，字段红字与焦点都不再出现。
    formFocusUsername.value = false;
    formSaving.value = true;
    const done =
      formEditingId.value !== null && formEditingVersion.value !== null
        ? updateMutation.mutateAsync({
            id: formEditingId.value,
            payload: {
              version: formEditingVersion.value,
              full_name: input.full_name,
              // 编辑态留空 = 不改密码 ⇒ 压根不传该键（不是传空串，后端会把密码改成空）。
              ...(input.password ? { password: input.password } : {}),
            },
          })
        : createMutation.mutateAsync({
            username: input.username,
            full_name: input.full_name,
            // 新增态留空 = 用默认口令（沿用旧版行为）。
            password: input.password || DEFAULT_PASSWORD,
          });
    return done
      .then(() => {
        formVisible.value = false;
        resetForm();
      })
      .finally(() => {
        formSaving.value = false;
      });
  }

  /** 加角色。SHELF_ACCOUNT 多货架走循环 addUserRole（纯 INSERT、无 version；后端唯一键
   *  兜重复）；留空 = scope_id 为 null 的通配（共享 HMI 通行）。 */
  async function submitAddRole(): Promise<void> {
    const userId = rolesUserId.value;
    const targetRole = rolesSelectedRole.value;
    if (!userId || !targetRole) return;
    rolesSaving.value = true;
    try {
      if (targetRole === SHELF_SCOPED_ROLE) {
        const shelfIds = [...rolesShelfIds.value];
        if (shelfIds.length === 0) {
          await addRoleMutation.mutateAsync({
            userId,
            payload: { role: SHELF_SCOPED_ROLE, scope_type: 'shelf', scope_id: null },
          });
        } else {
          for (const sid of shelfIds) {
            await addRoleMutation.mutateAsync({
              userId,
              payload: { role: SHELF_SCOPED_ROLE, scope_type: 'shelf', scope_id: sid },
            });
          }
        }
      } else {
        // 其余 4 个角色不绑货架，scope 必须为 null。
        await addRoleMutation.mutateAsync({
          userId,
          payload: { role: targetRole, scope_type: null, scope_id: null },
        });
      }
      rolesShelfIds.value = [];
      await fetchRoles();
      // 货架范围写在 access token 的 claims 里 ⇒ 改了要等 token 刷新才生效，必须提示。
      if (targetRole === SHELF_SCOPED_ROLE) {
        void ElMessageBox.alert(
          '绑定变更已写入。关联 SHELF_ACCOUNT 账号需重新登录或等待 access token 自动刷新（最多 12h）后才能看到新货架范围。',
          '提示',
          { type: 'info' },
        ).catch(() => {
          /* 用户关掉提示，忽略 */
        });
      }
    } catch {
      // 错误已由 mutation 的 onError 提示；保持弹窗开着让用户改完重试。
    } finally {
      rolesSaving.value = false;
    }
  }

  /** 移除角色（version 取该行 `UserRoleOut.version`）。 */
  async function submitRemoveRole(role: UserRoleOutData): Promise<void> {
    const userId = rolesUserId.value;
    if (!userId) return;
    rolesSaving.value = true;
    try {
      await removeRoleMutation.mutateAsync({ userId, roleId: role.id, version: role.version });
      await fetchRoles();
    } catch {
      // 同上：错误已提示
    } finally {
      rolesSaving.value = false;
    }
  }

  /** 绑定企微账号。 */
  async function submitBindWx(wxUserId: string): Promise<void> {
    const userId = wxBindUserId.value;
    if (!userId) return;
    wxBindSaving.value = true;
    try {
      await bindWxMutation.mutateAsync({ userId, wxUserId });
    } catch {
      // 同上：错误已提示，弹窗留着让用户改 userid 重试
    } finally {
      wxBindSaving.value = false;
    }
  }

  /** 解绑企微账号（version 取 `WxIdentity.version`）。 */
  async function submitUnbindWx(version: number): Promise<void> {
    const userId = wxBindUserId.value;
    if (!userId) return;
    wxBindSaving.value = true;
    try {
      await unbindWxMutation.mutateAsync({ userId, version });
    } catch {
      // 同上
    } finally {
      wxBindSaving.value = false;
    }
  }

  const actions: UsersColumnActions = {
    openWxBind: (row) => openWxBind(row),
    openRoles: (row) => openRoles(row),
    edit: (row) => openEdit(row),
    resetPassword: (row) => {
      void resetPasswordMutation.mutateAsync(row.id);
    },
    deactivate: (row) => {
      void deactivateMutation.mutateAsync({ id: row.id, version: row.version });
    },
  };

  // ============ 切片：options（角色对话框的货架候选）============
  // 共享基础数据层（useProductionShelvesQuery）：货架是跨页面共用的基础数据，30s 内与
  // 其它页复用同一份缓存。**不限 zone**（两种区的架都列出来，label 里标「生产 / 品检」），
  // 沿用旧版角色对话框的候选口径。
  const shelvesQuery = useProductionShelvesQuery({ is_active: true, limit: 200 });
  const shelfOptions = computed(() => shelvesQuery.data.value?.items ?? []);

  const options = { shelfOptions };

  // ============ 列定义 + 列可见性 ============
  const columnDefs = buildUsersColumnDefs({ usernameFilter, activeFilter, actions });
  // listKey 沿用旧页面的 'user_list' ⇒ 已存的「列可见性 / 列顺序」快照继续复用（换 key
  // 会让所有用户丢一次列配置）。
  const columnVisibility = useColumnVisibility(columnDefs, { listKey: 'user_list' });

  return {
    query,
    filters,
    ui,
    dialogs,
    wxIdentity,
    mutations,
    options,
    actions,
    columnDefs,
    columnVisibility,
    submitForm,
    submitAddRole,
    submitRemoveRole,
    submitBindWx,
    submitUnbindWx,
  };
});
