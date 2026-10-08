// src/components/__tests__/PdfPreviewDialogContract.spec.ts
//
// 回归守卫单测：锁「用 el-dialog 承载 PdfViewer 处必须挂 .pdf-preview-dialog」这条契约。
//
// 2026-10-03 缺陷：零件详情页预览 PDF 时「工具栏在、下面纯白」。
//   病灶是 PdfViewer 内部的 flex 高度链要求宿主有确定高度
//   （.pdf-viewer{height:100%} → .canvas-wrap{flex:1} → .pdf-viewport{flex:1;overflow:hidden}），
//   而 EP 的 .el-dialog__body 是 display:block + height:auto，直接子元素的 height:100%
//   退化成 auto，链塌成 0，position:absolute 的 canvas 被 overflow:hidden 裁掉。
//   全站 7 处 fullscreen 弹窗都照抄了「el-dialog body 有确定高度」这个错误假设，一起空白。
//
// 为什么用源码断言而不是 mount 断言：
//   这是**纯 CSS 塌陷**，jsdom 没有布局引擎（不实现 flex / definite height / 视口单位），
//   mount 后量到的盒模型全是 0，测出来恒等「有 bug」或恒等「无 bug」，无法区分修复前后 ——
//   写出来的断言是自欺。真正能测出回归的是「承载标记在不在」这条静态契约：
//   el-dialog 上没挂 .pdf-preview-dialog，就等于没给高度，身体怎么量都会塌。
//   故本守卫读 .vue 源码，判定「<PdfViewer> 所属的那个 el-dialog 开标签里有没有该 class」。
//
// 判定逻辑（避免「文件里出现过这个字符串就算过」的高误判）：
//   1. 先剥 HTML 注释（注释里出现的 el-dialog / PdfViewer 字面量不算结构）。
//   2. 按出现顺序扫 `<el-dialog ...>` / `</el-dialog>`，用栈维护嵌套；
//      每遇到一个 `<PdfViewer`，栈顶就是「拥有它的那一个 el-dialog」。
//   3. 断言该开标签同时含 `pdf-preview-dialog` 与 `fullscreen`
//      （缺 fullscreen 则 .is-fullscreen 选择器不命中，class 形同虚设）。
//
// 范围说明（有意只锁这 7 处，不做全仓扫描）：
//   - 非 fullscreen 弹窗不走这条规则。OutsourceQuotePdfPreview.vue 是 900px 宽的
//     非全屏预览，它在自己的 scoped 样式里给 .drawing-frame-wrap 定了确定高度。
//   - 宿主自带确定高度、无需该 class 的 2 处（不改、也不在本守卫内）：
//     DrawingPreviewPane（.file-preview flex 链）、PartPreviewDialog（aspect-ratio 定宽定高）。
//   上述「例外集合」是人工判定，再加一条全仓扫描只会把维护者绑在人工白名单上；
//  本守卫的价值是锁死这 7 个已知调用点，新增 fullscreen 预览弹窗请一并加进下面的表。

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/** 全部「el-dialog fullscreen 直接承载 PdfViewer」的调用点（相对仓库根，正斜杠）。 */
const FULLSCREEN_PDF_DIALOGS: { file: string; where: string }[] = [
  { file: 'src/components/FileListCard.vue', where: 'previewVisible 预览弹窗' },
  { file: 'src/views/assemblies/components/AssemblyChildrenTable.vue', where: '子件图纸预览' },
  { file: 'src/views/production/scan/ScanPickParts.vue', where: '图纸预览' },
  { file: 'src/views/production/scan/ScanInspectParts.vue', where: '图纸预览' },
  { file: 'src/views/production/scan/ScanReturnParts.vue', where: '图纸预览' },
  { file: 'src/views/parts/new/components/PartBatchPdfTab.vue', where: 'PDF 文件名预览' },
  { file: 'src/views/parts/new/components/PartBatchManualTab.vue', where: '图纸预览' },
];

/** 把注释逐字符替换成空格（换行保留）—— 位置全部不变，标签栈只在真实结构上跑。 */
function stripComments(src: string): string {
  const blank = (m: string): string => m.replace(/[^\n]/g, ' ');
  return src.replace(/<!--[\s\S]*?-->/g, blank).replace(/\/\*[\s\S]*?\*\//g, blank);
}

/** 返回每个 `<PdfViewer>` 所属 el-dialog 的开标签原文。 */
function owningDialogTags(src: string): string[] {
  const open: string[] = [];
  const owned: string[] = [];
  for (const m of src.matchAll(/<el-dialog\b[^>]*>|<\/el-dialog>|<PdfViewer\b/g)) {
    const tag = m[0];
    if (tag === '</el-dialog>') {
      open.pop();
    } else if (tag.startsWith('<el-dialog')) {
      open.push(tag);
    } else if (open.length > 0) {
      // 栈顶 = 最近的、尚未闭合的 el-dialog，即「拥有这个 PdfViewer 的那一个」
      owned.push(open[open.length - 1] as string);
    }
  }
  return owned;
}

describe('el-dialog 承载 PdfViewer 的高度契约', () => {
  for (const { file, where } of FULLSCREEN_PDF_DIALOGS) {
    it(`${file} 的「${where}」弹窗挂了 pdf-preview-dialog`, () => {
      const src = stripComments(readFileSync(join(ROOT, file), 'utf8'));
      const owners = owningDialogTags(src);
      expect(
        owners.length,
        `${file} 里没扫到承载 PdfViewer 的 el-dialog，模板结构变了请同步本表`,
      ).toBeGreaterThan(0);
      for (const tag of owners) {
        const oneline = tag.replace(/\s+/g, ' ');
        expect(
          oneline,
          `${file}（${where}）承载 PdfViewer 的 el-dialog 缺 class="pdf-preview-dialog"：` +
            'body 是 auto 高度，PdfViewer 的 flex 高度链会塌成 0，画面全白',
        ).toContain('pdf-preview-dialog');
        expect(
          oneline,
          `${file}（${where}）的 el-dialog 缺 fullscreen，` +
            '.pdf-preview-dialog 的 .is-fullscreen 选择器不命中，该 class 形同虚设',
        ).toContain('fullscreen');
      }
    });
  }

  it('.pdf-preview-dialog 的全局规则存在', () => {
    const scss = stripComments(readFileSync(join(ROOT, 'src/styles/index.scss'), 'utf8'));
    expect(
      scss.replace(/\s+/g, ' '),
      'src/styles/index.scss 里的 .pdf-preview-dialog 规则被删了：' +
        '上面 7 处 class 会变成无样式的空标记，高度链照旧塌陷',
    ).toContain('.pdf-preview-dialog.el-dialog.is-fullscreen');
  });
});
