// 2026-09-20 新增：occt-wasm 加载产物的对外类型
// 取代旧的 chili-wasm LoadedShape / ShapeRange / LeafUserData 等（测量相关已全部删除）
import type * as THREE from 'three';
import type { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import type { OcctKernel, ShapeHandle } from 'occt-wasm';

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export interface UvBoundsLike {
  uMin: number;
  uMax: number;
  vMin: number;
  vMax: number;
}

export interface BboxLike {
  xmin: number;
  ymin: number;
  zmin: number;
  xmax: number;
  ymax: number;
  zmax: number;
}

/**
 * OCCT 解析后的拓扑树。
 * OCCT 的 TopoDS_Shape 是复合结构：Compound → (Solid | CompSolid | Shell) →
 * Shell → Face → Wire → Edge → Vertex。本结构按相同层级递归展开。
 *
 * - `handle`：occt-wasm 的 ShapeHandle（数字 ID），可用于后续 kernel 调用
 *   （如 kernel.getVolume(handle) / kernel.surfaceType(handle) 等）
 * - `type`：OCCT 形状类型枚举；compound / compsolid / solid / shell / face / wire / edge / vertex
 * - `children`：按 OCCT 层级规则展开的子节点（compound 列出 solid+shell，solid 列出 shell，shell 列出 face……）
 * - 类型特定字段：
 *   - vertex.position
 *   - edge.{curveType, length, startPoint, endPoint, parameters}
 *   - face.{surfaceType, center, normal, uvBounds, cylinder?}
 *   - body.{volume, area, centerOfMass}（compound/compsolid/solid）
 *
 * 注意：
 * - ShapeHandle 是 occt-wasm 内部 arena 整数；持有期间会被 kernel 跟踪，
 *   dispose 时随 kernel.releaseAll() 释放。
 * - 本结构主要用于 UI 展示与后续逻辑；浏览器控制台可调
 *   `inspectLastLoaded()` 拿到最近一次加载的拓扑对象。
 */
export interface TopologyNode {
  type:
    'compound' | 'compsolid' | 'solid' | 'shell' | 'face' | 'wire' | 'edge' | 'vertex' | 'shape';
  handle: ShapeHandle;
  bbox: BboxLike;
  children: TopologyNode[];
  vertex?: { x: number; y: number; z: number };
  edge?: {
    curveType: string;
    length: number;
    startPoint: Vec3Like;
    endPoint: Vec3Like;
    parameters: { first: number; last: number };
  };
  face?: {
    surfaceType: string;
    center: Vec3Like;
    normal: Vec3Like;
    uvBounds: UvBoundsLike;
    cylinder?: { radius: number; isDirect: boolean };
  };
  body?: { volume: number; area: number; centerOfMass: Vec3Like };
}

/** 整体统计（与拓扑并行缓存，便于 UI 一眼展示） */
export interface TopologyStats {
  solids: number;
  shells: number;
  faces: number;
  wires: number;
  edges: number;
  vertices: number;
  volume: number;
  surfaceArea: number;
  bbox: BboxLike;
}

/**
 * occt-wasm 加载完成后的产物。root 直接 add 到 scene 即可。
 * topology / stats / kernel 三个引用都通过 LoadedShape 暴露，
 * 后续如果要做交互/测量可以基于 TopologyNode.handle 调 kernel API。
 */
export interface LoadedShape {
  root: THREE.Group;
  /** occt-wasm 句柄，可作为 kernel API 的输入 */
  rootHandle: ShapeHandle;
  /** 用于二次查询（拓扑 / measure / future operations） */
  kernel: OcctKernel;
  /** 完整拓扑树 */
  topology: TopologyNode;
  /** 整体统计（数量 + 体积 + 包围盒） */
  stats: TopologyStats;
  /** mesh 三角形数 */
  triangleCount: number;
  /** 根 ShapeNode 名称（compound 通常 = 'model'，其他 = type 字符串） */
  rootName: string;
  /** 边线 LineMaterial，ViewerCanvas 注册到 SceneManager 维护 resolution */
  lineMaterial?: LineMaterial;
}
