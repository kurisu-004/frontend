<!--
  UrgentOrdersList.vue
  2026-09-29 新增：dashboard「紧急工单 Top 15」列表。

  数据来源：useDashboardUrgentList.items（listUnionItems 拉的 100 件非终态工件
  按 planned_delivery_date ASC）。本组件内客户端二次过滤 + slice(0,15)。

  视觉：
    - 紧急行底色 #fde2e2 沿用旧 DashboardItemData.urgent 约定
    - 序号 / 图号 / 名称 / 客户 / 状态（ElTag）/ 倒计 chip（deliveryDaysLeftText
      + deliveryUrgencyClass）
    - 行可点 → emit row-click(item) 给父组件管 drawer 开关
-->
<template>
  <el-card shadow="never" class="list-card">
    <template #header>
      <div class="list-header">
        <span class="list-title">
          <el-icon><Bell /></el-icon>
          <span>最紧急工单（Top {{ displayItems.length }}）</span>
        </span>
        <span class="list-subtitle">按计划交期升序 · 7 天内</span>
      </div>
    </template>

    <div v-if="displayItems.length === 0" class="list-empty">
      <el-empty :image-size="60" description="暂无 7 天内紧急工单" />
    </div>

    <div v-else class="list-rows">
      <div
        v-for="(item, idx) in displayItems"
        :key="item.id"
        :class="['row', { urgent: item.is_urgent }]"
        @click="emit('rowClick', item)"
      >
        <span class="row-index">{{ idx + 1 }}</span>
        <span class="row-serial" :title="item.serial_no ?? '—'">{{ item.serial_no ?? '—' }}</span>
        <span class="row-drawing" :title="item.drawing_no">{{ item.drawing_no }}</span>
        <span class="row-name" :title="item.name">{{ item.name }}</span>
        <span class="row-customer" :title="customerPath(item)">{{ customerPath(item) || '—' }}</span>
        <el-tag :type="ORDER_STATUS_TAG_TYPE[item.status]" size="small" effect="plain">
          {{ ORDER_STATUS_LABEL[item.status] }}
        </el-tag>
        <span :class="['row-due', deliveryUrgencyClass(item.planned_delivery_date)]">
          {{ deliveryDaysLeftText(item.planned_delivery_date) || formatDeliveryDate(item.planned_delivery_date) }}
        </span>
      </div>
    </div>
  </el-card>
</template>

<script setup lang="ts">
// 2026-09-29 新增：dashboard「紧急工单 Top 15」列表展示壳。
//
// 验收（与方案 §2 对齐）：
//   - 取 items.filter(p => p.planned_delivery_date <= today+7).slice(0, 15)
//   - 紧急行底色 #fde2e2（与旧 DashboardItemData.urgent 约定一致）
//   - 倒计 chip 走 src/utils/deliveryDate.ts 的 deliveryDaysLeftText /
//     deliveryUrgencyClass（已有 35-72 行 helpers）
//   - emit row-click(part) 给父组件管 drawer 开关
//
// 客户端过滤口径：
//   today = 本地 0 点；planned_delivery_date（'YYYY-MM-DD'）≤ today+6（即 7 天窗口内）
//   排序已在后端走 planned_delivery_date ASC，前端只过滤 + slice，不重排。
// 7 天窗口之外的件在 dashboard 顶视图不展示（详情页另行处理）。

import { computed } from 'vue';
import { Bell } from '@element-plus/icons-vue';
import {
  deliveryDaysLeftText,
  deliveryUrgencyClass,
  formatDeliveryDate,
} from '@/utils/deliveryDate';
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
  { limit: 15 },
);

const emit = defineEmits<(e: 'rowClick', part: PartListItem) => void>();

/** 2026-09-29 新增：today+6 ISO（'YYYY-MM-DD'）作为过滤上限。 */
function cutoffIso(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 6);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/** 2026-09-29 新增：客户路径展示 —— l1_customer_name + customer_name（如有）。 */
function customerPath(item: PartListItem): string {
  const l1 = item.l1_customer_name ?? '';
  const cur = item.customer_name ?? '';
  if (l1 && cur && l1 !== cur) return `${l1} / ${cur}`;
  return cur || l1;
}

/** 2026-09-29 新增：客户端过滤 + slice。props.items 已按 planned_delivery_date ASC
 * 排序，前端只过滤 7 天窗口内 + top N。 */
const displayItems = computed<PartListItem[]>(() => {
  const cutoff = cutoffIso();
  return props.items.filter((p) => {
    if (!p.planned_delivery_date) return false;
    return p.planned_delivery_date <= cutoff;
  }).slice(0, props.limit);
});
</script>

<style lang="scss" scoped>
.list-card {
  background: #fff;
  border-radius: 6px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
  display: flex;
  flex-direction: column;
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
}
.row {
  display: grid;
  // 序号 | 流水 | 图号 | 名称 | 客户 | 状态 | 倒计
  grid-template-columns: 28px 88px 92px 1.2fr 1fr 80px 92px;
  gap: 8px;
  align-items: center;
  padding: 8px 14px;
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
.row-index {
  font-size: 12px;
  color: var(--text-secondary);
  text-align: center;
}
.row-serial,
.row-drawing {
  font-family: 'SF Mono', Menlo, Consolas, monospace;
  font-weight: 600;
  font-size: 12px;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.row-name,
.row-customer {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-primary);
}
.row-customer {
  color: var(--primary-color);
  font-size: 12px;
}
.row-due {
  font-size: 12px;
  color: var(--text-secondary);
  text-align: right;
  font-family: 'SF Mono', Menlo, Consolas, monospace;
  &.overdue {
    color: var(--el-color-danger);
    font-weight: 600;
  }
  &.due-soon {
    color: var(--el-color-warning);
    font-weight: 600;
  }
}
</style>
