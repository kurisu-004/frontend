// @vitest-environment happy-dom
// src/views/hr/schedule/components/__tests__/ScheduleSelectionBar.spec.ts
//
// 2026-10-19 新建（排班日历页第一轮 review MINOR-2 / MINOR-7）：拖选浮条的三条交互契约。
//
//  1. **草稿是受控态**：日型 / 名称都从 props 进、变更都 emit 出，组件自己**不持有**。
//     这正是 MINOR-2 的修法 —— 此前 store 里有 `draftDayType` / `draftName` 两个只写不读的
//     死状态，而浮条自己另持一份局部 `ref`；「换选区就复位草稿」这条不变式因此只写在浮条里，
//     选区的 owner（store）那一侧什么都不知道。本文件把「本组件无局部态」钉死。
//  2. **换档清残留名称**：「法定节假日 → 自定义休息」不许沿用上一条的名字。
//  3. **按「应用」必须有反馈**：没选档位 / `CUSTOM_LEAVE` 缺名时各给一句 warning
//     （此前两处都是静默 `return`，用户点完像按钮坏了），且缺名那次输入框转红。

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
const ElInputStub = {
  name: 'ElInput',
  props: ['modelValue', 'disabled', 'error'],
  emits: ['update:modelValue'],
  template:
    '<input class="mock-name" :disabled="disabled" :class="{ \'is-error\': error }" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
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

beforeEach(() => warningMock.mockClear());

function applyButton(wrapper: ReturnType<typeof mountBar>) {
  return wrapper.findAll('button').find((b) => b.text() === '应用')!;
}

function pick(wrapper: ReturnType<typeof mountBar>, dayType: HrDayType | null) {
  wrapper.find('.mock-select').setValue(dayType ?? '');
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

  it('B2：`CUSTOM_LEAVE` 才渲染名称输入，其余档不渲染（少一个控件少一个误填口）', () => {
    expect(mountBar({ draftDayType: 'WORKDAY' }).find('.mock-name').exists()).toBe(false);
    expect(mountBar({ draftDayType: 'CUSTOM_LEAVE' }).find('.mock-name').exists()).toBe(true);
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

  it('B5：`CUSTOM_LEAVE` 缺名 ⇒ warning + 输入框转红 + 不 emit apply；补上名字后红字撤掉', async () => {
    const w = mountBar({ draftDayType: 'CUSTOM_LEAVE' });
    await applyButton(w).trigger('click');
    expect(warningMock).toHaveBeenCalledWith('「自定义休息」必须填写名称');
    expect(w.emitted('apply')).toBeFalsy();
    expect(w.find('.mock-name').classes()).toContain('is-error');

    await w.setProps({ draftName: '厂庆' });
    expect(w.find('.mock-name').classes()).not.toContain('is-error');
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
    // `setDraftDayType` 在上一档不要名称时已把 `draftName` 清空，所以缺名立刻成立 —— 不复位
    // 的话输入框会在用户动手之前先红，与本组件「一上来就红是一片没有来由的红」相抵。
    const w = mountBar();
    await applyButton(w).trigger('click');
    await w.setProps({ draftDayType: 'CUSTOM_LEAVE' });
    expect(w.find('.mock-name').classes()).not.toContain('is-error');
    // 反向：本次草稿真被按过一次应用之后，红态照常亮（不是把红态整个关掉）。
    await applyButton(w).trigger('click');
    expect(w.find('.mock-name').classes()).toContain('is-error');
  });
});
