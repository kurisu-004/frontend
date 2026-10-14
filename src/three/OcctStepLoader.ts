// 2026-09-20 新增：基于 occt-wasm 的 STEP 加载器
// 取代旧 src/three/ChiliStepLoader.ts（chili3d 移植内核）
//
// 设计：
//   - 用 OcctKernel.importStep(text) 解析 STEP 文件
//   - 提取完整拓扑结构（递归遍历：compound→solid→shell→face→wire→edge→vertex）
//     缓存到 _topologyCache + LoadedShape.topology
//   - 用 kernel.tessellate(shape) 三角化为 mesh
//   - 用 kernel.wireframe(shape) 提取边线
//   - 坐标系：geometry buffer = STEP mm；fitToUnitSphere 只动 group.transform
//   - Mesh + LineSegments2 组合为 THREE.Group，add 到 scene 即可
//
// 注：本文件不依赖任何 vendored 代码。occt-wasm 句柄（ShapeHandle = number）
//      由 `releaseShape()`（切模型 / 卸载时逐个释放）与 `disposeKernel()`（整进程拆解，
//      内部 releaseAll + delete）两条路释放。

import * as THREE from 'three';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { OcctKernel, type ShapeHandle } from 'occt-wasm';
import type { LoadedShape, TopologyNode, TopologyStats } from './types';

export type OcctFormat = 'step' | 'stl' | 'brep';
export type OcctLoadStage = 'wasm' | 'parse' | 'tessellate';

export interface LoadOcctOptions {
  /** 三角化精度（线性偏转，单位 = STEP 原始长度）。默认 0.1 mm */
  linearDeflection?: number;
  /** 角度偏转（弧度）。默认 0.5 */
  angularDeflection?: number;
  /** fitToUnitSphere 开关。默认 true（与旧 loader 一致） */
  fitToUnitSphere?: boolean;
  /** 进度回调（0~100） */
  onProgress?: (pct: number, stage: OcctLoadStage) => void;
  /** 浏览器侧 wasm 路径前缀，默认 '/' */
  wasmBaseUrl?: string;
}

export class OcctLoadError extends Error {
  public readonly stage: OcctLoadStage;
  public readonly cause?: unknown;
  public constructor(message: string, stage: OcctLoadStage, cause?: unknown) {
    super(message);
    this.name = 'OcctLoadError';
    this.stage = stage;
    if (cause !== undefined) this.cause = cause;
  }
}

export const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB OOM 防护

export function detectFormat(nameOrExt: string): OcctFormat {
  const lower = nameOrExt.toLowerCase();
  if (lower.endsWith('.step') || lower.endsWith('.stp')) return 'step';
  if (lower.endsWith('.brep')) return 'brep';
  if (lower.endsWith('.stl')) return 'stl';
  return 'step';
}

// ---- kernel singleton ----

let kernelPromise: Promise<OcctKernel> | null = null;
const topologyCache = new Map<ShapeHandle, TopologyNode>();
const statsCache = new Map<ShapeHandle, TopologyStats>();
let lastLoaded: ShapeHandle | null = null;

/**
 * 2026-10-20 新增：句柄 → 拓扑 / 统计 的模块级缓存的**唯一出入口**。
 *
 * 为什么要包一层：这两张 Map 此前只有写入点（`loadStepFromBytes`）与三个只读调试出口，
 * 没有任何清理路径 —— 每加载一个 STEP/BREP/STL 就多留一份拓扑树和统计，且 occt-wasm 那边
 * 的形状句柄同样只增不减。把它收成一个对象，`forget()` 才有唯一实现可测（见
 * `__tests__/stepShapeRelease.spec.ts`：缓存大小不得随加载次数单调增长）。
 *
 * 写点只有 `loadStepFromBytes` 一处；`reset()` 只有 `disposeKernel()` 一个调用方。导出整个
 * 对象是为了让清位逻辑可单测（node 环境无法初始化 wasm，见该 spec 头注释），不是给业务侧
 * 的第二套 API。
 */
