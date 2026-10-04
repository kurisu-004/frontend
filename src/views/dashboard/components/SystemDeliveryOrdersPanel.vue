<!--
  SystemDeliveryOrdersPanel.vue
  dashboard 右栏两块交期面板的共用展示壳（variant 二选一）：
    - variant="urgent"   「最紧急工单（Top N）」：7 天窗口内**还没交过**的工单
    - variant="partial"  「部分已交（Top N）」：7 天窗口内**已交过一部分**的工单

  两个 variant 的入参 items 都是 useDashboardUrgentList.items 的同一份（零新增请求），
  但**已经过窗口过滤 + 分桶**（`splitForDashboard`），本组件只负责渲染，不再判口径。

  行源（2026-10-05）：t_part 全表行，含装配件的子零件、不含装配件父行，行单位恒「件」
  （与 snapshot 柱状图 `upcoming_delivery[].count` 的 `COUNT(*) FROM t_part` 同口径）。

  行内 6 列 —— 序列号 / 名称 / 数量 / 二级客户 / 状态 / 系统交期：
    - 名称与二级客户两列窄屏下 ellipsis 截断，tooltip 常显兜底（不做溢出检测：
      行高会随内容抖动）。系统交期只出日期；临近橙由 deliveryUrgencyClass 驱动。
      逾期红在本面板恒不出现 —— items 已过窗口下界（每一行 system_delivery_date >=
      today），而 deliveryUrgencyClass 只在 diff < 0 时才给 'overdue'，故样式表里
      没有逾期分支。
    - 数量列：urgent 出纯总量；partial 出「已交 / 总量」，已交部分走主题色，
      并包 el-tooltip 显式标注单位与含义（恒「件」）。
      partial 的两个数字不做静默截断 —— 轨宽按 4 位 ×2 留足，溢出会带省略号可见。

  布局：行宽分三档，用容器查询而非视口媒体查询（见 .list-rows 的 container-type）。
  `.urgent` 红底**只** urgent 变体有 —— 「紧急」语义与 partial 不共表。
-->
<template>
  <el-card shadow="never" class="list-card">
    <template #header>
      <div class="list-header">
        <span class="list-title">
          <el-icon><component :is="titleIcon" /></el-icon>
          <span>{{ titleText }}</span>
        </span>
        <span class="list-subtitle">{{ subtitleText }}</span>
      </div>
    </template>

    <div v-if="displayItems.length === 0" class="list-empty">
      <el-empty :image-size="60" :description="emptyText" />
    </div>

    <div v-else class="list-rows">
      <div
        v-for="item in displayItems"
        :key="item.id"
        :class="['row', { urgent: isUrgentVariant && item.is_urgent }]"
        @click="emit('rowClick', item)"
      >
        <span class="row-serial">{{ item.serial_no ?? '—' }}</span>
        <el-tooltip :content="item.name" placement="top" :show-after="200" :disabled="!item.name">
          <span class="row-name">{{ item.name }}</span>
        </el-tooltip>
        <span v-if="!isPartialVariant" class="row-qty">{{ item.quantity }}</span>
        <el-tooltip
          v-else
          :content="deliveredTooltip(item)"
          placement="top"
          :show-after="200"
        >
          <span class="row-qty row-qty--partial">
            <span class="row-qty-done">{{ item.delivered_quantity ?? 0 }}</span>
            <span class="row-qty-sep">/</span>
            <span>{{ item.quantity }}</span>
          </span>
        </el-tooltip>
        <el-tooltip
          :content="item.customer_name ?? ''"
          placement="top"
          :show-after="200"
          :disabled="!item.customer_name"
        >
          <span class="row-customer">{{ item.customer_name ?? '—' }}</span>
        </el-tooltip>
        <el-tag :type="ORDER_STATUS_TAG_TYPE[item.status]" size="small" effect="plain">
          {{ ORDER_STATUS_LABEL[item.status] }}
        </el-tag>
        <span :class="['row-due', deliveryUrgencyClass(item.system_delivery_date)]">
          {{ formatDeliveryDate(item.system_delivery_date) }}
        </span>
      </div>
    </div>
  </el-card>
