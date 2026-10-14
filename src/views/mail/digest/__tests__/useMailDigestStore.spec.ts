// @vitest-environment happy-dom
// src/views/mail/digest/__tests__/useMailDigestStore.spec.ts
//
// 2026-10-13 新增：交期汇总邮件页 store（`composables/useMailDigestStore`）单测。
// 覆盖本域最容易静默出错的六类点：
//
//  1. **4 不变量**：enabled 闸门在 `openGate()` 之前**零请求**、开闸后三条 query 各发一次；
//     `$dispose()` 后重建拿到全新表单态（Pinia 单例不 dispose 会把未保存改动泄漏到下次
//     进入）；消费侧全走 `store.切片.字段` 不解构（嵌套 ref 自动解包 + 代理 set 可写回）。
//  2. **hydrate + dirty**：配置到达后整份覆盖表单；用户改了字段后 dirty 变 true；
//     再来一次后台 refetch **不覆盖**用户正在编辑的内容（⚠️ 2026-10-14 订正：本域不设
//     staleTime，原先写的「30s staleTime 到期」是错的；这里守的是「任何一次 config 重新
//     到达都不会抹掉用户填了一半的表单」）；显式刷新 / 40901 才强制覆盖。
//  3. **OCC 硬约束**：`POST /config` 的 payload 必带 `version`（取 `GET /config` 的
//     version，无行时后端返 0）；标题模板留空转 `null`（不是空串）。
//  4. **错误码分流**：40901 走 warning + **强制重拉配置**（不重拉的话用户拿着旧 version
//     再点一次必然再冲突）；21703 / 21704 走字段聚焦（把 focusField 指向对应输入项）。
//     ⚠️ 2026-10-14：本文件所有 `apiError(…)` 的码实参一律引 `MAIL_DIGEST_ERROR_CODES`
//     具名常量，不写裸数字 —— 本域码段刚从 215xx 迁到 217xx（215xx 已被后端 outsource
//     发货域占用），裸字面量漏改一处就是**静默失配**（分流不命中、focusField 不置位，
//     用例若照抄旧数字反而「照旧绿」，等于什么都没守）。
//  5. **前端校验前置**：收件人空 / 邮箱非法 / 频率组合非法时**不发请求**，只标红字段。
//  6. **失效编排**：保存成功失效本域前缀；立即发送**失败也失效**（服务端已记 FAILED 日志，
//     只在成功分支失效会让「刚才那次为什么没发出去」凭空消失）。
//
// mock 策略：`vi.mock('@/api/mailDigest')` 六个函数全桩；`vi.mock('element-plus')` 把
// ElMessage 桩成 no-op（happy-dom 下真 EP Message 会往 body 挂节点、污染断言）。
// 顺序硬约束：pinia 先、VueQueryPlugin 后（store setup 首行 `useQueryClient()`）。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';

