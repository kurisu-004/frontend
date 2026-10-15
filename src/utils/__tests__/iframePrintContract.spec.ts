// src/utils/__tests__/iframePrintContract.spec.ts —— 「隐藏 iframe 打印」全仓唯一实现守卫。
//
// 2026-10-22 新增。行为守卫在同目录的 `iframePrint.spec.ts`，本份守的是另一件事：
// **`utils/iframePrint.ts` 之外不得再出现第二份实现**。
//
// 为什么需要它：`iframe.onload = () => { ...; contentWindow.print() }` 这个写法本身
// 完全合法、typecheck 与 lint 都过，而它在 keep-alive 页面上会**静默**多打印一次
// （根因见 iframePrint.ts 文件头）。它最早的落点就是 `components/FileListCard.vue`，
// 零件一览的批量打印照着抄了一份，两份都漏了同一件事。
//
// ⚠️ 所以「行为测试全绿」**证明不了**「全仓没有第三份」：helper 的 spec 测的是 helper，
// 别人新写一份 `iframe.onload` 在别的域里，那份 spec 一条都不会红。跨文件的「写法一致性」
// 挂一次组件看不出来，只能扫源码 —— 与 `echartsContract.spec.ts`（扫整个 `src/`、
// 保证 `echarts.use()` 只落在注册点）、`PdfPreviewDialogContract.spec.ts`（el-dialog
// class 白名单）同一形态。
//
// 扫的是**剥掉注释后**的代码：本仓的注释为了说明问题会**原样引用**被禁的写法
// （`iframePrint.ts` 与两个消费方的文件头都写着它们），不剥的话一条正确的注释就假红。

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SRC = join(ROOT, 'src');
/** 本文件要守的那个实现自己豁免（它必然含有这些写法）。 */
const IMPL = 'src/utils/iframePrint.ts';

function srcOf(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8');
}

/** 剥掉 `<!-- -->`、`/* *\/` 与整行注释，只留代码。 */
function stripComments(src: string): string {
  const blank = (m: string): string => m.replace(/[^\n]/g, ' ');
  return src
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .split('\n')
    .map((l) => (/^\s*(\/\/|\*)/.test(l) ? l.replace(/[^\n]/g, ' ') : l))
    .join('\n');
}

/** 递归列 `src/` 下的 .vue / .ts（跳过 `__tests__` 与 `__fixtures__`）。 */
function sourceFiles(dir: string = SRC): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) {
      if (name === '__tests__' || name === '__fixtures__') continue;
      out.push(...sourceFiles(abs));
      continue;
    }
    if (['.ts', '.vue'].includes(extname(name))) out.push(abs);
  }
  return out;
}

describe('隐藏 iframe 打印：全仓只有 utils/iframePrint.ts 一份实现', () => {
  // 命中即红。三条各对应改前两份实现的**逐字同款**写法。
  const FORBIDDEN: [RegExp, string][] = [
    [/\.onload\s*=/, '裸 iframe.onload 赋值（必须经 useIframePrint：一次性 + deactivate 拆解）'],
    [
      /contentWindow\?\s*\.print\(\)|contentWindow\.print\(\)/,
      '直接调 contentWindow.print()（必须经 useIframePrint）',
    ],
    [/window\.open\(\s*blobUrl/, 'window.open(blobUrl) 打印兜底（helper 内已有，不要再抄一份）'],
  ];

  for (const [pattern, why] of FORBIDDEN) {
    it(`实现之外没有 ${pattern.source}：${why}`, () => {
      const hits = sourceFiles()
        .map((abs) => ({
          rel: relative(ROOT, abs).split('\\').join('/'),
          code: stripComments(readFileSync(abs, 'utf8')),
        }))
        .filter(({ rel }) => rel !== IMPL)
        .filter(({ code }) => pattern.test(code))
        .map(({ rel }) => rel);
      expect(hits, `这些文件里有 ${pattern.source}：打印只能走 utils/iframePrint.ts`).toEqual([]);
    });
  }

  it('两个已知消费方都改成了 useIframePrint', () => {
    for (const rel of [
      'src/views/parts/list/composables/useBatchPrint.ts',
      'src/components/FileListCard.vue',
    ]) {
      const code = stripComments(srcOf(rel));
      expect(code, `${rel} 没有 import useIframePrint`).toMatch(
        /import \{ useIframePrint \} from '@\/utils\/iframePrint'/,
      );
      expect(code, `${rel} 没有调用 useIframePrint`).toMatch(/useIframePrint\(/);
      expect(code, `${rel} 没有把结果交给 printBlob`).toMatch(
        /const \{ printBlob \} = useIframePrint\(/,
      );
    }
  });

  it('消费方不再自己管 blob URL 生命周期（helper 独占 createObjectURL / revokeObjectURL）', () => {
    // helper 之外还有别的 blob URL 用途（预览 / 下载），所以只查**打印**这条路径上的
    // 变量名：改前分别是 `blobUrl` 与 `printBlobUrl`，现在都该消失。
    expect(stripComments(srcOf('src/views/parts/list/composables/useBatchPrint.ts'))).not.toMatch(
      /URL\.(create|revoke)ObjectURL/,
    );
    // FileListCard 还有 previewBlobUrl 的预览用途（PreviewCarriers.spec.ts 在守），
    // 只查 printBlobUrl 这一个。
    expect(stripComments(srcOf('src/components/FileListCard.vue'))).not.toMatch(/printBlobUrl/);
  });
});
