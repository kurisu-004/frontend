<!--
  ScheduleDayCell.vue — 月历单格（日期号 + 日型徽标 + 「覆盖」角标 + 班次色带）

  2026-10-19 新建。**纯展示**：所有判据由 props 给（`inMonth` / `day` / `dayType` / `name` /
  `derived` / `isOverride` / `workday` / `bands`），组件内零 store、零请求。

  `derived`（按星期兜底、非显式配置）的日子走弱化视觉：它**不是**「没配过」的空白，而是
  「本来就是周日 / 工作日」的兜底结果 —— 不弱化的话整月 30 天全是强色块，真正的显式配置
  （法定节假日那种）反而被淹没。

  ⚠️ **格内密度必须自己管**（42 格 × 6 行的网格是硬约束）：日型徽标用 `el-tag`（`type` 的映射
    收在 `utils/dayType.ts::dayTypeTagType`，本组件不写第二份），但**尺寸与字号由本页覆写** ——
    `el-tag--small` 的 20px 高 / 12px 字在 1366×768 这类笔记本视口下会把格子顶出裁切。
  ⚠️ **色带的「要不要画」判据是 `bands.length > 0 && inMonth`，不再看日级 `workday`**：日级判据
    只适用于班次作用域；全局作用域下权威判据是**班次级**的 `shift_bands[].is_workday`（store 已按
    它滤过），再用日级 `workday` 过一道就会把「全局休息日 + 某班次覆盖上班」杀掉。
  ⚠️ **色带段带 `override` 标记**（该段这一天来自本班次的覆盖行）：全局视图上「这天是全局配置」
    与「这天被某班次覆盖过」要能一眼分辨，所以被覆盖的那段有内描边 + tooltip 点名。
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

    <!-- 班次色带：贴在格子底边的一排小段，一段一个班次（`bands`，0 或 N 条）。
         ⚠️ 判据是「当天有上工的班次」（store 已按班次级 `is_workday` 滤过），不是日型。 -->
    <div v-if="showBands" class="shift-bands">
      <span
        v-for="(band, i) in bands"
        :key="i"
        :class="['shift-band', { 'is-override': band.override }]"
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
import type { ShiftBandView } from '../composables/useScheduleStore';

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
   * 是当天所有上班的班次（后端日行的 `shift_bands`，休息班次已由 store 滤掉）。颜色与
   * `override` 标记都由 store 解析好，本组件只画。
   *
   * ⚠️ 形状直接引 store 的 `ShiftBandView`（**不要在这里手抄一份内联结构类型**）：store 那侧
   *   加字段时这里会当场类型报错，而手抄出来的同形类型靠结构兼容悄悄放过、漂移无声）。
   */
  bands: ShiftBandView[];
  /** 是否是拖选区间的端点 / 区间内。 */
  selected: boolean;
  inRange: boolean;
}>();

const typeLabel = computed(() => (props.dayType ? dayTypeLabel(props.dayType) : '无数据'));
/** 日型徽标的 `el-tag` type（6 档 → 5 个 type 的映射收在 `utils/dayType.ts`，无数据给 `info`）。 */
const tagType = computed(() => dayTypeTagType(props.dayType));

/** ⚠️ **不要在这里再判 `workday`**（2026-10-16 改）：store 已按**班次级**的判据滤好
 *  （全局侧 `shift_bands[].is_workday`、班次侧 `is_workday`）。日级 `workday` 只适用于班次
 *  作用域，全局作用域下用它当闸门会把「全局是休息日、但某班次有覆盖行使其照常上班」这一段
 *  杀掉 —— 而那正是本域最该让用户看到的信息（后端 `vo.rs` 点名的场景）。 */
const showBands = computed(() => props.bands.length > 0 && props.cell.inMonth);

/** 格子标题（原生 tooltip）：日期 + 日型 + 是否覆盖 + 名字 + 当天上班的班次。补格只给日期。 */
const titleText = computed(() => {
  if (!props.cell.inMonth) return props.cell.iso;
  const parts = [props.cell.iso, typeLabel.value];
  if (props.dayType === null) return parts.join(' ');
  if (props.name) parts.push(props.name);
  if (props.isOverride) parts.push('（本班次已覆盖）');
  // 色带可能一段都没有（这天没班次上班），有就点名 ——「多段颜色对应哪些班次」靠这一行辨认。
  // 被覆盖的那段额外点名（tooltip 是鼠标悬停才看得到的细节通道，适合承载这个信息）。
  if (props.bands.length > 0) {
    parts.push(`上班班次：${props.bands.map(bandTitle).join('、')}`);
  }
  if (props.derived) parts.push('（按星期兜底）');
  return parts.join(' ');
});