vi.mock('element-plus', () => ({
  ElMessage: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

const fetchMailDigestConfigMock = vi.fn();
const fetchMailDigestMetaMock = vi.fn();
const listMailDigestLogsMock = vi.fn();
const saveMailDigestConfigMock = vi.fn();
const previewMailDigestMock = vi.fn();
const sendMailDigestNowMock = vi.fn();

vi.mock('@/api/mailDigest', () => ({
  fetchMailDigestConfig: (...args: unknown[]) => fetchMailDigestConfigMock(...args),
  fetchMailDigestMeta: (...args: unknown[]) => fetchMailDigestMetaMock(...args),
  listMailDigestLogs: (...args: unknown[]) => listMailDigestLogsMock(...args),
  saveMailDigestConfig: (...args: unknown[]) => saveMailDigestConfigMock(...args),
  previewMailDigest: (...args: unknown[]) => previewMailDigestMock(...args),
  sendMailDigestNow: (...args: unknown[]) => sendMailDigestNowMock(...args),
}));

// 2026-10-16：邮箱列表（`/api/v2/cron/mail/accounts`）—— 「发信邮箱」下拉的选项来源。
const listMailAccountsMock = vi.fn();

vi.mock('@/api/mailAccounts', () => ({
  fetchMailMeta: vi.fn(),
  listMailAccounts: (...args: unknown[]) => listMailAccountsMock(...args),
}));

import { ElMessage } from 'element-plus';
import { useMailDigestStore } from '../composables/useMailDigestStore';
import { MAIL_DIGEST_ERROR_CODES } from '../mailDigestErrorText';
import type { MailDigestConfigData, MailDigestLogData } from '../mailDigestSchema';

/** `GET /config` 的合法响应（守门 schema 全 18 键）。 */
const CONFIG: MailDigestConfigData = {
  id: '1900000000000000001',
  version: 3,
  enabled: true,
  frequency: 'WEEKLY',
  send_hour: 8,
  send_minute: 30,
  weekday: 1,
  day_of_month: null,
  recipients: ['a@example.com'],
  cc_recipients: [],
  include_overdue: true,
  include_upcoming: true,
  upcoming_days: 14,
  visible_columns: ['part_no', 'customer'],
  subject_template: null,
  // 2026-10-16 新增：发信邮箱 id（雪花 ID ⇒ JSON string）。
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
      value: 'WEEKLY',
      label: '每周',
      needs_time: true,
      needs_weekday: true,
      needs_day_of_month: false,
    },
    {
      value: 'MONTHLY',
      label: '每月',
      needs_time: true,
      needs_weekday: false,
      needs_day_of_month: true,
    },
    {
      value: 'MANUAL_ONLY',
      label: '仅手动',
      needs_time: false,
      needs_weekday: false,
      needs_day_of_month: false,
    },
  ],
  columns: [
    { key: 'part_no', label: '零件号' },
    { key: 'customer', label: '客户' },
  ],
  defaults: {
    enabled: false,
    frequency: 'MANUAL_ONLY',
    send_hour: null,
    send_minute: null,
    weekday: null,
    day_of_month: null,
    recipients: [],
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

/** 2026-10-16：SMTP 改由邮箱账号实体承载（`/api/v2/cron/mail/accounts`），本页多挂一条
 *  `qk.mailAccounts()` 的 query 给「发信邮箱」下拉供选项。与「邮箱设置」tab 共用同一条
 *  缓存，切 tab 不重新打。 */
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

function logRow(over: Partial<MailDigestLogData> = {}): MailDigestLogData {
  return {
    log_id: '1900000000000000010',
    status: 'SUCCESS',
    subject: '交期汇总 2026-10-13',
    to_recipients: ['a@example.com'],
    overdue_count: 3,
    upcoming_count: 12,
    html_bytes: 20480,
    sent_at: '2026-10-13 08:30:00',
    error_message: null,
    config_version: 3,
    cc_recipients: [],
    trigger_source: 'SCHEDULED',
    ...over,
  };
}

const LOGS = { items: [logRow()], total: 1, limit: 20, offset: 0 };

/** 起一套 pinia + vue-query 环境，返回 QueryClient（失效调用点要 spy 它）。 */
function setupApp(): QueryClient {
  const app = createApp({});
  app.use(createPinia());
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: 0 }, mutations: { retry: 0 } },
  });
  app.use(VueQueryPlugin, { queryClient });
  setActivePinia(app.config.globalProperties.$pinia);
  return queryClient;
}

/** 等 useQuery 的 scheduler 跑过一轮（TanStack 内部是 setTimeout(…, 0)）。 */
function tick(ms = 30): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 造一个带 ApiError 形态 code 的异常（http.ts 的响应拦截器抛的就是它）。 */
function apiError(code: number, message = `后端 ${code}`): Error & { code: number } {
  return Object.assign(new Error(message), { code });
}

let qc: QueryClient;

