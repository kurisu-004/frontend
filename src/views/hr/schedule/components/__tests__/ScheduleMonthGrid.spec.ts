// @vitest-environment happy-dom
// src/views/hr/schedule/components/__tests__/ScheduleMonthGrid.spec.ts
//
// 2026-10-19 新建：月历**拖选**的交互契约守卫。本域的拖选是最容易静默失效的一段（监听挂
// 错地方、忘了摘、拖完顺带弹了单日编辑器），四组用例逐条钉住：
//
//  1. `mousedown` → **window** `mousemove` → **window** `mouseup` 产出**升序**区间（正拖与
//     反拖都要对）；
//  2. 只读（`canEdit=false`）与**补格**（前后月）都起不了拖选；
//  3. 拖到一半组件被卸载 ⇒ `onBeforeUnmount` 摘掉 window 上那两个监听（不摘的话切页之后
//     残留监听会对着已销毁的 ref 写值）；
//  4. **真拖过之后的那一次 click 被吞掉** —— 浏览器在 `mouseup` 之后照样派发 `click`，而
//     单元格编辑器的 `el-popover trigger="click"` 就绑在这个 click 上，不吞就会在批量拖选
//     的最后顺带弹出一个单日编辑器（写的是另一条路径）。且这个拦截标记**必须自动复位**：
//     `mouseup` 落在月历根子树之外时 click 根本不经过捕获处理器，标记不复位就会把用户
//     下一次点格静默吞掉。
//  5. **补格不落进选区** —— 拖到补格时识别作「没命中」，保持上一次悬停格（否则会把当月之外
//     的日期批量写进库，而 invalidate 后的重查不含它 ⇒ 用户看不到任何变化）。
//
// EP 用桩而不是真组件：被测的是**拖选状态机**（区间 / 禁用 / 清理 / click 拦截），不复刻
// el-popover 的内部实现（桩法照 `views/mail/digest/__tests__/MailScheduleSection.spec.ts`）。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import ScheduleMonthGrid from '../ScheduleMonthGrid.vue';
import { buildMonthGrid, type MonthCell } from '../../utils/monthGrid';

// ---------------------------------------------------------------- EP 桩
const ElPopoverStub = {
  name: 'ElPopover',
  props: ['visible', 'trigger'],
  template:
    '<div class="mock-popover"><div class="mock-ref"><slot name="reference" /></div><slot /></div>',
};
const ElButtonStub = { name: 'ElButton', template: '<button><slot /></button>' };
const ElRadioGroupStub = { name: 'ElRadioGroup', template: '<div><slot /></div>' };
const ElRadioButtonStub = { name: 'ElRadioButton', template: '<span><slot /></span>' };
const ElInputStub = { name: 'ElInput', template: '<input />' };
const ElDescriptionsStub = { name: 'ElDescriptions', template: '<div><slot /></div>' };
const ElDescriptionsItemStub = {
  name: 'ElDescriptionsItem',
  template: '<div><slot /></div>',
};
const ElFormStub = { name: 'ElForm', template: '<form><slot /></form>' };
const ElFormItemStub = { name: 'ElFormItem', template: '<div><slot /></div>' };

const globalConfig = {
  components: {
    'el-popover': ElPopoverStub,
    'el-button': ElButtonStub,
    'el-radio-group': ElRadioGroupStub,
    'el-radio-button': ElRadioButtonStub,
    'el-input': ElInputStub,
    'el-descriptions': ElDescriptionsStub,
    'el-descriptions-item': ElDescriptionsItemStub,
    'el-form': ElFormStub,
    'el-form-item': ElFormItemStub,
  },
};

const OCT2026 = buildMonthGrid(2026, 10);

function mountGrid(canEdit = true, cells: MonthCell[] = OCT2026) {
  return mount(ScheduleMonthGrid, {
    props: {
      cells,
      calendarDays: new Map(),
      cursor: { year: 2026, month: 10 },
      scopeIsShift: false,
      scopeLabel: '全局日历',
      shiftColor: null,
      canEdit,
      writing: false,
      selectedRange: null,
    },
    global: globalConfig,
  });
}

type Grid = ReturnType<typeof mountGrid>;

function datesOf(wrapper: Grid): string[] {
  return wrapper.findAll('[data-date]').map((el) => el.attributes('data-date') ?? '');
}

function cellEl(wrapper: Grid, iso: string): HTMLElement {
  return wrapper.find(`[data-date="${iso}"]`).element as HTMLElement;
}

