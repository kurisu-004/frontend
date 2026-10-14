// Tab 2「PDF 批量上传」的**解析段**（2026-10-20 从 usePartBatchPdf.ts 拆出）。
//
// 这一段覆盖「文件进来到行树成型」的整条链路：el-upload 钩子 → 解析（PDF 页数 +
// 文件名图号）→ 源文件区页树 → 选中页合并 / 合成行拆分 / 级联删除 → blob 预览 →
// 3D 模型按图号挂行。独立成模块的判据是**它只写「源」与「行」两样东西**：不碰提交态
// 之外的任何后端调用，也不碰 Excel 回填口径（那在回填段）。
//
// 两个横切关注点留在这一层，因为它们的触发点全在这里：
//  - **页切片**（pdf-lib load / copyPages / 单页切片登记 / 整批回滚）：三个建行入口里
//    有两个（合并成装配件 / 手动新增装配件）会切页，其中「手动新增」在行段；把这组函数
//    连同重入闸门与失败文案放一起，行段直接调用即可，不必各自复述 pdf-lib 的坑。
//  - **拖拽排序**：el-table 的 tbody 由 composable 持有并 provide 给模板（表格 DOM ref
//    经 EP 重建，必须由 composable 持有），只在行集合变动时发生，与建单无关。
//
// 依赖：共享状态层 + 回填段（`applyExcelToAll` / `readExcel`）。行段与提交段在本段之后
// 创建，故本段**不**依赖它们 —— 两个建行入口用的是状态层的 `makeStandaloneRow` /
// `makeAssemblyChild` / `makeAssemblyRow`（纯构造函数，不是行为）。

import { computed, provide, ref, watch, type ComputedRef, type Ref } from 'vue';
import { ElMessage, type UploadFile } from 'element-plus';
import { useLazyDraggable } from '@/composables/useLazyDraggable';
import { findElTableTbody } from '@/utils/elTable';
import { countPdfPages } from '@/utils/pdfjs';
import { parseDrawingFilename } from '@/utils/drawingFilename';
import { makeUid, pageUid, parsePageUid, stripExt } from './usePartBatchShared';
import type { PdfBatchState } from './usePartBatchPdfState';
import type { UsePartBatchPdfFill } from './usePartBatchPdfFill';
import type {
  AssemblyChildRow,
  PdfPreviewState,
  PdfSource,
  SourceTreeRow,
  StandalonePartRow,
} from './usePartBatchPdfTypes';
// type-only：只为 `loadPdfDoc` / `copyPagesFrom` 的返回类型标注。pdf-lib 的**值**必须
// 保持动态 import（切页只在建行时发生，不该进首屏 bundle）。
import type { PDFDocument as PdfLibDocument } from 'pdf-lib';

export interface UsePartBatchPdfParse {
  pdfBuildingTree: Ref<boolean>;
  pdfPreviewing: Ref<PdfPreviewState | null>;
  pdfPreviewVisible: Ref<boolean>;
  sourceTree: ComputedRef<SourceTreeRow[]>;
  onPdfChange: (file: UploadFile) => void;
  onPdfRemove: (file: UploadFile) => void;
  onExcelChange: (file: UploadFile) => void;
  onExcelRemove: (file: UploadFile) => void;
  onThreeDModelChange: (file: UploadFile) => void;
  onThreeDModelRemove: (file: UploadFile) => void;
  rebuildFromUploads: () => Promise<void>;
  clearSelection: (table?: { clearSelection: () => void } | null) => void;
  mergeSelectedAsPart: () => Promise<void>;
  mergeSelectedAsAssembly: () => Promise<void>;
  splitStandalonePart: (row: StandalonePartRow) => void;
  removePdf: (pdfUid: string) => void;
  removeStandalonePart: (uid: string) => void;
  removeAssembly: (uid: string) => void;
  pdfSourceLabel: (uid: string) => string;
  previewStandalonePart: (row: StandalonePartRow) => void;
  previewPdfSourceByUid: (uid: string) => void;
  closePdfPreview: () => void;
  onSourceSelectionChange: (rows: SourceTreeRow[]) => void;
  previewSourceRow: (row: SourceTreeRow) => void;
  // —— 以下供行段调用（页切片 + 重入闸门 + 失败文案）——
  loadPdfDoc: (raw: Blob) => Promise<PdfLibDocument>;
  pushPageSlice: (src: PdfSource, srcDoc: PdfLibDocument, pageIndex: number) => Promise<PdfSource>;
  rollbackPushedSources: (uid: string[]) => void;
  sliceFailedMessage: (src: PdfSource, e: unknown) => string;
  pageCountFailedMessage: (src: PdfSource, e: unknown) => string;
  rejectIfSlicing: () => boolean;
  /** 切页在途标记的读写口（供行段的「手动新增装配件」共用同一份标志）。 */
  setSlicing: (v: boolean) => void;
}