beforeEach(() => {
  vi.clearAllMocks();
  qc = setupApp();
  fetchMailDigestConfigMock.mockResolvedValue(CONFIG);
  fetchMailDigestMetaMock.mockResolvedValue(META);
  listMailDigestLogsMock.mockResolvedValue(LOGS);
  // 2026-10-16：默认给一条邮箱（默认档 = 「有邮箱、已选中」）；各用例按需覆盖。
  listMailAccountsMock.mockResolvedValue({ items: ACCOUNTS });
  saveMailDigestConfigMock.mockResolvedValue(CONFIG);
  previewMailDigestMock.mockResolvedValue({
    subject: '交期汇总 2026-10-13',
    html: '<table></table>',
    overdue_count: 3,
    upcoming_count: 12,
    columns: ['part_no', 'customer'],
  });
  sendMailDigestNowMock.mockResolvedValue({
    log_id: '1900000000000000010',
    status: 'SUCCESS',
    subject: '交期汇总 2026-10-13',
    to_recipients: ['a@example.com'],
    overdue_count: 3,
    upcoming_count: 12,
    html_bytes: 2048,
    sent_at: '2026-10-13 09:00:00',
    error_message: null,
  });
});

describe('useMailDigestStore — 不变量（闸门 / 切片解包 / $dispose）', () => {
  it('I1：openGate() 之前零请求；开闸后配置 / meta / 日志各发一次', async () => {
    const store = useMailDigestStore();
    await tick();
    expect(fetchMailDigestConfigMock).not.toHaveBeenCalled();
    expect(fetchMailDigestMetaMock).not.toHaveBeenCalled();
    expect(listMailDigestLogsMock).not.toHaveBeenCalled();

    store.query.openGate();
    await tick();
    expect(fetchMailDigestConfigMock).toHaveBeenCalledTimes(1);
    expect(fetchMailDigestMetaMock).toHaveBeenCalledTimes(1);
    expect(listMailDigestLogsMock).toHaveBeenCalledTimes(1);
    // 日志分页进 params（page=1 / pageSize=20 ⇒ offset 0）
    expect(listMailDigestLogsMock).toHaveBeenCalledWith({ limit: 20, offset: 0 });
  });

  it('I2：切片读不写 .value（嵌套 ref 自动解包），且代理 set 能写回', async () => {
    const store = useMailDigestStore();
    store.query.openGate();
    await tick();

    expect(store.query.logsTotal).toBe(1);
    expect(store.query.items).toHaveLength(1);
    expect(store.query.columnOptions).toHaveLength(2);
    // 2026-10-16：SMTP 判据已换成「邮箱实体」那一套（见 SND3 / SND4）。
    expect(store.query.senderAccounts).toHaveLength(1);
    expect(store.query.noAccounts).toBe(false);
    expect(store.query.senderMissing).toBe(false);
    expect(store.query.upcomingDaysRange).toEqual({ min: 1, max: 60 });

    store.query.logsPage = 3;
    expect(store.query.logsPage).toBe(3);
    store.query.logsPageSize = 50;
    await tick();
    expect(listMailDigestLogsMock).toHaveBeenLastCalledWith({ limit: 50, offset: 100 });
  });

  it('I3：$dispose() 后重建 store 拿到全新表单态（不泄漏上一次的未保存改动）', async () => {
    const first = useMailDigestStore();
    first.query.openGate();
    await tick();
    first.query.form.recipients = ['edited@example.com'];
    expect(first.query.dirty).toBe(true);

    first.$dispose();

    const second = useMailDigestStore();
    second.query.openGate();
    await tick();
    expect(second.query.form.recipients).toEqual(['a@example.com']);
    expect(second.query.dirty).toBe(false);
  });
});

