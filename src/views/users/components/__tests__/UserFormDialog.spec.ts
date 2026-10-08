// @vitest-environment happy-dom
// src/views/users/components/__tests__/UserFormDialog.spec.ts
//
// 2026-10-10 新增：账号表单对话框（新增 / 编辑合一）的**渲染 / 交互契约**回归守卫。
// 四组用例：
//
//  1. **Zod 校验**：空用户名 / 全空格 → 用户名字段挂红字且不发写请求；填全后保存调
//     `createUser`（编辑态走 `updateUser` 且必带 `version`）。
//  2. **关窗再开窗必清字段报错**（2026-10-10 review 第 1 轮的重要项）：`errors` 的生命周期
//     跟着组件走，store 的 `resetForm()` 够不到它 ⇒ 保存报错 → 取消 → 再点「新增账号」，
//     空表单上不得还挂着上一次的红色报错。
//  3. **20602 用户名重复**：store 置 `focusUsername` → 用户名字段红字 + 焦点回送。
//  4. **二次提交仍会重新提示**：`submitForm` 入口会复位 `focusUsername`，所以弹窗开着
//     重试时红字不会「粘住」。
//
// 用 EP 模板桩而不是真 EP 组件：被测的是「Zod 报错有没有正确落到字段上、跨开关窗有没有
// 清干净、focus 有没有回送」，不复刻 el-form-item 的内部实现。桩法照
// `views/inspection/__tests__/ScanTreeDialog.spec.ts` 与本目录的 `WxBindDialog.spec.ts`。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, type Directive } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';
import type { UserOutData } from '../../usersSchema';

vi.mock('element-plus', () => ({
  ElMessage: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
  ElMessageBox: { alert: vi.fn(async () => undefined), confirm: vi.fn(async () => undefined) },
}));

const createUserMock = vi.fn();
const updateUserMock = vi.fn();

vi.mock('@/api/iam', () => ({
  listUsers: vi.fn(async () => ({ items: [], total: 0, limit: 20, offset: 0 })),
  createUser: (...args: unknown[]) => createUserMock(...args),
  updateUser: (...args: unknown[]) => updateUserMock(...args),
  deactivateUser: vi.fn(),
  resetUserPassword: vi.fn(),
  listUserRoles: vi.fn(async () => []),
  addUserRole: vi.fn(),
  removeUserRole: vi.fn(),
  getWxIdentity: vi.fn(async () => null),
  bindWxIdentity: vi.fn(),
  unbindWxIdentity: vi.fn(),
}));

vi.mock('@/api/shelves', () => ({
  listShelves: vi.fn(async () => ({ items: [], total: 0, limit: 200, offset: 0 })),
}));

import UserFormDialog from '../UserFormDialog.vue';
import { useUsersListStore } from '../../composables/useUsersListStore';

const ROW: UserOutData = {
  id: '1900000000000000001',
  version: 3,
  username: 'zhangsan',
  full_name: '张三',
  phone: null,
  is_active: true,
  last_login_at: null,
  created_at: '2026-01-01T00:00:00',
  updated_at: '2026-10-01T00:00:00',
  roles: [],
};

// ---------------------------------------------------------------- EP 桩
const MockElDialog = defineComponent({
  name: 'ElDialog',
  props: ['modelValue', 'title'],
  setup(props, { slots }) {
    return () =>
      h('div', { class: 'mock-dialog' }, [
        h('div', { class: 'mock-dialog-title' }, String(props.title ?? '')),
        slots.default?.(),
        slots.footer?.(),
      ]);
  },
});

/** `el-form-item` 桩：`error` prop 直接渲染成可断言的 `.mock-form-error`。 */
const MockElFormItem = defineComponent({
  name: 'ElFormItem',
  props: ['label', 'error'],
  setup(props, { slots }) {
    return () =>
      h('div', { class: 'mock-form-item' }, [
        h('div', { class: 'mock-form-label' }, String(props.label ?? '')),
        slots.default?.(),
        props.error ? h('div', { class: 'mock-form-error' }, String(props.error)) : null,
      ]);
  },
});

