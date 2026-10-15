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
//     的最后顺带弹出一个单日编辑器（写的是另一条路径）。
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
});
