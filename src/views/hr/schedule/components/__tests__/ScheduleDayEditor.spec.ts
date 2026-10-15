// @vitest-environment happy-dom
// src/views/hr/schedule/components/__tests__/ScheduleDayEditor.spec.ts
//
// 2026-10-19 新建：点单日弹层对「`CUSTOM_LEAVE` 缺名」的前端拦截契约。
//
//  1. **缺名不发**：`CUSTOM_LEAVE` 在全局日历上必须带名称（后端 21907），缺名时给 warning +
//     红框，且**不 emit apply**（本组件是纯组件，emit 出去才有请求，所以「不发请求」= 不 emit）。
//  2. **判空口径与后端同源**：后端拒的是 `trim()` 后为空，所以**全空格同样算缺名**。
//  3. **只在全局日历上要名称**：班次覆盖行没有名称列、那个写端点也不校验它 ⇒ 班次作用域按缺名
//     去拦是拦一条后端本就允许的写（口径见 `docs/api/hr.md` §3.8）。
//  4. **拦下时不关弹层**：关掉就把「补个名字再试」变成「重新点开那一格」。
//  5. **法定节假日要能起名**：「国庆节」「春节」就是 `name` 列的原始用途；不填名也允许提交
//     （后端缺名闸门只判 `CUSTOM_LEAVE`，见 `docs/api/hr.md` §3.3）。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent } from 'vue';
import { mount } from '@vue/test-utils';
import ScheduleDayEditor from '../ScheduleDayEditor.vue';
import type { ScheduleDayView } from '../../composables/useScheduleStore';

// ---------------------------------------------------------------- EP 桩
/** 弹层桩：默认插槽常驻（省得逐个用例去开），并按真实行为在挂载时抛一次 `show`
 *  —— 组件的草稿就是靠 `@show="syncDraft"` 灌进来的，不抛就等于没打开。 */
const ElPopoverStub = defineComponent({
  name: 'ElPopover',
  props: { visible: { type: Boolean, default: false } },
  emits: ['update:visible', 'show'],
  mounted() {
    this.$emit('show');
  },
  template: '<div class="mock-popover"><slot /></div>',
});
/** ⚠️ `error` 照真实组件的形态实现（真源：`el-form-item` 收到 `error` ⇒ 自身带 `is-error`，
 *   红框由后代选择器 `.el-form-item.is-error .el-input__wrapper` 画）。`el-input` 自己没有
 *   `error` prop，所以红框**不能**挂在输入框上。 */
const ElFormItemStub = {
  name: 'ElFormItem',
  props: ['error'],
  template: '<div class="mock-form-item" :class="{ \'is-error\': !!error }"><slot /></div>',
};
const ElInputStub = {
  name: 'ElInput',
  props: ['modelValue', 'disabled'],
  emits: ['update:modelValue'],
  template:
    '<input class="mock-name" :disabled="disabled" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
};
const ElButtonStub = {
  name: 'ElButton',
  props: ['loading', 'disabled'],
  template: '<button :disabled="disabled"><slot /></button>',
};
const PassthroughStub = (name: string) => ({
  name,
  props: ['modelValue'],
  emits: ['update:modelValue'],
  template: '<div><slot /></div>',
});

const globalConfig = {
  components: {
    'el-popover': ElPopoverStub,
    'el-form': PassthroughStub('ElForm'),
    'el-form-item': ElFormItemStub,
    'el-input': ElInputStub,
    'el-button': ElButtonStub,
    'el-radio-group': PassthroughStub('ElRadioGroup'),
    'el-radio-button': PassthroughStub('ElRadioButton'),
    'el-descriptions': PassthroughStub('ElDescriptions'),
    'el-descriptions-item': PassthroughStub('ElDescriptionsItem'),
  },
};

import type * as ElementPlusModule from 'element-plus';

// ⚠️ `vi.mock` 的 factory 被 hoist 到文件顶部 ⇒ 桩变量必须走 `vi.hoisted`，否则这里就是
//   `Cannot access 'warningMock' before initialization`。
const { warningMock } = vi.hoisted(() => ({ warningMock: vi.fn() }));
vi.mock('element-plus', async (importOriginal) => {
  const actual = await importOriginal<typeof ElementPlusModule>();
  return { ...actual, ElMessage: { ...actual.ElMessage, warning: warningMock } };
});

