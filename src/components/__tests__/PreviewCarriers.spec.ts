// src/components/__tests__/PreviewCarriers.spec.ts —— 图纸预览「承载点契约」守卫。
//
// 这三类契约都是**全仓 spec 全绿也拦不住**的：它们不在任何一个组件的内部逻辑里，而是
// 「同一个语义在 6 处承载点之间必须保持一致」。mount 用例测不到（一次只挂一个承载点），
// 而任何一处漂移的后果都是静默的：
//
//   1. **转图等待期的文案**：转图还在等时那句提示必须说「图纸转图中…」，说成
//      「加载原始 PDF…」是在骗用户 —— 那一刻一个 `/content` 请求都没发过。
//   2. **blob URL 的释放**：object URL 只有 revoke 才释放内存，漏一次就是一次泄漏，
//      而预览是可反复打开的。
//   3. **迟到守卫**：异步拿到的 blob 若在「用户已关窗 / 已换文件」之后才回来，写进去
//      就是一份永远不会被 revoke 的孤儿。
//
// 断言方式是读 .vue 源码（与 `PdfPreviewDialogContract.spec.ts` 同款）：这三条都是
// **跨文件的写法一致性**，不是运行时行为，挂一次组件看不出「另外 5 处有没有跟上」。
// 判据都取「同一行 / 同一个函数体内」这种粗粒度锚点，避免写正则去解 Vue 模板。

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function srcOf(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8');
}

/**
 * 取某个 `.vue` 的 <template> 段（脚本段里的同名字面量不算数）。
 *
 * 用 `lastIndexOf` 收尾而不是 `indexOf`：Vue SFC 的模板里有插槽（`<template #default>`），
 * 第一个 `</template>` 往往只是某个插槽的结束标签。
 */
function templateOf(rel: string): string {
  const src = srcOf(rel);
  const t = src.indexOf('<template>');
  const e = src.lastIndexOf('</template>');
  expect(t, `${rel} 里找不到 <template>`).toBeGreaterThanOrEqual(0);
  expect(e, `${rel} 里找不到 </template>`).toBeGreaterThan(t);
  return src.slice(t, e);
}

/**
 * 剥掉注释行（整行注释 + 块注释），只留代码。
 *
 * 为什么必须剥：这批断言扫的是「源码里有没有某个写法」，而注释里为了说明问题会**原样
 * 引用**被禁的写法。不剥的话，一条正确的注释就能让守卫假红。
 * 只剥「整行是注释」与块注释，不做 `//` 全文替换 —— 源码里有 `https://`，一刀切会截断。
 */
function stripComments(src: string): string {
  const blank = (m: string): string => m.replace(/[^\n]/g, ' ');
  return src
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .split('\n')
    .map((l) => (/^\s*(\/\/|\*)/.test(l) ? l.replace(/[^\n]/g, ' ') : l))
    .join('\n');
}

/** 第 `idx` 行所在的「外层函数块」：从它往上最近的一个函数/箭头函数头，到该行为止。 */
function enclosingBlock(lines: string[], idx: number): string {
  let start = 0;
  for (let i = idx - 1; i >= 0; i -= 1) {
    if (/^\s*(export\s+)?(async\s+)?function\s+\w+/.test(lines[i] as string)) {
      start = i;
      break;
    }
  }
  return lines.slice(start, idx + 1).join('\n');
}

