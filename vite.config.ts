import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'
import path from 'path'

export default defineConfig({
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
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  // 显式 include 重依赖：避免 vite 进入 dep discover 模式 → 浏览器点新页面时不再触发
  // "[optimizer] bundling dependencies..." + full-reload。
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
  css: {
    preprocessorOptions: {
      scss: {
        api: 'modern-compiler',
      },
    },
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
})
