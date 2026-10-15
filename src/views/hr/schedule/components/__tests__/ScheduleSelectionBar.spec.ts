// @vitest-environment happy-dom
// src/views/hr/schedule/components/__tests__/ScheduleSelectionBar.spec.ts
//
// 2026-10-19 新建（排班日历页第一轮 review MINOR-2 / MINOR-7）：拖选浮条的三条交互契约；
//          2026-10-19 补：名称框判据分作用域 + 红框挂真机制 + 法定节假日可起名。
//
//  1. **草稿是受控态**：日型 / 名称都从 props 进、变更都 emit 出，组件自己**不持有**。
//     这正是 MINOR-2 的修法 —— 此前 store 里有 `draftDayType` / `draftName` 两个只写不读的
//     死状态，而浮条自己另持一份局部 `ref`；「换选区就复位草稿」这条不变式因此只写在浮条里，
//     选区的 owner（store）那一侧什么都不知道。本文件把「本组件无局部态」钉死。
//  2. **换档清残留名称**：「法定节假日 → 自定义休息」不许沿用上一条的名字。
//  3. **按「应用」必须有反馈**：没选档位 / 全局日历上的 `CUSTOM_LEAVE` 缺名时各给一句 warning
//     （此前两处都是静默 `return`，用户点完像按钮坏了），且缺名那次红框真能红。
//  4. **名称框的判据分作用域**（与点单日弹层同一套）：班次覆盖行没有 `name` 列、端点 9 也
//     不校验它 ⇒ 班次作用域既不渲染名称框也不拦缺名（口径见 `docs/api/hr.md` §3.8）。
//  5. **法定节假日能起名**：「国庆节」「春节」就是这一列的原始用途，不填名也允许提交
//     （后端缺名闸门只判 `CUSTOM_LEAVE`，见 `docs/api/hr.md` §3.3）。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import ScheduleSelectionBar from '../ScheduleSelectionBar.vue';
import type { HrDayType } from '@/types/hr';

// ---------------------------------------------------------------- EP 桩
const ElSelectStub = {
  name: 'ElSelect',
  props: ['modelValue', 'disabled'],
  emits: ['update:modelValue'],
  template:
    '<select class="mock-select" :disabled="disabled" @change="$emit(\'update:modelValue\', $event.target.value || null)"><slot /></select>',
};
const ElOptionStub = {
  name: 'ElOption',
  props: ['label', 'value'],
  template: '<option :value="value">{{ label }}</option>',
};
/**
 * ⚠️ **刻意不声明 `error` prop、也不自己画红**：真实的 `el-input`（2.14.6）压根没有 `error`
 *   这个 prop，给它传 `:error` 只会当成同名 HTML 属性落到根 div 上、什么样式都不触发（假红）。
 *   桩一旦声明 `error` 并渲染成 `is-error`，任何退回假红的改法都会照样绿 —— 那样的绿是验桩
 *   的意图，不是验产品的行为。
 */
const ElInputStub = {
  name: 'ElInput',
  props: ['modelValue', 'disabled'],
  emits: ['update:modelValue'],
  template:
    '<input class="mock-name" :disabled="disabled" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
};
/**
 * 红框的真机制：`el-form-item` 收到非空 `error` ⇒ 内部 `watch` 后给**自身**加 `is-error`，
 * 红框由后代选择器 `.el-form-item.is-error .el-form-item__content .el-input__wrapper` 画。
 * 桩照这个形态实现，所以「红」与「传了什么 prop」两件事都被验到。
 */
const ElFormItemStub = {
  name: 'ElFormItem',
  props: ['error'],
  template: '<div class="mock-form-item" :class="{ \'is-error\': !!error }"><slot /></div>',
};
const ElButtonStub = {
  name: 'ElButton',
  props: ['loading', 'disabled'],
  template: '<button :disabled="disabled"><slot /></button>',
};

import type * as ElementPlusModule from 'element-plus';

const globalConfig = {
  components: {
    'el-select': ElSelectStub,
    'el-option': ElOptionStub,
    'el-input': ElInputStub,
    'el-form-item': ElFormItemStub,
    'el-button': ElButtonStub,
  },
};

// ⚠️ `vi.mock` 的 factory 被 hoist 到文件顶部 ⇒ 桩变量必须走 `vi.hoisted`，否则这里就是
//   `Cannot access 'warningMock' before initialization`。
const { warningMock } = vi.hoisted(() => ({ warningMock: vi.fn() }));
vi.mock('element-plus', async (importOriginal) => {
  const actual = await importOriginal<typeof ElementPlusModule>();
  return { ...actual, ElMessage: { ...actual.ElMessage, warning: warningMock } };
});

function mountBar(over: Partial<Record<string, unknown>> = {}) {
  return mount(ScheduleSelectionBar, {
    props: {
      range: { from: '2026-10-01', to: '2026-10-05' },
      count: 5,
      scopeIsShift: false,
      draftDayType: null,
      draftName: '',
      busy: false,
      ...over,
    },
    global: globalConfig,
  });
}

