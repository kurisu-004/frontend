# occt-wasm 产物链（分块 + wasm 定位）

> 2026-10-21 新增。本文件登记 **3D 预览（occt-wasm）在构建产物里的当前形态**：
> 它被切成哪几块、wasm 从哪个 URL 加载、产物里各有一份什么。
> 口径的守门在 `src/three/__tests__/occtWasmAssetPipeline.spec.ts`（配置层），
> 产物层的核对方法见文末「怎么复核」。

## 结论先说

| 事项                               | 当前形态                                                                                     |
| ---------------------------------- | -------------------------------------------------------------------------------------------- |
| 首屏 `index.html` 的 modulepreload | `rolldown-runtime` / `css` / `iam` / `vite-preload-helper`（1.2KB）—— **不含 occt-wasm**     |
| `rolldown-runtime`                 | 901 字节，是 `index` 入口自身的模块运行时（入口与 occt-wasm chunk 都 import 它）⇒ 进 preload |
| occt-wasm 的 JS                    | 独立 chunk `assets/occt-wasm-<hash>.js`（约 110KB），只被 3D 预览那条懒路径静态引用          |
| three.js 的 JS                     | 独立 chunk `assets/three-<hash>.js`（约 505KB）                                              |
| wasm 二进制                        | **只有一份** `assets/occt-wasm-<hash>.wasm`（约 21MB，带内容 hash）                          |
| `public/` 下的 occt-wasm 拷贝      | **不再产出**（整条 postinstall 拷贝链路已下线）；旧机器上手动删一次即可，见文末              |

`vite-preload-helper` 那条 group 的 `includeDependenciesRecursively` 保持默认（true）即可：
实测产物里那个 1.2KB 的 helper chunk **一条 import 都没有**，`rolldown-runtime` 也没有被它
拽进去（两侧的 `rolldown-runtime` 都是同一个 901 字节的 chunk）。

## 分块：为什么入口曾经白带 110KB

vite 把懒加载路由的预加载 helper（`__vitePreload`）放在一个**虚拟模块**里，模块 id 是
`\0vite/preload-helper.js`（vite 侧常量 `preloadHelperId`，见 `vite/dist/node/chunks/node.js`）。
它不被任何业务 group 命中，于是混进了 occt-wasm 那条 group 的产物：入口为了静态引用这个
helper 而静态依赖整块 occt-wasm，`index.html` 的 modulepreload 列表里就多出 110KB
（gzip 36KB）的低频 3D 代码。

⚠️ 这里只登记**产物事实**，不登记 rolldown 的内部机制：上游类型文档对「未被任何 group 命中的
模块」的表述是「fall back to the automatic chunking」，与「被塞进第一个 group」不是同一条
机制描述（2026-10-21 复核 `node_modules/rolldown/dist/shared/define-config-*.d.mts` 时确认）。
可靠的判据是产物：helper 混在 occt-wasm chunk 里 ⇒ 该 chunk 进首屏 preload，而 3D 预览本身
只在懒路径（`StepViewer` chunk）上被引用。

处置是给它一条显式的 group（`vite-preload-helper`），首屏只多带 1.2KB 的 helper。
两条承重约束（都在 spec 里守着，也都实测过）：

- **`priority: 10` 不能省**。同优先级时 rolldown 按 group 的**声明顺序**决胜（上游文档原话：
  两个 group 同 `priority` 时取 index 更小的那个），而本组声明在 occt-wasm 之后 ⇒ 去掉
  `priority` 后 helper 被 occt-wasm 那条抢走：实测 occt-wasm chunk 由 111553 字节涨到
  112710 字节，并重新出现在 `index.html` 的 modulepreload 列表里（2026-10-21 实测）。
- **`test` 三种写法等价，写函数只为直白**。`test` 接受函数、正则字面量与 `new RegExp(...)`；
  2026-10-21 把三条全改成正则字面量再改回，产物与函数写法**逐字节一致**（含每个 chunk 的
  内容 hash）。正则要按上游文档写 `[\\/]` 才是跨平台的版本（`/` 只在 POSIX 路径下成立）。
  ⚠️ `test` 留空 = 「任何模块都算命中」，三条都不能省。

用 `codeSplitting.groups` 而不是 `manualChunks`（后者在 rolldown 里已 deprecated，且实测对
chunk 名的字典序敏感）。

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

