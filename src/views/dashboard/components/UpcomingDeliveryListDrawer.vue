<!--
  UpcomingDeliveryListDrawer.vue
  2026-09-30 新增：dashboard「7 天交期柱状图按层点击抽屉」。
  沿 UrgentOrderDrawer 范式：<el-drawer direction="rtl" :size="480"
  :with-header="false" :append-to-body="true" :destroy-on-close="true"
  @update:model-value>。v-if="statuses.length > 0" 让 enabled 闸门天然生效。
  Props / Events：
    - modelValue: boolean
    - date: 'YYYY-MM-DD'
    - layer: 'top' | 'middle' | 'bottom'
    - statuses: OrderStatus[]
    - @update:modelValue: 双向同步
  渲染：el-table stripe；列复用 UrgentOrdersList.vue:31-49 字段（序号 / 流水 /
  图号 / 名称 / 客户 / 状态 ElTag / 倒计 chip）；loading / error / empty 三态。
-->
<template>
  <el-drawer
    :model-value="modelValue"
    direction="rtl"
    :size="480"
    :with-header="false"
    :append-to-body="true"
    :destroy-on-close="true"
    @update:model-value="(v) => emit('update:modelValue', v)"
  >
    <div v-if="statuses.length === 0" class="drawer-empty">
      <el-empty :image-size="60" description="该层无状态，请重新点击" />
    </div>

    <div v-else class="drawer-body">
      <!-- 顶部 header：日期 · 层标题 · 状态数 + 关闭按钮 -->
      <div class="drawer-header">
        <div class="header-row-1">
          <span class="header-date">{{ date }}</span>
          <el-tag
            :style="{ backgroundColor: layerColor, borderColor: layerColor, color: '#fff' }"
            size="small"
            effect="dark"
          >
            {{ LAYER_LABEL[layer] }}
          </el-tag>
          <span class="header-status-count">{{ statuses.length }} 状态</span>
        </div>
        <div class="header-row-2">
          <span class="header-total">共 {{ rows.length }} 件</span>
        </div>
        <div class="header-row-3">
          <el-button text size="small" @click="emit('update:modelValue', false)">
            关闭
          </el-button>
        </div>
      </div>

      <!-- 列表 -->
      <div class="drawer-list">
        <el-table
          v-loading="isPending"
          :data="rows"
          stripe
          style="width: 100%"
          empty-text="该日该层无工单"
        >
          <el-table-column type="index" label="#" width="44" />
          <el-table-column prop="serial_no" label="流水" width="92">
            <template #default="{ row }">
              <span class="cell-serial">{{ row.serial_no ?? '—' }}</span>
            </template>
          </el-table-column>
          <el-table-column prop="drawing_no" label="图号" width="96">
            <template #default="{ row }">
              <span class="cell-drawing">{{ row.drawing_no }}</span>
            </template>
          </el-table-column>
          <el-table-column prop="name" label="名称" min-width="120">
            <template #default="{ row }">
              <span class="cell-name" :title="row.name">{{ row.name }}</span>
            </template>
          </el-table-column>
          <el-table-column label="客户" min-width="120">
            <template #default="{ row }">
              <span class="cell-customer" :title="customerPath(row as PartListItem)">
                {{ customerPath(row as PartListItem) || '—' }}
              </span>
            </template>
          </el-table-column>
          <el-table-column prop="status" label="状态" width="86">
            <template #default="{ row }">
              <el-tag :type="ORDER_STATUS_TAG_TYPE[row.status as OrderStatus]" size="small" effect="plain">
                {{ ORDER_STATUS_LABEL[row.status as OrderStatus] }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="倒计" width="84" align="right">
            <template #default="{ row }">
              <span :class="['cell-due', deliveryUrgencyClass(row.planned_delivery_date)]">
                {{
                  deliveryDaysLeftText(row.planned_delivery_date) ||
                    formatDeliveryDate(row.planned_delivery_date)
                }}
              </span>
            </template>
          </el-table-column>
        </el-table>

        <div v-if="error" class="list-error">
          <el-icon color="#f56c6c"><WarningFilled /></el-icon>
          <span>{{ error.message ?? '加载失败' }}</span>
        </div>
      </div>
    </div>
  </el-drawer>
</template>

<script setup lang="ts">
// 2026-09-30 新增：dashboard「7 天交期柱状图按层点击抽屉」展示壳。
//
// 数据流（与 plan §2.3 对齐）：
//   1. props.modelValue=true 时 useDashboardUpcomingList 的 enabled 闸门打开
//      （params getter 返回 { date, statuses } 非 null）；
//   2. params 变化（切层 / 切日期）→ queryKey 变化 → 自动 refetch；
//   3. rows = query.data.items（500 件上限防御性兜底；实际单日 × 8 状态远小于此）。
//
// 视觉：
//   - 顶部 header：日期 + 层标题（el-tag 用项目主色背景）+ 状态数 + 共 N 件 + 关闭按钮
//   - 列表：el-table stripe；列复用 UrgentOrdersList.vue:31-49 字段
//   - loading / error / empty 三态
//   - v-if="statuses.length === 0" 兜底：父组件 onBarLayerClick 写入后 statuses
//     一定有元素；此处防御 props 异常时给空状态提示。

import { computed, toValue } from 'vue';
import { WarningFilled } from '@element-plus/icons-vue';
import { useDashboardUpcomingList } from '@/views/dashboard/composables/useDashboardUpcomingList';
import {
  deliveryDaysLeftText,
  deliveryUrgencyClass,
  formatDeliveryDate,
} from '@/utils/deliveryDate';
import {
  ORDER_STATUS_LABEL,
  ORDER_STATUS_TAG_TYPE,
  type OrderStatus,
  type PartListItem,
} from '@/types/parts';

const props = defineProps<{
  modelValue: boolean;
  date: string;
  layer: 'top' | 'middle' | 'bottom';
  statuses: readonly OrderStatus[];
}>();

const emit = defineEmits<(e: 'update:modelValue', v: boolean) => void>();

/** 2026-09-30 新增：层标签映射（与 UpcomingDeliveryChart.LAYERS.label 对齐）。 */
const LAYER_LABEL: Record<'top' | 'middle' | 'bottom', string> = {
  top: '品检前',
  middle: '待品检/待送货',
  bottom: '已送货',
};

/** 2026-09-30 新增：层颜色映射（与 UpcomingDeliveryChart.LAYERS.color 对齐，
 *  顶部 header 标签背景色取此）。 */
const LAYER_COLOR: Record<'top' | 'middle' | 'bottom', string> = {
  top: '#1e4d8b',
  middle: '#2c6cb8',
  bottom: '#4a8fd6',
};

const layerColor = computed(() => LAYER_COLOR[props.layer]);

/** 2026-09-30 新增：params getter —— 仅 drawer 打开时返回非 null 让闸门打开；
 *  关闭（modelValue=false）时返回 null 停 fetch，与 enabled 闸门语义对齐。 */
const params = computed(() => {
  if (!props.modelValue) return null;
  if (props.statuses.length === 0) return null;
  return { date: props.date, statuses: [...props.statuses] as OrderStatus[] };
});

const { data: rows, isPending, error } = useDashboardUpcomingList(() => toValue(params));

/** 2026-09-30 新增：客户路径展示 —— l1_customer_name + customer_name（如有）。 */
function customerPath(item: PartListItem): string {
  const l1 = item.l1_customer_name ?? '';
  const cur = item.customer_name ?? '';
  if (l1 && cur && l1 !== cur) return `${l1} / ${cur}`;
  return cur || l1;
}
</script>

<style lang="scss" scoped>
.drawer-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
}
.drawer-body {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.drawer-header {
  padding: 16px 18px 12px;
  border-bottom: 1px solid #eee;
  background: #fafbfc;
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex-shrink: 0;
}
.header-row-1 {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.header-date {
  font-family: 'SF Mono', Menlo, Consolas, monospace;
  font-weight: 600;
  font-size: 13px;
  color: var(--text-primary);
}
.header-status-count {
  font-size: 12px;
  color: var(--text-secondary);
}
.header-row-2 {
  display: flex;
  align-items: baseline;
  gap: 6px;
}
.header-total {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}
.header-row-3 {
  display: flex;
  justify-content: flex-end;
}
.drawer-list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 8px 4px 12px;
}
.cell-serial,
.cell-drawing {
  font-family: 'SF Mono', Menlo, Consolas, monospace;
  font-weight: 600;
  font-size: 12px;
  color: var(--text-primary);
}
.cell-name,
.cell-customer {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-primary);
}
.cell-customer {
  color: var(--primary-color);
  font-size: 12px;
}
.cell-due {
  font-size: 12px;
  color: var(--text-secondary);
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
.list-error {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 16px;
  font-size: 13px;
  color: var(--el-color-danger);
}
</style>