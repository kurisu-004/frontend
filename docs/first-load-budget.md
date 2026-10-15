# 首屏与页面闭包预算（2026-10-21 新增）

> 本文件登记 **前端产物里「哪些重物必须懒、懒在哪、当前实测多少**」。
> 与 [`occt-wasm-asset-pipeline.md`](occt-wasm-asset-pipeline.md) 同一形态：
> 结论先说 → 为什么 → 怎么复核。CLAUDE.md「产物体积」一节是它的摘要。
>
> ⚠️ 全文体积单位与 `vite build` 的输出口径一致：**kB = 1000 字节**。

## 结论先说

| 口径                                   | 改前                  | 改后                        |
| -------------------------------------- | --------------------- | --------------------------- |
| **首屏**（`index.html` 声明的 JS+CSS） | 1138 KB / gzip 376 KB | **448 KB / gzip 143 KB**    |
| 进页面最重的一条路由（零件详情，JS）   | 3066 KB               | 1771 KB                     |
| `dist` 总量                            | 30 MB                 | 30 MB（不变）               |
| 3D 预览 wasm 的**首下传输量**          | 22.3 MB               | ~7.1 MB（nginx 开 gzip 后） |

⚠️ **两栏口径不同，别混**：`dist` 总量没变，因为优化搬的是「什么时候下载」而不是
「磁盘上放多少」；wasm 那 22MB 仍在产物里，只是传输时被 gzip 压掉 68%。

**首屏构成**（`index.html` 里 6 个 `modulepreload` + 2 个 CSS，合计 448 KB）：

| 文件                                               | raw    | gzip  |
| -------------------------------------------------- | ------ | ----- |
| `iam-*.js`（zod + axios）                          | 149 KB | 46 KB |
| `index-*.js`（应用代码 + 路由表）                  | 87 KB  | 29 KB |
| `runtime-core.esm-bundler-*.js`（vue runtime）     | 71 KB  | 27 KB |
| `css-*.js`（element-plus 共享组件）                | 44 KB  | 17 KB |
| `dist-*.js`（共享小件）                            | 30 KB  | 11 KB |
| `index-*.css` / `css-*.css`                        | 65 KB  | 11 KB |
| `rolldown-runtime` / `vite-preload-helper`（合计） | 2 KB   | 1 KB  |

**各路由「进页面就下载」的静态闭包**（判据与算法见文末「怎么复核」）：

（下表只数 JS —— CSS 不进这张闭包表；每个路由的闭包里**含**首屏那批 JS。）

| 路由         | 改前    | 改后    |
| ------------ | ------- | ------- |
| 零件详情     | 3066 KB | 1771 KB |
| 零件批量上传 | 2864 KB | 1158 KB |
| 装配件详情   | 2772 KB | 1641 KB |
| 工序设计     | 2567 KB | 1432 KB |
| 零件一览     | 2574 KB | 1038 KB |
| 大屏         | 1889 KB | 771 KB  |
| 待品检       | 1692 KB | 1003 KB |
| 生产统计     | 1620 KB | 932 KB  |
| 送货单一览   | 1508 KB | 820 KB  |
| 生产队列     | 1457 KB | 769 KB  |
| 账号管理     | 1470 KB | 781 KB  |
| 客户一览     | 1393 KB | 704 KB  |
| 报工台扫码闸 | 1153 KB | 463 KB  |

## 为什么：六类重物，全部是「低频功能挂在静态 import 上」

产物里最重的五个包，每一个都对应一个「用户很少做」的动作，但基线里它们都由**静态
import** 进入某个页面级 chunk。处置一律是「改成懒加载」，不改功能：

| 包                                                  | raw    | 谁原来静态引用它                                                                    | 现在怎么懒                                                   |
| --------------------------------------------------- | ------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| echarts + zrender + vue-echarts                     | 628 KB | `src/main.ts`（全局注册 `<v-chart>`）                                               | `defineAsyncComponent(() => import(...))`                    |
| pdfjs-dist 主模块（该 chunk 含 PdfViewer 组件本体） | 431 KB | `components/PdfViewer.vue` → `@/utils/pdfjs`                                        | `utils/pdfjs.ts::loadPdfjs()`（memo + 失败清位）             |
| xlsx                                                | 424 KB | `utils/{bid,historicalPrice,purchaseOrder}ExcelParser`                              | 三个 parser 改 type-only import，`utils` 由调用方传入        |
| pdf-lib                                             | 420 KB | `utils/mergePdfs.ts`                                                                | `mergePdfBlobs` 函数体内 `await import`                      |
| three.js                                            | 505 KB | `components/FileListCard.vue`、`views/production/components/DrawingPreviewPane.vue` | `defineAsyncComponent`（都挂在 `v-if`/`el-tab-pane` 门控内） |

