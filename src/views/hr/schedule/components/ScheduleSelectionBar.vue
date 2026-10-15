<!--
  ScheduleSelectionBar.vue — 拖选后的批量操作浮条

  2026-10-19 新建。**纯组件**：区间与草稿从 props 进、动作从 emit 出。

  ⚠️ **草稿（日型 / 名称）的 owner 是 store 不是本组件**：选区由月历产出、草稿由本浮条产出，
    而「换一段选区就把草稿复位」这条不变式必须写在选区的 owner 旁边才成立（写在浮条里，
    将来多一个设选区的入口就会带着上一段区间的档位）。所以本组件是 `v-model` 式的受控态：
    `draftDayType` / `draftName` 走 props 进、`setDraft*` 走 emit 出，自己不持有。

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
      :model-value="draftDayType"
      class="sel-type"
      placeholder="批量设为"
      :disabled="busy"
      @update:model-value="onPick"
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
      :model-value="draftName"
      class="sel-name"
      placeholder="名称（必填）"
      :disabled="busy"
      :error="nameMissing"
      maxlength="30"
      show-word-limit
      @update:model-value="emit('draftName', String($event ?? ''))"
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
import { ElMessage } from 'element-plus';
import type { HrDayType } from '@/types/hr';
import { HR_DAY_TYPE_OPTIONS, dayTypeNeedsName } from '../utils/dayType';

const props = defineProps<{
  /** 选区升序区间（`null` = 没选，整条浮条不渲染）。 */
  range: { from: string; to: string } | null;
  /** 选区天数（由 store 按同一套日期运算算好，避免两处各算一次）。 */
  count: number;
  scopeIsShift: boolean;
  /** 批量草稿的日型（`null` = 还没选档）。store 持有，本组件只读。 */
  draftDayType: HrDayType | null;
  /** `CUSTOM_LEAVE` 的名称草稿。 */
  draftName: string;
  /** 写端点忙态。 */
  busy: boolean;
}>();

const emit = defineEmits<
  ((e: 'apply', dayType: HrDayType, name: string | null) => void) &
    ((e: 'clear') => void) &
    ((e: 'cancel') => void) &
    ((e: 'draftDayType', dayType: HrDayType) => void) &
    ((e: 'draftName', name: string) => void)
>();

/** 「名称没填」这态要不要红：只在「档位已选成 `CUSTOM_LEAVE` + 名称空 + 用户按过应用」之后
 *  才亮 —— 一上来就红是一片没有来由的红。 */
const appliedOnce = ref(false);

const nameNeeded = computed(() => props.draftDayType !== null && dayTypeNeedsName(props.draftDayType));
const nameMissing = computed(() => nameNeeded.value && appliedOnce.value && !props.draftName.trim());

/** 换选区就把「按过一次应用」复位（下一段选区不该继承上一段的标红）。 */
watch(
  () => props.range,
  () => {
    appliedOnce.value = false;
  },
);

/** ⚠️ **换档位同样要复位**：上一档若是不要名称的档，store 的 `setDraftDayType` 会把残留的
 *  `draftName` 清空 —— 于是「按过一次应用 → 换成 `CUSTOM_LEAVE`」会在用户**还没按应用**时就
 *  让 `nameMissing` 成立，输入框凭空先红。与换选区复位同源：这条红只在「当前这组草稿已被用户
 *  按过一次应用」时才有来由。 */
watch(
  () => props.draftDayType,
  () => {
    appliedOnce.value = false;
  },
);

/** 补上名称后立刻撤红：这一态的判据是「按过应用且仍为空」，不再空就不该继续红。 */
watch(
  () => props.draftName,
  () => {
    if (!nameMissing.value) appliedOnce.value = false;
  },
);

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

function onPick(v: unknown): void {
  const dayType = v as HrDayType | null;
  if (!dayType) return;
  emit('draftDayType', dayType);
}

/** ⚠️ 两个「按了没反应」的口子都必须有反馈（静默 `return` 会被当成按钮坏了）：
 *  一是没选档位，二是 `CUSTOM_LEAVE` 缺名（后端会拒 21907）。 */
function onApply(): void {
  appliedOnce.value = true;
  if (!props.draftDayType) {
    ElMessage.warning('请先选择要批量设置的日型');
    return;
  }
  if (nameNeeded.value && !props.draftName.trim()) {
    ElMessage.warning('「自定义休息」必须填写名称');
    return;
  }
  emit('apply', props.draftDayType, nameNeeded.value ? props.draftName.trim() : null);
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
