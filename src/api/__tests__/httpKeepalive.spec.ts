// src/api/__tests__/httpKeepalive.spec.ts
//
// 覆盖 access token 保活定时器（api/http.ts 的 `ensureAccessTokenKeepalive`）。
//
// 为什么要有它：HTTP 流量是旧续命机制（`maybeProactiveRefresh`，只在成功响应拦截器
// 里调）的唯一触发源。空闲页面（大屏零轮询、无操作无请求）零流量 ⇒ access token
// （默认 TTL 900s）静默过期 ⇒ dashboard WS 的周期性 re-auth 拿旧 token 校验失败 ⇒
// 关闭码 4001 ⇒ 曾把用户踢回登录页。
//
// 用例：
//   - E1 零 HTTP 请求时到点自动 refresh 一次（这正是旧机制覆盖不到的路径）；
//   - E2 auth_session 被删后停摆，不再 refresh（不留悬挂定时器）；
//   - E3 无有效 token / exp 解不出时不排期；
//   - E4 幂等：重复调用只是重排，不产生并发的 refresh；
//   - E5 定时器句柄做了 unref → 不阻塞 node 环境的 vitest 进程退出。
//
// mock @/api/iam 的 refreshTokens：真 axios 会在 node 环境下挂起/超时。
// // @vitest-environment 保持默认 node —— 这正是要验证的进程退出行为。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const refreshTokensMock = vi.fn();

vi.mock('@/api/iam', () => ({
  refreshTokens: (...args: unknown[]) => refreshTokensMock(...args),
  login: vi.fn(),
  logout: vi.fn(),
  me: vi.fn(),
}));

const STORAGE_KEY = 'auth_session';

/** 可变 storage 桩：模拟「登录 / 刷新写入」与「登出删除」两条路径。 */
let storedSession: Record<string, unknown> | null = null;
let removeItemMock = vi.fn();

function stubStorage(): void {
  removeItemMock = vi.fn(() => {
    storedSession = null;
  });
  vi.stubGlobal('localStorage', {
    getItem: vi.fn(() => (storedSession === null ? null : JSON.stringify(storedSession))),
    setItem: vi.fn((_k: string, v: string) => {
      storedSession = JSON.parse(v) as Record<string, unknown>;
    }),
    removeItem: removeItemMock,
  });
}

/** 造一个 payload 带指定 exp 的假 JWT（decodeJwt 只解 payload，不验签）。 */
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

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** 造一次 refresh 响应（token 的 exp 由 remainingSec 控制）。 */
function makeRefreshedPair(remainingSec: number): { token: string; refresh_token: string } {
  return {
    token: makeJwtWithExp(nowSec() + remainingSec),
    refresh_token: 'rotated-refresh-token',
  };
}

/** 每个用例都重新 import http.ts，拿到干净的模块级 keepalive 状态。 */
async function loadHttp() {
  vi.resetModules();
  return import('../http');
}

beforeEach(() => {
  vi.useFakeTimers();
  storedSession = null;
  refreshTokensMock.mockReset();
  // 默认行为：refresh 成功并 rotation 出新的一对 token（新 access token 剩余 900s）
  refreshTokensMock.mockImplementation(async () => makeRefreshedPair(900));
  vi.stubGlobal('window', { dispatchEvent: vi.fn() });
  stubStorage();
});

