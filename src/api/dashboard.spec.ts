// src/api/dashboard.spec.ts
//
// 2026-09-28 重构：原订阅 / 取消订阅控制帧测试全部删除（subscribe/unsubscribe
// 帧随控制帧发送逻辑一起删除）。覆盖：
//   - URL 拼接（带 token）
//   - fetchDashboardSnapshot / fetchUpcomingDelivery / fetchDeliveryOrders 三个
//     HTTP 端点（mock api.get）
//   - reconnectDashboard() 公开 API
// FakeWebSocket 桩保留（VueUse 内部仍是 new WebSocket(url)，实例计数可用）。
//
// 2026-10-01 修复 WS「控制台一直报错」三缺陷后新增覆盖：
//   - **无 token 时零连接尝试**（旧实现拿裸 URL 握手 → 后端必回 40100，是刷屏源头）
//   - **'auth:session-changed' 驱动 URL 重算**：换 token → 重连；token=null → 关闭
//   - **logout → 不刷新页面 → 重新登录** 全链路（登录前零实例，登录后带 token 的实例）
//   - **失败握手 → 退避重连序列**（1s/2s/4s/8s/10s 封顶，不封顶次数）
//   - **失败日志降噪**：前 3 次带完整诊断对象，之后每 30 次一行
//
// 2026-10-02 后端补完主动 Close 帧（此前全仓零发送，浏览器只见 1006）后新增覆盖：
//   - **close 4001（会话失效）→ 停止重连**：进 60s 也不产生新 WebSocket 实例
//   - **close 1006 → 仍按退避重连**：防「把所有关闭码都停掉」这种过度处理回归
//   - **close 4001 → 派发 'auth:session-lost'** + 清 localStorage 会话
//   - **close 4003（慢消费方丢事件）→ 派发 'dashboard:full-refetch'** 且仍重连
//     （review Major 2：后端规定动作是「重连 + 全量 HTTP 重取」，而重连后的首帧
//     snapshot 在本层被 no-op 丢掉 ⇒ 补数据只能靠这个信号）
//
// 关闭码 fixture 的 reason 字符串**必须与后端实际发送值一致**（4001 → 'auth expired'、
// 4003 → 'lagged'，见后端 docs/api/websocket.md 关闭码表）。本 spec 是后人查关闭码表
// 的第一现场，写一个后端从不发送的 reason 会诱导后来人去 match reason 文案。
// 2026-10-02 修正：原 4001 用例写的是 'session invalid'（后端从不发这个值）。
//
// createGlobalState 惰性语义：模块顶层不创建 socket，仅注册 listener；首次调
// 用 onDashboardEvent / onDashboardStatus / reconnectDashboard / closeDashboard
// 才触发 useWebSocket 工厂内部 new WebSocket()。测试通过 onDashboardStatus
// 触发实例化。
//
// happy-dom 环境：VueUse useWebSocket 依赖 document / window（isClient 检查 +
// autoClose 注册 beforeunload 监听），node env 下 stub document 仍会让 Vue
// runtime-dom 的 createElement 等 DOM 钩子抛错。切 happy-dom 让 happy-dom 自身
// 撑起 document / window，我们只 stub WebSocket / localStorage 覆盖目标行为。

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class FakeWebSocket {
  public static readonly CONNECTING = 0;
  public static readonly OPEN = 1;
  public static readonly CLOSING = 2;
  public static readonly CLOSED = 3;

  public static instances: FakeWebSocket[] = [];

  public readonly url: string;
  public readyState = FakeWebSocket.CONNECTING;
  public readonly send = vi.fn();
  public onopen: (() => void) | null = null;
  public onmessage: ((event: { data: string }) => void) | null = null;
  public onerror: (() => void) | null = null;
  public onclose: ((event: { code?: number; reason?: string }) => void) | null = null;

  public constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  public open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  /** 模拟服务端关闭（VueUse 会自动 autoReconnect 重连，retried++）。 */
  public closeWith(ev: { code?: number; reason?: string } = {}): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.(ev);
  }

  public close(): void {
    this.closeWith({});
  }

  /** 2026-10-01 新增：模拟**握手失败**。
   *
   *  浏览器行为是：握手被拒（后端在 upgrade 前直接回 401 / 代理不回响应）时先 fire
   *  error，再 fire code=1006 的 close，且 close 事件里**没有** status / reason。
   *  这两个事件成对出现是 onError 只置标记、由 onDisconnected 统一计数出日志的依据。 */
  public failHandshake(code = 1006): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onerror?.();
    this.onclose?.({ code });
  }

  /** 模拟服务端推送业务事件。 */
  public pushEvent(eventType: string, data: Record<string, unknown> = {}): void {
    this.onmessage?.({
      data: JSON.stringify({
        type: 'event',
        event_type: eventType,
        data,
        ts: '2026-09-28T10:00:00+08:00',
      }),
    });
  }
}

