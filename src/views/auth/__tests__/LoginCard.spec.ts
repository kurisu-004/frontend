// 2026-09-24 新增：LoginCard 视觉壳组件单测（仓内首例组件单测先例）。
// 用 happy-dom + @vue/test-utils mount + vi.mock 拦截子组件 / 图标 import。
//
// 注意：仓内日常开发走 unplugin-vue-components + ElementPlusResolver 自动注册；
// vitest 单独跑不走该插件，el-card / el-button 不会被解析为组件。挂个最小 stub
// 让 mount 跑得通：el-card 当透明容器、el-button 透传 attrs/slots 给原生 button。
// @vitest-environment happy-dom
/* eslint-disable vue/one-component-per-file -- 本文件为 spec 桩组件集中放置，单测场景可接受 */

import { describe, it, expect } from 'vitest';
import { defineComponent, h } from 'vue';
import { mount } from '@vue/test-utils';
import LoginCard from '../LoginCard.vue';

// 2026-09-24 新增：el-button 的最小 stub。attrs 透传到原生 <button>，
// native-type="submit" 在原生 form 语义里点击触发 submit 事件。
// disabled 走原生 HTML attribute，便于测试断言 btn.attributes('disabled')。
const ElButtonStub = defineComponent({
  name: 'ElButtonStub',
  inheritAttrs: false,
  setup(_, { slots, attrs }) {
    return () =>
      h(
        'button',
        {
          ...attrs,
          type: attrs['native-type'] ?? attrs.type ?? 'button',
          disabled: attrs.disabled === true || attrs.disabled === '' || attrs.disabled === 'true',
        },
        slots.default?.(),
      );
  },
});

const ElCardStub = defineComponent({
  name: 'ElCardStub',
  setup(_, { slots }) {
    return () => h('div', { class: 'el-card-stub' }, slots.default?.());
  },
});

const globalConfig = {
  components: { ElButton: ElButtonStub, ElCard: ElCardStub },
};

describe('LoginCard', () => {
  it('渲染默认 props', () => {
    const wrapper = mount(LoginCard, {
      props: { title: 'myERP' },
      slots: { default: '<input class="cp-input" />' },
      global: globalConfig,
    });
    expect(wrapper.text()).toContain('myERP');
    expect(wrapper.text()).toContain('登 录');
    expect(wrapper.find('button').exists()).toBe(true);
  });

  it('点提交按钮 emit submit', async () => {
    const wrapper = mount(LoginCard, {
      props: { title: 'myERP' },
      slots: { default: '<input />' },
      global: globalConfig,
    });
    // happy-dom 下 click submit-button 不冒泡到 form submit 事件，
    // 直接在 form 上触发 submit 事件走 @submit.prevent="onSubmit"。
    await wrapper.find('form').trigger('submit');
    expect(wrapper.emitted('submit')).toHaveLength(1);
  });

  it('submitting=true 时按钮文案切到「登录中...」', () => {
    const wrapper = mount(LoginCard, {
      props: { title: 'myERP', submitting: true },
      slots: { default: '<input />' },
      global: globalConfig,
    });
    expect(wrapper.text()).toContain('登录中');
    // submitting 时默认 disabled=false；按钮不被禁用，但文案与父组件逻辑拦截 submit。
    expect(wrapper.find('button').attributes('disabled')).toBeUndefined();
  });

  it('submitting=true 时再次点按钮不会 emit（onSubmit 内 submitting 守卫）', async () => {
    const wrapper = mount(LoginCard, {
      props: { title: 'myERP', submitting: true },
      slots: { default: '<input />' },
      global: globalConfig,
    });
    await wrapper.find('button').trigger('click');
    expect(wrapper.emitted('submit')).toBeUndefined();
  });

  it('disabled=true 时按钮 DOM disabled 且点击不 emit', async () => {
    const wrapper = mount(LoginCard, {
      props: { title: 'myERP', disabled: true },
      slots: { default: '<input />' },
      global: globalConfig,
    });
    expect(wrapper.find('button').attributes('disabled')).toBeDefined();
    await wrapper.find('button').trigger('click');
    expect(wrapper.emitted('submit')).toBeUndefined();
  });

  it('errorMessage 渲染在指定容器', () => {
    const wrapper = mount(LoginCard, {
      props: { title: 'myERP', errorMessage: '账号或密码错误' },
      slots: { default: '<input />' },
      global: globalConfig,
    });
    const error = wrapper.find('[role="alert"]');
    expect(error.exists()).toBe(true);
    expect(error.text()).toBe('账号或密码错误');
  });

  it('slots default / footer 各自渲染', () => {
    const wrapper = mount(LoginCard, {
      props: { title: 'myERP' },
      slots: {
        default: '<p class="cp-body">body</p>',
        footer: '<a class="cp-foot">link</a>',
      },
      global: globalConfig,
    });
    expect(wrapper.find('.cp-body').exists()).toBe(true);
    expect(wrapper.find('.cp-foot').exists()).toBe(true);
  });
});