// ============================================================
// 1. 转图等待期的文案
// ============================================================
describe('转图等待期不能说成「加载原始 PDF…」', () => {
  // 这四处是「降级合流」形态（wantsOriginalPdf = 用户点了逃生口 || preview.degraded）。
  // 它们在原始 PDF 分支里既可能是「转图还在等」，也可能是「已决定看原始 PDF、正在拉
  // blob」—— 两种情形必须分开说。
  const MERGED: string[] = [
    'src/components/FileListCard.vue',
    'src/views/assemblies/components/AssemblyChildrenTable.vue',
    'src/views/production/components/DrawingPreviewPane.vue',
    'src/views/dashboard/components/PartPreviewDialog.vue',
  ];

  for (const rel of MERGED) {
    it(`${rel}：「加载原始 PDF…」那一句与转图文案同处一个三元（判据是 wantsOriginalPdf）`, () => {
      const tpl = stripComments(templateOf(rel));
      const hit = tpl
        .split('\n')
        .filter((l) => l.includes('加载原始 PDF…'));
      expect(hit.length, '找不到「加载原始 PDF…」那一句').toBe(1);
      const line = hit[0] as string;
      expect(
        line,
        `「加载原始 PDF…」必须是 \`wantsOriginalPdf ? '加载原始 PDF…' : '图纸转图中…'\`：` +
          '无条件说「加载原始 PDF」会让仍在转图的 PDF 显示成在拉原始 PDF（那一刻没发过 /content）',
      ).toContain('wantsOriginalPdf');
      expect(line, '同一句里必须带上转图中的那一档').toContain('图纸转图中');
    });
  }

  // PartDrawingPreviewDialog 是「独立分支」形态：转图等待是一个 v-else-if，
  // 条件里显式排除 wantsOriginalPdf。按分支而非按三元核对。
  it('PartDrawingPreviewDialog.vue：转图等待是独立分支，且条件排除 wantsOriginalPdf', () => {
    const tpl = stripComments(templateOf('src/views/production/scan/components/PartDrawingPreviewDialog.vue'));
    const branch = tpl
      .split('\n')
      .find((l) => l.includes('v-else-if') && l.includes('!wantsOriginalPdf'));
    expect(branch, '找不到「转图等待」那个 v-else-if 分支').toBeDefined();
    // 分支之后三行内应当就是「图纸转图中…」
    const lines = tpl.split('\n');
    const idx = lines.indexOf(branch as string);
    const window = lines.slice(idx, idx + 4).join('\n');
    expect(window, '转图等待分支里必须说「图纸转图中…」').toContain('图纸转图中');
    expect(window, '转图等待分支里不得出现「加载原始 PDF…」').not.toContain('加载原始 PDF');
  });

  // OutsourceQuotePdfPreview 是「受控 props」形态：它自己不知道 caller 在不在转图，
  // 判据由 caller 给的 busyHint 决定。两条都要钉：子组件认这个 prop、caller 真的传了。
  it('OutsourceQuotePdfPreview.vue：转图等待由 busyHint 决定，且排在「无可预览内容」之前', () => {
    const tpl = stripComments(templateOf('src/views/outsource/components/OutsourceQuotePdfPreview.vue'));
    const busyIdx = tpl.indexOf('v-else-if="busyHint"');
    const emptyIdx = tpl.indexOf('无可预览内容');
    expect(busyIdx, '子组件没有 busyHint 分支').toBeGreaterThan(-1);
    expect(emptyIdx, '子组件里找不到「无可预览内容」').toBeGreaterThan(-1);
    expect(
      busyIdx,
      'busyHint 分支必须排在「无可预览内容」之前，否则转图等待期会显示成「没有可预览内容」',
    ).toBeLessThan(emptyIdx);
  });

  it('OutsourceQuoteList.vue：把转图 / 拉 blob 两档都算进 busyHint 传给子组件', () => {
    const src = srcOf('src/views/outsource/OutsourceQuoteList.vue');
    expect(src, 'caller 没有传 :busy-hint').toContain(':busy-hint=');
    // 两档分别对应「CI 还在转」与「已决定看原始 PDF、blob 在路上」，混成一句会让
    // 用户以为点按钮没用。
    const hint = new RegExp('drawingBusyHint[\\s\\S]*?\\n\\}\\);').exec(src)?.[0] ?? '';
    expect(hint, '找不到 drawingBusyHint 的定义').not.toBe('');
    expect(hint).toContain('图纸转图中');
    expect(hint).toContain('加载原始 PDF');
  });
});

