// src/composables/__tests__/useAuthSession.dummy.spec.ts
// 2026-08-26 新增 / 2026-08-28 重写：dummy-auth 注入路径的单元测试。
//
// 2026-08-28 改用 vitest 的 `vi.stubEnv` stub `import.meta.env`：
// - `import.meta.env.DEV` 在 vitest 默认就是 true（dev 配置），无需 stub
// - `import.meta.env.VITE_DUMMY_AUTH` 须显式 stub 为 'true' 才会走注入路径
// 由于 useAuthSession 是模块级单例（user/token/isDummyAuthActiveValue 都在模块顶层），
// 用 `vi.resetModules()` 在每个用例前重置模块 + `await import()` 拿到全新实例，
// 避免上一个用例注入的 session 状态泄漏到下一个用例。
// 完整 prod 保护验证靠 Task 1 Step 4 的 `npx vite build --mode dummy` throw 测试。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

describe('useAuthSession.initDummyAuth', () => {
  beforeEach(() => {
    // 每个用例开始前重置模块缓存，让下一次 await import('../useAuthSession') 拿到全新模块实例
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('initializes admin user with full menus when VITE_DUMMY_AUTH=true', async () => {
    vi.stubEnv('VITE_DUMMY_AUTH', 'true')
    const { useAuthSession } = await import('../useAuthSession')
    const auth = useAuthSession()
    // 静音 console.info，避免单测输出噪音
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    auth.initDummyAuth()
    expect(auth.isAuthenticated()).toBe(true)
    expect(auth.user.value?.username).toBe('dev-admin')
    expect(auth.user.value?.roles).toContain('MANAGER')
    expect(auth.isDummyAuthActive()).toBe(true)
    expect(infoSpy).toHaveBeenCalledWith(
      '[dummy-auth] 已注入开发用管理员会话（dev-only）',
    )
    infoSpy.mockRestore()
  })

  it('isDummyAuthActive reflects module state after init', async () => {
    vi.stubEnv('VITE_DUMMY_AUTH', 'true')
    const { useAuthSession } = await import('../useAuthSession')
    const auth = useAuthSession()
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    auth.initDummyAuth()
    // vitest 默认 import.meta.env.DEV === true + VITE_DUMMY_AUTH stub = 'true' → 应正常注入
    expect(auth.isDummyAuthActive()).toBe(true)
    infoSpy.mockRestore()
  })

  // 2026-08-28 新增：未设 VITE_DUMMY_AUTH 时 initDummyAuth 应直接 return，不注入 session、不打 console。
  it('does not inject when VITE_DUMMY_AUTH is not set', async () => {
    // 显式不 stub VITE_DUMMY_AUTH（vitest 默认 import.meta.env.VITE_DUMMY_AUTH === undefined）
    const { useAuthSession } = await import('../useAuthSession')
    const auth = useAuthSession()
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    auth.initDummyAuth()
    expect(auth.isAuthenticated()).toBe(false)
    expect(auth.isDummyAuthActive()).toBe(false)
    expect(infoSpy).not.toHaveBeenCalled()
    infoSpy.mockRestore()
  })

  // 2026-08-28 新增：VITE_DUMMY_AUTH === 'false' 也不注入（防止字符串真值以外的边界情况）。
  it('does not inject when VITE_DUMMY_AUTH is explicitly false', async () => {
    vi.stubEnv('VITE_DUMMY_AUTH', 'false')
    const { useAuthSession } = await import('../useAuthSession')
    const auth = useAuthSession()
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    auth.initDummyAuth()
    expect(auth.isAuthenticated()).toBe(false)
    expect(auth.isDummyAuthActive()).toBe(false)
    infoSpy.mockRestore()
  })
})
