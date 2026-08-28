/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}

interface ImportMetaEnv {
  readonly VITE_API_BASE: string
  // 2026-08-28 新增：dev-only dummy-auth 开关。由 `npm run dev:dummy`
  // （=`vite --mode dummy`）加载的 .env.dummy 注入；prod build 时 vite.config.ts
  // 会主动 throw 禁止进 bundle。客户端代码读 `'true'` 字符串判断。
  readonly VITE_DUMMY_AUTH?: string
}
interface ImportMeta {
  readonly env: ImportMetaEnv
}