// ============================================================
// 2. blob URL 的释放
// ============================================================
describe('blob URL 只经一个 revoke-then-assign 的入口', () => {
  // AssemblyChildrenTable 有**两个**写入点（点行的非 PDF 图纸、PDF 原始 PDF 的 blob
  // watch），任何一处直接赋值都会把上一个 object URL 悬空。
  it('AssemblyChildrenTable.vue：所有 blob 赋值都在 setBlobUrl 内，且它先 revoke', () => {
    const code = stripComments(srcOf('src/views/assemblies/components/AssemblyChildrenTable.vue'));
    const helper = new RegExp(
      'function setBlobUrl\\([^)]*\\): void \\{([\\s\\S]*?)\\n\\}',
    ).exec(code)?.[1];
    expect(helper, '找不到 setBlobUrl 助手函数').toBeDefined();
    expect(helper, 'setBlobUrl 必须先 revoke 前一个').toContain('URL.revokeObjectURL');
    expect(helper).toContain('drawingPreviewBlobUrl.value = next');

    // 助手之外不得再有裸赋值（revoke 只挂在 onClosed 上，它只救得了「当前那一个」）。
    const outside = code.replace(
      new RegExp('function setBlobUrl\\([^)]*\\): void \\{[\\s\\S]*?\\n\\}'),
      '',
    );
    const bare = [...outside.matchAll(/(\w*BlobUrl\.value\s*=[^;\n]*)/g)];
    for (const m of bare) {
      expect(
        m[0],
        `发现了绕过 setBlobUrl 的裸赋值 ${m[0]}：被覆盖的 object URL 从此没人 revoke`,
      ).toBe(false);
    }
  });

  // 另外四个持有 blob 的承载点：同一个外层函数里，createObjectURL 之前必须有
  // revoke —— 紧挨着上一行、或在 await 之前先 revoke 都算（后者同样能保证
  // 「新 URL 挂上去时旧的已经死了」）。
  for (const [rel, field] of [
    ['src/components/FileListCard.vue', 'previewBlobUrl'],
    ['src/views/dashboard/components/PartPreviewDialog.vue', 'previewBlob'],
    ['src/views/production/components/DrawingPreviewPane.vue', 'selectedPreviewBlob'],
    [
      'src/views/production/scan/components/PartDrawingPreviewDialog.vue',
      'previewBlobUrl',
    ],
  ] as const) {
    it(`${rel}：挂上新的 ${field} 之前必先 revoke 前一个`, () => {
      const lines = stripComments(srcOf(rel)).split('\n');
      const writes = lines
        .map((l, i) => ({ l, i }))
        .filter(({ l }) => new RegExp(`${field}\\.value\\s*=\\s*URL\\.createObjectURL`).test(l));
      expect(writes.length, '找不到 URL.createObjectURL 的赋值点').toBeGreaterThan(0);
      for (const { i } of writes) {
        const block = enclosingBlock(lines, i);
        expect(
          /URL\.revokeObjectURL|revoke\w*Blob\(|setBlobUrl\(/.test(block),
          `${rel} 第 ${i + 1} 行所在的外层函数里没有 revoke：新 URL 挂上去时旧的还活着 ⇒ 泄漏`,
        ).toBe(true);
      }
    });
  }
});

// ============================================================
// 3. 迟到守卫：除了「文件还是同一个」，还得判「宿主是否仍开着」
// ============================================================
describe('迟到 blob 的守卫同时判宿主是否仍开着', () => {
  // 只比文件 id 是不够的：换文件必然改 id，但「同一份文件、只是把弹窗关了」不会 ——
  // 关窗那条路径上 id 没变，而 blob 又确实会迟到，于是它被写进去、再也没人 revoke。
  for (const [rel, field, hostGuard] of [
    ['src/components/FileListCard.vue', 'previewBlobUrl', 'previewVisible.value'],
    ['src/views/dashboard/components/PartPreviewDialog.vue', 'previewBlob', 'props.modelValue'],
    [
      'src/views/production/components/DrawingPreviewPane.vue',
      'selectedPreviewBlob',
      'activeTab.value',
    ],
  ] as const) {
    it(`${rel}：每个 ${field} 写入窗口的迟到守卫都判了 ${hostGuard}`, () => {
      const src = srcOf(rel);
      // 每个「await 拉 blob → 写进 ${field}」的窗口都要判宿主开关。
      // 逐个窗口查而不是查第一个：图片 / 3D 那条路径与 PDF 原始 PDF 那条是两次独立的
      // await，漏掉其中一次同样是一次泄漏。
      const windows = [
        ...src.matchAll(
          new RegExp(
            `await fetchPartFileContent\\([\\s\\S]{0,800}?${field}\\.value = URL\\.createObjectURL`,
            'g',
          ),
        ),
      ].map((m) => m[0]);
      expect(windows.length, '找不到「拉 blob → 写 ref」之间的段').toBeGreaterThan(0);
      for (const w of windows) {
        expect(w, `守卫里没有判宿主开关（${hostGuard}）`).toContain(hostGuard);
        expect(w, '守卫里应当仍在比文件 id').toContain('?.id !==');
      }
    });
  }

  // PartDrawingPreviewDialog 的守卫形态不同：它比对自增 token，而 token 只在
  // loadPreview 里自增 —— 不在关窗时也自增的话，在途 blob 回来照样通过比对。
  it('PartDrawingPreviewDialog.vue：onClosed 也自增 previewToken（让在途 blob 的比对失败）', () => {
    const src = srcOf('src/views/production/scan/components/PartDrawingPreviewDialog.vue');
    const onClosed = new RegExp('function onClosed\\(\\): void \\{([\\s\\S]*?)\\n\\}').exec(
      src,
    )?.[1];
    expect(onClosed, '找不到 onClosed 函数体').toBeDefined();
    expect(
      onClosed,
      'onClosed 里必须自增 previewToken：否则关窗后到达的 blob 会通过比对写进 previewBlobUrl，而它已被 revoke 过',
    ).toContain('previewToken += 1');
  });
});
