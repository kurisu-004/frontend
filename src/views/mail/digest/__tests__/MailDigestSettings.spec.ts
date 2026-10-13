// @vitest-environment happy-dom
// src/views/mail/digest/__tests__/MailDigestSettings.spec.ts
//
// 2026-10-13 新增：页面壳 `MailDigestSettings.vue` 的**接线守卫**。本页其余部分（store /
// schema / 三个 section）各有自己的 spec，这份只守「壳把它们拼起来的那几根线」：
//
//  1. **v-model 回写**：section emit 出来的整份表单模型真的写回 store 的 `query.form`
//     （壳是唯一接线点，写错的表现是「改了输入框、保存时发的还是旧值」）；
//  2. **发信邮箱状态条**（2026-10-16 取代原「SMTP 状态条」）：一条邮箱都没有 ⇒ 顶部出
//     warning + 「立即发送」禁用；**有邮箱但本条配置没选同样出 warning 且禁用**（后端
//     `resolve_sender` 对 null 直接 21701、没有回落到默认邮箱的分支，而「立即发送」不可
//     撤销）；都正常 ⇒ 不出（邮箱列表还没回来时也不出 —— 否则会先闪一条假告警）；
//  3. **「立即发送」走二次确认**：只有 `el-popconfirm` 的 confirm 才发请求（真发不可撤销，
//     点一下就发是事故）；按钮本身在「发不出信」（无邮箱 / 未选邮箱）时禁用。
//
// section 子组件在本 spec 里用桩替换（VTU 的 `stubs` 优先于 SFC 的局部 import）：
// 被测的是壳的接线，不是三个 section 的内部渲染（那三份各有 spec）。被桩替掉的组件
// 通过 props 把当前的表单模型交出来，壳再通过 emit 把它写回 store。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, type Directive } from 'vue';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';