export const shapeCache = {
  /** 记录一次加载产出的句柄与它对应的拓扑 / 统计。 */
  put(handle: ShapeHandle, topology: TopologyNode, stats: TopologyStats): void {
    topologyCache.set(handle, topology);
    statsCache.set(handle, stats);
    lastLoaded = handle;
  },
  /** 单个句柄的拓扑；未缓存（已释放 / 不是本模块产的）时返回 null。 */
  topologyOf(handle: ShapeHandle): TopologyNode | null {
    return topologyCache.get(handle) ?? null;
  },
  /** 单个句柄的统计；未缓存（已释放 / 不是本模块产的）时返回 null。 */
  statsOf(handle: ShapeHandle): TopologyStats | null {
    return statsCache.get(handle) ?? null;
  },
  /**
   * 清掉一个句柄的拓扑 + 统计条目；返回它是否正好是「最近一次加载」那一个。
   * 清「最近一次」是为了让 `inspectLastLoaded()` 如实回答「现在没有可看的模型」，
   * 而不是把一个已被释放的句柄继续摆给控制台。
   */
  forget(handle: ShapeHandle): boolean {
    topologyCache.delete(handle);
    statsCache.delete(handle);
    if (lastLoaded !== handle) return false;
    lastLoaded = null;
    return true;
  },
  /** 当前缓存的句柄数（诊断与测试用）。 */
  size(): number {
    return topologyCache.size;
  },
  /** 清空两张表并复位「最近一次加载」。仅 `disposeKernel()` 用（kernel 都换人了）。 */
  reset(): void {
    topologyCache.clear();
    statsCache.clear();
    lastLoaded = null;
  },
};

/**
 * 拿到已加载文件的最末一层拓扑。
 *
 * ⚠️ **无任何代码调用方，仅供浏览器控制台 inspect**（排查 OCCT 解析结果时在 devtools 里
 * 手敲）。它与正式清理路径 `releaseShape()` 的区别：释放某个形状后本函数返回 null，而不是
 * 继续给出一个句柄已失效的对象。
 */
export function inspectLastLoaded(): TopologyNode | null {
  if (lastLoaded === null) return null;
  return topologyCache.get(lastLoaded) ?? null;
}

/** 拿单个句柄的拓扑（缓存）。⚠️ 同上：无代码调用方，仅供浏览器控制台 inspect。 */
export function getTopology(handle: ShapeHandle): TopologyNode | null {
  return topologyCache.get(handle) ?? null;
}

/** 拿单个句柄的统计（缓存）。⚠️ 同上：无代码调用方，仅供浏览器控制台 inspect。 */
export function getStats(handle: ShapeHandle): TopologyStats | null {
  return statsCache.get(handle) ?? null;
}

/**
 * 释放一个已加载形状的 wasm 句柄，并清掉它在两张缓存表里的条目。**生产路径上的正式清理
 * 入口**，调用方是 `StepViewer.vue`：切模型、src 清空、组件卸载三条路径各调一次。
 *
 * 只传 `LoadedShape` 的句柄 + kernel 两个字段就够（三维组的 GPU 资源由 SceneManager 另行
 * dispose，与本函数无关）。传 null / undefined 时是空操作，调用方不必自己判空。
 *
 * `shapeCache.forget` 刻意放在 `kernel.release` **之前、且不在同一个 try 里**：反过来写成
 * 「先 release 再 forget，forget 塞在 try 内」的话，release 一抛错（内核已被 dispose /
 * 句柄已失效）就跳过 forget，两张表里留下一条永远拿不掉的僵尸条目。
 *
 * 网格数据不受影响：`meshShape` / `wireframe` 早已把顶点拷进普通 Float32Array，释放 OCCT
 * 句柄不会让已经在屏上的模型消失。
 */
export function releaseShape(
  shape: Pick<LoadedShape, 'rootHandle' | 'kernel'> | null | undefined,
): void {
  if (!shape) return;
  shapeCache.forget(shape.rootHandle);
  try {
    shape.kernel.release(shape.rootHandle);
  } catch {
    /* 句柄已失效或内核已 dispose：缓存已清掉，这里无需再做什么 */
  }
}

/** 重置模块级内核引用与缓存。**只有 `disposeKernel()` 一个调用方**（原先的
 *  `_resetKernelForTest` 没有任何测试在用，名字与实际用途不符，一并去掉）。 */
function resetKernelState(): void {
  kernelPromise = null;
  shapeCache.reset();
}