afterEach(async () => {
  const http = await import('../http');
  http.resetKeepaliveForTest();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('access token 保活定时器（零 HTTP 流量下自续期）', () => {
  it('E1：零 HTTP 请求时到点自动 refresh 一次（旧机制覆盖不到的路径）', async () => {
    const http = await loadHttp();
    // token 剩余寿命 700s > 提前量 300s ⇒ 第一轮只排期不刷新
    storedSession = { token: makeJwtWithExp(nowSec() + 700), refresh_token: 'r0' };
    http.ensureAccessTokenKeepalive();
    expect(refreshTokensMock).not.toHaveBeenCalled();

    // 推进到「剩余寿命 - 提前量 + 余量」= 700 - 300 + 5 = 405s：此时 refreshTokens
    // 被调一次；成功返回的新 token 剩余 900s ⇒ 重新排期，不再连续触发。
    await vi.advanceTimersByTimeAsync(405_000);
    expect(refreshTokensMock).toHaveBeenCalledTimes(1);
    expect(refreshTokensMock).toHaveBeenCalledWith('r0');

    // 再推一个完整 TTL 周期：只多刷新一次（证明按新 exp 重排，不是死循环也不是停了）
    await vi.advanceTimersByTimeAsync(900_000);
    expect(refreshTokensMock).toHaveBeenCalledTimes(2);
    // refresh token 已 rotation，新一轮用的是 persistTokens 写回的新值
    expect(refreshTokensMock).toHaveBeenLastCalledWith('rotated-refresh-token');
  });

  it('E2：auth_session 被删后停摆，不再 refresh（不留悬挂定时器）', async () => {
    const http = await loadHttp();
    storedSession = { token: makeJwtWithExp(nowSec() + 700), refresh_token: 'r0' };
    http.ensureAccessTokenKeepalive();

    // 登出：teardownSession 会 removeItem('auth_session')
    localStorage.removeItem(STORAGE_KEY);
    // 模拟「确保表」被再次调用（登录 / 刷新 / loadFromStorage 都会调）——此时无 token
    http.ensureAccessTokenKeepalive();

    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(refreshTokensMock).not.toHaveBeenCalled();
  });

  it('E3：无 token / exp 解不出时不排期（不 refresh）', async () => {
    const http = await loadHttp();

    // 3a：storage 里没有 auth_session
    http.ensureAccessTokenKeepalive();
    // 3b：token 不是 JWT（解不出 exp）
    storedSession = { token: 'not-a-jwt', refresh_token: 'r0' };
    http.ensureAccessTokenKeepalive();

    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(refreshTokensMock).not.toHaveBeenCalled();
  });

  it('E4：剩余寿命已不足提前量时立即 refresh；重复起表幂等（不并发多次）', async () => {
    const http = await loadHttp();
    storedSession = { token: makeJwtWithExp(nowSec() + 60), refresh_token: 'r0' };

    http.ensureAccessTokenKeepalive();
    await flushPromises();
    http.ensureAccessTokenKeepalive();
    http.ensureAccessTokenKeepalive();
    await flushPromises();

    // 幂等重排不会各起一次 refresh（getOrCreateRefresh 是雪崩复用的单例 promise）
    expect(refreshTokensMock).toHaveBeenCalledTimes(1);
  });

  it('E5：定时器句柄做 unref（不阻塞 node 环境 vitest 进程退出）', async () => {
    const http = await loadHttp();
    const realSetTimeout = globalThis.setTimeout;
    const unrefSpies: Array<ReturnType<typeof vi.fn>> = [];
    vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation((...args: Parameters<typeof realSetTimeout>) => {
        const handle = realSetTimeout(...args) as unknown as { unref?: () => void };
        if (typeof handle?.unref === 'function') {
          const spy = vi.fn();
          // 换成 spy：既保留可调用形态，又能断言「确实被调用过」
          handle.unref = spy;
          unrefSpies.push(spy);
        }
        return handle as unknown as ReturnType<typeof realSetTimeout>;
      }) as unknown as typeof globalThis.setTimeout;

    storedSession = { token: makeJwtWithExp(nowSec() + 700), refresh_token: 'r0' };
    http.ensureAccessTokenKeepalive();

    // 必须挂上 unref：node 环境的 vitest run 会被这个模块级 setTimeout 挂住不退出。
    // （浏览器返回 number、没有 unref，实现侧用可选调用兼容两侧。）
    expect(unrefSpies.length).toBeGreaterThanOrEqual(1);
    expect(unrefSpies[0]).toHaveBeenCalledTimes(1);
  });
});

/** 冲刷微任务，让 getOrCreateRefresh 的 async 链跑完。 */
async function flushPromises(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
}
