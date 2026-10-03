<!--
  DashboardView.vue
  dashboard 顶层视图：KPI 横排 + 双栏（左 交期分桶柱状图，右 两块交期工单面板）。
  组件自身不持数据，全部由 composables 提供。

  布局：
    - KPI 横排（DashboardKpiTiles，5 tile：逾期未交 / 今日到期 / 两周到期 / 在制 / 在检）
    - 双栏：左 UpcomingDeliveryChart + FactoryRealtimeStrip，右 SystemDeliveryOrdersPanel ×2
      （variant=urgent 最紧急工单 / variant=partial 部分已交）
    - 视口 ≤1100px 折叠成单列

  数据流：
    - useDashboardSnapshot() → snapshot.upcoming_delivery（14 天分桶）+ in_process +
      on_inspection_shelves（在制 / 在检 KPI 派生来源）
    - useDashboardUrgentList() → items（listUnionItems 拉 100 件非终态件，按
      system_delivery_date ASC）；右栏两块面板**共用这一份 items**，由
      splitForDashboard（src/utils/systemDeliveryOrders.ts）按 7 天窗口 + 「有无已交
      批次」分桶，零新增请求。
    - useDashboardOverdue(isManager) → overdueCount（Manager-only，闸门按角色）
    - 行点击 → selectedPart + previewOpen 走 PartPreviewDialog（统一入口）

  2026-10-03 新增右栏第二块面板「部分已交」：.main-right 两卡均分高度
  （flex: 1 1 0 + min-height 兜底），面板头 flex-shrink: 0 防被压扁。
-->
<template>
  <div class="dashboard">
    <!-- 双栏布局：左 柱状图 + 实时态 / 右 两块交期工单面板 -->
    <section class="dashboard-main">
      <div class="main-left">
        <!-- KPI 横排（5 tile） -->
        <DashboardKpiTiles
          :manager="isManager"
          :overdue-count="overdueCount"
          :today-count="todayCount"
          :week-count="weekCount"
          :in-process-count="inProcessCount"
          :in-inspection-count="inInspectionCount"
        />
        <UpcomingDeliveryChart
          :buckets="upcomingBuckets"
          height="100%"
          @bar-layer-click="onBarLayerClick"
        />
        <!-- 工厂实时态 -->
        <FactoryRealtimeStrip
          :items="inProcessItems"
          :can-open-detail="canOpenPartDetail"
          @item-click="goPartDetail"
        />
      </div>
      <div class="main-right">
        <SystemDeliveryOrdersPanel
          variant="urgent"
          :items="deliveryBuckets.urgent"
          @row-click="onRowClick"
        />
        <SystemDeliveryOrdersPanel
          variant="partial"
          :items="deliveryBuckets.partial"
          @row-click="onRowClick"
        />
      </div>
    </section>

    <!-- 通用图纸预览对话框（A4 横向预览 + 该工单所有批次 + 持有者）。dashboard 两条
         路径（右栏两面板行点击 + UpcomingDeliveryListDrawer 行点击）都进
         PartPreviewDialog。 -->
    <PartPreviewDialog v-model="previewOpen" :part="selectedPart" />

    <!-- 抽屉：交期柱状图按层点击列表 -->
    <UpcomingDeliveryListDrawer
      v-if="selectedLayer"
      v-model="upcomingDrawerOpen"
      :date="selectedLayer.date"
      :layer="selectedLayer.layer"
      :statuses="selectedLayer.statuses"
      @row-click="onUpcomingRowClick"
    />
  </div>
</template>

<script setup lang="ts">
// dashboard 顶层视图的编排：三个独立 useQuery + 一个共享 WS 事件订阅，通过
// useDashboardInvalidation 复用 AFFECTS_DASHBOARD 事件集 + 500ms / 1500ms debounce，
// 避免重复订阅 handler。
//
// 不写 retry：信任 main.ts 全局 queries.retry: 0。
//
// 跨角色权限：
//   - SHELF_ACCOUNT：isShelfAccount = true → canOpenPartDetail = false → chips 不可点。
//   - MANAGER / CLERK / INSPECTOR / CNC_PROGRAMMER：canOpenPartDetail = true。

import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { usePermissions } from '@/composables/usePermissions';
import type { OrderStatus, PartListItem } from '@/types/parts';
import { useDashboardSnapshot } from '@/views/dashboard/composables/useDashboardSnapshot';
import { useDashboardUrgentList } from '@/views/dashboard/composables/useDashboardUrgentList';
import { useDashboardOverdue } from '@/views/dashboard/composables/useDashboardOverdue';
import { splitForDashboard } from '@/utils/systemDeliveryOrders';
import DashboardKpiTiles from './components/DashboardKpiTiles.vue';
import UpcomingDeliveryChart from './components/UpcomingDeliveryChart.vue';
import UpcomingDeliveryListDrawer from './components/UpcomingDeliveryListDrawer.vue';
import SystemDeliveryOrdersPanel from './components/SystemDeliveryOrdersPanel.vue';
import FactoryRealtimeStrip from './components/FactoryRealtimeStrip.vue';
import PartPreviewDialog from './components/PartPreviewDialog.vue';

const router = useRouter();
const { isManager, isClerk, isInspector, isCncProgrammer } = usePermissions();

/** 纯 SHELF_ACCOUNT 账号禁跳详情。 */
const canOpenPartDetail = computed(
  () => isManager.value || isClerk.value || isInspector.value || isCncProgrammer.value,
);

// ============ 数据 ============
const { data: snapshot } = useDashboardSnapshot();
const { items: urgentItems } = useDashboardUrgentList();
const { overdueCount } = useDashboardOverdue(isManager);

// upcoming_delivery 数组（来自 snapshot，可能为空数组）
const upcomingBuckets = computed(() => snapshot.value?.upcoming_delivery ?? []);

