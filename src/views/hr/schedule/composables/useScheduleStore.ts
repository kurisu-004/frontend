// src/views/hr/schedule/composables/useScheduleStore.ts
//
// 2026-10-19 新建：排班日历页的页面级 Pinia setup store。形态照
// `views/wecom/webhooks/composables/useWeComWebhooksStore.ts`（切片形态 + `$dispose` 契约 +
// query hook 外提 + Zod 守门 + mutation 统一失效 + 统一错误入口）。
//
// 不变量（改动前必读）：
// 1. 必须在 HrScheduleCalendar.vue 的 setup 内首调。组件外（路由守卫 / 其它 store）禁止。
// 2. HrScheduleCalendar.vue 的 onBeforeUnmount 必须 `store.$dispose()`：Pinia 是单例，
//    不 dispose 会把「翻到哪个月 / 选中哪个班次 / 填了一半的班次弹窗」泄漏到下次进入。
// 3. 消费侧禁止解构 store（reactive 解构丢响应式）；统一 `store.切片.字段` 访问，不写
//    .value（深代理自动解包）。store 内部闭包持 raw 态，照写 .value。
// 4. 不 import vue-router（本月没有导航需求；作用域切换只改 store 内部态，不改 URL）。
//
// **四个切片**：query（读数据 + 月历游标）/ dialogs（班次弹窗）/ actions（写端点）/
// selection（拖选区间 + 批量草稿）。第四个切片是本域特有的：**拖选区间同时活在月历格与批量
// 浮条两个组件里**，而两者都不是壳 —— 塞进壳里就等于让壳持有状态（违反壳「只拼装」的
// 职责），塞进月历里则浮条拿不到。它只存 UI 态、不进任何请求体的重复来源。
//
// ⚠️ **失效编排是本文件最容易写错的一处**：全局日历一变，**每个班次的「最终日型」派生值
//   全变**（`effective_day_type` 是叠加覆盖行之后的结果），所以写全局日历必须连带失效
//   `qk.hrShiftCalendarPrefix`；只失效 `hrCalendarDaysPrefix` 会让班次日历显示上一套推导值。
//
// ⚠️ **updateHrShift 的「可选列缺省 = 不改、显式 null = 清空」**：`submit` 里对 `color` /
//   `remark` 逐列比对原行值 —— 没动就不发这个键（**不发 `null`**），显式清空才发 `null`。

import { computed, reactive, ref } from 'vue';
import { defineStore } from 'pinia';
import { ElMessage } from 'element-plus';
import { useMutation, useQueryClient } from '@tanstack/vue-query';
import {
  createHrShift,
  deactivateHrShift,
  deleteHrCalendarDays,
  deleteHrShiftCalendarDays,
  saveHrCalendarDays,
  saveHrShiftCalendarDays,
  updateHrShift,
} from '@/api/hr';
import { qk } from '@/composables/queries/keys';
import type {
  CreateShiftPayload,
  HrCalendarDayInput,
  HrCalendarDaysDeletePayload,
  HrCalendarRangeQuery,
  HrShiftCalendarDayInput,
  HrDayType,
  UpdateShiftPayload,
} from '@/types/hr';
import {
  initialShiftForm,
  shiftFormSchema,
  toShiftFieldErrors,
  type HrCalendarDayData,
  type HrShiftCalendarDayData,
  type HrShiftData,
  type ShiftFormFieldErrors,
  type ShiftFormModel,
} from '../hrScheduleSchema';
import { HR_SCHEDULE_ERROR_CODES, hrErrorText } from '../hrErrorText';
import { isWorkdayDayType } from '../utils/dayType';
import { addDaysIso, buildMonthGrid, daysBetween, monthBounds } from '../utils/monthGrid';
import { useHrCalendarQuery, useHrShiftsQuery, type ScheduleScope } from './useScheduleQueries';