const MockElForm = defineComponent({
  name: 'ElForm',
  props: ['model', 'labelWidth'],
  setup(_p, { slots }) {
    return () => h('div', { class: 'mock-form' }, slots.default?.());
  },
});

/** v-model 桩：输入即 emit `update:modelValue`；`focus` 被 expose 出去（组件用模板 ref
 *  调它回送焦点，桩不 expose 会抛 "focus is not a function"）。 */
const MockElInput = defineComponent({
  name: 'ElInput',
  inheritAttrs: false,
  props: ['modelValue', 'placeholder', 'disabled', 'type'],
  emits: ['update:modelValue'],
  setup(props, { emit, expose }) {
    expose({ focus: vi.fn() });
    return () =>
      h('input', {
        class: ['mock-input', `mock-input-${String(props.type ?? 'text')}`],
        'data-placeholder': String(props.placeholder ?? ''),
        'data-disabled': String(Boolean(props.disabled)),
        value: String(props.modelValue ?? ''),
        onInput: (e: Event) => emit('update:modelValue', (e.target as HTMLInputElement).value),
      });
  },
});

const ElButtonStub = defineComponent({
  name: 'ElButton',
  inheritAttrs: false,
  props: ['type', 'loading'],
  setup(props, { slots, attrs }) {
    return () =>
      h(
        'button',
        {
          class: ['mock-button', `mock-button-${String(props.type ?? 'default')}`],
          onClick: () => (attrs.onClick as (() => void) | undefined)?.(),
        },
        slots.default?.(),
      );
  },
});

const loadingDirective: Directive<HTMLElement, unknown> = {
  mounted(el, binding) {
    el.dataset.loading = String(binding.value);
  },
  updated(el, binding) {
    el.dataset.loading = String(binding.value);
  },
};

const globalConfig = {
  directives: { loading: loadingDirective },
  components: {
    'el-dialog': MockElDialog,
    'el-form': MockElForm,
    'el-form-item': MockElFormItem,
    'el-button': ElButtonStub,
    'el-input': MockElInput,
  },
};

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

function mountDialog() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const wrapper = mount(UserFormDialog, {
    global: {
      ...globalConfig,
      plugins: [pinia, [VueQueryPlugin, { queryClient: new QueryClient({ defaultOptions: { queries: { retry: 0 } } }) }]],
    },
  });
  return { wrapper, store: useUsersListStore() };
}

function buttonByText(wrapper: ReturnType<typeof mount>, text: string) {
  return wrapper.findAll('button').find((b) => b.text() === text);
}

/** 当前所有字段红字的文字集合（判「有没有残留报错」用）。 */
function fieldErrors(wrapper: ReturnType<typeof mount>): string[] {
  return wrapper.findAll('.mock-form-error').map((n) => n.text());
}

