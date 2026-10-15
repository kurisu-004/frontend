// @vitest-environment happy-dom
// src/views/hr/schedule/composables/__tests__/useScheduleStore.spec.ts
//
// 2026-10-19 新建：排班日历页 store（`useScheduleStore`）单测，形态照
// `views/wecom/webhooks/__tests__/useWeComWebhooksStore.spec.ts`。覆盖本域最容易静默出错的
// 五类点：
//
//  1. **不变量**：enabled 闸门在 `openGate()` 之前**零请求**、开闸后两条 query 各打一次；
//     `$dispose()` 后重建拿到全新作用域 / 弹窗态（Pinia 单例不 dispose 会把「翻到的月份 +
//     填了一半的班次弹窗」泄漏到下次进入）；消费侧全走 `store.切片.字段` 不解构。
//  2. **失效编排**：写**全局日历必须连带失效 `hrShiftCalendarPrefix`** —— 改全局日型会让
//     每个班次的 `effective_day_type` 派生值全变，只失效 `hrCalendarDaysPrefix` 会让班次
//     月历显示上一套推导值（本域最贵的一个坑）。
//  3. **批量一次请求**：拖选区间的写入是 `{items:[...]}` 一次往返，不是逐日循环；清空走
//     `{from,to}` 区间口径。
//  4. **OCC + 「不动 vs 显式清空」**：改档 payload 必带 `version`；`color` / `remark` 只在
//     **值确实变了**时才进 payload（没变就不发这个键 —— 发 `null` 等于把库里的值抹了）。
//  5. **前端校验前置**：时段 V1–V6 不过时**不发请求**，只标红 `segments` 字段。
//
// mock 策略：`vi.mock('@/api/hr')` 十端点全桩；`vi.mock('element-plus')` 把 ElMessage 桩成
// no-op。顺序硬约束：pinia 先、VueQueryPlugin 后（store setup 首行 `useQueryClient()`）。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';

vi.mock('element-plus', () => ({
  ElMessage: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
  ElMessageBox: { confirm: vi.fn(async () => undefined), alert: vi.fn(async () => undefined) },
}));

const listHrCalendarDaysMock = vi.fn();
const saveHrCalendarDaysMock = vi.fn();
const deleteHrCalendarDaysMock = vi.fn();
const listHrShiftsMock = vi.fn();
const createHrShiftMock = vi.fn();
const updateHrShiftMock = vi.fn();
const deactivateHrShiftMock = vi.fn();
const getHrShiftCalendarMock = vi.fn();
const saveHrShiftCalendarDaysMock = vi.fn();
const deleteHrShiftCalendarDaysMock = vi.fn();

vi.mock('@/api/hr', () => ({
  listHrCalendarDays: (...a: unknown[]) => listHrCalendarDaysMock(...a),
  saveHrCalendarDays: (...a: unknown[]) => saveHrCalendarDaysMock(...a),
  deleteHrCalendarDays: (...a: unknown[]) => deleteHrCalendarDaysMock(...a),
  listHrShifts: (...a: unknown[]) => listHrShiftsMock(...a),
  createHrShift: (...a: unknown[]) => createHrShiftMock(...a),
  updateHrShift: (...a: unknown[]) => updateHrShiftMock(...a),
  deactivateHrShift: (...a: unknown[]) => deactivateHrShiftMock(...a),
  getHrShiftCalendar: (...a: unknown[]) => getHrShiftCalendarMock(...a),
  saveHrShiftCalendarDays: (...a: unknown[]) => saveHrShiftCalendarDaysMock(...a),
  deleteHrShiftCalendarDays: (...a: unknown[]) => deleteHrShiftCalendarDaysMock(...a),
}));

import { ElMessage } from 'element-plus';
import { useScheduleStore } from '../useScheduleStore';
import { HR_SCHEDULE_ERROR_CODES } from '../../hrErrorText';
import type { HrCalendarDayData, HrShiftData } from '../../hrScheduleSchema';

function shiftRow(over: Partial<HrShiftData> = {}): HrShiftData {
  return {
    id: '9000000000000901',
    version: 4,
    code: 'DAY',
    name: '白班',
    color: '#1e4d8b',
    segments: [
      { seq: 1, start: '08:00', end: '12:00' },
      { seq: 2, start: '13:00', end: '17:00' },
    ],
    is_active: true,
    sort_order: 1,
    remark: null,
    cross_day: false,
    overflow_minutes: 0,
    daily_minutes: 480,
    created_at: '2026-10-19 08:00:00',
    updated_at: '2026-10-19 08:00:00',
    ...over,
  };
}

