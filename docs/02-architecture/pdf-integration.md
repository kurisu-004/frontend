# PDF 集成

> **目标读者**：Agent 加新 PDF 视图 / 排查"PDF 打不开 / worker 报错" / 部署运维排查 .mjs MIME
> **核心价值**：pdfjs 单点配置、worker 缓存穿透、CJK 支持、nginx `.mjs` 配置联动
> **最后更新**：2026-08-26 · **维护者**：@frontend-team

---

## 单点 import：`src/utils/pdfjs.ts`

所有 PDF 渲染必须从 `src/utils/pdfjs.ts` 拿 `pdfjsLib`，**不要**直接 `import ... from 'pdfjs-dist'`。文件头部注释里写明了三件单点配置的初始化：

- `workerSrc` 带 `?PDF_WORKER_CACHE_BUST` 后缀
- `PDF_CMAP_URL` 通过 `import.meta.glob` 把 `pdfjs-dist/cmaps/*.bcmap` 拷进 assets，取目录前缀
- `PDF_CMAP_OPTIONS`（`cMapUrl` + `cMapPacked: true`）供 `getDocument()` 使用

反例——绕过单点配置的后果：

```ts
// 错：workerSrc 未配置 → pdfjs 退化到主线程 fake worker，大 PDF 卡死
//     cMap 也没设 → CJK PDF 字符画成方块
import { getDocument } from 'pdfjs-dist'
```

正例：

```ts
import { pdfjsLib, PDF_CMAP_OPTIONS } from '@/utils/pdfjs'

const task = pdfjsLib.getDocument({ url: pdfUrl, ...PDF_CMAP_OPTIONS })
```

单点配置里做的事没法在每个调用方各自重复（worker 路径带 hash / cMapUrl 是相对 assets 的运行时路径），所以强约束走"单点 import"。

## `PDF_WORKER_CACHE_BUST` 版本串

`src/utils/pdfjs.ts` 顶部：

```ts
const PDF_WORKER_CACHE_BUST = 'v=20260719'
pdfjsLib.GlobalWorkerOptions.workerSrc = `${PdfWorkerUrl}?${PDF_WORKER_CACHE_BUST}`
```

**历史教训（2026-07-19 复盘）**：生产 nginx 没配 `.mjs` 的 MIME，pdf worker 以 `application/octet-stream` + `Cache-Control: max-age=31536000, immutable` 下发。worker 文件名是 vite 内容 hash，nginx 修复 MIME 后文件名不变，被浏览器按年缓存的"中毒响应"继续整年复用——控制台报 `Failed to load module script ... octet-stream`，pdfjs 退化到主线程 fake worker，所有 PDF 预览卡顿。

解决方案是给 `workerSrc` 追加查询参数改变缓存键，强制浏览器重新请求拿到修正后的响应。

**何时递增版本串**（如改成 `'v=20260826'`）：

- pdfjs 版本升级（worker 行为变化）
- cache 中毒（任何形式：MIME 错配 / 错版本被 immutable 缓存）
- nginx 修复 `.mjs` 配置后第一次上线（让所有用户清掉旧缓存）

递增成本极低（一个常量字符串），收益是绕开"旧缓存 + 新配置"的不一致窗口。

## `PDF_CMAP_OPTIONS` 与 cMap 部署

CJK PDF（中文 / 日文 / 韩文）需要 cMap（字符名 → glyph index 的映射表）。`src/utils/pdfjs.ts` 通过 `import.meta.glob` 把 `pdfjs-dist/cmaps/*.bcmap` 全部以 `?url` 拷进 vite assets，目录前缀作为 `cMapUrl`。PdfViewer 渲染时传入：

```ts
{ cMapUrl: PDF_CMAP_URL, cMapPacked: true }
```

部署侧确保 `assets/cmaps-*.js`（vite 打包产物）在 nginx 可访问——目前 vite 已默认把 `import.meta.glob` 引用的所有 `.bcmap` 拷进 `dist/assets/`，跟着前端镜像走，不需要额外配置。

