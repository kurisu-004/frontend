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
//      通过内核的 release() / releaseAll() 释放。

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

/** 拿到已加载文件的最末一层拓扑（浏览器控制台 inspect 用） */
export function inspectLastLoaded(): TopologyNode | null {
  if (lastLoaded === null) return null;
  return topologyCache.get(lastLoaded) ?? null;
}

/** 拿单个句柄的拓扑（缓存） */
export function getTopology(handle: ShapeHandle): TopologyNode | null {
  return topologyCache.get(handle) ?? null;
}

/** 拿单个句柄的统计（缓存） */
export function getStats(handle: ShapeHandle): TopologyStats | null {
  return statsCache.get(handle) ?? null;
}

/** 重置内部状态（测试 / 切场景时用） */
export function _resetKernelForTest(): void {
  kernelPromise = null;
  topologyCache.clear();
  statsCache.clear();
  lastLoaded = null;
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

  // 解析
  let shape: ShapeHandle;
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
  } catch (e) {
    throw new OcctLoadError(
      `${format} 解析失败: ${e instanceof Error ? e.message : String(e)}`,
      'parse',
      e,
    );
  }

  // 拓扑 + 统计
  const topology = buildTopology(kernel, shape);
  const stats = buildStats(kernel, shape);
  topologyCache.set(shape, topology);
  statsCache.set(shape, stats);
  lastLoaded = shape;

  options.onProgress?.(60, 'tessellate');

  const linDef = options.linearDeflection ?? 0.1;
  const angDef = options.angularDeflection ?? 0.5;

  // mesh + wireframe
  let faceMesh: ReturnType<OcctKernel['meshShape']>;
  let edgeData: ReturnType<OcctKernel['wireframe']>;
  try {
    faceMesh = kernel.meshShape(shape, { linearDeflection: linDef, angularDeflection: angDef });
    // 用默认 source:'curve'（OCCT 真实拓扑边，face↔face 边界），避免三角化内部网格线
    edgeData = kernel.wireframe(shape, { deflection: linDef });
  } catch (e) {
    throw new OcctLoadError(
      `三角化失败: ${e instanceof Error ? e.message : String(e)}`,
      'tessellate',
      e,
    );
  }

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
}

export async function loadStepFromArrayBuffer(
  buf: ArrayBuffer,
  format: OcctFormat,
  options: LoadOcctOptions = {},
): Promise<LoadedShape> {
  return loadStepFromBytes(new Uint8Array(buf), format, options);
}

// 仅暴露一次 kernel 给模块内部清理使用
export async function disposeKernel(): Promise<void> {
  if (kernelPromise) {
    const k = await kernelPromise;
    try {
      (k as unknown as { [Symbol.dispose]: () => void })[Symbol.dispose]();
    } catch {
      /* ignore */
    }
  }
  _resetKernelForTest();
}

// 抑制 unused 警告（SHAPE_TYPES_RECURSED 留作未来拓展）
void SHAPE_TYPES_RECURSED;