function dayRow(iso: string, over: Partial<HrCalendarDayData> = {}): HrCalendarDayData {
  return { cal_date: iso, day_type: 'WORKDAY', name: null, derived: false, ...over };
}

const SHIFTS = {
  items: [
    shiftRow(),
    shiftRow({ id: '9000000000000902', code: 'NIGHT', name: '夜班', version: 1 }),
  ],
};
const GLOBAL_DAYS = {
  items: [
    dayRow('2026-10-01', { day_type: 'STATUTORY_HOLIDAY', name: '国庆' }),
    dayRow('2026-10-03', { day_type: 'REST_DAY', derived: true }),
  ],
};
const SHIFT_DAYS = {
  items: [
    {
      cal_date: '2026-10-05',
      global_day_type: 'WORKDAY' as const,
      effective_day_type: 'REST_DAY' as const,
      is_workday: false,
      is_override: true,
    },
  ],
};

function setupApp(): QueryClient {
  const app = createApp({});
  app.use(createPinia());
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: 0 }, mutations: { retry: 0 } },
  });
  app.use(VueQueryPlugin, { queryClient });
  setActivePinia(app.config.globalProperties.$pinia);
  return queryClient;
}

function tick(ms = 30): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function apiError(code: number, message = `后端 ${code}`): Error & { code: number } {
  return Object.assign(new Error(message), { code });
}

let qc: QueryClient;

beforeEach(() => {
  vi.clearAllMocks();
  qc = setupApp();
  listHrShiftsMock.mockResolvedValue(SHIFTS);
  listHrCalendarDaysMock.mockResolvedValue(GLOBAL_DAYS);
  getHrShiftCalendarMock.mockResolvedValue(SHIFT_DAYS);
  saveHrCalendarDaysMock.mockResolvedValue(undefined);
  deleteHrCalendarDaysMock.mockResolvedValue(undefined);
  saveHrShiftCalendarDaysMock.mockResolvedValue(undefined);
  deleteHrShiftCalendarDaysMock.mockResolvedValue(undefined);
  createHrShiftMock.mockResolvedValue(shiftRow({ version: 1 }));
  updateHrShiftMock.mockResolvedValue(shiftRow({ version: 5 }));
  deactivateHrShiftMock.mockResolvedValue(shiftRow({ is_active: false, version: 5 }));
});

/** 起一个开了闸门的 store（多数用例的下一步都是开闸后操作）。 */
async function readyStore() {
  const store = useScheduleStore();
  store.query.openGate();
  await tick();
  return store;
}

describe('useScheduleStore — 不变量（闸门 / 切片解包 / $dispose）', () => {
  it('I1：openGate() 之前零请求；开闸后班次栏 + 全局月历各打一次', async () => {
    const store = useScheduleStore();
    await tick();
    expect(listHrShiftsMock).not.toHaveBeenCalled();
    expect(listHrCalendarDaysMock).not.toHaveBeenCalled();

    store.query.openGate();
    await tick();
    expect(listHrShiftsMock).toHaveBeenCalledTimes(1);
    // ⚠️ 班次栏必须带 `include_inactive: true`（停用是软删，不带就再也点不回来）。
    expect(listHrShiftsMock.mock.calls[0]![0]).toEqual({ include_inactive: true });
    expect(listHrCalendarDaysMock).toHaveBeenCalledTimes(1);
  });

  it('I2：切片读不写 .value（嵌套 ref 自动解包），且代理 set 能写回', async () => {
    const store = await readyStore();
    expect(store.query.shifts).toHaveLength(2);
    // 出参是**信封**：hook 里 parse 完已取 `.items`，store 侧是数组而不是 `{items:[]}`。
    expect(Array.isArray(store.query.shifts)).toBe(true);
    expect(store.query.calendarDays instanceof Map).toBe(true);
    expect(store.query.calendarDays.get('2026-10-01')?.name).toBe('国庆');

    store.dialogs.shiftForm.code = 'N2';
    expect(store.dialogs.shiftForm.code).toBe('N2');
  });

  it('I3：$dispose() 后重建 store 拿到全新作用域（不泄漏上一次的选中）', async () => {
    const first = await readyStore();
    first.actions.selectScope({ kind: 'shift', id: '9000000000000902', name: '夜班', color: null });
    first.dialogs.openCreateShift();
    first.dialogs.shiftForm.code = '填了一半';
    expect(first.query.scopeIsShift).toBe(true);

    first.$dispose();

    const second = useScheduleStore();
    expect(second.query.scope).toBe('global');
    expect(second.query.scopeIsShift).toBe(false);
    expect(second.dialogs.shiftForm.code).toBe('');
    expect(second.dialogs.shiftVisible).toBe(false);
  });

  it('I4：42 格月历与统计同源（统计只数当月格，补格不计入）', async () => {
    const store = await readyStore();
    store.actions.gotoMonth(0);
    // 游标落在当月（测试运行时是今天所在月），后端返的 10-01 / 10-03 只在 10 月算数。
    store.actions.gotoMonth(new Date().getMonth() + 1 - new Date().getMonth());
    expect(store.query.cells).toHaveLength(42);
    expect(store.query.range.from.slice(8)).toBe('01');
    expect(store.query.stats.workdays + store.query.stats.restDays).toBe(
      store.query.cells.filter((c) => c.inMonth && store.query.calendarDays.has(c.iso)).length,
    );
  });
});

