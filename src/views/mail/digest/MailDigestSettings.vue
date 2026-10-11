<!--
  MailDigestSettings.vue — 交期汇总邮件定时任务管理页（薄壳）

  2026-10-13 新建。路由 `/mail/digest`（`menuCode: 'mail_digest'`，与后端
  `seeds/menu.sql` 的菜单 code 逐字一致 —— 不一致会被路由守卫第 3 条踢回首一个有 path
  的节点）。

  本页只做**组件拼装 + 生命周期编排**，所有页面态在
  `composables/useMailDigestStore.ts`（Pinia setup store，4 不变量见该文件头）：
    - SMTP 状态条（`GET /meta` 的 `smtp` 段；未配置时顶部一条 warning，并禁用「立即发送」）
    - 工具条：保存 / 预览 / 立即发送（**el-popconfirm 二次确认**，真发不可撤销）/ 刷新
    - 四个配置卡片（调度 / 收件人 / 内容）+ 预览弹窗 + 发送历史 + 分页

  ⚠️ **「立即发送」必须挂二次确认**：`POST /mail-digest/send` 是真发、不可撤销，也没有
  「撤回」端点；点错一次的代价是收件人真收到一封内容不全的汇总邮件。

  组件一律 props + emits 通信（section 不首调 store），所以本壳是 store 的唯一消费方，
  也是 `v-model` 的接线点：`store.query.form` 是 reactive 对象，子组件 emit 出的整份
  模型直接赋回即可（Pinia 深代理下是响应式赋值）。
-->
<template>
  <div v-loading="store.query.configLoading" class="mail-digest-page">
    <!-- SMTP 未配置：定时与手动发送都会失败，提前说清楚 + 禁用「立即发送」。
         ⚠️ 2026-10-14：**标题刻意不提错误码**（原先写的是「都会返回 21501」）。业务码
         是前后端契约的实现细节，对运维/管理员没有可操作性 —— description 里已经写清了
         该设哪几个环境变量；而码值一旦进 UI 文案，它就是第二个会漂移的来源（本轮就因
         后端把 215xx 段换成 217xx 而变成错码）。真失败时弹的那句人话由
         `mailDigestErrorText.ts` 按码查表给出，管理员需要码值时看控制台/后端日志即可。
         ⚠️ 判据是 store 的 `smtpMissing`（= `smtp.configured === false`）而不是
         「取不到」：meta 还没回来时它是 false，此时**不**弹这条，否则首屏会先闪一条
         假告警再消失。 -->
    <el-alert
      v-if="store.query.smtpMissing"
      class="smtp-alert"
      type="warning"
      show-icon
      :closable="false"
      title="SMTP 未配置，定时与手动发送都会失败"
      description="需在服务端设置 MAIL_SMTP_USERNAME / MAIL_SMTP_PASSWORD / MAIL_FROM_ADDRESS（以及 MAIL_SMTP_HOST / MAIL_SMTP_PORT）后重启；本域其余配置仍可正常保存。"
    />

    <el-alert
      v-if="store.query.configErrorText"
      class="smtp-alert"
      type="error"
      show-icon
      :closable="false"
      :title="store.query.configErrorText"
    />

    <el-card shadow="never" class="toolbar-card">
      <div class="toolbar-row">
        <el-button type="primary" :loading="store.actions.saving" @click="onSave">保存</el-button>
        <el-button :loading="store.actions.previewing" @click="onPreview">预览</el-button>
        <el-popconfirm
          title="确认立即发送？邮件会真的发给收件人，且不可撤销。"
          width="320"
          confirm-button-text="确认发送"
          cancel-button-text="取消"
          @confirm="onSend"
        >
          <template #reference>
            <el-button
              type="danger"
              :loading="store.actions.sending"
              :disabled="store.actions.sendDisabled"
            >
              立即发送
            </el-button>
          </template>
        </el-popconfirm>
        <el-button @click="onRefresh">
          <el-icon><Refresh /></el-icon>
          <span>刷新</span>
        </el-button>
        <span v-if="store.query.dirty" class="dirty-hint">有未保存的修改</span>
      </div>
    </el-card>

    <el-card shadow="never" class="section-card">
      <template #header><span class="section-title">定时设置</span></template>
      <MailScheduleSection
        :model-value="store.query.form"
        :frequency-options="store.query.frequencyOptions"
        :errors="store.query.fieldErrors"
        :focus-field="store.query.focusField"
        @update:model-value="onFormChange"
      />
    </el-card>

    <el-card shadow="never" class="section-card">
      <template #header><span class="section-title">收件人</span></template>
      <MailRecipientsSection
        :model-value="store.query.form"
        :errors="store.query.fieldErrors"
        :focus-field="store.query.focusField"
        @update:model-value="onFormChange"
      />
    </el-card>

    <el-card shadow="never" class="section-card">
      <template #header><span class="section-title">发送内容</span></template>
      <MailContentSection
        :model-value="store.query.form"
        :columns="store.query.columnOptions"
        :upcoming-days-range="store.query.upcomingDaysRange"
        :errors="store.query.fieldErrors"
        :focus-field="store.query.focusField"
        @update:model-value="onFormChange"
      />
    </el-card>

    <el-card shadow="never" class="section-card">
      <template #header>
        <div class="log-header">
          <span class="section-title">发送历史</span>
          <span class="section-sub">共 {{ store.query.logsTotal }} 条</span>
        </div>
      </template>
      <MailLogTable :items="store.query.items" :loading="store.query.logsLoading" />
      <div class="pagination">
        <el-pagination
          v-model:current-page="store.query.logsPage"
          v-model:page-size="store.query.logsPageSize"
          :page-sizes="[20, 50, 100]"
          :total="store.query.logsTotal"
          layout="total, sizes, prev, pager, next, jumper"
          :pager-count="7"
          background
          size="small"
        />
      </div>
    </el-card>

    <MailPreviewDialog
      v-model="store.dialogs.preview.visible"
      :result="store.dialogs.preview.result"
      :loading="store.dialogs.preview.loading"
    />
  </div>