</template>

<script setup lang="ts">
// 2026-10-03 新增：dashboard 交期面板展示壳，urgent / partial 两个 variant 共用。
// el-tooltip / el-tag / el-card / el-icon / el-empty 不 import：由 vite.config.ts 的
// unplugin-vue-components + ElementPlusResolver 自动注册（样式同理自动注入）。

import { computed } from 'vue';
import { Bell, GoodsFilled } from '@element-plus/icons-vue';
import { deliveryUrgencyClass, formatDeliveryDate } from '@/utils/deliveryDate';
import {
  ORDER_STATUS_LABEL,
  ORDER_STATUS_TAG_TYPE,
  type PartListItem,
} from '@/types/parts';

const props = withDefaults(
  defineProps<{
    /** 变体：urgent = 最紧急（未交过）；partial = 部分已交。 */
    variant: 'urgent' | 'partial';
    /** 已过窗口过滤 + 分桶的条目（`splitForDashboard` 的某一桶）。 */
    items: PartListItem[];
    limit?: number;
  }>(),
  { limit: 30 },
);

const emit = defineEmits<(e: 'rowClick', part: PartListItem) => void>();

const isPartialVariant = computed(() => props.variant === 'partial');
const isUrgentVariant = computed(() => props.variant === 'urgent');

const titleIcon = computed(() => (isPartialVariant.value ? GoodsFilled : Bell));

/** 展示条数：入参已分桶，这里只做上限截断。 */
const displayItems = computed<PartListItem[]>(() => props.items.slice(0, props.limit));

const titleText = computed(() =>
  isPartialVariant.value
    ? `部分已交（Top ${displayItems.value.length}）`
    : `最紧急工单（Top ${displayItems.value.length}）`,
);
const subtitleText = computed(() =>
  isPartialVariant.value ? '存在已交批次 · 7 天内' : '按系统交期升序 · 7 天内',
);
const emptyText = computed(() =>
  isPartialVariant.value ? '暂无部分已交工单' : '暂无 7 天内紧急工单',
);

/** partial 数量列的 tooltip：显式标注单位与含义。
 *  行源恒为 t_part（row_type=PART_FLAT：含装配件子件、不含装配件父行），故单位恒「件」，
 *  不存在「装配件行按套计」的分支。 */
function deliveredTooltip(item: PartListItem): string {
  return `已送 ${item.delivered_quantity ?? 0} 件 / 总量 ${item.quantity} 件`;
}
</script>

