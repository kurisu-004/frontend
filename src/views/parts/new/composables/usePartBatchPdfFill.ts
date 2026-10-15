// Tab 2「PDF 批量上传」的**回填段**（2026-10-20 从 usePartBatchPdf.ts 拆出）。
//
// 这一段只做一件事：把 Excel 解析出来的行按图号回填到表内三类行上。它独立成模块的
// 理由是**作用域契约独立**：回填的「传了就必须显式给全两侧、缺侧即空、绝不退回全量」
// 只在这段成立（四个建行入口各自传本次新建的那一侧，重新解析才走全表），与建行 /
// 建单 / 上传三段的口径都无关 —— 混在一个文件里时这条契约只能靠读满屏代码自己找。
//
// 依赖：只依赖共享状态层（`PdfBatchState`）。不动行集合本身（`three_d_index` 除外，
// 那在解析段），所以不会触发行世代号。

import { ElMessage } from 'element-plus';
import { parseBidExcel, type BidRow, type ParseResult } from '@/utils/bidExcelParser';
import { parseHistoricalPriceExcel } from '@/utils/historicalPriceExcelParser';
import { todayIso } from './usePartBatchShared';
import type { PdfBatchState } from './usePartBatchPdfState';
import type { ExcelFillTarget } from './usePartBatchPdfTypes';

export interface UsePartBatchPdfFill {
  /** 读一份 Excel（arrayBuffer）→ BidRow[]。sheet 名决定走哪套 parser。 */
  readExcel: (file: File) => Promise<BidRow[]>;
  /** 按图号把 Excel 行覆盖到表内字段（作用域见 `ExcelFillTarget`）。 */
  applyExcelToAll: (target?: ExcelFillTarget) => void;
}

