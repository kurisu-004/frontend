// Tab 2「PDF 批量上传」的**行段**（2026-10-20 从 usePartBatchPdf.ts 拆出）。
//
// 这一段覆盖「行已经存在之后」的全部表内编辑：单价联动总价、行内客户 / 交期 / 总装图
// 改值，以及两个「手动新增」对话框（唯一的**不用勾页**建行入口）。独立成模块的判据是
// **它只改行内字段、不改行的来源**：解析段管「行从哪来 / 源文件被删」，本段管「行里的
// 值是多少」，两者的失败面与提示口径完全不同。
//
// 行工厂（`makeStandaloneRow` / `makeAssemblyChild` / `makeAssemblyRow`）不在本段 ——
// 它们是解析段建行也要用的纯构造函数，放在共享状态层（见 `usePartBatchPdfState.ts` 文件头）。
//
// 「手动新增装配件」要切页，页切片那组函数与切页重入闸门由解析段持有（pdf-lib 的加载 /
// 回滚 / 失败文案 / 闸门都在那里），本段只调用、不复述。

import { computed, reactive, ref, type ComputedRef, type Ref } from 'vue';
import { ElMessage, type UploadFile } from 'element-plus';
import { countPdfPages } from '@/utils/pdfjs';
import { makeUid } from './usePartBatchShared';
import type { PdfBatchState } from './usePartBatchPdfState';
import type { UsePartBatchPdfFill } from './usePartBatchPdfFill';
import type { UsePartBatchPdfParse } from './usePartBatchPdfParse';
import type {
  AssemblyChildRow,
  AssemblyRow,
  PdfSource,
  StandalonePartRow,
} from './usePartBatchPdfTypes';

export interface UsePartBatchPdfRows {
  effectiveChildren: (a: AssemblyRow) => AssemblyChildRow[];
  totalAssemblyChildren: ComputedRef<number>;
  onUnitPriceChange: (row: StandalonePartRow, v: number | undefined) => void;
  onAsmUnitPriceChange: (row: AssemblyRow, v: number | undefined) => void;
  onChildUnitPriceChange: (c: AssemblyChildRow, v: number | undefined) => void;
  onCustomerLeafChange: (row: { customer_id: string; customer_name?: string }, v: string) => void;
  onAsmPlannedChange: (asmRow: AssemblyRow, v: string) => void;
  onAsmMasterPageChange: (a: AssemblyRow, v: number | null | undefined) => void;
  manualPartDialogVisible: Ref<boolean>;
  manualPartForm: { drawing_no: string; name: string; file: File | null };
  manualPartFileList: ComputedRef<UploadFile[]>;
  manualPartFormValid: ComputedRef<boolean>;
  closeManualPartDialog: () => void;
  manualAsmDialogVisible: Ref<boolean>;
  manualAsmForm: { drawing_no: string; name: string; file: File | null };
  manualAsmFileList: ComputedRef<UploadFile[]>;
  manualAsmFormValid: ComputedRef<boolean>;
  closeManualAsmDialog: () => void;
  addManualPart: () => void;
  confirmManualPart: () => Promise<void>;
  onManualPartFileChange: (file: UploadFile) => void;
  onManualPartFileRemove: () => void;
  addManualAssembly: () => void;
  confirmManualAssembly: () => Promise<void>;
  onManualAsmFileChange: (file: UploadFile) => void;
  onManualAsmFileRemove: () => void;
}

