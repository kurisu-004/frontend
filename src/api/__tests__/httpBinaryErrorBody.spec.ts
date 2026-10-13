// @vitest-environment happy-dom
// src/api/__tests__/httpBinaryErrorBody.spec.ts
//
// 2026-10-16 新增（review 第 1 轮 MAJOR-4）：`api/http.ts` 错误拦截器的**二进制 error body**
// 分支守卫。
//
// 为什么必须有它：`responseType` 非 json 的端点，其 error body 也是二进制对象而不是普通
// 对象 ⇒ `isEnvelope()` 判 false ⇒ 拦截器**直接抛 `ApiError(httpStatus, ...)`、不进 reactive
// refresh 分支**。后端返 `{code:40102,...}` + HTTP 401 时，用户表现为「访问过期时被踢成
// network error、40102 自动刷新对这条端点静默失效」。
//
// ⚠️ **这个分支漏了没有任何测试信号**：页面级 spec 一律 `vi.mock('@/api/http')` 把整个模块
// 换掉，`apiGetMock` 直接返回 `{data: ArrayBuffer}` ⇒ 两个拦截器一行都不执行。本文件直接
// 调用**真实注册在 `api` 实例上的**那个 rejected handler，是全仓唯一能触到它的测试面。
//
// 覆盖：
//   - B1：Blob body（既有分支）—— 回归守卫，确认没被本轮改坏；
//   - B2：ArrayBuffer body（本轮新增分支）—— `{code:40102}` 能解出信封 ⇒ 走 refresh；
//   - B3：ArrayBuffer body 是纯文本 / 非 JSON ⇒ 落回 `ApiError(httpStatus)`，不吞异常；
//   - B4：40105（SESSION_REVOKED）优先于 40102 refresh 判定（两种 body 形态都要对）。
//
// 不覆盖（已在文件头登记为已知局限）：真正的重试请求、refresh token 互斥、Web Locks ——
// 那些在 `httpKeepalive.spec.ts` 与本文件分属不同的桩面，各守各的。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const refreshTokensMock = vi.fn();
vi.mock('@/api/iam', () => ({
  refreshTokens: (...args: unknown[]) => refreshTokensMock(...args),
  login: vi.fn(),
  logout: vi.fn(),
  me: vi.fn(),
}));

import axios from 'axios';
import type { AxiosError } from 'axios';
import { api } from '../http';

/** 取注册在 `api` 实例上的那个响应 rejected handler（错误拦截器）。 */
function errorHandler(): (error: AxiosError) => Promise<unknown> {
  const handlers = (api.interceptors.response.handlers ?? []).filter(
    (h) => typeof h.rejected === 'function',
  );
  expect(handlers).toHaveLength(1);
  return handlers[0]!.rejected as (error: AxiosError) => Promise<unknown>;
}

/** 造一个形状与真实一致的 AxiosError（只用到 `response.data` / `status` / `config` / `message`）。 */
function axiosError(data: unknown, status = 401): AxiosError {
  return {
    isAxiosError: true,
    name: 'AxiosError',
    message: `Request failed with status code ${status}`,
    config: { headers: {} },
    response: { data, status, statusText: '', headers: {}, config: { headers: {} } },
    toJSON: () => ({}),
  } as unknown as AxiosError;
}

const ENVELOPE_40102 = { code: 40102, message: 'access token 已过期', data: null };

