<!--
  DashboardView.vue
  2026-09-29 重做：从车间大屏导向（货架轮播 + 工厂实时态）改为办公桌面屏导向
  （未来 7 天交期概览 + 最紧急工单 + 图纸预览）。

  信息架构（自上而下）：
    Header（欢迎语 + 当前日期 + 角色徽章）
    KPI 横排（5 tile：逾期未交 / 今日到期 / 本周到期 / 在制 / 在检）
    双栏布局：左 UpcomingDeliveryChart，右 UrgentOrdersList
    Footer：FactoryRealtimeStrip（沿旧 in_process 数据，按工人分组 chips）

  数据流：
    - useDashboardSnapshot() → snapshot.upcoming_delivery（14 天分桶，Phase 4 由 7 天扩 14 天）
      + in_process + on_inspection_shelves（在制 / 在检 KPI 派生来源）
    - useDashboardUrgentList() → items（listUnionItems 拉 100 件非终态件，按 system_delivery_date ASC）
    - useDashboardOverdue(isManager) → overdueCount（Manager-only，闸门按角色）
    - 行点击 → selectedPart + previewOpen 走 PartPreviewDialog（统一入口，A4 横向
      预览 + 该工单所有批次 + 持有者）

  2026-09-30 重构（dashboard 域 Phase 6 末次调整）：
    - 顶层 layout gap 12 → 16（视觉松绑，避免三块组件粘连）；
    - .main-left 子项 KpiTiles / Chart / Strip 之间用 gap: 16px（沿外层 gap）；
    - 移除 urgentCount 派生（KPI 不再消费 useDashboardUrgentList 的「紧急工单」tile）；
    - 新增 inProcessCount = snapshot.in_process.length、inInspectionCount =
      snapshot.on_inspection_shelves.length 两个 computed（KPI 「在制」「在检」tile 数据源）；
    - 移除 <UrgentOrderDrawer> 挂载（业务方改用 PartPreviewDialog；UrgentOrderDrawer
      文件保留供外部复用）；
    - 新增 <PartPreviewDialog v-model="previewOpen" :part="selectedPart" />；
    - onRowClick / onUpcomingRowClick 行为统一改为 selectedPart.value = part;
      previewOpen.value = true（不再 toggle drawer）；
    - <UpcomingDeliveryChart> 传 height="100%"（2026-09-30 review 第 1 轮 A.1+B.1
      修复后）：外层 .main-left > :nth-child(2) flex: 1 1 50% 控制 wrapper 高度，
      v-chart :style.height='100%' 撑满 wrapper（之前传 '50%' 导致 v-chart 只占
      wrapper 一半、下方空白）。
  2026-09-30 Phase 2 followup #2：.main-left > :last-child 由 flex: 0 0 auto 改为
  flex: 0 0 20% + min-height: 160px，固定 Strip 卡片占 20% 屏幕高度，与 Chart 各占
  一半；剩余空间由 Chart 撑满。配合 FactoryRealtimeStrip 内部 el-carousel 轮播
  承载超出 worker groups（>4 时自动分页）。
  2026-09-30 Phase 2 followup #4：onUpcomingRowClick 删除 upcomingDrawerOpen.value
  = false（drawer 保持展开），方便用户在下批连续预览图纸时保持 drawer 上下文。
  selectedLayer 不重置（已在原代码注释内说明），下次用户再点柱状图 drawer
  直接展开无须重渲。
-->
<template>
  <div class="dashboard">
    <!-- 双栏布局：左 UpcomingDeliveryChart / 右 UrgentOrdersList -->
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
        <!-- 2026-09-30 第 1 轮修复（review A.1+B.1）：由 height="50%" 改为
             height="100%"。原 50% 透传给 v-chart 的 inline style，v-chart 只占
             wrapper 高度的 50%，下方一半空白。修复方案 A2：wrapper 高度由外层
             flex chain（.main-left > :nth-child(2) { flex: 1 1 50%; min-height:
             280px; display: flex }）决定，v-chart 内 height: 100% 撑满 wrapper。 -->
        <UpcomingDeliveryChart
          :buckets="upcomingBuckets"
          height="100%"
          @bar-layer-click="onBarLayerClick"
        />
        <!-- Footer：工厂实时态 -->
        <FactoryRealtimeStrip
          :items="inProcessItems"
          :can-open-detail="canOpenPartDetail"
          @item-click="goPartDetail"
        />
      </div>
      <div class="main-right">
        <UrgentOrdersList :items="urgentItems" @row-click="onRowClick" />
      </div>
    </section>

    <!-- 2026-09-30 新增：通用图纸预览对话框（A4 横向预览 + 该工单所有批次 + 持有者），
         dashboard 双路径（UrgentOrdersList 行点击 + UpcomingDeliveryListDrawer 行点击）
         都进 PartPreviewDialog；UrgentOrderDrawer 文件保留供外部复用，但 dashboard
         不再挂载。 -->
    <PartPreviewDialog v-model="previewOpen" :part="selectedPart" />

    <!-- 抽屉：7 天交期柱状图按层点击列表 -->
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
// 2026-09-29 重做 + 2026-09-30 重构：完全抛弃车间大屏设计，改为办公桌面屏。
//
// 设计要点：
//   - 三个独立 useQuery + 一个共享 WS 事件订阅：
//     * useDashboardSnapshot    → snapshot（upcoming_delivery + in_process +
//       on_inspection_shelves）
//     * useDashboardUrgentList  → items（100 件非终态件，按 system_delivery_date ASC，
//       2026-09-30 调整）
//     * useDashboardOverdue     → overdueCount（Manager-only）
//     三个 useQuery 通过 useDashboardInvalidation 复用 AFFECTS_DASHBOARD 事件集 +
//     500ms / 1500ms debounce，避免重复订阅 handler。
//   - 不写 retry：信任 main.ts 全局 queries.retry: 0（沿 2026-09-26 约定）。
//   - 行点击 → PartPreviewDialog（v-model + :part，受控组件）；点击其他区域通过
//     emit('update:modelValue', false) 关闭。UrgentOrderDrawer 不再挂载。
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
import DashboardKpiTiles from './components/DashboardKpiTiles.vue';
import UpcomingDeliveryChart from './components/UpcomingDeliveryChart.vue';
import UpcomingDeliveryListDrawer from './components/UpcomingDeliveryListDrawer.vue';
import UrgentOrdersList from './components/UrgentOrdersList.vue';
import FactoryRealtimeStrip from './components/FactoryRealtimeStrip.vue';
import PartPreviewDialog from './components/PartPreviewDialog.vue';