const httpGetMock = vi.fn();

vi.mock('@/api/http', () => ({
  api: {
    get: (...args: unknown[]) => httpGetMock(...args),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
  cleanParams: (obj?: Record<string, unknown>) => obj ?? {},
  ApiError: class ApiError extends Error {
    public readonly code: number;
    public constructor(code: number, message: string) {
      super(message);
      this.code = code;
    }
  },
}));

/** 默认 token：多数用例关心的是「有 token 时的行为」。 */
const DEFAULT_TOKEN = 'mock-jwt-token';

/** 造一个 payload 里带指定 exp 的假 JWT（utils/jwt 的 decodeJwt 只解 payload，
 *  不验签，所以测试里无需真签名）。 */
function makeJwtWithExp(expEpochSec: number): string {
  const payload = btoa(
    JSON.stringify({
      sub: '180000000000001',
      aud: 'hsh-erp-rust',
      iat: expEpochSec - 900,
      nbf: expEpochSec - 900,
      exp: expEpochSec,
      iss: 'hsh-erp-rust',
      jti: 'test-jti',
      typ: 'access',
    }),
  )
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `header.${payload}.signature`;
}

/** 触发 createGlobalState 工厂 → 内部 useWebSocket.immediate.open() 创建 socket。 */
async function bootstrapSocket(api: Awaited<ReturnType<typeof loadDashboardApi>>): Promise<void> {
  api.onDashboardStatus(() => undefined);
}

/** 派发 auth:session-changed 后让 Vue 调度队列 + 微任务跑完
 *  （VueUse 的 watch(urlRef, open) 走 Vue scheduler，不是 setTimeout）。 */
async function flushVue(): Promise<void> {
  await new Promise((r) => setTimeout(r, 50));
}

async function loadDashboardApi(opts: { token?: string | null } = {}) {
  const token = opts.token === undefined ? DEFAULT_TOKEN : opts.token;
  vi.resetModules();
  FakeWebSocket.instances = [];
  httpGetMock.mockReset();
  vi.stubGlobal('WebSocket', FakeWebSocket);
  // happy-dom 默认 host 是 'localhost:3000'，dashboard.ts 读 location.host 拼 URL，
  // 这里 stub 到 dev 端口保持断言可读。
  vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:5173' });
  vi.stubGlobal('localStorage', {
    getItem: vi.fn(() => (token === null ? null : JSON.stringify({ token }))),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  });
  return import('./dashboard');
}

/** 可变 token 的 localStorage 桩：模拟「拦截器刷新 / 登录写入 / 登出删除」三条路径。 */
function stubMutableToken(initial: string | null): { set: (t: string | null) => void } {
  let current = initial;
  vi.stubGlobal('localStorage', {
    getItem: vi.fn(() => (current === null ? null : JSON.stringify({ token: current }))),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  });
  return {
    set: (t: string | null) => {
      current = t;
    },
  };
}

// ============================================================================
// 生命周期钩子（文件级，单一实现）
//
// 2026-09-28 review 第 2 轮修复（N4）：dashboard.ts 在模块顶层注册
// window.addEventListener('auth:session-changed')。vi.resetModules() 不清 DOM
// listener，前一条用例挂的 listener 会累积在 window 上 → 后续 dispatchEvent
// 触发多个陈旧模块实例的 syncWsUrl()，各自建连，产生「实例计数对不上 / 串扰」。
// 2026-10-01：这里改成**文件级唯一**一套钩子。
//   - 之前把 spy 分散在父 / 子 describe 的 beforeEach 里，vi.spyOn 对已 mock 的
//     方法会返回同一个 mock，于是子 beforeEach 里 `const realAdd =
//     window.addEventListener.bind(window)` 拿到的是 mock 自己 → mockImplementation
//     内自调用 → RangeError: Maximum call stack size exceeded。
//   - 集中到文件级后每个用例只会安装一次 spy，且只有一处清理点，不存在嵌套。
// ============================================================================

/** 本轮用例期间注册到 window 上的 auth 事件 listener（用于 afterEach 清理）。 */
const authEventListeners: Array<[string, EventListener]> = [];

beforeEach(() => {
  vi.useRealTimers();
  FakeWebSocket.instances = [];
  httpGetMock.mockReset();
  authEventListeners.length = 0;

  const realAdd = window.addEventListener.bind(window);
  vi.spyOn(window, 'addEventListener').mockImplementation(((
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ) => {
    const result = realAdd(type, listener, options);
    if (
      (type === 'auth:session-changed' ||
        type === 'auth:tokens-refreshed' ||
        // 2026-10-02 新增：4001 用例自己也往 window 上挂 'auth:session-lost' 收集器，
        // 挂进来一起记，afterEach 统一清，避免 listener 在用例之间泄漏。
        type === 'auth:session-lost' ||
        // 2026-10-02 新增：4003 用例挂 'dashboard:full-refetch' 收集器，同上。
        type === 'dashboard:full-refetch') &&
      typeof listener === 'function'
    ) {
      authEventListeners.push([type, listener]);
    }
    return result;
  }) as typeof window.addEventListener);
});

afterEach(() => {
  for (const [type, listener] of authEventListeners.splice(0)) {
    window.removeEventListener(type, listener);
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('dashboard WebSocket 单例（VueUse useWebSocket + createGlobalState 2026-09-28）', () => {
  it('URL 带 token 拼接：localStorage 有 token 时 ?token=xxx', async () => {
    const api = await loadDashboardApi({ token: DEFAULT_TOKEN });
    await bootstrapSocket(api);

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0]?.url).toBe(
      `ws://localhost:5173/ws/dashboard?token=${DEFAULT_TOKEN}`,
    );
  });

  it('reconnectDashboard() 显式重连：open() 调用产生新 socket', async () => {
    const api = await loadDashboardApi();
    await bootstrapSocket(api);
    expect(FakeWebSocket.instances).toHaveLength(1);

    api.reconnectDashboard();

    expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(2);
  });

  it('closeDashboard() 关闭长连接：readyState 变 CLOSED', async () => {
    const api = await loadDashboardApi();
    await bootstrapSocket(api);
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    expect(socket.readyState).toBe(FakeWebSocket.OPEN);

    api.closeDashboard();

    // VueUse close 内部会调 ws.close() → readyState 变 CLOSED
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
  });

  it('onDashboardEvent 接收业务事件分发', async () => {
    const api = await loadDashboardApi();
    await bootstrapSocket(api);
    const handler = vi.fn();
    api.onDashboardEvent(handler);

    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    socket.pushEvent('PART_TO_SHIP', { part_id: '180000000000001' });

    expect(handler).toHaveBeenCalledTimes(1);
    const ev = handler.mock.calls[0]?.[0] as { event_type: string; data: Record<string, unknown> };
    expect(ev.event_type).toBe('PART_TO_SHIP');
    expect(ev.data.part_id).toBe('180000000000001');
  });

  it('onDashboardStatus 接收连接状态变更（OPEN / CLOSED）', async () => {
    const api = await loadDashboardApi();
    const statusHandler = vi.fn();
    api.onDashboardStatus(statusHandler);
    // 这里 onDashboardStatus 自身已经触发 socket 创建

    const socket = FakeWebSocket.instances[0]!;
    socket.open(); // → 触发 'open'

    expect(statusHandler).toHaveBeenCalledWith('open');

    socket.closeWith({}); // → 触发 'closed'
    expect(statusHandler).toHaveBeenCalledWith('closed');
  });

  it('snapshot 帧不再派发到 onDashboardEvent 订阅者（HTTP 全量首取已替代）', async () => {
    const api = await loadDashboardApi();
    await bootstrapSocket(api);
    const handler = vi.fn();
    api.onDashboardEvent(handler);

    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    socket.onmessage?.({
      data: JSON.stringify({
        type: 'snapshot',
        data: {
          overdue_count: 0,
          in_inspection_count: 0,
          in_process: [],
          system_delivery_orders: { urgent: [], partial: [] },
          ts: 'x',
        },
        ts: 'x',
      }),
    });

    // snapshot 帧直接忽略，不应再触发 event handler
    expect(handler).not.toHaveBeenCalled();
  });

  it('fetchDashboardSnapshot：HTTP GET /api/v2/dashboard/snapshot，返回解封后 data', async () => {
    const api = await loadDashboardApi();
    const sample = {
      overdue_count: 12,
      in_inspection_count: 4,
      in_process: [],
      system_delivery_orders: { urgent: [], partial: [] },
      ts: '2026-10-07T14:30:00.123+08:00',
    };
    httpGetMock.mockResolvedValue({ data: sample });

    const result = await api.fetchDashboardSnapshot();

    // 端点不接受任何 query 参数（交期分桶已拆到 /dashboard/upcoming-delivery），
    // 故不传 config —— 少一个 params 段，axum 的 Query 提取器拿到空 map。
    expect(httpGetMock).toHaveBeenCalledWith('/dashboard/snapshot');
    expect(result).toEqual(sample);
  });

  it('fetchUpcomingDelivery：basis + days 进查询串，GET /dashboard/upcoming-delivery', async () => {
    const api = await loadDashboardApi();
    const sample = {
      today: '2026-10-07',
      buckets: [{ date: '2026-10-07', count: 8, by_status: { IN_PROCESS: 3 } }],
      ts: '2026-10-07T14:30:00.123+08:00',
    };
    httpGetMock.mockResolvedValue({ data: sample });

    const result = await api.fetchUpcomingDelivery({ basis: 'system', days: 14 });
    expect(httpGetMock).toHaveBeenCalledWith('/dashboard/upcoming-delivery', {
      params: { basis: 'system', days: 14 },
    });
    expect(result).toEqual(sample);

    // cleanParams 剔 undefined：不传的字段根本不出现在请求对象里
    await api.fetchUpcomingDelivery({});
    expect(httpGetMock).toHaveBeenLastCalledWith('/dashboard/upcoming-delivery', { params: {} });
  });

  it('fetchDeliveryOrders：statuses 数组拼成逗号分隔单值，GET /dashboard/delivery-orders', async () => {
    const api = await loadDashboardApi();
    const sample = {
      date: '2026-10-07',
      basis: 'system',
      total: 17,
      items: [],
      ts: '2026-10-07T14:30:00.123+08:00',
    };
    httpGetMock.mockResolvedValue({ data: sample });

    const result = await api.fetchDeliveryOrders({
      date: '2026-10-07',
      statuses: ['PENDING', 'IN_PROCESS', 'OUTSOURCE'],
      basis: 'system',
    });

    // 后端 axum Query 把 statuses 反序列化成逗号分隔的单值；发重复 key 取不到期望形态
    // 直接 400，故这里必须 join(',') 而不是把数组原样发出去。
    expect(httpGetMock).toHaveBeenCalledWith('/dashboard/delivery-orders', {
      params: { date: '2026-10-07', statuses: 'PENDING,IN_PROCESS,OUTSOURCE', basis: 'system' },
    });
    expect(result).toEqual(sample);

    // basis 不传时被 cleanParams 剔掉（后端缺省 system）
    await api.fetchDeliveryOrders({ date: '2026-10-07', statuses: ['DELIVERED'] });
    expect(httpGetMock).toHaveBeenLastCalledWith('/dashboard/delivery-orders', {
      params: { date: '2026-10-07', statuses: 'DELIVERED' },
    });
  });
});

// ============================================================================
// 2026-10-01：无 token 不连接（WS 控制台刷屏的根因之一）
// ============================================================================

describe('dashboard WS：无 token 时零连接尝试', () => {
  it('localStorage 无 token → 一个 WebSocket 都不建（不再拿裸 URL 换 40100）', async () => {
    // 2026-10-01 回归 guard。旧实现是 buildWsUrl(null) → 裸路径 URL →
    // 照样 new WebSocket → 后端 handler.rs:85 回 401「缺少 token 查询参数」
    // → autoReconnect 无限重试 → 控制台永远刷 WS 报错。
    // 新实现把 URL 置 undefined，VueUse `_init()` 首行守卫直接返回。
    const api = await loadDashboardApi({ token: null });
    await bootstrapSocket(api);

    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('无 token 时订阅 onDashboardEvent 也不会建连接', async () => {
    const api = await loadDashboardApi({ token: null });
    api.onDashboardEvent(() => undefined);
    expect(FakeWebSocket.instances).toHaveLength(0);
  });
});

// ============================================================================
// 2026-10-01：auth:session-changed 驱动 URL 重算（覆盖 login/logout/token 刷新）
// ============================================================================

describe('dashboard WS：auth:session-changed 驱动 token 生命周期', () => {
  it('token 被刷新（http.ts persistTokens 派发）→ URL 换新 token 并重连', async () => {
    const stub = stubMutableToken('old-token');
    vi.resetModules();
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:5173' });
    const api = await import('./dashboard');
    await bootstrapSocket(api);

    expect(FakeWebSocket.instances[0]?.url).toBe('ws://localhost:5173/ws/dashboard?token=old-token');

    // 拦截器刷新成功：localStorage 已是新 token + dispatch auth:session-changed
    stub.set('new-token');
    window.dispatchEvent(
      new CustomEvent('auth:session-changed', { detail: { token: 'new-token' } }),
    );
    await flushVue();

    expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(2);
    expect(FakeWebSocket.instances[1]?.url).toBe('ws://localhost:5173/ws/dashboard?token=new-token');
  });

  it('登出（detail.token = null）→ 关闭连接且不再重连', async () => {
    // 2026-10-01 回归 guard。少了这条，登出后 WS 会继续拿着已被吊销的
    // session 重连（后端 40105），控制台一直刷错直到关页面。
    const stub = stubMutableToken('live-token');
    vi.resetModules();
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:5173' });
    const api = await import('./dashboard');
    await bootstrapSocket(api);

    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    expect(FakeWebSocket.instances).toHaveLength(1);

    stub.set(null);
    window.dispatchEvent(
      new CustomEvent('auth:session-changed', { detail: { token: null } }),
    );
    await flushVue();

    // 老 socket 被 close
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
    // 且不产生新连接
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('logout → 不刷新页面 → 重新登录：登录后用新 token 建连', async () => {
    // 2026-10-01 回归 guard，覆盖「旧实现 computed 缓存住登出前 token」这个 bug：
    // 旧 URL 不会因 login 更新 → WS 一直拿吊销 token 重连。
    const stub = stubMutableToken('old-token');
    vi.resetModules();
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:5173' });
    const api = await import('./dashboard');
    await bootstrapSocket(api);
    expect(FakeWebSocket.instances[0]?.url).toContain('token=old-token');

    // logout：store 清 localStorage 后派发 null
    stub.set(null);
    window.dispatchEvent(new CustomEvent('auth:session-changed', { detail: { token: null } }));
    await flushVue();
    expect(FakeWebSocket.instances).toHaveLength(1);

    // login：store 的 loginMutation.onSuccess 写入新 token 后派发
    stub.set('fresh-token');
    window.dispatchEvent(
      new CustomEvent('auth:session-changed', { detail: { token: 'fresh-token' } }),
    );
    await flushVue();

    expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(2);
    expect(FakeWebSocket.instances.at(-1)?.url).toBe(
      'ws://localhost:5173/ws/dashboard?token=fresh-token',
    );
  });

  it('token 未变时不重连（syncWsUrl 值相等短路）', async () => {
    // 防止 refresh 事件高频派发导致无谓 close/reconnect 抖动。
    const api = await loadDashboardApi({ token: DEFAULT_TOKEN });
    await bootstrapSocket(api);
    expect(FakeWebSocket.instances).toHaveLength(1);

    window.dispatchEvent(
      new CustomEvent('auth:session-changed', { detail: { token: DEFAULT_TOKEN } }),
    );
    await flushVue();

    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});

// ============================================================================
// 2026-10-01：失败握手的退避重连 + 诊断日志降噪
// ============================================================================

describe('dashboard WS：连接失败的退避重连与诊断', () => {
  beforeEach(() => {
    // 只 fake 定时器，Vue scheduler 走 microtask 不受影响。
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  /** 推进 fake timer，让 VueUse 的 autoReconnect setTimeout 链逐个触发。 */
  function advanceRetries(totalMs: number): void {
    let elapsed = 0;
    // 每次推进 1s 粒度足够覆盖 10s 封顶的退避，且不会跨过 setTimeout。
    while (elapsed < totalMs) {
      vi.advanceTimersByTime(1_000);
      elapsed += 1_000;
    }
  }

  it('握手失败（error + close 1006）→ 按 1s/2s/4s/8s/10s 退避重连，不封顶次数', async () => {
    // 2026-10-01 回归 guard：旧实现在 vite 缺 /ws 代理的环境下就是这条路径
    // （每次 attempt 两条 console.error），是用户报告「控制台一直报 WS 错」的机制。
    const api = await loadDashboardApi();
    await bootstrapSocket(api);
    expect(FakeWebSocket.instances).toHaveLength(1);

    // 第 1 次失败 → 1s 后第 2 个实例
    FakeWebSocket.instances[0]!.failHandshake();
    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(999);
    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(2);

    // 第 2 次失败 → 2s 后第 3 个
    FakeWebSocket.instances[1]!.failHandshake();
    vi.advanceTimersByTime(1_999);
    expect(FakeWebSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(3);

    // 第 3 次 → 4s 后第 4 个
    FakeWebSocket.instances[2]!.failHandshake();
    vi.advanceTimersByTime(4_000);
    expect(FakeWebSocket.instances).toHaveLength(4);

    // 第 4 次 → 8s 后第 5 个
    FakeWebSocket.instances[3]!.failHandshake();
    vi.advanceTimersByTime(8_000);
    expect(FakeWebSocket.instances).toHaveLength(5);

    // 第 5 次 → 10s 后第 6 个（退避封顶）
    FakeWebSocket.instances[4]!.failHandshake();
    vi.advanceTimersByTime(10_000);
    expect(FakeWebSocket.instances).toHaveLength(6);

    // 第 6 次 → 仍是 10s（不封顶：WS 是 dashboard 唯一更新通道，
    // 放弃重连会让页面静默停止刷新，比刷屏更糟）
    FakeWebSocket.instances[5]!.failHandshake();
    advanceRetries(60_000);
    expect(FakeWebSocket.instances.length).toBeGreaterThan(6);
  });

  it('失败日志带可诊断字段（脱敏 URL / closeCode / 次数），且不再用 console.error 刷屏', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const api = await loadDashboardApi({ token: 'super-secret-jwt' });
    await bootstrapSocket(api);

    FakeWebSocket.instances[0]!.failHandshake();

    // 一次失败只出一条日志（error + close 成对到达，不重复计数）
    expect(warn).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();

    const detail = warn.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(detail.closeCode).toBe(1006);
    expect(detail.hadErrorEvent).toBe(true);
    // JWT 必须脱敏（否则会进 nginx access log / 报错截图）
    expect(String(detail.url)).not.toContain('super-secret-jwt');
    expect(String(detail.url)).toContain('token=***');
    expect(String(warn.mock.calls[0]?.[0])).toContain('第 1 次连接失败');
  });

  it('日志降噪：前 3 次打完整诊断，之后每 30 次才打一行', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const api = await loadDashboardApi();
    await bootstrapSocket(api);

    // 前 3 次：每次一条
    for (let i = 0; i < 3; i += 1) {
      const socket = FakeWebSocket.instances.at(-1)!;
      socket.failHandshake();
      vi.advanceTimersByTime(10_000);
    }
    expect(warn).toHaveBeenCalledTimes(3);

    // 第 4~29 次：静默（不刷屏）
    for (let i = 0; i < 26; i += 1) {
      FakeWebSocket.instances.at(-1)!.failHandshake();
      vi.advanceTimersByTime(10_000);
    }
    expect(warn).toHaveBeenCalledTimes(3);

    // 第 30 次：恢复一条
    FakeWebSocket.instances.at(-1)!.failHandshake();
    vi.advanceTimersByTime(10_000);
    expect(warn).toHaveBeenCalledTimes(4);
    expect(String(warn.mock.calls[3]?.[0])).toContain('第 30 次连接失败');
  });

  it('连接恢复后失败计数归零（下次失败重新从第 1 次打）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const api = await loadDashboardApi();
    await bootstrapSocket(api);

    // 攒到 5 次失败（只有前 3 次 + 每 30 次会打，这里都静默）
    for (let i = 0; i < 5; i += 1) {
      FakeWebSocket.instances.at(-1)!.failHandshake();
      vi.advanceTimersByTime(10_000);
    }
    expect(warn).toHaveBeenCalledTimes(3);

    // 这次成功握手
    FakeWebSocket.instances.at(-1)!.open();
    // 连接被服务端掐断 → 计数应回到 1
    FakeWebSocket.instances.at(-1)!.failHandshake();
    expect(warn).toHaveBeenCalledTimes(4);
    expect(String(warn.mock.calls[3]?.[0])).toContain('第 1 次连接失败');
  });

  it('token 已过期时诊断里 tokenExpired=true（便于区分 40102 与代理/后端故障）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // 1006 无法区分 401/502/代理缺失（浏览器不暴露握手期 status），
    // 但「token 是不是已经过期」在 app 内可判定 —— 这是本次加它的唯一目的。
    const expired = makeJwtWithExp(Math.floor(Date.now() / 1000) - 60);
    const api = await loadDashboardApi({ token: expired });
    await bootstrapSocket(api);

    FakeWebSocket.instances[0]!.failHandshake();

    const detail = warn.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(detail.tokenExpired).toBe(true);
  });

  it('token 仍有效时诊断里 tokenExpired=false', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const valid = makeJwtWithExp(Math.floor(Date.now() / 1000) + 600);
    const api = await loadDashboardApi({ token: valid });
    await bootstrapSocket(api);

    FakeWebSocket.instances[0]!.failHandshake();

    const detail = warn.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(detail.tokenExpired).toBe(false);
  });
});

// ============================================================================
// 2026-10-02：后端补完主动 Close 帧后的关闭码分流
//
// 后端 ws_hub 从「零发送 Close 帧（所有断开都是裸 drop，浏览器只见 1006）」改成
// 主动发 Close 帧，带上语义关闭码（关闭码表见后端 docs/api/websocket.md）：
//   1011 内部错误 / 1012 服务重启 / 4003 慢消费方
//     → 瞬时或可自愈，**必须继续无限重试**（WS 是 dashboard 唯一更新通道）；
//   4001 会话在连接期间失效
//     → 唯一终止性关闭码。再重试多少次都是 401，属于死路。
//   1001 后端不主动发（写失败路径已改裸断），前端无分支，保留在码表里仅作对照。
//
// 没有这个分流时 4001 会退化成「无限重试 → 每次握手又被判 401 → 控制台刷屏」，
// 即 2026-10-01 刚修掉的 logout 死循环 bug 的另一面。
// ============================================================================

describe('dashboard WS：关闭码 4001（会话失效）停止重连', () => {
  beforeEach(() => {
    // 同样只 fake 定时器：VueUse 的 watch(urlRef, open) 走 Vue scheduler（微任务），
    // 不会被 fake；重连的 setTimeout 链则完全被 fake 住，才能断言「60s 内不建连」。
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  /** 冲刷 Vue 微任务队列（`Promise.then` 链），让 watch(urlRef, open) 真正跑一遍。 */
  async function flushMicrotasks(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }

  it('close 4001 → 不再产生新 WebSocket 实例（停止重连，进 60s 也不连）', async () => {
    const api = await loadDashboardApi();
    await bootstrapSocket(api);
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    expect(FakeWebSocket.instances).toHaveLength(1);

    // 后端主动 Close 帧：会话在连接期间失效（注意不带 error 事件，真实浏览器行为）
    socket.closeWith({ code: 4001, reason: 'auth expired' });

    // 停重连的关键时序：VueUse 在 onDisconnected 返回后才 setTimeout(_init, 1s)，
    // 本次写入 undefined 触发的 watch → open() → close() → resetRetry() 要先把
    // 那个定时器掐掉，所以要冲一次微任务。
    await flushMicrotasks();
    expect(FakeWebSocket.instances).toHaveLength(1);

    // 退避封顶只有 10s，这里推进 60s：若哨兵失效，1s/2s/4s/8s/10s 各建一个新实例。
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('close 1006 → 仍按退避重连（防回归：别把正常网络抖动也停掉）', async () => {
    // 1006 是「原因未知的异常关闭」兜底码（没收到任何 Close 帧），后端故障 / 代理
    // 掐断 / 休眠唤醒都会落到它。它必须继续无限重试，否则 dashboard 静默停止刷新。
    const api = await loadDashboardApi();
    await bootstrapSocket(api);
    const socket = FakeWebSocket.instances[0]!;
    socket.open();

    socket.closeWith({ code: 1006 });
    expect(FakeWebSocket.instances).toHaveLength(1);

    // 第 1 次重试退避 1s
    vi.advanceTimersByTime(999);
    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(2);

    // 继续第 2 次（2s）——证明是「一直重连」而不是「碰巧连了一次」
    FakeWebSocket.instances[1]!.closeWith({ code: 1006 });
    vi.advanceTimersByTime(2_000);
    expect(FakeWebSocket.instances).toHaveLength(3);
  });

  it('close 4001 → 派发 auth:session-lost（供 app 层 forceLogout 走登出）', async () => {
    const lost = vi.fn();
    // 经文件级 addEventListener spy 记账 → afterEach 统一 removeEventListener。
    window.addEventListener('auth:session-lost', lost);

    const api = await loadDashboardApi();
    await bootstrapSocket(api);
    const socket = FakeWebSocket.instances[0]!;
    socket.open();

    socket.closeWith({ code: 4001, reason: 'auth expired' });

    expect(lost).toHaveBeenCalledTimes(1);
    const detail = (lost.mock.calls[0]?.[0] as CustomEvent<{ code: number; reason: string | null }>)
      .detail;
    expect(detail).toEqual({ code: 4001, reason: 'auth expired' });

    // 同时清掉 localStorage 会话：后端已判定失效，本地留着只会让下一次握手继续 401。
    const removeItem = localStorage.removeItem as unknown as ReturnType<typeof vi.fn>;
    expect(removeItem).toHaveBeenCalledWith('auth_session');
  });

  // ==========================================================================
  // 2026-10-02 修复（review Major 2）：4003「慢消费方」丢事件 → 补一次全量重取
  //
  // 后端 websocket.md 关闭码表 4003 行的规定动作是「重连 + 全量 HTTP 重取」，
  // 且成立前提写的是「重连时自然重新收到首帧 snapshot」。本仓 dashboard 域是
  // 「HTTP 全量首取 + WS 事件 invalidate 重取」，重连后的首帧 snapshot 被显式
  // no-op 丢弃（api/dashboard.ts 的 dispatch()）⇒ 该前提不成立，重连补不回来
  // 丢掉的事件，必须由 WS 层额外派发 'dashboard:full-refetch' 让上层立即 invalidate。
  // ==========================================================================

  it('close 4003 → 派发 dashboard:full-refetch（丢的事件重连补不回来）', async () => {
    const fullRefetch = vi.fn();
    window.addEventListener('dashboard:full-refetch', fullRefetch);

    const api = await loadDashboardApi();
    await bootstrapSocket(api);
    const socket = FakeWebSocket.instances[0]!;
    socket.open();

    // 后端广播队列（容量 1024）溢出 → 永久丢了 n 条事件 → 4003 lagged
    socket.closeWith({ code: 4003, reason: 'lagged' });

    expect(fullRefetch).toHaveBeenCalledTimes(1);
    const detail = (
      fullRefetch.mock.calls[0]?.[0] as CustomEvent<{ code: number; reason: string | null }>
    ).detail;
    expect(detail).toEqual({ code: 4003, reason: 'lagged' });
  });

  it('close 4003 → 仍按退避重连（4003 是非终止性码，只补数据不停连接）', async () => {
    const fullRefetch = vi.fn();
    window.addEventListener('dashboard:full-refetch', fullRefetch);

    const api = await loadDashboardApi();
    await bootstrapSocket(api);
    const socket = FakeWebSocket.instances[0]!;
    socket.open();

    socket.closeWith({ code: 4003, reason: 'lagged' });
    // 会话没死 ⇒ 停重连就是回归（4001 专属行为，绝不能外溢到 4003）
    vi.advanceTimersByTime(999);
    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('close 1006 / 4001 → 不派发 dashboard:full-refetch（防信号外溢）', async () => {
    const fullRefetch = vi.fn();
    window.addEventListener('dashboard:full-refetch', fullRefetch);

    const api = await loadDashboardApi();
    await bootstrapSocket(api);
    FakeWebSocket.instances[0]!.open();
    FakeWebSocket.instances[0]!.closeWith({ code: 1006 });
    // 1006 同样会因断连丢事件，但那是既有架构的已知缺口（无轮询），本轮刻意不扩范围：
    // 4003 是后端**明确告知**「永久丢了 n 条」的码，只有它配得上「全量重取」这个动作。
    expect(fullRefetch).not.toHaveBeenCalled();

    // 推进退避建第 2 个连接，再喂 4001（终止性码，同样不该触发全量重取）
    vi.advanceTimersByTime(1_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
    FakeWebSocket.instances[1]!.open();
    FakeWebSocket.instances[1]!.closeWith({ code: 4001, reason: 'auth expired' });
    expect(fullRefetch).not.toHaveBeenCalled();
  });
});