describe('useMailDigestStore — hydrate 与 dirty', () => {
  it('H1：配置到达后整份覆盖表单（空标题模板 → 空串，不塞 null 进 el-input）', async () => {
    const store = useMailDigestStore();
    store.query.openGate();
    await tick();

    expect(store.query.form.frequency).toBe('WEEKLY');
    expect(store.query.form.send_hour).toBe(8);
    expect(store.query.form.weekday).toBe(1);
    expect(store.query.form.upcoming_days).toBe(14);
    expect(store.query.form.visible_columns).toEqual(['part_no', 'customer']);
    expect(store.query.form.subject_template).toBe('');
    expect(store.query.dirty).toBe(false);
  });

  it('H2：改字段后 dirty=true；随后的后台 refetch **不覆盖**用户正在编辑的内容', async () => {
    const store = useMailDigestStore();
    store.query.openGate();
    await tick();

    store.query.form.recipients = ['edited@example.com'];
    expect(store.query.dirty).toBe(true);

    // 模拟「配置重新到达」触发的后台 refetch（数据变了，但用户有未保存改动）。
    fetchMailDigestConfigMock.mockResolvedValue({ ...CONFIG, version: 4, recipients: ['x@y.com'] });
    await store.query.reloadConfig(false);
    await tick();

    expect(store.query.form.recipients).toEqual(['edited@example.com']);
    expect(store.query.dirty).toBe(true);
  });

  it('H3：refreshAll() 强制覆盖（用户主动点「刷新」就是要服务端那份）', async () => {
    const store = useMailDigestStore();
    store.query.openGate();
    await tick();

    store.query.form.recipients = ['edited@example.com'];
    fetchMailDigestConfigMock.mockResolvedValue({ ...CONFIG, version: 4, recipients: ['x@y.com'] });
    await store.query.refreshAll();
    await tick();

    expect(store.query.form.recipients).toEqual(['x@y.com']);
    expect(store.query.dirty).toBe(false);
  });
});

// ⚠️ 2026-10-14 新增（review 第 1 轮 M-2）。修的是一条**看不见的死路**：MANUAL_ONLY 下
// 「多填时刻」被 schema 判非法，而那一整行输入（含红字）在该频率下不渲染 ⇒ 用户只看到
// 一句「请先修正表单中标红的字段」、屏幕上一处红字都没有，save / preview / sendNow 全被
// 拦死。修法：hydrate 时按频率判据归一（`applyConfigToForm`）。
describe('useMailDigestStore — hydrate 时按频率判据归一（M-2 死路）', () => {
  it('MANUAL_ONLY + 服务端返非空时刻/星期/月号 ⇒ 表单被归一成 null，且不脏', async () => {
    fetchMailDigestConfigMock.mockResolvedValue({
      ...CONFIG,
      frequency: 'MANUAL_ONLY',
      send_hour: 8,
      send_minute: 30,
      weekday: 3,
      day_of_month: 5,
    });
    const store = useMailDigestStore();
    store.query.openGate();
    await tick();

    expect(store.query.form.send_hour).toBeNull();
    expect(store.query.form.send_minute).toBeNull();
    expect(store.query.form.weekday).toBeNull();
    expect(store.query.form.day_of_month).toBeNull();
    // 归一后快照同步更新 ⇒ 不把服务端那行的脏组合算成「用户改了表单」
    expect(store.query.dirty).toBe(false);
  });

  it('归一后三条动作都能过校验（原来 save 会被拦死且屏幕零红字）', async () => {
    const MANUAL_CONFIG = { ...CONFIG, frequency: 'MANUAL_ONLY', send_hour: 8, send_minute: 30 };
    fetchMailDigestConfigMock.mockResolvedValue(MANUAL_CONFIG);
    // 后端保存后回的是**已归一**的那行（MANUAL_ONLY + 时刻为 null），与真实行为一致
    saveMailDigestConfigMock.mockResolvedValue({
      ...CONFIG,
      frequency: 'MANUAL_ONLY',
      send_hour: null,
      send_minute: null,
    });
    const store = useMailDigestStore();
    store.query.openGate();
    await tick();

    await store.actions.save();
    expect(saveMailDigestConfigMock).toHaveBeenCalledTimes(1);
    expect(store.query.fieldErrors).toEqual({});

    await store.actions.preview();
    expect(previewMailDigestMock).toHaveBeenCalledTimes(1);
    // 发出去的时刻字段也必须是 null（不能把刚归一掉的脏值又拼回去）
    expect(previewMailDigestMock.mock.calls[0]![0]).toMatchObject({
      send_hour: null,
      send_minute: null,
    });
  });

  it('归一用 meta 的判据而不是写死的表：meta 先落地时，meta 说 DAILY 不要时刻 ⇒ 时刻被清掉', async () => {
    // 让 meta 先到（立即 resolve）、config 延后（20ms 后）—— 两条 read 是并行的，归一读的
    // 必须是**当时**的 `frequencyFlags`。若改成读写死的那张表，本例会红。
    fetchMailDigestMetaMock.mockResolvedValue({
      ...META,
      frequencies: META.frequencies.map((f) =>
        f.value === 'DAILY' ? { ...f, needs_time: false } : f,
      ),
    });
    fetchMailDigestConfigMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ ...CONFIG, frequency: 'DAILY' }), 20);
        }),
    );
    const store = useMailDigestStore();
    store.query.openGate();
    await tick(80);

    expect(store.query.form.frequency).toBe('DAILY');
    expect(store.query.form.send_hour).toBeNull();
    expect(store.query.form.send_minute).toBeNull();
  });
});

