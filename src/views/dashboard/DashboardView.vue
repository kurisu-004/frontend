<!--
  DashboardView.vue
  2026-09-29 重做：从车间大屏导向（货架轮播 + 工厂实时态）改为办公桌面屏导向
  （未来 7 天交期概览 + 最紧急工单 + 图纸预览）。

  信息架构（自上而下）：
    Header（欢迎语 + 当前日期 + 角色徽章）
    KPI 横排（4 tile：逾期未交 / 今日到期 / 本周到期 / 紧急工单）
    双栏布局：左 UpcomingDeliveryChart，右 UrgentOrdersList
    Footer：FactoryRealtimeStrip（沿旧 in_process 数据，按工人分组 chips）

  数据流：
    - useDashboardSnapshot() → snapshot.upcoming_delivery（7 天分桶）+ in_process
    - useDashboardUrgentList() → items（listUnionItems 拉 100 件非终态件）+ urgentCount
    - useDashboardOverdue(isManager) → overdueCount（Manager-only，闸门按角色）
    - 行点击 emit row-click(part) → 父组件打开 UrgentOrderDrawer
-->
<template>
  <div class="dashboard">
    <!-- Header：欢迎语 + 当前日期 + 角色徽章 -->
    <header class="dashboard-header">
      <div class="header-left">
        <span class="header-greeting">{{ greeting }}，{{ userName }}</span>
        <span class="header-date">{{ todayDisplay }}</span>
      </div>
      <div class="header-right">
        <el-tag v-if="roleTag.label" :type="roleTag.type" size="small" effect="plain">
          {{ roleTag.label }}
        </el-tag>
      </div>
    </header>

    <!-- KPI 横排 -->
    <DashboardKpiTiles
      :manager="isManager"
      :overdue-count="overdueCount"
      :today-count="todayCount"
      :week-count="weekCount"
      :urgent-count="urgentCount"
    />

    <!-- 双栏布局：左 UpcomingDeliveryChart / 右 UrgentOrdersList -->
    <section class="dashboard-main">
      <div class="main-left">
        <UpcomingDeliveryChart :buckets="upcomingBuckets" height="320px" />
      </div>
      <div class="main-right">
        <UrgentOrdersList :items="urgentItems" @row-click="onRowClick" />
      </div>
    </section>

    <!-- Footer：工厂实时态 -->
    <FactoryRealtimeStrip
      :items="inProcessItems"
      :can-open-detail="canOpenPartDetail"
      @item-click="goPartDetail"
    />

    <!-- 抽屉：选中的工单详情 + 图纸 -->
    <UrgentOrderDrawer v-model="drawerVisible" :part="selectedPart" />
  </div>
</template>

<script setup lang="ts">
// 2026-09-29 重做：完全抛弃车间大屏设计，改为办公桌面屏。
//
// 设计要点：
//   - 三个独立 useQuery + 一个共享 WS 事件订阅：
//     * useDashboardSnapshot    → snapshot（upcoming_delivery + in_process）
//     * useDashboardUrgentList  → items（100 件非终态件，按 planned_delivery_date ASC）
//     * useDashboardOverdue     → overdueCount（Manager-only）
//     三个 useQuery 通过 useDashboardInvalidation 复用 AFFECTS_DASHBOARD 事件集 +
//     500ms / 1500ms debounce，避免重复订阅 handler。
//   - 不写 retry：信任 main.ts 全局 queries.retry: 0（沿 2026-09-26 约定）。
//   - 行点击 emit → 父组件管 drawer 开关（UrgentOrderDrawer 是受控组件，
//     v-model + :part）；点击其他区域通过 emit('update:modelValue', false) 关闭。
//
// 跨角色权限：
//   - SHELF_ACCOUNT：isShelfAccount = true → canOpenPartDetail = false → chips 不可点。
//   - MANAGER / CLERK / INSPECTOR / CNC_PROGRAMMER：canOpenPartDetail = true。

import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { usePermissions } from '@/composables/usePermissions';
import type { PartListItem } from '@/types/parts';
import { useDashboardSnapshot } from '@/views/dashboard/composables/useDashboardSnapshot';
import { useDashboardUrgentList } from '@/views/dashboard/composables/useDashboardUrgentList';
import { useDashboardOverdue } from '@/views/dashboard/composables/useDashboardOverdue';
import DashboardKpiTiles from './components/DashboardKpiTiles.vue';
import UpcomingDeliveryChart from './components/UpcomingDeliveryChart.vue';
import UrgentOrdersList from './components/UrgentOrdersList.vue';
import UrgentOrderDrawer from './components/UrgentOrderDrawer.vue';
import FactoryRealtimeStrip from './components/FactoryRealtimeStrip.vue';

const router = useRouter();
const auth = useAuthStore();
const { isManager, isClerk, isInspector, isCncProgrammer } = usePermissions();

/** 2026-09-29 新增：工控机账号（纯 SHELF_ACCOUNT）禁跳详情。 */
const canOpenPartDetail = computed(
  () => isManager.value || isClerk.value || isInspector.value || isCncProgrammer.value,
);

// ============ 数据 ============
const { data: snapshot } = useDashboardSnapshot();
const { items: urgentItems, urgentCount } = useDashboardUrgentList();
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

// ============ 顶部 header 派生 ============
function todayIso(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

const todayDisplay = computed(() => {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  return `${yyyy}-${mm}-${dd} · ${weekdays[d.getDay()]}`;
});

const greeting = computed(() => {
  const h = new Date().getHours();
  if (h < 6) return '凌晨好';
  if (h < 12) return '早上好';
  if (h < 14) return '中午好';
  if (h < 18) return '下午好';
  return '晚上好';
});

const userName = computed(() => auth.user?.full_name ?? auth.user?.username ?? '用户');

const roleTag = computed<{ label: string; type: 'primary' | 'warning' | 'info' }>(() => {
  if (isManager.value) return { label: '管理员', type: 'primary' };
  if (isClerk.value) return { label: '文员', type: 'primary' };
  if (isInspector.value) return { label: '品检员', type: 'warning' };
  if (isCncProgrammer.value) return { label: 'CNC 编程', type: 'info' };
  return { label: '', type: 'info' };
});

// ============ 抽屉 ============
const drawerVisible = ref(false);
const selectedPart = ref<PartListItem | null>(null);

function onRowClick(part: PartListItem): void {
  selectedPart.value = part;
  drawerVisible.value = true;
}

function goPartDetail(partId: string): void {
  if (!canOpenPartDetail.value) return;
  void router.push(`/parts/${partId}`);
}
</script>

<style lang="scss" scoped>
// 2026-09-29 重做：移除整个 shelves-area / shelf-card / shelf-item / 1600/2400
// 媒体查询，改为办公桌面屏布局（grid 列 + flex 行）。

.dashboard {
  display: flex;
  flex-direction: column;
  gap: 12px;
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
  grid-template-columns: 3fr 2fr;
  gap: 12px;
  min-height: 0;
}
.main-left,
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