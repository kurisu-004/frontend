// src/router/index.spec.ts
//
// 覆盖 router 模块顶层注册的 'auth:session-lost' 监听器（决定 4001 之后会话怎么处置的
// 那段代码）与全局前置守卫的导航 settle。
//
// 4001 按 reason 三路分流（reason 字面量与后端 `reauth_close_code` 严格对齐）：
//   - R1 reason='auth expired' → forceLogout 恰好一次，参数是 router 实例本身
//     （store 不 import vue-router，靠参数注入 —— 传错会静默跳错路由）；
//   - R2 reason='access token expired' + refreshOrLogout 成功 → 不登出，且必须调
//     reconnectDashboard 恢复长连接；
//   - R3 reason='access token expired' + refreshOrLogout 失败 → 登出，且**不重复**
//     forceLogout（refreshOrLogout 内部已做过）；
//   - R4 reason=null → 乐观走 refresh 分支（后端没细分 reason 时不该直接踢人）；
//   - R5 reason 为未知的非空串 → 保守 forceLogout（不得把真吊销拖成 refresh 往返）；
//   - R6 reason='auth expired' → 不做 refreshOrLogout 往返（那条路注定失败）。
//   - R7 全局前置守卫的 refreshOrLogout resolve false 时导航必须 settle：
//     本守卫是 3 参签名，从不调 next() 会让 prod 导航永久挂起、dev 抛
//     "Invalid navigation guard"。
//   - R8 连续两次事件 → 幂等：listener 不做去重，靠 forceLogout 自身可重入。
//   - R9 refreshOrLogout 自身抛异常 → 兜底 forceLogout（不能吞成 unhandled rejection）。
//
// mock 掉整个 @/stores/auth（只关心「listener 调了 store 的哪个方法、传了什么参数」）
// 与 @/api/dashboard（reconnectDashboard 会真的建 WebSocket 连接）。
// keepActivePinia 不需要 —— 被 mock 的 useAuthStore 是一个普通函数，不走 Pinia。
// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const forceLogoutMock = vi.fn();
const refreshOrLogoutMock = vi.fn();
const reconnectDashboardMock = vi.fn();

vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({
    forceLogout: forceLogoutMock,
    refreshOrLogout: refreshOrLogoutMock,
  }),
}));

vi.mock('@/api/dashboard', () => ({
  reconnectDashboard: () => reconnectDashboardMock(),
}));

// router 模块在 import 时就会注册 window listener，必须在 mock 生效之后 import。
const routerModule = await import('./index');
const router = routerModule.default;

/** 派发 4001 事件。 */
function dispatchSessionLost(reason: string | null): void {
  window.dispatchEvent(
    new CustomEvent('auth:session-lost', {
      detail: { code: 4001, reason },
    }),
  );
}

/** 等 listener 里的 promise 链（refreshOrLogout → reconnectDashboard）跑完。 */
async function flushAsync(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
}

