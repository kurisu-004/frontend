// @vitest-environment happy-dom
// src/views/wecom/daily/__tests__/useWeComDailyStore.spec.ts
//
// 2026-10-17 新建：每日总结页 store（`composables/useWeComDailyStore`）单测。覆盖本域最容易
// 静默出错的六类点：
//
//  1. **4 不变量**：enabled 闸门在 `openGate()` 之前**零请求**、开闸后四条 query 各发一次
//     （本域多挂一条**跨域复用的 webhook 列表**）；`$dispose()` 后重建拿到全新表单态；消费侧全
//     走 `store.切片.字段` 不解构。
//  2. **hydrate + dirty**：配置到达后整份覆盖表单；用户改了字段后 dirty 变 true；再来一次
//     后台 refetch **不覆盖**用户正在编辑的内容；显式刷新才强制覆盖。
//  3. **OCC 硬约束**：`POST /config` 的 payload 必带 `version`（无行时后端返 0）；标题模板留
//     空转 `null`；payload **逐字段写全**（不是 `Partial` 断言拼出来的）。
//  4. **错误码分流**：40901 走 warning + **强制重拉配置**；21804 走字段聚焦。⚠️ 所有
//     `apiError(…)` 的码实参一律引 `WECOM_DAILY_ERROR_CODES` 具名常量。
//  5. **前端校验前置**：四节全关 / 频率组合非法 / 数值越界时**不发请求**，只标红字段。
//  6. **失效编排**：保存成功失效 `qk.wecomDailyPrefix`（config + meta，**不含 logs**）；立即
//     发送**成败都失效日志那条精确键**（不失效前缀 —— 见 `keys.ts` 的取舍）；预览**刻意不失效**。
//
// mock 策略：`vi.mock('@/api/wecomDaily')` 六个函数全桩；webhook 子域的读端点也桩
// （`useWeComWebhooksQuery` 从那个域 import）；`vi.mock('element-plus')` 把 ElMessage 桩成
// no-op。顺序硬约束：pinia 先、VueQueryPlugin 后（store setup 首行 `useQueryClient()`）。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';

