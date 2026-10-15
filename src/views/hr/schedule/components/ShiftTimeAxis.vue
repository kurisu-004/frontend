<!--
  ShiftTimeAxis.vue — ★ 班次时段的双日时间轴编辑器

  2026-10-19 新建。本域最容易做错的一处（绝对时钟轴）就落在本组件，所以口径写在这里：

  **段值是 `cal_date 00:00` 起算的绝对偏移 `'HH:MM'`，`HH ∈ 0..48`。**
    夜班 22:00 → 次日 02:00 = `22:00→26:00`；24h 连做 = `08:00→32:00`。
  「跨天班次的日期归属 = 工作开始时间所在日」由数据结构本身保证，本组件**不做任何跨天推断**。

  **为什么分「当日 / 次日」两行而不是画成一条 48h 单行**：一段最多跨一个午夜（后端 21908
  把总跨度卡在 24:00 内），两行各 24h 时「几点几分」是**墙钟**（用户脑子里的 08:00），而
  48h 单行的刻度是偏移量（用户要心算 `32:00` = 次日 08:00）。前者能一眼看懂，后者不能。

  **禁选已占用区间**：已提交的那几段渲染成实心块，块上 `cursor: not-allowed`，`mousedown`
  命中块时**直接 return**（点击与拖拽都被忽略）；在空白处拖出来的新段若与任一已占用段**相交**
  （邻接不算），松手时转红闪一下并**丢弃**，不进列表。判据是纯函数
  `utils/absTime.ts::findOverlap`，与 V4 的邻接口径一致。

  **seq 由组件自己算**：新段按 `start` 升序插入、`seq = 下标 + 1`（`pickerToSegments` 收口），
  用户不用管序号 —— 提交给后端的永远是连续递增的 1..n。

  **零 Element Plus 控件**：这是自绘的轴，原生 `<input type="time">` / `<select>` / `<button>`
  就够（同时让本组件的单测不必拖 EP 桩）。

  **「结束于」选择器为什么不能省**：UI 有个便利启发式 —— 结束时刻不晚于开始时刻就自动勾「次日」。
  它只影响显示便利，**不承担数据正确性**，而且对 `08:00 → 08:00`（24h 连做）这种相等的情形
  **启发式失效**（判不出是当日 0 长还是次日 24h）。所以每段额外给一个显式的 0/1/2 天选择器，
  启发式只是替用户少点一次。
