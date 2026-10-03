<!--
  SystemDeliveryOrdersPanel.vue
  dashboard 右栏两块交期面板的共用展示壳（variant 二选一）：
    - variant="urgent"   「最紧急工单（Top N）」：7 天窗口内**还没交过**的工单
    - variant="partial"  「部分已交（Top N）」：7 天窗口内**已交过一部分**的工单

  两个 variant 的入参 items 都是 useDashboardUrgentList.items 的同一份（零新增请求），
  但**已经过窗口过滤 + 分桶**（`splitForDashboard`），本组件只负责渲染，不再判口径。

  行内 6 列 —— 序列号 / 名称 / 数量 / 二级客户 / 状态 / 系统交期：
    - 名称与二级客户两列窄屏下 ellipsis 截断，tooltip 常显兜底（不做溢出检测：
      行高会随内容抖动）。系统交期只出日期，逾期红 / 临近橙仍由 deliveryUrgencyClass 驱动。
    - 数量列：urgent 出纯总量；partial 出「已交 / 总量」，已交部分走主题色，
      并包 el-tooltip 显式标注单位与含义（装配件行「套」、零件行「件」）。

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
 *  装配件行的数量单位是「套」、零件行是「件」，两者不可混用同单位文案。 */
function deliveredTooltip(item: PartListItem): string {
  const unit = item.row_type === 'ASSEMBLY' ? '套' : '件';
  return `已送 ${item.delivered_quantity ?? 0} ${unit} / 总量 ${item.quantity} ${unit}`;
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
  min-height: 200px;
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
  // 定宽依据取真实数据：serial_no 恒 5 字符、二级客户 ≤5 字符、交期恒 MM/DD；
  // 名称 p90 20 字符，容器 > 560px 时给满 200px。数量列三档统一 56px —— partial 变体
  // 渲染「20 / 64」需要 ~36px，urgent 变体的纯数字用不满但两 variant 必须同轨，否则
  // 同一容器下换 variant 整行错位。多出的宽度由二级客户列的 minmax(0, 1fr) 吸收。
  // 状态列按 el-tag--small 最坏宽度定轨（ORDER_STATUS_LABEL 恒 3 个汉字 ≈ 52px），
  // 本档留 4px 余量。二级客户吃剩余空间，窄屏截断由 ellipsis + tooltip 兜。
  grid-template-columns: 56px 200px 56px minmax(0, 1fr) 56px 56px;
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
  display: flex;
  justify-content: flex-end;
  align-items: baseline;
  gap: 2px;
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
  &.overdue {
    color: var(--el-color-danger);
    font-weight: 600;
  }
  &.due-soon {
    color: var(--el-color-warning);
    font-weight: 600;
  }
}
@container sysdeliveryrow (max-width: 560px) {
  .row {
    // 状态列 56px：el-tag 无 overflow，轨宽不得小于其最坏宽度 52px，留 4px 余量。
    grid-template-columns: 48px 150px 56px minmax(0, 1fr) 56px 52px;
  }
}
@container sysdeliveryrow (max-width: 440px) {
  .row {
    // 2026-10-03：极窄档名称列让出宽度给二级客户，取 clamp(76px, 24cqi, 110px)。
    // 本档容器实测 340~440px，24cqi 即 82~106px —— 两端 clamp 上下限是越界保护，
    // 本档取不到。状态列 52px = el-tag--small 最坏宽度（3 个汉字：36+7×2+1×2），
    // 零余量但不裁字。
    grid-template-columns: 44px clamp(76px, 24cqi, 110px) 56px minmax(0, 1fr) 52px 48px;
  }
}
</style>
