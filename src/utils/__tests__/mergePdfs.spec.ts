import { describe, expect, it } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { mergePdfBlobs } from '../mergePdfs'

/** 造一个 pageCount 页的空白 PDF Blob。 */
async function makePdfBlob(pageCount: number): Promise<Blob> {
  const doc = await PDFDocument.create()
  for (let i = 0; i < pageCount; i++) {
    doc.addPage([200, 200])
  }
  const bytes = await doc.save()
  return new Blob([bytes.buffer as ArrayBuffer], { type: 'application/pdf' })
}

describe('mergePdfBlobs', () => {
  it('多个 PDF 合并后页数累加', async () => {
    const merged = await mergePdfBlobs([
      await makePdfBlob(1),
      await makePdfBlob(2),
      await makePdfBlob(3),
    ])
    const doc = await PDFDocument.load(await merged.arrayBuffer())
    expect(doc.getPageCount()).toBe(6)
    expect(merged.type).toBe('application/pdf')
  })

  it('保持输入顺序（逐份追加）', async () => {
    // 两份各 1 页但尺寸不同 → 合并后第 1 页应来自第 1 份
    const a = await PDFDocument.create()
    a.addPage([100, 100])
    const b = await PDFDocument.create()
    b.addPage([300, 400])
    const blobA = new Blob([(await a.save()).buffer as ArrayBuffer])
    const blobB = new Blob([(await b.save()).buffer as ArrayBuffer])

    const merged = await mergePdfBlobs([blobA, blobB])
    const doc = await PDFDocument.load(await merged.arrayBuffer())
    expect(doc.getPageCount()).toBe(2)
    expect(doc.getPage(0).getSize()).toEqual({ width: 100, height: 100 })
    expect(doc.getPage(1).getSize()).toEqual({ width: 300, height: 400 })
  })

  it('空数组返回 1 页空 PDF（pdf-lib 1.17 行为：save+load 至少 1 页）', async () => {
    const merged = await mergePdfBlobs([])
    const doc = await PDFDocument.load(await merged.arrayBuffer())
    // pdf-lib 1.17.x：PDFDocument.create().save() 后再 load 会得到 1 页空文档，
    // 这是库本身的序列化行为，不是 mergePdfBlobs 的 bug。空数组分支只在
    // useBatchPrint 兜底触发（batches.length === 0 已早 return），不影响生产路径。
    expect(doc.getPageCount()).toBe(1)
  })
})
