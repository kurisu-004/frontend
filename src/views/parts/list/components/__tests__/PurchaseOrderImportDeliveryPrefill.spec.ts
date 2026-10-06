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
//   赋值与 warnings 表达式的**原文**；warnings 是跨行数组字面量，断言前先做
//   空白归一。

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../../../../', import.meta.url));
const DIALOG = 'src/views/parts/list/components/PurchaseOrderImportDialog.vue';

/**
 * 把注释逐字符替换成空格（换行保留）—— 位置全不变，只在真实代码上判定。
 *
 * 2026-10-06 补剥独占整行的 `//`（做法与
 * src/views/parts/new/__tests__/PartBatchPdfTabChildCountContract.spec.ts 一致）：
 * 对话框 <script setup> 里 39 处注释全是独占整行，不剥的话一句
 * `// systemDeliveryDate: it.deliveryDate` 就能让负向断言假失败、一句
 * `// systemDeliveryDate: delivery.prefill(...)` 就能让正向断言假通过。
 * 不做「遇到 // 就截断」那种粗暴处理（会误伤 URL 里的 //）；本文件唯一的行尾
 * 注释是 onConfirm 里的 `return; // 用户取消`，已核过它不含任何被守卫的字面量。
 */
function stripComments(src: string): string {
  const blank = (m: string): string => m.replace(/[^\n]/g, ' ');
  return src
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/^[ \t]*\/\/[^\n]*$/gm, blank);
}

const src = stripComments(readFileSync(join(ROOT, DIALOG), 'utf8'));
/** 空白归一，让跨行的对象字面量能被单条断言覆盖。 */
const flat = src.replace(/\s+/g, ' ');

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

  it('warnings 无条件展开，不与后端返回的数组共享引用', () => {
    expect(
      flat,
      `${DIALOG} 的 warnings 没有把 ...matchWarnings 摊进新数组：` +
        'PreviewGroup 会直接持有后端响应的数组实例，将来谁 push / sort 就污染响应对象',
    ).toMatch(/warnings:\s*\[\s*\.\.\.matchWarnings\s*,/);
    expect(
      flat,
      `${DIALOG} 里仍有把 matchWarnings 实例直接交给 PreviewGroup 的分支（如 : matchWarnings）`,
    ).not.toMatch(/:\s*matchWarnings\s*[,\}]/);
  });

  it('本地说明只在有候选时追加（未匹配行的提示是纯噪音）', () => {
    expect(
      flat,
      `${DIALOG} 没给本地说明加 parts.length > 0 的门槛：` +
        '无候选的行压根用不上日期，却会被挂上说明、抬高警告计数',
    ).toMatch(/delivery\.warning && parts\.length > 0 \? \[delivery\.warning\] : \[\]/);
  });
});