async function getKernel(): Promise<OcctKernel> {
  if (kernelPromise) return kernelPromise;
  kernelPromise = OcctKernel.init({
    // 浏览器：locateFile 让 emscripten 从 /occt-wasm.wasm 拉 wasm（vite 走 /）
    wasmUrl: `${typeof window !== 'undefined' ? window.location.origin : ''}/occt-wasm.wasm`,
  }).catch((e) => {
    kernelPromise = null;
    throw new OcctLoadError(
      `occt-wasm 初始化失败: ${e instanceof Error ? e.message : String(e)}`,
      'wasm',
      e,
    );
  });
  return kernelPromise;
}

// ---- 拓扑提取 ----

const SHAPE_TYPES_RECURSED = new Set([
  'compound',
  'compsolid',
  'solid',
  'shell',
  'face',
  'wire',
  'edge',
  'vertex',
] as const);

function buildTopology(kernel: OcctKernel, handle: ShapeHandle): TopologyNode {
  const type = kernel.getShapeType(handle);
  const bbox = kernel.getBoundingBox(handle, false);
  const baseBbox = {
    xmin: bbox.xmin,
    ymin: bbox.ymin,
    zmin: bbox.zmin,
    xmax: bbox.xmax,
    ymax: bbox.ymax,
    zmax: bbox.zmax,
  };

  const node: TopologyNode = {
    type,
    handle,
    bbox: baseBbox,
    children: [],
  };

  // 类型特定的属性
  if (type === 'vertex') {
    const p = kernel.vertexPosition(handle);
    node.vertex = { x: p.x, y: p.y, z: p.z };
  } else if (type === 'edge') {
    try {
      const params = kernel.curveParameters(handle);
      const a = kernel.curvePointAtParam(handle, params.first);
      const b = kernel.curvePointAtParam(handle, params.last);
      node.edge = {
        curveType: kernel.curveType(handle),
        length: kernel.curveLength(handle),
        startPoint: { x: a.x, y: a.y, z: a.z },
        endPoint: { x: b.x, y: b.y, z: b.z },
        parameters: params,
      };
    } catch {
      /* 某些 edge 可能退化，吞错 */
    }
  } else if (type === 'face') {
    try {
      const uv = kernel.uvBounds(handle);
      const mid = {
        u: (uv.uMin + uv.uMax) / 2,
        v: (uv.vMin + uv.vMax) / 2,
      };
      const center = kernel.pointOnSurface(handle, mid.u, mid.v);
      const normal = kernel.surfaceNormal(handle, mid.u, mid.v);
      const cyl = kernel.getFaceCylinderData(handle);
      node.face = {
        surfaceType: kernel.surfaceType(handle),
        center: { x: center.x, y: center.y, z: center.z },
        normal: { x: normal.x, y: normal.y, z: normal.z },
        uvBounds: uv,
        cylinder: cyl ?? undefined,
      };
    } catch {
      /* ignore */
    }
  } else if (type === 'solid' || type === 'compound' || type === 'compsolid') {
    try {
      node.body = {
        volume: kernel.getVolume(handle),
        area: kernel.getSurfaceArea(handle),
        centerOfMass: kernel.getCenterOfMass(handle),
      };
    } catch {
      /* ignore */
    }
  }

  // 递归子形状（按类型顺序：solid → shell → face → wire → edge → vertex）
  if (type === 'compound' || type === 'compsolid') {
    for (const child of kernel.getSubShapes(handle, 'solid')) {
      node.children.push(buildTopology(kernel, child));
    }
    for (const child of kernel.getSubShapes(handle, 'shell')) {
      node.children.push(buildTopology(kernel, child));
    }
  } else if (type === 'solid') {
    for (const child of kernel.getSubShapes(handle, 'shell')) {
      node.children.push(buildTopology(kernel, child));
    }
  } else if (type === 'shell') {
    for (const child of kernel.getSubShapes(handle, 'face')) {
      node.children.push(buildTopology(kernel, child));
    }
  } else if (type === 'face') {
    for (const child of kernel.getSubShapes(handle, 'wire')) {
      node.children.push(buildTopology(kernel, child));
    }
  } else if (type === 'wire') {
    for (const child of kernel.getSubShapes(handle, 'edge')) {
      node.children.push(buildTopology(kernel, child));
    }
  } else if (type === 'edge') {
    // 边的两个顶点通过 subShape 获取（edge 严格意义上不"拥有" vertex，
    // OCCT 里 vertex 是共享的；但通过 edgeToFaceMap 等查询太重，简单做法是
    // 从 startPoint/endPoint 已经能拿到两端坐标，不再单独建拓扑节点）
  }

  return node;
}