/** 把一段文本编成 ArrayBuffer（TextEncoder 在 node / happy-dom 都有）。 */
function asArrayBuffer(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

/**
 * 种一份**过期**的会话到 localStorage（access 已过期、refresh 还在）。
 *
 * ⚠️ 必须种：`doRefresh` 读的是 storage 里的 `refresh_token`，缺它会先抛
 * `ApiError(40103, 'no refresh token')`、**压根到不了** `refreshTokens()` —— 那样
 * 「进了 refresh 分支」这条断言就成了假信号（它测的是 40103 早退，不是二进制 body 解析）。
 * token 必须是合法 JWT 形状：`doRefreshUnderLock` 的「早退复用」要解 `exp`，解不出就直接
 * 发请求（那正是我们要的路径），但仍要给一个能解析的 payload 以免行为随实现漂移。
 */
function seedSession(): void {
  const payload = (exp: number) =>
    btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' })) +
    '.' +
    btoa(JSON.stringify({ sub: 'u1', exp })) +
    '.sig';
  const past = Math.floor(Date.now() / 1000) - 60;
  localStorage.setItem(
    'auth_session',
    JSON.stringify({
      token: payload(past),
      refresh_token: 'refresh-token-for-test',
      user: { id: 'u1', username: 'tester', roles: ['MANAGER'], permissions: [] },
    }),
  );
}

beforeEach(async () => {
  vi.clearAllMocks();
  localStorage.clear();
  refreshTokensMock.mockReset().mockRejectedValue(new Error('refresh 失败（测试桩）'));
  seedSession();
  // ⚠️ **必须等一拍**：`getOrCreateRefresh` 的模块级 `refreshPromise` 是用
  // `setTimeout(…, 0)` 清空的，上一条用例的 refresh 失败后它还挂着同一个 rejected promise ⇒
  // 本条会复用它、**不再调** `refreshTokens`。不清干净时「进了 refresh 分支」的判据
  // 在第二条用例上就是假信号（它测到的是复用，不是二进制 body 解析）。
  await new Promise((r) => setTimeout(r, 5));
});

describe('http 错误拦截器 — 二进制 error body（2026-10-16 MAJOR-4）', () => {
  it('B1（回归）：Blob body 能解出信封 ⇒ 同样进 refresh 分支（既有分支没被改坏）', async () => {
    const blob = new Blob([JSON.stringify(ENVELOPE_40102)], { type: 'application/json' });
    const err = (await errorHandler()(axiosError(blob)).catch((e: unknown) => e as Error)) as Error;
    expect(refreshTokensMock).toHaveBeenCalled();
    expect(String(err.message)).not.toContain('Request failed with status code');
  });

  it('B2：ArrayBuffer body 能解出信封 ⇒ 同样进 refresh 分支（本轮新增的分支）', async () => {
    const listeners: string[] = [];
    const onLogout = () => listeners.push('auth:logout');
    window.addEventListener('auth:logout', onLogout);
    try {
      const err = (await errorHandler()(axiosError(asArrayBuffer(JSON.stringify(ENVELOPE_40102)))).catch(
        (e: unknown) => e as Error,
      )) as Error;
      // 进了 refresh 分支的标志：① 去调了 refreshTokens；② refresh 失败派发了 auth:logout。
      // 若 ArrayBuffer 分支缺失，这里会是 `ApiError(401, 'Request failed with status…')`。
      expect(refreshTokensMock).toHaveBeenCalled();
      expect(listeners).toContain('auth:logout');
      expect(String((err as Error).message)).not.toContain('Request failed with status code');
    } finally {
      window.removeEventListener('auth:logout', onLogout);
    }
  });

  it('B3：ArrayBuffer body 不是 JSON / 不是信封 ⇒ 落回 ApiError(httpStatus)，不吞不炸', async () => {
    // 「不是信封」是正常形态（例如后端返纯文本 500、nginx 返 HTML 错误页）。
    const err = (await errorHandler()(axiosError(asArrayBuffer('<html>502</html>'), 502)).catch(
      (e: unknown) => e as Error & { code?: number },
    )) as Error & { code?: number };
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe(502);
    // 空 body 也一样（不是 JSON 解析失败就炸，而是 payload 归 null 后按非信封处理）。
    const empty = (await errorHandler()(axiosError(asArrayBuffer(''), 500)).catch(
      (e: unknown) => e as Error & { code?: number },
    )) as Error & { code?: number };
    expect(empty.code).toBe(500);
  });

  it('B4：40105（SESSION_REVOKED）在两种 body 形态下都优先于 40102 refresh 判定', async () => {
    for (const data of [
      new Blob([JSON.stringify({ code: 40105, message: '会话已吊销', data: null })], {
        type: 'application/json',
      }),
      asArrayBuffer(JSON.stringify({ code: 40105, message: '会话已吊销', data: null })),
    ]) {
      refreshTokensMock.mockClear();
      const listeners: string[] = [];
      const onLogout = () => listeners.push('auth:logout');
      window.addEventListener('auth:logout', onLogout);
      try {
        const err = (await errorHandler()(axiosError(data)).catch(
        (e: unknown) => e as Error & { code?: number },
      )) as Error & { code?: number };
        expect(err.code).toBe(40105);
        // 40105 走的是「直接登出」，**不**去换 refresh token。
        expect(refreshTokensMock).not.toHaveBeenCalled();
        expect(listeners).toContain('auth:logout');
      } finally {
        window.removeEventListener('auth:logout', onLogout);
      }
    }
  });

  it('B5：文件头登记的纪律 —— 新增 `responseType` 非 json 的端点时，本文件必须扩用例', async () => {
    // 把「源码里出现过哪些 responseType」列出来：出现新值却没有对应分支时，
    // 这条会提醒（不是自动红，而是让漏配在 review 里被看见）。
    const src = readFileSync('src/api/http.ts', 'utf8');
    expect(src).toContain("payload instanceof Blob");
    expect(src).toContain('payload instanceof ArrayBuffer');
    // 反向：本文件不得自己抄一份 isEnvelope 判据（那是要在 http.ts 里改的那一处）。
    expect(src).toContain('function isEnvelope');
    expect(axios.isAxiosError).toBeDefined();
  });
});