describe('useScheduleStore — 单日 / 批量写入与失效编排', () => {
  it('W1：全局作用域改单日 → 端点 2，且**连带失效班次日历前缀**', async () => {
    const store = await readyStore();
    store.dialogs.activeIso = '2026-10-02';
    const spy = vi.spyOn(qc, 'invalidateQueries');

    await store.actions.setDay('MAKEUP_HOLIDAY', null);
    await tick();

    expect(saveHrCalendarDaysMock).toHaveBeenCalledWith({
      items: [{ cal_date: '2026-10-02', day_type: 'MAKEUP_HOLIDAY', name: null }],
    });
    // ⚠️ 本域最贵的坑：全局日型一变，每个班次的 effective_day_type 派生值全变。
    expect(spy).toHaveBeenCalledWith({ queryKey: ['hr', 'calendar-days'] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['hr', 'shift-calendar'] });
  });

  it('W2：班次作用域改单日 → 端点 9（带 shiftId，且不带 name 列）', async () => {
    const store = await readyStore();
    store.actions.selectScope({ kind: 'shift', id: '9000000000000902', name: '夜班', color: null });
    store.dialogs.activeIso = '2026-10-07';
    await tick();

    await store.actions.setDay('REST_DAY', null);
    expect(saveHrShiftCalendarDaysMock).toHaveBeenCalledWith('9000000000000902', {
      items: [{ cal_date: '2026-10-07', day_type: 'REST_DAY' }],
    });
    expect(saveHrCalendarDaysMock).not.toHaveBeenCalled();
  });

  it('W3：拖选批量 → **一次请求**覆盖整段（不是逐日循环），成功后清空选区', async () => {
    const store = await readyStore();
    store.selection.setSelectedRange({ from: '2026-10-01', to: '2026-10-05' });
    expect(store.selection.count).toBe(5);

    const ok = await store.actions.applySelection('WORKDAY', null);
    await tick();

    expect(ok).toBe(true);
    expect(saveHrCalendarDaysMock).toHaveBeenCalledTimes(1);
    const items = saveHrCalendarDaysMock.mock.calls[0]![0].items as Array<{ cal_date: string }>;
    expect(items).toHaveLength(5);
    expect(items[0]!.cal_date).toBe('2026-10-01');
    expect(items[4]!.cal_date).toBe('2026-10-05');
    expect(store.selection.range).toBeNull();
  });

  it('W4：批量「清除」走区间口径 `{from,to}`（全局 / 班次各一条端点）', async () => {
    const store = await readyStore();
    store.selection.setSelectedRange({ from: '2026-10-01', to: '2026-10-05' });
    await store.actions.clearSelected();
    expect(deleteHrCalendarDaysMock).toHaveBeenCalledWith({ from: '2026-10-01', to: '2026-10-05' });

    store.actions.selectScope({ kind: 'shift', id: '9000000000000902', name: '夜班', color: null });
    store.selection.setSelectedRange({ from: '2026-10-01', to: '2026-10-05' });
    await store.actions.clearSelected();
    expect(deleteHrShiftCalendarDaysMock).toHaveBeenCalledWith('9000000000000902', {
      from: '2026-10-01',
      to: '2026-10-05',
    });
  });

  it('W5：「清空本月覆盖」用**当月 from/to**（端点 10 的区间口径）', async () => {
    const store = await readyStore();
    store.actions.selectScope({ kind: 'shift', id: '9000000000000901', name: '白班', color: null });
    const ok = await store.actions.clearMonthOverrides();
    expect(ok).toBe(true);
    expect(deleteHrShiftCalendarDaysMock).toHaveBeenCalledWith('9000000000000901', {
      from: store.query.range.from,
      to: store.query.range.to,
    });
  });

  it('W6：单日「恢复默认 / 恢复继承全局」按作用域各走一条 delete 端点', async () => {
    const store = await readyStore();
    store.dialogs.activeIso = '2026-10-03';
    await store.actions.resetDay();
    expect(deleteHrCalendarDaysMock).toHaveBeenCalledWith({ dates: ['2026-10-03'] });

    store.actions.selectScope({ kind: 'shift', id: '9000000000000901', name: '白班', color: null });
    store.dialogs.activeIso = '2026-10-05';
    await store.actions.resetDay();
    expect(deleteHrShiftCalendarDaysMock).toHaveBeenCalledWith('9000000000000901', {
      dates: ['2026-10-05'],
    });
  });

  it('W7：切作用域会清掉上一个作用域的选区（选区不属于跨作用域的东西）', async () => {
    const store = await readyStore();
    store.selection.setSelectedRange({ from: '2026-10-01', to: '2026-10-05' });
    store.actions.selectScope({ kind: 'shift', id: '9000000000000901', name: '白班', color: null });
    expect(store.selection.range).toBeNull();
  });

  it('W8：21907（自定义休息缺名）→ 弹人话，且失败也失效', async () => {
    const store = await readyStore();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    saveHrCalendarDaysMock.mockRejectedValue(
      apiError(HR_SCHEDULE_ERROR_CODES.CALENDAR_LEAVE_NAME_REQUIRED, '缺名'),
    );

    store.dialogs.activeIso = '2026-10-06';
    await store.actions.setDay('CUSTOM_LEAVE', null);
    await tick();

    expect(spy).toHaveBeenCalledWith({ queryKey: ['hr', 'calendar-days'] });
    expect(ElMessage.error).toHaveBeenCalledWith('自定义休息日必须填写名称');
  });
});