/** 段的 tooltip 文案：被覆盖的段带「（覆盖）」后缀，区分「全局配置」与「被某班次覆盖过」。 */
function bandTitle(band: { title: string; override: boolean }): string {
  return band.override ? `${band.title}（覆盖）` : band.title;
}
</script>

<style lang="scss" scoped>
.day-cell {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 2px;
  height: 100%;
  /* ⚠️ `min-height: 0` 不能给：`.day-cell` 是 `ScheduleMonthGrid` 的 `.grid-body` 那个
     `repeat(6, minmax(0, 1fr))` 轨道的 grid 项，格子的高度下限必须完全交给轨道 —— 任何
     `min-height` 都会让轨道收不下去（格子溢出轨道、整块网格被卡片裁掉）。下限改由父级的整体
     高度保证：视口够高时每行远高于内容高，不够高时格子内容在**格内**裁切（本块自带
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

/* 日型徽标与节假日名：42 格 × 6 行的密集网格，纵向预算是硬约束（`.day-cell` 自带
   `overflow: hidden`，超出部分直接被裁，不会变成页面滚动条）。所以这块自己把 `el-tag` 的
   尺寸压回**手写徽标的预算**（10px 字 / 16px 行高），而不是迁就 Element Plus `small` 的
   20px 高 / 12px 字 —— 后者在 1366×768（视口 ≈650px）的笔记本上会把带 `day-name` 的格子顶出
   裁切，而那正是拖选浮条展开、用户逐格读色带的时候。 */
.day-badges {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
  min-width: 0;
  /* 允许被压扁 ⇒ 高度不够时裁切优先落在这一块，而不是把整块顶出 `.day-cell`。 */
  min-height: 0;
  overflow: hidden;
}

.day-badges :deep(.el-tag) {
  /* 尺寸与字号：`.el-tag` 是 `display: inline-flex`，`height` 与 `--el-tag-font-size` 都要
     显式给（`font-size` 在 EP 里取的就是这个变量）。`padding` 收到 4px，给最长的一档标签
     （法定节假日）多留一点横向余量。 */
  --el-tag-font-size: 10px;
  height: 16px;
  padding: 0 4px;
  max-width: 100%;
}

/* ⚠️ **省略号必须打在 `.el-tag__content` 上**：`.el-tag` 是 flex 容器，文字装在它内部的
   `<span class="el-tag__content">` 里；`text-overflow` 只对**块级**排版盒生效，写在外层
   `.el-tag` 上是空操作（症状：文字被硬切、无省略号，窄格上看着像渲染坏了）。 */
.day-badges :deep(.el-tag__content) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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

/* 补格（前后月）：只留一个极淡的框，不可点也不可拖选。
   ⚠️ 这里只藏 `.day-badges`：`.shift-bands` 补格**根本不渲染**（`showBands` 带
   `cell.inMonth` 闸门），给它写一条 `visibility: hidden` 是够不着的死规则。 */
.is-out {
  background: #fafbfc;
  border-style: dashed;
  opacity: 0.5;
}

.is-out .day-badges {
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

/* 班次色带：贴在格子底边的一排小段，一段一个班次，是「这天上工的是谁」的视觉锚。
   ⚠️ **段数不定，一律等分铺满**：子段是 `flex: 1 1 0`，段数一多每段就按比例变细（不是裁切，
   段不会凭空消失）；段多到 `min-width` 都兜不住时，整排才在容器里裁掉尾部 —— 裁掉的那些
   仍可通过格子的 tooltip 点名。 */
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
  /* 兜底下限：段再多也留一道可见的细条（而不是被压成 0 宽、看着像没有这一段）。 */
  min-width: 2px;
  height: 100%;
}

/* 被班次覆盖行改过的那一段：内描边 + 轻微加深，让「全局是休息/节假日、这一段被某班次覆盖上
   班」在多段并排时一眼可辨（纯色并排本来只有色差，单看颜色分不出哪个是覆盖）。 */
.shift-band.is-override {
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.55);
  filter: brightness(0.88);
}
</style>
