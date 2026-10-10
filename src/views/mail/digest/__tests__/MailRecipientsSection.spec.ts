// @vitest-environment happy-dom
// src/views/mail/digest/__tests__/MailRecipientsSection.spec.ts
//
// 2026-10-14 新增（review 第 1 轮 A4）：收件人 section 的**渲染与接线契约**守卫。三组：
//
//  1. **TO / CC 两个下拉都在**（缺一个就是「收件人能填、抄送填不了」的静默功能缺失；
//     两者靠 `aria-label` 区分，不靠位置），且 `multiple-limit` = 20。
//  2. **补丁只动自己那一项**：TO 的变更不能顺带改掉 CC（反过来同理）。这是「整份模型从
//     emit 出、壳整体写回 store」的结构下最容易写错的一处 —— 写错的表现是「改一个收件人，
//     另一个列表被清空」，且因为 schema 只校验格式，功能性断言测不出来。
//  3. **非数组值归一成 `[]`**（EP 的 `clearable` 清出来的是 `[]`，某些路径给 `null`；
//     `null` 若顺着 patch 写进表单态会在 Zod 的 `z.array()` 上炸成一条看不懂的报错）。
//
// EP 桩法与 `MailScheduleSection.spec.ts` 同款（纯组件，props 进 / emits 出，见
// `composables/useMailDigestStore.ts` 文件头的结构说明）。`el-select` 的桩按「点一下
// 发出一个预置值」造，这样不用复刻 EP 的标签 / 输入框内部实现就能验接线。

import { describe, expect, it } from 'vitest';
import { defineComponent, h } from 'vue';
import { mount } from '@vue/test-utils';
import MailRecipientsSection from '../components/MailRecipientsSection.vue';
import type { MailDigestFormField, MailDigestFormModel } from '../mailDigestSchema';

/** el-select 桩：点一下就 emit 出 `next`（用来驱动「用户选了一个新地址」）。
 *  `nextByLabel` 按 `aria-label` 分派 —— 同一份桩要同时服务 TO / CC 两个下拉（真实页面
 *  也只有一个 `el-select` 组件）。`aria-label` / `placeholder` 等未声明的 attr 走
 *  fallthrough 落在根元素上（真实 EP 同理），断言直接读 DOM 属性 —— 顺带把 a11y 标注也钉住。 */
function selectStub(nextByLabel: Record<string, unknown>) {
  return defineComponent({
    name: 'ElSelect',
    props: ['modelValue', 'multipleLimit'],
    emits: ['update:modelValue'],
    setup(props, { emit, attrs }) {
      return () =>
        h('div', {
          class: 'mock-select',
          'data-limit': props.multipleLimit == null ? '' : String(props.multipleLimit),
          'data-count': Array.isArray(props.modelValue) ? String(props.modelValue.length) : '-',
          onClick: () => emit('update:modelValue', nextByLabel[attrs['aria-label'] as string]),
        });
    },
  });
}

function mountSection(
  form: MailDigestFormModel,
  opts: {
    nextTo?: unknown;
    nextCc?: unknown;
    errors?: Record<string, string>;
    focusField?: MailDigestFormField | null;
  } = {},
) {
  let latest = form;
  const wrapper = mount(MailRecipientsSection, {
    props: {
      modelValue: form,
      'onUpdate:modelValue': (next: MailDigestFormModel) => {
        latest = next;
      },
      ...(opts.errors ? { errors: opts.errors } : {}),
      ...(opts.focusField !== undefined ? { focusField: opts.focusField } : {}),
    },
    global: {
      components: {
        'el-select': selectStub({ 收件人: opts.nextTo, 抄送: opts.nextCc }),
      },
    },
  });
  return { wrapper, latest: () => latest };
}

function baseForm(over: Partial<MailDigestFormModel> = {}): MailDigestFormModel {
  return {
    enabled: true,
    frequency: 'DAILY',
    send_hour: 8,
    send_minute: 30,
    weekday: null,
    day_of_month: null,
    recipients: ['a@example.com'],
    cc_recipients: ['c@example.com'],
    include_overdue: true,
    include_upcoming: false,
    upcoming_days: 7,
    visible_columns: ['part_no'],
    subject_template: '',
    ...over,
  };
}

