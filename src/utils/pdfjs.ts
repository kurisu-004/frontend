// utils/pdfjs.ts
//
// pdfjs-dist 单点配置：workerSrc + 浏览器缓存穿透 + cMap。
// PdfViewer.vue / parts/new 域（usePartBatchPdf.ts）统一从这里拿 pdfjsLib，
// 不要各自 import 'pdfjs-dist'。
//
// 背景（2026-07-19）：7-17 前生产 nginx 未配 .mjs 的 MIME，pdf worker 以
// application/octet-stream + Cache-Control: max-age=31536000, immutable 下发，
// 被浏览器按年缓存。worker 文件名是 Vite 内容 hash，服务端修复 MIME 后文件名不变，
// 中毒缓存会被整年复用（控制台报「Failed to load module script ... octet-stream」，
// pdfjs 退化到主线程 fake worker）。在 workerSrc 后追加版本查询参数改变缓存键，
// 强制浏览器重新请求拿到修正后的响应。今后若再遇类似缓存中毒，递增下面的版本串即可。
//
// cMap（2026-10-03 修缺陷重写）：中文 / 日文 PDF 渲染时，pdfjs 找不到字体 CMap 会打印
// "UnknownErrorException: Ensure that the `cMapUrl` API parameter is provided."
// 并把字符画成方块。此前打包靠 `import.meta.glob('/node_modules/pdfjs-dist/cmaps/*.bcmap',
// { query: '?url' })` 收集 URL 再取首项的目录前缀，有两个只在 build 后才爆发的失效点：
//   ① `?url` 导入同样过 Vite 的 shouldInline()，即受 build.assetsInlineLimit
//      （默认 4096 字节）约束 —— 低于阈值的资源被内联成 base64 data URI 而非落文件。
//      cmaps/ 下 168 个 .bcmap 有 134 个 < 4096；而字典序第一个 `78-EUC-H.bcmap`
//      只有 2404 字节，恰好属于被内联的那批 ⇒ 取到的「首项」本身就是一整条 base64
//      data URI，再按 `/[^/]+$/` 截前缀得到的仍是垃圾。
//   ② 侥幸落成文件的那批，Vite 会按内容加 hash（Adobe-GB1-UCS2-<hash>.bcmap），而 pdfjs
//      不查 manifest：worker 的 fetchBuiltInCMap 把 `<name>.bcmap` 发回主线程，
//      BaseBinaryDataFactory 按 `cMapUrl + filename` 直接 fetch，按原名请求必然 404。
// 两者叠加的后果是「矢量线条照常画、整份 PDF 的文字（尺寸标注 / 标题栏 / 中文标签）
// 整体消失且界面不报错」—— pdfjs 的 loadFont 对 translateFont 的 rejection 只 warn
// 后塞一个 ErrorFont 兜底。
// 现改为显式路径常量：dev 由 Vite dev server 直接服务 node_modules 下的原名文件，
// build 由 scripts/pdfjsCmapsPlugin.ts 的 emitFile 产出 dist/cmaps/<原名>.bcmap（无 hash）。
// 三处（此常量 / 该插件 / nginx 的 `location ^~ /cmaps/`）必须同步改。

import * as pdfjsLib from 'pdfjs-dist';
import PdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

const PDF_WORKER_CACHE_BUST = 'v=20260719';

pdfjsLib.GlobalWorkerOptions.workerSrc = `${PdfWorkerUrl}?${PDF_WORKER_CACHE_BUST}`;

/**
 * 选 cMap 的 base 路径（2026-10-03）。抽成纯函数只为让 dev / build 两条分支都能被
 * 单测直接覆盖：import.meta.env.DEV 在 vitest 里恒为 true，只断言导出常量的
 * PDF_CMAP_URL 只能验到 dev 那一条，build 分支回归时不会有任何测试失败。
 */
export function cMapBaseUrl(isDev: boolean, baseUrl: string): string {
  return `${baseUrl}${isDev ? 'node_modules/pdfjs-dist/cmaps/' : 'cmaps/'}`;
}

/** 形如 `/cmaps/`（build）/ `/node_modules/pdfjs-dist/cmaps/`（dev），pdfjs 后续自己拼 `<name>.bcmap`。 */
export const PDF_CMAP_URL = cMapBaseUrl(import.meta.env.DEV, import.meta.env.BASE_URL);

/** 在 getDocument 时传入，启用 cMap 渲染。 */
export const PDF_CMAP_OPTIONS = {
  cMapUrl: PDF_CMAP_URL,
  cMapPacked: true,
} as const;

export { pdfjsLib };

/**
 * 读取本地 File 的 PDF 页数（2026-09-27 从 composables/usePdfPageCount.ts 下沉到这里）。
 * 不发起网络请求；损坏 / 加密 / 非 PDF → 抛错（调用方负责 ElMessage 提示）。
 *
 * destroy() 必须在 PDFDocumentLoadingTask 上调用，不在 PDFDocumentProxy 上（旧实现
 * 调 doc.destroy() 抛 "doc.destroy is not a function"）。
 */
export async function countPdfPages(file: File): Promise<number> {
  const buf = await file.arrayBuffer();
  const task = pdfjsLib.getDocument({ data: buf });
  try {
    const doc = await task.promise;
    return doc.numPages;
  } finally {
    await task.destroy();
  }
}
