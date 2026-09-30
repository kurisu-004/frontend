<!--
  UrgentOrdersList.vue
  2026-09-29 新增：dashboard「紧急工单 Top 15」列表。
  2026-09-30 调整：列重排（一级 / 二级客户双列 + 删除「流水」「图号」两列） + 倒计 chip
  改用 system_delivery_date（沿 useDashboardUrgentList.sort_by=SYSTEM_DELIVERY_DATE）。
  - 紧急行底色 #fde2e2 沿用旧 DashboardItemData.urgent 约定
  - 行：序号 / 名称 / 一级客户 / 二级客户 / 状态（ElTag）/ 倒计 chip（system_delivery_date）
  - 行可点 → emit row-click(item) 给父组件管 dialog 开关（PartPreviewDialog）

  数据来源：useDashboardUrgentList.items（listUnionItems 拉的 100 件非终态工件
  按 system_delivery_date ASC）。本组件内客户端二次过滤 + slice(0,15)。
-->
<template>
  <el-card shadow="never" class="list-card">
    <template #header>
      <div class="list-header">
        <span class="list-title">
          <el-icon><Bell /></el-icon>
          <span>最紧急工单（Top {{ displayItems.length }}）</span>
        </span>
        <!-- 2026-09-30：subtitle 同步切到「系统交期」表述，与后端 sort_by 对齐 -->
        <span class="list-subtitle">按系统交期升序 · 7 天内</span>
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
        <span class="row-name" :title="item.name">{{ item.name }}</span>
        <!-- 2026-09-30：客户拆双列（一级 / 二级），分别取 l1_customer_name / customer_name -->
        <span class="row-customer-l1" :title="item.l1_customer_name ?? '—'">
          {{ item.l1_customer_name ?? '—' }}
        </span>
        <span class="row-customer-l2" :title="item.customer_name ?? '—'">
          {{ item.customer_name ?? '—' }}
        </span>
        <el-tag :type="ORDER_STATUS_TAG_TYPE[item.status]" size="small" effect="plain">
          {{ ORDER_STATUS_LABEL[item.status] }}
        </el-tag>
        <!-- 2026-09-30：倒计 chip 由 planned_delivery_date 改为 system_delivery_date -->
        <span :class="['row-due', deliveryUrgencyClass(item.system_delivery_date)]">
          {{
            deliveryDaysLeftText(item.system_delivery_date) ||
              formatDeliveryDate(item.system_delivery_date)
          }}
        </span>
      </div>
    </div>
  </el-card>
</template>

<script setup lang="ts">
// 2026-09-29 新增 + 2026-09-30 调整：dashboard「紧急工单 Top 15」列表展示壳。
//
// 验收（与方案 §2 对齐）：
//   - 取 items.filter(p => p.system_delivery_date <= today+7).slice(0, 15)
//   - 紧急行底色 #fde2e2（与旧 DashboardItemData.urgent 约定一致）
//   - 倒计 chip 走 src/utils/deliveryDate.ts 的 deliveryDaysLeftText /
//     deliveryUrgencyClass（已有 35-72 行 helpers）
//   - emit row-click(part) 给父组件管 dialog 开关（dashboard 双路径都进
//     PartPreviewDialog，沿 plan §1.7）
//
// 客户端过滤口径：
//   today = 本地 0 点；system_delivery_date（'YYYY-MM-DD'）≤ today+6（即 7 天窗口内）
//   排序已在后端走 system_delivery_date ASC，前端只过滤 + slice，不重排。
//   7 天窗口之外的件在 dashboard 顶视图不展示（详情页另行处理）。

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

/** 2026-09-30 调整：客户端过滤改为 system_delivery_date；后端 sort 已保证
 *  system_delivery_date ASC，前端只过滤 7 天窗口内 + top N。 */
const displayItems = computed<PartListItem[]>(() => {
  const cutoff = cutoffIso();
  return props.items.filter((p) => {
    if (!p.system_delivery_date) return false;
    return p.system_delivery_date <= cutoff;
  }).slice(0, props.limit);
});
</script>

<style lang="scss" scoped>
.list-card {
  background: #fff;
  border-radius: 6px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
  // 2026-09-30：依赖父 .main-right 的 flex chain 自动撑满一屏高度
  // （flex: 1; min-height: 0），不要再写 height: calc(100vh - ...) 让高度在
  // dashboard 多分辨率下退化。
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
}
.row {
  display: grid;
  // 2026-09-30：列重排为 序号 | 名称 | 一级客户 | 二级客户 | 状态 | 倒计
  grid-template-columns: 28px 1.4fr 1fr 1fr 86px 96px;
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
.row-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-primary);
}
.row-customer-l1,
.row-customer-l2 {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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