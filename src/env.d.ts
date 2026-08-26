/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}

interface ImportMetaEnv {
  readonly VITE_API_BASE: string
}
interface ImportMeta {
  readonly env: ImportMetaEnv
}

// 2026-08-26 新增：vite.config.ts define 注入的 build 期常量。
// true 仅在 dev 模式 + --dummy-auth 同时满足时；prod build 永远是 false。
// 客户端代码用 `if (__DUMMY_AUTH__)` 即可，TypeScript 也能识别。
declare const __DUMMY_AUTH__: boolean