const DAY: ScheduleDayView = {
  iso: '2026-10-01',
  dayType: 'CUSTOM_LEAVE',
  globalDayType: 'CUSTOM_LEAVE',
  name: null,
  derived: false,
  isOverride: false,
  workday: false,
};

function dayView(over: Partial<ScheduleDayView> = {}): ScheduleDayView {
  return { ...DAY, ...over };
}

function mountEditor(over: Record<string, unknown> = {}) {
  return mount(ScheduleDayEditor, {
    props: {
      day: dayView(),
      iso: '2026-10-01',
      scopeIsShift: false,
      scopeLabel: '两班倒',
      canEdit: true,
      writing: false,
      ...over,
    },
    global: globalConfig,
  });
}

type Wrapper = ReturnType<typeof mountEditor>;

function applyButton(w: Wrapper) {
  return w.findAll('button').find((b) => b.text() === '应用')!;
}

function popoverVisible(w: Wrapper): boolean {
  return w.findComponent(ElPopoverStub).props('visible') === true;
}

/** 名称那一栏的 `el-form-item`（红框挂它身上，不挂输入框）。 */
function nameFieldRed(w: Wrapper): boolean {
  const item = w.find('.mock-name').element.closest('.mock-form-item');
  return item !== null && item.classList.contains('is-error');
}

/** 走一遍「用户点开这一格」。 */
async function open(w: Wrapper) {
  await w.findComponent(ElPopoverStub).vm.$emit('update:visible', true);
  await w.vm.$nextTick();
}

beforeEach(() => warningMock.mockClear());

describe('ScheduleDayEditor — `CUSTOM_LEAVE` 缺名拦在前端', () => {
  it('E1：全局日历 + `CUSTOM_LEAVE` + 空名 ⇒ warning + 红框 + 不 emit apply + 弹层不关', async () => {
    const w = mountEditor();
    await open(w);
    expect(nameFieldRed(w), '还没按应用就先红是一片没有来由的红').toBe(false);

    await applyButton(w).trigger('click');
    expect(warningMock).toHaveBeenCalledWith('「自定义休息」必须填写名称');
    expect(
      w.emitted('apply'),
      '拦住时不能 emit（emit 出去就是一次注定吃 21907 的请求）',
    ).toBeFalsy();
    expect(nameFieldRed(w)).toBe(true);
    expect(popoverVisible(w), '拦下时关掉弹层 = 把「补个名字再试」变成「重新点开那一格」').toBe(
      true,
    );
  });

  it('E2：名称只有空格也算缺名（后端拒的是 `trim()` 后为空，不是「有没有这个字段」）', async () => {
    const w = mountEditor({ day: dayView({ name: '   ' }) });
    await open(w);
    await applyButton(w).trigger('click');
    expect(warningMock).toHaveBeenCalledWith('「自定义休息」必须填写名称');
    expect(w.emitted('apply')).toBeFalsy();
    expect(nameFieldRed(w)).toBe(true);
  });

  it('E3：`CUSTOM_LEAVE` 填了名 ⇒ emit trim 后的名字 + 无 warning + 弹层收起', async () => {
    const w = mountEditor({ day: dayView({ name: ' 设备检修 ' }) });
    await open(w);
    await applyButton(w).trigger('click');
    expect(w.emitted('apply')).toEqual([['CUSTOM_LEAVE', '设备检修']]);
    expect(warningMock).not.toHaveBeenCalled();
    expect(nameFieldRed(w)).toBe(false);
    expect(popoverVisible(w)).toBe(false);
  });

  it('E4：其余档名一律给 `null`（不该把残留的名字发出去）', async () => {
    const w = mountEditor({ day: dayView({ dayType: 'WORKDAY', name: '残留' }) });
    await open(w);
    await applyButton(w).trigger('click');
    expect(w.emitted('apply')).toEqual([['WORKDAY', null]]);
    expect(warningMock).not.toHaveBeenCalled();
  });

  it('E5：班次作用域 + `CUSTOM_LEAVE` + 空名 ⇒ **不拦**（覆盖行没有名称列，后端也不校验）', async () => {
    // 钉住作用域判据：这一条若被改成「不分作用域一律拦」，就等于拦掉一条后端本就允许的写，
    // 还会逼用户填一个端点根本不收的名字（store 的班次分支只发 `{cal_date, day_type}`）。
    // 名称这一位给的是空串而不是 `null`（本组件按档位判、不按作用域判），落网时被 store 丢掉。
    const w = mountEditor({ scopeIsShift: true, day: dayView({ name: null }) });
    await open(w);
    await applyButton(w).trigger('click');
    expect(w.emitted('apply')).toEqual([['CUSTOM_LEAVE', '']]);
    expect(warningMock).not.toHaveBeenCalled();
    expect(nameFieldRed(w)).toBe(false);
  });

  it('E6：补上名称后红框撤掉，同一次打开里再按应用就能提交', async () => {
    const w = mountEditor();
    await open(w);
    await applyButton(w).trigger('click');
    expect(nameFieldRed(w)).toBe(true);

    await w.find('.mock-name').setValue('厂庆');
    expect(nameFieldRed(w), '判据是「按过应用且仍为空」，不再空就不该继续红').toBe(false);

    await applyButton(w).trigger('click');
    expect(w.emitted('apply')).toEqual([['CUSTOM_LEAVE', '厂庆']]);
  });

  it('E7：重新打开弹层时红态复位（下一格不该继承上一格的标红）', async () => {
    const w = mountEditor();
    await open(w);
    await applyButton(w).trigger('click');
    expect(nameFieldRed(w)).toBe(true);

    // 关掉再点开 ⇒ 弹层重新抛 `show` ⇒ 草稿与红态一起复位。
    const pop = w.findComponent(ElPopoverStub);
    await pop.vm.$emit('update:visible', false);
    await pop.vm.$emit('update:visible', true);
    await pop.vm.$emit('show');
    expect(nameFieldRed(w)).toBe(false);
  });
});

