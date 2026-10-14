// Tab 2「PDF 批量上传」composable —— **组装层**（2026-10-20 拆分后）。
//
// 拆分后本文件只做三件事：创建共享状态、按依赖顺序建五段、把它们的返回值拼成对外返回面。
// 对外接口（`usePartBatchPdf` 的签名、返回值的每一项、以及 `PartBatchPdfTab.vue` 的
// `v-bind="pdf"` 调用方式）逐字未变 —— 类型也从这里原样 re-export，外部 import 路径不变。
//
// 五段 + 上传 job 子系统的职责与依赖方向（单向，无环）：
//
//   状态层 `usePartBatchPdfState`   —— 各段共享的 ref / computed、行工厂、两道跨段闸门
//        ↓
//   回填段 `usePartBatchPdfFill`     —— Excel 读入 + 按图号回填（作用域契约在这段）
//        ↓
//   解析段 `usePartBatchPdfParse`    —— 上传解析 / 源文件树 / 页切片 / 合并拆分删除 / 预览 / 拖拽
//        ↓
//   行段   `usePartBatchPdfRows`     —— 行内字段联动 + 手动新增两个对话框
//        ↓
//   提交段 `usePartBatchPdfSubmit`   —— 三段状态机 + 建单两路 / 草稿 / 收口
//        ↓
//   上传 job 子系统 `usePartBatchPdfUploads`
//                                    —— 一批上传作业的登记 / 调度 / 状态格 / 失败清单 / 清场
//
// 为什么是这个顺序：「切页」（解析段）与「建行」（行段的手动新增装配件）互调、提交态
// （提交段）与「重新解析」（解析段）互调，两处双向依赖都靠「依赖对方的那一端退到更早的
// 层」解开 —— 页切片与切页闸门进解析段、行工厂与两道闸门进状态层。
//
// 提交段 → 上传 job 子系统这条边（2026-10-21 拆出后新增）也是单向的：子系统只经 `state`
// 读写共享状态、只经入参拿行视图，两个入口的**阶段机**仍在提交段，子系统自己不碰
// `commitStage` / `pdfSubmitting`。它由提交段在内部创建（不是本文件并列调的第 6 个工厂），
// 但依赖方向与上面五段同一条直线。
//
// 2026-10-04 单按钮 + 后端上传：提交入口收敛成一个 `onSubmit`，内部三段
// `idle → creating → uploading → done`。上传失败语义是「工单已建 + 失败清单可重试」——工单落库不可回滚，
// 所以 `commitStage` 一旦越过 creating 就绝不回 idle（回 idle 会让用户再点一次
// 主按钮，把同一批工单建第二遍），重试一律只补传文件。
//
// 2026-10-05：creating 阶段**分两路**。独立零件行走 `POST /parts/batch`（一次请求，
// 端点内无 assembly 概念）；装配件行走树形端点 `POST /api/v2/assemblies`（逐组一次请求，
// 一次建出 `t_assembly` 顶层 + 全部 `t_part` 子件）。此前把装配件主子件展平成 N+1 个
// 独立 part 发 `POST /parts/batch`，结果 `t_assembly` 一行不涨、子件的 `assembly_id`
// 全 NULL —— 表格上叫「装配件」的东西在服务端根本不是装配件。
//
// 建单只有「部分行成立」时是例外：建出来的行会立刻从本地表格移除（它们已经是真实
// 工单，留着只会诱导重复提交），剩下的失败行才留在表里等下一次提交 ⇒ 阶段此时回
// idle 也不会重复建单。`POST /parts/batch` 与 `POST /assemblies` 都无幂等键，任何
// 「同一批行发第二次」都是真建出第二份工单。
//
// 已知取舍（2026-10-04）：本 Tab 的草稿是**只写**的 —— `draft.load()` 只在 saver 里用来
// 读回旧 payload 以保住 Tab 1 的 `manual_tab` 段，没有任何把 `pdf_tab.rows` 灌回
// `standaloneParts` / `assemblies` 的路径。所以刷新后表格是空的、行全部丢失，重新提交
// 必须重新选文件再解析。会**重复建单**的实际触发点是「重新解析」：它把全部行重新列出来
// （含上一次已经建出工单的那些），再点提交就会建第二遍。
// 要根治得让行 uid 可复现（解析结果按文件名+页码派生），属独立设计变更。

