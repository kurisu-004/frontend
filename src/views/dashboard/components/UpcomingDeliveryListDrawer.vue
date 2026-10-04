<!--
  UpcomingDeliveryListDrawer.vue
  dashboard「交期分桶柱状图按层点击抽屉」。
  Props / Events：
    - modelValue: boolean
    - date: 'YYYY-MM-DD'
    - layer: 'top' | 'middle' | 'bottom'
    - statuses: OrderStatus[]
    - basis: 'planned' | 'system'（2026-10-04 新增，交期统计口径）
    - @update:modelValue: 双向同步
  渲染：el-table stripe；列 = # / 流水(serial_no) / 图号(drawing_no) / 名称 /
  客户(l1_customer_name + customer_name 拼接) / 状态 ElTag / 倒计
  （按 basis 取 planned_delivery_date 或 system_delivery_date，出逾期/临近配色）；
  loading / error / empty 三态。
  闸门：父组件 DashboardView `v-if="selectedLayer"` 保证 drawer 首次点击前不挂载，
  useDashboardUpcomingList 的 enabled 闸门天然生效；drawer 自身
  `v-if="statuses.length === 0"` 是 props 异常兜底。

  口径（2026-10-04 新增）：抽屉是柱状图的下钻，日期窗口与倒计列都必须跟柱状图当前
  口径一致，否则会出现「点的是系统交期的柱、列里却显示计划交期倒计」的自相矛盾。
  - 组件不持口径状态：props.basis 进，透传给 useDashboardUpcomingList；
  - header 挂一枚口径小标签，让抽屉自解释当前口径；
  - 倒计列读 rowDeliveryDate(计划交期, 系统交期) 统一取字段，模板里不写三元；
  - 客户列 / 倒计列的取字段 helper 一律收「字段值」而不是整行，模板侧不留
    `as PartListItem` 强转（el-table 列 slot 的 row 是 DefaultRow，见函数注释）。

  统计口径与条目（2026-10-05）：抽屉是柱状图的下钻，行源与柱高同源 ——
  t_part 全表行，含装配件的子零件、不含装配件父行，行单位恒「件」。故一个装配件
  （4 个子零件）+ 5 个独立零件 = 柱高 9 = 三层抽屉逐层打开的行数之和（一次只开一层）；
  子零件各占一行，抽屉里**不**出现装配件父行，也无装配件标识列 / 树形 / 标签。
  头部件数取服务端 total，被 limit 截断时追加「仅显示前 N 条」。

  抽屉形态：direction 'btt'（bottom-to-top）+ :size 60% —— 从屏幕底部弹出、水平
  宽度撑满、最大高度 60%，与 dashboard 双栏布局配合（点柱状图看到的是「目标日期的
  工单清单」，横向表格能展示更全列）。

  LAYER_COLOR 走 EP 预设 hex（success #67c23a / warning #e6a23c / danger #f56c6c），
  与 UpcomingDeliveryChart.LAYERS.color 一致。

  emit('rowClick', part)：行点击 → 父组件打开 PartPreviewDialog 预览该工单。抽屉
  **不自行关闭**（dialog append-to-body 覆盖在抽屉之上，关掉 dialog 后抽屉仍可见，
  方便连续预览）。本组件不感知 PartPreviewDialog 存在，emit 只传 part payload。
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
          <!-- 2026-10-04：口径小标签，让抽屉自解释当前统计口径（跟柱状图开关同步） -->
          <el-tag size="small" effect="plain" type="info">{{ basisLabel }}</el-tag>
          <!--
            2026-10-05：件数渲染 total（服务端匹配总数）而非 rows.length —— limit 与
            端点页长上限一致，rows.length 只是「本页拿回来的条数」，拿它当件数会在
            条数触顶时谎报。被截断时追加提示，否则用户以为抽屉里的就是全部。
            2026-10-05 补：换键期间（切 basis / 切日期 / 切层）query.data 尚未落地，
            此时不渲染件数 —— pending 期渲染「共 0 件」会被读成一个权威计数。
          -->
          <span v-if="!isPending" class="header-total">共 {{ total }} 件</span>
          <span v-if="isTruncated" class="header-truncated">仅显示前 {{ rows.length }} 条</span>
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
              <span class="cell-customer" :title="customerPath(row.l1_customer_name, row.customer_name)">
                {{ customerPath(row.l1_customer_name, row.customer_name) || '—' }}
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
              <span
                :class="['cell-due', deliveryUrgencyClass(rowDeliveryDate(row.planned_delivery_date, row.system_delivery_date))]"
              >
                {{
                  deliveryDaysLeftText(
                    rowDeliveryDate(row.planned_delivery_date, row.system_delivery_date),
                  ) || formatDeliveryDate(rowDeliveryDate(row.planned_delivery_date, row.system_delivery_date))
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
// dashboard「交期分桶柱状图按层点击抽屉」展示壳。
//
// 数据流：
//   1. props.modelValue=true 时 useDashboardUpcomingList 的 enabled 闸门打开
//      （params getter 返回 { date, statuses, basis } 非 null）；
//   2. params 变化（切层 / 切日期 / 切口径）→ queryKey 变化 → 自动 refetch；
//   3. rows = query.data.items（请求 limit 与端点页长上限一致 ⇒ 最多 200 行；
//      单日 × 8 状态实际远小于此）；total = 服务端匹配总数，header 件数按它渲染。
//
// 视觉：
//   - 顶部 header：单行放 日期 + 层标题(el-tag 用项目主色背景) + 口径标签 + 共 N 件
//     （N = total；换键 pending 期间整块不渲染，避免「共 0 件」被读成权威计数；
//      被服务端 limit 截断时追加「仅显示前 N 条」）
//   - 列表：el-table stripe；列 = # / 流水 / 图号 / 名称 / 客户(一二级拼接) / 状态 ElTag /
//     倒计（**当前口径**交期字段的倒计文案，逾期/临近配色）
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
import { DELIVERY_BASIS_LABEL, type DeliveryBasis } from '@/types/dashboard';

const props = defineProps<{
  modelValue: boolean;
  date: string;
  layer: 'top' | 'middle' | 'bottom';
  statuses: readonly OrderStatus[];
  /** 2026-10-04 新增：交期统计口径（必填，唯一状态源在父组件 DashboardView）。 */
  basis: DeliveryBasis;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void;
  /** 行点击 → 父组件 DashboardView 打开 PartPreviewDialog 预览该工单。 */
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

/** 2026-10-04 新增：header 口径标签文案（与柱状图开关共用 DELIVERY_BASIS_LABEL）。 */
const basisLabel = computed(() => DELIVERY_BASIS_LABEL[props.basis]);

/** 2026-10-04 新增：取当前口径对应的交期字段值。
 *  倒计列有三处消费（class / 倒计文案 / 日期回显），散在模板里各写一次三元容易
 *  漏改一处导致「class 用计划交期、文案用系统交期」，故收成一个函数。
 *  入参是**两个字段值**而不是整行：el-table 列的 scoped slot 交给模板的 row 类型是
 *  el-table 的 DefaultRow（Record<PropertyKey, any>，不含具体字段），把整行传进收
 *  PartListItem 的函数在模板侧就得逐处 `as PartListItem` 强转，噪音大且掩盖了
 *  「这个函数到底读哪几个字段」这条信息。传字段值则零强转，函数签名本身也把依赖
 *  的字段钉死了。
 *  system_delivery_date 可空，返回 null 时下游 deliveryDate 工具函数按空值处理
 *  （无倒计文案、日期列留空）。 */
function rowDeliveryDate(
  plannedDate: string | null,
  systemDate: string | null,
): string | null {
  return props.basis === 'system' ? systemDate : plannedDate;
}

/** 2026-09-30 新增：params getter —— 仅 drawer 打开时返回非 null 让闸门打开；
 *  关闭（modelValue=false）时返回 null 停 fetch，与 enabled 闸门语义对齐。
 *  2026-10-04：透传 basis，让下钻的日期窗口与柱状图当前口径一致。 */
const params = computed(() => {
  if (!props.modelValue) return null;
  if (props.statuses.length === 0) return null;
  return {
    date: props.date,
    statuses: [...props.statuses] as OrderStatus[],
    basis: props.basis,
  };
});

const { data: rows, total, isPending, error } = useDashboardUpcomingList(() => toValue(params));

/** total 超过实际取回条数 = 服务端截断（limit 与端点页长上限一致），
 *  头部件数与提示条的开关。total <= rows.length 时不渲染任何额外提示。 */
const isTruncated = computed(() => total.value > rows.value.length);

/** 行点击 → emit rowClick(part) 给父组件 DashboardView（父组件负责打开
 *  PartPreviewDialog）。本组件不感知该 dialog 存在 —— 关注点分离，emit 只传
 *  part payload。 */
function onRowClick(row: PartListItem): void {
  emit('rowClick', row);
}

/** 2026-09-30 新增：客户路径展示 —— l1_customer_name + customer_name（如有）。
 *  同 rowDeliveryDate：收字段值而非整行，模板侧免掉 `as PartListItem` 强转。 */
function customerPath(l1Name: string | null, customerName: string | null): string {
  const l1 = l1Name ?? '';
  const cur = customerName ?? '';
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
.header-total {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}
.header-truncated {
  font-size: 12px;
  color: var(--text-secondary);
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