describe('useScheduleStore — 班次 CRUD（OCC + 不动 vs 显式清空）', () => {
  it('C1：新建 payload 带 code / name / segments / sort_order', async () => {
    const store = await readyStore();
    store.dialogs.openCreateShift();
    store.dialogs.shiftForm.code = ' MID ';
    store.dialogs.shiftForm.name = '中班';

    const ok = await store.actions.submitShift();
    expect(ok).toBe(true);
    expect(createHrShiftMock).toHaveBeenCalledTimes(1);
    const payload = createHrShiftMock.mock.calls[0]![0];
    expect(payload.code).toBe('MID'); // trim 已归一
    expect(payload.name).toBe('中班');
    expect(payload.segments).toHaveLength(2);
    expect(store.dialogs.shiftVisible).toBe(false);
  });

  it('C2：改档 payload 必带 `version`（取正在编辑那一行）', async () => {
    const store = await readyStore();
    store.dialogs.openEditShift(store.query.shifts[0]!);
    store.dialogs.shiftForm.name = '白班（改）';
    await store.actions.submitShift();

    const [id, body] = updateHrShiftMock.mock.calls[0]!;
    expect(id).toBe('9000000000000901');
    expect(body.version).toBe(4);
    expect(body.name).toBe('白班（改）');
  });

  it('C3：**没动就不发这个键**（缺省 = 不改；发 `null` 等于抹掉库里的值）', async () => {
    const store = await readyStore();
    store.dialogs.openEditShift(store.query.shifts[0]!);
    // 颜色 / 备注一个都没碰
    await store.actions.submitShift();
    const [, body] = updateHrShiftMock.mock.calls[0]!;
    expect('color' in body).toBe(false);
    expect('remark' in body).toBe(false);
  });

  it('C4：显式清空才发 `null`（原值非空 → 表单置空 ⇒ 带 `color: null`）', async () => {
    const store = await readyStore();
    store.dialogs.openEditShift(store.query.shifts[0]!);
    store.dialogs.shiftForm.color = null;
    await store.actions.submitShift();
    const [, body] = updateHrShiftMock.mock.calls[0]!;
    expect('color' in body).toBe(true);
    expect(body.color).toBeNull();
  });

  it('C5：时段 V1–V6 不过时**不发请求**，只标红 `segments`', async () => {
    const store = await readyStore();
    store.dialogs.openCreateShift();
    store.dialogs.shiftForm.code = 'BAD';
    store.dialogs.shiftForm.name = '重叠班';
    store.dialogs.shiftForm.segments = [
      { seq: 1, start: '08:00', end: '12:00' },
      { seq: 2, start: '11:00', end: '13:00' },
    ];

    const ok = await store.actions.submitShift();
    expect(ok).toBe(false);
    expect(createHrShiftMock).not.toHaveBeenCalled();
    expect(store.dialogs.shiftFieldErrors.segments).toContain('重叠');
    expect(ElMessage.warning).toHaveBeenCalledWith('请先修正表单中标红的字段');
  });

  it('C6：跨度超 24:00 判红（V6 / 后端 21908）', async () => {
    const store = await readyStore();
    store.dialogs.openCreateShift();
    store.dialogs.shiftForm.code = 'LONG';
    store.dialogs.shiftForm.name = '超跨度';
    store.dialogs.shiftForm.segments = [{ seq: 1, start: '08:00', end: '32:01' }];
    expect(await store.actions.submitShift()).toBe(false);
    expect(createHrShiftMock).not.toHaveBeenCalled();
    expect(store.dialogs.shiftFieldErrors.segments).toContain('24:00');
  });

  it('C7：停用传**整行**（body 必填 `version`）', async () => {
    const store = await readyStore();
    await store.actions.deactivate(store.query.shifts[0]!);
    expect(deactivateHrShiftMock).toHaveBeenCalledWith('9000000000000901', { version: 4 });
    expect(store.actions.deactivatingRowId).toBeNull();
    expect(ElMessage.success).toHaveBeenCalledWith('班次已停用');
  });

  it('C8：40901（OCC 冲突）走 **warning** 而不是 error', async () => {
    const store = await readyStore();
    updateHrShiftMock.mockRejectedValue(apiError(HR_SCHEDULE_ERROR_CODES.VERSION_CONFLICT, 'OCC'));
    store.dialogs.openEditShift(store.query.shifts[0]!);
    await store.actions.submitShift();
    await tick();

    expect(ElMessage.warning).toHaveBeenCalledWith('配置已被他人修改，请刷新后重试');
    expect(ElMessage.error).not.toHaveBeenCalled();
  });

  it('C9：21902（编码重复）走人话', async () => {
    const store = await readyStore();
    createHrShiftMock.mockRejectedValue(apiError(HR_SCHEDULE_ERROR_CODES.SHIFT_CODE_DUPLICATED));
    store.dialogs.openCreateShift();
    store.dialogs.shiftForm.code = 'DAY';
    store.dialogs.shiftForm.name = '重复编码';
    await store.actions.submitShift();
    await tick();
    expect(ElMessage.error).toHaveBeenCalledWith('班次编码重复，请换一个编码');
  });
});

