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
 *  本批两个守卫点（`disposeKernel` / `_resetKernelForTest`）在文档注释里都被点名解释了
 *  「为什么不能那么用」，守卫要判的是**代码**里有没有那条调用/导出，不是注释里有没有那个词。 */
function stripComments(src: string): string {
  return src
    .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/^\s*\/\/.*$/gm, ' ');
}

const STEP_VIEWER_CODE = stripComments(STEP_VIEWER_SRC);
const LOADER_CODE = stripComments(LOADER_SRC);

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
});

describe('StepViewer / 释放接线（源码契约守卫）', () => {
  /** 取源码里 [startMarker, endMarker) 那一段（再剥掉注释）；任一 marker 找不到就当场红
   *  （防止挪了函数后守卫悄悄在空串上通过）。切段用**原始**文本 —— 分节标记
   *  `// ---- watch src ----` 本身就是行注释，在剥注释后的文本里已经不存在了。 */
  function region(startMarker: string, endMarker: string): string {
    const from = STEP_VIEWER_SRC.indexOf(startMarker);
    const to = STEP_VIEWER_SRC.indexOf(endMarker, from + startMarker.length);
    expect(from, `找不到起始标记 ${startMarker}`).toBeGreaterThanOrEqual(0);
    expect(to, `找不到结束标记 ${endMarker}`).toBeGreaterThan(from);
    return stripComments(STEP_VIEWER_SRC.slice(from, to));
  }

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

  // kernel 是模块级单例，多个 StepViewer 实例会同时活着（FileListCard 每个 3D 文件一个）。
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