vi.mock('element-plus', () => ({
  ElMessage: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

const saveMailDigestConfigMock = vi.fn();
const previewMailDigestMock = vi.fn();
const sendMailDigestNowMock = vi.fn();
const fetchMailDigestConfigMock = vi.fn();
const fetchMailDigestMetaMock = vi.fn();
const listMailDigestLogsMock = vi.fn();

// 2026-10-16：邮箱列表（「发信邮箱」下拉的选项来源；与「邮箱设置」tab 共用一条缓存）。
const listMailAccountsMock = vi.fn();

vi.mock('@/api/mailAccounts', () => ({
  fetchMailMeta: vi.fn(),
  listMailAccounts: (...args: unknown[]) => listMailAccountsMock(...args),
}));

vi.mock('@/api/mailDigest', () => ({
  fetchMailDigestConfig: (...args: unknown[]) => fetchMailDigestConfigMock(...args),
  fetchMailDigestMeta: (...args: unknown[]) => fetchMailDigestMetaMock(...args),
  listMailDigestLogs: (...args: unknown[]) => listMailDigestLogsMock(...args),
  saveMailDigestConfig: (...args: unknown[]) => saveMailDigestConfigMock(...args),
  previewMailDigest: (...args: unknown[]) => previewMailDigestMock(...args),
  sendMailDigestNow: (...args: unknown[]) => sendMailDigestNowMock(...args),
}));

import MailDigestSettings from '../MailDigestSettings.vue';
import { useMailDigestStore } from '../composables/useMailDigestStore';

const CONFIG = {
  id: '1900000000000000001',
  version: 3,
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
  sender_account_id: '9000000000000902',
  smtp_configured: true,
  created_at: '2026-10-01 08:00:00',
  updated_at: '2026-10-02 08:00:00',
};

const META = {
  frequencies: [
    {
      value: 'DAILY',
      label: '每天',
      needs_time: true,
      needs_weekday: false,
      needs_day_of_month: false,
    },
    {
      value: 'MANUAL_ONLY',
      label: '仅手动',
      needs_time: false,
      needs_weekday: false,
      needs_day_of_month: false,
    },
  ],
  columns: [{ key: 'part_no', label: '零件号' }],
  // ⚠️ `defaults` 段与 `config` 的**配置字段**同构（少了 id / version / 时间戳 / smtp 标志），
  // 且守门 schema 是 `.strict()`：多塞一个键整个 meta 查询就进 error 态、页面永远拿不到
  // `frequencies` 段（那正是「频率单选组是空的」的成因）。
  // ⚠️ 2026-10-16：`defaults` 里**新增** `sender_account_id`，且 `meta` 顶层**不再有** `smtp`
  // 段 —— 多塞一个键同样会让整个 meta 查询进 error 态。
  defaults: {
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
    subject_template: null,
    sender_account_id: null,
  },
  upcoming_days_range: { min: 1, max: 60 },
};

/** 2026-10-16：SMTP 改由邮箱账号实体承载，本页顶部告警的判据换成下面两条。 */
const ACCOUNTS = [
  {
    id: '9000000000000902',
    version: 1,
    name: '采购部邮箱',
    preset: 'NET_EASE_163',
    preset_label: '网易 163',
    account: 'purchase@example.com',
    host: 'smtp.163.com',
    port: 465,
    tls_mode: 'WRAPPED',
    is_default: true,
    created_at: '2026-10-16 08:00:00',
    updated_at: '2026-10-16 08:00:00',
  },
];

// ---------------------------------------------------------------- 桩
const loadingDirective: Directive<HTMLElement, unknown> = {
  mounted(el, binding) {
    el.dataset.loading = String(binding.value);
  },
  updated(el, binding) {
    el.dataset.loading = String(binding.value);
  },
};

// ⚠️ `description` 也在桩里渲染出来（初版漏了它，于是「告警文案不承诺『不选也能发』」那条
// 文案回归断言是恒真的假绿 —— 真正的文案全在 description 里）。
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

const ElCardStub = defineComponent({
  name: 'ElCard',
  setup(_p, { slots }) {
    return () => h('div', { class: 'mock-card' }, [slots.header?.(), slots.default?.()]);
  },
});

const ElIconStub = defineComponent({
  name: 'ElIcon',
  setup(_p, { slots }) {
    return () => h('span', { class: 'mock-icon' }, slots.default?.());
  },
});

const ElButtonStub = defineComponent({
  name: 'ElButton',
  inheritAttrs: false,
  props: ['type', 'disabled', 'loading'],
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

/** 二次确认弹层桩：渲染 reference 槽 + 一个「确认」按钮（点它才 emit confirm）。 */
const ElPopconfirmStub = defineComponent({
  name: 'ElPopconfirm',
  props: ['title'],
  emits: ['confirm'],
  setup(props, { slots, emit }) {
    return () =>
      h('div', { class: 'mock-popconfirm', 'data-title': String(props.title ?? '') }, [
        slots.reference?.(),
        h('button', { class: 'mock-popconfirm-confirm', onClick: () => emit('confirm') }, '确认'),
      ]);
  },
});

const ElPaginationStub = defineComponent({
  name: 'ElPagination',
  props: ['currentPage', 'pageSize', 'total'],
  emits: ['update:currentPage', 'update:pageSize'],
  setup(props, { emit }) {
    return () =>
      h('div', { class: 'mock-pagination', 'data-total': String(props.total ?? 0) }, [
        h(
          'button',
          {
            class: 'mock-page-next',
            onClick: () => emit('update:currentPage', (props.currentPage ?? 1) + 1),
          },
          '下一页',
        ),
      ]);
  },
});

/** section 桩：把当前表单模型渲染成 data 属性，并提供一个「改收件人」按钮发 emit。 */
function makeSectionStub(name: string) {
  return defineComponent({
    name,
    props: ['modelValue'],
    emits: ['update:modelValue'],
    setup(props, { emit, attrs }) {
      return () =>
        h('div', { class: 'mock-section', 'data-name': name }, [
          h(
            'span',
            { class: 'mock-recipients' },
            JSON.stringify((props.modelValue as { recipients: string[] }).recipients),
          ),
          h(
            'button',
            {
              class: 'mock-edit',
              onClick: () =>
                emit('update:modelValue', {
                  ...(props.modelValue as Record<string, unknown>),
                  recipients: ['edited@example.com'],
                  // 顺带验证壳把 focusField / errors 也透传给了 section
                  ...(attrs as Record<string, unknown>),
                }),
            },
            '改收件人',
          ),
        ]);
    },
  });
}

const globalConfig = {
  directives: { loading: loadingDirective },
  components: {
    'el-alert': ElAlertStub,
    'el-card': ElCardStub,
    'el-icon': ElIconStub,
    'el-button': ElButtonStub,
    'el-popconfirm': ElPopconfirmStub,
    'el-pagination': ElPaginationStub,
  },
  stubs: {
    MailScheduleSection: makeSectionStub('MailScheduleSection'),
    MailRecipientsSection: makeSectionStub('MailRecipientsSection'),
    MailContentSection: makeSectionStub('MailContentSection'),
    MailLogTable: true,
    MailPreviewDialog: true,
  },
};

/** 起一套 pinia + vue-query 环境（顺序硬约束：pinia 先、VueQueryPlugin 后 ——
 *  store setup 首行 `useQueryClient()`）。 */
function setupApp(): { pinia: ReturnType<typeof createPinia>; queryClient: QueryClient } {
  const pinia = createPinia();
  setActivePinia(pinia);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: 0 }, mutations: { retry: 0 } },
  });
  return { pinia, queryClient };
}

function tick(ms = 30): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

let pinia: ReturnType<typeof createPinia>;
let qc: QueryClient;

beforeEach(() => {
  vi.clearAllMocks();
  ({ pinia, queryClient: qc } = setupApp());
  fetchMailDigestConfigMock.mockResolvedValue(CONFIG);
  fetchMailDigestMetaMock.mockResolvedValue(META);
  listMailDigestLogsMock.mockResolvedValue({ items: [], total: 0, limit: 20, offset: 0 });
  listMailAccountsMock.mockResolvedValue({ items: ACCOUNTS });
  saveMailDigestConfigMock.mockResolvedValue(CONFIG);
  previewMailDigestMock.mockResolvedValue({
    subject: 's',
    html: '<p>x</p>',
    overdue_count: 0,
    upcoming_count: 0,
    columns: ['part_no'],
  });
  sendMailDigestNowMock.mockResolvedValue({
    log_id: '1',
    status: 'SUCCESS',
    subject: 's',
    to_recipients: ['a@example.com'],
    overdue_count: 0,
    upcoming_count: 0,
    html_bytes: 1,
    sent_at: '2026-10-13 08:00:00',
    error_message: null,
  });
});

/** 挂壳 + 开闸 + 等三条 query 落地。 */
async function mountPage() {
  const wrapper = mount(MailDigestSettings, {
    global: {
      ...globalConfig,
      plugins: [pinia, [VueQueryPlugin, { queryClient: qc }]],
    },
  });
  const store = useMailDigestStore();
  store.query.openGate();
  await tick();
  return { wrapper, store };
}

describe('MailDigestSettings — section 的 v-model 回写', () => {
  it('section emit 出来的整份模型真的写回 store 的 query.form', async () => {
    const { wrapper, store } = await mountPage();
    expect(store.query.form.recipients).toEqual(['a@example.com']);
    // 桩渲染出的收件人是「store 那份」的快照 ⇒ 证明 props 传对了
    expect(wrapper.findAll('.mock-section')[0]?.find('.mock-recipients').text()).toContain(
      'a@example.com',
    );

    await wrapper.findAll('.mock-edit')[0]?.trigger('click');
    await flushPromises();

    expect(store.query.form.recipients).toEqual(['edited@example.com']);
    expect(store.query.dirty).toBe(true);
    wrapper.unmount();
  });
});

describe('MailDigestSettings — 发信邮箱状态条与「立即发送」（2026-10-16 起）', () => {
  /** 顶部 warning 告警（页面可能同时渲染 error 型的 config 告警，故按 class 筛）。 */
  function warningAlerts(wrapper: VueWrapper) {
    return wrapper.findAll('.mock-alert').filter((n) => n.classes().includes('mock-alert-warning'));
  }

  function sendButton(wrapper: VueWrapper) {
    return wrapper.findAll('.mock-button').find((n) => n.text() === '立即发送');
  }

  it('一条邮箱都没有：出「还没有可用邮箱」告警 + 「立即发送」按钮禁用', async () => {
    listMailAccountsMock.mockResolvedValue({ items: [] });
    const { wrapper } = await mountPage();

    const alerts = warningAlerts(wrapper);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.text()).toContain('还没有可用邮箱');
    expect(sendButton(wrapper)?.attributes('disabled')).toBeDefined();
    wrapper.unmount();
  });

  it('有邮箱但本条配置没选：出「尚未选择发信邮箱」告警，**且禁用**立即发送', async () => {
    // ⚠️ 禁用：后端 `mail_digest::service::resolve_sender` 对 `sender_account_id IS NULL`
    // 直接返 21701（HTTP 503），全仓没有回落到默认邮箱的分支 ⇒ 「不选也能发」是假承诺，
    // 而「立即发送」是真发、不可撤销。
    fetchMailDigestConfigMock.mockResolvedValue({ ...CONFIG, sender_account_id: null });
    const { wrapper } = await mountPage();

    const alerts = warningAlerts(wrapper);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.text()).toContain('尚未选择发信邮箱');
    expect(sendButton(wrapper)?.attributes('disabled')).toBeDefined();
    wrapper.unmount();
  });

  it('⚠️ 顶部告警**不承诺**「不选也能发」（文案回归：后端没有回落默认邮箱的分支）', async () => {
    // 「立即发送」是真发、不可撤销；文案一旦又写成「不选时将由系统使用默认邮箱发送」，
    // 用户就会点一次、确认一次、然后吃一个 21701。下拉的 placeholder 侧由
    // `MailScheduleSection.spec.ts` 的 S5 守。
    fetchMailDigestConfigMock.mockResolvedValue({ ...CONFIG, sender_account_id: null });
    const { wrapper } = await mountPage();

    const text = wrapper
      .findAll('.mock-alert')
      .map((n) => n.text())
      .join('|');
    expect(text).toContain('尚未选择发信邮箱');
    expect(text).not.toMatch(/默认邮箱|不选.{0,8}也能发|回落到默认|使用默认/);
    wrapper.unmount();
  });

  it('已选好发信邮箱：不出告警、按钮可点', async () => {
    const { wrapper } = await mountPage();
    expect(warningAlerts(wrapper)).toHaveLength(0);
    expect(sendButton(wrapper)?.attributes('disabled')).toBeUndefined();
    wrapper.unmount();
  });

  it('告警文案里**不出现任何环境变量名**（SMTP 已改成页面内配置）', async () => {
    listMailAccountsMock.mockResolvedValue({ items: [] });
    const { wrapper } = await mountPage();
    const text = wrapper
      .findAll('.mock-alert')
      .map((n) => n.text())
      .join('|');
    expect(text).not.toMatch(/MAIL_SMTP|SMTP_HOST|SMTP_PORT|USERNAME|PASSWORD/);
    wrapper.unmount();
  });

  it('「立即发送」必须经二次确认才发请求（真发不可撤销）', async () => {
    const { wrapper } = await mountPage();
    // popconfirm 的 title 写明不可撤销
    expect(wrapper.find('.mock-popconfirm').attributes('data-title')).toContain('不可撤销');
    // 只渲染了 reference + 确认按钮：此时还没发任何请求
    expect(sendMailDigestNowMock).not.toHaveBeenCalled();

    await wrapper.find('.mock-popconfirm-confirm').trigger('click');
    await tick();
    expect(sendMailDigestNowMock).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });
});

