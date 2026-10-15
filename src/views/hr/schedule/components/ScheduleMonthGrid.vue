<!--
  ScheduleMonthGrid.vue — 自绘月历（6×7 网格）+ 区间拖选

  2026-10-19 新建。

  ⚠️ **不用 `el-calendar`**：本仓零 `el-calendar` 先例，而内置日历给不了本域要的形态 ——
  每格的班次色带 / 「覆盖」角标 / `derived` 弱化 / 按作用域切换徽标，四样都得逐格自定义。
  自绘的另一个好处是「一格一个 DOM 节点 + `data-date`」，拖选命中判定就是一次 `closest`。

  ⚠️ **拖选监听必须挂 window（不是格子）**：监听挂格子上时，鼠标一移出格子就收不到
  `mousemove`，拖动态会卡在中途（用户松手时 UI 还停在半截选区）。三件套照
  `src/components/ImagePager.vue` 的拖动平移：`mousedown` 起、`window.mousemove` 跟、
  `window.mouseup` 收，`onBeforeUnmount` 里兜底摘监听（页面在拖到一半时切走的路径）。

  ⚠️ **拖完不能顺带弹出单日编辑器**：拖选与点单日在同一格上，浏览器在 `mouseup` 之后照样会
  派发 `click`，而 `el-popover` 的 `trigger="click"` 就绑在这个 click 上。所以根节点挂
  **捕获阶段**的 click 拦截：刚刚真拖过（终点格 ≠ 起点格）就吞掉这一次 click，只拖一下不改
  单日。捕获阶段在 popover 自己的监听之前跑，所以拦得住。
-->
<template>
  <div class="month-grid" @click.capture="onRootClickCapture">
    <div class="grid-toolbar">
      <div class="grid-nav">
        <el-button size="small" @click="emit('gotoMonth', -1)">上一月</el-button>
        <span class="grid-title">{{ cursor.year }} 年 {{ cursor.month }} 月</span>
        <el-button size="small" @click="emit('gotoMonth', 1)">下一月</el-button>
        <el-button size="small" text @click="emit('gotoToday')">本月</el-button>
      </div>
      <div class="grid-hint">
        {{
          canEdit
            ? '拖选一段日期可批量改日型；单击某天改单日'
            : '只读模式：可查看与翻月，不能改日历'
        }}
      </div>
    </div>

    <div class="grid-weekdays">
      <span v-for="w in WEEKDAYS" :key="w" class="weekday">{{ w }}</span>
    </div>

    <div :class="['grid-body', { 'is-selecting': dragging }]">
      <ScheduleDayEditor
        v-for="cell in cells"
        :key="cell.iso"
        :day="calendarDays.get(cell.iso) ?? null"
        :iso="cell.iso"
        :scope-is-shift="scopeIsShift"
        :scope-label="scopeLabel"
        :can-edit="canEdit"
        :writing="writing"
        @open="emit('selectDay', cell.iso)"
        @apply="(t, n) => emit('dayApply', t, n)"
        @reset="emit('dayReset')"
      >
        <ScheduleDayCell
          :cell="cell"
          :day-type="dayTypeOf(cell.iso)"
          :name="nameOf(cell.iso)"
          :derived="derivedOf(cell.iso)"
          :is-override="overrideOf(cell.iso)"
          :workday="workdayOf(cell.iso)"
          :scope-is-shift="scopeIsShift"
          :shift-color="shiftColor"
          :selected="isSelected(cell.iso)"
          :in-range="inRange(cell.iso)"
          @mousedown="onCellMouseDown(cell.iso, cell.inMonth, $event)"
        />
      </ScheduleDayEditor>
    </div>
  </div>
</template>

<script setup lang="ts">
// views/hr/schedule/components/ScheduleMonthGrid.vue
//
// 2026-10-19 新建：见文件头。**纯组件**：只管渲染与拖选交互，所有写动作与翻页都 emit 出去
// 由壳接 store —— 月历不是数据的 owner。

import { onBeforeUnmount, ref } from 'vue';
import type { HrDayType } from '@/types/hr';
import ScheduleDayCell from './ScheduleDayCell.vue';
import ScheduleDayEditor from './ScheduleDayEditor.vue';
import type { MonthCell } from '../utils/monthGrid';
import { isoMinMax } from '../utils/monthGrid';
import type { ScheduleDayView } from '../composables/useScheduleStore';

const props = defineProps<{
  cells: MonthCell[];
  /** 归一化后的当月数据（按 ISO 索引；缺键 = 后端没返那天）。 */
  calendarDays: Map<string, ScheduleDayView>;
  cursor: { year: number; month: number };
  scopeIsShift: boolean;
  scopeLabel: string;
  /** 班次色（可空）。 */
  shiftColor: string | null;
  /** 有没有排班管理权限（false = 拖选整体禁用）。 */
  canEdit: boolean;
  /** 写端点忙态（透传给单元格编辑器的「应用」按钮）。 */
  writing: boolean;
  /** 当前拖选区间（`null` = 没选）。 */
  selectedRange: { from: string; to: string } | null;
}>();

