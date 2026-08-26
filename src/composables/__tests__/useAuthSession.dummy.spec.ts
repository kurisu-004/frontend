// src/composables/__tests__/useAuthSession.dummy.spec.ts
// 2026-08-26 新增：dummy-auth 注入路径的单元测试。
//
// 注意：__DUMMY_AUTH__ 是 Vite build 期常量，vitest 默认不替换 import.meta.env.DEV
// 也不应用 vite `define` 文本替换（实验验证）。要让它在测试里为 true，必须在
// 源码执行前 stub globalThis.__DUMMY_AUTH__（vitest 的 global lookup 会查到）。
// 完整 prod 保护验证靠 Task 1 Step 4 的 vite build --dummy-auth throw 测试。

// 必须放在所有 import 之前：让源码 `__DUMMY_AUTH__` 全局标识符解析到 true。
;(globalThis as { __DUMMY_AUTH__?: boolean }).__DUMMY_AUTH__ = true

import { describe, it, expect, beforeEach } from 'vitest'

describe('useAuthSession.initDummyAuth', () => {
  beforeEach(() => {
    // 不重置 globalThis.__DUMMY_AUTH__，否则下一测试 import 会拿到 false。
  })

  it('initializes admin user with full menus', async () => {
    const { useAuthSession } = await import('../useAuthSession')
    const auth = useAuthSession()
    auth.initDummyAuth()
    expect(auth.isAuthenticated()).toBe(true)
    expect(auth.user.value?.username).toBe('dev-admin')
    expect(auth.user.value?.roles).toContain('MANAGER')
    expect(auth.isDummyAuthActive()).toBe(true)
  })

  it('isDummyAuthActive reflects module state after init', async () => {
    const { useAuthSession } = await import('../useAuthSession')
    const auth = useAuthSession()
    auth.initDummyAuth()
    // 在测试环境（import.meta.env.DEV = true + __DUMMY_AUTH__ stub = true）下应正常注入。
    expect(auth.isDummyAuthActive()).toBe(true)
  })
})