</template>

<script setup lang="ts">
// views/mail/digest/MailDigestSettings.vue
//
// 2026-10-13 新建：见文件头。

import { onBeforeUnmount, onMounted, watch } from 'vue';
import { Refresh } from '@element-plus/icons-vue';
import MailScheduleSection from './components/MailScheduleSection.vue';
import MailRecipientsSection from './components/MailRecipientsSection.vue';
import MailContentSection from './components/MailContentSection.vue';
import MailPreviewDialog from './components/MailPreviewDialog.vue';
import MailLogTable from './components/MailLogTable.vue';
import { useMailDigestStore } from './composables/useMailDigestStore';
import type { MailDigestFormModel } from './mailDigestSchema';

// 不变量 #1：壳 setup 顶部首调 store（$dispose 绑到首个创建它的组件）。
const store = useMailDigestStore();

function onFormChange(next: MailDigestFormModel): void {
  // 走 store 的 applyForm（整体覆盖同一个 reactive 对象），**不要**写
  // `store.query.form = next` —— 那会换掉 store 内部闭包持有的对象引用，之后的
  // dirty / 校验 / payload 组装全都作用在旧对象上（页面看着改了、发出去还是旧值）。
  store.query.applyForm(next);
}

function onSave(): void {
  void store.actions.save();
}

function onPreview(): void {
  void store.actions.preview();
}

function onSend(): void {
  void store.actions.sendNow();
}

function onRefresh(): void {
  void store.query.refreshAll();
}

// 每页条数变化时页码复位（避免停在一个已不存在的页）。watch 源必须是 getter：
// store.query.logsPageSize 经 Pinia 解包后是 number，直接 watch 一个 number 追不到
// 响应式（照 UserList.vue 的同款处置）。
watch(
  () => store.query.logsPageSize,
  (newSize, oldSize) => {
    if (oldSize !== undefined && newSize !== oldSize && store.query.logsPage > 1) {
      store.query.logsPage = 1;
    }
  },
);

onMounted(() => {
  // 开 enabled 闸门 → 三条 query 首屏 fetch（配置 / meta / 日志第一页）。
  store.query.openGate();
});

onBeforeUnmount(() => {
  // 不变量 #2：Pinia 单例，离开页面销毁，下次进入重建 fresh 状态
  // （否则未保存的表单改动 / 预览弹窗态 / 日志页码会泄漏到下次进入）。
  store.$dispose();
});
</script>

<style lang="scss" scoped>
.mail-digest-page {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.smtp-alert {
  margin-bottom: 0;
}

.toolbar-card {
  margin-bottom: 0;
}

.toolbar-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.dirty-hint {
  font-size: 13px;
  color: var(--el-color-warning);
}

.section-title {
  font-size: 15px;
  font-weight: 600;
}

.section-sub {
  font-size: 12px;
  color: var(--text-secondary);
}

.log-header {
  display: flex;
  align-items: baseline;
  gap: 12px;
}

.pagination {
  display: flex;
  justify-content: flex-end;
  margin-top: 12px;
}
</style>
