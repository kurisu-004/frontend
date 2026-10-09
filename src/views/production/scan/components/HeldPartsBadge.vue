<!--
  HeldPartsBadge.vue

  扫码台「已持有 N 件」徽章卡 + 右侧抽屉（2026-07-17 改造）。

  行为：
  - 顶栏触发按钮：「已持有 N 件」(N = 已加载条数；N=0 时灰色；N>=1 时主色 + 计数 badge)。
    2026-10-04：列表端点返回分页信封，N 取 `.items.length`（已加载），抽屉里另标
    「共 M 件」= 信封 total；两者不等即表示受后端 limit 截断（不再谎称是全部）。
  - 点击打开 el-drawer（右侧 rtl，size=400px），列出当前 worker 持有件
  - 抽屉里的头部（计数 / 刷新）与列表块（加载 / 错误 / 空 / 四态 + 行渲染）已分别搬进
    `HeldPartsHeader.vue` / `HeldPartsList.vue`，与 `/scan/action` 的「查看持有」弹窗共用
    同一份渲染（2026-10-11）。本组件只留顶栏按钮、抽屉壳与把两者串起来的 `.held-card`
  - 数据源 = `useScanHeldQuery`，与放回页 / 送检页**共用同一条 query key** ⇒ 同屏只发
    一次请求，领取/放回/送检后由 mutation 的失效链自动同刷（2026-10-10 前这里是模块级
    `useScanBus` 信号 + 各自 fetchHeld，同一屏对同一个工人发 2 次同参请求且切页无缓存）
  - autoOpenToken 变化且 autoOpenOnChange=true 时：自动打开 drawer，让工人确认刚提交的结果

  入参：
  - workerId: 雪花 ID 字符串（来自 useScanSession.worker.value.id）
  - maxListHeight: drawer 内列表最大高度（默认 calc(100vh - 200px)）
  - autoOpenOnChange: 是否响应 autoOpenToken 自动打开 drawer（默认 false）
  - autoOpenToken: 页面在**写成功后**自增的计数器；每次变化触发一次自动开抽屉
-->

<template>
  <el-button
    :type="count > 0 ? 'warning' : 'info'"
    :plain="count === 0"
    :disabled="!workerId"
    @click="drawerVisible = true"
  >
    <el-icon><Box /></el-icon>
    <span>已持有</span>
    <el-badge v-if="count > 0" :value="count" :max="99" class="count-badge" type="danger" />
    <span v-else class="muted-inline">0 件</span>
  </el-button>

  <el-drawer
    v-model="drawerVisible"
    direction="rtl"
    size="400px"
    title="我的持有零件"
    :with-header="true"
    :append-to-body="true"
    :destroy-on-close="false"
    @open="onOpen"
  >
    <div class="held-card">
      <!-- 2026-10-11：头部（计数 / 刷新）与下面的列表块（`HeldPartsList`）都收敛成
           域内共用件，与 `/scan/action` 的「查看持有」弹窗共用同一份渲染。 -->
      <HeldPartsHeader
        :worker-id="workerId"
        :count="count"
        :total="total"
        :loading="loading"
        @refresh="fetchHeld"
      />

      <HeldPartsList
        :items="parts"
        :loading="loading"
        :error-msg="errorMsg"
        :max-list-height="maxListHeight"
      />
    </div>
  </el-drawer>
</template>

