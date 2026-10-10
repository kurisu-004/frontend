// src/views/iam/roles/composables/useRolesStore.ts
//
// 2026-10-14 新建：RBAC 控制面板（/iam/roles）的页面级 Pinia setup store。形态照
// `views/users/composables/useUsersListStore.ts`（账号管理页 —— 本页是它的同域姊妹：
// 同样是「左列表 + 右详情 + 三个写对话框」，同样把主查询外提成同域 query hook）。
//
// 不变量（改动前必读，抄自 useUsersListStore）：
//   1. 必须在 RolesPage.vue 的 setup 内首调 —— 切片链路上的 watch / query 会绑到首个
//      创建 store 的组件。组件外（路由守卫 / 其它 store）禁止首调。
//   2. RolesPage.vue 的 onBeforeUnmount 必须 `store.$dispose()`：Pinia 是单例，不 dispose
//      会把选中角色 / 勾选态泄漏到下次进入。
//   3. 消费侧禁止解构 store（reactive 解构丢响应式）；统一 `store.切片.字段` 访问。
//   4. 不 import vue-router（本页无导航需求）。
//
// 本页比账号管理多两处**只读**语义，都是与后端拒写形成的双端兜底（前端不给入口，后端
// 也会拒）：
//   - ADMIN（元角色）的左列表行不渲染写操作按钮；
//   - 选中 ADMIN 时右区整体 readonly（el-tree disabled + **提交按钮不渲染**）。

import { computed, reactive, ref, watch } from 'vue';
import { defineStore } from 'pinia';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useMutation, useQueryClient } from '@tanstack/vue-query';
import {
  createRole,
  deactivateRole,
  saveRoleGrants,
  updateRole,
  type SaveRoleGrantsPayload,
} from '@/api/rbac';
import { qk } from '@/composables/queries/keys';
import {
  roleFormSchema,
  toFieldErrors,
  type RoleFormFieldErrors,
  type RoleFormInput,
} from './rbacSchema';
import { useRbacCatalogQuery, useRoleGrantsQuery, useRolesQuery } from './useRolesQuery';

/** 元角色 code：后端对它通配放行，且拒写它的授权（POST grants 返 400）。
 *  前端对 ADMIN 做只读渲染 —— 这是第一道闸，后端是第二道。 */
export const ADMIN_ROLE_CODE = 'ADMIN';

/** OCC 版本冲突：只表达乐观锁冲突，UI 提示刷新后重试并重拉。 */
const VERSION_CONFLICT_CODE = 40901;

