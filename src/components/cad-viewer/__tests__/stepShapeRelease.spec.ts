// src/components/cad-viewer/__tests__/stepShapeRelease.spec.ts
//
// 2026-10-20 新增：occt-wasm 侧「形状句柄 + 拓扑缓存只进不出」的回归守卫。
//
// 病灶（2026-10-20 巡检）：`three/OcctStepLoader.ts` 有两张模块级 Map（topologyCache /
// statsCache）与 `lastLoaded`，写点只有 `loadStepFromBytes` 一处，**唯一的清位点是
// `_resetKernelForTest`，而全仓没有任何测试用它**；`disposeKernel()` 全仓零调用方；全仓对
// `kernel.release()` / `releaseAll()` 只有注释引用。结果是每加载一个 STEP/BREP/STL，
// wasm arena 里的形状 + JS 侧的拓扑树都只增不减，反复切文件 / 开关预览面板会一路堆上去。
// GPU 侧本来就是干净的（`StepViewer.vue` 卸载时 dispose cubeGizmo + sceneManager），本次只
// 补 wasm 侧。
//
// ⚠️ 为什么分成两段断言（本文件最重要的方法论）：
//   occt-wasm 的初始化是 emscripten 主线程 wasm，**node / happy-dom 环境无法真实初始化**
//   （`__tests__/StepViewer.spec.ts` 头注释已登记同一条限制）。所以：
//   - 「释放与清位逻辑本身对不对」→ 用**假 kernel**（只需一个 `release` 方法）跑真代码，
//     覆盖 R1~R4。这是行为断言，能抓住「forget 漏了一张表」「顺序反了」这类真缺陷；
//   - 「StepViewer 到底有没有在那三条路径上调它」→ 读 .vue 源文本做**源码契约守卫**
//     （R5~R7），形态照 `PdfPreviewDialogContract.spec.ts` / `BatchCardDndFootprint.spec.ts`。
//   两段缺一不可：只有源码守卫则清位逻辑本身写错了也不红；只有逻辑单测则组件压根没接线，
//   生产上照样一路泄漏。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OcctKernel, ShapeHandle } from 'occt-wasm';
import { inspectLastLoaded, releaseShape, shapeCache } from '@/three/OcctStepLoader';
import type { TopologyNode, TopologyStats } from '@/three/types';

// 读组件源码。⚠️ 用 `import.meta.url` **字符串** + `node:url` 的 `fileURLToPath`，不要写
// `new URL('../x.vue', import.meta.url)`：happy-dom 下全局 `URL` 是它自己的实现，会忽略
// 传入的 base，`readFileSync` 随即抛「The URL must be of scheme file」。本 spec 跑在 node
// 环境，两种写法都可用，仍与同域其它守卫（`PoolDrawer.spec.ts` 等）保持一致。
const CAD_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STEP_VIEWER_SRC = readFileSync(resolve(CAD_DIR, 'StepViewer.vue'), 'utf8');
const LOADER_SRC = readFileSync(resolve(CAD_DIR, '../../three/OcctStepLoader.ts'), 'utf8');

/** 把三类注释逐字符换成空格（换行保留）—— 位置不变，判定只跑在真实代码上。
 *  本批守卫点在文档注释里都被点名解释了「为什么不能那么用」，守卫要判的是**代码**里有没有
 *  那条调用/导出，不是注释里有没有那个词。
 *
 *  ⚠️ **顺序：HTML → `//` 行注释 → 块注释**。反过来（块注释在前）时，一句行注释里只要出现
 *  块注释的起始符（文件路径、glob、正则片段都容易撞上），块注释正则就会从那里一路吃到文件里
 *  下一个闭合符，把中间整段**真实代码**吞成空格 —— 守卫不会变红而是**恒绿**（整文件级断言
 *  静默通过）。代价是反过来的病态形态（块注释内部有一行以 `//` 开头、且那行含闭合符）会漏剥，
 *  本仓不存在这种写法。 */
