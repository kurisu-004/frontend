// src/three/__tests__/occtWasmAssetPipeline.spec.ts
//
// 2026-10-21 新增：occt-wasm 产物链的两条跨层不变量守卫（vite.config.ts + 本目录的
// OcctStepLoader.ts + package.json + public/）。
//
// 两条不变量各自对应一个「删掉之后 lint / typecheck / 单测全绿、只有构建产物变差」的问题：
//
//   A. 入口不得静态依赖 occt-wasm chunk。
//      vite 把懒加载路由的预加载 helper 放在虚拟模块 `\0vite/preload-helper.js` 里，
//      它不被任何业务规则命中；rolldown 会把没被命中的模块塞进它创建的第一个 group。
//      少了 `vite-preload-helper` 那条，入口为了静态引用这个 helper 而静态依赖整块
//      occt-wasm ⇒ `index.html` 的 modulepreload 多出 110KB（gzip 36KB）的低频 3D 代码。
//
// ⚠️ 这是**构建产物层**的判据，node/happy-dom 环境跑不了真实的 vite build
// （occt-wasm 是 emscripten 主线程 wasm，见 `components/cad-viewer/__tests__/StepViewer.spec.ts`
// 的既有登记）。所以这里守的是「配置与代码不许退回旧形态」，真正的产物核对靠
// `npx vite build` 后人工比对 `index.html` 的 modulepreload 列表与 `find dist -name '*.wasm'`。
// 仓内口径与实测数字见 `docs/occt-wasm-asset-pipeline.md`。

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const VITE_CONFIG = readFileSync(join(ROOT, 'vite.config.ts'), 'utf8');
/**
 * 剥掉整行 `//` 注释。
 *
 * 必须剥：本仓的注释里正当地引用了 `manualChunks`、正则字面量、旧路径这些**被断言禁止**
 * 的字符串（如 vite.config.ts 里「不要顺手简化成正则」那段就写着 `test: /…/`），
 * 不剥的话每条负向断言都会被自己的注释打红。
 * 只处理「整行只有注释」的情况 —— 被检查的几段里代码行不带尾随注释。
 */
function stripFullLineComments(src: string): string {
  return src
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

/**
 * 取出 `output.codeSplitting` 那个对象块的源码文本（已剥整行注释）。
 *
 * 取不到就当场抛 —— 断言对象若是空串，`not.toMatch('')` / `toContain('')` 这类会恒真，
 * 整条守卫静默空转（仓内约定见 views/statistics 的 chartContract.spec.ts 头注释）。
 */
function codeSplittingBlock(): string {
  const start = VITE_CONFIG.indexOf('codeSplitting: {');
  expect(
    start,
    'vite.config.ts 里找不到 output.codeSplitting —— 配置被改回 manualChunks 了？',
  ).toBeGreaterThan(-1);
  const end = VITE_CONFIG.indexOf('\n          },', start);
  expect(end, 'codeSplitting 块没有正常闭合').toBeGreaterThan(start);
  return stripFullLineComments(VITE_CONFIG.slice(start, end));
}

/** 取出 `codeSplitting.groups` 数组的源码文本（已剥整行注释）。取不到当场抛（同上）。 */
function groupsBlock(): string {
  const block = codeSplittingBlock();
  const start = block.indexOf('groups: [');
  expect(start, 'codeSplitting 里找不到 groups 数组').toBeGreaterThan(-1);
  const end = block.indexOf('\n            ],', start);
  expect(end, 'groups 数组没有正常闭合').toBeGreaterThan(start);
  return block.slice(start, end);
}

describe('A. 入口不得静态依赖 occt-wasm chunk', () => {
  it('用 rolldown 的 codeSplitting（而非已废弃的 manualChunks）表达分块', () => {
    expect(codeSplittingBlock()).toContain('codeSplitting');
    expect(stripFullLineComments(VITE_CONFIG)).not.toMatch(/^\s*manualChunks:/m);
  });

  it('occt-wasm 与 three 仍各自是独立 group（3D 预览不被并进业务 bundle）', () => {
    const groups = groupsBlock();
    expect(groups).toContain("name: 'occt-wasm'");
    expect(groups).toContain("name: 'three'");
    // 两条 group 的捕获范围必须覆盖包目录，否则 occt-wasm chunk 会退化成只剩胶水层。
    expect(groups).toContain("id.includes('node_modules/occt-wasm/')");
    expect(groups).toContain("id.includes('node_modules/three/')");
  });

  it('预加载 helper 单独成组，且带显式 priority（同优先级只按声明顺序决胜，会失效）', () => {
    const groups = groupsBlock();
    expect(groups).toContain("name: 'vite-preload-helper'");
    expect(groups).toContain("id.includes('vite/preload-helper')");
    // priority 是承重项：实测 priority: 0 且该组声明在 occt-wasm 之后时整条失效。
    const m = /name: 'vite-preload-helper'[\s\S]*?priority: (-?\d+)/.exec(groups);
    expect(m, 'helper 那条 group 上没有 priority —— 声明顺序一变就会静默失效').not.toBeNull();
    expect(Number(m?.[1])).toBeGreaterThan(0);
  });

  it('三条 group 的 test 都是函数（正则写法实测一条都匹配不到）', () => {
    const groups = groupsBlock();
    expect(groups).not.toMatch(/test:\s*\//);
    expect(groups.match(/test:\s*\(id:\s*string\)\s*=>/g)).toHaveLength(3);
  });
});