describe('useMailDigestStore — 天数范围跟 meta 走（N-1）', () => {
  it('meta 把上限放宽到 90 时，表单里的 90 能过校验（旧版会被写死的 1..60 拒）', async () => {
    fetchMailDigestMetaMock.mockResolvedValue({
      ...META,
      upcoming_days_range: { min: 1, max: 90 },
    });
    fetchMailDigestConfigMock.mockResolvedValue({ ...CONFIG, upcoming_days: 90 });
    const store = useMailDigestStore();
    store.query.openGate();
    await tick();

    expect(store.query.upcomingDaysRange).toEqual({ min: 1, max: 90 });
    expect(store.query.form.upcoming_days).toBe(90);

    await store.actions.save();
    expect(saveMailDigestConfigMock).toHaveBeenCalledTimes(1);
    expect(saveMailDigestConfigMock.mock.calls[0]![0]).toMatchObject({ upcoming_days: 90 });
    expect(store.query.fieldErrors).toEqual({});
  });
});

describe('useMailDigestStore — 保存（OCC 硬约束）', () => {
  it('S1：payload 带 version（取 GET /config 的 version），标题模板留空转 null', async () => {
    const store = useMailDigestStore();
    store.query.openGate();
    await tick();

    await store.actions.save();

    expect(saveMailDigestConfigMock).toHaveBeenCalledTimes(1);
    const payload = saveMailDigestConfigMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.version).toBe(3);
    // ⚠️ 空串会让后端拿空标题当模板渲染出无主题邮件 ⇒ 必须转 null。
    expect(payload.subject_template).toBeNull();
    expect(payload.frequency).toBe('WEEKLY');
    expect(payload.recipients).toEqual(['a@example.com']);
    expect(ElMessage.success).toHaveBeenCalledWith('已保存');
  });

  it('S2：保存成功后表单按返回的配置重置（dirty 回 false）', async () => {
    const store = useMailDigestStore();
    store.query.openGate();
    await tick();

    store.query.form.recipients = ['edited@example.com'];
    saveMailDigestConfigMock.mockResolvedValue({ ...CONFIG, version: 4 });
    await store.actions.save();
    await tick();

    expect(store.query.dirty).toBe(false);
  });

  it('S3：校验不过时**不发请求**，只标红字段 + 聚焦到第一个出错的字段', async () => {
    const store = useMailDigestStore();
    store.query.openGate();
    await tick();

    store.query.form.recipients = [];
    await store.actions.save();

    expect(saveMailDigestConfigMock).not.toHaveBeenCalled();
    expect(store.query.fieldErrors.recipients).toBe('至少填写一个收件人');
    expect(store.query.focusField).toBe('recipients');
    expect(ElMessage.warning).toHaveBeenCalledWith('请先修正表单中标红的字段');
  });

  it('S4：邮箱非法被前端拦下（对齐后端 21703），不发请求', async () => {
    const store = useMailDigestStore();
    store.query.openGate();
    await tick();

    store.query.form.recipients = ['not-an-email'];
    await store.actions.save();
    expect(saveMailDigestConfigMock).not.toHaveBeenCalled();
    expect(store.query.fieldErrors.recipients).toBe('邮箱格式不正确');
  });
});

