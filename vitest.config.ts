// vitest 配置：运行纯函数和 WebSocket singleton 单测。
// 2026-09-24：视图层（src/views/**/*.spec.ts）启用 happy-dom 跑组件单测；
// composable / utils / api spec 仍走 node，最小爆炸半径。登录页是仓内
// 首例组件单测，先在这里单点开闸。
//
// 注意：vitest 3 起 `environmentMatchGlobs` 已被移除，改走文件头 pragma
// `// @vitest-environment happy-dom`。LoginCard.spec.ts / LoginView.spec.ts
// 顶部第一行即带此 pragma，仓内其它 *.spec.ts 走默认 node 环境不变。
import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    include: ['src/**/*.spec.ts'],
    environment: 'node',
  },
});
