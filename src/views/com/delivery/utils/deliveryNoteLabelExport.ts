// src/views/com/delivery/utils/deliveryNoteLabelExport.ts
//
// 2026-10-09 新增：**「打印标签」的导出实现**（草稿卡片与详情页共用一份）。
//
// 标签不再经打印预览对话框：用户在表格里勾选零件 / 装配件行 → 点「打印标签」→ 直接
// 下载 xlsx（`deliveryNoteLabelWorkbook` 的单 sheet 渲染）。两处入口的行为必须一致
// （文件名、toast 措辞、已打印标记、绿底刷新），所以实现只落在这里，各页面调它。
//
// 为什么放域内 utils：它 import 了 `PartTreeRow`（域内类型），放 `src/utils/` 会让通用
// 工具反向依赖 `views/`（见 CLAUDE.md §目录归位）。

import { ElMessage } from 'element-plus';
import { triggerBrowserDownload } from '@/utils/download';
import { usePrintedLabels } from '../composables/usePrintedLabels';
import {
  DELIVERY_NOTE_LABEL_XLSX_MIME,
  renderDeliveryNoteLabelWorkbook,
} from './deliveryNoteLabelWorkbook';
import { partRowsToLabelRows, type PartTreeRow } from './deliveryNotePartRows';

/** 导出所需的单据最小字段（列表头与详情头都满足）。 */
export interface LabelExportNote {
  id: string;
  delivery_note_no: string;
}

/**
 * 导出勾选行的标签，并把它们登记为「已打印」（绿底随之刷新）。
 *
 * 空选不导出：`warn` 说清怎么补救即可，不发请求、不建空工作簿。打印按钮本身不做
 * disabled —— 「灰着不让点」只会让人猜原因。
 *
 * ⚠️ **只标记真正出纸的行**（`written`）：装配件父行在「后端没给可出货套数」时数量为空，
 * 渲染层会整行跳过（跳过条数如实写进 toast），把这些行记成已打印就是绿底骗人。
 * `member_ids` 本身是整行 batch_ids，所以一条行被标记时该零件的所有批次一起变绿。
 */
export async function exportPartRowsLabels(
  note: LabelExportNote,
  rows: readonly PartTreeRow[],
): Promise<void> {
  if (rows.length === 0) {
    ElMessage.warning('请先勾选要打印标签的零件/装配件');
    return;
  }
  try {
    const { bytes, skipped, written } = await renderDeliveryNoteLabelWorkbook(
      partRowsToLabelRows(rows),
    );
    triggerBrowserDownload(
      new Blob([bytes.slice().buffer as ArrayBuffer], { type: DELIVERY_NOTE_LABEL_XLSX_MIME }),
      `${note.delivery_note_no}-标签.xlsx`,
    );
    usePrintedLabels().markPrinted(note.id, written.flatMap((r) => r.member_ids ?? []));
    ElMessage.success(
      skipped > 0 ? `已导出标签（跳过 ${skipped} 条数量为空的行）` : '已导出标签',
    );
  } catch (e) {
    ElMessage.error((e as Error).message ?? '导出标签失败');
  }
}
