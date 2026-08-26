import { defineConfig, type UserConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'
import { fileURLToPath, URL } from 'node:url'

// 解析 --dummy-auth CLI flag（由 `vite --dummy-auth` / `vite build --dummy-auth` 透传）
const isDummyAuthEnabled = process.argv.includes('--dummy-auth')

function config(): UserConfig {
  // 第一道 prod 保护：build 期硬 throw，防止假登录逻辑进 prod bundle。
  // 2026-08-26 新增：仅当显式 --dummy-auth 且 mode !== 'development' 时拒绝。
  if (isDummyAuthEnabled && process.env.NODE_ENV !== 'development') {
    throw new Error(
      '[dummy-auth] refusing to enable in production build. ' +
      'Remove --dummy-auth from your command or run in dev mode only.',
    )
  }

  return {
    // 第二道保护：客户端代码用 __DUMMY_AUTH__ 时，prod bundle 里 tree-shake 整段
    define: {
      __DUMMY_AUTH__: JSON.stringify(
        isDummyAuthEnabled && process.env.NODE_ENV === 'development',
      ),
    },
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
