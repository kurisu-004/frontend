<!--
  DeliveryDateChip.vue

  报工台（PICK / RETURN / INSPECT）工件卡片右上角的交期 chip。
  把 ScanPickParts / ScanReturnParts / ScanInspectParts 三页重复的 span 模板与样式集中。

  2026-10-04：**只显示系统交期**（`system_delivery_date`），无值时日期位渲染 `-`
  （对齐 `formatDashboardDeliveryDate` 的空值口径）。计划交期（`planned_delivery_date`）
  退化为**纯排序键** —— `useScanPartsSort` 仍用它给「无系统交期」的那一组排序，不再
  上屏：工人对着两个日期分不清哪个是硬期限，混着显示只会催错件。
  无值时 `daysText` / 紧迫样式 / 「系统交期」小标签全部不渲染，只留一个 `-`，不制造
  「这里应该有值」的错觉。
-->
<template>
  <span :class="['delivery-date', urgencyClass]">
    <el-icon><Calendar /></el-icon>
    <span>{{ formattedDate }}</span>
    <span v-if="daysText" class="days-left">· {{ daysText }}</span>
    <el-tag v-if="hasSystem" type="info" size="small" effect="plain" class="system-tag"
      >系统交期</el-tag
    >
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { Calendar } from '@element-plus/icons-vue';
import {
  formatDeliveryDate,
  deliveryDaysLeftText,
  deliveryUrgencyClass,
} from '@/utils/deliveryDate';

const props = defineProps<{
  systemDeliveryDate: string | null;
}>();

const hasSystem = computed(() => props.systemDeliveryDate != null);
const formattedDate = computed(() => formatDeliveryDate(props.systemDeliveryDate) || '-');
const daysText = computed(() => deliveryDaysLeftText(props.systemDeliveryDate));
const urgencyClass = computed(() => deliveryUrgencyClass(props.systemDeliveryDate));
</script>

<style scoped>
.delivery-date {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 16px;
  font-weight: 600;
  padding: 2px 10px;
  border-radius: 4px;
  background: #f5f7fa;
  color: #606266;
}
.delivery-date.overdue {
  color: #f56c6c;
  background: #fef0f0;
}
.delivery-date.due-soon {
  color: #e6a23c;
  background: #fdf6ec;
}
.days-left {
  font-weight: 500;
  font-size: 13px;
  margin-left: 2px;
}
.system-tag {
  margin-left: 2px;
}
</style>
