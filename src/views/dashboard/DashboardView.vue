<!--
  DashboardView.vue
  dashboard 顶层视图：KPI 横排 + 双栏（左 交期分桶柱状图，右 两块交期工单面板）。
  组件自身不持数据，全部由 composables 提供。

  布局：
    - KPI 横排（DashboardKpiTiles，5 tile：逾期未交 / 今日到期 / N 天到期 / 在加工 / 在检）
    - 双栏：左 UpcomingDeliveryChart + FactoryRealtimeStrip，右 SystemDeliveryOrdersPanel ×2
      （variant=urgent 最紧急工单 / variant=partial 部分已交）
    - 视口 ≤1100px 折叠成单列

  数据流（两个 HTTP 请求 + 一个共享 WS 事件订阅）：
    - useDashboardSnapshot() → snapshot：逾期未交 KPI / 在加工 KPI / 在检 KPI /
      工厂实时态 chips / 右栏两块交期面板。**无口径概念** —— 分桶已拆到独立端点，
      故切口径 / 切天数不会换它的键，与口径无关的四个 KPI 也不会跟着闪空。
    - useDashboardUpcoming(deliveryBasis, deliveryDays) → 分桶 + 后端判定的 today：
      柱状图数据源，也是「今日到期 / N 天到期」两个 KPI 的派生来源（柱状图与 KPI
      读同一份 buckets，口径天然一致，不存在两个数互相矛盾）。
    - 交期统计口径（deliveryBasis，缺省 system）与窗口天数（deliveryDays，缺省 14）
      是全页唯二的可变入参，一处改动、三处消费：柱状图分桶请求、柱状图开关 / 天数
      选择器、下钻抽屉的 basis 快照。切口径 / 切天数时 useDashboardUpcoming 换键占位
      （keepPreviousData），isPlaceholderData 经 `:stale` 下发给柱状图出「数字还不是
      当前口径」提示层，同时挡住柱子点击（拿旧日期 + 新口径去查会数据错位）。
    - 行点击 → selectedPart + previewOpen 走 PartPreviewDialog（统一入口）

  2026-10-03 新增右栏第二块面板「部分已交」：.main-right 两卡均分高度
  （flex: 1 1 0 + min-height 兜底），面板头 flex-shrink: 0 防被压扁。
  两卡 min-height 各 160px ⇒ 右栏内容硬地板 160×2 + 16 gap = 336px；加上
  .dashboard 自身的 92px（上下 padding 32 + 行间 gap 16 + KPI 行预留 44；KPI 行
  实际更高时阈值按比例上移），视口高 ≲ 428px 时地板会超出可视区。
  兜底只在单列分支成立：≤1100px 时 .dashboard 改 height: auto，超出部分由外层
  .el-main 纵向滚动（MainLayout 的 .main-content 带 overflow: auto）；**双列下没有
  滚动路径** —— .dashboard 是定高 + overflow: hidden，.el-main 拿到的是定高子元素、
  永不滚动，超出部分直接被裁掉。
-->
<template>
  <div class="dashboard">
    <!-- 双栏布局：左 柱状图 + 实时态 / 右 两块交期工单面板 -->
    <section class="dashboard-main">
      <div class="main-left">
        <!-- KPI 横排（5 tile） -->
        <DashboardKpiTiles
          :overdue-count="overdueCount"
          :today-count="todayCount"
          :window-count="windowCount"
          :days="deliveryDays"
          :in-process-count="inProcessCount"
          :in-inspection-count="inInspectionCount"
        />
        <UpcomingDeliveryChart
          :buckets="upcomingBuckets"
          :basis="deliveryBasis"
          :days="deliveryDays"
          :today="upcomingToday"
          :stale="upcomingStale"
          height="100%"
          @update:basis="deliveryBasis = $event"
          @update:days="deliveryDays = $event"
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
      :basis="selectedLayer.basis"
      @row-click="onUpcomingRowClick"
    />
  </div>
</template>

<script setup lang="ts">
// dashboard 顶层视图的编排：两个独立 useQuery + 一个共享 WS 事件订阅，通过
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
import type { OrderStatus } from '@/types/parts';
import type { DeliveryBasis, PartPreviewTarget } from '@/types/dashboard';
import { useDashboardSnapshot } from '@/views/dashboard/composables/useDashboardSnapshot';
import { useDashboardUpcoming } from '@/views/dashboard/composables/useDashboardUpcoming';
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

// ============ 交期统计口径 + 窗口天数 ============
// 全页唯二的可变入参。不做 localStorage 持久化 —— 每次进页面回落缺省值，避免上次口径
// 成为隐性默认、用户对着与预期不符的数字做判断。切任一个都只改这一个 ref：
//   - useDashboardUpcoming 的 queryKey（含 basis + days）→ 换键自动 refetch 新数据；
//   - UpcomingDeliveryChart 的开关 / 天数选择器选中态（受控 props）；
//   - selectedLayer.basis → 抽屉下钻的统计口径。
// KPI（今日到期 / N 天到期）从同一份 buckets 派生，故无需改动即自动跟随口径。
//
// 口径缺省 system（系统交期）：右栏两块交期面板恒为系统交期语义，缺省口径若选
// planned 会让 KPI 与同页右栏在首次进入时说两个口径的数字。
const deliveryBasis = ref<DeliveryBasis>('system');
/** 柱状图窗口天数（后端 clamp 1..60）。列进 KPI 标签（`N 天到期`）与柱状图分桶。 */
const deliveryDays = ref(14);

