<!--
  UpcomingDeliveryListDrawer.vue
  2026-09-30 新增：dashboard「7 天交期柱状图按层点击抽屉」。
  沿 UrgentOrderDrawer 范式：<el-drawer direction="rtl" :size="480"
  :with-header="false" :append-to-body="true" :destroy-on-close="true"
  @update:model-value>。
  Props / Events：
    - modelValue: boolean
    - date: 'YYYY-MM-DD'
    - layer: 'top' | 'middle' | 'bottom'
    - statuses: OrderStatus[]
    - @update:modelValue: 双向同步
  渲染：el-table stripe；字段与 UrgentOrdersList 对齐；loading / error / empty 三态。
  闸门：父组件 DashboardView `v-if="selectedLayer"` 保证 drawer 首次点击前不挂载，
  useDashboardUpcomingList 的 enabled 闸门天然生效；drawer 自身
  `v-if="statuses.length === 0"` 是 props 异常兜底。

  2026-09-30（Phase 5）改 btt + 行点击 emit：
    - direction: 'rtl' → 'btt'（bottom-to-top），:size 480 → 60%：让抽屉从屏幕底部
      弹出，水平宽度撑满，最大高度 60%，与下方 dashboard 双栏布局配合更顺（用户
      点柱状图看到的是"目标日期的工单清单"，横向表格能展示更全列）。
    - 2026-09-30 调整：LAYER_COLOR 同步 EP 预设 hex（success #67c23a / warning
      #e6a23c / danger #f56c6c），与 UpcomingDeliveryChart.LAYERS.color 保持一致。
    - 新增 emit('rowClick', part)：用户在抽屉行点击 → 父组件 DashboardView 关闭
      下方抽屉 → 复用 UrgentOrderDrawer 打开右侧工单详情。两 drawer 协调逻辑
      全在父组件，本组件不感知 UrgentOrderDrawer 存在（关注点分离）。
-->
<template>
  <el-drawer
    :model-value="modelValue"
    direction="btt"
    size="60%"
    :with-header="false"
    :append-to-body="true"
    :destroy-on-close="true"
    @update:model-value="(v) => emit('update:modelValue', v)"
  >
    <div v-if="statuses.length === 0" class="drawer-empty">
      <el-empty :image-size="60" description="该层无状态，请重新点击" />
    </div>

    <div v-else class="drawer-body">
      <!-- 顶部 header：日期 · 层标签 · 共 N 件（2026-10-01 订正：本注释原写
           「日期 · 层标题 · 状态数 + 关闭按钮」，dddebb7 桌面屏重构已把 header
           收成单行 header-row-1 并删掉状态数与关闭按钮节点） -->
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
          <span class="header-total">共 {{ rows.length }} 件</span>
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
          @row-click="onRowClick"
        >
          <el-table-column type="index" label="#" width="44" />
          <el-table-column prop="serial_no" label="流水" width="92">
            <template #default="{ row }">
              <span class="cell-serial">{{ row.serial_no ?? '—' }}</span>
            </template>
          </el-table-column>
          <el-table-column prop="drawing_no" label="图号" width="200">
            <template #default="{ row }">
              <span class="cell-drawing">{{ row.drawing_no }}</span>
            </template>
          </el-table-column>
          <el-table-column prop="name" label="名称" min-width="220">
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
//   - 顶部 header：单行放 日期 + 层标题(el-tag 用项目主色背景) + 共 N 件
//   - 列表：el-table stripe；字段与 UrgentOrdersList 对齐
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

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void;
  /** 2026-09-30（Phase 5）新增：行点击 → 父组件 DashboardView 关下方抽屉并复用 UrgentOrderDrawer。 */
  (e: 'rowClick', part: PartListItem): void;
}>();

/** 2026-09-30 新增：层标签映射（与 UpcomingDeliveryChart.LAYERS.label 对齐）。 */
const LAYER_LABEL: Record<'top' | 'middle' | 'bottom', string> = {
  top: '品检前',
  middle: '待品检/待送货',
  bottom: '已送货',
};

/** 2026-09-30 新增 + Phase 5 同步 EP 预设 hex（与 UpcomingDeliveryChart.LAYERS.color 对齐，
 *  顶部 header 标签背景色取此）。
 *  用 hex 而非 var() —— el-tag :style 直接吃 hex 字符串，与 chart 内 layer.color
 *  形态对齐；dashboard 三层视觉闭环 = chart 柱体 + drawer header tag 同色。 */
const LAYER_COLOR: Record<'top' | 'middle' | 'bottom', string> = {
  top: '#f56c6c',
  middle: '#e6a23c',
  bottom: '#67c23a',
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

/** 2026-09-30（Phase 5）新增：行点击 → emit rowClick(part) 给父组件 DashboardView。
 *  父组件会关闭下方抽屉并复用 UrgentOrderDrawer 打开工单详情。本组件不感知
 *  UrgentOrderDrawer 存在 —— 关注点分离，emit 只传 part payload。 */
function onRowClick(row: PartListItem): void {
  emit('rowClick', row);
}

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
// 2026-10-01 清理死样式：.header-status-count / .header-row-2 / .header-row-3
// 三个选择器在 dddebb7「办公桌面屏重构」把 header 收成单行 header-row-1 时已从
// 模板中移除对应节点（状态数与关闭按钮不再渲染），样式块漏删。同批修掉的还有
// __tests__/UpcomingDeliveryListDrawer.spec.ts U1 里断言已删除元素的用例 ——
// 它长期红灯正是死样式掩盖「测试与模板不同步」的结果。
.header-total {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
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