/** 后端区间约束：跨度 ≤ 366 天（越界 21904）。月视图自身的区间恒 ≤ 31 天，这个上界是给
 *  「用户把选区一路拖出去」这类极端操作兜底的夹紧点。 */
const MAX_RANGE_DAYS = 366;

/** 月历一格归一化后的视图对象。
 *
 *  两种作用域的出参形状不同（全局日历行带 `name` / `derived`，班次日历行带
 *  `global_day_type` / `is_override`），月历格与单元格编辑器却只想要「今天是什么日型、
 *  有没有被覆盖过」这一组判据。归一化收在 store 的 `calendarDays` 里，下游不必各写一遍
 *  作用域分支。 */
export interface ScheduleDayView {
  iso: string;
  /** 当前作用域下生效的日型（班次作用域 = `effective_day_type`）。 */
  dayType: HrDayType;
  /** 全局日历那天的日型（全局作用域下与 `dayType` 相同）。 */
  globalDayType: HrDayType;
  /** 节假日名（只有全局日历行有；班次作用域恒为 null —— 班次行的可空列是 `remark`）。 */
  name: string | null;
  /** 全局那行是不是按星期兜底推出来的（`derived`）。班次作用域下恒 false。 */
  derived: boolean;
  /** 该天有没有本班次的覆盖行（全局作用域下恒 false）。 */
  isOverride: boolean;
  /** 是否算上班。班次作用域读后端算好的 `is_workday`，全局作用域前端本地判
   *  （`isHrWorkday`）—— 两者同源，不会打架。 */
  workday: boolean;
}

/** 本月统计（顶部那一行）。口径都按**当月格**算，补格不计入。 */
export interface ScheduleMonthStats {
  workdays: number;
  restDays: number;
  overrides: number;
  makeupWorkdays: number;
}

/** 本地零点取「今天」的年月（翻月的默认落点）。 */
function currentMonth(): { year: number; month: number } {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1 };
}

/** 闭区间 `[from, to]` 的日期串枚举（升序）。非法串 / from > to 返回空数组。 */
function eachDate(from: string, to: string): string[] {
  const span = daysBetween(from, to);
  if (span < 0) return [];
  const out: string[] = [];
  for (let i = 0; i <= span; i += 1) out.push(addDaysIso(from, i));
  return out;
}