import { onBeforeUnmount, watch } from 'vue';
import { createPdfBatchState } from './usePartBatchPdfState';
import { usePartBatchPdfFill } from './usePartBatchPdfFill';
import { usePartBatchPdfParse } from './usePartBatchPdfParse';
import { usePartBatchPdfRows } from './usePartBatchPdfRows';
import { usePartBatchPdfSubmit } from './usePartBatchPdfSubmit';
import type { UsePartBatchPdfOptions, UsePartBatchPdfReturn } from './usePartBatchPdfTypes';

// 对外类型面逐字保留：`PartBatchPdfTab.vue` 与 `views/parts/new/__tests__/` 下两份 spec
// 都从本文件 import 这些类型，路径与名字都不能动。
export type {
  AssemblyChildRow,
  AssemblyRow,
  PdfPreviewState,
  PdfSource,
  SourceTreeRow,
  StandalonePartRow,
  UploadStatusCell,
  UsePartBatchPdfOptions,
  UsePartBatchPdfReturn,
} from './usePartBatchPdfTypes';

/**
 * Tab 2「PDF 批量上传」的全部 state + handler。返回值直接 `v-bind` 给 PartBatchPdfTab。
 */
export function usePartBatchPdf(opts: UsePartBatchPdfOptions): UsePartBatchPdfReturn {
  const { applicantSearch } = opts;

  const state = createPdfBatchState(opts);
  const { pdfForm } = state;

  // PDF Tab 一级客户切换 → 拉一次该客户下申请人全集。
  // useApplicantSearch.loadForCustomer 内部对同一 rootCustomerId 不重拉；
  // 切换到空客户则清空缓存。immediate: false 避免首次 null 时多余调用。
  watch(
    () => pdfForm.customerL1Id,
    (next) => {
      void applicantSearch.loadForCustomer(next);
    },
    { immediate: false },
  );

  const fill = usePartBatchPdfFill(state);
  const parse = usePartBatchPdfParse(state, fill);
  const rowSeg = usePartBatchPdfRows(state, fill, parse);
  const submit = usePartBatchPdfSubmit(state, rowSeg);

  // 2026-08-27：vue-draggable-plus 的 useDraggable composable 在 unmount 时
  // 自动 destroy，无需手动调用。
  // unmount 时关预览（revoke blob URL）+ 刷新 draft 快照 + 撤销 pending saver
  //（避免 debounce 在组件已销毁后写入 stale state）。
  onBeforeUnmount(() => {
    parse.closePdfPreview();
    submit.flushDraftOnUnmount();
  });

  return {
    // 客户
    l1Customers: state.l1Customers,
    leafCustomerOptions: state.leafCustomerOptions,
    // applicants
    applicantCandidates: applicantSearch.applicants,
    applicantLoading: applicantSearch.loading,
    querySearch: applicantSearch.querySearch,
    // pdfForm
    pdfForm,
    // file lists
    pdfFiles: state.pdfFiles,
    excelFiles: state.excelFiles,
    threeDModelFiles: state.threeDModelFiles,
    pdfBuildingTree: parse.pdfBuildingTree,
    pdfSubmitting: state.pdfSubmitting,
    // data
    allPdfs: state.allPdfs,
    selectedPages: state.selectedPages,
    standaloneParts: state.standaloneParts,
    assemblies: state.assemblies,
    totalAssemblyChildren: rowSeg.totalAssemblyChildren,
    sourceTree: parse.sourceTree,
    // preview state
    pdfPreviewing: parse.pdfPreviewing,
    pdfPreviewVisible: parse.pdfPreviewVisible,
    // manual add dialog
    manualPartDialogVisible: rowSeg.manualPartDialogVisible,
    manualPartForm: rowSeg.manualPartForm,
    manualPartFileList: rowSeg.manualPartFileList,
    manualPartFormValid: rowSeg.manualPartFormValid,
    manualAsmDialogVisible: rowSeg.manualAsmDialogVisible,
    manualAsmForm: rowSeg.manualAsmForm,
    manualAsmFileList: rowSeg.manualAsmFileList,
    manualAsmFormValid: rowSeg.manualAsmFormValid,
    // upload handlers
    onPdfChange: parse.onPdfChange,
    onPdfRemove: parse.onPdfRemove,
    onExcelChange: parse.onExcelChange,
    onExcelRemove: parse.onExcelRemove,
    onThreeDModelChange: parse.onThreeDModelChange,
    onThreeDModelRemove: parse.onThreeDModelRemove,
    // parse
    rebuildFromUploads: parse.rebuildFromUploads,
    onUnitPriceChange: rowSeg.onUnitPriceChange,
    onAsmUnitPriceChange: rowSeg.onAsmUnitPriceChange,
    onChildUnitPriceChange: rowSeg.onChildUnitPriceChange,
    onCustomerLeafChange: rowSeg.onCustomerLeafChange,
    onAsmPlannedChange: rowSeg.onAsmPlannedChange,
    // preview
    closePdfPreview: parse.closePdfPreview,
    previewSourceRow: parse.previewSourceRow,
    previewStandalonePart: parse.previewStandalonePart,
    previewPdfSourceByUid: parse.previewPdfSourceByUid,
    pdfSourceLabel: parse.pdfSourceLabel,
    // selection
    onSourceSelectionChange: parse.onSourceSelectionChange,
    clearSelection: parse.clearSelection,
    // merge / split
    mergeSelectedAsPart: parse.mergeSelectedAsPart,
    mergeSelectedAsAssembly: parse.mergeSelectedAsAssembly,
    effectiveChildren: rowSeg.effectiveChildren,
    onAsmMasterPageChange: rowSeg.onAsmMasterPageChange,
    splitStandalonePart: parse.splitStandalonePart,
    removePdf: parse.removePdf,
    removeStandalonePart: parse.removeStandalonePart,
    removeAssembly: parse.removeAssembly,
    // manual add
    addManualPart: rowSeg.addManualPart,
    onManualPartFileChange: rowSeg.onManualPartFileChange,
    onManualPartFileRemove: rowSeg.onManualPartFileRemove,
    confirmManualPart: rowSeg.confirmManualPart,
    closeManualPartDialog: rowSeg.closeManualPartDialog,
    addManualAssembly: rowSeg.addManualAssembly,
    onManualAsmFileChange: rowSeg.onManualAsmFileChange,
    onManualAsmFileRemove: rowSeg.onManualAsmFileRemove,
    confirmManualAssembly: rowSeg.confirmManualAssembly,
    closeManualAsmDialog: rowSeg.closeManualAsmDialog,
    // submit：2026-10-04 单入口（建工单 + 逐 part 后置上传）
    onSubmit: submit.onSubmit,
    retryFailedUploads: submit.retryFailedUploads,
    // 上传状态（行内进度 / 行内单文件重试 / 全局汇总）
    pdfUploadCells: state.pdfUploadCells,
    threeDUploadCells: state.threeDUploadCells,
    getRowPdfCell: submit.getRowPdfCell,
    getRowThreeDCell: submit.getRowThreeDCell,
    // 阶段机 + 主按钮文案
    commitStage: state.commitStage,
    canSubmit: submit.canSubmit,
    submitLabel: submit.submitLabel,
    cellRetryDisabled: submit.cellRetryDisabled,
    retryUploadByCell: submit.retryUploadByCell,
  };
}
