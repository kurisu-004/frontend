// views/parts/composables/useBatchPrint.ts
//
// 2026-08-22 从 PartsList.vue 抽出：批量打印图纸（iframe + 批次并发 + PDF 合并）。
//
// 2026-08-22：PDF 合并已抽到 src/utils/mergePdfs.ts（mergePdfBlobs），这里只调它。

import { onBeforeUnmount, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { printPartDrawingBatch } from '@/api/parts'
import { mergePdfBlobs } from '@/utils/mergePdfs'
import type { SelectedRowType } from './usePartBatchSelection'

export interface UseBatchPrintDeps {
  selectedIds: Set<string>
  selectedRowTypes: Map<string, SelectedRowType>
}

export function useBatchPrint(deps: UseBatchPrintDeps) {
  const batchPrinting = ref(false)
  const batchPrintProgress = ref(0)
  const batchPrintCurrent = ref(0)
  const batchPrintTotal = ref(0)
  const iframeRef = ref<HTMLIFrameElement | null>(null)
  let blobUrl = ''

  async function onBatchPrint(): Promise<void> {
    if (deps.selectedIds.size === 0) return

    const PART_BATCH_SIZE = 20
    const ASSEMBLY_BATCH_SIZE = 2
    const CONCURRENCY = 3

    batchPrinting.value = true
    try {
      const partIds: string[] = []
      const assemblyIds: string[] = []
      // 2026-07-31：以 selectedIds 为唯一来源遍历（之前用 selectedRowTypes 当主源
      // 会让取消勾选的残留 id 仍然送进后端，UI 计数 ≠ 实际打印集合）。
      for (const id of deps.selectedIds) {
        const t = deps.selectedRowTypes.get(id)
        if (t === 'ASSEMBLY') assemblyIds.push(id)
        else partIds.push(id)
      }

      // 构建批次队列：先零件后装配体
      const batches: { partIds: string[]; assemblyIds?: string[] }[] = []
      for (let i = 0; i < partIds.length; i += PART_BATCH_SIZE) {
        batches.push({ partIds: partIds.slice(i, i + PART_BATCH_SIZE) })
      }
      for (let i = 0; i < assemblyIds.length; i += ASSEMBLY_BATCH_SIZE) {
        batches.push({
          partIds: [],
          assemblyIds: assemblyIds.slice(i, i + ASSEMBLY_BATCH_SIZE),
        })
      }

      if (batches.length === 0) return

      batchPrintTotal.value = batches.length
      batchPrintCurrent.value = 0
      batchPrintProgress.value = 0

      let doneCount = 0
      const batchBlobs: Blob[] = new Array(batches.length)

      const tasks = batches.map((b, idx) => async () => {
        const blob = await printPartDrawingBatch(
          b.partIds,
          b.assemblyIds && b.assemblyIds.length > 0 ? b.assemblyIds : undefined,
        )
        batchBlobs[idx] = blob
        doneCount++
        batchPrintCurrent.value = doneCount
        batchPrintProgress.value = Math.round((doneCount / batches.length) * 100)
      })

      // 简易并发池（最多 CONCURRENCY 个并发）
      let nextIdx = 0
      async function worker(): Promise<Error | null> {
        while (nextIdx < tasks.length) {
          const i = nextIdx++
          try {
            await tasks[i]()
          } catch (err) {
            return err as Error
          }
        }
        return null
      }
      const errors = await Promise.all(
        Array.from({ length: CONCURRENCY }, () => worker()),
      )
      const firstError = errors.find((e) => e !== null)
      if (firstError) {
        throw new Error(`第 ${batchPrintCurrent.value + 1} 批生成失败：${firstError.message}`)
      }

      // 2026-08-22：PDF 合并抽到 src/utils/mergePdfs.ts（纯函数 + 单测覆盖）。
      const mergedBlob = await mergePdfBlobs(batchBlobs)

      if (blobUrl) URL.revokeObjectURL(blobUrl)
      blobUrl = URL.createObjectURL(mergedBlob)

      const iframe = iframeRef.value
      if (!iframe) {
        ElMessage.error('打印 iframe 未挂载，请刷新页面后重试')
        return
      }
      iframe.src = blobUrl
      iframe.onload = () => {
        try {
          iframe.contentWindow?.focus()
          iframe.contentWindow?.print()
        } catch {
          // sandbox / cross-origin 等极端情况下 fallback 到新窗口打印
          const w = window.open(blobUrl, '_blank')
          if (w) w.print()
        }
      }
    } catch (e) {
      await ElMessageBox.alert(
        (e as Error).message ?? '批量打印失败',
        '错误',
        { confirmButtonText: '确定', type: 'error' },
      )
    } finally {
      batchPrintTotal.value = 0
      batchPrintCurrent.value = 0
      batchPrintProgress.value = 0
      setTimeout(() => { batchPrinting.value = false }, 800)
    }
  }

  onBeforeUnmount(() => {
    if (blobUrl) {
      URL.revokeObjectURL(blobUrl)
      blobUrl = ''
    }
  })

  return {
    batchPrinting,
    batchPrintProgress,
    batchPrintCurrent,
    batchPrintTotal,
    iframeRef,
    onBatchPrint,
  }
}
