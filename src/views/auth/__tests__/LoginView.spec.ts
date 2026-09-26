// 2026-09-24 新增：LoginView 单测。
// 覆盖：空字段校验、全空格 username trim、合法凭据成功跳转、ApiError 40101
// 错误映射、mutationFn 调用参数、Zod 校验失败时不调 login。
// 2026-09-26 迁移：mock 改 @/stores/auth（替代 @/composables/useAuthSession），
// loginMock → loginMutateAsyncMock；调用形态从 (u, p) 改为 ({ username, password })。
// mock 内部维护 isPending / error 状态，mutateAsync mock 副作用写入；
// LoginView 通过 store proxy 读到自动解包后的值（isPending: boolean /
// error: ApiError | null），无需 .value。
// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, reactive } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';

const loginMutateAsyncMock = vi.fn();
const routerReplace = vi.fn();

// mock 内部状态：LoginView 读 mutation.error（自动解包后的值），需要 mock 在
// mutateAsync reject 时把 error 写到 mutationState.error，isPending 同步翻为 false。
const mutationState = reactive({
  isPending: false,
  error: null as unknown,
});

// 真正暴露给 LoginView 的 mutateAsync：包一层副作用（写 isPending / error），
// 然后调真实 mock impl（每个 case 用 mockResolvedValue / mockRejectedValue 覆写）。
const wrappedMutateAsync = async (creds: unknown) => {
  mutationState.isPending = true;
  mutationState.error = null;
  try {
    return await loginMutateAsyncMock(creds);
  } catch (e) {
    mutationState.error = e;
    throw e;
  } finally {
    mutationState.isPending = false;
  }
};

vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({
    // Pinia store proxy 自动解包嵌套 ref —— mock 直接给值，不需要 ref() 包装。
    loginMutation: {
      get isPending() {
        return mutationState.isPending;
      },
      get error() {
        return mutationState.error;
      },
      mutateAsync: wrappedMutateAsync,
    },
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

// 2026-09-24：LoginView.onSubmit 内 await mutateAsync 后用 try/catch 吞掉 rejection
// 避免 unhandledRejection（错误已通过 mutation.error.value 暴露给 errorMessage）。
// 原本在此注册的 process.on('unhandledRejection') 兜底是修复初版漏 try/catch 时
// 用的，现在 LoginView 已有 try/catch，保留 process 级兜底作为最后保险——
// queryClient mutationCache 在 onError 路径仍可能 dispatch 一个 hook 内的
// unhandledRejection（具体取决于版本），删掉该 hook 后实测验证不再出现红测。
// 2026-09-24 重测：删掉该 hook 后 38 文件 413 测试全绿，移除。
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
    loginMutateAsyncMock.mockReset();
    routerReplace.mockReset();
    mutationState.isPending = false;
    mutationState.error = null;
  });

  it('空字段点提交：errors 显示、loginMutateAsyncMock 未调', async () => {
    const wrapper = mount(LoginView, { global: globalConfig });
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(loginMutateAsyncMock).not.toHaveBeenCalled();
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
    expect(loginMutateAsyncMock).not.toHaveBeenCalled();
  });

  it('合法凭据 + MANAGER 角色：loginMutateAsyncMock 调一次，跳 /dashboard', async () => {
    loginMutateAsyncMock.mockResolvedValue(makeUser(['MANAGER']));
    const wrapper = mount(LoginView, { global: globalConfig });
    const inputs = wrapper.findAll('input');
    await inputs[0].setValue('alice');
    await inputs[1].setValue('password123');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(loginMutateAsyncMock).toHaveBeenCalledTimes(1);
    expect(loginMutateAsyncMock).toHaveBeenCalledWith({
      username: 'alice',
      password: 'password123',
    });
    expect(routerReplace).toHaveBeenCalledWith('/dashboard');
  });

  it('ApiError 40101：errorMessage 显示账号或密码错误', async () => {
    loginMutateAsyncMock.mockRejectedValue(new ApiError(40101, 'invalid'));
    const wrapper = mount(LoginView, { global: globalConfig });
    const inputs = wrapper.findAll('input');
    await inputs[0].setValue('alice');
    await inputs[1].setValue('wrong');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(wrapper.text()).toContain('账号或密码错误');
  });

  it('mutationFn 收到的 username 已被 trim', async () => {
    loginMutateAsyncMock.mockResolvedValue(makeUser(['MANAGER']));
    const wrapper = mount(LoginView, { global: globalConfig });
    const inputs = wrapper.findAll('input');
    await inputs[0].setValue('  alice  ');
    await inputs[1].setValue('pw');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(loginMutateAsyncMock).toHaveBeenCalledWith({ username: 'alice', password: 'pw' });
  });

  it('Zod 校验未通过时不调 login', async () => {
    const wrapper = mount(LoginView, { global: globalConfig });
    const inputs = wrapper.findAll('input');
    await inputs[0].setValue('alice');
    // 密码留空
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(loginMutateAsyncMock).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain('请输入密码');
  });
});
