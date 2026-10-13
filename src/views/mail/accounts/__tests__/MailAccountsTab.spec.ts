// @vitest-environment happy-dom
// src/views/mail/accounts/__tests__/MailAccountsTab.spec.ts
//
// 2026-10-16 新建：页面壳 `MailAccountsTab.vue` 的**接线守卫**，只守三组：
//
//  1. **「零个默认」提示条的显隐**：有邮箱但一条默认都没有 ⇒ 出；任一条已默认 ⇒ 不出；
//     一条邮箱都没有 ⇒ 也不出（空表上挂一条「你没有默认邮箱」的警告是噪音，那页有专门的空态）。
//  2. **⚠️ 提示文案里没有「设默认 → 才能发信」这类承诺（文案回归）**。后端对 `is_default`
//     的全部消费只有列表排序（`ORDER BY is_default DESC`）与那条「至多一条为 true」的唯一
//     索引，发信只读 `mail_digest_config.sender_account_id`
//     （`mail_digest::service::resolve_sender`，`NULL` 直接 21701）。文案一旦写成「点「设为
//     默认」…才能用它发信」，用户就会照做、再回交期汇总仍发不出去 —— 那正是
//     `MailDigestSettings.spec.ts` 与 `MailScheduleSection.spec.ts`（S5）守的同一类假承诺。
//  3. 提示文案里不出现任何 SMTP 环境变量名（SMTP 已改成页面内配置，见 mailDigest 域那条）。
//
// ⚠️ **`el-alert` 桩必须渲染 `description`**（本文件的核心前提）：提示正文**就在 description
// 里**，title 只是小标题。桩只渲染 title 时，下面第 2 组断言读到的 `.mock-alert` 文本是空的
// —— 全绿、却一个字都没验。`MailDigestSettings.spec.ts` 初版与
// `MailScheduleSection.spec.ts`（本轮之前）都栽过这个坑，两处已修，这里也不许留。
//
// 表格部分（行内按钮、`deletingRowId` / `settingDefaultRowId` 的 loading 落点）不在本 spec：
// `el-table` 的列插槽要复刻 EP 的行作用域上下文，性价比极低；那部分由
// `useMailAccountsStore.spec.ts` 的 W3b / W2b 在 store 层守。
//
// 桩法照 `views/mail/digest/__tests__/MailScheduleSection.spec.ts` 与
// `views/mail/digest/__tests__/MailDigestSettings.spec.ts`。pinia 先、VueQueryPlugin 后
// （store setup 首行 `useQueryClient()`）。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, type Directive } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { createApp } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';

