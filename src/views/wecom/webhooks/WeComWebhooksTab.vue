<!--
  WeComWebhooksTab.vue — Webhook 通道列表（Webhook 配置 tab 的壳）

  2026-10-17 新建。职责只有**拼装 + 生命周期**：列表 + 工具条（新增 / 刷新）+ 新增/编辑弹窗
  + 软删二次确认 + 测连通。全部页面态在 `composables/useWeComWebhooksStore.ts`
  （Pinia setup store，4 不变量见该文件头）。

  ⚠️ **完整 webhook 地址在列表页恒不可见、且永不显示明文**（列表给的是 `url_masked`，完整地址
  后端**根本不返回**）。所以这一列的信息量有上限 —— 用户能确认「这条通道配过了」，不能确认
  「配的是哪一串」；真要换，只能进编辑弹窗重填（留空 = 不改）。

  消费 store **不写 .value**（Pinia 深代理自动解包），统一 `store.切片.字段`。
-->
<template>
  <div v-loading="store.query.loading" class="wecom-webhooks-tab">
    <el-alert
      v-if="store.query.listErrorText"
      class="list-alert"
      type="error"
      show-icon
      :closable="false"
      :title="store.query.listErrorText"
    />

    <el-card shadow="never" class="toolbar-card">
      <div class="toolbar-row">
        <el-button type="primary" @click="store.dialogs.openCreate()">新增 Webhook</el-button>
        <el-button @click="onRefresh">
          <el-icon><Refresh /></el-icon>
          <span>刷新</span>
        </el-button>
        <span class="toolbar-hint">
          地址只在新增时录入，保存后不再显示；改名请进编辑弹窗，留空地址表示不修改。
        </span>
      </div>
    </el-card>

    <!-- 「有通道但一个默认都没有」：后端**新建通道永远不设默认**，而「删掉默认通道」也**不会**
         自动转给别的（库里就变成零个默认）⇒ 这是正常使用下必然出现的一种状态，提示条解释的
         是「默认」这一列为什么全空。

         ⚠️ **文案只陈述 `is_default` 的真实语义，一个字的推送承诺都不许有**：后端对
         `is_default` 的全部消费只有列表排序（`ORDER BY is_default DESC`）与那条「至多一条为
         true」的唯一索引，推送路径只读 `wecom_daily_config.webhook_id`。写成「点「设为默认」
         …才能用它推送」会让用户照做、回到每日总结仍吃 21801（那页的 `webhookMissing` 还会把
         「立即发送」置灰）。守卫：`__tests__/WeComWebhooksTab.spec.ts` 的 H1。 -->
    <el-alert
      v-if="showNoDefaultHint"
      class="default-hint"
      type="warning"
      show-icon
      :closable="false"
      title="还没有设为默认的 Webhook"
      description="新建通道不会自动成为默认；「默认」只影响这里的列表排序，不影响推送。每日总结要用哪条通道，请在「每日总结」页的「推送通道」下拉里选。"
    />

    <el-card shadow="never">
      <el-empty
        v-if="!store.query.loading && store.query.webhooks.length === 0"
        description="还没有配置 Webhook 通道"
      >
        <el-button type="primary" @click="store.dialogs.openCreate()">新增 Webhook</el-button>
      </el-empty>
      <el-table v-else :data="store.query.webhooks" row-key="id" class="webhooks-table">
        <el-table-column prop="name" label="名称" min-width="140" show-overflow-tooltip />
        <!-- 恒显示后端下发的掩码。完整地址不出参（见文件头），没有任何可展示的完整值。 -->
        <el-table-column prop="url_masked" label="Webhook 地址" min-width="260" show-overflow-tooltip />
        <el-table-column label="默认" width="80">
          <template #default="{ row }">
            <el-tag v-if="row.is_default" type="primary" size="small">默认</el-tag>
            <span v-else class="cell-muted">—</span>
          </template>
        </el-table-column>
        <!-- ⚠️ 走 `formatNaiveDateTime` 而不是裸 `prop`：后端 `updated_at` 是 naive 字符串，
             裸渲染会把秒/小数原样怼进这一格，与同域日志表（本 tab 与「每日总结」tab 各一张表）
             的切片口径不一致（切 tab 时两处时间格式跳变）。切片函数的取舍见
             `views/wecom/utils/naiveDateTime.ts`。 -->
        <el-table-column label="更新时间" width="180">
          <template #default="{ row }">
            <span>{{ formatNaiveDateTime(row.updated_at) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="280" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="store.dialogs.openEdit(row as WeComWebhookData)">
              编辑
            </el-button>
            <el-button
              link
              type="primary"
              :loading="store.actions.testingRowId === row.id"
              @click="store.actions.test(row as WeComWebhookData)"
            >
              测连通
            </el-button>
            <el-button
              link
              type="primary"
              :disabled="row.is_default"
              :loading="store.actions.settingDefaultRowId === row.id"
              @click="store.actions.makeDefault(row as WeComWebhookData)"
            >
              设为默认
            </el-button>
            <el-popconfirm
              title="确认删除这条通道？被每日总结配置选中时会被拒绝。"
              width="320"
              confirm-button-text="确认删除"
              cancel-button-text="取消"
              @confirm="onDelete(row as WeComWebhookData)"
            >
              <template #reference>
                <el-button
                  link
                  type="danger"
                  :loading="store.actions.deletingRowId === row.id"
                >
                  删除
                </el-button>
              </template>
            </el-popconfirm>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <WeComWebhookDialog
      :model-value="store.dialogs.visible"
      :mode="store.dialogs.mode"
      :form="store.dialogs.form"
      :errors="store.dialogs.fieldErrors"
      :url-masked="store.dialogs.editingUrlMasked"
      :loading="store.actions.saving"
      @update:model-value="onDialogVisible"
      @patch="onFormPatch"
      @confirm="onConfirm"
      @cancel="store.dialogs.closeDialog()"
    />
  </div>
</template>

<script setup lang="ts">
// views/wecom/webhooks/WeComWebhooksTab.vue
//
// 2026-10-17 新建：见文件头。

import { computed, onBeforeUnmount, onMounted } from 'vue';
import { Refresh } from '@element-plus/icons-vue';
import WeComWebhookDialog from './WeComWebhookDialog.vue';
import { useWeComWebhooksStore } from './composables/useWeComWebhooksStore';
import type { WeComWebhookData, WeComWebhookFormModel } from './weComWebhookSchema';
import { formatNaiveDateTime } from '../utils/naiveDateTime';

// 不变量 #1：壳 setup 顶部首调 store（$dispose 绑到首个创建它的组件）。
const store = useWeComWebhooksStore();

/** 「有通道但一个默认都没有」的提示条。⚠️ 判据的「已加载」由 `webhooks.length > 0` 顺带承担
 *  （列表还在飞时它必然是 0）：不必再叠一个 `!loading`，那会在后台 refetch 期间把已经成立的
 *  提示条藏掉一瞬。 */
const showNoDefaultHint = computed(
  () => store.query.webhooks.length > 0 && !store.query.hasDefault,
);

function onDelete(row: WeComWebhookData): void {
  // 传整行：软删端点的 body 必填 `version`（OCC 锚），store 从行上取。
  void store.actions.remove(row);
}

/** 弹窗的整体显隐（× / Esc / 点遮罩都走这里）。**刻意不另发业务事件** —— 这个弹窗的唯一出口
 * 是「保存」，其余关闭动作一律收在 `closeDialog()` 一处（照 CLAUDE.md「弹窗关闭权」；本弹窗还
 * 留着 × 是安全的：关闭不丢任何已提交的数据，唯一的输入态在 store 里，关掉再打开会被
 * `openCreate` / `openEdit` 重置）。 */
function onDialogVisible(next: boolean): void {
  if (!next) store.dialogs.closeDialog();
}

/** 弹窗里某个字段变了 → 写回 store 的同一个 reactive 表单对象（整体 Object.assign，不能换
 *  引用：store 的 `validateForm` 闭包持有的是那一个）。`next` 标成可选是因为子组件的联合签名
 * 把「无 payload 的事件」也并进来了，Vue 生成的模板监听器类型因而带 `?`；运行时 `patch` 事件
 * 必然带 payload。 */
function onFormPatch(next?: Partial<WeComWebhookFormModel>): void {
  if (!next) return;
  Object.assign(store.dialogs.form, next);
}

function onConfirm(): void {
  void store.actions.submit();
}

function onRefresh(): void {
  void store.query.refresh();
}

onMounted(() => {
  // 开 enabled 闸门 → 唯一那条 query 首屏 fetch（通道列表）。
  store.query.openGate();
});

onBeforeUnmount(() => {
  // 不变量 #2：Pinia 单例，离开 /wecom（两个 pane 一并卸载）时销毁，下次进入重建 fresh 状态
  // （否则填了一半的弹窗态会泄漏到下次进入）。
  store.$dispose();
});
</script>

<style lang="scss" scoped>
.wecom-webhooks-tab {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.toolbar-card {
  margin-bottom: 0;
}

.toolbar-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.toolbar-hint {
  font-size: 12px;
  color: var(--text-secondary);
}

.cell-muted {
  color: var(--text-secondary);
}

.default-hint,
.list-alert {
  margin-bottom: 0;
}
</style>