describe('useMailDigestStore — 错误码分流', () => {
  it('E1：40901 走 warning + 强制重拉配置（否则用户拿旧 version 再点一次必然再冲突）', async () => {
    const store = useMailDigestStore();
    store.query.openGate();
    await tick();
    fetchMailDigestConfigMock.mockClear();

    store.query.form.recipients = ['edited@example.com'];
    saveMailDigestConfigMock.mockRejectedValue(
      apiError(MAIL_DIGEST_ERROR_CODES.VERSION_CONFLICT, 'OCC'),
    );
    fetchMailDigestConfigMock.mockResolvedValue({ ...CONFIG, version: 4, recipients: ['x@y.com'] });
    await store.actions.save();
    await tick();

    expect(ElMessage.warning).toHaveBeenCalledWith('配置已被他人修改，请刷新后重试');
    expect(ElMessage.error).not.toHaveBeenCalled();
    expect(fetchMailDigestConfigMock).toHaveBeenCalled();
    // 强制重拉 ⇒ 本地未保存改动被服务端那份覆盖（这正是 40901 的语义）
    expect(store.query.form.recipients).toEqual(['x@y.com']);
    expect(store.query.dirty).toBe(false);
  });

  it('E2：21703（INVALID_RECIPIENT）把焦点送回收件人字段（不是甩一句「操作失败」）', async () => {
    const store = useMailDigestStore();
    store.query.openGate();
    await tick();

    saveMailDigestConfigMock.mockRejectedValue(
      apiError(MAIL_DIGEST_ERROR_CODES.INVALID_RECIPIENT, 'bad email'),
    );
    await store.actions.save();
    await tick();

    expect(store.query.focusField).toBe('recipients');
    expect(ElMessage.error).toHaveBeenCalledWith('收件人邮箱格式不合法，请检查收件人列表');
  });

  it('E3：21704（INVALID_FREQUENCY_COMBO）把焦点送回频率字段', async () => {
    const store = useMailDigestStore();
    store.query.openGate();
    await tick();

    saveMailDigestConfigMock.mockRejectedValue(
      apiError(MAIL_DIGEST_ERROR_CODES.INVALID_FREQUENCY_COMBO, 'bad combo'),
    );
    await store.actions.save();
    await tick();

    expect(store.query.focusField).toBe('frequency');
    expect(ElMessage.error).toHaveBeenCalledWith(
      '发送频率与时间设置不匹配，请检查频率、触发时刻、星期 / 每月几号',
    );
  });

  it('E4：焦点标志在每次提交入口复位（改完重试时红字与高亮仍会出现）', async () => {
    const store = useMailDigestStore();
    store.query.openGate();
    await tick();

    saveMailDigestConfigMock.mockRejectedValue(
      apiError(MAIL_DIGEST_ERROR_CODES.INVALID_RECIPIENT, 'bad email'),
    );
    await store.actions.save();
    expect(store.query.focusField).toBe('recipients');

    saveMailDigestConfigMock.mockResolvedValue(CONFIG);
    await store.actions.save();
    expect(store.query.focusField).toBeNull();
    expect(store.query.fieldErrors).toEqual({});
  });
});

