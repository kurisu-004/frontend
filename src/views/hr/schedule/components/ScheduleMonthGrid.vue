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

  2026-10-16 改：①「本月」去掉 `text`（三个翻页按钮形态一致）；② 工具栏右侧的提示文字
  换成「清空本月覆盖」（页面级的图例 / 作用域两张卡退役后，它是这个动作在页面上**唯一**的入口）；
  ③ 拖选过程中按本地 anchor + hover 现算实时选区（见 `liveRange`）；④ 色带改复数段。
-->
<template>
  <div class="month-grid" @click.capture="onRootClickCapture">
    <div class="grid-toolbar">
      <div class="grid-nav">
        <el-button size="small" @click="emit('gotoMonth', -1)">上一月</el-button>
        <span class="grid-title">{{ cursor.year }} 年 {{ cursor.month }} 月</span>
        <el-button size="small" @click="emit('gotoMonth', 1)">下一月</el-button>
        <!-- ⚠️ 三个翻页按钮必须同形态（原先只有它带 `text`，一个默认、一个文字按钮）。 -->
        <el-button size="small" @click="emit('gotoToday')">本月</el-button>
      </div>

      <!-- 「清空本月覆盖」是端点 10 在页面上**唯一**的入口（页面级的作用域卡退役后搬到这里），
           二次确认仍在壳里（`HrScheduleCalendar.onClearMonthOverrides`）。 -->
      <el-button
        v-if="scopeIsShift && canEdit"
        size="small"
        type="danger"
        plain
        :loading="writing"
        @click="emit('clearMonthOverrides')"
      >
        清空本月覆盖
      </el-button>
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
          :bands="bandsOf(cell.iso)"
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

import { computed, onBeforeUnmount, ref } from 'vue';
import type { HrDayType } from '@/types/hr';
import ScheduleDayCell from './ScheduleDayCell.vue';
import ScheduleDayEditor from './ScheduleDayEditor.vue';
import type { MonthCell } from '../utils/monthGrid';
import { isoMinMax } from '../utils/monthGrid';
import type { ShiftBandView, ScheduleDayView } from '../composables/useScheduleStore';

const props = defineProps<{
  cells: MonthCell[];
  /** 归一化后的当月数据（按 ISO 索引；缺键 = 后端没返那天）。 */
  calendarDays: Map<string, ScheduleDayView>;
  cursor: { year: number; month: number };
  scopeIsShift: boolean;
  scopeLabel: string;
  /** 有没有排班管理权限（false = 拖选整体禁用）。 */
  canEdit: boolean;
  /** 写端点忙态（透传给单元格编辑器的「应用」按钮与「清空本月覆盖」）。 */
  writing: boolean;
  /** 当前拖选区间（`null` = 没选）。⚠️ 它**只在 mouseup 时才 emit**，拖动过程中读它永远是
   *  上一次的选区 —— 拖动中的实时预览走 `liveRange`。 */
  selectedRange: { from: string; to: string } | null;
}>();

const emit = defineEmits<
  ((e: 'update:selectedRange', range: { from: string; to: string } | null) => void) &
    ((e: 'selectDay', iso: string) => void) &
    ((e: 'dayApply', dayType: HrDayType, name: string | null) => void) &
    ((e: 'dayReset') => void) &
    ((e: 'gotoMonth', delta: number) => void) &
    ((e: 'gotoToday') => void) &
    ((e: 'clearMonthOverrides') => void)
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
/** 共享的空数组常量：`bandsOf` 每个格子都要返回数组，给同一个引用省掉 42 次分配。 */
const EMPTY_BANDS: ShiftBandView[] = [];

/** 格底色带（班次作用域 0 或 1 条、全局作用域 0 或 N 条；休息班次已由 store 滤掉）。 */
function bandsOf(iso: string): ShiftBandView[] {
  return props.calendarDays.get(iso)?.bands ?? EMPTY_BANDS;
}

// ---- 拖选 ----
const dragging = ref(false);
const anchorIso = ref('');
const hoverIso = ref('');
/** 刚拖完一次（终点 ≠ 起点）⇒ 吞掉紧随其后的那一次 click。 */
let suppressNextClick = false;
/** 兜底复位 click 拦截的定时器（mouseup 之后的宏任务），见 `onWindowMouseUp`。 */
let suppressResetTimer: ReturnType<typeof setTimeout> | null = null;

/** 当月格（`inMonth = true`）的日期集。补格在集合外 ⇒ 拖选命中判定把它当「没命中」。 */
const inMonthIsos = computed(() => {
  const s = new Set<string>();
  for (const c of props.cells) if (c.inMonth) s.add(c.iso);
  return s;
});

/** `clientX/clientY` 命中哪一格：先取该点最顶层的元素，再上溯到带 `data-date` 的格。
 *
 *  ⚠️ **补格（前后月）在这里就被判成「没命中」**：`ScheduleDayCell` 给所有 42 格都渲染
 *  `data-date`，而 `mousedown` 侧已经用 `inMonth` 挡住了「从补格起拖」。若这里不过滤，从
 *  10-31 向右拖到补格 11-01 就会产出 `{from:'10-31', to:'11-01'}` ⇒ 批量写把**当月之外的
 *  11-01 写进库**，而 invalidate 之后重查的区间不含它 ⇒ 用户看不到任何变化（「补格灰显、
 *  不可点、不可拖选」这条契约的反面）。
 *  ⚠️ `elementFromPoint` 在某些环境（无布局的测试环境）恒返回 null，此时同样**保持上一次的
 *  悬停格**而不是把选区清掉 —— 选区不会因为一次识别失败而跳回起点。 */
