// src/three/__tests__/occtWasmAssetPipeline.spec.ts
//
// 2026-10-21 新增：occt-wasm 产物链的两条跨层不变量守卫（vite.config.ts + 本目录的
// OcctStepLoader.ts + package.json + 全仓源码扫描）。
//
// 两条不变量各自对应一个「删掉之后 lint / typecheck / 单测全绿、只有构建产物变差」的问题：
//
//   A. 入口不得静态依赖 occt-wasm chunk。
//      vite 把懒加载路由的预加载 helper 放在虚拟模块 `\0vite/preload-helper.js` 里，
//      它不被任何业务规则命中，于是混进了 occt-wasm 那条 group 的产物：入口静态引用
//      helper ⇒ 静态依赖整块 occt-wasm ⇒ `index.html` 的 modulepreload 多出 110KB
//      （gzip 36KB）的低频 3D 代码。少了 `vite-preload-helper` 那条即复现。
//      （这里只记产物事实，不记 rolldown 内部机制 —— 上游类型文档对「未被任何 group 命中的
//      模块」的表述与「塞进第一个 group」不是同一条。）
//
//   B. wasm 只产出一份，且由代码显式定位。
//      `occt-wasm.js`（emscripten 产物）内含 `new URL("occt-wasm.wasm", import.meta.url)`，
//      vite 扫到就会 emit 一份带 hash 的；public/ 下若另有同一份拷贝，就是产出两份 21MB。
//      本段的判据**全部取代码与配置的内容**：「产物只有一份」的充分条件是「没有任何代码 /
//      配置再往 public/ 产出或定位这份 wasm」。public/ 目录当前有没有留着一份拷贝是**本机
//      环境状态**（旧机器上那份是生成链路留下的，未被重新生成也不会被自动清掉），拿它当判据
//      会让守卫在「用户环境不干净」时报红，而那不是代码的问题。残留是一次性人工清理动作，
//      见 `docs/occt-wasm-asset-pipeline.md`。
//
// ⚠️ 两条都是**构建产物层**的判据，node/happy-dom 环境跑不了真实的 vite build
// （occt-wasm 是 emscripten 主线程 wasm，`__tests__/stepShapeRelease.spec.ts` 的头注释
// 已登记同一条限制）。所以这里守的是「配置与代码不许退回旧形态」，真正的产物核对靠
// `npx vite build` 后人工比对 `index.html` 的 modulepreload 列表与 `find dist -name '*.wasm'`。
// 仓内口径与实测数字见 `docs/occt-wasm-asset-pipeline.md`。

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const VITE_CONFIG = readFileSync(join(ROOT, 'vite.config.ts'), 'utf8');
const LOADER = readFileSync(join(ROOT, 'src/three/OcctStepLoader.ts'), 'utf8');
const GITIGNORE = readFileSync(join(ROOT, '.gitignore'), 'utf8');
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
};

/**
 * 剥掉整行注释（默认 `//`，传 `markers` 可换成 `<!--` 之类）。
 *
 * 必须剥：本仓的注释里正当地引用了 `manualChunks`、旧路径、`wasmUrl` 这几个**被断言禁止**
 * 的字符串（如 vite.config.ts 的 assetsInclude 注释里写着 `.wasm` import 的两种语义、
 * OcctStepLoader.ts 里写着「`wasmUrl` 已标 deprecated」），不剥的话每条负向断言都会被
 * 自己的注释打红。
 * 只处理「整行只有注释」的情况 —— 被检查的几段里代码行不带尾随注释。
 */
function stripFullLineComments(src: string, markers: readonly string[] = ['//']): string {
  return src
    .split('\n')
    .filter((line) => !markers.some((m) => line.trim().startsWith(m)))
    .join('\n');
}

/** 递归收集目录下全部文件（不区分扩展名，交给调用方按扩展名分流）。 */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(abs));
    else if (entry.isFile()) out.push(abs);
  }
  return out;
}