function buildStats(kernel: OcctKernel, root: ShapeHandle): TopologyStats {
  const solids = kernel.subShapeCount(root, 'solid');
  const shells = kernel.subShapeCount(root, 'shell');
  const faces = kernel.subShapeCount(root, 'face');
  const wires = kernel.subShapeCount(root, 'wire');
  const edges = kernel.subShapeCount(root, 'edge');
  const vertices = kernel.subShapeCount(root, 'vertex');
  let volume = 0;
  let surfaceArea = 0;
  try {
    volume = kernel.getVolume(root);
    surfaceArea = kernel.getSurfaceArea(root);
  } catch {
    /* ignore for compound */
  }
  return {
    solids,
    shells,
    faces,
    wires,
    edges,
    vertices,
    volume,
    surfaceArea,
    bbox: ((): TopologyStats['bbox'] => {
      const bb = kernel.getBoundingBox(root, false);
      return {
        xmin: bb.xmin,
        ymin: bb.ymin,
        zmin: bb.zmin,
        xmax: bb.xmax,
        ymax: bb.ymax,
        zmax: bb.zmax,
      };
    })(),
  };
}

// ---- mesh / wireframe → THREE ----

/**
 * 把 occt-wasm wireframe 的 polyline 数据转换为 LineSegmentsGeometry 可用的
 * 连续线段端点对数组。
 *
 * occt-wasm wireframe({source:'curve'}) 的返回结构：
 *   - points: Float32Array（每个边是连续采样点；xyz 三元组）
 *   - edgeGroups: Int32Array（每条边 3 个 int：[pointStart, pointCount, edgeHash]）
 *     pointStart 是以 float 为单位的起始索引，pointCount 是该边采样点占的 float 数
 *     （实际顶点数 = pointCount / 3）
 *
 * LineSegmentsGeometry.setPositions 接受 [x1,y1,z1, x2,y2,z2, x1,y1,z1, x2,y2,z2, ...]
 * 排列的 flat float 数组，每对相邻点是 1 条线段。所以一条有 N 个顶点的 polyline
 * 展开成 N-1 对端点 = 6*(N-1) 个 float。
 *
 * 优点：只渲染 OCCT 真实拓扑边（面/面交接处），不画三角化内部线。
 * 曲线边自动按 OCCT 自己的弦偏转采样 polyline，画出来是平滑曲线而不是直线折角。
 */
function wireframeToLinePositions(edgeData: ReturnType<OcctKernel['wireframe']>): Float32Array {
  const { points, edgeGroups, edgeCount } = edgeData;
  if (edgeCount === 0 || edgeGroups.length === 0) {
    return new Float32Array(0);
  }

  // 预计算总输出长度
  let totalFloats = 0;
  for (let i = 0; i < edgeCount; i++) {
    const pointCount = edgeGroups[i * 3 + 1];
    const vertexCount = Math.floor(pointCount / 3);
    if (vertexCount >= 2) {
      totalFloats += (vertexCount - 1) * 6; // 每对端点 6 个 float
    }
  }

  const out = new Float32Array(totalFloats);
  let writeIdx = 0;
  for (let i = 0; i < edgeCount; i++) {
    const pointStart = edgeGroups[i * 3];
    const pointCount = edgeGroups[i * 3 + 1];
    const vertexCount = Math.floor(pointCount / 3);
    if (vertexCount < 2) continue;
    // 展开 polyline: (p0,p1), (p1,p2), (p2,p3), ...
    for (let v = 0; v < vertexCount - 1; v++) {
      const a = pointStart + v * 3;
      const b = pointStart + (v + 1) * 3;
      out[writeIdx++] = points[a];
      out[writeIdx++] = points[a + 1];
      out[writeIdx++] = points[a + 2];
      out[writeIdx++] = points[b];
      out[writeIdx++] = points[b + 1];
      out[writeIdx++] = points[b + 2];
    }
  }
  return out;
}