vi.mock('element-plus', () => ({
  ElMessage: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

const fetchWeComDailyConfigMock = vi.fn();
const fetchWeComDailyMetaMock = vi.fn();
const listWeComDailyLogsMock = vi.fn();
const saveWeComDailyConfigMock = vi.fn();
const previewWeComDailyMock = vi.fn();
const sendWeComDailyNowMock = vi.fn();

vi.mock('@/api/wecomDaily', () => ({
  fetchWeComDailyConfig: (...args: unknown[]) => fetchWeComDailyConfigMock(...args),
  fetchWeComDailyMeta: (...args: unknown[]) => fetchWeComDailyMetaMock(...args),
  listWeComDailyLogs: (...args: unknown[]) => listWeComDailyLogsMock(...args),
  saveWeComDailyConfig: (...args: unknown[]) => saveWeComDailyConfigMock(...args),
  previewWeComDaily: (...args: unknown[]) => previewWeComDailyMock(...args),
  sendWeComDailyNow: (...args: unknown[]) => sendWeComDailyNowMock(...args),
}));

// 跨域复用的 webhook 列表读端点（另一个 tab 共用同一条 qk.wecomWebhooks() 缓存）。
const listWeComWebhooksMock = vi.fn();

vi.mock('@/api/wecomWebhooks', () => ({
  listWeComWebhooks: (...args: unknown[]) => listWeComWebhooksMock(...args),
}));

import { ElMessage } from 'element-plus';
import { useWeComDailyStore } from '../composables/useWeComDailyStore';
import { qk } from '@/composables/queries/keys';
import { WECOM_DAILY_ERROR_CODES } from '../weComDailyErrorText';
import type { WeComDailyConfigData, WeComDailyLogData } from '../weComDailySchema';

const CONFIG: WeComDailyConfigData = {
  id: '9000000000000800',
  version: 3,
  enabled: true,
  frequency: 'WEEKLY',
  send_hour: 8,
  send_minute: 30,
  weekday: 1,
  day_of_month: null,
  webhook_id: '9000000000000903',
  upcoming_days: 3,
  worker_metric: 'QUANTITY',
  worker_top_n: 15,
  max_chunks: 3,
  include_overview: true,
  include_delivery: true,
  include_orders: true,
  include_workers: true,
  subject_template: null,
  webhook_configured: true,
  created_at: '2026-10-17 08:00:00',
  updated_at: '2026-10-17 08:00:00',
};

const META = {
  frequencies: [
    { value: 'DAILY', label: '每天', needs_time: true, needs_weekday: false, needs_day_of_month: false },
    { value: 'WEEKLY', label: '每周', needs_time: true, needs_weekday: true, needs_day_of_month: false },
    { value: 'MONTHLY', label: '每月', needs_time: true, needs_weekday: false, needs_day_of_month: true },
    { value: 'MANUAL_ONLY', label: '仅手动', needs_time: false, needs_weekday: false, needs_day_of_month: false },
  ],
  worker_metrics: [
    { value: 'QUANTITY', label: '按件数' },
    { value: 'BATCH', label: '按批次数' },
  ],
  defaults: {
    enabled: false,
    frequency: 'MANUAL_ONLY',
    send_hour: null,
    send_minute: null,
    weekday: null,
    day_of_month: null,
    webhook_id: null,
    upcoming_days: 3,
    worker_metric: 'QUANTITY',
    worker_top_n: 15,
    max_chunks: 3,
    include_overview: true,
    include_delivery: true,
    include_orders: true,
    include_workers: true,
    subject_template: null,
  },
  upcoming_days_range: { min: 1, max: 60 },
  worker_top_n_range: { min: 0, max: 200 },
  max_chunks_range: { min: 1, max: 20 },
};

const WEBHOOKS = {
  items: [
    {
      id: '9000000000000903',
      version: 1,
      name: '生产群',
      url_masked: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=693a***faaa',
      is_default: true,
      created_at: '2026-10-17 08:00:00',
      updated_at: '2026-10-17 08:00:00',
    },
  ],
};

function logRow(over: Partial<WeComDailyLogData> = {}): WeComDailyLogData {
  return {
    log_id: '9000000000000900',
    config_version: 3,
    trigger_source: 'SCHEDULED',
    status: 'SUCCESS',
    webhook_name: '生产群',
    webhook_masked: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=693a***faaa',
    report_date: '2026-10-17',
    markdown_bytes: 5120,
    chunk_count: 2,
    chunk_sent: 2,
    overview_batch_count: 12,
    overview_quantity: 340,
    note_count: 3,
    note_part_count: 56,
    overdue_count: 2,
    upcoming_count: 7,
    worker_row_total: 22,
    error_message: null,
    sent_at: '2026-10-17 08:00:00',
    ...over,
  };
}

const LOGS = { items: [logRow()], total: 1, limit: 20, offset: 0 };

const PREVIEW = {
  subject: '生产日报 2026-10-17',
  chunks: ['## 全厂报工总览\n批次 12 / 件数 340', '## 工人报工\n张三 ██████░░░░ 120'],
  chunk_count: 2,
  overview_batch_count: 12,
  overview_quantity: 340,
  completed_count: 4,
  in_process_count: 18,
  repair_part_count: 1,
  note_count: 3,
  note_part_count: 56,
  overdue_count: 2,
  upcoming_count: 7,
  worker_rows: [{ worker_name: '张三', badge_code: 'B001', batch_count: 4, quantity: 120 }],
  worker_row_total: 22,
  sections: ['全厂报工总览', '工人报工'],
};

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

function tick(ms = 30): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function apiError(code: number, message = `后端 ${code}`): Error & { code: number } {
  return Object.assign(new Error(message), { code });
}

let qc: QueryClient;

beforeEach(() => {
  vi.clearAllMocks();
  qc = setupApp();
  fetchWeComDailyConfigMock.mockResolvedValue(CONFIG);
  fetchWeComDailyMetaMock.mockResolvedValue(META);
  listWeComDailyLogsMock.mockResolvedValue(LOGS);
  listWeComWebhooksMock.mockResolvedValue(WEBHOOKS);
  saveWeComDailyConfigMock.mockResolvedValue(CONFIG);
  previewWeComDailyMock.mockResolvedValue(PREVIEW);
  sendWeComDailyNowMock.mockResolvedValue(logRow({ trigger_source: 'MANUAL' }));
});

describe('useWeComDailyStore — 不变量（闸门 / 切片解包 / $dispose）', () => {
  it('I1：openGate() 之前零请求；开闸后配置 / meta / 日志 / 通道列表各发一次', async () => {
    const store = useWeComDailyStore();
    await tick();
    expect(fetchWeComDailyConfigMock).not.toHaveBeenCalled();
    expect(fetchWeComDailyMetaMock).not.toHaveBeenCalled();
    expect(listWeComDailyLogsMock).not.toHaveBeenCalled();
    expect(listWeComWebhooksMock).not.toHaveBeenCalled();

    store.query.openGate();
    await tick();
    expect(fetchWeComDailyConfigMock).toHaveBeenCalledTimes(1);
    expect(fetchWeComDailyMetaMock).toHaveBeenCalledTimes(1);
    // 日志分页进 params（page=1 / pageSize=20 ⇒ offset 0）
    expect(listWeComDailyLogsMock).toHaveBeenCalledWith({ limit: 20, offset: 0 });
    // ⚠️ 通道列表走的是**跨域复用的** qk.wecomWebhooks()（与「Webhook 配置」tab 同一份缓存）
    expect(listWeComWebhooksMock).toHaveBeenCalledTimes(1);
  });

  it('I2：切片读不写 .value（嵌套 ref 自动解包），且代理 set 能写回（含日志翻页换 params）', async () => {
    const store = useWeComDailyStore();
    store.query.openGate();
    await tick();

    expect(store.query.logsTotal).toBe(1);
    expect(store.query.items).toHaveLength(1);
    expect(store.query.workerMetricOptions).toHaveLength(2);
    expect(store.query.webhooks).toHaveLength(1);
    expect(store.query.ranges).toEqual({
      upcoming_days: { min: 1, max: 60 },
      worker_top_n: { min: 0, max: 200 },
      max_chunks: { min: 1, max: 20 },
    });

    store.query.logsPage = 3;
    expect(store.query.logsPage).toBe(3);
    store.query.logsPageSize = 50;
    await tick();
    expect(listWeComDailyLogsMock).toHaveBeenLastCalledWith({ limit: 50, offset: 100 });
  });

  it('I3：$dispose() 后重建 store 拿到全新表单态（不泄漏上一次的未保存改动）', async () => {
    const first = useWeComDailyStore();
    first.query.openGate();
    await tick();
    first.query.form.upcoming_days = 30;
    expect(first.query.dirty).toBe(true);

    first.$dispose();

    const second = useWeComDailyStore();
    second.query.openGate();
    await tick();
    expect(second.query.form.upcoming_days).toBe(3);
    expect(second.query.dirty).toBe(false);
  });
});

describe('useWeComDailyStore — hydrate 与 dirty', () => {
  it('H1：配置到达后整份覆盖表单（空标题模板 → 空串，不塞 null 进 el-input）', async () => {
    const store = useWeComDailyStore();
    store.query.openGate();
    await tick();

    expect(store.query.form.frequency).toBe('WEEKLY');
    expect(store.query.form.send_hour).toBe(8);
    expect(store.query.form.weekday).toBe(1);
    expect(store.query.form.upcoming_days).toBe(3);
    expect(store.query.form.worker_top_n).toBe(15);
    expect(store.query.form.subject_template).toBe('');
    // 通道 id 原样 hydrate（雪花 ID 不过 Number()）
    expect(store.query.form.webhook_id).toBe('9000000000000903');
    expect(store.query.dirty).toBe(false);
  });

  it('H2：改字段后 dirty=true；随后的后台 refetch **不覆盖**用户正在编辑的内容', async () => {
    const store = useWeComDailyStore();
    store.query.openGate();
    await tick();

    store.query.form.upcoming_days = 30;
    expect(store.query.dirty).toBe(true);

    // ⚠️ 走**真实的后台 refetch 路径**（失效本域配置键），不是 store 的显式重拉 ——
    // `reloadConfig()` 只服务 40901 与「刷新」两条**强制覆盖**路径（它刻意不再暴露，
    // 也就没有「不强制」的调用方）。后台 refetch 靠 watcher 自己的 `dirty` 闸门挡。
    fetchWeComDailyConfigMock.mockResolvedValue({ ...CONFIG, version: 4, upcoming_days: 7 });
    await qc.invalidateQueries({ queryKey: qk.wecomDailyConfig() });
    await tick();

    expect(store.query.form.upcoming_days).toBe(30);
    expect(store.query.dirty).toBe(true);
  });

  it('H3：refreshAll() 强制覆盖（用户主动点「刷新」就是要服务端那份）', async () => {
    const store = useWeComDailyStore();
    store.query.openGate();
    await tick();

    store.query.form.upcoming_days = 30;
    fetchWeComDailyConfigMock.mockResolvedValue({ ...CONFIG, version: 4, upcoming_days: 7 });
    await store.query.refreshAll();
    await tick();

    expect(store.query.form.upcoming_days).toBe(7);
    expect(store.query.dirty).toBe(false);
  });

  it('H4：MANUAL_ONLY + 服务端返非空时刻/星期/月号 ⇒ hydrate 时被归一成 null（且不脏）', async () => {
    // 这是**一条看不见的死路**：MANUAL_ONLY 下那些输入框整行不渲染，而表单若留着非空的时刻，
    // schema 的「多填即非法」issue 挂在 `send_time` 上 ⇒ 屏幕上零红字，save / preview /
    // sendNow 三条路全被拦死。
    fetchWeComDailyConfigMock.mockResolvedValue({
      ...CONFIG,
      frequency: 'MANUAL_ONLY',
      send_hour: 8,
      send_minute: 30,
      weekday: 3,
      day_of_month: 5,
    });
    const store = useWeComDailyStore();
    store.query.openGate();
    await tick();

    expect(store.query.form.send_hour).toBeNull();
    expect(store.query.form.send_minute).toBeNull();
    expect(store.query.form.weekday).toBeNull();
    expect(store.query.form.day_of_month).toBeNull();
    expect(store.query.dirty).toBe(false);
  });
});

describe('useWeComDailyStore — 保存（OCC 硬约束 + 逐字段写全）', () => {
  it('S1：payload 带 version、标题模板留空转 null，且**逐字段写全**（无 Partial 断言）', async () => {
    const store = useWeComDailyStore();
    store.query.openGate();
    await tick();

    await store.actions.save();

    expect(saveWeComDailyConfigMock).toHaveBeenCalledTimes(1);
    const payload = saveWeComDailyConfigMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.version).toBe(3);
    // ⚠️ 空串会让后端拿空标题当模板渲染出无主题消息 ⇒ 必须转 null。
    expect(payload.subject_template).toBeNull();
    expect(payload.frequency).toBe('WEEKLY');
    expect(payload.webhook_id).toBe('9000000000000903');
    expect(payload.worker_metric).toBe('QUANTITY');
    expect(payload.worker_top_n).toBe(15);
    expect(payload.max_chunks).toBe(3);
    // ⚠️ 这条逐条把 16 个配置键都点一遍：后端加一个必填配置字段而本地漏发时，typecheck 会当场
    // 把这里判红（照 CLAUDE.md 登记的「`.strict()` 少键 = 页面恒空」那条纪律的前置防线）。
    expect(Object.keys(payload).sort()).toEqual(
      [
        'day_of_month',
        'enabled',
        'frequency',
        'include_delivery',
        'include_orders',
        'include_overview',
        'include_workers',
        'max_chunks',
        'send_hour',
        'send_minute',
        'subject_template',
        'upcoming_days',
        'version',
        'webhook_id',
        'weekday',
        'worker_metric',
        'worker_top_n',
      ].sort(),
    );
    expect(ElMessage.success).toHaveBeenCalledWith('已保存');
  });

  it('S2：保存成功后表单按返回的配置重置（dirty 回 false）', async () => {
    const store = useWeComDailyStore();
    store.query.openGate();
    await tick();

    store.query.form.upcoming_days = 30;
    saveWeComDailyConfigMock.mockResolvedValue({ ...CONFIG, version: 4, upcoming_days: 3 });
    await store.actions.save();
    await tick();

    expect(store.query.dirty).toBe(false);
  });

  it('S3：保存成功失效 `wecomDailyPrefix`（config + meta），**不失效 logs**', async () => {
    const store = useWeComDailyStore();
    store.query.openGate();
    await tick();
    const spy = vi.spyOn(qc, 'invalidateQueries');

    await store.actions.save();
    await tick();

    expect(spy).toHaveBeenCalledWith({ queryKey: ['wecom-daily'] });
    // ⚠️ 保存配置不改变任何一条历史行 ⇒ 不该连带刷日志（见 keys.ts 的取舍）。
    expect(spy).not.toHaveBeenCalledWith({
      queryKey: ['wecom-daily', 'logs', expect.anything()],
    });
  });

  it('S4：四节全关时**不发请求**，标红虚拟字段 sections', async () => {
    const store = useWeComDailyStore();
    store.query.openGate();
    await tick();

    store.query.form.include_overview = false;
    store.query.form.include_delivery = false;
    store.query.form.include_orders = false;
    store.query.form.include_workers = false;
    await store.actions.save();

    expect(saveWeComDailyConfigMock).not.toHaveBeenCalled();
    expect(store.query.fieldErrors.sections).toBe('四节内容至少要开启一节，否则推送出去是一条空消息');
    expect(ElMessage.warning).toHaveBeenCalledWith('请先修正表单中标红的字段');
  });

  it('S5：webhook_id 空选**不拦保存**（代价落在发送时的 21801）', async () => {
    fetchWeComDailyConfigMock.mockResolvedValue({ ...CONFIG, webhook_id: null });
    const store = useWeComDailyStore();
    store.query.openGate();
    await tick();

    await store.actions.save();

    expect(saveWeComDailyConfigMock).toHaveBeenCalledTimes(1);
    expect(saveWeComDailyConfigMock.mock.calls[0]![0]).toMatchObject({ webhook_id: null });
  });
});

describe('useWeComDailyStore — 错误码分流', () => {
  it('E1：40901 走 warning + 强制重拉配置（否则用户拿旧 version 再点一次必然再冲突）', async () => {
    const store = useWeComDailyStore();
    store.query.openGate();
    await tick();
    fetchWeComDailyConfigMock.mockClear();

    store.query.form.upcoming_days = 30;
    saveWeComDailyConfigMock.mockRejectedValue(
      apiError(WECOM_DAILY_ERROR_CODES.VERSION_CONFLICT, 'OCC'),
    );
    fetchWeComDailyConfigMock.mockResolvedValue({ ...CONFIG, version: 4, upcoming_days: 7 });
    await store.actions.save();
    await tick();

    expect(ElMessage.warning).toHaveBeenCalledWith('配置已被他人修改，请刷新后重试');
    expect(ElMessage.error).not.toHaveBeenCalled();
    expect(fetchWeComDailyConfigMock).toHaveBeenCalled();
    // 强制重拉 ⇒ 本地未保存改动被服务端那份覆盖（这正是 40901 的语义）
    expect(store.query.form.upcoming_days).toBe(7);
    expect(store.query.dirty).toBe(false);
  });

  it('E2：21804 把焦点送回频率字段', async () => {
    const store = useWeComDailyStore();
    store.query.openGate();
    await tick();

    saveWeComDailyConfigMock.mockRejectedValue(
      apiError(WECOM_DAILY_ERROR_CODES.CONFIG_INVALID, 'bad combo'),
    );
    await store.actions.save();
    await tick();

    expect(store.query.focusField).toBe('frequency');
    expect(ElMessage.error).toHaveBeenCalledWith(
      '推送配置组合不合法，请检查频率 / 触发时刻 / 内容开关 / 人数与分片上限',
    );
  });

  it('E3：21806（选中的通道被别人删掉）走**跨表兜底**文案，不是兜底的「保存失败」', async () => {
    const store = useWeComDailyStore();
    store.query.openGate();
    await tick();

    saveWeComDailyConfigMock.mockRejectedValue(apiError(21806, 'gone'));
    await store.actions.save();
    await tick();

    expect(ElMessage.error).toHaveBeenCalledWith('Webhook 不存在或已删除，请刷新后重试');
  });

  it('E4：焦点标志在每次提交入口复位（改完重试时红字与高亮仍会出现）', async () => {
    const store = useWeComDailyStore();
    store.query.openGate();
    await tick();

    saveWeComDailyConfigMock.mockRejectedValue(
      apiError(WECOM_DAILY_ERROR_CODES.CONFIG_INVALID, 'bad combo'),
    );
    await store.actions.save();
    expect(store.query.focusField).toBe('frequency');

    saveWeComDailyConfigMock.mockResolvedValue(CONFIG);
    await store.actions.save();
    expect(store.query.focusField).toBeNull();
    expect(store.query.fieldErrors).toEqual({});
  });
});

describe('useWeComDailyStore — 预览与立即发送', () => {
  it('P1：预览成功后打开弹窗并带上结果，且**不失效任何 query**', async () => {
    const store = useWeComDailyStore();
    store.query.openGate();
    await tick();
    const spy = vi.spyOn(qc, 'invalidateQueries');

    await store.actions.preview();

    expect(previewWeComDailyMock).toHaveBeenCalledTimes(1);
    const payload = previewWeComDailyMock.mock.calls[0]![0] as Record<string, unknown>;
    // 请求体是**配置部分**：不含 version（那两条端点不写配置）
    expect(payload).not.toHaveProperty('version');
    expect(payload.subject_template).toBeNull();
    expect(store.dialogs.preview.visible).toBe(true);
    // ⚠️ 逐片保存（契约里没有 markdown 单字段）
    expect(store.dialogs.preview.result?.chunks).toHaveLength(2);
    expect(store.dialogs.preview.result?.chunk_count).toBe(2);
    // 预览只渲染、不发送、不落流水 ⇒ 任何数据源都没变，不该失效
    expect(spy).not.toHaveBeenCalled();
  });

  it('SND1：发送成功 → success toast + 失效**日志那条精确键**', async () => {
    const store = useWeComDailyStore();
    store.query.openGate();
    await tick();
    const spy = vi.spyOn(qc, 'invalidateQueries');

    await store.actions.sendNow();
    await tick();

    expect(sendWeComDailyNowMock).toHaveBeenCalledTimes(1);
    expect(ElMessage.success).toHaveBeenCalledWith('企业微信消息已发送');
    expect(spy).toHaveBeenCalledWith({ queryKey: ['wecom-daily', 'logs', { limit: 20, offset: 0 }] });
    // ⚠️ **不**失效 prefix（那会把 config + meta 也刷一遍，而发送不改配置）
    expect(spy).not.toHaveBeenCalledWith({ queryKey: ['wecom-daily'] });
  });

  it('SND2：发送**失败也失效**日志（后端已记 FAILED 流水，否则那行会凭空消失）', async () => {
    const store = useWeComDailyStore();
    store.query.openGate();
    await tick();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    sendWeComDailyNowMock.mockRejectedValue(
      apiError(WECOM_DAILY_ERROR_CODES.SEND_FAILED, 'wecom down'),
    );

    await store.actions.sendNow();
    await tick();

    expect(spy).toHaveBeenCalledWith({ queryKey: ['wecom-daily', 'logs', { limit: 20, offset: 0 }] });
    expect(ElMessage.error).toHaveBeenCalledWith(
      '企业微信推送失败，请检查 webhook 是否仍有效（机器人是否已被移出群）',
    );
  });

  it('SND3：一条通道都没有 ⇒ noWebhooks=true（壳据此弹告警 + 禁用「立即发送」）', async () => {
    listWeComWebhooksMock.mockResolvedValue({ items: [] });
    const store = useWeComDailyStore();
    store.query.openGate();
    await tick();

    expect(store.query.webhooksLoaded).toBe(true);
    expect(store.query.noWebhooks).toBe(true);
    expect(store.query.webhookMissing).toBe(false);
    expect(store.actions.sendDisabled).toBe(true);
  });

  it('SND4：通道列表还在飞时 noWebhooks / webhookMissing 都是 false（首屏不闪假告警）', async () => {
    const store = useWeComDailyStore();
    store.query.openGate();
    // 通道列表请求挂在不 resolve 的 promise 上
    listWeComWebhooksMock.mockImplementation(() => new Promise(() => undefined));
    await tick();

    expect(store.query.webhooksLoaded).toBeNull();
    expect(store.query.noWebhooks).toBe(false);
    expect(store.query.webhookMissing).toBe(false);
    expect(store.actions.sendDisabled).toBe(false);
  });

  it('SND5：有通道但本条配置没选 ⇒ webhookMissing=true ⇒ **「立即发送」禁用**（后端无回落分支）', async () => {
    fetchWeComDailyConfigMock.mockResolvedValue({ ...CONFIG, webhook_id: null });
    const store = useWeComDailyStore();
    store.query.openGate();
    await tick();

    expect(store.query.webhookMissing).toBe(true);
    expect(store.actions.sendDisabled).toBe(true);
  });

  it('SND6：选了通道 ⇒ sendDisabled=false（发得出去，不该灰着）', async () => {
    const store = useWeComDailyStore();
    store.query.openGate();
    await tick();

    expect(store.query.webhookMissing).toBe(false);
    expect(store.actions.sendDisabled).toBe(false);
  });
});

describe('useWeComDailyStore — range 跟 meta 走', () => {
  it('R1：meta 把 max_chunks 上限收窄到 5 时，表单里的 10 被拦（UI 与 schema 同一真源）', async () => {
    fetchWeComDailyMetaMock.mockResolvedValue({ ...META, max_chunks_range: { min: 1, max: 5 } });
    fetchWeComDailyConfigMock.mockResolvedValue({ ...CONFIG, max_chunks: 10 });
    const store = useWeComDailyStore();
    store.query.openGate();
    await tick();

    expect(store.query.ranges.max_chunks).toEqual({ min: 1, max: 5 });
    await store.actions.save();

    expect(saveWeComDailyConfigMock).not.toHaveBeenCalled();
    expect(store.query.fieldErrors.max_chunks).toContain('1..5');
  });

  it('R2：meta 把 worker_top_n 上限放宽到 500 时，500 能过校验', async () => {
    fetchWeComDailyMetaMock.mockResolvedValue({ ...META, worker_top_n_range: { min: 0, max: 500 } });
    fetchWeComDailyConfigMock.mockResolvedValue({ ...CONFIG, worker_top_n: 500 });
    const store = useWeComDailyStore();
    store.query.openGate();
    await tick();

    expect(store.query.ranges.worker_top_n).toEqual({ min: 0, max: 500 });
    await store.actions.save();

    expect(saveWeComDailyConfigMock).toHaveBeenCalledTimes(1);
    expect(saveWeComDailyConfigMock.mock.calls[0]![0]).toMatchObject({ worker_top_n: 500 });
  });
});