/**
 * 找出**落在字符串 / 模板字面量里**的「public 根路径 occt-wasm 引用」，逐条返回 `标签: 命中原文`。
 *
 * 用 TS 词法扫描器而不是正则扫全文：本仓的注释里正当地引用着 `occt-wasm.wasm` 这个文件名
 * （loader 的成因注释、`.gitignore` 的说明、docs 的口径），正则会把它们一并算成命中 ⇒ 守卫必然
 * 假红，久而久之必然被人加白名单放宽成恒绿。扫描器把注释当 trivia 跳过、只交出字符串字面量，
 * 「注释里提到」与「代码里定位」因此天然分开。
 */
function publicWasmRefsIn(src: string, label: string): string[] {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, src);
  const hits: string[] = [];
  // 只有这三种 token 带起始引号 / 反引号；TemplateMiddle / TemplateTail 是插值续段，
  // 文本首字符就是路径本身，剥引号会把斜杠吃掉。
  const hasLeadingQuote = (kind: ts.SyntaxKind): boolean =>
    kind === ts.SyntaxKind.StringLiteral ||
    kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral ||
    kind === ts.SyntaxKind.TemplateHead;
  // 插值内的括号深度：独立词法器不认识 `${}`，只能靠「当前在模板里」这个计数才认得出闭合的
  // `}`（同 typescript 解析器的 `CloseBraceToken → reScanTemplateToken` 处置）。两个计数缺一不可：
  // 深度 `templateDepth` 管嵌套模板（`${ `a${x}b` }` 里内层的收尾只让外层深度减 1）；
  // 括号 `braceDepth` 管插值里带对象字面量的表达式（`${ ({a: 1}).a }` 的那个 `}` 是对象闭合、
  // 不是插值闭合，误当插值收尾会让扫描器错位、后面的落点漏检）。
  let templateDepth = 0;
  let braceDepth = 0;
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken;) {
    if (templateDepth > 0) {
      if (kind === ts.SyntaxKind.OpenBraceToken) braceDepth += 1;
      else if (kind === ts.SyntaxKind.CloseBraceToken) {
        if (braceDepth > 0) braceDepth -= 1;
        else kind = scanner.reScanTemplateToken(false);
      }
    }
    if (kind === ts.SyntaxKind.TemplateHead) {
      templateDepth += 1;
      braceDepth = 0;
    } else if (kind === ts.SyntaxKind.TemplateTail) {
      templateDepth -= 1;
      braceDepth = 0;
    }
    if (
      !hasLeadingQuote(kind) &&
      kind !== ts.SyntaxKind.TemplateMiddle &&
      kind !== ts.SyntaxKind.TemplateTail
    ) {
      kind = scanner.scan();
      continue;
    }
    const raw = scanner.getTokenText();
    // 摘掉唯一的合法形态 `occt-wasm/dist/…` 这个包内子路径前缀 —— 它是 `?url` import 的
    // specifier，不指向 public/ 下的那份拷贝，留着会自己打自己。
    const body = (hasLeadingQuote(kind) ? raw.slice(1) : raw).replace(/^occt-wasm\/dist\//, '');
    // 三种形态都指向 public/ 下那份拷贝：`/occt-wasm.wasm`（根路径）、`public/occt-wasm.wasm`
    // （拼目录）、`${origin}/occt-wasm.wasm`（origin 前缀的根路径）。
    if (/^\/occt-wasm\b/.test(body) || /\/occt-wasm\.(?:wasm|js)\b/.test(body)) {
      hits.push(`${label}: ${raw}`);
    }
    kind = scanner.scan();
  }
  return hits;
}

/** 取 `.vue` 的各段 `<script>` 源码；没有 script 段时返回空数组。 */
function scriptBlocksOfVue(src: string): string[] {
  return [...src.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? '');
}

/**
 * 全仓扫一遍「把 wasm 定位到 public 根路径」的落点：产品源码 + 构建配置 + 入口 HTML + 构建脚本。
 *
 * 范围只收**会进产物 / 参与产物生成**的文件：`__tests__` 下的 spec 与 fixture 刻意带着被禁的
 * 字面量（它们正是那些负向断言的素材），且不进产物，扫进去只会让新加的同类 spec 无故变红。
 */
