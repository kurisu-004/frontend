// views/parts/list/composables/useBatchPrint.ts
//
// 2026-08-22 从 PartsList.vue 抽出：批量打印图纸（iframe + 批次并发 + PDF 合并）。
//
// 2026-08-22：PDF 合并已抽到 src/utils/mergePdfs.ts（mergePdfBlobs），这里只调它。
//
// 2026-10-22：blob URL + 隐藏 iframe 的打印落地抽到 src/utils/iframePrint.ts。
// 本页在 keep-alive 缓存名单里（路由名 `PartsList` = 组件文件名），切走再回来时
// iframe 会因为被 `move()` 进游离容器而**重新加载 `src`** ⇒ 改前那个永不解绑的
// `iframe.onload` 会把 `print()` 再跑一遍，打印窗口自己弹回来。根因与四道闸的判据
// 见 iframePrint.ts 文件头，这里不再重复。

import { ref, type Ref } from 'vue';
import { ElMessageBox } from 'element-plus';
import { printPartDrawingBatch } from '@/api/parts';
import { mergePdfBlobs } from '@/utils/mergePdfs';
import { useIframePrint } from '@/utils/iframePrint';
import type { SelectedRowType } from './usePartBatchSelection';

export interface UseBatchPrintDeps {
  selectedIds: Set<string>;
  selectedRowTypes: Map<string, SelectedRowType>;
}

/** 2026-09-21 显式返回类型。 */
export interface UseBatchPrintReturn {
  batchPrinting: Ref<boolean>;
  batchPrintProgress: Ref<number>;
  batchPrintCurrent: Ref<number>;
  batchPrintTotal: Ref<number>;
  iframeRef: Ref<HTMLIFrameElement | null>;
  onBatchPrint: () => Promise<void>;
}

export function useBatchPrint(deps: UseBatchPrintDeps): UseBatchPrintReturn {
  const batchPrinting = ref(false);
  const batchPrintProgress = ref(0);
  const batchPrintCurrent = ref(0);
  const batchPrintTotal = ref(0);
  const iframeRef = ref<HTMLIFrameElement | null>(null);
  // 2026-10-22：打印宿主（blob URL 生命周期 + 一次性 onload + keep-alive deactivate
  // 拆解）交给共享 helper，本 composable 只剩「造 PDF」这一段批次编排。
  const { printBlob } = useIframePrint(iframeRef);

  async function onBatchPrint(): Promise<void> {
    if (deps.selectedIds.size === 0) return;

    const PART_BATCH_SIZE = 20;
    const ASSEMBLY_BATCH_SIZE = 2;
    const CONCURRENCY = 3;

    batchPrinting.value = true;
    try {
      const partIds: string[] = [];
      const assemblyIds: string[] = [];
      // 2026-07-31：以 selectedIds 为唯一来源遍历（之前用 selectedRowTypes 当主源
      // 会让取消勾选的残留 id 仍然送进后端，UI 计数 ≠ 实际打印集合）。
      for (const id of deps.selectedIds) {
        const t = deps.selectedRowTypes.get(id);
        if (t === 'ASSEMBLY') assemblyIds.push(id);
        else partIds.push(id);
      }

      // 构建批次队列：先零件后装配体
      const batches: { partIds: string[]; assemblyIds?: string[] }[] = [];
      for (let i = 0; i < partIds.length; i += PART_BATCH_SIZE) {
        batches.push({ partIds: partIds.slice(i, i + PART_BATCH_SIZE) });
      }
      for (let i = 0; i < assemblyIds.length; i += ASSEMBLY_BATCH_SIZE) {
        batches.push({
          partIds: [],
          assemblyIds: assemblyIds.slice(i, i + ASSEMBLY_BATCH_SIZE),
        });
      }

      if (batches.length === 0) return;

      batchPrintTotal.value = batches.length;
      batchPrintCurrent.value = 0;
      batchPrintProgress.value = 0;

      let doneCount = 0;
      const batchBlobs: Blob[] = new Array(batches.length);

      const tasks = batches.map((b, idx) => async () => {
        const blob = await printPartDrawingBatch(
          b.partIds,
          b.assemblyIds && b.assemblyIds.length > 0 ? b.assemblyIds : undefined,
        );
        batchBlobs[idx] = blob;
        doneCount++;
        batchPrintCurrent.value = doneCount;
        batchPrintProgress.value = Math.round((doneCount / batches.length) * 100);
      });

      // 简易并发池（最多 CONCURRENCY 个并发）
      let nextIdx = 0;
      async function worker(): Promise<Error | null> {
        while (nextIdx < tasks.length) {
          const i = nextIdx++;
          try {
            await tasks[i]();
          } catch (err) {
            return err as Error;
          }
        }
        return null;
      }
      const errors = await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
      const firstError = errors.find((e) => e !== null);
      if (firstError) {
        throw new Error(`第 ${batchPrintCurrent.value + 1} 批生成失败：${firstError.message}`);
      }

      // 2026-08-22：PDF 合并抽到 src/utils/mergePdfs.ts（纯函数 + 单测覆盖）。
      const mergedBlob = await mergePdfBlobs(batchBlobs);

      // 「iframe 未挂载」的报错由 printBlob 自己发，失败时返回 false，无需调用方分支。
      printBlob(mergedBlob);
    } catch (e) {
      await ElMessageBox.alert((e as Error).message ?? '批量打印失败', '错误', {
        confirmButtonText: '确定',
        type: 'error',
      });
    } finally {
      batchPrintTotal.value = 0;
      batchPrintCurrent.value = 0;
      batchPrintProgress.value = 0;
      setTimeout(() => {
        batchPrinting.value = false;
      }, 800);
    }
  }

  return {
    batchPrinting,
    batchPrintProgress,
    batchPrintCurrent,
    batchPrintTotal,
    iframeRef,
    onBatchPrint,
  };
}
