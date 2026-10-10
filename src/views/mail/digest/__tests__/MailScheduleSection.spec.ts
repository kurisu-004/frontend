// @vitest-environment happy-dom
// src/views/mail/digest/__tests__/MailScheduleSection.spec.ts
//
// 2026-10-13 新增：调度设置 section 的**渲染契约**守卫。四组：
//
//  1. `MANUAL_ONLY` 时**隐藏全部时间输入**（时/分、星期、月号都不渲染），并给出
//     「仅手动发送，不注册定时任务」的提示 —— 这条是需求里点名的行为；
//  2. 其余三种频率各自只渲染自己那一组配套输入（DAILY 只有时刻 / WEEKLY 多星期 /
//     MONTHLY 多月号），判据读 `frequencyOptions` 的三个 `needs_*`（meta 驱动，不是硬编码）；
//  3. 切频率时把「当前频率用不到」的配套字段置 null（留着会构成后端 21704）；
//  4. 字段红字与 focusField 高亮落到对应行上（字段聚焦的视觉层）。
//
// 用 EP 模板桩而不是真 EP 组件：被测的是「本组件有没有按 needs_* 正确分支」，不复刻
// el-select / el-radio-group 的内部实现（桩法照 `views/users/components/__tests__/WxBindDialog.spec.ts`
// 与 `views/production/__tests__/ProcessWorkTypeMappingTab.spec.ts`）。
//
// ⚠️ 本组件是**纯组件**（props 进 / emits 出，不首调 store）—— 这是 2026-10-13 刻意的
// 结构选择，见 `composables/useMailDigestStore.ts` 文件头。所以本 spec 不需要 pinia /
// vue-query，桩子只有 EP 那几件。

import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import MailScheduleSection from '../components/MailScheduleSection.vue';
import {
  DEFAULT_MAIL_DIGEST_FREQUENCY_OPTIONS,
  type MailDigestFormField,
  type MailDigestFormModel,
  type MailDigestFrequencyOptionData,
} from '../mailDigestSchema';
import type { MailDigestFrequency } from '@/types/mailDigest';

// ---------------------------------------------------------------- EP 桩
const ElSwitchStub = {
  name: 'ElSwitch',
  props: ['modelValue'],
  emits: ['update:modelValue'],
  template: '<button class="mock-switch" @click="$emit(\'update:modelValue\', !modelValue)" />',
};

const ElRadioGroupStub = {
  name: 'ElRadioGroup',
  props: ['modelValue'],
  emits: ['update:modelValue'],
  template: '<div class="mock-radio-group"><slot /></div>',
};

const ElRadioButtonStub = {
  name: 'ElRadioButton',
  props: ['value'],
  template: '<label class="mock-radio-button"><slot /></label>',
};

const ElSelectStub = {
  name: 'ElSelect',
  props: ['modelValue', 'placeholder'],
  emits: ['update:modelValue'],
  template:
    '<div class="mock-select" :data-placeholder="placeholder || \'\'" @click="$emit(\'update:modelValue\', 1)" />',
};

const ElOptionStub = {
  name: 'ElOption',
  props: ['label', 'value'],
  template: '<div class="mock-option" />',
};

const ElInputNumberStub = {
  name: 'ElInputNumber',
  props: ['modelValue', 'disabled'],
  emits: ['update:modelValue'],
  template: '<div class="mock-input-number" :data-disabled="String(!!disabled)" />',
};

const ElAlertStub = {
  name: 'ElAlert',
  props: ['title', 'description'],
  template: '<div class="mock-alert"><span class="alert-title">{{ title }}</span></div>',
};

const globalConfig = {
  components: {
    'el-switch': ElSwitchStub,
    'el-radio-group': ElRadioGroupStub,
    'el-radio-button': ElRadioButtonStub,
    'el-select': ElSelectStub,
    'el-option': ElOptionStub,
    'el-input-number': ElInputNumberStub,
    'el-alert': ElAlertStub,
  },
};