describe('ScheduleDayEditor — 法定节假日可起名（`name` 列的原始用途）', () => {
  it('E8：全局日历 + `STATUTORY_HOLIDAY` + 填「国庆节」⇒ emit 带 name（这一档要能起名）', async () => {
    const w = mountEditor({ day: dayView({ dayType: 'STATUTORY_HOLIDAY' }) });
    await open(w);
    // 名称框在法定节假日这一档是可编辑的（不是 disabled）。
    expect(w.find('.mock-name').attributes('disabled')).toBeUndefined();
    await w.find('.mock-name').setValue('国庆节');
    await applyButton(w).trigger('click');
    expect(w.emitted('apply')).toEqual([['STATUTORY_HOLIDAY', '国庆节']]);
    expect(warningMock).not.toHaveBeenCalled();
    expect(nameFieldRed(w)).toBe(false);
  });

  it('E9：全局日历 + `STATUTORY_HOLIDAY` + 不填名 ⇒ **允许提交**（名可选，后端不落 21907）', async () => {
    const w = mountEditor({ day: dayView({ dayType: 'STATUTORY_HOLIDAY', name: null }) });
    await open(w);
    await applyButton(w).trigger('click');
    expect(w.emitted('apply'), '后端 name 是 Option，只有 CUSTOM_LEAVE 缺名才被拒').toEqual([
      ['STATUTORY_HOLIDAY', ''],
    ]);
    expect(warningMock).not.toHaveBeenCalled();
    expect(nameFieldRed(w), '法定节假日名可选，缺名不该标红').toBe(false);
  });

  it('E10：法定节假日与自定义休息的必填判据不串档（切档后红态按各自的判据走）', async () => {
    const w = mountEditor({ day: dayView({ dayType: 'CUSTOM_LEAVE' }) });
    await open(w);
    await applyButton(w).trigger('click');
    expect(nameFieldRed(w), '`CUSTOM_LEAVE` 缺名要红').toBe(true);

    // 切到选填档（日型单选组是真受控态，这里从组上发 `update:modelValue` 驱动草稿换档）：
    // 上一档的红不能跟过去，缺名也不该再拦。
    w.findComponent({ name: 'ElRadioGroup' }).vm.$emit('update:modelValue', 'STATUTORY_HOLIDAY');
    await w.vm.$nextTick();
    expect(nameFieldRed(w), '法定节假日名可选，上一档的红不能跟过来').toBe(false);
    await applyButton(w).trigger('click');
    expect(w.emitted('apply')).toEqual([['STATUTORY_HOLIDAY', '']]);
  });
});
