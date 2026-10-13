// 2026-10-17 新增（客户无限层级改造）：零件新建两 Tab 的**客户选择器契约守卫**。
//
// 守四条静态契约，全都用源码断言而不是 mount 断言（同
// `PartBatchPdfTabChildCountContract.spec.ts` / `PdfPreviewDialogContract.spec.ts`
// 的取舍：被守的都是「配置值 / 校验放在哪一层」这类静态事实，mount 一次成本高且脆）：
//
//   1. 录入 Tab cascader 的 `label` 吃 `customer_path` 而不是 `name`。label 若退回
//      `name`，输入框里只显示「装配班」三个字 —— 同名部门跨分支时挂到了哪家完全
//      看不出来（选完即忘）。
//   2. `checkStrictly: true` **必须保留**：草稿 / 编辑态允许先选中间层（先定部门再定
//      班组），「必须落叶子」是**提交时**的业务闸，不是选择器的限制。
//   3. PDF 批量上传 Tab 两处行内「客户」列选的 option label 走 `path`
//      （= `customer_path`），候选来自 `props.leafCustomerOptions`（所选根子树内的
//      **叶子**）而不是「所选根的直接子」。
//   4. 「落叶子」的闸落在 `usePartBatchManual.ts::onAddConfirm` 而不是
//      `partEntrySchema.ts`：Zod 那层拿不到客户树结构（没有 customers），
//      塞进去就只能写一条永远判不出真假的空壳断言。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// happy-dom 环境下 import.meta.url 不保证是 file: 协议（见 usePartBatchPdf.spec.ts
// 的同类注释），用 cwd 拼路径更稳。
const ROOT = process.cwd();
const DIALOG = join(ROOT, 'src/views/parts/new/components/PartEntryFormDialog.vue');
const PDF_TAB = join(ROOT, 'src/views/parts/new/components/PartBatchPdfTab.vue');
const MANUAL = join(ROOT, 'src/views/parts/new/composables/usePartBatchManual.ts');
const SCHEMA = join(ROOT, 'src/views/parts/new/partEntrySchema.ts');

/** 剥注释：注释里出现的字段名不算代码（本守卫要守的是配置本身）。 */
function stripComments(src: string): string {
  const blank = (m: string): string => m.replace(/[^\n]/g, ' ');
  return src.replace(/<!--[\s\S]*?-->/g, blank).replace(/\/\*[\s\S]*?\*\//g, blank);
}

const DIALOG_SRC = stripComments(readFileSync(DIALOG, 'utf8'));
const PDF_TAB_SRC = stripComments(readFileSync(PDF_TAB, 'utf8'));

describe('录入 Tab 客户级联：cascader 配置契约', () => {
  it('label 走 customer_path（同名部门跨分支要能分辨）', () => {
    expect(
      DIALOG_SRC,
      'cascader 的 label 又退回 name 了：选中值只剩末段名字，同名部门无法分辨',
    ).toMatch(/label:\s*'customer_path'/);
    expect(
      DIALOG_SRC,
      'cascader 的 label 不该是 name —— CustomerTreeNode 带 customer_path 就是给级联' +
        '面板消歧用的',
    ).not.toMatch(/label:\s*'name'/);
  });

  it('checkStrictly 保留：草稿态允许选中间层（落叶子由提交闸负责）', () => {
    expect(DIALOG_SRC, 'checkStrictly 被去掉了：用户在组装草稿时无法先定部门再定班组').toMatch(
      /checkStrictly:\s*true/,
    );
    expect(DIALOG_SRC).toMatch(/emitPath:\s*false/);
  });
});

describe('PDF 批量上传 Tab：行内客户列选的候选与 label', () => {
  it('两处「客户」列（独立零件 / 装配件）候选都取 leafCustomerOptions，label 取 path', () => {
    const optionUses = PDF_TAB_SRC.match(/props\.leafCustomerOptions\.map\(/g) ?? [];
    expect(
      optionUses.length,
      '两处客户列（独立零件表 / 装配件表）的 option 来源不是 props.leafCustomerOptions：' +
        '行内列选又退回「所选根的直接子」，深度 ≥ 3 时中间层会被选中并被后端 20302 拒',
    ).toBe(2);
    expect(PDF_TAB_SRC).toMatch(/label: c\.path \|\| c\.name/);
    expect(
      PDF_TAB_SRC,
      'option label 不再用单段 name：深度 ≥ 3 时分不清是哪条路径下的同名部门',
    ).not.toMatch(/label: c\.name/);
    // 列头文案不再是「分厂」（任意深度下「分厂」不再是固定的那一层）
    expect(PDF_TAB_SRC).not.toContain("label: '分厂'");
  });
});

describe('「单据只能挂叶子」的闸放在哪一层', () => {
  const manualSrc = stripComments(readFileSync(MANUAL, 'utf8'));
  const schemaSrc = stripComments(readFileSync(SCHEMA, 'utf8'));

  it('onAddConfirm 里按「有没有子节点」拒掉中间层', () => {
    expect(
      manualSrc,
      'onAddConfirm 不再校验「客户必须是叶子」：中间层节点会被放进待新增列表，' +
        '提交时被后端 20302 拒',
    ).toMatch(/parent_id === matched\.id/);
    expect(manualSrc).toContain('还有下级部门');
  });

  it('这条闸不在 partEntrySchema 里（Zod 那层拿不到客户树结构）', () => {
    expect(
      schemaSrc,
      '「落叶子」被塞进 partEntrySchema 了：schema 是纯字段校验、拿不到 customers，' +
        '写进去只能是一条永远判不出真假的空壳断言',
    ).not.toMatch(/children|parent_id|叶子/);
  });
});

describe('装配件编辑弹窗：客户 option label（K4）', () => {
  it('label 用 customer_path，且不再走 useAssemblyDetail 的 formatCustomerOptionLabel', () => {
    const dlg = stripComments(
      readFileSync(join(ROOT, 'src/views/assemblies/components/AssemblyEditDialog.vue'), 'utf8'),
    );
    expect(
      dlg,
      '装配件编辑弹窗的 option label 又退回「直接父名 / 本级名」了：深度 ≥ 3 时只给出' +
        '最后一段祖先，跨分支同名仍分不清',
    ).toMatch(/:label="c\.customer_path \|\| c\.name"/);
    expect(
      dlg,
      '本组件不得再 import formatCustomerOptionLabel —— 该文件由并行任务独占，' +
        '本任务只在组件内联 customer_path',
    ).not.toContain('formatCustomerOptionLabel');
    expect(dlg).toContain('选择末级客户');
  });
});