**`cos-js-sdk-v5`（165 KB）已从依赖里彻底删除**（2026-10-15）：上传链路从「STS 临时
凭证 + SDK 直传」换成「预签 PUT URL + `XMLHttpRequest`」，不再需要 SDK，也不存在它的
懒加载入口（`utils/cosSdk.ts` 随之删除）。这条路当初要多付一次 memo 与失败清位的代价
（见 `utils/pdfjs.ts` 同款形态），如今整条路径都不复存在。

另有 `occt-wasm` 的 JS 胶水（109 KB）与 22 MB wasm 早已由
[`occt-wasm-asset-pipeline.md`](occt-wasm-asset-pipeline.md) 处理，不在本文件重复。

**判据**（这五条能成立，靠的是同一个前提）：低频组件要么挂在一个**用户动作门控**的
`v-if` / `el-tab-pane` / `destroy-on-close` 弹窗里，要么本来就只在某个按钮的处理函数里
跑 ⇒ 把它改成异步加载，代价都落在「用户已经在等」的那段时间里，首屏与页面首帧无感。

**反判据**：页面 `setup` 期就执行的逻辑不能改成异步（如路由守卫、pinia 初始化）。

## 三个「不要动」的结论

- **不要改 three 的引入方式**：`three@0.160` 走单文件 `build/three.module.js`，没有
  tree-shake 粒度；`import * as THREE` 拿不到更小的包。
- **不要为了体积换 xlsx**：`0.18.5` 的原型污染 / ReDoS 风险已登记在 CLAUDE.md「已知风险」。
- **不要合并 41 个 `css-*.js` 空壳 chunk**：那是 element-plus 按需 CSS 的正常产物。

## 怎么复核

### 首屏（产物层）

```bash
npx vite build
# ① 首屏声明了哪些文件、有没有 echarts
grep -o 'modulepreload[^>]*' dist/index.html | sed 's/></>\n</g'
grep -o '<script[^>]*>' dist/index.html
# ② echarts chunk 只被**动态** import 引用（下面两行应各只出一条，且不含 from"..."）
rg -o 'import\(`\./echarts[^`]*`\)' dist/assets/index-*.js
rg -o 'from"\./echarts[^"]*"' dist/assets/*.js
# ③ 换算成传输量（gzip 与 nginx 的 gzip_level 6 接近，brotli 更小）
gzip -9c dist/assets/index-*.js | wc -c
```

### 各路由「进页面就下载」的闭包

判据是**静态 import 闭包**（动态 import 是点按钮才发生的，不该算进首屏）。
逐 chunk 解析 `from "./x"` 与 `import("./x")` 两种形态后从路由 chunk 做一次 BFS 即可；
把 `three-*` / `pdf-*` / `xlsx-*` / `es-*` / `occt-wasm-*` 标出来，
「进页面就白带哪几个重物」一眼可见。改动前后各跑一次这张表对比。

### 运行时（真机人工确认一次）

异步注册与懒加载**证明不了运行时正确**，各留一条人工确认项：

- 打开 dashboard 与 statistics 各 tab ⇒ 图表出现，配色 / legend 位置与 v5 主题一致；
- 打开任一零件的 PDF 图纸预览 ⇒ canvas 出图，中文不画成方块；
- 打开任一 STEP / IGES 文件的 3D 预览 ⇒ 模型渲染成功。

## nginx：wasm 必须开 gzip

`gzip_types` 不列 `application/wasm` 时 **nginx 完全不解压**（内建默认只有 `text/html`）
⇒ 3D 预览首下 22.3 MB。已加在 `nginx.conf`（HTTPS 块）与 `nginx.http-only.conf`
（HTTP 块）两处，**两块必须逐字同步**，理由写在配置文件里。