function baseForm(over: Partial<MailDigestFormModel> = {}): MailDigestFormModel {
  return {
    enabled: true,
    frequency: 'DAILY',
    send_hour: 8,
    send_minute: 30,
    weekday: null,
    day_of_month: null,
    recipients: ['a@example.com'],
    cc_recipients: [],
    include_overdue: true,
    include_upcoming: false,
    upcoming_days: 7,
    visible_columns: ['part_no'],
    subject_template: '',
    ...over,
  };
}

/** 按频率组装 options（传自定义 needs_* 用）。 */
function optionsFor(
  over: Partial<Record<MailDigestFrequency, Partial<MailDigestFrequencyOptionData>>> = {},
) {
  return DEFAULT_MAIL_DIGEST_FREQUENCY_OPTIONS.map((opt) => ({
    ...opt,
    ...(over[opt.value] ?? {}),
  }));
}

/** 挂载组件，并捕获它 emit 出来的最新表单模型。 */
function mountSection(
  form: MailDigestFormModel,
  opts: {
    frequencyOptions?: MailDigestFrequencyOptionData[];
    errors?: Record<string, string>;
    focusField?: MailDigestFormField | null;
  } = {},
) {
  let latest = form;
  const wrapper = mount(MailScheduleSection, {
    props: {
      modelValue: form,
      frequencyOptions: opts.frequencyOptions ?? optionsFor(),
      // `onUpdate:modelValue` prop 形式接 emit（`<script setup>` 组件的 `wrapper.vm.$on`
      // 不可用 —— vm 代理只暴露 setup 里的绑定，不含实例方法）。
      'onUpdate:modelValue': (next: MailDigestFormModel) => {
        latest = next;
      },
      ...(opts.errors ? { errors: opts.errors } : {}),
      ...(opts.focusField !== undefined ? { focusField: opts.focusField } : {}),
    },
    global: globalConfig,
  });
  return { wrapper, latest: () => latest };
}

describe('MailScheduleSection — MANUAL_ONLY 隐藏全部时间输入', () => {
  it('MANUAL_ONLY：时刻 / 星期 / 月号三个输入都不渲染，并显示「仅手动」提示', () => {
    const form = baseForm({
      frequency: 'MANUAL_ONLY',
      send_hour: null,
      send_minute: null,
    });
    const { wrapper } = mountSection(form);

    expect(wrapper.findAll('.time-select')).toHaveLength(0);
    expect(wrapper.find('.weekday-select').exists()).toBe(false);
    expect(wrapper.find('.day-input').exists()).toBe(false);
    expect(wrapper.find('.mock-alert').text()).toContain('仅手动发送，不注册定时任务');
    wrapper.unmount();
  });

  it('频率单选组四个选项都在（meta 未到达时用兜底表，首屏也能切频率）', () => {
    const { wrapper } = mountSection(baseForm({ frequency: 'MANUAL_ONLY' }));
    const labels = wrapper.findAll('.mock-radio-button').map((n) => n.text());
    expect(labels).toHaveLength(4);
    expect(labels.join('|')).toContain('仅手动');
    wrapper.unmount();
  });
});

