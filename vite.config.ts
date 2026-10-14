import { defineConfig, loadEnv, type PluginOption, type UserConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import AutoImport from 'unplugin-auto-import/vite';
import Components from 'unplugin-vue-components/vite';
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers';
import { fileURLToPath, URL } from 'node:url';
// 2026-10-03 修缺陷新增：把 pdfjs-dist/cmaps/*.bcmap 以原名（无内容 hash）产出到
// dist/cmaps/。pdfjs 自行按 `cMapUrl + <name>.bcmap` 拼 URL、不查 manifest，而走资源图
// 的 `?url` 导入既会被 assetsInlineLimit 内联成 data URI、落文件时又会被加 hash，
// 两条路都拿不到原名文件（详见该模块内注释）。dev 不受影响，由 dev server 直接服务
// node_modules 下的原名文件。
import { pdfjsCmapsPlugin } from './scripts/pdfjsCmapsPlugin.ts';

// 2026-09-20 新增：COOP/COEP dev middleware。
//
// 背景：occt-wasm 当前在主线程跑（sandbox 初始化），不强制 SharedArrayBuffer。
// 但 occt-wasm 用 emscripten 主线程加载 wasm 时，部分浏览器要求页面必须
// Cross-Origin-Isolated（COOP/COEP 双头），否则 wasm streaming compile 失败。
// 给 dev server + preview server 加这两个 header，未来接入 occt-wasm Worker 时
// 也能直接复用，不需要再改。
//
// 仅 serve 模式（dev + preview server）由本插件加这两个头（occt-wasm 需要）；
// **生产 nginx 当前不带 COOP/COEP**（nginx.conf / nginx.http-only.conf 均无此二头）。
//
// ⚠️ 2026-10-12 补注 COEP `require-corp` 的副作用：跨域预览图（EdgeOne `previews/*`）
// 必须在响应侧回 `Cross-Origin-Resource-Policy: cross-origin`，否则被浏览器拦截 ——
// dev/preview 表现为图片加载失败，而把该 URL 在地址栏直开却正常。
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
        // 2026-09-28 review 跟进（M-2）：unplugin-vue-components 默认递归扫描
        // src/components/**/*.vue，会把 CosUploader/ 内的子组件 FileList / UploadArea
        // 也注册成全局组件。这些子组件仅在 index.vue <script setup> 内 import，
        // 全局可访问会污染组件命名空间（仓内已存在 FileListCard.vue，未来易撞名）。
        // 用 excludeNames 排除 FileList / UploadArea 两个组件名（unplugin 的
        // exclude 是 transform 过滤，excludeNames 才是注册过滤；这是该项目仓
        // 唯一一处 CosUploader 内部子组件名，全列白名单比正则更清晰）。
        excludeNames: ['FileList', 'UploadArea'],
      }),
      crossOriginIsolation(),
      pdfjsCmapsPlugin(),
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
    // ⚠️ 2026-10-21 实测订正：这不是「`?url` import 能被当资源处理的前提」——
    // 2026-10-21 实测（vite 8.3.1）整条删掉后产物与保留时**逐字节一致**：wasm 仍产出
    // `assets/occt-wasm-<hash>.wasm`、occt-wasm chunk 与首屏 modulepreload 列表都不变。
    // 原因：`?url` 由 query 自身被识别成资源引用，与扩展名无关；`wasm` 也不在 vite 的
    // `KNOWN_ASSET_TYPES` 内建表里（`.wasm` 默认走 vite 自带的 wasm 插件：`?init` → wasm-helper、
    // 裸 `.wasm` → wasm-direct，即编译并内联实例，不是资源 URL）。
    // 保留本项只为「将来若出现不带 query 的 `.wasm` import，仍按资源 URL 语义处理」；
    // 当前仓内唯一的 `.wasm` 引用（`OcctStepLoader.ts` 里的 `occt-wasm/dist/occt-wasm.wasm?url`）
    // 带 `?url`，本项当前零作用。
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
        // 后每次小幅改动全量重传；occt-wasm 的 wasm 文件 21MB，单独 chunk 后首次加载
        // 才会拉，业务代码改动不会触发 occt-wasm chunk 重生。
        //
        // 用 rolldown 的 `codeSplitting.groups`（而非已废弃的 `manualChunks`）表达这三条。
        // 第三条 `vite-preload-helper` 是 2026-10-21 新增的，理由与它的 `priority` 为什么
        // 不能省，见下方长注释。
        //
        // 三条的 `test` 都写函数。`test` 也接受正则字面量与 `new RegExp(...)`，三种写法
        // 实测产物逐字节一致（2026-10-21 实测，rolldown 1.2.11 + vite 8.3.1；正则按上游文档
        // 写 `[\\/]` 以兼容 Windows 路径分隔符），函数写法只是读起来更直白。
        // ⚠️ `test` 留空 = 「任何模块都算命中」，三条都不能省。
        output: {
          codeSplitting: {
            groups: [
              {
                name: 'occt-wasm',
                test: (id: string) => id.includes('node_modules/occt-wasm/'),
              },
              {
                name: 'three',
                test: (id: string) => id.includes('node_modules/three/'),
              },
              // 2026-10-21 新增。vite 把懒加载路由的预加载 helper 放在虚拟模块
              // `\0vite/preload-helper.js`（vite 侧常量 `preloadHelperId`）里，它不被上面
              // 两条命中 ⇒ 与 occt-wasm 的代码落进同一块 chunk；而入口静态引用这个 helper，
              // 于是静态依赖整块 occt-wasm，`index.html` 的 modulepreload 列表里就多出
              // 110KB（gzip 36KB）的低频 3D 代码 —— 而 3D 预览是低频功能，不该在首屏。
              //
              // 只记观测、不记机制：上游类型文档对「未被任何 group 命中的模块」的表述是
              // 「fall back to the automatic chunking」，与「被塞进第一个 group」不是同一条
              // 机制描述（2026-10-21 复核 `node_modules/rolldown` 的 `define-config-*.d.mts`
              // 时确认）；真正稳的是产物事实 —— helper 混在 occt-wasm chunk 里、该 chunk
              // 因此进首屏 preload，而 3D 预览本身只在懒路径上被引用。改分块后请以产物复核。
              //
              // `priority: 10` 是承重项，不能省：同优先级时 rolldown 按 group 的**声明顺序**
              // 决胜（上游文档原话：两个 group 同 priority 时取 index 更小的那个），而本组
              // 声明在 occt-wasm 之后 ⇒ 去掉 priority 后 helper 会被 occt-wasm 那条抢走，
              // 实测 occt-wasm chunk 由 111553 字节涨到 112710 字节并重新出现在首屏
              // modulepreload 列表里（2026-10-21 实测）。守卫见
              // `src/three/__tests__/occtWasmAssetPipeline.spec.ts`。
              {
                name: 'vite-preload-helper',
                test: (id: string) => id.includes('vite/preload-helper'),
                priority: 10,
              },
            ],
          },
        },
      },
    },
    server: {
      port: 5173,
      host: '0.0.0.0',
      proxy: {
        '/api': {
          target: 'http://127.0.0.1:3000',
          changeOrigin: true,
          ws: true,
        },
        // 2026-10-01 新增：WS 中枢 /ws/* 的 dev 反代。
        // 起因：dashboard WS 连的是 `${proto}://${location.host}/ws/dashboard`（api/dashboard.ts
        // 的 buildWsUrl），不带 /api 前缀，因此上面的 '/api' context 匹配不到。Vite 8 的 dev
        // upgrade 监听器只对匹配到的 proxy context 转发 proxy.ws，不匹配的路径掉出循环后
        // 不写任何响应 —— 浏览器看到的是「握手无响应」，而 HTTP 首屏快照走 /api 完全正常，
        // 于是表现为「页面数据正常但控制台一直刷 WS 报错」。
        // 复验：curl -i -N -H "Connection: Upgrade" -H "Upgrade: websocket" \
        //   -H "Sec-WebSocket-Version: 13" \
        //   -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
        //   "http://127.0.0.1:5173/ws/dashboard"   → 应从「零响应」变为 401（无 token）
        // 生产 / 预发不走这里：nginx.conf:141-154 已有 `location ^~ /ws/`（同形反代）。
        '/ws': {
          target: 'http://127.0.0.1:3000',
          changeOrigin: true,
          ws: true,
        },
      },
    },
  };
}

export default defineConfig(config);
