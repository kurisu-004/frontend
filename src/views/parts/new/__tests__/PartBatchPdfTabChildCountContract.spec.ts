// 2026-10-05 新增：装配件表「子件数」列与工具栏表头计数的**同口径**守卫。
//
// 缺陷：表格「子件数」列按 `r.children.length` 显示，工具栏表头按 `totalAssemblyChildren`
// （= 全部装配件的 `effectiveChildren` 之和）显示，两者不是同一份数据。指定某页作总装图
// 后该页从子件里排除（否则打印会重复输出该页），于是同一个视图里两个数字直接打架：
// 2 页装配件 + 指定第 1 页 = 表头「共 1 子件」、行内「子件数 2」。
// 影响只在展示层（建单 / 上传 / 建号全走 effectiveChildren，数据与后端契约都对），但用户
// 正是拿这一列跟表头、以及跟真正建出的子件数核对的，数字打架会让人以为多了一条子件。
//
// 为什么用源码断言而不是 mount 断言：
//   本组件的 props 面是整个 `usePartBatchPdf()` 的返回值（几十项），模板内嵌 el-table /
//   el-upload / 拖拽排序 / PDF 预览弹窗，mount 一次的成本与脆弱度远高于被测的那一行
//   `cellRender`。而「这一列取的是哪份数据」本身就是一条静态契约 —— 同
//   `src/components/__tests__/PdfPreviewDialogContract.spec.ts` 的取舍。
//   定位按 `key: 'children_length'` 切出**该列自己的 def 块**（到下一个 `key:` 为止），
//   不做整文件搜 `children.length`（其它列、子件行模板里都合法出现这个字面量）。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../../..', import.meta.url));
const TAB = 'src/views/parts/new/components/PartBatchPdfTab.vue';

/**
 * 剥注释：注释里出现的 `children.length` / `totalAssemblyChildren` 字面量不算代码。
 * 本文件的注释全是「整行独占」写法（无行尾注释，已核过），所以只按独占行剥 `//`，
 * 不做「遇到 `//` 就截断」那种会误伤 URL 的粗暴处理。
 */
function stripComments(src: string): string {
  const blank = (m: string): string => m.replace(/[^\n]/g, ' ');
  return src
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/^[ \t]*\/\/[^\n]*$/gm, blank);
}

/** 返回 `key: '<keyName>'` 那一列自己的 def 块原文；找不到该列直接抛（结构变了）。 */
function columnBlock(src: string, keyName: string): string {
  const at = src.indexOf(`key: '${keyName}'`);
  if (at < 0) throw new Error(`没找到 key: '${keyName}' 的列 def，列结构变了请同步本守卫`);
  const rest = src.slice(at);
  const nextKey = rest.slice(1).search(/\bkey:\s*'/);
  return nextKey < 0 ? rest : rest.slice(0, nextKey + 1);
}

const SRC = stripComments(readFileSync(join(ROOT, TAB), 'utf8'));

describe('装配件「子件数」列与表头计数的口径一致性', () => {
  it('「子件数」列按 effectiveChildren 计数，不按 children.length', () => {
    const block = columnBlock(SRC, 'children_length');
    expect(
      block,
      '「子件数」列的 cellRender 不再走 props.effectiveChildren：' +
        '指定总装图后这一列会比表头 totalAssemblyChildren 多出一条子件',
    ).toContain('props.effectiveChildren(');
    expect(
      block,
      '「子件数」列又改回按 children.length 计：被指定为总装图的那一页被算成子件，' +
        '与表头「共 N 子件」及真正建出的子件数打架',
    ).not.toMatch(/\.children\.length/);
  });

  it('工具栏表头的子件总数走 totalAssemblyChildren（不自己数 children.length）', () => {
    const at = SRC.indexOf('class="tree-stat"');
    expect(at, '工具栏那行统计（tree-stat）找不到了，本守卫需同步').toBeGreaterThan(0);
    const stat = SRC.slice(at, SRC.indexOf('</span>', at));
    expect(
      stat,
      '表头的子件总数没走 totalAssemblyChildren：两处各自数一遍就会在指定总装图后打架',
    ).toContain('{{ totalAssemblyChildren }}');
  });
});