/** 走完一次拖拽：起点 `from`、终点 `to`（命中判定靠 `elementFromPoint` 桩）。 */
async function drag(wrapper: Grid, from: string, to: string): Promise<void> {
  await wrapper.find(`[data-date="${from}"]`).trigger('mousedown', { button: 0 });
  vi.spyOn(document, 'elementFromPoint').mockReturnValue(cellEl(wrapper, to));
  window.dispatchEvent(new MouseEvent('mousemove', { clientX: 20, clientY: 20 }));
  window.dispatchEvent(new MouseEvent('mouseup', { clientX: 20, clientY: 20 }));
  await wrapper.vm.$nextTick();
}

/** 最后一次 `update:selectedRange` 的载荷。 */
function lastRange(wrapper: Grid): unknown {
  const emitted = wrapper.emitted('update:selectedRange');
  return emitted?.[emitted.length - 1]?.[0];
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('ScheduleMonthGrid — 拖选区间', () => {
  it('D1：42 格都带 `data-date`（拖选命中判定的锚点）', () => {
    const dates = datesOf(mountGrid());
    expect(dates).toHaveLength(42);
    expect(dates[0]).toBe('2026-09-27');
    expect(dates).toContain('2026-10-01');
  });

  it('D2：正拖产出**升序**区间（2026-10-01 → 2026-10-04）', async () => {
    const w = mountGrid();
    await drag(w, '2026-10-01', '2026-10-04');
    expect(lastRange(w)).toEqual({ from: '2026-10-01', to: '2026-10-04' });
  });

  it('D3：反拖（终点在起点之前）同样产出**升序**区间', async () => {
    const w = mountGrid();
    await drag(w, '2026-10-04', '2026-10-01');
    expect(lastRange(w)).toEqual({ from: '2026-10-01', to: '2026-10-04' });
  });

  it('D4：只点一下（终点 = 起点）⇒ 选区清空，不产出区间', async () => {
    const w = mountGrid();
    await drag(w, '2026-10-04', '2026-10-04');
    expect(lastRange(w)).toBeNull();
  });
});

describe('ScheduleMonthGrid — 拖选的禁用与清理', () => {
  it('D5：`canEdit=false`（只读）时整段拖选禁用', async () => {
    const w = mountGrid(false);
    await drag(w, '2026-10-01', '2026-10-04');
    expect(w.emitted('update:selectedRange')).toBeFalsy();
  });

  it('D6：**补格**（前后月的日子）起不了拖选', async () => {
    const w = mountGrid(true);
    await drag(w, '2026-09-27', '2026-10-01'); // 09-27 是补格
    expect(w.emitted('update:selectedRange')).toBeFalsy();
  });

  it('D7：非左键（右键 / 中键）不起拖选', async () => {
    const w = mountGrid();
    await w.find('[data-date="2026-10-01"]').trigger('mousedown', { button: 2 });
    expect(w.emitted('update:selectedRange')).toBeFalsy();
  });

  it('D8：拖到一半卸载 ⇒ 摘掉 window 上的 mousemove / mouseup', async () => {
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    const w = mountGrid();
    await w.find('[data-date="2026-10-01"]').trigger('mousedown', { button: 0 });
    w.unmount();
    const removed = removeSpy.mock.calls.map((c) => c[0]);
    expect(removed).toContain('mousemove');
    expect(removed).toContain('mouseup');
  });
});

describe('ScheduleMonthGrid — 补格不是合法的拖选终点', () => {
  it('D10：从 10-31 拖到补格 11-01 ⇒ 任何一次 emit 的区间都**不含 2026-11-01**', async () => {
    const w = mountGrid(true);
    // 2026-11-01 是 10 月月历里的**补格**（11 月 1 日，落在最后一行）。
    const nov1 = '2026-11-01';
    expect(w.find(`[data-date="${nov1}"]`).exists()).toBe(true);
    await drag(w, '2026-10-31', nov1);
    // 终点判成「没命中」⇒ 悬停格停在 10-31 ⇒ 与起点同格 ⇒ 走「只是点了一下」那支（选区清空、
    // click 交给单日编辑器）。无论落哪一支，**当月之外的日期一个都不能进选区**。
    const emitted = (w.emitted('update:selectedRange') ?? []).map((c) =>
      c[0] as { from: string; to: string } | null,
    );
    expect(emitted.length).toBeGreaterThan(0);
    for (const range of emitted) {
      expect(range === null || range.to <= '2026-10-31').toBe(true);
      expect(JSON.stringify(range)).not.toContain(nov1);
    }
  });

  it('D10b：10-30 → 10-31 → 越过补格 ⇒ 上界钉在 10-31（批量写不越出当月）', async () => {
    const w = mountGrid(true);
    await w.find('[data-date="2026-10-30"]').trigger('mousedown', { button: 0 });
    const spy = vi.spyOn(document, 'elementFromPoint');
    spy.mockReturnValue(cellEl(w, '2026-10-31'));
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 20, clientY: 20 }));
    spy.mockReturnValue(cellEl(w, '2026-11-01')); // 补格：判成「没命中」
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 20, clientY: 20 }));
    window.dispatchEvent(new MouseEvent('mouseup', { clientX: 20, clientY: 20 }));
    await w.vm.$nextTick();
    expect(lastRange(w)).toEqual({ from: '2026-10-30', to: '2026-10-31' });
  });

  it('D11：反方向（补格 → 当月格）起手也不行，且拖到一半经过补格不会把选区顶出去', async () => {
    const w = mountGrid(true);
    // 起点就是补格 ⇒ 根本不起拖选（D6 的另一侧）。
    await drag(w, '2026-11-01', '2026-10-31');
    expect(w.emitted('update:selectedRange')).toBeFalsy();

    // 先拖到当月的 10-28（合法），再移过补格再移回 10-29 ⇒ 上界取最后一次**命中当月格**的值。
    const w2 = mountGrid(true);
    await w2.find('[data-date="2026-10-28"]').trigger('mousedown', { button: 0 });
    const spy = vi.spyOn(document, 'elementFromPoint');
    spy.mockReturnValue(cellEl(w2, '2026-10-29'));
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 20, clientY: 20 }));
    spy.mockReturnValue(cellEl(w2, '2026-11-01')); // 补格：判成「没命中」，保持 10-29
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 20, clientY: 20 }));
    window.dispatchEvent(new MouseEvent('mouseup', { clientX: 20, clientY: 20 }));
    await w2.vm.$nextTick();
    expect(lastRange(w2)).toEqual({ from: '2026-10-28', to: '2026-10-29' });
  });
});