function stripComments(src: string): string {
  return src
    .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/^\s*\/\/.*$/gm, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

const STEP_VIEWER_CODE = stripComments(STEP_VIEWER_SRC);
const LOADER_CODE = stripComments(LOADER_SRC);

/** 取源码里 [startMarker, endMarker) 那一段（再剥掉注释）；任一 marker 找不到就当场红
 *  （防止挪了函数后守卫悄悄在空串上通过）。切段用**原始**文本 —— 分节标记
 *  `// ---- watch src ----` 本身就是行注释，在剥注释后的文本里已经不存在了。 */
function regionOf(src: string, startMarker: string, endMarker: string): string {
  const from = src.indexOf(startMarker);
  const to = src.indexOf(endMarker, from + startMarker.length);
  expect(from, `找不到起始标记 ${startMarker}`).toBeGreaterThanOrEqual(0);
  expect(to, `找不到结束标记 ${endMarker}`).toBeGreaterThan(from);
  return stripComments(src.slice(from, to));
}

/** occt-wasm 的 `ShapeHandle` 是 branded type（`number & { [brand]: never }`，防的就是把裸
 *  数字当句柄传）。本文件用假句柄，故在这里显式补 brand —— 生产代码不该有这一步。 */
function handleOf(n: number): ShapeHandle {
  return n as ShapeHandle;
}

function topology(handle: ShapeHandle): TopologyNode {
  return { type: 'solid', handle, bbox: BBOX, children: [] };
}

const BBOX = {
  xmin: 0,
  ymin: 0,
  zmin: 0,
  xmax: 1,
  ymax: 1,
  zmax: 1,
} as const;

function stats(): TopologyStats {
  return {
    solids: 1,
    shells: 1,
    faces: 6,
    wires: 6,
    edges: 12,
    vertices: 8,
    volume: 1,
    surfaceArea: 6,
    bbox: BBOX,
  };
}

/** 假 kernel：本文件只用到 `release`（OcctKernel 上其余几十个方法与清位逻辑无关）。 */
function fakeKernel(): { release: ReturnType<typeof vi.fn>; kernel: OcctKernel } {
  const release = vi.fn();
  return { release, kernel: { release } as unknown as OcctKernel };
}

beforeEach(() => {
  shapeCache.reset();
});

describe('occt-wasm 形状句柄与缓存的清位（假 kernel，node 环境可跑真逻辑）', () => {
  it('R1：put 后两张表都能取回；releaseShape 后两张表都取不到、inspectLastLoaded 归 null', () => {
    const { kernel, release } = fakeKernel();
    const h = handleOf(11);
    shapeCache.put(h, topology(h), stats());

    expect(shapeCache.size()).toBe(1);
    expect(shapeCache.topologyOf(h)?.handle).toBe(h);
    expect(shapeCache.statsOf(h)?.faces).toBe(6);
    expect(inspectLastLoaded()?.handle).toBe(h);

    releaseShape({ rootHandle: h, kernel });

    expect(release, 'wasm 句柄必须交还给内核').toHaveBeenCalledWith(h);
    expect(shapeCache.size()).toBe(0);
    expect(shapeCache.topologyOf(h)).toBeNull();
    expect(shapeCache.statsOf(h)).toBeNull();
    expect(inspectLastLoaded(), '句柄已失效，不能继续摆给控制台').toBeNull();
  });

  // 验收标准的核心断言：连着切 N 次模型，缓存**不得**单调增长。
  // 病灶形态下 size 依次是 1、2、3、4……；这里逐轮查**两张表**各自的残留（只查 size()
  // 会被「漏删一张表」的写法钻过去，而那正是本条最该拦的半截修复）。
  it('R2：连切 4 次模型，缓存峰值恒为 1、每轮结束两张表都归零（不单调增长）', () => {
    const peaks: number[] = [];
    for (let round = 0; round < 4; round++) {
      const { kernel } = fakeKernel();
      const handle = handleOf(100 + round);
      shapeCache.put(handle, topology(handle), stats());
      peaks.push(shapeCache.size());
      releaseShape({ rootHandle: handle, kernel });
      expect(shapeCache.size(), `第 ${round + 1} 轮释放后拓扑表必须归零`).toBe(0);
      expect(shapeCache.topologyOf(handle), `第 ${round + 1} 轮释放后拓扑不得残留`).toBeNull();
      expect(shapeCache.statsOf(handle), `第 ${round + 1} 轮释放后统计不得残留`).toBeNull();
    }
    expect(peaks).toEqual([1, 1, 1, 1]);
  });

  // 清位顺序守卫：清缓存的动作不能落在 kernel.release 的 try 里（内核一抛错就被跳过，
  // 两张表里留下一条永远拿不掉的僵尸条目）。
  it('R3：kernel.release 抛错（内核已 dispose）时，两张缓存表照样被清掉', () => {
    const boom = vi.fn(() => {
      throw new Error('kernel disposed');
    });
    const kernel = { release: boom } as unknown as OcctKernel;
    const h = handleOf(7);
    shapeCache.put(h, topology(h), stats());

    expect(() => releaseShape({ rootHandle: h, kernel })).not.toThrow();
    expect(boom).toHaveBeenCalledWith(h);
    expect(shapeCache.size()).toBe(0);
  });

  it('R4：releaseShape(null / undefined) 是空操作（调用方不必自己判空）', () => {
    expect(() => releaseShape(null)).not.toThrow();
    expect(() => releaseShape(undefined)).not.toThrow();
    expect(shapeCache.size()).toBe(0);
  });

  // 「释放自己那一份」与「清空全部」是两件事：多 StepViewer 同屏时，A 实例释放自己的形状
  // 顺手清掉 B 实例的拓扑缓存是真实缺陷（调试数据凭空消失），而上面四条断言在那种写法下
  // 全绿 —— 只有「释放后别人还在」才抓得住（把 forget 换成 reset() 即变红）。
  it('R2b：释放单个句柄不得顺手清掉别人的条目（forget ≠ reset）', () => {
    const { kernel } = fakeKernel();
    const h1 = handleOf(201);
    const h2 = handleOf(202);
    shapeCache.put(h1, topology(h1), stats());
    shapeCache.put(h2, topology(h2), stats());
    expect(shapeCache.size()).toBe(2);

    releaseShape({ rootHandle: h1, kernel });

    expect(shapeCache.topologyOf(h1)).toBeNull();
    expect(shapeCache.statsOf(h1)).toBeNull();
    expect(shapeCache.size(), '只剩另一个句柄的一条').toBe(1);
    expect(shapeCache.topologyOf(h2)?.handle, '另一个句柄的拓扑必须还在').toBe(h2);
    expect(shapeCache.statsOf(h2)?.faces, '另一个句柄的统计必须还在').toBe(6);
  });
});

describe('StepViewer / 释放接线（源码契约守卫）', () => {
  const region = (startMarker: string, endMarker: string): string =>
    regionOf(STEP_VIEWER_SRC, startMarker, endMarker);

  it('R5：切模型 / src 清空 / 组件卸载三条路径各调一次释放', () => {
    const unload = region('onBeforeUnmount(', '// ----------------- watch src');
    const watchSrc = region('// ----------------- watch src', '// ----------------- grid / gizmo');
    const load = region('async function loadFromBlobUrl(', 'async function fetchBlob(');

    expect(unload.match(/releaseCurrentShape\(\);/g) ?? [], '卸载').toHaveLength(1);
    expect(watchSrc.match(/releaseCurrentShape\(\);/g) ?? [], 'src 清空').toHaveLength(1);
    expect(load.match(/releaseCurrentShape\(\);/g) ?? [], '切模型').toHaveLength(1);

    // 顺序：先放旧句柄、再拉新模型 —— 两份句柄同时活着没有任何好处。
    expect(load.indexOf('releaseCurrentShape();')).toBeLessThan(load.indexOf('loadStepFromBytes'));
  });

  // kernel 是模块级单例，多个 StepViewer 实例会同时活着 —— 三条同时存活的路径：
  // ① tagsView 的 keep-alive 让多个路由实例并存（`layouts/MainLayout.vue` 的
  // `<keep-alive :include="tags.cachedViewNames">` + `stores/tagsView.ts` 的 visitedViews），
  // 开两个零件详情标签、各自打开一个 3D 预览即得两个实例；
  // ② `views/parts/detail/components/PartFilesTabsCard.vue` 内那三个 `FileListCard` 挂载点是
  // `v-if / v-else-if / v-else` **互斥**的，同一时刻只挂一个，且每个预览弹窗里只有一个 StepViewer；
  // ③ `views/production/components/DrawingPreviewPane.vue` 是另一个承载点。
  // 组件生命周期上拆 kernel 会让其余实例的句柄全部失效。
  it('R6：组件不调 disposeKernel（共享单例只能整进程拆）', () => {
    expect(STEP_VIEWER_CODE).not.toMatch(/\bdisposeKernel\b/);
    expect(STEP_VIEWER_CODE).toContain("from '@/three/OcctStepLoader'");
  });

  it('R7：加载器里不再有名不副实的 _resetKernelForTest 死导出', () => {
    expect(LOADER_CODE).not.toMatch(/_resetKernelForTest/);
    expect(LOADER_CODE).toContain('export function releaseShape(');
  });
});

describe('加载失败不留僵尸（源码契约守卫，判位置不判行号）', () => {
  const loaderBody = (): string =>
    regionOf(
      LOADER_SRC,
      'export async function loadStepFromBytes',
      'export async function loadStepFromArrayBuffer',
    );

  // 病灶：`meshShape` / `wireframe` / `buildTopology` / `buildStats` / `buildMeshGroup` /
  // `fitToUnitSphere` 里任一处抛错，`loadStepFromBytes` 都只 reject —— 调用方拿到的是错误而
  // 不是 LoadedShape，`StepViewer` 的三条释放路径都拿不到这个句柄，wasm 句柄与两张缓存表里
  // 的条目（入表之后那条）就都永远没人清了。
  // ⚠️ 断言的是**相对位置**（这几步都必须落在同一个 try 内、catch 里必须有 releaseShape），
  // 不是行号：行号必然过期。回退形态（各自带 catch，或干脆没有 catch）都会红。
  it('R8：拿到句柄到返回 LoadedShape 整段包在一个 try 里，catch 走 releaseShape 语义', () => {
    const body = loaderBody();
    // try 的起点锚在「拿到 kernel 之后的第一处 try」：那是句柄作用域真正开始的地方
    // （文件体积闸与 kernel 初始化在句柄存在之前，不属本条要守的范围）。
    const kernelAt = body.indexOf('const kernel = await getKernel()');
    expect(kernelAt, '找不到 kernel 获取点').toBeGreaterThanOrEqual(0);
    const tryAt = body.indexOf('try {', kernelAt);
    const catchAt = body.indexOf('catch (e) {');
    expect(tryAt, '找不到包裹 shape 作用域的 try').toBeGreaterThan(kernelAt);
    expect(catchAt, '找不到兜底 catch').toBeGreaterThan(tryAt);

    const tryBody = body.slice(tryAt, catchAt);
    for (const call of [
      'kernel.importStep(',
      'buildTopology(',
      'buildStats(',
      'kernel.meshShape(',
      'kernel.wireframe(',
      'shapeCache.put(',
      'buildMeshGroup(',
      'fitToUnitSphere(',
    ]) {
      expect(tryBody, `${call} 必须落在 try 内，否则它抛错会绕过清位`).toContain(call);
    }

    const catchBody = body.slice(catchAt);
    // 统一走 releaseShape：forget（两张表 + lastLoaded）与 kernel.release 都在里面，
    // 且 release 自身带 try —— 清理动作不能盖掉原始错误。
    expect(catchBody, '失败路径必须交还句柄并清掉入表条目').toContain(
      'releaseShape({ rootHandle: shape, kernel })',
    );
    // 句柄可能压根没拿到（解析就炸了）：那种情况下不许去释放一个 null。
    expect(catchBody).toMatch(/if \(shape !== null\)/);
    // 释放不能盖掉原始错误：失败仍然要抛给调用方。
    expect(catchBody).toContain('OcctLoadError');
  });

  // R8 只守「八步都在 try 内」，不守「报错说的是不是那一步」—— 病灶形态下 R8 全绿而用户
  // 看到的是 `[parse] 拓扑提取失败`（三角化抛的错）。`StepViewer.vue` 把 `[${stage}] ${message}`
  // 原样上屏，说错阶段 = 现场排查被带偏一整个阶段，所以这三段文案必须各自落在**它所描述的
  // 调用之前**。
  // 断言取「相对位置 + meshShape 之前最后一处 failLabel 是哪句」两条，判位置不判行号；
  // 把 `stage = 'tessellate'` 那两行挪回 `shapeCache.put()` 之后即红。
  it('R9：stage / failLabel 的赋值必须落在它所描述的那一步之前（三角化不能说成拓扑提取失败）', () => {
    const body = loaderBody();

    const failLabels = [...body.matchAll(/failLabel = (.+);/g)].map((m) => ({
      at: m.index ?? -1,
      text: m[1],
    }));
    expect(failLabels.length, '找不到 failLabel 赋值（四段：解析 / 拓扑 / 三角化 / 组网）').toBe(4);

    const importAt = body.indexOf('kernel.importStep(');
    const topologyAt = body.indexOf('buildTopology(');
    const meshAt = body.indexOf('kernel.meshShape(');
    const putAt = body.indexOf('shapeCache.put(');
    const groupAt = body.indexOf('buildMeshGroup(');
    const stageAt = body.indexOf("stage = 'tessellate'");

    // 第 0 段（解析）：初值就是解析文案，且早于第一处 import。
    expect(failLabels[0].at, '解析文案必须早于 importStep').toBeLessThan(importAt);
    expect(failLabels[0].text).toBe('`${format} 解析失败`');

    // 第 1 段（解析 → 拓扑）：拓扑文案必须排在 buildTopology 之前。
    const labelBeforeTopology = failLabels.filter((l) => l.at < topologyAt);
    const lastBeforeTopology = labelBeforeTopology[labelBeforeTopology.length - 1];
    expect(lastBeforeTopology.text, 'buildTopology 之前最后一处 failLabel 必须是拓扑文案').toBe(
      "'拓扑提取失败'",
    );

    // 第二段（三角化）：stage 与 failLabel 都必须在 meshShape **之前**，否则 meshShape /
    // wireframe 抛错仍被算成上一段。
    expect(stageAt, 'tessellate 阶段必须在三角化之前就位').toBeGreaterThan(-1);
    expect(stageAt).toBeLessThan(meshAt);
    const labelBeforeMesh = failLabels.filter((l) => l.at < meshAt);
    const lastBeforeMesh = labelBeforeMesh[labelBeforeMesh.length - 1];
    expect(
      lastBeforeMesh.text,
      'meshShape 之前最后一处 failLabel 必须是三角化文案（病灶形态下这里是拓扑文案）',
    ).toBe("'三角化失败'");

    // 第三段（组网）：入表之后另有自己的文案，不复用三角化那一句。
    expect(putAt).toBeGreaterThan(meshAt);
    const labelBeforeGroup = failLabels.filter((l) => l.at < groupAt);
    const lastBeforeGroup = labelBeforeGroup[labelBeforeGroup.length - 1];
    expect(lastBeforeGroup.text, 'buildMeshGroup 之前最后一处 failLabel 应是组网文案').toBe(
      "'网格组装失败'",
    );
  });

  // 进度回调不是加载管线的一步：它的异常若漏进统一 catch，会被套上 failLabel 说成
  // 「三角化失败」，还顺手 releaseShape 掉一个已经算好的模型（调用方只拿到 reject）。
  // 故所有进度通知必须走 reportProgress，且那层自己 try/catch。
  it('R9b：进度通知一律走 reportProgress（回调抛错不得被算成加载失败）', () => {
    expect(
      LOADER_CODE.match(/options\.onProgress\?\.\(/g) ?? [],
      '裸的 options.onProgress?.( 调用必须全部改走 reportProgress',
    ).toHaveLength(0);

    const helper = regionOf(LOADER_SRC, 'function reportProgress(', '// ---- 顶层入口 ----');
    expect(helper, 'reportProgress 必须自己 try/catch 住回调').toMatch(/try \{/);
    expect(helper).toMatch(/catch \(e\)/);
    // 不是静默吞：控制台要留线索。
    expect(helper).toContain('console.warn');
  });
});