<style lang="scss" scoped>
.list-card {
  background: #fff;
  border-radius: 6px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
  // 依赖父 .main-right 的 flex chain 均分高度（flex: 1 1 0 + min-height 兜底），
  // 不写 height: calc(100vh - ...) 以免高度在多分辨率下退化。
  display: flex;
  flex-direction: column;
  flex: 1 1 0;
  // 160 而非更高的兜底：右栏两卡均分 + 16px gap ⇒ 内容硬地板 = 160×2 + 16 = 336px。
  // 再加 .dashboard 自身的 92px（上下 padding 32 + 行间 gap 16 + KPI 行预留 44；
  // KPI 行实际更高时阈值按比例上移）⇒ 视口高 ≲ 428px 时地板就超出可视区。
  // **双列下没有滚动路径**：.dashboard 是定高 + overflow: hidden，.el-main 拿到的
  // 是定高子元素、永不滚动，超出部分直接被裁掉。.el-main 的纵向滚动兜底只在
  // ≤1100px 的单列分支（.dashboard 改 height: auto）成立。
  min-height: 160px;
  :deep(.el-card__header) {
    padding: 10px 14px;
    background: #fafbfc;
    border-bottom: 1px solid #eee;
    // 头不被两卡均分的 flex 压扁（否则标题行会逐卡矮一截）。
    flex-shrink: 0;
  }
  :deep(.el-card__body) {
    padding: 0;
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }
}
.list-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  width: 100%;
}
.list-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  font-size: 14px;
  color: var(--text-primary);
}
.list-subtitle {
  font-size: 12px;
  color: var(--text-secondary);
}
.list-empty {
  padding: 40px 0;
  display: flex;
  justify-content: center;
}
.list-rows {
  display: flex;
  flex-direction: column;
  // 2026-10-03：行宽分档以「卡片正文宽」为口径，故用容器查询而不是视口媒体查询 ——
  // 同一视口下正文宽还会随左侧栏展开/收起与 1100px 单列折叠变化。
  // 三档与视口的实测对应（侧栏展开 165px、无滚动条占位）：容器 ≤440px ← 视口
  // 1101~1350、441~560px ← 视口 1351~1650、>560px ← 视口 ≥1651；视口 ≤1100 折叠成单列
  // （容器 869px）直接吃满档。经典滚动条平台（.el-card__body overflow-y:auto，30 行时
  // 出滚动条）容器再窄 ~15px，侧栏折叠同理 ⇒ 这几个边界只是路标，档位以容器宽为准。
  container-type: inline-size;
  container-name: sysdeliveryrow;
}
.row {
  display: grid;
  // 2026-10-03：6 列 = 序列号 | 名称 | 数量 | 二级客户 | 状态 | 系统交期。
  // 定宽依据取真实数据：serial_no 恒 5 字符（12px 等宽 = 36px）、二级客户 ≤5 字符、
  // 交期恒 MM/DD（36px）；名称 p90 20 字符，容器 > 560px 时给满 200px。状态列按
  // el-tag--small 最坏宽度定轨（ORDER_STATUS_LABEL 恒 3 个汉字 ≈ 52px）。二级客户吃
  // 剩余空间，窄屏截断由 ellipsis + tooltip 兜。
  //
  // 数量列 80px 的由来（partial 档「已交 / 总量」是最不可截的信息）：三档统一 80px
  // —— urgent 出纯数字用不满，但两 variant 必须同轨，否则同一容器下换 variant 整行
  // 错位。12px 等宽最坏平台 7.2px/字符（SF Mono 0.6em；Consolas 0.55em 更窄），
  // 「1791 / 1791」= 9 字符 + 分隔符两侧各 2px = 68.8px，留 11px 余量（8 字符的
  // 「1791 / 100」= 61.6px 更宽裕）。数量实测可达 4 位（本仓 fixture 即
  // quantity: 1791），要两侧都 5 位（总字符 ≥ 11、≈ 83px）才触 ellipsis —— 故
  // .row-qty--partial 刻意不用 flex，ellipsis 生效时至少是可见截断而非静默切断。
  //
  // 2026-10-03 记账：56→80 的 24px 全部由 1fr（二级客户）让出，本档（>560px）该列
  // 相对上一版均匀少 24px；本档下缘（容器 560.4px，刚越过 560px 分界）1fr =
  // 62.4px，12px 字号仍容 5 个汉字，不产生可见截断。视口 1650→1651 处 1fr 从
  // 154px 掉到 62.4px（上一版 148→86.4px，幅度 61.6px；本版幅度 91.6px），是三档
  // 分档机制的固有产物，不是回归。
  grid-template-columns: 56px 200px 80px minmax(0, 1fr) 56px 56px;
  gap: 6px;
  align-items: center;
  padding: 8px 10px;
  font-size: 13px;
  border-bottom: 1px dashed #f0f0f0;
  cursor: pointer;
  transition: background-color 0.12s;
  &:hover {
    background: #f5f7fa;
  }
  &.urgent {
    background: #fde2e2;
    &:hover {
      background: #fbd7d7;
    }
  }
  &:last-child {
    border-bottom: none;
  }
}
.row-serial,
.row-qty,
.row-due {
  font-family: 'SF Mono', Menlo, Consolas, monospace;
  font-size: 12px;
}
.row-serial {
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.row-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-primary);
}
.row-qty {
  color: var(--text-primary);
  text-align: right;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.row-qty--partial {
  // 刻意**不用** display:flex —— text-overflow: ellipsis 对 flex 容器不生效，溢出
  // 会变成从字符中间静默切断（连省略号都没有），而这一列正是 partial 变体的全部信息。
  // 保持普通 span（.row-qty 的 overflow/ellipsis 直接生效），分隔符间距改用 sep 的
  // margin 表达 —— 视觉与原先 flex + gap: 2px 等价（都是分隔符两侧各 2px）。
  .row-qty-sep {
    margin: 0 2px;
  }
}
.row-qty-done {
  color: var(--primary-color);
  font-weight: 600;
}
.row-qty-sep {
  color: var(--text-secondary);
}
.row-customer {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--primary-color);
  font-size: 12px;
}
.row-due {
  color: var(--text-secondary);
  text-align: right;
  // 2026-10-05：无逾期分支。入参 items 已过交期窗口下界（system_delivery_date >=
  // today），deliveryUrgencyClass 在本面板恒不返 'overdue'，写一条永不命中的规则
  // 只会让后来人以为逾期有配色。逾期件由 KPI「逾期未交」tile 承担。
  &.due-soon {
    color: var(--el-color-warning);
    font-weight: 600;
  }
}
@container sysdeliveryrow (max-width: 560px) {
  .row {
    // 名称列 120px：数量列从 56 加宽到 80 后，本档下缘（容器 441px）留给二级客户的
    // 余量只剩 5px（不足半个汉字）。名称让到 120px（≈9 个汉字，仍短于 p90 20 字符，
    // 靠 tooltip 兜），把二级客户抬回 35px（上一版同点位 29px，本档 1fr 恒 +6px）。
    // 状态列 56px = el-tag--small 最坏宽度 52px + 4px 余量。
    grid-template-columns: 48px 120px 80px minmax(0, 1fr) 56px 52px;
  }
}
@container sysdeliveryrow (max-width: 440px) {
  .row {
    // 极窄档（本档容器对应视口 1101~1350、实测 340~440px；再窄就折叠成单列、
    // 容器 869px 直接吃满档）。名称列取 clamp(48px, 16cqi, 88px)：本档
    // 的宽度预算要同时喂饱 80px 的数量列和 1fr 的二级客户列，名称是三列里唯一
    // 「让位代价最低」的 —— 它截断后有 tooltip，且同一信息在行点击后的
    // PartPreviewDialog 里完整可读。
    //   1fr（二级客户）实测：容器 340（视口 1101）→ 19.9；容器 412（视口 1280）
    //   → 80.1；容器 440（视口 1350）→ 103.6（对应名称列 54.5 / 65.9 / 70.4）。
    //   clamp 上下限本档都取不到，是越界保护。
    // 本档相对上一版是**变宽**的（1fr +11~+19px）：上一版名称列是
    // clamp(76px, 24cqi, 110px)，本版收到 clamp(48px, 16cqi, 88px) 省下的宽度
    // 多过数量列 56→80 吃掉的 24px —— 三档里只有 >560px 那一档的 1fr 变窄。
    // 序列号 40px（5 字符需 36px）/ 交期 44px（MM/DD 需 36px）—— 两列都只比内容
    // 宽几像素，是本档仅剩的余量来源。状态列 52px = el-tag--small 最坏宽度，零余量
    // 但不裁字。
    grid-template-columns: 40px clamp(48px, 16cqi, 88px) 80px minmax(0, 1fr) 52px 44px;
  }
}
</style>
