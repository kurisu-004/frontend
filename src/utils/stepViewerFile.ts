// 2026-09-20 新增：STEP/STL/IGES 等 3D 模型文件的判定与 occt-wasm 格式探测。
//
// 设计要点：
//   - is3DModelFileType：用于 FileListCard 预览分流（与 iconColor 判定保持一致）。
//   - isOcctSupported：occt-wasm 实际能解析的子集（STEP/STP/IGES/IGS/STL/BREP）。
//     OBJ / 3MF 当前 occt-wasm 不支持 → isOcctSupported 返回 false → 仍走下载兜底。
//   - detectOcctFormat：薄包 occt-wasm 的 detectFormat，统一入口。

import { detectFormat } from '@/three/OcctStepLoader';

/** 浏览器侧可尝试用 3D 预览的文件扩展名（含 occt-wasm 当前不支持的 OBJ/3MF）。
 *  与 FileListCard.vue iconColor 判定的 STEP/STP/IGES/IGS/STL/OBJ/3MF 对齐。 */
const OCCT_3D_MODEL_TYPES = new Set(['STEP', 'STP', 'IGES', 'IGS', 'STL', 'OBJ', '3MF']);

/** occt-wasm 实际能解析的子集（STEP/STP/IGES/IGS → step；STL → stl；BREP → brep）。
 *  OBJ / 3MF 当前 occt-wasm 不支持 → 走下载兜底。 */
const OCCT_SUPPORTED_TYPES = new Set(['STEP', 'STP', 'IGES', 'IGS', 'STL', 'BREP']);

function upperOrEmpty(t: string | null | undefined): string {
  return (t ?? '').toUpperCase();
}

/** 给一个 file_type（STEP/STP/...）判定是否属于「3D 模型类」。含 OBJ/3MF（OCCT 暂不支持）。 */
export function is3DModelFileType(t: string | null | undefined): boolean {
  return OCCT_3D_MODEL_TYPES.has(upperOrEmpty(t));
}

/** 给一个 file_type 判定 occt-wasm 能否解析（不含 OBJ/3MF）。 */
export function isOcctSupported(t: string | null | undefined): boolean {
  return OCCT_SUPPORTED_TYPES.has(upperOrEmpty(t));
}

/** 给一个文件名（原始小写 / 大写皆可）返回 occt-wasm 期望的 format；
 *  不能识别时返回 null（调用方应走下载兜底，不强转成 'step'）。 */
export function detectOcctFormat(
  filename: string | null | undefined,
): 'step' | 'stl' | 'brep' | null {
  if (!filename) return null;
  // occt-wasm 的 detectFormat 对未知后缀默认返回 'step' —— 我们上层要更严，未知直接 null
  const lower = filename.toLowerCase();
  const SUPPORTED = ['.step', '.stp', '.stl', '.brep'];
  if (!SUPPORTED.some((ext) => lower.endsWith(ext))) return null;
  return detectFormat(filename);
}

/**
 * 把 PartFileItem.file_type（STEP / STP / IGES / IGS / STL / BREP ...）映射到
 * occt-wasm 期望的格式标记。给定非 occt-supported 类型时返回 null（应走下载兜底）。
 *
 * 用于 StepViewer.vue 的 props.format prop —— blob URL 场景下无法从 URL 探测格式，
 * 必须由调用方（已知 file_type 的父组件）显式传入。
 */
export function fileTypeToOcctFormat(
  fileType: string | null | undefined,
): 'step' | 'stl' | 'brep' | null {
  const up = upperOrEmpty(fileType);
  if (up === 'STEP' || up === 'STP' || up === 'IGES' || up === 'IGS') return 'step';
  if (up === 'STL') return 'stl';
  if (up === 'BREP') return 'brep';
  return null;
}