export const useScheduleStore = defineStore('hr-schedule', () => {
  // ⚠️ 必须在 setup 第一行捕获（Pinia 不给 action wrapper / listener 注入上下文，
  // `useQueryClient()` 的守卫会抛）。
  const qc = useQueryClient();

  // enabled 闸门：默认 false，由壳的 onMounted 调 `query.openGate()` 开闸。
  // 本页没有持久化筛选（配置型页面），所以**不叫 restoreState**。
  const ready = ref(false);

  /** 开闸（壳的 onMounted 调）：true 之后两条 query 首打一次。 */
  function openGate(): void {
    ready.value = true;
  }

  // ============ 作用域与月历游标 ============
  /** 当前编辑作用域。月历据此切端点（端点 1 / 端点 8）与切换单元格编辑器的动作集。 */
  const scope = ref<ScheduleScope>('global');
  /** 月历游标（1-based 月）。URL 不带月份（不变量 #4），刷新回到当月。 */
  const cursor = ref<{ year: number; month: number }>(currentMonth());
  /** 本月区间（`from` = 当月 1 日、`to` = 当月最后一天），两条读端点的查询参数。 */
  const range = computed<HrCalendarRangeQuery>(() =>
    monthBounds(cursor.value.year, cursor.value.month),
  );
  /** 42 格月历（月历格与统计共用同一份，避免两处各生成一次而某处忘了带年份判定）。 */
  const cells = computed(() => buildMonthGrid(cursor.value.year, cursor.value.month));

  // ============ 切片：query（两条读端点）============
  const shiftsQuery = useHrShiftsQuery({ enabled: ready });
  const calendarQuery = useHrCalendarQuery({ enabled: ready, scope, range });

  /** 班次栏数据。**恒为数组**（拿不到时给 `[]`，页面据此渲染空态）。 */
  const shifts = computed<HrShiftData[]>(() => [...(shiftsQuery.data.value ?? [])]);
  /** 当前作用域的数据，已归一化成 `ScheduleDayView` 并按 `cal_date` 建索引。 */
  const calendarDays = computed<Map<string, ScheduleDayView>>(() => {
    const map = new Map<string, ScheduleDayView>();
    const sc = scope.value;
    const rows: Array<HrCalendarDayData | HrShiftCalendarDayData> = calendarQuery.data.value ?? [];
    for (const row of rows) {
      if (sc === 'global') {
        const d = row as HrCalendarDayData;
        map.set(d.cal_date, {
          iso: d.cal_date,
          dayType: d.day_type,
          globalDayType: d.day_type,
          name: d.name,
          derived: d.derived,
          isOverride: false,
          workday: isWorkdayDayType(d.day_type),
        });
      } else {
        const d = row as HrShiftCalendarDayData;
        map.set(d.cal_date, {
          iso: d.cal_date,
          dayType: d.effective_day_type,
          globalDayType: d.global_day_type,
          name: null,
          derived: false,
          isOverride: d.is_override,
          workday: d.is_workday,
        });
      }
    }
    return map;
  });

  const loading = computed(() => shiftsQuery.isFetching.value || calendarQuery.isFetching.value);
  /** 顶部错误条文案：班次栏与月历两条读端点的错误合并成一条（页面只有一条告警位）。 */
  const listErrorText = computed<string | null>(() => {
    if (shiftsQuery.error.value) return hrErrorText(shiftsQuery.error.value, '班次列表加载失败');
    if (calendarQuery.error.value) return hrErrorText(calendarQuery.error.value, '日历加载失败');
    return null;
  });

  /** 本月统计：只数当月格（补格不计入）。 */
  const stats = computed<ScheduleMonthStats>(() => {
    const out: ScheduleMonthStats = { workdays: 0, restDays: 0, overrides: 0, makeupWorkdays: 0 };
    for (const cell of cells.value) {
      if (!cell.inMonth) continue;
      const day = calendarDays.value.get(cell.iso);
      if (!day) continue;
      if (day.workday) out.workdays += 1;
      else out.restDays += 1;
      if (day.isOverride) out.overrides += 1;
      if (day.dayType === 'MAKEUP_WORKDAY') out.makeupWorkdays += 1;
    }
    return out;
  });

  /** 当前作用域的人类可读名（「正在编辑：全局日历」/「正在编辑：夜班」）。 */
  const scopeLabel = computed(() => (scope.value === 'global' ? '全局日历' : scope.value.name));
  /** 当前作用域是否班次（决定「清空本月覆盖」按钮与批量「清除覆盖」是否可用）。 */
  const scopeIsShift = computed(() => scope.value !== 'global');

  // ============ 切片：selection（拖选区间 + 批量草稿）============
  /** 当前拖选区间（升序 `[from, to]`），`null` = 没选。 */
  const selectedRange = ref<{ from: string; to: string } | null>(null);
  /** 批量动作的日型草稿（`null` = 浮条上还没选档）。 */
  const draftDayType = ref<HrDayType | null>(null);
  /** `CUSTOM_LEAVE` 必填的名称草稿（其余档忽略）。 */
  const draftName = ref('');

  function setSelectedRange(range: { from: string; to: string } | null): void {
    selectedRange.value = range;
    draftDayType.value = null;
    draftName.value = '';
  }

  function clearSelection(): void {
    setSelectedRange(null);
  }

  /** 批量作用的天数（含两端）。没选区时给 0。 */
  const selectedCount = computed(() => {
    const r = selectedRange.value;
    return r ? daysBetween(r.from, r.to) + 1 : 0;
  });

  // ============ 切片：dialogs（班次新增 / 编辑弹窗）============
  const shiftDialogVisible = ref(false);
  const shiftDialogMode = ref<'create' | 'edit'>('create');
  /** 正在编辑的那一行（`null` = 新建）。**OCC 锚 `version` 从它身上取**。 */
  const editingShift = ref<HrShiftData | null>(null);
  const shiftForm = reactive<ShiftFormModel>(initialShiftForm());
  const shiftFieldErrors = ref<ShiftFormFieldErrors>({});
  /** 正在停用的行 id（`null` = 无）。按行挂 loading，避免整列一起转圈。 */
  const deactivatingRowId = ref<string | null>(null);

  function openCreateShift(): void {
    shiftDialogMode.value = 'create';
    editingShift.value = null;
    Object.assign(shiftForm, initialShiftForm());
    shiftFieldErrors.value = {};
    shiftDialogVisible.value = true;
  }

  function openEditShift(row: HrShiftData): void {
    shiftDialogMode.value = 'edit';
    editingShift.value = row;
    Object.assign(shiftForm, {
      code: row.code,
      name: row.name,
      color: row.color,
      // 深拷贝：弹窗里的拖拽 / 删段改的是这个数组，不该回污染 query 缓存里的行对象。
      segments: row.segments.map((s) => ({ ...s })),
      sort_order: row.sort_order,
      remark: row.remark,
    });
    shiftFieldErrors.value = {};
    shiftDialogVisible.value = true;
  }

  function closeShiftDialog(): void {
    shiftDialogVisible.value = false;
  }

  /** 表单校验：Zod 过一遍（含 V1–V6 的 `validateSegments`），把 issue 聚合到字段红字。
   *
   * @returns true = 可提交（已把规范化值写回表单）；false = 已提示、已标红。 */
  function validateShiftForm(): boolean {
    const parsed = shiftFormSchema.safeParse({ ...shiftForm });
    if (!parsed.success) {
      shiftFieldErrors.value = toShiftFieldErrors(parsed.error.issues);
      ElMessage.warning('请先修正表单中标红的字段');
      return false;
    }
    Object.assign(shiftForm, parsed.data);
    shiftFieldErrors.value = {};
    return true;
  }

  // ============ 切片：actions（六条写端点）============
  /** 写完立即失效。失效是「写完立即看到自己那笔」的优化，不是跨页面写的一致性保证。 */
  function invalidate(keys: ReadonlyArray<ReadonlyArray<unknown>>): Promise<void> {
    return Promise.all(keys.map((queryKey) => qc.invalidateQueries({ queryKey }))).then(
      () => undefined,
    );
  }

  const CALENDAR_KEYS = [qk.hrCalendarDaysPrefix, qk.hrShiftCalendarPrefix] as const;
  const SHIFT_CALENDAR_KEYS = [qk.hrShiftCalendarPrefix] as const;
  const SHIFT_KEYS = [qk.hrShiftsPrefix] as const;

  /**
   * 六条写端点的统一失败入口。
   *
   * ⚠️ **失败也失效**：21906（往停用班次写）/ 40901（OCC 冲突）说明本端副本在失败那一刻
   *   已经不等于真源 —— 只有后端知道谁被停用了、谁改了行。
   * ⚠️ 40901 单独分支：它是 OCC 冲突，提示与动作都与业务失败不同（warning 而非 error）。
   */
  async function handleWriteError(
    e: Error & { code?: number },
    keys: ReadonlyArray<ReadonlyArray<unknown>>,
    fallback: string,
  ): Promise<void> {
    await invalidate(keys);
    if (e?.code === HR_SCHEDULE_ERROR_CODES.VERSION_CONFLICT) {
      ElMessage.warning('配置已被他人修改，请刷新后重试');
      return;
    }
    ElMessage.error(hrErrorText(e, fallback));
  }

  const saveGlobalDays = useMutation({
    mutationKey: ['hr', 'save-calendar-days'],
    mutationFn: (items: HrCalendarDayInput[]) => saveHrCalendarDays({ items }),
    onSuccess: async () => {
      await invalidate(CALENDAR_KEYS);
      ElMessage.success('日历已更新');
    },
    onError: (e: Error & { code?: number }) => handleWriteError(e, CALENDAR_KEYS, '更新日历失败'),
  });

  const deleteGlobalDays = useMutation({
    mutationKey: ['hr', 'delete-calendar-days'],
    mutationFn: (payload: HrCalendarDaysDeletePayload) => deleteHrCalendarDays(payload),
    onSuccess: async () => {
      await invalidate(CALENDAR_KEYS);
      ElMessage.success('已恢复默认');
    },
    onError: (e: Error & { code?: number }) => handleWriteError(e, CALENDAR_KEYS, '恢复默认失败'),
  });

  const saveShiftDays = useMutation({
    mutationKey: ['hr', 'save-shift-calendar-days'],
    mutationFn: (v: { shiftId: string; items: HrShiftCalendarDayInput[] }) =>
      saveHrShiftCalendarDays(v.shiftId, { items: v.items }),
    onSuccess: async () => {
      await invalidate(SHIFT_CALENDAR_KEYS);
      ElMessage.success('班次日历已更新');
    },
    onError: (e: Error & { code?: number }) =>
      handleWriteError(e, SHIFT_CALENDAR_KEYS, '更新班次日历失败'),
  });

  const deleteShiftDays = useMutation({
    mutationKey: ['hr', 'delete-shift-calendar-days'],
    mutationFn: (v: { shiftId: string; payload: HrCalendarDaysDeletePayload }) =>
      deleteHrShiftCalendarDays(v.shiftId, v.payload),
    onSuccess: async () => {
      await invalidate(SHIFT_CALENDAR_KEYS);
      ElMessage.success('已清除覆盖');
    },
    onError: (e: Error & { code?: number }) =>
      handleWriteError(e, SHIFT_CALENDAR_KEYS, '清除覆盖失败'),
  });

  const createShift = useMutation({
    mutationKey: ['hr', 'create-shift'],
    mutationFn: (payload: CreateShiftPayload) => createHrShift(payload),
    onSuccess: async () => {
      await invalidate(SHIFT_KEYS);
      ElMessage.success('班次已创建');
    },
    onError: (e: Error & { code?: number }) => handleWriteError(e, SHIFT_KEYS, '创建班次失败'),
  });

  const updateShift = useMutation({
    mutationKey: ['hr', 'update-shift'],
    mutationFn: (v: { id: string; body: UpdateShiftPayload }) => updateHrShift(v.id, v.body),
    onSuccess: async () => {
      await invalidate(SHIFT_KEYS);
      ElMessage.success('班次已保存');
    },
    onError: (e: Error & { code?: number }) => handleWriteError(e, SHIFT_KEYS, '保存班次失败'),
  });

  const deactivateShift = useMutation({
    mutationKey: ['hr', 'deactivate-shift'],
    // ⚠️ 收**整行**而不是 id：停用端点的 body 必填 `version`（OCC 锚），只传 id 必然发出
    // 一个 `{}` ⇒ 后端 422 纯文本、连业务码都没有。
    mutationFn: (row: HrShiftData) => deactivateHrShift(row.id, { version: row.version }),
    onSuccess: async () => {
      await invalidate(SHIFT_KEYS);
      ElMessage.success('班次已停用');
    },
    onError: (e: Error & { code?: number }) => handleWriteError(e, SHIFT_KEYS, '停用班次失败'),
  });

  /** 写端点的统一忙态（弹窗保存按钮 / 批量浮条共用）。 */
  const writing = computed(
    () =>
      saveGlobalDays.isPending.value ||
      deleteGlobalDays.isPending.value ||
      saveShiftDays.isPending.value ||
      deleteShiftDays.isPending.value ||
      createShift.isPending.value ||
      updateShift.isPending.value ||
      deactivateShift.isPending.value,
  );

  /** 提交班次弹窗：按 `shiftDialogMode` 分派新建 / 改档。校验不过不发请求。
   *
   *  ⚠️ **改档的可选列语义**：`color` / `remark` 逐列与原行比对 —— 值没变就**不发这个键**
   *  （缺省 = 不改），用户显式清空（`null` ≠ 原值）才发 `null`。把两种情况统一成一个
   *  `null` 发出去，「没动颜色」就会把库里的颜色抹掉。 */
  async function submitShift(): Promise<boolean> {
    if (!validateShiftForm()) return false;
    const base = {
      code: shiftForm.code,
      name: shiftForm.name,
      segments: shiftForm.segments,
      sort_order: shiftForm.sort_order,
    };
    try {
      if (shiftDialogMode.value === 'edit' && editingShift.value) {
        const row = editingShift.value;
        const body: UpdateShiftPayload = {
          // version 是 OCC 锚，必须取**正在编辑那一行**的当前值。
          version: row.version,
          ...base,
        };
        if (shiftForm.color !== row.color) body.color = shiftForm.color;
        if ((shiftForm.remark ?? null) !== row.remark) body.remark = shiftForm.remark;
        await updateShift.mutateAsync({ id: row.id, body });
      } else {
        await createShift.mutateAsync({
          ...base,
          color: shiftForm.color,
          remark: shiftForm.remark,
        });
      }
      closeShiftDialog();
      return true;
    } catch {
      // 错误已由 mutation 的 onError 提示，弹窗保持打开让用户改完重试。
      return false;
    }
  }

  /** 停用班次（**软删**：行仍在库里，只是 `is_active=false`）。二次确认由调用方做。 */
  async function deactivate(row: HrShiftData): Promise<void> {
    deactivatingRowId.value = row.id;
    try {
      await deactivateShift.mutateAsync(row);
    } catch {
      /* 错误已由 onError 提示 */
    } finally {
      deactivatingRowId.value = null;
    }
  }

  /** 单元格编辑器正在编辑的那一天（由月历在打开弹层时写入；空串 = 没打开）。 */
  const activeIso = ref<string>('');

  /** 单日改日型（单元格编辑器的「应用」）。作用域决定走端点 2 还是端点 9。 */
  async function setDay(dayType: HrDayType, name?: string | null): Promise<boolean> {
    const sc = scope.value;
    try {
      if (sc === 'global') {
        await saveGlobalDays.mutateAsync([
          { cal_date: activeIso.value, day_type: dayType, name: name ?? null },
        ]);
      } else {
        await saveShiftDays.mutateAsync({
          shiftId: sc.id,
          items: [{ cal_date: activeIso.value, day_type: dayType }],
        });
      }
      return true;
    } catch {
      return false;
    }
  }

  /** 单日恢复默认 / 恢复继承全局（删那一行的显式配置）。 */
  async function resetDay(): Promise<boolean> {
    const sc = scope.value;
    try {
      if (sc === 'global') {
        await deleteGlobalDays.mutateAsync({ dates: [activeIso.value] });
      } else {
        await deleteShiftDays.mutateAsync({
          shiftId: sc.id,
          payload: { dates: [activeIso.value] },
        });
      }
      return true;
    } catch {
      return false;
    }
  }

  /** 拖选区间的**批量**写：一次请求覆盖整段，不逐日循环。
   *
   *  ⚠️ 越界夹紧：`from > to` 或跨度 > 366 天（后端 21904）一律不发请求，只提示。 */
  async function applySelection(dayType: HrDayType, name?: string | null): Promise<boolean> {
    const r = selectedRange.value;
    if (!r) return false;
    const span = daysBetween(r.from, r.to);
    if (span < 0 || span > MAX_RANGE_DAYS) {
      ElMessage.warning('所选区间不合法或过大（跨度不能超过 366 天），请缩小后重试');
      return false;
    }
    const dates = eachDate(r.from, r.to);
    const sc = scope.value;
    try {
      if (sc === 'global') {
        await saveGlobalDays.mutateAsync(
          dates.map((cal_date) => ({ cal_date, day_type: dayType, name: name ?? null })),
        );
      } else {
        await saveShiftDays.mutateAsync({
          shiftId: sc.id,
          items: dates.map((cal_date) => ({ cal_date, day_type: dayType })),
        });
      }
      clearSelection();
      return true;
    } catch {
      return false;
    }
  }

  /** 拖选区间的**批量**清除：全局作用域 = 删显式行；班次作用域 = 删覆盖行（恢复继承全局）。 */
  async function clearSelected(): Promise<boolean> {
    const r = selectedRange.value;
    if (!r) return false;
    const sc = scope.value;
    try {
      if (sc === 'global') {
        await deleteGlobalDays.mutateAsync({ from: r.from, to: r.to });
      } else {
        await deleteShiftDays.mutateAsync({ shiftId: sc.id, payload: { from: r.from, to: r.to } });
      }
      clearSelection();
      return true;
    } catch {
      return false;
    }
  }

  /** 「清空本月覆盖」：按 `{from, to}` 区间删班次覆盖行（端点 10 的区间口径）。 */
  async function clearMonthOverrides(): Promise<boolean> {
    const sc = scope.value;
    if (sc === 'global') return false;
    try {
      await deleteShiftDays.mutateAsync({
        shiftId: sc.id,
        payload: { from: range.value.from, to: range.value.to },
      });
      return true;
    } catch {
      return false;
    }
  }

  // ============ 切片：导航（月历游标 / 作用域）============
  /** 切作用域：切班次时把拖选区清掉（上一次的选区属于上一个作用域的日历）。 */
  function selectScope(next: ScheduleScope): void {
    if (scope.value !== next) clearSelection();
    scope.value = next;
  }

  /** 月历翻页（`delta` = ±1 月）。跨年由 `new Date(year, month-1+delta, 1)` 自然处理。 */
  function gotoMonth(delta: number): void {
    const d = new Date(cursor.value.year, cursor.value.month - 1 + delta, 1);
    cursor.value = { year: d.getFullYear(), month: d.getMonth() + 1 };
    clearSelection();
  }

  /** 回到本月。 */
  function gotoThisMonth(): void {
    cursor.value = currentMonth();
    clearSelection();
  }

  const query = {
    shifts,
    calendarDays,
    cells,
    range,
    cursor,
    scope,
    scopeLabel,
    scopeIsShift,
    stats,
    loading,
    listErrorText,
    /** 开 enabled 闸门（壳的 onMounted 调）。 */
    openGate,
    refreshCalendar: calendarQuery.fetchCalendar,
    refreshShifts: shiftsQuery.fetchShifts,
  };

  const dialogs = {
    shiftVisible: shiftDialogVisible,
    shiftMode: shiftDialogMode,
    editingShift,
    shiftForm,
    shiftFieldErrors,
    /** 单元格编辑器正在编辑的那一天（空串 = 没打开）。 */
    activeIso,
    openCreateShift,
    openEditShift,
    closeShiftDialog,
  };

  const actions = {
    /** 写端点的统一忙态：班次弹窗保存按钮与批量浮条共用。 */
    writing,
    /** 正在停用的行 id（`null` = 无）。 */
    deactivatingRowId,
    submitShift,
    deactivate,
    setDay,
    resetDay,
    applySelection,
    clearSelected,
    clearMonthOverrides,
    selectScope,
    gotoMonth,
    gotoThisMonth,
  };

  const selection = {
    range: selectedRange,
    count: selectedCount,
    draftDayType,
    draftName,
    setSelectedRange,
    clearSelection,
  };

  return {
    query,
    dialogs,
    actions,
    selection,
  };
});