describe('MailScheduleSection — 三种定时频率各自的配套输入', () => {
  it('DAILY：只有时 / 分两个下拉，无星期、无月号', () => {
    const { wrapper } = mountSection(baseForm({ frequency: 'DAILY' }));
    expect(wrapper.findAll('.time-select')).toHaveLength(2);
    expect(wrapper.find('.weekday-select').exists()).toBe(false);
    expect(wrapper.find('.day-input').exists()).toBe(false);
    expect(wrapper.find('.mock-alert').exists()).toBe(false);
    wrapper.unmount();
  });

  it('WEEKLY：时 / 分 + 星期下拉，无月号', () => {
    const { wrapper } = mountSection(baseForm({ frequency: 'WEEKLY', weekday: 1 }));
    expect(wrapper.findAll('.time-select')).toHaveLength(2);
    expect(wrapper.find('.weekday-select').exists()).toBe(true);
    expect(wrapper.find('.weekday-select').attributes('data-placeholder')).toBe('选择星期几');
    expect(wrapper.find('.day-input').exists()).toBe(false);
    wrapper.unmount();
  });

  it('MONTHLY：时 / 分 + 月号输入（1..28），无星期', () => {
    const { wrapper } = mountSection(baseForm({ frequency: 'MONTHLY', day_of_month: 5 }));
    expect(wrapper.findAll('.time-select')).toHaveLength(2);
    expect(wrapper.find('.day-input').exists()).toBe(true);
    expect(wrapper.find('.weekday-select').exists()).toBe(false);
    wrapper.unmount();
  });

  it('显隐由 options 的 needs_* 决定（meta 驱动）：meta 说 DAILY 不要时刻就不渲染时刻', () => {
    const { wrapper } = mountSection(baseForm({ frequency: 'DAILY' }), {
      frequencyOptions: optionsFor({ DAILY: { needs_time: false } }),
    });
    expect(wrapper.findAll('.time-select')).toHaveLength(0);
    expect(wrapper.find('.mock-alert').exists()).toBe(true);
    wrapper.unmount();
  });
});

describe('MailScheduleSection — 切频率时清掉用不到的配套字段', () => {
  /** 直接从 el-radio-group 桩上抓 emit 通道（点真实按钮要复刻 EP 的 radio 语义）。 */
  function captureGroupEmit(wrapper: ReturnType<typeof mount>): (v: unknown) => void {
    const vm = wrapper.findComponent(ElRadioGroupStub).vm as unknown as {
      $emit: (e: string, v: unknown) => void;
    };
    return (v: unknown) => vm.$emit('update:modelValue', v);
  }

  it('WEEKLY → MANUAL_ONLY：weekday 与时刻一并置 null（留着会被后端 21704 拒）', () => {
    const { wrapper, latest } = mountSection(baseForm({ frequency: 'WEEKLY', weekday: 3 }));
    captureGroupEmit(wrapper)('MANUAL_ONLY');
    expect(latest().frequency).toBe('MANUAL_ONLY');
    expect(latest().weekday).toBeNull();
    expect(latest().send_hour).toBeNull();
    expect(latest().send_minute).toBeNull();
    wrapper.unmount();
  });

  it('DAILY → WEEKLY：保留时刻、只补星期（切过去不丢用户已填的时刻）', () => {
    const { wrapper, latest } = mountSection(baseForm({ frequency: 'DAILY' }));
    captureGroupEmit(wrapper)('WEEKLY');
    expect(latest().weekday).toBeNull();
    expect(latest().send_hour).toBe(8);
    expect(latest().send_minute).toBe(30);
    wrapper.unmount();
  });

  it('MANUAL_ONLY → DAILY：时刻仍是 null（不凭空造值，让用户自己选）', () => {
    const { wrapper, latest } = mountSection(
      baseForm({ frequency: 'MANUAL_ONLY', send_hour: null, send_minute: null }),
    );
    captureGroupEmit(wrapper)('DAILY');
    expect(latest().frequency).toBe('DAILY');
    expect(latest().send_hour).toBeNull();
    wrapper.unmount();
  });
});

describe('MailScheduleSection — 字段红字与聚焦高亮', () => {
  it('errors 命中某字段时该行标 is-error 且显示红字', () => {
    const { wrapper } = mountSection(baseForm({ frequency: 'WEEKLY', weekday: null }), {
      errors: { weekday: '每周发送需指定星期几' },
    });
    const row = wrapper.findAll('.field-row').find((n) => n.classes().includes('is-error'));
    expect(row?.text()).toContain('每周发送需指定星期几');
    wrapper.unmount();
  });

  it('focusField 指到的行加 is-focus（字段聚焦的视觉层；默认值不额外标红）', () => {
    const { wrapper } = mountSection(baseForm(), { focusField: 'frequency' });
    expect(wrapper.findAll('.field-row').some((n) => n.classes().includes('is-focus'))).toBe(true);
    wrapper.unmount();
  });
});
