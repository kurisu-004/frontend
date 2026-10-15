// utils/mergePdfs.ts
//
// 2026-08-22 从 PartsList.vue 批量打印流程抽出的纯函数：
// 浏览器端用 pdf-lib 把多个 PDF Blob 按数组顺序合并成单个 PDF Blob。
// 抽离目的：PartsList 瘦身 + 可单测（pdf-lib 在 vitest node 环境直接可跑）。
//
// 2026-10-21：pdf-lib 改成函数体内动态 import。它约 415KB，而本文件是被
// `views/parts/list/composables/useBatchPrint.ts` 静态引用的 —— 于是「零件一览」这条
// 页面级静态闭包里白坐着 415KB，尽管合并只在用户勾选图纸点「批量打印」时才发生。
// `mergePdfBlobs` 本来就是 async，挪进函数体不改变任何调用形态。

/** 按数组顺序合并多个 PDF Blob 为一个 PDF Blob。空数组 → 0 页 PDF。 */
export async function mergePdfBlobs(blobs: Blob[]): Promise<Blob> {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- 动态 import 故意不进页面静态闭包，类型只能内联 typeof import() 反推
  const { PDFDocument }: typeof import('pdf-lib') = await import('pdf-lib');
  const merged = await PDFDocument.create();
  for (const blob of blobs) {
    const pdf = await PDFDocument.load(await blob.arrayBuffer());
    const pages = await merged.copyPages(pdf, pdf.getPageIndices());
    for (const page of pages) {
      merged.addPage(page);
    }
  }
  const bytes = await merged.save();
  return new Blob([bytes.buffer as ArrayBuffer], { type: 'application/pdf' });
}
