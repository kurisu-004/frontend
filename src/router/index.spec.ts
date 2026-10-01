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
