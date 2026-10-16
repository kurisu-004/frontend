<!--
  ScheduleDayCell.vue — 月历单格（日期号 + 日型徽标 + 「覆盖」角标 + 班次色带）

  2026-10-19 新建。**纯展示**：所有判据由 props 给（`inMonth` / `day` / `dayType` / `name` /
  `derived` / `isOverride` / `workday` / `bands`），组件内零 store、零请求。

  2026-10-16 改三处：
    - 日型徽标由 `.dt-*` 六档手写色块换成 `el-tag`（映射收进 `utils/dayType.ts::dayTypeTagType`，
      本组件不写第二份）；⚠️ `size="small"` 是 20px 高，比原先手写的 10px 字 / 16px 行高每格
      **高 4px** —— 月历行高由父级 `repeat(6, minmax(0, 1fr))` 分配，这点富余由行高吸收，
      不给格子加 `min-height`（加了 `1fr` 就收不下去）。
    - 色带判据从「班次作用域 + 当月格」收紧为「**有上工的班次** + 当月格」：原先漏了
      `workday` 判据 ⇒ 用户建了带颜色的班次后，当月**每一天**都挂上了色带。
    - 色带由单条变**复数段**（`bands`）：全局日历上一格可能有 N 个班次上班（后端日行的
      `shift_bands`），每段一个颜色 + 一个班次名（进原生 tooltip）。班次作用域 0 或 1 条。

  `derived`（按星期兜底、非显式配置）的日子走弱化视觉：它**不是**「没配过」的空白，而是
  「本来就是周日 / 工作日」的兜底结果 —— 不弱化的话整月 30 天全是强色块，真正的显式配置
  （法定节假日那种）反而被淹没。
-->
<template>
  <div
    :class="[
      'day-cell',
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
           「覆盖」这回事 —— 那边的 `is_override` 属于每个班次，不属于这一天）。 -->
      <span v-if="isOverride" class="override-flag">覆盖</span>
    </div>

    <!-- 日型徽标（中文标签）。`name` 存在时（法定节假日 / 自定义休息）把名字也带上：
         光看「法定节假日」分不清五一和国庆。 -->
    <div class="day-badges">
      <el-tag size="small" effect="plain" :type="tagType">{{ typeLabel }}</el-tag>
      <span v-if="name" class="day-name">{{ name }}</span>
    </div>

    <!-- 班次色带：贴在格子底边的一排**等宽小段**，一段一个班次（段多时整排裁切）。
         ⚠️ 判据是「当天有上工的班次」，不是「作用域是不是班次」—— 休息日不该有色带。 -->
    <div v-if="showBands" class="shift-bands">
      <span
        v-for="(band, i) in bands"
        :key="i"
        class="shift-band"
        :style="{ backgroundColor: band.color }"
        :title="band.title"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
// views/hr/schedule/components/ScheduleDayCell.vue
//
// 2026-10-19 新建：见文件头。

import { computed } from 'vue';
import type { HrDayType } from '@/types/hr';
import type { MonthCell } from '../utils/monthGrid';
import { dayTypeLabel, dayTypeTagType } from '../utils/dayType';

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
  /**
   * 当天上工的班次色带（**0 或 N 条**）：班次作用域就是当前这个班次（0 或 1 条），全局作用域
   * 是当天所有上班的班次（后端日行的 `shift_bands`，休息班次已由 store 滤掉）。颜色由 store
   * 解析好（含没填色时的默认色），本组件只画。
   */
  bands: Array<{ color: string; title: string }>;
  /** 是否是拖选区间的端点 / 区间内。 */
  selected: boolean;
  inRange: boolean;
}>();

const typeLabel = computed(() => (props.dayType ? dayTypeLabel(props.dayType) : '无数据'));
/** 日型徽标的 `el-tag` type（6 档 → 5 个 type 的映射收在 `utils/dayType.ts`，无数据给 `info`）。 */
const tagType = computed(() => dayTypeTagType(props.dayType));

/** ⚠️ **`workday` 这道闸不能省**（2026-10-16 修）：原先只有 `scopeIsShift && inMonth`，于是建了
 *  带颜色的班次后当月**每一天**都挂色带 —— 休息日也挂，等于整月一排色块，什么都没表达出来。 */
const showBands = computed(() => props.bands.length > 0 && props.workday && props.cell.inMonth);

/** 格子标题（原生 tooltip）：日期 + 日型 + 是否覆盖 + 名字 + 当天上班的班次。补格只给日期。 */
const titleText = computed(() => {
  if (!props.cell.inMonth) return props.cell.iso;
  const parts = [props.cell.iso, typeLabel.value];
  if (props.dayType === null) return parts.join(' ');
  if (props.name) parts.push(props.name);
  if (props.isOverride) parts.push('（本班次已覆盖）');
  // 色带可能一段都没有（这天没班次上班），有就点名 ——「多段颜色对应哪些班次」靠这一行辨认。
  if (props.bands.length > 0) parts.push(`上班班次：${props.bands.map((b) => b.title).join('、')}`);
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
  /* 2026-10-16 改：原先 `min-height: 54px` 会让 `1fr` 轨道收不下去（行高不够时格子溢出
     轨道、整块网格被卡片裁掉）。下限改由父级 `repeat(6, minmax(0, 1fr))` 的整体高度保证：
     视口够高时每行远高于 54px，不够高时格子内容在**格内**裁切（`.day-cell` 自带
     `overflow: hidden`），不产生外溢、不给页面凭空加滚动条。 */
  min-height: 0;
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

/* 日型徽标：色块交给 `el-tag`（`size="small" effect="plain"`），这里只管排版与裁切。
   ⚠️ **不覆写它的尺寸**：`small` 的 20px 高 / 12px 字是 Element Plus 的口径（2.14.6 的
   `theme-chalk/src/common/var.scss`），比原先手写的 16px 行高每格高 4px，由月历行的
   `1fr` 富余吸收（见 `.day-cell` 的 `min-height` 注释）。这里只防「最长的一档标签
   （法定节假日）把格子撑破」——交给标签自己裁切，不让它把 `.day-badges` 顶宽。 */
.day-badges {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
  min-width: 0;
}

.day-badges :deep(.el-tag) {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
}

.day-name {
  max-width: 100%;
  font-size: 10px;
  line-height: 14px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
.is-out .shift-bands {
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

/* 班次色带：贴在格子底边的一排等宽小段（一段一个班次），「这天上工的是谁」的视觉锚。
   段多时整排裁切，不换行 —— 换行会把底边顶出一条参差不齐的边。 */
.shift-bands {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  height: 4px;
  opacity: 0.85;
  overflow: hidden;
}

.shift-band {
  flex: 1 1 0;
  min-width: 0;
  height: 100%;
}
</style>
