<!--
  RolesPage.vue — 角色权限（RBAC 控制面板）

  2026-10-14 新建。**薄壳**：左角色列表 + 右授权面板 + 新建/改名对话框，全部状态与动作
  在同域 store（`./composables/useRolesStore.ts`）里；本组件只做「骨架 + 事件接线」。
  形态照 `views/users/UserList.vue`（账号管理 —— 本页是它的姊妹页）。
-->
<template>
  <div class="roles-page">
    <div class="page-header">
      <h2>角色权限</h2>
      <el-button type="primary" @click="store.dialogs.form.openCreate()">新建角色</el-button>
    </div>

    <div class="roles-body">
      <!-- 左：角色列表 -->
      <div class="roles-left">
        <el-table
          v-loading="store.query.loading"
          :data="store.query.roles"
          row-key="id"
          height="100%"
          empty-text="暂无角色"
          highlight-current-row
          @current-change="onCurrentChange"
        >
          <el-table-column prop="name" label="名称" min-width="120" />
          <el-table-column prop="code" label="代码" min-width="120" />
          <el-table-column label="用户数" width="70" align="center">
            <template #default="{ row }">{{ row.user_count }}</template>
          </el-table-column>
          <el-table-column label="状态" width="80" align="center">
            <template #default="{ row }">
              <!-- 系统角色不走「启用 / 停用」分档：它的主语义是「内置」，
                   停用态只是附加说明（`is_system && !is_active`）。 -->
              <el-tag v-if="row.is_system" size="small" :type="row.is_active ? 'info' : 'danger'">
                {{ row.is_active ? '内置' : '内置·已停用' }}
              </el-tag>
              <el-tag v-else-if="row.is_active" size="small" type="success">启用</el-tag>
              <el-tag v-else size="small" type="danger">停用</el-tag>
            </template>
          </el-table-column>
          <!--
            操作列逐行判：ADMIN（元角色）无任何写按钮（后端 grants / deactivate 都拒）；
            其它内置角色可改名 / 停用（不可删除）；自定义角色三项全开。口径与后端
            update_role / deactivate_role 的实际限制一致（见 useRolesStore 文件头）。
          -->
          <el-table-column label="操作" width="180" fixed="right">
            <template #default="{ row }">
              <template v-if="row.code !== ADMIN_ROLE_CODE">
                <el-button
                  link
                  type="primary"
                  size="small"
                  @click="store.dialogs.form.openEdit(row.id)"
                >
                  改名
                </el-button>
                <el-button
                  v-if="row.is_active"
                  link
                  type="warning"
                  size="small"
                  :loading="deactivateLoadingFor(row.id)"
                  @click="store.dialogs.deactivate.openDeactivate(row.id, false)"
                >
                  停用
                </el-button>
                <el-button
                  v-if="!row.is_system"
                  link
                  type="danger"
                  size="small"
                  :loading="deactivateLoadingFor(row.id)"
                  @click="store.dialogs.deactivate.openDeactivate(row.id, true)"
                >
                  删除
                </el-button>
              </template>
              <span v-else class="muted">—</span>
            </template>
          </el-table-column>
        </el-table>
      </div>

      <!-- 右：授权面板 -->
      <div class="roles-right">
        <RoleGrantsPanel
          :role="store.query.selectedRole"
          :readonly="store.query.isSelectedReadonly"
          :menu-tree="store.catalog.menuTree"
          :permission-groups="store.catalog.permissionGroups"
          :checked-menu-codes="store.grants.checkedMenuCodes"
          :checked-permission-codes="store.grants.checkedPermissionCodes"
          :loading="store.grants.loading"
          :saving="store.grants.saving"
          :ready="store.grants.ready"
          @update:menu-codes="store.grants.setCheckedMenus"
          @update:permission-codes="store.grants.setCheckedPermissions"
          @submit="store.grants.submitGrants()"
        />
      </div>
    </div>

    <!-- 新建 / 改名对话框 -->
    <el-dialog
      v-model="store.dialogs.form.visible"
      :title="store.dialogs.form.editingId ? '编辑角色' : '新建角色'"
      width="480px"
      @closed="store.dialogs.form.closeForm()"
    >
      <el-form :model="store.dialogs.form.form" label-width="80px">
        <el-form-item label="代码" prop="code">
          <el-input
            v-model="store.dialogs.form.form.code"
            :disabled="!store.dialogs.form.codeEditable"
            placeholder="如 QC_LEAD（大写）"
          />
          <div v-if="!store.dialogs.form.codeEditable" class="field-hint">
            {{
              store.dialogs.form.editingIsSystem
                ? '内置角色的代码固定，不可修改。'
                : '该角色已有账号持有，改 code 会强制这些账号重新登录，故不可改。'
            }}
          </div>
          <div v-if="store.dialogs.form.errors.code" class="field-error">
            {{ store.dialogs.form.errors.code }}
          </div>
        </el-form-item>
        <el-form-item label="名称" prop="name">
          <el-input v-model="store.dialogs.form.form.name" placeholder="如 品检组长" />
          <div v-if="store.dialogs.form.errors.name" class="field-error">
            {{ store.dialogs.form.errors.name }}
          </div>
        </el-form-item>
        <el-form-item label="备注" prop="description">
          <el-input v-model="store.dialogs.form.form.description" placeholder="可选" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="store.dialogs.form.closeForm()">取消</el-button>
        <el-button type="primary" :loading="store.dialogs.form.saving" @click="onSubmitForm">
          保存
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
// views/iam/roles/RolesPage.vue
//
// 2026-10-14 新建：见文件头。store 4 不变量之 #1（**页面 setup 内首调**）与 #2
// （`onBeforeUnmount` 必须 `$dispose()`）都在这里；#4（禁 import vue-router）天然满足
// —— 本页没有任何导航需求。
//
// 组件零 `api/*` 依赖：数据全部来自 store 的切片。

