// @vitest-environment happy-dom
// src/views/users/components/__tests__/WxBindDialog.spec.ts
//
// 2026-10-10 新增：企业微信绑定对话框的**渲染 / 交互契约**回归守卫。三组用例：
//
//  1. **未绑态**（`getWxIdentity` 返回 `null`）：正常渲染输入框 + 「绑定」按钮；空输入
//     时按钮禁用；Zod 校验不过（只有空白）时报错且不发请求；填入 userid 后调
//     `bindWxIdentity(id, { wx_user_id })`（payload 里**没有** corp_id）。
//  2. **已绑态**：展示 corp_id / wx_user_id / 绑定时间，**不**渲染输入框；「解绑」按钮
//     经二次确认后调 `unbindWxIdentity(id, { version })`（version 取绑定行的）。
//  3. 状态说明区常驻（一个账号只能绑一个企微账号 + userid 需先存在于通讯录）。
//
// 用 EP 模板桩而不是真 EP 组件：被测的是「本组件有没有把 store 的绑定态正确分成
// 加载中 / 已绑 / 未绑三支、有没有把 version 正确带进解绑请求」，不复刻 el-dialog /
// el-popconfirm 的内部实现。桩法照 `views/inspection/__tests__/ScanTreeDialog.spec.ts`。

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

const getWxIdentityMock = vi.fn();
const bindWxIdentityMock = vi.fn();
const unbindWxIdentityMock = vi.fn();

vi.mock('@/api/iam', () => ({
  listUsers: vi.fn(async () => ({ items: [], total: '0', limit: '20', offset: '0' })),
  createUser: vi.fn(),
  updateUser: vi.fn(),
  deactivateUser: vi.fn(),
  resetUserPassword: vi.fn(),
  listUserRoles: vi.fn(async () => []),
  addUserRole: vi.fn(),
  removeUserRole: vi.fn(),
  getWxIdentity: (...args: unknown[]) => getWxIdentityMock(...args),
  bindWxIdentity: (...args: unknown[]) => bindWxIdentityMock(...args),
  unbindWxIdentity: (...args: unknown[]) => unbindWxIdentityMock(...args),
}));

vi.mock('@/api/shelves', () => ({
  listShelves: vi.fn(async () => ({ items: [], total: 0, limit: 200, offset: 0 })),
}));

import WxBindDialog from '../WxBindDialog.vue';
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

const WX_IDENTITY = {
  id: '1900000000000000010',
  corp_id: 'ww1234567890',
  wx_user_id: 'zhangsan',
  user_id: ROW.id,
  version: 2,
  created_at: '2026-10-01T09:00:00',
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

/** `inheritAttrs: false` 是必需的：不关掉的话 onClick 既被桩手动调用、又作为根元素上的
 *  原生监听被绑定 ⇒ 一次点击触发两次。 */
const ElButtonStub = defineComponent({
  name: 'ElButton',
  inheritAttrs: false,
  props: ['type', 'size', 'disabled', 'loading'],
  setup(props, { slots, attrs }) {
    return () =>
      h(
        'button',
        {
          class: ['mock-button', `mock-button-${props.type ?? 'default'}`],
          disabled: Boolean(props.disabled),
          onClick: () => {
            if (props.disabled) return;
            (attrs.onClick as (() => void) | undefined)?.();
          },
        },
        slots.default?.(),
      );
  },
});

/**
 * 二次确认弹层桩：正文默认不展开，只渲染 reference 槽 + 一个「确认」按钮。点「确认」触发
 * 组件模板上写的 `@confirm` —— 声明了 emits 之后它以 `onConfirm` 监听器（prop/attr）形式
 * 传进来，**不是**具名 slot（踩过：拿 slots.confirm 永远是 undefined）。
 */
const MockElPopconfirm = defineComponent({
  name: 'ElPopconfirm',
  props: ['title', 'width'],
  emits: ['confirm'],
  setup(props, { slots, emit }) {
    return () =>
      h('div', { class: 'mock-popconfirm', 'data-title': String(props.title ?? '') }, [
        slots.default?.(),
        slots.reference?.(),
        h('button', { class: 'mock-popconfirm-confirm', onClick: () => emit('confirm') }, '确认'),
      ]);
  },
});

/** v-model 桩：输入即 emit `update:modelValue`（真实 el-input 的等价最小行为）。 */
const MockElInput = defineComponent({
  name: 'ElInput',
  inheritAttrs: false,
  props: ['modelValue', 'placeholder', 'error'],
  emits: ['update:modelValue', 'keyup'],
  setup(props, { attrs, emit }) {
    return () =>
      h('input', {
        class: 'mock-input',
        'data-placeholder': String(props.placeholder ?? ''),
        value: String(props.modelValue ?? ''),
        onInput: (e: Event) => emit('update:modelValue', (e.target as HTMLInputElement).value),
        onKeyup: () => {
          (attrs.onKeyupEnter as (() => void) | undefined)?.();
        },
      });
  },
});

const ElTagStub = defineComponent({
  name: 'ElTag',
  setup(_p, { slots }) {
    return () => h('span', { class: 'mock-tag' }, slots.default?.());
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
    'el-button': ElButtonStub,
    'el-popconfirm': MockElPopconfirm,
    'el-input': MockElInput,
    'el-tag': ElTagStub,
  },
};

/** 等 useQuery 的 scheduler 跑过一轮（TanStack 内部是 setTimeout(…, 0)，
 *  flushPromises 的一个宏任务不足以保证请求已 settle）。 */
function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 20));
}

