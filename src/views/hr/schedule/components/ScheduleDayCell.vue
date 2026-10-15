<!--
  ScheduleDayCell.vue — 月历单格（日期号 + 日型徽标 + 「覆盖」角标 + 班次色带）

  2026-10-19 新建。**纯展示**：所有判据由 props 给（`inMonth` / `day` / `dayType` / `name` /
  `derived` / `isOverride` / `shiftColor`），组件内零 store、零请求。

  颜色口径：`dayType` 只给到**色板键**（`workday` / `rest` / …），具体颜色映射在下面的
  scoped scss 里 —— `.dt-{colorKey}` 六档，颜色取主题变量（藏青 `#1e4d8b` / 蓝 `#2c6cb8` /
  浅蓝 `#4a8fd6`，定义在 `src/styles/variables.scss` 的 `:root`）。色板键来自
  `@/types/hr::HR_DAY_TYPE_META`，**样式层不写第二份日型字面量**。

  `derived`（按星期兜底、非显式配置）的日子走弱化视觉：它**不是**「没配过」的空白，而是
  「本来就是周日 / 工作日」的兜底结果 —— 不弱化的话整月 30 天全是强色块，真正的显式配置
  （法定节假日那种）反而被淹没。
-->
<template>
  <div
    :class="[
      'day-cell',
      `dt-${colorKey}`,
      {
        'is-out': !cell.inMonth,
        'is-derived': derived,
        'is-unknown': dayType === null,
        'is-selected': selected,
        'is-in-range': inRange,
        'is-rest': !workday,
      },
    ]"
    :data-date="cell.iso"
    :title="titleText"
  >
    <div class="day-head">
      <span class="day-num">{{ cell.day }}</span>
      <!-- 「覆盖」角标：只在班次作用域且 `is_override === true` 时出现（全局日历没有
           「覆盖」这回事）。 -->
      <span v-if="isOverride" class="override-flag">覆盖</span>
    </div>

    <!-- 日型徽标（中文标签）。`name` 存在时（法定节假日 / 自定义休息）把名字也带上：
         光看「法定节假日」分不清五一和国庆。 -->
    <div class="day-badges">
      <span class="day-type">{{ typeLabel }}</span>
      <span v-if="name" class="day-name">{{ name }}</span>
    </div>

    <!-- 班次色带：只在班次作用域出现，颜色取该班次自己的 `color`（可空 → 主题浅蓝）。 -->
    <div
      v-if="showShiftBand"
      class="shift-band"
      :style="{ backgroundColor: shiftColor ?? 'var(--primary-lighter)' }"
    />
  </div>
</template>

<script setup lang="ts">
// views/hr/schedule/components/ScheduleDayCell.vue
//
// 2026-10-19 新建：见文件头。

import { computed } from 'vue';
import type { HrDayType } from '@/types/hr';
import type { MonthCell } from '../utils/monthGrid';
import { dayTypeColorKey, dayTypeLabel } from '../utils/dayType';

const props = defineProps<{
  cell: MonthCell;
  /** 当前作用域下生效的日型（班次作用域 = `effective_day_type`）。
   *  ⚠️ **可空**：后端没返这一天时给 `null` 并显示「无数据」——拿 `WORKDAY` 占位会把
   *  「这条没数据」渲染成「这天上班」，用户照着改日型时判断依据是错的。 */
  dayType: HrDayType | null;
  /** 节假日名（可空）。 */
  name: string | null;
  /** 该天是不是按星期兜底推出来的（`derived`）。 */
  derived: boolean;
  /** 该天有没有本班次的覆盖行。 */
  isOverride: boolean;
  /** 最终日型是否算上班。 */
  workday: boolean;
  /** 班次作用域下才给班次色（`color` 可空 = 用主题浅蓝）。 */
  scopeIsShift: boolean;
  shiftColor: string | null;
  /** 是否是拖选区间的端点 / 区间内。 */
  selected: boolean;
  inRange: boolean;
}>();

const colorKey = computed(() => (props.dayType ? dayTypeColorKey(props.dayType) : 'rest'));
const typeLabel = computed(() => (props.dayType ? dayTypeLabel(props.dayType) : '无数据'));
const showShiftBand = computed(() => props.scopeIsShift && props.cell.inMonth);

/** 格子标题（原生 tooltip）：日期 + 日型 + 是否覆盖 + 名字。补格只给日期。 */
const titleText = computed(() => {
  if (!props.cell.inMonth) return props.cell.iso;
  const parts = [props.cell.iso, typeLabel.value];
  if (props.dayType === null) return parts.join(' ');
  if (props.name) parts.push(props.name);
  if (props.scopeIsShift) parts.push(props.isOverride ? '（本班次已覆盖）' : '（继承全局）');
  if (props.derived) parts.push('（按星期兜底）');
  return parts.join(' ');
});
</script>

<style lang="scss" scoped>
.day-cell {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 2px;
  height: 100%;
  min-height: 54px;
  padding: 4px 5px 6px;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  background: var(--white);
  overflow: hidden;
  user-select: none;
}

.day-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
}

.day-num {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

.override-flag {
  padding: 0 4px;
  border-radius: 2px;
  background: var(--primary-light);
  color: var(--white);
  font-size: 10px;
  line-height: 15px;
}

/* 日型徽标：文字色 = 色板键，颜色映射全部收在这六条里。 */
.day-badges {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.day-type {
  align-self: flex-start;
  padding: 0 4px;
  border-radius: 2px;
  font-size: 10px;
  line-height: 16px;
  white-space: nowrap;
}

.day-name {
  font-size: 10px;
  line-height: 14px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dt-workday .day-type {
  background: rgba(30, 77, 139, 0.12);
  color: #1e4d8b;
}

.dt-makeup-work .day-type {
  background: rgba(42, 108, 184, 0.14);
  color: #2c6cb8;
}

.dt-rest .day-type {
  background: #f0f2f5;
  color: #6b7280;
}

.dt-holiday .day-type {
  background: rgba(214, 122, 26, 0.16);
  color: #b45309;
}

.dt-makeup-rest .day-type {
  background: rgba(120, 113, 108, 0.16);
  color: #78716c;
}

.dt-custom .day-type {
  background: rgba(103, 58, 183, 0.14);
  color: #673ab7;
}

/* 后端没返这一天：整体压灰，别让它跟真日型混在一起被当成配置读。 */
.is-unknown {
  opacity: 0.5;
  border-style: dashed;
}

/* 休息日：日期号弱化，与工作日拉开一眼可辨的层级。 */
.is-rest .day-num {
  font-weight: 500;
  color: var(--text-secondary);
}

/* 按星期兜底的日子：整格降透明度，显式配置的日子才保持满色。 */
.is-derived {
  opacity: 0.62;
}

/* 补格（前后月）：只留一个极淡的框，不可点也不可拖选。 */
.is-out {
  background: #fafbfc;
  border-style: dashed;
  opacity: 0.5;
}

.is-out .day-badges,
.is-out .shift-band {
  visibility: hidden;
}

/* 拖选：端点格描主色，区间内格淡主色底。 */
.is-selected {
  border-color: var(--primary-color);
  box-shadow: inset 0 0 0 1px var(--primary-color);
}

.is-in-range {
  background: var(--primary-bg);
}

/* 班次色带：贴在格子底边的一条实色，「这个月的这天在这个班次里是 XX」的视觉锚。 */
.shift-band {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 4px;
  opacity: 0.85;
}
</style>
