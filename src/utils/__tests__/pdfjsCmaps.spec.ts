// 2026-10-03 修缺陷新增的回归锁：cMap 必须以「原名、无 hash」产出。
//
// 缺陷本身只在生产构建出现（dev 下 Vite dev server 直接服务 node_modules 原名文件），
// 表现是矢量线条照常画、整份 PDF 的文字整体消失且界面不报错 —— pdfjs 对 cMap 加载
// 失败只 warn（loadFont → ErrorFont 兜底）。纯前端单测跑不到 build，所以这里锁的是
// 三条与 build 产物直接相关的不变量：
//   ① 插件逐个 emitFile 出的 fileName 与源文件名集合相等（无 hash、不改名、不丢文件）；
//   ② cMapBaseUrl 的 dev / build 两条分支都指向可请求的原名路径（见下方说明为什么必须
//      走纯函数而不是断言 PDF_CMAP_URL）；
//   ③ src/utils/pdfjs.ts 的源码里不得再出现 import.meta.glob（与 ② 互补：② 锁住取 base
//      的分支，③ 拦住「整段换回资源图 + glob 收集」的重构）。
// 另有两条源码级断言锁 nginx：两份 conf 都必须显式声明 /cmaps/。
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { listCMapFiles, pdfjsCmapsPlugin, resolveCMapDir } from '../../../scripts/pdfjsCmapsPlugin';
import { cMapBaseUrl, PDF_CMAP_OPTIONS, PDF_CMAP_URL } from '../pdfjs';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/**
 * 把注释逐字符替换成空格（换行保留），再交给源码级断言。
 * 必须先剥注释：pdfjs.ts 的文件头注释里就写着 `*.bcmap` 这个字面量（在解释为什么不能
 * 走资源图），不剥注释的话守卫会被自己的文档命中；反过来，也不能用简单的
 * 「斜杠星号 … 星号斜杠」配对 —— 前半截会被当成块注释起点，一路吞到文件后面某个真正的
 * 块注释结束符，连带把被守卫的代码一起吃掉（断言恒真，等于没有守卫）。
 * 故这里用「块注释 / 行注释 / 模板串 / 双引号串 / 单引号串」五类整体匹配的写法，
 * 从左到右一次性扫完：字符串里的块注释起始符归字符串、注释里的双斜杠归注释。
 */
