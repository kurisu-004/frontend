<!--
  HeldPartsBadge.vue

  扫码台「已持有 N 件」徽章卡 + 右侧抽屉（2026-07-17 改造）。

  行为：
  - 顶栏触发按钮：「已持有 N 件」(N = 已加载条数；N=0 时灰色；N>=1 时主色 + 计数 badge)。
    2026-10-04：列表端点返回分页信封，N 取 `.items.length`（已加载），抽屉里另标
    「共 M 件」= 信封 total；两者不等即表示受后端 limit 截断（不再谎称是全部）。
  - 点击打开 el-drawer（右侧 rtl，size=400px），列出当前 worker 持有件
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
        <el-button size="small" link :loading="loading" @click="fetchHeld">
          <el-icon><Refresh /></el-icon>
          <span>刷新</span>
        </el-button>
      </div>

      <div v-if="loading && parts.length === 0" class="held-loading">
        <el-icon class="is-loading"><Loading /></el-icon>
        <span>加载中…</span>
      </div>

      <div v-else-if="errorMsg" class="held-error">
        <el-icon color="#f56c6c"><WarningFilled /></el-icon>
        <span>{{ errorMsg }}</span>
      </div>

      <div v-else-if="parts.length === 0" class="held-empty">
        <el-icon :size="48" color="#c0c4cc"><Box /></el-icon>
        <p>暂未持有零件</p>
        <p class="held-empty-hint">领取后会出现在这里</p>
      </div>

      <div v-else class="held-list" :style="{ maxHeight: maxListHeight }">
        <!-- 2026-10-04：key 用 `p.batch_id || p.id`（与报工台三页列表同口径）。
             后端把 held 端点的 `batch_id` 填上后，同一 part 的多个批次会在
             抽屉里撞 part id ⇒ Vue duplicate-key（整列表只渲染一行且控制台告警）。
             批次锚点缺失（老数据 / 后端回退）时退回 part id。 -->
        <div
          v-for="p in parts"
          :key="p.batch_id || p.id"
          :class="['held-row', { 'is-urgent': p.is_urgent }]"
        >
          <div class="held-row-main">
            <span class="held-serial">{{ p.serial_no || '—' }}</span>
            <span class="held-drawing">{{ p.drawing_no }}</span>
          </div>
          <div class="held-row-name">{{ p.name }}</div>
          <!-- 2026-10-04：本行 VO 是后端 PartListItem，没有 next_process_name /
               shelf_code 键（后端列表刻意不返 next_process_id，也没有货架码派生），
               「下一工序 / 货架」两个 tag 恒不显示、「未选工序」恒显示，是假话 ⇒ 删除。
               加急是本行唯一还有意义的副信息，没有它时整块不渲染。 -->
          <div v-if="p.is_urgent" class="held-row-sub">
            <span class="urgent-tag">加急</span>
          </div>
        </div>
      </div>
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
import { Box, Loading, Refresh, User, WarningFilled } from '@element-plus/icons-vue';
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
  padding: 0 4px;
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
.held-loading,
.held-error,
.held-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 32px 8px;
  color: #909399;
  font-size: 13px;
  text-align: center;
}
.held-error {
  color: #f56c6c;
}
.held-empty-hint {
  font-size: 12px;
  color: #c0c4cc;
  margin: 0;
}
.held-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow-y: auto;
  padding-right: 4px;
}
.held-row {
  border: 1px solid #ebeef5;
  border-radius: 6px;
  padding: 10px 12px;
  background: #fafafa;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.held-row.is-urgent {
  background: #fdf6ec;
  border-color: #f9d77e;
}
.held-row-main {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
}
.held-serial {
  font-weight: 600;
  color: #303133;
  min-width: 72px;
}
.held-drawing {
  color: #606266;
}
.held-row-name {
  font-size: 13px;
  color: #303133;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.held-row-sub {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  font-size: 12px;
}
.urgent-tag {
  color: #e6a23c;
  font-weight: 600;
  font-size: 12px;
}
.muted-inline {
  color: #909399;
  margin-left: 2px;
}
.count-badge {
  margin-left: 4px;
}
</style>
