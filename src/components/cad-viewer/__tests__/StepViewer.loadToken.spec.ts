// @vitest-environment happy-dom
// src/components/cad-viewer/__tests__/StepViewer.loadToken.spec.ts
//
// 2026-10-20 新增：`StepViewer` 加载代次令牌（loadToken）的回归守卫 —— **先发后至的那次加载
// 必须自释放句柄**。
//
// 病灶：`loadFromBlobUrl` 全程 await（拉 blob → arrayBuffer → occt-wasm 解析），期间 `src`
// 可能再变一次（用户在预览弹窗里连切 3D 文件，或父组件换预览对象）。没有令牌时两次加载各自
// 把结果写进 `currentShape`，**后到者覆盖先到者** ⇒ 被覆盖那份的 wasm 句柄与拓扑缓存条目从此
// 没有任何人拿得到；而「切模型 / src 清空 / 组件卸载」三条释放路径都只看 `currentShape`。
// 同一条漏法还有两个更短的入口：卸载期间仍在途的加载（组件已经没了，模型照样被挂上去）、
// `src` 清空期间仍在途的加载（挂回一个已经清空的 canvas）。三者都由同一个令牌守住。
//
// 为什么在这里 mount 真组件（而不是再写一条源码计数守卫）：竞态在运行期才发生。源码计数能
// 守住「那段 if 还在」，守不住「它在 await 之后**且**在写 currentShape 之前」—— 而顺序错
// 一格就等于没有。所以本文件把 `loadStepFromBytes` 桩成可控的延迟 promise，真跑一遍「连切两次
// src」，断言先到那份走 `releaseShape` 且从不 `setModel`。
//
// 桩的范围：SceneManager / CubeGizmo / 加载器三个模块 + 两个子组件（工具条、进度条）全部桩掉 ——
// 本用例只关心句柄的归属，真 three.js 跑不起来（无 WebGL），子组件与本用例无关。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import * as THREE from 'three';
import type { LoadedShape } from '@/three/types';

interface SmStub {
  setModel: ReturnType<typeof vi.fn>;
}

const mocks = vi.hoisted(() => ({
  loadStepFromBytes: vi.fn(),
  releaseShape: vi.fn(),
  sceneManagers: [] as unknown[],
}));

vi.mock('@/three/OcctStepLoader', () => ({
  loadStepFromBytes: mocks.loadStepFromBytes,
  releaseShape: mocks.releaseShape,
  OcctLoadError: class OcctLoadError extends Error {
    public stage = 'tessellate';
  },
}));

vi.mock('@/three/SceneManager', () => ({
  SceneManager: class SceneManagerStub {
    public camera = {};
    public controls = {};
    public setModel = vi.fn();
    public constructor() {
      mocks.sceneManagers.push(this);
    }
    public mount() {}
    public unmount() {}
    public setGridVisible() {}
    public registerLineMaterial() {}
    public getModelBoundingRadius() {
      return 1;
    }
  },
}));

vi.mock('@/three/CubeGizmo', () => ({
  CubeGizmo: class CubeGizmoStub {
    public setVisible() {}
    public dispose() {}
  },
}));

vi.mock('../StepViewerToolbar.vue', () => ({
  default: { name: 'StepViewerToolbarStub', template: '<div class="toolbar-stub" />' },
}));

vi.mock('../StepViewerProgress.vue', () => ({
  default: { name: 'StepViewerProgressStub', template: '<div class="progress-stub" />' },
}));

import StepViewer from '../StepViewer.vue';

/** 加载器只被组件用来拿 root / stats，本用例构造最小可用产物即可。
 *  组件里的 `stats` 只用到 `bbox`（emit('loaded') 与 setCurrentModelInfo），其余字段按
 *  `TopologyStats` 补齐以过类型检查。 */