type Wrapper = ReturnType<typeof mountBar>;

beforeEach(() => warningMock.mockClear());

function applyButton(wrapper: Wrapper) {
  return wrapper.findAll('button').find((b) => b.text() === '应用')!;
}

function pick(wrapper: Wrapper, dayType: HrDayType | null) {
  wrapper.find('.mock-select').setValue(dayType ?? '');
}

/** 传给 `el-form-item` 的 `error` prop 真值（**验 prop**，不是验桩画出来的类）。 */
function nameFieldError(w: Wrapper): string {
  return w.findComponent({ name: 'ElFormItem' }).props('error') as string;
}

/** 名称栏是否标红：红在 `el-form-item` 祖先上（真机制），不在输入框自己身上。 */
function nameFieldRed(w: Wrapper): boolean {
  const input = w.find('.mock-name');
  if (!input.exists()) return false;
  const item = input.element.closest('.mock-form-item');
  return item !== null && item.classList.contains('is-error');
}

describe('ScheduleSelectionBar — 草稿是受控态（owner 在 store）', () => {
  it('B1：选档 / 改名称都只 emit，组件自己不留副本（回灌靠 store 回写 props）', async () => {
    const w = mountBar();
    pick(w, 'CUSTOM_LEAVE');
    expect(w.emitted('draftDayType')).toEqual([['CUSTOM_LEAVE']]);

    // 模拟 store 回灌：草稿真值在 store 那边，本组件只能从 props 读到它。
    await w.setProps({ draftDayType: 'CUSTOM_LEAVE' });
    await w.find('.mock-name').setValue('厂庆');
    expect(w.emitted('draftName')).toEqual([['厂庆']]);
  });

  it('B2：名称框只出现在**全局日历 + 能填名称的两档**（少一个控件少一个误填口）', () => {
    expect(mountBar({ draftDayType: 'WORKDAY' }).find('.mock-name').exists()).toBe(false);
    expect(mountBar({ draftDayType: 'MAKEUP_HOLIDAY' }).find('.mock-name').exists()).toBe(false);
    expect(mountBar({ draftDayType: 'CUSTOM_LEAVE' }).find('.mock-name').exists()).toBe(true);
    // 法定节假日要能起「国庆节」的名（后端 `name` 列的原始用途之一）。
    expect(mountBar({ draftDayType: 'STATUTORY_HOLIDAY' }).find('.mock-name').exists()).toBe(true);
    // 班次作用域：覆盖行**没有 name 列**、端点 9 也不收它 ⇒ 不渲染（填了也发不出去）。
    expect(
      mountBar({ draftDayType: 'CUSTOM_LEAVE', scopeIsShift: true }).find('.mock-name').exists(),
    ).toBe(false);
  });

  it('B3：名称框回显的是 props 里的草稿值（不是组件内部的旧值）', async () => {
    const w = mountBar({ draftDayType: 'CUSTOM_LEAVE', draftName: '国庆' });
    expect((w.find('.mock-name').element as HTMLInputElement).value).toBe('国庆');
  });
});

describe('ScheduleSelectionBar — 应用的两个失败分支都有反馈', () => {
  it('B4：没选档位 ⇒ warning + 不 emit apply', async () => {
    const w = mountBar();
    await applyButton(w).trigger('click');
    expect(warningMock).toHaveBeenCalledWith('请先选择要批量设置的日型');
    expect(w.emitted('apply')).toBeFalsy();
  });

  it('B5：`CUSTOM_LEAVE` 缺名 ⇒ warning + 真红 + 不 emit apply；补上名字后红框撤掉', async () => {
    const w = mountBar({ draftDayType: 'CUSTOM_LEAVE' });
    expect(nameFieldError(w), '还没按应用就先红是一片没有来由的红').toBe('');
    await applyButton(w).trigger('click');
    expect(warningMock).toHaveBeenCalledWith('「自定义休息」必须填写名称');
    expect(w.emitted('apply')).toBeFalsy();
    // 红框只能由 `el-form-item` 的 `error` 触发（`el-input` 没有这个 prop，桩也没声明）。
    expect(nameFieldError(w)).toBe('请填写名称');
    expect(nameFieldRed(w)).toBe(true);

    await w.setProps({ draftName: '厂庆' });
    expect(nameFieldError(w)).toBe('');
    expect(nameFieldRed(w)).toBe(false);
  });

  it('B6：名称只有空格也算缺名（后端 21907 拒的是「空」不是「有内容」）', async () => {
    const w = mountBar({ draftDayType: 'CUSTOM_LEAVE', draftName: '   ' });
    await applyButton(w).trigger('click');
    expect(w.emitted('apply')).toBeFalsy();
  });

  it('B7：正常档位 ⇒ 直接 emit apply 且名称给 `null`（其余档不该带 name）', async () => {
    const w = mountBar({ draftDayType: 'WORKDAY', draftName: '残留' });
    await applyButton(w).trigger('click');
    expect(w.emitted('apply')).toEqual([['WORKDAY', null]]);
    expect(warningMock).not.toHaveBeenCalled();
  });

  it('B8：`CUSTOM_LEAVE` 填了名 ⇒ emit 时给 trim 后的名字', async () => {
    const w = mountBar({ draftDayType: 'CUSTOM_LEAVE', draftName: ' 厂庆 ' });
    await applyButton(w).trigger('click');
    expect(w.emitted('apply')).toEqual([['CUSTOM_LEAVE', '厂庆']]);
  });

  it('B9：换档位不继承上一组的红态（选上 `CUSTOM_LEAVE` 后**未经应用**不红，按过应用才红）', async () => {
    // 复现路径：还没选档时按过一次应用（`appliedOnce` 置位）→ 换成 `CUSTOM_LEAVE`。store 的
    // `setDraftDayType` 在上一档不能填名称时已把 `draftName` 清空，所以缺名立刻成立 —— 不复位
    // 的话输入框会在用户动手之前先红，与本组件「一上来就红是一片没有来由的红」相抵。
    const w = mountBar();
    await applyButton(w).trigger('click');
    await w.setProps({ draftDayType: 'CUSTOM_LEAVE' });
    expect(nameFieldRed(w)).toBe(false);
    // 反向：本次草稿真被按过一次应用之后，红态照常亮（不是把红态整个关掉）。
    await applyButton(w).trigger('click');
    expect(nameFieldRed(w)).toBe(true);
  });
});

