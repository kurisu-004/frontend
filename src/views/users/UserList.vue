<!--
  UserList.vue — 账号管理（薄壳）

  2026-10-10 重构：替代 2026-08-25 的 487 行 legacy 页面（裸调 api + 手写分页组件 +
  el-form 内联校验规则 + 列定义内联在 SFC + 状态散在 setup 顶层）。本页现在只拼装：
    - 顶部工具条（新增 / 刷新 / 自动刷新 / 共 N 个账号 / 重置筛选）；
    - `<UserTable>`（承载全部表格 DOM 逻辑：列可见性 / 列拖动 / 表头筛选）；
    - 分页（page / pageSize 在 store，切页改 queryKey 自动 refetch）；
    - 三个对话框（新增编辑 / 角色管理 / 企业微信绑定）；
    - 生命周期编排：`restoreState()`（末尾开 enabled 闸门）+ `store.$dispose()`。

  导航不在本页（store 也不 import vue-router，见该 store 顶部的 4 不变量）。
-->
<template>
  <div class="user-page">
    <el-card shadow="never" class="toolbar-card">
      <div class="toolbar-row">
        <el-button type="primary" @click="store.dialogs.form.openCreate()">新增账号</el-button>
        <el-button @click="onRefresh">
          <el-icon><Refresh /></el-icon>
          <span>刷新</span>
        </el-button>
        <el-checkbox v-model="store.ui.autoRefresh">自动刷新（5min）</el-checkbox>
        <el-button link @click="store.query.resetAllFilters()">重置筛选</el-button>
        <span v-if="store.query.total > 0" class="total-hint"
          >共 {{ store.query.total }} 个账号</span
        >
      </div>
    </el-card>

    <el-card shadow="never">
      <UserTable />
    </el-card>

    <div class="pagination">
      <el-pagination
        v-model:current-page="store.query.page"
        v-model:page-size="store.query.pageSize"
        :page-sizes="[20, 50, 100]"
        :total="store.query.total"
        layout="total, sizes, prev, pager, next, jumper"
        :pager-count="7"
        background
        size="small"
      />
    </div>

    <UserFormDialog />
    <RoleDialog />
    <WxBindDialog />
  </div>
</template>

<script setup lang="ts">
// views/users/UserList.vue
//
// 2026-10-10 重构壳：页面态 / 列定义 / 表头筛选 / 写操作全部下沉到
// `useUsersListStore`（Pinia setup store，4 不变量见该文件头）。本壳只做组件拼装 +
// 生命周期编排。

import { onBeforeUnmount, onMounted, watch } from 'vue';
import { Refresh } from '@element-plus/icons-vue';
import UserTable from './components/UserTable.vue';
import UserFormDialog from './components/UserFormDialog.vue';
import RoleDialog from './components/RoleDialog.vue';
import WxBindDialog from './components/WxBindDialog.vue';
import { useUsersListStore } from './composables/useUsersListStore';

// 不变量 #1：壳 setup 顶部首调 store（切片链路上的 onBeforeUnmount 绑到首个创建它的组件）。
const store = useUsersListStore();

async function onRefresh(): Promise<void> {
  await store.query.fetchList();
}

// 每页条数变化时页码复位（避免停在一个已不存在的页）。watch 源必须是 getter：
// store.query.pageSize 经 Pinia 解包后是 number，直接 watch 一个 number 追不到响应式。
watch(
  () => store.query.pageSize,
  (newSize, oldSize) => {
    if (oldSize !== undefined && newSize !== oldSize && store.query.page > 1) {
      store.query.page = 1;
    }
  },
);

onMounted(() => {
  // 恢复持久化筛选 / 每页条数，末尾开 enabled 闸门 → useQuery 自动首屏 fetch。
  store.query.restoreState();
});

onBeforeUnmount(() => {
  // 不变量 #2：Pinia 单例，离开页面销毁，下次进入重建 fresh 状态。
  store.$dispose();
});
</script>

<style lang="scss" scoped>
.user-page {
  padding: 0;
}
.toolbar-card {
  margin-bottom: 12px;
}
.toolbar-row {
  display: flex;
  align-items: center;
  gap: 16px;
}
.total-hint {
  color: var(--text-secondary);
  font-size: 13px;
}
.pagination {
  display: flex;
  justify-content: flex-end;
  margin-top: 12px;
}
</style>