describe("router 模块 'auth:session-lost' 监听器（dashboard WS 关闭码 4001）", () => {
  beforeEach(() => {
    forceLogoutMock.mockClear();
    refreshOrLogoutMock.mockReset();
    reconnectDashboardMock.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('R1：reason=auth expired → forceLogout 被调用一次，参数是 router 实例本身', async () => {
    dispatchSessionLost('auth expired');
    await flushAsync();

    expect(forceLogoutMock).toHaveBeenCalledTimes(1);
    // 参数必须是 router 实例本身：store 不 import vue-router，路由跳转完全依赖
    // 这个注入。传成 undefined / 局部 router 副本都会让「跳 /login」静默失效。
    expect(forceLogoutMock.mock.calls[0]?.[0]).toBe(router);
  });

  it('R6：reason=auth expired → 不走 refreshOrLogout 往返（会话已吊销，注定失败）', async () => {
    dispatchSessionLost('auth expired');
    await flushAsync();

    expect(refreshOrLogoutMock).not.toHaveBeenCalled();
    expect(reconnectDashboardMock).not.toHaveBeenCalled();
  });

  it('R2：reason=access token expired 且 refresh 成功 → 不登出，并恢复长连接', async () => {
    refreshOrLogoutMock.mockResolvedValue(true);

    dispatchSessionLost('access token expired');
    await flushAsync();

    expect(refreshOrLogoutMock).toHaveBeenCalledTimes(1);
    expect(refreshOrLogoutMock.mock.calls[0]?.[0]).toBe(router);
    expect(forceLogoutMock).not.toHaveBeenCalled();
    // 必须恢复长连接：WS 侧已在 4001 分支把 URL 置 undefined 停连，而
    // refreshOrLogout 走的是 /iam/me（成功响应，不触发 40102），不一定发生 refresh，
    // 也就没人派发 auth:session-changed ⇒ 漏掉这一句 WS 就永远停在 undefined。
    expect(reconnectDashboardMock).toHaveBeenCalledTimes(1);
  });

  it('R3：reason=access token expired 且 refresh 失败 → 登出，且不重复 forceLogout', async () => {
    refreshOrLogoutMock.mockResolvedValue(false);

    dispatchSessionLost('access token expired');
    await flushAsync();

    expect(refreshOrLogoutMock).toHaveBeenCalledTimes(1);
    // refreshOrLogout 内部失败时已经 forceLogout(router) + router.replace('/login')，
    // listener 再调一次是重复导航。
    expect(forceLogoutMock).not.toHaveBeenCalled();
    expect(reconnectDashboardMock).not.toHaveBeenCalled();
  });

  it('R4：reason=null（后端未细分 reason）→ 走 refresh 分支，不直接登出', async () => {
    refreshOrLogoutMock.mockResolvedValue(true);

    dispatchSessionLost(null);
    await flushAsync();

    expect(refreshOrLogoutMock).toHaveBeenCalledTimes(1);
    expect(forceLogoutMock).not.toHaveBeenCalled();
    expect(reconnectDashboardMock).toHaveBeenCalledTimes(1);
  });

  it('R5：未知的非空 reason → 保守 forceLogout（不拖成 refresh 往返）', async () => {
    dispatchSessionLost('some-future-reason');

    await flushAsync();

    expect(refreshOrLogoutMock).not.toHaveBeenCalled();
    expect(forceLogoutMock).toHaveBeenCalledTimes(1);
    expect(reconnectDashboardMock).not.toHaveBeenCalled();
  });

  it('R8：连续两次事件 → 幂等（forceLogout 自身可重入，listener 不做去重）', async () => {
    dispatchSessionLost('auth expired');
    dispatchSessionLost('auth expired');
    await flushAsync();

    // 不去重是刻意的：WS 层是 createGlobalState 单例，4001 派发点只有一处，
    // 真出现两次也只会来自「测试/重放」；forceLogout 每步都是幂等赋值。
    expect(forceLogoutMock).toHaveBeenCalledTimes(2);
    expect(forceLogoutMock.mock.calls[1]?.[0]).toBe(router);
  });

  it('R9：refreshOrLogout 自身抛异常 → 兜底 forceLogout（不吞成 unhandled rejection）', async () => {
    // refreshOrLogout 把 forceLogout 放在 catch 里，而 forceLogout 自身也可能抛
    // （teardownSession 的 storage 写入 / queryClient.clear() / router.replace）。异常穿出
    // listener 的 promise 就是一条无人处理的 rejection ⇒ 会话没清、没跳登录页。
    refreshOrLogoutMock.mockRejectedValue(new Error('localStorage SecurityError'));

    dispatchSessionLost('access token expired');
    await flushAsync();

    // 宁可多登不可不登
    expect(forceLogoutMock).toHaveBeenCalledTimes(1);
    expect(forceLogoutMock.mock.calls[0]?.[0]).toBe(router);
    expect(reconnectDashboardMock).not.toHaveBeenCalled();
  });
});

// 全局前置守卫回归护栏：导航必须 settle。
describe('全局前置守卫：refreshOrLogout 失败时的导航必须 settle', () => {
  beforeEach(() => {
    forceLogoutMock.mockClear();
    refreshOrLogoutMock.mockReset();
    reconnectDashboardMock.mockClear();
  });

  afterEach(async () => {
    // 上面 R7 的导航被 next(false) 取消（AbortNavigation），先回起点再复位 spy，
    // 避免残留的 failed navigation 影响后续断言。
    await router.push('/login').catch(() => undefined);
    vi.restoreAllMocks();
  });

  it('R7：/iam/me 校验失败 → 导航 settle（不挂起）且 router 收到 router 实例', async () => {
    // 未登录 + 目标路由 requireAuth → 守卫会调 refreshOrLogout
    refreshOrLogoutMock.mockResolvedValue(false);

    // 必须用 Promise.race + 超时：若回归成「不调 next()」，prod 语义下守卫 promise
    // 永不 settle，直接 await 会挂到 vitest 全局 timeout，报错不指向根因。
    //
    // 四种结局用单一 outcome 变量区分，断言读起来就是「到底发生了什么」：
    //   cancelled         —— push resolve 出一个 navigation failure（next(false) 的正常结局）
    //   settled-navigate  —— 守卫调了 next('/login') 之类，导航真跑完了
    //   rejected          —— dev 分支 detect 到 next 没被调用 → "Invalid navigation guard"
    //   hung              —— race 超时，prod 语义的永久挂起
    let outcome: 'cancelled' | 'settled-navigate' | 'rejected' | 'hung' = 'hung';
    await Promise.race([
      router.push('/parts').then(
        (r) => {
          outcome = r ? 'cancelled' : 'settled-navigate';
        },
        () => {
          outcome = 'rejected';
        },
      ),
      new Promise<void>((r) => setTimeout(r, 500)),
    ]);

    expect(outcome).toBe('cancelled');
    expect(refreshOrLogoutMock).toHaveBeenCalledTimes(1);
    // router 参数照旧透传 —— forceLogout(router) 里的 router.replace('/login') 靠它
    expect(refreshOrLogoutMock.mock.calls[0]?.[0]).toBe(router);
    // 守卫侧只**取消**这条已被取代的导航（next(false)），自己不导航。真实的「跳登录页」
    // 由 refreshOrLogout → forceLogout 内的 router.replace 完成；在本 spec 里
    // refreshOrLogout 是 mock，那一跳不发生。
    expect(router.currentRoute.value.path).not.toBe('/parts');
  });
});
