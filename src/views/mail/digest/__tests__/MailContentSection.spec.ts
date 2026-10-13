// @vitest-environment happy-dom
// src/views/mail/digest/__tests__/MailContentSection.spec.ts
//
// 2026-10-13 新增：发送内容 section 的**渲染契约**守卫。四组：
//
//  1. 关掉「含未来 N 天」时 `upcoming_days` 输入项**禁用**（需求里点名的行为）；
//  2. 关开关**不清天数**（清掉的话「关 → 开」之后用户会发现天数丢了）；
//  3. 列白名单选项取自 props（meta 驱动，前端不硬编码列名）；
//  4. 标题模板留空合法（= 用后端默认标题），红字与聚焦高亮落到对应行。
//
// EP 桩法与 `MailScheduleSection.spec.ts` 同款（纯组件，props 进 / emits 出，见
// `composables/useMailDigestStore.ts` 文件头的结构说明）。

import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import MailContentSection from '../components/MailContentSection.vue';
import type { MailDigestFormField, MailDigestFormModel } from '../mailDigestSchema';

const ElSwitchStub = {
  name: 'ElSwitch',
  props: ['modelValue'],
  emits: ['update:modelValue'],
  template: '<button class="mock-switch" @click="$emit(\'update:modelValue\', !modelValue)" />',
};

const ElInputNumberStub = {
  name: 'ElInputNumber',
  props: ['modelValue', 'disabled', 'min', 'max'],
  emits: ['update:modelValue'],
  template:
    '<div class="mock-input-number" :data-disabled="String(!!disabled)" :data-min="min" :data-max="max" />',
};

const ElInputStub = {
  name: 'ElInput',
  props: ['modelValue', 'placeholder'],
  emits: ['update:modelValue'],
  template: '<input class="mock-input" :placeholder="placeholder || \'\'" />',
};

const ElCheckboxGroupStub = {
  name: 'ElCheckboxGroup',
  props: ['modelValue'],
  emits: ['update:modelValue'],
  template: '<div class="mock-checkbox-group"><slot /></div>',
};

const ElCheckboxStub = {
  name: 'ElCheckbox',
  props: ['value', 'label'],
  template: '<label class="mock-checkbox"><slot /></label>',
};

const globalConfig = {
  components: {
    'el-switch': ElSwitchStub,
    'el-input-number': ElInputNumberStub,
    'el-input': ElInputStub,
    'el-checkbox-group': ElCheckboxGroupStub,
    'el-checkbox': ElCheckboxStub,
  },
};

const COLUMNS = [
  { key: 'part_no', label: '零件号' },
  { key: 'name', label: '名称' },
  { key: 'customer', label: '客户' },
  { key: 'system_delivery_date', label: '系统交期' },
];

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

function mountSection(
  form: MailDigestFormModel,
  opts: {
    columns?: typeof COLUMNS;
    upcomingDaysRange?: { min: number; max: number };
    errors?: Record<string, string>;
    focusField?: MailDigestFormField | null;
  } = {},
) {
  let latest = form;
  const wrapper = mount(MailContentSection, {
    props: {
      modelValue: form,
      columns: opts.columns ?? COLUMNS,
      upcomingDaysRange: opts.upcomingDaysRange ?? { min: 1, max: 60 },
      // `onUpdate:modelValue` prop 形式接 emit（script-setup 组件的 wrapper.vm.$on 不可用）。
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

describe('MailContentSection — 关掉「含未来 N 天」时禁用天数输入', () => {
  it('include_upcoming=false ⇒ 天数输入 disabled=true', () => {
    const { wrapper } = mountSection(baseForm({ include_upcoming: false }));
    expect(wrapper.find('.days-input').attributes('data-disabled')).toBe('true');
    wrapper.unmount();
  });

  it('include_upcoming=true ⇒ 天数输入可用（且两个开关都点得动）', () => {
    const { wrapper } = mountSection(baseForm({ include_upcoming: true }));
    expect(wrapper.find('.days-input').attributes('data-disabled')).toBe('false');
    wrapper.unmount();
  });

  it('关开关只切开关、不动天数（关 → 开之后天数还在，不给用户「天数丢了」的意外）', async () => {
    const { wrapper, latest } = mountSection(
      baseForm({ include_upcoming: true, upcoming_days: 21 }),
    );
    // 两个 el-switch：第一个是「包含逾期」，第二个是「含未来 N 天」。
    // 每步之后把 emit 出来的新模型喂回 props（父组件 v-model 的真实接线，否则桩看到的
    // 永远是初始 modelValue、第二次点击会 toggle 出同样的值）。
    await wrapper.findAll('.mock-switch')[1]?.trigger('click');
    await wrapper.setProps({ modelValue: latest() });
    expect(latest().include_upcoming).toBe(false);
    expect(latest().upcoming_days).toBe(21);

    await wrapper.findAll('.mock-switch')[1]?.trigger('click');
    await wrapper.setProps({ modelValue: latest() });
    expect(latest().include_upcoming).toBe(true);
    expect(latest().upcoming_days).toBe(21);
    wrapper.unmount();
  });

  it('天数输入的上下限取自 props（meta 驱动，后端收窄时前端自动跟随）', () => {
    const { wrapper } = mountSection(baseForm({ include_upcoming: true }), {
      upcomingDaysRange: { min: 3, max: 30 },
    });
    expect(wrapper.find('.days-input').attributes('data-min')).toBe('3');
    expect(wrapper.find('.days-input').attributes('data-max')).toBe('30');
    expect(wrapper.text()).toContain('3..30');
    wrapper.unmount();
  });
});

describe('MailContentSection — 列白名单与标题模板', () => {
  it('列选项逐个来自 props（meta 驱动，前端不硬编码列名）', () => {
    const { wrapper } = mountSection(baseForm());
    const labels = wrapper.findAll('.mock-checkbox').map((n) => n.text());
    expect(labels).toEqual(['零件号', '名称', '客户', '系统交期']);
    wrapper.unmount();
  });

  it('meta 未返回列候选时给出提示而不是空白（首屏 meta 还在飞的那一瞬）', () => {
    const { wrapper } = mountSection(baseForm(), { columns: [] });
    expect(wrapper.text()).toContain('暂无列候选');
    wrapper.unmount();
  });

  it('标题模板留空合法（= 用后端默认标题），不是必填', () => {
    const { wrapper } = mountSection(baseForm({ subject_template: '' }));
    expect(wrapper.find('.mock-input').attributes('placeholder')).toContain('留空则用后端默认标题');
    wrapper.unmount();
  });
});

describe('MailContentSection — 字段红字与聚焦高亮', () => {
  it('visible_columns 报错时该行标 is-error 并显示红字', () => {
    const { wrapper } = mountSection(baseForm(), { errors: { visible_columns: '至少选择一列' } });
    const row = wrapper.findAll('.field-row').find((n) => n.classes().includes('is-error'));
    expect(row?.text()).toContain('至少选择一列');
    wrapper.unmount();
  });

  it('focusField 指到 upcoming_days 时该行加 is-focus', () => {
    const { wrapper } = mountSection(baseForm(), { focusField: 'upcoming_days' });
    const row = wrapper.findAll('.field-row').find((n) => n.classes().includes('is-focus'));
    expect(row?.classes()).toContain('field-row');
    wrapper.unmount();
  });
});