// in_process 数组（来自 snapshot，按工人分组 chips 用）
const inProcessItems = computed(() => snapshot.value?.in_process ?? []);

// 右栏两块面板的分桶结果。共用同一份 items，只 filter + slice，零新增请求；
// 交付动作发 PART_DELIVERED（已在本域 AFFECTS_DASHBOARD 事件集内）→ 自动失效重取。
const deliveryBuckets = computed(() =>
  splitForDashboard(urgentItems.value, { urgentLimit: 30, partialLimit: 30 }),
);

// ============ KPI 派生 ============
const todayCount = computed<number>(() => {
  const today = todayIso();
  return upcomingBuckets.value
    .filter((b) => b.date === today)
    .reduce((sum, b) => sum + (Number(b.count) || 0), 0);
});

const weekCount = computed<number>(() =>
  upcomingBuckets.value.reduce((sum, b) => sum + (Number(b.count) || 0), 0),
);

/** 在制件数 = snapshot.in_process.length（在制 KPI tile 数据源） */
const inProcessCount = computed<number>(() => snapshot.value?.in_process.length ?? 0);

/** 在检件数 = snapshot.on_inspection_shelves.length（在检 KPI tile 数据源） */
const inInspectionCount = computed<number>(
  () => snapshot.value?.on_inspection_shelves.length ?? 0,
);

function todayIso(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// ============ 预览对话框 ============
// 两条路径（右栏两面板行点击 + UpcomingDeliveryListDrawer 行点击）都进
// PartPreviewDialog，行为统一：selectedPart.value = part; previewOpen.value = true。
const previewOpen = ref(false);
const selectedPart = ref<PartListItem | null>(null);

function onRowClick(part: PartListItem): void {
  selectedPart.value = part;
  previewOpen.value = true;
}

function goPartDetail(partId: string): void {
  if (!canOpenPartDetail.value) return;
  void router.push(`/parts/${partId}`);
}

// ============ 交期柱状图按层点击 ============
// selectedLayer 持有 { date, layer, statuses } 三元组，v-if="selectedLayer" 保证
// drawer 在首次点击前不挂载（useDashboardUpcomingList 的 enabled 闸门天然生效）。
const upcomingDrawerOpen = ref(false);
const selectedLayer = ref<{
  date: string;
  layer: 'top' | 'middle' | 'bottom';
  statuses: readonly OrderStatus[];
} | null>(null);

function onBarLayerClick(payload: {
  date: string;
  layer: 'top' | 'middle' | 'bottom';
  statuses: readonly OrderStatus[];
}): void {
  selectedLayer.value = {
    date: payload.date,
    layer: payload.layer,
    statuses: payload.statuses,
  };
  upcomingDrawerOpen.value = true;
}

// 两 drawer/dialog 协调逻辑全在本函数，UpcomingDeliveryListDrawer 只 emit
// rowClick(part)，不感知 PartPreviewDialog 存在。drawer 不关闭 —— dialog
// （append-to-body）覆盖在 drawer 之上，关掉 dialog 后 drawer 仍可见，方便连续预览。
// 不重置 selectedLayer：下次用户再点柱状图时 upcomingDrawerOpen 按需重新打开。
function onUpcomingRowClick(part: PartListItem): void {
  selectedPart.value = part;
  previewOpen.value = true;
}
</script>

<style lang="scss" scoped>
.dashboard {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 16px;
  height: calc(100vh - 60px);
  box-sizing: border-box;
  overflow: hidden;
  background: var(--content-bg);
}

.dashboard-main {
  flex: 1;
  display: grid;
  // 列比 3fr 2fr（用户「6:4」要求），下限钉死 minmax(0, …)：裸 fr 的下限是 auto
  // （= min-content），左栏内容宽会反向决定右栏 track；钉死后右栏恒取 2/5。
  grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
  gap: 16px;
  min-height: 0;
}
.main-left {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-height: 0;
}
.main-left > :first-child {
  // KpiTiles 不压缩，由 Chart / Strip 撑满剩余空间
  flex-shrink: 0;
}
.main-left > :nth-child(2) {
  // Chart 占 50%，可压缩到 min-height: 280px（保证窄屏可读）
  flex: 1 1 50%;
  min-height: 280px;
  min-width: 0;
  display: flex;
}
.main-left > :nth-child(2) > * {
  flex: 1;
  min-width: 0;
}
.main-left > :last-child {
  // Strip 固定占屏幕 20% 高度（与 Chart 各占一半）；min-height: 160px 兜底避免
  // 极窄屏塌缩。Strip 内部 worker groups >4 时由 el-carousel 轮播承载。
  flex: 0 0 20%;
  min-height: 160px;
}
.main-right {
  min-height: 0;
  display: flex;
  flex-direction: column;
  // 两块交期面板等高切分（flex: 1 1 0 在各自组件内），gap 与左栏同 16px。
  gap: 16px;
}

@media (max-width: 1100px) {
  .dashboard {
    // 单列下两块内容纵向堆叠，总高必然超过一屏 —— 改为内容撑高 + 纵向滚动。
    // 保持「定高 + overflow: hidden」会把第二行整块裁掉。
    height: auto;
    min-height: calc(100vh - 60px);
    overflow-y: auto;
  }
  .dashboard-main {
    grid-template-columns: 1fr;
    // 两栏各占一行、按内容定高。行高若交给 1fr，auto 高度的 grid 行里
    // 「flex-basis: 0 的子项」高度会退化成 min-height，两块面板被压成两条细缝。
    grid-template-rows: auto auto;
  }
  .main-right {
    // auto 高度容器里两卡按各自 min-height 排布，不做等分。
    flex: 0 0 auto;
  }
}
</style>
