// @vitest-environment happy-dom
// src/views/wecom/daily/__tests__/useWeComDailyQuery.spec.ts
//
// 2026-10-17 新增：三条读端点 query hook 的**坏响应守门**守卫（与 api 层那份负向守卫成对）。
//
// ⚠️ **本 spec 存在的唯一理由**（照 `useMailDigestQuery.spec.ts` 的同款纪律）：api 层按
//   CLAUDE.md「queryFn Zod 守门」只发请求、不做 parse，所以一旦有人把 queryFn 里的
//   `xxxSchema.parse(...)` 整段删掉，api 层那份负向守卫
//   （`src/api/__tests__/wecomDaily.contract.spec.ts::N1`，断言读端点不 parse）**照样全绿**，
//   而线上是「后端漏发一个字段 → 那一列整列 undefined，且零报错」。只有在这里 mock 一份**坏
//   响应**、断言它进不了 data，才能把这个洞补上。
//
// 覆盖：
//   - C1：`GET /config` 少 `webhook_configured`（ConfigOut 21 键里最新加的那个）；
//   - M1：`GET /meta` 少 `max_chunks_range`（输入框的 min/max 无源）；
//   - M1b：`GET /meta` 整段形状错（顶层是裸数组）；
//   - L1：`GET /logs` 的**行**少 `error_message`（`.strict()` 下失败行整表空，管理员看不到
//     「为什么失败」，而失败正是这张表存在的理由）；
//   - L1b：`GET /logs` 的 `items` 不是数组（专守**信封形状**那一维）；
//   - L2：`GET /logs` 的 `params` 传 `null` ⇒ 闸门拦住，零请求（**三层 null 防御**的闸门那层）；
//   - S0：三条 hook 收到**好响应**时数据落进 data、且每条**恰好打一次**请求（负向用例的基线）；
//   - G1：`enabled=false` 时三条 hook 都**零网络请求**。
//
// 环境：happy-dom；element-plus 桩成 no-op（真 `ElMessage` 在 node env 会因
// `document is not defined` 抛）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, effectScope, ref, type MaybeRefOrGetter } from 'vue';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';

