// src/composables/__tests__/keepAliveContract.spec.ts
//
// 2026-10-22 新增：keep-alive 「后台不该做的事」三类漂移守卫。
//
// 背景（根因一句话）：`MainLayout.vue` 的 `<keep-alive :include="tags.cachedViewNames">`
// 让切标签页走 deactivate 而不是 unmount ⇒ **组件实例、它的 watcher、它的
// `document` 级监听、它的 useQuery observer 全都还在跑**，只有 `onDeactivated` 会来。
// 于是下面三类东西在「用户看着别的标签页」时仍在活动，**且全部零报错零日志**：
//
//   1. **自动刷新轮询**（`refetchInterval` + `refetchIntervalInBackground: true`）——
//      `refetchIntervalInBackground` 管的是**浏览器窗口**失焦，与 Vue 的 keep-alive
//      毫无关系 ⇒ 后台标签页照样每 5 分钟打一次请求，而 autoRefresh 还持久化到
//      localStorage，勾过一次就一直轮询。
//   2. **`document` 级 keydown**（行内编辑的 Enter 存盘 / Esc 取消）—— 编辑到一半切走，
//      `editingId` 仍非空、监听仍在，在别的标签页敲 Enter 会把那一行存了。
//   3. **blob URL 的卸载兜底** —— 与 keep-alive 无关的独立一类，一并登记。
//
// 三类都是「行为测试全绿 ⇒ 证明不了没漂移」：改前 `useInspectionQueueQuery` 的 spec 全绿、
// `usePartInlineEdit.spec.ts` 全绿、`PreviewCarriers.spec.ts` 全绿，而这三条缺陷同时
// 存在。**照着现成代码抄一份新页面**（本仓新增列表页的默认动作就是复制一个 query
// hook）就会重新引入 ⇒ 只能扫源码，与 `echartsContract.spec.ts` /
// `iframePrintContract.spec.ts` 同一形态。
//
// 扫的是**剥掉注释后**的代码：本仓注释为了说明问题会原样引用被禁的写法
// （三个 query hook 的文件头都写着 `refetchIntervalInBackground: true`），不剥就假红。

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SRC = join(ROOT, 'src');

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

/** 找出所有剥完注释后仍含 `needle` 的源文件（相对 ROOT 的 posix 路径）。 */
function filesMatching(needle: RegExp): string[] {
  return sourceFiles()
    .map((abs) => relative(ROOT, abs).split('\\').join('/'))
    .filter((rel) => needle.test(stripComments(srcOf(rel))));
}