function publicWasmRefSites(): string[] {
  const hits: string[] = [];
  const scriptsDir = join(ROOT, 'scripts');
  const files = [
    ...filesUnder(join(ROOT, 'src')),
    ...(existsSync(scriptsDir) ? filesUnder(scriptsDir) : []),
    join(ROOT, 'vite.config.ts'),
  ];
  for (const abs of files) {
    const rel = relative(ROOT, abs);
    if (rel.split('/').includes('__tests__')) continue;
    // 先分流扩展名再读盘：src 下混着 .xlsx 之类二进制，按 utf-8 读进来既没用又白花时间。
    if (/\.(?:ts|tsx|js|mjs|cjs)$/.test(abs)) {
      hits.push(...publicWasmRefsIn(readFileSync(abs, 'utf8'), rel));
    } else if (rel.endsWith('.vue')) {
      hits.push(
        ...scriptBlocksOfVue(readFileSync(abs, 'utf8')).flatMap((block, i) =>
          publicWasmRefsIn(block, `${rel}#script[${i}]`),
        ),
      );
    } else if (rel.startsWith('scripts/')) {
      // 构建脚本里的非 JS 文件（shell 等）没有词法可借，剥掉整行注释后按纯文本查。
      const body = stripFullLineComments(readFileSync(abs, 'utf8'), ['#']);
      if (/occt-wasm/.test(body)) hits.push(`${rel}: 出现了 occt-wasm 字面量`);
    }
  }
  // index.html 不是 JS：它能加的只有 <link rel=preload>，而 preload 的 URL 拿不到构建期的
  // 内容 hash，指向 occt-wasm 的任何写法都是错的。剥掉 HTML 注释后整份查。
  const html = stripFullLineComments(readFileSync(join(ROOT, 'index.html'), 'utf8'), ['<!--']);
  if (/occt-wasm/.test(html)) hits.push('index.html: 出现了 occt-wasm 字面量');
  return hits;
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

/**
 * 把 `groups` 数组按**花括号配平**切成一个个 group 对象字面量，逐个返回 `{ name, text }`
 * （已剥整行注释）。
 *
 * 为什么必须切而不是拿整段正则：整段正则的 `[\s\S]*?` 没有上界，`priority` 这类字段只要
 * 出现在任一 group 里就会让它后面那几条断言跟着一起绿 —— 把 helper 那条的 `priority` 删掉
 * 却抓到后面 occt-wasm 那条的 `priority`，仍是全绿，守卫等于恒绿。切成对象后每条断言只看
 * 自己那一条 group 的切片。名字按正则捕获组**精确**比对，不做子串匹配（否则
 * `occt-wasm-late` 这类名字会与 `occt-wasm` 混）。
 */
function groupSlices(): Array<{ name: string; text: string }> {
  const groups = groupsBlock();
  const out: Array<{ name: string; text: string }> = [];
  const re = /\{\s*name: '([^']+)'/g;
  for (let m = re.exec(groups); m !== null; m = re.exec(groups)) {
    let depth = 0;
    let end = -1;
    for (let i = m.index; i < groups.length; i += 1) {
      const ch = groups[i];
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end < 0) break;
    out.push({ name: m[1], text: groups.slice(m.index, end + 1) });
  }
  return out;
}

/** 取名字精确等于 `name` 的那一条 group 的源码文本；切不出返回 null（由调用方断言）。 */
function groupSlice(name: string): string | null {
  return groupSlices().find((g) => g.name === name)?.text ?? null;
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

  it('三条 group 都带 test（留空 = 任何模块都算命中）', () => {
    const objs = groupSlices();
    expect(
      objs.length,
      'groups 里切出的 group 数不是 3 —— 新增/删除 group 时请同步复核本 spec',
    ).toBe(3);
    for (const name of ['occt-wasm', 'three', 'vite-preload-helper']) {
      const slice = groupSlice(name);
      expect(slice, `groups 里找不到 name: '${name}' 那一条`).not.toBeNull();
      expect(slice, `name: '${name}' 那条 group 没有 test`).toMatch(/\btest\s*:/);
    }
  });

  it('预加载 helper 单独成组，且带显式 priority（同优先级只按声明顺序决胜，会失效）', () => {
    const slice = groupSlice('vite-preload-helper');
    expect(slice, "groups 里找不到 name: 'vite-preload-helper' 那一条").not.toBeNull();
    expect(slice).toContain("id.includes('vite/preload-helper')");
    // priority 是承重项：去掉它后 helper 会被声明在前的 occt-wasm 那条抢走，occt-wasm chunk
    // 重新进首屏 modulepreload。只在本 group 的切片里找 —— 整段正则会抓到别处的 priority。
    const m = /\bpriority:\s*(-?\d+)/.exec(slice ?? '');
    expect(m, 'helper 那条 group 上没有 priority —— 声明顺序一变就会静默失效').not.toBeNull();
    expect(Number(m?.[1])).toBeGreaterThan(0);
  });
});