function cellAt(clientX: number, clientY: number): string | null {
  if (typeof document.elementFromPoint !== 'function') return null;
  const el = document.elementFromPoint(clientX, clientY);
  if (!el || typeof el.closest !== 'function') return null;
  const iso = el.closest('[data-date]')?.getAttribute('data-date') ?? null;
  if (iso === null || !inMonthIsos.value.has(iso)) return null;
  return iso;
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
  // ⚠️ **兜底复位**：`@click.capture` 只挂在 `.month-grid` 根上，而 click 是在 mouseup 之后
  //   由浏览器派发的 —— 当 mousedown 起在格子里、mouseup 落在根子树之外（如一路拖到右侧
  //   班次栏才松手）时，click 被派发到公共祖先，捕获处理器根本不跑 ⇒ `suppressNextClick`
  //   会一直挂着，把用户**下一次**点月历格静默吞掉。`setTimeout(…, 0)` 是宏任务，必定排在
  //   mouseup 之后同步派发的那个 click 之后 ⇒ 只当兜底，正常路径仍由 `onRootClickCapture`
  //   消费掉。
  if (suppressResetTimer) clearTimeout(suppressResetTimer);
  suppressResetTimer = setTimeout(() => {
    suppressNextClick = false;
    suppressResetTimer = null;
  }, 0);
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

// 不变量：组件在**拖到一半时被卸载**（切月 / 切页 / `$dispose`）也要摘干净 window 监听与
// click 兜底复位定时器，否则残留监听会对着已销毁的 ref 写值。
onBeforeUnmount(() => {
  dragging.value = false;
  detachWindowListeners();
  if (suppressResetTimer) clearTimeout(suppressResetTimer);
  suppressResetTimer = null;
});

// ---- 选区判定 ----
/**
 * 拖动中的实时选区：拖拽期间用本地 anchor+hover 现算，松手后交回 props。
 * ⚠️ `selectedRange` 只在 mouseup 时才 emit，拖动中读它永远是上一次的选区
 * ⇒ 用户看不到「我正在选哪几天」。
 *
 * ⚠️ **按下瞬间（anchor === hover，即「还没拖过一格」）给 `null` 而不是单日区间**：
 *   单击在本页是「打开单日编辑器」，不是「选中这一天」——若此时就给 `{from,to}` 落成同一格，
 *   按下与松手之间会闪一次「已选中」高亮，松手又被 `update:selectedRange(null)` 清掉，闪的是
 *   一条假反馈。拖过至少一格（`anchor !== hover`）才现区间预览。
 *
 * ⚠️ **只管显示，不改 emit 时机与载荷**：`update:selectedRange` 仍然只在 `onWindowMouseUp`
 *   里发一次（松手才落选区 = 拖到一半按 Esc / 切月都不会留下一个没写出的选区）。
 */
const liveRange = computed(() => {
  if (!dragging.value || !anchorIso.value || !hoverIso.value) return props.selectedRange;
  if (anchorIso.value === hoverIso.value) return null;
  const [lo, hi] = isoMinMax(anchorIso.value, hoverIso.value);
  return { from: lo, to: hi };
});

function isSelected(iso: string): boolean {
  return liveRange.value?.from === iso || liveRange.value?.to === iso;
}
function inRange(iso: string): boolean {
  const r = liveRange.value;
  return !!r && iso >= r.from && iso <= r.to;
}
</script>

<style lang="scss" scoped>
/* 2026-10-16：整块月历占满「父级给定的高度」——`.main-content`（MainLayout）是 flex 定高 +
   `overflow: auto`，壳（`HrScheduleCalendar`）逐层 `height: 100%` / `flex: 1` 放到这里。
   ⚠️ **少放行一层整页就退回 auto 高度**：`flex: 1` 需要父级有确定高度，`min-height: 0` 需要
    允许收缩到内容以下，两条缺一不可。 */
.month-grid {
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex: 1;
  min-height: 0;
}

/* 工具栏与表头都是「内容高」的那几行：不许被 flex 压扁（表头被压扁时星期文字会挤成一团）。 */
.grid-toolbar,
.grid-weekdays {
  flex: 0 0 auto;
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

.grid-weekdays,
.grid-body {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  gap: 4px;
}

/* ⚠️ **行数必须写死 6**：`MONTH_GRID_CELLS = 42 = 6 × 7`（`utils/monthGrid.ts`），格数恒定是
   本域刻意的（翻月时格子位置不动）。写成 `auto` 时行高退回内容高，整块月历不占满；写成 6 行
   `1fr` 才是「剩余空间按 6 行均分」。 */
.grid-body {
  grid-template-rows: repeat(6, minmax(0, 1fr));
  flex: 1;
  min-height: 0;
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
