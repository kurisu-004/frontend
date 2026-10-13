// @vitest-environment happy-dom
// src/views/mail/digest/__tests__/useMailDigestQuery.spec.ts
//
// 2026-10-16 新增：三条读端点 query hook 的**坏响应守门**守卫（与 api 层那份负向守卫成对）。
//
// ⚠️ **本 spec 存在的唯一理由**（照 `views/mail/accounts/__tests__/useMailAccountsQuery.spec.ts`
//   的 W3 系列、statistics 域的同款纪律）：
//   api 层按 CLAUDE.md「queryFn Zod 守门」只发请求、不做 parse（parse 返回深拷贝，在 api 层
//   再走一遍等于每屏数据被校验并克隆两遍），所以一旦有人把 queryFn 里的
//   `xxxSchema.parse(...)` 整段删掉，api 层那份负向守卫
//   （`src/api/__tests__/mailDigest.contract.spec.ts::N1`，断言读端点不 parse）**照样全绿**，
//   而线上是「后端漏发一个字段 → 那一列整列 undefined，且零报错」。只有在这里 mock 一份
//   **坏响应**、断言它进不了 data，才能把这个洞补上。
//   **两组守卫必须成对存在**：少了 api 层那条，把 parse 搬回 api 层是零信号；少了本文件
//   这几条，把 parse 从 queryFn 删掉也是零信号。本域的写端点（保存 / preview / send）走
//   useMutation、没有 queryFn 承载，守门由 api 层 `N2` 那几条单独守，两条路径互不替代。
//
// 覆盖（每条 hook 各一条坏响应，形状照 accounts 域的 W3a / W3d）：
//   - C1：`GET /config` 少 `sender_account_id`（后端 `ConfigOut` 19 键里最新的那个）；
//   - M1：`GET /meta` 信封少 `upcoming_days_range`（前端 el-input-number 的 min/max 无源）；
//   - L1：`GET /logs` 的**行**少 `error_message`（`.strict()` 下失败行整表空，管理员看不到
//     「为什么失败」，而失败正是这条日志存在的理由）；
//   - S0：三条 hook 收到**好响应**时数据落进 data（负向用例的基线：只有坏响应守卫、没有
//     好响应基线的话，「请求压根没发出去 / 闸门没开」也是全绿）。
//
// 环境：happy-dom（vue-query 的 `useQuery` 需要一个 app 上下文跑 watch）；
// element-plus 桩成 no-op（真 `ElMessage` 在 node env 会因 `document is not defined` 抛）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, effectScope, ref, type MaybeRefOrGetter } from 'vue';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';

