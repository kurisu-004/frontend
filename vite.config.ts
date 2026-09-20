import { defineConfig, loadEnv, type PluginOption, type UserConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import AutoImport from 'unplugin-auto-import/vite';
import Components from 'unplugin-vue-components/vite';
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers';
import { fileURLToPath, URL } from 'node:url';

// 2026-09-20 新增：COOP/COEP dev middleware。
//
// 背景：occt-wasm 当前在主线程跑（sandbox 初始化），不强制 SharedArrayBuffer。
// 但 occt-wasm 用 emscripten 主线程加载 wasm 时，部分浏览器要求页面必须
// Cross-Origin-Isolated（COOP/COEP 双头），否则 wasm streaming compile 失败。
// 给 dev server + preview server 加这两个 header，未来接入 occt-wasm Worker 时
// 也能直接复用，不需要再改。
//
// 仅 serve 模式生效；prod 走 nginx，nginx.conf 已带 COOP/COEP（见 5-build-and-deploy）。
function crossOriginIsolation(): PluginOption {
  return {
    name: 'cross-origin-isolation',
    apply: 'serve', // dev + preview 都属 serve；build 不需要
    configureServer(server) {
      server.middlewares.use((_req, res, next) => {
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
        res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
        next();
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use((_req, res, next) => {
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
        res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
        next();
      });
    },
  };
}

// 2026-08-28 重写：弃用裸全局 `define: { __DUMMY_AUTH__ }` 方案（Vite 8 dev client
// 不走 define 替换，详见 docs/08-known-risks/framework-pitfalls.md 第 6 节）。
// 改走 Vite 官方 env 机制：`npm run dev:dummy` = `vite --mode dummy` → 自动加载
// `.env.dummy` → 客户端读 `import.meta.env.VITE_DUMMY_AUTH === 'true'` 决定是否注入。
//
// 配置改成函数形式拿 `{ command, mode }`，配置求值期就能可靠判定 build vs serve。

function config({ command, mode }: { command: 'build' | 'serve'; mode: string }): UserConfig {
  // loadEnv 第三个参数 '' 表示读所有变量（不限 VITE_ 前缀），方便后面读 VITE_DUMMY_AUTH。
  const env = loadEnv(mode, process.cwd(), '');

  // 第一道 prod 保护：build 期只要 VITE_DUMMY_AUTH === 'true'（不论 mode 是什么，
  // 防住「.env.production 误设 VITE_DUMMY_AUTH=true」「--mode dummy build」两种情况）
  // 就硬 throw。dummy-auth 不得进 prod bundle。
  if (command === 'build' && env.VITE_DUMMY_AUTH === 'true') {
    throw new Error(
      '[dummy-auth] refusing to build with VITE_DUMMY_AUTH=true. ' +
        'Remove VITE_DUMMY_AUTH from your .env / .env.dummy or run dev mode only.',
    );
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
      crossOriginIsolation(),
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
        // 2026-09-20：STEP 3D 预览器（three + occt-wasm）。three 是 three.js 主体，
        // occt-wasm 是 OCCT emscripten 模块（webpack module federation 模式，需 esbuild
        // 预 bundle 才能正确解析）。
        'three',
        'occt-wasm',
      ],
    },
    // 2026-09-20：把 .wasm 视为资源（不参与 import graph 解析）。
    // occt-wasm 内部用 emscripten 的 fetch 走 `${origin}/occt-wasm.wasm` 直接 GET，
    // 不走 ES module import，所以 vite 不需要把它当模块；assetsInclude 只是让
    // 未来如果有 import xxx from '*.wasm' 也能正确处理。
    assetsInclude: ['**/*.wasm'],
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
            return;
          }
          defaultHandler(warning);
        },
        // 2026-09-20：把 three.js / occt-wasm 拆成独立 chunk，避免与业务 bundle 混在一起
        // 后每次小幅改动全量重传；occt-wasm 的 wasm 文件 22MB，单独 chunk 后首次加载
        // 才会拉，业务代码改动不会触发 occt-wasm chunk 重生。
        output: {
          manualChunks: (id: string): string | undefined => {
            if (id.includes('node_modules/three/')) return 'three';
            if (id.includes('node_modules/occt-wasm/')) return 'occt-wasm';
            return undefined;
          },
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
  };
}

export default defineConfig(config);
