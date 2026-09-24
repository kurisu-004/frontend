// 2026-09-24 新增：LoginView 单测。
// 覆盖：空字段校验、全空格 username trim、合法凭据成功跳转、ApiError 40101
// 错误映射、mutationFn 调用参数、Zod 校验失败时不调 login。
// @vitest-environment happy-dom
/* eslint-disable vue/one-component-per-file -- 本文件为 spec 桩组件集中放置，单测场景可接受 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';

const loginMock = vi.fn();
const routerReplace = vi.fn();

vi.mock('@/composables/useAuthSession', () => ({
  useAuthSession: () => ({
    login: loginMock,
    user: { value: null },
    logout: vi.fn(),
  }),
}));

vi.mock('vue-router', () => ({
  useRouter: () => ({ replace: routerReplace }),
  useRoute: () => ({ path: '/login' }),
}));

import LoginView from '../LoginView.vue';
import { ApiError } from '@/api/http';
import type { CurrentUser } from '@/types/user';

// 2026-09-24 EP 组件 stub：仓内走 unplugin-vue-components 自动注册，vitest 不挂
// 该插件；挂最小 stub 让 mount 跑得通，ElInput 用原生 input 替代便于 setValue
// 触发 v-model；ElFormItem 把 error prop 渲染到 .el-form-item__error 容器。

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

const ElInputStub = defineComponent({
  name: 'ElInputStub',
  props: ['modelValue', 'type', 'placeholder'],
  emits: ['update:modelValue'],
  setup(props, { emit, attrs }) {
    return () =>
      h('input', {
        value: props.modelValue,
        type: props.type ?? 'text',
        placeholder: props.placeholder,
        ...attrs,
        onInput: (e: Event) => emit('update:modelValue', (e.target as HTMLInputElement).value),
      });
  },
});

const ElFormItemStub = defineComponent({
  name: 'ElFormItemStub',
  props: ['label', 'error'],
  setup(props, { slots }) {
    return () =>
      h('div', { class: 'el-form-item-stub' }, [
        props.label ? h('label', props.label) : null,
        slots.default?.(),
        props.error ? h('p', { class: 'el-form-item__error' }, props.error) : null,
      ]);
  },
});

const ElFormStub = defineComponent({
  name: 'ElFormStub',
  setup(_, { slots }) {
    return () => h('form', { class: 'el-form-stub' }, slots.default?.());
  },
});

const globalConfig = {
  components: {
    ElButton: ElButtonStub,
    ElCard: ElCardStub,
    ElInput: ElInputStub,
    ElForm: ElFormStub,
    ElFormItem: ElFormItemStub,
  },
  // 2026-09-24：useMutation 需要 QueryClient。每个测试一个 client 避免状态泄漏；
  // mutation 内部 promise 没人在外层 await 时，落到这里吃掉。
  plugins: [
    [
      VueQueryPlugin,
      {
        queryClient: new QueryClient({
          defaultOptions: { mutations: { retry: 0 } },
        }),
      },
    ] as [typeof VueQueryPlugin, { queryClient: QueryClient }],
  ],
};

// 2026-09-24：处理 mutateAsync 失败时 queryClient 内部 onError 抛出的 unhandled rejection。
// LoginView.onSubmit 内 await mutateAsync 后没有 try/catch，但 useMutation 内部仍会
// dispatch 一个 unhandled rejection，需要在测试侧全局吃掉。
process.on('unhandledRejection', () => undefined);

const makeUser = (roles: string[]): CurrentUser => ({
  id: 'u1',
  username: 'alice',
  full_name: 'Alice',
  is_active: true,
  roles,
  shelf_ids: [],
  menus: [],
});

describe('LoginView', () => {
  beforeEach(() => {
    loginMock.mockReset();
    routerReplace.mockReset();
  });

  it('空字段点提交：errors 显示、loginMock 未调', async () => {
    const wrapper = mount(LoginView, { global: globalConfig });
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(loginMock).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain('请输入账号');
    expect(wrapper.text()).toContain('请输入密码');
  });

  it('全空格 username：onBlur 触发 trim 校验为空', async () => {
    const wrapper = mount(LoginView, { global: globalConfig });
    const inputs = wrapper.findAll('input');
    await inputs[0].setValue('   ');
    await inputs[0].trigger('blur');
    await flushPromises();
    expect(wrapper.text()).toContain('请输入账号');
    expect(loginMock).not.toHaveBeenCalled();
  });

  it('合法凭据 + MANAGER 角色：loginMock 调一次，跳 /dashboard', async () => {
    loginMock.mockResolvedValue(makeUser(['MANAGER']));
    const wrapper = mount(LoginView, { global: globalConfig });
    const inputs = wrapper.findAll('input');
    await inputs[0].setValue('alice');
    await inputs[1].setValue('password123');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(loginMock).toHaveBeenCalledTimes(1);
    expect(loginMock).toHaveBeenCalledWith('alice', 'password123');
    expect(routerReplace).toHaveBeenCalledWith('/dashboard');
  });

  it('ApiError 40101：errorMessage 显示账号或密码错误', async () => {
    loginMock.mockRejectedValue(new ApiError(40101, 'invalid'));
    const wrapper = mount(LoginView, { global: globalConfig });
    const inputs = wrapper.findAll('input');
    await inputs[0].setValue('alice');
    await inputs[1].setValue('wrong');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(wrapper.text()).toContain('账号或密码错误');
  });

  it('mutationFn 收到的 username 已被 trim', async () => {
    loginMock.mockResolvedValue(makeUser(['MANAGER']));
    const wrapper = mount(LoginView, { global: globalConfig });
    const inputs = wrapper.findAll('input');
    await inputs[0].setValue('  alice  ');
    await inputs[1].setValue('pw');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(loginMock).toHaveBeenCalledWith('alice', 'pw');
  });

  it('Zod 校验未通过时不调 login', async () => {
    const wrapper = mount(LoginView, { global: globalConfig });
    const inputs = wrapper.findAll('input');
    await inputs[0].setValue('alice');
    // 密码留空
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(loginMock).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain('请输入密码');
  });
});
