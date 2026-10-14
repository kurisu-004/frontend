<!--
  MailAccountsTab.vue — 邮箱账号列表（邮箱设置 tab 的壳）

  2026-10-16 新建。职责只有**拼装 + 生命周期**：列表 + 工具条（新增 / 刷新）+ 新增/编辑
  弹窗 + 删除二次确认。全部页面态在 `composables/useMailAccountsStore.ts`
  （Pinia setup store，4 不变量见该文件头）。

  ⚠️ **授权码在列表页恒显示「已配置」，永不显示明文、掩码或任何派生值**（连长度都不
  给）。这不是「暂时没做掩码」，而是后端出参**根本不返回**该值：密文入库、`AccountOut`
  里没有 `encrypted_secret`（`mailAccountSchema` 的 `.strict()` 会在后端哪天误带出来时
  当场抛）。所以这一列的信息量有上限 —— 用户能确认「这条配过了」，不能确认「配的是哪
  一串」；真要换，只能进编辑弹窗重填（留空 = 不改）。

  消费 store **不写 .value**（Pinia 深代理自动解包），统一 `store.切片.字段`。
-->
<template>
  <div v-loading="store.query.loading" class="mail-accounts-tab">
    <el-card shadow="never" class="toolbar-card">
      <div class="toolbar-row">
        <el-button type="primary" @click="store.dialogs.openCreate()">新增邮箱</el-button>
        <el-button @click="onRefresh">
          <el-icon><Refresh /></el-icon>
          <span>刷新</span>
        </el-button>
      </div>
    </el-card>

    <!-- 「有邮箱但一个默认都没有」：后端**新建邮箱永远不设默认**，而「删掉默认邮箱」也**不会**
         自动转给别的（库里就变成零个默认）⇒ 这是正常使用下必然出现的一种状态，提示条解释的
         是「默认」这一列为什么全空。

         ⚠️ **文案只陈述 `is_default` 的真实语义，一个字的发信承诺都不许有**：后端对
         `is_default` 的全部消费只有列表排序（`ORDER BY is_default DESC`）与那条「至多一条为
         true」的唯一索引，发信路径只读 `mail_digest_config.sender_account_id`
         （`mail_digest::service::resolve_sender`）。写成「点「设为默认」…才能用它发信」会让
         用户照做、回到交期汇总仍吃 21701（那页的 `senderMissing` 还会把「立即发送」置灰）。
         守卫：`__tests__/MailAccountsTab.spec.ts` 的 H1。 -->
    <el-alert
      v-if="showNoDefaultHint"
      class="default-hint"
      type="warning"
      show-icon
      :closable="false"
      title="还没有设为默认的邮箱"
      description="新建邮箱不会自动成为默认；「默认」只影响这里的列表排序，不影响发信。交期汇总要用哪条邮箱，请在「交期汇总」页的「发信邮箱」下拉里选。"
    />

    <el-card shadow="never">
      <el-empty
        v-if="!store.query.loading && store.query.accounts.length === 0"
        description="还没有配置邮箱账号"
      />
      <el-table v-else :data="store.query.accounts" row-key="id" class="accounts-table">
        <el-table-column prop="name" label="名称" min-width="140" show-overflow-tooltip />
        <el-table-column label="预设" min-width="110">
          <!-- 标签**直接取行上的 `preset_label`**（后端下发），不查 `/cron/mail/meta`：
               meta 还在飞或失败时这一列会整列显示 `NET_EASE_163` 原文。降级到字面量的
               唯一情形是后端对未知 preset 的既定降级（那时 `preset_label` 是空串）。 -->
          <template #default="{ row }">{{ row.preset_label || row.preset }}</template>
        </el-table-column>
        <el-table-column prop="account" label="登录账号" min-width="200" show-overflow-tooltip />
        <!-- 恒显示「已配置」：授权码不出参（见文件头），没有任何可展示的值。 -->
        <el-table-column label="授权码" width="100">
          <template #default>
            <el-tag type="success" size="small">已配置</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="默认" width="80">
          <template #default="{ row }">
            <el-tag v-if="row.is_default" type="primary" size="small">默认</el-tag>
            <span v-else class="cell-muted">—</span>
          </template>
        </el-table-column>
        <el-table-column prop="updated_at" label="更新时间" width="180" />
        <el-table-column label="操作" width="220" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="store.dialogs.openEdit(row as MailAccountData)">
              编辑
            </el-button>
            <el-button
              link
              type="primary"
              :disabled="row.is_default"
              :loading="store.actions.settingDefaultRowId === row.id"
              @click="store.actions.makeDefault(row as MailAccountData)"
            >
              设为默认
            </el-button>
            <el-popconfirm
              title="确认删除这条邮箱？被定时任务选中时会被拒绝。"
              width="320"
              confirm-button-text="确认删除"
              cancel-button-text="取消"
              @confirm="onDelete(row as MailAccountData)"
            >
              <template #reference>
                <el-button link type="danger" :loading="store.actions.deletingRowId === row.id">
                  删除
                </el-button>
              </template>
            </el-popconfirm>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <MailAccountDialog
      :model-value="store.dialogs.visible"
      :mode="store.dialogs.mode"
      :form="store.dialogs.form"
      :errors="store.dialogs.fieldErrors"
      :preset-options="store.query.presetOptions"
      :preset-detail="store.query.selectedPresetDetail"
      :loading="store.actions.saving"
      @update:model-value="onDialogVisible"
      @patch="onFormPatch"
      @confirm="onConfirm"
      @cancel="store.dialogs.closeDialog()"
    />
  </div>