describe('UserFormDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createUserMock.mockResolvedValue(ROW);
    updateUserMock.mockResolvedValue(ROW);
    try {
      localStorage.clear();
    } catch {
      /* node 环境不可用时忽略 */
    }
  });

  // ============ Zod 校验 ============
  it('空表单保存：用户名字段挂红字且不发写请求', async () => {
    const { wrapper, store } = mountDialog();
    store.dialogs.form.openCreate();
    await flushPromises();

    await buttonByText(wrapper, '保存')?.trigger('click');
    await flushPromises();

    expect(fieldErrors(wrapper)).toEqual(['请输入用户名', '请输入姓名']);
    expect(createUserMock).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('填全后保存调 createUser（编辑态走 updateUser 且必带 version）', async () => {
    const { wrapper, store } = mountDialog();
    store.dialogs.form.openCreate();
    await flushPromises();

    await wrapper.findAll('input')[0]?.setValue('lisi');
    await wrapper.findAll('input')[1]?.setValue('李四');
    await flushPromises();

    await buttonByText(wrapper, '保存')?.trigger('click');
    await flushPromises();
    await tick();

    expect(createUserMock).toHaveBeenCalledTimes(1);
    expect(createUserMock.mock.calls[0]?.[0]).toMatchObject({
      username: 'lisi',
      full_name: '李四',
    });
    // 成功后弹窗关闭。
    expect(store.dialogs.form.visible).toBe(false);

    // 编辑态：用户名禁用、payload 带 version。
    const edit = mountDialog();
    edit.store.dialogs.form.openEdit(ROW);
    await flushPromises();
    await buttonByText(edit.wrapper, '保存')?.trigger('click');
    await flushPromises();
    await tick();
    expect(updateUserMock).toHaveBeenCalledWith(ROW.id, { version: 3, full_name: '张三' });

    wrapper.unmount();
    edit.wrapper.unmount();
  });

  // ============ 重要项：关窗再开窗必清字段报错 ============
  it('保存报错 → 取消 → 再开窗：上一轮的红字不得残留（空表单上也不许挂）', async () => {
    const { wrapper, store } = mountDialog();
    store.dialogs.form.openCreate();
    await flushPromises();

    await buttonByText(wrapper, '保存')?.trigger('click');
    await flushPromises();
    expect(fieldErrors(wrapper)).toHaveLength(2);

    // 取消关窗。
    await buttonByText(wrapper, '取消')?.trigger('click');
    await flushPromises();
    expect(store.dialogs.form.visible).toBe(false);

    // 再点「新增账号」：表单是空的（store 的 resetForm 清了字段），红字也必须一起清。
    store.dialogs.form.openCreate();
    await flushPromises();
    expect(store.dialogs.form.form.username).toBe('');
    expect(fieldErrors(wrapper)).toEqual([]);
    wrapper.unmount();
  });

  // ============ 20602 用户名重复 ============
  it('20602：用户名字段红字 + 焦点回送；二次提交又撞 20602 时红字仍会重新出现', async () => {
    const { ElMessage } = await import('element-plus');
    createUserMock.mockRejectedValue(Object.assign(new Error('用户名已存在'), { code: 20602 }));
    const { wrapper, store } = mountDialog();
    store.dialogs.form.openCreate();
    await flushPromises();

    await wrapper.findAll('input')[0]?.setValue('zhangsan');
    await wrapper.findAll('input')[1]?.setValue('张三');
    await flushPromises();
    await buttonByText(wrapper, '保存')?.trigger('click');
    await flushPromises();
    await tick();

    expect(ElMessage.error).toHaveBeenCalledWith('用户名已存在');
    expect(fieldErrors(wrapper)).toEqual(['用户名已存在']);
    // 后端拒 ⇒ 弹窗保持开着，用户改完直接重试。
    expect(store.dialogs.form.visible).toBe(true);

    // 改完用户名二次提交，又撞 20602 ⇒ 红字**必须**重新出现（标志已在 submitForm 入口复位）。
    await wrapper.findAll('input')[0]?.setValue('zhangsan2');
    await flushPromises();
    await buttonByText(wrapper, '保存')?.trigger('click');
    await flushPromises();
    await tick();

    expect(createUserMock).toHaveBeenCalledTimes(2);
    expect(fieldErrors(wrapper)).toEqual(['用户名已存在']);
    wrapper.unmount();
  });

  it('编辑态：用户名输入框禁用（后端不允许改用户名）', async () => {
    const { wrapper, store } = mountDialog();
    store.dialogs.form.openEdit(ROW);
    await flushPromises();

    expect(wrapper.find('.mock-dialog-title').text()).toBe('编辑账号');
    expect(wrapper.findAll('input')[0]?.attributes('data-disabled')).toBe('true');
    wrapper.unmount();
  });
});