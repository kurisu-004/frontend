<!--
  RoleDialog.vue — 角色管理

  2026-10-10 新建。保留旧页面的全部行为：
    - 角色 tag 列表 + 逐个移除；
    - `SHELF_ACCOUNT` 时显示**可多选**的货架下拉，留空 = 共享 HMI 通配
      （scope_id 为 NULL，意图覆盖车间全部 PRODUCTION 架，不绑死单架）；
    - 多货架绑走循环 addUserRole；
    - 已绑的货架在多选下拉里 `:disabled`（防重复绑，后端唯一键会兜但没必要让用户撞）；
    - 加完 `SHELF_ACCOUNT` 后弹「要重新登录 / 等 token 刷新才生效」的提示（store 里做）。

  「移除」传的 version 是 `UserRoleOut.version`（`t_user_role` 的计数器），不是
  `t_user.version` —— 两个是互不相关的数，混用必 40901。
-->
<template>
  <el-dialog
    :model-value="store.dialogs.roles.visible"
    title="角色管理"
    :width="dlg.width"
    :top="dlg.top"
    :close-on-click-modal="false"
    @update:model-value="store.dialogs.roles.closeRoles()"
  >
    <p class="roles-current">当前账号（{{ store.dialogs.roles.username }}）：</p>
    <div v-if="store.dialogs.roles.list.length === 0" class="muted">无角色</div>
    <div v-for="r in store.dialogs.roles.list" :key="r.id" class="role-row">
      <el-tag size="small" :type="r.scope_type ? 'warning' : 'primary'">
        {{ r.role }}{{ r.shelf_code ? ` @${r.shelf_code}` : '' }}
      </el-tag>
      <el-button
        link
        size="small"
        type="danger"
        :loading="store.dialogs.roles.saving"
        @click="store.submitRemoveRole(r)"
      >
        移除
      </el-button>
    </div>
    <el-divider />
    <div class="role-form">
      <div class="role-form-row">
        <span class="role-form-label">加角色</span>
        <el-select
          v-model="store.dialogs.roles.selectedRole"
          placeholder="选角色"
          style="width: 180px"
          clearable
        >
          <el-option v-for="o in ROLE_OPTIONS" :key="o.value" :label="o.label" :value="o.value" />
        </el-select>
      </div>
      <div v-if="store.dialogs.roles.selectedRole === SHELF_SCOPED_ROLE" class="role-form-row">
        <span class="role-form-label">货架（可多选）</span>
        <el-select
          v-model="store.dialogs.roles.shelfIds"
          multiple
          filterable
          collapse-tags
          collapse-tags-tooltip
          :max-collapse-tags="3"
          placeholder="选 1+ 个货架；留空 = 共享 HMI 通行"
          style="width: 340px"
          clearable
        >
          <el-option
            v-for="s in store.options.shelfOptions"
            :key="s.id"
            :disabled="store.dialogs.roles.boundShelfIds.has(String(s.id))"
            :label="`${s.code} (${s.zone === 'PRODUCTION' ? '生产' : '品检'})`"
            :value="String(s.id)"
          />
        </el-select>
      </div>
      <div class="role-form-row">
        <el-button
          type="primary"
          :disabled="!store.dialogs.roles.selectedRole"
          :loading="store.dialogs.roles.saving"
          @click="store.submitAddRole()"
        >
          添加
        </el-button>
      </div>
    </div>
    <p
      v-if="
        store.dialogs.roles.selectedRole === SHELF_SCOPED_ROLE &&
        store.dialogs.roles.shelfIds.length === 0
      "
      class="scope-hint"
    >
      货架留空 = 共享工控机（HMI）通行：该账号意图覆盖车间所有 PRODUCTION 架，不绑死单架。
    </p>
  </el-dialog>
</template>

<script setup lang="ts">
// views/users/components/RoleDialog.vue
//
// 2026-10-10 新建：见文件头。组件 0 业务状态（角色列表 / 候选 / 选中值全在 store），
// 零 `api/*` 依赖。

import { useDialogSize } from '@/composables/useDialogSize';
import { ROLE_OPTIONS, SHELF_SCOPED_ROLE } from '../usersConstants';
import { useUsersListStore } from '../composables/useUsersListStore';

const store = useUsersListStore();
const dlg = useDialogSize({ desktopWidth: 560 });
</script>

<style lang="scss" scoped>
.roles-current {
  margin-bottom: 8px;
}

.role-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.role-form-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.role-form-label {
  width: 96px;
  text-align: right;
  font-size: 14px;
  color: var(--el-text-color-regular);
}

.muted {
  color: var(--text-secondary);
}

.scope-hint {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 8px 0 0;
  padding: 8px 12px;
  background: #fdf6ec;
  border: 1px solid #faecd8;
  border-radius: 6px;
  font-size: 13px;
  color: #b88230;
  line-height: 1.5;
}
</style>
