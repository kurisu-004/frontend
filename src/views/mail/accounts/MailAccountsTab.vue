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

    <el-card shadow="never">
      <el-empty
        v-if="!store.query.loading && store.query.accounts.length === 0"
        description="还没有配置邮箱账号"
      />
      <el-table v-else :data="store.query.accounts" row-key="id" class="accounts-table">
        <el-table-column prop="name" label="名称" min-width="140" show-overflow-tooltip />
        <el-table-column label="预设" min-width="110">
          <template #default="{ row }">{{ presetLabel(row.preset) }}</template>
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
                <el-button link type="danger">删除</el-button>
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

import { onBeforeUnmount, onMounted } from 'vue';
import { Refresh } from '@element-plus/icons-vue';
import MailAccountDialog from './MailAccountDialog.vue';
import { useMailAccountsStore } from './composables/useMailAccountsStore';
import type {
  MailAccountData,
  MailAccountFormModel,
  MailPresetOptionData,
} from './mailAccountSchema';

// 不变量 #1：壳 setup 顶部首调 store（$dispose 绑到首个创建它的组件）。
const store = useMailAccountsStore();

/** 预设枚举 → 中文 label。**只认 `/mail/meta` 下发的选项**（`presetOptions`），认不到就
 *  显示枚举原文 —— 不在前端硬编一张 `NET_EASE_163 → '网易 163'` 的映射：那是这个域的
 *  第二个真源，后端改 label 时它不会报错，只会静默显示旧文案。 */
function presetLabel(preset: string): string {
  const hit = store.query.presetOptions.find((p: MailPresetOptionData) => p.value === preset);
  return hit?.label ?? preset;
}

function onDelete(row: MailAccountData): void {
  void store.actions.remove(row.id);
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
</style>
