// 2026-10-03 修缺陷新增：构建期把 pdfjs-dist 的 cMap 以「原名、无 hash」产出到 dist/cmaps/。
//
// 为什么不能靠 import.meta.glob('...cmaps/*.bcmap', { query: '?url' })（本文件之前
// 就在 src/utils/pdfjs.ts 里这么干）：两个失效点都只在 build 后才爆发，dev 完全看不出来。
//   ① `?url` 导入同样过 Vite 的 shouldInline() 判定，即受 build.assetsInlineLimit
//      （默认 4096 字节）约束，低于阈值的资源被内联成 base64 data URI 而不是落文件。
//      pdfjs-dist/cmaps/ 里 168 个 .bcmap 有 134 个小于 4096 ⇒ 绝大部分根本没产出文件。
//   ② 侥幸落文件的那批，Vite 会按内容加 hash（Adobe-GB1-UCS2-<hash>.bcmap），而 pdfjs
//      不查 manifest —— worker 的 fetchBuiltInCMap 把 `<name>.bcmap` 发回主线程，
//      主线程 BaseBinaryDataFactory 按 `cMapUrl + filename` 直接 fetch 原名 URL，必然 404。
// 所以这里绕开资源图，buildStart 里逐个 emitFile 并写死 fileName 为 `cmaps/<原名>`。
//
// 注意别用「把 assetsInlineLimit 全局调 0」来绕过 ①：那是全局开关，会改掉所有其它
// 小资源的产出方式，副作用面远大于本问题。
//
// dev 不走这里（apply: 'build'）：dev 由 Vite dev server 直接服务
// /node_modules/pdfjs-dist/cmaps/ 下的原名文件，src/utils/pdfjs.ts 按 DEV 分流到该路径。
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { Plugin } from 'vite';

// 用 createRequire 从本文件位置反查，而不是 process.cwd()：vite.config.ts 的 cwd 未必是
// 包根（monorepo / 子目录调用 / 测试进程内），写死路径也会随包管理器（pnpm 的
// 符号链接布局）漂移。
const requireFromHere = createRequire(import.meta.url);

/** 定位 node_modules 里 pdfjs-dist 的 cmaps/ 目录。 */
export function resolveCMapDir(): string {
  return join(dirname(requireFromHere.resolve('pdfjs-dist/package.json')), 'cmaps');
}

/** 列出全部 cMap 文件名（只取 .bcmap，字典序稳定）。 */
export function listCMapFiles(): string[] {
  const dir = resolveCMapDir();
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith('.bcmap'))
      .sort();
  } catch (e) {
    throw new Error(
      `[pdfjs-cmaps] 读取 pdfjs-dist cmaps 目录失败: ${dir}（${(e as Error).message}）。` +
        '请确认已 npm install，pdfjs-dist 6.x 自带 cmaps/ 目录。',
    );
  }
}

/**
 * Vite 插件：把 168 个 .bcmap 以原名产出到 dist/cmaps/。
 * dist 布局与 src/utils/pdfjs.ts 的 PDF_CMAP_URL 常量、nginx 的 `location ^~ /cmaps/`
 * 三者必须同步改：pdfjs 自行按 `cMapUrl + <name>.bcmap` 拼 URL，不查任何 manifest。
 */
export function pdfjsCmapsPlugin(): Plugin {
  const cMapDir = resolveCMapDir();
  return {
    name: 'pdfjs-cmaps',
    // dev 走 Vite dev server 直接服务 node_modules 原名文件，不需要重跑 emitFile。
    apply: 'build',
    buildStart() {
      for (const name of listCMapFiles()) {
        this.emitFile({
          type: 'asset',
          fileName: `cmaps/${name}`,
          source: readFileSync(join(cMapDir, name)),
        });
      }
    },
  };
}
