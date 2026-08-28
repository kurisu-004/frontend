import { defineConfig, loadEnv, type UserConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'
import { fileURLToPath, URL } from 'node:url'

// 2026-08-28 重写：弃用裸全局 `define: { __DUMMY_AUTH__ }` 方案（Vite 8 dev client
// 不走 define 替换，详见 docs/08-known-risks/framework-pitfalls.md 第 6 节）。
// 改走 Vite 官方 env 机制：`npm run dev:dummy` = `vite --mode dummy` → 自动加载
// `.env.dummy` → 客户端读 `import.meta.env.VITE_DUMMY_AUTH === 'true'` 决定是否注入。
//
// 配置改成函数形式拿 `{ command, mode }`，配置求值期就能可靠判定 build vs serve。

function config({ command, mode }: { command: 'build' | 'serve'; mode: string }): UserConfig {
  // loadEnv 第三个参数 '' 表示读所有变量（不限 VITE_ 前缀），方便后面读 VITE_DUMMY_AUTH。
  const env = loadEnv(mode, process.cwd(), '')

  // 第一道 prod 保护：build 期只要 VITE_DUMMY_AUTH === 'true'（不论 mode 是什么，
  // 防住「.env.production 误设 VITE_DUMMY_AUTH=true」「--mode dummy build」两种情况）
  // 就硬 throw。dummy-auth 不得进 prod bundle。
  if (command === 'build' && env.VITE_DUMMY_AUTH === 'true') {
    throw new Error(
      '[dummy-auth] refusing to build with VITE_DUMMY_AUTH=true. ' +
      'Remove VITE_DUMMY_AUTH from your .env / .env.dummy or run dev mode only.',
    )
  }

  return {
    plugins: [
      vue(),
      AutoImport({
        resolvers: [ElementPlusResolver()],
        dts: 'src/auto-imports.d.ts',
      }),
      Components({
        resolvers: [ElementPlusResolver()],
        dts: 'src/components.d.ts',
      }),
    ],
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    css: {
      preprocessorOptions: {
        scss: {
          api: 'modern-compiler',
        },
      },
    },
    // 显式 include 重依赖：避免 vite 进入 dep discover 模式 → 浏览器点新页面时不再触发
    // "[optimizer] bundling dependencies..." + full-reload。不要删（CLAUDE.md #5）。
    optimizeDeps: {
      include: [
        'vue',
        'vue-router',
        'pinia',
        'axios',
        'element-plus',
        '@element-plus/icons-vue',
        'xlsx',
        'vue-draggable-plus',
      ],
    },
    // 2026-08-21：EP 改按需加载后，统计页(echarts ~700kB)与 PDF 预览(pdfjs ~560kB)仍是
    // 独立的懒加载重 chunk，属合理体积；阈值对齐到 750 避免对已知合理 chunk 重复告警，
    // 新超标的 chunk 仍会正常报警。
    build: {
      chunkSizeWarningLimit: 750,
      rollupOptions: {
        // 2026-08-21：element-plus 依赖的 @vueuse/core 在其 dist 里含有 rolldown
        // 不识别的 `/* #__PURE__ */` 注解位置，触发 INVALID_ANNOTATION 警告；这是上游
        // rollup→rolldown 迁移期的已知问题（注释被忽略不影响产出正确性）。
        // 过滤掉 node_modules 里 @vueuse/core 触发的这类噪音，避免淹没新出现的真警告。
        onwarn(warning, defaultHandler) {
          if (
            warning.code === 'INVALID_ANNOTATION' &&
            typeof warning.id === 'string' &&
            warning.id.includes('@vueuse/core')
          ) {
            return
          }
          defaultHandler(warning)
        },
      },
    },
    server: {
      port: 5173,
      host: '0.0.0.0',
      proxy: {
        '/api': {
          target: 'http://127.0.0.1:8000',
          changeOrigin: true,
          ws: true,
        },
      },
    },
  }
}

export default defineConfig(config)