vi.mock('element-plus', () => ({
  ElMessage: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

const listMailAccountsMock = vi.fn();
const fetchMailMetaMock = vi.fn();

vi.mock('@/api/mailAccounts', () => ({
  listMailAccounts: (...args: unknown[]) => listMailAccountsMock(...args),
  fetchMailMeta: (...args: unknown[]) => fetchMailMetaMock(...args),
  createMailAccount: vi.fn(),
  updateMailAccount: vi.fn(),
  deleteMailAccount: vi.fn(),
  setDefaultMailAccount: vi.fn(),
}));

import MailAccountsTab from '../MailAccountsTab.vue';
import type { MailAccountData } from '../mailAccountSchema';

// ---------------------------------------------------------------- 桩
const loadingDirective: Directive<HTMLElement, unknown> = {
  mounted(el, binding) {
    el.dataset.loading = String(binding.value);
  },
  updated(el, binding) {
    el.dataset.loading = String(binding.value);
  },
};

/** ⚠️ `description` 与 `title` **都**渲染（理由见文件头）。 */
const ElAlertStub = defineComponent({
  name: 'ElAlert',
  props: ['title', 'description', 'type'],
  setup(props, { slots }) {
    return () =>
      h('div', { class: ['mock-alert', `mock-alert-${props.type}`] }, [
        h('span', { class: 'alert-title' }, String(props.title ?? '')),
        h('span', { class: 'alert-description' }, String(props.description ?? '')),
        slots.default?.(),
      ]);
  },
});

const passthrough = (name: string, tag: string) =>
  defineComponent({
    name,
    setup(_p, { slots }) {
      return () => h(tag, slots.default?.());
    },
  });

/** `el-table` / `el-table-column` / `el-popconfirm` 只留形状不渲染内容（本 spec 不测表格）。 */
const ElTableStub = defineComponent({
  name: 'ElTable',
  props: ['data'],
  setup: () => () => h('div'),
});
const ElTableColumnStub = defineComponent({ name: 'ElTableColumn', setup: () => () => h('div') });
const ElPopconfirmStub = defineComponent({
  name: 'ElPopconfirm',
  setup(_p, { slots }) {
    return () => h('div', [slots.reference?.()]);
  },
});
const ElEmptyStub = defineComponent({
  name: 'ElEmpty',
  props: ['description'],
  setup(props) {
    return () => h('div', { class: 'mock-empty' }, String(props.description ?? ''));
  },
});

const globalConfig = {
  components: {
    'el-alert': ElAlertStub,
    'el-card': passthrough('ElCard', 'div'),
    'el-button': passthrough('ElButton', 'button'),
    'el-icon': passthrough('ElIcon', 'span'),
    'el-table': ElTableStub,
    'el-table-column': ElTableColumnStub,
    'el-popconfirm': ElPopconfirmStub,
    'el-empty': ElEmptyStub,
  },
  directives: { loading: loadingDirective },
};

// ---------------------------------------------------------------- fixture
function account(over: Partial<MailAccountData> = {}): MailAccountData {
  return {
    id: '9000000000000902',
    version: 1,
    name: '采购部邮箱',
    preset: 'NET_EASE_163',
    preset_label: '网易 163',
    account: 'purchase@example.com',
    host: 'smtp.163.com',
    port: 465,
    tls_mode: 'WRAPPED',
    is_default: false,
    created_at: '2026-10-16 08:00:00',
    updated_at: '2026-10-16 08:00:00',
    ...over,
  };
}

const META = {
  presets: [
    {
      value: 'NET_EASE_163',
      label: '网易 163',
      host: 'smtp.163.com',
      port: 465,
      tls_mode: 'WRAPPED',
    },
  ],
};

/** 起 pinia + vue-query 环境，再挂壳（`onMounted` 里 store 才开闸取数）。 */
async function mountTab(items: readonly MailAccountData[]) {
  listMailAccountsMock.mockResolvedValue({ items });
  fetchMailMetaMock.mockResolvedValue(META);

  const app = createApp({});
  app.use(createPinia());
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: 0 }, mutations: { retry: 0 } },
  });
  app.use(VueQueryPlugin, { queryClient });
  setActivePinia(app.config.globalProperties.$pinia);

  const wrapper = mount(MailAccountsTab, {
    global: { ...globalConfig, stubs: { MailAccountDialog: true } },
  });
  await flushPromises();
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------- 用例
describe('MailAccountsTab — 「零个默认」提示条的显隐', () => {
  it('H0：有邮箱但一条默认都没有 ⇒ 出提示条', async () => {
    const wrapper = await mountTab([account(), account({ id: '9000000000000903' })]);
    expect(wrapper.find('.mock-alert').exists()).toBe(true);
    wrapper.unmount();
  });

  it('H0b：任一条已是默认 ⇒ 不出提示条', async () => {
    const wrapper = await mountTab([account({ is_default: true }), account()]);
    expect(wrapper.find('.mock-alert').exists()).toBe(false);
    wrapper.unmount();
  });

  it('H0c：一条邮箱都没有 ⇒ 不出提示条（空态另有 el-empty，不挂警告）', async () => {
    const wrapper = await mountTab([]);
    expect(wrapper.find('.mock-alert').exists()).toBe(false);
    expect(wrapper.find('.mock-empty').exists()).toBe(true);
    wrapper.unmount();
  });
});

describe('MailAccountsTab — 提示文案**不承诺**「设为默认就能发信」（2026-10-16 文案回归）', () => {
  /** 取提示条的 title + description（两条都渲染，见文件头）。中间插 `|` 当分隔，
   *  免得「上一句的字」与「下一句的字」凑成一句假承诺。 */
  async function hintText(items: readonly MailAccountData[]): Promise<string> {
    const wrapper = await mountTab(items);
    const alert = wrapper.find('.mock-alert');
    expect(alert.exists()).toBe(true);
    const text = `${alert.find('.alert-title').text()}|${alert.find('.alert-description').text()}`;
    wrapper.unmount();
    return text;
  }

  it('H1：不出现「点「设为默认」→ 才能 / 就能 / 即可发信」这类承诺', async () => {
    // 曾经写的是「在下方点「设为默认」选定一条后，交期汇总才能用它发信」——
    // `is_default` 在后端只被列表排序与唯一索引消费，发信走
    // `mail_digest_config.sender_account_id`，照着做仍然发不出去（`senderMissing` 置灰
    // 「立即发送」或吃 21701）。同类断言见 `MailDigestSettings.spec.ts` 与
    // `MailScheduleSection.spec.ts` 的 S5。
    const text = await hintText([account()]);
    expect(text).not.toMatch(/设为默认[^|]{0,40}(才能|就能|即可)/);
  });

  it('H1b：文案里不出现「默认发信邮箱」这个说法（把 is_default 说成发信通道本身就是错的）', async () => {
    const text = await hintText([account()]);
    expect(text).not.toContain('默认发信邮箱');
  });

  it('H1c：如实陈述 `is_default` 的真实语义（只影响排序），并指路到真正决定发信的地方', async () => {
    const text = await hintText([account()]);
    expect(text).toContain('排序');
    expect(text).toContain('「发信邮箱」');
    expect(text).toContain('交期汇总');
  });

  it('H2：文案里不出现任何 SMTP 环境变量名（SMTP 已改成页面内配置）', async () => {
    const text = await hintText([account()]);
    expect(text).not.toMatch(/MAIL_SMTP|SMTP_HOST|SMTP_PORT|USERNAME|PASSWORD/);
  });
});