vi.mock('element-plus', () => ({
  ElMessage: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

const fetchMailDigestConfigMock = vi.fn();
const fetchMailDigestMetaMock = vi.fn();
const listMailDigestLogsMock = vi.fn();

vi.mock('@/api/mailDigest', () => ({
  fetchMailDigestConfig: () => fetchMailDigestConfigMock(),
  fetchMailDigestMeta: () => fetchMailDigestMetaMock(),
  listMailDigestLogs: (params: unknown) => listMailDigestLogsMock(params),
}));

import { ElMessage } from 'element-plus';
import {
  useMailDigestConfigQuery,
  useMailDigestLogsQuery,
  useMailDigestMetaQuery,
} from '../composables/useMailDigestQuery';

// ============================================================================
// fixtures（逐字照后端 DTO，键集真源见 __tests__/mailDigestKeySet.spec.ts）
// ============================================================================

/** 一条合法的 `SendResultOut`（`/send` 返它本身、`/logs` 返它构成的 items，**12 键**）。 */
const LOG_ROW = {
  log_id: '9000000000000900',
  config_version: 3,
  trigger_source: 'SCHEDULED' as const,
  status: 'SUCCESS' as const,
  subject: '2026-10-16 交期汇总',
  to_recipients: ['a@example.com'],
  cc_recipients: [],
  overdue_count: 2,
  upcoming_count: 5,
  html_bytes: 4096,
  sent_at: '2026-10-16 08:00:00',
  error_message: null,
};

/** `GET /config` 的出参（后端 `ConfigOut`，**19 键**，`.strict()`）。 */
const CONFIG = {
  id: '9000000000000800',
  version: 3,
  enabled: true,
  frequency: 'WEEKLY' as const,
  send_hour: 8,
  send_minute: 30,
  weekday: 1,
  day_of_month: null,
  recipients: ['a@example.com'],
  cc_recipients: ['b@example.com'],
  include_overdue: true,
  include_upcoming: true,
  upcoming_days: 7,
  visible_columns: ['part_no', 'customer'],
  subject_template: null,
  // ⚠️ 少这个键的症状：store 的 `senderMissing` 判据读到 undefined、「立即发送」按钮的
  // 禁用理由算不出来，管理员点下去撞后端 21701。
  sender_account_id: '9000000000000902',
  smtp_configured: true,
  created_at: '2026-10-13 08:00:00',
  updated_at: '2026-10-16 08:00:00',
};

/** `GET /meta` 的出参（后端 `MetaOut`，**4 键**；`defaults` 与 `ConfigOut` 的共享字段同构）。 */
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
  columns: [{ key: 'part_no', label: '零件号' }],
  defaults: {
    enabled: true,
    frequency: 'DAILY' as const,
    send_hour: 8,
    send_minute: 0,
    weekday: null,
    day_of_month: null,
    recipients: [],
    cc_recipients: [],
    include_overdue: true,
    include_upcoming: true,
    upcoming_days: 7,
    visible_columns: ['part_no'],
    subject_template: null,
    sender_account_id: null,
  },
  upcoming_days_range: { min: 1, max: 60 },
};

/** `GET /logs` 的出参（后端 `LogListOut`，**4 键**）。 */
const LOG_LIST = { items: [LOG_ROW], total: 1, limit: 20, offset: 0 };

let testApp: ReturnType<typeof createApp>;
let testQueryClient: QueryClient;

function mount<T>(enabled: MaybeRefOrGetter<boolean>, use: () => T) {
  const scope = effectScope();
  let comp: T | undefined;
  scope.run(() => {
    comp = testApp.runWithContext(() => use());
  });
  return { scope, comp: comp! };
}

function tick(ms = 30): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchMailDigestConfigMock.mockResolvedValue(CONFIG);
  fetchMailDigestMetaMock.mockResolvedValue(META);
  listMailDigestLogsMock.mockResolvedValue(LOG_LIST);
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
// S0：好响应基线（负向用例的前提：请求真发了、数据真落进了 data）
// ============================================================================

describe('useMailDigestQuery — 好响应落值', () => {
  it('S0：三条 hook 各自把好响应落进 data（坏响应守卫的基线）', async () => {
    const c = mount(ref(true), () => useMailDigestConfigQuery({ enabled: ref(true) }));
    const m = mount(ref(true), () => useMailDigestMetaQuery({ enabled: ref(true) }));
    const l = mount(ref(true), () =>
      useMailDigestLogsQuery({ enabled: ref(true), params: ref({ limit: 20, offset: 0 }) }),
    );
    await tick();

    expect(c.comp.query.error.value).toBeNull();
    expect(c.comp.data.value?.version).toBe(3);
    expect(m.comp.query.error.value).toBeNull();
    expect(m.comp.data.value?.upcoming_days_range.max).toBe(60);
    expect(l.comp.query.error.value).toBeNull();
    expect(l.comp.data.value?.items).toHaveLength(1);
    c.scope.stop();
    m.scope.stop();
    l.scope.stop();
  });
});

// ============================================================================
// C1 / M1 / L1：坏响应 ⇒ queryFn 里的 parse 必须拦住（parse 真接在返回路径上）
// ============================================================================

describe('useMailDigestConfigQuery — 坏响应守门（C1）', () => {
  it('C1：config 少 sender_account_id ⇒ 进 error 态、data 不落值', async () => {
    // Zod 的 strip 默认会把缺字段**悄悄吞掉**让页面照常渲染那一列的 undefined ——
    // queryFn 里的 parse 就是为拦住这个（少声明 ≠ 少一列，而是整条抛）。
    const broken: Record<string, unknown> = { ...CONFIG };
    delete broken['sender_account_id'];
    fetchMailDigestConfigMock.mockResolvedValue(broken);

    const { scope, comp } = mount(ref(true), () =>
      useMailDigestConfigQuery({ enabled: ref(true) }),
    );
    await tick();

    expect(comp.query.error.value, '缺 sender_account_id 应当抛').not.toBeNull();
    expect(comp.data.value).toBeUndefined();
    // 错误桥接必须弹一次（否则坏契约在页面上是彻底静默的：表空 + 无提示）。
    expect(ElMessage.error).toHaveBeenCalled();
    scope.stop();
  });
});

describe('useMailDigestMetaQuery — 坏响应守门（M1）', () => {
  it('M1：meta 少 upcoming_days_range ⇒ 进 error 态（天数输入框的 min/max 无源）', async () => {
    const { upcoming_days_range: _drop, ...noRange } = META;
    fetchMailDigestMetaMock.mockResolvedValue(noRange);

    const { scope, comp } = mount(ref(true), () => useMailDigestMetaQuery({ enabled: ref(true) }));
    await tick();

    expect(comp.query.error.value).not.toBeNull();
    expect(comp.data.value).toBeUndefined();
    scope.stop();
  });

  it('M1b：meta 整段形状错（顶层是裸数组）⇒ 进 error 态', async () => {
    fetchMailDigestMetaMock.mockResolvedValue([META]);

    const { scope, comp } = mount(ref(true), () => useMailDigestMetaQuery({ enabled: ref(true) }));
    await tick();

    expect(comp.query.error.value).not.toBeNull();
    expect(comp.data.value).toBeUndefined();
    scope.stop();
  });
});

describe('useMailDigestLogsQuery — 坏响应守门（L1）', () => {
  it('L1：日志行少 error_message ⇒ 整表进 error 态（失败行正是这张表存在的理由）', async () => {
    const { error_message: _drop, ...noMsg } = LOG_ROW;
    listMailDigestLogsMock.mockResolvedValue({ ...LOG_LIST, items: [noMsg] });

    const { scope, comp } = mount(ref(true), () =>
      useMailDigestLogsQuery({ enabled: ref(true), params: ref({ limit: 20, offset: 0 }) }),
    );
    await tick();

    expect(comp.query.error.value, '缺 error_message 应当抛').not.toBeNull();
    expect(comp.data.value).toBeUndefined();
    scope.stop();
  });

  it('L1b：信封形状错（items 不是数组）⇒ 进 error 态', async () => {
    // 写成 `z.array` 时症状是「每一屏都抛、列表恒空、零告警」；反过来守门写成裸数组则
    // 是在放行一个不存在的契约。
    listMailDigestLogsMock.mockResolvedValue({ ...LOG_LIST, items: LOG_ROW });

    const { scope, comp } = mount(ref(true), () =>
      useMailDigestLogsQuery({ enabled: ref(true), params: ref({ limit: 20, offset: 0 }) }),
    );
    await tick();

    expect(comp.query.error.value).not.toBeNull();
    expect(comp.data.value).toBeUndefined();
    scope.stop();
  });
});