⚠️ `wasm` 是 occt-wasm 的正式选项名（`wasmUrl` / `wasmPath` 在 5.x 全系都标了
`@deprecated`，5.0.0 起就有 `wasm`）。`package.json` 声明 `^5.4.0`、lockfile pin 5.4.0 ——
那个下限的含义是「本仓只在 5.4.0 上构建/验证过」，**不是** `wasm` 选项的功能下限。

## 已随本次下线的两处

- `package.json` 的 `postinstall` 钩子；
- `scripts/copy-occt-wasm.mjs`。

同批清掉的还有两处陈旧理由：`Dockerfile` 顶部「npm ci 之前必须先把 scripts/ 放进上下文」
的理由已改成 `vite.config.ts` import 了 `scripts/pdfjsCmapsPlugin.ts`（COPY 本身仍必需）；
`.gitignore` 里 `/public/occt-wasm.wasm` / `/public/occt-wasm.js` 两条 ignore 保留，理由
改成「生成链路已下线，保留仅为防误提交」。

## 判据为什么取「代码与配置」，不取「public/ 目录当前状态」

「产物里 wasm 只有一份」的**充分条件**是「没有任何代码 / 配置再往 `public/` 产出或定位这份
wasm」。这个条件完全由仓库内容决定，所以守卫守它：

- `src/**`、`vite.config.ts`、`index.html`、`scripts/**` 里没有任何字符串字面量指向
  `/occt-wasm.wasm`、`public/occt-wasm.wasm`、`${origin}/occt-wasm.wasm`（用 TS 词法扫描器
  逐个 token 判，注释里提到这些名字不算 —— 仓内正当地引用着它们）；
- `package.json` 里没有任何脚本提到 `occt-wasm`（判据不只看 `postinstall` 这一个键：钩子换名成
  `prepare` / `preinstall` 同样在 `npm ci` 时自动跑）；
- `.gitignore` 仍 ignore 那两个残留路径 ⇒ 残留即使没删也不可能被 `git add -A` 带进仓库。

⚠️ **`public/` 目录当前有没有留着一份拷贝不是判据**：那是本机环境状态。生成链路下线后，
旧机器上已存在的那份既不会被重新生成、也不会被自动清掉，拿它当断言会让守卫在「用户环境不
干净」时报红 —— 而那不是代码的问题。对应的判据见下一节。

## 旧机器上的残留清理（一次性人工动作）

从旧版本升级上来的机器上，`public/` 下可能还留着当年 postinstall 生成的那两份：

```
public/occt-wasm.wasm   # 约 21MB
public/occt-wasm.js     # 约 123KB
```

它们从未入 git（被 `.gitignore` 挡着），没有任何代码再引用，删掉即可：

```bash
rm -f public/occt-wasm.wasm public/occt-wasm.js
```

删不删都不影响构建产物（没有任何代码会去读它们），也不影响单测（判据不取目录状态，见上一
节）。留着只是白占 21MB 磁盘。

## 怎么复核（产物层）

occt-wasm 是 emscripten 主线程 wasm，node / happy-dom 环境跑不了真实加载
（`src/components/cad-viewer/__tests__/stepShapeRelease.spec.ts` 的头注释已登记同一条限制），
所以产物层只能靠手工跑一次构建来核对：

```bash
npx vite build --outDir /tmp/verify-occt --emptyOutDir
# ① 首屏不该 preload occt-wasm
grep -o 'modulepreload[^>]*' /tmp/verify-occt/index.html | sed 's/></>\n</g'
# ② wasm 只有一份、且带 hash
find /tmp/verify-occt -name '*.wasm' -exec ls -lh {} \;
# ③ occt-wasm 仍是独立 chunk、且只被懒路径（StepViewer）引用，入口不静态引用它
ls -l /tmp/verify-occt/assets/occt-wasm-*.js
grep -o 'from"\./occt-wasm[^"]*"' /tmp/verify-occt/assets/StepViewer-*.js | sort -u
grep -o 'from"\./occt-wasm[^"]*"' /tmp/verify-occt/assets/index-*.js | sort -u  # 应无输出
```

**运行时（真机）仍需人工确认一次**：打开任一零件详情的 3D 预览，看 devtools 网络面板里
wasm 请求命中 `/assets/occt-wasm-<hash>.wasm` 且 200、`application/wasm` 正常，
模型能正常渲染。构建产物层只能证明「引用关系对」，证明不了「浏览器里真能加载」。