describe('MailRecipientsSection — TO / CC 两个可填列表都在', () => {
  it('两个下拉各自带 aria-label（收件人 / 抄送），不是同一个渲染了两次', () => {
    const { wrapper } = mountSection(baseForm());
    const selects = wrapper.findAll('.mock-select');
    expect(selects).toHaveLength(2);
    expect(selects[0]!.attributes('aria-label')).toBe('收件人');
    expect(selects[1]!.attributes('aria-label')).toBe('抄送');
    expect(wrapper.text()).toContain('收件人（TO）');
    expect(wrapper.text()).toContain('抄送（CC）');
    wrapper.unmount();
  });

  it('multiple-limit=20，且回显当前模型里的地址条数（发出去的 payload 依赖这个回显）', () => {
    const { wrapper } = mountSection(
      baseForm({ recipients: ['a@example.com', 'b@example.com'], cc_recipients: [] }),
    );
    const selects = wrapper.findAll('.mock-select');
    expect(selects[0]!.attributes('data-limit')).toBe('20');
    expect(selects[1]!.attributes('data-limit')).toBe('20');
    expect(selects[0]!.attributes('data-count')).toBe('2');
    expect(selects[1]!.attributes('data-count')).toBe('0');
    wrapper.unmount();
  });

  it('CC 可以留空（占位符明说「可留空」，空数组是合法初值）', () => {
    const { wrapper } = mountSection(baseForm({ cc_recipients: [] }));
    expect(wrapper.findAll('.mock-select')[1]!.attributes('data-count')).toBe('0');
    expect(wrapper.findAll('.mock-select')[1]!.attributes('placeholder')).toBe('可留空');
    wrapper.unmount();
  });
});

describe('MailRecipientsSection — 补丁只动自己那一项', () => {
  it('改 TO：recipients 换新值、cc_recipients 原样带着', async () => {
    const { wrapper, latest } = mountSection(baseForm(), {
      nextTo: ['a@example.com', 'new@example.com'],
    });
    await wrapper.findAll('.mock-select')[0]!.trigger('click');
    expect(latest().recipients).toEqual(['a@example.com', 'new@example.com']);
    expect(latest().cc_recipients).toEqual(['c@example.com']);
    wrapper.unmount();
  });

  it('改 CC：cc_recipients 换新值、recipients 原样带着', async () => {
    const { wrapper, latest } = mountSection(baseForm(), { nextCc: ['c2@example.com'] });
    await wrapper.findAll('.mock-select')[1]!.trigger('click');
    expect(latest().cc_recipients).toEqual(['c2@example.com']);
    expect(latest().recipients).toEqual(['a@example.com']);
    wrapper.unmount();
  });

  it('EP 给出 null / 非数组时归一成 []（不许把 null 写进表单态）', async () => {
    const { wrapper, latest } = mountSection(baseForm(), { nextTo: null });
    await wrapper.findAll('.mock-select')[0]!.trigger('click');
    expect(latest().recipients).toEqual([]);
    wrapper.unmount();
  });
});

describe('MailRecipientsSection — 字段红字与聚焦高亮', () => {
  it('errors 命中 recipients 时该行标 is-error 且显示红字', () => {
    const { wrapper } = mountSection(baseForm(), { errors: { recipients: '至少填写一个收件人' } });
    const row = wrapper.findAll('.field-row').find((n) => n.classes().includes('is-error'));
    expect(row?.text()).toContain('至少填写一个收件人');
    wrapper.unmount();
  });

  it('errors 命中 cc_recipients 时红字落在抄送那一行（不是收件人那一行）', () => {
    const { wrapper } = mountSection(baseForm(), {
      errors: { cc_recipients: '邮箱格式不正确' },
    });
    const rows = wrapper.findAll('.field-row');
    expect(rows[0]!.classes()).not.toContain('is-error');
    expect(rows[1]!.classes()).toContain('is-error');
    expect(rows[1]!.text()).toContain('邮箱格式不正确');
    wrapper.unmount();
  });

  it('focusField 指到 cc_recipients 时高亮落在抄送那一行', () => {
    const { wrapper } = mountSection(baseForm(), { focusField: 'cc_recipients' });
    const rows = wrapper.findAll('.field-row');
    expect(rows[0]!.classes()).not.toContain('is-focus');
    expect(rows[1]!.classes()).toContain('is-focus');
    wrapper.unmount();
  });
});
