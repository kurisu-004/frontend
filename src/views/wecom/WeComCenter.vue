<!--
  WeComCenter.vue — 定时任务 → 企业微信的**页内 tab 壳**（路由 /wecom，menuCode: 'wecom'）

  2026-10-17 新建。结构照 `src/views/mail/MailCenter.vue` 逐字同款：邮件域先有「邮箱设置」
  与「交期汇总」两个 tab，企业微信域先有「Webhook 配置」与「每日总结」两个 —— 推送类型的
  差异由**页内 tab** 承担，不占菜单层级（侧栏只多一个「企业微信」项）。

  本壳**零业务逻辑、零数据**：只持有 `activeTab` 这一个 ref，其余全交给两个子 tab 各自的
  store（`useWeComWebhooksStore` / `useWeComDailyStore`）。它们是两个独立的 Pinia 实例，只
  共享 `qk.wecomWebhooks()` 那一条 query 缓存（切 tab 不重新打通道列表）。

  ⚠️ **两个 pane 都必须挂 `lazy`**，理由与 `MailCenter.vue` / `views/statistics/ProductionStats.vue`
  同款：`el-tab-pane` 不带 `lazy` 时**首屏全部 pane 都挂载** ⇒ 进页面立刻并发打
  `/cron/wecom/webhooks` 与 `/cron/wecom-daily/config|meta|logs`（四五个请求），而用户第一眼
  看的只有当前那一个 tab。`lazy` 之后每个 pane 首次被激活才挂载、取数时机随之对齐。
  ⚠️ 这个判断已对着本仓安装的 element-plus 2.14.6 源码核过：`tab-pane.vue` 里
  `shouldBeRender = !lazy || loaded || active`，**已渲染过的 pane 用 `v-show` 常驻、不卸载**
  ⇒ 切走 tab **不会**触发子组件的 `onBeforeUnmount`、也就不会触发 `$dispose()`，未保存的表单
  改动跨 tab 切换是保住的。`$dispose` 的真实触发点是**离开 /wecom 这一页**（本壳卸载，两个
  pane 一并卸载）。
  守卫：`__tests__/WeComCenter.spec.ts` 的**源码契约**用例（渲染后的 DOM 里查不出 `lazy`
  —— 它的效果就是「不渲染」）。

  ⚠️ **`/wecom` 是书签 URL，与后端 `/api/v2/cron/wecom/*` 的 API 前缀无关**：两层不要求一致
  （见 `src/router/index.ts` 的同名路由注释）。将来改 API 前缀时不要连带改这里。

  ⚠️ `activeTab` **刻意不持久化**到 localStorage（照 `MailCenter.vue` 的同一取舍）：本页无
  「记住上次看哪个 tab」的需求，而持久化会把「进来时该看什么」变成一个没人维护的状态。
-->
<template>
  <div class="wecom-center">
    <el-tabs v-model="activeTab" type="border-card" class="wecom-tabs">
      <!-- 顺序即侧栏顺序：先配置通道（建好 webhook 才有得选），再看每日总结。 -->
      <el-tab-pane label="Webhook 配置" name="webhooks" lazy>
        <WeComWebhooksTab />
      </el-tab-pane>
      <el-tab-pane label="每日总结" name="daily" lazy>
        <WeComDailySettings />
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<script setup lang="ts">
// views/wecom/WeComCenter.vue
//
// 2026-10-17 新建：见文件头。

import { ref } from 'vue';
import WeComWebhooksTab from './webhooks/WeComWebhooksTab.vue';
import WeComDailySettings from './daily/WeComDailySettings.vue';

/** 当前 tab。**刻意不持久化到 localStorage**：见文件头。 */
const activeTab = ref('webhooks');
</script>

<style lang="scss" scoped>
.wecom-center {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.wecom-tabs {
  background: #fff;
  border-radius: 4px;
}

/* border-card 形态下 el-tabs__content 自带一圈 padding，页内两个 tab 的内容全是卡片，
   再叠一层会出现「卡片外面还有一段空白」的视觉断层。压成 12px 让卡片与 tab 头齐平。 */
.wecom-tabs :deep(.el-tabs__content) {
  padding: 12px;
}
</style>