export function usePartBatchPdfParse(
  state: PdfBatchState,
  fill: UsePartBatchPdfFill,
): UsePartBatchPdfParse {
  const {
    pdfForm,
    pdfFiles,
    excelFiles,
    threeDModelFiles,
    allPdfs,
    selectedPages,
    standaloneParts,
    assemblies,
    excelByDrawingNo,
    makeStandaloneRow,
    makeAssemblyChild,
    makeAssemblyRow,
    guardRowMutation,
    resetCommitState,
  } = state;
  const { readExcel, applyExcelToAll } = fill;

  const pdfBuildingTree = ref(false);

  // PR-H 2026-07-28：拖拽排序 —— vue-draggable-plus 的 useDraggable composable
  // 在 setup 阶段调用一次后只在初始化时绑定一次目标 tbody；表格 DOM ref 必须
  // 由本 composable 持有（el-table tbody 会被 EP 重建），通过 provide 暴露给
  // PartBatchPdfTab 模板用 :ref 把实例回写到 ref。
  const standaloneTableRef = ref<{ $el?: HTMLElement } | null>(null);
  const assembliesTableRef = ref<{ $el?: HTMLElement } | null>(null);
  // useDraggable 真正要的 DOM 是 tbody；watcher 在 tableRef 解析后 query 出 tbody。
  const standaloneTbodyRef = ref<HTMLElement | null>(null);
  const assembliesTbodyRef = ref<HTMLElement | null>(null);

  /** 从 el-table 组件实例解析出 EP 渲染出的 tbody DOM。 */
  function resolveTbody(tableRef: Ref<{ $el?: HTMLElement } | null>): HTMLElement | null {
    return findElTableTbody(tableRef.value?.$el ?? null);
  }

  /** 只用于源文件区表格展示的原始（未合成）PDF。 */
  const originalPdfs = computed(() => allPdfs.value.filter((s) => !s.synthesized));

  /** 源文件区树状数据：仅显示多页 PDF（单页 PDF 已直接进独立零件表）。
   *  多页 PDF → 1 父行 + N 子页。 */
  const sourceTree = computed<SourceTreeRow[]>(() =>
    originalPdfs.value
      .filter((src) => src.totalPages > 1)
      .map((src) => ({
        id: src.uid,
        pdfSourceUid: src.uid,
        pageIndex: null,
        filename: src.filename,
        totalPages: src.totalPages,
        children: Array.from({ length: src.totalPages }, (_, i) => ({
          id: `${src.uid}:p${i}`,
          pdfSourceUid: src.uid,
          pageIndex: i,
          filename: `${src.filename}（第 ${i + 1} 页）`,
          totalPages: src.totalPages,
        })),
      })),
  );

  // el-upload 钩子
  function onPdfChange(file: UploadFile): void {
    // 多文件上传会触发多次 on-change；用 fileList 状态自动管理
    pdfFiles.value = fileList(pdfFiles.value, file, '.pdf');
  }
  function onPdfRemove(file: UploadFile): void {
    pdfFiles.value = pdfFiles.value.filter((f) => f.uid !== file.uid);
  }
  function onExcelChange(file: UploadFile): void {
    excelFiles.value = fileList(excelFiles.value, file, '.xlsx,.xls', /*matchExt*/ true);
  }
  function onExcelRemove(file: UploadFile): void {
    excelFiles.value = excelFiles.value.filter((f) => f.uid !== file.uid);
    // 2026-10-03：Excel 文件被移除 → 解析快照同步作废（否则会用已不在列表里的
    // Excel 数据继续回填新建行）。无条件作废的依据是快照只来自 rebuildFromUploads
    // 读到的 `excelFiles.value[0]`：el-upload 未开 `multiple` 也拦不住再次选文件，
    // onExcelChange 走 fileList 的追加语义，列表可能多于 1 个，而快照只对应该次
    // 解析时的第 1 个文件；移除后第 1 个文件可能已换人、甚至列表已空，旧快照无从
    // 校验。取舍：宁可清空导致「少填」，也不要沿用旧快照错填。
    excelByDrawingNo.value = null;
  }
  // PR-H 2026-07-28：3D 模型上传钩子
  function onThreeDModelChange(file: UploadFile): void {
    threeDModelFiles.value = fileList(
      threeDModelFiles.value,
      file,
      '.step,.stp,.iges,.igs,.stl,.obj,.3mf',
    );
  }
  function onThreeDModelRemove(file: UploadFile): void {
    threeDModelFiles.value = threeDModelFiles.value.filter((f) => f.uid !== file.uid);
  }

  /** 把新 file push 到 list（去重 by uid），扩展名校称校验。 */
  function fileList(
    current: UploadFile[],
    file: UploadFile,
    accept: string,
    matchExt = false,
  ): UploadFile[] {
    if (current.some((f) => f.uid === file.uid)) return current;
    const name = (file.name || '').toLowerCase();
    const exts = accept.replace(/\./g, '').split(',');
    if (matchExt) {
      if (!exts.some((e) => name.endsWith('.' + e))) {
        ElMessage.warning(`不支持的文件类型：${file.name}`);
        return current;
      }
    }
    return [...current, file];
  }

  /** 从 pdfFiles 重新构建 allPdfs + standaloneParts（不自动组成装配件）。
   *  多页 PDF → 每页独立成一行；单页 PDF → 一行。 */
  async function rebuildFromUploads(): Promise<void> {
    if (pdfFiles.value.length === 0) {
      ElMessage.warning('请先上传 PDF');
      return;
    }
    if (!pdfForm.customerL1Id) {
      ElMessage.warning('请选择一级客户');
      return;
    }
    // 提交 / 补传在途时重新解析 = 整表换新（行 uid 全换 + resetCommitState 清空
    // createdTargets），先行的 onSubmit 跑完还会照常收口 ⇒ 静默清空刚解析出的行、
    // 跳页、再弹「成功创建 0 条零件」。两道防线里这是第一道。
    if (guardRowMutation()) return;
    pdfBuildingTree.value = true;
    try {
      // 解析 Excel（可选）。2026-10-03：结果写进 composable 级 excelByDrawingNo，
      // 让后续「合并页 / 手动新增」新建的行也能回填（见状态层该字段注释）。
      excelByDrawingNo.value = null;
      if (excelFiles.value.length > 0) {
        const raw = excelFiles.value[0].raw as File | undefined;
        if (raw) {
          const rows = await readExcel(raw);
          excelByDrawingNo.value = new Map(rows.map((r) => [r.drawingNo, r]));
        }
      }

      const sources: PdfSource[] = [];
      const rows: StandalonePartRow[] = [];
      const unparsedPdfNames: string[] = [];

      for (const f of pdfFiles.value) {
        const raw = f.raw as File | undefined;
        if (!raw) continue;
        const fname = f.name;
        const parsed = parseDrawingFilename(fname);
        if (!parsed.drawingNo && !parsed.partName) {
          unparsedPdfNames.push(fname);
        }
        const totalPages = await countPdfPages(raw);
        const pdfUid = `pdf-${f.uid}`;
        sources.push({
          uid: pdfUid,
          raw,
          filename: fname,
          totalPages,
          synthesized: false,
        });
        if (totalPages === 1) {
          // 单页 PDF → 自动进独立零件表
          rows.push(
            makeStandaloneRow({
              pdfSourceUid: pdfUid,
              drawing_no: parsed.drawingNo || '',
              name: parsed.partName || '',
            }),
          );
        }
        // 多页 PDF 不预生成任何行；用户从源文件区显式选择页 → 合并
      }

      allPdfs.value = sources;
      standaloneParts.value = rows;
      assemblies.value = [];
      selectedPages.value = new Set();
      // 行 uid 全部换新 ⇒ 上一批的提交状态（工单 id 映射 / job / 失败清单 / 阶段机）
      // 再也对不上表里任何一行，留着只会让主按钮显示点不动的「重试上传」。
      // 上一批已建出的工单在服务端，本页无从补传（跨刷新取舍见 usePartBatchPdf.ts 文件头）。
      resetCommitState();
      // 全表回填：重新解析已整体替换 standaloneParts 并清空 assemblies，此刻表内
      // 每一行都是刚解析出来的新行，不存在「用户手改过的既有行」需要保护。
      applyExcelToAll();
      // PR-H 2026-07-28：按 drawing_no 把 3D 模型挂到对应独立零件 / 装配件子件行
      linkThreeDModelsToRows();

      if (unparsedPdfNames.length > 0) {
        ElMessage.warning(
          `以下 ${unparsedPdfNames.length} 个 PDF 文件名无法识别图号/名称，请手动填写：` +
            unparsedPdfNames.slice(0, 5).join('、') +
            (unparsedPdfNames.length > 5 ? ' …' : ''),
        );
      }
      ElMessage.success(`已解析：源 ${sources.length} 个 · 候选 ${rows.length} 页`);
    } catch (e) {
      ElMessage.error((e as Error).message ?? '解析失败');
    } finally {
      pdfBuildingTree.value = false;
    }
  }

  /** PR-H 2026-07-28：3D 模型支持扩展名（与后端 _file_kind_policy.THREE_D_MODEL 对齐）。 */
  const THREE_D_EXTS = ['step', 'stp', 'iges', 'igs', 'stl', 'obj', '3mf'];

  /** 把 3D 模型按文件名解析的 drawing_no 自动挂到独立零件 / 装配件子件行。
   *  - 文件名约定：图号_名称.ext（与 PDF 解析共用 `parseDrawingFilename`，先剥扩展名）。
   *  - 已挂过该图号的 → 跳过（不重复挂）。
   *  - 找不到匹配行 → ElMessage.warning（不报错，整批仍可提交）。
   *
   *  2026-10-11 核实：子件图号不再拼后缀、拆分出的独立行也同图号，但**按图号 `find`
   *  不会误挂** —— 唯一调用点是 `rebuildFromUploads`，它在本函数之前刚把
   *  `standaloneParts` 整体替换成「单页 PDF 一行」的全新数组并 `assemblies.value = []`，
   * 此刻表内没有任何合并 / 拆分产生的行，且一个图号最多一行；`mergeSelectedAsAssembly` /
   *  `splitStandalonePart` 都在这一轮之后才跑，且**不再调用**本函数（它们建出的行
   *  `three_d_index` 恒 null = 无 3D 模型，与改动前一致）。 */
  function linkThreeDModelsToRows(): void {
    if (threeDModelFiles.value.length === 0) return;
    const warns: string[] = [];
    threeDModelFiles.value.forEach((f, idx) => {
      const raw = f.raw as File | undefined;
      if (!raw) return;
      const fname = f.name;
      const noExt = THREE_D_EXTS.reduce(
        (acc, ext) => acc.replace(new RegExp(`\\.${ext}$`, 'i'), ''),
        fname,
      );
      const parsed = parseDrawingFilename(`${noExt}.pdf`); // 复用 PDF 解析逻辑
      if (!parsed.drawingNo) {
        warns.push(`3D 模型「${fname}」文件名无法识别图号，已忽略`);
        return;
      }
      // 先尝试独立零件，再试装配件子件
      const spMatch = standaloneParts.value.find((r) => r.drawing_no === parsed.drawingNo);
      if (spMatch) {
        if (spMatch.three_d_index != null) {
          warns.push(`图号 ${parsed.drawingNo} 已挂载 3D 模型，跳过「${fname}」`);
          return;
        }
        spMatch.three_d_index = idx;
        return;
      }
      let attached = false;
      for (const a of assemblies.value) {
        const childMatch = a.children.find((c) => c.drawing_no === parsed.drawingNo);
        if (childMatch) {
          if (childMatch.three_d_index != null) {
            warns.push(`图号 ${parsed.drawingNo} 已挂载 3D 模型，跳过「${fname}」`);
            attached = true;
            break;
          }
          childMatch.three_d_index = idx;
          attached = true;
          break;
        }
      }
      if (!attached) warns.push(`未找到图号 ${parsed.drawingNo} 对应零件行，已忽略「${fname}」`);
    });
    if (warns.length > 0) {
      ElMessage.warning(
        `3D 模型挂载提示（${warns.length} 条）：\n` +
          warns.slice(0, 5).join('\n') +
          (warns.length > 5 ? '\n…' : ''),
      );
    }
  }

  // ============ PDF 文件名点击预览 ============
  const pdfPreviewing = ref<PdfPreviewState | null>(null);
  const pdfPreviewVisible = ref(false);

  /** 打开预览（通用入口）：传入 pdfSourceUid 和起始页（1-indexed）。 */
  function previewAt(pdfSourceUid: string, title: string, page: number): void {
    if (pdfPreviewing.value) {
      try {
        URL.revokeObjectURL(pdfPreviewing.value.url);
      } catch {
        /* ignore */
      }
    }
    const src = allPdfs.value.find((s) => s.uid === pdfSourceUid);
    if (!src) {
      ElMessage.warning('PDF 不可用');
      return;
    }
    pdfPreviewing.value = {
      url: URL.createObjectURL(src.raw),
      title,
      page,
    };
    pdfPreviewVisible.value = true;
  }

  /** 关闭预览：revoke URL，清状态。el-dialog `:before-close` 会调。 */
  function closePdfPreview(): void {
    if (pdfPreviewing.value) {
      try {
        URL.revokeObjectURL(pdfPreviewing.value.url);
      } catch {
        /* ignore */
      }
      pdfPreviewing.value = null;
    }
    pdfPreviewVisible.value = false;
  }

  // ============ 拖拽排序（vue-draggable-plus useLazyDraggable） ============
  // PR-H 2026-07-28：拖动 handle 列重排行顺序。
  // - 不接受嵌套展开行（child-table 不挂 sortable）；仅顶层独立零件 / 装配件行。
  // - 2026-08-27 fix：两个 tbodyRef 在 setup 时均为 null，useDraggable 默认 immediate
  //   会在挂载时 new Sortable(null) 抛错。改用 useLazyDraggable：给 ref 赋值即自动重绑，
  //   覆盖 el-table 首次挂载与 EP 重建 tbody（行数变化 / v-if）两种时机。
  // - 表格 DOM ref 由本 composable 持有，通过 provide('partBatchPdfRefs') 暴露
  //   给 PartBatchPdfTab，模板用 :ref 回写。
  /** 拖拽收尾：把 list 从 oldIndex 挪到 newIndex，返回原地复制的 list 给响应式。 */
  function makeOnEnd<T>(list: Ref<T[]>) {
    return (evt: { oldIndex?: number; newIndex?: number }) => {
      const { oldIndex, newIndex } = evt;
      if (oldIndex == null || newIndex == null || oldIndex === newIndex) return;
      const next = list.value.slice();
      const [moved] = next.splice(oldIndex, 1);
      if (moved) next.splice(newIndex, 0, moved);
      list.value = next;
    };
  }
  useLazyDraggable(standaloneTbodyRef, standaloneParts, {
    handle: '.drag-handle',
    draggable: 'tr',
    animation: 150,
    ghostClass: 'sortable-ghost',
    onEnd: makeOnEnd(standaloneParts),
  });
  useLazyDraggable(assembliesTbodyRef, assemblies, {
    handle: '.drag-handle',
    draggable: 'tr',
    animation: 150,
    ghostClass: 'sortable-ghost',
    onEnd: makeOnEnd(assemblies),
  });

  // 监听 tableRef 变化 → 重新解析 tbody 写回 ref；useLazyDraggable 内部 watcher 接管重绑。
  // 触发时机：el-table 首次挂载、行数变化（v-if / 数据长度变化）让 EP 重建 tbody。
  watch(
    standaloneTableRef,
    () => {
      standaloneTbodyRef.value = resolveTbody(standaloneTableRef);
    },
    { flush: 'post' },
  );
  watch(
    assembliesTableRef,
    () => {
      assembliesTbodyRef.value = resolveTbody(assembliesTableRef);
    },
    { flush: 'post' },
  );

  // 把 tableRef 暴露给 PartBatchPdfTab：provide 注入，避免通过 v-bind 摊开
  // 时 props readonly 静默丢写。
  provide('partBatchPdfRefs', { standaloneTableRef, assembliesTableRef });

  // ============ 源文件区：勾选 + 归组 + 删除 ============

  /** el-table type=selection 回调：把选中的 SourceTreeRow 扁平化成页 UID 集合。
   *  顶层被选中 → 等价于「该 PDF 全部页」。 */
  function onSourceSelectionChange(rows: SourceTreeRow[]): void {
    const next = new Set<string>();
    for (const r of rows) {
      if (r.pageIndex !== null) {
        next.add(pageUid(r.pdfSourceUid, r.pageIndex));
      } else {
        const src = allPdfs.value.find((s) => s.uid === r.pdfSourceUid);
        if (src) for (let p = 0; p < src.totalPages; p++) next.add(pageUid(r.pdfSourceUid, p));
      }
    }
    selectedPages.value = next;
  }

  /** 源文件区点击文件名预览。顶层 → 第 1 页；子页 → 对应页。 */
  function previewSourceRow(row: SourceTreeRow): void {
    const page = row.pageIndex === null ? 1 : row.pageIndex + 1;
    previewAt(row.pdfSourceUid, `${row.filename} 预览`, page);
  }

  // el-table 类型来自 element-plus 类型导出，运行时为函数组件；用宽松类型包住。
  // el-table ref 现在由 PartBatchPdfTab 持有；外部调用（清空选择按钮）需传 ref，
  // composable 内部 merge 后调用可不传 —— 只重置 selectedPages 状态。
  function clearSelection(table?: { clearSelection: () => void } | null): void {
    table?.clearSelection();
    selectedPages.value = new Set();
  }

  /**
   * 加载源 PDF 文档。一次建行里的多次切页共用它，避免 N 页就 load N 次（load 要重解
   * 整份 xref，代价随页数线性涨）。
   */
  async function loadPdfDoc(raw: Blob): Promise<PdfLibDocument> {
    const { PDFDocument } = await import('pdf-lib');
    return PDFDocument.load(await raw.arrayBuffer());
  }

  /** 从已加载的 srcDoc 切出 pageIndices（0-based）指定的页 → 新 PDF Blob。 */
  async function copyPagesFrom(srcDoc: PdfLibDocument, pageIndices: number[]): Promise<Blob> {
    const { PDFDocument } = await import('pdf-lib');
    const out = await PDFDocument.create();
    const copied = await out.copyPages(srcDoc, pageIndices);
    copied.forEach((p) => out.addPage(p));
    const bytes = await out.save();
    // pdf-lib save() 返回 Uint8Array<ArrayBufferLike>，TS 5+ 要求 BlobPart 严格是
    // ArrayBuffer 类型；slice() 拷贝出独立 ArrayBuffer，避开 SharedArrayBuffer 误判。
    return new Blob([bytes.slice().buffer as ArrayBuffer], { type: 'application/pdf' });
  }

  /** 用 pdf-lib 合并 PDF 的指定页（0-based pageIndices）→ 新 PDF Blob。 */
  async function mergePages(raw: Blob, pageIndices: number[]): Promise<Blob> {
    return copyPagesFrom(await loadPdfDoc(raw), pageIndices);
  }

  /**
   * 切出 1 页并登记成 PdfSource（`syn-` 约定），返回新 source。
   *
   * 2026-10-05：装配件的每个子件 / 总装图各自持有一份**单页切片**，`uid` 天然唯一 ⇒
   * 上传时一个 entry 对应一个目标实体（顶层与 N 个子件共享整份多页 PDF 会让打印把每一页
   * 在每个子件上重复输出）。`originPdfUid` 指向原始 PDF，`removePdf` 靠它级联清理这些切片。
   */
  async function pushPageSlice(
    src: PdfSource,
    srcDoc: PdfLibDocument,
    pageIndex: number,
  ): Promise<PdfSource> {
    const slice: PdfSource = {
      uid: `syn-${makeUid()}`,
      raw: await copyPagesFrom(srcDoc, [pageIndex]),
      filename: `${stripExt(src.filename)}_p${pageIndex + 1}.pdf`,
      totalPages: 1,
      synthesized: true,
      synthesizedFrom: [{ pdfUid: src.uid, pageIndices: [pageIndex] }],
      originPdfUid: src.uid,
    };
    allPdfs.value.push(slice);
    return slice;
  }

  /**
   * 把本轮已登记的 PdfSource 按 uid 从 `allPdfs` 摘掉（切页中途失败时的回滚）。
   *
   * 2026-10-05：切片是循环里逐个 push 进去的，失败时装配件行还没建出来 ⇒ 这批切片没有
   * 任何行引用，也不在源文件区显示（`originalPdfs` 只留 `!synthesized`），用户既看不到
   * 也删不掉，纯占内存（切到第 40 页失败 = 前 39 份单页 Blob 悬空）。失败即整批摘掉，
   * 保持「一次建行要么全成、要么什么都不留」。
   */
  function rollbackPushedSources(uid: string[]): void {
    if (uid.length === 0) return;
    const owned = new Set(uid);
    allPdfs.value = allPdfs.value.filter((s) => !owned.has(s.uid));
  }

  /**
   * 切页失败的提示文案。**必须带出是哪个文件**：源文件区有多份 PDF 时，只说「解析失败」
   * 用户无从判断是哪一份出了问题。
   *
   * 2026-10-05：pdf-lib 对加密 PDF 抛 `EncryptedPDFError`、对 xref 异常的 PDF 抛
   * `ParseError`（pdfjs 能正常读，源文件区已经能看到页），所以「能预览」不代表
   * 「能切页」。三个建行入口的按钮都是裸 `@click`（Vue 不接 handler 返回的 promise），
   * 不兜住就是 unhandled rejection：不建行、不提示、用户只看到按钮按了没反应。
   */
  function sliceFailedMessage(src: PdfSource, e: unknown): string {
    return `切页失败：无法从「${src.filename}」切出单页 PDF（${errorReason(e)}）`;
  }

  /**
   * 读不出页数时的提示。与 `sliceFailedMessage` **刻意分开**：这是另一个失败面 ——
   * 手动新增的这份 PDF 从没进过 `rebuildFromUploads`（那里 pdfjs 读不动会整批中断并
   * 弹「解析失败」），所以走到这里还读不出页数只可能是这份文件本身 pdfjs 就打不开。
   * 混进「切页失败」会让用户以为坏的是切页那一步，换份文件重试也还是这句。
   */
  function pageCountFailedMessage(src: PdfSource, e: unknown): string {
    return `无法读取「${src.filename}」的页数，子件数量无法确定（${errorReason(e)}）`;
  }

  /** 异常 → 提示里的一句话原因（两个失败文案共用同一口径）。 */
  function errorReason(e: unknown): string {
    return e instanceof Error && e.message ? e.message : '未知原因';
  }

  /** 切页在途标记。模块内局部量，不进对外返回面（模板拿不到、也就无从 `:loading`）。 */
  let pageSlicing = false;

  /**
   * 切页前的重入闸门：已在切页就拒掉本次点击（返回 true = 调用方应直接 return）。
   *
   * 2026-10-05：切页是主线程同步计算（load 要重解整份 xref，再逐页 create/copyPages/
   * save），几百页会假死数秒；期间按钮既无 loading 也未禁用，可连点 ⇒ 建出两行重复装配件
   *（`POST /assemblies` 无幂等键）。这里只做函数级拦截。
   */
  function rejectIfSlicing(): boolean {
    if (!pageSlicing) return false;
    ElMessage.warning('正在切页，请稍候');
    return true;
  }

  /** 切页在途标记的写入口。行段（手动新增装配件）必须占同一份标志，否则两个建行入口
   *  各自可连点、各自建出重复装配件（`POST /assemblies` 无幂等键）。 */
  function setSlicing(v: boolean): void {
    pageSlicing = v;
  }

  /** 把选中页按 pdfUid 分组。 */
  function selectedByPdf(): Map<string, number[]> {
    const m = new Map<string, number[]>();
    for (const k of selectedPages.value) {
      const { pdfUid, pageIndex } = parsePageUid(k);
      const arr = m.get(pdfUid) ?? [];
      arr.push(pageIndex);
      m.set(pdfUid, arr);
    }
    for (const arr of m.values()) arr.sort((a, b) => a - b);
    return m;
  }

  /** 合并选中页 → 一个独立零件（同一 PDF）。 */
  async function mergeSelectedAsPart(): Promise<void> {
    if (guardRowMutation()) return;
    if (rejectIfSlicing()) return;
    const byPdf = selectedByPdf();
    if (byPdf.size === 0) {
      ElMessage.warning('请先勾选页');
      return;
    }
    if (byPdf.size > 1) {
      ElMessage.warning('合并为零件的页必须来自同一 PDF');
      return;
    }
    const [pdfUid, pageIndices] = [...byPdf.entries()][0];
    const src = allPdfs.value.find((s) => s.uid === pdfUid);
    if (!src) return;

    let created: StandalonePartRow;
    if (pageIndices.length === src.totalPages) {
      // 全部页 → 直接复用原 PDF，无合成
      created = makeStandaloneRow({
        pdfSourceUid: pdfUid,
        drawing_no: parseDrawingFilename(src.filename).drawingNo || '',
        name: parseDrawingFilename(src.filename).partName || '',
      });
    } else {
      // 部分页 → pdf-lib 合成
      // 2026-10-05：与「合并为装配件」/「手动新增装配件」同一口径 —— 按钮是裸 `@click`，
      // pdf-lib 抛错时原本是 unhandled rejection（不建行、不提示、按钮看着像坏了）。
      // 回滚集合天然为空：合成产物是 `mergePages` 成功之后才 push 进 allPdfs 的，
      // 抛错时一个条目都没登记，没有半成品要摘。
      pageSlicing = true;
      let merged: Blob;
      try {
        merged = await mergePages(src.raw, pageIndices);
      } catch (e) {
        ElMessage.error(sliceFailedMessage(src, e));
        return;
      } finally {
        pageSlicing = false;
      }
      const newUid = `syn-${makeUid()}`;
      allPdfs.value.push({
        uid: newUid,
        raw: merged,
        filename: `${stripExt(src.filename)}_p${pageIndices.map((i) => i + 1).join('+')}.pdf`,
        totalPages: pageIndices.length,
        synthesized: true,
        synthesizedFrom: [{ pdfUid, pageIndices }],
        originPdfUid: pdfUid,
      });
      created = makeStandaloneRow({
        pdfSourceUid: newUid,
        pageCount: pageIndices.length,
        mergedFrom: pageIndices.map((i) => ({ pdfUid, pageIndex: i })),
        drawing_no: parseDrawingFilename(src.filename).drawingNo || '',
        name: parseDrawingFilename(src.filename).partName || '',
      });
    }
    standaloneParts.value.push(created);
    // 移除原 standalone 行（如果存在）
    clearSelection();
    // 2026-10-03：只回填本次新建的这一行 —— 全表重扫会把用户在其他行上手改过的
    // 数量 / 单价 / 交期 / 申请人覆盖回 Excel 值。
    applyExcelToAll({ parts: [created] });
    ElMessage.success(`已合并 ${pageIndices.length} 页 → 独立零件`);
  }

  /** 合并选中页 → 一个装配件（同一 PDF，至少 2 页）。 */
  async function mergeSelectedAsAssembly(): Promise<void> {
    if (guardRowMutation()) return;
    if (rejectIfSlicing()) return;
    const byPdf = selectedByPdf();
    if (byPdf.size === 0) {
      ElMessage.warning('请先勾选页');
      return;
    }
    if (byPdf.size > 1) {
      ElMessage.warning('合并为装配件的页必须来自同一 PDF');
      return;
    }
    const [pdfUid, pageIndices] = [...byPdf.entries()][0];
    if (pageIndices.length < 2) {
      ElMessage.warning('合并为装配件至少需要 2 页');
      return;
    }
    const src = allPdfs.value.find((s) => s.uid === pdfUid);
    if (!src) return;
    const parsed = parseDrawingFilename(src.filename);
    // 2026-10-05：每个子件切出**自己那一页**的单页 PDF（load 一次，逐页切）。校验全过
    // 才占重入闸门，所以上面那些 early return 不必各自释放。
    pageSlicing = true;
    const slices: PdfSource[] = [];
    try {
      const srcDoc = await loadPdfDoc(src.raw);
      for (const pi of pageIndices) slices.push(await pushPageSlice(src, srcDoc, pi));
    } catch (e) {
      rollbackPushedSources(slices.map((s) => s.uid));
      ElMessage.error(sliceFailedMessage(src, e));
      return;
    } finally {
      pageSlicing = false;
    }
    // 2026-10-11 口径变更：子件图号 / 名称**直接取源值**，不再按页码拼 `-02 / -03`
    // 后缀 —— 合并为装配件后所有子件与装配件保持一致（后端对 children 是纯透传，
    // `t_part.drawing_no` 也无唯一约束，`t_part.serial_no` 由 `{asm_serial}-{i:02d}`
    // 独立保证，天然允许同图号多行）。
    const children: AssemblyChildRow[] = pageIndices.map((pi, i) =>
      makeAssemblyChild({
        pdfSourceUid: slices[i]!.uid,
        pageIndex: pi,
        drawing_no: parsed.drawingNo || '',
        name: parsed.partName || '',
      }),
    );
    const created = makeAssemblyRow({
      // 顶层 pdfSourceUid 仍是**原始** PDF：源文件区预览 / removePdf 级联清理依赖它
      pdfSourceUid: pdfUid,
      drawing_no: parsed.drawingNo || '',
      name: parsed.partName || '',
      // 默认「无总装图」：不产生 ASSEMBLY_MASTER 文件，打印既不出总装图也不出
      // 该装配件的序列号背面。要指定某页作总装图由用户在下拉里选。
      masterPageIndex: null,
      masterPdfSourceUid: null,
      children,
    });
    assemblies.value.push(created);
    clearSelection();
    // 2026-10-03：只回填本次新建的这一个装配件（含其子件交期同步），不动其它装配件。
    applyExcelToAll({ assemblies: [created] });
    ElMessage.success(`已合并 ${pageIndices.length} 页 → 装配件`);
  }

  /** 拆分：把合成后的独立零件拆回 N 个单页行。 */
  function splitStandalonePart(row: StandalonePartRow): void {
    if (!row.mergedFrom || row.mergedFrom.length === 0) return;
    // 找到原始 PDF
    const originUid = row.mergedFrom[0].pdfUid;
    const src = allPdfs.value.find((s) => s.uid === originUid);
    if (!src) {
      ElMessage.error('原 PDF 已不存在，无法拆分');
      return;
    }
    // 按 pageIndex 排序，逐页创建独立行
    const sorted = [...row.mergedFrom].sort((a, b) => a.pageIndex - b.pageIndex);
    // 2026-10-11：拆出的多行**同图号同名称**（直接取源 PDF 文件名解析结果）。
    // 拆开后的行本就是独立零件，与合成行同图号是必然结果 —— `t_part.drawing_no`
    // 无唯一约束，唯一性由 `serial_no` 单独保证。
    const parsed = parseDrawingFilename(src.filename);
    // 每页一行：字段全部来自同一个源文件，逐页循环只是行数不同
    for (const _page of sorted) {
      standaloneParts.value.push(
        makeStandaloneRow({
          pdfSourceUid: originUid,
          drawing_no: parsed.drawingNo || '',
          name: parsed.partName || '',
        }),
      );
    }
    // 删除合成 PDF（若已合并成 part，且 part 是唯一引用）
    const synthUid = row.pdfSourceUid;
    if (synthUid.startsWith('syn-')) {
      allPdfs.value = allPdfs.value.filter((s) => s.uid !== synthUid);
    }
    standaloneParts.value = standaloneParts.value.filter((r) => r.uid !== row.uid);
    ElMessage.success(`已拆回 ${sorted.length} 页`);
  }

  /** 删除一个原 PDF：连带删除合成 PDF + 引用它的所有 part / assembly。 */
  function removePdf(pdfUid: string): void {
    if (!allPdfs.value.some((s) => s.uid === pdfUid)) return;
    // 1. 找出要删除的源：原 PDF + 它的所有合成派生
    const removeUids = new Set<string>([pdfUid]);
    allPdfs.value.filter((s) => s.originPdfUid === pdfUid).forEach((s) => removeUids.add(s.uid));
    // 2. 从 allPdfs 移除
    allPdfs.value = allPdfs.value.filter((s) => !removeUids.has(s.uid));
    // 3. 清理 standaloneParts
    standaloneParts.value = standaloneParts.value.filter((r) => !removeUids.has(r.pdfSourceUid));
    // 4. 清理 assemblies
    assemblies.value = assemblies.value.filter((a) => !removeUids.has(a.pdfSourceUid));
    // 5. 清理 selection
    const next = new Set<string>();
    for (const k of selectedPages.value) {
      if (!removeUids.has(parsePageUid(k).pdfUid)) next.add(k);
    }
    selectedPages.value = next;
    // 6. 从 el-upload pdfFiles 移除原 UploadFile（pdfUid = "pdf-<uploadFileUid>"）
    const uploadUid = pdfUid.startsWith('pdf-') ? pdfUid.slice(4) : null;
    if (uploadUid) {
      pdfFiles.value = pdfFiles.value.filter((f) => String(f.uid) !== uploadUid);
    }
  }

  function removeStandalonePart(uid: string): void {
    const row = standaloneParts.value.find((r) => r.uid === uid);
    if (!row) return;
    // 若是合成行，删除合成 PDF
    if (row.pdfSourceUid.startsWith('syn-')) {
      allPdfs.value = allPdfs.value.filter((s) => s.uid !== row.pdfSourceUid);
    }
    standaloneParts.value = standaloneParts.value.filter((r) => r.uid !== uid);
  }

  /**
   * 删除一个装配件行，并把它持有的单页切片（`syn-` 开头）从 `allPdfs` 里摘掉 ——
   * 切片只在建这一行时产生、行删了就没有引用，留在 allPdfs 里只是堆无人使用的 Blob。
   * 仍被其它行引用的切片不动（`Set` 去重：总装图切片与对应子件的切片是同一个 uid）。
   */
  function removeAssembly(uid: string): void {
    const row = assemblies.value.find((a) => a.uid === uid);
    if (!row) return;
    assemblies.value = assemblies.value.filter((a) => a.uid !== uid);
    const owned = new Set<string>();
    if (row.masterPdfSourceUid) owned.add(row.masterPdfSourceUid);
    for (const c of row.children) owned.add(c.pdfSourceUid);
    if (owned.size === 0) return;
    const stillUsed = new Set<string>();
    for (const r of standaloneParts.value) stillUsed.add(r.pdfSourceUid);
    for (const a of assemblies.value) {
      stillUsed.add(a.pdfSourceUid);
      if (a.masterPdfSourceUid) stillUsed.add(a.masterPdfSourceUid);
      for (const c of a.children) stillUsed.add(c.pdfSourceUid);
    }
    allPdfs.value = allPdfs.value.filter(
      (s) => !(s.uid.startsWith('syn-') && owned.has(s.uid) && !stillUsed.has(s.uid)),
    );
  }

  /** 展示用：把 PdfSource uid 翻译成可读文件名 + 页数。 */
  function pdfSourceLabel(uid: string): string {
    const src = allPdfs.value.find((s) => s.uid === uid);
    if (!src) return '(已删除)';
    return src.synthesized
      ? `${src.filename}（合成 ${src.totalPages} 页）`
      : `${src.filename}（${src.totalPages} 页）`;
  }

  /** 预览独立零件 / 装配件图纸。 */
  function previewStandalonePart(row: StandalonePartRow): void {
    previewAt(row.pdfSourceUid, `${row.drawing_no || row.name} 预览`, 1);
  }
  function previewPdfSourceByUid(uid: string): void {
    previewAt(uid, `${pdfSourceLabel(uid)} 预览`, 1);
  }

  return {
    pdfBuildingTree,
    pdfPreviewing,
    pdfPreviewVisible,
    sourceTree,
    onPdfChange,
    onPdfRemove,
    onExcelChange,
    onExcelRemove,
    onThreeDModelChange,
    onThreeDModelRemove,
    rebuildFromUploads,
    clearSelection,
    mergeSelectedAsPart,
    mergeSelectedAsAssembly,
    splitStandalonePart,
    removePdf,
    removeStandalonePart,
    removeAssembly,
    pdfSourceLabel,
    previewStandalonePart,
    previewPdfSourceByUid,
    closePdfPreview,
    onSourceSelectionChange,
    previewSourceRow,
    loadPdfDoc,
    pushPageSlice,
    rollbackPushedSources,
    sliceFailedMessage,
    pageCountFailedMessage,
    rejectIfSlicing,
    setSlicing,
  };
}
