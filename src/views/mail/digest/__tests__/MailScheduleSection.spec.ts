// @vitest-environment happy-dom
// src/views/mail/digest/__tests__/MailScheduleSection.spec.ts
//
// 2026-10-13 新增：调度设置 section 的**渲染契约**守卫。四组：
//
//  1. `MANUAL_ONLY` 时**隐藏全部时间输入**（时/分、星期、月号都不渲染），并给出
//     「仅手动发送，不注册定时任务」的提示 —— 这条是需求里点名的行为；
//  2. 其余三种频率各自只渲染自己那一组配套输入（DAILY 只有时刻 / WEEKLY 多星期 /
//     MONTHLY 多月号），判据读 `frequencyOptions` 的三个 `needs_*`（meta 驱动，不是硬编码）；
//  3. 切频率时把「当前频率用不到」的配套字段置 null（⚠️ 2026-10-14 订正：后端对「多填」
//     是清空 / 忽略而非 21704，前端归一是为了表单自洽 + 红字落在可见字段上，见 M-2）；
//  4. 字段红字与 focusField 高亮落到对应行上（字段聚焦的视觉层）；
//  5. 2026-10-16 新增的「发信邮箱」一行：**选项来自 `senderAccounts` prop（query 数据）、
//     不是组件内硬编码**，label 用管理员起的自定义名称，清空归一成 null（= 未选）。
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
import type { MailAccountData } from '@/views/mail/accounts/mailAccountSchema';

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

// 2026-10-16：这两个桩加了 `<slot />`（渲染 el-option 子项）与 `label` 文本输出。
// 加 slot 的原因不是「更像真的」，而是「发信邮箱」那一组用例要断言**选项集**（标签取自
// `senderAccounts` prop）；没有 slot 的话 el-option 永远不会被渲染，选项断言全是空的。
// 既有用例不受影响：它们只断言 `.time-select` / `.weekday-select` 的存在与 placeholder。
const ElSelectStub = {
  name: 'ElSelect',
  props: ['modelValue', 'placeholder'],
  emits: ['update:modelValue'],
  template:
    '<div class="mock-select" :data-placeholder="placeholder || \'\'" @click="$emit(\'update:modelValue\', 1)"><slot /></div>',
};

const ElOptionStub = {
  name: 'ElOption',
  props: ['label', 'value'],
  template: '<div class="mock-option">{{ label }}</div>',
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

/** 2026-10-16：「发信邮箱」下拉的候选（query `GET /mail/accounts` 的行）。
 *  label 是**管理员起的自定义名称**，不是登录账号 —— 同一家服务商的多个账号靠它区分。 */
const SENDER_ACCOUNTS: readonly MailAccountData[] = [
  {
    id: '9000000000000902',
    version: 1,
    name: '采购部邮箱',
    preset: 'NET_EASE_163',
    account: 'purchase@example.com',
    is_default: true,
    created_at: '2026-10-16 08:00:00',
    updated_at: '2026-10-16 08:00:00',
  },
  {
    id: '9000000000000903',
    version: 1,
    name: '仓库邮箱',
    preset: 'TENCENT_QQ',
    account: '123456789',
    is_default: false,
    created_at: '2026-10-16 08:00:00',
    updated_at: '2026-10-16 08:00:00',
  },
];

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
    sender_account_id: null,
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
    senderAccounts?: readonly MailAccountData[];
    errors?: Record<string, string>;
    focusField?: MailDigestFormField | null;
  } = {},
) {
  let latest = form;
  const wrapper = mount(MailScheduleSection, {
    props: {
      modelValue: form,
      frequencyOptions: opts.frequencyOptions ?? optionsFor(),
      // 默认给两条邮箱：不传时组件要能渲染（prop 可选），但**带选项**才是真实场景，
      // 下面的 S1/S2 都靠它断言「选项来自 props 而不是组件内硬编码」。
      senderAccounts: opts.senderAccounts ?? SENDER_ACCOUNTS,
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

  it('WEEKLY → MANUAL_ONLY：weekday 与时刻一并置 null（多填的那支后端是清空/忽略，前端先归一）', () => {
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

// ============================================================
// 2026-10-16：「发信邮箱」一行
// ============================================================

describe('MailScheduleSection — 发信邮箱下拉（2026-10-16）', () => {
  /** 「发信邮箱」那个 select 的 emit 通道。⚠️ 不能用 `findComponent(ElSelectStub)`：
   *  页面里同时有时刻 / 星期两个同款 select，`findComponent` 返回的是第一个（时刻），
   *  拿它 emit 等于在测「改时刻」那条路。 */
  function senderSelectEmit(wrapper: ReturnType<typeof mount>): (v: unknown) => void {
    const target = wrapper
      .findAllComponents(ElSelectStub)
      .find((c) => c.classes().includes('sender-select'));
    const vm = target!.vm as unknown as { $emit: (e: string, v: unknown) => void };
    return (v: unknown) => vm.$emit('update:modelValue', v);
  }

  it('S1：选项 = `senderAccounts` prop 的每一行，label 用自定义名称（不是登录账号）', () => {
    const { wrapper } = mountSection(baseForm({ sender_account_id: '9000000000000902' }));
    const labels = wrapper
      .findAll('.sender-select')[0]!
      .findAll('.mock-option')
      .map((n) => n.text());
    expect(labels).toEqual(['采购部邮箱', '仓库邮箱']);
    // 自定义名称才是展示口径：登录账号不该顶上来当标签。
    expect(labels.join('|')).not.toContain('purchase@example.com');
    wrapper.unmount();
  });

  it('S2：一个邮箱都没有时给「还没有可用邮箱」的指路提示（选项区自然为空）', () => {
    const { wrapper } = mountSection(baseForm(), { senderAccounts: [] });
    expect(wrapper.findAll('.sender-select')[0]!.findAll('.mock-option')).toHaveLength(0);
    expect(wrapper.text()).toContain('还没有可用邮箱');
    wrapper.unmount();
  });

  it('S3：选中发信邮箱时 patch 出的是雪花 id 原样字符串（不过 Number）', () => {
    const { wrapper, latest } = mountSection(baseForm({ sender_account_id: null }));
    senderSelectEmit(wrapper)('9000000000000903');
    expect(latest().sender_account_id).toBe('9000000000000903');
    wrapper.unmount();
  });

  it('S4：清空（el-select 给空串）归一成 null = 未选，不把空串塞上 wire', () => {
    const { wrapper, latest } = mountSection(baseForm({ sender_account_id: '9000000000000902' }));
    senderSelectEmit(wrapper)('');
    expect(latest().sender_account_id).toBeNull();
    wrapper.unmount();
  });
});