export function usePartBatchPdfRows(
  state: PdfBatchState,
  fill: UsePartBatchPdfFill,
  parse: UsePartBatchPdfParse,
): UsePartBatchPdfRows {
  const { customers, allPdfs, standaloneParts, assemblies } = state;
  const { applyExcelToAll } = fill;
  const {
    loadPdfDoc,
    pushPageSlice,
    rollbackPushedSources,
    sliceFailedMessage,
    pageCountFailedMessage,
    rejectIfSlicing,
    setSlicing,
  } = parse;

  /**
   * 实际建出的子件：被指定为总装图的那一页从子件里排除。
   * 表格里仍然渲染完整 `a.children`（下拉选项来自它、用户填的图号 / 交期不能丢），
   * 但建单 / 上传 / 计数一律走本函数。
   *
   * 排除是为了「页不重不漏」：总装图单独走 `kind=ASSEMBLY_MASTER`，若同一页又作为子件
   * 存在，打印会在总装图页之外再输出一次该页。
   */
  function effectiveChildren(a: AssemblyRow): AssemblyChildRow[] {
    if (a.masterPageIndex === null) return a.children;
    return a.children.filter((c) => c.page_index !== a.masterPageIndex);
  }

  // 2026-10-05：按 effectiveChildren 计数 —— 指定为总装图的那一页从子件里排除，
  // 表头计数必须与真正建出的子件数一致，否则用户按计数核对会多出一条。
  const totalAssemblyChildren = computed(() =>
    assemblies.value.reduce((sum, a) => sum + effectiveChildren(a).length, 0),
  );

  /**
   * 单价改动 → 自动联动总价（PR-H 2026-07-28 起三类行共用）。
   *
   * 三类行（独立零件 / 装配件顶层 / 装配件子件）的联动公式完全一样：
   * `total_price = unit_price × quantity`。对装配件顶层，`quantity` 是**套数**
   * （`AssemblyRow.quantity`），所以算出来的是整套总价，与 Excel 的整套口径一致。
   *
   * 用户手改过总价后本函数会把它覆盖掉 —— 表格里总价列可编辑，用户想保自己的值
   * 就以那次手改为准再点一次单价。数量为 0 或单价为空时**不动**总价（避免清空
   * 单价顺手把已有总价也抹成 0）。
   */
  function linkTotalPrice(
    row: { quantity: number; unit_price: number | null; total_price: number | null },
    v: number | undefined,
  ): void {
    row.unit_price = v ?? null;
    if (row.quantity > 0 && row.unit_price != null) {
      row.total_price = row.unit_price * row.quantity;
    }
  }

  function onUnitPriceChange(row: StandalonePartRow, v: number | undefined): void {
    linkTotalPrice(row, v);
  }
  function onAsmUnitPriceChange(a: AssemblyRow, v: number | undefined): void {
    linkTotalPrice(a, v);
  }
  function onChildUnitPriceChange(c: AssemblyChildRow, v: number | undefined): void {
    linkTotalPrice(c, v);
  }

  /** 行（standalone / 装配件顶层）客户下拉 onChange：同步 customer_name（显示用单段名）。 */
  function onCustomerLeafChange(
    row: { customer_id: string; customer_name?: string },
    v: string,
  ): void {
    row.customer_id = v;
    const c = customers.value.find((x) => x.id === v);
    row.customer_name = c?.name ?? '';
  }

  /** 装配件顶层计划交期改值 → 同步所有子件。简单覆盖语义：child 单独改后
   *  下次顶层改会被覆盖（如需「记住 child 单独覆盖」需加 flag 字段，本轮不做）。 */
  function onAsmPlannedChange(asmRow: AssemblyRow, v: string): void {
    asmRow.planned_delivery_date = v;
    for (const c of asmRow.children) c.planned_delivery_date = v;
  }

  /**
   * 总装图下拉改值：同时维护 `masterPageIndex` 与 `masterPdfSourceUid`（后者是那个
   * 子件的切片，提交 / 上传 / 状态格都按它寻址）。
   *
   * 判空用 `typeof v !== 'number'`：el-select 清空 emit 的是 `undefined`
   * （应用层配了 `value-on-clear` 时可能是 `''`），都按「无总装图」处理。
   */
  function onAsmMasterPageChange(a: AssemblyRow, v: number | null | undefined): void {
    if (typeof v !== 'number') {
      a.masterPageIndex = null;
      a.masterPdfSourceUid = null;
      return;
    }
    a.masterPageIndex = v;
    const child = a.children.find((c) => c.page_index === v);
    if (!child) {
      // 下拉选项就是从 children 生成的，理论上到不了这里。真到了说明 children 被
      // 换过（草稿恢复 / 将来新增的入口），宁可提示也不要静默按「无」提交。
      a.masterPdfSourceUid = null;
      ElMessage.warning('总装图选中的页在子件表里找不到，已按「无总装图」处理');
      return;
    }
    a.masterPdfSourceUid = child.pdfSourceUid;
  }

  // ============ 手动新增零件 / 装配件 ============
  const manualPartDialogVisible = ref(false);
  const manualPartForm = reactive<{
    drawing_no: string;
    name: string;
    file: File | null;
  }>({ drawing_no: '', name: '', file: null });
  const manualPartFileList = computed<UploadFile[]>(() =>
    manualPartForm.file
      ? [
          {
            uid: -1,
            name: manualPartForm.file.name,
            status: 'success',
            raw: manualPartForm.file as UploadFile['raw'],
          },
        ]
      : [],
  );
  const manualPartFormValid = computed(
    () => manualPartForm.drawing_no.trim().length > 0 && manualPartForm.file !== null,
  );

  function addManualPart(): void {
    manualPartForm.drawing_no = '';
    manualPartForm.name = '';
    manualPartForm.file = null;
    manualPartDialogVisible.value = true;
  }

  function onManualPartFileChange(file: UploadFile): void {
    manualPartForm.file = (file.raw as File | undefined) ?? null;
  }

  function onManualPartFileRemove(): void {
    manualPartForm.file = null;
  }

  async function confirmManualPart(): Promise<void> {
    if (state.guardRowMutation()) return;
    if (!manualPartFormValid.value) return;
    const f = manualPartForm.file!;
    const pdfUid = `manual-${makeUid()}`;
    allPdfs.value.push({
      uid: pdfUid,
      raw: f,
      filename: f.name,
      totalPages: 1,
      synthesized: false,
    });
    const created = state.makeStandaloneRow({
      pdfSourceUid: pdfUid,
      drawing_no: manualPartForm.drawing_no.trim(),
      name: manualPartForm.name.trim(),
    });
    standaloneParts.value.push(created);
    manualPartDialogVisible.value = false;
    // 2026-10-03：只回填本次新建的这一行（Excel 数据在 composable 级状态里活着）。
    applyExcelToAll({ parts: [created] });
    ElMessage.success('已新增零件');
  }

  /** 模板里点「取消」按钮的关闭动作。 */
  function closeManualPartDialog(): void {
    manualPartDialogVisible.value = false;
  }
  function closeManualAsmDialog(): void {
    manualAsmDialogVisible.value = false;
  }

  const manualAsmDialogVisible = ref(false);
  const manualAsmForm = reactive<{
    drawing_no: string;
    name: string;
    file: File | null;
  }>({ drawing_no: '', name: '', file: null });
  const manualAsmFileList = computed<UploadFile[]>(() =>
    manualAsmForm.file
      ? [
          {
            uid: -2,
            name: manualAsmForm.file.name,
            status: 'success',
            raw: manualAsmForm.file as UploadFile['raw'],
          },
        ]
      : [],
  );
  const manualAsmFormValid = computed(
    () => manualAsmForm.drawing_no.trim().length > 0 && manualAsmForm.file !== null,
  );

  function addManualAssembly(): void {
    manualAsmForm.drawing_no = '';
    manualAsmForm.name = '';
    manualAsmForm.file = null;
    manualAsmDialogVisible.value = true;
  }

  function onManualAsmFileChange(file: UploadFile): void {
    manualAsmForm.file = (file.raw as File | undefined) ?? null;
  }

  function onManualAsmFileRemove(): void {
    manualAsmForm.file = null;
  }

  async function confirmManualAssembly(): Promise<void> {
    if (state.guardRowMutation()) return;
    if (rejectIfSlicing()) return;
    if (!manualAsmFormValid.value) return;
    const f = manualAsmForm.file!;
    const pdfUid = `manual-asm-${makeUid()}`;
    const manualSource: PdfSource = {
      uid: pdfUid,
      raw: f,
      filename: f.name,
      // 下面读出页数后就地补上；先给 0 是为了让失败提示能用上这个 source（带文件名）
      totalPages: 0,
      synthesized: false,
    };
    // 2026-10-05：与「合并为装配件」同一口径 —— 每个子件只持自己那一页的单页切片。
    // 原始 PDF 也进 allPdfs，一起纳入回滚：切页失败时行没建出来，留着它会让用户重试时
    // 多出一份重复的源文件（源文件区是按 `!synthesized` 展示的，删得掉但看不见因果）。
    //
    // 重入闸门必须占在**任何 await 之前**：`countPdfPages` 是这里最慢的一步（pdfjs 要解析
    // 整份文件），占晚了对话框「添加」按钮在解析期间就变成可连点 ⇒ 建出两行重复装配件
    // （`POST /assemblies` 无幂等键）。`countPdfPages` 也因此必须落在 try 里：flag 已置位
    // 而 await 在 try 外的话，它一抛错 `pageSlicing` 就永远停在 true，本入口被焊死。
    const slices: PdfSource[] = [];
    // 失败发生在哪一步：`pages` = 连页数都读不出来（另一个失败面，见 `pageCountFailedMessage`）。
    let phase: 'pages' | 'slice' = 'pages';
    setSlicing(true);
    let totalPages = 0;
    try {
      totalPages = await countPdfPages(f);
      manualSource.totalPages = totalPages;
      phase = 'slice';
      allPdfs.value.push(manualSource);
      const srcDoc = await loadPdfDoc(f);
      for (let p = 0; p < totalPages; p++)
        slices.push(await pushPageSlice(manualSource, srcDoc, p));
    } catch (e) {
      rollbackPushedSources([manualSource.uid, ...slices.map((s) => s.uid)]);
      ElMessage.error(
        phase === 'pages'
          ? pageCountFailedMessage(manualSource, e)
          : sliceFailedMessage(manualSource, e),
      );
      return;
    } finally {
      setSlicing(false);
    }
    // 2026-10-11 口径变更：每个子件**直接取手动输入框的值**，与页数无关 ——
    // 不再拼 `-01 / -02` 后缀（与「合并为装配件」入口同口径，两条入口天然统一）。
    const asmDrawingNo = manualAsmForm.drawing_no.trim();
    const asmName = manualAsmForm.name.trim() || asmDrawingNo;
    const children: AssemblyChildRow[] = [];
    for (let p = 0; p < totalPages; p++) {
      children.push(
        state.makeAssemblyChild({
          pdfSourceUid: slices[p]!.uid,
          pageIndex: p,
          drawing_no: asmDrawingNo,
          name: asmName,
        }),
      );
    }
    const created = state.makeAssemblyRow({
      pdfSourceUid: pdfUid,
      drawing_no: asmDrawingNo,
      name: manualAsmForm.name.trim(),
      // 2026-10-05：默认「无总装图」，与「合并为装配件」一致。默认把第 1 页当总装图会
      // 让「有总装图 ⇒ 打印额外出总装图页 + 序列号背面」这条后端守卫在用户没要求时也被
      // 触发。要总装图由用户在下拉里显式指定。
      masterPageIndex: null,
      masterPdfSourceUid: null,
      children,
    });
    assemblies.value.push(created);
    manualAsmDialogVisible.value = false;
    // 2026-10-03：只回填本次新建的这一个装配件（含其子件交期同步），不动其它装配件。
    applyExcelToAll({ assemblies: [created] });
    ElMessage.success(`已新增装配件（共 ${totalPages} 子件）`);
  }

  return {
    effectiveChildren,
    totalAssemblyChildren,
    onUnitPriceChange,
    onAsmUnitPriceChange,
    onChildUnitPriceChange,
    onCustomerLeafChange,
    onAsmPlannedChange,
    onAsmMasterPageChange,
    manualPartDialogVisible,
    manualPartForm,
    manualPartFileList,
    manualPartFormValid,
    closeManualPartDialog,
    manualAsmDialogVisible,
    manualAsmForm,
    manualAsmFileList,
    manualAsmFormValid,
    closeManualAsmDialog,
    addManualPart,
    confirmManualPart,
    onManualPartFileChange,
    onManualPartFileRemove,
    addManualAssembly,
    confirmManualAssembly,
    onManualAsmFileChange,
    onManualAsmFileRemove,
  };
}