describe('keep-alive 契约 1：后台标签页不得继续轮询', () => {
  it('每个 refetchIntervalInBackground: true 的 query hook 都折进了 isActive 闸', () => {
    const sites = filesMatching(/refetchIntervalInBackground:\s*true/);
    // 清单是人工判定的：新增一个自动刷新的列表页就会多一个，漏在这里等于这条守卫
    // 从此对那个页面失效。四条分别是待编程 / 待品检 / 账号 / 送货单。
    expect(sites.length, '自动刷新站点数变了，新增页面请一并加进这张表').toBeGreaterThan(0);
    for (const rel of sites) {
      const code = stripComments(srcOf(rel));
      expect(code, `${rel} 没有 import useIsActive`).toMatch(
        /import \{ useIsActive \} from '@\/composables\/useIsActive'/,
      );
      // 闸必须落在 refetchInterval **本身**的 computed 里，而不是让调用方自己判 ——
      // 只有 computed 形态才会让两个开关都进依赖收集（裸函数体的开关不进，见各文件
      // 文件头「设计要点」里关于 `unrefGetters` 的那段）。
      expect(
        code,
        `${rel} 的 refetchInterval 没有折进 isActive ⇒ 缓存页切到后台仍每 5 分钟打一次请求`,
      ).toMatch(/refetchInterval:\s*computed\(\(\)\s*=>[\s\S]{0,160}isActive\.value/);
    }
  });

  it('全仓只有三处可执行 onActivated / onDeactivated（新增活跃判据请先看这张表）', () => {
    const sites = filesMatching(/\bon(Activated|Deactivated)\s*\(/);
    expect(sites.sort()).toEqual(
      [
        // 「是不是活跃」判据的两枚：共享 composable 与纯 utils 打印宿主（后者不能引
        // composables，因为它在 utils/ 下、判据要独立自持）。
        'src/composables/useIsActive.ts',
        'src/utils/iframePrint.ts',
        // ⚠️ **不是**活跃判据：`usePartDetail` 的 onActivated 是「keep-alive 缓存页
        // 每次回来补一次 refetch」，方向相反（回来即刷新，不是离开即停）。它自己的
        // 注释也写明「不要挂 onDeactivated」。同一文件的其余 onActivated/onDeactivated
        // 命中项全在注释里，已被 stripComments 剥掉。
        'src/views/parts/detail/composables/usePartDetail.ts',
      ].sort(),
    );
  });
});

describe('keep-alive 契约 2：document 级 keydown 必须有活跃守卫', () => {
  // 表是人工判定的：`[listener 站点, handler 定义处]`。handler 与 addEventListener
  // 不在同一文件是常态（外协那一对就是），所以守的是**这两个位置都要在表里**——
  // 新增一个 document 级 keydown 站点却不加进这张表，下面那条计数断言当场红。
  const KEYDOWN_SITES: [string, string][] = [
    [
      'src/views/parts/list/composables/usePartInlineEdit.ts',
      'src/views/parts/list/composables/usePartInlineEdit.ts',
    ],
    [
      'src/views/outsource/OutsourceCompanySentParts.vue',
      'src/views/outsource/composables/useOutsourceSentPartsPage.ts',
    ],
  ];

  it('新增的 document keydown 监听站点已登记进守卫表', () => {
    const sites = filesMatching(/document\.addEventListener\(\s*'keydown'/);
    expect(
      sites.sort(),
      '有未登记的 keydown 监听站点：加进 KEYDOWN_SITES 并给 handler 加闸',
    ).toEqual(KEYDOWN_SITES.map(([listener]) => listener).sort());
  });

  for (const [listener, handler] of KEYDOWN_SITES) {
    it(`${handler} 的 keydown handler 判了 isActive（监听点 ${listener}）`, () => {
      const code = stripComments(srcOf(handler));
      expect(code, `${handler} 没有 import useIsActive`).toMatch(
        /import \{ useIsActive \} from '@\/composables\/useIsActive'/,
      );
      expect(
        code,
        `${handler} 的 keydown handler 没有判 isActive ⇒ 用户在别的标签页敲 Enter 会存掉一行`,
      ).toMatch(/if \(!isActive\.value\) return;/);
    });
  }
});

describe('keep-alive 契约 3：blob URL 必须有卸载兜底', () => {
  // 清单照 `PreviewCarriers.spec.ts` 的承载点表；那里守的是「挂新 URL 前先 revoke 前
  // 一个」，这里守的是**最后那一个**：用户不走 `@closed`、直接关掉宿主页签时没人 revoke
  // ⇒ object URL 悬空，那份 PDF / 图纸的字节留在内存里（关掉整页也救不了它）。
  //
  // ⚠️ 这一族**与 keep-alive 无关**（页面被缓存时 `onBeforeUnmount` 根本不触发，那时
  // 弹窗还开着、URL 仍被组件持有 ⇒ 不是泄漏），登记在这里只是因为它与前两条同属
  // 「只在 onBeforeUnmount 收尾的东西」这一类。
  const CARRIERS: [string, string][] = [
    ['src/components/FileListCard.vue', 'previewBlobUrl'],
    ['src/views/assemblies/components/AssemblyChildrenTable.vue', 'drawingPreviewBlobUrl'],
    ['src/views/dashboard/components/PartPreviewDialog.vue', 'previewBlob'],
    ['src/views/production/components/DrawingPreviewPane.vue', 'selectedPreviewBlob'],
    ['src/views/production/scan/components/PartDrawingPreviewDialog.vue', 'previewBlobUrl'],
    ['src/views/outsource/OutsourceQuoteList.vue', 'drawingPreviewBlobUrl'],
  ];

  for (const [rel, field] of CARRIERS) {
    it(`${rel}：onBeforeUnmount 里释放了 ${field}`, () => {
      const code = stripComments(srcOf(rel));
      // 取 onBeforeUnmount 的函数体（`(...) => {` 或 `onBeforeUnmount(fn)` 两种形态都收）。
      const bodies = [
        ...code.matchAll(/onBeforeUnmount\(\s*\(?\)?\s*=>\s*\{([\s\S]*?)\n\s*\}\);/g),
        ...code.matchAll(/onBeforeUnmount\(\s*\w+\s*\);/g),
      ].map((m) => m[0]);
      expect(bodies.length, `${rel} 没有 onBeforeUnmount`).toBeGreaterThan(0);
      const joined = bodies.join('\n');
      expect(
        /URL\.revokeObjectURL|setBlobUrl\(\s*''\s*\)|releaseBlobUrl|revoke\w*Blob\(/.test(joined),
        `${rel} 的 onBeforeUnmount 没有释放 ${field}：不走 @closed 直接关标签页就漏一份`,
      ).toBe(true);
    });
  }
});
