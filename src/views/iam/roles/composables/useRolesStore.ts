// src/views/iam/roles/composables/useRolesStore.ts
//
// 2026-10-14 新建：RBAC 控制面板（/iam/roles）的页面级 Pinia setup store。形态照
// `views/users/composables/useUsersListStore.ts`（账号管理页 —— 本页是它的同域姊妹：
// 同样是「左列表 + 右详情」，同样把主查询外提成同域 query hook）。
//
// 不变量（改动前必读，抄自 useUsersListStore）：
//   1. 必须在 RolesPage.vue 的 setup 内首调 —— 切片链路上的 watch / query 会绑到首个
//      创建 store 的组件。组件外（路由守卫 / 其它 store）禁止首调。
//   2. RolesPage.vue 的 onBeforeUnmount 必须 `store.$dispose()`：Pinia 是单例，不 dispose
//      会把选中角色 / 勾选态泄漏到下次进入。
//   3. 消费侧禁止解构 store（reactive 解构丢响应式）；统一 `store.切片.字段` 访问。
//   4. 不 import vue-router（本页无导航需求）。
//
// 左列表操作列与后端写能力的口径（不是「内置角色一律只读」）：
//   - `code === 'ADMIN'`（元角色）：改名 / 停用 / 删除全部隐藏，选中时右区整体 readonly
//     （**提交按钮不渲染**）。后端对 ADMIN 的 grants 与 deactivate 一律拒写；
//   - 其它 `is_system=true`：允许**改名**（弹窗里 code 输入框禁用，名称 / 备注可改）与
//     **停用**，隐藏**删除**。后端只拒系统角色改 code，停用只拒 ADMIN，删除仅限自定义；
//   - `is_system=false`：三项全允许，code 仅在无人持有时可编辑。

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

  /** 选中行；null = 未选中。操作按钮的显隐由视图按 `row.code` / `row.is_system` 判。 */
  const selectedRoleId = ref<string>('');
  const selectedRole = computed(
    () => roles.value.find((r) => r.id === selectedRoleId.value) ?? null,
  );
  /** 右区是否只读：ADMIN 元角色不可写（与后端 POST grants 对 ADMIN 返 400 对齐）。 */
  const isSelectedReadonly = computed(() => selectedRole.value?.code === ADMIN_ROLE_CODE);

  /** 当前勾上的菜单 code / 权限点 code（提交时作为**全量**发出去）。 */
  const checkedMenuCodes = ref<string[]>([]);
  const checkedPermissionCodes = ref<string[]>([]);
  /** grants → 勾选态的一次性灌入标记（role_id:version）。 */
  const hydratedFor = ref('');

  function selectRole(id: string): void {
    // 同 id 早退：el-table 的 `:data` 被替换（写后失效重拉 / staleTime 到期刷新）时，
    // Element Plus 会对同 id 的行**重新 emit current-change**（`setData` →
    // `updateCurrentRowData` → `setCurrentRowByKey` 无条件 emit；行对象按引用找不到就按
    // row-key 查出新对象）。放过去就会把勾选态清空 + hydratedFor 打回 ''，而 grants 的
    // 对象引用没变 ⇒ watch 不再触发 ⇒ 停在「空勾选 + ready=true」，此时点保存就是整包
    // 清空该角色授权。同 id 没有「切角色」语义，直接早退，保留用户当下的勾选。
    if (id === selectedRoleId.value) return;
    selectedRoleId.value = id;
    // 授权包的勾选态随角色切换整体重置 —— 沿用上一角色的勾选会让管理员把 A 角色的
    // 选择误提交到 B 角色（后端是整包替换，一提交就真的生效了）。
    checkedMenuCodes.value = [];
    checkedPermissionCodes.value = [];
    // 同期重置「已灌入」标记：hydratedFor 是 role_id:version 的一次性短路，不清它时
    // 切走再切回同一角色会命中短路 ⇒ 刚被清空的勾选态永远不再从 grants 灌回。
    hydratedFor.value = '';
  }

  // ============ 切片：grants（选中角色的授权包 + 勾选态）============
  const grantsQuery = useRoleGrantsQuery(selectedRoleId, restored);
  const grants = grantsQuery.data;
  const grantsLoading = grantsQuery.isFetching;
  const grantsSaving = ref(false);
  /** 授权包是否已就绪（保存按钮 disabled 与 `submitGrants` 早退共用这条判据）。 */
  const grantsReady = computed(() => grants.value !== undefined);

  /** 把 grants 的已授权集合灌进勾选态。判据是 `role_id:version` stamp ≠ hydratedFor
   *  （**不是**「grants 对象引用变化」）—— 只要触发源重放，同一角色的授权包在勾选态被
   *  清后仍有自愈机会；服务端版本没变时重复触发是零成本的短路。
   *
   *  ⚠️ grants 按角色分片：切角色后 queryKey 先变、data 后到，中间有一拍 data 仍属上一
   *  角色 ⇒ 必须按 `role_id` 过滤，否则会把 A 的授权灌给 B。 */
  function syncChecksFromGrants(): void {
    const g = grants.value;
    if (!g || g.role_id !== selectedRoleId.value) return;
    const stamp = `${g.role_id}:${g.version}`;
    if (hydratedFor.value === stamp) return;
    hydratedFor.value = stamp;
    checkedMenuCodes.value = [...g.menu_codes];
    checkedPermissionCodes.value = [...g.permission_codes];
  }

  // 两个触发源：grants 数据到位 / 刷新（对象引用变化），以及选中角色变化（切回同一角色
  // 时 grants 引用可能不变，靠这一路让 stamp 判定重放）。
  watch([grants, selectedRoleId], syncChecksFromGrants);

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
  /** 正在编辑的角色行（按 `formEditingId` 查，不是 `selectedRole` —— 改名按钮可以点在
   *  未选中行上）。 */
  const formEditingRole = computed(
    () => roles.value.find((r) => r.id === formEditingId.value) ?? null,
  );
  /** 改名态下 code 是否可改：
   *  - 新建态恒可改；
   *  - 内置角色的 code 是后端判权的稳定键（后端只拒系统角色改 code），不可改；
   *  - 自定义角色有人持有时保守禁用：后端支持级联改名（关联表同步改），但会踢掉全部
   *    持有者重登，默认不替管理员做这个决定（user_count === 0 才放开）。 */
  const formCodeEditable = computed(() => {
    if (formEditingId.value === null) return true;
    const role = formEditingRole.value;
    if (!role) return false;
    return !role.is_system && role.user_count === 0;
  });
  /** code 禁用原因的文案分支（内置角色 / 有人持有是两回事）。 */
  const formEditingIsSystem = computed(() => formEditingRole.value?.is_system ?? false);
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
  /** 停用 / 删除的一次性流程：二次确认 → 提交 → 清选中态。无独立弹窗（确认走
   *  `ElMessageBox.confirm`），故不留 `visible` 之类的中转状态。 */
  const deactivateSaving = ref(false);
  /** 在途操作的目标行 id（'' = 无在途）。`deactivateSaving` 是全局在途标志，配 targetId
   *  才能把逐行 loading 收在真正被点的那一行上（否则任一行的操作会让全表按钮一起转圈）。 */
  const deactivateTargetId = ref('');

  async function openDeactivate(id: string, isDelete: boolean): Promise<void> {
    const role = roles.value.find((r) => r.id === id);
    if (!role) return;
    try {
      await ElMessageBox.confirm(
        isDelete
          ? `确认删除角色「${role.name}」？删除不可恢复` +
              (role.user_count > 0
                ? `，${role.user_count} 个持有该角色的账号将失去对应权限。`
                : '。')
          : `确认停用角色「${role.name}」？` +
              (role.user_count > 0
                ? `停用后 ${role.user_count} 个持有该角色的账号将失去对应权限。`
                : '当前没有账号持有该角色。'),
        isDelete ? '确认删除' : '确认停用',
        { type: 'warning' },
      );
    } catch {
      return; // 用户取消
    }
    deactivateSaving.value = true;
    deactivateTargetId.value = id;
    try {
      await deactivateMutation.mutateAsync({ id, version: role.version, delete: isDelete });
      // 停用/删除后若选中的正是该角色，清选中态（右区会随之一并收起）。
      if (selectedRoleId.value === id) selectRole('');
    } catch {
      // 错误已由 onError 提示。
    } finally {
      deactivateSaving.value = false;
      deactivateTargetId.value = '';
    }
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
    onSuccess: async (data, vars) => {
      await invalidateRolesDomain();
      const action = vars.delete ? '已删除' : '已停用';
      ElMessage.success(
        data.affected_user_count > 0
          ? `${action}，${data.affected_user_count} 个账号不再持有该角色`
          : action,
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
   *  code 省略 = 不改（后端 update 的 `code?` 语义）；新建态 code 必填。
   *
   *  提交值取 **parse 结果**而不是原始输入：`roleFormSchema` 负责 trim + 大写归一
   *  （与后端 `[A-Z0-9_]` 的 code 约束对齐）。 */
  function submitRoleForm(input: RoleFormInput): Promise<void> {
    const parsed = roleFormSchema.safeParse(input);
    if (!parsed.success) {
      formErrors.value = toFieldErrors(parsed.error.issues);
      return Promise.resolve();
    }
    const editing = formEditingId.value !== null;
    if (!editing && !parsed.data.code) {
      formErrors.value = { code: '请输入角色代码' };
      return Promise.resolve();
    }
    formErrors.value = {};
    formSaving.value = true;
    const values = parsed.data;
    const done =
      formEditingId.value !== null && formEditingVersion.value !== null
        ? updateMutation.mutateAsync({
            id: formEditingId.value,
            payload: {
              version: formEditingVersion.value,
              name: values.name,
              ...(values.description ? { description: values.description } : {}),
              // code 留空 / 不可改（内置角色或已有账号持有）⇒ 不传该键（update 的语义
              // 是省略即不改；传空串会把 code 改成空）。
              ...(formCodeEditable.value && values.code ? { code: values.code } : {}),
            },
          })
        : createMutation.mutateAsync({
            code: values.code,
            name: values.name,
            ...(values.description ? { description: values.description } : {}),
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

  /** 保存授权（**整包替换**：两个数组都是当前勾上的全集，带 OCC version）。
   *
   *  ⚠️ ADMIN 早退：元角色后端拒写（400），前端根本不渲染提交按钮，这里是第二道闸。
   *  ⚠️ grants 未就绪早退：此时勾选态还没回填（空集），而 `version` 只能取
   *  `grants.version`（与列表行的 role.version 同源于 t_role.version，兜底值恰好是
   *  一份**合法的 OCC 锚**）—— 带空集提交会把该角色的授权静默清空且不报冲突。 */
  async function submitGrants(): Promise<void> {
    const role = selectedRole.value;
    if (!role || isSelectedReadonly.value) return;
    if (!grants.value) {
      ElMessage.warning('授权加载中，请稍候');
      return;
    }
    grantsSaving.value = true;
    try {
      await saveGrantsMutation.mutateAsync({
        id: role.id,
        payload: {
          menu_codes: [...checkedMenuCodes.value],
          permission_codes: [...checkedPermissionCodes.value],
          version: grants.value.version,
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
    /** 授权包已就绪（RoleGrantsPanel 的保存按钮 :disabled 用它）。 */
    ready: grantsReady,
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
      /** code 禁用原因的分支：true = 内置角色（code 固定），false = 可能只是有人持有。 */
      editingIsSystem: formEditingIsSystem,
      saving: formSaving,
      form,
      errors: formErrors,
      openCreate,
      openEdit,
      closeForm,
    },
    deactivate: {
      saving: deactivateSaving,
      targetId: deactivateTargetId,
      openDeactivate,
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
