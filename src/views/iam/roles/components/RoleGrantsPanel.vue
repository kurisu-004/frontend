<!--
  RoleGrantsPanel.vue — 角色授权编辑区（RBAC 面板右栏）

  2026-10-14 新建。组件 0 业务状态（勾选集合 / 提交都在 store），只负责渲染与事件上报：

    - 上半：系统菜单树勾选（el-tree，`node-key="code"`、父子联动）；
    - 下半：权限点按 domain 分组勾选（el-checkbox-group）；
    - 底部：保存按钮（**readonly 时整块不渲染**，见下）。

  ⚠️ **ADMIN 元角色的只读是双端兜底的前端那一半**：后端对 ADMIN 的 `POST .../grants`
  返 400，所以前端不给提交入口 —— 用户看到的是一份「全勾选、不可改」的全量视图，
  而不是点保存然后吃一个后端错误。

  ⚠️ **el-tree 的 `node-key="code"` 与 el-checkbox-group 的 `value` 用同一套 code
  取值域**（都来自后端 `MenuNode.code` / `PermissionDef.code`），这是后端
  `RoleGrants.menu_codes` / `permission_codes` 能直接对上号的前提。
-->
<template>
  <div v-loading="loading" class="grants-panel">
    <el-empty v-if="!role" description="请在左侧选择一个角色" :image-size="80" />

    <template v-else>
      <el-alert
        v-if="readonly"
        type="info"
        :closable="false"
        show-icon
        title="系统内置角色不可修改"
        description="ADMIN 对所有菜单与权限点通配放行，其授权由后端固定；下方展示的是全量视图。"
        class="readonly-alert"
      />

      <section class="grants-section">
        <h4 class="grants-title">菜单权限（{{ checkedMenuCodes.length }} 项）</h4>
        <el-tree
          :data="menuTree"
          :props="{ label: 'title', children: 'children' }"
          node-key="code"
          show-checkbox
          :default-expand-all="true"
          :disabled="readonly"
          class="menu-tree"
          @check="onMenusCheck"
        />
      </section>

      <section class="grants-section">
        <h4 class="grants-title">功能权限</h4>
        <el-empty v-if="permissionGroups.length === 0" description="暂无权限点" :image-size="60" />
        <div v-for="g in permissionGroups" :key="g.domain" class="perm-group">
          <div class="perm-domain">{{ g.domain }}</div>
          <el-checkbox-group
            :model-value="checkedPermissionCodes"
            :disabled="readonly"
            @update:model-value="onPermissionsChange"
          >
            <el-checkbox
              v-for="p in g.items"
              :key="p.code"
              :value="p.code"
              :disabled="readonly || !p.is_active"
            >
              {{ p.name }}
              <span class="perm-code">{{ p.code }}</span>
            </el-checkbox>
          </el-checkbox-group>
        </div>
      </section>

      <!--
        保存按钮在 readonly 时**整个不渲染**（不是 disabled）：一个恒灰的按钮会让管理员
        反复点它然后困惑「为什么没反应」，而不渲染它表达的是「这里不可写」。
      -->
      <div v-if="!readonly" class="grants-footer">
        <el-button type="primary" :loading="saving" @click="emit('submit')">保存授权</el-button>
        <span class="grants-hint">整包替换：勾选结果覆盖该角色的全部菜单与功能权限。</span>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
// views/iam/roles/components/RoleGrantsPanel.vue
//
// 2026-10-14 新建：见文件头。组件零 store / api 依赖 —— 数据与勾选态全由父组件
// （RolesPage.vue）从 store 切片取出后以 props 传入，回调走 emit。这样本组件可以被
// 单独 mount 做行为单测（见 __tests__/RolesPage.spec.ts），不必拉起整个 store。

import type { MenuNodeData, PermissionGroup } from '../composables/rbacSchema';

defineProps<{
  /** 当前选中角色；null = 未选中。 */
  role: { id: string; code: string; name: string; is_system: boolean } | null;
  /** 只读（ADMIN 元角色）：树与勾选全部 disabled，且不渲染保存按钮。 */
  readonly: boolean;
  menuTree: MenuNodeData[];
  permissionGroups: PermissionGroup[];
  checkedMenuCodes: string[];
  checkedPermissionCodes: string[];
  loading: boolean;
  saving: boolean;
}>();

/** `update:menuCodes` / `update:permissionCodes` 合写成一条签名：两个 emit 的载荷
 *  都是 string[]，拆成两条只会让消费方多写一个重载分支。 */
const emit = defineEmits<{
  (
    e: 'update:menuCodes' | 'update:permissionCodes',
    codes: string[],
  ): void;
  (e: 'submit'): void;
}>();

/** el-tree 的勾选事件：第二个参数带半选态标志，这里**只要全选集合** ——
 *  授权是按菜单节点粒度存的（`menu_codes`），半选的父节点由后端按子节点推导，
 *  前端多传一个半选 code 会被整包替换成一条无意义的授权记录。 */
function onMenusCheck(
  _data: unknown,
  checkedInfo: { checkedKeys: Array<string | number> },
): void {
  emit('update:menuCodes', checkedInfo.checkedKeys.map(String));
}

function onPermissionsChange(codes: Array<string | number>): void {
  emit('update:permissionCodes', codes.map(String));
}
</script>

<style lang="scss" scoped>
.grants-panel {
  height: 100%;
  overflow-y: auto;
  padding: 0 4px;
}

.readonly-alert {
  margin-bottom: 12px;
}

.grants-section {
  margin-bottom: 18px;
}

.grants-title {
  margin: 0 0 8px;
  font-size: 14px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.menu-tree {
  max-height: 320px;
  overflow-y: auto;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 4px;
  padding: 8px;
}

.perm-group {
  margin-bottom: 12px;
}

.perm-domain {
  font-size: 13px;
  color: var(--el-text-color-secondary);
  margin-bottom: 4px;
}

.perm-code {
  margin-left: 6px;
  font-size: 12px;
  color: var(--el-text-color-placeholder);
  font-family: monospace;
}

.grants-footer {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 0;
  border-top: 1px solid var(--el-border-color-lighter);
}

.grants-hint {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
</style>