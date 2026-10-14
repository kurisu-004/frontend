<!--
  WeComDailySettings.vue — 企业微信「每日总结」配置 + 预览 + 发送历史（薄壳）

  2026-10-17 新建。结构照 `views/mail/digest/MailDigestSettings.vue` 逐字同款，本页是
  `/wecom` 下的一个 el-tab-pane（壳 `views/wecom/WeComCenter.vue`），不直接挂路由。

  本页只做**组件拼装 + 生命周期编排**，所有页面态在
  `composables/useWeComDailyStore.ts`（Pinia setup store，4 不变量见该文件头）：
    - 推送通道状态条（两条告警：一个可用通道都没有 / 有通道但本条配置没选）
    - 工具条：保存 / 预览 / 立即发送（**el-popconfirm 二次确认**，真发不可撤销）/ 刷新
    - 两个配置卡片（调度 + 内容）+ 预览弹窗 + 发送历史 + 分页

  ⚠️ **「立即发送」必须挂二次确认**：`POST /cron/wecom-daily/send` 是真发、不可撤销，也没有
  「撤回」端点；点错一次的代价是**整个群里多出一条日报**（或几条分片消息）。

  ⚠️ **顶部告警的判据用 store 的 `noWebhooks` / `webhookMissing`**（各自都是**三态**派生的
  `=== true`）而不是「取不到」：通道列表还在飞时它们是 false，此时**不**弹，否则首屏会先闪
  一条假告警再消失。
  ⚠️ **文案里不出现「不选也会用默认通道推」这类说法**：后端对 `webhook_id IS NULL`（或指向已
  软删的行）直接返 21801，**没有**回落到 `is_default` 的分支。

  组件一律 props + emits 通信（section 不首调 store），所以本壳是 store 的唯一消费方，也是
  `v-model` 的接线点：`store.query.form` 是 reactive 对象，子组件 emit 出的整份模型经
  `applyForm` 赋回即可（不能换引用，见该函数的注释）。
-->
<template>
  <div v-loading="store.query.configLoading" class="wecom-daily-page">
    <el-alert
      v-if="store.query.noWebhooks"
      class="wecom-alert"
      type="warning"
      show-icon
      :closable="false"
      title="还没有可用的推送通道，定时与手动发送都会失败"
      description="请先到「Webhook 配置」里新增一条通道，再回到本页选择它。"
    />
    <el-alert
      v-else-if="store.query.webhookMissing"
      class="wecom-alert"
      type="warning"
      show-icon
      :closable="false"
      title="尚未选择推送通道"
      description="不选则无法推送：请在下方「推送通道」里选一条。本页其余配置仍可正常保存。"
    />

    <el-alert
      v-if="store.query.configErrorText"
      class="wecom-alert"
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
          title="确认立即发送？消息会真的发到群里，且不可撤销。"
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
      <template #header><span class="section-title">调度与通道</span></template>
      <WeComScheduleSection
        :model-value="store.query.form"
        :frequency-options="store.query.frequencyOptions"
        :webhooks="store.query.webhooks"
        :errors="store.query.fieldErrors"
        :focus-field="store.query.focusField"
        @update:model-value="onFormChange"
      />
    </el-card>

    <el-card shadow="never" class="section-card">
      <template #header><span class="section-title">推送内容</span></template>
      <WeComContentSection
        :model-value="store.query.form"
        :worker-metric-options="store.query.workerMetricOptions"
        :ranges="store.query.ranges"
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
      <!-- ⚠️ `upcoming-days` 必须传：日志表的「N 日内」表头由它决定（写死「3日内」在管理员
           把它改成 7 天之后就是一句假话）。 -->
      <WeComLogTable
        :items="store.query.items"
        :loading="store.query.logsLoading"
        :upcoming-days="store.query.form.upcoming_days"
      />
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

    <WeComPreviewDialog
      v-model="store.dialogs.preview.visible"
      :result="store.dialogs.preview.result"
    />
  </div>
</template>

<script setup lang="ts">
// views/wecom/daily/WeComDailySettings.vue
//
// 2026-10-17 新建：见文件头。

import { onBeforeUnmount, onMounted, watch } from 'vue';
import { Refresh } from '@element-plus/icons-vue';
import WeComScheduleSection from './components/WeComScheduleSection.vue';
import WeComContentSection from './components/WeComContentSection.vue';
import WeComPreviewDialog from './components/WeComPreviewDialog.vue';
import WeComLogTable from './components/WeComLogTable.vue';
import { useWeComDailyStore } from './composables/useWeComDailyStore';
import type { WeComDailyFormModel } from './weComDailySchema';

// 不变量 #1：壳 setup 顶部首调 store（$dispose 绑到首个创建它的组件）。
const store = useWeComDailyStore();

function onFormChange(next: WeComDailyFormModel): void {
  // 走 store 的 applyForm（整体覆盖同一个 reactive 对象），**不要**写
  // `store.query.form = next` —— 那会换掉 store 内部闭包持有的对象引用，之后的 dirty /
  // 校验 / payload 组装全都作用在旧对象上（页面看着改了、发出去还是旧值）。
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

// 每页条数变化时页码复位（避免停在一个已不存在的页）。watch 源必须是 getter：store.query
// .logsPageSize 经 Pinia 解包后是 number，直接 watch 一个 number 追不到响应式。
watch(
  () => store.query.logsPageSize,
  (newSize, oldSize) => {
    if (oldSize !== undefined && newSize !== oldSize && store.query.logsPage > 1) {
      store.query.logsPage = 1;
    }
  },
);

onMounted(() => {
  // 开 enabled 闸门 → 四条 query 首屏 fetch（配置 / meta / 流水分页第一页 / 通道列表）。
  store.query.openGate();
});

onBeforeUnmount(() => {
  // 不变量 #2：Pinia 单例，离开 /wecom（两个 pane 一并卸载）时销毁，下次进入重建 fresh 状态
  //（否则未保存的表单改动 / 预览弹窗态 / 日志页码会泄漏到下次进入）。
  // ⚠️ 销毁时机的口径：本页挂在 `WeComCenter.vue` 的 `el-tab-pane` 里。element-plus 2.14.6
  // 的 `tab-pane` 在 `lazy` 下**只延迟首次挂载，已渲染过的 pane 用 `v-show` 常驻** ⇒
  // **切走 tab 不会**触发这里，`$dispose` 的真实触发点是**离开 /wecom 这一页**。
  store.$dispose();
});
</script>

<style lang="scss" scoped>
.wecom-daily-page {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.wecom-alert {
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