import { onBeforeUnmount, onMounted } from 'vue';
import RoleGrantsPanel from './components/RoleGrantsPanel.vue';
import { useRolesStore, ADMIN_ROLE_CODE } from './composables/useRolesStore';
import type { RoleDefData } from './composables/rbacSchema';

// 不变量 #1：首调。
const store = useRolesStore();

onMounted(() => {
  // enabled 闸门在 restoreState() 末尾打开，避免「默认态首屏 + 恢复态再屏」双 fetch。
  store.query.restoreState();
});

onBeforeUnmount(() => {
  // 不变量 #2：Pinia 是单例，不 dispose 会把选中角色 / 勾选态泄漏到下次进入。
  store.$dispose();
});

/** el-table 的当前行变化 → 切选中角色。同 id 重发（表格数据替换）由 store 早退兜住，
 *  勾选态不会被清（见 `useRolesStore::selectRole` 的注释）。 */
function onCurrentChange(row: RoleDefData | null): void {
  store.query.selectRole(row ? row.id : '');
}

/** 逐行 loading：停用 / 删除在途时只让被点的那一行转圈（store 的在途标志 + 目标行 id）。 */
function deactivateLoadingFor(rowId: string): boolean {
  return store.dialogs.deactivate.saving && store.dialogs.deactivate.targetId === rowId;
}

function onSubmitForm(): void {
  void store.submitRoleForm({ ...store.dialogs.form.form });
}
</script>

<style lang="scss" scoped>
.roles-page {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.roles-body {
  flex: 1;
  min-height: 0;
  display: flex;
  gap: 16px;
}

.roles-left {
  width: 44%;
  min-width: 360px;
}

.roles-right {
  flex: 1;
  min-width: 0;
  border-left: 1px solid var(--el-border-color-lighter);
  padding-left: 16px;
}

.muted {
  color: var(--el-text-color-placeholder);
}

.field-hint {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  line-height: 1.4;
}

.field-error {
  font-size: 12px;
  color: var(--el-color-danger);
  line-height: 1.4;
}
</style>
