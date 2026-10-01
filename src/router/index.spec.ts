// src/router/index.spec.ts
//
// 2026-10-02 新增：覆盖 router 模块顶层注册的 'auth:session-lost' 监听器
// （真正执行「终止会话 + 跳登录页」的那段代码）。此前该接入点零覆盖：3 个
// 关闭码用例全在 WS 层（src/api/dashboard.spec.ts），app 层真正收口的一步没人测。
//
// 覆盖：
//   - R1：dispatch 'auth:session-lost' → auth.forceLogout 被调用**恰好一次**，
//         参数就是 router 模块导出的 router 实例（store 不 import vue-router，
//         靠参数注入 —— 参数传错会静默跳错路由，这个断言是那道不变式的 guard）
//   - R2：不再调 refreshOrLogout（review Major 1：WS 派发前已清 localStorage，
//         复核 /iam/me 在构造上必然 40100，stillValid 分支是死代码）
//   - R3：连续两次事件 → 幂等（forceLogout 自身可重入，listener 不做去重）
//   - R4：2026-10-02 缺陷 A —— 全局前置守卫的 `refreshOrLogout` resolve false 时，
//         导航必须 settle。原实现是 `if (!ok) return;`，3 参守卫里从不调 next() ⇒
//         prod 守卫 promise 永不 settle（导航挂死）、dev 抛 "Invalid navigation guard"。
//
// mock 掉整个 @/stores/auth：本文件只关心「listener 调了 store 的哪个方法、传了什么
// 参数」，不关心 store 内部清 state / tagsView 的实现（那部分由
// src/stores/__tests__/auth.spec.ts 覆盖）。keepActivePinia 都不需要 —— 被 mock 的
// useAuthStore 是一个普通函数，不走 Pinia。
// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const forceLogoutMock = vi.fn();
const refreshOrLogoutMock = vi.fn();

vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({
    forceLogout: forceLogoutMock,
    refreshOrLogout: refreshOrLogoutMock,
  }),
}));

// router 模块在 import 时就会注册 window listener，必须在 mock 生效之后 import。
const routerModule = await import('./index');
const router = routerModule.default;

describe("router 模块 'auth:session-lost' 监听器（dashboard WS 关闭码 4001）", () => {
  beforeEach(() => {
    forceLogoutMock.mockClear();
    refreshOrLogoutMock.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('R1：收到事件 → forceLogout 被调用一次，参数是 router 实例本身', () => {
    window.dispatchEvent(
      new CustomEvent('auth:session-lost', { detail: { code: 4001, reason: 'auth expired' } }),
    );

    expect(forceLogoutMock).toHaveBeenCalledTimes(1);
    // 参数必须是 router 实例本身：store 不 import vue-router，路由跳转完全依赖
    // 这个注入。传成 undefined / 局部 router 副本都会让「跳 /login」静默失效。
    expect(forceLogoutMock.mock.calls[0]?.[0]).toBe(router);
  });

  it('R2：不再走 refreshOrLogout 复核（review Major 1：那次复核必 40100）', () => {
    window.dispatchEvent(
      new CustomEvent('auth:session-lost', { detail: { code: 4001, reason: 'auth expired' } }),
    );

    expect(refreshOrLogoutMock).not.toHaveBeenCalled();
  });

  it('R3：连续两次事件 → 幂等（forceLogout 自身可重入，listener 不做去重）', () => {
    window.dispatchEvent(
      new CustomEvent('auth:session-lost', { detail: { code: 4001, reason: 'auth expired' } }),
    );
    window.dispatchEvent(
      new CustomEvent('auth:session-lost', { detail: { code: 4001, reason: 'auth expired' } }),
    );

    // 不去重是刻意的：WS 层是 createGlobalState 单例，4001 派发点只有一处，
    // 真出现两次也只会来自「测试/重放」；forceLogout 每步都是幂等赋值。
    expect(forceLogoutMock).toHaveBeenCalledTimes(2);
    expect(forceLogoutMock.mock.calls[1]?.[0]).toBe(router);
  });
});

// 2026-10-02 缺陷 A 回归护栏：全局前置守卫的导航必须 settle。
describe('全局前置守卫：refreshOrLogout 失败时的导航必须 settle（缺陷 A）', () => {
  beforeEach(() => {
    forceLogoutMock.mockClear();
    refreshOrLogoutMock.mockClear();
  });

  afterEach(async () => {
    // 上面 R4 的导航被 next(false) 取消（AbortNavigation），先回起点再复位 spy，
    // 避免残留的 failed navigation 影响后续断言。
    await router.push('/login').catch(() => undefined);
    vi.restoreAllMocks();
  });

  it('R4：/iam/me 校验失败 → 导航 settle（不挂起）且 router 收到 router 实例', async () => {
    // 未登录 + 目标路由 requireAuth → 守卫会调 refreshOrLogout
    refreshOrLogoutMock.mockResolvedValue(false);

    // 必须用 Promise.race + 超时：若回归成「不调 next()」，prod 语义下守卫 promise
    // 永不 settle，直接 await 会挂到 vitest 5s 全局 timeout，报错不指向根因。
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