export function usePartBatchPdfFill(state: PdfBatchState): UsePartBatchPdfFill {
  const { customers, pdfForm, standaloneParts, assemblies, excelByDrawingNo } = state;

  async function readExcel(file: File): Promise<BidRow[]> {
    const buf = await file.arrayBuffer();

    // 2026-09-21 对齐 TS 严格：动态 import 拿 xlsx 必须靠 typeof import() 反推类型。
    // 项目 eslint 规则 @typescript-eslint/consistent-type-imports 默认禁此内联写法，
    // 但本文件刻意保持动态 import 以避免 xlsx（~700KB）进首屏 bundle，故此处加行级豁免。
    // 已知风险见 docs/08-known-risks/dependency-risks.md。
    // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- 动态 import 故意不进主 bundle，类型只能内联 typeof import() 反推
    const XLSX: typeof import('xlsx') = await import('xlsx');
    const wb = XLSX.read(buf, { type: 'array' });
    const sheetNames = wb.SheetNames;
    let parsed: ParseResult;
    if (sheetNames.includes('历史价确认单明细')) {
      parsed = parseHistoricalPriceExcel(wb, todayIso(), XLSX.utils);
    } else if (sheetNames.includes('招标项目-标的')) {
      parsed = parseBidExcel(wb, todayIso(), XLSX.utils);
    } else {
      throw new Error(
        `Excel 格式无法识别（需要「历史价确认单明细」或「招标项目-标的」sheet），当前文件 sheet: ${sheetNames.join(', ')}`,
      );
    }
    if (parsed.errors.length > 0) {
      ElMessage.warning(`Excel 解析告警：${parsed.errors.length} 条（已忽略）`);
    }
    return parsed.rows;
  }

  /** 用 Excel 行覆盖表内字段（applicant / quantity / planned_delivery_date + 客户 + 单价）。
   *  2026-07-30 起不再覆盖 is_urgent（批量 PDF 导入默认全部不加急，由用户手动 switch）。
   *
   *  数据源是 composable 级 `excelByDrawingNo`。没有 Excel 数据时静默返回（不抛错、不提示）
   *  —— 「没传 Excel」是完全正常的用法，不该打扰用户。
   *
   *  `target` **不传** = 全表（只有 `rebuildFromUploads` 走这条：它本就整体替换了
   *  `standaloneParts` 并清空 `assemblies`，表内全是刚解析出来的新行，不存在「用户
   *  手改过的既有行」需要保护）。`target` **已传** = 只回填它显式给出的集合，
   *  **没给的一侧按空集合处理，绝不退回全量**：全表重扫会把用户在另一侧（独立零件表
   *  ↔ 装配件表）手改过的数量 / 单价 / 总价 / 交期 / 申请人一起覆盖回 Excel 值
   *  （客户有 `!customer_id` 守卫所以幸免），而「建行」这个动作与那些行无关。
   *  ⇒ 4 个建行入口（合并成零件 / 合并成装配件 / 手动新增零件 / 手动新增装配件）
   *  一律显式传入本次新建的行，且**只给本次涉及的那一侧**。 */
  function applyExcelToAll(target?: ExcelFillTarget): void {
    const excelMap = excelByDrawingNo.value;
    if (!excelMap) return;
    // 2026-10-03：作用域在进循环前一次性定死 —— 不传 = 两张表全量；传了 = 只用它
    //  给出的集合（缺侧即空）。先算成两个局部变量，是为了让「传了作用域就绝不兜回
    //  全量」这件事在代码里一眼可读，且不可能再被 `??` 悄悄改回隐式回落。
    const parts = target ? (target.parts ?? []) : standaloneParts.value;
    const asms = target ? (target.assemblies ?? []) : assemblies.value;
    for (const r of parts) {
      const matched = excelMap.get(r.drawing_no);
      if (!matched) continue;
      r.applicant_name = matched.applicantName || r.applicant_name;
      r.quantity = matched.quantity || r.quantity;
      // 2026-07-30：批量 PDF 导入不再从应标 Excel 继承 is_urgent，默认全部不加急；
      // 用户在 el-switch 单独打开加急。
      if (matched.plannedDeliveryDate) r.planned_delivery_date = matched.plannedDeliveryDate;
      // PR-H 2026-07-28：含税单价 / 总价
      if (matched.unitPrice != null) r.unit_price = matched.unitPrice;
      if (matched.totalPrice != null) r.total_price = matched.totalPrice;
      // 自动解析客户（Excel 的「申请人所在一级部门名称」→ 客户 id）
      if (!r.customer_id) {
        const customerId = resolveCustomerIdFromDeptName(matched.deptName);
        if (customerId) {
          r.customer_id = customerId;
          const c = customers.value.find((x) => x.id === customerId);
          r.customer_name = c?.name ?? '';
        }
      }
    }
    for (const a of asms) {
      // 2026-10-11：顶层命中源为**装配件自身图号** `a.drawing_no`，且**不再有子件
      // 回退** —— 子件图号 / 名称已统一取源值（两个建行入口都不再拼 `-01 / -02`
      // 后缀），建行那一刻 `a.children[i].drawing_no` 与 `a.drawing_no` 恒等；本函数
      // 只在建行的同一 tick 里跑一次，草稿又是只写不恢复的（无「先建后改子件图号
      // 再回填」的时序），所以 `childHit` 分支已不可达，保留只会让人误以为子件图号
      // 还能与顶层不同。
      //
      // ⚠️ 随之而来的**已知代价**：Excel 的「物料编号」列若是旧口径的「逐个子件各占一行」
      // （那一行装的是子件自己的图号；那行的**单价**是子件价，而客户 / 申请人 / 数量 /
      // 计划交期在两种形态下都是整套口径），顶层图号在表里查不到 ⇒ 这一行**整行都不回填**：
      // 客户 / 申请人 / 计划交期 / 单价 / 总价保持建行时的空值（`makeAssemblyRow` 的
      // 默认值）待手填，数量保持默认 1。不再是「只有价不回填、其余几列照填」。
      // 子件图号与装配件一致是产品定的口径，不做前缀模糊匹配：错的数字比空值危险。
      const ownHit = excelMap.get(a.drawing_no);
      if (ownHit) {
        // 客户 / 申请人由顶层统一持有（子件不再各自持有这两个字段）
        if (!a.customer_id) {
          const customerId = resolveCustomerIdFromDeptName(ownHit.deptName);
          if (customerId) {
            a.customer_id = customerId;
            const c = customers.value.find((x) => x.id === customerId);
            a.customer_name = c?.name ?? '';
          }
        }
        a.applicant_name = ownHit.applicantName || a.applicant_name;
        // 数量 = **整套数量**（业务口径：Excel 的数量是整套的数量）
        a.quantity = ownHit.quantity || a.quantity;
        if (ownHit.plannedDeliveryDate) a.planned_delivery_date = ownHit.plannedDeliveryDate;
        // `!= null` 只是类型防御：`BidRow.unitPrice` / `totalPrice` 声明为 `number`，
        // parser 已把空值 / 负数兜底成 0（`totalPrice` 缺列时是 `unitPrice * quantity`），
        // 永不为 null ⇒ 走不到短路，Excel 单元格为空时**照样**以 0 覆盖用户手填的单价。
        if (ownHit.unitPrice != null) a.unit_price = ownHit.unitPrice;
        if (ownHit.totalPrice != null) a.total_price = ownHit.totalPrice;
      }
      // 未命中（`ownHit` 为 undefined）时顶层整套价保持 null 等用户手填：Excel 的
      // 「物料编号」列装不进这个装配件的图号，硬套别的行的价格会与整套口径差一个套数
      // 倍率，错的数字比空值更危险。
      // 2026-10-05 子件口径（业务口径：客户 / 申请人 / 计划交期 / 单价是整套共享的，
      // 子件数量与单价需手填）：
      //   - 计划交期：顶层填完后同步给全部子件，保证「整套一个交期」。交期既可能来自
      //     Excel，也可能来自用户在顶层手改（`onAsmPlannedChange`），两种来源都会同步
      //     下来；子件单独改过的交期会被顶层值覆盖，与该 handler 的简单覆盖语义一致。
      //   - quantity 保持 makeAssemblyChild 的默认值 1；
      //   - unit_price / total_price 保持 null 待手填。**子件单价不从 Excel 回填**：
      //     Excel 的含税单价是**整套**口径（同一行同时给出了整套数量和整套总价），
      //     摊到每个子件上会让 N 个子件把整套价重复计价 N 倍。要给子件单独定价就得
      //     人工按子件拆，用户在子件行的「含税单价」列自己填。
      if (a.planned_delivery_date) {
        for (const c of a.children) c.planned_delivery_date = a.planned_delivery_date;
      }
      // 2026-07-30：子件不从应标 Excel 继承 is_urgent（同独立零件，默认全部不加急）。
    }
  }

  /**
   * 把 Excel 的「申请人所在一级部门名称」（如「六厂」「一车间 装配班」）解析成客户 id。
   *
   * 2026-10-17（客户无限层级改造）：查找范围由「所选根的**直接子**」改成「所选根的
   * **整棵子树**」，且只在**叶子**里匹配 —— 业务单据只能挂叶子，命中中间层等于交一份
   * 必然被后端拒（20104）的数据。叶子口径与 `leafCustomerOptions`（行内下拉候选）
   * 逐字一致 ⇒ 「Excel 能自动回填的值一定能在下拉里选到，用户看得懂它是什么」。
   *
   * **同名多命中不猜**：子树里出现两个同名叶子（不同分支下都有「一车间」）时返回
   * `null`，由调用点保持该行客户为空、待用户手选。取第一个匹配会把零件挂到另一个部门，
   * 错数据比空值危险（同本文件 Excel 价回填、CLAUDE.md 多处「错的比空危险」的口径）。
   *
   * 调用点两处（独立零件行 / 装配件顶层行）都在 `if (!row.customer_id)` 守卫内，
   * 返回 `null` 时不写任何字段 ⇒ 该行客户保持空值待手填。
   */
  function resolveCustomerIdFromDeptName(deptName: string): string | null {
    const rootId = pdfForm.customerL1Id;
    const wanted = deptName.trim();
    if (!rootId || !wanted) return null;
    const hits = state.leafCustomerOptions.value.filter((c) => c.name.trim() === wanted);
    if (hits.length !== 1) return null;
    return hits[0]?.id ?? null;
  }

  return { readExcel, applyExcelToAll };
}