-->
<template>
  <div ref="rootEl" class="time-axis">
    <!-- 总跨度（V6 的实时反馈）：超 24:00 转红并给一句人话解释。 -->
    <div class="axis-summary">
      <span :class="['axis-span', { 'is-over': spanOver }]"> 总跨度 {{ spanText }} / 24:00 </span>
      <span v-if="spanOver" class="axis-over-hint"> 班次跨度超过 24 小时，与相邻工作日会冲突 </span>
      <span v-else class="axis-hint">在两行空白处按住拖动即可新增时段</span>
    </div>

    <div class="axis-lanes">
      <div v-for="(row, idx) in rows" :key="row.label" class="lane-block">
        <div class="lane-label">{{ row.label }} {{ shortDate(row.date) }}</div>
        <div
          :class="['lane', { 'is-readonly': readonly }]"
          :data-lane="idx"
          @mousedown="onLaneMouseDown(idx, $event)"
        >
          <span
            v-for="(tick, ti) in TICKS"
            :key="tick"
            class="lane-tick"
            :style="{ left: `${(ti / (TICKS.length - 1)) * 100}%` }"
            >{{ tick }}</span
          >
          <span
            v-for="(tick, ti) in TICKS"
            :key="`grid-${tick}`"
            class="lane-grid-line"
            :style="{ left: `${(ti / (TICKS.length - 1)) * 100}%` }"
          />
          <!-- 已提交段（= 已占用区间，禁选） -->
          <div
            v-for="p in piecesOf(idx)"
            :key="p.key"
            :class="['seg-piece', pieceClass(p)]"
            :style="[pieceStyle(p), pieceCursor(p)]"
            :data-occupied="p.seg.start"
            :title="`${p.seg.start} → ${p.seg.end}`"
          />
          <!-- 拖拽预览 / 冲突红闪：与已提交段同一套切片与几何，但没有禁选光标（未落库）。 -->
          <div
            v-for="p in ghostPiecesOf(idx)"
            :key="`ghost-${p.key}`"
            :class="['seg-piece', 'is-ghost', pieceClass(p), { 'is-conflict': ghostConflict }]"
            :style="[pieceStyle(p), pieceCursor(p)]"
          />
        </div>
      </div>
    </div>

    <!-- 段列表（逐段微调 + 删除） -->
    <div class="seg-list">
      <div v-for="(p, i) in pickerList" :key="i" class="seg-row">
        <span class="seg-index">#{{ i + 1 }}</span>
        <input
          class="seg-time"
          type="time"
          step="900"
          :disabled="readonly"
          :value="p.start"
          @change="onStartChange(i, $event)"
        />
        <span class="seg-arrow">→</span>
        <input
          class="seg-time"
          type="time"
          step="900"
          :disabled="readonly"
          :value="p.end"
          @change="onEndChange(i, $event)"
        />
        <label class="seg-endday">
          结束于
          <select
            class="seg-select"
            :disabled="readonly"
            :value="String(p.endDay)"
            @change="onEndDayChange(i, $event)"
          >
            <option value="0">当日</option>
            <option value="1">次日</option>
            <option value="2">+2 日</option>
          </select>
        </label>
        <span class="seg-abs">{{ absTextOf(p) }}</span>
        <button
          v-if="!readonly"
          class="seg-del"
          type="button"
          title="删除该时段"
          @click="removeAt(i)"
        >
          删除
        </button>
      </div>

      <button
        v-if="!readonly"
        class="seg-add"
        type="button"
        :disabled="pickerList.length >= MAX_SEGMENTS"
        :title="pickerList.length >= MAX_SEGMENTS ? '最多 6 段' : '新增一段'"
        @click="addDefault"
      >
        + 新增时段（{{ pickerList.length }}/{{ MAX_SEGMENTS }}）
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
// views/hr/schedule/components/ShiftTimeAxis.vue
//
// 2026-10-19 新建：见文件头。

import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { ShiftSegmentOut } from '@/types/hr';
import {
  ABS_MAX_SEGMENTS,
  MINUTES_PER_DAY,
  absRangeToPicker,
  findOverlap,
  formatAbs,
  parseAbs,
  pickerToSegments,
  segmentsToPickers,
  spanOf,
  toAbsRange,
  type AbsRange,
  type SegmentPickerState,
} from '../utils/absTime';
import { addDaysIso } from '../utils/monthGrid';

const props = withDefaults(
  defineProps<{
    /** 段列表（绝对时钟轴）。受控组件：一切改动都从这里 emit 回父级。 */
    modelValue: ShiftSegmentOut[];
    /** 只读态（没有 `hr.schedule.manage`）：不可拖拽、不可新增 / 删除。 */
    readonly?: boolean;
    /** 行标签用的基准日（`YYYY-MM-DD`）。班次本身不绑定日历日，这个基准只是给两行一个
     *  可读的落点（不传就用本地今天）。 */
    baseDate?: string;
    /** 段块颜色（可空 = 主题蓝）。 */
    color?: string | null;
  }>(),
  { readonly: false, baseDate: '', color: null },
);

const emit = defineEmits<(e: 'update:modelValue', segments: ShiftSegmentOut[]) => void>();

/** 横轴刻度（每 6 小时一格，末尾 24:00 = 行尾）。 */
const TICKS = ['00:00', '06:00', '12:00', '18:00', '24:00'] as const;

/** 拖拽吸附步长（15 分钟）。UI 便利：分钟级的 24h 宽轴点不准。 */
const SNAP = 15;

/** 冲突红闪的停留时长（毫秒）—— 够用户看清「被丢了」，又不至于让人以为是卡住。 */
const REJECT_FLASH_MS = 700;

const MAX_SEGMENTS = ABS_MAX_SEGMENTS;