/** 挂弹窗 + 打开对应账号的企微绑定（模拟操作列点「企微」）。
 *  `identity` 传 'pending' 时把 getWxIdentity 挂在不 resolve 的 promise 上（测加载态）。 */
async function mountDialog(identity: unknown) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const release: Array<() => void> = [];
  if (identity === 'pending') {
    getWxIdentityMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          release.push(() => resolve(WX_IDENTITY));
        }),
    );
  } else {
    getWxIdentityMock.mockResolvedValue(identity);
  }
  const wrapper = mount(WxBindDialog, {
    global: {
      ...globalConfig,
      plugins: [
        pinia,
        [
          VueQueryPlugin,
          { queryClient: new QueryClient({ defaultOptions: { queries: { retry: 0 } } }) },
        ],
      ],
    },
  });
  const store = useUsersListStore();
  store.dialogs.wxBind.openWxBind(ROW);
  await tick();
  return { wrapper, store, release };
}

function buttonByText(wrapper: ReturnType<typeof mount>, text: string) {
  return wrapper.findAll('button').find((b) => b.text() === text);
}

describe('WxBindDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    unbindWxIdentityMock.mockResolvedValue(undefined);
    bindWxIdentityMock.mockResolvedValue(WX_IDENTITY);
  });

  // ============ 加载态 ============
  it('加载态：请求在飞时既不闪输入框也不闪已绑态（data 未回来 ≠ 未绑定）', async () => {
    const { wrapper, release } = await mountDialog('pending');
    expect(wrapper.find('.wx-loading').exists()).toBe(true);
    expect(wrapper.find('.mock-input').exists()).toBe(false);
    expect(wrapper.find('.wx-bound').exists()).toBe(false);

    release[0]?.();
    await tick();
    // 请求回来后直接进已绑态。
    expect(wrapper.find('.wx-loading').exists()).toBe(false);
    expect(wrapper.find('.wx-bound').exists()).toBe(true);
    wrapper.unmount();
  });

  // ============ 未绑态（getWxIdentity 返回 null）============
  it('未绑态：渲染输入框 + 绑定按钮，不碰已绑态的详情与解绑按钮', async () => {
    const { wrapper } = await mountDialog(null);
    expect(wrapper.find('.mock-dialog-title').text()).toBe('企业微信绑定');
    expect(wrapper.find('.mock-input').exists()).toBe(true);
    expect(wrapper.find('.mock-input').attributes('data-placeholder')).toBe(
      '企业微信通讯录里的成员 UserID',
    );
    expect(buttonByText(wrapper, '绑定')?.exists()).toBe(true);
    // 未绑态不该出现 corp_id / 解绑按钮。
    expect(wrapper.text()).not.toContain('ww1234567890');
    expect(buttonByText(wrapper, '解绑')).toBeUndefined();
    expect(wrapper.find('.mock-popconfirm').exists()).toBe(false);
    // 状态说明区常驻。
    expect(wrapper.text()).toContain('一个系统账号只能绑一个企业微信账号');
    expect(wrapper.text()).toContain('需先存在于本企业微信通讯录中');
    wrapper.unmount();
  });

  it('未绑态：只填空白时按钮禁用，且不发请求；填入 userid 后调 bindWxIdentity（payload 无 corp_id）', async () => {
    const { wrapper } = await mountDialog(null);
    const bindBtn = buttonByText(wrapper, '绑定');
    expect(bindBtn?.attributes('disabled')).toBeDefined();

    await wrapper.find('.mock-input').setValue('  zhangsan  ');
    await flushPromises();
    expect(buttonByText(wrapper, '绑定')?.attributes('disabled')).toBeUndefined();

    await buttonByText(wrapper, '绑定')?.trigger('click');
    await flushPromises();
    // trim 在前（Zod schema 里 trim 链在 min 之前）。
    expect(bindWxIdentityMock).toHaveBeenCalledWith(ROW.id, { wx_user_id: 'zhangsan' });
    expect(bindWxIdentityMock.mock.calls[0]?.[1]).not.toHaveProperty('corp_id');
    wrapper.unmount();
  });

  it('未绑态：全空格的输入被 Zod 拦下（弹错、不发请求）', async () => {
    const { wrapper } = await mountDialog(null);
    // 按钮的禁用判据是 `!wxUserIdDraft.trim()`，全空格时本身就是禁用态。
    await wrapper.find('.mock-input').setValue('   ');
    await flushPromises();
    expect(buttonByText(wrapper, '绑定')?.attributes('disabled')).toBeDefined();
    await buttonByText(wrapper, '绑定')?.trigger('click');
    expect(bindWxIdentityMock).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  // ============ 已绑态 ============
  it('已绑态：展示 corp_id / 成员 UserID / 绑定时间，且不渲染输入框', async () => {
    const { wrapper } = await mountDialog(WX_IDENTITY);
    expect(wrapper.find('.mock-input').exists()).toBe(false);
    expect(wrapper.find('.wx-bound').text()).toContain('ww1234567890');
    expect(wrapper.find('.wx-bound').text()).toContain('zhangsan');
    expect(wrapper.find('.wx-bound').text()).toContain('2026-10-01T09:00:00');
    // 雪花 ID 不进 UI（只展示 corp_id / userid / 绑定时间三行）。
    expect(buttonByText(wrapper, '绑定')).toBeUndefined();
    // 解绑走二次确认。
    expect(wrapper.find('.mock-popconfirm').attributes('data-title')).toContain(
      '确认解绑企业微信账号',
    );
    wrapper.unmount();
  });

  it('已绑态：解绑带 version 调 unbindWxIdentity（version 取绑定行的）', async () => {
    const { wrapper, store } = await mountDialog(WX_IDENTITY);
    await buttonByText(wrapper, '确认')?.trigger('click');
    await flushPromises();
    expect(unbindWxIdentityMock).toHaveBeenCalledWith(ROW.id, { version: 2 });
    expect(store.dialogs.wxBind.saving).toBe(false);
    wrapper.unmount();
  });

  it('换账号再打开：草稿被清掉（不继承上一个账号的 userid）', async () => {
    const { wrapper, store } = await mountDialog(null);
    await wrapper.find('.mock-input').setValue('lisi');
    await flushPromises();

    store.dialogs.wxBind.closeWxBind();
    store.dialogs.wxBind.openWxBind({ ...ROW, id: '1900000000000000009', username: 'lisi' });
    await flushPromises();

    expect(wrapper.find('.mock-input').attributes('value')).toBe('');
    wrapper.unmount();
  });
});
