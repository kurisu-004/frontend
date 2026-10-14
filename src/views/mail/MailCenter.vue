<!--
  MailCenter.vue — 定时任务 → 邮件的**页内 tab 壳**（路由 /mail，menuCode: 'mail'）

  2026-10-16 新建。原来 `/mail/digest` 直接渲染 `MailDigestSettings.vue`（邮件类型占
  菜单层级），现在邮件类型改用页内 tab 区分：侧栏是「定时任务 → 邮件」，进页后用 tab
  切具体的邮件能力 —— 当前两个：**邮箱设置**（新）与**交期汇总**（原有整页搬进来）。

  本壳**零业务逻辑、零数据**：只持有 `activeTab` 这一个 ref，其余全交给两个子 tab 各自
  的 store（`useMailAccountsStore` / `useMailDigestStore`）。它们是两个独立的 Pinia
  实例，只共享 `qk.mailAccounts()` 那一条 query 缓存（切 tab 不重新打邮箱列表）。

  ⚠️ **两个 pane 都必须挂 `lazy`**，理由与 `views/statistics/ProductionStats.vue` 同款：
  `el-tab-pane` 不带 `lazy` 时**首屏全部 pane 都挂载** ⇒ 进页面立刻并发打
  `/cron/mail/accounts` 与 `/cron/mail-digest/config|meta|logs`（五六个请求），而用户第一眼看的
  只有当前那一个 tab。`lazy` 之后每个 pane 首次被激活才挂载、取数时机随之对齐。
  ⚠️ 这个判断已对着本仓安装的 element-plus 2.14.6 源码核过：`tab-pane.vue` 里
  `shouldBeRender = !lazy || loaded || active`，**已渲染过的 pane 用 `v-show` 常驻、不
  卸载** ⇒ 切走 tab **不会**触发子组件的 `onBeforeUnmount`、也就不会触发
  `$dispose()`，未保存的表单改动跨 tab 切换是保住的。`$dispose` 的真实触发点是**离开
  /mail 这一页**（本壳卸载，两个 pane 一并卸载）。页内不缓存到 localStorage 是既有契约
  （见 `MailDigestSettings.vue` 的不变量 #2），本页不改变它。

  ⚠️ 路由 path 与老书签：2026-10-13 上线时入口是 `/mail/digest`，老书签由
  `src/router/index.ts` 里一条 `path: 'mail/digest'` + `redirect: '/mail'` 的路由保住。
-->
<template>
  <div class="mail-center">
    <el-tabs v-model="activeTab" type="border-card" class="mail-tabs">
      <!-- 2026-10-16：两个 pane 都带 lazy（理由见文件头）。顺序即侧栏顺序：先配置
           （建好邮箱才有得选），再看交期汇总。 -->
      <el-tab-pane label="邮箱设置" name="accounts" lazy>
        <MailAccountsTab />
      </el-tab-pane>
      <el-tab-pane label="交期汇总" name="digest" lazy>
        <MailDigestSettings />
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<script setup lang="ts">
// views/mail/MailCenter.vue
//
// 2026-10-16 新建：见文件头。

import { ref } from 'vue';
import MailAccountsTab from './accounts/MailAccountsTab.vue';
import MailDigestSettings from './digest/MailDigestSettings.vue';

/** 当前 tab。**刻意不持久化到 localStorage**：本页无「记住上次看哪个 tab」的需求，
 *  而持久化会把「进来时该看什么」这件事变成一个没人维护的状态。 */
const activeTab = ref('accounts');
</script>

<style lang="scss" scoped>
.mail-center {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.mail-tabs {
  background: #fff;
  border-radius: 4px;
}

/* border-card 形态下 el-tabs__content 自带一圈 padding，页内两个 tab 的内容全是卡片，
   再叠一层会出现「卡片外面还有一段空白」的视觉断层。压成 12px 让卡片与 tab 头齐平。 */
.mail-tabs :deep(.el-tabs__content) {
  padding: 12px;
}
</style>