export const useRolesStore = defineStore('iam-roles', () => {
  // ⚠️ 必须在 setup 第一行捕获（Pinia 不给 action wrapper / listener 注入上下文，
  // `useQueryClient()` 的守卫会抛）。
  const qc = useQueryClient();

  // enabled 闸门：默认 false，restoreState() 末尾开闸，避免双 fetch。
  const restored = ref(false);

  // ============ 切片：query（角色列表主查询）============
  const listQuery = useRolesQuery(restored);
  const roles = computed(() => listQuery.data.value ?? []);
  const loading = listQuery.isFetching;
  const errorMsg = computed<string | null>(() => {
    const e = listQuery.error.value;
    return e ? e.message : null;
  });
  const { fetchList } = listQuery;

  /** 选中行（ADMIN 等系统角色的操作按钮在视图里按 `selectedRole.is_system` 隐藏）。 */
  const selectedRoleId = ref<string>('');
  const selectedRole = computed(() => roles.value.find((r) => r.id === selectedRoleId.value) ?? null);
  /** 右区是否只读：ADMIN 元角色不可写（与后端 POST grants 对 ADMIN 返 400 对齐）。 */
  const isSelectedReadonly = computed(() => selectedRole.value?.code === ADMIN_ROLE_CODE);

  function selectRole(id: string): void {
    selectedRoleId.value = id;
    // 授权包的勾选态随角色切换整体重置 —— 沿用上一角色的勾选会让管理员把 A 角色的
    // 选择误提交到 B 角色（后端是整包替换，一提交就真的生效了）。
    checkedMenuCodes.value = [];
    checkedPermissionCodes.value = [];
  }

  // ============ 切片：grants（选中角色的授权包 + 勾选态）============
  const grantsQuery = useRoleGrantsQuery(selectedRoleId, restored);
  const grants = grantsQuery.data;
  const grantsLoading = grantsQuery.isFetching;

  /** 当前勾上的菜单 code / 权限点 code（提交时作为**全量**发出去）。 */
  const checkedMenuCodes = ref<string[]>([]);
  const checkedPermissionCodes = ref<string[]>([]);
  const grantsSaving = ref(false);

  /** grants 到位后把已授权集合灌进勾选态（每次换角色 / 刷新都重灌）。
   *  只灌一次判定用 key 是 roleId + version：保存成功后后端会自增 version，
   *  那个时刻应当以**服务端返回的**为准重新灌，而不是保留本地勾选（虽然两者一致，
   *  但一旦服务端做了规范化就会分叉）。 */
  const hydratedFor = ref('');
  watch(grants, (g) => {
    if (!g) return;
    const stamp = `${g.role_id}:${g.version}`;
    if (hydratedFor.value === stamp) return;
    hydratedFor.value = stamp;
    checkedMenuCodes.value = [...g.menu_codes];
    checkedPermissionCodes.value = [...g.permission_codes];
  });

  // ============ 切片：catalog（权限点分组 + 菜单树全集）============
  const catalogQuery = useRbacCatalogQuery(restored);
  // query.data 是 `Ref<T | undefined>`（请求回来之前是 undefined），对外一律给空数组
  // 默认值：消费侧（视图 / 组件）因此不必到处写 `?? []`，而 el-tree / v-for 收到空数组
  // 与 undefined 的差别是「空态渲染」vs「渲染报错」。
  const permissionGroups = computed(() => catalogQuery.permissionGroups.value ?? []);
  const menuTree = computed(() => catalogQuery.menuTree.value ?? []);

  // ============ 切片：dialogs.role（新建 / 改名合一）============
  const formVisible = ref(false);
  /** 正在编辑的角色 id；null = 新建模式。 */
  const formEditingId = ref<string | null>(null);
  /** OCC 锚：`POST /{id}/update` 必传（缺省是后端 422 纯文本）。 */
  const formEditingVersion = ref<number | null>(null);
  /** 改名态下 code 是否可改：改 code 会让已持有旧 code 的授权失去指向，
   *  仅在该角色当前无人持有（user_count === 0）时放开。 */
  const formCodeEditable = computed(
    () => formEditingId.value === null || (selectedRole.value?.user_count ?? 0) === 0,
  );
  const formSaving = ref(false);
  const form = reactive<RoleFormInput>({ code: '', name: '', description: '' });
  const formErrors = ref<RoleFormFieldErrors>({});

  function resetForm(): void {
    form.code = '';
    form.name = '';
    form.description = '';
    formEditingId.value = null;
    formEditingVersion.value = null;
    formErrors.value = {};
  }

  function openCreate(): void {
    resetForm();
    formVisible.value = true;
  }

  function openEdit(id: string): void {
    const role = roles.value.find((r) => r.id === id);
    if (!role) return;
    resetForm();
    formEditingId.value = role.id;
    formEditingVersion.value = role.version;
    form.code = role.code;
    form.name = role.name;
    form.description = role.description ?? '';
    formVisible.value = true;
  }

  function closeForm(): void {
    formVisible.value = false;
  }

  // ============ 切片：dialogs.deactivate（停用 / 删除）============
  const deactivateVisible = ref(false);
  const deactivateTargetId = ref<string>('');
  const deactivateIsDelete = ref(false);
  const deactivateTargetUserCount = ref(0);
  const deactivateSaving = ref(false);

  function openDeactivate(id: string, isDelete: boolean): void {
    const role = roles.value.find((r) => r.id === id);
    if (!role) return;
    deactivateTargetId.value = role.id;
    deactivateTargetUserCount.value = role.user_count;
    deactivateIsDelete.value = isDelete;
    deactivateVisible.value = true;
  }

  // ============ 切片：mutations（4 个写端点）============
  /** 写完立即失效本域（角色列表 + 授权包 + 两份全集）。失效的是「优化」（写完看到
   *  自己那笔），**不是**新鲜度保证：别的管理员改了授权，本页要靠 30s staleTime 或
   *  手动刷新看到（跨页面写操作不做穷举失效，CLAUDE.md 既定策略）。 */
  function invalidateRolesDomain(): Promise<void> {
    return qc.invalidateQueries({ queryKey: qk.rolesPrefix }).then(() => undefined);
  }

  /** 全部写 mutation 的 onError 统一入口。40901 单独分支：它是 OCC 冲突（数据被他人
   *  改过），提示与动作都与业务失败不同 —— warning + 顺带重拉，否则用户拿着列表里的
   *  旧 version 再点一次必然再次冲突。 */
  async function handleWriteError(e: Error & { code?: number }, fallback: string): Promise<void> {
    if (e?.code === VERSION_CONFLICT_CODE) {
      ElMessage.warning('数据已被他人修改，请刷新后重试');
      await fetchList();
      await grantsQuery.fetchGrants();
      return;
    }
    ElMessage.error(e?.message ?? fallback);
  }

  const createMutation = useMutation({
    mutationKey: ['iam-roles', 'create'],
    mutationFn: (payload: Parameters<typeof createRole>[0]) => createRole(payload),
    onSuccess: async () => {
      await invalidateRolesDomain();
      ElMessage.success('已新建角色');
    },
    onError: (e: Error & { code?: number }) => handleWriteError(e, '新建失败'),
  });

  const updateMutation = useMutation({
    mutationKey: ['iam-roles', 'update'],
    mutationFn: (vars: { id: string; payload: Parameters<typeof updateRole>[1] }) =>
      updateRole(vars.id, vars.payload),
    onSuccess: async () => {
      await invalidateRolesDomain();
      ElMessage.success('已保存');
    },
    onError: (e: Error & { code?: number }) => handleWriteError(e, '保存失败'),
  });

  const deactivateMutation = useMutation({
    mutationKey: ['iam-roles', 'deactivate'],
    mutationFn: (vars: { id: string; version: number; delete: boolean }) =>
      deactivateRole(vars.id, { version: vars.version, delete: vars.delete }),
    onSuccess: async (data) => {
      await invalidateRolesDomain();
      ElMessage.success(
        data.affected_user_count > 0
          ? `已处理，${data.affected_user_count} 个账号不再持有该角色`
          : '已处理',
      );
    },
    onError: (e: Error & { code?: number }) => handleWriteError(e, '操作失败'),
  });

  const saveGrantsMutation = useMutation({
    mutationKey: ['iam-roles', 'save-grants'],
    mutationFn: (vars: { id: string; payload: SaveRoleGrantsPayload }) =>
      saveRoleGrants(vars.id, vars.payload),
    onSuccess: async () => {
      // 授权包改动影响的是「谁在下次登录时拿到什么权限」，不等于当前用户的权限。
      // 当前用户的 permissions 存在 auth store 里、不归 query 管 ⇒ 这里只失效面板域。
      await invalidateRolesDomain();
      ElMessage.success('已保存授权');
    },
    onError: (e: Error & { code?: number }) => handleWriteError(e, '保存授权失败'),
  });

  const mutations = { createMutation, updateMutation, deactivateMutation, saveGrantsMutation };

  // ============ 动作编排 ============
  function restoreState(): void {
    // 开闸放行首屏 fetch（面板无持久化筛选态，只有这一行）。
    restored.value = true;
  }

  /** 新建 / 改名的提交。Zod 校验在这里做（组件持有输入态，它只负责调本函数）。
   *  code 省略 = 不改（后端 update 的 `code?` 语义）；新建态 code 必填。 */
  function submitRoleForm(input: RoleFormInput): Promise<void> {
    const parsed = roleFormSchema.safeParse(input);
    const errors: RoleFormFieldErrors = parsed.success ? {} : toFieldErrors(parsed.error.issues);
    const editing = formEditingId.value !== null;
    if (!editing && !input.code.trim()) {
      errors.code = '请输入角色代码';
    }
    if (Object.keys(errors).length > 0) {
      formErrors.value = errors;
      return Promise.resolve();
    }
    formErrors.value = {};
    formSaving.value = true;
    const done =
      formEditingId.value !== null && formEditingVersion.value !== null
        ? updateMutation.mutateAsync({
            id: formEditingId.value,
            payload: {
              version: formEditingVersion.value,
              name: input.name.trim(),
              ...(input.description ? { description: input.description.trim() } : {}),
              // code 留空 = 不改 ⇒ 压根不传该键（不是传空串，后端会把 code 改成空）。
              ...(input.code.trim() ? { code: input.code.trim() } : {}),
            },
          })
        : createMutation.mutateAsync({
            code: input.code.trim(),
            name: input.name.trim(),
            ...(input.description ? { description: input.description.trim() } : {}),
          });
    return done
      .then(() => {
        formVisible.value = false;
        resetForm();
      })
      .catch(() => {
        // 错误已由 onError 提示；弹窗保持开着让用户改完重试。
      })
      .finally(() => {
        formSaving.value = false;
      });
  }

  /** 停用 / 删除：先弹二次确认（会告知影响多少账号），再发请求。 */
  async function submitDeactivate(): Promise<void> {
    const id = deactivateTargetId.value;
    const role = roles.value.find((r) => r.id === id);
    if (!role) return;
    deactivateSaving.value = true;
    try {
      const isDelete = deactivateIsDelete.value;
      await ElMessageBox.confirm(
        isDelete
          ? `确认删除角色「${role.name}」？该操作不可恢复。`
          : `确认停用角色「${role.name}」？` +
            (role.user_count > 0
              ? `当前有 ${role.user_count} 个账号持有该角色，停用后这些账号将失去对应权限。`
              : '当前没有账号持有该角色。'),
        isDelete ? '确认删除' : '确认停用',
        { type: 'warning' },
      );
      await deactivateMutation.mutateAsync({ id, version: role.version, delete: isDelete });
      // 停用/删除后若选中的正是该角色，清选中态（右区会随之一并收起）。
      if (selectedRoleId.value === id) selectRole('');
      deactivateVisible.value = false;
    } catch {
      // 用户取消 或 已被 onError 提示。
    } finally {
      deactivateSaving.value = false;
    }
  }

  /** 保存授权（**整包替换**：两个数组都是当前勾上的全集，带 OCC version）。
   *
   *  ⚠️ ADMIN 早退：元角色后端拒写（400），前端根本不渲染提交按钮，这里是第二道闸。 */
  async function submitGrants(): Promise<void> {
    const role = selectedRole.value;
    if (!role || isSelectedReadonly.value) return;
    grantsSaving.value = true;
    try {
      await saveGrantsMutation.mutateAsync({
        id: role.id,
        payload: {
          menu_codes: [...checkedMenuCodes.value],
          permission_codes: [...checkedPermissionCodes.value],
          version: grants.value?.version ?? role.version,
        },
      });
    } catch {
      // 同上：错误已提示，勾选态保留让用户改完重试。
    } finally {
      grantsSaving.value = false;
    }
  }

  /** 勾选态变更（el-tree / el-checkbox-group 的 @check / @change）。 */
  function setCheckedMenus(codes: string[]): void {
    checkedMenuCodes.value = codes;
  }

  function setCheckedPermissions(codes: string[]): void {
    checkedPermissionCodes.value = codes;
  }

  const query = {
    roles,
    loading,
    errorMsg,
    selectedRoleId,
    selectedRole,
    isSelectedReadonly,
    fetchList,
    selectRole,
    restoreState,
  };

  const grantsSlice = {
    data: grants,
    loading: grantsLoading,
    saving: grantsSaving,
    checkedMenuCodes,
    checkedPermissionCodes,
    setCheckedMenus,
    setCheckedPermissions,
    submitGrants,
  };

  const dialogs = {
    form: {
      visible: formVisible,
      editingId: formEditingId,
      codeEditable: formCodeEditable,
      saving: formSaving,
      form,
      errors: formErrors,
      openCreate,
      openEdit,
      closeForm,
    },
    deactivate: {
      visible: deactivateVisible,
      saving: deactivateSaving,
      isDelete: deactivateIsDelete,
      targetUserCount: deactivateTargetUserCount,
      openDeactivate,
      submitDeactivate,
    },
  };

  return {
    query,
    grants: grantsSlice,
    catalog: { permissionGroups, menuTree },
    dialogs,
    mutations,
    submitRoleForm,
  };
});