describe('ScheduleSelectionBar — 名称判据分作用域 / 法定节假日可起名', () => {
  it('B10：班次作用域 + `CUSTOM_LEAVE` + 不填名 ⇒ **不拦、正常提交**（端点 9 不校验 name）', async () => {
    // 钉住作用域判据：这一条若被改成「不分作用域一律拦」，拦掉的就是一条后端本就允许的写，
    // 还会逼用户填一个发不出去的名字（store 的班次分支只发 `{cal_date, day_type}`）。
    const w = mountBar({ scopeIsShift: true, draftDayType: 'CUSTOM_LEAVE' });
    await applyButton(w).trigger('click');
    expect(warningMock).not.toHaveBeenCalled();
    expect(w.emitted('apply')).toEqual([['CUSTOM_LEAVE', null]]);
    expect(w.find('.mock-name').exists(), '班次作用域不渲染名称框').toBe(false);
  });

  it('B11：`STATUTORY_HOLIDAY` + 填「国庆节」⇒ emit 带 name（这列的原始用途）', async () => {
    const w = mountBar({ draftDayType: 'STATUTORY_HOLIDAY', draftName: '国庆节' });
    await applyButton(w).trigger('click');
    expect(w.emitted('apply')).toEqual([['STATUTORY_HOLIDAY', '国庆节']]);
    expect(warningMock).not.toHaveBeenCalled();
  });

  it('B12：`STATUTORY_HOLIDAY` + 不填名 ⇒ 允许提交且**不标红**（后端缺名闸门只判 `CUSTOM_LEAVE`）', async () => {
    const w = mountBar({ draftDayType: 'STATUTORY_HOLIDAY' });
    await applyButton(w).trigger('click');
    expect(w.emitted('apply')).toEqual([['STATUTORY_HOLIDAY', '']]);
    expect(warningMock).not.toHaveBeenCalled();
    expect(nameFieldRed(w), '法定节假日名可选，缺名不该红').toBe(false);
    expect(nameFieldError(w)).toBe('');
  });

  it('B13：法定节假日与自定义休息的判据不串档（换一个必填档 / 换一个选填档都不残留红）', async () => {
    const w = mountBar({ draftDayType: 'CUSTOM_LEAVE' });
    await applyButton(w).trigger('click');
    expect(nameFieldRed(w)).toBe(true);

    // 换到选填档：上一档的红不能跟过去，缺名也不再拦。
    await w.setProps({ draftDayType: 'STATUTORY_HOLIDAY' });
    expect(nameFieldRed(w)).toBe(false);
    expect(nameFieldError(w)).toBe('');
    warningMock.mockClear();
    await applyButton(w).trigger('click');
    expect(w.emitted('apply')).toEqual([['STATUTORY_HOLIDAY', '']]);
    expect(warningMock, '法定节假日缺名不拦').not.toHaveBeenCalled();

    // 换回必填档：换档本身不红（用户还没按这一次应用），按过之后才红 —— 判据跟着档位走。
    await w.setProps({ draftDayType: 'CUSTOM_LEAVE' });
    expect(nameFieldRed(w)).toBe(false);
    await applyButton(w).trigger('click');
    expect(nameFieldRed(w)).toBe(true);
    expect(nameFieldError(w)).toBe('请填写名称');
  });
});