describe('useScheduleStore — 读端点的坏响应', () => {
  it('R1：坏响应 ⇒ listErrorText 有值 + 数据回落空数组（不白屏）', async () => {
    listHrCalendarDaysMock.mockResolvedValue({ items: [{ cal_date: '2026-10-01' }] });
    const store = await readyStore();
    expect(store.query.listErrorText).toBe('服务端返回的数据格式不符合预期，请联系管理员');
    expect(store.query.calendarDays.size).toBe(0);
  });

  it('R2：班次作用域切的是**另一条读端点**（key 与 queryFn 一起换）', async () => {
    const store = await readyStore();
    store.actions.selectScope({ kind: 'shift', id: '9000000000000902', name: '夜班', color: null });
    await tick();
    expect(getHrShiftCalendarMock).toHaveBeenCalledWith('9000000000000902', {
      from: store.query.range.from,
      to: store.query.range.to,
    });
    expect(listHrCalendarDaysMock).toHaveBeenCalledTimes(1); // 全局那次仍在缓存里
    // 班次日历行的归一化：`effective_day_type` 生效、`is_override` 进模型。
    expect(store.query.calendarDays.get('2026-10-05')?.dayType).toBe('REST_DAY');
    expect(store.query.calendarDays.get('2026-10-05')?.globalDayType).toBe('WORKDAY');
    expect(store.query.calendarDays.get('2026-10-05')?.isOverride).toBe(true);
  });
});
