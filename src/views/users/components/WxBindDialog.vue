<!--
  WxBindDialog.vue — 企业微信账号绑定

  2026-10-10 新建：前端首次接入后端早已实装的三个企微绑定端点
  （`GET|POST /api/v2/iam/users/{id}/wx-bind` + `POST /api/v2/iam/users/{id}/wx-bind/unbind`）。

  **单输入框形态**的依据：绑定基数是双向一对一（后端业务层限制）—— 一个企微 userid 只能绑
  一个系统账号（40108），一个系统账号只能绑一个企微 userid（40110）⇒ 不存在「多绑定列表」
  这种 UI。存量数据理论上可能有 >1 行绑定，但 unbind 端点会软删该账号的**全部**绑定行，
  文案统一叫「解绑」。

  取数由 store 持有（`store.wxIdentity`，键走 `qk.userWxIdentity(userId)`，闸门 =
  弹窗开着且有账号 id）⇒ 本组件零 `api/*` 依赖。

  ⚠️ `getWxIdentity` 未绑定时返回 **`null`**（不是 `[]`）：下面的三分支显式区分
  「加载中 / 已绑 / 未绑」，不直接对返回值 `.map` / `.length`。
-->
<template>
  <el-dialog
    :model-value="store.dialogs.wxBind.visible"
    title="企业微信绑定"
    :width="dlg.width"
    :top="dlg.top"
    :close-on-click-modal="false"
    @update:model-value="store.dialogs.wxBind.closeWxBind()"
  >
    <p class="wx-current">当前账号（{{ store.dialogs.wxBind.username }}）：</p>

    <!-- 已绑态：展示绑定详情 + 一个带二次确认的「解绑」按钮 -->
    <div v-if="identity" class="wx-bound">
      <div><strong>企业 ID：</strong>{{ identity.corp_id }}</div>
      <div><strong>成员 UserID：</strong>{{ identity.wx_user_id }}</div>
      <div><strong>绑定时间：</strong>{{ identity.created_at }}</div>
      <el-popconfirm
        title="确认解绑企业微信账号？解绑后该账号将无法用企业微信登录。"
        width="280"
        @confirm="store.submitUnbindWx(identity.version)"
      >
        <template #reference>
          <el-button type="danger" :loading="store.dialogs.wxBind.saving">解绑</el-button>
        </template>
      </el-popconfirm>
    </div>

    <!-- 加载中：data 还没回来（undefined）与「确认未绑定」（null）是两态，不能都渲染成
         未绑态 —— 否则已绑账号会先闪一个输入框再跳到已绑态。 -->
    <div v-else-if="store.wxIdentity.loading" class="wx-loading">加载绑定状态…</div>

    <!-- 未绑态：一个输入框 + 「绑定」按钮 -->
    <div v-else class="wx-unbound">
      <el-input
        v-model="wxUserIdDraft"
        placeholder="企业微信通讯录里的成员 UserID"
        clearable
        :error="Boolean(errors.wx_user_id)"
        @keyup.enter="onBind"
      />
      <div v-if="errors.wx_user_id" class="wx-error">{{ errors.wx_user_id }}</div>
      <el-button
        type="primary"
        class="wx-bind-btn"
        :disabled="!wxUserIdDraft.trim()"
        :loading="store.dialogs.wxBind.saving"
        @click="onBind"
      >
        绑定
      </el-button>
    </div>

    <p class="scope-hint">
      一个系统账号只能绑一个企业微信账号；该 UserID 需先存在于本企业微信通讯录中，否则 绑定会失败。
    </p>
  </el-dialog>
</template>

<script setup lang="ts">
// views/users/components/WxBindDialog.vue
//
// 2026-10-10 新建：见文件头。组件 0 业务状态（绑定数据 / 对话框态 / 写分发全在 store），
// 这里只持有「未绑态输入框的草稿」这一个局部 ref + Zod 校验。

import { computed, ref, watch } from 'vue';
import { useDialogSize } from '@/composables/useDialogSize';
import {
  toFieldErrors,
  wxBindFormSchema,
  type WxBindFormFieldErrors,
  type WxBindFormInput,
} from '../usersSchema';
import { useUsersListStore } from '../composables/useUsersListStore';

const store = useUsersListStore();
const dlg = useDialogSize({ desktopWidth: 480 });

/** 已绑定的绑定行；`undefined` = 还在加载，`null` = 后端确认未绑定。 */
const identity = computed(() => store.wxIdentity.data ?? null);

const wxUserIdDraft = ref('');
const errors = ref<WxBindFormFieldErrors>({});

// 换账号打开时清掉上一次的草稿 / 报错。**watch 的是 userId 而不是 visible**：同一个账号
// 「关掉 → 再打开」时 visible 是 true → true（watch 判为无变化、不触发），草稿会带着上
// 一轮的半截 userid 留在输入框里；userId 每次打开都被重置（含重新设成同一个值之前的
// 那次置 null），变化必然被观察到。
watch(
  () => store.dialogs.wxBind.userId,
  () => {
    wxUserIdDraft.value = '';
    errors.value = {};
  },
);

function onBind(): void {
  const parsed = wxBindFormSchema.safeParse({ wx_user_id: wxUserIdDraft.value });
  if (!parsed.success) {
    errors.value = toFieldErrors<WxBindFormInput>(parsed.error.issues);
    return;
  }
  errors.value = {};
  // 失败（40108 / 40109 / 40110）的专门文案由 store 的 mutation onError 弹。
  void store.submitBindWx(parsed.data.wx_user_id);
}
</script>

<style lang="scss" scoped>
.wx-current {
  margin-bottom: 8px;
}

.wx-bound,
.wx-unbound {
  display: flex;
  flex-direction: column;
  gap: 8px;
  line-height: 1.8;
  font-size: 13px;
}

.wx-loading {
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 1.8;
}

.wx-bind-btn {
  align-self: flex-start;
}

.wx-error {
  color: var(--el-color-danger);
  font-size: 12px;
}

.scope-hint {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 12px 0 0;
  padding: 8px 12px;
  background: #fdf6ec;
  border: 1px solid #faecd8;
  border-radius: 6px;
  font-size: 13px;
  color: #b88230;
  line-height: 1.5;
}
</style>