describe('B. wasm 只产出一份，且由代码显式定位', () => {
  it('OcctStepLoader 用 ?url import 拿带 hash 的 wasm URL', () => {
    expect(LOADER).toContain("import occtWasmUrl from 'occt-wasm/dist/occt-wasm.wasm?url'");
    // `wasm` 是 occt-wasm 的正式选项名，`wasmUrl` / `wasmPath` 已标 deprecated。
    expect(LOADER).toContain('OcctKernel.init({ wasm: occtWasmUrl })');
  });

  it('不再有写死的根路径 wasm URL（那条要求 public/ 里有一份无 hash 拷贝）', () => {
    const code = stripFullLineComments(LOADER);
    expect(code).not.toContain('/occt-wasm.wasm`');
    expect(code).not.toContain('wasmUrl:');
    expect(code).not.toContain('window.location.origin');
  });

  it('occt-wasm 依赖声明不得低于 5.4.0（lockfile 实装版本；低于它的解析结果未验证）', () => {
    const range = PKG.dependencies['occt-wasm'];
    expect(range, 'package.json 的 dependencies 里没有 occt-wasm').toBeTruthy();
    const m = /^\^?(\d+)\.(\d+)\.(\d+)/.exec(range ?? '');
    expect(m, `occt-wasm 的版本声明不是可解析的 semver：${range}`).not.toBeNull();
    const [major, minor, patch] = [Number(m?.[1]), Number(m?.[2]), Number(m?.[3])];
    const declared = major * 1_000_000 + minor * 1_000 + patch;
    expect(
      declared,
      `occt-wasm 声明为 ${range}，低于 5.4.0 —— 该解析结果本仓未构建/未验证`,
    ).toBeGreaterThanOrEqual(5 * 1_000_000 + 4 * 1_000);
  });

  it('public/ 拷贝链路已整条下线：没有任何脚本提到 occt-wasm，拷贝脚本也不存在', () => {
    expect(PKG.scripts.postinstall).toBeUndefined();
    // 判据取「脚本正文里不得出现 occt-wasm」而不是只看 postinstall 这一个键：钩子名可以换
    // （prepare / preinstall 同样在 npm ci 时自动跑），换名就能绕过只看一个键的写法。
    const hooked = Object.entries(PKG.scripts)
      .filter(([, body]) => /occt-wasm/.test(body))
      .map(([name]) => name);
    expect(hooked, 'package.json 里仍有脚本提到 occt-wasm —— 拷贝链路可能被换名复活').toEqual([]);
    expect(existsSync(join(ROOT, 'scripts/copy-occt-wasm.mjs'))).toBe(false);
  });

  it('产品源码 / 构建配置 / 入口 HTML / 构建脚本里没有第二处 public 根路径定位', () => {
    // 判据是「没有第二条来源」，不是「public/ 目录当前是空的」—— 后者是本机环境状态
    // （旧机器上留着的拷贝既不会被重新生成、也不会自动清掉），会在环境不干净时报红。
    const sites = publicWasmRefSites();
    expect(
      sites,
      `以下落点把 wasm 定位到了 public/ 根路径（产物会多出一份 21MB）：\n${sites.join('\n')}`,
    ).toEqual([]);
  });

  it('public/ 下的旧拷贝仍被 ignore 挡着（残留不入库 ⇒ 产物形态只由代码决定）', () => {
    expect(GITIGNORE).toContain('/public/occt-wasm.wasm');
    expect(GITIGNORE).toContain('/public/occt-wasm.js');
  });

  it('vite.config 里不再有「从 public 根路径 fetch wasm」的旧注释', () => {
    expect(stripFullLineComments(VITE_CONFIG)).not.toContain('${origin}/occt-wasm.wasm');
  });
});
