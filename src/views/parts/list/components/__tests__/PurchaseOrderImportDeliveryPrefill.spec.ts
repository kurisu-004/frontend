// src/views/parts/list/components/__tests__/PurchaseOrderImportDeliveryPrefill.spec.ts
//
// 回归守卫单测：锁「系统交期的候选默认值必须经 resolveExcelDeliveryDate」这条契约。
//
// 2026-10-06 缺陷（MAJOR-1）：Excel 交货日期无法识别时（待定 / 2026年8月1日），
//   purchaseOrderExcelParser 的 parseDateOrNull 是原样透传的，而 el-date-picker 不会
//   顺手洗掉绑定的 model 值（解析失败只把展示用的 parsedValue 置空）。于是原文一路
//   流进 batch-update 的 system_delivery_date，后端该字段是三态 NaiveDate，反序列化
//   阶段就 400（body 还是纯文本不是 R 信封），用户已勾选的整批回填全部作废。
//
// 为什么用源码断言而不是 mount 断言：
//   候选行只渲染在 el-table 的 expand 展开内容里，能不能读到它取决于 el-table 的
//   内部展开状态；为了读一个默认值去 mount 整个 el-dialog + el-upload + el-table +
//   el-date-picker（还要连列拖动 composable 的 MutationObserver），测出来的东西既脆
//   又测不准 —— 与 PdfPreviewDialogContract.spec.ts 同一判断：真正能测出回归的是
//   「取值走的哪条路」这条静态契约。行为正确性由
//   src/utils/__tests__/purchaseOrderExcelParser.spec.ts 的 resolveExcelDeliveryDate
//   用例覆盖（那条链路上「保持零件现有值 / 不映射成 null」逐字断言过），本守卫只锁
//   「对话框确实调用了它、且没有绕回去直接取 it.deliveryDate」。
//
// 判定逻辑（避免「文件里出现过这个字符串就算过」的高误判）：
//   先剥注释（注释里出现的 deliveryDate / prefill 字面量不算结构），再断言候选
//   赋值的**表达式原文**。

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../../../../', import.meta.url));
const DIALOG = 'src/views/parts/list/components/PurchaseOrderImportDialog.vue';

/** 把注释逐字符替换成空格（换行保留）—— 位置全不变，只在真实代码上判定。 */
function stripComments(src: string): string {
  const blank = (m: string): string => m.replace(/[^\n]/g, ' ');
  return src.replace(/<!--[\s\S]*?-->/g, blank).replace(/\/\*[\s\S]*?\*\//g, blank);
}

const src = stripComments(readFileSync(join(ROOT, DIALOG), 'utf8'));

describe('采购订单导入的系统交期预填契约', () => {
  it('候选默认值走 resolveExcelDeliveryDate 的 prefill', () => {
    expect(
      src,
      `${DIALOG} 的 buildPreviewGroups 里没有把预填交给 resolveExcelDeliveryDate，` +
        '不可识别的 Excel 交货日期会原样发往后端 → 整批 400',
    ).toContain('systemDeliveryDate: delivery.prefill(part.system_delivery_date)');
  });

  it('候选默认值不再直接取 Excel 的 deliveryDate', () => {
    expect(
      src,
      `${DIALOG} 里仍有 systemDeliveryDate: it.deliveryDate：` +
        'Excel 交货日期不可识别时会把原文（如「待定」）当成新交期发出去',
    ).not.toMatch(/systemDeliveryDate:\s*it\.deliveryDate/);
  });

  it('不可解析 / 缺失时不映射成 null（null 在后端三态里是清空）', () => {
    expect(
      src,
      `${DIALOG} 里出现 it.deliveryDate ?? null 形态的兜底：` +
        'null 会把零件上已有的系统交期静默清成 NULL，比整批 400 更危险',
    ).not.toMatch(/deliveryDate\s*\?\?\s*null/);
  });

  it('该行的 warnings 追加本地说明，且不改后端返回的数组本身', () => {
    expect(
      src,
      `${DIALOG} 的 buildPreviewGroups 没把「保持现有交期」的说明追加进该行 warnings，` +
        '用户只能在候选行里看到日期没变，不知道 Excel 那列写了什么',
    ).toContain('delivery.warning ? [...matchWarnings, delivery.warning] : matchWarnings');
  });
});