function stripComments(src: string): string {
  const blank = (m: string): string => m.replace(/[^\n]/g, ' ');
  const TOKEN =
    /\/\*[\s\S]*?\*\/|\/\/[^\n]*|`(?:\\[\s\S]|[^`\\])*`|"(?:\\[\s\S]|[^"\\\n])*"|'(?:\\[\s\S]|[^'\\\n])*'/g;
  return src.replace(TOKEN, (m) => (m.startsWith('/*') || m.startsWith('//') ? blank(m) : m));
}

interface EmittedAsset {
  type: string;
  fileName: string;
  source: Uint8Array;
}

/** buildStart 的最小可调用形态（Vite 侧类型是 ObjectHook，也可能是 { handler } 对象形态）。 */
type BuildStartHook = (
  this: {
    emitFile: (file: { fileName: string; source: Uint8Array }) => unknown;
  },
  _options: unknown,
) => void;

/** 用只有 emitFile 的假 plugin context 跑一次 buildStart，返回全部 emit 参数。 */
function emitCMapAssets(): EmittedAsset[] {
  const emitFile = vi.fn();
  const hook = pdfjsCmapsPlugin().buildStart;
  const buildStart = (typeof hook === 'function'
    ? hook
    : hook?.handler) as unknown as BuildStartHook;
  const ctx = { emitFile };
  buildStart.call(ctx, {});
  return emitFile.mock.calls.map((c) => c[0] as EmittedAsset);
}

describe('pdfjs cMap 构建产物锁（2026-10-03 修缺陷）', () => {
  const sourceNames = readdirSync(resolveCMapDir()).filter((f) => f.endsWith('.bcmap'));

  it('源目录里的 .bcmap 数量与插件枚举一致（换 pdfjs-dist 版本时这里会变，是预期）', () => {
    expect(sourceNames.length).toBeGreaterThan(0);
    expect(listCMapFiles().sort()).toEqual([...sourceNames].sort());
  });

  describe('pdfjsCmapsPlugin.buildStart', () => {
    it('每个 cMap 都 emitFile 一次，数量齐全', () => {
      expect(emitCMapAssets()).toHaveLength(sourceNames.length);
    });

    it('fileName 形如 cmaps/<原名>.bcmap：与源文件名逐一相等，未被改名（无 hash）', () => {
      const emitted = emitCMapAssets();

      expect(emitted.every((f) => f.type === 'asset')).toBe(true);
      expect(emitted.every((f) => f.fileName.startsWith('cmaps/'))).toBe(true);
      // 只有一段路径段：走 Vite 资源图时产出的是 assets/xxx-<hash>.bcmap 两段。
      expect(emitted.every((f) => f.fileName.split('/').length === 2)).toBe(true);

      // 关键断言：逐名相等（集合相等），证明一个都没被加内容 hash、没被丢。
      // 不用正则猜 hash —— pdfjs 的 cMap 原名本身就含连字符与数字（90ms-RKSJ-H.bcmap 之类），
      // 任何「像 hash」的启发式都会误报；集合相等才是无歧义的不变量。
      const emittedNames = emitted.map((f) => f.fileName.slice('cmaps/'.length)).sort();
      expect(emittedNames).toEqual([...sourceNames].sort());
    });

    it('source 是原文件的二进制内容，不是被 Vite 处理过的字符串', () => {
      const first = emitCMapAssets()[0];
      expect(first.source).toBeInstanceOf(Uint8Array);
      expect(first.source.length).toBeGreaterThan(0);
    });
  });

  // 为什么锁 cMapBaseUrl 而不只锁 PDF_CMAP_URL：vitest 恒在 import.meta.env.DEV === true
  // 下运行，PDF_CMAP_URL 在测试里永远是 dev 那一条。改回 build 分支前它同样满足
  // 「以 / 结尾 / 不含 data: / 以 cmaps/ 结尾」——结构性质断言在两个分支上都成立，
  // 拦不住任何回归。cMapBaseUrl 把分支选择变成可传参的纯函数，两条分支才有覆盖。
  describe('cMapBaseUrl', () => {
    it('build 分支指向 dist/cmaps/，与 emitFile 的 fileName 前缀一致', () => {
      expect(cMapBaseUrl(false, '/')).toBe('/cmaps/');
    });

    it('dev 分支指向 dev server 直接服务的 node_modules 原名目录', () => {
      expect(cMapBaseUrl(true, '/')).toBe('/node_modules/pdfjs-dist/cmaps/');
    });

    it('尊重 BASE_URL：部署在子路径下时不丢前缀（cMap 与 index.html 同源相对寻址）', () => {
      expect(cMapBaseUrl(false, '/erp/')).toBe('/erp/cmaps/');
      expect(cMapBaseUrl(true, '/erp/')).toBe('/erp/node_modules/pdfjs-dist/cmaps/');
    });

    it('两个分支产出的都是可请求的相对路径：拼上原名后无查询串、basename 不变', () => {
      const name = 'Adobe-GB1-UCS2.bcmap';
      for (const base of [cMapBaseUrl(false, '/'), cMapBaseUrl(true, '/')]) {
        const url = `${base}${name}`;
        expect(url).not.toMatch(/[?#]/);
        expect(url).not.toContain('data:');
        expect(basename(url)).toBe(name);
      }
    });
  });

  describe('PDF_CMAP_URL', () => {
    it('等于 cMapBaseUrl 在当前环境下的取值（常量的推导没被绕过）', () => {
      expect(PDF_CMAP_URL).toBe(cMapBaseUrl(import.meta.env.DEV, import.meta.env.BASE_URL));
    });

    it('是以 / 结尾的路径前缀，不是 data: URI（内联即失效）', () => {
      expect(PDF_CMAP_URL.endsWith('/')).toBe(true);
      expect(PDF_CMAP_URL).not.toContain('data:');
      expect(PDF_CMAP_URL).not.toContain('base64');
    });

    it('不指向 /assets/：那里产出的是带内容 hash 的资源名', () => {
      expect(PDF_CMAP_URL).not.toContain('/assets/');
    });

    it('以 cmaps/ 结尾，可与构建产物的 dist/cmaps/ 对齐', () => {
      expect(PDF_CMAP_URL.endsWith('cmaps/')).toBe(true);
    });

    it('getDocument 的入参沿用同一个 URL（PdfViewer.vue 依赖 PDF_CMAP_OPTIONS）', () => {
      expect(PDF_CMAP_OPTIONS.cMapUrl).toBe(PDF_CMAP_URL);
      expect(PDF_CMAP_OPTIONS.cMapPacked).toBe(true);
    });
  });

  // 源码级守卫：cMap 必须以「固定目录 + 原名」寻址，不经 Vite 资源图（?url / ?raw）。
  // 资源图路径有两条只在 build 后才爆发的失效点：assetsInlineLimit 低于 4096 字节时把
  // 资源内联成 data URI、落文件时又按内容加 hash，而 pdfjs 不查 manifest、按原名拼 URL。
  // 与上面的 cMapBaseUrl 断言互补：那条锁「选哪个目录」，这条拦「别把整个取 URL 的方式
  // 换回资源图 / glob 收集」——那种改法在 vitest 的 dev 环境下四条结构断言照样全过。
  it('src/utils/pdfjs.ts 不再用 import.meta.glob 收集 cMap', () => {
    const src = stripComments(readFileSync(join(ROOT, 'src/utils/pdfjs.ts'), 'utf8'));
    expect(
      src.includes('import.meta.glob'),
      'src/utils/pdfjs.ts 里出现了 import.meta.glob：cMap 一旦回到 Vite 资源图，' +
        '低于 assetsInlineLimit 的会被内联成 data URI、落文件的会被加内容 hash，' +
        '而 pdfjs 按原名请求 → 生产端整份 PDF 文字消失。改回固定目录 + 原名（cMapBaseUrl）',
    ).toBe(false);
  });

  it('src/utils/pdfjs.ts 不再导入 .bcmap 资源（?url / ?raw 都算内联或加 hash 的入口）', () => {
    const src = stripComments(readFileSync(join(ROOT, 'src/utils/pdfjs.ts'), 'utf8'));
    expect(src).not.toMatch(/from\s+['"][^'"]*\.bcmap/);
    expect(src).not.toContain('.bcmap?url');
    expect(src).not.toContain('.bcmap?raw');
  });

  // nginx 段此前零测试覆盖。必须显式声明 /cmaps/，不能靠 `location /` 的 try_files 兜底：
  // 缺文件时会被回退成 200 + index.html，pdfjs 拿 HTML 喂 BinaryCMapReader 抛
  // "Invalid dataSize."，日志里看不出是 nginx 兜底。两份 conf 任一漏改都会在生产上炸。
  describe('nginx 的 /cmaps/ 路由', () => {
    for (const conf of ['nginx.conf', 'nginx.http-only.conf']) {
      it(`${conf} 显式声明 location ^~ /cmaps/ 且缺文件返 404`, () => {
        const src = readFileSync(join(ROOT, conf), 'utf8');
        const block = src.match(/location\s+\^~\s+\/cmaps\/[^}]*\}/)?.[0] ?? '';
        expect(
          block,
          `${conf} 里没有 location ^~ /cmaps/ 块：pdfjs 拼出的 cMap URL 会落到 ` +
            '`location /` 的 try_files，缺文件被回退成 200 + index.html',
        ).not.toBe('');
        expect(block).toContain('try_files $uri =404');
      });
    }
  });
});