// ============ 数据 ============
// upcomingStale = useDashboardUpcoming 的 isPlaceholderData，即「换键占位中，图上数字
// 还是上一份（口径 / 天数）」。不用 isFetching：同键后台 refetch（WS 事件驱动的周期性
// 刷新）也会让它为 true，而那时图上数字是当前且正确的，不该提示。
const { data: snapshot } = useDashboardSnapshot();
const { data: upcoming, isPlaceholderData: upcomingStale } = useDashboardUpcoming(
  () => deliveryBasis.value,
  () => deliveryDays.value,
);

/** 后端判定的「今天」（'YYYY-MM-DD'）。前端一律用它，不再 new Date()。
 *  首帧 `upcoming` 尚未落地时为空串：柱状图据此渲染空坐标轴（不造假柱），
 *  「今日到期」取不到桶即 0。 */
const upcomingToday = computed<string>(() => upcoming.value?.today ?? '');

/** 交期分桶（来自端点 2，可能为空数组）。 */
const upcomingBuckets = computed(() => upcoming.value?.buckets ?? []);

/** 工人在手加工批次（来自 snapshot.in_process，chips 用）。 */
const inProcessItems = computed(() => snapshot.value?.in_process ?? []);

/** 右栏两块面板的分桶（服务端已按窗口 + 「有无已交」分好并各截断 30 行，零新增请求、
 *  零前端过滤）。交付动作发 PART_DELIVERED（已在本域 AFFECTS_DASHBOARD 事件集内）
 *  → 自动失效重取。 */
const deliveryBuckets = computed(() => snapshot.value?.system_delivery_orders ?? { urgent: [], partial: [] });

// ============ KPI 派生 ============
const overdueCount = computed<number>(() => snapshot.value?.overdue_count ?? 0);

/** 今日到期 = 首桶 count。「首桶即今天」不是口头约定：
 *  `upcomingBucketsSchema` 的末位 refine 在 queryFn 守门处强制 today === buckets[0].date，
 *  后端漂了会抛错而不是让这个 KPI 静默显示错日的数字。 */
const todayCount = computed<number>(() => upcomingBuckets.value[0]?.count ?? 0);

/** 窗口内到期：全 N 天桶 count 之和（非按某个自然周切）。 */
const windowCount = computed<number>(() =>
  upcomingBuckets.value.reduce((sum, b) => sum + (b.count || 0), 0),
);

/** 在加工件数 = 工人在手加工批次数（snapshot.in_process.length）。 */
const inProcessCount = computed<number>(() => snapshot.value?.in_process.length ?? 0);

/** 在检件数 = 品检区待品检批次数（服务端 COUNT，snapshot.in_inspection_count）。 */
const inInspectionCount = computed<number>(() => snapshot.value?.in_inspection_count ?? 0);

// ============ 预览对话框 ============
// 两条路径（右栏两面板行点击 + UpcomingDeliveryListDrawer 行点击）都进
// PartPreviewDialog，行为统一：selectedPart.value = part; previewOpen.value = true。
// PartPreviewDialog 只读 4 个字段（id / serial_no / name / status），故 selectedPart
// 用 PartPreviewTarget 这个最小结构 —— 三条路径的行类型各不相同
// （WorkerHeldBatchData / SystemDeliveryOrderData / DeliveryOrderDetailData），
// 收成最小公共结构比让弹窗去认某个具体 VO 更稳。
const previewOpen = ref(false);
const selectedPart = ref<PartPreviewTarget | null>(null);

function onRowClick(part: PartPreviewTarget): void {
  selectedPart.value = part;
  previewOpen.value = true;
}

function goPartDetail(partId: string): void {
  if (!canOpenPartDetail.value) return;
  void router.push(`/parts/${partId}`);
}

// ============ 交期柱状图按层点击 ============
// selectedLayer 持有 { date, layer, statuses, basis } 四元组，v-if="selectedLayer" 保证
// drawer 在首次点击前不挂载（useDashboardDeliveryOrders 的 enabled 闸门天然生效）。
// basis 随点击时的口径**快照**进 selectedLayer：抽屉打开后用户再切图上的开关，
// 已打开的抽屉不会被就地改口径（那会让「点的是 A 柱、列表变成 B 口径」在半途发生）；
// 下次点柱才带新口径。
const upcomingDrawerOpen = ref(false);
const selectedLayer = ref<{
  date: string;
  layer: 'top' | 'middle' | 'bottom';
  statuses: readonly OrderStatus[];
  basis: DeliveryBasis;
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
    basis: deliveryBasis.value,
  };
  upcomingDrawerOpen.value = true;
}

// 两 drawer/dialog 协调逻辑全在本函数，UpcomingDeliveryListDrawer 只 emit
// rowClick(part)，不感知 PartPreviewDialog 存在。drawer 不关闭 —— dialog
// （append-to-body）覆盖在 drawer 之上，关掉 dialog 后 drawer 仍可见，方便连续预览。
// 不重置 selectedLayer：下次用户再点柱状图时 upcomingDrawerOpen 按需重新打开。
function onUpcomingRowClick(part: PartPreviewTarget): void {
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
    // 单列下两块内容纵向堆叠，总高必然超过一屏 —— 改为内容撑高，滚动交给外层
    // .el-main（MainLayout 的 .main-content 带 overflow: auto）。保持「定高 +
    // overflow: hidden」会把第二行整块裁掉；这里也不能自己再挂 overflow-y，
    // auto 高度的盒子上它是永不触发的死规则，留着只会让「谁在滚」读起来含混。
    height: auto;
    min-height: calc(100vh - 60px);
  }
  .dashboard-main {
    // 撑高必须显式解掉 flex 压缩：默认 flex: 1（= 1 1 0%），在 height: auto 的
    // flex 容器里 flex-basis 0 会让它的高度退化成 min-height（0），内容被压扁、
    // 「撑高」名不副实。
    flex: 0 0 auto;
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