describe('MailDigestSettings — 工具条与分页接线', () => {
  it('「保存」调 store 的保存动作（payload 带 version）', async () => {
    const { wrapper } = await mountPage();
    const saveBtn = wrapper.findAll('.mock-button').find((n) => n.text() === '保存');
    await saveBtn?.trigger('click');
    await tick();

    expect(saveMailDigestConfigMock).toHaveBeenCalledTimes(1);
    expect(saveMailDigestConfigMock.mock.calls[0]![0]).toMatchObject({ version: 3 });
    wrapper.unmount();
  });

  it('「预览」调预览端点', async () => {
    const { wrapper } = await mountPage();
    const previewBtn = wrapper.findAll('.mock-button').find((n) => n.text() === '预览');
    await previewBtn?.trigger('click');
    await tick();

    expect(previewMailDigestMock).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it('「刷新」三条读端点全刷', async () => {
    const { wrapper } = await mountPage();
    fetchMailDigestConfigMock.mockClear();
    fetchMailDigestMetaMock.mockClear();
    listMailDigestLogsMock.mockClear();

    const refreshBtn = wrapper.findAll('.mock-button').find((n) => n.text() === '刷新');
    await refreshBtn?.trigger('click');
    await tick();

    expect(fetchMailDigestConfigMock).toHaveBeenCalled();
    expect(fetchMailDigestMetaMock).toHaveBeenCalled();
    expect(listMailDigestLogsMock).toHaveBeenCalled();
    wrapper.unmount();
  });

  it('分页「下一页」写回 store 页码 ⇒ offset 随页码换', async () => {
    const { wrapper, store } = await mountPage();
    expect(store.query.logsPage).toBe(1);
    await wrapper.find('.mock-page-next').trigger('click');
    await tick();
    expect(store.query.logsPage).toBe(2);
    expect(listMailDigestLogsMock).toHaveBeenLastCalledWith({ limit: 20, offset: 20 });
    wrapper.unmount();
  });
});