describe('ScheduleMonthGrid — 拖完不弹单日编辑器', () => {
  it('D9：真拖过之后的那一次 click 被**捕获阶段**吞掉；没拖的 click 照常走', async () => {
    const w = mountGrid();
    let cellClicks = 0;
    // 模拟 popover 的 `trigger="click"`：它绑在格子（reference）上、跑在冒泡阶段。
    cellEl(w, '2026-10-04').addEventListener('click', () => {
      cellClicks += 1;
    });

    cellEl(w, '2026-10-04').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(cellClicks).toBe(1); // 单击：照常交给单元格编辑器

    await drag(w, '2026-10-01', '2026-10-04');
    cellEl(w, '2026-10-04').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(cellClicks).toBe(1); // 拖完那一次被吞掉（没涨到 2）
  });

  // ⚠️ **泄漏回归**：`@click.capture` 只挂在月历根上。`mousedown` 起在格子里、`mouseup` 落在根
  //   子树之外（真实场景：一路拖到右侧班次栏才松手）时，浏览器把 click 派发到公共祖先 ——
  //   捕获处理器**根本不跑**，`suppressNextClick` 会一直挂着，于是用户下一次点月历格被静默
  //   吞掉（点不动、也不报错）。这里模拟那一支：拖完的 click 不经过根，再点一次必须有效。
  it('D12：拖完的 click 没经过月历根 ⇒ 拦截标记必须自动复位（不能吞掉下一次点击）', async () => {
    vi.useFakeTimers();
    try {
      const w = mountGrid();
      let cellClicks = 0;
      cellEl(w, '2026-10-04').addEventListener('click', () => {
        cellClicks += 1;
      });

      await drag(w, '2026-10-01', '2026-10-04');
      // 模拟「mouseup 落在月历之外」：mouseup 之后**没有任何** click 抵达月历根。
      vi.advanceTimersByTime(1);

      cellEl(w, '2026-10-04').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(cellClicks).toBe(1); // 标记已复位 ⇒ 这一次 click 照常交给单元格编辑器
    } finally {
      vi.useRealTimers();
    }
  });

  it('D13：拖到一半卸载 ⇒ 兜底复位定时器也摘干净', async () => {
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    const w = mountGrid();
    await drag(w, '2026-10-01', '2026-10-04');
    w.unmount();
    // 摘不摘掉的实际后果是「组件没了还挂着一个会写局部变量的宏任务」，不摘是资源泄漏。
    expect(clearSpy).toHaveBeenCalled();
  });
});
