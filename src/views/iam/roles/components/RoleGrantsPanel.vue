<!--
  RoleGrantsPanel.vue — 角色授权编辑区（RBAC 面板右栏）

  2026-10-14 新建。组件 0 业务状态（勾选集合 / 提交都在 store），只负责渲染与事件上报：

    - 上半：系统菜单树勾选（el-tree，`node-key="code"`、`check-strictly`）；
    - 下半：权限点按 domain 分组勾选（el-checkbox-group）；
    - 底部：保存按钮（**readonly 时整块不渲染**，见下）。

  ⚠️ **el-tree 用 `check-strictly`（父子不联动）**：后端 grants 是**扁平集合语义**
  （`menu_codes` 就是一个 code 数组），级联模式无法忠实表达「父组授权但部分子项未授权」
  —— 级联勾选父节点会把整棵子树一起写进集合，保存即越权。独立勾选下
  `getCheckedKeys()` 返回的就是精确集合，与整包替换的载荷一一对应。

  ⚠️ **勾选态回填由本组件负责**（`watch` → `setCheckedKeys`）：只把 grants 里的 code
  渲染成计数而不驱动树，会出现「角色已授 5 个菜单、树显示 0 勾」，管理员勾一个新的
  保存就把原有授权全部清空（整包替换）。回填时与树里实际存在的 code 求交集 —— 树是
  渲染源，树里没有的 code 勾不出来，保留在提交里没有意义。

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
          ref="treeRef"
          :key="role?.id"
          :data="menuTree"
          :props="treeProps"
          node-key="code"
          show-checkbox
          check-strictly
          :default-expand-all="true"
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

        grants 未就绪（ready=false，正在加载 / 刚切角色）时 disabled：此时树还没回填，
        提交出去的就是一份空勾选 —— 整包替换语义下等于清空该角色的全部授权。
      -->
      <div v-if="!readonly" class="grants-footer">
        <el-button type="primary" :loading="saving" :disabled="!ready" @click="onSave">
          保存授权
        </el-button>
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

import { computed, onMounted, ref, watch } from 'vue';
import type { MenuNodeData } from '@/views/auth/sessionSchema';
import type { PermissionGroup } from '../composables/rbacSchema';

const props = defineProps<{
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
  /** 授权包是否已就绪（`GET .../grants` 已返回）。false 时保存按钮 disabled。 */
  ready: boolean;
}>();

/** `update:menuCodes` / `update:permissionCodes` 合写成一条签名：两个 emit 的载荷
 *  都是 string[]，拆成两条只会让消费方多写一个重载分支。 */
const emit = defineEmits<{
  (e: 'update:menuCodes' | 'update:permissionCodes', codes: string[]): void;
  (e: 'submit'): void;
}>();

/** el-tree 实例：只依赖本组件用到的两个方法。刻意不 import ElTree 组件本体 ——
 *  那会把整个组件拉进本模块的依赖图，而模板里 el-tree 走全局注册。 */
interface MenuTreeHandle {
  setCheckedKeys: (keys: string[]) => void;
  getCheckedKeys: () => Array<string | number>;
}
const treeRef = ref<MenuTreeHandle | null>(null);

/** 树节点解析配置。el-tree 没有组件级 `disabled` prop（勾选禁用走 `props.disabled`），
 *  readonly（ADMIN 元角色）时用「恒 true」的节点判定函数把整树勾选禁用 —— 面板展示的
 *  是后端固定授权，不给改。⚠️ el-tree 不 watch 这个对象的替换，故模板上用 `:key="role.id"`
 *  让树随角色重建，readonly 的切换才真正生效。 */
const treeProps = computed(() => ({
  label: 'title',
  children: 'children',
  disabled: props.readonly ? () => true : 'disabled',
}));

/** 树里全部节点的 code（含分组节点）—— 回填/裁决都以「树里存在的节点」为准。 */
const treeCodes = computed<Set<string>>(() => {
  const out = new Set<string>();
  const walk = (nodes: MenuNodeData[]): void => {
    for (const n of nodes) {
      out.add(n.code);
      if (n.children.length > 0) walk(n.children);
    }
  };
  walk(props.menuTree);
  return out;
});

/** 把已授权集合写回树的勾选态。
 *
 *  - 与树内 code 求交集：树是唯一可勾选面，授权里若有树里不存在的 code（已下线菜单），
 *    勾不出来也回填不进去 —— 提交时它以「未勾选」形态被整包替换掉，与面板呈现一致；
 *  - el-tree 在 `v-if="role"` 内，调用点必须在树挂载之后。 */
function applyCheckedKeys(): void {
  if (!props.role) return;
  const keys = props.checkedMenuCodes.filter((c) => treeCodes.value.has(c));
  treeRef.value?.setCheckedKeys?.(keys);
}

/** 回填触发点（三个源独立到达，任一到齐都要重放一次）：
 *  - `role.id`：切角色；
 *  - `checkedMenuCodes`：授权包到位 / 用户勾选后 store 回写；
 *  - `treeCodes`：菜单树全集比授权包晚到时，先前被交集滤掉的 code 要重新回填。
 *
 *  `flush: 'post'`：树在 `v-if="role"` 内，首次选中角色时 pre flush 阶段树还没挂载
 *  （treeRef 为 null），post flush 等 DOM 更新完再写。 */
watch([() => props.role?.id ?? '', () => props.checkedMenuCodes, treeCodes], applyCheckedKeys, {
  flush: 'post',
});

/** 组件挂载时角色与授权包可能都已就绪（isolated 挂载 / 暖缓存），watch 不会再触发，
 *  故补一次。 */
onMounted(applyCheckedKeys);

/** el-tree 的勾选事件：第二个参数带半选态标志，check-strictly 下 `checkedKeys` 就是
 *  精确集合（无级联），直接上报。 */
function onMenusCheck(_data: unknown, checkedInfo: { checkedKeys: Array<string | number> }): void {
  emit('update:menuCodes', checkedInfo.checkedKeys.map(String));
}

function onPermissionsChange(codes: Array<string | number>): void {
  emit('update:permissionCodes', codes.map(String));
}

/** 保存：读 `getCheckedKeys()` 而不是 props —— 提交的永远是树当下的勾选态，
 *  check-strictly 下它就是精确集合。 */
function onSave(): void {
  const keys = treeRef.value?.getCheckedKeys?.() ?? props.checkedMenuCodes;
  emit('update:menuCodes', keys.map(String));
  emit('submit');
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