function shapeOf(name: string): LoadedShape {
  const bbox = { xmin: 0, ymin: 0, zmin: 0, xmax: 1, ymax: 1, zmax: 1 };
  // 真 Group：SceneManager 已桩掉不会碰 WebGL，但用真对象省掉一处类型断言，
  // 且断言 setModel 收到的正是这一份身份。
  const root = new THREE.Group();
  root.name = name;
  return {
    root,
    rootHandle: 1 as unknown as LoadedShape['rootHandle'],
    kernel: {} as unknown as LoadedShape['kernel'],
    topology: {
      type: 'solid',
      handle: 1 as unknown as LoadedShape['rootHandle'],
      bbox,
      children: [],
    },
    stats: {
      solids: 1,
      shells: 1,
      faces: 6,
      wires: 6,
      edges: 12,
      vertices: 8,
      volume: 1,
      surfaceArea: 6,
      bbox,
    },
    triangleCount: 12,
    rootName: name,
  };
}

/** 把 `loadStepFromBytes` 桩成一串由用例自己兑现的 promise（每次调用一个）。 */
function deferredLoads(): Array<(s: LoadedShape) => void> {
  const resolvers: Array<(s: LoadedShape) => void> = [];
  mocks.loadStepFromBytes.mockReset();
  mocks.loadStepFromBytes.mockImplementation(
    () => new Promise<LoadedShape>((resolve) => resolvers.push(resolve)),
  );
  return resolvers;
}

function mountViewer() {
  return mount(StepViewer, {
    props: { src: null, format: 'step', showToolbar: false },
    attachTo: document.body,
  });
}

function sceneManagerStub(): SmStub {
  return mocks.sceneManagers[0] as SmStub;
}

beforeEach(() => {
  mocks.releaseShape.mockReset();
  mocks.sceneManagers.length = 0;
  // 出网口：组件自己 fetch blob。只用 blob.arrayBuffer()，其余是摆设。
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      blob: async () => ({ arrayBuffer: async () => new ArrayBuffer(8) }) as unknown as Blob,
    })),
  );
});

describe('StepViewer / 加载代次令牌（竞态下不漏句柄）', () => {
  it('连切两次 src：先发后至的那份自己释放，且从不挂到 scene', async () => {
    const settle = deferredLoads();
    const w = mountViewer();
    await flushPromises();

    await w.setProps({ src: 'blob:a' });
    await flushPromises();
    await w.setProps({ src: 'blob:b' });
    await flushPromises();
    expect(mocks.loadStepFromBytes, '两次 src 变化 ⇒ 两次加载').toHaveBeenCalledTimes(2);

    const first = shapeOf('first');
    const second = shapeOf('second');
    settle[0]!(first);
    await flushPromises();

    expect(mocks.releaseShape, '被后一轮作废的形状必须就地释放').toHaveBeenCalledWith(first);
    expect(sceneManagerStub().setModel, '作废的那份不得挂到 scene').not.toHaveBeenCalled();

    settle[1]!(second);
    await flushPromises();

    expect(sceneManagerStub().setModel).toHaveBeenCalledTimes(1);
    expect(sceneManagerStub().setModel).toHaveBeenCalledWith(second.root);
    expect(mocks.releaseShape, '当轮胜出的形状不得被释放').not.toHaveBeenCalledWith(second);
  });

  it('src 清空期间仍在途的加载：回来后自释放，不把模型挂回空 canvas', async () => {
    const settle = deferredLoads();
    const w = mountViewer();
    await flushPromises();

    await w.setProps({ src: 'blob:a' });
    await flushPromises();
    await w.setProps({ src: null });
    await flushPromises();

    const stale = shapeOf('stale');
    settle[0]!(stale);
    await flushPromises();

    expect(mocks.releaseShape).toHaveBeenCalledWith(stale);
    expect(sceneManagerStub().setModel).not.toHaveBeenCalled();
  });

  it('卸载期间仍在途的加载：回来后自释放，不碰已销毁的组件', async () => {
    const settle = deferredLoads();
    const w = mountViewer();
    await flushPromises();

    await w.setProps({ src: 'blob:a' });
    await flushPromises();
    w.unmount();

    const stale = shapeOf('stale');
    settle[0]!(stale);
    await flushPromises();

    expect(mocks.releaseShape).toHaveBeenCalledWith(stale);
    expect(sceneManagerStub().setModel).not.toHaveBeenCalled();
  });
});
