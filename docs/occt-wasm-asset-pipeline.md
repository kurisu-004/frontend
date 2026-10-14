# occt-wasm 产物链（分块 + wasm 定位）

> 2026-10-21 新增。本文件登记 **3D 预览（occt-wasm）在构建产物里的当前形态**：
> 它被切成哪几块、wasm 从哪个 URL 加载、产物里各有一份什么。
> 口径的守门在 `src/three/__tests__/occtWasmAssetPipeline.spec.ts`（配置层），
> 产物层的核对方法见文末「怎么复核」。

## 结论先说

| 事项                               | 当前形态                                                                                 |
| ---------------------------------- | ---------------------------------------------------------------------------------------- |
| 首屏 `index.html` 的 modulepreload | `rolldown-runtime` / `css` / `iam` / `vite-preload-helper`（1.2KB）—— **不含 occt-wasm** |
| occt-wasm 的 JS                    | 独立 chunk `assets/occt-wasm-<hash>.js`（约 110KB），只被 3D 预览那条懒路径静态引用      |
| three.js 的 JS                     | 独立 chunk `assets/three-<hash>.js`（约 505KB）                                          |
| wasm 二进制                        | **只有一份** `assets/occt-wasm-<hash>.wasm`（约 21MB，带内容 hash）                      |
| `public/` 下的 occt-wasm 拷贝      | **没有**（整条 postinstall 拷贝链路已下线）                                              |

## 分块：为什么入口曾经白带 110KB

vite 把懒加载路由的预加载 helper（`__vitePreload`）放在一个**虚拟模块**里，模块 id 是
`\0vite/preload-helper.js`（vite 侧常量 `preloadHelperId`，见 `vite/dist/node/chunks/node.js`）。
它不被任何业务规则命中，而 **rolldown 会把没被任何 group 命中的模块塞进它创建的第一个 group**
—— 那恰好是 `occt-wasm`。于是入口为了静态引用这个 helper 而静态依赖整块 occt-wasm，
`index.html` 的 modulepreload 列表里就多出 110KB（gzip 36KB）的低频 3D 代码。

处置是给它一条显式的 group（`vite-preload-helper`），首屏只多带 1.2KB 的 helper。
两条承重约束（都在 spec 里守着，也都实测过）：

- **`priority: 10` 不能省**。同优先级时 rolldown 按 group 的**声明顺序**决胜：实测
  `priority: 0` 且该组声明在 `occt-wasm` 之后时整条失效；写成显式更高优先级后，
  把该组挪到最前 / 最后、把名字换成排序在 `occt-wasm` 之后的 `zzz-preload-helper`，
  产物字节一致。
- **`test` 必须写函数**。同一批实测里 `test: /node_modules[\/]occt-wasm[\/]/` 这种正则写法
  一条都匹配不到 —— occt-wasm chunk 会退化成只剩 emscripten 胶水层，包的 `index.js` /
  `types.js` / `svg.js` / `xcaf-document.js` 散回业务 chunk，破坏「occt-wasm 独立 chunk」
  这条本来的意图。函数写法才与旧的 `manualChunks` 捕获范围一致。

`manualChunks`（rolldown 里已标 deprecated）能达成同样的产物，**但它的分块结果依赖 chunk 名
的字典序**：实测只有当 helper 那块的块名排在 `occt-wasm` 之前（`aaa-preload` ✅ /
`vendor-preload` ❌）才生效。名字一改就静默失效，故改用 `codeSplitting.groups`。

## wasm 定位：为什么从两份收成一份

`node_modules/occt-wasm/dist/occt-wasm.js`（emscripten 产物）内部写着
`new URL("occt-wasm.wasm", import.meta.url)`，vite 扫到这行就会把 21MB 的 wasm 从资源图
emit 一份带 hash 的。同时仓库曾有一条 postinstall 钩子（`scripts/copy-occt-wasm.mjs`）
把**同一个文件**拷进 `public/`，供代码里写死的 `${origin}/occt-wasm.wasm` 定位用。
两个来源指向同一个文件、产出两份 21MB，而运行时只用得上写死路径那份（显式传了 wasm URL
⇒ emscripten 的 `locateFile` 分支恒生效，它自己那行 `new URL` 走不到）。

现在 wasm 由 `src/three/OcctStepLoader.ts` 里这条 import 定位：

```ts
import occtWasmUrl from 'occt-wasm/dist/occt-wasm.wasm?url';
// ...
OcctKernel.init({ wasm: occtWasmUrl });
```

两个来源因此收敛到同一个文件路径，vite 侧只 emit 一份。附带两个收益：

- wasm 有了内容 hash ⇒ nginx 的 `location /assets/`（`expires 1y` + `immutable`）能对它生效，
  不用再担心「同名文件换内容后客户端拿旧字节」。
- 21MB 从产物里少了一份（另有一份 123KB 的 `public/occt-wasm.js` 同理消失 —— 它从未被
  任何代码引用过，`OcctKernel.init` 内部是 `await import("./occt-wasm.js")`，走的是包内相对路径）。

⚠️ `wasm` 是 occt-wasm **5.4.0** 起的正式选项名（`wasmUrl` / `wasmPath` 已标 deprecated），
依赖 `package-lock.json` 里 pin 的 5.4.0；`package.json` 的声明是 `^5.3.2`，用 `npm ci` 装到的是
5.4.0。

## 已随本次下线的两处

- `package.json` 的 `postinstall` 钩子；
- `scripts/copy-occt-wasm.mjs`。

⚠️ `.gitignore` 里 `/public/occt-wasm.wasm` / `/public/occt-wasm.js` 两条已失效（生成物不再存在），
留着无害（真有人手工把文件拷进去仍会被忽略），本次未清理。
`Dockerfile` 顶部「npm ci 之前必须先把 scripts/ 放进上下文」那条注释的**理由**也已不成立
（`scripts/` 目录里还有 `pdfjsCmapsPlugin.ts` 被 `vite.config.ts` import，COPY 本身仍必需），
本次未清理。

## 怎么复核（产物层）

occt-wasm 是 emscripten 主线程 wasm，node / happy-dom 环境跑不了真实加载
（见 `src/components/cad-viewer/__tests__/StepViewer.spec.ts` 的既有登记），
所以产物层只能靠手工跑一次构建来核对：

```bash
npx vite build --outDir /tmp/verify-occt --emptyOutDir
# ① 首屏不该 preload occt-wasm
grep modulepreload /tmp/verify-occt/index.html
# ② wasm 只有一份、且带 hash
find /tmp/verify-occt -name '*.wasm' -exec ls -lh {} \;
# ③ occt-wasm 仍是独立 chunk、且仍被懒路径引用（sourcemap 能看到 chunk 内含哪些模块）
npx vite build --outDir /tmp/verify-occt --emptyOutDir --sourcemap true
grep -o 'occt-wasm-[A-Za-z0-9_-]*\.js' /tmp/verify-occt/assets/StepViewer-*.js | head -1
```

**运行时（真机）仍需人工确认一次**：打开任一零件详情的 3D 预览，看 devtools 网络面板里
wasm 请求命中 `/assets/occt-wasm-<hash>.wasm` 且 200、`application/wasm` 正常，
模型能正常渲染。构建产物层只能证明「引用关系对」，证明不了「浏览器里真能加载」。