<script setup lang="ts">
/**
 * 用法（三页都传 `autoOpenOnChange` + 一个写成功后自增的 `autoOpenToken`）：
 *   <HeldPartsBadge :worker-id="String(worker.id)" :auto-open-on-change="true"
 *                   :auto-open-token="heldChangeToken" />
 *
 * 为什么 `autoOpenToken` 是**计数器 prop** 而不是模块级事件总线（2026-10-10 起）：
 *   - 「刷新数据」这一半已被 query key 共享替代 —— 徽章与三页读同一条 `qk.scanHeld`，
 *     写操作的失效链一失效，四个面同刷，信号是冗余的；
 *   - 剩下的「提交成功后自动开抽屉」是**写侧信息**，query 的失效通道不携带它
 *     （invalidate 只说「数据过期了」，不说「刚刚有人提交成功」）。而把它做成
 *     `watch(query.dataUpdatedAt)` 之类的数据侧近似会在**暖缓存**进页面时失准：
 *     缓存仍新鲜 ⇒ 不发请求 ⇒ 没有 data 更新 ⇒ 提交后的那一次反而被当成「首次更新」
 *     而被跳过，或反之在任意一次后台 refetch 上误开抽屉。
 *   - 计数器 prop 是 Vue 原生的显式数据流：谁提交、谁自增，链路一眼看得见，也不必
 *     让四个消费方共享一个模块级可变单例。
 *   自增点放在**写成功之后**（`await mutateAsync()` 返回即写成功，且此时失效链的
 *   refetch 已经 settle —— TanStack 会 await `onSuccess` 返回的 promise），
 *   所以抽屉打开时看到的已经是刷新后的列表。
 */
import { computed, ref, watch } from 'vue';
import { Box } from '@element-plus/icons-vue';
import HeldPartsHeader from './HeldPartsHeader.vue';
import HeldPartsList from './HeldPartsList.vue';
import { useScanHeldQuery } from '@/views/production/scan/composables/useScanListQuery';
import { scanListErrorText } from '@/views/production/scan/composables/scanListErrorMessage';

const props = withDefaults(
  defineProps<{
    workerId: string;
    maxListHeight?: string;
    /** 写操作成功后是否自动打开 drawer（让工人确认领取/放回结果） */
    autoOpenOnChange?: boolean;
    /** 页面在写成功后自增的计数器；每次变化触发一次自动开抽屉 */
    autoOpenToken?: number;
  }>(),
  {
    maxListHeight: 'calc(100vh - 200px)',
    autoOpenOnChange: false,
    autoOpenToken: 0,
  },
);

const drawerVisible = ref(false);

// 与放回页 / 送检页共用同一条 query key（同 workerId + 同 limit ⇒ 同键 ⇒ 同屏去重成
// 1 次请求，写后随失效链同刷）。`silent: true` 是因为本页把错误渲染进抽屉内的
// `errorMsg` 行，而不是再弹一次 toast —— 见 useScanListQuery.ts 的说明。
const held = useScanHeldQuery(
  () => (props.workerId ? { workerId: props.workerId, limit: 200 } : null),
  { silent: true },
);

const parts = computed(() => held.query.data.value?.items ?? []);
// 后端信封里的总条数；count 是「已加载」的条数，两者不等说明列表被 limit 截断
const total = computed(() => held.query.data.value?.total ?? 0);
const loading = computed(() => held.query.isFetching.value);
const errorMsg = computed(() => {
  const e = held.query.error.value;
  return e ? scanListErrorText(e, '加载失败') : null;
});

const count = computed(() => parts.value.length);

/** 抽屉里的「刷新」按钮：走 query 的 refetch，不绕 api 层。 */
function fetchHeld(): Promise<void> {
  return held.fetchList();
}

function onOpen(): void {
  // 每次打开都重新拉一次（最新数据）；抽屉打开期间数据已经是最新的就不重复往返。
  if (held.query.isStale.value) void fetchHeld();
}

// 写成功后自增 ⇒ 自动开抽屉。`prev === undefined` 不可能发生（`withDefaults` 给了
// `autoOpenToken: 0`，非 immediate watch 的首次触发 prev 恒为数字），故只挡「没变」。
watch(
  () => props.autoOpenToken,
  (token, prev) => {
    if (token === prev) return;
    if (props.autoOpenOnChange) drawerVisible.value = true;
  },
);
</script>

<style scoped>
.held-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  /* 面板自身的 4px 内边距（叠在抽屉体自带的 padding 之上），两处面板同值 */
  padding: 0 4px;
}
.muted-inline {
  color: #909399;
  margin-left: 2px;
}
.count-badge {
  margin-left: 4px;
}
</style>
