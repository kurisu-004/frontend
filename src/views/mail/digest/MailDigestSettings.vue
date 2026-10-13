<!--
  MailDigestSettings.vue — 交期汇总邮件定时任务管理页（薄壳）

  2026-10-13 新建。**2026-10-16 起本页是 `/mail` 下的一个 el-tab-pane**
  （壳 `views/mail/MailCenter.vue`），不再直接挂路由。

  本页只做**组件拼装 + 生命周期编排**，所有页面态在
  `composables/useMailDigestStore.ts`（Pinia setup store，4 不变量见该文件头）：
    - 发信邮箱状态条（**2026-10-16 改**：SMTP 不再是部署级环境变量，判据变成「一个可用
      邮箱都没有 / 有邮箱但本条配置没选」；文案里**不再出现任何环境变量名**）
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
    <!-- 2026-10-16：原来的「SMTP 未配置」告警改成两条「发信邮箱」告警。
         ⚠️ 判据用 store 的 `noAccounts` / `senderMissing`（各自都是**三态**派生的
         `=== true`）而不是「取不到」：邮箱列表还在飞时它们是 false，此时**不**弹，
         否则首屏会先闪一条假告警再消失（与原 `smtpMissing` 同一坑、同一处处置）。
         ⚠️ **标题刻意不提环境变量名**（原先写的是 MAIL_SMTP_USERNAME 等）：SMTP 已改成
         页面内可维护的邮箱账号，运维不需要、也不应该去改服务端 env；这些名字留在文案里
         只会让用户去改一个已经不起作用的地方。业务码同理不进 UI 文案 —— 真失败时弹的
         那句人话由 `mailDigestErrorText.ts` 按码查表给出。 -->
    <el-alert
      v-if="store.query.noAccounts"
      class="sender-alert"
      type="warning"
      show-icon
      :closable="false"
      title="还没有可用邮箱，定时与手动发送都会失败"
      description="请先到「邮箱设置」里新增一条邮箱账号（填写服务商授权码），再回到本页选择发信邮箱。"
    />
    <!-- ⚠️ 文案里**不出现**「不选也会用默认邮箱发」这类说法：后端
         `mail_digest::service::resolve_sender` 对 `sender_account_id IS NULL` 直接返
         21701（503），**没有**回落到默认邮箱的分支。理由写在代码注释里，不写给用户看
         —— 用户要的是「选一条」，不是一段与后端争辩的说明。 -->
    <el-alert
      v-else-if="store.query.senderMissing"
      class="sender-alert"
      type="warning"
      show-icon
      :closable="false"
      title="尚未选择发信邮箱"
      description="不选则无法发送：请在下方「发信邮箱」里选一条。本页其余配置仍可正常保存。"
    />

    <el-alert
      v-if="store.query.configErrorText"
      class="sender-alert"
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
        :sender-accounts="store.query.senderAccounts"
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
  // 开 enabled 闸门 → 四条 query 首屏 fetch（配置 / meta / 日志第一页 / 邮箱列表，
  // 邮箱列表是 2026-10-16 为「发信邮箱」下拉加的）。
  store.query.openGate();
});

onBeforeUnmount(() => {
  // 不变量 #2：Pinia 单例，离开页面销毁，下次进入重建 fresh 状态
  // （否则未保存的表单改动 / 预览弹窗态 / 日志页码会泄漏到下次进入）。
  // ⚠️ 2026-10-16：销毁时机的口径 —— 本页现在挂在 `MailCenter.vue` 的 `el-tab-pane`
  // 里。element-plus 2.14.6 的 `tab-pane` 在 `lazy` 下**只延迟首次挂载，已渲染过的
  // pane 用 `v-show` 常驻**（`tab-pane.vue`：`shouldBeRender = !lazy || loaded ||
  // active`，渲染分支带 `vShow`）⇒ **切走 tab 不会**触发这里，`$dispose` 的真实触发点
  // 是**离开 /mail 这一页**（本壳卸载，两个 pane 一并卸载）。「不跨 tab 保留未保存改动」
  // 不是本页的契约，是「离开 /mail 就丢」——本次没有改变它。
  store.$dispose();
});
</script>

<style lang="scss" scoped>
.mail-digest-page {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.sender-alert {
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
