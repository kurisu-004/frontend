<!--
  HeldPartsDialog.vue

  扫码台 `/scan/action` 的「查看持有」弹窗（2026-10-11 新增）：工人在这一页扫完工牌还没
  领任何件时，顶栏徽章不可见（徽章挂在报工台布局里，`/scan/action` 自己画顶栏），就缺一个
  「我手上到底有什么」的入口 —— 工人在动作选择页就该能看到自己的持有情况，不必先随便
  跳进一个动作页再从徽章里点开。

  与 `HeldPartsBadge` 的关系：**同一份数据、同一份渲染**。
    - 数据：`useScanHeldQuery`，params 刻意与徽章 / 放回页 / 送检页**完全一致**
      （`{ workerId, limit: 200 }`）⇒ 同一 workerId 落在同一条 `qk.scanHeld` 上 ⇒
      同屏去重成 1 次请求，写操作的失效链也一并同刷。本组件**不新增任何 query key、
      不新增任何请求**。
    - 渲染：内部用 `HeldPartsList`（与徽章抽屉共用），见该组件文件头。

  入口形态（产品拍板）：正文第四个大按钮，不是顶栏徽章、不是独立路由页。
-->

<template>
  <el-dialog
    v-model="visible"
    title="我的持有零件"
    width="460px"
    :close-on-click-modal="false"
    @open="onOpen"
  >
    <div class="held-card">
      <div class="held-header">
        <span class="held-subtitle">
          <el-icon><User /></el-icon>
          <span>{{ workerId ? '当前工人' : '未识别' }}</span>
          <span class="held-count-inline"
            >已加载 {{ count }} 件<template v-if="total > count"
              >（共 {{ total }} 件）</template
            ></span
          >
        </span>
        <el-button size="small" link :loading="loading" @click="refresh">
          <el-icon><Refresh /></el-icon>
          <span>刷新</span>
        </el-button>
      </div>

      <HeldPartsList
        :items="parts"
        :loading="loading"
        :error-msg="errorMsg"
        max-list-height="52vh"
        empty-hint="在这个工位点「取件」领取后会出现在这里"
      />
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { Refresh, User } from '@element-plus/icons-vue';
import HeldPartsList from './HeldPartsList.vue';
import { useScanHeldQuery } from '@/views/production/scan/composables/useScanListQuery';
import { scanListErrorText } from '@/views/production/scan/composables/scanListErrorMessage';

const props = defineProps<{
  /** 工人雪花 ID 字符串；空 / null 时不发请求（后端 `worker_id` 必填且只吃 JSON 字符串）。 */
  workerId: string | null;
}>();

// v-model 直通：父组件用 `v-model` 控制显隐，本组件不持有独立状态。
const visible = defineModel<boolean>({ required: true });

// params 与 `HeldPartsBadge` 逐字一致（`{ workerId, limit: 200 }`）⇒ 同一条 qk.scanHeld。
// `null` 是占位键 + `enabled` 闸门（queryFn 内有二次守卫），见 useScanListQuery 的说明。
// `silent: true`：错误渲染进面板里的错误行，不弹 toast —— 徽章与本页共用同一条 query key，
// 两边都弹会在同一次失败上弹两条一模一样的 toast。
const held = useScanHeldQuery(
  () => (props.workerId ? { workerId: props.workerId, limit: 200 } : null),
  { silent: true },
);

const parts = computed(() => held.query.data.value?.items ?? []);
// 后端信封里的总条数；count 是「已加载」的条数，两者不等说明列表被 limit 截断
const total = computed(() => held.query.data.value?.total ?? 0);
const count = computed(() => parts.value.length);
const loading = computed(() => held.query.isFetching.value);
const errorMsg = computed(() => {
  const e = held.query.error.value;
  return e ? scanListErrorText(e, '加载失败') : null;
});

function refresh(): Promise<void> {
  return held.fetchList();
}

function onOpen(): void {
  // 与徽章抽屉同一口径：打开时若缓存已过期就补一次 refetch；数据还新鲜就不往返。
  if (held.query.isStale.value) void refresh();
}
</script>

<style scoped>
.held-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.held-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.held-subtitle {
  display: flex;
  align-items: center;
  gap: 6px;
  color: #606266;
  font-size: 13px;
}
.held-count-inline {
  margin-left: 6px;
  padding: 2px 8px;
  background: #ecf5ff;
  color: #409eff;
  border-radius: 10px;
  font-weight: 600;
}
</style>
