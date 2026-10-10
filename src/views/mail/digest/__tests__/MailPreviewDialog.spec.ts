// @vitest-environment happy-dom
// src/views/mail/digest/__tests__/MailPreviewDialog.spec.ts
//
// 2026-10-14 新增（review 第 1 轮 M-1 + A4）：邮件预览弹窗的**渲染与隔离契约**守卫。
// 三组：
//
//  1. **iframe 必须带 `sandbox`**（最高优先的一条）：邮件正文里的零件号 / 名称 / 客户名
//     与配置里的 `subject_template` 都是任意用户可录入的自由文本，服务端渲染出来就是
//     **攻击者可控的 HTML**。没有 `sandbox` 时 `about:srcdoc` iframe 继承父页 origin，
//     正文里的 `<script>` / `<img onerror=…>` 会在登录态同源上下文里执行，够得着
//     `parent.localStorage` 里的 access + refresh token，并以当前身份 `fetch('/api/v2/*')`
//     —— 而本仓**全仓没有 CSP**，没有第二道防线。判定写成「属性在 + 两种放开项都不在」
//     而不是「属性值等于空串」：将来有人改成 `allow-same-origin` / `allow-scripts`
//     （都等于把隔离拆掉）时本用例会红。
//  2. **`srcdoc` 绑定的是服务端返回的 html**（绑定写错 ⇒ 预览显示的是上一封 / 空文档，
//     且 attribute 名写错时 Vue 只会静默不渲染属性）。
//  3. **三种态**：loading 显示「正在渲染」且**不**渲染 iframe；无结果渲染空态；
//     有关联结果才渲染 iframe + 元信息（主题 / 逾期 / 未来 / 生效列数）。
//
// 用 EP 模板桩而不是真 EP 组件：被测的是「本组件有没有按契约渲染」，不复刻 el-dialog
// 的 teleport / 动画（桩法照 `MailScheduleSection.spec.ts`）。

import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import MailPreviewDialog from '../components/MailPreviewDialog.vue';
import type { MailDigestPreviewData } from '../mailDigestSchema';

// ---------------------------------------------------------------- EP 桩
const ElDialogStub = {
  name: 'ElDialog',
  props: ['modelValue', 'title', 'width', 'top', 'closeOnClickModal'],
  emits: ['update:modelValue'],
  template:
    '<section class="mock-dialog" :data-title="title" :data-top="top" :data-width="width">' +
    '<slot /><footer class="mock-footer"><slot name="footer" /></footer></section>',
};

const ElTagStub = {
  name: 'ElTag',
  props: ['type', 'size', 'effect'],
  template: '<span class="mock-tag"><slot /></span>',
};

const ElEmptyStub = {
  name: 'ElEmpty',
  props: ['description'],
  template: '<div class="mock-empty">{{ description }}</div>',
};

const ElButtonStub = {
  name: 'ElButton',
  emits: ['click'],
  template: '<button class="mock-button" @click="$emit(\'click\')"><slot /></button>',
};

const globalConfig = {
  components: {
    'el-dialog': ElDialogStub,
    'el-tag': ElTagStub,
    'el-empty': ElEmptyStub,
    'el-button': ElButtonStub,
  },
};

const RESULT: MailDigestPreviewData = {
  subject: '交期汇总 2026-10-14',
  // 刻意放一段「服务端渲染出来的」HTML：正文内容本身是用户可录入的自由文本，
  // 组件对它**只能渲染、不解析**（解析 = v-html = 同源 XSS）。
  html: '<table><tr><td>P-001</td></tr></table><script>/* 攻击者可注入 */</script>',
  overdue_count: 3,
  upcoming_count: 12,
  columns: ['part_no', 'customer'],
};

function mountDialog(props: {
  modelValue?: boolean;
  result?: MailDigestPreviewData | null;
  loading?: boolean;
}) {
  return mount(MailPreviewDialog, {
    props: { modelValue: true, result: RESULT, loading: false, ...props },
    global: globalConfig,
  });
}

describe('MailPreviewDialog — iframe 必须沙箱化（M-1 同源 XSS 防线）', () => {
  it('sandbox 属性存在，且不含 allow-same-origin / allow-scripts', () => {
    const wrapper = mountDialog({});
    const frame = wrapper.find('iframe');
    expect(frame.exists()).toBe(true);
    expect(frame.attributes('sandbox')).toBeDefined();
    // 两种「等于没加」的写法都要挡住：
    //   allow-same-origin → 不透明 origin 变回父页 origin（同源可读写 parent.localStorage）；
    //   allow-scripts    → 正文里的内联脚本 / onerror 又能跑。
    expect(frame.attributes('sandbox')).not.toContain('allow-same-origin');
    expect(frame.attributes('sandbox')).not.toContain('allow-scripts');
    // 空值 = 最大限制（禁 form / top-navigation / popups，邮件预览一个都不需要）。
    expect(frame.attributes('sandbox')).toBe('');
    wrapper.unmount();
  });

  it('srcdoc 绑的是服务端返回的 html（绑定名写错时 Vue 只会静默不渲染该属性）', () => {
    const wrapper = mountDialog({});
    // ⚠️ 断**属性**而不是 `wrapper.find('iframe').html()`：happy-dom 不给 iframe 建嵌套
    // 浏览上下文，`html()` 返回的是 iframe 元素自身的外层 HTML（含 srcdoc 属性值），
    // 拿它 `toContain('<script>')` 是**恒真** —— 上一版（review 第 2 轮 B-4）就是这样
    // 「看着在守、其实没守」。真正想守的「正文原样进属性（不 escape、不 strip 标签，
    // 隔离靠 sandbox 不靠清洗内容）」由上面那行 `toBe(RESULT.html)` 逐字钉死。
    expect(wrapper.find('iframe').attributes('srcdoc')).toBe(RESULT.html);
    wrapper.unmount();
  });

  it('iframe 带 title（无障碍：读屏软件要能报出这块 iframe 是「邮件正文」）', () => {
    const wrapper = mountDialog({});
    expect(wrapper.find('iframe').attributes('title')).toBe('邮件正文预览');
    wrapper.unmount();
  });
});

describe('MailPreviewDialog — 三种态的渲染分支', () => {
  it('loading：显示「正在渲染」且**不**渲染 iframe', () => {
    const wrapper = mountDialog({ loading: true });
    expect(wrapper.text()).toContain('正在按当前配置渲染邮件');
    expect(wrapper.find('iframe').exists()).toBe(false);
    wrapper.unmount();
  });

  it('无结果：渲染空态而不是空白弹窗', () => {
    const wrapper = mountDialog({ result: null });
    expect(wrapper.find('.mock-empty').text()).toBe('尚无预览内容');
    expect(wrapper.find('iframe').exists()).toBe(false);
    wrapper.unmount();
  });

  it('有结果：主题 / 逾期数 / 未来数 / 生效列数都从 result 逐项渲染', () => {
    const wrapper = mountDialog({});
    expect(wrapper.text()).toContain('交期汇总 2026-10-14');
    expect(wrapper.text()).toContain('逾期 3 条');
    expect(wrapper.text()).toContain('未来 12 条');
    expect(wrapper.text()).toContain('生效列 2 列');
    wrapper.unmount();
  });

  it('关闭按钮 emit update:modelValue=false（壳据此 v-model 收起弹窗）', async () => {
    const wrapper = mountDialog({});
    await wrapper.find('.mock-footer .mock-button').trigger('click');
    expect(wrapper.emitted('update:modelValue')).toEqual([[false]]);
    wrapper.unmount();
  });
});
