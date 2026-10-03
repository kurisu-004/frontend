<!--
  UrgentOrdersList.vue
  2026-10-03 调整：行内 6 列 —— 序列号 / 名称(200px，el-tooltip 兜截断) / 数量 /
  二级客户 / 状态(ElTag) / 系统交期(MM/DD)。名称与二级客户两列窄屏下会 ellipsis
  截断，tooltip 常显兜底（不做溢出检测：行高会随内容抖动）。系统交期只出日期，
  逾期红 / 临近橙的配色仍由 deliveryUrgencyClass 驱动。
  - 行宽分三档，用容器查询而非视口媒体查询（见 .list-rows 的 container-type）
  - 紧急行底色 #fde2e2
  - 行可点 → emit rowClick(item)，由父组件管 PartPreviewDialog 开关

  数据来源：useDashboardUrgentList.items（100 件非终态件，后端已按
  system_delivery_date ASC 排序）。本组件内客户端过滤 7 天窗口 + slice(0, limit)。
-->
<template>
  <el-card shadow="never" class="list-card">
    <template #header>
      <div class="list-header">
        <span class="list-title">
          <el-icon><Bell /></el-icon>
          <span>最紧急工单（Top {{ displayItems.length }}）</span>
        </span>
        <span class="list-subtitle">按系统交期升序 · 7 天内</span>
      </div>
    </template>

    <div v-if="displayItems.length === 0" class="list-empty">
      <el-empty :image-size="60" description="暂无 7 天内紧急工单" />
    </div>

    <div v-else class="list-rows">
      <div
        v-for="item in displayItems"
        :key="item.id"
        :class="['row', { urgent: item.is_urgent }]"
        @click="emit('rowClick', item)"
      >
        <span class="row-serial">{{ item.serial_no ?? '—' }}</span>
        <el-tooltip :content="item.name" placement="top" :show-after="200" :disabled="!item.name">
          <span class="row-name">{{ item.name }}</span>
        </el-tooltip>
        <span class="row-qty">{{ item.quantity }}</span>
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
// 2026-10-03 调整：dashboard「紧急工单」列表展示壳，6 列（见文件头注释）。
// el-tooltip 不 import：由 vite.config.ts 的 unplugin-vue-components +
// ElementPlusResolver 自动注册（样式同理自动注入）。

import { computed } from 'vue';
import { Bell } from '@element-plus/icons-vue';
import { deliveryUrgencyClass, formatDeliveryDate } from '@/utils/deliveryDate';
import {
  ORDER_STATUS_LABEL,
  ORDER_STATUS_TAG_TYPE,
  type PartListItem,
} from '@/types/parts';

const props = withDefaults(
  defineProps<{
    items: PartListItem[];
    limit?: number;
  }>(),
  { limit: 30 },
);

const emit = defineEmits<(e: 'rowClick', part: PartListItem) => void>();

/** today+6 ISO（'YYYY-MM-DD'）作为过滤上限。 */
function cutoffIso(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 6);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

const displayItems = computed<PartListItem[]>(() => {
  const cutoff = cutoffIso();
  return props.items
    .filter((p) => {
      if (!p.system_delivery_date) return false;
      return p.system_delivery_date <= cutoff;
    })
    .slice(0, props.limit);
});
</script>

<style lang="scss" scoped>
.list-card {
  background: #fff;
  border-radius: 6px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
  // 依赖父 .main-right 的 flex chain 自动撑满一屏高度（flex: 1; min-height: 0），
  // 不写 height: calc(100vh - ...) 以免高度在多分辨率下退化。
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  :deep(.el-card__header) {
    padding: 10px 14px;
    background: #fafbfc;
    border-bottom: 1px solid #eee;
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
  container-type: inline-size;
  container-name: urgentrow;
}
.row {
  display: grid;
  // 2026-10-03：6 列 = 序列号 | 名称 | 数量 | 二级客户 | 状态 | 系统交期。
  // 定宽依据取真实数据（100 行 / 7 天窗口）：serial_no 恒 5 字符、quantity ≤4 位、
  // 二级客户 ≤5 字符、交期恒 MM/DD；名称 p90 20 字符，容器 ≥560px 时给满 200px。
  // 二级客户吃剩余空间（minmax(0, 1fr)），窄屏截断由 ellipsis + tooltip 兜。
  grid-template-columns: 56px 200px 40px minmax(0, 1fr) 56px 56px;
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
@container urgentrow (max-width: 560px) {
  .row {
    grid-template-columns: 48px 150px 36px minmax(0, 1fr) 52px 52px;
  }
}
@container urgentrow (max-width: 440px) {
  .row {
    // 24cqi：容器 342px 时约 82px、容器 440px 时封顶 110px，名称列在极窄档
    // 让出宽度给二级客户。
    grid-template-columns: 44px clamp(76px, 24cqi, 110px) 32px minmax(0, 1fr) 48px 48px;
  }
}
</style>