// ---- 行标签 ----
const base = computed(() => props.baseDate || localToday());
const rows = computed(() => [
  { label: '当日', date: base.value },
  { label: '次日', date: addDaysIso(base.value, 1) || base.value },
]);
function shortDate(iso: string): string {
  return iso.slice(5);
}
/** 本地零点取今天（不引 `new Date('YYYY-MM-DD')` —— 那按 UTC 解读会差一天，见 monthGrid）。 */
function localToday(): string {
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${mm}-${dd}`;
}

// ---- 编辑态（选择器态 ⇄ 绝对段列表的收口在 utils/absTime）----
const pickerList = ref<SegmentPickerState[]>([]);

/** 选择器态的等价判据（值比较，不用 JSON 串 —— 串在字段序变化时会假阴性）。 */
function samePickers(a: readonly SegmentPickerState[], b: readonly SegmentPickerState[]): boolean {
  return (
    a.length === b.length &&
    a.every((p, i) => p.start === b[i]!.start && p.end === b[i]!.end && p.endDay === b[i]!.endDay)
  );
}

/**
 * 父级改动回灌：只有当它与本地草稿**不等价**时才重置，否则用户正在输入的中间态会被冲掉。
 *
 * `immediate: true` 让**首帧**就从 `modelValue` 灌好草稿（回调在响应式上下文里跑，既能读到
 * 最新的 props，也不会被 `vue/no-setup-props-destructure` 判红）。
 */
watch(
  () => props.modelValue,
  (next) => {
    const norm = segmentsToPickers(next);
    if (!samePickers(norm, pickerList.value)) pickerList.value = norm;
  },
  { immediate: true },
);

function commit(list: SegmentPickerState[]): void {
  // 按绝对起点排序（与 `pickerToSegments` 同序）：本地草稿与提交值同序，父级回灌时
  // 不会被判成「外部改动」而重置（用户会看到列表莫名跳一下）。
  const sorted = [...list].sort((a, b) => absStart(a) - absStart(b));
  pickerList.value = sorted;
  emit('update:modelValue', pickerToSegments(sorted));
}

/** 选择器态的绝对起点（分不出就排 0：坏行会先被 `pickerToSegments` 丢掉）。 */
function absStart(p: SegmentPickerState): number {
  return parseAbs(p.start) ?? 0;
}

/** 「+ 新增时段」按钮：接在**最后一段之后**排 1 小时，空列表时给 `08:00→09:00`。
 *
 *  ⚠️ 这只是拖拽之外的兜底路径：末段已经跨到次日（`end > 24:00`）时起点会被夹到 23:00，
 *   可能与末段重叠 —— 那时由表单校验（V4）标红，而不是在这里静默改用户的段。 */
function addDefault(): void {
  if (props.readonly || pickerList.value.length >= MAX_SEGMENTS) return;
  const last = pickerList.value[pickerList.value.length - 1];
  const lastEnd = last ? (parseAbs(last.end) ?? 0) + last.endDay * MINUTES_PER_DAY : 0;
  const start = last ? Math.min(lastEnd, 23 * 60) : 8 * 60;
  const end = Math.min(start + 60, MINUTES_PER_DAY);
  commit([...pickerList.value, absRangeToPicker({ start, end })]);
}

function removeAt(index: number): void {
  if (props.readonly) return;
  commit(pickerList.value.filter((_, i) => i !== index));
}

/** 把一个选择器态显示成「墙钟 + 前缀」：`22:00 → 次日 02:00`。
 *
 *  ⚠️ **前缀与数字必须同源**：前缀已经把「跨了几天」说完了，所以右端打的是**墙钟**
 *  （`02:00`），不能再加 `endDay × 1440` 的偏移 —— 那样会打出「次日 26:00」这种
 *  自相矛盾的串。绝对偏移（`22:00 → 26:00`）是 `types/hr.ts::ShiftSegmentOut` 那一侧的
 *  wire 形态，两种写法各服务一处，不要互相套用。 */
function absTextOf(p: SegmentPickerState): string {
  const s = parseAbs(p.start);
  const e = parseAbs(p.end);
  if (s === null || e === null) return '—';
  const suffix = p.endDay === 1 ? '次日 ' : p.endDay === 2 ? '+2 日 ' : '';
  return `${formatAbs(s)} → ${suffix}${formatAbs(e)}`;
}

function onStartChange(index: number, e: Event): void {
  const v = (e.target as HTMLInputElement).value;
  commit(pickerList.value.map((p, i) => (i === index ? { ...p, start: v } : p)));
}

/** ⚠️ **便利启发式**（见文件头）：结束时刻不晚于开始时刻时自动把「结束于」勾到次日。
 * 它只替用户少点一次，`08:00 → 08:00` 这种 24h 连做判不出来（启发式失效）——所以每段另有
 * 一个显式的 0/1/2 天选择器，用户随时能改回来。 */
function onEndChange(index: number, e: Event): void {
  const v = (e.target as HTMLInputElement).value;
  commit(
    pickerList.value.map((p, i) => {
      if (i !== index) return p;
      const s = parseAbs(p.start);
      const end = parseAbs(v);
      const endDay = s !== null && end !== null && end <= s && p.endDay === 0 ? 1 : p.endDay;
      return { ...p, end: v, endDay };
    }),
  );
}

function onEndDayChange(index: number, e: Event): void {
  const v = Number((e.target as HTMLSelectElement).value);
  const endDay = (v === 1 || v === 2 ? v : 0) as 0 | 1 | 2;
  commit(pickerList.value.map((p, i) => (i === index ? { ...p, endDay } : p)));
}

// ---- 渲染几何 ----
interface Piece {
  key: string;
  seg: ShiftSegmentOut;
  /** 该片在**本行内**的起止分钟（0..1440）。 */
  start: number;
  end: number;
  /** 该段是否横跨两行（跨行段的两片同色无圆角，读成一条）。 */
  cross: boolean;
}

/** 把一个绝对区间切成某一行内的片；该行没覆盖到返回 `[]`。 */
function sliceOf(range: AbsRange, lane: number): { start: number; end: number } | null {
  const lo = Math.max(range.start - lane * MINUTES_PER_DAY, 0);
  const hi = Math.min(range.end - lane * MINUTES_PER_DAY, MINUTES_PER_DAY);
  return hi > lo ? { start: lo, end: hi } : null;
}

/** 已提交段按行切片的渲染件。一段最多跨一个午夜 ⇒ 每段最多两片。 */
function piecesOf(lane: number): Piece[] {
  const out: Piece[] = [];
  for (const seg of props.modelValue) {
    const r = toAbsRange(seg);
    if (!r) continue;
    const s = sliceOf(r, lane);
    if (!s) continue;
    out.push({ key: `seg-${seg.seq}-${lane}`, seg, start: s.start, end: s.end, cross: lane === 0 });
  }
  return out;
}

/** 拖拽预览 / 冲突红闪的渲染件（与已提交段同一套切片，接缝处同样无圆角）。 */
function ghostPiecesOf(lane: number): Piece[] {
  const ghost = drag.value ?? rejected.value;
  if (!ghost) return [];
  const s = sliceOf(ghost, lane);
  if (!s) return [];
  return [
    {
      key: `${lane}`,
      seg: { seq: 0, start: formatAbs(ghost.start), end: formatAbs(ghost.end) },
      start: s.start,
      end: s.end,
      cross: lane === 0,
    },
  ];
}

function pieceStyle(p: Piece): Record<string, string> {
  return {
    left: `${(p.start / MINUTES_PER_DAY) * 100}%`,
    width: `${((p.end - p.start) / MINUTES_PER_DAY) * 100}%`,
    background: props.color ?? 'var(--primary-light)',
  };
}

/** ⚠️ **内联** cursor（不是 CSS 类）：「已占用区间禁选」这条契约要在 happy-dom 下可断言，
 *  而组件 scoped 样式在测试环境不生效。禁选的可观测锚点就是这一个属性。
 *
 *  ⚠️ **只给已提交段挂 `not-allowed`**：拖拽预览（ghost）与红闪冲突块是**尚未落库**的临时
 *  几何，它们上面照样能继续拖（拖到重叠才在松手时被拒），挂上禁选光标会给出「这里点不动」
 *  的假信号。判据是 `seg.seq === 0`（ghost 段的哨兵值，见 `ghostPiecesOf`）。 */
function pieceCursor(p: Piece): Record<string, string> {
  return p.seg.seq === 0 ? {} : { cursor: 'not-allowed' };
}

/** 贴行首（0 点）/ 行尾（24 点）的那一侧不要圆角 —— 跨行段的接缝才读得成一体。 */
function pieceClass(p: Piece): Record<string, boolean> {
  return {
    'is-cross': p.cross,
    'touch-start': p.start === 0,
    'touch-end': p.end === MINUTES_PER_DAY,
  };
}

// ---- 拖拽 ----
const drag = ref<AbsRange | null>(null);
const rejected = ref<AbsRange | null>(null);
const ghostConflict = computed(() => rejected.value !== null);
let dragLaneEl: HTMLElement | null = null;
let rejectTimer: ReturnType<typeof setTimeout> | null = null;

const rootEl = ref<HTMLElement | null>(null);

function laneElement(lane: number): HTMLElement | null {
  return rootEl.value?.querySelector<HTMLElement>(`[data-lane="${lane}"]`) ?? null;
}

/** 命中点所在的那一行（取该点最顶层的元素再上溯到 `[data-lane]`）。
 *  识别不到时**保持上一次的那一行**：预览不会因为一次识别失败跳回行首。 */
function laneElementAt(clientX: number, clientY: number): HTMLElement | null {
  if (typeof document.elementFromPoint !== 'function') return null;
  const el = document.elementFromPoint(clientX, clientY);
  if (!el || typeof el.closest !== 'function') return null;
  return el.closest<HTMLElement>('[data-lane]');
}

/** 屏幕横坐标 → 该行的绝对分钟（吸附 15 分钟；无布局宽度时取行首）。 */
function minuteFromClientX(el: HTMLElement, clientX: number, lane: number): number {
  const rect = el.getBoundingClientRect();
  if (!rect.width) return lane * MINUTES_PER_DAY;
  const ratio = (clientX - rect.left) / rect.width;
  const within = Math.round((ratio * MINUTES_PER_DAY) / SNAP) * SNAP;
  return lane * MINUTES_PER_DAY + Math.min(MINUTES_PER_DAY, Math.max(0, within));
}

function onLaneMouseDown(lane: number, e: MouseEvent): void {
  if (props.readonly) return;
  if (e.button !== 0) return;
  // ⚠️ 已占用段：点击与拖拽**都忽略**（这是「禁止选中已覆盖的时间范围」的落点）。
  if ((e.target as HTMLElement | null)?.closest?.('.seg-piece')) return;
  const el = laneElement(lane);
  if (!el) return;
  dragLaneEl = el;
  const m = minuteFromClientX(el, e.clientX, lane);
  drag.value = { start: m, end: m };
  window.addEventListener('mousemove', onWindowMouseMove);
  window.addEventListener('mouseup', onWindowMouseUp);
}

function onWindowMouseMove(e: MouseEvent): void {
  if (!drag.value) return;
  const el = laneElementAt(e.clientX, e.clientY) ?? dragLaneEl;
  if (!el) return;
  dragLaneEl = el;
  const lane = Number(el.getAttribute('data-lane') ?? 0);
  drag.value = { ...drag.value, end: minuteFromClientX(el, e.clientX, lane) };
}

function onWindowMouseUp(): void {
  window.removeEventListener('mousemove', onWindowMouseMove);
  window.removeEventListener('mouseup', onWindowMouseUp);
  const d = drag.value;
  drag.value = null;
  dragLaneEl = null;
  if (!d) return;
  const range: AbsRange = { start: Math.min(d.start, d.end), end: Math.max(d.start, d.end) };
  // 只是点了一下、没拖出长度 ⇒ 不当成新段。
  if (range.end - range.start < SNAP) return;
  // 与已占用相交 ⇒ 转红并丢弃，不进列表（`findOverlap` 的邻接口径：`08:00~12:00` 与
  // `12:00~17:00` 各画各的，不算冲突）。
  const occupied = props.modelValue.map(toAbsRange).filter((r): r is AbsRange => r !== null);
  if (findOverlap(range, occupied) !== null) {
    rejected.value = range;
    if (rejectTimer) clearTimeout(rejectTimer);
    rejectTimer = setTimeout(() => {
      rejected.value = null;
      rejectTimer = null;
    }, REJECT_FLASH_MS);
    return;
  }
  commit([...pickerList.value, absRangeToPicker(range)]);
}

// ---- 总跨度（V6 的实时反馈）----
const spanMinutes = computed(() => spanOf(props.modelValue));
const spanText = computed(() => formatAbs(spanMinutes.value));
const spanOver = computed(() => spanMinutes.value > MINUTES_PER_DAY);

// 不变量：拖到一半时组件被卸载（弹窗关掉 / `$dispose`）要摘干净 window 监听与红闪定时器，
// 否则残留监听会对着已销毁的 ref 写值。
onBeforeUnmount(() => {
  window.removeEventListener('mousemove', onWindowMouseMove);
  window.removeEventListener('mouseup', onWindowMouseUp);
  if (rejectTimer) clearTimeout(rejectTimer);
});

defineExpose({ spanMinutes, spanOver });
</script>

<style lang="scss" scoped>
.time-axis {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 100%;
}

.axis-summary {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
}

.axis-span {
  font-weight: 600;
  color: var(--text-primary);
}

.axis-span.is-over {
  color: #c45656;
}

.axis-over-hint {
  color: #c45656;
}

.axis-hint {
  color: var(--text-secondary);
}

.lane-block {
  display: flex;
  align-items: center;
  gap: 8px;
}

.lane-label {
  flex: 0 0 88px;
  font-size: 12px;
  color: var(--text-secondary);
  text-align: right;
}

.lane {
  position: relative;
  flex: 1 1 auto;
  height: 56px;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  background: #fbfcfd;
  overflow: hidden;
}

.lane.is-readonly {
  cursor: default;
}

.lane:not(.is-readonly) {
  cursor: crosshair;
}

.lane-tick {
  position: absolute;
  top: 2px;
  transform: translateX(-50%);
  font-size: 10px;
  line-height: 12px;
  color: var(--text-secondary);
  pointer-events: none;
}

.lane-grid-line {
  position: absolute;
  top: 16px;
  bottom: 0;
  width: 1px;
  background: var(--border-color);
  pointer-events: none;
}

.seg-piece {
  position: absolute;
  top: 20px;
  height: 28px;
  border-radius: 3px;
}

.seg-piece.touch-start {
  border-top-left-radius: 0;
  border-bottom-left-radius: 0;
}

.seg-piece.touch-end {
  border-top-right-radius: 0;
  border-bottom-right-radius: 0;
}

.seg-piece.is-ghost {
  z-index: 2;
  opacity: 0.55;
}

.seg-piece.is-ghost.is-conflict {
  background: #c45656;
  opacity: 0.9;
}

.seg-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.seg-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}

.seg-index {
  flex: 0 0 24px;
  color: var(--text-secondary);
}

.seg-time,
.seg-select {
  height: 26px;
  padding: 0 4px;
  border: 1px solid var(--border-color);
  border-radius: 3px;
  font-size: 12px;
}

.seg-time {
  width: 104px;
}

.seg-endday {
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--text-secondary);
}

.seg-abs {
  color: var(--text-secondary);
}

.seg-del,
.seg-add {
  padding: 2px 8px;
  border: 1px solid var(--border-color);
  border-radius: 3px;
  background: var(--white);
  color: var(--text-regular);
  font-size: 12px;
  cursor: pointer;
}

.seg-del {
  color: #c45656;
}

.seg-add:disabled {
  color: var(--text-secondary);
  cursor: not-allowed;
}
</style>
