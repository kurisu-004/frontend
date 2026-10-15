<!--
  ScheduleSelectionBar.vue — 拖选后的批量操作浮条

  2026-10-19 新建。**纯组件**：区间与草稿从 props 进、动作从 emit 出。

  ⚠️ **「清除」在两个作用域下是两件事、文案也不同**：
    - 全局日历 = 删掉这些天的**显式行**，落回「按星期兜底」的默认日型；
    - 班次日历 = 删掉这些天的**覆盖行**，落回**全局日历**那天的日型。
  同一个「清除」按钮配两套语义却只写一个标签，是把「我以为给全厂放假」变成「只放了一个班次
  的假」的最短路径，所以标题与提示都按作用域切换。

  ⚠️ **一次区间批量请求，不逐日循环**：后端的两条写端点本来就是批量 upsert
  （`{items:[...]}` / `{from,to}`），逐日循环会把 31 天变成 31 趟往返，且中途失败会留下
  「改了一半」的日历。
-->
<template>
  <div v-if="range" class="selection-bar">
    <span class="sel-summary">
      已选 <b>{{ count }}</b> 天 · {{ shortFrom }} ~ {{ shortTo }}
    </span>

    <el-select
      v-model="picked"
      class="sel-type"
      placeholder="批量设为"
      :disabled="busy"
      @change="onPick"
    >
      <el-option
        v-for="opt in HR_DAY_TYPE_OPTIONS"
        :key="opt.value"
        :label="opt.label"
        :value="opt.value"
      />
    </el-select>

    <!-- `CUSTOM_LEAVE` 缺名后端拒 21907，所以这一档必须先收名称再发请求。 -->
    <el-input
      v-if="nameNeeded"
      v-model="name"
      class="sel-name"
      placeholder="名称（必填）"
      :disabled="busy"
      maxlength="30"
      show-word-limit
    />

    <el-button type="primary" size="small" :loading="busy" @click="onApply">应用</el-button>

    <el-button size="small" :loading="busy" @click="emit('clear')">
      {{ scopeIsShift ? '清除覆盖' : '恢复默认' }}
    </el-button>

    <el-button size="small" text @click="emit('cancel')">取消</el-button>

    <span class="sel-hint">{{ hint }}</span>
  </div>
</template>

<script setup lang="ts">
// views/hr/schedule/components/ScheduleSelectionBar.vue
//
// 2026-10-19 新建：见文件头。

import { computed, ref, watch } from 'vue';
import type { HrDayType } from '@/types/hr';
import { HR_DAY_TYPE_OPTIONS, dayTypeNeedsName } from '../utils/dayType';

const props = defineProps<{
  /** 选区升序区间（`null` = 没选，整条浮条不渲染）。 */
  range: { from: string; to: string } | null;
  /** 选区天数（由 store 按同一套日期运算算好，避免两处各算一次）。 */
  count: number;
  scopeIsShift: boolean;
  /** 写端点忙态。 */
  busy: boolean;
}>();

const emit = defineEmits<
  ((e: 'apply', dayType: HrDayType, name: string | null) => void) &
    ((e: 'clear') => void) &
    ((e: 'cancel') => void)
>();

const picked = ref<HrDayType | null>(null);
const name = ref('');

/** 换选区就复位草稿（上一次的档位留给下一次 = 把上周期的「调休放假」误按到今天）。 */
watch(
  () => props.range,
  () => {
    picked.value = null;
    name.value = '';
  },
);

const nameNeeded = computed(() => picked.value !== null && dayTypeNeedsName(picked.value));

/** 浮条上的 `MM-DD ~ MM-DD`。跨年时年份在格子里看得到，这里不重复。 */
function short(iso: string): string {
  return iso.slice(5);
}
const shortFrom = computed(() => (props.range ? short(props.range.from) : ''));
const shortTo = computed(() => (props.range ? short(props.range.to) : ''));

const hint = computed(() =>
  props.scopeIsShift
    ? '「清除覆盖」删掉本班次这些天的覆盖行，落回全局日历那天'
    : '「恢复默认」删掉这些天的显式行，落回按星期兜底的日型',
);

function onPick(): void {
  // 换档时把上一档残留的名称清掉，避免「法定节假日 → 自定义休息」沿用上一条的名字。
  if (picked.value && !dayTypeNeedsName(picked.value)) name.value = '';
}

function onApply(): void {
  if (!picked.value) return;
  if (nameNeeded.value && !name.value.trim()) return;
  emit('apply', picked.value, nameNeeded.value ? name.value.trim() : null);
}
</script>

<style lang="scss" scoped>
.selection-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border: 1px solid var(--primary-lighter);
  border-radius: 4px;
  background: var(--primary-bg);
}

.sel-summary {
  font-size: 13px;
  color: var(--text-primary);
}

.sel-type {
  width: 140px;
}

.sel-name {
  width: 180px;
}

.sel-hint {
  font-size: 12px;
  color: var(--text-secondary);
}
</style>
