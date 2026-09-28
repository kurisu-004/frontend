// src/api/dashboard.spec.ts
//
// 2026-09-28 重构：原订阅 / 取消订阅控制帧测试全部删除（subscribe/unsubscribe
// 帧随控制帧发送逻辑一起删除，2026-09-28 决策）。新增覆盖：
//   - URL 拼接（带 token）
//   - auth:tokens-refreshed 事件触发 tokenVersion++ → VueUse 自动重连
//   - fetchDashboardSnapshot HTTP + Zod parse 集成（mock api.get）
//   - reconnectDashboard() 公开 API
// FakeWebSocket 桩保留（VueUse 内部仍是 new WebSocket(url)，实例计数可用）。
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
  apiPrint: { get: vi.fn(), post: vi.fn() },
  cleanParams: (obj?: Record<string, unknown>) => obj ?? {},
  ApiError: class ApiError extends Error {
    public readonly code: number;
    public constructor(code: number, message: string) {
      super(message);
      this.code = code;
    }
  },
}));

/** 触发 createGlobalState 工厂 → 内部 useWebSocket.immediate.open() 创建 socket。 */
async function bootstrapSocket(api: Awaited<ReturnType<typeof loadDashboardApi>>): Promise<void> {
  api.onDashboardStatus(() => undefined);
}

async function loadDashboardApi() {
  vi.resetModules();
  FakeWebSocket.instances = [];
  httpGetMock.mockReset();
  vi.stubGlobal('WebSocket', FakeWebSocket);
  // happy-dom 默认 host 是 'localhost:3000'，dashboard.ts 读 location.host 拼 URL，
  // 这里 stub 到 dev 端口保持断言可读。
  vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:5173' });
  vi.stubGlobal('localStorage', {
    getItem: vi.fn(() => null),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  });
  return import('./dashboard');
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('dashboard WebSocket 单例（VueUse useWebSocket + createGlobalState 2026-09-28）', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.useRealTimers();
  });

  it('URL 带 token 拼接：localStorage 有 token 时 ?token=xxx', async () => {
    vi.resetModules();
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:5173' });
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((k: string) =>
        k === 'auth_session' ? JSON.stringify({ token: 'mock-jwt-token' }) : null,
      ),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
    const api = await import('./dashboard');
    await bootstrapSocket(api);

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0]?.url).toBe(
      'ws://localhost:5173/ws/dashboard?token=mock-jwt-token',
    );
  });

  it('URL 不带 token：localStorage 没 token 时裸路径', async () => {
    const api = await loadDashboardApi();
    await bootstrapSocket(api);
    expect(FakeWebSocket.instances[0]?.url).toBe('ws://localhost:5173/ws/dashboard');
  });

  it('auth:tokens-refreshed 事件 → tokenVersion++ → VueUse 自动重连（实例计数 +1）', async () => {
    // 2026-09-28 改造核心：刷新 token 不再需要手动 reconnectDashboard。
    // 拦截器 dispatch auth:tokens-refreshed → 模块级 tokenVersion ref bump →
    // URL computed 重算 → VueUse watch(urlRef, open) 自动 close + 重建 socket。
    vi.resetModules();
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:5173' });
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
    const api = await import('./dashboard');
    await bootstrapSocket(api);

    expect(FakeWebSocket.instances).toHaveLength(1);
    const firstUrl = FakeWebSocket.instances[0]?.url;

    // 模拟 auth store 刷新成功后 dispatchEvent('auth:tokens-refreshed')
    window.dispatchEvent(new CustomEvent('auth:tokens-refreshed'));
    // 等待 VueUse watch 触发 + Vue 调度队列清空。
    // effectScope(true) detached scope 内的 watch 在 tokenVersion.value++ 后
    // 由 Vue scheduler 在 microtask 队列清空时回调，回调里 close() 老 socket + new WebSocket()。
    await new Promise((r) => setTimeout(r, 50));

    // VueUse watch 检测到 urlRef 变化 → close() 老 socket → open 新 socket
    expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(2);
    expect(FakeWebSocket.instances[1]?.url).toBe(firstUrl); // 同 URL 但新实例
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
          on_production_shelves: [],
          on_inspection_shelves: [],
          in_process: [],
          upcoming_delivery: [],
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
      on_production_shelves: [],
      on_inspection_shelves: [],
      in_process: [],
      upcoming_delivery: [],
      ts: '2026-09-28T10:00:00+08:00',
    };
    httpGetMock.mockResolvedValue({ data: sample });

    const result = await api.fetchDashboardSnapshot();

    expect(httpGetMock).toHaveBeenCalledWith('/dashboard/snapshot');
    expect(result).toEqual(sample);
  });
});