</template>

<script setup lang="ts">
// views/mail/accounts/MailAccountsTab.vue
//
// 2026-10-16 新建：见文件头。

import { computed, onBeforeUnmount, onMounted } from 'vue';
import { Refresh } from '@element-plus/icons-vue';
import MailAccountDialog from './MailAccountDialog.vue';
import { useMailAccountsStore } from './composables/useMailAccountsStore';
import type { MailAccountData, MailAccountFormModel } from './mailAccountSchema';

// 不变量 #1：壳 setup 顶部首调 store（$dispose 绑到首个创建它的组件）。
const store = useMailAccountsStore();

/** 「有邮箱但一个默认都没有」的提示条。⚠️ 判据的「已加载」由 `accounts.length > 0` 顺带
 *  承担（列表还在飞时它必然是 0）：不必再叠一个 `!loading`，那会在后台 refetch 期间把
 *  已经成立的提示条藏掉一瞬。 */
const showNoDefaultHint = computed(
  () => store.query.accounts.length > 0 && !store.query.hasDefault,
);

function onDelete(row: MailAccountData): void {
  // 传整行：动作端点的 body 必填 `version`（OCC 锚），store 从行上取。
  void store.actions.remove(row);
}

/** 弹窗的整体显隐（× / Esc / 点遮罩都走这里）。**刻意不另发业务事件** ——
 *  这个弹窗的唯一出口是「保存」，其余关闭动作一律收在 `closeDialog()` 一处
 *  （照 CLAUDE.md「弹窗关闭权」；本弹窗还留着 × 是安全的：关闭不丢任何已提交的数据，
 *  唯一的输入态在 store 里，关掉再打开会被 `openCreate` / `openEdit` 重置）。 */
function onDialogVisible(next: boolean): void {
  if (!next) store.dialogs.closeDialog();
}

/** 弹窗里某个字段变了 → 写回 store 的同一个 reactive 表单对象（整体 Object.assign，
 *  不能换引用：store 的 `selectedPresetDetail` / `validateForm` 闭包持有的是那一个）。
 *  `next` 标成可选是因为子组件的联合签名把「无 payload 的事件」也并进来了，Vue 生成的
 *  模板监听器类型因而带 `?`；运行时 `patch` 事件必然带 payload。 */
function onFormPatch(next?: Partial<MailAccountFormModel>): void {
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
  // 开 enabled 闸门 → 两条 query 首屏 fetch（邮箱列表 + SMTP 预设选项）。
  store.query.openGate();
});

onBeforeUnmount(() => {
  // 不变量 #2：Pinia 单例，离开 /mail（两个 pane 一并卸载）时销毁，下次进入重建
  // fresh 状态（否则填了一半的弹窗态会泄漏到下次进入）。
  store.$dispose();
});
</script>

<style lang="scss" scoped>
.mail-accounts-tab {
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

.cell-muted {
  color: var(--text-secondary);
}

.default-hint {
  margin-bottom: 0;
}
</style>