vi.mock('element-plus', () => ({
  ElMessage: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

const fetchWeComDailyConfigMock = vi.fn();
const fetchWeComDailyMetaMock = vi.fn();
const listWeComDailyLogsMock = vi.fn();

vi.mock('@/api/wecomDaily', () => ({
  fetchWeComDailyConfig: () => fetchWeComDailyConfigMock(),
  fetchWeComDailyMeta: () => fetchWeComDailyMetaMock(),
  listWeComDailyLogs: (params: unknown) => listWeComDailyLogsMock(params),
}));

import { ElMessage } from 'element-plus';
import {
  useWeComDailyConfigQuery,
  useWeComDailyLogsQuery,
  useWeComDailyMetaQuery,
} from '../composables/useWeComDailyQuery';

// ============================================================================
// fixtures（逐字照后端 DTO）
// ============================================================================

const CONFIG = {
  id: '9000000000000800',
  version: 3,
  enabled: true,
  frequency: 'WEEKLY' as const,
  send_hour: 8,
  send_minute: 30,
  weekday: 1,
  day_of_month: null,
  webhook_id: '9000000000000903',
  upcoming_days: 3,
  order_list_limit: 30,
  worker_metric: 'QUANTITY' as const,
  worker_top_n: 15,
  max_chunks: 6,
  include_overview: true,
  include_delivery: true,
  include_orders: true,
  include_drawings: true,
  include_workers: true,
  subject_template: null,
  // ⚠️ 少这个键的症状：store 的告警 / 判据读到 undefined。
  webhook_configured: true,
  created_at: '2026-10-17 08:00:00',
  updated_at: '2026-10-17 08:00:00',
};

const META = {
  frequencies: [
    {
      value: 'DAILY' as const,
      label: '每天',
      needs_time: true,
      needs_weekday: false,
      needs_day_of_month: false,
    },
  ],
  worker_metrics: [{ value: 'QUANTITY' as const, label: '按件数' }],
  defaults: {
    enabled: false,
    frequency: 'MANUAL_ONLY' as const,
    send_hour: null,
    send_minute: null,
    weekday: null,
    day_of_month: null,
    webhook_id: null,
    upcoming_days: 3,
    order_list_limit: 30,
    worker_metric: 'QUANTITY' as const,
    worker_top_n: 15,
    max_chunks: 6,
    include_overview: true,
    include_delivery: true,
    include_orders: true,
    include_drawings: true,
    include_workers: true,
    subject_template: null,
  },
  upcoming_days_range: { min: 1, max: 60 },
  worker_top_n_range: { min: 0, max: 200 },
  max_chunks_range: { min: 1, max: 20 },
};

const LOG_ROW = {
  log_id: '9000000000000900',
  config_version: 3,
  trigger_source: 'SCHEDULED' as const,
  status: 'SUCCESS' as const,
  webhook_name: '生产群',
  webhook_masked: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=693a***faaa',
  report_date: '2026-10-17',
  markdown_bytes: 5120,
  chunk_count: 2,
  chunk_sent: 2,
  overview_batch_count: 12,
  overview_quantity: 340,
  note_count: 0,
  note_part_count: 56,
  overdue_count: 2,
  upcoming_count: 7,
  worker_row_total: 22,
  error_message: null,
  sent_at: '2026-10-17 08:00:00',
};

const LOG_LIST = { items: [LOG_ROW], total: 1, limit: 20, offset: 0 };

let testApp: ReturnType<typeof createApp>;
let testQueryClient: QueryClient;

function mount<T>(enabled: MaybeRefOrGetter<boolean>, use: (e: MaybeRefOrGetter<boolean>) => T) {
  const scope = effectScope();
  let comp: T | undefined;
  scope.run(() => {
    comp = testApp.runWithContext(() => use(enabled));
  });
  return { scope, comp: comp! };
}

// 三条 hook 的适配器：hook 自身的入参是**对象形**（`{ enabled }` / `{ params, enabled }`），
// 不是位置形 `(enabled)`，所以不能把 hook 函数直接丢给 `mount`。
// ⚠️ **这三行是本 spec 唯一把闸门接进 hook 的线，而 TS 守不住它**（见 useWeComWebhooksQuery
//   spec 的同款说明）。typecheck 与 lint 照样全绿，只有 G1 会红。
const useConfig = (e: MaybeRefOrGetter<boolean>) => useWeComDailyConfigQuery({ enabled: e });
const useMeta = (e: MaybeRefOrGetter<boolean>) => useWeComDailyMetaQuery({ enabled: e });
const useLogs = (e: MaybeRefOrGetter<boolean>) =>
  useWeComDailyLogsQuery({ enabled: e, params: { limit: 20, offset: 0 } });

/** 只吃闸门 + params 的变体（L2 要传 `params: null`）。 */
function useLogsWithParams(
  e: MaybeRefOrGetter<boolean>,
  params: MaybeRefOrGetter<{ limit?: number; offset?: number } | null>,
) {
  return useWeComDailyLogsQuery({ enabled: e, params });
}

function tick(ms = 30): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchWeComDailyConfigMock.mockResolvedValue(CONFIG);
  fetchWeComDailyMetaMock.mockResolvedValue(META);
  listWeComDailyLogsMock.mockResolvedValue(LOG_LIST);
  testQueryClient = new QueryClient({
    defaultOptions: { mutations: { retry: 0 }, queries: { retry: 0 } },
  });
  testApp = createApp({});
  testApp.use(VueQueryPlugin, { queryClient: testQueryClient });
});

afterEach(() => {
  testQueryClient.unmount();
});

// ============================================================================
// S0：好响应基线
// ============================================================================

describe('useWeComDailyQuery — 好响应落值', () => {
  it('S0：三条 hook 各自把好响应落进 data（坏响应守卫的基线），且各打一次请求', async () => {
    const c = mount(ref(true), useConfig);
    const m = mount(ref(true), useMeta);
    const l = mount(ref(true), useLogs);
    await tick();

    expect(c.comp.query.error.value).toBeNull();
    expect(c.comp.data.value?.version).toBe(3);
    expect(m.comp.query.error.value).toBeNull();
    expect(m.comp.data.value?.max_chunks_range.max).toBe(20);
    expect(l.comp.query.error.value).toBeNull();
    expect(l.comp.data.value?.items).toHaveLength(1);
    // 「**恰好**一次」把双发也钉住：只断落值证得「至少打了一次」。
    expect(fetchWeComDailyConfigMock).toHaveBeenCalledTimes(1);
    expect(fetchWeComDailyMetaMock).toHaveBeenCalledTimes(1);
    expect(listWeComDailyLogsMock).toHaveBeenCalledTimes(1);
    c.scope.stop();
    m.scope.stop();
    l.scope.stop();
  });
});

// ============================================================================
// G1：enabled 闸门
// ============================================================================

describe('useWeComDailyQuery — enabled 闸门', () => {
  it('G1：enabled=false ⇒ 三条 hook 零网络请求、data 恒 undefined', async () => {
    const c = mount(ref(false), useConfig);
    const m = mount(ref(false), useMeta);
    const l = mount(ref(false), useLogs);
    await tick();

    expect(fetchWeComDailyConfigMock, 'config 闸门未开时不该发请求').not.toHaveBeenCalled();
    expect(fetchWeComDailyMetaMock, 'meta 闸门未开时不该发请求').not.toHaveBeenCalled();
    expect(listWeComDailyLogsMock, 'logs 闸门未开时不该发请求').not.toHaveBeenCalled();
    expect(c.comp.data.value).toBeUndefined();
    expect(m.comp.data.value).toBeUndefined();
    expect(l.comp.data.value).toBeUndefined();
    c.scope.stop();
    m.scope.stop();
    l.scope.stop();
  });

  it('L2：logs 的 params 传 null ⇒ 闸门拦住、零请求（占位键那一层不漏成真请求）', async () => {
    const scope = effectScope();
    let comp!: ReturnType<typeof useWeComDailyLogsQuery>;
    scope.run(() => {
      comp = testApp.runWithContext(() => useLogsWithParams(ref(true), ref(null)));
    });
    await tick();

    expect(listWeComDailyLogsMock, 'params 为 null 时不该发请求').not.toHaveBeenCalled();
    expect(comp.data.value).toBeUndefined();
    scope.stop();
  });
});

// ============================================================================
// C1 / M1 / L1：坏响应 ⇒ queryFn 里的 parse 必须拦住
// ============================================================================

describe('useWeComDailyConfigQuery — 坏响应守门（C1）', () => {
  it('C1：config 少 webhook_configured ⇒ 进 error 态、data 不落值', async () => {
    // Zod 的 strip 默认会把缺字段**悄悄吞掉**让页面照常渲染那一列的 undefined ——
    // queryFn 里的 parse 就是为拦住这个。
    const broken: Record<string, unknown> = { ...CONFIG };
    delete broken['webhook_configured'];
    fetchWeComDailyConfigMock.mockResolvedValue(broken);

    const { scope, comp } = mount(ref(true), useConfig);
    await tick();

    expect(comp.query.error.value, '缺 webhook_configured 应当抛').not.toBeNull();
    expect(comp.data.value).toBeUndefined();
    expect(ElMessage.error).toHaveBeenCalled();
    scope.stop();
  });

  it('C1b：config 多一个键 ⇒ 进 error 态（.strict() 的对称代价）', async () => {
    fetchWeComDailyConfigMock.mockResolvedValue({ ...CONFIG, last_error: 'x' });

    const { scope, comp } = mount(ref(true), useConfig);
    await tick();

    expect(comp.query.error.value).not.toBeNull();
    scope.stop();
  });
});

describe('useWeComDailyMetaQuery — 坏响应守门（M1）', () => {
  it('M1：meta 少 max_chunks_range ⇒ 进 error 态（输入框的 min/max 无源）', async () => {
    const { max_chunks_range: _drop, ...noRange } = META;
    fetchWeComDailyMetaMock.mockResolvedValue(noRange);

    const { scope, comp } = mount(ref(true), useMeta);
    await tick();

    expect(comp.query.error.value).not.toBeNull();
    expect(comp.data.value).toBeUndefined();
    scope.stop();
  });

  it('M1b：meta 整段形状错（顶层是裸数组）⇒ 进 error 态', async () => {
    fetchWeComDailyMetaMock.mockResolvedValue([META]);

    const { scope, comp } = mount(ref(true), useMeta);
    await tick();

    expect(comp.query.error.value).not.toBeNull();
    expect(comp.data.value).toBeUndefined();
    scope.stop();
  });
});

describe('useWeComDailyLogsQuery — 坏响应守门（L1）', () => {
  it('L1：日志行少 error_message ⇒ 整表进 error 态（失败行正是这张表存在的理由）', async () => {
    const { error_message: _drop, ...noMsg } = LOG_ROW;
    listWeComDailyLogsMock.mockResolvedValue({ ...LOG_LIST, items: [noMsg] });

    const { scope, comp } = mount(ref(true), useLogs);
    await tick();

    expect(comp.query.error.value, '缺 error_message 应当抛').not.toBeNull();
    expect(comp.data.value).toBeUndefined();
    scope.stop();
  });

  it('L1b：信封形状错（items 不是数组）⇒ 进 error 态', async () => {
    // 写成 z.array 时症状是「每一屏都抛、列表恒空、零告警」。
    listWeComDailyLogsMock.mockResolvedValue({ ...LOG_LIST, items: LOG_ROW });

    const { scope, comp } = mount(ref(true), useLogs);
    await tick();

    expect(comp.query.error.value).not.toBeNull();
    expect(comp.data.value).toBeUndefined();
    scope.stop();
  });

  it('L1c：`chunk_count === 0` 的行**是合法值**（准备阶段就失败）⇒ 不该被当成坏响应', async () => {
    // 反向用例：这条守的是「别把合法值当坏值拦掉」。症状会是「准备阶段失败的那一行根本不
    // 能出现在表里」，而它恰恰是排查故障最需要的那一行。
    listWeComDailyLogsMock.mockResolvedValue({
      ...LOG_LIST,
      items: [{ ...LOG_ROW, status: 'FAILED', chunk_count: 0, chunk_sent: 0, markdown_bytes: 0 }],
    });

    const { scope, comp } = mount(ref(true), useLogs);
    await tick();

    expect(comp.query.error.value).toBeNull();
    expect(comp.data.value?.items[0]?.chunk_count).toBe(0);
    scope.stop();
  });
});