const router = useRouter();
const { isManager, isClerk, isInspector, isCncProgrammer } = usePermissions();

/** 2026-09-29 新增：工控机账号（纯 SHELF_ACCOUNT）禁跳详情。 */
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

// 2026-09-30 新增：在制件数 = snapshot.in_process.length（在制 KPI tile 数据源）
const inProcessCount = computed<number>(() => snapshot.value?.in_process.length ?? 0);

// 2026-09-30 新增：在检件数 = snapshot.on_inspection_shelves.length（在检 KPI tile 数据源）
const inInspectionCount = computed<number>(() =>
  snapshot.value?.on_inspection_shelves.length ?? 0,
);

// ============ 顶部 header 派生 ============
function todayIso(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// ============ 预览对话框 ============
// 2026-09-30 调整：previewOpen / selectedPart 替换原 drawerVisible（toggle UrgentOrderDrawer）。
// 两条路径（UrgentOrdersList 行点击 + UpcomingDeliveryListDrawer 行点击）都进
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

// 2026-09-30 新增：7 天交期柱状图按层点击 → 打开 UpcomingDeliveryListDrawer。
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

// 2026-09-30 调整：UpcomingDeliveryListDrawer 行点击 → 关闭下方抽屉并打开
// PartPreviewDialog。两 drawer/dialog 协调逻辑全在本函数，UpcomingDeliveryListDrawer
// 只 emit rowClick(part)，不感知 PartPreviewDialog 存在。
// 不重置 selectedLayer —— 下次用户再点柱状图时 selectedLayer 还在，
// upcomingDrawerOpen 会按需重新打开（沿用 onBarLayerClick 路径）。
function onUpcomingRowClick(part: PartListItem): void {
  // 2026-09-30 Phase 2 followup #4：drawer 不再关闭，让用户在下批连续预览图纸时
  // 保持 drawer 上下文。dialog（append-to-body）覆盖在 drawer 之上，关闭 dialog 后
  // drawer 仍可见。
  selectedPart.value = part;
  previewOpen.value = true;
}
</script>

<style lang="scss" scoped>
// 2026-09-29 重做 + 2026-09-30 重构：移除整个 shelves-area / shelf-card / shelf-item /
// 1600/2400 媒体查询，改为办公桌面屏布局（grid 列 + flex 行），gap 12 → 16
// 让三块组件视觉松绑。

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

.dashboard-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-shrink: 0;
}
.header-left {
  display: flex;
  align-items: baseline;
  gap: 12px;
}
.header-greeting {
  font-size: 18px;
  font-weight: 600;
  color: var(--text-primary);
}
.header-date {
  font-size: 13px;
  color: var(--text-secondary);
}
.header-right {
  display: flex;
  gap: 6px;
}

.dashboard-main {
  flex: 1;
  display: grid;
  // 2026-09-30：grid 列比保持 3fr 2fr（用户「6:4」要求），仅改 main 子项 gap
  grid-template-columns: 3fr 2fr;
  gap: 16px;
  min-height: 0;
}
.main-left {
  // 2026-09-30：main-left 三子项之间用 gap 16px 让 Chart / KpiTiles / Strip 视觉松绑
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
  // 2026-09-30 Phase 2 followup #2：Strip 固定占屏幕 20% 高度（与 Chart 各占一半）；
  // min-height: 160px 兜底避免极窄屏塌缩。Strip 内部 worker groups >4 时由
  // FactoryRealtimeStrip 的 <el-carousel> 轮播承载。
  flex: 0 0 20%;
  min-height: 160px;
}
.main-right {
  min-height: 0;
  display: flex;
  flex-direction: column;
}

@media (max-width: 1100px) {
  .dashboard-main {
    grid-template-columns: 1fr;
  }
}
</style>