const emit = defineEmits<
  ((e: 'update:selectedRange', range: { from: string; to: string } | null) => void) &
    ((e: 'selectDay', iso: string) => void) &
    ((e: 'dayApply', dayType: HrDayType, name: string | null) => void) &
    ((e: 'dayReset') => void) &
    ((e: 'gotoMonth', delta: number) => void) &
    ((e: 'gotoToday') => void)
>();

/** 表头：中文习惯里周日是一周第一天，故列序为 日…六。 */
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'] as const;

// ---- 日型取数：缺键（后端没返那天）时给 null，让格子如实显示「无数据」 ----
function dayTypeOf(iso: string): HrDayType | null {
  return props.calendarDays.get(iso)?.dayType ?? null;
}
function nameOf(iso: string): string | null {
  return props.calendarDays.get(iso)?.name ?? null;
}
function derivedOf(iso: string): boolean {
  return props.calendarDays.get(iso)?.derived ?? false;
}
function overrideOf(iso: string): boolean {
  return props.calendarDays.get(iso)?.isOverride ?? false;
}
function workdayOf(iso: string): boolean {
  return props.calendarDays.get(iso)?.workday ?? false;
}

// ---- 拖选 ----
const dragging = ref(false);
const anchorIso = ref('');
const hoverIso = ref('');
/** 刚拖完一次（终点 ≠ 起点）⇒ 吞掉紧随其后的那一次 click。 */
let suppressNextClick = false;

/** `clientX/clientY` 命中哪一格：先取该点最顶层的元素，再上溯到带 `data-date` 的格。
 *  ⚠️ `elementFromPoint` 在某些环境（无布局的测试环境）恒返回 null，这时**保持上一次的
 *  悬停格**而不是把选区清掉 —— 选区不会因为一次识别失败而跳回起点。 */
function cellAt(clientX: number, clientY: number): string | null {
  if (typeof document.elementFromPoint !== 'function') return null;
  const el = document.elementFromPoint(clientX, clientY);
  if (!el || typeof el.closest !== 'function') return null;
  return el.closest('[data-date]')?.getAttribute('data-date') ?? null;
}

function onCellMouseDown(iso: string, inMonth: boolean, e: MouseEvent): void {
  if (!props.canEdit) return;
  // 只响应左键：右键菜单 / 中键拖动不该起一个跨天选区。
  if (e.button !== 0) return;
  // 补格不可点也不可拖选（它是别的月的日子，写进去用户会以为改到了当月）。
  if (!inMonth) return;
  dragging.value = true;
  anchorIso.value = iso;
  hoverIso.value = iso;
  window.addEventListener('mousemove', onWindowMouseMove);
  window.addEventListener('mouseup', onWindowMouseUp);
}

function onWindowMouseMove(e: MouseEvent): void {
  if (!dragging.value) return;
  const iso = cellAt(e.clientX, e.clientY);
  if (iso) hoverIso.value = iso;
}

function onWindowMouseUp(): void {
  if (!dragging.value) return;
  dragging.value = false;
  detachWindowListeners();
  const from = anchorIso.value;
  const to = hoverIso.value;
  if (!from || !to || from === to) {
    // 单击（没拖动）：选区清空，click 交给单元格编辑器处理。
    emit('update:selectedRange', null);
    return;
  }
  suppressNextClick = true;
  const [lo, hi] = isoMinMax(from, to);
  emit('update:selectedRange', { from: lo, to: hi });
}

/** 拖完的那一次 click 不要再打开单日编辑器（见文件头）。 */
function onRootClickCapture(e: MouseEvent): void {
  if (!suppressNextClick) return;
  suppressNextClick = false;
  e.stopPropagation();
  e.preventDefault();
}

function detachWindowListeners(): void {
  window.removeEventListener('mousemove', onWindowMouseMove);
  window.removeEventListener('mouseup', onWindowMouseUp);
}

// 不变量：组件在**拖到一半时被卸载**（切月 / 切页 / `$dispose`）也要摘干净 window 监听，
// 否则残留监听会对着已销毁的 ref 写值。
onBeforeUnmount(() => {
  dragging.value = false;
  detachWindowListeners();
});

// ---- 选区判定 ----
function isSelected(iso: string): boolean {
  return props.selectedRange?.from === iso || props.selectedRange?.to === iso;
}
function inRange(iso: string): boolean {
  const r = props.selectedRange;
  return !!r && iso >= r.from && iso <= r.to;
}
</script>

<style lang="scss" scoped>
.month-grid {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.grid-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.grid-nav {
  display: flex;
  align-items: center;
  gap: 8px;
}

.grid-title {
  min-width: 96px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  text-align: center;
}

.grid-hint {
  font-size: 12px;
  color: var(--text-secondary);
}

.grid-weekdays,
.grid-body {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  gap: 4px;
}

.grid-weekdays {
  .weekday {
    font-size: 12px;
    color: var(--text-secondary);
    text-align: center;
  }
}

.grid-body.is-selecting :deep(.day-cell) {
  cursor: crosshair;
}
</style>
