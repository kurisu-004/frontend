// utils/mergePdfs.ts
//
// 2026-08-22 从 PartsList.vue 批量打印流程抽出的纯函数：
// 浏览器端用 pdf-lib 把多个 PDF Blob 按数组顺序合并成单个 PDF Blob。
// 抽离目的：PartsList 瘦身 + 可单测（pdf-lib 在 vitest node 环境直接可跑）。

import { PDFDocument } from 'pdf-lib'

/** 按数组顺序合并多个 PDF Blob 为一个 PDF Blob。空数组 → 0 页 PDF。 */
export async function mergePdfBlobs(blobs: Blob[]): Promise<Blob> {
  const merged = await PDFDocument.create()
  for (const blob of blobs) {
    const pdf = await PDFDocument.load(await blob.arrayBuffer())
    const pages = await merged.copyPages(pdf, pdf.getPageIndices())
    for (const page of pages) {
      merged.addPage(page)
    }
  }
  const bytes = await merged.save()
  return new Blob([bytes.buffer as ArrayBuffer], { type: 'application/pdf' })
}