function buildMeshGroup(
  faceMesh: ReturnType<OcctKernel['meshShape']>,
  edgeData: ReturnType<OcctKernel['wireframe']>,
  rootName: string,
): THREE.Group {
  const group = new THREE.Group();
  group.name = rootName;

  // face mesh（一个 mesh 包含整个形状的所有 face）
  if (faceMesh.positions.length > 0 && faceMesh.indices.length > 0) {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(faceMesh.positions, 3));
    geom.setAttribute('normal', new THREE.Float32BufferAttribute(faceMesh.normals, 3));
    geom.setIndex(new THREE.Uint32BufferAttribute(faceMesh.indices, 1));
    const mat = new THREE.MeshPhongMaterial({
      color: 0xc7d2e0,
      emissive: 0x303a48,
      shininess: 30,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.name = 'faces';
    group.add(mesh);
  }

  // edges —— 走 source:'curve' 取 OCCT 真实拓扑边（面/面边界），不画三角化内部网格线
  const linePositions = wireframeToLinePositions(edgeData);
  if (linePositions.length > 0) {
    const lineGeom = new LineSegmentsGeometry();
    lineGeom.setPositions(linePositions);
    const lineMat = new LineMaterial({
      color: 0x2a3138,
      linewidth: 1,
      resolution: new THREE.Vector2(1, 1),
      worldUnits: false,
      dashed: false,
      alphaToCoverage: true,
      depthTest: true,
    });
    const lines = new LineSegments2(lineGeom, lineMat);
    lines.name = 'edges';
    group.add(lines);
  }

  return group;
}

// ---- fitToUnitSphere ----

function fitToUnitSphere(group: THREE.Group): void {
  const box = new THREE.Box3().setFromObject(group);
  if (!Number.isFinite(box.min.x) || !Number.isFinite(box.max.x)) return;
  const size = new THREE.Vector3();
  box.getSize(size);
  const center = new THREE.Vector3();
  box.getCenter(center);
  const maxAxis = Math.max(size.x, size.y, size.z, 1e-6);
  const scale = 2 / maxAxis;
  group.scale.setScalar(scale);
  group.position.copy(center).multiplyScalar(-scale);
  group.updateMatrixWorld(true);
}

// ---- 顶层入口 ----

export async function loadStepFromBytes(
  bytes: Uint8Array,
  format: OcctFormat,
  options: LoadOcctOptions = {},
): Promise<LoadedShape> {
  if (bytes.byteLength > MAX_FILE_SIZE) {
    throw new OcctLoadError(`File too large: ${bytes.byteLength} bytes`, 'parse');
  }
  options.onProgress?.(5, 'wasm');
  const kernel = await getKernel();
  options.onProgress?.(40, 'parse');

  // 2026-10-20（review 第 2 轮）：从「拿到句柄」到「返回 LoadedShape」**整段**包在一个 try 里。
  // 判据是「本函数一旦 reject，句柄就再也没人能清」：调用方拿不到 LoadedShape，
  // `StepViewer` 的三条 releaseCurrentShape() 路径（切模型 / src 清空 / 卸载）全都够不着它。
  // 过去只有三角化那两步自己带 catch，`buildTopology` / `buildStats`（在 try 之外）与
  // `buildMeshGroup` / `fitToUnitSphere`（在入表之后）任一抛错都漏同一个口子。
  // 所以 catch 统一走 releaseShape 的语义（forget + kernel.release，含 put 之后的缓存条目）
  // 再抛，**不按失败点分叉**：阶段差异只落在 stage 与文案两个变量上。
  let shape: ShapeHandle | null = null;
  let stage: OcctLoadStage = 'parse';
  let failLabel = `${format} 解析失败`;
  try {
    if (format === 'step') {
      // STEP 是文本，TextDecoder 解码；编码常见为 utf-8（ISO 10303-21 默认）
      const text = new TextDecoder('utf-8').decode(bytes);
      shape = kernel.importStep(text);
    } else if (format === 'brep') {
      const text = new TextDecoder('utf-8').decode(bytes);
      shape = kernel.fromBREP(text);
    } else {
      shape = kernel.importStl(bytes);
    }

    // 拓扑 + 统计（**此处不入表**，入表位置见三角化之后那行）
    failLabel = '拓扑提取失败';
    const topology = buildTopology(kernel, shape);
    const stats = buildStats(kernel, shape);

    options.onProgress?.(60, 'tessellate');

    const linDef = options.linearDeflection ?? 0.1;
    const angDef = options.angularDeflection ?? 0.5;

    // 用默认 source:'curve'（OCCT 真实拓扑边，face↔face 边界），避免三角化内部网格线
    const faceMesh = kernel.meshShape(shape, {
      linearDeflection: linDef,
      angularDeflection: angDef,
    });
    const edgeData = kernel.wireframe(shape, { deflection: linDef });

    // 2026-10-20：入表排在三角化**之后**。理由不是「失败路径会留僵尸」（那条现在由统一 catch
    // 兜底），而是「网格没拿到就不算一个完整模型」—— 调试导出（inspectLastLoaded /
    // getTopology / getStats）摆给控制台的条目不该是半成品。
    shapeCache.put(shape, topology, stats);

    stage = 'tessellate';
    failLabel = '三角化 / 建模失败';

    const rootName = topology.type === 'compound' ? 'model' : topology.type;
    const group = buildMeshGroup(faceMesh, edgeData, rootName);

    if (options.fitToUnitSphere !== false) {
      fitToUnitSphere(group);
    }

    options.onProgress?.(100, 'tessellate');

    // 把边线 LineMaterial 暴露出来，供 ViewerCanvas 注册到 SceneManager 维护 resolution
    const edgesChild = group.children.find((c) => c.name === 'edges');
    const lineMat = (edgesChild as unknown as { material: LineMaterial } | undefined)?.material;

    return {
      root: group,
      rootHandle: shape,
      kernel,
      topology,
      stats,
      triangleCount: faceMesh.triangleCount,
      rootName,
      lineMaterial: lineMat,
    };
  } catch (e) {
    // 解析就炸的那一支还没有句柄可放（shape 仍是 null），其余一律交还内核 + 清掉入表条目。
    // releaseShape 内部「forget 在 release 之前、且 release 另带一层 try」，正好是这里要的顺序。
    if (shape !== null) releaseShape({ rootHandle: shape, kernel });
    throw new OcctLoadError(
      `${failLabel}: ${e instanceof Error ? e.message : String(e)}`,
      stage,
      e,
    );
  }
}

export async function loadStepFromArrayBuffer(
  buf: ArrayBuffer,
  format: OcctFormat,
  options: LoadOcctOptions = {},
): Promise<LoadedShape> {
  return loadStepFromBytes(new Uint8Array(buf), format, options);
}

/**
 * 整进程级内核拆解：释放 kernel 持有的**全部**句柄（`[Symbol.dispose]` 内部走 releaseAll +
 * delete 原始内核）并清空模块级状态。
 *
 * ⚠️ **绝不能挂在任何组件生命周期上**：kernel 是模块级单例，而 `StepViewer` 可以同时挂着多个
 * 实例 —— 实例数 = 当前**同时存活**的 3D 预览弹窗个数：tagsView 的 keep-alive 让多个路由
 * 实例同时活着（开两个零件详情标签、各自打开一个 3D 预览即得两个 `StepViewer`；
 * `PartFilesTabsCard` 内那三个 `FileListCard` 挂载点是 `v-if / v-else-if / v-else` 互斥的，
 * 同一时刻只挂一个，每个预览弹窗里也只有一个 `StepViewer`），另有 `DrawingPreviewPane`
 * 这个承载点。一个卸载就拆 kernel 会让其余实例下一次加载拿到已释放的句柄；而且 wasm
 * 初始化本身不便宜，让它跟着「关一个预览窗口」反复拆建更亏。单个形状的释放走
 * `releaseShape()`，本函数留给「确认没有任何 `StepViewer` 挂载」的整进程收尾（应用退出、
 * 集成测试 teardown）。
 */
export async function disposeKernel(): Promise<void> {
  const pending = kernelPromise;
  if (pending) {
    kernelPromise = null;
    try {
      const k = await pending;
      (k as unknown as { [Symbol.dispose]: () => void })[Symbol.dispose]();
    } catch {
      /* 初始化就失败或已 dispose：下面照样把模块级状态复位 */
    }
  }
  resetKernelState();
}

// 抑制 unused 警告（SHAPE_TYPES_RECURSED 留作未来拓展）
void SHAPE_TYPES_RECURSED;