describe('useMailDigestStore — 预览与立即发送', () => {
  it('P1：预览成功后打开弹窗并带上结果', async () => {
    const store = useMailDigestStore();
    store.query.openGate();
    await tick();

    await store.actions.preview();

    expect(previewMailDigestMock).toHaveBeenCalledTimes(1);
    const payload = previewMailDigestMock.mock.calls[0]![0] as Record<string, unknown>;
    // 请求体是**配置部分**：不含 version（那两条端点不写配置）
    expect(payload).not.toHaveProperty('version');
    expect(payload.subject_template).toBeNull();
    expect(store.dialogs.preview.visible).toBe(true);
    expect(store.dialogs.preview.result?.html).toBe('<table></table>');
  });

  it('SND1：发送成功 → success toast + 失效本域前缀（写完立刻看到自己那行日志）', async () => {
    const store = useMailDigestStore();
    store.query.openGate();
    await tick();
    const spy = vi.spyOn(qc, 'invalidateQueries');

    await store.actions.sendNow();
    await tick();

    expect(sendMailDigestNowMock).toHaveBeenCalledTimes(1);
    expect(ElMessage.success).toHaveBeenCalledWith('邮件已发送');
    expect(spy).toHaveBeenCalledWith({ queryKey: ['mail-digest'] });
  });

  it('SND2：发送**失败也失效**日志（服务端已记 FAILED 日志，否则那行会凭空消失）', async () => {
    const store = useMailDigestStore();
    store.query.openGate();
    await tick();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    sendMailDigestNowMock.mockRejectedValue(
      apiError(MAIL_DIGEST_ERROR_CODES.SMTP_SEND_FAILED, 'smtp down'),
    );

    await store.actions.sendNow();
    await tick();

    expect(spy).toHaveBeenCalledWith({ queryKey: ['mail-digest'] });
    expect(ElMessage.error).toHaveBeenCalledWith('邮件发送失败，请检查 SMTP 配置与收件人地址');
  });

  it('SND3：一条邮箱都没有时 noAccounts=true（壳据此禁用「立即发送」并弹告警）', async () => {
    listMailAccountsMock.mockResolvedValue({ items: [] });
    const store = useMailDigestStore();
    store.query.openGate();
    await tick();

    expect(store.query.accountsLoaded).toBe(true);
    expect(store.query.noAccounts).toBe(true);
    expect(store.query.senderMissing).toBe(false);
    expect(store.actions.sendDisabled).toBe(true);
  });

  it('SND4：邮箱列表还在飞时 noAccounts/senderMissing 都是 false（首屏不闪假告警）', async () => {
    const store = useMailDigestStore();
    store.query.openGate();
    // 邮箱列表请求挂在不 resolve 的 promise 上
    listMailAccountsMock.mockImplementation(() => new Promise(() => undefined));
    await tick();

    expect(store.query.accountsLoaded).toBeNull();
    expect(store.query.noAccounts).toBe(false);
    expect(store.query.senderMissing).toBe(false);
    expect(store.actions.sendDisabled).toBe(false);
  });

  it('SND5：有邮箱但本条配置没选时 senderMissing=true ⇒ **「立即发送」禁用**（后端无回落分支）', async () => {
    fetchMailDigestConfigMock.mockResolvedValue({ ...CONFIG, sender_account_id: null });
    listMailAccountsMock.mockResolvedValue({ items: ACCOUNTS });
    const store = useMailDigestStore();
    store.query.openGate();
    await tick();

    expect(store.query.senderMissing).toBe(true);
    // ⚠️ 禁用：后端 `mail_digest::service::resolve_sender` 对 `sender_account_id IS NULL`
    // 直接返 21701（503），**没有**回落到默认邮箱的分支 —— 「不选也能发」是假承诺，
    // 而「立即发送」是不可撤销操作。
    expect(store.actions.sendDisabled).toBe(true);
  });

  it('SND5b：选了发信邮箱 ⇒ sendDisabled=false（发得出去，不该灰着）', async () => {
    listMailAccountsMock.mockResolvedValue({ items: ACCOUNTS });
    const store = useMailDigestStore();
    store.query.openGate();
    await tick();

    expect(store.query.senderMissing).toBe(false);
    expect(store.actions.sendDisabled).toBe(false);
  });

  it('SND6：配置里的 sender_account_id 原样 hydrate 进表单（雪花 ID 不过 Number()）', async () => {
    listMailAccountsMock.mockResolvedValue({ items: ACCOUNTS });
    const store = useMailDigestStore();
    store.query.openGate();
    await tick();

    expect(store.query.form.sender_account_id).toBe('9000000000000902');
  });
});