**注**：直接 `import ... from 'pdfjs-dist/cmaps/?url'` 对目录无效（Rolldown / vite 不解析），必须用 `import.meta.glob('.../*.bcmap', { query: '?url', import: 'default' })`——见 `src/utils/pdfjs.ts` 实现。

## `PdfViewer.vue` 组件

路径：`src/components/PdfViewer.vue`（已存在，直接 import 复用即可，不要再写第二个 PDF 渲染组件）。

Props：

| 名称 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `url` | `string` | — | PDF 的可访问 URL（一般是后端即时签发的 COS 临时链接） |
| `page` | `number` | `1` | 初始页码（外部受控可用 `watch` 同步） |
| `initialScale` | `number` | `1.0` | 初始缩放，范围 `0.4 ~ 3.0` |

事件：无显式 `emit`——外部若要监听翻页/缩放，`watch(props.page)` 与 `watch(props.url)` 即可。内部已经按 `page` / `scale` reactive 驱动 `render()`。

渲染细节：

- canvas 自适应 devicePixelRatio（高分屏不糊）
- `renderTask` 在 unmount 与 page/scale 变化前 `cancel()`，避免快速翻页时旧 task 与新 task 抢 canvas
- 提供的 toolbar：上一页 / 下一页、缩放（数字输入 + ±0.2 按钮）、下载（直接 `<a download>` 触发浏览器下载）

典型用法：

```vue
<PdfViewer :url="cosSignedUrl" :page="currentPage" @vue:updated="..." />
```

## `mergePdfs.ts` 工具

路径：`src/utils/mergePdfs.ts`。

```ts
export async function mergePdfBlobs(blobs: Blob[]): Promise<Blob>
```

浏览器端用 `pdf-lib` 按数组顺序合并多个 PDF Blob 为单个 Blob。空数组 → 0 页 PDF（不抛错）。典型场景：批量打印前把多张图纸 PDF 合并成一份下发；PartsList 批量送检时图纸双面合并。

单测入口：`src/utils/__tests__/mergePdfs.spec.ts`（`pdf-lib` 在 vitest node 环境直接可跑，纯函数）。

注意：mergePdfs 走 pdf-lib，与 pdfjs-dist 是两套独立的库——合并后的 PDF 仍由 PdfViewer 渲染时，PDF_CMAP_OPTIONS 同样适用。

## nginx `.mjs` location 块

`nginx.conf` 里有一段与 `src/utils/pdfjs.ts` 联动的配置：

```nginx
location ~* \.mjs$ {
    default_type application/javascript;
    expires 1h;
    try_files $uri =404;
}
```

**为什么独立写一段**：

1. `mime.types` 默认不带 `.mjs` 映射，nginx 会把 worker 当 `application/octet-stream` 下发，浏览器「MIME type checking for module scripts」拒绝加载。
2. 这条 location 是正则，优先级高于前缀 `location /assets/`——必须独立覆盖，否则 `/assets/pdf.worker.min-*.mjs` 会被 `/assets/` 块接管，缓存策略也会被 `1y immutable` 接管，新 worker 推不出去。
3. 缓存策略故意 `expires 1h` + 不加 `immutable`——MIME 修复后再出问题，1 小时内浏览器自动 revalidate 拿到正确响应，**不会**像 `/assets/` 的 1y immutable 那样长期持有中毒缓存。

## 缓存策略完整图

| 路径 | Cache-Control | 用途 |
| --- | --- | --- |
| `/` (HTML) | 无缓存（`expires -1` 默认） | SPA 入口，每次验证最新 |
| `/assets/*.{js,css}` | `public, max-age=31536000, immutable` | vite 打包出的内容 hash 文件，内容变则文件名变 |
| `*.mjs`（含 worker） | `expires 1h`，不强制 immutable | pdfjs worker 等模块脚本，1h revalidate |
| `/api/*` | `no-cache`（默认） | 后端响应永远验证 |

**MCP 端点（`/api/mcp*`、`/mcp`）在 nginx 层 `deny all`**——应用层无鉴权，安全完全靠 nginx + 云安全组。这条与 PDF 无关但属于同层"反向用 nginx 加固"的设计，详见 nginx.conf 注释。
